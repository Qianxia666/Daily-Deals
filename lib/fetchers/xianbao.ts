import { fetchText } from '../http';
import { decodeEntities, stripHtml } from '../rss';
import { SOURCE_TIMEOUT_MS } from '../sources';
import type { RawDeal } from './types';

const DEFAULT_URL = 'https://new.xianbao.fun/category-weibo/';
const ORIGIN = 'https://new.xianbao.fun';

interface XianbaoEntry {
  title: string;
  link: string;
  publishedAt: string | null;
}

function attribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return match?.[1] ?? '';
}

function parsePublishedAt(date: string, time: string): string | null {
  if (!date) return null;

  const clock = time.match(/(\d{2}):(\d{2})/);
  const stamp = clock
    ? `${date}T${clock[1]}:${clock[2]}:00+08:00`
    : `${date}T00:00:00+08:00`;

  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function parseListing(html: string, linkPrefix: string): XianbaoEntry[] {
  const entries: XianbaoEntry[] = [];
  const seen = new Set<string>();
  const blocks = html.match(
    /<li[^>]*class="[^"]*article-list[^"]*"[^>]*>[\s\S]*?<\/li>/gi,
  );

  for (const block of blocks ?? []) {
    const anchor = block.match(/<a\b[^>]*>[\s\S]*?<\/a>/i);
    if (!anchor) continue;

    const href = attribute(anchor[0], 'href');
    // 只保留当前分类的文章，跳过后台公告与其他排行入口。
    if (!href.startsWith(linkPrefix) || !href.endsWith('.html')) continue;

    const link = new URL(href, ORIGIN).toString();
    if (seen.has(link)) continue;

    const title = decodeEntities(
      attribute(anchor[0], 'title') || stripHtml(anchor[1]),
    ).trim();
    if (!title) continue;

    const timeTag = block.match(/<time\b[^>]*>/i)?.[0] ?? '';
    const publishedAt = parsePublishedAt(
      attribute(timeTag, 'datetime'),
      attribute(timeTag, 'title'),
    );

    seen.add(link);
    entries.push({ title, link, publishedAt });
  }

  return entries;
}

/** 从列表页地址推断文章路径前缀，例如 category-kuan → /kuan/。 */
function linkPrefixFor(url: string): string {
  const path = new URL(url, ORIGIN).pathname;
  const category = path.match(/^\/category-([^/]+)\/?$/)?.[1];
  if (category) return `/${category}/`;

  const hot = path.match(/^\/([^/]+)-hot\.html$/)?.[1];
  return hot ? `/${hot}/` : '/weibo/';
}

/**
 * 线报酷使用简单的 Cookie 校验：设置 xb_hpass=1 即可读取列表页。
 * 列表页包含最近约 100 条文章，标题、链接与发布时间都是真实页面内容。
 */
export async function fetchXianbao(
  url: string = DEFAULT_URL,
  sourceId = 'xianbao',
): Promise<RawDeal[]> {
  const html = await fetchText(
    url,
    {
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: `${ORIGIN}/`,
        Cookie: 'xb_hpass=1',
      },
    },
    SOURCE_TIMEOUT_MS,
  );

  if (html.includes('访问确认') && html.includes('xb_hpass')) {
    throw new Error('线报酷 Cookie 校验未通过');
  }

  const entries = parseListing(html, linkPrefixFor(url));
  if (entries.length === 0) {
    throw new Error('线报酷未解析到条目（页面结构可能已变化）');
  }

  return entries.map((entry) => ({
    title: entry.title,
    link: entry.link,
    description: '',
    publishedAt: entry.publishedAt,
    expiresAt: null,
    source: sourceId,
  }));
}
