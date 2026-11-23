import { NextResponse, type NextRequest } from 'next/server';

/**
 * 每个请求生成一次性 nonce 的 CSP。
 * Next.js 会从请求头里的 Content-Security-Policy 读取 nonce，
 * 并自动加到自己注入的内联启动脚本与样式上，因此无需脚本级 unsafe-inline。
 */
export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    // 组件里使用 style={{...}} 生成的内联样式属性无法带 nonce；
    // 样式属性不能执行脚本，单独放开比整体放开 style-src 更收敛。
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // 使用 Node.js 运行时：本项目依赖 better-sqlite3，Edge 构建会尝试打包它。
  runtime: 'nodejs',
  // 静态资源不需要每次都生成 nonce。
  matcher: ['/((?!_next/static|_next/image).*)'],
};
