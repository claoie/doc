import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, startServer, until, type Client, type TestServer } from "./harness";
import {
  CLEARED_COOKIE,
  ISO,
  NOT_FOUND,
  PNG,
  RATE_LIMITED,
  TOKEN,
  UNAUTHORIZED,
  expectApiHeaders,
  expectBody,
  expectError,
  expectInvalid,
  imageFile,
  rawRequest,
  read,
  resetToken,
  sha256,
  signIn,
  waitForMailsTo,
} from "./harness/admin";

/*
 * The HTTP layer every endpoint shares: the /api prefix, route matching,
 * the order of the checks, the cross-origin rule, JSON and multipart bodies,
 * the envelope and its headers, the session cookie and the client address.
 */

let t: TestServer;
let owner: Client;
let ownerUser: any;
let member: Client;
let memberUser: any;
let everyoneId: string;

const DAY = 24 * 60 * 60 * 1000;
/** The address of the suite's own connections: `localhost` is the IPv4 or the IPv6 loopback, depending on the machine. */
const LOOPBACK = ["127.0.0.1", "::1"];

beforeAll(async () => {
  t = await startServer();
  ({ owner, user: ownerUser } = await t.setupOwner());
  ({ client: member, user: memberUser } = await t.addMember(owner, "member@example.com"));
  everyoneId = (await owner.get("/groups")).body.data[0].id;
});

afterAll(async () => {
  await t.close();
});

const json = (body: string | Uint8Array | ReadableStream<Uint8Array>, type: string | null = "application/json"): RequestInit => ({
  body: body as BodyInit,
  headers: type === null ? {} : { "Content-Type": type },
});

/** POSTs a body to `/me/update` as the owner, an endpoint that reads JSON and has no rate limit. */
const update = (init: RequestInit = {}, client: Client = owner) => read(client.raw("POST", "/me/update", init));

