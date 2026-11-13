import {
  incrementAiAttempts,
  listDealsForAi,
  listDealsMissingTags,
  saveAiEnrichment,
  saveDealTags,
  type AiPendingDeal,
  type AiTagPendingDeal,
} from './db';
import { request } from './http';
import { matchSubscriptionsForDeal } from './delivery';
import {
  getAiKeywordExpandTimeoutMs,
  getAiSearchRerankTimeoutMs,
  getAiSummaryTimeoutMs,
  getAiTagTimeoutMs,
  getAiTagsBrandExtractEnabled,
  getAiTagsEnabled,
  getAiTagsMax,
  getAiTagsProposeEnabled,
  getAiTagsProposeMax,
  getAiTagVocabulary,
  getRuntimeEnv,
  getRuntimeEnvNumber,
} from './runtime-settings';
import {
  getTagRunProgress,
  resetTagRunProgress,
  updateTagRunProgress,
  type TagRunProgress,
} from './tag-progress';

interface TagOptions {
  vocabulary: string[];
  tagsMax: number;
  proposeEnabled: boolean;
  proposeMax: number;
  brandExtractEnabled: boolean;
}

function buildSummaryPrompt(options: TagOptions): string {
  const { vocabulary, tagsMax, proposeEnabled, proposeMax, brandExtractEnabled } =
    options;

  const tagRule =
    vocabulary.length > 0
      ? `8. tags 返回 1–${tagsMax} 个标签：优先使用下列词表中的标签：${vocabulary.join(
          '、',
        )}。词表没有更精确的类目时，可以直接输出 2–6 字的精确类目词（洗发水、抽纸、瑜伽垫）或品牌名，品牌不得与类目组合。禁止宽泛词、平台名、店铺后缀、促销词、价格与规格。`
      : `8. tags 返回 1–${tagsMax} 个 2–6 字的精确类目词或品牌名，品牌不得与类目组合；禁止宽泛词、平台名、店铺后缀、促销词、价格与规格。`;

  const proposeRule =
    proposeEnabled && proposeMax > 0
      ? `9. proposedTags：只上报没有出现在 tags 中的"精确类目"与"品牌"，先类目后品牌，各最多 2 个，总数不超过 ${proposeMax} 个；类目为 2–6 字商品名词（洗发水、抽纸），不得带价格/规格/材质/促销语；品牌只报原文逐字出现的商品品牌（优衣库、徕芬），不得与类目组合，并同时写入 brands；没有合适的新词时返回 []。`
      : '9. proposedTags 返回空数组 []。';

  const entityRule = brandExtractEnabled
    ? '10. brands 和 products 从该项的 title、description 原文中抽取品牌名与产品名，必须逐字出现在原文中，不得推测；没有则返回 []。'
    : '10. brands 和 products 返回空数组 []。';

  const format =
    '{"items":[{"id":1,"title":"","summary":"","tags":[],"proposedTags":[],"brands":[],"products":[]}]}';

  return `你是中文优惠信息编辑。用户会给出 items 数组，每项包含 id、title、description，部分条目可能还有 context。请逐条改写成更简洁、更好读的标题和摘要，帮助读者快速判断是否值得参与。

硬性规则：
1. 只能使用该项自己的 title、description 和 context 中的事实，不同条目的信息不能混用。
2. 严禁编造或推测价格、折扣、金额、日期、名额、链接、品牌、参与方式。
3. 每个输入 id 必须返回一条，id 原样返回，不得新增、遗漏或重复。
4. 如果某项的某个字段在原文中找不到依据，该字段返回空字符串 ""。
5. title 不超过 28 个汉字，是对原标题的简洁改写，保留核心对象和优惠动作；不要加"必看""震惊"等标题党用语，不要带来源名。
6. summary 不超过 60 个汉字，一句话说清"是什么优惠、力度多大"。
7. Epic 免费游戏是限时免费，标题或摘要必须体现"限时"，严禁写成"永久免费"。
${tagRule}
${proposeRule}
${entityRule}
11. 不要输出 Markdown，不要输出解释，只输出 JSON 对象。

输出格式：
${format}`;
}

interface AiConfig {
  apiKey: string;
  endpoint: string;
  model: string;
  searchModel: string;
  maxItems: number;
  batchSize: number;
  retrySize: number;
  maxAttempts: number;
  concurrency: number;
  timeoutMs: number;
  tagTimeoutMs: number;
  searchTimeoutMs: number;
  expandTimeoutMs: number;
}

interface AiResult {
  title: string;
  summary: string;
  tags: string[];
  proposedTags: string[];
  entities: string[];
}

const runtime = globalThis as typeof globalThis & {
  __dailyDealsAiRunning?: boolean;
};

function chatEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function readConfig(): AiConfig | null {
  const apiKey = getRuntimeEnv('LLM_API_KEY').trim();
  const baseUrl = getRuntimeEnv('LLM_BASE_URL').trim();
  const model = getRuntimeEnv('LLM_MODEL').trim();
  if (!apiKey || !baseUrl || !model) return null;

  const maxItems = getRuntimeEnvNumber('LLM_MAX_ITEMS_PER_RUN', 80, 1, 200);
  const batchSize = getRuntimeEnvNumber('AI_SUMMARY_BATCH_SIZE', 20, 5, 30);
  const retrySize = getRuntimeEnvNumber('AI_SUMMARY_RETRY_SIZE', 10, 1, 30);
  const maxAttempts = getRuntimeEnvNumber(
    'AI_SUMMARY_MAX_ATTEMPTS',
    3,
    1,
    10,
  );
  const concurrency = getRuntimeEnvNumber('LLM_CONCURRENCY', 3, 1, 6);
  const timeoutMs = getAiSummaryTimeoutMs();

  return {
    apiKey,
    endpoint: chatEndpoint(baseUrl),
    model,
    searchModel: getRuntimeEnv('AI_SEARCH_MODEL', '').trim() || model,
    maxItems,
    batchSize,
    retrySize,
    maxAttempts,
    concurrency,
    timeoutMs,
    tagTimeoutMs: getAiTagTimeoutMs(),
    searchTimeoutMs: getAiSearchRerankTimeoutMs(),
    expandTimeoutMs: getAiKeywordExpandTimeoutMs(),
  };
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/** 输出中出现的数字必须能在原文中找到，避免模型凭空生成金额/折扣/日期。 */
function numbersAreGrounded(
  deal: AiPendingDeal,
  output: string,
): boolean {
  const source = `${deal.title} ${deal.description}`;
  const available = new Set(source.match(/\d+(?:\.\d+)?/g) ?? []);
  const produced = output.match(/\d+(?:\.\d+)?/g) ?? [];
  return produced.every((value) => available.has(value));
}

/** 泛化词、平台名、店铺后缀、价格规格与促销语，不能作为标签。 */
const TAG_BLOCKLIST = new Set([
  '好物', '推荐', '优惠', '超值', '免费', '热卖', '促销', '特价', '新品', '爆款',
  '旗舰店', '官方', '自营', '店铺', '商城', '淘宝', '天猫', '京东', '拼多多', '抖音', '快手',
]);

function isNoisyTag(tag: string): boolean {
  if (TAG_BLOCKLIST.has(tag)) return true;
  if (/^\d+(?:\.\d+)?$/.test(tag)) return true;
  if (/(旗舰店|官方店|专营店|自营店)$/.test(tag)) return true;
  // 带价格/规格的组合词（8.5元、9.9折、600ml、5件套）不是标签。
  if (
    /\d/.test(tag) &&
    /(元|折|ml|kg|g|l|升|毫升|件套|件装|片装|瓶装|盒装|袋装|支装|个装|只装)(?![a-z])/i.test(
      tag,
    )
  ) {
    return true;
  }
  if (/(特价|捡漏|好价|合集|秒杀|包邮)/.test(tag)) return true;
  return false;
}

/** 核心标签：优先词表，也接受模型输出的精确类目与品牌，最多 tagsMax 个。 */
function normalizeTags(value: unknown, options: TagOptions): string[] {
  if (!Array.isArray(value)) return [];

  const max = options.tagsMax > 0 ? options.tagsMax : 5;
  const tags: string[] = [];
  for (const entry of value) {
    const tag = cleanText(entry, 12);
    if (tag.length < 2) continue;
    if (isNoisyTag(tag)) continue;
    if (tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length >= max) break;
  }
  return tags;
}

/** 词表之外的新品类词或品牌，立即进入候选池但不会直接进入前台标签建议。 */
function normalizeProposedTags(
  value: unknown,
  vocabulary: string[],
  options: TagOptions,
): string[] {
  if (!options.proposeEnabled || options.proposeMax <= 0) return [];
  if (!Array.isArray(value)) return [];

  const allowed = new Set(vocabulary.map((tag) => tag.toLowerCase()));
  const result: string[] = [];
  for (const entry of value) {
    const tag = cleanText(entry, 12);
    if (tag.length < 2 || tag.length > 8) continue;
    if (isNoisyTag(tag)) continue;
    if (allowed.has(tag.toLowerCase())) continue;
    if (result.some((item) => item.toLowerCase() === tag.toLowerCase())) {
      continue;
    }
    result.push(tag);
    if (result.length >= options.proposeMax) break;
  }
  return result;
}

/** 品牌/产品实体必须能在原文中逐字找到，否则丢弃。 */
function normalizeEntities(
  value: unknown,
  sourceText: string,
  max: number,
): string[] {
  if (!Array.isArray(value) || max <= 0) return [];

  const source = sourceText.toLowerCase();
  const result: string[] = [];
  for (const entry of value) {
    const entity = cleanText(entry, 24);
    if (entity.length < 2) continue;
    if (!source.includes(entity.toLowerCase())) continue;
    if (result.some((item) => item.toLowerCase() === entity.toLowerCase())) {
      continue;
    }
    result.push(entity);
    if (result.length >= max) break;
  }
  return result;
}

function normalizeResult(
  raw: Record<string, unknown>,
  deal: AiPendingDeal,
  options: TagOptions,
): AiResult | null {
  let summary = cleanText(raw.summary, 120);
  if (!summary) return null;

  let title = cleanText(raw.title, 56);

  // Epic 免费游戏是限时免费，纠正模型可能给出的"永久免费"。
  if (deal.source === 'epic') {
    title = title.replace(/永久|终身/g, '限时');
    summary = summary.replace(/永久|终身/g, '限时');
  }

  const sourceText = `${deal.title} ${deal.description}${
    deal.source === 'epic' ? ' 限时免费' : ''
  }`;
  const unsupported = (text: string) =>
    ['永久', '终身', '无限'].some(
      (word) => text.includes(word) && !sourceText.includes(word),
    );
  const valid = (text: string) =>
    Boolean(text) &&
    !/https?:\/\//i.test(text) &&
    numbersAreGrounded(deal, text) &&
    !unsupported(text);

  // 摘要必须可靠；标题是可选字段，不合格时留空并回退原文。
  if (!valid(summary)) return null;
  if (title && !valid(title)) title = '';

  const entities = options.brandExtractEnabled
    ? normalizeEntities(
        [
          ...(Array.isArray(raw.brands) ? raw.brands : []),
          ...(Array.isArray(raw.products) ? raw.products : []),
        ],
        sourceText,
        6,
      )
    : [];

  const tags = normalizeTags(raw.tags, options);

  return {
    title,
    summary,
    tags,
    proposedTags: normalizeProposedTags(
      raw.proposedTags,
      options.vocabulary,
      options,
    ).filter((tag) => !tags.includes(tag)),
    entities,
  };
}

function parseBatchContent(content: string): unknown {
  let text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  try {
    const objectStart = text.indexOf('{');
    const arrayStart = text.indexOf('[');

    if (objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)) {
      const end = text.lastIndexOf('}');
      if (end > objectStart) {
        return JSON.parse(text.slice(objectStart, end + 1));
      }
    }

    if (arrayStart >= 0) {
      const end = text.lastIndexOf(']');
      if (end > arrayStart) {
        return JSON.parse(text.slice(arrayStart, end + 1));
      }
    }

    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseBatchResults(
  content: string,
  deals: AiPendingDeal[],
  options: TagOptions,
): Map<number, AiResult> {
  const parsed = parseBatchContent(content);
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' &&
        Array.isArray((parsed as Record<string, unknown>).items)
      ? ((parsed as Record<string, unknown>).items as unknown[])
      : [];

  const byId = new Map(deals.map((deal) => [deal.id, deal]));
  const results = new Map<number, AiResult>();

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;

    const raw = entry as Record<string, unknown>;
    const id =
      typeof raw.id === 'number'
        ? raw.id
        : Number.parseInt(String(raw.id), 10);
    const deal = byId.get(id);
    if (!deal || results.has(id)) continue;

    const result = normalizeResult(raw, deal, options);
    if (result) results.set(id, result);
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callModelBatch(
  config: AiConfig,
  deals: AiPendingDeal[],
  options: TagOptions,
): Promise<Map<number, AiResult>> {
  const items = deals.map((deal) => ({
    id: deal.id,
    title: deal.title,
    description: deal.description.slice(0, 800),
    ...(deal.source === 'epic'
      ? {
          context:
            '该条目来自 Epic 免费游戏列表，当前处于限时免费领取时间窗内（不是永久免费）。',
        }
      : {}),
  }));

  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: buildSummaryPrompt(options) },
      {
        role: 'user',
        content: JSON.stringify({ items }),
      },
    ],
    temperature: 0.1,
    max_tokens: Math.min(8192, 400 + deals.length * 200),
    response_format: { type: 'json_object' },
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await request(
        config.endpoint,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
        },
        config.timeoutMs,
      );

      const body = await response.text();

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt === 0) {
          await sleep(1_000);
          continue;
        }
        throw new Error(
          `HTTP ${response.status}: ${body.slice(0, 160)}`,
        );
      }

      const data = JSON.parse(body) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      const results = parseBatchResults(content, deals, options);

      if (results.size > 0) return results;
      if (attempt === 0) {
        await sleep(400);
        continue;
      }
      return results;
    } catch (error) {
      if (attempt === 0) {
        await sleep(1_000);
        continue;
      }
      console.warn(
        `[ai] 批量请求失败（${deals.length} 条）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return new Map();
    }
  }

  return new Map();
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const size = Math.min(limit, items.length);

  await Promise.all(
    Array.from({ length: size }, async () => {
      while (index < items.length) {
        const current = items[index];
        index += 1;
        await worker(current);
      }
    }),
  );
}

/**
 * 为尚未生成摘要的条目批量补全 AI 摘要。
 * 只改写已有文本，不新增事实；失败条目保留至下一轮重试。
 */
export async function enrichPendingDeals(): Promise<void> {
  if (getRuntimeEnv('LLM_ENABLED', 'true').trim() === 'false') return;

  const config = readConfig();
  if (!config) return;
  if (runtime.__dailyDealsAiRunning) return;

  runtime.__dailyDealsAiRunning = true;

  try {
    const pending = listDealsForAi(config.maxItems, config.maxAttempts);
    if (pending.length === 0) return;

    const tagsEnabled = getAiTagsEnabled();
    const options: TagOptions = {
      vocabulary: tagsEnabled ? getAiTagVocabulary() : [],
      tagsMax: getAiTagsMax(),
      proposeEnabled: tagsEnabled && getAiTagsProposeEnabled(),
      proposeMax: tagsEnabled ? getAiTagsProposeMax() : 0,
      brandExtractEnabled: tagsEnabled && getAiTagsBrandExtractEnabled(),
    };

    const batches: AiPendingDeal[][] = [];
    for (let index = 0; index < pending.length; index += config.batchSize) {
      batches.push(pending.slice(index, index + config.batchSize));
    }

    let done = 0;
    let retried = 0;
    let failed = 0;

    await runPool(batches, config.concurrency, async (batch) => {
      const results = await callModelBatch(config, batch, options);

      // 同一轮内只补一次：把缺失的条目压成一个小批次再请求一遍。
      const missing = batch.filter((deal) => !results.has(deal.id));
      if (missing.length > 0) {
        const retryBatch = missing.slice(0, config.retrySize);
        retried += retryBatch.length;
        const retryResults = await callModelBatch(
          config,
          retryBatch,
          options,
        );
        for (const [id, result] of retryResults) {
          results.set(id, result);
        }
      }

      const stillMissing: number[] = [];
      for (const deal of batch) {
        const result = results.get(deal.id);
        if (!result) {
          stillMissing.push(deal.id);
          continue;
        }
        saveAiEnrichment(deal.id, result, config.model);
        matchSubscriptionsForDeal(deal.id);
        done += 1;
      }

      if (stillMissing.length > 0) {
        incrementAiAttempts(stillMissing);
        failed += stillMissing.length;
      }
    });

    console.log(
      `[ai] batches=${batches.length} batchSize=${config.batchSize} enriched=${done} retried=${retried} failed=${failed} pending=${pending.length} model=${config.model}`,
    );
  } catch (error) {
    console.error('[ai] 任务失败：', error);
  } finally {
    runtime.__dailyDealsAiRunning = false;
  }
}

const TAG_SYSTEM_PROMPT = `你是中文优惠信息分类器。用户会给出 items 数组，每项包含 id、title、summary、description。请为每条优惠输出品类标签、可选的新品类词，以及可抽取的品牌与产品。

硬性规则：
1. tags：返回 1–__TAGS_MAX__ 个标签，优先使用词表（__VOCABULARY__）中的词；词表没有更精确的类目时，可以直接输出 2–6 字的精确类目词（洗发水、抽纸、瑜伽垫）或品牌名，品牌不得与类目组合（禁止"薇姿洗发水"）。禁止宽泛词、平台名、店铺后缀、促销词、价格与规格、纯数字；只有完全无法判断时才选择"其他"。
2. proposedTags：只上报没有出现在 tags 中的"精确类目"与"品牌"，先类目后品牌，类目和品牌各最多 2 个，总数不超过 __PROPOSE_MAX__ 个。
   类目：2–6 字商品名词，粒度到二级类目（洗发水、抽纸、瑜伽垫、空气炸锅），不得包含价格/折扣（8.5元、9.9折）、规格（600ml、5件套）、材质修饰（不锈钢、亚克力）或促销语（特价、捡漏、合集）。
   品牌：只报原文逐字出现的商品品牌，保留官方写法（babycare、海尔 Haier、徕芬）；不得报平台名、店铺后缀、型号系列。
   品牌与类目必须分开，禁止组合成"薇姿洗发水"这类词。
   示例：
   "京东9.9津贴捡漏合集（不锈钢鸣音水壶、亚克力小推车）"→ ["水壶","推车"]
   "8.5元特价舒蕾山茶花洗发水600ml"→ ["洗发水","舒蕾"]
   "徕芬i2电动牙刷"→ ["电动牙刷","徕芬"]
   禁止输出：宽泛词（好物/推荐/优惠/超值/免费/热卖/促销/特价/新品/爆款）、平台名（淘宝/京东/拼多多/天猫/抖音）、店铺后缀（旗舰店/官方店/专营店）、纯数字、地名、与 tags 重复的词。
3. brands、products：__ENTITY_RULE__
4. 结合标题与摘要判断真实品类，不要被无关词干扰（例如"奶茶色口红"不是奶茶）。
5. 每个输入 id 必须返回一条，id 原样返回。
6. 不要输出 Markdown，不要输出解释，只输出 JSON 对象。

可用标签：__VOCABULARY__

输出格式：
{"items":[{"id":1,"tags":["奶茶"],"proposedTags":[],"brands":[],"products":[]}]}`;

interface TagResult {
  tags: string[];
  proposedTags: string[];
  entities: string[];
}

function parseTagResults(
  content: string,
  deals: AiTagPendingDeal[],
  options: TagOptions,
): Map<number, TagResult> {
  const parsed = parseBatchContent(content);
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' &&
        Array.isArray((parsed as Record<string, unknown>).items)
      ? ((parsed as Record<string, unknown>).items as unknown[])
      : [];

  const byId = new Map(deals.map((deal) => [deal.id, deal]));
  const results = new Map<number, TagResult>();

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const id =
      typeof raw.id === 'number'
        ? raw.id
        : Number.parseInt(String(raw.id), 10);
    const deal = byId.get(id);
    if (!deal || results.has(id)) continue;

    const tags = normalizeTags(raw.tags, options);
    const proposedTags = normalizeProposedTags(
      raw.proposedTags,
      options.vocabulary,
      options,
    ).filter((tag) => !tags.includes(tag));
    const entities = options.brandExtractEnabled
      ? normalizeEntities(
          [
            ...(Array.isArray(raw.brands) ? raw.brands : []),
            ...(Array.isArray(raw.products) ? raw.products : []),
          ],
          `${deal.title} ${deal.description}`,
          6,
        )
      : [];

    if (tags.length === 0 && proposedTags.length === 0 && entities.length === 0) {
      continue;
    }
    results.set(id, { tags, proposedTags, entities });
  }

  return results;
}

async function callTagModelBatch(
  config: AiConfig,
  deals: AiTagPendingDeal[],
  options: TagOptions,
): Promise<Map<number, TagResult>> {
  const items = deals.map((deal) => ({
    id: deal.id,
    title: deal.title,
    summary: deal.summary.slice(0, 160),
    description: deal.description.slice(0, 500),
  }));

  const entityRule = options.brandExtractEnabled
    ? '从该项 title、description 原文中逐字抽取品牌名与产品名，必须能在原文中找到，没有则返回 []。'
    : '返回空数组 []。';

  const proposeMax =
    options.proposeEnabled && options.proposeMax > 0 ? options.proposeMax : 0;

  const payload = {
    model: config.model,
    messages: [
      {
        role: 'system',
        content: TAG_SYSTEM_PROMPT.replace(
          '__VOCABULARY__',
          options.vocabulary.join('、'),
        )
          .replace('__TAGS_MAX__', String(options.tagsMax))
          .replace('__PROPOSE_MAX__', String(proposeMax))
          .replace('__ENTITY_RULE__', entityRule),
      },
      { role: 'user', content: JSON.stringify({ items }) },
    ],
    temperature: 0.1,
    max_tokens: Math.min(8192, 120 + deals.length * 80),
    response_format: { type: 'json_object' },
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await request(
        config.endpoint,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
        },
        config.tagTimeoutMs,
      );

      const body = await response.text();
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt === 0) {
          await sleep(1_000);
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
      }

      const data = JSON.parse(body) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      const results = parseTagResults(content, deals, options);
      if (results.size > 0 || attempt === 1) return results;
      await sleep(400);
    } catch (error) {
      if (attempt === 0) {
        await sleep(1_000);
        continue;
      }
      console.warn(
        `[tags] 批量分类失败（${deals.length} 条）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return new Map();
    }
  }

  return new Map();
}

