import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import {
  addSubscription,
  countSubscriptions,
  deleteSubscription,
  setSubscriptionEnabled,
} from '@/lib/db';
import { getAccountLimits } from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { keyword?: unknown }
    | null;
  const keyword =
    typeof body?.keyword === 'string'
      ? body.keyword.trim().slice(0, 20)
      : '';

  if (keyword.length < 2) {
    return NextResponse.json(
      { error: '关键词至少 2 个字符' },
      { status: 400 },
    );
  }

  const limits = getAccountLimits();
  if (countSubscriptions(user.id) >= limits.subscriptions) {
    return NextResponse.json(
      { error: `最多只能添加 ${limits.subscriptions} 个关键词` },
      { status: 400 },
    );
  }

  const subscription = addSubscription(user.id, keyword);
  if (!subscription) {
    return NextResponse.json({ error: '该关键词已经订阅过了' }, { status: 409 });
  }

  return NextResponse.json({ subscription });
}

export async function PATCH(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { id?: unknown; enabled?: unknown }
    | null;
  const id = Number(body?.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const ok = setSubscriptionEnabled(user.id, id, body?.enabled === true);
  if (!ok) return NextResponse.json({ error: '订阅不存在' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { id?: unknown }
    | null;
  const id = Number(body?.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  if (!deleteSubscription(user.id, id)) {
    return NextResponse.json({ error: '订阅不存在' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
