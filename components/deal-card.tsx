import {
  ArrowUpRight,
  Bookmark,
  Check,
  Clock3,
  Sparkles,
} from 'lucide-react';
import {
  CATEGORY_LABELS,
} from '@/lib/constants';
import { getExpiryInfo } from '@/lib/format';
import type { Category, DealItem } from '@/lib/types';
import { cn, truncateText } from '@/lib/utils';
import { Badge } from './ui/badge';

const CATEGORY_STYLES: Record<Category, string> = {
  free: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  limited: 'border-sky-200 bg-sky-50 text-sky-800',
  discount: 'border-indigo-200 bg-indigo-50 text-indigo-800',
  membership: 'border-violet-200 bg-violet-50 text-violet-800',
  game: 'border-blue-200 bg-blue-50 text-blue-800',
  other: 'border-line bg-slate-50 text-slate-600',
};

interface DealCardProps {
  item: DealItem;
  highlight?: string;
  onToggleClaim: () => void;
  onToggleFavorite: () => void;
  onTagClick?: (tag: string) => void;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把命中的搜索词包成高亮，未命中时原样输出。 */
function Highlighted({ text, query }: { text: string; query?: string }) {
  const tokens = (query ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  if (tokens.length === 0) return <>{text}</>;

  const pattern = new RegExp(
    `(${tokens.map(escapeRegExp).join('|')})`,
    'gi',
  );
  const matched = new Set(tokens.map((token) => token.toLowerCase()));

  return (
    <>
      {text.split(pattern).map((part, index) =>
        matched.has(part.toLowerCase()) ? (
          <mark
            key={`${part}-${index}`}
            className="rounded-sm bg-amber-100 px-0.5 text-ink"
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function DealCard({
  item,
  highlight,
  onToggleClaim,
  onToggleFavorite,
  onTagClick,
}: DealCardProps) {
  const expiry = getExpiryInfo(item.expiresAt);
  const displayTitle = item.aiTitle || item.title;
  const titleChanged = Boolean(item.aiTitle && item.aiTitle !== item.title);
  const shortTitle = truncateText(displayTitle, 40);
  const hasAi = Boolean(item.aiSummary);

  return (
    <article
      aria-labelledby={`deal-title-${item.id}`}
      className={cn(
        'rounded-2xl border p-4 shadow-sm transition-colors duration-200',
        item.claimed
          ? 'border-slate-200 bg-slate-50'
          : 'border-line bg-white hover:border-slate-300',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <a
          id={`deal-title-${item.id}`}
          href={item.link}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'min-w-0 flex-1 cursor-pointer text-[15px] font-semibold leading-snug tracking-tight underline-offset-4 hover:underline',
            item.claimed ? 'text-slate-600' : 'text-ink',
          )}
        >
          <Highlighted text={displayTitle} query={highlight} />
        </a>
        <button
          type="button"
          aria-label={
            item.favorite ? `取消收藏：${shortTitle}` : `收藏：${shortTitle}`
          }
          aria-pressed={item.favorite}
          onClick={onToggleFavorite}
          className={cn(
            'flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors duration-200 disabled:opacity-60 md:h-9 md:w-9',
            item.favorite
              ? 'text-gold hover:bg-amber-50'
              : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700',
          )}
        >
          <Bookmark
            className={cn('h-5 w-5 md:h-4 md:w-4', item.favorite && 'fill-current')}
            aria-hidden="true"
          />
        </button>
      </div>

      {hasAi ? (
        <div
          className={cn(
            'mt-2.5 rounded-xl border px-3 py-2.5 md:py-2',
            item.claimed
              ? 'border-slate-200 bg-slate-50'
              : 'border-slate-200 bg-slate-50/80',
          )}
        >
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            AI 摘要
          </div>
          <p
            className={cn(
              'mt-1 text-[13px] leading-relaxed',
              item.claimed ? 'text-slate-500' : 'text-slate-700',
            )}
          >
            <Highlighted text={item.aiSummary ?? ''} query={highlight} />
          </p>
          {(item.aiValue || item.aiAction) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.aiValue && (
                <span className="inline-flex items-center rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600">
                  力度：{item.aiValue}
                </span>
              )}
              {item.aiAction && (
                <span className="inline-flex items-center rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600">
                  操作：{item.aiAction}
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
        item.description && (
          <p
            className={cn(
              'mt-2 line-clamp-3 text-[13px] leading-relaxed',
              item.claimed ? 'text-slate-500' : 'text-slate-600',
            )}
          >
            <Highlighted text={item.description} query={highlight} />
          </p>
        )
      )}

      {(item.description || titleChanged) && (
        <details className="mt-2">
          <summary className="w-fit cursor-pointer text-[11px] text-slate-400 transition-colors hover:text-slate-600">
            查看原文
          </summary>
          {titleChanged && (
            <p
              className={cn(
                'mt-1.5 text-[12px] leading-relaxed',
                item.claimed ? 'text-slate-400' : 'text-slate-500',
              )}
            >
              原标题：{item.title}
            </p>
          )}
          {item.description && (
            <p
              className={cn(
                'mt-1.5 whitespace-pre-line text-[12px] leading-relaxed',
                item.claimed ? 'text-slate-400' : 'text-slate-500',
              )}
            >
              {item.description}
            </p>
          )}
        </details>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5',
            CATEGORY_STYLES[item.category],
          )}
        >
          {CATEGORY_LABELS[item.category]}
        </span>
        <Badge variant="outline">{item.sourceName}</Badge>

        {item.tags
          .filter(
            (tag) =>
              tag !== CATEGORY_LABELS[item.category] &&
              tag !== item.sourceName,
          )
          .slice(0, 3)
          .map((tag) =>
            onTagClick ? (
              <button
                key={tag}
                type="button"
                aria-label={`查看标签：${tag}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onTagClick(tag);
                }}
                className="inline-flex cursor-pointer items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium leading-5 text-sky-800 transition-colors hover:border-sky-300 hover:bg-sky-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              >
                #{tag}
              </button>
            ) : (
              <span
                key={tag}
                className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium leading-5 text-sky-800"
              >
                #{tag}
              </span>
            ),
          )}

        {expiry && !expiry.expired && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5',
              expiry.urgent
                ? 'border-red-200 bg-red-50 text-red-700'
                : 'border-amber-200 bg-amber-50 text-amber-800',
            )}
          >
            {expiry.urgent && (
              <Clock3 className="h-3 w-3" aria-hidden="true" />
            )}
            {expiry.text}
          </span>
        )}

        {item.claimed && (
          <span className="inline-flex items-center gap-1 rounded-full border border-transparent bg-slate-200 px-2 py-0.5 text-[11px] font-medium leading-5 text-slate-600">
            <Check className="h-3 w-3" aria-hidden="true" />
            已读
          </span>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2 md:mt-3">
        <a
          href={item.link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-ink px-4 text-sm font-medium text-white transition-colors duration-200 hover:bg-slate-800 md:h-9 md:text-[13px]"
        >
          查看优惠
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </a>
        <button
          type="button"
          aria-pressed={item.claimed}
          aria-label={item.claimed ? '取消已读标记' : '标记为已读'}
          onClick={onToggleClaim}
          className={cn(
            'inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl border px-3.5 text-sm font-medium transition-colors duration-200 disabled:opacity-60 md:h-9 md:px-3 md:text-[13px]',
            item.claimed
              ? 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
              : 'border-line bg-white text-slate-700 hover:bg-slate-50',
          )}
        >
          <Check className="h-4 w-4" aria-hidden="true" />
          {item.claimed ? '已读' : '标为已读'}
        </button>
      </div>
    </article>
  );
}
