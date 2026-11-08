import {
  listSources,
  listSourceStatus,
  getLastFetchedAt,
  pruneDeals,
  resetNewFlags,
  saveFetchRun,
  upsertDeals,
  type SourceRunStatus,
  type StoredSource,
} from './db';
import { fetchSource } from './fetchers';
import { describeFetchError } from './http';
import { enrichPendingDeals } from './llm';
import { runBackupIfDue } from './backup';
import { sendFeishuAlert } from './alerts';
import {
  getGlobalIntervalMinutes,
  getRuntimeEnvNumber,
} from './runtime-settings';
import { SOURCE_TIMEOUT_MS } from './sources';
import type { RawDeal } from './fetchers/types';

const failureCounts = new Map<string, number>();

const runtime = globalThis as typeof globalThis & {
  __dailyDealsSchedulerStarted?: boolean;
  __dailyDealsFetching?: boolean;
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
  const targets = sourceIds
    ? all.filter((source) => sourceIds.includes(source.id))
    : all;

  if (targets.length === 0) return;

  runtime.__dailyDealsFetching = true;

  try {
    // 只重置本轮来源的新增标记，避免部分来源轮次把其他来源的新标记清掉。
    resetNewFlags(targets.map((source) => source.id));

    const outcomes = await Promise.all(targets.map(fetchOne));
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
        void sendFeishuAlert(`source:${status.source}`, '【来源抓取失败】', [
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

/** 计算当前到期的来源：未抓取过，或距上次抓取已超过该来源的刷新间隔。 */
function dueSources(): StoredSource[] {
  const statusMap = new Map(
    listSourceStatus().map((status) => [status.source, status.fetchedAt]),
  );
  const globalMinutes = getGlobalIntervalMinutes();
  const now = Date.now();

  return listSources().filter((source) => {
    const last = statusMap.get(source.id);
    if (!last) return true;

    const timestamp = Date.parse(last);
    if (Number.isNaN(timestamp)) return true;

    const minutes = source.refreshMinutes ?? globalMinutes;
    return now - timestamp >= minutes * 60_000;
  });
}

/**
 * 服务启动即注册调度循环。
 * 每 60 秒检查一次各来源是否到期，因此后台修改全局/单来源刷新间隔后无需重启。
 */
export function startScheduler(): void {
  if (runtime.__dailyDealsSchedulerStarted) return;
  runtime.__dailyDealsSchedulerStarted = true;

  const tick = () => {
    runBackupIfDue();

    const due = dueSources();
    if (due.length === 0) return;
    void runFetchRound(due.map((source) => source.id));
  };

  setTimeout(tick, 2_500);
  setInterval(tick, 60_000);

  // 每 5 分钟补一次 AI 摘要，覆盖上次进程中断或新入库的条目。
  setInterval(() => {
    void enrichPendingDeals();
  }, 5 * 60_000);

  const globalMinutes = getGlobalIntervalMinutes();
  const lastFetchedAt = getLastFetchedAt();
  console.log(
    `[scheduler] global=${globalMinutes}min tick=60s last=${
      lastFetchedAt ?? 'never'
    }`,
  );
}
