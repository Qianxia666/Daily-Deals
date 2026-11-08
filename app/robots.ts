import type { MetadataRoute } from 'next';
import { getSiteOrigin } from '@/lib/site-origin';

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
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
