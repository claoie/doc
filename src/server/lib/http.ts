import type { Server } from "bun";
import type { AuthSession, AuthUser } from "./auth";
import { chunks } from "./streams";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const API_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export const ok = (data: unknown, status = 200): Response =>
  Response.json({ data: data ?? {} }, { status, headers: API_HEADERS });

export const fail = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status, headers: API_HEADERS });

export const badRequest = (message: string) => new HttpError(400, "invalid_input", message);
export const unauthorized = () => new HttpError(401, "unauthorized", "Sign in required");
export const forbidden = (message = "You do not have permission to do this") =>
  new HttpError(403, "forbidden", message);
export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

export interface Context {
  req: Request;
  url: URL;
  params: Record<string, string>;
  ip: string;
  server: Server<unknown>;
  user: AuthUser | null;
  session: AuthSession | null;
  /** `Set-Cookie` values appended to the response. */
  cookies: string[];
}

export interface AuthedContext extends Context {
  user: AuthUser;
  session: AuthSession;
}

type Handler<C extends Context> = (ctx: C) => unknown;

export interface Route {
  method: "GET" | "POST";
  segments: string[];
  isPublic: boolean;
  handler: Handler<Context>;
}

const define = (method: Route["method"], path: string, isPublic: boolean, handler: Handler<Context>): Route => ({
  method,
  segments: path.split("/").filter(Boolean),
  isPublic,
  handler,
});

export const get = (path: string, handler: Handler<AuthedContext>) =>
  define("GET", path, false, handler as Handler<Context>);
export const post = (path: string, handler: Handler<AuthedContext>) =>
  define("POST", path, false, handler as Handler<Context>);
export const publicGet = (path: string, handler: Handler<Context>) => define("GET", path, true, handler);
export const publicPost = (path: string, handler: Handler<Context>) => define("POST", path, true, handler);

const specificity = (route: Route) => route.segments.map((s) => (s.startsWith(":") ? "1" : "0")).join("");

export class Router {
  private routes: Route[];

  constructor(routes: Route[]) {
    this.routes = [...routes].sort((a, b) => specificity(a).localeCompare(specificity(b)));
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const lookup = method === "HEAD" ? "GET" : method;
    const parts = pathname.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== lookup || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < parts.length; i++) {
        const segment = route.segments[i]!;
        const part = parts[i]!;
        if (segment.startsWith(":")) {
          try {
            params[segment.slice(1)] = decodeURIComponent(part);
          } catch {
            matched = false;
            break;
          }
        } else if (segment !== part) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, params };
    }
    return null;
  }
}

const readLimited = async (req: Request, limit: number): Promise<Uint8Array> => {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) throw new HttpError(413, "payload_too_large", "Request body is too large");
  if (!req.body) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks(req.body)) {
    size += chunk.byteLength;
    if (size > limit) throw new HttpError(413, "payload_too_large", "Request body is too large");
    parts.push(chunk);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of parts) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

export const JSON_LIMIT = 1024 * 1024;

/**
 * Parses a JSON object body. Requiring `application/json` means a cross-site
 * form cannot submit it without a CORS preflight.
 */
export const readJson = async (ctx: Context, limit = JSON_LIMIT): Promise<Record<string, unknown>> => {
  const type = ctx.req.headers.get("content-type") ?? "";
  const bytes = await readLimited(ctx.req, limit);
  if (bytes.byteLength === 0) return {};
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected application/json");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw badRequest("Malformed JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("Expected a JSON object");
  return value as Record<string, unknown>;
};

/** Parses a multipart body, rejecting it up front when the declared size exceeds `limit`. */
export const readForm = async (ctx: Context, limit: number): Promise<FormData> => {
  const type = ctx.req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(415, "unsupported_media_type", "Expected multipart/form-data");
  }
  const declared = Number(ctx.req.headers.get("content-length") ?? "0");
  if (declared > limit) throw new HttpError(413, "payload_too_large", "File is too large");
  try {
    return await ctx.req.formData();
  } catch {
    throw badRequest("Malformed multipart body");
  }
};

export const formFile = (form: FormData, name = "file"): File => {
  const value = form.get(name);
  if (!value || typeof value === "string") throw badRequest(`Missing file field "${name}"`);
  return value;
};

