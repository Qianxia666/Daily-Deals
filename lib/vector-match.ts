import {
  getDealVector,
  insertVectorDeliveries,
  listDealsNeedingVector,
  listEnabledSubscriptions,
  listKeywordVectors,
  listKeywordsNeedingVector,
  logVectorMatches,
  saveDealVector,
  upsertKeywordVector,
  type KeywordVectorRecord,
} from './db';
import {
  bufferToVector,
  embedTexts,
  getEmbeddingConfig,
  KEYWORD_INSTRUCTION,
  vectorToBuffer,
  type EmbeddingConfig,
} from './embeddings';

/** 只给最近入库的文章算向量，避免历史库无限膨胀。 */
const DEAL_VECTOR_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const KEYWORD_BATCH = 32;
const DEAL_BATCH = 8;
const CACHE_TTL_MS = 60_000;

interface KeywordVectorCache {
  model: string;
  loadedAt: number;
  entries: { keyword: string; vector: Float32Array }[];
}

const runtime = globalThis as typeof globalThis & {
  __dealVectorCache?: KeywordVectorCache;
};

function loadKeywordCache(model: string): KeywordVectorCache {
  const cached = runtime.__dealVectorCache;
  if (
    cached &&
    cached.model === model &&
    Date.now() - cached.loadedAt < CACHE_TTL_MS
  ) {
    return cached;
  }

  const rows: KeywordVectorRecord[] = listKeywordVectors(model);
  const next: KeywordVectorCache = {
    model,
    loadedAt: Date.now(),
    entries: rows.map((row) => ({
      keyword: row.keyword,
      vector: bufferToVector(row.vector),
    })),
  };
  runtime.__dealVectorCache = next;
  return next;
}

function dot(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    sum += left[i] * right[i];
  }
  return sum;
}

/**
 * 只取「AI 标题 + 原始标题 + 标签」做向量。
 * 摘要和描述里大量套话/规则噪声会拉长文本、稀释相似度，
 * 导致长文档的分数系统性低于短文本校准值，这里刻意不拼。
 */
function describeDealText(deal: {
  title: string;
  ai_title: string | null;
  tags: string;
}): string {
  const tags = deal.tags
    .replace(/[[\]"]/g, ' ')
    .replace(/,/g, ' ')
    .trim();
  const text = [deal.ai_title ?? '', deal.title, tags]
    .filter(Boolean)
    .join('\n')
    .slice(0, 200);
  return text || deal.title;
}

/**
 * 对单条优惠做向量匹配。
 * 灰度模式下只写日志不投递；同一用户同一条优惠只保留分数最高的关键词。
 */
export async function matchDealByVector(
  dealId: number,
  config: EmbeddingConfig = getEmbeddingConfig(),
): Promise<number> {
  if (!config.enabled) return 0;

  const stored = getDealVector(dealId);
  if (!stored || stored.model !== config.model) return 0;

  const cache = loadKeywordCache(config.model);
  if (cache.entries.length === 0) return 0;

  const subscriptions = listEnabledSubscriptions();
  if (subscriptions.length === 0) return 0;

  const byKeyword = new Map<
    string,
    { id: number; user_id: number }[]
  >();
  for (const sub of subscriptions) {
    const keyword = sub.keyword.trim().toLowerCase();
    if (keyword.length < 2) continue;
    if (config.stopwords.includes(keyword)) continue;
    const list = byKeyword.get(keyword) ?? [];
    list.push({ id: sub.id, user_id: sub.user_id });
    byKeyword.set(keyword, list);
  }
  if (byKeyword.size === 0) return 0;

  const dealVector = bufferToVector(stored.vector);
  const bestPerUser = new Map<
    number,
    { score: number; keyword: string; subscriptionId: number; userId: number }
  >();

  for (const entry of cache.entries) {
    const subs = byKeyword.get(entry.keyword);
    if (!subs) continue;

    const score = dot(dealVector, entry.vector);
    if (score < config.threshold) continue;

    for (const sub of subs) {
      const current = bestPerUser.get(sub.user_id);
      if (!current || score > current.score) {
        bestPerUser.set(sub.user_id, {
          score,
          keyword: entry.keyword,
          subscriptionId: sub.id,
          userId: sub.user_id,
        });
      }
    }
  }

  const ranked = [...bestPerUser.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, config.maxPerDeal);
  if (ranked.length === 0) return 0;

  if (config.dryRun) {
    logVectorMatches(
      ranked.map((item) => ({
        dealId,
        keyword: item.keyword,
        userId: item.userId,
        score: item.score,
        pushed: false,
      })),
    );
    return 0;
  }

  const created = insertVectorDeliveries(
    dealId,
    ranked.map((item) => ({
      subscriptionId: item.subscriptionId,
      userId: item.userId,
    })),
  );

  logVectorMatches(
    ranked.map((item) => ({
      dealId,
      keyword: item.keyword,
      userId: item.userId,
      score: item.score,
      pushed: created > 0,
    })),
  );

  return created;
}

/** 补齐缺失或模型过期的关键词向量。 */
export async function syncKeywordVectors(
  config: EmbeddingConfig = getEmbeddingConfig(),
): Promise<number> {
  if (!config.enabled) return 0;

  const keywords = listKeywordsNeedingVector(config.model, KEYWORD_BATCH);
  if (keywords.length === 0) return 0;

  const vectors = await embedTexts(
    keywords.map((keyword) => `${KEYWORD_INSTRUCTION}${keyword}`),
    config,
  );
  if (!vectors) return 0;

  let saved = 0;
  keywords.forEach((keyword, index) => {
    const vector = vectors[index];
    if (!vector) return;
    upsertKeywordVector(
      keyword,
      vectorToBuffer(vector),
      vector.length,
      config.model,
    );
    saved += 1;
  });

  if (saved > 0) {
    console.log(`[vector] 关键词向量补齐 ${saved}/${keywords.length}`);
    runtime.__dealVectorCache = undefined;
  }
  return saved;
}

/** 补齐文章向量，并在算完后立即做一次向量匹配。 */
export async function embedPendingDeals(
  config: EmbeddingConfig = getEmbeddingConfig(),
): Promise<number> {
  if (!config.enabled) return 0;

  const since = new Date(Date.now() - DEAL_VECTOR_WINDOW_MS).toISOString();
  const deals = listDealsNeedingVector(config.model, since, DEAL_BATCH);
  if (deals.length === 0) return 0;

  const vectors = await embedTexts(
    deals.map((deal) => describeDealText(deal)),
    config,
  );
  if (!vectors) return 0;

  let saved = 0;
  for (let index = 0; index < deals.length; index += 1) {
    const deal = deals[index];
    const vector = vectors[index];
    if (!vector) continue;

    saveDealVector(deal.id, vectorToBuffer(vector), config.model);
    saved += 1;
    await matchDealByVector(deal.id, config);
  }

  if (saved > 0) {
    console.log(`[vector] 文章向量补齐 ${saved}/${deals.length}`);
  }
  return saved;
}
