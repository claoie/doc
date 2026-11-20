import type { SessionInfo } from "common/api-types";
import { token } from "common/ids";
import { config } from "server/config";
import { sql } from "server/db";
import { clearedSessionCookie, hashToken, revokeUserSessions, signIn, signOut } from "server/lib/auth";
import { renderMail } from "server/lib/emails";
import { HttpError, badRequest, forbidden, get, post, publicGet, publicPost, readJson } from "server/lib/http";
import { sendMail } from "server/lib/mail";
import { rateLimit } from "server/lib/ratelimit";
import { getWorkspace, initWorkspace, lockSetup } from "server/lib/spaces";
import { providerLogout, requireLocalLogin } from "server/lib/sso";
import { findUserById, hashPassword, iso, toUser, verifyPassword, type UserRow } from "server/lib/users";
import { EMAIL_RULE, NAME_RULE, PASSWORD_RULE, input, normalizeEmail } from "server/lib/validate";
import { disconnectUser } from "server/realtime/hub";

const RESET_PURPOSE = "password-reset";
const RESET_MINUTES = 30;

const invalidCredentials = () => new HttpError(401, "invalid_credentials", "Invalid email or password");

const PASSWORDS_OFF = "Passwords are turned off in this workspace: sign in with single sign-on";

export const routes = [
  publicGet("/setup", async () => {
    const [row] = await sql`SELECT EXISTS (SELECT 1 FROM users) AS has_users`;
    return { needsSetup: !row.has_users };
  }),

  publicPost("/setup", async (ctx) => {
    requireLocalLogin("This workspace uses single sign-on: the first person to sign in with it sets it up");
    rateLimit("setup", ctx.ip);
    const body = input(await readJson(ctx));
    const workspaceName = body.string("workspaceName", { max: 100 });
    const name = body.string("name", NAME_RULE);
    const email = normalizeEmail(body.string("email", EMAIL_RULE));
    const passwordHash = await hashPassword(body.string("password", PASSWORD_RULE));
    const user = await sql.begin(async (tx) => {
      await lockSetup(tx);
      const [existing] = await tx`SELECT EXISTS (SELECT 1 FROM users) AS has_users`;
      if (existing.has_users) throw forbidden("Setup has already been completed");
      const [owner] = await tx`
        INSERT INTO users (email, name, password_hash, role) VALUES (${email}, ${name}, ${passwordHash}, 'owner')
        RETURNING *`;
      await initWorkspace(tx, workspaceName, owner.id);
      return owner as UserRow;
    });
    await signIn(ctx, user.id);
    return { user: toUser(user, user.id) };
  }),

  publicPost("/auth/login", async (ctx) => {
    requireLocalLogin(PASSWORDS_OFF);
    rateLimit("login", ctx.ip);
    const body = input(await readJson(ctx));
    const email = body.string("email", EMAIL_RULE).toLowerCase();
    const password = body.string("password", { max: 200, trim: false });
    // While single sign-on is on, an account linked to the provider signs in
    // only through it, even with AUTH_LOCAL_LOGIN, so a person the provider
    // disabled can't come back with a password: it is looked up as an unknown one.
    const [user] = await sql`SELECT * FROM users WHERE lower(email) = ${email} AND (${!config.sso} OR auth_sub IS NULL)`;
    const valid = await verifyPassword(password, user?.password_hash ?? null);
    if (!user || !valid || user.deactivated_at) throw invalidCredentials();
    await signIn(ctx, user.id);
    return { user: toUser(user, user.id) };
  }),

  post("/auth/logout", async (ctx) => {
    const { authSid, authRefreshToken } = ctx.session;
    await signOut(ctx);
    return authSid ? providerLogout(authRefreshToken) : {};
  }),

  publicPost("/auth/forgot-password", async (ctx) => {
    requireLocalLogin(PASSWORDS_OFF);
    rateLimit("forgot-password", ctx.ip);
    const body = input(await readJson(ctx));
    const email = body.string("email", EMAIL_RULE).toLowerCase();
    // Nothing for an account linked to the provider while single sign-on is on, as at /auth/login.
    const [user] = await sql`
      SELECT id, email, name FROM users
      WHERE lower(email) = ${email} AND deactivated_at IS NULL AND (${!config.sso} OR auth_sub IS NULL)`;
    if (user) {
      const value = token();
      await sql`DELETE FROM user_tokens WHERE user_id = ${user.id} AND purpose = ${RESET_PURPOSE}`;
      await sql`
        INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at)
        VALUES (${user.id}, ${RESET_PURPOSE}, ${hashToken(value)}, now() + make_interval(mins => ${RESET_MINUTES}))`;
      const workspace = await getWorkspace();
      sendMail(
        renderMail({
          to: user.email,
          subject: `Reset your ${workspace.name || "workspace"} password`,
          paragraphs: [
            `Hi ${user.name},`,
            `Someone asked to reset your password. The link below is valid for ${RESET_MINUTES} minutes. If it was not you, ignore this email.`,
          ],
          action: { label: "Reset password", url: `${config.appUrl}/reset-password?token=${encodeURIComponent(value)}` },
        }),
      );
    }
    return {};
  }),

  publicPost("/auth/reset-password", async (ctx) => {
    requireLocalLogin(PASSWORDS_OFF);
    rateLimit("reset-password", ctx.ip, 20);
    const body = input(await readJson(ctx));
    const value = body.string("token", { max: 200 });
    const passwordHash = await hashPassword(body.string("password", PASSWORD_RULE));
    // While single sign-on is on, a link sent before the account was linked to the provider no longer works, as at /auth/login.
    const [row] = await sql`
      DELETE FROM user_tokens t USING users u
      WHERE t.token_hash = ${hashToken(value)} AND t.purpose = ${RESET_PURPOSE} AND t.expires_at > now()
        AND u.id = t.user_id AND u.deactivated_at IS NULL AND (${!config.sso} OR u.auth_sub IS NULL)
      RETURNING t.user_id`;
    if (!row) throw badRequest("This reset link is invalid or has expired");
    await sql`UPDATE users SET password_hash = ${passwordHash}, updated_at = now() WHERE id = ${row.user_id}`;
    await sql`DELETE FROM user_tokens WHERE user_id = ${row.user_id} AND purpose = ${RESET_PURPOSE}`;
    await revokeUserSessions(row.user_id);
    disconnectUser(row.user_id);
    await signIn(ctx, row.user_id);
    const user = await findUserById(row.user_id);
    return { user: toUser(user!, row.user_id) };
  }),

  post("/auth/change-password", async (ctx) => {
    requireLocalLogin(PASSWORDS_OFF);
    const body = input(await readJson(ctx));
    const current = body.string("currentPassword", { max: 200, trim: false });
    const next = body.string("newPassword", PASSWORD_RULE);
    const [row] = await sql`SELECT password_hash FROM users WHERE id = ${ctx.user.id}`;
    if (!(await verifyPassword(current, row?.password_hash ?? null))) {
      throw new HttpError(400, "invalid_password", "Current password is incorrect");
    }
    await sql`UPDATE users SET password_hash = ${await hashPassword(next)}, updated_at = now() WHERE id = ${ctx.user.id}`;
    await revokeUserSessions(ctx.user.id, ctx.session.id);
    sendMail(
      renderMail({
        to: ctx.user.email,
        subject: "Your password was changed",
        paragraphs: [
          `Hi ${ctx.user.name},`,
          "Your password was just changed and your other sessions were signed out. If this was not you, reset your password right away.",
        ],
      }),
    );
    return {};
  }),

  get("/auth/sessions", async (ctx): Promise<SessionInfo[]> => {
    const rows = await sql`
      SELECT id, user_agent, ip, created_at, last_seen_at FROM sessions
      WHERE user_id = ${ctx.user.id} AND expires_at > now() ORDER BY last_seen_at DESC`;
    return rows.map((r: Record<string, never>) => ({
      id: r.id,
      userAgent: r.user_agent,
      ip: r.ip,
      createdAt: iso(r.created_at)!,
      lastSeenAt: iso(r.last_seen_at)!,
      current: r.id === ctx.session.id,
    }));
  }),

  post("/auth/sessions/revoke", async (ctx) => {
    const id = input(await readJson(ctx)).uuid("id");
    await sql`DELETE FROM sessions WHERE id = ${id} AND user_id = ${ctx.user.id}`;
    if (id === ctx.session.id) ctx.cookies.push(clearedSessionCookie());
    return {};
  }),
];
