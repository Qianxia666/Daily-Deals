'use client';

import {
  Bookmark,
  Inbox,
  LoaderCircle,
  SearchX,
  Sparkles,
  Tag,
  WifiOff,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  DealsListResponse,
  SiteSettings,
  SourceId,
} from '@/lib/types';
import { useRouter } from 'next/navigation';
import { useDealSearch, PENDING_SEARCH_KEY } from '@/lib/use-deal-search';
import { DealMasonry } from './deal-masonry';
import { FilterBar, type SearchMode } from './filter-bar';
import { PreferenceDialog, type PreferenceOption } from './preference-dialog';
import { LoadingScreen } from './loading-screen';
import { StatsBar } from './stats-bar';
import { Button } from './ui/button';
import { useLocalDealStates } from './use-local-deal-states';

const EMPTY_STATS = {
  activeCount: 0,
  newCount: 0,
};

const EMPTY_ANNOUNCEMENT = {
  enabled: false,
  text: '',
};

const FILTERS_KEY = 'daily-deals.filters.v1';
const PREFERENCES_KEY = 'daily-deals.preferences.v1';
const MAX_PREFERENCES = 5;
const PAGE_SIZE = 30;
const SPLASH_MIN_MS = 400;
const SPLASH_FADE_MS = 300;

