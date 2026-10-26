import { stat } from "node:fs/promises";
import path from "node:path";
import { MERMAID_BASE } from "common/mermaid";

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

/**
 * Policy for the app shell. Scripts only come from the app and the pinned
 * diagram renderer; `javascript:` URLs and inline scripts never run. Embeds
 * and images may come from any https origin.
 */
const APP_CSP = [
  "default-src 'self'",
  `script-src 'self' ${MERMAID_BASE}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

const APP_HEADERS = { ...HTML_HEADERS, "Content-Security-Policy": APP_CSP };

/** Other pages (the drawing editor frame) always run sandboxed, even when opened directly. */
const FRAME_HEADERS = {
  ...HTML_HEADERS,
  "Content-Security-Policy": "sandbox allow-scripts allow-popups allow-downloads; frame-ancestors 'self'",
};

const isFile = async (file: string) => (await stat(file).catch(() => null))?.isFile() ?? false;

/** Serves the built client: hashed `/assets/*` with long caching, other paths fall back to `index.html`. */
export const serveStatic = async (req: Request, pathname: string, root: string | null): Promise<Response> => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
  if (!root) return new Response("Not Found", { status: 404 });
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const target = path.resolve(root, "." + path.posix.normalize("/" + decoded));
  const inside = target === root || target.startsWith(root + path.sep);
  if (inside && target !== root && !decoded.includes("\0") && (await isFile(target))) {
    const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
    headers["Cache-Control"] = decoded.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    if (target.endsWith(".html")) Object.assign(headers, target === path.join(root, "index.html") ? APP_HEADERS : FRAME_HEADERS);
    return new Response(Bun.file(target), { headers });
  }
  if (decoded.startsWith("/assets/")) return new Response("Not Found", { status: 404 });
  const index = path.join(root, "index.html");
  if (!(await isFile(index))) return new Response("Not Found", { status: 404 });
  return new Response(Bun.file(index), { headers: APP_HEADERS });
};
