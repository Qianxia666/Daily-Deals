import { createHmac } from 'node:crypto';
import { request } from './http';
import {
  getRuntimeEnv,
  getRuntimeEnvNumber,
  getRuntimeBool,
} from './runtime-settings';

const cooldowns = new Map<string, number>();

/**
 * 通过飞书自定义机器人推送告警。
 * 同一 key 在冷却时间内只发送一次；未配置 Webhook 时直接跳过。
 */
export async function sendFeishuAlert(
  key: string,
  title: string,
  lines: string[],
): Promise<void> {
  if (!getRuntimeBool('ALERTS_ENABLED', true)) return;

  const webhook = getRuntimeEnv('FEISHU_WEBHOOK_URL').trim();
  if (!webhook) return;

  const cooldownMs =
    getRuntimeEnvNumber('ALERT_COOLDOWN_MINUTES', 60, 5, 1440) * 60_000;
  const now = Date.now();
  if (now - (cooldowns.get(key) ?? 0) < cooldownMs) return;
  cooldowns.set(key, now);

  const payload: Record<string, unknown> = {
    msg_type: 'text',
    content: { text: [title, ...lines].join('\n') },
  };

  const secret = getRuntimeEnv('FEISHU_WEBHOOK_SECRET').trim();
  if (secret) {
    const timestamp = String(Math.floor(now / 1000));
    const sign = createHmac('sha256', `${timestamp}\n${secret}`)
      .update('')
      .digest('base64');
    payload.timestamp = timestamp;
    payload.sign = sign;
  }

  try {
    await request(
      webhook,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      10_000,
    );
  } catch (error) {
    console.warn(
      `[alert] 飞书告警发送失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
