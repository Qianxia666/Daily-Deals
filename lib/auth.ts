import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import type { NextRequest, NextResponse } from 'next/server';
import {
  createUserSession,
  deleteUserSession,
  getUserBySession,
  pruneExpiredSessions,
} from './db';
import type { AccountUser } from './types';

const scryptAsync = promisify(scrypt);

export const SESSION_COOKIE = 'dd_session';
const SESSION_DAYS = 30;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 120;
}

export function isValidPassword(value: string): boolean {
  return value.length >= 6 && value.length <= 72;
}

export async function hashPassword(
  password: string,
): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return { hash: derived.toString('hex'), salt };
}

export async function verifyPasswordHash(
  password: string,
  hash: string,
  salt: string,
): Promise<boolean> {
  try {
    const derived = (await scryptAsync(password, salt, 64)) as Buffer;
    const expected = Buffer.from(hash, 'hex');
    if (expected.length !== derived.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionStart {
  token: string;
  expiresAt: string;
}

export function startSession(userId: number): SessionStart {
  pruneExpiredSessions();

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  createUserSession(hashToken(token), userId, expiresAt);
  return { token, expiresAt };
}

export async function getCurrentUser(): Promise<AccountUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value ?? '';
  if (!token) return null;
  return getUserBySession(hashToken(token));
}

export async function clearCurrentSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value ?? '';
  if (token) deleteUserSession(hashToken(token));
}

/** 登录/注册成功后写入 HttpOnly 会话 Cookie。 */
export function applySessionCookie(
  response: NextResponse,
  session: SessionStart,
  request: NextRequest,
): void {
  response.cookies.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
    secure: request.nextUrl.protocol === 'https:',
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
