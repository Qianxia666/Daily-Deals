import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: '每日优惠情报 · Daily Deals',
  description:
    '定时自动聚合多个真实来源的免费、限免与低价优惠信息，只展示真实抓取到的内容。',
  applicationName: '每日优惠情报',
};

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
