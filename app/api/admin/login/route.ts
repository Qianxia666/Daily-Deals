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

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > 8_192) {
    return NextResponse.json({ error: '请求体过大' }, { status: 413 });
  }

  if (getRuntimeBool('RATE_LIMIT_ENABLED', true)) {
    const limit = getRuntimeEnvNumber(
      'ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE',
      5,
      1,
      60,
    );
    if (process.env.TRUST_PROXY !== '1') {
      const global = checkRateLimit('admin-login:global', 30);
      if (!global.ok) {
        return NextResponse.json(
          { error: '尝试过于频繁，请稍后再试' },
          {
            status: 429,
            headers: { 'Retry-After': String(global.retryAfter) },
          },
        );
      }
    }
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

  if (!password || password.length > 512 || !verifyPassword(password)) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return NextResponse.json({ error: '密码错误' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  const forwardedProto = request.headers.get('x-forwarded-proto') ?? '';
  response.cookies.set(ADMIN_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
    secure:
      forwardedProto.split(',')[0]?.trim() === 'https' ||
      request.nextUrl.protocol === 'https:',
  });
  return response;
}
