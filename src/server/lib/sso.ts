import type { WorkspaceRole } from "common/api-types";
import { config } from "server/config";
import { sql } from "server/db";
import { disconnectSessions, disconnectUser } from "server/realtime/hub";
import {
  InvalidGrant,
  InvalidToken,
  LoginError,
  Unavailable,
  createAuthClient,
  type AccessClaims,
  type AuthClient,
  type AuthEvent,
  type IdClaims,
} from "./auth-client";
import { HttpError } from "./http";
import { log } from "./logger";
import { initWorkspace, lockSetup } from "./spaces";
import type { UserRow } from "./users";
import { normalizeEmail } from "./validate";

/*
 * Optional single sign-on through an OpenID Connect provider whose tokens and
 * events follow the contract `auth-client.ts` implements. It is off unless
 * AUTH_ISSUER is set, and nothing here contacts the provider before someone
 * signs in with it.
 */

/** How often a session started through the provider re-checks the user's access with it. */
export const RECHECK_MS = 10 * 60 * 1000;
/** How long past a due re-check a session is still served while the provider is unreachable. */
const STALE_MS = 60 * 60 * 1000;

/** Reasons the sign-in page shows after a refused sign-in (`/login?sso_error=…`). */
export type SsoError = "login_failed" | "access_denied" | "unavailable" | "no_email" | "account_exists" | "deactivated" | "rate_limited";

const asEmail = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    return normalizeEmail(value);
  } catch {
    return null;
  }
};

