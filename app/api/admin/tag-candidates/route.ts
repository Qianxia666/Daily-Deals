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
  tags?: unknown;
  target?: unknown;
}

function payload() {
  return {
    tagCandidates: getTagCandidates(500),
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

  const known = new Set(getTagCandidates(5000).map((item) => item.tag));
  const tags = Array.isArray(body?.tags)
    ? [
        ...new Set(
          body.tags
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ]
    : [];

  // 批量转正：一次最多 200 个，逐个走与单条相同的转正逻辑。
  if (action === 'promote' && tags.length > 0) {
    if (tags.length > 200) {
      return NextResponse.json(
        { error: '一次最多转正 200 个标签' },
        { status: 400 },
      );
    }
    const missing = tags.filter((item) => !known.has(item));
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `候选标签不存在：${missing.slice(0, 5).join('、')}` },
        { status: 404 },
      );
    }
    for (const item of tags) promoteTag(item);
    return NextResponse.json(payload(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  // 批量屏蔽：一次最多 200 个，逐个走与单条相同的屏蔽逻辑。
  if (action === 'block' && tags.length > 0) {
    if (tags.length > 200) {
      return NextResponse.json(
        { error: '一次最多屏蔽 200 个标签' },
        { status: 400 },
      );
    }
    const missing = tags.filter((item) => !known.has(item));
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `候选标签不存在：${missing.slice(0, 5).join('、')}` },
        { status: 404 },
      );
    }
    for (const item of tags) blockTag(item);
    return NextResponse.json(payload(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  if (!tag) {
    return NextResponse.json({ error: '缺少标签' }, { status: 400 });
  }

  if (!known.has(tag)) {
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
