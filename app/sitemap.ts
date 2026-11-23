import type { MetadataRoute } from 'next';
import { listSitemapDeals, listSitemapTags } from '@/lib/db';
import { getSiteOrigin } from '@/lib/site-origin';

// 站点公开地址是运行时配置（后台/环境变量），必须在请求时读取而不是构建时固化。
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await getSiteOrigin();
  // 未配置站点公开地址时不输出任何条目：避免把请求 Host 拼进 <loc>。
  if (!origin) return [];
  const deals = listSitemapDeals();
  const tags = listSitemapTags(5, 300);

  return [
    {
      url: `${origin}/`,
      lastModified: new Date(),
      changeFrequency: 'hourly',
      priority: 1,
    },
    {
      url: `${origin}/search`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.6,
    },
    ...tags.map((item) => ({
      url: `${origin}/tag/${encodeURIComponent(item.tag)}`,
      lastModified: new Date(item.lastModified),
      changeFrequency: 'daily' as const,
      priority: 0.7,
    })),
    ...deals.map((deal) => ({
      url: `${origin}/deal/${deal.id}`,
      lastModified: new Date(deal.lastModified),
      changeFrequency: 'daily' as const,
      priority: 0.8,
    })),
  ];
}
