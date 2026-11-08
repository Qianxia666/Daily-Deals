import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { getRuntimeEnvRaw } from './runtime-settings';

export const ADMIN_COOKIE = 'dd_admin';
const TOKEN_PAYLOAD = 'daily-deals-admin-v1';

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
  return createHmac('sha256', secret).update(TOKEN_PAYLOAD).digest('hex');
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
  const expected = createSessionToken();
  if (!token || !expected) return false;

  const tokenBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  if (tokenBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(tokenBuffer, expectedBuffer);
}
