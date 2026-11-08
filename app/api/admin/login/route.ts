import { NextResponse, type NextRequest } from 'next/server';
import {
  ADMIN_COOKIE,
  adminConfigured,
  createSessionToken,
  verifyPassword,
} from '@/lib/admin';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import {
  getRuntimeBool,
  getRuntimeEnvNumber,
} from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  if (!adminConfigured()) {
    return NextResponse.json(
      { error: '服务端未配置 ADMIN_PASSWORD' },
      { status: 503 },
    );
  }

  if (getRuntimeBool('RATE_LIMIT_ENABLED', true)) {
    const limit = getRuntimeEnvNumber(
      'ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE',
      5,
      1,
      60,
    );
    const result = checkRateLimit(`admin-login:${getClientIp(request)}`, limit);
    if (!result.ok) {
      return NextResponse.json(
        { error: '尝试过于频繁，请稍后再试' },
        {
          status: 429,
          headers: { 'Retry-After': String(result.retryAfter) },
        },
      );
    }
  }

  const body = (await request.json().catch(() => null)) as
    | { password?: unknown }
    | null;
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!verifyPassword(password)) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return NextResponse.json({ error: '密码错误' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
  return response;
}
