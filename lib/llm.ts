import {
  incrementAiAttempts,
  listDealsForAi,
  saveAiEnrichment,
  type AiPendingDeal,
} from './db';
import { request } from './http';
import {
  getRuntimeEnv,
  getRuntimeEnvNumber,
} from './runtime-settings';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'Qwen/Qwen3-30B-A3B-Instruct-2507';

const SYSTEM_PROMPT = `你是中文优惠信息编辑。用户会给出 items 数组，每项包含 id、title、description，部分条目可能还有 context。请逐条改写成更简洁、更好读的标题和摘要，帮助读者快速判断是否值得参与。

硬性规则：
1. 只能使用该项自己的 title、description 和 context 中的事实，不同条目的信息不能混用。
2. 严禁编造或推测价格、折扣、金额、日期、名额、链接、品牌、参与方式。
3. 每个输入 id 必须返回一条，id 原样返回，不得新增、遗漏或重复。
4. 如果某项的某个字段在原文中找不到依据，该字段返回空字符串 ""。
5. title 不超过 28 个汉字，是对原标题的简洁改写，保留核心对象和优惠动作；不要加"必看""震惊"等标题党用语，不要带来源名。
6. summary 不超过 60 个汉字，一句话说清"是什么优惠、力度多大"。
7. value 不超过 20 个字，例如"返现150元""立减20元""5折"；没有明确力度则返回 ""。
8. action 不超过 30 个字，说清"需要做什么"；没有明确步骤则返回 ""。
9. Epic 免费游戏是限时免费，value 必须写"限时免费"，严禁写成"永久免费"。
10. 不要输出 Markdown，不要输出解释，只输出 JSON 对象。

输出格式：
{"items":[{"id":1,"title":"","summary":"","value":"","action":""}]}`;

interface AiConfig {
  apiKey: string;
  endpoint: string;
  model: string;
  maxItems: number;
  batchSize: number;
  retrySize: number;
  maxAttempts: number;
  concurrency: number;
  timeoutMs: number;
}

interface AiResult {
  title: string;
  summary: string;
  value: string;
  action: string;
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
  if (!apiKey) return null;

  const baseUrl =
    getRuntimeEnv('LLM_BASE_URL').trim() || DEFAULT_BASE_URL;
  const model = getRuntimeEnv('LLM_MODEL').trim() || DEFAULT_MODEL;
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
  const timeoutMs = getRuntimeEnvNumber(
    'LLM_TIMEOUT_MS',
    120_000,
    10_000,
    300_000,
  );

  return {
    apiKey,
    endpoint: chatEndpoint(baseUrl),
    model,
    maxItems,
    batchSize,
    retrySize,
    maxAttempts,
    concurrency,
    timeoutMs,
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

function normalizeResult(
  raw: Record<string, unknown>,
  deal: AiPendingDeal,
): AiResult | null {
  let summary = cleanText(raw.summary, 120);
  if (!summary) return null;

  let title = cleanText(raw.title, 56);
  let value = cleanText(raw.value, 40);
  let action = cleanText(raw.action, 60);

  // Epic 免费游戏是限时免费，纠正模型可能给出的"永久免费"。
  if (deal.source === 'epic') {
    title = title.replace(/永久|终身/g, '限时');
    summary = summary.replace(/永久|终身/g, '限时');
    value = value.replace(/永久|终身/g, '限时');
    action = action.replace(/永久|终身/g, '限时');
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

  // 摘要必须可靠；标题、力度、操作是可选字段，不合格时留空并回退原文。
  if (!valid(summary)) return null;
  if (title && !valid(title)) title = '';
  if (value && !valid(value)) value = '';
  if (action && !valid(action)) action = '';

  return { title, summary, value, action };
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

    const result = normalizeResult(raw, deal);
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
      { role: 'system', content: SYSTEM_PROMPT },
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
      const results = parseBatchResults(content, deals);

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

    const batches: AiPendingDeal[][] = [];
    for (let index = 0; index < pending.length; index += config.batchSize) {
      batches.push(pending.slice(index, index + config.batchSize));
    }

    let done = 0;
    let retried = 0;
    let failed = 0;

    await runPool(batches, config.concurrency, async (batch) => {
      const results = await callModelBatch(config, batch);

      // 同一轮内只补一次：把缺失的条目压成一个小批次再请求一遍。
      const missing = batch.filter((deal) => !results.has(deal.id));
      if (missing.length > 0) {
        const retryBatch = missing.slice(0, config.retrySize);
        retried += retryBatch.length;
        const retryResults = await callModelBatch(config, retryBatch);
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

export interface AiSearchDeal {
  id: number;
  title: string;
}

export interface AiSearchSelection {
  ids: number[];
  reason: string;
}

const SEARCH_SYSTEM_PROMPT = `你是中文优惠信息检索助手。用户会给出搜索需求，下面是从优惠站点实时抓取到的条目列表，每条只包含 id 和标题。请只根据标题判断是否相关，并按相关度排序。

硬性规则：
1. 只能依据标题判断，不要假设标题之外的信息。
2. 只能返回列表中出现过的 id，严禁编造 id。
3. 与需求无关的条目不要返回；宁可少返回，也不要凑数。
4. 最多返回 30 条。
5. reason 用一句不超过 40 字的中文说明筛选依据，不要包含链接。
6. 只输出 JSON 对象，不要输出 Markdown 或解释。

输出格式：
{"ids":[1,2,3],"reason":""}`;

function parseSearchSelection(
  content: string,
  validIds: Set<number>,
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
    if (ids.length >= 30) break;
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
): Promise<string | null> {
  const items = deals.map((deal) => ({
    id: deal.id,
    title: deal.title.slice(0, 90),
  }));

  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: SEARCH_SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({ query, items }),
      },
    ],
    temperature: 0.1,
    max_tokens: 500,
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

/**
 * 让模型从当前真实条目中筛选搜索结果。
 * 返回 null 表示 AI 不可用或输出不可解析，调用方应回退到关键词匹配。
 */
export async function searchDealsWithAi(
  query: string,
  deals: AiSearchDeal[],
): Promise<AiSearchSelection | null> {
  if (getRuntimeEnv('AI_SEARCH_ENABLED', 'true').trim() === 'false') {
    return null;
  }

  const config = readConfig();
  if (!config || deals.length === 0) return null;

  const content = await callSearchModel(config, query, deals);
  if (content === null) return null;

  const validIds = new Set(deals.map((deal) => deal.id));
  return parseSearchSelection(content, validIds);
}
