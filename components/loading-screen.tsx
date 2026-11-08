'use client';

import { Tag } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 全屏首屏加载动画。
 * leaving 为 true 时淡出，由调用方在动画结束后卸载。
 */
export function LoadingScreen({
  label,
  leaving = false,
}: {
  label: string;
  leaving?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-[#fffdf8] transition-opacity duration-300',
        leaving && 'pointer-events-none opacity-0',
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute h-[26rem] w-[26rem] rounded-full bg-[radial-gradient(circle,rgba(161,98,7,0.16),transparent_68%)]"
      />

      <div className="relative flex flex-col items-center px-6 text-center">
        <div className="relative h-20 w-20">
          <div className="absolute inset-0 rounded-full border-2 border-amber-100" />
          <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-gold motion-reduce:animate-none" />
          <div className="absolute inset-[7px] flex items-center justify-center rounded-full bg-amber-50">
            <Tag
              aria-hidden="true"
              className="h-7 w-7 animate-pulse text-gold motion-reduce:animate-none"
            />
          </div>
        </div>

        <p className="mt-6 text-sm font-semibold tracking-wide text-ink">
          正在准备今日优惠
        </p>
        <p className="mt-1.5 text-xs text-slate-500">
          正在同步各来源的最新内容
        </p>

        <div className="mt-4 flex items-center gap-1.5" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="h-1.5 w-1.5 animate-bounce rounded-full bg-gold/70 motion-reduce:animate-none"
              style={{ animationDelay: `${index * 140}ms` }}
            />
          ))}
        </div>
      </div>

      <p className="absolute bottom-8 text-[10px] uppercase tracking-[0.28em] text-slate-400">
        {label}
      </p>
      <span className="sr-only">正在加载优惠数据</span>
    </div>
  );
}
