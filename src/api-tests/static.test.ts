import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startServer, STATIC_FILES, type TestServer } from "./harness";
import { rawRequest } from "./harness/raw-http";
import { apiError } from "./harness/errors";

/**
 * The built web app, served outside `/api` (src/server/lib/static.ts). The
 * harness lays the files of `STATIC_FILES` out in a `client` directory next
 * to the server.
 */

let t: TestServer;

beforeAll(async () => {
  t = await startServer();
});

afterAll(async () => {
  await t.close();
});

const SHELL = STATIC_FILES["index.html"]!;

const APP_CSP =
  "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net/npm/mermaid@11.4.1/; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https: http:; media-src 'self' blob: https: http:; font-src 'self' data:; connect-src 'self'; " +
  "frame-src 'self' https:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

const FRAME_CSP = "sandbox allow-scripts allow-popups allow-downloads; frame-ancestors 'self'";

const get = async (pathname: string, init: RequestInit = {}) => {
  const res = await t.client().fetch(pathname, init);
  return { status: res.status, headers: res.headers, text: await res.text() };
};

/** A request whose path is sent exactly as written (`fetch` would resolve dot segments first). */
const raw = (target: string, method = "GET") => rawRequest(t.port, `${method} ${target} HTTP/1.1\nHost: localhost:${t.port}`);

const expectShell = (res: { status: number; headers: Headers | Record<string, string>; text?: string; body?: string }) => {
  const header = (name: string) => (res.headers instanceof Headers ? res.headers.get(name) : (res.headers[name] ?? null));
  expect(res.status).toBe(200);
  expect(res.text ?? res.body).toBe(SHELL);
  expect(header("content-type")).toBe("text/html; charset=utf-8");
  expect(header("cache-control")).toBe("no-cache");
  expect(header("x-content-type-options")).toBe("nosniff");
  expect(header("referrer-policy")).toBe("same-origin");
  expect(header("content-security-policy")).toBe(APP_CSP);
};

describe("the app shell", () => {
  test.each([
    "/",
    "/some/app/route",
    "/s/general/p/a-page-0123456789",
    "/share/abcdefghij/p/untitled-0123456789",
    "/missing.txt",
    "/missing.html",
    "/missing.js",
    "/nested/missing.json",
    "/INDEX.HTML",
    "/Robots.txt",
    "/with+space.txt",
    "/index.html/extra",
  ])("answers %s, a path that is no file, with index.html and the app's policy", async (pathname) => {
    expectShell(await get(pathname));
  });

  test("is what index.html itself gets", async () => {
    expectShell(await get("/index.html"));
  });

  test("answers a directory path, with or without a trailing slash", async () => {
    expectShell(await get("/nested"));
    expectShell(await get("/nested/"));
    expectShell(await get("/nested/dir"));
    // `/assets` without a slash is not under `/assets/`.
    expectShell(await get("/assets"));
  });

  test("ignores the query string", async () => {
    expectShell(await get("/some/route?x=1&y=/assets/app-4f3a2b1c.js"));
    expectShell(await get("/?"));
  });

  test("is answered for paths that only look like the API", async () => {
    expectShell(await get("/apix"));
    expectShell(await get("/api-docs"));
    expectShell(await get("/API/health"));
    expectShell(await get("/Api"));
    expectShell(await get("/x/api/health"));
  });

  test("is not answered with an ETag or Last-Modified, and a conditional request gets the whole page", async () => {
    const res = await get("/", { headers: { "If-None-Match": "*", "If-Modified-Since": new Date(Date.now() + 86_400_000).toUTCString() } });
    expectShell(res);
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("last-modified")).toBeNull();
  });
});

