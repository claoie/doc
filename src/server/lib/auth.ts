import { timingSafeEqual } from "node:crypto";
import { token } from "common/ids";
import { config } from "server/config";
import { sql } from "server/db";
import { unauthorized, type Context } from "./http";
import type { UserRow } from "./users";

export type AuthUser = UserRow;

export interface AuthSession {
  id: string;
}

const COOKIE = "session";
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const SLIDE_AFTER_MS = 60 * 1000;

export const hashToken = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

export const sameHash = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const cookieAttributes = (maxAgeSeconds: number) =>
  `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${config.secureCookies ? "; Secure" : ""}`;

export const sessionCookie = (value: string) => `${COOKIE}=${value}; ${cookieAttributes(SESSION_MS / 1000)}`;
export const clearedSessionCookie = () => `${COOKIE}=; ${cookieAttributes(0)}`;

export const readCookie = (req: Request, name: string): string | null => {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
};

/** Starts a session for the user and queues its cookie on the response. */
export const signIn = async (ctx: Context, userId: string) => {
  const value = token();
  const userAgent = (ctx.req.headers.get("user-agent") ?? "").slice(0, 500) || null;
  const [session] = await sql`
    INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at)
    VALUES (${userId}, ${hashToken(value)}, ${userAgent}, ${ctx.ip || null}, ${new Date(Date.now() + SESSION_MS)})
    RETURNING id`;
  await sql`UPDATE users SET last_login_at = now() WHERE id = ${userId}`;
  ctx.cookies.push(sessionCookie(value));
  ctx.session = { id: session.id };
};

export const signOut = async (ctx: Context) => {
  if (ctx.session) await sql`DELETE FROM sessions WHERE id = ${ctx.session.id}`;
  ctx.cookies.push(clearedSessionCookie());
};

interface SessionLookup {
  user: AuthUser;
  session: AuthSession;
  /** Set when the session was extended and its cookie should be re-sent. */
  refreshedCookie: string | null;
}

/** Resolves the session cookie of a request to an active user. */
export const authenticate = async (req: Request): Promise<SessionLookup | null> => {
  const value = readCookie(req, COOKIE);
  if (!value || value.length > 100) return null;
  const [row] = await sql`
    SELECT s.id AS session_id, s.last_seen_at AS session_last_seen_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hashToken(value)} AND s.expires_at > now() AND u.deactivated_at IS NULL`;
  if (!row) return null;
  const { session_id, session_last_seen_at, ...user } = row;
  let refreshedCookie: string | null = null;
  if (Date.now() - new Date(session_last_seen_at).getTime() > SLIDE_AFTER_MS) {
    await sql`
      UPDATE sessions SET last_seen_at = now(), expires_at = ${new Date(Date.now() + SESSION_MS)}
      WHERE id = ${session_id}`;
    refreshedCookie = sessionCookie(value);
  }
  return { user: user as AuthUser, session: { id: session_id }, refreshedCookie };
};

export const requireUser = (ctx: Context): AuthUser => {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
};

export const revokeUserSessions = async (userId: string, exceptSessionId?: string) => {
  if (exceptSessionId) await sql`DELETE FROM sessions WHERE user_id = ${userId} AND id <> ${exceptSessionId}`;
  else await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
};

export const purgeExpiredSessions = async () => {
  await sql`DELETE FROM sessions WHERE expires_at < now()`;
  await sql`DELETE FROM user_tokens WHERE expires_at < now()`;
};
