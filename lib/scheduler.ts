import {
  backfillRecentDeals,
  listKeywordsMissingExpansion,
  listSources,
  listSourceStatus,
  getLastFetchedAt,
  pruneDeals,
  resetNewFlags,
  saveFetchRun,
  saveKeywordExpansion,
  skipStalePendingDeliveries,
  upsertDeals,
  type SourceRunStatus,
  type StoredSource,
} from './db';
import { fetchSource } from './fetchers';
import { describeFetchError } from './http';
import {
  enrichPendingDeals,
  expandKeywordsWithAi,
  getAiModelName,
} from './llm';
import { runBackupIfDue } from './backup';
import { sendAdminAlert } from './alerts';
import {
  deliverPending,
  deliverPendingDigests,
  runScheduledDigests,
} from './delivery';
import { startBodyBackfillWorker } from './body-backfill';
import {
  getGlobalIntervalMinutes,
  getRuntimeEnvNumber,
  getRuntimeEnvRaw,
} from './runtime-settings';
import { SOURCE_TIMEOUT_MS } from './sources';
import { getEmbeddingConfig } from './embeddings';
import { embedPendingDeals, syncKeywordVectors } from './vector-match';
import type { RawDeal } from './fetchers/types';

const failureCounts = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const runtime = globalThis as typeof globalThis & {
  __dailyDealsSchedulerStarted?: boolean;
  __dailyDealsFetching?: boolean;
  __dailyDealsVectorBusy?: boolean;
  __dailyDealsKeywordBusy?: boolean;
};

export function isFetching(): boolean {
  return runtime.__dailyDealsFetching === true;
}

interface FetchOutcome {
  status: SourceRunStatus;
  deals: RawDeal[];
}

async function fetchOne(source: StoredSource): Promise<FetchOutcome> {
  try {
    const deals = await fetchSource(source);
    return {
      status: {
        source: source.id,
        ok: true,
        count: deals.length,
        error: null,
      },
      deals,
    };
  } catch (error) {
    return {
      status: {
        source: source.id,
        ok: false,
        count: 0,
        error: describeFetchError(error, SOURCE_TIMEOUT_MS),
      },
      deals: [],
    };
  }
}

/**
 * 执行一轮抓取。
 * 传入 sourceIds 时只抓取指定来源，否则抓取全部启用来源。
 * 各来源并行且独立失败；单个来源超时或报错不会影响其他来源。
 */
export async function runFetchRound(sourceIds?: string[]): Promise<void> {
  if (runtime.__dailyDealsFetching) return;

  const all = listSources();
  // 停用/已移除的来源停止抓取，并清空其失败计数，避免恢复后立刻误报告警。
  for (const source of all) {
    if (source.state !== 'active') failureCounts.delete(source.id);
  }
  const visible = all.filter((source) => source.state === 'active');
  const targets = sourceIds
    ? visible.filter((source) => sourceIds.includes(source.id))
    : visible;

  if (targets.length === 0) return;

  runtime.__dailyDealsFetching = true;

  try {
    // 只重置本轮来源的新增标记，避免部分来源轮次把其他来源的新标记清掉。
    resetNewFlags(targets.map((source) => source.id));

    const outcomes = await Promise.all(
      targets.map(async (source) => {
        // 同一轮内随机错开建连时间，避免多个来源在同一秒并发请求。
        if (targets.length > 1) {
          await sleep(Math.floor(Math.random() * 2_500));
        }
        return fetchOne(source);
      }),
    );
    const statuses: SourceRunStatus[] = [];

    for (const outcome of outcomes) {
      if (!outcome.status.ok) {
        statuses.push(outcome.status);
        continue;
      }

      try {
        upsertDeals(outcome.deals);
        statuses.push(outcome.status);
      } catch (error) {
        statuses.push({
          source: outcome.status.source,
          ok: false,
          count: 0,
          error: describeFetchError(error, SOURCE_TIMEOUT_MS),
        });
      }
    }

    pruneDeals();
    const fetchedAt = new Date().toISOString();
    saveFetchRun(statuses, fetchedAt);

    const okCount = statuses.filter((status) => status.ok).length;
    console.log(
      `[fetch] ${fetchedAt} sources=${okCount}/${statuses.length} fetched=${
        statuses.reduce((sum, status) => sum + status.count, 0)
      }`,
    );

    // 连续失败达到阈值时推送一次飞书告警，成功后自动清零。
    const threshold = getRuntimeEnvNumber('ALERT_FAILURE_THRESHOLD', 3, 1, 10);
    for (const status of statuses) {
      if (status.ok) {
        failureCounts.delete(status.source);
        continue;
      }

      const failures = (failureCounts.get(status.source) ?? 0) + 1;
      failureCounts.set(status.source, failures);

      if (failures === threshold) {
        const source = targets.find((item) => item.id === status.source);
        void sendAdminAlert(`source:${status.source}`, '【来源抓取失败】', [
          `来源：${source?.name ?? status.source}`,
          `连续失败：${failures} 轮`,
          `错误：${status.error ?? '未知错误'}`,
        ]);
      }
    }

    // 摘要在后台生成，不阻塞抓取与页面响应。
    void enrichPendingDeals();
  } catch (error) {
    console.error('[fetch] round failed:', error);
  } finally {
    runtime.__dailyDealsFetching = false;
  }
}

