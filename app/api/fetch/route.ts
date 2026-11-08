import { NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin';
import { triggerFetch } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const started = triggerFetch();

  return NextResponse.json(
    { started, fetching: true },
    { status: 202, headers: { 'Cache-Control': 'no-store' } },
  );
}
