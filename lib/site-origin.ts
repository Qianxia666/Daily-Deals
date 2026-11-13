import { headers } from 'next/headers';
import { getSiteUrl } from './runtime-settings';

/**
 * 站点 Origin，用于 canonical、Open Graph、sitemap 与 robots。
 * 后台「站点公开地址」优先，保证反代、IP 直连等场景下输出稳定的正式域名；
 * 未配置时再回退到请求头推导。
 */
export async function getSiteOrigin(): Promise<string> {
  const configured = getSiteUrl();
  if (configured) return configured;

  const headerStore = await headers();
  const host =
    headerStore.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    headerStore.get('host') ||
    'localhost:3000';
  const proto =
    headerStore.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'http';

  return `${proto}://${host}`;
}