describe("the /api prefix", () => {
  test("/api and /api/ are API paths without an endpoint", async () => {
    for (const path of ["/api", "/api/", "/api?x=1", "/api/?x=1"]) {
      const res = await read(t.client().fetch(path));
      expectBody(res, 404, NOT_FOUND);
      expectApiHeaders(res.headers);
    }
  });

  test("paths that only look like the prefix are served by the web app, not the API", async () => {
    for (const path of ["/apix", "/api-docs", "/API/health", "/Api/health", "/%61pi/health", "/v1/api/health"]) {
      const res = await t.client().fetch(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain('<div id="root"></div>');
    }
  });

  test("the query string plays no part in finding the endpoint", async () => {
    expectBody(await t.client().get("/health?x=1&y=/me"), 200, { data: { ok: true } });
    expectBody(await t.client().get("/health?"), 200, { data: { ok: true } });
  });

  test("empty path segments are ignored: doubled and trailing slashes reach the same endpoint", async () => {
    // Accident: the router drops empty segments, so these are not 404s.
    for (const path of ["/api//health", "/api/health/", "/api///health//"]) {
      expectBody(await read(t.client().fetch(path)), 200, { data: { ok: true } });
    }
    expectBody(await read(owner.fetch("/api//groups//")), 200, { data: [expect.objectContaining({ name: "Everyone" })] });
  });

  test("dot segments are resolved before the endpoint is looked up", async () => {
    // Accident: the request URL is normalised before routing; `fetch` would do it itself, so these go over a socket as they are.
    const host = `Host: localhost:${t.port}`;
    for (const target of ["/api/x/../health", "/api/./health", "/api/groups/../../api/health"]) {
      const res = await rawRequest(t.port, `GET ${target} HTTP/1.1\r\n${host}`);
      expect({ target, status: res.status, body: res.body as unknown }).toEqual({ target, status: 200, body: '{"data":{"ok":true}}' });
    }
    const outside = await rawRequest(t.port, `GET /api/../health HTTP/1.1\r\n${host}`);
    expect(outside.status).toBe(200);
    expect(outside.headers["content-type"]).toBe("text/html; charset=utf-8");
  });
});

describe("route matching", () => {
  test("static segments are matched exactly: case matters and percent-escapes are not decoded", async () => {
    for (const path of ["/Health", "/HEALTH", "/%68ealth", "/he%61lth", "/health%3Fx", "/health;v=1", "/health.json", "/healthz", "/h"]) {
      expectBody(await t.client().get(path), 404, NOT_FOUND);
    }
  });

  test("a static segment wins over a parameter in the same place", async () => {
    // `/pages/recent` and `/spaces/all` are endpoints of their own, not the page `recent` or the space `all`.
    expectBody(await owner.get("/pages/recent"), 200, { data: [] });
    expectBody(await owner.get("/spaces/all"), 200, { data: [expect.objectContaining({ slug: "general" })] });
    expectError(await owner.get("/pages/recentx"), 404, "not_found", "Page not found");
    expectError(await owner.get("/spaces/allx"), 404, "not_found", "Space not found");
  });

  test("the method is part of the match", async () => {
    // GET /invitations/accept is the public invitation lookup with the id `accept`, not the accept endpoint.
    expectError(await t.client().get("/invitations/accept"), 400, "invalid_invitation", "This invitation is invalid, expired or has been revoked");
    expectBody(await owner.get("/auth/logout"), 404, NOT_FOUND);
    expectBody(await owner.get("/me/update"), 404, NOT_FOUND);
    expectBody(await owner.post("/me"), 404, NOT_FOUND);
    expectBody(await t.client().post("/health"), 404, NOT_FOUND);
    expect((await owner.get("/me")).status).toBe(200);
  });

  test("the number of segments is part of the match", async () => {
    expectBody(await owner.get("/me/extra"), 404, NOT_FOUND);
    expectBody(await owner.get(`/groups/${everyoneId}`), 404, NOT_FOUND);
    expectBody(await owner.get(`/groups/${everyoneId}/members/extra`), 404, NOT_FOUND);
    expectBody(await t.client().get("/health/health"), 404, NOT_FOUND);
  });

  test("HEAD is answered by GET endpoints, with the headers and no body", async () => {
    const res = await t.client().raw("HEAD", "/health");
    expect(res.status).toBe(200);
    expectApiHeaders(res.headers);
    expect(await res.text()).toBe("");

    const authed = await owner.raw("HEAD", "/me");
    expect(authed.status).toBe(200);
    expect(await authed.text()).toBe("");

    const anonymous = await t.client().raw("HEAD", "/me");
    expect(anonymous.status).toBe(401);
    expectApiHeaders(anonymous.headers);
    expect(await anonymous.text()).toBe("");

    // HEAD finds no POST endpoint, and an unknown path is a 404 as for GET.
    expect((await owner.raw("HEAD", "/auth/logout")).status).toBe(404);
    expect((await owner.raw("HEAD", "/nope")).status).toBe(404);
    expect((await owner.get("/me")).status).toBe(200);
  });

  test("HEAD runs the GET handler: a HEAD on a rate-limited endpoint counts", async () => {
    const client = t.client({ ip: "198.51.100.40" });
    const id = "00000000-0000-4000-8000-000000000000";
    for (let i = 0; i < 30; i++) expect((await client.raw("HEAD", `/invitations/${id}`)).status).toBe(400);
    expect((await client.raw("HEAD", `/invitations/${id}`)).status).toBe(429);
    expectBody(await client.get(`/invitations/${id}`), 429, RATE_LIMITED);
  });

  test("other methods find no endpoint: PUT, DELETE, PATCH and OPTIONS answer 404", async () => {
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
      for (const path of ["/health", "/me", "/auth/logout", "/nope"]) {
        const res = await read(owner.raw(method, path));
        expect({ method, path, status: res.status, body: res.body as unknown }).toEqual({ method, path, status: 404, body: NOT_FOUND });
        expectApiHeaders(res.headers);
      }
    }
    expect((await owner.get("/me")).status).toBe(200);
  });

  test("a preflight gets no CORS headers: the API is same-origin only", async () => {
    const res = await t.client().raw("OPTIONS", "/auth/login", {
      headers: { Origin: "https://elsewhere.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    expectBody(await read(res), 403, { error: { code: "forbidden_origin", message: "Cross-origin request rejected" } });
    for (const header of ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-allow-credentials", "allow"]) {
      expect(res.headers.get(header)).toBeNull();
    }
    const get = await t.client().raw("GET", "/health", { headers: { Origin: "https://elsewhere.example" } });
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBeNull();
    expect(get.headers.get("vary")).toBeNull();
  });

  test("path parameters are percent-decoded", async () => {
    const encoded = [...everyoneId].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("");
    const res = await owner.get(`/groups/${encoded}/members`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    // An escaped slash stays inside the one parameter, and so does anything else once decoded.
    for (const id of ["a%2Fb", "%E2%9C%93", "%20", "a%00b", "%25zz", "%3F", "%23"]) {
      expectError(await owner.get(`/groups/${id}/members`), 404, "not_found", "Group not found");
    }
  });

  test("a malformed escape in a parameter matches no endpoint", async () => {
    for (const id of ["%zz", "%", "%e4%b8", "%ff", "abc%2", "%u0041"]) {
      expectBody(await owner.get(`/groups/${id}/members`), 404, NOT_FOUND);
      expectBody(await t.client().get(`/invitations/${id}?token=x`), 404, NOT_FOUND);
    }
  });
});

describe("sessions and public endpoints", () => {
  const uuid = "00000000-0000-4000-8000-000000000000";
  const protectedRoutes: [string, string][] = [
    ["GET", "/me"],
    ["POST", "/me/update"],
    ["POST", "/me/avatar"],
    ["POST", "/me/avatar/remove"],
    ["POST", "/auth/logout"],
    ["POST", "/auth/change-password"],
    ["GET", "/auth/sessions"],
    ["POST", "/auth/sessions/revoke"],
    ["POST", "/workspace/update"],
    ["POST", "/workspace/logo"],
    ["POST", "/workspace/logo/remove"],
    ["GET", "/members"],
    ["POST", "/members/role"],
    ["POST", "/members/deactivate"],
    ["POST", "/members/activate"],
    ["POST", "/members/delete"],
    ["GET", "/invitations"],
    ["POST", "/invitations"],
    ["POST", "/invitations/resend"],
    ["POST", "/invitations/link"],
    ["POST", "/invitations/revoke"],
    ["GET", "/groups"],
    ["POST", "/groups"],
    ["POST", `/groups/${uuid}/update`],
    ["POST", `/groups/${uuid}/delete`],
    ["GET", `/groups/${uuid}/members`],
    ["POST", `/groups/${uuid}/members/add`],
    ["POST", `/groups/${uuid}/members/remove`],
  ];

  test.each(protectedRoutes)("%s %s needs a session", async (method, path) => {
    const res = await t.client().request(method, path);
    expectBody(res, 401, UNAUTHORIZED);
    expectApiHeaders(res.headers);
    expect(res.headers.getSetCookie()).toEqual([]);

    const stale = t.client();
    stale.cookie = "A".repeat(43);
    expectBody(await stale.request(method, path), 401, UNAUTHORIZED);
  });

  test("public endpoints answer without a session", async () => {
    const anonymous = () => t.client();
    expectBody(await anonymous().get("/health"), 200, { data: { ok: true } });
    expectBody(await anonymous().get("/setup"), 200, { data: { needsSetup: false } });
    expectBody(await anonymous().get("/auth/config"), 200, { data: { sso: { enabled: false, localLogin: true } } });
    expectBody(await anonymous().get("/workspace/public"), 200, { data: { name: "Acme", logoUrl: null } });
    expectInvalid(await anonymous().post("/setup", {}), "workspaceName must be a string");
    expectInvalid(await anonymous().post("/auth/login", {}), "email must be a string");
    expectInvalid(await anonymous().post("/auth/forgot-password", {}), "email must be a string");
    expectInvalid(await anonymous().post("/auth/reset-password", {}), "token must be a string");
    const invalidInvitation = { error: { code: "invalid_invitation", message: "This invitation is invalid, expired or has been revoked" } };
    expectBody(await anonymous().get(`/invitations/${uuid}`), 400, invalidInvitation);
    expectBody(await anonymous().post("/invitations/accept", {}), 400, invalidInvitation);
    expectError(await anonymous().get("/images/nope.png"), 404, "not_found", "Image not found");
  });

  test("a cookie that is no session does not get in the way of a public endpoint", async () => {
    const stale = t.client();
    stale.cookie = "A".repeat(43);
    expectBody(await stale.get("/health"), 200, { data: { ok: true } });
    expectBody(await stale.get("/auth/config"), 200, { data: { sso: { enabled: false, localLogin: true } } });
  });

  test("an unknown endpoint is a 404 with or without a session, before any 401", async () => {
    for (const [method, path] of [["GET", "/nope"], ["POST", "/nope"], ["GET", "/me/nope"], ["POST", "/members/nope"], ["GET", "/a/b/c/d/e/f"]] as const) {
      expectBody(await t.client().request(method, path), 404, NOT_FOUND);
      expectBody(await owner.request(method, path), 404, NOT_FOUND);
    }
  });

  test("the session is checked before the body: no session is a 401 whatever was sent", async () => {
    const anonymous = t.client();
    expectBody(await read(anonymous.raw("POST", "/me/update", json("{nope"))), 401, UNAUTHORIZED);
    expectBody(await read(anonymous.raw("POST", "/me/update", json("x=1", "text/plain"))), 401, UNAUTHORIZED);
    expectBody(await read(anonymous.raw("POST", "/me/avatar", json("{}"))), 401, UNAUTHORIZED);
    expectBody(await anonymous.post("/members/role", { role: "nope" }), 401, UNAUTHORIZED);
    expectBody(await anonymous.get("/members?limit=0"), 401, UNAUTHORIZED);
    expectBody(await anonymous.get("/groups/not-a-uuid/members"), 401, UNAUTHORIZED);
  });

  test("the realtime endpoint needs a session before anything else, and a WebSocket upgrade after that", async () => {
    for (const method of ["GET", "POST", "PUT"]) {
      const res = await read(t.client().raw(method, "/ws", { headers: { Origin: "https://elsewhere.example" } }));
      expectBody(res, 401, UNAUTHORIZED);
      expectApiHeaders(res.headers);
    }
    const plain = await read(owner.raw("GET", "/ws"));
    expectBody(plain, 400, { error: { code: "upgrade_failed", message: "Expected a WebSocket upgrade" } });
    expectApiHeaders(plain.headers);
  });
});

describe("the cross-origin rule for requests that are not GET or HEAD", () => {
  const rejected = { error: { code: "forbidden_origin", message: "Cross-origin request rejected" } };
  const post = (origin: string | null, extra: Record<string, string> = {}) =>
    read(owner.raw("POST", "/me/update", { body: "{}", headers: { "Content-Type": "application/json", ...(origin === null ? {} : { Origin: origin }), ...extra } }));

  test("no Origin header is allowed", async () => {
    expect((await post(null)).status).toBe(200);
  });

  test("an empty Origin header counts as none", async () => {
    expect((await post("")).status).toBe(200);
  });

  test("the origin of APP_URL is allowed, however it is written", async () => {
    for (const origin of ["http://doc.test", "http://doc.test/", "HTTP://DOC.TEST", "http://doc.test:80", "http://doc.test/some/path?x=1"]) {
      const res = await post(origin);
      expect({ origin, status: res.status }).toEqual({ origin, status: 200 });
    }
  });

  test("an origin on the request's own host is allowed, whatever its scheme", async () => {
    for (const origin of [`http://localhost:${t.port}`, `https://localhost:${t.port}`, `http://LOCALHOST:${t.port}/x`]) {
      const res = await post(origin);
      expect({ origin, status: res.status }).toEqual({ origin, status: 200 });
    }
    // The comparison is with the Host header as the client sent it.
    expect((await post("http://wiki.example", { Host: "wiki.example" })).status).toBe(200);
    expect((await post("https://wiki.example:8443", { Host: "wiki.example:8443" })).status).toBe(200);
    expectBody(await post("http://wiki.example:81", { Host: "wiki.example" }), 403, rejected);
  });

  test("any other origin is rejected: another host, port or scheme, `null`, and what is no URL", async () => {
    const origins = [
      "https://doc.test",
      "http://doc.test:8080",
      "http://sub.doc.test",
      "http://doc.test.evil.example",
      "http://localhost",
      `http://localhost:${t.port + 1}`,
      `http://127.0.0.1:${t.port}`,
      "https://evil.example",
      "null",
      "garbage",
      "doc.test",
      "//doc.test",
      "file:///etc/passwd",
    ];
    for (const origin of origins) {
      const res = await post(origin);
      expect({ origin, status: res.status, body: res.body as unknown }).toEqual({ origin, status: 403, body: rejected });
      expectApiHeaders(res.headers);
    }
  });

  test("a rejected request changed nothing", async () => {
    const client = await signIn(t, "member@example.com", "member-password");
    const res = await read(client.raw("POST", "/auth/logout", { body: "{}", headers: { "Content-Type": "application/json", Origin: "https://evil.example" } }));
    expectBody(res, 403, rejected);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await client.get("/me")).status).toBe(200);
    const renamed = await read(client.raw("POST", "/me/update", { ...json('{"name":"Hacked"}'), headers: { "Content-Type": "application/json", Origin: "null" } }));
    expectBody(renamed, 403, rejected);
    expect((await client.get("/me")).body.data.user.name).toBe("member");
  });

  test("the origin is checked before the endpoint is looked up and before the session", async () => {
    const evil = { Origin: "https://evil.example" };
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expectBody(await read(t.client().raw(method, "/nope", { headers: evil })), 403, rejected);
      expectBody(await read(t.client().raw(method, "/me/update", { headers: evil })), 403, rejected);
      expectBody(await read(owner.raw(method, "/nope", { headers: evil })), 403, rejected);
    }
    expectBody(await read(t.client().raw("POST", "", { headers: evil })), 403, rejected);
  });

  test("GET and HEAD are never rejected for their origin", async () => {
    for (const origin of ["https://evil.example", "null", "garbage"]) {
      expectBody(await read(t.client().raw("GET", "/health", { headers: { Origin: origin } })), 200, { data: { ok: true } });
      expect((await owner.raw("GET", "/me", { headers: { Origin: origin } })).status).toBe(200);
      expect((await owner.raw("HEAD", "/me", { headers: { Origin: origin } })).status).toBe(200);
      expectBody(await read(t.client().raw("GET", "/nope", { headers: { Origin: origin } })), 404, NOT_FOUND);
    }
  });

  test("without single sign-on the provider's event endpoint gets no exemption", async () => {
    expectBody(await read(t.client().raw("POST", "/auth/events", { headers: { Origin: "https://idp.example" } })), 403, rejected);
    expectBody(await read(t.client().raw("POST", "/auth/events")), 404, NOT_FOUND);
  });
});

describe("JSON bodies", () => {
  const unsupported = { error: { code: "unsupported_media_type", message: "Expected application/json" } };

  test("an empty body is an empty object, whatever its content type", async () => {
    expect((await update()).status).toBe(200);
    expect((await update(json("", "text/plain"))).status).toBe(200);
    expect((await update(json("", "application/json"))).status).toBe(200);
    expect((await update(json(new Uint8Array(0), null))).status).toBe(200);
    // An endpoint with required fields then misses them.
    expectInvalid(await read(owner.raw("POST", "/members/role")), "role is required");
    expectInvalid(await read(owner.raw("POST", "/auth/sessions/revoke")), "id must be a valid id");
  });

  test("a body that is not declared as JSON is refused with 415", async () => {
    const types = [
      "text/plain",
      "text/plain;charset=UTF-8",
      "text/json",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/ld+json",
      "application/octet-stream",
      "json",
      "application",
    ];
    for (const type of types) {
      const res = await update(json('{"name":"Nope"}', type));
      expect({ type, status: res.status, body: res.body as unknown }).toEqual({ type, status: 415, body: unsupported });
      expectApiHeaders(res.headers);
    }
    // No Content-Type at all (bytes), and the one `fetch` gives a string.
    expectBody(await update(json(new TextEncoder().encode('{"name":"Nope"}'), null)), 415, unsupported);
    expectBody(await update(json('{"name":"Nope"}', null)), 415, unsupported);
    expect((await owner.get("/me")).body.data.user.name).toBe("Owner");
  });

  test("application/json is recognised in any case and with parameters", async () => {
    const types = ["application/json", "application/json; charset=utf-8", "application/json;charset=UTF-8", "APPLICATION/JSON", "Application/Json; Charset=ISO-8859-1", "application/json; boundary=x"];
    for (const type of types) {
      const res = await update(json('{"name":"Owner"}', type));
      expect({ type, status: res.status }).toEqual({ type, status: 200 });
    }
  });

  test("the body is read as UTF-8 whatever charset is declared", async () => {
    const res = await update(json('{"name":"Zoë 日本 🎉"}', "application/json; charset=iso-8859-1"), member);
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe("Zoë 日本 🎉");
    await member.post("/me/update", { name: "member" });
  });

  test("only the start of the type is compared", async () => {
    // Accident: anything that begins with `application/json` passes, such as `application/jsonfoo` or `application/json-seq`.
    expect((await update(json('{"name":"Owner"}', "application/jsonfoo"))).status).toBe(200);
    expect((await update(json('{"name":"Owner"}', "application/json-seq"))).status).toBe(200);
  });

  test("a body that is not JSON is refused", async () => {
    for (const body of ["{", "}", '{"a":}', '{"a":1,}', "{'a':1}", "{a:1}", "NaN", "undefined", "  ", "\n", '{"name":"Owner"} trailing', '{"name":"Owner"}{"name":"Owner"}', '{"name":"\n"}', "01"]) {
      const res = await update(json(body));
      expect({ body, status: res.status, answer: res.body as unknown }).toEqual({ body, status: 400, answer: { error: { code: "invalid_input", message: "Malformed JSON" } } });
    }
  });

  test("JSON that is not an object is refused", async () => {
    for (const body of ["[]", '[{"name":"Owner"}]', '"text"', "123", "0", "1.5", "null", "true", "false", '""']) {
      const res = await update(json(body));
      expect({ body, status: res.status, answer: res.body as unknown }).toEqual({ body, status: 400, answer: { error: { code: "invalid_input", message: "Expected a JSON object" } } });
    }
  });

  test("whitespace around the object is fine, unknown fields are ignored and the last of a repeated key wins", async () => {
    expect((await update(json(' \r\n\t{ "name" : "Owner" }\n '))).status).toBe(200);
    const res = await update(json('{"name":"First","unknown":{"deep":[1,2,3]},"name":"Owner","__proto__":{"name":"x"}}'));
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe("Owner");
  });

  test("a byte order mark before the object is skipped", async () => {
    // Accident: the decoder drops a leading U+FEFF, so this parses.
    const res = await update(json('﻿{"name":"Owner"}'));
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe("Owner");
  });

  test("bytes that are not UTF-8 and lone surrogates become U+FFFD", async () => {
    // Accident: decoding is lenient, so neither is a 400.
    const encoder = new TextEncoder();
    const invalid = new Uint8Array([...encoder.encode('{"name":"a'), 0xff, ...encoder.encode('b"}')]);
    const bytes = await update(json(invalid), member);
    expect(bytes.status).toBe(200);
    expect(bytes.body.data.user.name).toBe("a�b");
    const surrogate = await update(json('{"name":"c\\ud800d"}'), member);
    expect(surrogate.status).toBe(200);
    expect(surrogate.body.data.user.name).toBe("c�d");
    const [row] = await t.sql`SELECT name FROM users WHERE id = ${memberUser.id}`;
    expect(row.name).toBe("c�d");
    await member.post("/me/update", { name: "member" });
  });

  test("escapes are decoded: \\u sequences, surrogate pairs and control characters", async () => {
    const res = await update(json('{"name":"\\u005a\\u006f\\u00eb \\ud83c\\udf89 \\t\\"q\\" \\/ \\\\"}'), member);
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe('Zoë 🎉 \t"q" / \\');
    await member.post("/me/update", { name: "member" });
  });

  const padded = (bytes: number) => {
    const prefix = '{"name":"Owner","pad":"';
    const suffix = '"}';
    return prefix + "x".repeat(bytes - prefix.length - suffix.length) + suffix;
  };
  const streamed = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const data = new TextEncoder().encode(text);
        for (let at = 0; at < data.length; at += 64 * 1024) controller.enqueue(data.subarray(at, at + 64 * 1024));
        controller.close();
      },
    });
  const tooLarge = { error: { code: "payload_too_large", message: "Request body is too large" } };
  const MIB = 1024 * 1024;

  test("a body of exactly 1 MiB is read; one byte more is refused with 413 by its declared length", async () => {
    expect((await update(json(padded(MIB)))).status).toBe(200);
    const res = await update(json(padded(MIB + 1)));
    expectBody(res, 413, tooLarge);
    expectApiHeaders(res.headers);
  });

  test("a body sent without a length is measured as it arrives", async () => {
    expect((await update(json(streamed(padded(MIB))))).status).toBe(200);
    expectBody(await update(json(streamed(padded(MIB + 1)))), 413, tooLarge);
    expectBody(await update(json(streamed(padded(3 * MIB)))), 413, tooLarge);
  });

  test("the size is checked before the content type and before the JSON", async () => {
    expectBody(await update(json(padded(MIB + 1), "text/plain")), 413, tooLarge);
    expectBody(await update(json("x".repeat(MIB + 1))), 413, tooLarge);
    expectBody(await update(json("x".repeat(MIB), "text/plain")), 415, { error: { code: "unsupported_media_type", message: "Expected application/json" } });
    expectInvalid(await update(json("x".repeat(MIB))), "Malformed JSON");
  });

  test("the size counts bytes, not characters", async () => {
    // 349 522 three-byte characters in the wrapper are exactly 1 MiB, and a third as many characters.
    const exact = `{"pad":"${"日".repeat(349_522)}"}`;
    expect(new TextEncoder().encode(exact).length).toBe(MIB);
    expect((await update(json(exact))).status).toBe(200);
    expectBody(await update(json(`{"pad":"${"日".repeat(349_522)}x"}`)), 413, tooLarge);
  });
});

