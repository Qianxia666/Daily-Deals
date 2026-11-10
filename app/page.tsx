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
  const countMap = new Map(
    getPopularTags(1000).map((item) => [item.tag, item.count]),
  );
  const tagOptions = vocabulary
    .map((tag) => ({ tag, count: countMap.get(tag) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return (
    <DealsApp
      initialSite={getSiteSettings()}
      placeholderTag={placeholderTag}
      tagOptions={tagOptions}
      currentUserEmail={user?.email ?? null}
    />
  );
}
