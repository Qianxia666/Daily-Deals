import type { NextRequest } from 'next/server';

interface Bucket {
  count: number;
  resetAt: number;
}

const store = new Map<string, Bucket>();
let lastSweep = 0;

/** 取客户端 IP；没有反向代理头时回退为全局计数。 */
export function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'global';
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
