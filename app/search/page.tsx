import type { Metadata } from 'next';
import { SearchLanding } from '@/components/search-landing';
import { getCurrentUser } from '@/lib/auth';
import { getAiSearchEnabled, getDealsMeta } from '@/lib/db';
import { getAiTagVocabulary, getSiteSettings } from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = getSiteSettings();
  return {
    title: `搜索 · ${site.title}`,
    description: site.tagline,
    alternates: { canonical: '/search' },
  };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.q) ? params.q[0] : params.q;
  const initialQuery = (raw ?? '').trim().slice(0, 80);

  const site = getSiteSettings();
  const vocabulary = getAiTagVocabulary();
  const placeholderTag =
    vocabulary.length > 0
      ? vocabulary[Math.floor(Math.random() * vocabulary.length)]
      : '';
  const meta = getDealsMeta();
  const user = await getCurrentUser();

  return (
    <SearchLanding
      initialSite={site}
      placeholderTag={placeholderTag}
      activeCount={meta.stats.activeCount}
      sourceCount={meta.sources.length}
      aiSearchEnabled={getAiSearchEnabled()}
      aiUnlocked={Boolean(user)}
      currentUserEmail={user?.email ?? null}
      initialQuery={initialQuery}
    />
  );
}
