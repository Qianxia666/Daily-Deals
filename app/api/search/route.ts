import { NextResponse, type NextRequest } from 'next/server';
import {
  getAiSearchEnabled,
  getDataRetentionDays,
  getDealsSnapshot,
  getLastFetchedAt,
  getTagSuggestions,
  getVisibleSourceIds,
  listFormalTagCounts,
  searchDealsForQuery,
  searchDealsForTag,
  consumeAiQuota,
} from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  getAiSearchCoarseStrategy,
  getAiSearchDays,
  getAiSearchFtsEnabled,
  getAiSearchMaxItems,
  getAiSearchMaxPerSource,
  getAiSearchRecallLimit,
  getAiSearchRerankEnabled,
  getAiSearchRerankLimit,
  getAiSearchRewriteEnabled,
  getAiSearchRewriteOnEmptyRerank,
  getAiSearchRewritePerMinute,
  getAiSearchRewriteTimeoutMs,
  getAiSearchScope,
  getAiSearchSynonymEnabled,
  getAiSearchTagSuggestTimeoutMs,
  getAiSearchUseSummary,
  getAiSearchDailyLimit,
  getKeywordSearchDays,
  getKeywordSearchMaxResults,
  getRuntimeBool,
  getRuntimeEnvNumber,
  getSearchSuggestTags,
} from '@/lib/runtime-settings';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import {
  rewriteSearchQuery,
  searchDealsWithAi,
  suggestTagsForQuery,
  type AiSearchDeal,
} from '@/lib/llm';
import type { SearchCandidate, SearchScopeOptions } from '@/lib/search-index';
import { buildFtsQuery } from '@/lib/search-text';
import type { DealItem, TagSuggestion } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SearchBody {
  query?: unknown;
  mode?: unknown;
  tag?: unknown;
}

type SearchMode = 'ai' | 'keyword';

interface SearchResponse {
  query: string;
  mode: SearchMode;
  ids: number[];
  reason: string;
  windowDays: number;
  suggestedTags?: TagSuggestion[];
  truncated?: boolean;
}

interface CacheEntry {
  expiresAt: number;
  payload: SearchResponse;
}

const aiCache = new Map<string, CacheEntry>();
const rewriteCache = new Map<
  string,
  { expiresAt: number; keywords: string[] }
>();
const tagSuggestCache = new Map<
  string,
  { expiresAt: number; tags: TagSuggestion[] }
>();

