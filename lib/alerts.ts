import { sendNotification, CHANNEL_LABELS } from './notify';
import {
  getNotifyConfig,
  getRuntimeBool,
  getRuntimeEnvNumber,
  type NotifyKind,
} from './runtime-settings';

const cooldowns = new Map<string, number>();
const KINDS: NotifyKind[] = ['wecom', 'feishu', 'dingtalk', 'bark'];

/**
 * 后台告警：向所有已启用并配置好的通知渠道推送。
 * 同一 key 在冷却时间内只发送一次；没有任何渠道配置时直接跳过。
 */
export async function sendAdminAlert(
  key: string,
  title: string,
  lines: string[],
): Promise<void> {
  if (!getRuntimeBool('ALERTS_ENABLED', true)) return;

  const targets = KINDS.map((kind) => ({ kind, config: getNotifyConfig(kind) }))
    .filter(
      ({ config }) => config.enabled && Boolean(config.webhook || config.key),
    );
  if (targets.length === 0) return;

  const cooldownMs =
    getRuntimeEnvNumber('ALERT_COOLDOWN_MINUTES', 60, 5, 1440) * 60_000;
  const now = Date.now();
  if (now - (cooldowns.get(key) ?? 0) < cooldownMs) return;

  let delivered = false;
  await Promise.all(
    targets.map(async ({ kind, config }) => {
      try {
        await sendNotification(
          {
            kind,
            webhook: config.webhook,
            secret: config.secret,
            key: config.key,
          },
          { title, lines },
        );
        delivered = true;
      } catch (error) {
        console.warn(
          `[alert] ${CHANNEL_LABELS[kind]}告警发送失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }),
  );

  // 只有至少一个渠道发送成功才进入冷却，否则下次仍可重试。
  if (delivered) cooldowns.set(key, now);
}
