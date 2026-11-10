import {
  getPublicDigest,
  listDealsForPublicDigest,
  savePublicDigest,
  todayKey,
} from './db';
import { getRuntimeEnv } from './runtime-settings';
import type {
  PublicDigest,
  PublicDigestGroup,
  PublicDigestItem,
} from './types';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TAGS = 10;
const MAX_ITEMS_PER_TAG = 8;

/** 泛化标签不作为热词展示。 */
const GENERIC_TAGS = new Set([
  '其他',
  '其它',
  'other',
  'others',
  'discount',
  'discounts',
  'membership',
  'free',
  'deal',
  'deals',
  'promo',
  'promotion',
  'sale',
  'coupon',
]);

function isGenericTag(tag: string): boolean {
  return GENERIC_TAGS.has(tag.trim().toLowerCase());
}

function siteBaseUrl(): string {
  return (getRuntimeEnv('SITE_URL', '') ?? '').trim().replace(/\/+$/, '');
}

function validDateParts(value: string): { year: number; month: number; day: number } | null {
  if (!DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** 仅允许真实存在且不晚于今天的日期。 */
export function isValidDigestDate(value: string): boolean {
  const parts = validDateParts(value);
  if (!parts) return false;
  return value <= todayKey();
}

export function buildPublicDigest(date: string): PublicDigest {
  const parts = validDateParts(date);
  const deals = listDealsForPublicDigest(date);
  const now = Date.now();
  const base = siteBaseUrl();

  const tagCounts = new Map<string, number>();
  for (const deal of deals) {
    for (const raw of deal.tags) {
      const tag = raw.trim();
      if (!tag || isGenericTag(tag)) continue;
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const ranked = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
    .slice(0, MAX_TAGS);

  const rank = new Map(ranked.map((item, index) => [item.tag, index]));
  const buckets: PublicDigestItem[][] = ranked.map(() => []);
  const others: PublicDigestItem[] = [];

  for (const deal of deals) {
    const item: PublicDigestItem = {
      dealId: deal.id,
      title: deal.title,
      url: base ? `${base}/deal/${deal.id}` : `/deal/${deal.id}`,
      source: deal.source,
      tags: deal.tags,
      expired: Boolean(deal.expiresAt && new Date(deal.expiresAt).getTime() <= now),
    };

    let chosen = -1;
    for (const tag of deal.tags) {
      const index = rank.get(tag.trim());
      if (index !== undefined && (chosen < 0 || index < chosen)) chosen = index;
    }

    if (chosen >= 0) {
      if (buckets[chosen].length < MAX_ITEMS_PER_TAG) {
        buckets[chosen].push(item);
      }
    } else if (others.length < MAX_ITEMS_PER_TAG) {
      others.push(item);
    }
  }

  const groups: PublicDigestGroup[] = ranked
    .map((entry, index) => ({
      tag: entry.tag,
      count: entry.count,
      items: buckets[index],
    }))
    .filter((group) => group.items.length > 0);

  if (others.length > 0) {
    groups.push({
      tag: '其他优惠',
      count: others.length,
      items: others,
    });
  }

  if (groups.length === 0 && deals.length > 0) {
    groups.push({
      tag: '最新收录',
      count: deals.length,
      items: deals.slice(0, MAX_ITEMS_PER_TAG).map((deal) => ({
        dealId: deal.id,
        title: deal.title,
        url: base ? `${base}/deal/${deal.id}` : `/deal/${deal.id}`,
        source: deal.source,
        tags: deal.tags,
        expired: Boolean(
          deal.expiresAt && new Date(deal.expiresAt).getTime() <= now,
        ),
      })),
    });
  }

  const active = deals.filter(
    (deal) => !deal.expiresAt || new Date(deal.expiresAt).getTime() > now,
  ).length;
  const label = parts ? `${parts.month}月${parts.day}日` : date;

  return {
    date,
    title: `${label}优惠汇总`,
    stats: [`当日收录 ${deals.length} 条，其中在架 ${active} 条`],
    tags: ranked,
    groups,
  };
}

export function ensurePublicDigest(date: string): PublicDigest {
  const existing = getPublicDigest(date);
  if (existing) return existing;
  const digest = buildPublicDigest(date);
  savePublicDigest(digest);
  return digest;
}

export function refreshPublicDigest(date: string): PublicDigest {
  const digest = buildPublicDigest(date);
  savePublicDigest(digest);
  return digest;
}
