'use client';

import {
  Bookmark,
  Inbox,
  LoaderCircle,
  SearchX,
  Sparkles,
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
import { CATEGORY_FILTERS } from '@/lib/constants';
import type {
  CategoryFilter,
  DealsResponse,
  SiteSettings,
  SourceId,
} from '@/lib/types';
import { DealCard } from './deal-card';
import { FilterBar, type SearchMode } from './filter-bar';
import { LoadingScreen } from './loading-screen';
import { StatsBar } from './stats-bar';
import { Button } from './ui/button';

const EMPTY_STATS = {
  activeCount: 0,
  newCount: 0,
};

const EMPTY_ANNOUNCEMENT = {
  enabled: false,
  text: '',
};

const FILTERS_KEY = 'daily-deals.filters.v1';
const LOCAL_STATES_KEY = 'daily-deals.local-states.v1';
const PAGE_SIZE = 30;
const SPLASH_MIN_MS = 400;
const SPLASH_FADE_MS = 300;

interface LocalDealState {
  claimed?: boolean;
  favorite?: boolean;
}

interface AiSearchResult {
  ids: number[];
  reason: string;
  mode: 'ai' | 'keyword';
  windowDays?: number;
}

function parseLocalStates(raw: string): Record<number, LocalDealState> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') return {};

  const result: Record<number, LocalDealState> = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const id = Number(key);
    if (!Number.isInteger(id) || !value || typeof value !== 'object') continue;

    const record = value as Record<string, unknown>;
    const entry: LocalDealState = {};
    if (typeof record.claimed === 'boolean') entry.claimed = record.claimed;
    if (typeof record.favorite === 'boolean') {
      entry.favorite = record.favorite;
    }
    if (entry.claimed !== undefined || entry.favorite !== undefined) {
      result[id] = entry;
    }
  }

  return result;
}

