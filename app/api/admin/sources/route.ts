import { NextResponse, type NextRequest } from 'next/server';
import { isAdmin } from '@/lib/admin';
import {
  createSource,
  deleteSource,
  getSource,
  restoreSource,
} from '@/lib/db';
import { getAdminPayload } from '@/lib/runtime-settings';
import type { SourceKind } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
const KINDS: SourceKind[] = [
  'rss',
  'epic',
  'linuxdo',
  'xianbao',
  'sina_weibo',
];

interface SourceBody {
  action?: unknown;
  id?: unknown;
  name?: unknown;
  url?: unknown;
  kind?: unknown;
  refreshMinutes?: unknown;
  hidden?: unknown;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeRefresh(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const rounded = Math.round(parsed);
  if (rounded < 5 || rounded > 1440) return undefined;
  return rounded;
}

export async function POST(request: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as SourceBody | null;
  if (!body) {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  const action = typeof body.action === 'string' ? body.action : '';

  if (action === 'delete') {
    const id = typeof body.id === 'string' ? body.id : '';
    const source = getSource(id);
    if (!source) {
      return NextResponse.json({ error: '来源不存在' }, { status: 404 });
    }

    deleteSource(id);
    return NextResponse.json(getAdminPayload());
  }

  if (action === 'restore') {
    const id = typeof body.id === 'string' ? body.id : '';
    if (!restoreSource(id)) {
      return NextResponse.json({ error: '来源不存在' }, { status: 404 });
    }
    return NextResponse.json(getAdminPayload());
  }

  if (action !== 'create') {
    return NextResponse.json({ error: '未知操作' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 30) {
    return NextResponse.json(
      { error: '来源名称需为 1–30 个字符' },
      { status: 400 },
    );
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!isHttpUrl(url)) {
    return NextResponse.json(
      { error: '来源链接必须是 http/https 地址' },
      { status: 400 },
    );
  }

  const kind: SourceKind =
    typeof body.kind === 'string' &&
    KINDS.includes(body.kind as SourceKind)
      ? (body.kind as SourceKind)
      : 'rss';
  const refreshMinutes = normalizeRefresh(body.refreshMinutes);
  if (refreshMinutes === undefined) {
    return NextResponse.json(
      { error: '刷新间隔需为 5–1440 分钟，或留空使用全局间隔' },
      { status: 400 },
    );
  }

  const requestedId =
    typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
  const id = requestedId || `site-${Date.now().toString(36)}`;
  if (!SLUG_PATTERN.test(id)) {
    return NextResponse.json(
      { error: '标识只能包含小写字母、数字和短横线，长度 2–40' },
      { status: 400 },
    );
  }

  const created = createSource({
    id,
    name,
    url,
    kind,
    refreshMinutes,
    state: 'active',
  });

  if (!created) {
    return NextResponse.json(
      { error: '该标识已存在，请换一个' },
      { status: 409 },
    );
  }

  return NextResponse.json(getAdminPayload());
}
