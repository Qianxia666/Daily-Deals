import { NextResponse, type NextRequest } from 'next/server';
import { CATEGORY_LABELS } from '@/lib/constants';
import {
  getAiSearchEnabled,
  getDataRetentionDays,
  getDealsSnapshot,
  getLastFetchedAt,
  getVisibleSourceIds,
  searchDealsForQuery,
  searchDealsForQueryLike,
} from '@/lib/db';
import {
  getAiSearchCoarseStrategy,
  getAiSearchDays,
  getAiSearchFtsEnabled,
  getAiSearchMaxItems,
  getAiSearchMaxPerSource,
  getAiSearchRecallLimit,
  getAiSearchRerankEnabled,
  getAiSearchRerankLimit,
  getAiSearchScope,
  getAiSearchSynonymEnabled,
  getAiSearchUseSummary,
  getKeywordSearchDays,
  getKeywordSearchMaxResults,
  getRuntimeBool,
  getRuntimeEnvNumber,
} from '@/lib/runtime-settings';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import {
  searchDealsWithAi,
  type AiSearchDeal,
} from '@/lib/llm';
import type { SearchCandidate } from '@/lib/search-index';
import { buildFtsQuery } from '@/lib/search-text';
import type { Category, DealItem } from '@/lib/types';

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

/** 旧回退路径：超出提交上限时按策略粗筛，避免只截取最新的一段。 */
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

/** 优先展示 AI 标题，同时保留原标题以补足关键词。 */
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

