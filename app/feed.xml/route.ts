import { listLatestDeals } from '@/lib/db';
import { getSiteSettings } from '@/lib/runtime-settings';
import { getSiteOrigin } from '@/lib/site-origin';

export const dynamic = 'force-dynamic';

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export async function GET(): Promise<Response> {
  const origin = await getSiteOrigin();
  const site = getSiteSettings();
  const deals = listLatestDeals(50);

  const items = deals
    .map((deal) => {
      const url = `${origin}/deal/${deal.id}`;
      const summary = (deal.summary || deal.title).slice(0, 300);
      return `    <item>
      <title>${escapeXml(deal.title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="true">${escapeXml(url)}</guid>
      <description>${escapeXml(summary)}</description>
${
  deal.publishedAt
    ? `      <pubDate>${new Date(deal.publishedAt).toUTCString()}</pubDate>\n`
    : ''
}      <category>${escapeXml(deal.source)}</category>
    </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(site.title)}</title>
    <link>${escapeXml(origin)}</link>
    <description>${escapeXml(site.tagline)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
    },
  });
}
