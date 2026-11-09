const SYNONYMS: Record<string, string[]> = {
  白嫖: ['免费', '限免', '免费领取', '0元'],
  免费: ['白嫖', '限免', '免费领取', '0元'],
  vps: ['云服务器', '主机', '服务器'],
  云服务器: ['vps', '主机', '服务器'],
  服务器: ['vps', '云服务器', '主机'],
  主机: ['vps', '云服务器', '服务器'],
  会员: ['年卡', '月卡', 'vip', '会员卡'],
  年卡: ['会员', 'vip', '年费'],
  域名: ['续费', '注册', '转入'],
  续费: ['域名', '年费'],
  键盘: ['机械键盘', '键帽'],
  机械键盘: ['键盘', '键帽'],
  耳机: ['蓝牙耳机', '头戴', '入耳'],
  流量卡: ['电话卡', '上网卡', '手机卡'],
  优惠券: ['券', '红包', '满减'],
  折扣: ['优惠', '特价', '降价'],
  限免: ['免费', '白嫖', '0元'],
};

const STOPWORDS = new Set([
  '的',
  '了',
  '是',
  '吗',
  '呢',
  '啊',
  '求',
  '推荐',
  '有没有',
  '什么',
  '怎么',
  '哪里',
  '哪个',
  '请问',
  '想要',
  '一个',
  '这个',
  '那个',
  'the',
  'a',
  'an',
  'for',
  'and',
  'of',
  'in',
  'to',
  'is',
]);

function chunkText(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? [];
}

function segmentTokens(segment: string): string[] {
  const tokens: string[] = [];
  for (const chunk of chunkText(segment)) {
    if (/^[a-z0-9]+$/.test(chunk)) {
      tokens.push(chunk);
      continue;
    }
    if (chunk.length === 1) {
      tokens.push(chunk);
      continue;
    }
    for (let index = 0; index < chunk.length - 1; index += 1) {
      tokens.push(chunk.slice(index, index + 2));
    }
  }
  return tokens;
}

/** 把文本转换为适合 FTS5 unicode61 的二元词串。 */
export function buildSearchIndexText(
  text: string | null | undefined,
  maxChars = 400,
): string {
  const raw = String(text ?? '').slice(0, Math.max(1, maxChars));
  const tokens = new Set<string>();
  for (const chunk of chunkText(raw)) {
    if (/^[a-z0-9]+$/.test(chunk)) {
      tokens.add(chunk);
      continue;
    }
    if (chunk.length === 1) {
      tokens.add(chunk);
      continue;
    }
    for (let index = 0; index < chunk.length - 1; index += 1) {
      tokens.add(chunk.slice(index, index + 2));
    }
  }
  return [...tokens].join(' ');
}

function splitQuery(query: string): string[] {
  return String(query ?? '')
    .trim()
    .toLowerCase()
    .split(/[\s,，。;；:：!！?？()（）[\]【】"'“”‘’、/\\|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function expandSegment(segment: string, withSynonyms: boolean): string[] {
  const terms = new Set<string>([segment]);
  if (!withSynonyms) return [...terms];

  for (const [key, values] of Object.entries(SYNONYMS)) {
    const matched =
      segment === key ||
      segment.includes(key) ||
      (segment.length >= 2 && key.includes(segment));
    if (!matched) continue;
    terms.add(key);
    for (const value of values) terms.add(value);
  }

  return [...terms];
}

function quoteTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

export interface FtsQueryOptions {
  synonyms?: boolean;
  maxTerms?: number;
}

/** 构造安全的 FTS5 MATCH 查询；返回 null 表示查询词无法用于全文索引。 */
export function buildFtsQuery(
  query: string,
  options: FtsQueryOptions = {},
): string | null {
  const withSynonyms = options.synonyms ?? true;
  const maxTerms = Math.min(Math.max(options.maxTerms ?? 40, 4), 80);
  const segments = splitQuery(query);
  if (segments.length === 0) return null;

  const filtered = segments.filter((segment) => !STOPWORDS.has(segment));
  const effective = filtered.length > 0 ? filtered : segments;

  const groups: string[] = [];
  const seen = new Set<string>();

  for (const segment of effective.slice(0, 8)) {
    const terms: string[] = [];
    for (const expanded of expandSegment(segment, withSynonyms)) {
      for (const token of segmentTokens(expanded)) {
        if (seen.has(token)) continue;
        seen.add(token);
        terms.push(token);
        if (seen.size >= maxTerms) break;
      }
      if (seen.size >= maxTerms) break;
    }

    const unique = terms.filter(
      (term, index) => terms.indexOf(term) === index,
    );
    if (unique.length > 0) {
      groups.push(`(${unique.map(quoteTerm).join(' OR ')})`);
    }
    if (seen.size >= maxTerms) break;
  }

  return groups.length > 0 ? groups.join(' AND ') : null;
}
