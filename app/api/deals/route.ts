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

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

/** 品类偏好标签：去重、限制长度与数量，异常值直接丢弃。 */
function parseTags(raw: string | null): string[] | null {
  if (!raw) return null;

  const tags: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const tag = part.trim();
    if (tag.length < 2 || tag.length > 12 || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 8) break;
  }

  return tags.length > 0 ? tags : null;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const metaOnly = params.get('metaOnly') === '1';

  const meta = getDealsMeta();
  const list = metaOnly
    ? { items: [], total: 0, hasMore: false, nextCursor: null }
    : getDealsList({
        limit: Number(params.get('limit')) || 40,
        cursor: params.get('cursor'),
        sources: parseList(params.get('sources'), 50),
        onlyNew: params.get('onlyNew') === '1',
        ids: parseIds(params.get('ids')),
        preferTags: parseTags(params.get('preferTags')),
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
