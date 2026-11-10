import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getAiQuota } from '@/lib/db';
import {
  getAiSearchDailyLimit,
  getRegistrationOpen,
} from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const user = await getCurrentUser();
  const limit = getAiSearchDailyLimit();

  return NextResponse.json(
    {
      user,
      registrationOpen: getRegistrationOpen(),
      aiQuota: user ? getAiQuota(user.id, limit) : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
