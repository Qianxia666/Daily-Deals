import { XMLParser } from 'fast-xml-parser';
import { truncateText } from './utils';

export interface ParsedFeedItem {
  title: string;
  link: string;
  description: string;
  publishedAt: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function nodeText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => nodeText(item)).find(Boolean) ?? '';
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['#text'] === 'string') return record['#text'];
    if (typeof record.__cdata === 'string') return record.__cdata;
    if (typeof record['@_href'] === 'string') return record['@_href'];
  }
  return '';
}

function extractLink(entry: Record<string, unknown>): string {
  const link = entry.link;

  if (typeof link === 'string') return link.trim();

  if (Array.isArray(link)) {
    const candidates = link as Record<string, unknown>[];
    const alternate =
      candidates.find(
        (item) =>
          item?.['@_rel'] === 'alternate' || item?.['@_rel'] == null,
      ) ?? candidates[0];
    return nodeText(alternate).trim();
  }

  if (link && typeof link === 'object') {
    return nodeText(link).trim();
  }

  return nodeText(entry.guid ?? entry.id).trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => {
      return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    })
    .replace(/&#(\d+);/g, (match, code: string) => {
      const point = Number(code);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (match, code: string) => {
      const point = Number.parseInt(code, 16);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    });
}

export function stripHtml(input: string): string {
  const withoutBlocks = input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const withoutTags = withoutBlocks.replace(/<[^>]+>/g, ' ');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

export function normalizeDate(value: unknown): string | null {
  const text = nodeText(value).trim();
  if (!text) return null;
  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function absoluteUrl(raw: string, baseUrl: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function parseRssFeed(xml: string, feedUrl: string): ParsedFeedItem[] {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const rss = parsed.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  const atom = parsed.feed as Record<string, unknown> | undefined;

  const entries = asArray(
    (channel?.item ?? atom?.entry ?? []) as Record<string, unknown>[],
  );
  const items: ParsedFeedItem[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    const title = stripHtml(nodeText(entry.title));
    const link = absoluteUrl(extractLink(entry), feedUrl);
    if (!title || !link) continue;

    const rawDescription = nodeText(
      entry.description ??
        entry['content:encoded'] ??
        entry.summary ??
        entry.content,
    );
    const description = truncateText(stripHtml(rawDescription), 220);

    const publishedAt = normalizeDate(
      entry.pubDate ??
        entry['dc:date'] ??
        entry.published ??
        entry.updated ??
        entry.date,
    );

    items.push({ title, link, description, publishedAt });
  }

  return items;
}
