import {
  Bookmark,
  LoaderCircle,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { CATEGORY_FILTERS } from '@/lib/constants';
import type {
  CategoryFilter,
  SourceId,
  SourceStatus,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';

export type SearchMode = 'ai' | 'keyword';

interface FilterBarProps {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onClearSearch: () => void;
  searching: boolean;
  searchError: string | null;
  mode: SearchMode;
  onModeChange: (mode: SearchMode) => void;
  aiSearchEnabled: boolean;
  aiWindowDays: number;
  keywordWindowDays: number;
  sources: SourceStatus[];
  totalActive: number;
  selectedSources: Set<SourceId>;
  onToggleSource: (source: SourceId) => void;
  onClearSources: () => void;
  category: CategoryFilter;
  onCategoryChange: (category: CategoryFilter) => void;
  hasFilters: boolean;
  onClearFilters: () => void;
}

interface ChipProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}

function Chip({ active, onClick, children, className }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-xs font-medium transition-colors duration-200',
        active
          ? 'border-ink bg-ink text-white'
          : 'border-line bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function FilterBar({
  inputRef,
  query,
  onQueryChange,
  onSearch,
  onClearSearch,
  searching,
  searchError,
  mode,
  onModeChange,
  aiSearchEnabled,
  aiWindowDays,
  keywordWindowDays,
  sources,
  totalActive,
  selectedSources,
  onToggleSource,
  onClearSources,
  category,
  onCategoryChange,
  hasFilters,
  onClearFilters,
}: FilterBarProps) {
  return (
    <section
      aria-label="搜索与筛选"
      className="rounded-2xl border border-line bg-white p-3.5 shadow-sm sm:p-4"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label="搜索模式"
          className="inline-flex rounded-xl border border-line bg-slate-50 p-0.5"
        >
          <button
            type="button"
            aria-pressed={mode === 'ai'}
            disabled={!aiSearchEnabled}
            title={aiSearchEnabled ? '由 AI 筛选并排序' : '管理员已关闭 AI 搜索'}
            onClick={() => onModeChange('ai')}
            className={cn(
              'inline-flex h-11 cursor-pointer items-center gap-1.5 rounded-[10px] px-3 text-xs font-medium transition-colors duration-200 md:h-9',
              mode === 'ai'
                ? 'bg-white text-ink shadow-sm'
                : 'text-slate-500 hover:text-slate-700',
              !aiSearchEnabled &&
                'cursor-not-allowed text-slate-400 hover:text-slate-400',
            )}
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            AI 搜索
          </button>
          <button
            type="button"
            aria-pressed={mode === 'keyword'}
            onClick={() => onModeChange('keyword')}
            className={cn(
              'inline-flex h-11 cursor-pointer items-center gap-1.5 rounded-[10px] px-3 text-xs font-medium transition-colors duration-200 md:h-9',
              mode === 'keyword'
                ? 'bg-white text-ink shadow-sm'
                : 'text-slate-500 hover:text-slate-700',
            )}
          >
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            普通搜索
          </button>
        </div>
        <span className="text-[11px] text-slate-500">
          {mode === 'ai'
            ? `最近 ${aiWindowDays} 天`
            : `最近 ${keywordWindowDays} 天`}
        </span>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
        className="flex items-stretch gap-2"
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
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={
              mode === 'ai'
                ? 'AI 搜索：免费云服务器、视频会员、游戏…'
                : '搜索标题、摘要或来源…'
            }
            aria-label={mode === 'ai' ? 'AI 搜索优惠' : '普通搜索优惠'}
            className="pl-10 pr-11"
          />
          {query && (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={onClearSearch}
              className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <Button
          type="submit"
          disabled={!query.trim() || searching}
          className="w-11 shrink-0 px-0 sm:w-auto sm:px-4"
          aria-label={mode === 'ai' ? '开始 AI 搜索' : '开始普通搜索'}
        >
          {searching ? (
            <LoaderCircle
              className="h-4 w-4 animate-spin"
              aria-hidden="true"
            />
          ) : mode === 'ai' ? (
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Search className="h-4 w-4" aria-hidden="true" />
          )}
          <span className="hidden sm:inline">
            {searching ? '搜索中' : mode === 'ai' ? 'AI 搜索' : '搜索'}
          </span>
        </Button>
      </form>

      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
        {!aiSearchEnabled
          ? `管理员已关闭 AI 搜索，普通搜索匹配最近 ${keywordWindowDays} 天的标题与摘要。`
          : mode === 'ai'
            ? `AI 只根据标题筛选最近 ${aiWindowDays} 天的优惠，只返回真实存在的条目。`
            : `普通搜索匹配最近 ${keywordWindowDays} 天的标题、摘要与描述。`}
      </p>
      {searchError && (
        <p className="mt-1.5 text-[11px] text-red-600">{searchError}</p>
      )}

      <div className="no-scrollbar -mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-0.5 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
        <Chip
          active={selectedSources.size === 0}
          onClick={onClearSources}
        >
          全部来源
          <span
            className={cn(
              'tabular-nums',
              selectedSources.size === 0 ? 'text-white/70' : 'text-slate-500',
            )}
          >
            {totalActive}
          </span>
        </Chip>
        {sources.map((source) => {
          const active = selectedSources.has(source.id);
          return (
            <Chip
              key={source.id}
              active={active}
              onClick={() => onToggleSource(source.id)}
            >
              {source.name}
              <span
                className={cn(
                  'tabular-nums',
                  active ? 'text-white/70' : 'text-slate-500',
                )}
              >
                {source.count}
              </span>
            </Chip>
          );
        })}
      </div>

      <div className="no-scrollbar -mx-1 mt-2 flex gap-2 overflow-x-auto px-1 pb-0.5 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
        {CATEGORY_FILTERS.map((filter) => {
          const active = category === filter.value;
          return (
            <Chip
              key={filter.value}
              active={active}
              onClick={() => onCategoryChange(filter.value)}
            >
              {filter.value === 'favorites' && (
                <Bookmark
                  className={cn('h-3.5 w-3.5', active && 'fill-current')}
                  aria-hidden="true"
                />
              )}
              {filter.label}
            </Chip>
          );
        })}
      </div>

      {hasFilters && (
        <div className="mt-2.5 flex items-center justify-end border-t border-line pt-2.5">
          <button
            type="button"
            onClick={onClearFilters}
            className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-2 text-xs font-medium text-slate-600 underline-offset-4 transition-colors hover:text-ink hover:underline"
          >
            清空筛选
          </button>
        </div>
      )}
    </section>
  );
}
