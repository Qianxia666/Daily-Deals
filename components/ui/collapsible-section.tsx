'use client';

import { ChevronDown } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * 后台可折叠板块。折叠状态按 id 存在 localStorage，刷新后保持。
 * 内容始终挂载，仅隐藏，避免折叠时丢失表单状态。
 */
export function CollapsibleSection({
  id,
  title,
  description,
  actions,
  defaultOpen = true,
  className,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(`admin:section:${id}`);
      if (saved === '1') setOpen(true);
      else if (saved === '0') setOpen(false);
    } catch {
      // localStorage 不可用时按默认状态展示。
    }
  }, [id]);

  const toggle = () => {
    setOpen((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(
          `admin:section:${id}`,
          next ? '1' : '0',
        );
      } catch {
        // 忽略写入失败。
      }
      return next;
    });
  };

  return (
    <section
      className={cn(
        'rounded-2xl border border-line bg-white p-4 shadow-sm sm:p-5',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description ? (
            <div className="mt-1 text-[11px] leading-relaxed text-slate-500">
              {description}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={open ? '折叠' : '展开'}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-line bg-white text-slate-500 transition-colors hover:bg-slate-50"
          >
            <ChevronDown
              className={cn(
                'h-4 w-4 transition-transform',
                !open && '-rotate-90',
              )}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      <div className={open ? 'mt-3' : 'hidden'}>{children}</div>
    </section>
  );
}