/**
 * 为已有摘要的存量条目补全品类标签。
 * force=true 时忽略 ai_tags_at，对全部在架条目重新打标（用于词表或提议配置变更后）。
 * 异步执行，后台通过 getTagRunProgress() 查看进度。
 */
export function startTagBackfill(force = false): TagRunProgress {
  const current = getTagRunProgress();
  if (current.running) return current;

  const fail = (error: string): TagRunProgress =>
    updateTagRunProgress({
      running: false,
      error,
      finishedAt: new Date().toISOString(),
    });

  if (!getAiTagsEnabled()) return fail('品类标签已在后台关闭');
  if (getRuntimeEnv('LLM_ENABLED', 'true').trim() === 'false') {
    return fail('AI 摘要已关闭，无法生成标签');
  }

  const config = readConfig();
  if (!config) return fail('未配置 AI 接口，无法生成标签');

  const options: TagOptions = {
    vocabulary: getAiTagVocabulary(),
    tagsMax: getAiTagsMax(),
    proposeEnabled: getAiTagsProposeEnabled(),
    proposeMax: getAiTagsProposeMax(),
    brandExtractEnabled: getAiTagsBrandExtractEnabled(),
  };
  if (options.vocabulary.length === 0) return fail('品类标签词表为空');

  const pending = listDealsMissingTags(20_000, force);
  if (pending.length === 0) {
    resetTagRunProgress(0);
    return updateTagRunProgress({
      running: false,
      finishedAt: new Date().toISOString(),
    });
  }

  resetTagRunProgress(pending.length);

  void (async () => {
    let tagged = 0;
    let failed = 0;

    try {
      const batches: AiTagPendingDeal[][] = [];
      for (let index = 0; index < pending.length; index += config.batchSize) {
        batches.push(pending.slice(index, index + config.batchSize));
      }

      await runPool(batches, config.concurrency, async (batch) => {
        const results = await callTagModelBatch(config, batch, options);

        const missing = batch.filter((deal) => !results.has(deal.id));
        if (missing.length > 0) {
          const retry = missing.slice(0, config.retrySize);
          const retryResults = await callTagModelBatch(
            config,
            retry,
            options,
          );
          for (const [id, result] of retryResults) results.set(id, result);
        }

        let batchTagged = 0;
        let batchFailed = 0;
        for (const deal of batch) {
          const result = results.get(deal.id);
          if (result) {
            saveDealTags(
              deal.id,
              result.tags,
              result.proposedTags,
              result.entities,
            );
            matchSubscriptionsForDeal(deal.id);
            batchTagged += 1;
          } else {
            batchFailed += 1;
          }
        }

        tagged += batchTagged;
        failed += batchFailed;
        const progress = getTagRunProgress();
        updateTagRunProgress({
          processed: progress.processed + batch.length,
          tagged,
          failed,
        });
      });

      updateTagRunProgress({
        running: false,
        finishedAt: new Date().toISOString(),
        processed: pending.length,
        tagged,
        failed,
        error: null,
      });
      console.log(
        `[tags] done=${tagged} failed=${failed} total=${pending.length} model=${config.model}`,
      );
    } catch (error) {
      updateTagRunProgress({
        running: false,
        finishedAt: new Date().toISOString(),
        tagged,
        failed,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error('[tags] 补全失败：', error);
    }
  })();

  return getTagRunProgress();
}

export interface AiSearchDeal {
  id: number;
  title: string;
  summary?: string;
  source?: string;
  expiresAt?: string | null;
}

export interface AiSearchSelection {
  ids: number[];
  reason: string;
}

function buildSearchPrompt(limit: number): string {
  return `你是中文优惠信息检索助手。用户会给出搜索需求，下面是从全文索引召回的真实条目，每项包含 id、标题、摘要、来源和到期时间。请结合标题与摘要判断相关度，并按相关度排序。

硬性规则：
1. 只能使用列表中出现的信息，不要假设列表之外的内容。
2. 只能返回列表中出现过的 id，严禁编造 id。
3. 与需求无关的条目不要返回；宁可少返回，也不要凑数。
4. 最多返回 ${limit} 条。
5. reason 用一句不超过 40 字的中文说明筛选依据，不要包含链接。
6. 只输出 JSON 对象，不要输出 Markdown 或解释。

输出格式：
{"ids":[1,2,3],"reason":""}`;
}

function parseSearchSelection(
  content: string,
  validIds: Set<number>,
  limit: number,
): AiSearchSelection | null {
  let text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!Array.isArray(raw.ids)) return null;

  const ids: number[] = [];
  for (const value of raw.ids) {
    const id =
      typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isInteger(id) || !validIds.has(id) || ids.includes(id)) {
      continue;
    }
    ids.push(id);
    if (ids.length >= limit) break;
  }

  const reason = cleanText(raw.reason, 80)
    .replace(/https?:\/\/\S+/gi, '')
    .trim();

  return { ids, reason };
}

