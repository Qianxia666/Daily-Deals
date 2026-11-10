import { NextResponse, type NextRequest } from 'next/server';
import { isAdmin } from '@/lib/admin';
import { listChannels, updateChannel } from '@/lib/db';

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

  const userId = await parseId(context);
  if (!userId) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const body = (await request.json().catch(() => null)) as
    | { channelId?: unknown; enabled?: unknown }
    | null;
  const channelId = Number(body?.channelId);
  if (!Number.isInteger(channelId) || typeof body?.enabled !== 'boolean') {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  if (!updateChannel(userId, channelId, { enabled: body.enabled })) {
    return NextResponse.json({ error: '渠道不存在' }, { status: 404 });
  }

  return NextResponse.json({ channels: listChannels(userId) });
}
