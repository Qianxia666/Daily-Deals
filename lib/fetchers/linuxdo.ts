import { categorizeTitle } from '../categorize';
import { describeFetchError, fetchText } from '../http';
import { normalizeDate, parseRssFeed } from '../rss';
import { getRuntimeEnv } from '../runtime-settings';
import type { RawDeal } from './types';

const DEFAULT_MIRROR_URL =
  'https://linuxdorss.longpink.com/welfare.xml';
const DIRECT_RSS_URL = 'https://linux.do/c/welfare/36.rss';
const JINA_RSS_URL = `https://r.jina.ai/${DIRECT_RSS_URL}`;

/** 单条通道的超时；三条通道全部失败时最多约 45 秒。 */
const ATTEMPT_TIMEOUT_MS = 15_000;

const RFC822_PATTERN =
  /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?\s+(?:[+-]\d{4}|GMT|UTC)/;

interface FeedEntry {
  title: string;
  link: string;
  description: string;
  publishedAt: string | null;
}

interface JinaEntry {
  title: string;
  link: string;
  publishedAt: string | null;
}

function parseJinaMarkdown(markdown: string): JinaEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: JinaEntry[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    const match = line.match(/^###\s*\[(.+?)\]\((https?:\/\/[^\s)]+)\)/);
    if (!match) continue;

    const title = match[1].trim();
    const link = match[2].trim();
    if (!title || !link || seen.has(link)) continue;

    let publishedAt: string | null = null;
    // RFC 822 日期通常出现在标题行的下一行，也兼容第三行。
    for (
      let offset = 1;
      offset <= 3 && index + offset < lines.length;
      offset += 1
    ) {
      const dateMatch = lines[index + offset]?.match(RFC822_PATTERN);
      if (dateMatch) {
        publishedAt = normalizeDate(dateMatch[0]);
        break;
      }
    }

    seen.add(link);
    entries.push({ title, link, publishedAt });
  }

  return entries;
}

/** 只接受 linux.do 的链接，避免镜像被篡改后引入站外地址。 */
function isLinuxDoLink(link: string): boolean {
  try {
    const host = new URL(link).hostname.toLowerCase();
    return host === 'linux.do' || host.endsWith('.linux.do');
  } catch {
    return false;
  }
}

function toDeals(entries: FeedEntry[], sourceId: string): RawDeal[] {
  const seen = new Set<string>();
  const deals: RawDeal[] = [];

  for (const entry of entries) {
    if (!isLinuxDoLink(entry.link) || seen.has(entry.link)) continue;
    seen.add(entry.link);

    deals.push({
      title: entry.title,
      link: entry.link,
      description: entry.description,
      publishedAt: entry.publishedAt,
      expiresAt: null,
      category: categorizeTitle(entry.title),
      source: sourceId,
    });
  }

  return deals;
}

async function fetchRss(url: string, sourceId: string): Promise<RawDeal[]> {
  const xml = await fetchText(url, {}, ATTEMPT_TIMEOUT_MS);
  return toDeals(parseRssFeed(xml, url), sourceId);
}

async function fetchJina(
  apiKey: string,
  sourceId: string,
): Promise<RawDeal[]> {
  const markdown = await fetchText(
    JINA_RSS_URL,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/plain',
      },
    },
    ATTEMPT_TIMEOUT_MS,
  );

  return toDeals(
    parseJinaMarkdown(markdown).map((entry) => ({
      title: entry.title,
      link: entry.link,
      description: '',
      publishedAt: entry.publishedAt,
    })),
    sourceId,
  );
}

/**
 * 按「镜像 RSS → 直连 RSS → Jina」顺序尝试，任一通道拿到数据即返回。
 * Jina 仅在配置了 JINA_API_KEY 时参与兜底，不再是必需项。
 */
export async function fetchLinuxDo(
  mirrorUrl: string = DEFAULT_MIRROR_URL,
  sourceId = 'linuxdo',
): Promise<RawDeal[]> {
  const attempts: { label: string; run: () => Promise<RawDeal[]> }[] = [
    { label: '镜像', run: () => fetchRss(mirrorUrl, sourceId) },
  ];

  if (mirrorUrl !== DIRECT_RSS_URL) {
    attempts.push({
      label: '直连',
      run: () => fetchRss(DIRECT_RSS_URL, sourceId),
    });
  }

  const apiKey = getRuntimeEnv('JINA_API_KEY').trim();
  if (apiKey) {
    attempts.push({
      label: 'Jina',
      run: () => fetchJina(apiKey, sourceId),
    });
  }

  const failures: string[] = [];

  for (const attempt of attempts) {
    try {
      const deals = await attempt.run();
      if (deals.length > 0) {
        if (failures.length > 0) {
          console.warn(
            `[linuxdo] ${attempt.label} 通道成功，此前失败：${failures.join('；')}`,
          );
        }
        return deals;
      }
      failures.push(`${attempt.label}: 未解析到条目`);
    } catch (error) {
      failures.push(
        `${attempt.label}: ${describeFetchError(error, ATTEMPT_TIMEOUT_MS)}`,
      );
    }
  }

  throw new Error(`linux.do 抓取失败（${failures.join('；')}）`);
}
