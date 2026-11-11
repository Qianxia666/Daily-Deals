import { fetchText } from '../http';
import { decodeEntities } from '../rss';
import { SOURCE_TIMEOUT_MS } from '../sources';
import { titleFromBody } from './body';
import type { RawDeal } from './types';

interface WeiboEntry {
  id: string;
  link: string;
  summary: string;
  publishedAt: string | null;
}

function parsePublishedAt(value: string): string | null {
  const match = value.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!match) return null;

  const parsed = Date.parse(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+08:00`,
  );
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** 从新浪新闻的博主镜像列表页解析条目，只保留 /news/detail/{id}.html。 */
function parseListing(html: string, origin: string): WeiboEntry[] {
  const anchors = [...html.matchAll(/<a class="post-link" href="([^"]+)"/gi)];
  const entries: WeiboEntry[] = [];
  const seen = new Set<string>();

  anchors.forEach((anchor, index) => {
    const href = anchor[1];
    const matched = href.match(/\/news\/detail\/(\d+)\.html/);
    if (!matched) return;

    const id = matched[1];
    if (seen.has(id)) return;

    const start = anchor.index ?? 0;
    const end =
      index + 1 < anchors.length
        ? (anchors[index + 1].index ?? html.length)
        : html.length;
    const block = html.slice(start, end);

    const textBlock = block.match(
      /<div class="post-text">([\s\S]*?)<\/div>/i,
    )?.[1];
    const summary = textBlock
      ? decodeEntities(textBlock.replace(/<[^>]+>/g, ' '))
          .replace(/\s+/g, ' ')
          .trim()
      : '';

    const time = block.match(/<div class="time">([^<]*)<\/div>/i)?.[1] ?? '';

    seen.add(id);
    entries.push({
      id,
      link: new URL(href, origin).toString(),
      summary,
      publishedAt: parsePublishedAt(time.trim()),
    });
  });

  return entries;
}

/**
 * 新浪新闻的微博博主镜像：这里只抓列表页做发现，正文由后台的补全任务
 * 逐条慢速抓取（见 lib/body-backfill.ts），避免一次请求上百个详情页。
 */
export async function fetchSinaWeibo(
  url: string,
  sourceId: string,
): Promise<RawDeal[]> {
  const origin = new URL(url).origin;
  const html = await fetchText(
    url,
    {
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: `${origin}/`,
      },
    },
    SOURCE_TIMEOUT_MS,
  );

  const entries = parseListing(html, origin);
  if (entries.length === 0) {
    throw new Error('微博镜像未解析到条目（页面结构可能已变化）');
  }

  return entries.map((entry) => ({
    title: titleFromBody(entry.summary) ?? `微博线报 ${entry.id}`,
    link: entry.link,
    description: entry.summary,
    publishedAt: entry.publishedAt,
    expiresAt: null,
    source: sourceId,
    bodyComplete: false,
  }));
}
