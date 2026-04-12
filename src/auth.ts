import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from './env.ts';
import { randomHex } from './crypto.ts';

const SESSION_COOKIE = 'tatos_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export type UserRow = {
  id: number;
  email: string;
  password_hash: string;
  studio_name: string;
  booking_slug: string;
  deposit_cents: number;
  plan: string;
  stripe_customer_id: string | null;
  created_at: string;
};

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserRow | null;
  };
};

export async function createSession(db: D1Database, userId: number): Promise<string> {
  const id = randomHex(32);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(id, userId, expiresAt).run();
  return id;
}

export async function destroySession(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

export async function getUserFromSession(db: D1Database, sessionId: string | undefined): Promise<UserRow | null> {
  if (!sessionId) return null;
  const row = await db
    .prepare(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?',
    )
    .bind(sessionId, Date.now())
    .first<UserRow>();
  return row ?? null;
}

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const sessionId = getCookie(c, SESSION_COOKIE);
  const user = await getUserFromSession(c.env.DB, sessionId);
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
    secure: true,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