/** 旧回退路径：超出提交上限时按策略粗筛，避免只截取最新的一段。 */
function coarseSelect(
  items: DealItem[],
  max: number,
  strategy: 'balanced' | 'recent',
  maxPerSource = 0,
): DealItem[] {
  if (maxPerSource <= 0 && items.length <= max) return items;

  if (strategy === 'recent') {
    if (maxPerSource <= 0) return items.slice(0, max);
    const counts = new Map<string, number>();
    const selected: DealItem[] = [];
    for (const item of items) {
      if ((counts.get(item.source) ?? 0) >= maxPerSource) continue;
      selected.push(item);
      counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
      if (selected.length >= max) break;
    }
    return selected;
  }

  const groups = new Map<string, DealItem[]>();
  for (const item of items) {
    const list = groups.get(item.source) ?? [];
    if (maxPerSource > 0 && list.length >= maxPerSource) continue;
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

  // 有单来源上限时不补足：补足会把刚被上限裁掉的同源条目重新加回来。
  if (maxPerSource <= 0 && selected.length < limit) {
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
    source: item.sourceName,
    expiresAt: item.expiresAt,
  };
}

/** 零结果标签建议：只推荐有结果可点的正式标签与高热度提议标签。 */
function buildSuggestions(
  keywords: string[],
  options: SearchScopeOptions,
): TagSuggestion[] {
  const limit = getSearchSuggestTags();
  if (limit <= 0) return [];
  try {
    return getTagSuggestions(keywords, options, limit);
  } catch (error) {
    console.warn('[search] tag suggestion failed', error);
    return [];
  }
}

/**
 * 两次召回都为空时，直接让模型从正式标签里挑相关的作为建议。
 * 调用失败才退回字面匹配；模型明确返回空数组时不做建议。
 */
async function buildSemanticSuggestions(
  query: string,
  keywords: string[],
  options: SearchScopeOptions,
): Promise<TagSuggestion[]> {
  const limit = getSearchSuggestTags();
  if (limit <= 0) return [];

  const cacheKey = `${limit}:${query.trim().toLowerCase()}`;
  const cached = tagSuggestCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.tags;

  try {
    const counts = listFormalTagCounts(options);
    if (counts.length === 0) return [];

    if (
      !checkRateLimit('search-tag-suggest', getAiSearchRewritePerMinute()).ok
    ) {
      return buildSuggestions([query, ...keywords], options);
    }

    const countByTag = new Map(counts.map((row) => [row.tag, row.count]));
    const picked = await suggestTagsForQuery(
      query,
      keywords,
      counts.map((row) => row.tag),
      limit,
      getAiSearchTagSuggestTimeoutMs(),
    );

    if (picked === null) {
      return buildSuggestions([query, ...keywords], options);
    }

    const tags = picked
      .map((tag) => ({ tag, count: countByTag.get(tag) ?? 0 }))
      .filter((item) => item.count > 0);

    if (tagSuggestCache.size > 500) tagSuggestCache.clear();
    tagSuggestCache.set(cacheKey, {
      expiresAt: Date.now() + 10 * 60_000,
      tags,
    });
    return tags;
  } catch (error) {
    console.warn('[search] ai tag suggestion failed', error);
    return buildSuggestions([query, ...keywords], options);
  }
}

function emptyResponse(
  query: string,
  reason: string,
  windowDays: number,
  suggestedTags: TagSuggestion[] = [],
): NextResponse {
  const payload: SearchResponse = {
    query,
    mode: 'keyword',
    ids: [],
    reason,
    windowDays,
    ...(suggestedTags.length > 0 ? { suggestedTags } : {}),
  };

  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * 改写搜索词并做第二次召回，复用于「首次召回为空」与「精排为空」两种情况。
 * 缓存与全站限流都在这里处理，调用方无需关心。
 */
async function rewriteRecall(
  query: string,
  scopeOptions: SearchScopeOptions,
  synonyms: boolean,
): Promise<{ keywords: string[]; candidates: SearchCandidate[] | null }> {
  const cacheKey = query.toLowerCase();
  let keywords: string[] = [];

  const cached = rewriteCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    keywords = cached.keywords;
  } else if (
    checkRateLimit('search-rewrite', getAiSearchRewritePerMinute()).ok
  ) {
    // 把站内正式标签一并交给模型，让它优先改写成真实存在的标签。
    let vocabulary: string[] = [];
    try {
      vocabulary = listFormalTagCounts(scopeOptions)
        .slice(0, 60)
        .map((row) => row.tag)
        .filter((tag) => tag !== '其他' && tag !== '其它');
    } catch (error) {
      console.warn('[search] rewrite vocabulary failed', error);
    }

    keywords = await rewriteSearchQuery(
      query,
      getAiSearchRewriteTimeoutMs(),
      vocabulary,
    );
    if (keywords.length > 0) {
      if (rewriteCache.size > 500) rewriteCache.clear();
      rewriteCache.set(cacheKey, {
        expiresAt: Date.now() + 10 * 60_000,
        keywords,
      });
    }
  }

  let candidates: SearchCandidate[] | null = null;
  if (keywords.length > 0) {
    const match = keywords
      .map((keyword) => buildFtsQuery(keyword, { synonyms }))
      .filter((value): value is string => Boolean(value))
      .join(' OR ');

    if (match) {
      const rewritten = searchDealsForQuery(match, scopeOptions);
      if (rewritten && rewritten.length > 0) candidates = rewritten;
    }
  }

  return { keywords, candidates };
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

  // 用户点击标签后走精确标签过滤，不调用 AI，也不做关键词召回。
  const selectedTag =
    typeof body?.tag === 'string' ? body.tag.trim().slice(0, 20) : '';
  if (selectedTag) {
    const TAG_RESULT_LIMIT = 100;
    // 多查一条用于判断是否被截断。
    const tagCandidates = searchDealsForTag(selectedTag, {
      ...scopeOptions,
      limit: TAG_RESULT_LIMIT + 1,
    });
    const truncated = tagCandidates.length > TAG_RESULT_LIMIT;
    const limited = truncated
      ? tagCandidates.slice(0, TAG_RESULT_LIMIT)
      : tagCandidates;
    // 标签筛选与 AI 精排无关，最多展示 100 条。
    const ids = rankCandidates(limited, 0, TAG_RESULT_LIMIT).map(
      (row) => row.id,
    );

    if (ids.length > 0) {
      const payload: SearchResponse = {
        query: selectedTag,
        mode,
        ids,
        reason: `已按标签「${selectedTag}」筛选`,
        windowDays,
        ...(truncated ? { truncated: true } : {}),
      };
      return NextResponse.json(payload, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    // 标签模式下不再推荐其他标签，避免循环推荐。
    return emptyResponse(
      selectedTag,
      `标签「${selectedTag}」下暂时没有在架优惠`,
      windowDays,
    );
  }

  // AI 搜索仅对登录用户开放，并按日扣减配额；关键词搜索无需登录。
  if (mode === 'ai') {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json(
        {
          error: '登录后即可使用 AI 搜索',
          code: 'AI_REQUIRES_LOGIN',
        },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const quota = consumeAiQuota(user.id, getAiSearchDailyLimit());
    if (!quota.ok) {
      return NextResponse.json(
        {
          error:
            quota.quota.limit > 0
              ? `今日 AI 搜索次数已用完（每天 ${quota.quota.limit} 次），明天再来或改用普通搜索`
              : '今日 AI 搜索次数已用完',
          code: 'AI_QUOTA_EXCEEDED',
        },
        { status: 429, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  let candidates: SearchCandidate[] | null = null;
  let ftsUsed = false;
  let rewriteKeywords: string[] = [];

  if (ftsEnabled) {
    const match = buildFtsQuery(query, { synonyms });
    if (match) {
      candidates = searchDealsForQuery(match, scopeOptions);
      ftsUsed = candidates !== null;
    }
  }

  // 第一次召回为零时，把口语搜索改写成品类词再试一次；只影响未命中的请求。
  if (
    mode === 'ai' &&
    ftsEnabled &&
    (!candidates || candidates.length === 0) &&
    query.length >= 2 &&
    getAiSearchRewriteEnabled()
  ) {
    const recalled = await rewriteRecall(
      query,
      scopeOptions,
      synonyms,
    );
    rewriteKeywords = recalled.keywords;
    if (recalled.candidates) candidates = recalled.candidates;
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
      buildSuggestions([query], scopeOptions),
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
      getAiSearchMaxPerSource(),
    );
    searchable = selected.map((item) =>
      dealToSearchDeal(item, useSummary),
    );
  } else {
    return emptyResponse(
      query,
      rewriteKeywords.length > 0
        ? activeOnly
          ? `在架优惠中没有找到相关结果，已尝试近义改写：${rewriteKeywords.join('、')}`
          : `最近 ${windowDays} 天没有找到相关优惠，已尝试近义改写：${rewriteKeywords.join('、')}`
        : activeOnly
          ? '在架优惠中没有找到相关结果，试试换个说法'
          : `最近 ${windowDays} 天没有找到相关优惠`,
      windowDays,
      await buildSemanticSuggestions(query, rewriteKeywords, scopeOptions),
    );
  }

  if (searchable.length === 0) {
    return emptyResponse(
      query,
      '没有找到相关优惠',
      windowDays,
      await buildSemanticSuggestions(query, rewriteKeywords, scopeOptions),
    );
  }

  const cacheEnabled = getRuntimeBool('AI_SEARCH_CACHE_ENABLED', true);
  let rewritePrefix =
    rewriteKeywords.length > 0
      ? `已将搜索理解为「${rewriteKeywords.join('、')}」。`
      : '';
  const cacheKey = [
    query,
    activeOnly ? 'active' : `days:${days}`,
    recallLimit,
    rerankLimit,
    useSummary ? 'summary' : 'title',
    synonyms ? 'syn' : 'plain',
    getAiSearchRerankEnabled() ? 'rerank' : 'plain',
    getAiSearchMaxPerSource(),
    getSearchSuggestTags(),
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
      reason: `${rewritePrefix}已按全文索引与新鲜度排序（AI 精排已关闭）`,
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

  // 召回有候选但 AI 精排全部过滤时，再改写一次搜索词重新精排。
  let finalSelection = selection;
  if (
    selection &&
    selection.ids.length === 0 &&
    rewriteKeywords.length === 0 &&
    getAiSearchRewriteOnEmptyRerank()
  ) {
    const recalled = await rewriteRecall(
      query,
      scopeOptions,
      synonyms,
    );
    rewriteKeywords = recalled.keywords;
    if (recalled.candidates && recalled.candidates.length > 0) {
      const retryRanked = rankCandidates(
        recalled.candidates,
        getAiSearchMaxPerSource(),
        recallLimit,
      );
      const retrySearchable = retryRanked.map((row) =>
        candidateToSearchDeal(row, useSummary),
      );
      if (retrySearchable.length > 0) {
        const retried = await searchDealsWithAi(
          query,
          retrySearchable,
          rerankLimit,
        );
        if (retried) finalSelection = retried;
      }
    }
  }

  rewritePrefix =
    rewriteKeywords.length > 0
      ? `已将搜索理解为「${rewriteKeywords.join('、')}」。`
      : '';

  const fallbackIds = (
    ftsUsed ? ranked : searchable.map((item) => ({ id: item.id }))
  )
    .slice(0, rerankLimit)
    .map((row) => row.id);

  console.log(
    `[search] mode=ai scope=${activeOnly ? 'active' : `${days}d`} fts=${
      ftsUsed ? 1 : 0
    } matched=${candidates?.length ?? 0} sent=${searchable.length} ai=${
      finalSelection ? 1 : 0
    } rewrite=${rewriteKeywords.join('|') || '-'}`,
  );

  if (finalSelection) {
    const ids = finalSelection.ids;
    const suggestedTags =
      ids.length === 0
        ? await buildSemanticSuggestions(query, rewriteKeywords, scopeOptions)
        : [];
    const payload: SearchResponse = {
      query,
      mode: 'ai',
      ids,
      reason:
        rewritePrefix +
        (finalSelection.reason ||
          '已按全文索引召回并结合标题与摘要精排'),
      windowDays,
      ...(ids.length === 0 ? { suggestedTags } : {}),
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
    reason: `${rewritePrefix}AI 暂不可用，已按全文索引与摘要匹配`,
    windowDays,
  };

  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