/** Parses AUTH_LINK_USERS, `<local email>=<provider username>,…`, into provider username → local email. */
export const parseLinkUsers = (value: string | undefined) => {
  const links = new Map<string, string>();
  const emails = new Set<string>();
  const problems: string[] = [];
  for (const part of (value ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.lastIndexOf("=");
    const email = asEmail(entry.slice(0, Math.max(eq, 0)));
    const username = entry.slice(eq + 1).trim();
    if (eq < 0 || !email || !username || /\s/.test(username)) {
      problems.push(`AUTH_LINK_USERS: "${entry}" is not <email>=<username>`);
    } else if (links.has(username)) {
      problems.push(`AUTH_LINK_USERS: ${username} is listed more than once`);
    } else if (emails.has(email)) {
      problems.push(`AUTH_LINK_USERS: ${email} is listed more than once`);
    } else {
      links.set(username, email);
      emails.add(email);
    }
  }
  return { links, problems };
};

const urlProblem = (name: string, value: string | undefined, rule: (url: URL) => boolean, requirement: string) => {
  if (value === undefined) return [];
  try {
    const url = new URL(value);
    if (rule(url) && !url.search && !url.hash) return [];
  } catch {
    // reported below
  }
  return [`${name} must be ${requirement}`];
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Everything wrong with the single sign-on settings; the server refuses to start unless this is empty. */
export const ssoProblems = (): string[] => {
  const sso = config.sso;
  if (!sso) return [];
  const problems = [
    ...(sso.clientId ? [] : ["AUTH_CLIENT_ID is required when AUTH_ISSUER is set"]),
    ...(sso.clientSecret ? [] : ["AUTH_CLIENT_SECRET is required when AUTH_ISSUER is set"]),
    ...urlProblem(
      "AUTH_ISSUER",
      sso.issuer,
      (url) => url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)),
      "an https URL (http only for localhost), without a query or fragment",
    ),
    ...urlProblem("AUTH_BACKCHANNEL_URL", sso.backChannelUrl, (url) => /^https?:$/.test(url.protocol), "an http or https URL, without a query or fragment"),
    ...urlProblem("AUTH_REDIRECT_URI", sso.redirectUri, (url) => /^https?:$/.test(url.protocol), "an absolute http or https URL (it defaults to APP_URL/api/auth/callback)"),
    ...parseLinkUsers(sso.linkUsers).problems,
  ];
  if (problems.length === 0) {
    try {
      clientFor(sso);
    } catch (error) {
      problems.push(`single sign-on: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
};

type SsoConfig = NonNullable<typeof config.sso>;

const clientFor = (sso: SsoConfig) =>
  createAuthClient({
    issuer: sso.issuer,
    backChannelUrl: sso.backChannelUrl,
    clientId: sso.clientId ?? "",
    clientSecret: sso.clientSecret,
    redirectUri: sso.redirectUri,
    audience: sso.audience,
  });

let cached: { key: string; client: AuthClient } | null = null;

/** The provider's client, or null when single sign-on is off. Built from the current settings. */
export const authClient = (): AuthClient | null => {
  const sso = config.sso;
  if (!sso) return null;
  const key = JSON.stringify([sso.issuer, sso.backChannelUrl, sso.clientId, sso.clientSecret, sso.redirectUri, sso.audience]);
  if (cached?.key !== key) cached = { key, client: clientFor(sso) };
  return cached.client;
};

/** Drops the cached client, with its discovery document and keys, and the re-check backoff. For tests. */
export const forgetAuthClient = () => {
  cached = null;
  retryAfter.clear();
};

/** What the browser needs to know before sign-in. */
export const ssoMode = () => ({ enabled: config.sso !== null, localLogin: config.localLogin });

/** Refuses what creates or uses a password while single sign-on is the only way in. */
export const requireLocalLogin = (message: string) => {
  if (!config.localLogin) throw new HttpError(403, "local_login_disabled", message);
};

/** Refuses a local change to the role of a member linked to the identity provider, which sets it. */
export const requireLocallyManaged = (user: Pick<UserRow, "auth_sub">) => {
  if (config.sso && user.auth_sub) {
    throw new HttpError(403, "sso_managed", "This member's role is managed by the identity provider");
  }
};

const WORKSPACE_ROLES: readonly string[] = ["owner", "admin", "member"] satisfies WorkspaceRole[];

/** The provider's role for this service, as a workspace role: anything doc doesn't know is `member`. */
export const workspaceRole = (role: string): WorkspaceRole => (WORKSPACE_ROLES.includes(role) ? (role as WorkspaceRole) : "member");

const displayName = (claims: AccessClaims) => (claims.name.trim() || claims.username.trim()).slice(0, 50);

/** The ID token's email, when the provider vouches for it. */
const verifiedEmail = (idClaims: IdClaims) => (idClaims.email_verified === true ? asEmail(idClaims.email) : null);

const isUniqueViolation = (error: unknown) => (error as { errno?: string })?.errno === "23505";

const findBySub = async (sub: string): Promise<UserRow | null> => {
  const [row] = await sql`SELECT * FROM users WHERE auth_sub = ${sub}`;
  return (row as UserRow | undefined) ?? null;
};

/**
 * Links the account with this email to `sub`, unless it is already linked.
 * A deactivated account is linked too, and stays deactivated: activation is
 * doc's own, and the callback refuses to sign it in.
 */
const linkByEmail = async (email: string, sub: string): Promise<UserRow | null> => {
  try {
    const [row] = await sql`
      UPDATE users SET auth_sub = ${sub}, updated_at = now()
      WHERE lower(email) = ${email} AND auth_sub IS NULL
      RETURNING *`;
    return (row as UserRow | undefined) ?? null;
  } catch (error) {
    // Another sign-in of the same person linked another account first.
    if (isUniqueViolation(error)) return findBySub(sub);
    throw error;
  }
};

/** Creates a user on their first sign-in, setting up the workspace when they are its first. */
const createUser = async (claims: AccessClaims, email: string): Promise<UserRow | SsoError> => {
  try {
    return await sql.begin(async (tx) => {
      await lockSetup(tx);
      // A sign-in of the same person that got here first.
      const [created] = await tx`SELECT * FROM users WHERE auth_sub = ${claims.sub}`;
      if (created) return created as UserRow;
      const [taken] = await tx`SELECT 1 FROM users WHERE lower(email) = ${email}`;
      // The account with this address is linked to someone else at the
      // provider, or appeared after the lookup in findOrCreateUser.
      if (taken) return "account_exists" as const;
      // The provider decides who joins, so the workspace's allowed email
      // domains, which govern doc's own invitations, don't apply here.
      const [existing] = await tx`SELECT EXISTS (SELECT 1 FROM users) AS has_users`;
      const [user] = await tx`
        INSERT INTO users (email, name, role, auth_sub)
        VALUES (${email}, ${displayName(claims)}, ${workspaceRole(claims.role)}, ${claims.sub})
        RETURNING *`;
      if (existing.has_users) {
        await tx`INSERT INTO group_members (group_id, user_id) SELECT id, ${user.id} FROM groups WHERE is_default ON CONFLICT DO NOTHING`;
      } else {
        await initWorkspace(tx, "My workspace", user.id);
      }
      return user as UserRow;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return (await findBySub(claims.sub)) ?? "account_exists";
  }
};

/**
 * Finds the local user for a provider sign-in: the one linked to its subject,
 * or the account AUTH_LINK_USERS maps its username to, or the one unlinked
 * account with its email; otherwise a new user. Linking leaves an account's
 * activation as it is.
 */
export const findOrCreateUser = async (claims: AccessClaims, idClaims: IdClaims): Promise<UserRow | SsoError> => {
  const linked = await findBySub(claims.sub);
  if (linked) return linked;
  const mapped = parseLinkUsers(config.sso?.linkUsers).links.get(claims.username);
  const byMapping = mapped ? await linkByEmail(mapped, claims.sub) : null;
  if (byMapping) return byMapping;
  const email = asEmail(idClaims.email);
  if (!email) return "no_email";
  // Verified or not: the provider sets an address a person chose only after
  // they confirm it, so one it hasn't verified was entered by its
  // administrator (at account creation or import), and matching on it is as
  // trustworthy as AUTH_LINK_USERS. A provider that lets people claim
  // addresses they haven't confirmed must not be used this way (README).
  const byEmail = await linkByEmail(email, claims.sub);
  if (byEmail) return byEmail;
  return createUser(claims, email);
};

/**
 * Copies the provider's view of the user onto the local row: the role, the
 * name and, at sign-in, a verified email. Activation is doc's own, so a
 * deactivated account stays deactivated.
 */
export const applyClaims = async (user: UserRow, claims: AccessClaims, idClaims?: IdClaims): Promise<UserRow> => {
  const role = workspaceRole(claims.role);
  const name = displayName(claims) || user.name;
  // At sign-in, an email the provider verified becomes the account's, and the
  // provider manages it from then on; without one, the account manages its
  // own. A re-check carries no ID token, so it leaves both alone.
  const verified = idClaims ? verifiedEmail(idClaims) : null;
  const fromProvider = idClaims ? verified !== null : user.email_from_provider;
  const email = verified && verified !== user.email.toLowerCase() ? verified : null;
  if (role === user.role && name === user.name && !email && fromProvider === user.email_from_provider) {
    return user;
  }
  const update = (nextEmail: string | null, nextFromProvider: boolean) => sql`
    UPDATE users SET role = ${role}, name = ${name}, email = COALESCE(${nextEmail}, email),
      email_from_provider = ${nextFromProvider}, updated_at = now()
    WHERE id = ${user.id} RETURNING *`;
  try {
    const [row] = await update(email, fromProvider);
    return (row as UserRow | undefined) ?? user;
  } catch (error) {
    // Another account here has that address: this one keeps, and manages, its own.
    if (!email || !isUniqueViolation(error)) throw error;
    const [row] = await update(null, false);
    return (row as UserRow | undefined) ?? user;
  }
};

/** The reason a callback that could not sign anyone in shows on the sign-in page. */
export const loginFailure = (error: unknown): SsoError => {
  if (error instanceof LoginError && error.code === "authorization_error" && error.error === "access_denied") return "access_denied";
  if (error instanceof Unavailable) return "unavailable";
  if (error instanceof LoginError || error instanceof InvalidToken || error instanceof InvalidGrant) {
    log.warn("single sign-on refused", { reason: error.message });
  } else {
    log.error("single sign-on failed", error);
  }
  return "login_failed";
};

/** Deletes a session and closes the sockets opened with it on this copy. */
export const endSession = async (sessionId: string) => {
  await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
  disconnectSessions([sessionId]);
};

export interface DueRecheck {
  sessionId: string;
  refreshToken: string | null;
  /** When the re-check came due. */
  recheckAt: Date;
}

const rechecks = new Map<string, Promise<UserRow | null>>();

/**
 * After the provider couldn't answer a session's re-check, how long that
 * session is served without asking again. Without it, every request of the
 * session would wait out the client's timeout while the provider is
 * unreachable. Kept per copy of the server, in memory: at most one request
 * per session and copy pays the timeout each interval.
 */
const RETRY_MS = 60 * 1000;
const retryAfter = new Map<string, number>();
/** Bounds the map when sessions that last failed never come back. */
const RETRY_MAX = 10_000;

const backOff = (sessionId: string) => {
  retryAfter.delete(sessionId);
  retryAfter.set(sessionId, Date.now() + RETRY_MS);
  if (retryAfter.size > RETRY_MAX) retryAfter.delete(retryAfter.keys().next().value!);
};

const recheck = async (auth: AuthClient, due: DueRecheck, user: UserRow): Promise<UserRow | null> => {
  // Without a refresh token the provider can't be asked again, so the session lasts until its first re-check.
  if (!due.refreshToken) {
    await endSession(due.sessionId);
    return null;
  }
  let refreshed;
  try {
    refreshed = await auth.refresh(due.refreshToken);
  } catch (error) {
    if (error instanceof InvalidGrant) {
      await endSession(due.sessionId);
      return null;
    }
    if (!(error instanceof Unavailable)) log.error("re-checking a single sign-on session failed", error);
    // Bounded staleness: served while the provider is unreachable, for at most an hour.
    if (Date.now() > due.recheckAt.getTime() + STALE_MS) {
      await endSession(due.sessionId);
      return null;
    }
    backOff(due.sessionId);
    return user;
  }
  retryAfter.delete(due.sessionId);
  if (refreshed.claims.sub !== user.auth_sub) {
    await endSession(due.sessionId);
    return null;
  }
  const updated = await applyClaims(user, refreshed.claims);
  await sql`
    UPDATE sessions SET auth_recheck_at = ${new Date(Date.now() + RECHECK_MS)},
      auth_refresh_token = COALESCE(${refreshed.refreshToken ?? null}, auth_refresh_token)
    WHERE id = ${due.sessionId}`;
  return updated;
};

/**
 * Asks the provider again about a session whose re-check is due, and applies
 * the answer. Returns the user as they now are, or null when the session has
 * ended. Concurrent requests of one session share one re-check.
 */
export const recheckSession = (due: DueRecheck, user: UserRow): Promise<UserRow | null> => {
  const auth = authClient();
  // Turned off since the session started: nothing can re-check it.
  if (!auth) return endSession(due.sessionId).then(() => null);
  const waitUntil = retryAfter.get(due.sessionId);
  if (waitUntil !== undefined && Date.now() < waitUntil) {
    // The provider couldn't answer moments ago: serve without asking, still
    // within the hour past the original re-check.
    if (Date.now() <= due.recheckAt.getTime() + STALE_MS) return Promise.resolve(user);
    retryAfter.delete(due.sessionId);
    return endSession(due.sessionId).then(() => null);
  }
  let pending = rechecks.get(due.sessionId);
  if (!pending) {
    pending = recheck(auth, due, user).finally(() => rechecks.delete(due.sessionId));
    rechecks.set(due.sessionId, pending);
  }
  return pending;
};

/** Ends every session of the user linked to `sub` and closes their sockets on this copy. */
const endUserSessions = async (sub: string) => {
  const [user] = await sql`SELECT id FROM users WHERE auth_sub = ${sub}`;
  if (!user) return;
  await sql`DELETE FROM sessions WHERE user_id = ${user.id}`;
  disconnectUser(user.id);
};

/**
 * Applies an event the provider pushed. Delivery is at least once, and each
 * case is idempotent, so no record of seen event ids is kept. Sockets on
 * another copy of the server notice within a minute (`checkSocketSessions`).
 * A removal, disabling or deletion ends the user's sessions but doesn't
 * deactivate them: the provider refuses their sign-in itself, and activation
 * is doc's own.
 */
export const applyEvent = async (event: AuthEvent) => {
  switch (event.type) {
    case "session.ended": {
      if (!event.sid) return;
      const ended: { id: string }[] = await sql`DELETE FROM sessions WHERE auth_sid = ${event.sid} RETURNING id`;
      disconnectSessions(ended.map((row) => row.id));
      return;
    }
    case "access.changed":
      if (!event.sub) return;
      if (typeof event.role !== "string") return endUserSessions(event.sub);
      await sql`UPDATE users SET role = ${workspaceRole(event.role)}, updated_at = now() WHERE auth_sub = ${event.sub}`;
      return;
    case "user.disabled":
    case "user.deleted":
      if (event.sub) await endUserSessions(event.sub);
      return;
  }
};

/**
 * Ends the provider's side of a session at sign-out: revokes its refresh token
 * in the background, and returns where the browser goes to end the provider's
 * own session.
 */
export const providerLogout = async (refreshToken: string | null): Promise<{ logoutUrl?: string }> => {
  const auth = authClient();
  const sso = config.sso;
  if (!auth || !sso) return {};
  if (refreshToken) {
    auth.revoke(refreshToken).catch((error) => log.warn("revoking a refresh token failed", { error: error instanceof Error ? error.message : String(error) }));
  }
  try {
    return { logoutUrl: await auth.logoutUrl(`${new URL(sso.redirectUri).origin}/`) };
  } catch (error) {
    log.warn("the provider's sign-out address is unavailable", { error: error instanceof Error ? error.message : String(error) });
    return {};
  }
};