describe("multipart bodies", () => {
  const unsupported = { error: { code: "unsupported_media_type", message: "Expected multipart/form-data" } };
  const upload = (init: RequestInit) => read(member.raw("POST", "/me/avatar", init));
  const boundary = "----doc-test-boundary";
  const part = (name: string, bytes: Uint8Array, filename: string | null = "a.png") =>
    Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename === null ? "" : `; filename="${filename}"`}\r\nContent-Type: image/png\r\n\r\n`),
      Buffer.from(bytes),
      Buffer.from("\r\n"),
    ]);
  const multipart = (...parts: Buffer[]) => Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]);

  test("a body that is not declared as multipart/form-data is refused with 415, even an empty one", async () => {
    expectBody(await upload({}), 415, unsupported);
    expectBody(await upload(json("{}")), 415, unsupported);
    expectBody(await upload({ body: PNG, headers: { "Content-Type": "image/png" } }), 415, unsupported);
    expectBody(await upload({ body: PNG }), 415, unsupported);
    expectBody(await upload({ body: "file=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } }), 415, unsupported);
    expectBody(await upload({ body: multipart(part("file", PNG)), headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` } }), 415, unsupported);
  });

  test("a form without the file field is refused", async () => {
    const res = await member.upload("/me/avatar", { other: imageFile(PNG, "a.png") });
    expectInvalid(res, 'Missing file field "file"');
    expectApiHeaders(res.headers);
    expectInvalid(await member.upload("/me/avatar", { File: imageFile(PNG, "a.png") }), 'Missing file field "file"');
    expectInvalid(await upload({ body: new FormData() }), 'Missing file field "file"');
  });

  test("text where the file should be is refused", async () => {
    expectInvalid(await member.upload("/me/avatar", { file: "just text" }), 'Missing file field "file"');
    expectInvalid(await member.upload("/me/avatar", { file: "" }), 'Missing file field "file"');
    // A part without a file name is text, whatever its content.
    const res = await upload({ body: multipart(part("file", PNG, null)), headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } });
    expectInvalid(res, 'Missing file field "file"');
  });

  test("a body that is not a multipart form is refused", async () => {
    const type = `multipart/form-data; boundary=${boundary}`;
    for (const init of [
      { body: "garbage", headers: { "Content-Type": type } },
      { body: "", headers: { "Content-Type": type } },
      { body: multipart(part("file", PNG)), headers: { "Content-Type": "multipart/form-data" } },
      { body: multipart(part("file", PNG)).subarray(0, 60), headers: { "Content-Type": type } },
      { body: multipart(part("file", PNG)), headers: { "Content-Type": "multipart/form-data; boundary=another" } },
    ]) {
      expectInvalid(await upload(init), "Malformed multipart body");
    }
  });

  test("a form written by hand is read, with the type in any case; the first file field is the one used", async () => {
    const lower = await upload({ body: multipart(part("file", PNG)), headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } });
    expect(lower.status).toBe(200);
    expect(lower.body.data.user.avatarUrl).toMatch(/^\/api\/images\/[0-9a-f-]{36}\.png$/);
    const upper = await upload({ body: multipart(part("file", PNG)), headers: { "Content-Type": `MULTIPART/FORM-DATA; boundary=${boundary}` } });
    expect(upper.status).toBe(200);
    const two = await upload({
      body: multipart(part("other", new TextEncoder().encode("x")), part("file", PNG), part("file", new TextEncoder().encode("not an image"))),
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(two.status).toBe(200);
    const reversed = await upload({
      body: multipart(part("file", new TextEncoder().encode("not an image")), part("file", PNG)),
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    });
    expectInvalid(reversed, "Images must be PNG, JPEG, WebP or GIF");
  });

  test("a form declared larger than 11 MiB is refused before it is read; a file over 10 MiB after", async () => {
    const image = (size: number) => {
      const bytes = new Uint8Array(size);
      bytes.set(PNG);
      return imageFile(bytes, "big.png", "image/png");
    };
    const over = await member.upload("/me/avatar", { file: image(11 * 1024 * 1024 + 1) });
    expectBody(over, 413, { error: { code: "payload_too_large", message: "File is too large" } });
    expectApiHeaders(over.headers);
    // The 11 MiB are the whole form: a file just under them, with the form around it, is over.
    expectBody(await member.upload("/me/avatar", { file: image(11 * 1024 * 1024 - 100) }), 413, { error: { code: "payload_too_large", message: "File is too large" } });
    expectBody(await member.upload("/me/avatar", { file: image(10 * 1024 * 1024 + 1) }), 413, { error: { code: "payload_too_large", message: "Images must be at most 10 MB" } });
    expect((await member.upload("/me/avatar", { file: image(10 * 1024 * 1024) })).status).toBe(200);
    expect((await member.post("/me/avatar/remove")).status).toBe(200);
  });
});

