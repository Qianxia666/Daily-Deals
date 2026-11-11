import { listPendingBodyDeals, markDealBodyFetched, saveDealBody } from './db';
import type { PendingBodyDeal } from './db';
import { extractBody, titleFromBody } from './fetchers/body';
import { fetchText, HttpError } from './http';
import { SOURCE_TIMEOUT_MS } from './sources';

const RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000;
const FAILURE_PAUSE_MS = 30 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 5;
const IDLE_DELAY_MS = 30_000;

const runtime = globalThis as typeof globalThis & {
  __bodyBackfillStarted?: boolean;
};

/** 来源被限流或连续失败后的暂停截止时间。 */
const pausedUntil = new Map<string, number>();
const failures = new Map<string, number>();

function headersFor(kind: string, link: string): Record<string, string> {
  if (kind === 'xianbao') {
    // 线报酷使用 Cookie 校验通行，详情页同样需要。
    return {
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      Referer: `${new URL(link).origin}/`,
      Cookie: 'xb_hpass=1',
    };
  }

  return { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
}

/** 不同类型来源的请求间隔：线报酷站点更脆弱，放慢一些。 */
function delayFor(kind: string): number {
  return kind === 'xianbao'
    ? 3_000 + Math.random() * 2_000
    : 1_500 + Math.random() * 2_000;
}

type BodyResult =
  | { kind: 'ok'; title: string; text: string }
  | { kind: 'empty' }
  | { kind: 'rate' }
  | { kind: 'error' };

async function fetchBody(deal: PendingBodyDeal): Promise<BodyResult> {
  try {
    const html = await fetchText(
      deal.link,
      { headers: headersFor(deal.kind, deal.link) },
      SOURCE_TIMEOUT_MS,
    );

    const text = extractBody(deal.kind, html);
    if (!text) return { kind: 'empty' };

    return {
      kind: 'ok',
      title: titleFromBody(text) ?? `线报 ${deal.id}`,
      text,
    };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 404 || error.status === 410) return { kind: 'empty' };
      if (error.status === 403 || error.status === 429) return { kind: 'rate' };
    }
    return { kind: 'error' };
  }
}

/**
 * 补一条正文。返回是否处理了这一条，供调度器决定下一次的等待时间。
 * 全局串行，保证对镜像站和线报站都足够温和。
 */
export async function backfillOneBody(): Promise<boolean> {
  // 取一小批而不是一条：某个来源处于暂停期时不应拖住其他来源。
  const candidates = listPendingBodyDeals(10);
  const next = candidates.find(
    (deal) => Date.now() >= (pausedUntil.get(deal.source) ?? 0),
  );
  if (!next) return false;

  const result = await fetchBody(next);

  if (result.kind === 'ok') {
    // 线报酷的列表标题更准确，正文只补充内容；微博镜像的标题来自摘要，用正文首行更清晰。
    saveDealBody(
      next.id,
      next.kind === 'xianbao' ? null : result.title,
      result.text,
    );
    failures.delete(next.source);
    return true;
  }

  if (result.kind === 'empty') {
    // 详情页已删除或解析不到正文：标记为已尝试，保留现有标题与摘要。
    markDealBodyFetched(next.id);
    failures.delete(next.source);
    return true;
  }

  if (result.kind === 'rate') {
    pausedUntil.set(next.source, Date.now() + RATE_LIMIT_PAUSE_MS);
    console.warn(`[body] ${next.source} 被限流，暂停 1 小时`);
    return true;
  }

  const count = (failures.get(next.source) ?? 0) + 1;
  failures.set(next.source, count);
  if (count >= MAX_CONSECUTIVE_FAILURES) {
    // 连续失败说明这条详情页本身有问题，标记已尝试，避免永远卡在队首。
    markDealBodyFetched(next.id);
    pausedUntil.set(next.source, Date.now() + FAILURE_PAUSE_MS);
    failures.delete(next.source);
    console.warn(`[body] ${next.source} 连续失败 ${count} 次，暂停 30 分钟`);
  }

  return false;
}

/** 启动常驻的正文补全循环：有活时按来源节奏逐条抓，没活时半分钟探一次。 */
export function startBodyBackfillWorker(): void {
  if (runtime.__bodyBackfillStarted) return;
  runtime.__bodyBackfillStarted = true;

  const loop = async () => {
    let processed = false;
    let kind = '';

    try {
      const [next] = listPendingBodyDeals(1);
      kind = next?.kind ?? '';
      processed = await backfillOneBody();
    } catch (error) {
      console.error('[body] 正文补全失败:', error);
    }

    setTimeout(
      () => {
        void loop();
      },
      processed && kind ? delayFor(kind) : IDLE_DELAY_MS,
    );
  };

  setTimeout(() => {
    void loop();
  }, 8_000);
}
