import Link from 'next/link';
import { getPopularTags } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { DealsApp } from '@/components/deals-app';
import { getAiTagVocabulary, getSiteSettings } from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await getCurrentUser();

  // 每次请求随机取一个品类标签做搜索占位词，刷新即换。
  const vocabulary = getAiTagVocabulary();
  const placeholderTag =
    vocabulary.length > 0
      ? vocabulary[Math.floor(Math.random() * vocabulary.length)]
      : '';

  // 「猜你喜欢」按库内实际条数排序，0 条的品类排在后面。
  const popularTags = getPopularTags(1000);
  const countMap = new Map(
    popularTags.map((item) => [item.tag, item.count]),
  );
  const tagOptions = vocabulary
    .map((tag) => ({ tag, count: countMap.get(tag) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  // 页脚分类入口：服务端渲染，方便搜索引擎顺着链接抓到标签页与详情页。
  const hotTags = popularTags
    .filter((item) => item.count >= 5)
    .slice(0, 30);

  return (
    <>
      <DealsApp
        initialSite={getSiteSettings()}
        placeholderTag={placeholderTag}
        tagOptions={tagOptions}
        currentUserEmail={user?.email ?? null}
      />
      {hotTags.length > 0 ? (
        <footer className="border-t border-line px-4 py-8">
          <div className="mx-auto w-full max-w-7xl">
            <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-gold">
              热门分类
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {hotTags.map((item) => (
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
          </div>
        </footer>
      ) : null}
    </>
  );
}