describe("the envelope", () => {
  test("success is { data } with the API headers; an endpoint with nothing to say answers an empty object", async () => {
    const health = await t.client().get("/health");
    expect(health.text).toBe('{"data":{"ok":true}}');
    expectApiHeaders(health.headers);

    const list = await owner.get("/groups");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.data)).toBe(true);
    expectApiHeaders(list.headers);

    const client = await signIn(t, "member@example.com", "member-password");
    const empty = await client.post("/auth/sessions/revoke", { id: "00000000-0000-4000-8000-000000000000" });
    expect(empty.text).toBe('{"data":{}}');
    expectApiHeaders(empty.headers);
  });

  test("failure is { error: { code, message } } with the same headers", async () => {
    const res = await owner.post("/members/role", { role: "nope" });
    expect(res.text).toBe('{"error":{"code":"invalid_input","message":"role must be one of owner, admin, member"}}');
    expectApiHeaders(res.headers);
    for (const header of ["set-cookie", "www-authenticate", "location", "etag", "content-security-policy", "access-control-allow-origin"]) {
      expect(res.headers.get(header)).toBeNull();
    }
    const unauthorized = await t.client().get("/me");
    expect(unauthorized.text).toBe('{"error":{"code":"unauthorized","message":"Sign in required"}}');
    expect(unauthorized.headers.get("www-authenticate")).toBeNull();
  });
});

