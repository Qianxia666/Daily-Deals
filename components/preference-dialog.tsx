'use client';

import { Search, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

export interface PreferenceOption {
  tag: string;
  count: number;
}

const MAX_SELECTION = 5;

interface PreferenceDialogProps {
  open: boolean;
  options: PreferenceOption[];
  initialTags: string[];
  onSave: (tags: string[]) => void;
  onCancel: () => void;
}

export function PreferenceDialog({
  open,
  options,
  initialTags,
  onSave,
  onCancel,
}: PreferenceDialogProps) {
  const [selected, setSelected] = useState<string[]>(initialTags);
  const [query, setQuery] = useState('');
  const [limitHit, setLimitHit] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(initialTags);
    setQuery('');
    setLimitHit(false);
  }, [open, initialTags]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [open, onCancel]);

  const filtered = useMemo(() => {
    const keyword = query.trim();
    if (!keyword) return options;
    return options.filter((option) => option.tag.includes(keyword));
  }, [options, query]);

  if (!open) return null;

  const toggle = (tag: string) => {
    setLimitHit(false);
    setSelected((previous) => {
      if (previous.includes(tag)) {
        return previous.filter((item) => item !== tag);
      }
      if (previous.length >= MAX_SELECTION) {
        setLimitHit(true);
        return previous;
      }
      return [...previous, tag];
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="preference-title"
        className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-line bg-white shadow-2xl sm:max-h-[80dvh] sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 pb-3 pt-4 sm:px-5">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-gold">
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              For you
            </p>
            <h2
              id="preference-title"
              className="mt-1 text-base font-semibold text-ink sm:text-lg"
            >
              选择你感兴趣的品类
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              最多选 {MAX_SELECTION} 个，之后可以在「猜你喜欢」里随时调整。
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onCancel}
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="px-4 pt-3 sm:px-5">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索品类，如：日用、零食"
              aria-label="搜索品类"
              className="h-10 w-full rounded-xl border border-line bg-white pl-9 pr-3 text-sm text-ink outline-none transition-colors placeholder:text-slate-400 focus:border-gold/70"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
          {filtered.length === 0 ? (
            <p className="py-10 text-center text-xs text-slate-500">
              没有匹配的品类，换个关键词试试。
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {filtered.map((option) => {
                const active = selected.includes(option.tag);
                return (
                  <button
                    key={option.tag}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggle(option.tag)}
                    className={cn(
                      'flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-xl border px-3 text-left text-xs font-medium transition-colors duration-200',
                      active
                        ? 'border-ink bg-ink text-white'
                        : 'border-line bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
                    )}
                  >
                    <span className="truncate">{option.tag}</span>
                    <span
                      className={cn(
                        'shrink-0 tabular-nums text-[10px]',
                        active ? 'text-white/70' : 'text-slate-400',
                      )}
                    >
                      {option.count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 sm:px-5">
          <p className="text-[11px] text-slate-500">
            已选{' '}
            <span className="font-semibold tabular-nums text-slate-700">
              {selected.length}
            </span>
            /{MAX_SELECTION}
            {limitHit && <span className="ml-1 text-amber-700">已达上限</span>}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}>
              跳过
            </Button>
            <Button
              size="sm"
              disabled={selected.length === 0}
              onClick={() => onSave(selected)}
            >
              保存并查看
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
