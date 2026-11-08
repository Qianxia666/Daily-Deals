import { headers } from 'next/headers';

/**
 * 从请求头推导站点 Origin，兼容反向代理后的域名、端口与 HTTPS。
 * 未绑定域名时也能得到当前访问地址，用于 canonical、Open Graph 和 sitemap。
 */
export async function getSiteOrigin(): Promise<string> {
  const headerStore = await headers();
  const host =
    headerStore.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    headerStore.get('host') ||
    'localhost:3000';
  const proto =
    headerStore.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'http';

  return `${proto}://${host}`;
}
