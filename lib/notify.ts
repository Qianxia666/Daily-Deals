import { createHmac } from 'node:crypto';
import { request } from './http';
import { getRuntimeEnvRaw, getSiteSettings } from './runtime-settings';
import type { ChannelKind } from './types';

export interface NotifyTarget {
  kind: ChannelKind;
  webhook: string;
  secret: string;
  key: string;
}

export interface NotifyItem {
  title: string;
  url: string;
}

export interface NotifyMessage {
  title: string;
  lines: string[];
  link?: string;
  items?: NotifyItem[];
}

export const CHANNEL_LABELS: Record<ChannelKind, string> = {
  wecom: '企业微信机器人',
  feishu: '飞书机器人',
  dingtalk: '钉钉机器人',
  bark: 'Bark 推送',
};

const ALLOWED_HOSTS: Record<Exclude<ChannelKind, 'bark'>, string[]> = {
  wecom: ['qyapi.weixin.qq.com'],
  feishu: ['open.feishu.cn', 'open.larksuite.com'],
  dingtalk: ['oapi.dingtalk.com'],
};

const TIMEOUT_MS = 8_000;

function allowAnyHost(): boolean {
  return (getRuntimeEnvRaw('NOTIFY_ALLOW_ANY_HOST') ?? '').trim() === '1';
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/** 校验用户填写的 Webhook；返回错误文案，通过时返回 null。 */
export function validateWebhook(
  kind: ChannelKind,
  webhook: string,
): string | null {
  if (allowAnyHost()) return null;

  let url: URL;
  try {
    url = new URL(webhook);
  } catch {
    return 'Webhook 地址格式不正确';
  }

  if (url.protocol !== 'https:') return 'Webhook 必须使用 https 地址';
  if (isPrivateHost(url.hostname)) return 'Webhook 不能指向内网地址';

  if (kind !== 'bark') {
    const allowed = ALLOWED_HOSTS[kind];
    if (!allowed.includes(url.hostname.toLowerCase())) {
      return `Webhook 域名必须是 ${allowed.join(' 或 ')}`;
    }
  }

  return null;
}

function markdownLabel(value: string): string {
  return value.replace(/[[\]]/g, '');
}

function markdownUrl(value: string): string {
  return value.replace(/\)/g, '%29').replace(/\(/g, '%28');
}

function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function actionLabel(items: NotifyItem[]): string {
  return items.length > 0 ? '查看全部' : '查看优惠详情';
}

/** 飞书交互卡片：标题栏 + 正文 + 可选条目 + 按钮。 */
function feishuCard(message: NotifyMessage): Record<string, unknown> {
  const items = message.items ?? [];
  const link = message.link ?? items[0]?.url ?? '';
  const elements: Record<string, unknown>[] = [];

  if (message.lines.length > 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: message.lines.join('\n') },
    });
  }

  if (items.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: itemLines(message).join('\n') },
    });
  }

  if (elements.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'plain_text', content: message.title },
    });
  }

  if (link) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: actionLabel(items) },
          url: link,
          type: 'primary',
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: message.title },
    },
    elements,
  };
}

/** 企业微信模板卡片：标题 + 摘要 + 最多 6 条可点击条目 + 跳转按钮。 */
function wecomCard(message: NotifyMessage): Record<string, unknown> {
  const items = message.items ?? [];
  const link = message.link ?? items[0]?.url ?? '';
  const card: Record<string, unknown> = {
    card_type: 'text_notice',
    source: {
      desc: clip(getSiteSettings().label, 20),
      desc_color: 1,
    },
    main_title: { title: clip(message.title, 26) },
  };

  const subtitle: string[] = [...message.lines];
  if (items.length > 6) {
    subtitle.push(`另有 ${items.length - 6} 条，点击查看全部`);
  }
  if (subtitle.length > 0) {
    card.sub_title_text = clip(subtitle.join('\n'), 120);
  }

  if (items.length > 0) {
    card.horizontal_content_list = items.slice(0, 6).map((item, index) => ({
      keyname: `${index + 1}`,
      value: clip(item.title, 26),
      type: 1,
      url: item.url,
    }));
  }

  if (link) {
    card.jump_list = [
      { type: 1, title: actionLabel(items), url: link },
    ];
    card.card_action = { type: 1, url: link };
  }

  return card;
}

function itemLines(message: NotifyMessage): string[] {
  return (message.items ?? []).map(
    (item, index) =>
      `${index + 1}. [${markdownLabel(item.title)}](${markdownUrl(item.url)})`,
  );
}

