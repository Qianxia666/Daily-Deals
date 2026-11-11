import {
  getRuntimeBool,
  getRuntimeEnv,
  getRuntimeEnvFloat,
  getRuntimeEnvNumber,
} from './runtime-settings';

/** 单次请求的文本条数，8B 模型下 16 条大约 8~10 秒。 */
const BATCH_SIZE = 16;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RETRIES = 2;

/** 关键词侧使用的指令前缀，能明显拉开相关与不相关文本的分数。 */
export const KEYWORD_INSTRUCTION =
  'Instruct: Given a deal article, judge whether it matches the keyword\nQuery: ';

export interface EmbeddingConfig {
  enabled: boolean;
  dryRun: boolean;
  url: string;
  key: string;
  model: string;
  threshold: number;
  maxPerDeal: number;
  stopwords: string[];
}

export function getEmbeddingConfig(): EmbeddingConfig {
  const stopwords = getRuntimeEnv(
    'SUBSCRIPTION_VECTOR_STOPWORDS',
    '免费,白嫖,羊毛,优惠,红包',
  )
    .split(/[,，\n]/)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);

  return {
    enabled: getRuntimeBool('SUBSCRIPTION_VECTOR_ENABLED', false),
    dryRun: getRuntimeBool('SUBSCRIPTION_VECTOR_DRY_RUN', true),
    url: getRuntimeEnv('EMBEDDING_API_URL').trim(),
    key: getRuntimeEnv('EMBEDDING_API_KEY').trim(),
    model: getRuntimeEnv('EMBEDDING_MODEL', 'Qwen/Qwen3-Embedding-8B').trim(),
    threshold: getRuntimeEnvFloat(
      'SUBSCRIPTION_VECTOR_THRESHOLD',
      0.5,
      0.3,
      0.95,
    ),
    maxPerDeal: getRuntimeEnvNumber('SUBSCRIPTION_VECTOR_MAX_PER_DEAL', 20, 1, 100),
    stopwords,
  };
}

/** 兼容 base 地址与完整地址两种写法。 */
function resolveEndpoint(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return /\/embeddings$/i.test(trimmed) ? trimmed : `${trimmed}/embeddings`;
}

function normalizeVector(values: number[]): Float32Array {
  let sum = 0;
  for (const value of values) sum += value * value;
  const length = Math.sqrt(sum) || 1;
  const result = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    result[i] = values[i] / length;
  }
  return result;
}

export function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function bufferToVector(buffer: Buffer): Float32Array {
  return new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    Math.floor(buffer.byteLength / 4),
  );
}

async function requestBatch(
  texts: string[],
  config: EmbeddingConfig,
): Promise<Float32Array[]> {
  const response = await fetch(resolveEndpoint(config.url), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({ model: config.model, input: texts }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `embedding HTTP ${response.status} ${detail.slice(0, 200)}`,
    );
  }

  const payload = (await response.json()) as {
    data?: { embedding?: number[]; index?: number }[];
  };
  const data = payload.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(`embedding 返回条数异常：${data?.length ?? 0}/${texts.length}`);
  }

  const ordered = [...data].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  return ordered.map((item) => {
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw new Error('embedding 返回空向量');
    }
    return normalizeVector(item.embedding);
  });
}

/**
 * 批量计算向量。
 * 未配置地址或密钥、接口持续失败时返回 null，调用方自动退回字符串匹配。
 */
export async function embedTexts(
  texts: string[],
  config: EmbeddingConfig = getEmbeddingConfig(),
): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];
  if (!config.url || !config.key) return null;

  const results: Float32Array[] = [];
  for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
    const batch = texts.slice(offset, offset + BATCH_SIZE);
    let attempt = 0;
    let vectors: Float32Array[] | null = null;

    while (attempt <= MAX_RETRIES && vectors === null) {
      try {
        vectors = await requestBatch(batch, config);
      } catch (error) {
        attempt += 1;
        console.warn(
          `[embedding] 第 ${attempt} 次请求失败（${batch.length} 条）：`,
          error instanceof Error ? error.message : error,
        );
        if (attempt > MAX_RETRIES) return null;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
      }
    }

    if (vectors === null) return null;
    results.push(...vectors);
  }

  return results;
}
