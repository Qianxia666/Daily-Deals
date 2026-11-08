import { categorizeTitle } from '../categorize';
import { fetchText } from '../http';
import { parseRssFeed } from '../rss';
import type { RawDeal } from './types';

export interface RssSourceConfig {
  id: string;
  url: string;
}

export async function fetchRssSource(
  config: RssSourceConfig,
): Promise<RawDeal[]> {
  const xml = await fetchText(config.url);
  const feedItems = parseRssFeed(xml, config.url);

  const seen = new Set<string>();
  const deals: RawDeal[] = [];

  for (const item of feedItems) {
    if (seen.has(item.link)) continue;
    seen.add(item.link);

    deals.push({
      title: item.title,
      link: item.link,
      description: item.description,
      publishedAt: item.publishedAt,
      expiresAt: null,
      category: categorizeTitle(item.title),
      source: config.id,
    });
  }

  if (deals.length === 0) {
    throw new Error('RSS 未解析到条目（可能为空或页面结构已变化）');
  }

  return deals;
}
