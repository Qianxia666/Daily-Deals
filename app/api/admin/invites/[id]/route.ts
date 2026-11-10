import { NextResponse, type NextRequest } from 'next/server';
import { isAdmin } from '@/lib/admin';
import { deleteInviteCode, listInviteCodes, setInviteCodeDisabled } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function parseId(
  context: { params: Promise<{ id: string }> },
): Promise<number | null> {
  const params = await context.params;
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
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

  const body = (await request.json().catch(() => null)) as
    | { disabled?: unknown }
    | null;
  if (typeof body?.disabled !== 'boolean') {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  if (!setInviteCodeDisabled(id, body.disabled)) {
    return NextResponse.json({ error: '邀请码不存在' }, { status: 404 });
  }
  return NextResponse.json({ codes: listInviteCodes() });
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

  if (!deleteInviteCode(id)) {
    return NextResponse.json(
      { error: '邀请码不存在或已被使用，无法删除' },
      { status: 409 },
    );
  }
  return NextResponse.json({ codes: listInviteCodes() });
}