function barkEndpoint(target: NotifyTarget): string {
  const raw = target.webhook.trim() || target.key.trim();
  if (!raw) throw new Error('未配置 Bark Key');
  if (/^https?:\/\//i.test(raw)) {
    // 自建 Bark 服务同样要限制 https 与内网地址，避免 SSRF。
    const error = validateWebhook('bark', raw);
    if (error) throw new Error(error);
    return raw;
  }

  const error = allowAnyHost() ? null : 'Bark 只支持 https 地址';
  if (error) throw new Error(error);
  return `https://api.day.app/${encodeURIComponent(raw)}`;
}

async function readJson(response: {
  text(): Promise<string>;
}): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function ensureOk(
  kind: ChannelKind,
  response: { ok: boolean; status: number },
  payload: Record<string, unknown>,
): void {
  const code = payload.errcode ?? payload.code ?? 0;
  if (!response.ok || (typeof code === 'number' && code !== 0)) {
    const detail =
      (payload.errmsg as string | undefined) ??
      (payload.msg as string | undefined) ??
      (payload.message as string | undefined) ??
      `HTTP ${response.status}`;
    throw new Error(`${CHANNEL_LABELS[kind]}发送失败：${detail}`);
  }
}

/** 通过指定渠道发送一条通知，失败时抛出可读错误。 */
export async function sendNotification(
  target: NotifyTarget,
  message: NotifyMessage,
): Promise<void> {
  if (target.kind === 'bark') {
    const body = [
      ...message.lines,
      ...(message.items ?? []).map(
        (item, index) => `${index + 1}. ${item.title}\n${item.url}`,
      ),
      message.link ? `查看全部：${message.link}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const response = await request(
      barkEndpoint(target),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: message.title,
          body,
          url: message.link ?? message.items?.[0]?.url ?? '',
          group: '每日优惠',
        }),
      },
      TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new Error(`Bark 推送失败：HTTP ${response.status}`);
    }
    // Bark 成功时返回 {"code":200}，Key 无效等情况仍是 HTTP 200。
    const payload = await readJson(response);
    const code = payload.code;
    if (typeof code === 'number' && code !== 200) {
      const detail =
        (payload.message as string | undefined) ?? `code ${code}`;
      throw new Error(`Bark 推送失败：${detail}`);
    }
    return;
  }

  const webhook = target.webhook.trim();
  if (!webhook) throw new Error('未配置 Webhook 地址');

  const error = validateWebhook(target.kind, webhook);
  if (error) throw new Error(error);

  if (target.kind === 'feishu') {
    const payload: Record<string, unknown> = {
      msg_type: 'interactive',
      card: feishuCard(message),
    };
    const secret = target.secret.trim();
    if (secret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      payload.timestamp = timestamp;
      payload.sign = createHmac('sha256', `${timestamp}\n${secret}`)
        .update('')
        .digest('base64');
    }

    const response = await request(
      webhook,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      TIMEOUT_MS,
    );
    ensureOk('feishu', response, await readJson(response));
    return;
  }

  if (target.kind === 'wecom') {
    const card = wecomCard(message);
    const payload = card.card_action
      ? { msgtype: 'template_card', template_card: card }
      : {
          msgtype: 'markdown',
          markdown: {
            content: [`### ${message.title}`, ...message.lines, ...itemLines(message)]
              .filter(Boolean)
              .join('\n'),
          },
        };

    const response = await request(
      webhook,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      TIMEOUT_MS,
    );
    ensureOk('wecom', response, await readJson(response));
    return;
  }

  let endpoint = webhook;
  const secret = target.secret.trim();
  if (secret) {
    const timestamp = String(Date.now());
    const sign = createHmac('sha256', secret)
      .update(`${timestamp}\n${secret}`)
      .digest('base64');
    const separator = endpoint.includes('?') ? '&' : '?';
    endpoint += `${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  }

  const items = message.items ?? [];
  const link = message.link ?? items[0]?.url ?? '';
  const markdown = [
    `### ${message.title}`,
    ...message.lines,
    ...itemLines(message),
    link ? `[${actionLabel(items)}](${markdownUrl(link)})` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const actionCard: Record<string, unknown> = {
    title: message.title,
    text: markdown,
    btnOrientation: '0',
  };
  if (link) {
    actionCard.singleTitle = actionLabel(items);
    actionCard.singleURL = link;
  }

  const response = await request(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'actionCard', actionCard }),
    },
    TIMEOUT_MS,
  );
  ensureOk('dingtalk', response, await readJson(response));
}
