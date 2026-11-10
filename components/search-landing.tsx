'use client';

import {
  ArrowLeft,
  LoaderCircle,
  Search,
  Sparkles,
  WifiOff,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DealItem, DealsListResponse, SiteSettings } from '@/lib/types';
import { useDealSearch, PENDING_SEARCH_KEY, type SearchMode } from '@/lib/use-deal-search';
import { cn } from '@/lib/utils';
import { DealMasonry } from './deal-masonry';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useLocalDealStates } from './use-local-deal-states';

function SearchBox({
  value,
  onChange,
  onSubmit,
  loading,
  placeholder,
  inputRef,
  compact,
  mode,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  loading: boolean;
  placeholder: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  compact?: boolean;
  mode: SearchMode;
}) {
  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className={cn(
        'flex items-stretch gap-2',
        !compact &&
          'rounded-2xl border border-line bg-white/75 p-2 shadow-sm backdrop-blur transition-all duration-300 focus-within:border-gold/70 focus-within:shadow-[0_0_0_1px_rgba(161,162,7,0.22),0_24px_80px_-36px_rgba(161,162,7,0.55)]',
      )}
    >
      <div className="relative min-w-0 flex-1">
        {mode === 'ai' ? (
          <Sparkles
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-violet-500"
            aria-hidden="true"
          />
        ) : (
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
        )}
        <Input
          ref={inputRef}
          type="search"
          inputMode="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={mode === 'ai' ? 'AI 搜索优惠' : '普通搜索优惠'}
          className={cn(
            'pl-10 pr-11',
            !compact &&
              'h-12 border-transparent bg-transparent hover:border-transparent focus:border-transparent',
          )}
        />
        {value && (
          <button
            type="button"
            aria-label="清空搜索"
            onClick={() => onChange('')}
            className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <Button
        type="submit"
        disabled={!value.trim() || loading}
        className="w-11 shrink-0 px-0 sm:w-auto sm:px-4"
        aria-label={mode === 'ai' ? '开始 AI 搜索' : '开始普通搜索'}
      >
        {loading ? (
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : mode === 'ai' ? (
          <Sparkles className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Search className="h-4 w-4" aria-hidden="true" />
        )}
        <span className="hidden sm:inline">
          {loading ? '搜索中' : mode === 'ai' ? 'AI 搜索' : '搜索'}
        </span>
      </Button>
    </form>
  );
}

export function SearchLanding({
  initialSite,
  placeholderTag,
  activeCount,
  sourceCount,
  aiSearchEnabled,
  aiUnlocked,
  initialQuery,
  currentUserEmail = null,
}: {
  initialSite: SiteSettings;
  placeholderTag: string;
  activeCount: number;
  sourceCount: number;
  aiSearchEnabled: boolean;
  aiUnlocked: boolean;
  initialQuery: string;
  currentUserEmail?: string | null;
}) {
  const aiActive = aiSearchEnabled && aiUnlocked;
  const mode: SearchMode = aiActive ? 'ai' : 'keyword';
  const showLoginHint = aiSearchEnabled && !aiUnlocked;
  const loginHref = `/login?next=${encodeURIComponent(
    initialQuery ? `/search?q=${encodeURIComponent(initialQuery)}` : '/search',
  )}`;

  const [input, setInput] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [items, setItems] = useState<DealItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestIdRef = useRef(0);
  const initialAppliedRef = useRef(false);

  const { statesRef, ready, setFavorite } = useLocalDealStates();
  const {
    result,
    searching,
    error: searchError,
    search,
    clear,
  } = useDealSearch();

  const hasSearched = Boolean(submittedQuery);
  const loading = searching || loadingItems;
  const placeholder = aiActive
    ? placeholderTag
      ? `AI 搜索：${placeholderTag}`
      : 'AI 搜索：免费云服务器、视频会员、游戏…'
    : '搜索标题、摘要或来源…';

  const runSearch = useCallback(
    async (raw: string, options: { tag?: boolean; syncUrl?: boolean } = {}) => {
      const query = raw.trim();
      if (!query) return;

      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      setInput(query);
      setSubmittedQuery(query);
      setActiveTag(options.tag ? query : null);
      setItems([]);
      setFetchError(null);
      setLoadingItems(true);

      const next = await search(
        query,
        mode,
        options.tag ? query : undefined,
      );
      if (!next || requestId !== requestIdRef.current) {
        if (requestId === requestIdRef.current) setLoadingItems(false);
        return;
      }

      if (options.syncUrl !== false) {
        window.history.replaceState(
          null,
          '',
          `/search?q=${encodeURIComponent(query)}`,
        );
      }

      if (next.ids.length === 0) {
        setLoadingItems(false);
        return;
      }

      try {
        const params = new URLSearchParams();
        params.set('ids', next.ids.slice(0, 500).join(','));
        params.set('limit', '120');

        const response = await fetch(`/api/deals?${params.toString()}`, {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const payload = (await response.json()) as DealsListResponse;
        if (requestId !== requestIdRef.current) return;

        const order = new Map(next.ids.map((id, index) => [id, index]));
        setItems(
          payload.items
            .map((item) => {
              const override = statesRef.current[item.id];
              return override ? { ...item, ...override } : item;
            })
            .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
        );
      } catch (cause) {
        if (requestId === requestIdRef.current) {
          setFetchError(
            cause instanceof Error ? cause.message : '结果加载失败',
          );
        }
      } finally {
        if (requestId === requestIdRef.current) setLoadingItems(false);
      }
    },
    [mode, search, statesRef],
  );

  // 地址栏带 ?q=，或从首页跳转时带过来的关键词，自动还原搜索结果。
  useEffect(() => {
    if (initialAppliedRef.current || !ready) return;
    initialAppliedRef.current = true;

    if (initialQuery) {
      void runSearch(initialQuery, { syncUrl: false });
      return;
    }

    try {
      const pending = sessionStorage.getItem(PENDING_SEARCH_KEY)?.trim();
      if (pending) {
        sessionStorage.removeItem(PENDING_SEARCH_KEY);
        void runSearch(pending, { syncUrl: false });
      }
    } catch {
      // 忽略浏览器禁用存储的情况。
    }
  }, [initialQuery, ready, runSearch]);

  // 按 / 聚焦搜索框。
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
      inputRef.current?.focus();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const reset = useCallback(() => {
    requestIdRef.current += 1;
    clear();
    setInput('');
    setSubmittedQuery('');
    setActiveTag(null);
    setItems([]);
    setFetchError(null);
    setLoadingItems(false);
    window.history.replaceState(null, '', '/search');
  }, [clear]);

  const toggleFavorite = useCallback(
    (id: number) => {
      const item = items.find((candidate) => candidate.id === id);
      if (!item) return;

      const nextValue = !item.favorite;
      setFavorite(id, nextValue);
      setItems((previous) =>
        previous.map((candidate) =>
          candidate.id === id
            ? { ...candidate, favorite: nextValue }
            : candidate,
        ),
      );
    },
    [items, setFavorite],
  );

  const handleTagClick = useCallback(
    (tag: string) => {
      if (searching) return;
      void runSearch(tag, { tag: true });
    },
    [searching, runSearch],
  );

  return (
    <div className="relative isolate min-h-dvh overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="tech-aurora absolute inset-0" />
        <div className="tech-grid absolute inset-0" />
        <div className="tech-scan absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-gold/70 to-transparent" />
      </div>

      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <a
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          返回首页
        </a>
        <div className="flex items-center gap-3">
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400 sm:inline">
            {initialSite.label}
          </span>
          <a
            href={currentUserEmail ? '/account' : loginHref}
            className="inline-flex h-8 items-center rounded-full border border-line bg-white/80 px-3 text-[11px] font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-white hover:text-ink"
          >
            {currentUserEmail ? '我的账号' : '登录'}
          </a>
        </div>
      </header>

      {!hasSearched ? (
        <main className="mx-auto w-full max-w-3xl px-4 pb-20 pt-[12vh] sm:px-6 sm:pt-[16vh]">
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-gold">
            // AI DEAL SEARCH
          </p>
          <h1 className="mt-4 bg-gradient-to-br from-ink via-ink to-gold bg-clip-text text-4xl font-semibold tracking-tight text-transparent sm:text-6xl">
            {initialSite.title}
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-slate-500 sm:text-[15px]">
            {initialSite.tagline}
          </p>

          <div className="mt-8">
            <SearchBox
              value={input}
              onChange={setInput}
              onSubmit={() => void runSearch(input)}
              loading={loading}
              placeholder={placeholder}
              inputRef={inputRef}
              mode={mode}
            />
          </div>

          {showLoginHint && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-violet-100 bg-violet-50/80 px-3 py-2.5 text-[11px] leading-relaxed text-violet-800">
              <span className="inline-flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                登录后解锁 AI 搜索，还能设置关键词订阅，命中后推送到你自己的机器人。
              </span>
              <a
                href={loginHref}
                className="font-medium text-violet-900 underline underline-offset-2"
              >
                去登录
              </a>
            </div>
          )}

          <div className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px] text-slate-400">
            <span>
              <span className="text-ink">{activeCount}</span> 条在架
            </span>
            <span className="text-line">/</span>
            <span>
              <span className="text-ink">{sourceCount}</span> 个来源
            </span>
            <span className="text-line">/</span>
            <span>
              {aiActive
                ? 'AI 语义筛选已就绪'
                : showLoginHint
                  ? '登录后可用 AI 搜索'
                  : '关键词匹配模式'}
            </span>
          </div>
        </main>
      ) : (
        <main className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
          <div className="sticky top-0 z-10 -mx-4 border-b border-line/70 bg-paper/85 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
            <SearchBox
              value={input}
              onChange={setInput}
              onSubmit={() => void runSearch(input)}
              loading={loading}
              placeholder={placeholder}
              inputRef={inputRef}
              compact
              mode={mode}
            />
          </div>

          {showLoginHint && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-violet-100 bg-violet-50/80 px-3 py-2 text-[11px] leading-relaxed text-violet-800">
              <span>当前为关键词匹配，登录后可使用 AI 搜索。</span>
              <a
                href={loginHref}
                className="font-medium text-violet-900 underline underline-offset-2"
              >
                去登录
              </a>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500" aria-live="polite">
              找到{' '}
              <span className="font-semibold tabular-nums text-slate-700">
                {items.length}
              </span>{' '}
              条
              <span className="text-violet-700">
                {' '}
                · {result?.mode === 'ai' ? 'AI 语义筛选' : '关键词匹配'}「
                {submittedQuery}」
              </span>
              {activeTag && <span className="text-sky-700"> · 标签</span>}
            </p>
            <button
              type="button"
              onClick={reset}
              className="text-[11px] font-medium text-slate-500 underline-offset-2 hover:text-ink hover:underline"
            >
              重新搜索
            </button>
          </div>

          {result?.reason && !searchError && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-violet-100 bg-violet-50 px-3 py-2 text-[11px] leading-relaxed text-violet-800">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <p className="min-w-0 flex-1">{result.reason}</p>
            </div>
          )}

          <div className="mt-4">
            {searchError ? (
              <div className="rounded-2xl border border-dashed border-line bg-white/70 px-6 py-14 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600">
                  <WifiOff className="h-5 w-5" aria-hidden="true" />
                </div>
                <p className="mt-4 text-sm font-semibold text-ink">
                  搜索失败
                </p>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-500">
                  {searchError}
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <Button variant="outline" onClick={() => void runSearch(input)}>
                    重试
                  </Button>
                  {searchError.includes('登录') && (
                    <a
                      href={loginHref}
                      className="inline-flex h-11 items-center rounded-xl bg-ink px-4 text-sm font-medium text-white transition-colors hover:bg-slate-800"
                    >
                      去登录
                    </a>
                  )}
                  {searchError.includes('次数已用完') && (
                    <a
                      href="/account"
                      className="inline-flex h-11 items-center rounded-xl border border-line bg-white px-4 text-sm font-medium text-ink transition-colors hover:bg-slate-50"
                    >
                      查看账号
                    </a>
                  )}
                </div>
              </div>
            ) : fetchError ? (
              <div className="rounded-2xl border border-dashed border-line bg-white/70 px-6 py-14 text-center">
                <p className="text-sm font-semibold text-ink">结果加载失败</p>
                <p className="mt-1 text-xs text-slate-500">{fetchError}</p>
                <div className="mt-4 flex justify-center">
                  <Button variant="outline" onClick={() => void runSearch(input)}>
                    重试
                  </Button>
                </div>
              </div>
            ) : loading ? (
              <div className="flex flex-col items-center gap-3 py-16 text-slate-500">
                <LoaderCircle
                  className="h-5 w-5 animate-spin text-gold"
                  aria-hidden="true"
                />
                <p className="font-mono text-[11px] uppercase tracking-[0.2em]">
                  Searching
                </p>
              </div>
            ) : items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-line bg-white/70 px-6 py-14 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                  <Search className="h-5 w-5" aria-hidden="true" />
                </div>
                <p className="mt-4 text-sm font-semibold text-ink">
                  {result?.mode === 'ai'
                    ? 'AI 没有找到相关优惠'
                    : '没有找到相关优惠'}
                </p>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-500">
                  {result?.reason || '换一种说法再试试。'}
                </p>
                {(result?.suggestedTags?.length ?? 0) > 0 && (
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {result?.suggestedTags?.map((item) => (
                      <Button
                        key={item.tag}
                        variant="secondary"
                        size="sm"
                        disabled={searching}
                        onClick={() => void runSearch(item.tag, { tag: true })}
                      >
                        {item.tag}
                        <span className="text-xs text-slate-500">
                          {item.count}
                        </span>
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <DealMasonry
                items={items}
                highlight={submittedQuery}
                onToggleFavorite={toggleFavorite}
                onTagClick={handleTagClick}
              />
            )}
          </div>
        </main>
      )}
    </div>
  );
}
