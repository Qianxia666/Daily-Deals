import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { getDealsSnapshot } from '@/lib/db';
import {
  getAiSearchDays,
  getKeywordSearchDays,
  getRuntimeBool,
  getSiteSettings,
} from '@/lib/runtime-settings';
import { isFetching } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const snapshot = getDealsSnapshot();
  const body = JSON.stringify({
    ...snapshot,
    fetching: isFetching(),
    site: getSiteSettings(),
    searchWindows: {
      ai: getAiSearchDays(),
      keyword: getKeywordSearchDays(),
    },
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
