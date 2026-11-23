import { getSiteUrl } from './runtime-settings';

/**
 * 站点 Origin，用于 canonical、Open Graph、sitemap 与 robots。
 * 只采用后台「站点公开地址」；未配置或非法时返回 null，
 * 调用方应省略绝对链接，避免把可伪造的 Host 头写进页面与站点地图。
 */
/** 只接受 http(s) 且可被 URL 解析的地址，避免错误配置让整站渲染抛错。 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function getSiteOrigin(): Promise<string | null> {
  const configured = getSiteUrl();
  if (configured && isHttpUrl(configured)) return configured;
  return null;
}
