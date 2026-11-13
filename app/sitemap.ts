import type { MetadataRoute } from 'next';
import { listSitemapDeals, listSitemapTags } from '@/lib/db';
import { getSiteOrigin } from '@/lib/site-origin';

// 缓存 15 分钟：sitemap 体积较大，避免每次爬虫请求都全量扫描数据库。
export const revalidate = 900;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await getSiteOrigin();
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
