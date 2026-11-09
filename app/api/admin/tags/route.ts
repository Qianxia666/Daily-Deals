import { NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin';
import { getTagStatus } from '@/lib/db';
import { startTagBackfill } from '@/lib/llm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  return NextResponse.json(
    { tags: getTagStatus() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    force?: unknown;
  } | null;

  startTagBackfill(body?.force === true);
  const tags = getTagStatus();
  return NextResponse.json(
    { tags, error: tags.lastError ?? undefined },
    {
      status: tags.lastError ? 400 : 200,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
