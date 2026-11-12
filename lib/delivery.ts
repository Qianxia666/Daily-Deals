import {
  countUserPushesToday,
  getDigestLastRun,
  getSiteDigestStats,
  insertDailyDigest,
  listDigestRecipients,
  listPendingDeliveries,
  listPendingDigests,
  listTodayDealsForDigest,
  markDeliveriesDigested,
  markDeliveriesSkipped,
  markDeliveryFailed,
  markDeliverySent,
  markDigestFailed,
  markDigestSent,
  matchDealToSubscriptions,
  pruneDailyDigests,
  setDigestLastRun,
  type PendingDelivery,
  type SiteDigestDeal,
} from './db';
import { sendNotification, type NotifyItem, type NotifyTarget } from './notify';
import { ensurePublicDigest, refreshPublicDigest } from './digest';
import {
  getAccountLimits,
  getRuntimeEnvNumber,
  getRuntimeEnvRaw,
  getSiteUrl,
} from './runtime-settings';
import type { DigestItem } from './types';

const runtime = globalThis as typeof globalThis & {
  __dailyDealsDeliveryRunning?: boolean;
  __dailyDealsDigestRunning?: boolean;
};

const DEFAULT_OVERFLOW_TIME = '20:30';
const DEFAULT_SITE_TIME = '21:00';

