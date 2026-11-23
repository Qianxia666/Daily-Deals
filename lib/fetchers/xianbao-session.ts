import { HttpError, readResponseText, request } from '../http';
import { SOURCE_TIMEOUT_MS } from '../sources';

/**
 * 线报酷会不定时返回 403 的 JS 跳转页，并同时下发一个随机名 cookie；
 * 带上该 cookie 重新请求即可通过。Node 的 fetch 不会自动保存 cookie，
 * 这里按站点域名缓存一份会话 cookie，供列表抓取与正文补全共用。
 */
const cookieJar = new Map<string, Map<string, string>>();

function jarFor(origin: string): Map<string, string> {
  let jar = cookieJar.get(origin);
  if (!jar) {
    jar = new Map();
    cookieJar.set(origin, jar);
  }
  return jar;
}

function headersWithCookies(
  origin: string,
  headers: Record<string, string>,
): Record<string, string> {
  const merged = new Map(jarFor(origin));
  if (!merged.has('xb_hpass')) merged.set('xb_hpass', '1');

  const cookie = [...merged].map(([name, value]) => `${name}=${value}`).join('; ');
  return { ...headers, Cookie: cookie };
}

/** 只取 name=value，忽略 expires/path 等属性；同名覆盖。 */
function absorbCookies(origin: string, setCookies: string[]): boolean {
  let changed = false;

  for (const raw of setCookies) {
    const pair = raw.split(';')[0]?.trim();
    if (!pair) continue;

    const eq = pair.indexOf('=');
    if (eq <= 0) continue;

    jarFor(origin).set(pair.slice(0, eq), pair.slice(eq + 1));
    changed = true;
  }

  return changed;
}

type FetchResponse = Awaited<ReturnType<typeof request>>;

function setCookiesOf(response: FetchResponse): string[] {
  const headers = response.headers as unknown as {
    getSetCookie?: () => string[];
  };
  const list = headers.getSetCookie?.() ?? [];
  if (list.length > 0) return list;

  const joined = response.headers.get('set-cookie');
  return joined ? [joined] : [];
}

/**
 * 请求线报酷页面。遇到 403 校验页时保存下发的 cookie 并重试一次，
 * 其他状态码仍按原逻辑抛出 HttpError。
 */
export async function fetchXianbaoText(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): Promise<string> {
  const origin = new URL(url).origin;

  let response = await request(
    url,
    { headers: headersWithCookies(origin, headers) },
    timeoutMs,
  );

  if (response.status === 403) {
    // 仅释放连接，不读取正文：403 校验页可能很大，读入内存没有意义。
    try {
      await response.body?.cancel();
    } catch {
      // 取消失败不影响后续重试。
    }

    if (absorbCookies(origin, setCookiesOf(response))) {
      response = await request(
        url,
        { headers: headersWithCookies(origin, headers) },
        timeoutMs,
      );
      absorbCookies(origin, setCookiesOf(response));
    }
  }

  if (!response.ok) throw new HttpError(response.status);

  return readResponseText(response);
}
