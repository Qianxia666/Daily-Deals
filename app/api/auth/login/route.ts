import { NextResponse, type NextRequest } from 'next/server';
import {
  applySessionCookie,
  isValidEmail,
  normalizeEmail,
  startSession,
  verifyPasswordHash,
} from '@/lib/auth';
import { getUserAuthByEmail, markUserLogin } from '@/lib/db';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import {
  getRegistrationOpen,
  getRuntimeBool,
  getRuntimeEnvNumber,
} from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > 16_384) {
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
      const global = checkRateLimit('login:global', 60);
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
    const result = checkRateLimit(`login:${getClientIp(request)}`, limit);
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
    | { email?: unknown; password?: unknown }
    | null;

  const email =
    typeof body?.email === 'string' ? normalizeEmail(body.email) : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!isValidEmail(email) || !password || password.length > 72) {
    return NextResponse.json({ error: '邮箱或密码错误' }, { status: 401 });
  }

  const record = getUserAuthByEmail(email);
  const valid =
    record &&
    !record.disabled &&
    (await verifyPasswordHash(password, record.passwordHash, record.passwordSalt));

  if (!record || !valid) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return NextResponse.json(
      { error: '邮箱或密码错误' },
      { status: 401 },
    );
  }

  markUserLogin(record.user.id);
  const response = NextResponse.json({
    user: record.user,
    registrationOpen: getRegistrationOpen(),
  });
  applySessionCookie(response, startSession(record.user.id), request);
  return response;
}