describe("the session cookie", () => {
  test("the cookie is found among others, with or without spaces around it", async () => {
    const value = owner.cookie!;
    const accepted = [
      `session=${value}`,
      `a=b; session=${value}; c=d`,
      `a=b;session=${value};c=d`,
      `   session   =   ${value}   `,
      `theme=dark;    session=${value}`,
      `session=${value};`,
      `flag; session=${value}`,
      `=x; session=${value}`,
      `Session=nope; SESSION=nope; session=${value}`,
      `xsession=nope; session-old=nope; session=${value}`,
    ];
    for (const cookie of accepted) {
      const res = await t.client().raw("GET", "/me", { headers: { Cookie: cookie } });
      expect({ cookie, status: res.status }).toEqual({ cookie, status: 200 });
    }
  });

  test("the first `session` cookie is the one used, and its name and value are taken as they are", async () => {
    const value = owner.cookie!;
    const refused = [
      `session=nope; session=${value}`,
      `session=; session=${value}`,
      `Session=${value}`,
      `SESSION=${value}`,
      `session="${value}"`,
      `session=${value}x`,
      `session=${value.slice(0, -1)}`,
      `session=${encodeURIComponent(value).replace(/[-_]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}x`,
      `xsession=${value}`,
      `session`,
      `session=`,
      `${value}`,
      `session:${value}`,
    ];
    for (const cookie of refused) {
      const res = await read(t.client().raw("GET", "/me", { headers: { Cookie: cookie } }));
      expect({ cookie, status: res.status, body: res.body as unknown }).toEqual({ cookie, status: 401, body: UNAUTHORIZED });
    }
  });

  test("a cookie value over 100 characters is ignored without being looked up", async () => {
    const at100 = "a".repeat(100);
    const at101 = "b".repeat(101);
    for (const value of [at100, at101]) {
      await t.sql`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (${ownerUser.id}, ${sha256(value)}, now() + interval '1 day')`;
    }
    const short = t.client();
    short.cookie = at100;
    expect((await short.get("/me")).status).toBe(200);
    const long = t.client();
    long.cookie = at101;
    expectBody(await long.get("/me"), 401, UNAUTHORIZED);
    await t.sql`DELETE FROM sessions WHERE token_hash IN (${sha256(at100)}, ${sha256(at101)})`;
  });

  test("the database holds the SHA-256 of the cookie, never the cookie", async () => {
    const client = await signIn(t, "member@example.com", "member-password");
    expect(client.cookie).toMatch(TOKEN);
    const rows = await t.sql`SELECT token_hash FROM sessions WHERE user_id = ${memberUser.id}`;
    expect(rows.map((row: any) => row.token_hash)).toContain(sha256(client.cookie!));
    expect(rows.every((row: any) => /^[0-9a-f]{64}$/.test(row.token_hash))).toBe(true);
    // The hash itself is not a session.
    const replay = t.client();
    replay.cookie = sha256(client.cookie!);
    expectBody(await replay.get("/me"), 401, UNAUTHORIZED);
  });

  test("an expired session is no session; the cookie is not cleared for it", async () => {
    const client = await signIn(t, "member@example.com", "member-password");
    await t.sql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = ${sha256(client.cookie!)}`;
    const res = await client.get("/me");
    expectBody(res, 401, UNAUTHORIZED);
    expect(res.headers.getSetCookie()).toEqual([]);
    // Nothing brings it back but a new expiry.
    await t.sql`UPDATE sessions SET expires_at = now() + interval '1 hour' WHERE token_hash = ${sha256(client.cookie!)}`;
    expect((await client.get("/me")).status).toBe(200);
  });

  test("the session of a deactivated user is no session, and works again once they are activated", async () => {
    const { client, user } = await t.addMember(owner, "sleeper@example.com");
    // Through SQL: the API also ends a deactivated member's sessions.
    await t.sql`UPDATE users SET deactivated_at = now() WHERE id = ${user.id}`;
    expectBody(await client.get("/me"), 401, UNAUTHORIZED);
    expectBody(await client.get("/health"), 200, { data: { ok: true } });
    await t.sql`UPDATE users SET deactivated_at = NULL WHERE id = ${user.id}`;
    expect((await client.get("/me")).status).toBe(200);
  });

  test("a session that single sign-on started ends when it is used while single sign-on is off", async () => {
    // Such a session has a re-check time; with no provider to ask, it is deleted and its sockets are closed.
    const client = await signIn(t, "member@example.com", "member-password");
    const hash = sha256(client.cookie!);
    const socket = await connect(client);
    await t.sql`UPDATE sessions SET auth_sid = 'provider-session', auth_recheck_at = now() + interval '10 minutes' WHERE token_hash = ${hash}`;
    const res = await client.get("/me");
    expectBody(res, 401, UNAUTHORIZED);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await socket.closed).toEqual({ code: 4001, reason: "signed out" });
    expect(await t.sql`SELECT 1 FROM sessions WHERE token_hash = ${hash}`).toHaveLength(0);
  });

  test("a session that was used within the last minute is not refreshed", async () => {
    const client = await signIn(t, "member@example.com", "member-password");
    const hash = sha256(client.cookie!);
    await t.sql`UPDATE sessions SET last_seen_at = now() - interval '45 seconds', expires_at = now() + interval '10 days' WHERE token_hash = ${hash}`;
    const [before] = await t.sql`SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = ${hash}`;
    const res = await client.get("/me");
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    const [after] = await t.sql`SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = ${hash}`;
    expect(after).toEqual(before);
  });

  test("a session last used over a minute ago slides: 30 more days, and the cookie is sent again", async () => {
    const client = await signIn(t, "member@example.com", "member-password");
    const value = client.cookie!;
    const hash = sha256(value);
    await t.sql`UPDATE sessions SET last_seen_at = now() - interval '75 seconds', expires_at = now() + interval '10 days' WHERE token_hash = ${hash}`;
    const started = Date.now();
    const res = await client.get("/me");
    const finished = Date.now();
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([`session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`]);
    const [row] = await t.sql`SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = ${hash}`;
    expect(new Date(row.last_seen_at).getTime()).toBeGreaterThanOrEqual(started - 1000);
    expect(new Date(row.last_seen_at).getTime()).toBeLessThanOrEqual(finished + 1000);
    expect(new Date(row.expires_at).getTime()).toBeGreaterThanOrEqual(started + 30 * DAY - 1000);
    expect(new Date(row.expires_at).getTime()).toBeLessThanOrEqual(finished + 30 * DAY + 1000);
    // Once slid, the next request is within the minute again.
    expect((await client.get("/me")).headers.getSetCookie()).toEqual([]);
  });

  test("the refreshed cookie rides on any successful answer: public endpoints, lists and images", async () => {
    const client = await signIn(t, "member@example.com", "member-password");
    const hash = sha256(client.cookie!);
    const expected = [`session=${client.cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`];
    const stale = () => t.sql`UPDATE sessions SET last_seen_at = now() - interval '75 seconds' WHERE token_hash = ${hash}`;

    await stale();
    expect((await client.get("/health")).headers.getSetCookie()).toEqual(expected);
    await stale();
    expect((await client.get("/auth/sessions")).headers.getSetCookie()).toEqual(expected);
    await stale();
    expect((await client.post("/me/update", {})).headers.getSetCookie()).toEqual(expected);

    const uploaded = await client.upload("/me/avatar", { file: imageFile(PNG, "a.png") });
    await stale();
    const image = await client.raw("GET", uploaded.body.data.user.avatarUrl.slice("/api".length));
    expect(image.status).toBe(200);
    expect(image.headers.getSetCookie()).toEqual(expected);
    await image.arrayBuffer();
    await client.post("/me/avatar/remove");
  });

  test("an answer that is an error extends the session all the same, but carries no cookie", async () => {
    // Accident: the cookie is only added to successful answers, though the session has already slid.
    const client = await signIn(t, "member@example.com", "member-password");
    const hash = sha256(client.cookie!);
    for (const request of [() => client.get("/nope"), () => client.post("/members/role", { role: "nope" }), () => client.post("/workspace/update", { name: "X" })]) {
      await t.sql`UPDATE sessions SET last_seen_at = now() - interval '75 seconds', expires_at = now() + interval '10 days' WHERE token_hash = ${hash}`;
      const started = Date.now();
      const res = await request();
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.getSetCookie()).toEqual([]);
      const [row] = await t.sql`SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = ${hash}`;
      expect(new Date(row.last_seen_at).getTime()).toBeGreaterThanOrEqual(started - 1000);
      expect(new Date(row.expires_at).getTime()).toBeGreaterThanOrEqual(started + 30 * DAY - 1000);
    }
  });

  test("signing out with a session that is due to slide only clears the cookie", async () => {
    const client = await signIn(t, "member@example.com", "member-password");
    const value = client.cookie!;
    await t.sql`UPDATE sessions SET last_seen_at = now() - interval '75 seconds' WHERE token_hash = ${sha256(value)}`;
    const res = await client.post("/auth/logout");
    expect(res.status).toBe(200);
    // Both are sent, the refreshed one first, so the cleared one is what the browser keeps.
    expect(res.headers.getSetCookie()).toEqual([`session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`, CLEARED_COOKIE]);
    expect(client.cookie).toBeNull();
  });
});

describe("the client address behind a trusted proxy", () => {
  /** The address recorded for a sign-in that arrived with this X-Forwarded-For. */
  const addressFor = async (forwarded: string) => {
    const client = await signIn(t, "member@example.com", "member-password", { "X-Forwarded-For": forwarded });
    const sessions = await client.get("/auth/sessions");
    const current = sessions.body.data.find((s: any) => s.current);
    await client.post("/auth/logout");
    return current.ip;
  };

  test("the last entry of X-Forwarded-For is the address", async () => {
    expect(await addressFor("203.0.113.9")).toBe("203.0.113.9");
    expect(await addressFor("203.0.113.1, 203.0.113.2")).toBe("203.0.113.2");
    expect(await addressFor("203.0.113.1,198.51.100.2,192.0.2.3")).toBe("192.0.2.3");
    expect(await addressFor("203.0.113.1, 2001:db8::1")).toBe("2001:db8::1");
  });

  test("spaces around it are dropped", async () => {
    expect(await addressFor("   203.0.113.4   ")).toBe("203.0.113.4");
    expect(await addressFor("203.0.113.1 ,\t203.0.113.5\t")).toBe("203.0.113.5");
  });

  test("it is cut at 64 characters and otherwise taken as written", async () => {
    expect(await addressFor("a".repeat(64))).toBe("a".repeat(64));
    expect(await addressFor("b".repeat(65))).toBe("b".repeat(64));
    expect(await addressFor("not an address")).toBe("not an address");
  });

  test("when the last entry is empty, the address of the connection is used", async () => {
    expect(LOOPBACK).toContain(await addressFor("203.0.113.1,"));
    expect(LOOPBACK).toContain(await addressFor("203.0.113.1, "));
    expect(LOOPBACK).toContain(await addressFor(""));
  });

  test("rate limits follow that address: the same last entry is one client, whatever precedes it", async () => {
    const bodies = [];
    for (let i = 0; i < 11; i++) {
      bodies.push((await t.client().request("POST", "/auth/forgot-password", {}, { "X-Forwarded-For": `10.99.0.${i}, 198.51.100.41` })).status);
    }
    expect(bodies).toEqual([400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 429]);
    // The same entries the other way round are eleven different clients.
    for (let i = 0; i < 11; i++) {
      expect((await t.client().request("POST", "/auth/forgot-password", {}, { "X-Forwarded-For": `198.51.100.41, 10.99.1.${i}` })).status).toBe(400);
    }
  });
});

describe("an unexpected error", () => {
  test("answers 500 internal_error without details, is logged, and the server carries on", async () => {
    // Accident: a NUL character passes validation and the database refuses it, which nothing catches.
    // The same happens wherever text reaches a query, such as `POST /auth/login` (email) and `GET /members?query=%00`.
    const res = await member.post("/me/update", { name: "a\u0000b" });
    expect(res.text).toBe('{"error":{"code":"internal_error","message":"Something went wrong"}}');
    expect(res.status).toBe(500);
    expectApiHeaders(res.headers);
    const entry = await until(() => t.logEntries().find((e) => e.level === "error" && e.path === "/api/me/update"), 2000, "the error in the log");
    expect(entry).toMatchObject({ t: expect.stringMatching(ISO), level: "error", msg: "request failed", method: "POST", path: "/api/me/update", error: expect.any(String) });

    expectError(await t.client().post("/auth/login", { email: "a\u0000b@example.com", password: "whatever" }), 500, "internal_error", "Something went wrong");
    expectError(await member.get("/members?query=%00"), 500, "internal_error", "Something went wrong");
    expect((await member.get("/me")).body.data.user.name).toBe("member");
  });
});

describe("a server with other settings: no trusted proxy, an https APP_URL and request logging", () => {
  let alt: TestServer;

  beforeAll(async () => {
    alt = await startServer({
      keepDatabase: true,
      smtp: t.smtp,
      env: { TRUST_PROXY: undefined, APP_URL: "https://doc.test///", LOG_REQUESTS: undefined },
    });
  });

  afterAll(async () => {
    await alt.close();
  });

  const signInAlt = async (headers: Record<string, string> = {}) => {
    const client = alt.client();
    const res = await client.request("POST", "/auth/login", { email: "owner@example.com", password: "owner-password" }, headers);
    expect(res.status).toBe(200);
    return { client, res };
  };

  test("with an https APP_URL the session cookie is Secure: on sign-in, when it slides and when it is cleared", async () => {
    const { client, res } = await signInAlt();
    const value = client.cookie!;
    expect(value).toMatch(TOKEN);
    expect(res.headers.getSetCookie()).toEqual([`session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`]);

    await alt.sql`UPDATE sessions SET last_seen_at = now() - interval '75 seconds' WHERE token_hash = ${sha256(value)}`;
    expect((await client.get("/me")).headers.getSetCookie()).toEqual([`session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`]);

    const out = await client.post("/auth/logout");
    expect(out.headers.getSetCookie()).toEqual(["session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure"]);
  });

  test("without a trusted proxy X-Forwarded-For is ignored: sessions record the connection's address", async () => {
    const { client } = await signInAlt({ "X-Forwarded-For": "203.0.113.77" });
    const sessions = await client.get("/auth/sessions");
    expect(LOOPBACK).toContain(sessions.body.data.find((s: any) => s.current).ip);
    const [row] = await alt.sql`SELECT ip FROM sessions WHERE token_hash = ${sha256(client.cookie!)}`;
    expect(LOOPBACK).toContain(row.ip);
    await client.post("/auth/logout");
  });

  test("and rate limits count per connection address, whatever the header says", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await alt.client().get(`/invitations/${id}`)).status);
    expect(statuses).toEqual([...Array(30).fill(400), 429]);
    expectBody(await alt.client({ ip: "203.0.113.78" }).get(`/invitations/${id}`), 429, RATE_LIMITED);
    // The copy that trusts its proxy keeps its own count.
    expect((await t.client({ ip: "127.0.0.1" }).get(`/invitations/${id}`)).status).toBe(400);
  });

  test("the origin of the https APP_URL is the allowed one, and trailing slashes of APP_URL are dropped", async () => {
    const { client } = await signInAlt();
    const post = (origin: string) => read(client.raw("POST", "/me/update", { body: "{}", headers: { "Content-Type": "application/json", Origin: origin } }));
    expect((await post("https://doc.test")).status).toBe(200);
    expect((await post("https://doc.test:443")).status).toBe(200);
    expectError(await post("http://doc.test"), 403, "forbidden_origin", "Cross-origin request rejected");
    expect((await post(`http://localhost:${alt.port}`)).status).toBe(200);

    // Links in mail are built on APP_URL without its trailing slashes.
    const invited = await client.post("/invitations", { emails: ["https-link@example.com"] });
    expect(invited.status).toBe(200);
    expect(invited.body.data[0].url).toMatch(/^https:\/\/doc\.test\/invites\/[0-9a-f-]{36}\?token=[A-Za-z0-9_-]{43}$/);
    const [mail] = await waitForMailsTo(t, "https-link@example.com");
    expect(mail!.text).toBe(`Owner invited you to join Acme.\n\nAccept invitation: ${invited.body.data[0].url}`);
    await client.post("/invitations/revoke", { id: invited.body.data[0].id });
    await client.post("/auth/logout");
  });

  test("the reset link is on the https APP_URL too, and the session it starts has a Secure cookie", async () => {
    await t.addMember(owner, "alt-reset@example.com");
    await waitForMailsTo(t, "alt-reset@example.com", 1);
    expectBody(await alt.client().post("/auth/forgot-password", { email: "alt-reset@example.com" }), 200, { data: {} });
    const mail = (await waitForMailsTo(t, "alt-reset@example.com", 2))[1]!;
    expect(mail.text).toMatch(/\n\nReset password: https:\/\/doc\.test\/reset-password\?token=[A-Za-z0-9_-]{43}$/);
    const res = await alt.client().post("/auth/reset-password", { token: resetToken(mail), password: "another-password" });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(/^session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/)]);
  });

  test("each request is logged as one line with its method, path, status, duration and user; health checks are not", async () => {
    const { client } = await signInAlt();
    const marker = `/api/log-marker-${Date.now()}`;
    await client.get("/me?secret=token-in-query");
    await alt.client().get("/health");
    await alt.client().get("/me");
    await client.post("/members/role", { role: "nope" });
    await client.fetch(marker);
    await until(() => alt.logEntries().some((e) => e.path === marker), 3000, "the request log");
    const lines = alt.logEntries().filter((e) => "status" in e);
    const mine = lines.filter((e) => e.userId === ownerUser.id || e.path === marker);

    expect(lines.every((e) => Object.keys(e).sort().join() === "method,ms,path,status,t,userId")).toBe(true);
    expect(lines.every((e) => ISO.test(e.t) && Number.isInteger(e.ms) && e.ms >= 0)).toBe(true);
    expect(lines.some((e) => e.path === "/api/health")).toBe(false);
    expect(lines.some((e) => String(e.path).includes("?") || JSON.stringify(e).includes("token-in-query"))).toBe(false);
    expect(mine.slice(-3).map(({ method, path, status, userId }) => ({ method, path, status, userId }))).toEqual([
      { method: "GET", path: "/api/me", status: 200, userId: ownerUser.id },
      { method: "POST", path: "/api/members/role", status: 400, userId: ownerUser.id },
      { method: "GET", path: marker, status: 404, userId: ownerUser.id },
    ]);
    expect(lines).toContainEqual({ t: expect.stringMatching(ISO), method: "GET", path: "/api/me", status: 401, ms: expect.any(Number), userId: null });
    // The sign-in itself is logged without a user: the request arrived without a session.
    expect(lines).toContainEqual({ t: expect.stringMatching(ISO), method: "POST", path: "/api/auth/login", status: 200, ms: expect.any(Number), userId: null });
    await client.post("/auth/logout");
  });

  test("a realtime upgrade is logged with status 101; this copy does not lead realtime and closes the socket with 1013", async () => {
    const { client } = await signInAlt();
    const socket = await connect(client);
    expect(await socket.closed).toEqual({ code: 1013, reason: "not the realtime leader" });
    const entry = await until(() => alt.logEntries().find((e) => e.path === "/api/ws"), 3000, "the upgrade in the log");
    expect(entry).toEqual({ t: expect.stringMatching(ISO), method: "GET", path: "/api/ws", status: 101, ms: expect.any(Number), userId: ownerUser.id });
    await client.post("/auth/logout");
  });
});
