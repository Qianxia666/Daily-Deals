import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { getRuntimeEnvRaw } from './runtime-settings';

export const ADMIN_COOKIE = 'dd_admin';
const TOKEN_PAYLOAD = 'daily-deals-admin-v1';
// 管理员会话有效期，与登录时写入的 cookie maxAge 保持一致。
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function adminPassword(): string {
  return (getRuntimeEnvRaw('ADMIN_PASSWORD') ?? '').trim();
}

export function adminConfigured(): boolean {
  return Boolean(adminPassword());
}

function sessionSecret(): string {
  return (
    (getRuntimeEnvRaw('ADMIN_SESSION_SECRET') ?? '').trim() ||
    adminPassword()
  );
}

export function createSessionToken(): string {
  const secret = sessionSecret();
  if (!secret) return '';
  const issuedAt = Date.now();
  const signature = createHmac('sha256', secret)
    .update(`${TOKEN_PAYLOAD}:${issuedAt}`)
    .digest('hex');
  return `${issuedAt}.${signature}`;
}

/** 校验签名与签发时间，避免 token 泄露后永久有效。 */
function verifySessionToken(token: string): boolean {
  const secret = sessionSecret();
  if (!secret) return false;

  const separator = token.indexOf('.');
  if (separator <= 0) return false;
  const issuedAt = Number(token.slice(0, separator));
  const signature = token.slice(separator + 1);
  if (!Number.isFinite(issuedAt) || signature.length === 0) return false;
  if (Date.now() - issuedAt > SESSION_TTL_MS) return false;

  const expected = createHmac('sha256', secret)
    .update(`${TOKEN_PAYLOAD}:${issuedAt}`)
    .digest('hex');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function verifyPassword(input: string): boolean {
  const expected = adminPassword();
  if (!expected || !input) return false;

  const actualHash = createHash('sha256').update(input).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export async function isAdmin(): Promise<boolean> {
  if (!adminConfigured()) return false;

  const store = await cookies();
  const token = store.get(ADMIN_COOKIE)?.value ?? '';
  if (!token) return false;
  return verifySessionToken(token);
}
