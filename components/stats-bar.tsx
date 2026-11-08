import { LoaderCircle, Megaphone } from 'lucide-react';
import { formatUpdatedAt } from '@/lib/format';
import type { Announcement, DealsStats } from '@/lib/types';

interface StatsBarProps {
  fetchedAt: string | null;
  fetching: boolean;
  stats: DealsStats;
  announcement: Announcement;
}

export function StatsBar({
  fetchedAt,
  fetching,
  stats,
  announcement,
}: StatsBarProps) {
  const hasAnnouncement =
    announcement.enabled && announcement.text.trim().length > 0;

  return (
    <section aria-label="抓取状态" className="mt-4 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 sm:text-[13px]">
        <span>
          更新时间{' '}
          <strong className="font-semibold tabular-nums text-ink">
            {formatUpdatedAt(fetchedAt)}
          </strong>
        </span>
        <span>
          在架{' '}
          <strong className="font-semibold tabular-nums text-ink">
            {stats.activeCount}
          </strong>
        </span>
        <span>
          本轮新增{' '}
          <strong className="font-semibold tabular-nums text-ink">
            {stats.newCount}
          </strong>
        </span>
        {fetching && (
          <span
            className="inline-flex items-center gap-1 text-slate-500"
            role="status"
          >
            <LoaderCircle
              className="h-3 w-3 animate-spin"
              aria-hidden="true"
            />
            抓取中
          </span>
        )}
      </div>

      {hasAnnouncement && (
        <div className="mt-2.5 flex gap-2 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2">
          <Megaphone
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700"
            aria-hidden="true"
          />
          <p className="whitespace-pre-line text-[11px] leading-relaxed text-amber-900">
            {announcement.text}
          </p>
        </div>
      )}
    </section>
  );
}