function shanghaiNow(): { date: string; time: string } {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const iso = shifted.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function runtimeEnabled(key: string): boolean {
  return (getRuntimeEnvRaw(key) ?? 'true') !== 'false';
}

function runtimeTime(key: string, fallback: string): string {
  const raw = (getRuntimeEnvRaw(key) ?? '').trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : fallback;
}

function truncate(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function dealUrl(dealId: number, fallback: string): string {
  const siteUrl = getSiteUrl();
  return siteUrl ? `${siteUrl}/deal/${dealId}` : fallback;
}

function toDigestItem(
  dealId: number,
  title: string,
  fallbackUrl: string,
): DigestItem {
  return {
    dealId,
    title: truncate(title, 40),
    url: dealUrl(dealId, fallbackUrl),
  };
}

/**
 * 新优惠完成 AI 打标后调用：把命中的订阅展开成待投递记录。
 * 匹配是幂等的，重复调用不会重复入队。
 */
export function matchSubscriptionsForDeal(dealId: number): void {
  try {
    matchDealToSubscriptions(dealId, {
      expand: runtimeEnabled('SUBSCRIPTION_MATCH_EXPAND_ENABLED'),
      minScore: getRuntimeEnvNumber('SUBSCRIPTION_MATCH_MIN_SCORE', 2, 1, 8),
    });
  } catch (error) {
    console.warn(
      `[delivery] 订阅匹配失败（deal=${dealId}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** 处理待投递队列，受每人每日推送上限约束；超限部分交给合并摘要。 */
export async function deliverPending(): Promise<void> {
  if (runtime.__dailyDealsDeliveryRunning) return;

  const limits = getAccountLimits();
  // 满额用户的条目留在队列里会让其他用户永远排不上，这里直接排除。
  const pending = listPendingDeliveries(30, {
    skipSaturatedUsers: limits.dailyPush,
  });
  if (pending.length === 0) return;

  runtime.__dailyDealsDeliveryRunning = true;

  try {
    const sentByUser = new Map<number, number>();

    for (const item of pending) {
      const sent = sentByUser.get(item.userId) ?? countUserPushesToday(item.userId);
      if (sent >= limits.dailyPush) {
        // 超出今日限额的留在队列，20:30 合并推送；不会顺延到次日。
        sentByUser.set(item.userId, sent);
        continue;
      }

      try {
        // 通知栏第一行放优惠本身，关键词与标签收进最后一行元信息。
        const keyword = truncate(item.keyword, 12);
        const meta =
          item.tags.length > 0
            ? `关键词「${keyword}」· 标签 ${item.tags.slice(0, 2).join(' / ')}`
            : `关键词「${keyword}」`;
        await sendNotification(
          {
            kind: item.channelKind,
            webhook: item.webhook,
            secret: item.secret,
            key: item.channelKey,
          },
          {
            title: truncate(item.dealTitle, 20),
            lines: [truncate(item.aiSummary, 40), meta].filter(Boolean),
            link: dealUrl(item.dealId, item.dealLink),
            group: keyword,
          },
        );
        markDeliverySent(item.id);
        sentByUser.set(item.userId, sent + 1);
      } catch (error) {
        markDeliveryFailed(
          item.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } catch (error) {
    console.warn(
      `[delivery] 投递任务失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    runtime.__dailyDealsDeliveryRunning = false;
  }
}

interface OverflowGroup {
  userId: number;
  channelId: number;
  target: NotifyTarget;
  deals: Map<number, DigestItem>;
  keywords: Set<string>;
}

function groupOverflow(pending: PendingDelivery[]): OverflowGroup[] {
  const groups = new Map<string, OverflowGroup>();

  for (const item of pending) {
    const key = `${item.userId}:${item.channelId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        userId: item.userId,
        channelId: item.channelId,
        target: {
          kind: item.channelKind,
          webhook: item.webhook,
          secret: item.secret,
          key: item.channelKey,
        },
        deals: new Map(),
        keywords: new Set(),
      };
      groups.set(key, group);
    }
    group.keywords.add(item.keyword);
    if (!group.deals.has(item.dealId)) {
      group.deals.set(
        item.dealId,
        toDigestItem(item.dealId, item.dealTitle, item.dealLink),
      );
    }
  }

  return [...groups.values()];
}

/** 生成 20:30 的超限合并摘要。 */
export async function runOverflowDigest(date: string): Promise<void> {
  if (!runtimeEnabled('DIGEST_OVERFLOW_ENABLED')) return;

  ensurePublicDigest(date);
  const pending = listPendingDeliveries(500);
  if (pending.length === 0) return;

  const limits = getAccountLimits();
  const sentByUser = new Map<number, number>();

  for (const group of groupOverflow(pending)) {
    const sent =
      sentByUser.get(group.userId) ?? countUserPushesToday(group.userId);
    sentByUser.set(group.userId, sent);

    const unique = [...group.deals.values()];
    if (unique.length === 0) continue;
    // 今日剩余额度足够逐条推送时交给即时推送；否则合并成一条，
    // 避免 20:30 之后才达标的条目拖到次日被静默丢弃。
    if (unique.length <= limits.dailyPush - sent) continue;

    const items = unique.slice(0, 100);

    const keywords = [...group.keywords];
    const label =
      keywords.length === 1 ? `「${truncate(keywords[0], 12)}」` : '订阅';
    const lines =
      keywords.length > 1
        ? [`关键词：${keywords.slice(0, 3).map((word) => truncate(word, 12)).join(' · ')}`]
        : [];
    if (unique.length > items.length) {
      lines.push(`仅展示前 ${items.length} 条`);
    }

    insertDailyDigest({
      userId: group.userId,
      channelId: group.channelId,
      kind: 'overflow',
      date,
      title: `今日还有 ${unique.length} 条${label}相关优惠`,
      lines,
      items,
    });
  }
}

/** 按品类轮转挑选，避免全站汇总被单一品类占满。 */
function pickSiteDeals(
  deals: SiteDigestDeal[],
  limit: number,
): SiteDigestDeal[] {
  const buckets = new Map<string, SiteDigestDeal[]>();
  for (const deal of deals) {
    const tag = deal.tags[0] ?? '其他';
    const bucket = buckets.get(tag) ?? [];
    bucket.push(deal);
    buckets.set(tag, bucket);
  }

  const picked: SiteDigestDeal[] = [];
  while (picked.length < limit) {
    let added = false;
    for (const bucket of buckets.values()) {
      if (bucket.length === 0) continue;
      const next = bucket.shift();
      if (!next) continue;
      picked.push(next);
      added = true;
      if (picked.length >= limit) break;
    }
    if (!added) break;
  }
  return picked;
}

function formatMonthDay(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}月${Number(day)}日`;
}

/** 生成 21:00 的全站优惠汇总。 */
export async function runSiteDigest(date: string): Promise<void> {
  if (!runtimeEnabled('DIGEST_SITE_ENABLED')) return;

  refreshPublicDigest(date);
  const stats = getSiteDigestStats();
  if (stats.newCount === 0) return;

  const limit = getRuntimeEnvNumber('DIGEST_SITE_MAX_ITEMS', 8, 1, 8);
  const deals = pickSiteDeals(listTodayDealsForDigest(60), limit);
  if (deals.length === 0) return;

  const items = deals.map((deal) =>
    toDigestItem(deal.id, deal.title, deal.link),
  );
  const lines = [
    `今日新增 ${stats.newCount} 条，当前在架 ${stats.activeCount} 条`,
    stats.topTags.length > 0 ? `热门品类：${stats.topTags.join(' · ')}` : '',
  ].filter(Boolean);

  for (const recipient of listDigestRecipients()) {
    insertDailyDigest({
      userId: recipient.userId,
      channelId: recipient.channelId,
      kind: 'site',
      date,
      title: `今日全站优惠汇总 · ${formatMonthDay(date)}`,
      lines,
      items,
    });
  }
}

/** 发送已生成的摘要；每用户每渠道每天仅一条。 */
export async function deliverPendingDigests(): Promise<void> {
  if (runtime.__dailyDealsDigestRunning) return;

  const digests = listPendingDigests(10);
  if (digests.length === 0) return;

  runtime.__dailyDealsDigestRunning = true;

  try {
    const siteUrl = getSiteUrl();
    for (const digest of digests) {
      const shown =
        digest.kind === 'site' ? digest.items.slice(0, 8) : digest.items.slice(0, 6);
      const remaining = digest.items.length - shown.length;
      const lines = [...digest.lines];
      if (remaining > 0) lines.push(`另有 ${remaining} 条，点击查看全部`);

      const items: NotifyItem[] = shown.map((item) => ({
        title: item.title,
        url: item.url,
      }));
      const link = siteUrl
        ? `${siteUrl}/digest/${digest.digestDate}`
        : digest.items[0]?.url;

      try {
        await sendNotification(
          {
            kind: digest.channelKind,
            webhook: digest.webhook,
            secret: digest.secret,
            key: digest.channelKey,
          },
          {
            title: digest.title,
            lines,
            link,
            items,
          },
        );
        markDigestSent(digest.id);
        if (digest.kind === 'overflow') {
          markDeliveriesDigested(
            digest.userId,
            digest.channelId,
            digest.items.map((item) => item.dealId),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        markDigestFailed(digest.id, message);
        if (digest.attempts + 1 >= 3 && digest.kind === 'overflow') {
          markDeliveriesSkipped(
            digest.userId,
            digest.channelId,
            digest.items.map((item) => item.dealId),
          );
        }
      }
    }
  } finally {
    runtime.__dailyDealsDigestRunning = false;
  }
}

/** 每分钟检查一次，到达配置时间后当天只执行一次。 */
export async function runScheduledDigests(): Promise<void> {
  const { date, time } = shanghaiNow();

  if (
    time >= runtimeTime('DIGEST_OVERFLOW_TIME', DEFAULT_OVERFLOW_TIME) &&
    getDigestLastRun('overflow') !== date
  ) {
    try {
      await runOverflowDigest(date);
    } catch (error) {
      console.warn(
        `[digest] 超限合并失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setDigestLastRun('overflow', date);
    }
  }

  if (
    time >= runtimeTime('DIGEST_SITE_TIME', DEFAULT_SITE_TIME) &&
    getDigestLastRun('site') !== date
  ) {
    try {
      await runSiteDigest(date);
    } catch (error) {
      console.warn(
        `[digest] 全站汇总失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setDigestLastRun('site', date);
      pruneDailyDigests(30);
    }
  }
}
