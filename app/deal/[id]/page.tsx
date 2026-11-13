import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SOURCE_NAMES } from '@/lib/constants';
import { getDealById, getRelatedDeals, isSourceVisible } from '@/lib/db';
import { getSiteSettings } from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';

function formatDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const site = getSiteSettings();
  const deal = getDealById(Number(id));
  if (!deal || !isSourceVisible(deal.source)) {
    return { title: `优惠详情 · ${site.title}` };
  }
  const expired = deal.expiresAt
    ? Date.parse(deal.expiresAt) <= Date.now()
    : false;
  return {
    title: `${deal.title} · ${site.title}`,
    description: (deal.summary || deal.description).slice(0, 120),
    alternates: { canonical: `/deal/${deal.id}` },
    robots: expired
      ? { index: false, follow: true }
      : { index: true, follow: true },
  };
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-4 py-3.5 md:px-5">
      <dt className="text-[10px] uppercase tracking-[0.18em] text-slate-400">
        {label}
      </dt>
      <dd className="mt-1 truncate text-sm font-medium text-ink">{value}</dd>
    </div>
  );
}

export default async function DealPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const deal = getDealById(Number(id));
  if (!deal || !isSourceVisible(deal.source)) notFound();

  const site = getSiteSettings();
  const sourceName =
    SOURCE_NAMES[deal.source as keyof typeof SOURCE_NAMES] ?? deal.source;
  const expired = deal.expiresAt
    ? new Date(deal.expiresAt).getTime() <= Date.now()
    : false;
  const summary = deal.summary.trim();
  const description = deal.description.trim();
  const body = summary || description;
  const related = getRelatedDeals(deal.id, deal.tags, 4);

  return (
    <div className="min-h-dvh px-4 py-8 md:py-10">
      <div className="mx-auto w-full max-w-7xl">
        <nav className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
          <Link href="/" className="transition-colors hover:text-ink">
            首页
          </Link>
          <span>/</span>
          <span>{sourceName}</span>
          <span>/</span>
          <span className="max-w-[18rem] truncate text-slate-500">
            {deal.title}
          </span>
        </nav>

        <header className="mt-4 border-b border-line pb-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.32em] text-gold">
              {site.label} · DEAL
            </span>
            <span className="h-px flex-1 bg-line" />
            <span className="font-mono text-[10px] text-slate-300">
              #{String(deal.id).padStart(5, '0')}
            </span>
          </div>

          <h1 className="mt-3.5 break-words text-3xl font-semibold leading-[1.2] tracking-tight text-ink md:text-[2.9rem]">
            {deal.title}
          </h1>

          {deal.tags.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {deal.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-line px-2.5 py-1 text-[11px] text-slate-600"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          {expired ? (
            <p className="mt-4 rounded-xl bg-amber-50 px-4 py-2.5 text-sm leading-relaxed text-amber-700">
              该优惠已过期，以下信息仅供参考，请以原链接页面为准。
            </p>
          ) : null}
        </header>

        <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-4">
          <Fact label="来源" value={sourceName} />
          <Fact
            label="发布"
            value={deal.publishedAt ? formatDate(deal.publishedAt) : '—'}
          />
          <Fact
            label="有效期"
            value={
              deal.expiresAt ? formatDate(deal.expiresAt) : '长期有效'
            }
          />
          <Fact label="状态" value={expired ? '已过期' : '进行中'} />
        </dl>

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <main className="min-w-0 space-y-5">
            <article className="rounded-2xl border border-line bg-white px-6 py-6 md:px-8">
              <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-gold">
                优惠说明
              </p>
              {body ? (
                <p className="mt-3 whitespace-pre-wrap [overflow-wrap:anywhere] text-[15px] leading-7 text-slate-700 md:text-base md:leading-8">
                  {body}
                </p>
              ) : (
                <p className="mt-3 text-sm text-slate-400">
                  暂无详细说明，可前往原链接查看完整活动内容。
                </p>
              )}

              {summary && description && description !== summary ? (
                <details className="group mt-5 border-t border-line pt-3.5">
                  <summary className="cursor-pointer list-none text-xs font-medium text-slate-500 transition-colors hover:text-ink">
                    查看来源原文
                    <span className="ml-1 inline-block transition-transform group-open:rotate-90">
                      ›
                    </span>
                  </summary>
                  <p className="mt-3 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-7 text-slate-500">
                    {description}
                  </p>
                </details>
              ) : null}
            </article>

            {deal.value || deal.action ? (
              <div className="grid gap-5 md:grid-cols-2">
                {deal.value ? (
                  <section className="rounded-2xl border border-line bg-white px-6 py-5">
                    <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-gold">
                      优惠力度
                    </p>
                    <p className="mt-2 text-sm leading-7 text-ink">
                      {deal.value}
                    </p>
                  </section>
                ) : null}
                {deal.action ? (
                  <section className="rounded-2xl border border-line bg-white px-6 py-5">
                    <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-gold">
                      参与方式
                    </p>
                    <p className="mt-2 text-sm leading-7 text-ink">
                      {deal.action}
                    </p>
                  </section>
                ) : null}
              </div>
            ) : null}
          </main>

          <aside className="lg:sticky lg:top-6">
            <div className="rounded-2xl border border-line bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line font-mono text-xs text-gold">
                  {sourceName.slice(0, 1)}
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] text-slate-400">优惠来源</p>
                  <p className="truncate text-sm font-medium text-ink">
                    {sourceName}
                  </p>
                </div>
              </div>

              <a
                href={deal.link}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="mt-4 inline-flex w-full items-center justify-center rounded-xl bg-ink px-4 py-3.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                前往原链接 →
              </a>
              <p className="mt-3 text-center text-[11px] leading-5 text-slate-400">
                优惠来自第三方来源，请在打开后自行核实价格与有效期。
              </p>
            </div>

            <Link
              href="/"
              className="mt-4 flex items-center justify-center rounded-xl border border-line bg-white px-4 py-2.5 text-xs font-medium text-slate-600 transition-colors hover:text-ink"
            >
              继续浏览优惠
            </Link>
          </aside>
        </div>

        {related.length > 0 ? (
          <section className="mt-8">
            <div className="flex items-baseline justify-between border-b border-line pb-2.5">
              <h2 className="text-sm font-semibold text-ink">同类优惠</h2>
              <span className="text-[11px] text-slate-400">根据标签推荐</span>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {related.map((item) => {
                const name =
                  SOURCE_NAMES[item.source as keyof typeof SOURCE_NAMES] ??
                  item.source;
                return (
                  <Link
                    key={item.id}
                    href={`/deal/${item.id}`}
                    className="group flex min-h-24 flex-col justify-between rounded-2xl border border-line bg-white p-4 transition-colors hover:border-gold/50"
                  >
                    <p className="text-sm font-medium leading-6 text-ink transition-colors group-hover:text-gold">
                      {item.title}
                    </p>
                    <p className="mt-3 flex items-center justify-between text-[11px] text-slate-400">
                      <span>{name}</span>
                      <span className="transition-transform group-hover:translate-x-0.5">
                        →
                      </span>
                    </p>
                  </Link>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
