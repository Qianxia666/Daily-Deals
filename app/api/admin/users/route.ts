import { NextResponse, type NextRequest } from 'next/server';
import { isAdmin } from '@/lib/admin';
import { searchAdminUsers, setUserDisabled } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = (searchParams.get('query') ?? '').trim().slice(0, 120);
  const rawStatus = searchParams.get('status') ?? 'all';
  const status =
    rawStatus === 'active' || rawStatus === 'disabled' ? rawStatus : 'all';
  const page = Math.min(
    10_000,
    Math.max(1, Math.floor(Number(searchParams.get('page')) || 1)),
  );
  const pageSize = Math.min(
    50,
    Math.max(5, Math.floor(Number(searchParams.get('pageSize')) || 20)),
  );

  const result = searchAdminUsers({
    query,
    status,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return NextResponse.json(
    { ...result, page, pageSize },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { id?: unknown; disabled?: unknown }
    | null;
  const id = Number(body?.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  if (!setUserDisabled(id, body?.disabled === true)) {
    return NextResponse.json({ error: '用户不存在' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