function isActive(item: DealItem): boolean {
  if (!item.expiresAt) return true;
  const timestamp = Date.parse(item.expiresAt);
  return Number.isNaN(timestamp) || timestamp > Date.now();
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

function freshnessScore(row: SearchCandidate): number {
  const timestamp = Date.parse(row.publishedAt ?? row.firstSeenAt);
  if (Number.isNaN(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  return Math.max(0, 1 - ageDays / 30);
}

/** 在全文召回结果上叠加新鲜度，并按来源配额做二次排序。 */
function rankCandidates(
  items: SearchCandidate[],
  maxPerSource: number,
  limit: number,
): SearchCandidate[] {
  const scored = items
    .map((item) => ({
      item,
      score: -item.rank + freshnessScore(item) * 0.8,
    }))
    .sort((left, right) => right.score - left.score);

  const selected: SearchCandidate[] = [];
  const selectedIds = new Set<number>();
  const sourceCounts = new Map<string, number>();

  for (const { item } of scored) {
    if (
      maxPerSource > 0 &&
      (sourceCounts.get(item.source) ?? 0) >= maxPerSource
    ) {
      continue;
    }
    selected.push(item);
    selectedIds.add(item.id);
    sourceCounts.set(item.source, (sourceCounts.get(item.source) ?? 0) + 1);
    if (selected.length >= limit) break;
  }

  if (selected.length < limit) {
    for (const { item } of scored) {
      if (selectedIds.has(item.id)) continue;
      selected.push(item);
      selectedIds.add(item.id);
      if (selected.length >= limit) break;
    }
  }

  return selected;
}

function candidateToSearchDeal(
  row: SearchCandidate,
  useSummary: boolean,
): AiSearchDeal {
  const title = row.aiTitle?.trim()
    ? `${row.aiTitle} ${row.title}`.trim()
    : row.title;

  return {
    id: row.id,
    title,
    summary: useSummary
      ? row.aiSummary ?? row.description.slice(0, 120)
      : '',
    category:
      CATEGORY_LABELS[row.category as Category] ?? row.category,
    source: row.sourceName,
    expiresAt: row.expiresAt,
  };
}

function dealToSearchDeal(
  item: DealItem,
  useSummary: boolean,
): AiSearchDeal {
  return {
    id: item.id,
    title: searchableTitle(item),
    summary: useSummary
      ? item.aiSummary ?? item.description.slice(0, 120)
      : '',
    category: CATEGORY_LABELS[item.category] ?? item.category,
    source: item.sourceName,
    expiresAt: item.expiresAt,
  };
}

function emptyResponse(
  query: string,
  reason: string,
  windowDays: number,
): NextResponse {
  return NextResponse.json(
    {
      query,
      mode: 'keyword',
      ids: [],
      reason,
      windowDays,
    } satisfies SearchResponse,
    { headers: { 'Cache-Control': 'no-store' } },
  );
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

  const retention = Math.max(1, getDataRetentionDays());
  const scope = mode === 'ai' ? getAiSearchScope() : 'days';
  const activeOnly = scope === 'active';

  const baseDays =
    mode === 'ai' ? getAiSearchDays() : getKeywordSearchDays();
  const days = activeOnly
    ? null
    : Math.max(1, Math.min(baseDays, retention));
  const windowDays = Math.max(1, Math.min(retention, days ?? retention));

  const keywordMax = getKeywordSearchMaxResults();
  const recallLimit = getAiSearchRecallLimit();
  const rerankLimit = getAiSearchRerankLimit();
  const useSummary = getAiSearchUseSummary();
  const ftsEnabled = getAiSearchFtsEnabled();
  const synonyms = getAiSearchSynonymEnabled();

  const fetchLimit =
    mode === 'ai'
      ? Math.min(Math.max(recallLimit * 2, 120), 400)
      : Math.min(Math.max(keywordMax * 2, 100), 500);

  const scopeOptions = {
    activeOnly,
    days,
    visibleSources: getVisibleSourceIds(),
    limit: fetchLimit,
  };

  let candidates: SearchCandidate[] | null = null;
  let ftsUsed = false;

  if (ftsEnabled) {
    const match = buildFtsQuery(query, { synonyms });
    if (match) {
      candidates = searchDealsForQuery(match, scopeOptions);
      ftsUsed = candidates !== null;
    }

    if (!candidates || candidates.length === 0) {
      const likeCandidates = searchDealsForQueryLike(query, scopeOptions);
      if (likeCandidates.length > 0) candidates = likeCandidates;
    }
  }

  if (mode === 'keyword') {
    if (candidates && candidates.length > 0) {
      const ids = rankCandidates(candidates, 0, keywordMax).map(
        (row) => row.id,
      );
      const payload: SearchResponse = {
        query,
        mode: 'keyword',
        ids,
        reason: activeOnly
          ? '普通搜索匹配所有在架优惠'
          : `普通搜索匹配最近 ${windowDays} 天的标题与摘要`,
        windowDays,
      };
      return NextResponse.json(payload, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (!ftsEnabled || candidates === null) {
      const snapshot = getDealsSnapshot();
      const scoped = snapshot.items.filter((item) =>
        activeOnly ? isActive(item) : withinDays(item, windowDays),
      );
      const payload: SearchResponse = {
        query,
        mode: 'keyword',
        ids: keywordMatches(scoped, query, false),
        reason:
          requestedMode === 'ai'
            ? 'AI 搜索已被管理员关闭，已按关键词匹配'
            : activeOnly
              ? '普通搜索匹配所有在架优惠'
              : `普通搜索匹配最近 ${windowDays} 天的标题与摘要`,
        windowDays,
      };
      return NextResponse.json(payload, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    return emptyResponse(
      query,
      activeOnly
        ? '在架优惠中没有找到相关结果'
        : `最近 ${windowDays} 天没有找到相关优惠`,
      windowDays,
    );
  }

  let searchable: AiSearchDeal[] = [];
  let ranked: SearchCandidate[] = [];

  if (candidates && candidates.length > 0) {
    ranked = rankCandidates(
      candidates,
      getAiSearchMaxPerSource(),
      recallLimit,
    );
    searchable = ranked.map((row) =>
      candidateToSearchDeal(row, useSummary),
    );
  } else if (!ftsEnabled || candidates === null) {
    const snapshot = getDealsSnapshot();
    const scoped = snapshot.items.filter((item) =>
      activeOnly ? isActive(item) : withinDays(item, windowDays),
    );
    if (scoped.length === 0) {
      return emptyResponse(
        query,
        activeOnly
          ? '当前没有可搜索的在架优惠'
          : `最近 ${windowDays} 天没有可搜索的优惠`,
        windowDays,
      );
    }

    const selected = coarseSelect(
      scoped,
      getAiSearchMaxItems(),
      getAiSearchCoarseStrategy(),
    );
    searchable = selected.map((item) =>
      dealToSearchDeal(item, useSummary),
    );
  } else {
    return emptyResponse(
      query,
      activeOnly
        ? '在架优惠中没有找到相关结果，试试换个说法'
        : `最近 ${windowDays} 天没有找到相关优惠`,
      windowDays,
    );
  }

  if (searchable.length === 0) {
    return emptyResponse(query, '没有找到相关优惠', windowDays);
  }

  const cacheEnabled = getRuntimeBool('AI_SEARCH_CACHE_ENABLED', true);
  const cacheKey = [
    query,
    activeOnly ? 'active' : `days:${days}`,
    recallLimit,
    rerankLimit,
    useSummary ? 'summary' : 'title',
    synonyms ? 'syn' : 'plain',
    getLastFetchedAt() ?? '',
    candidates?.length ?? 0,
  ].join('\u0000');

  if (cacheEnabled) {
    const hit = aiCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return NextResponse.json(hit.payload, {
        headers: { 'Cache-Control': 'no-store', 'X-Search-Cache': 'hit' },
      });
    }
  }

  if (!getAiSearchRerankEnabled()) {
    const ids = (ftsUsed ? ranked : searchable.map((item) => ({ id: item.id })))
      .slice(0, rerankLimit)
      .map((row) => row.id);
    const payload: SearchResponse = {
      query,
      mode: 'ai',
      ids,
      reason: '已按全文索引与新鲜度排序（AI 精排已关闭）',
      windowDays,
    };
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const selection = await searchDealsWithAi(
    query,
    searchable,
    rerankLimit,
  );

  const fallbackIds = (
    ftsUsed ? ranked : searchable.map((item) => ({ id: item.id }))
  )
    .slice(0, rerankLimit)
    .map((row) => row.id);

  console.log(
    `[search] mode=ai scope=${activeOnly ? 'active' : `${days}d`} fts=${
      ftsUsed ? 1 : 0
    } matched=${candidates?.length ?? 0} sent=${searchable.length} ai=${
      selection ? 1 : 0
    }`,
  );

  if (selection) {
    const payload: SearchResponse = {
      query,
      mode: 'ai',
      ids: selection.ids,
      reason:
        selection.reason ||
        '已按全文索引召回并结合标题与摘要精排',
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
    ids: fallbackIds,
    reason: 'AI 暂不可用，已按全文索引与摘要匹配',
    windowDays,
  };

  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
