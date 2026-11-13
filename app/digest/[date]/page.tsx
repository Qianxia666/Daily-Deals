import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SOURCE_NAMES } from '@/lib/constants';
import { ensurePublicDigest, isValidDigestDate } from '@/lib/digest';
import { getSiteSettings } from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ date: string }>;
}): Promise<Metadata> {
  const { date } = await params;
  if (!isValidDigestDate(date)) return { title: '优惠汇总' };
  const digest = ensurePublicDigest(date);
  const site = getSiteSettings();
  return {
    title: `${digest.title} · ${site.title}`,
    description: digest.stats[0] ?? '每日优惠汇总',
    alternates: { canonical: `/digest/${date}` },
  };
}

export default async function DigestDatePage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  if (!isValidDigestDate(date)) notFound();

  const digest = ensurePublicDigest(date);
  const site = getSiteSettings();

  return (
    <div className="min-h-dvh px-4 py-8 md:py-10">
      <div className="mx-auto w-full max-w-7xl">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-ink"
        >
          ← 返回首页
        </Link>

        <header className="mt-5 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-gold">
              {site.label} · DAILY DIGEST
            </p>
            <h1 className="mt-2.5 text-3xl font-semibold tracking-tight text-ink md:text-4xl">
              {digest.title}
            </h1>
          </div>
          <div className="space-y-0.5 text-xs leading-5 text-slate-500 md:text-right">
            {digest.stats.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </header>

        <div className="mt-6 grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
          {digest.tags.length > 0 ? (
            <aside className="lg:sticky lg:top-6 lg:self-start">
              <nav aria-label="今日热词">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-xs font-semibold tracking-wide text-ink">
                    今日热词
                  </h2>
                  <span className="text-[10px] text-slate-400">提及次数</span>
                </div>
                <ul className="mt-2.5 flex flex-wrap gap-2 lg:mt-3 lg:block lg:divide-y lg:divide-line lg:border-y lg:border-line">
                  {digest.tags.map((tag, index) => (
                    <li key={tag.tag}>
                      <a
                        href={`#tag-${index + 1}`}
                        className="group flex items-baseline gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-xs text-slate-600 transition-colors hover:border-gold/60 hover:text-ink lg:border-0 lg:bg-transparent lg:px-0 lg:py-2"
                      >
                        <span className="font-mono text-[10px] text-gold">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {tag.tag}
                        </span>
                        <span className="font-mono text-[10px] text-slate-400 group-hover:text-gold">
                          {tag.count}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            </aside>
          ) : null}

          <div className="grid content-start gap-5 md:grid-cols-2">
            {digest.groups.map((group, groupIndex) => {
              const rank = digest.tags.findIndex((tag) => tag.tag === group.tag);
              return (
                <section
                  key={`${group.tag}-${groupIndex}`}
                  id={rank >= 0 ? `tag-${rank + 1}` : undefined}
                  className="scroll-mt-6 rounded-2xl border border-line bg-white p-4 md:p-5"
                >
                  <div className="flex items-baseline gap-2.5 border-b border-line pb-2.5">
                    <span className="font-mono text-[11px] text-gold">
                      {String(groupIndex + 1).padStart(2, '0')}
                    </span>
                    <h2 className="text-base font-semibold tracking-tight text-ink">
                      {group.tag}
                    </h2>
                    <span className="text-[11px] text-slate-400">
                      {group.count} 条提及
                    </span>
                  </div>

                  <ul className="divide-y divide-line">
                    {group.items.map((item) => {
                      const sourceName =
                        SOURCE_NAMES[item.source as keyof typeof SOURCE_NAMES] ??
                        item.source;
                      return (
                        <li key={item.dealId}>
                          <Link
                            href={`/deal/${item.dealId}`}
                            className="group flex items-start gap-2.5 py-2.5 transition-colors"
                          >
                            <span className="mt-0.5 text-[11px] text-slate-300 transition-colors group-hover:text-gold">
                              →
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block break-words text-[13.5px] font-medium leading-[1.45] text-ink transition-colors group-hover:text-gold">
                                {item.title}
                              </span>
                              <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-400">
                                <span>{sourceName}</span>
                                {item.tags.slice(0, 2).map((tag) => (
                                  <span
                                    key={tag}
                                    className="rounded-full bg-slate-50 px-1.5 py-0.5 text-slate-500"
                                  >
                                    {tag}
                                  </span>
                                ))}
                                {item.expired ? (
                                  <span className="text-amber-600">已过期</span>
                                ) : null}
                              </span>
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>

        {digest.groups.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-line bg-white p-8 text-sm text-slate-500">
            这一天还没有收录优惠，去首页看看最新内容吧。
          </div>
        ) : null}

        <div className="mt-8 border-t border-line pt-5">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-xs font-medium text-white transition-opacity hover:opacity-85"
          >
            浏览全部优惠 →
          </Link>
        </div>
      </div>
    </div>
  );
}
