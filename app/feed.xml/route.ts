import { listLatestDeals } from '@/lib/db';
import { getSiteSettings, getSiteUrl } from '@/lib/runtime-settings';
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

/** 仅当配置了可用的 http(s) 站点地址时，才允许公共缓存。 */
function hasValidSiteUrl(): boolean {
  const configured = getSiteUrl();
  if (!configured) return false;
  try {
    const url = new URL(configured);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function GET(): Promise<Response> {
  const origin = await getSiteOrigin();
  // 未配置站点公开地址时只输出相对链接，避免把请求 Host 写进订阅源。
  const base = origin ?? '';
  const site = getSiteSettings();
  const deals = listLatestDeals(50);

  const items = deals
    .map((deal) => {
      const url = `${base}/deal/${deal.id}`;
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
    <link>${escapeXml(origin ?? '/')}</link>
    <description>${escapeXml(site.tagline)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;

  // 未配置有效站点地址时，绝对链接来自请求头；禁止公共缓存，避免 Host 投毒被缓存放大。
  const cacheControl = hasValidSiteUrl()
    ? 'public, max-age=600'
    : 'no-store';

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': cacheControl,
    },
  });
}
