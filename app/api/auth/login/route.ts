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
  if (getRuntimeBool('RATE_LIMIT_ENABLED', true)) {
    const result = checkRateLimit(
      `login:${getClientIp(request)}`,
      getRuntimeEnvNumber('ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE', 5, 1, 60),
    );
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

  if (!isValidEmail(email) || !password) {
    return NextResponse.json({ error: '请输入邮箱和密码' }, { status: 400 });
  }

  const record = getUserAuthByEmail(email);
  const valid =
    record &&
    !record.disabled &&
    (await verifyPasswordHash(password, record.passwordHash, record.passwordSalt));

  if (!record || !valid) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return NextResponse.json(
      { error: record?.disabled ? '该账号已被管理员禁用' : '邮箱或密码错误' },
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