export function DealsApp({ initialSite }: { initialSite: SiteSettings }) {
  const [data, setData] = useState<DealsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('ai');
  const [aiQuery, setAiQuery] = useState('');
  const [aiResult, setAiResult] = useState<AiSearchResult | null>(null);
  const [aiSearching, setAiSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [filtersReady, setFiltersReady] = useState(false);

  const [selectedSources, setSelectedSources] = useState<Set<SourceId>>(
    new Set(),
  );
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [onlyNew, setOnlyNew] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [splashPhase, setSplashPhase] = useState<
    'visible' | 'leaving' | 'hidden'
  >('visible');

  const localStatesRef = useRef<Record<number, LocalDealState>>({});
  const splashStartedAtRef = useRef(Date.now());
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef<DealsResponse | null>(null);
  const etagRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchSeqRef = useRef(0);

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

  useEffect(() => {
    return () => searchAbortRef.current?.abort();
  }, []);

  // 筛选条件与收藏/已领状态只保存在当前浏览器，刷新或重新访问后恢复。
  useEffect(() => {
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

          if (
            typeof record.category === 'string' &&
            CATEGORY_FILTERS.some((filter) => filter.value === record.category)
          ) {
            setCategory(record.category as CategoryFilter);
          }

          if (typeof record.onlyNew === 'boolean') {
            setOnlyNew(record.onlyNew);
          }

          if (record.searchMode === 'ai' || record.searchMode === 'keyword') {
            setSearchMode(record.searchMode);
          }
        }
      }
    } catch {
      // 忽略损坏的本地缓存。
    }

    try {
      const raw = localStorage.getItem(LOCAL_STATES_KEY);
      if (raw) localStatesRef.current = parseLocalStates(raw);
    } catch {
      // 忽略损坏的本地缓存。
    }

    setFiltersReady(true);
  }, []);

  useEffect(() => {
    if (!filtersReady) return;

    try {
      localStorage.setItem(
        FILTERS_KEY,
        JSON.stringify({
          sources: [...selectedSources],
          category,
          onlyNew,
          searchMode,
        }),
      );
    } catch {
      // 浏览器禁用存储时静默降级为仅当前页面生效。
    }
  }, [filtersReady, selectedSources, category, onlyNew, searchMode]);

  const load = useCallback(async (): Promise<DealsResponse | null> => {
    try {
      const response = await fetch('/api/deals', {
        cache: 'no-store',
        headers: etagRef.current
          ? { 'If-None-Match': etagRef.current }
          : undefined,
      });

      if (response.status === 304 && dataRef.current) {
        return dataRef.current;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      etagRef.current = response.headers.get('ETag');
      const payload = (await response.json()) as DealsResponse;
      const merged: DealsResponse = {
        ...payload,
        items: payload.items.map((item) => {
          const override = localStatesRef.current[item.id];
          return override ? { ...item, ...override } : item;
        }),
      };

      setData(merged);
      setLoadError(null);
      return merged;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '网络请求失败');
      return null;
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const payload = await load();
      if (stopped) return;

      const delay = !payload
        ? 10_000
        : !payload.fetchedAt || payload.fetching
          ? 4_000
          : 60_000;
      timer = setTimeout(tick, delay);
    };

    void tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const toggleItemState = useCallback(
    (id: number, field: 'claimed' | 'favorite') => {
      if (!data) return;

      const item = data.items.find((candidate) => candidate.id === id);
      if (!item) return;

      const nextValue = !item[field];
      const local: LocalDealState = {
        ...(localStatesRef.current[id] ?? {}),
        [field]: nextValue,
      };
      localStatesRef.current = { ...localStatesRef.current, [id]: local };

      try {
        localStorage.setItem(
          LOCAL_STATES_KEY,
          JSON.stringify(localStatesRef.current),
        );
      } catch {
        // 浏览器禁用存储时仅当前页面生效。
      }

      setData((previous) =>
        previous
          ? {
              ...previous,
              items: previous.items.map((candidate) =>
                candidate.id === id
                  ? { ...candidate, [field]: nextValue }
                  : candidate,
              ),
            }
          : previous,
      );
    },
    [data],
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
  const aiWindowDays = data?.searchWindows?.ai ?? 3;
  const keywordWindowDays = data?.searchWindows?.keyword ?? 30;

  useEffect(() => {
    if (aiSearchEnabled) return;
    setSearchMode('keyword');
    setAiQuery('');
    setAiResult(null);
  }, [aiSearchEnabled]);

  const clearSearch = useCallback(() => {
    setSearchInput('');
    setAiQuery('');
    setAiResult(null);
    setSearchError(null);
  }, []);

  const handleSearchModeChange = useCallback(
    (nextMode: SearchMode) => {
      setSearchMode(nextMode);
      setAiQuery('');
      setAiResult(null);
      setSearchError(null);
    },
    [],
  );

  const clearFilters = useCallback(() => {
    clearSearch();
    setSelectedSources(new Set());
    setCategory('all');
    setOnlyNew(false);
  }, [clearSearch]);

  const handleAiSearch = useCallback(async () => {
    const query = searchInput.trim();
    if (!query) return;

    const seq = searchSeqRef.current + 1;
    searchSeqRef.current = seq;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;

    setAiSearching(true);
    setSearchError(null);

    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, mode: searchMode }),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            ids?: unknown;
            reason?: unknown;
            mode?: unknown;
            windowDays?: unknown;
            error?: unknown;
          }
        | null;

      if (seq !== searchSeqRef.current) return;

      if (!response.ok) {
        throw new Error(
          typeof payload?.error === 'string'
            ? payload.error
            : `HTTP ${response.status}`,
        );
      }

      const ids = Array.isArray(payload?.ids)
        ? payload.ids.filter(
            (value): value is number => Number.isInteger(value),
          )
        : [];

      setAiResult({
        ids,
        reason: typeof payload?.reason === 'string' ? payload.reason : '',
        mode: payload?.mode === 'ai' ? 'ai' : 'keyword',
        windowDays:
          typeof payload?.windowDays === 'number'
            ? payload.windowDays
            : undefined,
      });
      setAiQuery(query);
    } catch (error) {
      if (controller.signal.aborted || seq !== searchSeqRef.current) return;
      setSearchError(
        error instanceof Error ? error.message : '搜索失败，请稍后重试',
      );
    } finally {
      if (seq === searchSeqRef.current) setAiSearching(false);
    }
  }, [searchInput, searchMode]);

  const hasFilters =
    Boolean(aiQuery) ||
    selectedSources.size > 0 ||
    category !== 'all' ||
    onlyNew;

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
      if (category === 'favorites') {
        if (!item.favorite) return false;
      } else if (category !== 'all' && item.category !== category) {
        return false;
      }
      if (onlyNew && !item.isNew) return false;
      if (aiOrder && !aiOrder.has(item.id)) return false;
      return true;
    });

    if (aiOrder) {
      return items.sort(
        (a, b) => (aiOrder.get(a.id) ?? 0) - (aiOrder.get(b.id) ?? 0),
      );
    }

    return items.sort((a, b) => {
      if (a.claimed !== b.claimed) return a.claimed ? 1 : -1;
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;

      const aTime = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const bTime = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      if (aTime !== bTime) return bTime - aTime;
      return b.id - a.id;
    });
  }, [data, selectedSources, category, onlyNew, aiOrder]);

  const hasMore = visibleCount < filteredItems.length;
  const visibleItems = filteredItems.slice(0, visibleCount);

  // 筛选或搜索变化时回到第一批，避免保留上一个结果集的滚动深度。
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [selectedSources, category, onlyNew, aiQuery]);

  // 触底自动加载下一批；同时保留手动按钮作为兜底。
  useEffect(() => {
    if (!hasMore) return;

    const node = loadMoreRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((count) => count + PAGE_SIZE);
        }
      },
      { rootMargin: '600px 0px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, visibleCount, filteredItems.length]);

  const favoriteCount =
    data?.items.filter((item) => item.favorite).length ?? 0;
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
            <Button variant="outline" onClick={() => void load()}>
              重试
            </Button>
          }
        />
      );
    } else {
      content = null;
    }
  } else if (filteredItems.length === 0) {
    if (aiQuery && aiResult) {
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
            <Button variant="outline" onClick={clearFilters}>
              查看全部优惠
            </Button>
          }
        />
      );
    } else if (data.items.length === 0) {
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
    } else if (category === 'favorites' && favoriteCount === 0) {
      content = (
        <EmptyState
          icon={<Bookmark className="h-5 w-5" aria-hidden="true" />}
          title="还没有收藏的优惠"
          description="点击卡片右上角的书签图标即可收藏，状态会保存在当前浏览器，刷新后依然保留。"
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
        <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {visibleItems.map((item) => (
            <DealCard
              key={item.id}
              item={item}
              highlight={aiQuery || undefined}
              onToggleClaim={() => toggleItemState(item.id, 'claimed')}
              onToggleFavorite={() => toggleItemState(item.id, 'favorite')}
            />
          ))}
        </div>

        {hasMore ? (
          <div
            ref={loadMoreRef}
            className="mt-4 flex flex-col items-center gap-2"
          >
            <Button
              variant="outline"
              onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
            >
              加载更多（还有 {filteredItems.length - visibleItems.length} 条）
            </Button>
            <p className="text-[11px] text-slate-400">
              已显示 {visibleItems.length} / {filteredItems.length} 条
            </p>
          </div>
        ) : (
          filteredItems.length > PAGE_SIZE && (
            <p className="mt-4 text-center text-[11px] text-slate-400">
              已显示全部 {filteredItems.length} 条
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
          onSearch={() => void handleAiSearch()}
          onClearSearch={clearSearch}
          searching={aiSearching}
          searchError={searchError}
          mode={searchMode}
          onModeChange={handleSearchModeChange}
          aiSearchEnabled={aiSearchEnabled}
          aiWindowDays={aiWindowDays}
          keywordWindowDays={keywordWindowDays}
          sources={data?.sources ?? []}
          totalActive={data?.stats.activeCount ?? 0}
          selectedSources={selectedSources}
          onToggleSource={toggleSource}
          onClearSources={() => setSelectedSources(new Set())}
          category={category}
          onCategoryChange={setCategory}
          onlyNew={onlyNew}
          onOnlyNewChange={setOnlyNew}
          hasFilters={hasFilters}
          onClearFilters={clearFilters}
        />

        <div className="mt-5 flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500" aria-live="polite">
            共{' '}
            <span className="font-semibold tabular-nums text-slate-700">
              {filteredItems.length}
            </span>{' '}
            条
            {aiQuery && (
              <span className="text-violet-700">
                {' '}
                · {aiResult?.mode === 'ai' ? 'AI 搜索' : '普通搜索'}「{aiQuery}」
              </span>
            )}
            {hasFilters && !aiQuery && <span> · 已筛选</span>}
          </p>
          <span className="hidden text-[11px] text-slate-500 sm:inline">
            {aiQuery
              ? aiResult?.mode === 'ai'
                ? '按 AI 相关度排序'
                : '按关键词匹配排序'
              : '按新到旧排序，已领取置底'}
          </span>
        </div>

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

      <footer className="mx-auto w-full max-w-6xl px-4 pb-10 pt-6 sm:px-6">
        <p className="border-t border-line pt-4 text-[11px] leading-relaxed text-slate-500">
          数据来自各来源公开 RSS 与 Epic 官方接口，仅聚合标题、摘要与原站链接，不存储正文。AI 只对已有条目做改写与筛选，不会生成不存在的优惠。来源状态可在管理后台查看，异常来源会在下一轮自动重试。
        </p>
      </footer>
      </div>

      {splashPhase !== 'hidden' && (
        <LoadingScreen
          label={site.label}
          leaving={splashPhase === 'leaving'}
        />
      )}
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

