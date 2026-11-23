import type { MetadataRoute } from 'next';
import { getSiteOrigin } from '@/lib/site-origin';

// 站点公开地址是运行时配置，必须在请求时读取。
export const dynamic = 'force-dynamic';

export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await getSiteOrigin();

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/api/'],
      },
    ],
    // 未配置站点公开地址时省略 sitemap/host，避免回显请求 Host。
    ...(origin ? { sitemap: `${origin}/sitemap.xml`, host: origin } : {}),
  };
}