describe("files of the web app", () => {
  test("another HTML file is served sandboxed, never with the app's policy", async () => {
    for (const name of ["excalidraw.html", "nested/dir/page.html"]) {
      const res = await get(`/${name}`);
      expect(res.status).toBe(200);
      expect(res.text).toBe(STATIC_FILES[name]!);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      expect(res.headers.get("content-security-policy")).toBe(FRAME_CSP);
    }
  });

  test.each([
    ["assets/app-4f3a2b1c.js", "text/javascript;charset=utf-8"],
    ["assets/app-9e8d7c6b.css", "text/css;charset=utf-8"],
    ["assets/font-1a2b3c4d.woff2", "font/woff2"],
  ])("the hashed asset %s is cached for a year as immutable", async (name, type) => {
    const res = await get(`/${name}`);
    expect(res.status).toBe(200);
    expect(res.text).toBe(STATIC_FILES[name]!);
    expect(res.headers.get("content-type")).toBe(type);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBeNull();
  });

  test.each([
    ["robots.txt", "text/plain;charset=utf-8"],
    ["favicon.svg", "image/svg+xml"],
    ["nested/data.json", "application/json;charset=utf-8"],
  ])("the file %s outside /assets/ is revalidated on every use", async (name, type) => {
    const res = await get(`/${name}`);
    expect(res.status).toBe(200);
    expect(res.text).toBe(STATIC_FILES[name]!);
    expect(res.headers.get("content-type")).toBe(type);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBeNull();
  });

  test("a missing asset is 404, not the app shell", async () => {
    for (const pathname of ["/assets/nope.js", "/assets/app-00000000.js", "/assets/", "/assets/sub/dir/x.css", "/assets/app-4f3a2b1c.js/x", "/assets/index.html"]) {
      const res = await get(pathname);
      expect([pathname, res.status, res.text]).toEqual([pathname, 404, "Not Found"]);
      expect(res.headers.get("content-security-policy")).toBeNull();
    }
  });

  test("a file name with a space is addressed percent-encoded", async () => {
    const res = await get("/with%20space.txt");
    expect(res.status).toBe(200);
    expect(res.text).toBe("spaced\n");
    expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("a trailing slash after a file's name is ignored", async () => {
    const res = await get("/robots.txt/");
    expect(res.status).toBe(200);
    expect(res.text).toBe(STATIC_FILES["robots.txt"]!);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const asset = await get("/assets/app-9e8d7c6b.css/");
    expect(asset.text).toBe(STATIC_FILES["assets/app-9e8d7c6b.css"]!);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const frame = await get("/excalidraw.html/");
    expect(frame.text).toBe(STATIC_FILES["excalidraw.html"]!);
    expect(frame.headers.get("content-security-policy")).toBe(FRAME_CSP);
    expectShell(await get("/index.html/"));
  });

  test("the query string does not take part in finding the file", async () => {
    const res = await get("/robots.txt?v=2&x=%ZZ");
    expect(res.status).toBe(200);
    expect(res.text).toBe(STATIC_FILES["robots.txt"]!);
    const asset = await get("/assets/app-4f3a2b1c.js?v=2");
    expect(asset.text).toBe(STATIC_FILES["assets/app-4f3a2b1c.js"]!);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("percent-encoded characters of a path are decoded, an encoded slash included", async () => {
    expect((await get("/%72obots.txt")).text).toBe(STATIC_FILES["robots.txt"]!);
    expect((await get("/nested%2Fdata.json")).text).toBe(STATIC_FILES["nested/data.json"]!);
    expect((await get("/nested%2fdir%2fpage.html")).headers.get("content-security-policy")).toBe(FRAME_CSP);
    // Decoding happens once.
    expectShell(await get("/%2572obots.txt"));
  });

  test("repeated slashes and dot segments are resolved inside the app's directory", async () => {
    expect((await raw("//robots.txt")).body).toBe(STATIC_FILES["robots.txt"]!);
    expect((await raw("/nested//data.json")).body).toBe(STATIC_FILES["nested/data.json"]!);
    expect((await raw("/nested/./dir/../data.json")).body).toBe(STATIC_FILES["nested/data.json"]!);
    expect((await raw("/nested/%2e/dir/%2E%2E/data.json")).body).toBe(STATIC_FILES["nested/data.json"]!);
    const viaAssets = await raw("/assets/../robots.txt");
    expect(viaAssets.body).toBe(STATIC_FILES["robots.txt"]!);
    expect(viaAssets.headers["cache-control"]).toBe("no-cache");
    const encodedDots = await raw("/assets/%2e%2e/robots.txt");
    expect(encodedDots.body).toBe(STATIC_FILES["robots.txt"]!);
    expect(encodedDots.headers["cache-control"]).toBe("no-cache");
  });

  test("HEAD answers the headers of GET without a body", async () => {
    const cases: [string, string, string][] = [
      ["/robots.txt", "text/plain;charset=utf-8", STATIC_FILES["robots.txt"]!],
      ["/assets/app-4f3a2b1c.js", "text/javascript;charset=utf-8", STATIC_FILES["assets/app-4f3a2b1c.js"]!],
      ["/excalidraw.html", "text/html; charset=utf-8", STATIC_FILES["excalidraw.html"]!],
      ["/a/route/of/the/app", "text/html; charset=utf-8", SHELL],
    ];
    for (const [pathname, type, content] of cases) {
      const res = await get(pathname, { method: "HEAD" });
      expect([pathname, res.status, res.text]).toEqual([pathname, 200, ""]);
      expect(res.headers.get("content-type")).toBe(type);
      expect(res.headers.get("content-length")).toBe(String(new TextEncoder().encode(content).length));
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const shell = await get("/a/route/of/the/app", { method: "HEAD" });
    expect(shell.headers.get("content-security-policy")).toBe(APP_CSP);
    expect(shell.headers.get("cache-control")).toBe("no-cache");
    const missing = await get("/assets/nope.js", { method: "HEAD" });
    expect(missing.status).toBe(404);
  });
});

describe("paths that try to leave the app's directory", () => {
  test("dot segments cannot climb above it: the path is resolved from the root first", async () => {
    expectShell(await raw("/../../../../etc/passwd"));
    expectShell(await raw("/../server/bundle.js"));
    expectShell(await raw("/nested/../../server/bundle.js"));
    expectShell(await raw("/%2e%2e/%2e%2e/server/bundle.js"));
    expectShell(await raw("/.%2e/server/bundle.js"));
  });

  test("encoded slashes cannot either", async () => {
    expectShell(await raw("/..%2f..%2f..%2fetc%2fpasswd"));
    expectShell(await raw("/%2e%2e%2f%2e%2e%2fserver%2fbundle.js"));
    expectShell(await raw("/nested%2f..%2f..%2fserver%2fbundle.js"));
    // The same file reached through an encoded climb that stays inside.
    expect((await raw("/nested%2f..%2frobots.txt")).body).toBe(STATIC_FILES["robots.txt"]!);
  });

  test("under /assets/ a climb that finds nothing is 404", async () => {
    for (const target of ["/assets/..%2f..%2fserver%2fbundle.js", "/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd", "/assets/..%2fmissing.txt"]) {
      const res = await raw(target);
      expect([target, res.status, res.body]).toEqual([target, 404, "Not Found"]);
    }
  });

  test("a file reached through an encoded climb out of /assets/ is served with the caching of an asset", async () => {
    const res = await raw("/assets/%2e%2e%2frobots.txt");
    expect(res.status).toBe(200);
    expect(res.body).toBe(STATIC_FILES["robots.txt"]!);
    // Accident: caching is decided by the decoded path starting with `/assets/`, before `..` is resolved.
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const html = await raw("/assets/..%2fexcalidraw.html");
    expect(html.body).toBe(STATIC_FILES["excalidraw.html"]!);
    // HTML keeps `no-cache` whatever the path.
    expect(html.headers["cache-control"]).toBe("no-cache");
    expect(html.headers["content-security-policy"]).toBe(FRAME_CSP);
    const index = await raw("/assets/..%2findex.html");
    expectShell(index);
  });

  test("backslashes are ordinary characters", async () => {
    expectShell(await raw("/..\\..\\server\\bundle.js"));
    expectShell(await get("/..%5c..%5cserver%5cbundle.js"));
    expectShell(await get("/nested%5Cdata.json"));
  });

  test("a NUL byte in the decoded path never names a file", async () => {
    expectShell(await get("/robots.txt%00"));
    expectShell(await get("/robots.txt%00.html"));
    expectShell(await get("/%00"));
    const asset = await get("/assets/app-4f3a2b1c.js%00");
    expect([asset.status, asset.text]).toEqual([404, "Not Found"]);
  });
});

describe("requests the static handler refuses", () => {
  test.each(["/%", "/%zz", "/%E0%A4%A", "/%ff", "/robots.txt%", "/assets/%C3", "/nested/%u0041"])(
    "a malformed escape in %s is 400",
    async (target) => {
      const res = await raw(target);
      expect([res.status, res.body]).toEqual([400, "Bad Request"]);
      expect(res.headers["content-security-policy"]).toBeUndefined();
    },
  );

  test.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("%s is 405 whatever the path", async (method) => {
    for (const pathname of ["/", "/robots.txt", "/assets/app-4f3a2b1c.js", "/assets/nope.js", "/some/app/route"]) {
      const res = await get(pathname, { method });
      expect([pathname, res.status, res.text]).toEqual([pathname, 405, "Method Not Allowed"]);
    }
    // The method is looked at before the path.
    const malformed = await raw("/%zz", method);
    expect([malformed.status, malformed.body]).toEqual([405, "Method Not Allowed"]);
  });
});

describe("/api is never static", () => {
  test("/api and anything under it answer as the API, not with files", async () => {
    for (const pathname of ["/api", "/api/", "/api/index.html", "/api/robots.txt", "/api/assets/app-4f3a2b1c.js", "/api/..%2frobots.txt"]) {
      const res = await get(pathname);
      expect([pathname, res.status]).toEqual([pathname, 404]);
      expect(JSON.parse(res.text)).toEqual(apiError("not_found", "Endpoint not found"));
      expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const posted = await get("/api", { method: "POST" });
    expect(posted.status).toBe(404);
    expect(JSON.parse(posted.text)).toEqual(apiError("not_found", "Endpoint not found"));
  });

  test("a dot segment that resolves into /api reaches the API", async () => {
    const res = await raw("/x/../api/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ data: { ok: true } });
  });
});

describe("files that appear and disappear while the server runs", () => {
  // These tests put files into the directory the harness serves from, and take them away again.
  test("an HTML file under /assets/ is sandboxed and not cached as immutable", async () => {
    const file = path.join(t.staticDir, "assets", "frame-0a1b2c3d.html");
    writeFileSync(file, "<!doctype html><title>frame</title>\n");
    try {
      const res = await get("/assets/frame-0a1b2c3d.html");
      expect(res.status).toBe(200);
      expect(res.text).toBe("<!doctype html><title>frame</title>\n");
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("content-security-policy")).toBe(FRAME_CSP);
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
    } finally {
      rmSync(file, { force: true });
    }
    expect((await get("/assets/frame-0a1b2c3d.html")).status).toBe(404);
  });

  test("a file added after the server started is served, with a name in any script", async () => {
    const dir = path.join(t.staticDir, "übung");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "日本語 ファイル.txt"), "こんにちは\n");
    try {
      const res = await get(`/${encodeURIComponent("übung")}/${encodeURIComponent("日本語 ファイル.txt")}`);
      expect(res.status).toBe(200);
      expect(res.text).toBe("こんにちは\n");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without index.html there is no shell to fall back to", async () => {
    const index = path.join(t.staticDir, "index.html");
    const aside = path.join(t.staticDir, "index.html.aside");
    renameSync(index, aside);
    try {
      for (const pathname of ["/", "/some/app/route", "/index.html"]) {
        const res = await get(pathname);
        expect([pathname, res.status, res.text]).toEqual([pathname, 404, "Not Found"]);
      }
      // Other files are still served.
      expect((await get("/robots.txt")).text).toBe(STATIC_FILES["robots.txt"]!);
    } finally {
      renameSync(aside, index);
    }
    expect(existsSync(index)).toBe(true);
    expectShell(await get("/"));
  });
});

describe("a server without a built web app next to it", () => {
  let bare: TestServer;

  beforeAll(async () => {
    bare = await startServer({ withoutStatic: true });
  });

  afterAll(async () => {
    await bare.close();
  });

  test("answers 404 outside /api", async () => {
    for (const pathname of ["/", "/index.html", "/robots.txt", "/assets/app-4f3a2b1c.js", "/some/app/route"]) {
      const res = await bare.client().fetch(pathname);
      expect([pathname, res.status, await res.text()]).toEqual([pathname, 404, "Not Found"]);
    }
    const head = await bare.client().fetch("/", { method: "HEAD" });
    expect(head.status).toBe(404);
  });

  test("still refuses other methods with 405 and malformed paths with 404", async () => {
    const posted = await bare.client().fetch("/", { method: "POST" });
    expect([posted.status, await posted.text()]).toEqual([405, "Method Not Allowed"]);
    // Without a directory the path is never decoded.
    const malformed = await rawRequest(bare.port, `GET /%zz HTTP/1.1\nHost: localhost:${bare.port}`);
    expect([malformed.status, malformed.body]).toEqual([404, "Not Found"]);
  });

  test("still serves the API", async () => {
    const res = await bare.client().get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { ok: true } });
  });
});
