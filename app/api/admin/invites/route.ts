import { NextResponse, type NextRequest } from 'next/server';
import { isAdmin } from '@/lib/admin';
import { createInviteCodes, listInviteCodes } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(parsed);
}

export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }
  return NextResponse.json(
    { codes: listInviteCodes() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | {
        count?: unknown;
        maxUses?: unknown;
        validityDays?: unknown;
        code?: unknown;
      }
    | null;

  const customCode =
    typeof body?.code === 'string' ? body.code.trim() : '';
  if (customCode && !/^[A-Za-z0-9_-]{4,32}$/.test(customCode)) {
    return NextResponse.json(
      { error: '自定义邀请码需为 4–32 位字母、数字、下划线或短横线' },
      { status: 400 },
    );
  }

  const count = customCode
    ? 1
    : Math.min(20, Math.max(1, parsePositiveInt(body?.count, 1)));
  const maxUses = Math.min(
    1000,
    Math.max(0, parsePositiveInt(body?.maxUses, 1)),
  );
  const validityDays = Math.min(
    3650,
    Math.max(0, parsePositiveInt(body?.validityDays, 30)),
  );
  const expiresAt =
    validityDays > 0
      ? new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

  const created = createInviteCodes({
    count,
    maxUses,
    expiresAt,
    code: customCode || undefined,
  });

  if (created.length === 0) {
    return NextResponse.json({ error: '邀请码已存在' }, { status: 409 });
  }

  return NextResponse.json({ codes: created });
}
