import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { User } from '@prisma/client';
import { prisma } from './db.ts';

const SESSION_COOKIE = 'tatos_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const stored_buf = Buffer.from(hash, 'hex');
  if (candidate.length !== stored_buf.length) return false;
  return timingSafeEqual(candidate, stored_buf);
}

export async function createSession(userId: number): Promise<string> {
  const id = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({ data: { id, userId, expiresAt } });
  return id;
}

export async function destroySession(id: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id } });
}

export async function getUserFromSession(sessionId: string | undefined): Promise<User | null> {
  if (!sessionId) return null;
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}

export type AppEnv = {
  Variables: {
    user: User | null;
  };
};

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const sessionId = getCookie(c, SESSION_COOKIE);
  const user = await getUserFromSession(sessionId);
  c.set('user', user);
  await next();
}

export async function requireAuth(c: Context<AppEnv>, next: Next) {
  if (!c.get('user')) return c.redirect('/login');
  await next();
}

export function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: process.env.NODE_ENV === 'production',
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
