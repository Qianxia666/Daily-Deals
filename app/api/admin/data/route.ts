import { NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin';
import { getAdminPayload } from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  return NextResponse.json(getAdminPayload(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
