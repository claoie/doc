import { signIn } from "server/lib/auth";
import { InvalidToken, Unavailable, type AuthEvent, type Login } from "server/lib/auth-client";
import { HttpError, notFound, ok, publicGet, publicPost, readText, type Context } from "server/lib/http";
import { log } from "server/lib/logger";
import { rateLimit } from "server/lib/ratelimit";
import { applyEvent, authClient, loginFailure, resolveUser, ssoMode, type SsoError } from "server/lib/sso";

/** Events are one signed token each; anything near this size is not one. */
const EVENT_LIMIT = 64 * 1024;

/** Deletes the provider client's login cookie (`__Host-login`) when a callback fails before it hands out its own. */
const CLEAR_LOGIN_COOKIE = "__Host-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";

/** With single sign-on off, these routes answer as unknown ones do. */
const requireClient = () => {
  const auth = authClient();
  if (!auth) throw notFound("Endpoint");
  return auth;
};

const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });

/** Back to the sign-in page with a short reason it can show. */
const refuse = (ctx: Context, reason: SsoError) => {
  ctx.cookies.push(CLEAR_LOGIN_COOKIE);
  return redirect(`/login?sso_error=${reason}`);
};

const limited = (ctx: Context, scope: string) => {
  try {
    rateLimit(scope, ctx.ip, 60);
    return false;
  } catch {
    return true;
  }
};

export const routes = [
  publicGet("/auth/config", () => ({ sso: ssoMode() })),

  publicGet("/auth/login", async (ctx) => {
    const auth = requireClient();
    if (limited(ctx, "sso-login")) return refuse(ctx, "rate_limited");
    try {
      const { redirectUrl, loginCookie } = await auth.startLogin(ctx.req, { returnTo: ctx.url.searchParams.get("returnTo") ?? undefined });
      ctx.cookies.push(loginCookie);
      return redirect(redirectUrl);
    } catch (error) {
      if (!(error instanceof Unavailable)) log.error("starting single sign-on failed", error);
      return refuse(ctx, "unavailable");
    }
  }),

  publicGet("/auth/callback", async (ctx) => {
    const auth = requireClient();
    if (limited(ctx, "sso-callback")) return refuse(ctx, "rate_limited");
    let login: Login;
    try {
      login = await auth.finishLogin(ctx.req);
    } catch (error) {
      return refuse(ctx, loginFailure(error));
    }
    try {
      const user = await resolveUser(login.claims, login.idClaims);
      if (typeof user === "string") return refuse(ctx, user);
      // Activation is doc's own: the provider let this person in, but an admin here deactivated them.
      if (user.deactivated_at) return refuse(ctx, "deactivated");
      await signIn(ctx, user.id, { sid: login.claims.sid, refreshToken: login.refreshToken ?? null });
    } catch (error) {
      return refuse(ctx, loginFailure(error));
    }
    ctx.cookies.push(login.clearCookie);
    return redirect(login.returnTo);
  }),

  publicPost("/auth/events", async (ctx) => {
    const auth = requireClient();
    rateLimit("sso-events", ctx.ip, 600);
    const body = await readText(ctx, EVENT_LIMIT);
    let event: AuthEvent;
    try {
      event = await auth.readEvent(body);
    } catch (error) {
      if (error instanceof InvalidToken) throw new HttpError(400, "invalid_token", "The event did not verify");
      // The provider retries: its keys could not be fetched to check this one.
      if (error instanceof Unavailable) throw new HttpError(503, "unavailable", "The identity provider is unreachable");
      throw error;
    }
    await applyEvent(event);
    return ok({}, 202);
  }),
];
