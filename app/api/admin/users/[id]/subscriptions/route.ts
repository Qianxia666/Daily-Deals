import { NextResponse, type NextRequest } from 'next/server';
import { isAdmin } from '@/lib/admin';
import {
  addSubscription,
  countSubscriptions,
  deleteSubscription,
  getUserById,
  listSubscriptions,
  setSubscriptionEnabled,
  updateSubscriptionKeyword,
} from '@/lib/db';
import { getAccountLimits } from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function parseId(
  context: { params: Promise<{ id: string }> },
): Promise<number | null> {
  const params = await context.params;
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const userId = await parseId(context);
  if (!userId) return NextResponse.json({ error: '参数错误' }, { status: 400 });
  if (!getUserById(userId)) {
    return NextResponse.json({ error: '用户不存在' }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as
    | { keyword?: unknown }
    | null;
  const keyword =
    typeof body?.keyword === 'string' ? body.keyword.trim().slice(0, 20) : '';
  if (keyword.length < 2) {
    return NextResponse.json({ error: '关键词至少 2 个字符' }, { status: 400 });
  }

  const limits = getAccountLimits();
  if (countSubscriptions(userId) >= limits.subscriptions) {
    return NextResponse.json(
      { error: `该用户最多只能添加 ${limits.subscriptions} 个关键词` },
      { status: 400 },
    );
  }

  const subscription = addSubscription(userId, keyword);
  if (!subscription) {
    return NextResponse.json({ error: '该关键词已经订阅过了' }, { status: 409 });
  }

  return NextResponse.json({
    subscription,
    subscriptions: listSubscriptions(userId),
  });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const userId = await parseId(context);
  if (!userId) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const body = (await request.json().catch(() => null)) as
    | { subscriptionId?: unknown; keyword?: unknown; enabled?: unknown }
    | null;
  const subscriptionId = Number(body?.subscriptionId);
  if (!Number.isInteger(subscriptionId)) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  if (typeof body?.keyword === 'string') {
    const keyword = body.keyword.trim().slice(0, 20);
    if (keyword.length < 2) {
      return NextResponse.json(
        { error: '关键词至少 2 个字符' },
        { status: 400 },
      );
    }
    if (!updateSubscriptionKeyword(userId, subscriptionId, keyword)) {
      return NextResponse.json(
        { error: '修改失败，关键词可能已存在' },
        { status: 409 },
      );
    }
  }

  if (typeof body?.enabled === 'boolean') {
    if (!setSubscriptionEnabled(userId, subscriptionId, body.enabled)) {
      return NextResponse.json({ error: '订阅不存在' }, { status: 404 });
    }
  }

  return NextResponse.json({ subscriptions: listSubscriptions(userId) });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const userId = await parseId(context);
  if (!userId) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const body = (await request.json().catch(() => null)) as
    | { subscriptionId?: unknown }
    | null;
  const subscriptionId = Number(body?.subscriptionId);
  if (!Number.isInteger(subscriptionId)) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  if (!deleteSubscription(userId, subscriptionId)) {
    return NextResponse.json({ error: '订阅不存在' }, { status: 404 });
  }
  return NextResponse.json({ subscriptions: listSubscriptions(userId) });
}
