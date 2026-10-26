import type { Server } from "bun";
import { config } from "server/config";
import { authenticate } from "server/lib/auth";
import { HttpError, Router, fail, ok, type Context } from "server/lib/http";
import { log, logRequest } from "server/lib/logger";
import { serveStatic } from "server/lib/static";
import type { SocketData } from "server/realtime/hub";
import { upgrade, websocket } from "server/realtime/ws";
import { routes as authRoutes } from "server/routes/auth";
import { routes as baseRoutes } from "server/routes/bases";
import { routes as commentRoutes } from "server/routes/comments";
import { routes as exportRoutes } from "server/routes/export";
import { routes as favoriteRoutes } from "server/routes/favorites";
import { routes as fileRoutes } from "server/routes/files";
import { routes as groupRoutes } from "server/routes/groups";
import { routes as healthRoutes } from "server/routes/health";
import { routes as invitationRoutes } from "server/routes/invitations";
import { routes as labelRoutes } from "server/routes/labels";
import { routes as meRoutes } from "server/routes/me";
import { routes as memberRoutes } from "server/routes/members";
import { routes as notificationRoutes } from "server/routes/notifications";
import { routes as pageRoutes } from "server/routes/pages";
import { routes as searchRoutes } from "server/routes/search";
import { routes as shareRoutes } from "server/routes/shares";
import { routes as spaceRoutes } from "server/routes/spaces";
import { routes as watchRoutes } from "server/routes/watch";
import { routes as workspaceRoutes } from "server/routes/workspace";

const router = new Router([
  ...healthRoutes,
  ...authRoutes,
  ...baseRoutes,
  ...meRoutes,
  ...workspaceRoutes,
  ...memberRoutes,
  ...invitationRoutes,
  ...groupRoutes,
  ...spaceRoutes,
  ...pageRoutes,
  ...labelRoutes,
  ...favoriteRoutes,
  ...watchRoutes,
  ...commentRoutes,
  ...fileRoutes,
  ...searchRoutes,
  ...shareRoutes,
  ...notificationRoutes,
  ...exportRoutes,
]);

const clientIp = (req: Request, server: Server<SocketData>): string => {
  if (config.trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for");
    const last = forwarded?.split(",").pop()?.trim();
    if (last) return last.slice(0, 64);
  }
  return server.requestIP(req)?.address ?? "";
};

/** Cross-site requests may not mutate state: a present Origin must match the app or the request host. */
const sameOrigin = (req: Request): boolean => {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return !origin;
  try {
    const url = new URL(origin);
    return url.origin === new URL(config.appUrl).origin || url.host === req.headers.get("host");
  } catch {
    return false;
  }
};

const handleApi = async (req: Request, url: URL, server: Server<SocketData>): Promise<Response | undefined> => {
  const started = performance.now();
  const ip = clientIp(req, server);
  let userId: string | null = null;
  let response: Response | undefined;
  try {
    const auth = await authenticate(req);
    userId = auth?.user.id ?? null;
    if (url.pathname === "/api/ws") {
      if (!auth) return fail(401, "unauthorized", "Sign in required");
      return await upgrade(req, server, auth.user);
    }
    if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
      throw new HttpError(403, "forbidden_origin", "Cross-origin request rejected");
    }
    const match = router.match(req.method, url.pathname.slice("/api".length) || "/");
    if (!match) throw new HttpError(404, "not_found", "Endpoint not found");
    if (!match.route.isPublic && !auth) throw new HttpError(401, "unauthorized", "Sign in required");
    const ctx: Context = {
      req,
      url,
      params: match.params,
      ip,
      server,
      user: auth?.user ?? null,
      session: auth?.session ?? null,
      cookies: auth?.refreshedCookie ? [auth.refreshedCookie] : [],
    };
    const result = await match.route.handler(ctx);
    response = result instanceof Response ? result : ok(result);
    for (const cookie of ctx.cookies) response.headers.append("Set-Cookie", cookie);
    return response;
  } catch (error) {
    if (error instanceof HttpError) {
      response = fail(error.status, error.code, error.message);
    } else {
      log.error("request failed", error, { method: req.method, path: url.pathname });
      response = fail(500, "internal_error", "Something went wrong");
    }
    return response;
  } finally {
    logRequest({
      method: req.method,
      path: url.pathname,
      status: response?.status ?? 101,
      ms: Math.round(performance.now() - started),
      userId,
    });
  }
};

export interface AppOptions {
  /** Directory of the built client, or null to serve no static files. */
  staticDir: string | null;
}

export const createApp = ({ staticDir }: AppOptions) => ({
  async fetch(req: Request, server: Server<SocketData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return handleApi(req, url, server);
    return serveStatic(req, url.pathname, staticDir);
  },
  websocket,
});