export function DealsApp({
  initialSite,
  placeholderTag,
  tagOptions,
  currentUserEmail = null,
}: {
  initialSite: SiteSettings;
  placeholderTag: string;
  tagOptions: PreferenceOption[];
  currentUserEmail?: string | null;
}) {
  const [data, setData] = useState<DealsListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const router = useRouter();

  const [searchInput, setSearchInput] = useState('');
  const [aiQuery, setAiQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [filtersLoaded, setFiltersLoaded] = useState(false);

  const {
    statesRef: localStatesRef,
    ready: localStatesReady,
    setFavorite,
    favoriteIds,
  } = useLocalDealStates();
  const {
    result: aiResult,
    searching: aiSearching,
    error: searchError,
    search,
    clear: clearSearchResult,
  } = useDealSearch();

  const filtersReady = filtersLoaded && localStatesReady;

  const [selectedSources, setSelectedSources] = useState<Set<SourceId>>(
    new Set(),
  );
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [preferenceTags, setPreferenceTags] = useState<string[]>([]);
  const [preferencesOnly, setPreferencesOnly] = useState(false);
  const [preferenceDialogOpen, setPreferenceDialogOpen] = useState(false);
  const [splashPhase, setSplashPhase] = useState<
    'visible' | 'leaving' | 'hidden'
  >('visible');

  const splashStartedAtRef = useRef(Date.now());
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef<DealsListResponse | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const hasStoredPreferencesRef = useRef(false);
  // 请求序号：并发请求时只应用最新一次响应，避免旧数据覆盖新数据。
  const requestSeqRef = useRef(0);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // 首屏全屏加载：数据就绪后至少展示 400ms，再淡出 300ms，避免一闪而过。
  useEffect(() => {
    if (splashPhase !== 'visible') return;
    if (!data && !loadError) return;

    const elapsed = Date.now() - splashStartedAtRef.current;
    const timer = window.setTimeout(
      () => setSplashPhase('leaving'),
      Math.max(0, SPLASH_MIN_MS - elapsed),
    );
    return () => window.clearTimeout(timer);
  }, [data, loadError, splashPhase]);

  useEffect(() => {
    if (splashPhase !== 'leaving') return;
    const timer = window.setTimeout(
      () => setSplashPhase('hidden'),
      SPLASH_FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [splashPhase]);

  useEffect(() => {
    if (splashPhase === 'hidden') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [splashPhase]);

  // 按 / 快速聚焦搜索框（输入框内不拦截）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 筛选条件与兴趣偏好只保存在当前浏览器，刷新或重新访问后恢复。
  useEffect(() => {
    let restoredTags: string[] = [];

    try {
      const rawPreferences = localStorage.getItem(PREFERENCES_KEY);
      if (rawPreferences !== null) {
        hasStoredPreferencesRef.current = true;

        const parsedPreferences = JSON.parse(rawPreferences) as unknown;
        if (parsedPreferences && typeof parsedPreferences === 'object') {
          const record = parsedPreferences as Record<string, unknown>;
          if (Array.isArray(record.tags)) {
            restoredTags = record.tags
              .filter((value): value is string => typeof value === 'string')
              .slice(0, MAX_PREFERENCES);
          }
        }
      }
    } catch {
      // 忽略损坏的偏好缓存。
    }

    if (restoredTags.length > 0) setPreferenceTags(restoredTags);

    try {
      const raw = localStorage.getItem(FILTERS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') {
          const record = parsed as Record<string, unknown>;

          if (Array.isArray(record.sources)) {
            setSelectedSources(
              new Set(
                record.sources.filter(
                  (value): value is string => typeof value === 'string',
                ),
              ),
            );
          }

          if (typeof record.favoritesOnly === 'boolean') {
            setFavoritesOnly(record.favoritesOnly);
          }

          if (
            record.preferencesOnly === true &&
            restoredTags.length > 0
          ) {
            setPreferencesOnly(true);
            setFavoritesOnly(false);
          }
        }
      }
    } catch {
      // 忽略损坏的本地缓存。
    }

    setFiltersLoaded(true);
  }, []);

  useEffect(() => {
    if (!filtersReady) return;

    try {
      localStorage.setItem(
        FILTERS_KEY,
        JSON.stringify({
          sources: [...selectedSources],
          favoritesOnly,
          preferencesOnly,
        }),
      );
    } catch {
      // 浏览器禁用存储时静默降级为仅当前页面生效。
    }
  }, [filtersReady, selectedSources, favoritesOnly, preferencesOnly]);

  // 首次进入且从未选择过偏好时，等首屏加载完成后再弹窗。
  useEffect(() => {
    if (!filtersReady || hasStoredPreferencesRef.current) return;
    if (splashPhase !== 'hidden') return;

    const timer = window.setTimeout(() => setPreferenceDialogOpen(true), 300);
    return () => window.clearTimeout(timer);
  }, [filtersReady, splashPhase]);

  const fetchPage = useCallback(
    async (
      options: {
        cursor?: string | null;
        append?: boolean;
        metaOnly?: boolean;
        silent?: boolean;
      } = {},
    ): Promise<DealsListResponse | null> => {
      // 轮询属于后台刷新，不抢占用户手动请求的序号。
      const seq = options.silent
        ? requestSeqRef.current
        : ++requestSeqRef.current;
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));

      if (selectedSources.size > 0) {
        params.set('sources', [...selectedSources].join(','));
      }
      if (preferencesOnly && preferenceTags.length > 0) {
        params.set('preferTags', preferenceTags.slice(0, MAX_PREFERENCES).join(','));
      }
      if (options.metaOnly) params.set('metaOnly', '1');
      if (options.cursor) params.set('cursor', options.cursor);

      let ids: number[] | null = null;
      if (aiResult) {
        ids = aiResult.ids;
      } else if (favoritesOnly) {
        ids = favoriteIds();
      }

      const emptyIds = Boolean(ids && ids.length === 0);
      if (ids) {
        if (emptyIds) {
          params.set('metaOnly', '1');
        } else {
          params.set('ids', ids.slice(0, 500).join(','));
          params.delete('cursor');
        }
      }

      try {
        const response = await fetch(`/api/deals?${params.toString()}`, {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const payload = (await response.json()) as DealsListResponse;
        const items = payload.items.map((item) => {
          const override = localStatesRef.current[item.id];
          return override ? { ...item, ...override } : item;
        });

        if (seq !== requestSeqRef.current) return null;
        setData((previous) => {
          if (!previous) return { ...payload, items };

          const meta = {
            fetchedAt: payload.fetchedAt,
            fetching: payload.fetching,
            sources: payload.sources,
            stats: payload.stats,
            announcement: payload.announcement,
            site: payload.site,
            aiSearchEnabled: payload.aiSearchEnabled,
            searchWindows: payload.searchWindows,
          };

          if (options.metaOnly) {
            return emptyIds
              ? {
                  ...previous,
                  ...meta,
                  items: [],
                  total: 0,
                  hasMore: false,
                  nextCursor: null,
                }
              : { ...previous, ...meta };
          }

          if (options.append) {
            const existing = new Set(previous.items.map((item) => item.id));
            return {
              ...previous,
              ...meta,
              items: [
                ...previous.items,
                ...items.filter((item) => !existing.has(item.id)),
              ],
              total: payload.total,
              hasMore: payload.hasMore,
              nextCursor: payload.nextCursor,
            };
          }

          return { ...payload, items };
        });

        setLoadError(null);
        return { ...payload, items };
      } catch (error) {
        if (seq !== requestSeqRef.current) return null;
        setLoadError(error instanceof Error ? error.message : '网络请求失败');
        return null;
      }
    },
    [selectedSources, favoritesOnly, aiResult, favoriteIds, preferencesOnly, preferenceTags],
  );

  useEffect(() => {
    if (!filtersReady) return;
    void fetchPage({});
  }, [filtersReady, fetchPage]);

  useEffect(() => {
    if (!filtersReady) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const current = dataRef.current;
      const payload = await fetchPage({
        metaOnly: Boolean(current && current.items.length > PAGE_SIZE),
        silent: true,
      });
      if (stopped) return;

      const delay = !payload
        ? 10_000
        : !payload.fetchedAt || payload.fetching
          ? 4_000
          : 60_000;
      timer = setTimeout(tick, delay);
    };

    timer = setTimeout(tick, 20_000);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [filtersReady, fetchPage]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !data?.nextCursor || !data.hasMore) return;
    if (aiResult || favoritesOnly) return;

    setLoadingMore(true);
    try {
      await fetchPage({ cursor: data.nextCursor, append: true });
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, data, fetchPage, aiResult, favoritesOnly]);

  const toggleFavorite = useCallback(
    (id: number) => {
      if (!data) return;

      const item = data.items.find((candidate) => candidate.id === id);
      if (!item) return;

      const nextValue = !item.favorite;
      setFavorite(id, nextValue);

      setData((previous) =>
        previous
          ? {
              ...previous,
              items: previous.items.map((candidate) =>
                candidate.id === id
                  ? { ...candidate, favorite: nextValue }
                  : candidate,
              ),
            }
          : previous,
      );
    },
    [data, setFavorite],
  );

  const toggleSource = useCallback((source: SourceId) => {
    setSelectedSources((previous) => {
      const next = new Set(previous);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }, []);

  const aiSearchEnabled = data?.aiSearchEnabled ?? true;
  // AI 可用时自动用 AI 搜索，不可用时自动降级为普通搜索。
  const searchMode: SearchMode = aiSearchEnabled ? 'ai' : 'keyword';

  /** 把当前标签同步到地址栏，支持刷新、分享与前进后退。 */
  const syncTagToUrl = useCallback(
    (tag: string | null, mode: 'push' | 'replace' = 'push') => {
      if (typeof window === 'undefined') return;

      const url = new URL(window.location.href);
      if (tag) url.searchParams.set('tag', tag);
      else url.searchParams.delete('tag');

      const next = `${url.pathname}${url.search}${url.hash}`;
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (next === current) return;

      if (mode === 'replace') {
        window.history.replaceState({ tag }, '', next);
      } else {
        window.history.pushState({ tag }, '', next);
      }
    },
    [],
  );

  const clearSearch = useCallback(() => {
    setSearchInput('');
    setAiQuery('');
    clearSearchResult();
    setActiveTag(null);
    syncTagToUrl(null, 'push');
  }, [clearSearchResult, syncTagToUrl]);

  const clearTag = useCallback(
    (options: { fromHistory?: boolean } = {}) => {
      setActiveTag(null);
      setAiQuery('');
      clearSearchResult();
      if (!options.fromHistory) syncTagToUrl(null, 'push');
    },
    [clearSearchResult, syncTagToUrl],
  );

  const clearFilters = useCallback(() => {
    clearSearch();
    setSelectedSources(new Set());
    setFavoritesOnly(false);
    setPreferencesOnly(false);
  }, [clearSearch]);

  /** 保存兴趣偏好；保存后自动切到「猜你喜欢」。 */
  const savePreferences = useCallback((tags: string[]) => {
    const unique = [...new Set(tags)].slice(0, MAX_PREFERENCES);

    try {
      localStorage.setItem(
        PREFERENCES_KEY,
        JSON.stringify({ tags: unique, chosenAt: new Date().toISOString() }),
      );
    } catch {
      // 浏览器禁用存储时仅当前页面生效。
    }

    hasStoredPreferencesRef.current = true;
    setPreferenceTags(unique);
    setPreferenceDialogOpen(false);
    setPreferencesOnly(unique.length > 0);
    if (unique.length > 0) setFavoritesOnly(false);
  }, []);

  /** 首次弹窗点「跳过」也写入空偏好，避免每次访问重复打扰。 */
  const cancelPreferences = useCallback(() => {
    if (!hasStoredPreferencesRef.current) {
      try {
        localStorage.setItem(
          PREFERENCES_KEY,
          JSON.stringify({ tags: [], chosenAt: new Date().toISOString() }),
        );
      } catch {
        // 忽略存储失败。
      }
      hasStoredPreferencesRef.current = true;
    }
    setPreferenceDialogOpen(false);
  }, []);

  const togglePreferences = useCallback(() => {
    if (preferenceTags.length === 0) {
      setPreferenceDialogOpen(true);
      return;
    }
    setPreferencesOnly((value) => !value);
    setFavoritesOnly(false);
  }, [preferenceTags.length]);

  const handleAiSearch = useCallback(
    async (
      tagOverride?: string,
      options: { fromHistory?: boolean } = {},
    ) => {
      const query = (tagOverride ?? searchInput).trim();
      if (!query) return;

      const next = await search(
        query,
        searchMode,
        tagOverride ? query : undefined,
      );
      if (!next) return;

      if (tagOverride) {
        setActiveTag(tagOverride);
        setAiQuery('');
        if (!options.fromHistory) syncTagToUrl(tagOverride, 'push');
      } else {
        setActiveTag(null);
        setAiQuery(query);
        if (!options.fromHistory) syncTagToUrl(null, 'push');
      }
    },
    [searchInput, searchMode, search, syncTagToUrl],
  );

  /** 首页搜索统一跳到 /search 的结果页，与独立搜索页保持同一套流程。 */
  const handleHomeSearch = useCallback(() => {
    const query = searchInput.trim();
    if (!query) return;

    try {
      sessionStorage.setItem(PENDING_SEARCH_KEY, query);
    } catch {
      // 浏览器禁用存储时退化为直接带参跳转。
    }
    router.push('/search');
  }, [router, searchInput]);

  /** 标签点击：同标签已有结果时不重复请求。 */
  const handleTagClick = useCallback(
    (tag: string) => {
      if (aiSearching) return;
      if (activeTag === tag && aiResult) return;
      void handleAiSearch(tag);
    },
    [aiSearching, activeTag, aiResult, handleAiSearch],
  );

  // 用 ref 保存最新实现，供 popstate 与首屏 URL 还原使用，避免反复重绑。
  const handleAiSearchRef = useRef(handleAiSearch);
  const clearTagRef = useRef(clearTag);
  useEffect(() => {
    handleAiSearchRef.current = handleAiSearch;
    clearTagRef.current = clearTag;
  }, [handleAiSearch, clearTag]);

  useEffect(() => {
    const onPopState = () => {
      const tag =
        new URLSearchParams(window.location.search).get('tag')?.trim() ?? '';
      if (tag) {
        void handleAiSearchRef.current(tag, { fromHistory: true });
      } else {
        clearTagRef.current({ fromHistory: true });
      }
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // 首次加载若地址栏带 ?tag=，直接还原标签筛选结果。
  const initialTagAppliedRef = useRef(false);
  useEffect(() => {
    if (initialTagAppliedRef.current) return;
    initialTagAppliedRef.current = true;

    const tag =
      new URLSearchParams(window.location.search).get('tag')?.trim() ?? '';
    if (tag) void handleAiSearchRef.current(tag, { fromHistory: true });
  }, []);

  const hasFilters =
    Boolean(aiQuery) ||
    Boolean(activeTag) ||
    selectedSources.size > 0 ||
    favoritesOnly ||
    preferencesOnly;

  const aiOrder = useMemo(() => {
    if (!aiResult) return null;
    const order = new Map<number, number>();
    aiResult.ids.forEach((id, index) => order.set(id, index));
    return order;
  }, [aiResult]);

  const filteredItems = useMemo(() => {
    if (!data) return [];

    const now = Date.now();

    const items = data.items.filter((item) => {
      if (item.expiresAt && Date.parse(item.expiresAt) <= now) return false;
      if (selectedSources.size > 0 && !selectedSources.has(item.source)) {
        return false;
      }
      if (favoritesOnly && !item.favorite) {
        return false;
      }
      if (aiOrder && !aiOrder.has(item.id)) return false;
      return true;
    });

    if (aiOrder) {
      return items.sort(
        (a, b) => (aiOrder.get(a.id) ?? 0) - (aiOrder.get(b.id) ?? 0),
      );
    }

    return items.sort((a, b) => {
      const aTime = Date.parse(a.publishedAt ?? a.firstSeenAt) || 0;
      const bTime = Date.parse(b.publishedAt ?? b.firstSeenAt) || 0;
      if (aTime !== bTime) return bTime - aTime;
      return b.id - a.id;
    });
  }, [data, selectedSources, favoritesOnly, aiOrder]);

  const hasMore = Boolean(data?.hasMore) && !aiOrder && !favoritesOnly;
  const visibleItems = filteredItems;

  // 触底自动加载下一页；同时保留手动按钮作为兜底。
  useEffect(() => {
    if (!hasMore) return;

    const node = loadMoreRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      { rootMargin: '600px 0px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMore, data?.nextCursor]);

  const favoriteCount = data
    ? new Set([
        ...Object.entries(localStatesRef.current)
          .filter(([, state]) => state.favorite)
          .map(([id]) => Number(id)),
        ...data.items.filter((item) => item.favorite).map((item) => item.id),
      ]).size
    : 0;
  const displayTotal =
    aiOrder || favoritesOnly ? filteredItems.length : data?.total ?? 0;
  const site = data?.site ?? initialSite;

  let content: ReactNode;

  if (!data) {
    if (loadError) {
      content = (
        <EmptyState
          icon={<WifiOff className="h-5 w-5" aria-hidden="true" />}
          title="无法加载数据"
          description={`请确认服务已启动并稍后重试。（${loadError}）`}
          action={
            <Button variant="outline" onClick={() => void fetchPage({})}>
              重试
            </Button>
          }
        />
      );
    } else {
      content = null;
    }
  } else if (filteredItems.length === 0) {
    if (activeTag) {
      content = (
        <EmptyState
          icon={<SearchX className="h-5 w-5" aria-hidden="true" />}
          title="该标签暂无在架优惠"
          description={`标签「${activeTag}」下暂时没有可展示的优惠，可以关闭标签筛选查看全部。`}
          action={
            <Button variant="outline" onClick={clearFilters}>
              查看全部优惠
            </Button>
          }
        />
      );
    } else if (aiQuery && aiResult) {
      content = (
        <EmptyState
          icon={<SearchX className="h-5 w-5" aria-hidden="true" />}
          title={
            aiResult?.mode === 'ai'
              ? 'AI 没有找到相关优惠'
              : '没有找到相关优惠'
          }
          description={
            aiResult.reason || '换一种说法再试试，或清空筛选查看全部优惠。'
          }
          action={
            <div className="flex flex-col items-center gap-3">
              {(aiResult.suggestedTags?.length ?? 0) > 0 && (
                <div className="flex flex-wrap justify-center gap-2">
                  {aiResult.suggestedTags?.map((item) => (
                    <Button
                      key={item.tag}
                      variant="secondary"
                      size="sm"
                      disabled={aiSearching}
                      onClick={() => void handleAiSearch(item.tag)}
                    >
                      {item.tag}
                      <span className="text-xs text-slate-500">
                        {item.count}
                      </span>
                    </Button>
                  ))}
                </div>
              )}
              <Button variant="outline" onClick={clearFilters}>
                查看全部优惠
              </Button>
            </div>
          }
        />
      );
    } else if (preferencesOnly) {
      content = (
        <EmptyState
          icon={<Sparkles className="h-5 w-5" aria-hidden="true" />}
          title="所选品类暂时没有在架优惠"
          description={`你关注的「${preferenceTags.join('、')}」暂时没有可展示内容，可以调整偏好或查看全部优惠。`}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant="outline"
                onClick={() => setPreferenceDialogOpen(true)}
              >
                调整偏好
              </Button>
              <Button variant="outline" onClick={clearFilters}>
                查看全部优惠
              </Button>
            </div>
          }
        />
      );
    } else if (data.items.length === 0 && !favoritesOnly) {
      if (!data.fetchedAt && data.fetching) {
        content = (
          <EmptyState
            icon={
              <LoaderCircle
                className="h-5 w-5 animate-spin"
                aria-hidden="true"
              />
            }
            title="正在抓取首批优惠"
            description="服务已启动，正在从各来源并行抓取。完成后内容会自动出现，无需刷新页面。"
          />
        );
      } else if (!data.fetchedAt) {
        content = (
          <EmptyState
            icon={<Inbox className="h-5 w-5" aria-hidden="true" />}
            title="尚未完成首轮抓取"
            description="请等待定时任务自动执行，或让管理员在后台手动触发抓取。"
          />
        );
      } else {
        content = (
          <EmptyState
            icon={<Inbox className="h-5 w-5" aria-hidden="true" />}
            title="当前暂无在架优惠"
            description="各来源暂未返回符合条件的条目。下一轮抓取会自动更新。"
          />
        );
      }
    } else if (favoritesOnly && favoriteCount === 0) {
      content = (
        <EmptyState
          icon={<Bookmark className="h-5 w-5" aria-hidden="true" />}
          title="还没有收藏的优惠"
          description="点击卡片底部的「收藏」按钮即可收藏，状态会保存在当前浏览器，刷新后依然保留。"
          action={
            <Button variant="outline" onClick={clearFilters}>
              查看全部优惠
            </Button>
          }
        />
      );
    } else if (hasFilters) {
      content = (
        <EmptyState
          icon={<SearchX className="h-5 w-5" aria-hidden="true" />}
          title="没有符合条件的优惠"
          description="试试减少筛选条件，或换一个搜索关键词。"
          action={
            <Button variant="outline" onClick={clearFilters}>
              清空筛选
            </Button>
          }
        />
      );
    } else {
      content = (
        <EmptyState
          icon={<Inbox className="h-5 w-5" aria-hidden="true" />}
          title="暂无在架优惠"
          description="下一轮抓取会自动更新。"
        />
      );
    }
  } else {
    content = (
      <div>
        <DealMasonry
          items={visibleItems}
          highlight={aiQuery || undefined}
          onToggleFavorite={toggleFavorite}
          onTagClick={handleTagClick}
        />

        {hasMore ? (
          <div
            ref={loadMoreRef}
            className="mt-4 flex flex-col items-center gap-2"
          >
            <Button
              variant="outline"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore
                ? '加载中…'
                : `加载更多（还有 ${Math.max(
                    0,
                    displayTotal - visibleItems.length,
                  )} 条）`}
            </Button>
            <p className="text-[11px] text-slate-400">
              已加载 {visibleItems.length} / {displayTotal} 条
            </p>
          </div>
        ) : (
          visibleItems.length > PAGE_SIZE && (
            <p className="mt-4 text-center text-[11px] text-slate-400">
              已显示全部 {visibleItems.length} 条
            </p>
          )
        )}
      </div>
    );
  }

  return (
    <>
      <div className="min-h-dvh">
      <header className="border-b border-line bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 pb-4 pt-5 sm:px-6 sm:pt-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-gold">
                {site.label}
              </p>
              <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink sm:text-2xl">
                {site.title}
              </h1>
              <p className="mt-1 text-xs text-slate-500">{site.tagline}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <a
                href={currentUserEmail ? '/account' : '/login'}
                className="inline-flex h-9 items-center rounded-full border border-line bg-white px-3 text-xs font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
              >
                {currentUserEmail ? '我的账号' : '登录'}
              </a>
              <a
                href="https://github.com/Qianxia666/Daily-Deals"
                target="_blank"
                rel="noreferrer"
                aria-label="打开 GitHub 仓库"
                title="GitHub 仓库"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-white text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
              >
                <GithubIcon className="h-4 w-4" />
              </a>
            </div>
          </div>

          <StatsBar
            fetchedAt={data?.fetchedAt ?? null}
            fetching={data?.fetching ?? false}
            stats={data?.stats ?? EMPTY_STATS}
            announcement={data?.announcement ?? EMPTY_ANNOUNCEMENT}
          />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 pb-4 pt-5 sm:px-6 sm:pt-6">
        {loadError && data && (
          <p className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[11px] text-red-700">
            数据刷新失败，正在自动重试（{loadError}）
          </p>
        )}

        <FilterBar
          inputRef={searchInputRef}
          query={searchInput}
          onQueryChange={setSearchInput}
          onSearch={handleHomeSearch}
          onClearSearch={clearSearch}
          searching={aiSearching}
          searchError={searchError}
          mode={searchMode}
          placeholderTag={placeholderTag}
          sources={data?.sources ?? []}
          totalActive={data?.stats.activeCount ?? 0}
          selectedSources={selectedSources}
          onToggleSource={toggleSource}
          onClearSources={() => setSelectedSources(new Set())}
          favoritesOnly={favoritesOnly}
          favoriteCount={favoriteCount}
          onToggleFavorites={() => {
            setFavoritesOnly((value) => !value);
            setPreferencesOnly(false);
          }}
          preferencesOnly={preferencesOnly}
          onTogglePreferences={togglePreferences}
          onEditPreferences={() => setPreferenceDialogOpen(true)}
          hasFilters={hasFilters}
          onClearFilters={clearFilters}
        />

        <div className="mt-5 flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500" aria-live="polite">
            共{' '}
            <span className="font-semibold tabular-nums text-slate-700">
              {displayTotal}
            </span>{' '}
            条
            {aiQuery && (
              <span className="text-violet-700">
                {' '}
                · {aiResult?.mode === 'ai' ? 'AI 搜索' : '普通搜索'}「{aiQuery}」
              </span>
            )}
            {activeTag && (
              <span className="text-sky-700">
                {' '}
                · 标签「{activeTag}」
              </span>
            )}
            {preferencesOnly && (
              <span className="text-violet-700"> · 猜你喜欢</span>
            )}
            {hasFilters && !aiQuery && !activeTag && !preferencesOnly && (
              <span> · 已筛选</span>
            )}
          </p>
          <span className="hidden text-[11px] text-slate-500 sm:inline">
            {activeTag
              ? '按标签筛选'
              : aiQuery
                ? aiResult?.mode === 'ai'
                  ? '按 AI 相关度排序'
                  : '按关键词匹配排序'
                : '按发布时间从新到旧'}
          </span>
        </div>

        {activeTag && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 text-[11px] leading-relaxed text-sky-800">
            <Tag className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1">
              标签：<span className="font-semibold">{activeTag}</span> ·{' '}
              {displayTotal} 条
              {aiResult?.truncated && <span>（仅显示前 100 条）</span>}
            </p>
            <button
              type="button"
              onClick={() => clearTag()}
              className="shrink-0 font-medium underline-offset-2 hover:underline"
            >
              关闭
            </button>
          </div>
        )}

        {aiQuery && aiResult && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-violet-100 bg-violet-50 px-3 py-2 text-[11px] leading-relaxed text-violet-800">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1">
              <span className="font-semibold">
                {aiResult.mode === 'ai' ? 'AI 筛选' : '关键词匹配'}
                {aiResult.windowDays ? `（近 ${aiResult.windowDays} 天）` : ''}
              </span>
              {aiResult.reason ? `：${aiResult.reason}` : '：已完成筛选'}
            </p>
            <button
              type="button"
              onClick={clearSearch}
              className="shrink-0 font-medium underline-offset-2 hover:underline"
            >
              清除
            </button>
          </div>
        )}

        <div className="mt-3">{content}</div>
      </main>
      </div>

      {splashPhase !== 'hidden' && (
        <LoadingScreen
          label={site.label}
          leaving={splashPhase === 'leaving'}
        />
      )}

      <PreferenceDialog
        open={preferenceDialogOpen}
        options={tagOptions}
        initialTags={preferenceTags}
        onSave={savePreferences}
        onCancel={cancelPreferences}
      />
    </>
  );
}

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
    </svg>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-white/70 px-6 py-14 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        {icon}
      </div>
      <p className="mt-4 text-sm font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-500">
        {description}
      </p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

