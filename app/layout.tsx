import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { getSiteSettings } from '@/lib/runtime-settings';
import { getSiteOrigin } from '@/lib/site-origin';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const site = getSiteSettings();
  const origin = await getSiteOrigin();
  const title =
    site.label && site.label !== site.title
      ? `${site.title} · ${site.label}`
      : site.title;

  return {
    metadataBase: new URL(origin),
    title,
    description: site.tagline,
    applicationName: site.title,
    alternates: { canonical: '/' },
    openGraph: {
      title,
      description: site.tagline,
      url: '/',
      siteName: site.title,
      locale: 'zh_CN',
      type: 'website',
    },
    twitter: {
      card: 'summary',
      title,
      description: site.tagline,
    },
    robots: { index: true, follow: true },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f8fafc',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
