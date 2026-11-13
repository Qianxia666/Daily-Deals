import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SOURCE_NAMES } from '@/lib/constants';
import { getPopularTags, listDealsByTag } from '@/lib/db';
import { getSiteSettings } from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 60;

function normalizeTag(raw: string): string {
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    value = raw;
  }
  return value.trim().slice(0, 20);
}

function formatDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ tag: string }>;
}): Promise<Metadata> {
  const tag = normalizeTag((await params).tag);
  const site = getSiteSettings();
  const { total } = listDealsByTag(tag, { limit: 1 });
  if (total === 0) return { title: `分类 · ${site.title}` };

  return {
    title: `${tag}优惠 · ${site.title}`,
    description: `共 ${total} 条「${tag}」相关优惠，来自真实来源，${site.tagline}`,
    alternates: { canonical: `/tag/${encodeURIComponent(tag)}` },
    robots: { index: true, follow: true },
  };
}

export default async function TagPage({
  params,
  searchParams,
}: {
  params: Promise<{ tag: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const tag = normalizeTag((await params).tag);
  if (!tag) notFound();

  const rawPage = (await searchParams).page;
  const page = Math.max(
    1,
    Number(Array.isArray(rawPage) ? rawPage[0] : rawPage) || 1,
  );
  const { items, total } = listDealsByTag(tag, {
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  if (total === 0 || items.length === 0) notFound();

  const site = getSiteSettings();
  const relatedTags = getPopularTags(120)
    .filter((item) => item.tag !== tag)
    .slice(0, 12);
  const pageCount = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="min-h-dvh px-4 py-8 md:py-10">
      <div className="mx-auto w-full max-w-4xl">
        <nav className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
          <Link href="/" className="transition-colors hover:text-ink">
            首页
          </Link>
          <span>/</span>
          <span>分类</span>
          <span>/</span>
          <span className="text-slate-500">{tag}</span>
        </nav>

        <header className="mt-4 border-b border-line pb-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-gold">
            {site.label} · TAG
          </p>
          <h1 className="mt-3 break-words text-3xl font-semibold leading-[1.2] tracking-tight text-ink md:text-4xl">
            {tag}优惠
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            共 {total} 条，按发布时间倒序，数据来自真实来源
            {page > 1 ? `（第 ${page} 页）` : ''}。
          </p>
        </header>

        <ul className="mt-5 space-y-3">
          {items.map((deal) => (
            <li
              key={deal.id}
              className="rounded-2xl border border-line bg-white px-5 py-4"
            >
              <Link
                href={`/deal/${deal.id}`}
                className="text-base font-medium leading-7 text-ink transition-colors hover:text-gold"
              >
                {deal.title}
              </Link>
              {deal.summary ? (
                <p className="mt-1.5 line-clamp-2 text-sm leading-6 text-slate-500">
                  {deal.summary}
                </p>
              ) : null}
              <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                <span>
                  {SOURCE_NAMES[deal.source as keyof typeof SOURCE_NAMES] ??
                    deal.source}
                </span>
                {deal.publishedAt ? (
                  <span>{formatDate(deal.publishedAt)}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>

        {pageCount > 1 ? (
          <nav className="mt-6 flex items-center justify-between text-sm">
            {page > 1 ? (
              <Link
                href={`/tag/${encodeURIComponent(tag)}${page > 2 ? `?page=${page - 1}` : ''}`}
                className="text-slate-500 transition-colors hover:text-ink"
              >
                ← 上一页
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-slate-400">
              {page} / {pageCount}
            </span>
            {page < pageCount ? (
              <Link
                href={`/tag/${encodeURIComponent(tag)}?page=${page + 1}`}
                className="text-slate-500 transition-colors hover:text-ink"
              >
                下一页 →
              </Link>
            ) : (
              <span />
            )}
          </nav>
        ) : null}

        {relatedTags.length > 0 ? (
          <section className="mt-10 border-t border-line pt-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-gold">
              其他分类
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {relatedTags.map((item) => (
                <Link
                  key={item.tag}
                  href={`/tag/${encodeURIComponent(item.tag)}`}
                  className="rounded-full border border-line bg-white px-3 py-1.5 text-xs text-slate-600 transition-colors hover:text-ink"
                >
                  {item.tag}
                  <span className="ml-1 text-slate-300">{item.count}</span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
