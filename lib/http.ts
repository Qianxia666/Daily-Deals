import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ProxyAgent, Agent, fetch as undiciFetch } from 'undici';
import type { Dispatcher } from 'undici';
import { getRuntimeEnvRaw } from './runtime-settings';
import { SOURCE_TIMEOUT_MS } from './sources';

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 4;

/** 私有/保留地址段；抓取源与正文链接均来自外部输入，必须默认拒绝。 */
const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.0\.0\./,
  /^192\.0\.2\./,
  /^192\.168\./,
  /^198\.(18|19)\./,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^22[4-9]\./,
  /^2[3-5]\d\./,
];

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE_V4.some((pattern) => pattern.test(ip));
  if (isIP(ip) === 6) {
    const value = ip.toLowerCase();
    if (value === '::1' || value === '::') return true;
    if (value.startsWith('fc') || value.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(value)) return true;
    if (value.startsWith('ff')) return true;
    // WHATWG URL 会把 IPv4 映射地址规范化为 ::ffff:xxxx:xxxx（十六进制），
    // 仅按点分十进制判断会漏掉 http://[::ffff:7f00:1] 这类内网地址。
    const mapped = value.match(
      /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
    );
    if (mapped) {
      const hi = Number.parseInt(mapped[1], 16);
      const lo = Number.parseInt(mapped[2], 16);
      return isPrivateIp(
        `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`,
      );
    }
    return false;
  }
  return false;
}

function allowPrivateFetch(): boolean {
  return process.env.ALLOW_PRIVATE_FETCH === '1';
}

/** 校验出站 URL：协议、主机名、解析后的全部 A/AAAA 地址。 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('不支持的协议');
  }
  if (allowPrivateFetch()) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('目标主机不允许');
  }

  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => isPrivateIp(item.address))) {
    throw new Error('目标地址位于内网或保留网段');
  }
  return url;
}

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

  const previous = cachedDispatcher;
  try {
    cachedDispatcher = new ProxyAgent(proxyUrl);
    cachedProxyUrl = proxyUrl;
    if (previous) void previous.close?.();
    return cachedDispatcher;
  } catch (error) {
    console.error(
      `[http] 代理地址无效（${redactProxy(proxyUrl)}）：`,
      error instanceof Error ? error.message : error,
    );
    cachedDispatcher = null;
    cachedProxyUrl = null;
    return null;
  }
}

function redactProxy(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'invalid-proxy';
  }
}

let cachedPinnedAgent: Agent | null = null;

/**
 * 无代理时使用的出站 Agent：连接阶段自行解析域名并再次校验地址，
 * 消除「assertPublicUrl 校验后、真正建连前重新解析」的 DNS 重绑定窗口。
 * 使用代理时解析发生在代理侧，这里无法固定，只能依赖建连前的预校验。
 */
function getPinnedAgent(): Agent {
  if (cachedPinnedAgent) return cachedPinnedAgent;
  cachedPinnedAgent = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true, verbatim: true })
          .then((addresses) => {
            const safe = addresses.filter((item) => !isPrivateIp(item.address));
            if (safe.length === 0 || safe.length !== addresses.length) {
              const error: NodeJS.ErrnoException = new Error(
                '目标地址位于内网或保留网段',
              );
              error.code = 'EADDRNOTAVAIL';
              callback(error, '', 0);
              return;
            }
            if (options.all) {
              callback(null, safe);
              return;
            }
            callback(null, safe[0].address, safe[0].family);
          })
          .catch((error: NodeJS.ErrnoException) => callback(error, '', 0));
      },
    },
  });
  return cachedPinnedAgent;
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
  let headers = new Headers(init.headers);
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

  let headerRecord: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerRecord[key] = value;
  });

  const dispatcher = getOutboundDispatcher();
  // 无代理时使用连接级校验的 Agent，避免校验与实际解析之间的重绑定。
  const requestDispatcher =
    dispatcher ?? (allowPrivateFetch() ? null : getPinnedAgent());
  const deadline = Date.now() + timeoutMs;
  let current = await assertPublicUrl(url);
  let currentMethod = init.method ?? 'GET';
  let currentBody = init.body;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DOMException('请求超时', 'TimeoutError');

    const response = await undiciFetch(current, {
      method: currentMethod,
      headers: headerRecord,
      body: currentBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(remaining),
      ...(requestDispatcher ? { dispatcher: requestDispatcher } : {}),
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;

    const next = await assertPublicUrl(new URL(location, current).toString());
    await response.body?.cancel();

    if (next.origin !== current.origin) {
      const nextHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(headerRecord)) {
        if (/^(authorization|cookie|proxy-authorization)$/i.test(key)) continue;
        nextHeaders[key] = value;
      }
      headerRecord = nextHeaders;
    }

    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && currentMethod === 'POST')
    ) {
      currentMethod = 'GET';
      currentBody = undefined;
      delete headerRecord['content-type'];
      delete headerRecord['content-length'];
    }

    current = next;
  }

  throw new Error('重定向次数过多');
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

/** 按响应头与 XML 声明解码响应体，供需要自行处理状态码的调用方复用。 */
export async function readResponseText(
  response: Awaited<ReturnType<typeof request>>,
): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_TEXT_BYTES) {
    await response.body?.cancel();
    throw new Error('响应体过大');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TEXT_BYTES) {
        await reader.cancel();
        throw new Error('响应体过大');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = Buffer.concat(chunks);
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

export async function fetchText(
  url: string,
  init: { headers?: HeadersInit } = {},
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): Promise<string> {
  const response = await request(url, init, timeoutMs);
  if (!response.ok) {
    throw new HttpError(response.status);
  }
  return readResponseText(response);
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
    if (/目标|协议|重定向|响应体过大/.test(error.message)) {
      return error.message;
    }
    return '抓取失败';
  }

  return '未知错误';
}
