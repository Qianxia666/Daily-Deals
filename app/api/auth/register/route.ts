import { NextResponse, type NextRequest } from 'next/server';
import {
  applySessionCookie,
  hashPassword,
  isValidEmail,
  isValidPassword,
  normalizeEmail,
  startSession,
} from '@/lib/auth';
import {
  checkInviteUsable,
  createUserWithInvite,
  getUserAuthByEmail,
  type RegisterError,
  type RegisterInvite,
} from '@/lib/db';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import {
  getRegistrationInviteCode,
  getRegistrationInviteRequired,
  getRegistrationOpen,
  getRuntimeBool,
  getRuntimeEnvNumber,
} from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const INVITE_MESSAGES: Record<RegisterError, string> = {
  EMAIL_EXISTS: '该邮箱已注册，请直接登录',
  INVITE_INVALID: '邀请码不存在',
  INVITE_DISABLED: '该邀请码已停用',
  INVITE_EXPIRED: '该邀请码已过期',
  INVITE_EXHAUSTED: '该邀请码使用次数已用完',
};

export async function POST(request: NextRequest) {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > 16_384) {
    return NextResponse.json({ error: '请求体过大' }, { status: 413 });
  }

  if (!getRegistrationOpen()) {
    return NextResponse.json(
      { error: '管理员已关闭自助注册' },
      { status: 403 },
    );
  }

  if (getRuntimeBool('RATE_LIMIT_ENABLED', true)) {
    if (process.env.TRUST_PROXY !== '1') {
      const global = checkRateLimit('register:global', 30);
      if (!global.ok) {
        return NextResponse.json(
          { error: '操作过于频繁，请稍后再试' },
          {
            status: 429,
            headers: { 'Retry-After': String(global.retryAfter) },
          },
        );
      }
    }
    const result = checkRateLimit(
      `register:${getClientIp(request)}`,
      getRuntimeEnvNumber('ADMIN_LOGIN_RATE_LIMIT_PER_MINUTE', 5, 1, 60),
    );
    if (!result.ok) {
      return NextResponse.json(
        { error: '操作过于频繁，请稍后再试' },
        {
          status: 429,
          headers: { 'Retry-After': String(result.retryAfter) },
        },
      );
    }
  }

  const body = (await request.json().catch(() => null)) as
    | { email?: unknown; password?: unknown; invite?: unknown }
    | null;

  const email =
    typeof body?.email === 'string' ? normalizeEmail(body.email) : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const invite = typeof body?.invite === 'string' ? body.invite.trim() : '';

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: '请输入有效的邮箱地址' }, { status: 400 });
  }
  if (!isValidPassword(password)) {
    return NextResponse.json(
      { error: '密码长度需为 8–72 位' },
      { status: 400 },
    );
  }

  const legacyInvite = getRegistrationInviteCode();
  const inviteRequired =
    getRegistrationInviteRequired() || Boolean(legacyInvite);

  if (inviteRequired && !invite) {
    return NextResponse.json({ error: '请输入邀请码' }, { status: 403 });
  }

  let inviteMode: RegisterInvite | null = null;
  if (invite) {
    // 旧版固定邀请码不消耗次数，也不要求存在于邀请码表中。
    inviteMode =
      legacyInvite && invite === legacyInvite
        ? { code: invite, consume: false }
        : { code: invite, consume: true };
  }

  const existing = getUserAuthByEmail(email);
  if (existing) {
    return NextResponse.json({ error: '该邮箱已注册，请直接登录' }, { status: 409 });
  }

  // 先做只读邀请码校验，避免无效邀请码也消耗 scrypt。
  if (inviteMode?.consume) {
    const inviteError = checkInviteUsable(inviteMode.code);
    if (inviteError) {
      return NextResponse.json(
        { error: INVITE_MESSAGES[inviteError] },
        { status: 403 },
      );
    }
  }

  const { hash, salt } = await hashPassword(password);
  const result = createUserWithInvite(email, hash, salt, inviteMode);

  if ('error' in result) {
    return NextResponse.json(
      { error: INVITE_MESSAGES[result.error] },
      { status: result.error === 'EMAIL_EXISTS' ? 409 : 403 },
    );
  }

  const response = NextResponse.json({ user: result.user });
  applySessionCookie(response, startSession(result.user.id), request);
  return response;
}
