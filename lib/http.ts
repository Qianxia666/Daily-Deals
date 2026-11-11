import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { Dispatcher } from 'undici';
import { getRuntimeEnvRaw } from './runtime-settings';
import { SOURCE_TIMEOUT_MS } from './sources';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 DailyDeals/1.0';

export class HttpError extends Error {
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

let cachedProxyUrl: string | null = null;
let cachedDispatcher: Dispatcher | null = null;

/**
 * Node 内置 fetch 不会读取 HTTP_PROXY/HTTPS_PROXY，必须显式传入 dispatcher。
 * 支持 OUTBOUND_PROXY 或标准的 HTTPS_PROXY/HTTP_PROXY（仅 http/https 代理）。
 */
export function getOutboundDispatcher(): Dispatcher | null {
  const stored = getRuntimeEnvRaw('OUTBOUND_PROXY');
  const proxyUrl =
    (stored && stored.trim()) ||
    (getRuntimeEnvRaw('HTTPS_PROXY') ?? '').trim() ||
    (getRuntimeEnvRaw('HTTP_PROXY') ?? '').trim() ||
    process.env.https_proxy?.trim() ||
    process.env.http_proxy?.trim() ||
    '';

  if (!proxyUrl) return null;
  if (cachedDispatcher && cachedProxyUrl === proxyUrl) return cachedDispatcher;

  try {
    cachedDispatcher = new ProxyAgent(proxyUrl);
    cachedProxyUrl = proxyUrl;
    return cachedDispatcher;
  } catch (error) {
    console.error(
      `[http] 代理地址无效（${proxyUrl}）：`,
      error instanceof Error ? error.message : error,
    );
    cachedDispatcher = null;
    cachedProxyUrl = null;
    return null;
  }
}

export interface RequestOptions {
  method?: string;
  headers?: HeadersInit;
  body?: string;
}

/** 通用请求，返回原始 Response；由调用方决定如何处理状态码与响应体。 */
export async function request(
  url: string,
  init: RequestOptions = {},
  timeoutMs: number = SOURCE_TIMEOUT_MS,
) {
  const headers = new Headers(init.headers);
  if (!headers.has('User-Agent')) headers.set('User-Agent', USER_AGENT);
  if (!headers.has('Accept')) {
    headers.set(
      'Accept',
      'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, text/plain;q=0.8, */*;q=0.7',
    );
  }
  if (!headers.has('Accept-Language')) {
    headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
  }

  const headerRecord: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerRecord[key] = value;
  });

  const dispatcher = getOutboundDispatcher();
  return undiciFetch(url, {
    method: init.method ?? 'GET',
    headers: headerRecord,
    body: init.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    ...(dispatcher ? { dispatcher } : {}),
  });
}

function normalizeCharset(label: string): string {
  const value = label.trim().toLowerCase();
  if (
    value === 'gbk' ||
    value === 'gb2312' ||
    value === 'gb18030' ||
    value === 'x-gbk'
  ) {
    return 'gb18030';
  }
  if (value === 'big5') return 'big5';
  return 'utf-8';
}

/** 根据响应头与 XML 声明识别编码，兼容 52pojie 等 GBK 站点。 */
function detectCharset(contentType: string, head: string): string {
  const fromHeader = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  if (fromHeader) return normalizeCharset(fromHeader);

  const fromXml = head.match(/encoding=["']([\w-]+)["']/i)?.[1];
  return fromXml ? normalizeCharset(fromXml) : 'utf-8';
}

export async function fetchText(
  url: string,
  init: { headers?: HeadersInit } = {},
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): Promise<string> {
  const response = await request(url, init, timeoutMs);
  if (!response.ok) {
    throw new HttpError(response.status);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const head = buffer.subarray(0, 300).toString('latin1');
  const charset = detectCharset(
    response.headers.get('content-type') ?? '',
    head,
  );

  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

export function describeFetchError(
  error: unknown,
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): string {
  if (error instanceof HttpError) return `HTTP ${error.status}`;

  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return `请求超时（${Math.round(timeoutMs / 1000)}s）`;
  }

  if (error instanceof Error) {
    if (error.message === 'fetch failed') {
      const cause = (error as Error & {
        cause?: { code?: string; message?: string };
      }).cause;
      const detail = cause?.code ?? cause?.message;
      return detail ? `网络请求失败（${detail}）` : '网络请求失败';
    }
    return error.message || '抓取失败';
  }

  return '未知错误';
}
