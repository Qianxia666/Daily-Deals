import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

interface Bucket {
  count: number;
  resetAt: number;
}

const store = new Map<string, Bucket>();
let lastSweep = 0;

/**
 * 取客户端标识。
 * 只有显式配置 TRUST_PROXY=1 时才信任代理头；否则使用请求指纹，
 * 避免攻击者通过轮换 X-Forwarded-For 绕过限流。
 */
export function getClientIp(request: NextRequest): string {
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
      // 取最右侧地址：由可信反代追加，而不是客户端可伪造的最左值。
      const parts = forwarded
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      const candidate = parts[parts.length - 1];
      if (candidate) return candidate;
    }
    const realIp = request.headers.get('x-real-ip')?.trim();
    if (realIp) return realIp;
  }

  const fingerprint = [
    request.headers.get('user-agent') ?? '',
    request.headers.get('accept-language') ?? '',
    request.headers.get('accept-encoding') ?? '',
  ].join('|');
  return `anon:${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`;
}

/** 固定窗口计数；返回是否放行以及建议的重试秒数。 */
export function checkRateLimit(
  key: string,
  limit: number,
): { ok: boolean; retryAfter: number } {
  const now = Date.now();

  // 定期清理过期桶，避免低流量下过期条目长期驻留内存。
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [entryKey, bucket] of store) {
      if (bucket.resetAt <= now) store.delete(entryKey);
    }
  }

  const current = store.get(key);
  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + 60_000 });
    return { ok: true, retryAfter: 0 };
  }

  if (current.count >= limit) {
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  return { ok: true, retryAfter: 0 };
}

/**
 * 路由级全站兜底桶。
 * 匿名请求的指纹来自可伪造的请求头（UA/Accept-Language/Accept-Encoding），
 * 轮换这些头即可拿到新的指纹桶；高价值入口需要在指纹桶之外再限一层全站总量。
 */
export function checkGlobalRateLimit(
  route: string,
  limit: number,
): { ok: boolean; retryAfter: number } {
  return checkRateLimit(`global:${route}`, limit);
}
