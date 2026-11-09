import { NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin';
import {
  blockTag,
  getTagCandidates,
  getTagStatus,
  mergeTag,
  promoteTag,
} from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface CandidateActionBody {
  action?: unknown;
  tag?: unknown;
  target?: unknown;
}

function payload() {
  return {
    tagCandidates: getTagCandidates(100),
    tags: getTagStatus(),
  };
}

export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  return NextResponse.json(payload(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: Request) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | CandidateActionBody
    | null;
  const action = typeof body?.action === 'string' ? body.action : '';
  const tag = typeof body?.tag === 'string' ? body.tag.trim() : '';
  const target =
    typeof body?.target === 'string' ? body.target.trim() : '';

  if (!tag) {
    return NextResponse.json({ error: '缺少标签' }, { status: 400 });
  }

  if (!getTagCandidates(5000).some((item) => item.tag === tag)) {
    return NextResponse.json({ error: '候选标签不存在' }, { status: 404 });
  }

  if (action === 'promote') {
    promoteTag(tag);
  } else if (action === 'block') {
    blockTag(tag);
  } else if (action === 'merge') {
    if (!target) {
      return NextResponse.json({ error: '请选择要合并到的标签' }, { status: 400 });
    }
    mergeTag(tag, target);
  } else {
    return NextResponse.json({ error: '不支持的操作' }, { status: 400 });
  }

  return NextResponse.json(payload(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
