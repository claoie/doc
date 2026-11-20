import { timingSafeEqual } from "node:crypto";
import { token } from "common/ids";
import { config } from "server/config";
import { sql } from "server/db";
import { unauthorized, type Context } from "./http";
import { RECHECK_MS, endSession, recheckSession } from "./sso";
import type { UserRow } from "./users";

export type AuthUser = UserRow;

export interface AuthSession {
  id: string;
  /** The identity provider's session and refresh token, on a session started through single sign-on. */
  authSid: string | null;
  authRefreshToken: string | null;
}

/** The identity provider's side of a session started through single sign-on. */
export interface ProviderSession {
  sid: string;
  refreshToken: string | null;
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
export const signIn = async (ctx: Context, userId: string, provider?: ProviderSession) => {
  const value = token();
  const userAgent = (ctx.req.headers.get("user-agent") ?? "").slice(0, 500) || null;
  const [session] = await sql`
    INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at, auth_sid, auth_refresh_token, auth_recheck_at)
    VALUES (${userId}, ${hashToken(value)}, ${userAgent}, ${ctx.ip || null}, ${new Date(Date.now() + SESSION_MS)},
      ${provider?.sid ?? null}, ${provider?.refreshToken ?? null}, ${provider ? new Date(Date.now() + RECHECK_MS) : null})
    RETURNING id`;
  await sql`UPDATE users SET last_login_at = now() WHERE id = ${userId}`;
  ctx.cookies.push(sessionCookie(value));
  ctx.session = { id: session.id, authSid: provider?.sid ?? null, authRefreshToken: provider?.refreshToken ?? null };
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

/**
 * The user of a session row joined with its user, after asking the identity
 * provider again when a single sign-on session's re-check is due; null when
 * that ended the session.
 */
const sessionUser = async (row: Record<string, unknown>): Promise<AuthUser | null> => {
  const { session_id, session_last_seen_at, session_auth_sid, session_auth_refresh_token, session_auth_recheck_at, ...user } = row;
  const recheckAt = session_auth_recheck_at ? new Date(session_auth_recheck_at as Date) : null;
  // Only sessions started through the provider have a re-check. A password
  // session ends while single sign-on is the only way in, and also once its
  // account is linked to the provider, which then governs it: nothing would
  // ever re-check it, so it could outlive the provider disabling the person.
  // A provider's session ends once single sign-on is turned off, since
  // nothing can re-check it either.
  const linked = (user as { auth_sub?: string | null }).auth_sub != null;
  if (recheckAt ? config.sso === null : !config.localLogin || (config.sso !== null && linked)) {
    await endSession(session_id as string);
    return null;
  }
  if (!recheckAt || recheckAt.getTime() > Date.now()) return user as unknown as AuthUser;
  const due = { sessionId: session_id as string, refreshToken: (session_auth_refresh_token as string | null) ?? null, recheckAt };
  return recheckSession(due, user as unknown as AuthUser);
};

/** Resolves the session cookie of a request to an active user. */
export const authenticate = async (req: Request): Promise<SessionLookup | null> => {
  const value = readCookie(req, COOKIE);
  if (!value || value.length > 100) return null;
  const [row] = await sql`
    SELECT s.id AS session_id, s.last_seen_at AS session_last_seen_at, s.auth_sid AS session_auth_sid,
      s.auth_refresh_token AS session_auth_refresh_token, s.auth_recheck_at AS session_auth_recheck_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hashToken(value)} AND s.expires_at > now() AND u.deactivated_at IS NULL`;
  if (!row) return null;
  const user = await sessionUser(row);
  if (!user) return null;
  const { session_id, session_last_seen_at, session_auth_sid, session_auth_refresh_token } = row;
  let refreshedCookie: string | null = null;
  if (Date.now() - new Date(session_last_seen_at).getTime() > SLIDE_AFTER_MS) {
    await sql`
      UPDATE sessions SET last_seen_at = now(), expires_at = ${new Date(Date.now() + SESSION_MS)}
      WHERE id = ${session_id}`;
    refreshedCookie = sessionCookie(value);
  }
  const session: AuthSession = { id: session_id, authSid: session_auth_sid, authRefreshToken: session_auth_refresh_token };
  return { user, session, refreshedCookie };
};

/**
 * Of these sessions, the ones still signed in: not ended or expired, their
 * user active, and for single sign-on, still allowed by the provider when a
 * re-check is due.
 */
export const liveSessions = async (sessionIds: readonly string[]): Promise<Set<string>> => {
  if (sessionIds.length === 0) return new Set();
  const rows: Record<string, unknown>[] = await sql`
    SELECT s.id AS session_id, s.auth_refresh_token AS session_auth_refresh_token, s.auth_recheck_at AS session_auth_recheck_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ANY(${sql.array([...sessionIds], "uuid")}) AND s.expires_at > now() AND u.deactivated_at IS NULL`;
  const users = await Promise.all(rows.map(sessionUser));
  return new Set(rows.filter((_, i) => users[i]).map((row) => row.session_id as string));
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
