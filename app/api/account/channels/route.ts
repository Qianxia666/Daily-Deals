import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import {
  addChannel,
  countChannelsByKind,
  deleteChannel,
  getChannelSecret,
  listChannels,
  updateChannel,
} from '@/lib/db';
import { CHANNEL_LABELS, sendNotification, validateWebhook } from '@/lib/notify';
import { getAccountLimits, getSiteSettings } from '@/lib/runtime-settings';
import type { ChannelKind } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KINDS: ChannelKind[] = ['wecom', 'feishu', 'dingtalk', 'bark'];

function parseKind(value: unknown): ChannelKind | null {
  return typeof value === 'string' && KINDS.includes(value as ChannelKind)
    ? (value as ChannelKind)
    : null;
}

function validateTarget(
  kind: ChannelKind,
  webhook: string,
  key: string,
): string | null {
  if (kind === 'bark') {
    const raw = webhook || key;
    if (!raw) return '请填写 Bark 设备 Key';
    if (/^https?:\/\//i.test(raw)) {
      const error = validateWebhook('bark', raw);
      if (error) return error;
    }
    return null;
  }

  if (!webhook) return '请填写机器人 Webhook 地址';
  return validateWebhook(kind, webhook);
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
  return NextResponse.json({ channels: listChannels(user.id) });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | {
        kind?: unknown;
        name?: unknown;
        webhook?: unknown;
        secret?: unknown;
        key?: unknown;
      }
    | null;

  const kind = parseKind(body?.kind);
  if (!kind) return NextResponse.json({ error: '渠道类型错误' }, { status: 400 });

  const webhook =
    typeof body?.webhook === 'string' ? body.webhook.trim().slice(0, 500) : '';
  const secret =
    typeof body?.secret === 'string' ? body.secret.trim().slice(0, 200) : '';
  const key = typeof body?.key === 'string' ? body.key.trim().slice(0, 300) : '';

  const name =
    typeof body?.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 20)
      : CHANNEL_LABELS[kind];

  const error = validateTarget(kind, webhook, key);
  if (error) return NextResponse.json({ error }, { status: 400 });

  const limits = getAccountLimits();
  if (countChannelsByKind(user.id, kind) >= limits.channelsPerKind) {
    return NextResponse.json(
      {
        error: `${CHANNEL_LABELS[kind]}最多绑定 ${limits.channelsPerKind} 个`,
      },
      { status: 400 },
    );
  }

  const channel = addChannel(user.id, {
    kind,
    name,
    webhook,
    secret,
    key,
  });
  if (!channel) {
    return NextResponse.json({ error: '保存失败' }, { status: 500 });
  }

  return NextResponse.json({ channel });
}

export async function PATCH(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | {
        id?: unknown;
        name?: unknown;
        enabled?: unknown;
        webhook?: unknown;
        secret?: unknown;
        key?: unknown;
      }
    | null;

  const id = Number(body?.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const current = getChannelSecret(user.id, id);
  if (!current) {
    return NextResponse.json({ error: '渠道不存在' }, { status: 404 });
  }

  const webhook =
    typeof body?.webhook === 'string' && body.webhook.trim()
      ? body.webhook.trim().slice(0, 500)
      : undefined;
  if (webhook) {
    const error = validateTarget(current.kind, webhook, '');
    if (error) return NextResponse.json({ error }, { status: 400 });
  }

  const name =
    typeof body?.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 20)
      : undefined;

  const ok = updateChannel(user.id, id, {
    name,
    enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
    webhook,
    secret:
      typeof body?.secret === 'string' && body.secret.trim()
        ? body.secret.trim().slice(0, 200)
        : undefined,
    key:
      typeof body?.key === 'string' && body.key.trim()
        ? body.key.trim().slice(0, 300)
        : undefined,
  });

  if (!ok) return NextResponse.json({ error: '渠道不存在' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { id?: unknown }
    | null;
  const id = Number(body?.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  if (!deleteChannel(user.id, id)) {
    return NextResponse.json({ error: '渠道不存在' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

/** 测试推送：使用当前保存的渠道配置发送一条测试消息。 */
export async function PUT(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { id?: unknown }
    | null;
  const id = Number(body?.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const channel = getChannelSecret(user.id, id);
  if (!channel) {
    return NextResponse.json({ error: '渠道不存在' }, { status: 404 });
  }

  try {
    await sendNotification(
      {
        kind: channel.kind,
        webhook: channel.webhook,
        secret: channel.secret,
        key: channel.key,
      },
      {
        title: `${getSiteSettings().title} · 测试推送`,
        lines: [
          `渠道：${channel.name}（${CHANNEL_LABELS[channel.kind]}）`,
          '收到这条消息说明配置已生效，命中关键词后会在这里提醒你。',
        ],
      },
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '发送失败' },
      { status: 502 },
    );
  }
}
