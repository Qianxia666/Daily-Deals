import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import {
  getAiQuota,
  listChannels,
  listSubscriptions,
  listUserDeliveries,
} from '@/lib/db';
import {
  getAccountLimits,
  getAiSearchDailyLimit,
} from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  return NextResponse.json(
    {
      user,
      aiQuota: getAiQuota(user.id, getAiSearchDailyLimit()),
      limits: getAccountLimits(),
      subscriptions: listSubscriptions(user.id),
      channels: listChannels(user.id),
      deliveries: listUserDeliveries(user.id),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
