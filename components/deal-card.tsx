'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Bookmark,
  ChevronDown,
  Clock3,
  FileText,
  Sparkles,
} from 'lucide-react';
import { formatPublishedAt, getExpiryInfo } from '@/lib/format';
import type { DealItem } from '@/lib/types';
import { cn, truncateText } from '@/lib/utils';
import { Badge } from './ui/badge';

interface DealCardProps {
  item: DealItem;
  highlight?: string;
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
  onToggleFavorite,
  onTagClick,
}: DealCardProps) {
  const expiry = getExpiryInfo(item.expiresAt);
  const displayTitle = item.aiTitle || item.title;
  const titleChanged = Boolean(item.aiTitle && item.aiTitle !== item.title);
  const shortTitle = truncateText(displayTitle, 40);
  const hasAi = Boolean(item.aiSummary);
  const [bodyOpen, setBodyOpen] = useState(false);
  const [bodyClamped, setBodyClamped] = useState(false);
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const hasBody = Boolean(item.description);
  // 原文块底部的折角按钮会向下溢出，页脚需要留出空间。
  const bodyToggle = !hasAi && hasBody && bodyClamped;

  // 折叠高度小于内容高度时才需要「展开全文」。等一帧再量，避免样式未生效时误判。
  useEffect(() => {
    if (bodyOpen) return;
    const element = bodyRef.current;
    if (!element) return;

    const check = () => {
      setBodyClamped(element.scrollHeight > element.clientHeight + 1);
    };

    check();
    const frame = requestAnimationFrame(check);
    window.addEventListener('resize', check);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', check);
    };
  }, [bodyOpen, item.description]);
  const publishedAt = formatPublishedAt(item.publishedAt);
  const hasOriginal = Boolean(item.description || titleChanged);
  const originalContent = (
    <div className="space-y-1.5">
      {titleChanged && (
        <p className="text-[12px] leading-relaxed text-slate-500">
          原标题：{item.title}
        </p>
      )}
      {item.description && (
        <p className="whitespace-pre-line text-[12px] leading-relaxed text-slate-500">
          {item.description}
        </p>
      )}
    </div>
  );

  return (
    <article
      aria-labelledby={`deal-title-${item.id}`}
      className="rounded-2xl border border-line bg-white p-4 shadow-sm transition-colors duration-200 hover:border-slate-300"
    >
      <div className="flex items-start justify-between gap-2">
        <a
          id={`deal-title-${item.id}`}
          href={item.link}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 cursor-pointer text-[15px] font-semibold leading-snug tracking-tight text-ink underline-offset-4 hover:underline"
        >
          <Highlighted text={displayTitle} query={highlight} />
        </a>
        {publishedAt && (
          <span className="shrink-0 whitespace-nowrap pt-0.5 text-[11px] leading-5 text-slate-400">
            {publishedAt}
          </span>
        )}
      </div>

      {hasAi ? (
        <div className="relative mt-2.5 rounded-xl border border-slate-200 bg-slate-50/80 px-3 pb-5 pt-2.5 md:pb-4 md:pt-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            AI 摘要
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-slate-700">
            <Highlighted text={item.aiSummary ?? ''} query={highlight} />
          </p>

          {hasOriginal && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -bottom-px left-1/2 h-px w-9 -translate-x-1/2 bg-white"
            />
          )}

          {hasOriginal && (
            <details className="group">
              <summary
                aria-label="查看原文"
                title="查看原文"
                className="absolute -bottom-3.5 left-1/2 flex h-7 w-9 -translate-x-1/2 cursor-pointer list-none items-center justify-center text-slate-300 transition-colors hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 [&::-webkit-details-marker]:hidden"
              >
                <ChevronDown
                  className="h-4 w-4 transition-transform duration-200 group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <div className="mt-2.5 border-t border-slate-200 pt-2">
                {originalContent}
              </div>
            </details>
          )}
        </div>
      ) : (
        hasBody && (
          <div
            className={cn(
              'relative mt-2.5 rounded-xl border border-slate-200 bg-slate-50/80 px-3 pt-2.5',
              bodyClamped ? 'pb-6' : 'pb-2.5',
            )}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
              <FileText className="h-3.5 w-3.5" aria-hidden="true" />
              文章原文
            </div>
            <p
              ref={bodyRef}
              className={cn(
                'mt-1 whitespace-pre-line text-[13px] leading-relaxed text-slate-700',
                !bodyOpen && 'line-clamp-3',
              )}
            >
              <Highlighted text={item.description ?? ''} query={highlight} />
            </p>
            {bodyClamped && (
              <>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -bottom-px left-1/2 h-px w-9 -translate-x-1/2 bg-white"
                />
                <button
                  type="button"
                  aria-label={bodyOpen ? '收起原文' : '展开原文'}
                  title={bodyOpen ? '收起原文' : '展开原文'}
                  aria-expanded={bodyOpen}
                  onClick={() => setBodyOpen((open) => !open)}
                  className="absolute -bottom-3.5 left-1/2 flex h-7 w-9 -translate-x-1/2 cursor-pointer items-center justify-center text-slate-300 transition-colors hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                >
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 transition-transform duration-200',
                      bodyOpen && 'rotate-180',
                    )}
                    aria-hidden="true"
                  />
                </button>
              </>
            )}
          </div>
        )
      )}

      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5',
          hasAi && hasOriginal ? 'mt-5' : bodyToggle ? 'mt-5' : 'mt-3',
        )}
      >
        <Badge variant="outline">{item.sourceName}</Badge>

        {item.tags
          .filter((tag) => tag !== item.sourceName)
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
      </div>

      <div className="mt-4 flex items-center gap-2 md:mt-3">
        <a
          href={item.link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-ink px-4 text-sm font-medium text-white transition-colors duration-200 hover:bg-slate-800 md:h-9 md:text-[13px]"
        >
          查看
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </a>
        <button
          type="button"
          aria-label={
            item.favorite ? `取消收藏：${shortTitle}` : `收藏：${shortTitle}`
          }
          aria-pressed={item.favorite}
          onClick={onToggleFavorite}
          className={cn(
            'inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition-colors duration-200 disabled:opacity-60 md:h-9 md:px-3 md:text-[13px]',
            item.favorite
              ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'
              : 'border-line bg-white text-slate-700 hover:bg-slate-50',
          )}
        >
          <Bookmark
            className={cn('h-4 w-4', item.favorite && 'fill-current')}
            aria-hidden="true"
          />
          {item.favorite ? '已收藏' : '收藏'}
        </button>
      </div>
    </article>
  );
}
