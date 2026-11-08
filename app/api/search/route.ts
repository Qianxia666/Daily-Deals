import { NextResponse, type NextRequest } from 'next/server';
import { CATEGORY_LABELS } from '@/lib/constants';
import {
  getAiSearchEnabled,
  getDataRetentionDays,
  getDealsSnapshot,
} from '@/lib/db';
import {
  getAiSearchCoarseStrategy,
  getAiSearchDays,
  getAiSearchMaxItems,
  getKeywordSearchDays,
  getRuntimeBool,
  getRuntimeEnvNumber,
} from '@/lib/runtime-settings';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import {
  searchDealsWithAi,
  type AiSearchDeal,
} from '@/lib/llm';
import type { DealItem } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SearchBody {
  query?: unknown;
  mode?: unknown;
}

type SearchMode = 'ai' | 'keyword';

interface SearchResponse {
  query: string;
  mode: SearchMode;
  ids: number[];
  reason: string;
  windowDays: number;
}

interface CacheEntry {
  expiresAt: number;
  payload: SearchResponse;
}

const aiCache = new Map<string, CacheEntry>();

/** 超出提交上限时按策略粗筛，避免只截取最新的一段。 */
function coarseSelect(
  items: DealItem[],
  max: number,
  strategy: 'balanced' | 'recent',
): DealItem[] {
  if (items.length <= max) return items;
  if (strategy === 'recent') return items.slice(0, max);

  const groups = new Map<string, DealItem[]>();
  for (const item of items) {
    const list = groups.get(item.source) ?? [];
    list.push(item);
    groups.set(item.source, list);
  }

  const lists = [...groups.values()];
  const selected: DealItem[] = [];
  for (let round = 0; selected.length < max; round += 1) {
    let added = false;
    for (const list of lists) {
      const item = list[round];
      if (!item) continue;
      selected.push(item);
      added = true;
      if (selected.length >= max) break;
    }
    if (!added) break;
  }
  return selected;
}

/** AI 搜索只使用标题：优先展示标题，同时保留原标题以补足关键词。 */
function searchableTitle(item: DealItem): string {
  const displayTitle = item.aiTitle?.trim() || item.title;
  if (item.aiTitle && item.aiTitle !== item.title) {
    return `${displayTitle} ${item.title}`.trim();
  }
  return displayTitle;
}

function withinDays(item: DealItem, days: number): boolean {
  const timestamp = Date.parse(item.publishedAt ?? item.firstSeenAt);
  if (Number.isNaN(timestamp)) return true;
  return timestamp >= Date.now() - days * 24 * 60 * 60 * 1000;
}

function keywordMatches(
  items: DealItem[],
  query: string,
  titleOnly: boolean,
): number[] {
  const needle = query.toLowerCase();
  const tokens = needle.split(/\s+/).filter(Boolean);

  return items
    .filter((item) => {
      const haystack = (
        titleOnly
          ? searchableTitle(item)
          : [
              item.title,
              item.aiTitle ?? '',
              item.aiSummary ?? '',
              item.description,
              item.sourceName,
              CATEGORY_LABELS[item.category],
            ].join(' ')
      ).toLowerCase();

      if (haystack.includes(needle)) return true;
      return tokens.length > 1 && tokens.every((token) => haystack.includes(token));
    })
    .map((item) => item.id);
}

export async function POST(request: NextRequest) {
  if (getRuntimeBool('RATE_LIMIT_ENABLED', true)) {
    const limit = getRuntimeEnvNumber(
      'SEARCH_RATE_LIMIT_PER_MINUTE',
      60,
      1,
      300,
    );
    const result = checkRateLimit(`search:${getClientIp(request)}`, limit);
    if (!result.ok) {
      return NextResponse.json(
        { error: '请求过于频繁，请稍后再试' },
        {
          status: 429,
          headers: {
            'Retry-After': String(result.retryAfter),
            'Cache-Control': 'no-store',
          },
        },
      );
    }
  }

  const body = (await request.json().catch(() => null)) as SearchBody | null;
  const query =
    typeof body?.query === 'string' ? body.query.trim().slice(0, 80) : '';

  if (!query) {
    return NextResponse.json({ error: '请输入搜索内容' }, { status: 400 });
  }

  const requestedMode: SearchMode =
    body?.mode === 'keyword' ? 'keyword' : 'ai';
  const aiEnabled = getAiSearchEnabled();
  const mode: SearchMode =
    requestedMode === 'ai' && aiEnabled ? 'ai' : 'keyword';
  const windowDays = Math.max(
    1,
    Math.min(
      mode === 'ai' ? getAiSearchDays() : getKeywordSearchDays(),
      getDataRetentionDays(),
    ),
  );

  const snapshot = getDealsSnapshot();
  const scoped = snapshot.items.filter((item) => withinDays(item, windowDays));

  if (scoped.length === 0) {
    const payload: SearchResponse = {
      query,
      mode,
      ids: [],
      reason: `最近 ${windowDays} 天没有可搜索的优惠`,
      windowDays,
    };
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  if (mode === 'keyword') {
    const payload: SearchResponse = {
      query,
      mode,
      ids: keywordMatches(scoped, query, false),
      reason:
        requestedMode === 'ai'
          ? 'AI 搜索已被管理员关闭，已按关键词匹配'
          : `普通搜索匹配最近 ${windowDays} 天的标题与摘要`,
      windowDays,
    };
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const maxItems = getAiSearchMaxItems();
  const candidates = coarseSelect(
    scoped,
    maxItems,
    getAiSearchCoarseStrategy(),
  );

  const searchable: AiSearchDeal[] = candidates.map((item) => ({
    id: item.id,
    title: searchableTitle(item),
  }));

  const cacheEnabled = getRuntimeBool('AI_SEARCH_CACHE_ENABLED', true);
  const cacheKey = `${query}\u0000${windowDays}\u0000${scoped.length}\u0000${
    scoped[0]?.id ?? 0
  }`;
  if (cacheEnabled) {
    const hit = aiCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return NextResponse.json(hit.payload, {
        headers: { 'Cache-Control': 'no-store', 'X-Search-Cache': 'hit' },
      });
    }
  }

  const selection = await searchDealsWithAi(query, searchable);
  console.log(
    `[search] ai window=${windowDays}d candidates=${scoped.length} sent=${searchable.length}`,
  );

  if (selection) {
    const payload: SearchResponse = {
      query,
      mode: 'ai',
      ids: selection.ids,
      reason: selection.reason,
      windowDays,
    };

    if (cacheEnabled) {
      if (aiCache.size > 500) {
        const now = Date.now();
        for (const [key, entry] of aiCache) {
          if (entry.expiresAt <= now) aiCache.delete(key);
        }
        if (aiCache.size > 500) aiCache.clear();
      }
      aiCache.set(cacheKey, {
        expiresAt:
          Date.now() +
          getRuntimeEnvNumber('AI_SEARCH_CACHE_MINUTES', 5, 1, 120) * 60_000,
        payload,
      });
    }

    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const payload: SearchResponse = {
    query,
    mode: 'keyword',
    ids: keywordMatches(scoped, query, true),
    reason: 'AI 暂不可用，已按标题关键词匹配',
    windowDays,
  };

  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
