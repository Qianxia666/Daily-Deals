import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { getDealsList, getDealsMeta } from '@/lib/db';
import {
  getAiSearchDays,
  getKeywordSearchDays,
  getRuntimeBool,
  getSiteSettings,
} from '@/lib/runtime-settings';
import { isFetching } from '@/lib/scheduler';
import type { Category } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CATEGORIES = new Set<Category>([
  'free',
  'limited',
  'discount',
  'membership',
  'game',
  'other',
]);

function parseList(value: string | null, max: number): string[] | null {
  if (!value) return null;
  const list = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
  return list.length > 0 ? list : null;
}

function parseIds(value: string | null): number[] | null {
  if (!value) return null;

  const ids: number[] = [];
  const seen = new Set<number>();
  for (const raw of value.split(',')) {
    const id = Number(raw.trim());
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 500) break;
  }

  return ids;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const metaOnly = params.get('metaOnly') === '1';
  const categoryValue = params.get('category');
  const category =
    categoryValue && CATEGORIES.has(categoryValue as Category)
      ? (categoryValue as Category)
      : null;

  const meta = getDealsMeta();
  const list = metaOnly
    ? { items: [], total: 0, hasMore: false, nextCursor: null }
    : getDealsList({
        limit: Number(params.get('limit')) || 40,
        cursor: params.get('cursor'),
        sources: parseList(params.get('sources'), 50),
        category,
        onlyNew: params.get('onlyNew') === '1',
        ids: parseIds(params.get('ids')),
      });

  const body = JSON.stringify({
    ...meta,
    fetching: isFetching(),
    site: getSiteSettings(),
    searchWindows: {
      ai: getAiSearchDays(),
      keyword: getKeywordSearchDays(),
    },
    ...list,
  });

  const etag = `W/"${createHash('sha1').update(body).digest('base64url')}"`;

  if (
    getRuntimeBool('API_ETAG_ENABLED', true) &&
    request.headers.get('if-none-match') === etag
  ) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': 'no-store' },
    });
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ETag: etag,
    },
  });
}