/** 手动触发全部来源；已有任务运行时返回 false。 */
export function triggerFetch(): boolean {
  if (runtime.__dailyDealsFetching) return false;
  void runFetchRound();
  return true;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 每个来源在到期时间上叠加 ±30 秒的确定性抖动。
 * 用「来源 + 上次抓取时间」做种子，同一轮里多次 tick 算出的偏移一致，
 * 进程重启也不会跳变。
 */
function sourceJitterMs(sourceId: string, lastFetchedAt: string): number {
  return (hashString(`${sourceId}:${lastFetchedAt}`) % 60_000) - 30_000;
}

/** 计算当前到期的来源：未抓取过，或已超过「刷新间隔 + 抖动」。 */
function dueSources(): StoredSource[] {
  const statusMap = new Map(
    listSourceStatus().map((status) => [status.source, status.fetchedAt]),
  );
  const globalMinutes = getGlobalIntervalMinutes();
  const now = Date.now();

  return listSources().filter((source) => source.state === 'active').filter((source) => {
    const last = statusMap.get(source.id);
    if (!last) return true;

    const timestamp = Date.parse(last);
    if (Number.isNaN(timestamp)) return true;

    const minutes = source.refreshMinutes ?? globalMinutes;
    return now >= timestamp + minutes * 60_000 + sourceJitterMs(source.id, last);
  });
}

/**
 * 服务启动即注册调度循环。
 * 每 15 秒检查一次各来源是否到期（每个来源再叠加 ±30 秒抖动），
 * 因此后台修改全局/单来源刷新间隔后无需重启。
 */
export function startScheduler(): void {
  if (runtime.__dailyDealsSchedulerStarted) return;
  runtime.__dailyDealsSchedulerStarted = true;

  const tick = () => {
    try {
      runBackupIfDue();

      const due = dueSources();
      if (due.length === 0) return;
      void runFetchRound(due.map((source) => source.id)).catch((error) => {
        console.error('[scheduler] 抓取轮次失败：', error);
      });
    } catch (error) {
      console.error('[scheduler] tick 失败：', error);
    }
  };

  setTimeout(tick, 2_500 + Math.random() * 57_500);
  setInterval(tick, 15_000);

  // 每 60 秒处理一次订阅推送、每日摘要与跨天清理。
  const deliveryTick = async () => {
    try {
      skipStalePendingDeliveries();
      await runScheduledDigests();
      await deliverPending();
      await deliverPendingDigests();
    } catch (error) {
      console.error('[scheduler] 投递调度失败：', error);
    }
  };
  setTimeout(() => {
    void deliveryTick();
  }, 6_000);
  setInterval(() => {
    void deliveryTick();
  }, 60_000);

  // 每 5 分钟补一次 AI 摘要，覆盖上次进程中断或新入库的条目。
  setInterval(() => {
    void enrichPendingDeals();
  }, 5 * 60_000);

  // 订阅向量：每 60 秒补齐关键词与文章向量，算完立即匹配。
  const vectorTick = async () => {
    if (runtime.__dailyDealsVectorBusy) return;
    const config = getEmbeddingConfig();
    if (!config.enabled) return;

    runtime.__dailyDealsVectorBusy = true;
    try {
      await syncKeywordVectors(config);
      await embedPendingDeals(config);
    } catch (error) {
      console.error('[vector] tick failed:', error);
    } finally {
      runtime.__dailyDealsVectorBusy = false;
    }
  };
  setTimeout(() => {
    void vectorTick();
  }, 20_000);
  setInterval(() => {
    void vectorTick();
  }, 60_000);

  // 表外订阅词：每 10 分钟检查一次，批量交给 AI 判断品类并补品牌/别名。
  const keywordTick = async () => {
    if (runtime.__dailyDealsKeywordBusy) return;
    runtime.__dailyDealsKeywordBusy = true;
    try {
      const missing = listKeywordsMissingExpansion(20);
      if (missing.length === 0) return;

      const results = await expandKeywordsWithAi(missing);
      const model = getAiModelName();
      if (!results) {
        // AI 不可用时先标记失败，24 小时后再试，避免空转。
        for (const keyword of missing) {
          saveKeywordExpansion(keyword, 'other', [], model, 'failed');
        }
        return;
      }

      const byKeyword = new Map(
        results.map((item) => [item.keyword.trim().toLowerCase(), item]),
      );
      let expanded = 0;
      for (const keyword of missing) {
        const result = byKeyword.get(keyword.trim().toLowerCase());
        if (result) {
          saveKeywordExpansion(
            keyword,
            result.kind,
            result.expansions,
            model,
            'ready',
          );
          if (result.expansions.length > 0) expanded += 1;
        } else {
          saveKeywordExpansion(keyword, 'other', [], model, 'failed');
        }
      }

      // 扩展补上之前抓到的文章不会自动重匹配，这里回扫最近 3 小时补齐。
      if (expanded > 0) {
        const created = backfillRecentDeals(180, {
          expand:
            (getRuntimeEnvRaw('SUBSCRIPTION_MATCH_EXPAND_ENABLED') ?? 'true') !==
            'false',
          minScore: getRuntimeEnvNumber(
            'SUBSCRIPTION_MATCH_MIN_SCORE',
            2,
            1,
            8,
          ),
        });
        console.log(
          `[keyword] ${expanded} 个词补齐扩展，回扫最近 3 小时，补入队 ${created} 条`,
        );
      }
    } catch (error) {
      console.error('[keyword] tick failed:', error);
    } finally {
      runtime.__dailyDealsKeywordBusy = false;
    }
  };
  setTimeout(() => {
    void keywordTick();
  }, 40_000);
  setInterval(() => {
    void keywordTick();
  }, 10 * 60_000);

  // 详情正文补全（微博镜像与线报酷）：串行慢速执行，不阻塞抓取。
  startBodyBackfillWorker();

  const globalMinutes = getGlobalIntervalMinutes();
  const lastFetchedAt = getLastFetchedAt();
  console.log(
    `[scheduler] global=${globalMinutes}min tick=15s jitter=±30s last=${
      lastFetchedAt ?? 'never'
    }`,
  );
}
