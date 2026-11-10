import { NextResponse, type NextRequest } from 'next/server';
import { isAdmin } from '@/lib/admin';
import {
  deleteUserAccount,
  deleteUserSessions,
  getAdminUserDetail,
  getUserById,
  setUserDisabled,
  updateUserEmail,
  updateUserPassword,
} from '@/lib/db';
import {
  hashPassword,
  isValidEmail,
  isValidPassword,
  normalizeEmail,
} from '@/lib/auth';
import { getAiSearchDailyLimit } from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function parseId(
  context: { params: Promise<{ id: string }> },
): Promise<number | null> {
  const params = await context.params;
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const id = await parseId(context);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const detail = getAdminUserDetail(id, getAiSearchDailyLimit());
  if (!detail) {
    return NextResponse.json({ error: '用户不存在' }, { status: 404 });
  }
  return NextResponse.json(detail, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const id = await parseId(context);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });
  if (!getUserById(id)) {
    return NextResponse.json({ error: '用户不存在' }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as
    | { email?: unknown; password?: unknown; disabled?: unknown }
    | null;
  if (!body) {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  if (typeof body.email === 'string') {
    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) {
      return NextResponse.json({ error: '请输入有效的邮箱地址' }, { status: 400 });
    }
    if (!updateUserEmail(id, email)) {
      return NextResponse.json(
        { error: '邮箱已被其他账号使用' },
        { status: 409 },
      );
    }
  }

  if (typeof body.password === 'string' && body.password) {
    if (!isValidPassword(body.password)) {
      return NextResponse.json(
        { error: '密码长度需为 6–72 位' },
        { status: 400 },
      );
    }
    const { hash, salt } = await hashPassword(body.password);
    updateUserPassword(id, hash, salt);
    deleteUserSessions(id);
  }

  if (typeof body.disabled === 'boolean') {
    setUserDisabled(id, body.disabled);
    if (body.disabled) deleteUserSessions(id);
  }

  const detail = getAdminUserDetail(id, getAiSearchDailyLimit());
  return NextResponse.json(detail);
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const id = await parseId(context);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  if (!deleteUserAccount(id)) {
    return NextResponse.json({ error: '用户不存在' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