async function callSearchModel(
  config: AiConfig,
  query: string,
  deals: AiSearchDeal[],
  limit: number,
): Promise<string | null> {
  const items = deals.map((deal) => ({
    id: deal.id,
    title: deal.title.slice(0, 90),
    summary: (deal.summary ?? '').slice(0, 120),
    source: deal.source ?? '',
    expiresAt: deal.expiresAt ?? null,
  }));

  const payload = {
    model: config.searchModel,
    messages: [
      { role: 'system', content: buildSearchPrompt(limit) },
      {
        role: 'user',
        content: JSON.stringify({ query, items }),
      },
    ],
    temperature: 0.1,
    max_tokens: Math.min(1200, 200 + limit * 30),
    response_format: { type: 'json_object' },
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await request(
        config.endpoint,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
        },
        config.searchTimeoutMs,
      );

      const body = await response.text();
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt === 0) {
          await sleep(800);
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
      }

      const data = JSON.parse(body) as {
        choices?: { message?: { content?: string } }[];
      };
      return data.choices?.[0]?.message?.content ?? '';
    } catch (error) {
      if (attempt === 0) {
        await sleep(800);
        continue;
      }
      console.warn(
        `[ai-search] 请求失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  return null;
}

const EXPAND_SYSTEM_PROMPT = `你是优惠信息订阅的关键词扩展助手。用户会给出一个关键词数组，请对每个词判断类型并给出扩展词。

类型说明：
- category：品类词（如"空调""奶茶""猫粮"），列出该品类下最常见的品牌名，6–12 个，必须是真实存在的品牌
- brand：品牌词（如"格力""喜茶"），列出该品牌常见的别名、英文名、简称，0–3 个
- other：泛词或无法归类（如"免费""红包""优惠"），返回空数组

硬性规则：
1. 只输出确定存在的品牌与别名，不确定就不要写，严禁编造
2. 不要输出品类本身的同义词，不要输出其他品类名
3. 品牌名使用中文常用写法，英文别名用小写
4. 每个输入词必须返回一条，keyword 原样返回

输出 JSON：
{"items":[{"keyword":"空调","kind":"category","expansions":["格力","美的","海尔"]}]}`;

export interface KeywordExpansionResult {
  keyword: string;
  kind: string;
  expansions: string[];
}

/** 让模型批量判断订阅词类型并给出品牌/别名扩展，一次请求处理多个词。 */
export async function expandKeywordsWithAi(
  keywords: string[],
): Promise<KeywordExpansionResult[] | null> {
  if (keywords.length === 0) return [];
  const config = readConfig();
  if (!config) return null;

  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: EXPAND_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ keywords }) },
    ],
    temperature: 0.1,
    max_tokens: Math.min(2048, 300 + keywords.length * 120),
    response_format: { type: 'json_object' },
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await request(
        config.endpoint,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
        },
        config.expandTimeoutMs,
      );

      const body = await response.text();

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt === 0) {
          await sleep(1_000);
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
      }

      const data = JSON.parse(body) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      const parsed = parseBatchContent(content) as { items?: unknown } | undefined;
      const items = Array.isArray(parsed?.items) ? parsed.items : [];

      const results: KeywordExpansionResult[] = [];
      for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        const keyword =
          typeof item.keyword === 'string' ? item.keyword.trim() : '';
        if (!keyword) continue;
        const kind = typeof item.kind === 'string' ? item.kind : 'other';
        const expansions = Array.isArray(item.expansions)
          ? item.expansions
              .filter((value): value is string => typeof value === 'string')
              .map((value) => value.trim())
              .filter(Boolean)
              .slice(0, 12)
          : [];
        results.push({ keyword, kind, expansions });
      }

      if (results.length > 0) return results;
      if (attempt === 0) continue;
    } catch (error) {
      if (attempt === 0) continue;
      console.warn(
        `[keyword] AI 扩展失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  return null;
}

/** 当前 AI 模型名，用于记录扩展来源。 */
export function getAiModelName(): string {
  return readConfig()?.model ?? '';
}

/**
 * 让模型从当前真实条目中筛选搜索结果。
 * 返回 null 表示 AI 不可用或输出不可解析，调用方应回退到关键词匹配。
 */
export async function searchDealsWithAi(
  query: string,
  deals: AiSearchDeal[],
  limit = 20,
): Promise<AiSearchSelection | null> {
  if (getRuntimeEnv('AI_SEARCH_ENABLED', 'true').trim() === 'false') {
    return null;
  }

  const config = readConfig();
  if (!config || deals.length === 0) return null;

  const content = await callSearchModel(config, query, deals, limit);
  if (content === null) return null;

  const validIds = new Set(deals.map((deal) => deal.id));
  return parseSearchSelection(content, validIds, limit);
}

const REWRITE_SYSTEM_PROMPT = `你是中文优惠搜索的查询改写助手。用户第一次搜索没有召回任何结果，请把 query 改写成 3–5 个更适合站内全文检索的关键词或品类词，用于第二次召回。

规则：
1. 保留原文中的品牌、型号、品类等实体词。
2. 去掉"想、求、有没有、便宜、好价、推荐、怎么"等语气词。
3. 把口语意图转成具体品类，例如"想喝点甜的"→"奶茶、咖啡、甜品、饮料"。
4. 不要加入原文没有的具体品牌、型号或价格。
5. 关键词不能重复，每个不超过 12 个字。
6. 只输出 JSON 对象：{"keywords":["..."]}`;

function normalizeKeywords(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  const keywords: string[] = [];

  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    for (const part of entry.split(/[,，、;；]+/)) {
      const cleaned = part
        .replace(/\s+/g, ' ')
        .replace(/^[\s:：]+|[\s:：]+$/g, '')
        .trim()
        .slice(0, 20);
      if (!cleaned || keywords.includes(cleaned)) continue;
      keywords.push(cleaned);
      if (keywords.length >= 5) break;
    }
    if (keywords.length >= 5) break;
  }

  return keywords;
}

