import { NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin';
import {
  getSearchIndexStatus,
  rebuildSearchIndexNow,
} from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  return NextResponse.json(
    { searchIndex: getSearchIndexStatus() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  try {
    const started = Date.now();
    const searchIndex = rebuildSearchIndexNow();
    return NextResponse.json(
      { searchIndex, elapsedMs: Date.now() - started },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[admin] rebuild search index failed', error);
    return NextResponse.json(
      { error: `重建索引失败：${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }
}
