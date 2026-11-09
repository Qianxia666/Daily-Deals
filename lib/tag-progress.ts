/**
 * 标签补全的运行时进度。放在 globalThis 上，避免生产环境多入口打包后
 * API 路由与调度器各自持有一份状态。
 */
export interface TagRunProgress {
  running: boolean;
  processed: number;
  batchTotal: number;
  tagged: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

const EMPTY: TagRunProgress = {
  running: false,
  processed: 0,
  batchTotal: 0,
  tagged: 0,
  failed: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
};

const state = globalThis as typeof globalThis & {
  __dailyDealsTagRun?: TagRunProgress;
};

export function getTagRunProgress(): TagRunProgress {
  if (!state.__dailyDealsTagRun) {
    state.__dailyDealsTagRun = { ...EMPTY };
  }
  return state.__dailyDealsTagRun;
}

export function updateTagRunProgress(
  patch: Partial<TagRunProgress>,
): TagRunProgress {
  const current = getTagRunProgress();
  Object.assign(current, patch);
  return current;
}

export function resetTagRunProgress(total: number): TagRunProgress {
  return updateTagRunProgress({
    running: true,
    processed: 0,
    batchTotal: total,
    tagged: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  });
}