function parseRewriteKeywords(content: string): string[] {
  let text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const parsed =
      start >= 0 && end > start
        ? JSON.parse(text.slice(start, end + 1))
        : JSON.parse(text);
    const record =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    return normalizeKeywords(record.keywords ?? record.items ?? parsed);
  } catch {
    return [];
  }
}

/**
 * 只在第一次召回为零时调用，把口语搜索改写成更容易命中的关键词。
 * 传入站内正式标签词表后，会优先复用这些真实存在的标签，提升二次召回命中率。
 * 超时或失败都返回空数组，不影响主搜索。
 */
export async function rewriteSearchQuery(
  query: string,
  timeoutMs: number,
  vocabulary: string[] = [],
): Promise<string[]> {
  if (getRuntimeEnv('AI_SEARCH_ENABLED', 'true').trim() === 'false') {
    return [];
  }

  const config = readConfig();
  if (!config) return [];

  const tags = vocabulary
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 60);
  const systemPrompt =
    tags.length > 0
      ? `${REWRITE_SYSTEM_PROMPT}

站内已有标签（优先复用，必须原样输出，不要改写文字）：
${tags.join('、')}

如果其中有与搜索意图相关的标签，请优先输出这些标签原文；不足 3 个时再按上述规则补充通用品类词。`
      : REWRITE_SYSTEM_PROMPT;

  const payload = {
    model: config.searchModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify({ query }) },
    ],
    temperature: 0.2,
    max_tokens: 200,
    response_format: { type: 'json_object' },
  };

  try {
    const response = await request(
      config.endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      },
      timeoutMs,
    );

    if (!response.ok) return [];
    const body = await response.text();
    const data = JSON.parse(body) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return parseRewriteKeywords(content);
  } catch (error) {
    console.warn(
      `[rewrite] 查询改写失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

function buildTagSuggestPrompt(limit: number): string {
  return `你是中文优惠网站的品类匹配助手。用户搜索两次都没有结果，请从给定的品类标签中挑出最符合搜索意图的标签，作为可点击的建议。
规则：
1. 只能从给定标签中原样挑选，禁止编造、改写或翻译标签。
2. 只有当标签本身就是用户想找的品类时才选择；不要因为"游戏""虚拟权益""其他"这类宽泛标签沾边就推荐，凑数视为错误。
3. 如果搜索词指向现实中不存在对应品类的场景（例如虚构道具、科幻设定、无意义词语），必须返回空数组。
4. 按相关度从高到低排序，最多返回 ${limit} 个；语义不相关的不要返回。
5. 为每个标签给出 0–1 的 confidence，低于 0.75 的不要返回。
6. 只输出 JSON 对象：{"tags":[{"tag":"标签原文","confidence":0.9}]}`;
}

/** 严格按词表校验模型挑选的标签，词表外或置信度不足的一律丢弃。 */
function parseTagPicks(content: string, vocabulary: string[]): string[] {
  let text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const parsed =
      start >= 0 && end > start
        ? JSON.parse(text.slice(start, end + 1))
        : JSON.parse(text);
    const record =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    const list = Array.isArray(record.tags)
      ? record.tags
      : Array.isArray(record.items)
        ? record.items
        : [];
    const canonical = new Map(
      vocabulary.map((tag) => [tag.toLowerCase(), tag]),
    );

    const picked: string[] = [];
    for (const entry of list) {
      const rawTag =
        typeof entry === 'string'
          ? entry
          : entry && typeof entry === 'object'
            ? (entry as Record<string, unknown>).tag
            : null;
      if (typeof rawTag !== 'string') continue;

      const confidence =
        entry && typeof entry === 'object'
          ? Number((entry as Record<string, unknown>).confidence ?? 1)
          : 1;
      if (!Number.isFinite(confidence) || confidence < 0.75) continue;

      const tag = canonical.get(rawTag.trim().toLowerCase());
      if (!tag || picked.includes(tag)) continue;
      picked.push(tag);
    }

    return picked;
  } catch {
    return [];
  }
}

/**
 * 两次召回都为空时，让模型只从正式标签里挑相关的作为建议。
 * 返回 null 表示调用失败（调用方退回字面匹配），空数组表示模型明确认为无相关标签。
 */
export async function suggestTagsForQuery(
  query: string,
  keywords: string[],
  vocabulary: string[],
  limit: number,
  timeoutMs: number,
): Promise<string[] | null> {
  if (limit <= 0 || vocabulary.length === 0) return [];
  if (getRuntimeEnv('AI_SEARCH_ENABLED', 'true').trim() === 'false') {
    return null;
  }

  const config = readConfig();
  if (!config) return null;

  const payload = {
    model: config.searchModel,
    messages: [
      { role: 'system', content: buildTagSuggestPrompt(limit) },
      {
        role: 'user',
        content: JSON.stringify({
          query,
          keywords: keywords.slice(0, 5),
          tags: vocabulary.slice(0, 200),
        }),
      },
    ],
    temperature: 0.1,
    max_tokens: 300,
    response_format: { type: 'json_object' },
  };

  try {
    const response = await request(
      config.endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      },
      timeoutMs,
    );

    if (!response.ok) return null;
    const body = await response.text();
    const data = JSON.parse(body) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return parseTagPicks(content, vocabulary).slice(0, limit);
  } catch (error) {
    console.warn(
      `[suggest] 标签建议失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
