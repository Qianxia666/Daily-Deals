import { NextResponse, type NextRequest } from 'next/server';
import { isAdmin } from '@/lib/admin';
import { CHANNEL_LABELS, sendNotification } from '@/lib/notify';
import { getNotifyConfig, getSiteSettings, type NotifyKind } from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KINDS: NotifyKind[] = ['wecom', 'feishu', 'dingtalk', 'bark'];

export async function POST(request: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { kind?: unknown }
    | null;
  const kind =
    typeof body?.kind === 'string' && KINDS.includes(body.kind as NotifyKind)
      ? (body.kind as NotifyKind)
      : null;

  if (!kind) {
    return NextResponse.json({ error: '渠道类型错误' }, { status: 400 });
  }

  const config = getNotifyConfig(kind);
  if (!config.webhook && !config.key) {
    return NextResponse.json(
      { error: `请先填写${CHANNEL_LABELS[kind]}的配置并保存` },
      { status: 400 },
    );
  }

  try {
    await sendNotification(
      {
        kind,
        webhook: config.webhook,
        secret: config.secret,
        key: config.key,
      },
      {
        title: `${getSiteSettings().title} · 后台测试推送`,
        lines: [
          `渠道：${CHANNEL_LABELS[kind]}`,
          '来源抓取失败告警会发送到这个渠道。',
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
