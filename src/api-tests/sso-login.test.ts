import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type TestServer } from "./harness";
import {
  answers,
  b64url,
  finishLogin,
  forgeLogin,
  logged,
  nowSeconds,
  sessionRow,
  sha256Base64Url,
  sha256Hex,
  signIn,
  signJwt,
  signingKey,
  startFakeProvider,
  startLogin,
  withBadSignature,
  type FakeProvider,
  type FinishedLogin,
  type LoginState,
  type Person,
  type SignInOptions,
} from "./harness/oidc";

/*
 * Signing in through the identity provider: `GET /auth/login` sends the
 * browser to the provider, `GET /auth/callback` takes it back, and every way
 * either fails. Who the person turns out to be is in sso-users.test.ts.
 */

const ISSUER = "https://auth.example.test";
/** Every character here needs form-encoding in the HTTP Basic credentials. */
const SECRET = "s3cret +/=&%:é";
const CLEARED_LOGIN_COOKIE = "__Host-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";
const RANDOM = /^[A-Za-z0-9_-]{43}$/;

const idp: FakeProvider = startFakeProvider({ issuer: ISSUER, clientSecret: SECRET });
/** A key the provider does not publish, under the `kid` of the one it does. */
const stranger = signingKey("k1");

let t: TestServer;

const alice: Person = { sub: "usr_alice", username: "alice", name: "Alice", role: "owner" };

/** A person nobody has seen, so a refused sign-in can be told from one that created them. */
let strangers = 0;
const newPerson = (): Person => {
  const n = ++strangers;
  return { sub: `usr_new_${n}`, username: `new${n}` };
};

/** The callback signed nobody in: back to the sign-in page with the reason, the login cookie deleted, no session cookie. */
const expectRefused = (finished: FinishedLogin, reason: string) => {
  expect(finished.status).toBe(302);
  expect(finished.location).toBe(`/login?sso_error=${reason}`);
  expect(finished.res.headers.get("cache-control")).toBe("no-store");
  expect(finished.setCookies).toEqual([CLEARED_LOGIN_COOKIE]);
};

/** The server logged why it refused a sign-in, after log line `mark`. */
const refusalLogged = (server: TestServer, mark: number, reason: string) =>
  logged(server, { level: "warn", msg: "single sign-on refused", reason }, mark);

/** A callback with a login cookie of the test's making. */
const forgedCallback = async (server: TestServer, person: Person, changes: LoginState = {}, options: Parameters<typeof forgeLogin>[4] = {}) => {
  const client = server.client();
  const forged = forgeLogin(client, idp, person, changes, options);
  return { client, forged, finished: await finishLogin(client, forged.callback) };
};

afterAll(async () => {
  await idp.stop();
});

describe("with single sign-on off", () => {
  let off: TestServer;

  beforeAll(async () => {
    off = await startServer();
  });

  afterAll(async () => {
    await off.close();
  });

  test("the sign-on routes answer as unknown endpoints do", async () => {
    const anonymous = off.client();
    const unknown = await anonymous.get("/auth/nothing-here");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: { code: "not_found", message: "Endpoint not found" } } as never);
    const answersGiven = [
      await anonymous.get("/auth/login?returnTo=/"),
      await anonymous.get("/auth/callback?code=c0de&state=x"),
      await anonymous.request("POST", "/auth/events", undefined),
      await anonymous.post("/auth/events", {}),
    ];
    for (const res of answersGiven) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(unknown.body);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });

  test("an event posted from another origin is refused like any cross-origin POST", async () => {
    const res = await off.client().request("POST", "/auth/events", undefined, { Origin: "https://auth.example.test" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden_origin", message: "Cross-origin request rejected" } } as never);
  });
});

describe("while the provider's discovery document cannot be had", () => {
  // Its own provider and server: once a server has the document, it keeps it.
  const broken = startFakeProvider({ issuer: ISSUER });
  let d: TestServer;

  beforeAll(async () => {
    d = await startServer({ env: broken.env });
  });

  afterEach(() => {
    broken.heal();
  });

  afterAll(async () => {
    await d.close();
    await broken.stop();
  });

  /** What breaks, and what the server logs about it: nothing when the provider is merely unreachable. */
  const FAILURES: [string, () => void, string | null][] = [
    ["is down", () => broken.down(), null],
    ["answers 503", () => (broken.hooks.discovery = answers.status(503, { error: "temporarily_unavailable" })), null],
    ["answers 404", () => (broken.hooks.discovery = answers.status(404, { error: "not_found" })), null],
    ["answers 429", () => (broken.hooks.discovery = answers.status(429, { error: "slow_down" })), null],
    ["answers with a redirect", () => (broken.hooks.discovery = answers.redirect(`${broken.url}/moved/openid-configuration`)), null],
    ["answers with something that is not JSON", () => (broken.hooks.discovery = answers.text("<html>maintenance</html>", "text/html")), null],
    ["answers with JSON that is not an object", () => (broken.hooks.discovery = answers.json([{ issuer: ISSUER }])), null],
    [
      "names another issuer",
      () => (broken.editDiscovery = (document) => ({ ...document, issuer: `${ISSUER}/` })),
      "the discovery document names a different issuer",
    ],
    [
      "names its back-channel address as the issuer",
      () => (broken.editDiscovery = (document) => ({ ...document, issuer: broken.url })),
      "the discovery document names a different issuer",
    ],
    [
      "has no authorization endpoint",
      () => (broken.editDiscovery = (document) => ({ ...document, authorization_endpoint: undefined })),
      "the discovery document has no authorization_endpoint",
    ],
    [
      "has no token endpoint",
      () => (broken.editDiscovery = (document) => ({ ...document, token_endpoint: null })),
      "the discovery document has no token_endpoint",
    ],
    [
      "has no key set address",
      () => (broken.editDiscovery = (document) => ({ ...document, jwks_uri: undefined })),
      "the discovery document has no jwks_uri",
    ],
    [
      "has a key set address that is not a string",
      () => (broken.editDiscovery = (document) => ({ ...document, jwks_uri: 42 })),
      "the discovery document has no jwks_uri",
    ],
  ];

  test.each(FAILURES)("when the provider %s, /auth/login sends the browser back to the sign-in page", async (_what, breakIt, error) => {
    breakIt();
    const mark = d.logs.length;
    const started = await startLogin(d.client(), "/s/general");
    expect(started.res.status).toBe(302);
    expect(started.location).toBe("/login?sso_error=unavailable");
    expect(started.res.headers.get("cache-control")).toBe("no-store");
    // No login was started, and a cookie left from an earlier try is deleted.
    expect(started.setCookies).toEqual([CLEARED_LOGIN_COOKIE]);
    if (error) await logged(d, { level: "error", msg: "starting single sign-on failed", error }, mark);
  });

  test.each(FAILURES)("when the provider %s, a callback cannot redeem its code", async (_what, breakIt, error) => {
    breakIt();
    const mark = d.logs.length;
    const { finished } = await forgedCallback(d, newPerson());
    // A document that is there but wrong is the provider's fault, not its absence.
    expectRefused(finished, error ? "login_failed" : "unavailable");
    if (error) await logged(d, { level: "error", msg: "single sign-on failed", error }, mark);
    expect(broken.count("token")).toBe(0);
  });

  test("a redirect from the discovery address is not followed", async () => {
    broken.hooks.discovery = answers.redirect(`${broken.url}/moved/openid-configuration`);
    broken.clearRequests();
    expect((await startLogin(d.client())).location).toBe("/login?sso_error=unavailable");
    expect(broken.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /.well-known/openid-configuration"]);
  });

  test("a failure is not remembered: the document is asked for again at each try, then kept once it is had", async () => {
    broken.clearRequests();
    broken.hooks.discovery = answers.status(503);
    for (let i = 0; i < 3; i++) expect((await startLogin(d.client())).location).toBe("/login?sso_error=unavailable");
    expect(broken.count("discovery")).toBe(3);
    broken.heal();
    for (let i = 0; i < 3; i++) expect((await startLogin(d.client())).res.status).toBe(302);
    expect(broken.count("discovery")).toBe(4);
    expect(broken.seen("discovery")[3]!.headers.accept).toBe("application/json");
    // Kept from now on, whatever the provider does next.
    broken.hooks.discovery = answers.status(503);
    const started = await startLogin(d.client());
    expect(started.authorize!.origin + started.authorize!.pathname).toBe("https://auth.example.test/oauth/authorize");
    expect(broken.count("discovery")).toBe(4);
  });
});

describe("with single sign-on on", () => {
  beforeAll(async () => {
    t = await startServer({ env: idp.env });
  });

  afterEach(() => {
    idp.heal();
  });

  afterAll(async () => {
    await t.close();
  });

  describe("GET /auth/login", () => {
    test("sends the browser to the provider's authorization endpoint with a code request bound to a login cookie", async () => {
      const before = nowSeconds();
      const started = await startLogin(t.client(), "/s/general");
      const after = nowSeconds();
      expect(started.res.status).toBe(302);
      expect(started.res.headers.get("cache-control")).toBe("no-store");
      const url = started.authorize!;
      expect(url.origin + url.pathname).toBe("https://auth.example.test/oauth/authorize");
      expect(url.hash).toBe("");
      const query = Object.fromEntries(url.searchParams);
      expect(query).toEqual({
        response_type: "code",
        client_id: "doc",
        redirect_uri: "http://doc.test/api/auth/callback",
        scope: "openid profile email",
        state: expect.stringMatching(RANDOM),
        nonce: expect.stringMatching(RANDOM),
        code_challenge: expect.stringMatching(RANDOM),
        code_challenge_method: "S256",
      });
      // Each parameter once.
      expect([...url.searchParams.keys()].sort()).toEqual(Object.keys(query).sort());

      // The login cookie: five minutes, for the whole site, never sent over plain http.
      expect(started.setCookies).toEqual([expect.stringMatching(/^__Host-login=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=300$/)]);
      // It holds what the callback needs, as base64url JSON.
      expect(started.saved).toEqual({
        state: query.state,
        nonce: query.nonce,
        verifier: expect.stringMatching(RANDOM),
        returnTo: "/s/general",
        iat: expect.any(Number),
        fresh: false,
      });
      const saved = started.saved!;
      expect(Number.isInteger(saved.iat)).toBe(true);
      expect(saved.iat).toBeGreaterThanOrEqual(before);
      expect(saved.iat).toBeLessThanOrEqual(after);
      // PKCE: the challenge is the SHA-256 of the verifier, which only the cookie holds.
      expect(sha256Base64Url(saved.verifier)).toBe(query.code_challenge!);
      expect(new Set([saved.state, saved.nonce, saved.verifier, query.code_challenge]).size).toBe(4);
    });

    test("makes a new state, nonce and verifier for every login", async () => {
      const one = await startLogin(t.client());
      const two = await startLogin(t.client());
      for (const field of ["state", "nonce", "verifier"]) expect(one.saved![field]).not.toBe(two.saved![field]);
      expect(one.authorize!.searchParams.get("code_challenge")).not.toBe(two.authorize!.searchParams.get("code_challenge"));
    });

    test("needs no session, and leaves the session of someone signed in alone", async () => {
      const { client } = await signIn(t.base, idp, alice);
      const session = client.cookie;
      const started = await startLogin(client);
      expect(started.res.status).toBe(302);
      expect(started.setCookies).toHaveLength(1);
      expect(client.cookie).toBe(session);
      expect((await client.get("/me")).status).toBe(200);
    });

    test("lands on / after sign-in when no return path is given", async () => {
      expect((await startLogin(t.client())).saved!.returnTo).toBe("/");
      expect((await startLogin(t.client(), "")).saved!.returnTo).toBe("/");
    });

    test.each([
      ["the home page", "/"],
      ["a path", "/s/general"],
      ["a path with a query and a fragment", "/p/abc?x=1&y=2#frag"],
      ["a path in other scripts", "/s/日本語/ページ?q=é&e=😀"],
      ["a path with an encoded space", "/s/a%20b"],
      ["a path with a non-breaking space", "/a b"],
      ["a path whose later segment is empty", "/.//evil.example"],
      ["a path that looks like a user name", "/@evil.example"],
      ["a path of 2048 characters", `/${"a".repeat(2047)}`],
      // The limit counts UTF-16 code units: 2047 accented letters are 4094 bytes, 1023 emoji are 1023 characters.
      ["a path of 2048 accented letters", `/${"é".repeat(2047)}`],
      ["a path of 2048 code units of emoji", `/${"😀".repeat(1023)}a`],
    ])("keeps %s as the place to return to", async (_what, returnTo) => {
      const started = await startLogin(t.client(), returnTo);
      expect(started.res.status).toBe(302);
      expect(started.saved!.returnTo).toBe(returnTo);
    });

    test.each([
      ["an absolute URL", "https://evil.example/x"],
      ["a protocol-relative URL", "//evil.example/x"],
      ["a path without its leading slash", "s/general"],
      ["a path starting with a backslash after the slash", "/\\evil.example"],
      ["a path with a backslash further on", "/a\\b"],
      ["a path with a tab", "/a\tb"],
      ["a path with a line break", "/a\nb"],
      ["a path with a carriage return", "/a\rb"],
      ["a path with a space", "/a b"],
      ["a path with a NUL", "/a\u0000b"],
      ["a path with a DEL", "/a\u007fb"],
      ["a path of 2049 characters", `/${"a".repeat(2048)}`],
      ["a path of 2049 code units of emoji", `/${"😀".repeat(1024)}`],
      ["a javascript: URL", "javascript:alert(1)"],
    ])("replaces %s with /", async (_what, returnTo) => {
      const started = await startLogin(t.client(), returnTo);
      expect(started.res.status).toBe(302);
      expect(started.authorize!.origin).toBe("https://auth.example.test");
      expect(started.saved!.returnTo).toBe("/");
    });

    test("takes the first returnTo when the query has several", async () => {
      const client = t.client();
      const res = await client.fetch("/api/auth/login?returnTo=/first&returnTo=/second");
      expect(res.status).toBe(302);
      expect(JSON.parse(Buffer.from(client.cookies.get("__Host-login")!, "base64url").toString()).returnTo).toBe("/first");
    });
  });

  describe("GET /auth/callback, when all is well", () => {
    test("redeems the code with the verifier, starts a session tied to the provider's, and returns to where the login began", async () => {
      idp.clearRequests();
      const browser = t.client();
      const before = Date.now();
      const started = await startLogin(browser, "/s/general?tab=pages#top");
      const authorization = idp.authorize(started.authorize!, alice);
      const finished = await finishLogin(browser, authorization.callback, { headers: { "User-Agent": "Mozilla/5.0 (api-suite)" } });
      const after = Date.now();

      expect(finished.status).toBe(302);
      expect(finished.location).toBe("/s/general?tab=pages#top");
      expect(finished.res.headers.get("cache-control")).toBe("no-store");
      // The session cookie as any sign-in sets it (APP_URL is plain http here, so not Secure), and the login cookie deleted.
      expect(finished.setCookies).toEqual([
        expect.stringMatching(/^session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/),
        CLEARED_LOGIN_COOKIE,
      ]);
      expect(browser.cookies.has("__Host-login")).toBe(false);

      // The one token request: the code, the redirect URI and the PKCE verifier, with the client's credentials in HTTP Basic.
      const tokenRequests = idp.seen("token");
      expect(tokenRequests).toHaveLength(1);
      const request = tokenRequests[0]!;
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/oauth/token");
      expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(request.headers.accept).toBe("application/json");
      expect(Object.fromEntries(request.form)).toEqual({
        grant_type: "authorization_code",
        code: authorization.code,
        redirect_uri: "http://doc.test/api/auth/callback",
        code_verifier: started.saved!.verifier,
      });
      expect(request.basic).toEqual({ id: "doc", secret: SECRET, raw: "doc:s3cret+%2B%2F%3D%26%25%3A%C3%A9" });
      // Nothing else was asked of the provider: this server already has its discovery document and keys
      // (sso-config.test.ts shows the order of the calls on a server that has neither).
      expect(idp.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /oauth/token"]);

      // The session: tied to the provider's session and refresh token, to be re-checked in 10 minutes.
      const session = (await sessionRow(t.sql, browser))!;
      const [user] = await t.sql`SELECT * FROM users WHERE auth_sub = 'usr_alice'`;
      expect(session.token_hash).toBe(sha256Hex(browser.cookie!));
      expect(session.user_id).toBe(user.id);
      expect(session.auth_sid).toBe("ses_alice");
      expect([...idp.refreshTokens.keys()]).toContain(session.auth_refresh_token);
      const recheckAt = new Date(session.auth_recheck_at).getTime();
      expect(recheckAt).toBeGreaterThanOrEqual(before + 600_000);
      expect(recheckAt).toBeLessThanOrEqual(after + 600_000);
      const expiresAt = new Date(session.expires_at).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * 86_400_000);
      expect(expiresAt).toBeLessThanOrEqual(after + 30 * 86_400_000);
      expect(session.ip).toBe(browser.ip);
      expect(session.user_agent).toBe("Mozilla/5.0 (api-suite)");
      const lastLogin = new Date(user.last_login_at).getTime();
      expect(lastLogin).toBeGreaterThanOrEqual(before - 1000);
      expect(lastLogin).toBeLessThanOrEqual(after + 1000);

      const me = await browser.get("/me");
      expect(me.status).toBe(200);
      expect(me.body.data.user).toMatchObject({ id: user.id, name: "Alice", email: "alice@example.com", role: "owner" });
    });

    test("signing in again while signed in starts another session and leaves the first one working", async () => {
      const first = await signIn(t.base, idp, alice);
      const cookie = first.client.cookie!;
      const second = await signIn(t.base, idp, alice, { client: first.client });
      expect(second.location).toBe("/");
      expect(first.client.cookie).not.toBe(cookie);
      const earlier = t.client();
      earlier.cookie = cookie;
      expect((await earlier.get("/me")).status).toBe(200);
      expect((await first.client.get("/me")).status).toBe(200);
    });

    test("a provider that issues no refresh token gives a session without one", async () => {
      for (const options of [{ noRefreshToken: true }, { answer: (normal) => ({ ...normal, refresh_token: 42 }) }] satisfies SignInOptions[]) {
        const signedIn = await signIn(t.base, idp, alice, options);
        expect(signedIn.location).toBe("/");
        const session = (await sessionRow(t.sql, signedIn.client))!;
        expect(session.auth_refresh_token).toBeNull();
        expect(session.auth_sid).toBe("ses_alice");
        expect(session.auth_recheck_at).not.toBeNull();
      }
    });

    test.each([
      ["a protocol-relative URL", "//evil.example/x"],
      ["an absolute URL", "https://evil.example/x"],
      ["a path with a backslash", "/\\evil.example"],
      ["a path with a tab", "/a\tb"],
      ["a number", 42],
      ["nothing", undefined],
      ["a path of 2049 characters", `/${"a".repeat(2048)}`],
    ])("a login cookie that asks to return to %s lands on /", async (_what, returnTo) => {
      const { finished } = await forgedCallback(t, alice, { returnTo });
      expect(finished.status).toBe(302);
      expect(finished.location).toBe("/");
    });

    test("the return path is taken from the login cookie, whatever the callback's query says", async () => {
      const client = t.client();
      const forged = forgeLogin(client, idp, alice, { returnTo: "/s/general" });
      const finished = await finishLogin(client, `${forged.callback}&returnTo=/elsewhere`);
      expect(finished.location).toBe("/s/general");
    });
  });

  describe("GET /auth/callback, the login cookie", () => {
    /** The callback as the provider would redirect to it, with whatever cookie header the test sends. */
    const callbackWith = async (cookieHeader: string | null, query?: string) => {
      const client = t.client();
      const forged = forgeLogin(client, idp, newPerson());
      client.cookies.clear();
      const mark = t.logs.length;
      const finished = await finishLogin(client, query === undefined ? forged.callback : `/api/auth/callback${query}`, cookieHeader === null ? {} : { headers: { cookie: cookieHeader } });
      return { finished, mark, forged, client };
    };

    test("a callback without a login cookie signs nobody in", async () => {
      const tokenRequests = idp.count("token");
      const { finished, mark } = await callbackWith(null);
      expectRefused(finished, "login_failed");
      await refusalLogged(t, mark, "no_login_cookie");
      // The provider was not asked to redeem anything.
      expect(idp.count("token")).toBe(tokenRequests);
    });

    test.each([
      ["is empty", "__Host-login=", "no_login_cookie"],
      ["is not base64url", "__Host-login={\"state\":\"x\"}", "no_login_cookie"],
      ["is base64 with padding", `__Host-login=${Buffer.from(JSON.stringify({ state: "x", nonce: "y", verifier: "z", iat: 1 })).toString("base64")}=`, "no_login_cookie"],
      ["is another cookie's name", `login=${b64url({ state: "x" })}`, "no_login_cookie"],
      ["does not hold JSON", `__Host-login=${b64url("not json")}`, "malformed segment"],
      ["holds a JSON array", `__Host-login=${b64url([1, 2])}`, "malformed segment"],
      ["holds a JSON string", `__Host-login=${b64url('"state"')}`, "malformed segment"],
      ["holds null", `__Host-login=${b64url("null")}`, "malformed segment"],
      ["holds an empty object", `__Host-login=${b64url({})}`, "no_login_cookie"],
    ])("a login cookie that %s is refused", async (_what, cookieHeader, reason) => {
      const { finished, mark } = await callbackWith(cookieHeader);
      expectRefused(finished, "login_failed");
      await refusalLogged(t, mark, reason);
    });

    test.each([
      ["no state", { state: undefined }],
      ["a state that is not a string", { state: 12345 }],
      ["no nonce", { nonce: undefined }],
      ["a nonce that is not a string", { nonce: null }],
      ["no verifier", { verifier: undefined }],
      ["a verifier that is not a string", { verifier: ["v"] }],
      ["no time", { iat: undefined }],
      ["a time that is not a number", { iat: String(nowSeconds()) }],
    ] as [string, LoginState][])("a login cookie with %s is refused", async (_what, changes) => {
      const client = t.client();
      const forged = forgeLogin(client, idp, newPerson(), changes);
      const mark = t.logs.length;
      // The state in the query is the one the provider would have been given.
      expectRefused(await finishLogin(client, forged.callback), "login_failed");
      await refusalLogged(t, mark, "no_login_cookie");
    });

    test("a login started more than five minutes ago has expired", async () => {
      const mark = t.logs.length;
      const { finished, client } = await forgedCallback(t, newPerson(), { iat: nowSeconds() - 301 });
      expectRefused(finished, "login_failed");
      await refusalLogged(t, mark, "login_expired");
      expect(client.cookie).toBeNull();
    });

    test("a login started a little under five minutes ago still completes", async () => {
      const { finished } = await forgedCallback(t, alice, { iat: nowSeconds() - 290 });
      expect(finished.location).toBe("/");
    });

    test("a login cookie dated more than 30 seconds ahead is refused, and one within 30 seconds accepted", async () => {
      const mark = t.logs.length;
      expectRefused((await forgedCallback(t, newPerson(), { iat: nowSeconds() + 40 })).finished, "login_failed");
      await refusalLogged(t, mark, "login_expired");
      expect((await forgedCallback(t, alice, { iat: nowSeconds() + 28 })).finished.location).toBe("/");
    });

    test("the login cookie is found among other cookies", async () => {
      const client = t.client();
      const forged = forgeLogin(client, idp, alice);
      const finished = await finishLogin(client, forged.callback, {
        headers: { cookie: `theme=dark; session=not-a-session;  __Host-login=${forged.cookie} ; other=1` },
      });
      expect(finished.location).toBe("/");
    });
  });

  describe("GET /auth/callback, what the provider sent the browser back with", () => {
    const callback = async (query: (forged: ReturnType<typeof forgeLogin>) => string) => {
      const client = t.client();
      const forged = forgeLogin(client, idp, newPerson());
      const mark = t.logs.length;
      const tokenRequests = idp.count("token");
      const finished = await finishLogin(client, `/api/auth/callback${query(forged)}`);
      // Nothing below gets as far as redeeming a code.
      expect(idp.count("token")).toBe(tokenRequests);
      return { finished, mark };
    };

    test("a state other than the login cookie's is refused", async () => {
      for (const query of [
        (f: { code: string }) => `?code=${f.code}&state=${"x".repeat(43)}`,
        (f: { code: string }) => `?code=${f.code}`,
        (f: { code: string }) => `?code=${f.code}&state=`,
        (f: { code: string; state: string }) => `?code=${f.code}&state=${f.state.toLowerCase()}x`,
      ]) {
        const { finished, mark } = await callback(query);
        expectRefused(finished, "login_failed");
        await refusalLogged(t, mark, "state_mismatch");
      }
    });

    test("the provider's access_denied is told apart from its other errors", async () => {
      const denied = await callback((f) => `?error=access_denied&error_description=The+user+said+no&state=${f.state}`);
      expectRefused(denied.finished, "access_denied");
      const failed = await callback((f) => `?error=server_error&state=${f.state}`);
      expectRefused(failed.finished, "login_failed");
      await refusalLogged(t, failed.mark, "authorization_error: server_error");
    });

    test("the provider's error is read before the state and the code", async () => {
      expectRefused((await callback(() => "?error=access_denied")).finished, "access_denied");
      expectRefused((await callback((f) => `?error=access_denied&state=wrong&code=${f.code}`)).finished, "access_denied");
      const failed = await callback((f) => `?error=interaction_required&code=${f.code}&state=${f.state}`);
      expectRefused(failed.finished, "login_failed");
      await refusalLogged(t, failed.mark, "authorization_error: interaction_required");
    });

    test("an empty error, and one of any length, are failures too: 64 characters of it are logged", async () => {
      const empty = await callback((f) => `?error=&state=${f.state}&code=${f.code}`);
      expectRefused(empty.finished, "login_failed");
      await refusalLogged(t, empty.mark, "authorization_error");
      const long = await callback((f) => `?error=${"e".repeat(100)}&state=${f.state}`);
      expectRefused(long.finished, "login_failed");
      await refusalLogged(t, long.mark, `authorization_error: ${"e".repeat(64)}`);
      // Only the exact word is the person's refusal.
      expectRefused((await callback((f) => `?error=ACCESS_DENIED&state=${f.state}`)).finished, "login_failed");
    });

    test("an error without a login cookie is a callback nobody started", async () => {
      const client = t.client();
      const mark = t.logs.length;
      expectRefused(await finishLogin(client, "/api/auth/callback?error=access_denied"), "login_failed");
      await refusalLogged(t, mark, "no_login_cookie");
    });

    test("a callback without a code is refused", async () => {
      for (const query of [(f: { state: string }) => `?state=${f.state}`, (f: { state: string }) => `?state=${f.state}&code=`]) {
        const { finished, mark } = await callback(query);
        expectRefused(finished, "login_failed");
        await refusalLogged(t, mark, "missing_code");
      }
    });
  });

  describe("GET /auth/callback, the token endpoint", () => {
    test("a code the provider refuses signs nobody in", async () => {
      const client = t.client();
      const forged = forgeLogin(client, idp, newPerson());
      const mark = t.logs.length;
      // A code the provider never issued.
      expectRefused(await finishLogin(client, `/api/auth/callback?code=made-up&state=${forged.state}`), "login_failed");
      await refusalLogged(t, mark, "the provider refused the grant");
      expect(idp.seen("token").at(-1)!.form.get("code")).toBe("made-up");
    });

    test("a code is redeemed with the verifier of this browser's login only", async () => {
      // The code was issued for another login's challenge: the provider refuses the verifier.
      const client = t.client();
      const forged = forgeLogin(client, idp, newPerson());
      const other = forgeLogin(t.client(), idp, newPerson());
      const mark = t.logs.length;
      expectRefused(await finishLogin(client, `/api/auth/callback?code=${other.code}&state=${forged.state}`), "login_failed");
      await refusalLogged(t, mark, "the provider refused the grant");
      expect(idp.seen("token").at(-1)!.form.get("code_verifier")).toBe(forged.verifier);
    });

    test("invalid_grant is a refusal whatever the status it comes with", async () => {
      for (const status of [400, 401, 403, 429]) {
        idp.hooks.token = answers.status(status, { error: "invalid_grant", error_description: "no" });
        const mark = t.logs.length;
        expectRefused((await forgedCallback(t, newPerson())).finished, "login_failed");
        await refusalLogged(t, mark, "the provider refused the grant");
      }
    });

    test.each([
      ["another error", answers.status(401, { error: "invalid_client" }), "the token endpoint refused the request (invalid_client)"],
      ["an error that is not a short code", answers.status(400, { error: "this is not a code" }), "the token endpoint refused the request (400)"],
      ["a refusal without an error", answers.status(403, { message: "no" }), "the token endpoint refused the request (403)"],
      ["a 404", answers.status(404, {}), "the token endpoint refused the request (404)"],
    ])("%s from the token endpoint fails the sign-in and is logged as the server's own failure", async (_what, hook, error) => {
      idp.hooks.token = hook;
      const mark = t.logs.length;
      expectRefused((await forgedCallback(t, newPerson())).finished, "login_failed");
      await logged(t, { level: "error", msg: "single sign-on failed", error }, mark);
    });

    test.each([
      ["answers 500", () => (idp.hooks.token = answers.status(500, { error: "server_error" }))],
      ["answers 503 with invalid_grant in the body", () => (idp.hooks.token = answers.status(503, { error: "invalid_grant" }))],
      ["answers 429", () => (idp.hooks.token = answers.status(429, { error: "slow_down" }))],
      ["answers 429 without JSON", () => (idp.hooks.token = () => new Response("Too Many Requests", { status: 429 }))],
      ["answers 400 without JSON", () => (idp.hooks.token = () => new Response("Bad Request", { status: 400 }))],
      ["answers 200 with something that is not JSON", () => (idp.hooks.token = answers.text("<html>ok</html>", "text/html"))],
      ["answers 200 with a JSON array", () => (idp.hooks.token = answers.json(["access_token"]))],
      ["answers with a redirect", () => (idp.hooks.token = answers.redirect(`${idp.url}/elsewhere`))],
      ["is down", () => idp.down()],
    ])("when the token endpoint %s, the sign-in is reported as the provider being unavailable", async (_what, breakIt) => {
      breakIt();
      const { finished, client } = await forgedCallback(t, newPerson());
      expectRefused(finished, "unavailable");
      expect(client.cookie).toBeNull();
    });

    test.each([
      ["no access token", (normal) => ({ ...normal, access_token: undefined })],
      ["no ID token", (normal) => ({ ...normal, id_token: undefined })],
      ["an access token that is not a string", (normal) => ({ ...normal, access_token: { jwt: normal.access_token } })],
      ["an ID token that is not a string", (normal) => ({ ...normal, id_token: null })],
      ["an empty answer", () => ({})],
    ] as [string, NonNullable<SignInOptions["answer"]>][])("an answer with %s is reported as the provider being unavailable", async (_what, answer) => {
      expectRefused((await forgedCallback(t, newPerson(), {}, { answer })).finished, "unavailable");
    });
  });

  describe("GET /auth/callback, verifying the tokens", () => {
    type Case = [string, () => SignInOptions, string];

    /** Replaces one token of the provider's answer. */
    const swap =
      (field: "access_token" | "id_token", change: (token: string, context: { nonce: string; person: Person }) => string): SignInOptions["answer"] =>
      (normal, context) => ({ ...normal, [field]: change(String(normal[field]), context) });

    const ACCESS_TOKEN: Case[] = [
      ["naming another algorithm", () => ({ accessToken: { header: { alg: "HS256" } } }), "unexpected alg"],
      ["naming no algorithm", () => ({ accessToken: { header: { alg: "none" } } }), "unexpected alg"],
      ["without an algorithm", () => ({ accessToken: { header: { alg: undefined } } }), "unexpected alg"],
      ["naming the algorithm in lower case", () => ({ accessToken: { header: { alg: "eddsa" } } }), "unexpected alg"],
      ["typed as a plain JWT", () => ({ accessToken: { header: { typ: "JWT" } } }), "unexpected typ"],
      ["typed with the media type prefix", () => ({ accessToken: { header: { typ: "application/at+jwt" } } }), "unexpected typ"],
      ["without a type", () => ({ accessToken: { header: { typ: undefined } } }), "unexpected typ"],
      ["with a type that is not a string", () => ({ accessToken: { header: { typ: 1 } } }), "unexpected typ"],
      ["with a critical header", () => ({ accessToken: { header: { crit: ["exp"] } } }), "unsupported critical header"],
      ["with an empty critical header", () => ({ accessToken: { header: { crit: [] } } }), "unsupported critical header"],
      ["with a null critical header", () => ({ accessToken: { header: { crit: null } } }), "unsupported critical header"],
      ["without a key id", () => ({ accessToken: { header: { kid: undefined } } }), "no kid"],
      ["with a key id that is not a string", () => ({ accessToken: { header: { kid: 1 } } }), "no kid"],
      ["with a key id the provider does not publish", () => ({ accessToken: { header: { kid: "k9" } } }), "signed with an unknown key"],
      ["with a wrong signature", () => ({ answer: swap("access_token", withBadSignature) }), "bad signature"],
      ["signed by another key under the same key id", () => ({ accessToken: { key: stranger.privateKey } }), "bad signature"],
      [
        "whose claims were changed after signing",
        () => ({
          answer: swap("access_token", (token) => {
            const [h, p, s] = token.split(".") as [string, string, string];
            const claims = JSON.parse(Buffer.from(p, "base64url").toString());
            return `${h}.${b64url({ ...claims, role: "owner" })}.${s}`;
          }),
        }),
        "bad signature",
      ],
      [
        "with a signature one byte short",
        () => ({
          answer: swap("access_token", (token) => {
            const [h, p, s] = token.split(".") as [string, string, string];
            return `${h}.${p}.${Buffer.from(s, "base64url").subarray(0, 63).toString("base64url")}`;
          }),
        }),
        "bad signature",
      ],
      ["with an empty signature", () => ({ answer: swap("access_token", (token) => token.split(".").slice(0, 2).join(".") + ".") }), "not a JWT"],
      ["of two parts", () => ({ answer: swap("access_token", (token) => token.split(".").slice(0, 2).join(".")) }), "not a JWT"],
      ["of four parts", () => ({ answer: swap("access_token", (token) => `${token}.AAAA`) }), "not a JWT"],
      ["in base64 with padding", () => ({ answer: swap("access_token", (token) => `${token}=`) }), "not a JWT"],
      ["that is an empty string", () => ({ answer: swap("access_token", () => "") }), "not a JWT"],
      [
        "whose header is not JSON",
        () => ({ answer: swap("access_token", (token) => [b64url("not json"), ...token.split(".").slice(1)].join(".")) }),
        "malformed segment",
      ],
      [
        "whose claims are a JSON array",
        () => ({ answer: swap("access_token", () => signJwt({ alg: "EdDSA", typ: "at+jwt", kid: "k1" }, ["sub"], idp.signer.privateKey)) }),
        "malformed segment",
      ],
      ["from another issuer", () => ({ accessToken: { claims: { iss: "https://auth.example.com" } } }), "wrong issuer"],
      ["from the issuer written with a trailing slash", () => ({ accessToken: { claims: { iss: `${ISSUER}/` } } }), "wrong issuer"],
      ["issued under the back-channel address", () => ({ accessToken: { claims: { iss: idp.url } } }), "wrong issuer"],
      ["without an issuer", () => ({ accessToken: { claims: { iss: undefined } } }), "wrong issuer"],
      ["for another audience", () => ({ accessToken: { claims: { aud: "another-service" } } }), "wrong audience"],
      ["for several audiences, none of them this one", () => ({ accessToken: { claims: { aud: ["a", "b"] } } }), "wrong audience"],
      ["for an audience this one is only part of", () => ({ accessToken: { claims: { aud: "doc " } } }), "wrong audience"],
      ["without an audience", () => ({ accessToken: { claims: { aud: undefined } } }), "wrong audience"],
      ["issued 40 seconds from now", () => ({ accessToken: { claims: { iat: nowSeconds() + 40 } } }), "issued in the future"],
      ["without an issue time", () => ({ accessToken: { claims: { iat: undefined } } }), "issued in the future"],
      ["with an issue time that is not a number", () => ({ accessToken: { claims: { iat: String(nowSeconds()) } } }), "issued in the future"],
      ["that expired 32 seconds ago", () => ({ accessToken: { claims: { iat: nowSeconds() - 700, exp: nowSeconds() - 32 } } }), "expired"],
      ["without an expiry", () => ({ accessToken: { claims: { exp: undefined } } }), "expired"],
      ["with an expiry that is not a number", () => ({ accessToken: { claims: { exp: String(nowSeconds() + 600) } } }), "expired"],
      ["without a subject", () => ({ accessToken: { claims: { sub: undefined } } }), "no sub claim"],
      ["with a subject that is not a string", () => ({ accessToken: { claims: { sub: 7 } } }), "no sub claim"],
      ["without a provider session", () => ({ accessToken: { claims: { sid: undefined } } }), "no sid claim"],
      ["without a username", () => ({ accessToken: { claims: { username: undefined } } }), "no username claim"],
      ["without a name", () => ({ accessToken: { claims: { name: undefined } } }), "no name claim"],
      ["with a null name", () => ({ accessToken: { claims: { name: null } } }), "no name claim"],
      ["without a role", () => ({ accessToken: { claims: { role: undefined } } }), "no role claim"],
      ["with a list of roles", () => ({ accessToken: { claims: { role: ["owner"] } } }), "no role claim"],
    ];

    const ID_TOKEN: Case[] = [
      ["typed as an access token", () => ({ idToken: { header: { typ: "at+jwt" } } }), "unexpected typ"],
      ["without a type", () => ({ idToken: { header: { typ: undefined } } }), "unexpected typ"],
      ["naming another algorithm", () => ({ idToken: { header: { alg: "RS256" } } }), "unexpected alg"],
      ["with a critical header", () => ({ idToken: { header: { crit: ["nonce"] } } }), "unsupported critical header"],
      ["without a key id", () => ({ idToken: { header: { kid: undefined } } }), "no kid"],
      ["with a key id the provider does not publish", () => ({ idToken: { header: { kid: "k9" } } }), "signed with an unknown key"],
      ["with a wrong signature", () => ({ answer: swap("id_token", withBadSignature) }), "bad signature"],
      ["signed by another key under the same key id", () => ({ idToken: { key: stranger.privateKey } }), "bad signature"],
      ["that is not a JWT", () => ({ answer: swap("id_token", () => "id-token") }), "not a JWT"],
      ["from another issuer", () => ({ idToken: { claims: { iss: "https://auth.example.com" } } }), "wrong issuer"],
      ["for another client", () => ({ idToken: { claims: { aud: "another-client" } } }), "wrong audience"],
      ["for several clients, none of them this one", () => ({ idToken: { claims: { aud: ["a", "b"], azp: "doc" } } }), "wrong audience"],
      ["without an audience", () => ({ idToken: { claims: { aud: undefined } } }), "wrong audience"],
      ["issued 40 seconds from now", () => ({ idToken: { claims: { iat: nowSeconds() + 40 } } }), "issued in the future"],
      ["that expired 32 seconds ago", () => ({ idToken: { claims: { iat: nowSeconds() - 700, exp: nowSeconds() - 32 } } }), "expired"],
      ["without an expiry", () => ({ idToken: { claims: { exp: undefined } } }), "expired"],
      ["for several clients without naming the authorized party", () => ({ idToken: { claims: { aud: ["doc", "other"] } } }), "wrong authorized party"],
      ["for several clients, authorized for another", () => ({ idToken: { claims: { aud: ["doc", "other"], azp: "other" } } }), "wrong authorized party"],
      ["with another login's nonce", () => ({ idToken: { claims: { nonce: "n".repeat(43) } } }), "nonce mismatch"],
      ["without a nonce", () => ({ idToken: { claims: { nonce: undefined } } }), "nonce mismatch"],
      ["with a nonce that is not a string", () => ({ idToken: { claims: { nonce: 1 } } }), "nonce mismatch"],
      ["about another subject than the access token", () => ({ idToken: { claims: { sub: "usr_someone_else" } } }), "the ID token names another subject"],
      ["without a subject", () => ({ idToken: { claims: { sub: undefined } } }), "the ID token names another subject"],
    ];

    let usersBefore: number;
    let sessionsBefore: number;

    beforeAll(async () => {
      // The keys are fetched once here, so that every case below is refused on its own account.
      expect((await signIn(t.base, idp, alice)).location).toBe("/");
      [{ n: usersBefore }] = await t.sql`SELECT count(*)::int AS n FROM users`;
      [{ n: sessionsBefore }] = await t.sql`SELECT count(*)::int AS n FROM sessions`;
    });

    const expectRejected = async (options: SignInOptions, reason: string) => {
      const mark = t.logs.length;
      const attempt = await signIn(t.base, idp, newPerson(), options);
      expectRefused(attempt, "login_failed");
      expect(attempt.client.cookie).toBeNull();
      await refusalLogged(t, mark, reason);
    };

    test.each(ACCESS_TOKEN)("an access token %s is refused", async (_what, options, reason) => {
      await expectRejected(options(), reason);
    });

    test.each(ID_TOKEN)("an ID token %s is refused", async (_what, options, reason) => {
      await expectRejected(options(), reason);
    });

    test("the access token is checked before the ID token", async () => {
      await expectRejected({ accessToken: { claims: { aud: "another-service" } }, idToken: { header: { alg: "none" } } }, "wrong audience");
    });

    test("none of the refused sign-ins above left an account or a session", async () => {
      expect([...(await t.sql`SELECT count(*)::int AS n FROM users`)]).toEqual([{ n: usersBefore }]);
      expect([...(await t.sql`SELECT count(*)::int AS n FROM sessions`)]).toEqual([{ n: sessionsBefore }]);
      expect(await t.sql`SELECT auth_sub FROM users WHERE auth_sub LIKE 'usr_new_%'`).toHaveLength(0);
    });

    test.each([
      ["an access token typed in upper case", () => ({ accessToken: { header: { typ: "AT+JWT" } } })],
      ["an ID token typed in lower case", () => ({ idToken: { header: { typ: "jwt" } } })],
      ["an access token for several audiences, this one among them", () => ({ accessToken: { claims: { aud: ["other", "doc"] } } })],
      ["an access token issued 28 seconds from now", () => ({ accessToken: { claims: { iat: nowSeconds() + 28 } } })],
      ["an access token that expired 20 seconds ago", () => ({ accessToken: { claims: { iat: nowSeconds() - 700, exp: nowSeconds() - 20 } } })],
      ["an ID token that expired 20 seconds ago", () => ({ idToken: { claims: { iat: nowSeconds() - 700, exp: nowSeconds() - 20 } } })],
      ["an ID token for this client alone, as a list", () => ({ idToken: { claims: { aud: ["doc"] } } })],
      ["an ID token for several clients, authorized for this one", () => ({ idToken: { claims: { aud: ["other", "doc"], azp: "doc" } } })],
      ["an ID token that does not say when the person signed in", () => ({ idToken: { claims: { auth_time: undefined } } })],
      ["tokens with claims the server does not know", () => ({ accessToken: { claims: { scope: "openid", groups: ["a"] } }, idToken: { claims: { amr: ["pwd"], at_hash: "x" } } })],
      ["headers with fields the server does not know", () => ({ accessToken: { header: { jku: "https://evil.example/keys", x5t: "abc" } } })],
      ["an access token with an empty provider session and role", () => ({ accessToken: { claims: { sid: "", role: "" } } })],
    ] as [string, () => SignInOptions][])("%s is accepted", async (_what, options) => {
      const signedIn = await signIn(t.base, idp, alice, options());
      expect(signedIn.status).toBe(302);
      expect(signedIn.location).toBe("/");
      expect((await signedIn.client.get("/me")).status).toBe(200);
    });

    describe("how recently the person signed in at the provider, when the login cookie asks", () => {
      // The server's own logins never ask; a cookie that does is honoured (it is the browser's to send).
      test.each([
        ["a maximum age, and the ID token has no sign-in time", { maxAge: 60 }, { auth_time: undefined }, "no auth_time"],
        ["a maximum age, and the sign-in time is not a number", { maxAge: 60 }, { auth_time: "now" }, "no auth_time"],
        ["a maximum age of 60 seconds, and the person signed in 92 seconds ago", { maxAge: 60 }, { auth_time: -92 }, "the sign-in is older than max_age"],
        ["a maximum age of 0, and the person signed in 32 seconds ago", { maxAge: 0 }, { auth_time: -32 }, "the sign-in is older than max_age"],
        ["a fresh sign-in, and the ID token has no sign-in time", { fresh: true }, { auth_time: undefined }, "no auth_time"],
        ["a fresh sign-in, and the person signed in 31 seconds before the login began", { fresh: true }, { auth_time: -31 }, "the sign-in is older than the login request"],
      ] as [string, LoginState, { auth_time: unknown }, string][])("refused: the cookie asks for %s", async (_what, asked, { auth_time }, reason) => {
        const authTime = typeof auth_time === "number" ? nowSeconds() + auth_time : auth_time;
        const mark = t.logs.length;
        const { finished } = await forgedCallback(t, newPerson(), asked, { idToken: { claims: { auth_time: authTime } } });
        expectRefused(finished, "login_failed");
        await refusalLogged(t, mark, reason);
      });

      test.each([
        ["a maximum age of 60 seconds, and the person signed in 80 seconds ago", { maxAge: 60 }, -80],
        ["a fresh sign-in, and the person signed in 30 seconds before the login began", { fresh: true }, -30],
        ["a fresh sign-in and a maximum age, and the person signed in just now", { fresh: true, maxAge: 0 }, 0],
        ["a maximum age that is not a number, which is not a request", { maxAge: "60", fresh: "true" }, -3600],
      ] as [string, LoginState, number][])("accepted: the cookie asks for %s", async (_what, asked, authTime) => {
        const { finished } = await forgedCallback(t, alice, asked, { idToken: { claims: { auth_time: nowSeconds() + authTime } } });
        expect(finished.location).toBe("/");
      });
    });
  });

  describe("the provider's keys, once fetched", () => {
    test("are not asked for again: for the tokens that follow, nor for a key id they do not hold", async () => {
      // Builds on the sign-ins above: this server fetched the keys once, moments ago.
      const before = idp.count("jwks");
      expect((await signIn(t.base, idp, alice)).location).toBe("/");
      expect(idp.count("jwks")).toBe(before);
      // A new key at the provider is not seen yet: within 30 seconds of the last fetch, the keys are not fetched again.
      const next = signingKey("k2");
      idp.keys = [next, idp.signer];
      const mark = t.logs.length;
      const attempt = await signIn(t.base, idp, newPerson(), {
        accessToken: { header: { kid: "k2" }, key: next.privateKey },
        idToken: { header: { kid: "k2" }, key: next.privateKey },
      });
      expectRefused(attempt, "login_failed");
      await refusalLogged(t, mark, "signed with an unknown key");
      expect(idp.count("jwks")).toBe(before);
      idp.keys = [idp.signer];
    });

    test("keep verifying while the provider's key set is down", async () => {
      const before = idp.count("jwks");
      idp.hooks.jwks = answers.status(503);
      expect((await signIn(t.base, idp, alice)).location).toBe("/");
      expect(idp.count("jwks")).toBe(before);
    });
  });

  describe("the limit on sign-in attempts", () => {
    test("GET /auth/login answers 60 times a minute per address, then sends the browser back with rate_limited", async () => {
      const client = t.client();
      for (let i = 0; i < 60; i++) {
        const res = await client.fetch("/api/auth/login");
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toStartWith("https://auth.example.test/oauth/authorize?");
      }
      const limited = await startLogin(client, "/s/general");
      expect(limited.res.status).toBe(302);
      expect(limited.location).toBe("/login?sso_error=rate_limited");
      expect(limited.res.headers.get("cache-control")).toBe("no-store");
      expect(limited.setCookies).toEqual([CLEARED_LOGIN_COOKIE]);
      // Another address is not held back, and the callback has a count of its own.
      expect((await startLogin(t.client())).res.status).toBe(302);
      const same = t.client({ ip: client.ip });
      expectRefused(await finishLogin(same, "/api/auth/callback?code=x&state=y"), "login_failed");
    });

    test("GET /auth/callback answers 60 times a minute per address, then refuses even a good callback", async () => {
      const client = t.client();
      for (let i = 0; i < 60; i++) {
        const res = await client.fetch("/api/auth/callback?code=x&state=y");
        expect(res.headers.get("location")).toBe("/login?sso_error=login_failed");
      }
      const tokenRequests = idp.count("token");
      const forged = forgeLogin(client, idp, alice);
      const limited = await finishLogin(client, forged.callback);
      expectRefused(limited, "rate_limited");
      expect(client.cookie).toBeNull();
      expect(idp.count("token")).toBe(tokenRequests);
      // The same callback from another address goes through.
      const elsewhere = t.client();
      elsewhere.cookies.set("__Host-login", forged.cookie);
      expect((await finishLogin(elsewhere, forged.callback)).location).toBe("/");
    });
  });
});

describe("the provider's keys at first use", () => {
  // Each case is a server that has never had the keys.
  let base: TestServer;
  const fresh = startFakeProvider({ issuer: ISSUER });

  beforeAll(async () => {
    base = await startServer({ env: fresh.env });
  });

  afterEach(() => {
    fresh.heal();
    fresh.keys = [fresh.signer];
    fresh.extraJwks = [];
  });

  afterAll(async () => {
    await base.close();
    await fresh.stop();
  });

  const withFreshServer = async (run: (server: TestServer) => Promise<void>) => {
    const server = await startServer({ env: { ...fresh.env, DATABASE_POOL_MAX: "2" }, keepDatabase: true });
    try {
      await run(server);
    } finally {
      await server.close();
    }
  };

  const signInTo = (server: TestServer, person: Person, options: SignInOptions = {}) => signIn(server.base, fresh, person, options);

  test.each([
    ["answers 503", () => (fresh.hooks.jwks = answers.status(503, {}))],
    ["answers 404", () => (fresh.hooks.jwks = answers.status(404, { error: "not_found" }))],
    ["answers with something that is not JSON", () => (fresh.hooks.jwks = answers.text("keys"))],
    ["answers with a JSON array", () => (fresh.hooks.jwks = answers.json([fresh.signer.jwk]))],
    ["answers with a redirect", () => (fresh.hooks.jwks = answers.redirect(`${fresh.url}/keys`))],
    ["cannot be reached", () => (fresh.editDiscovery = (document) => ({ ...document, jwks_uri: "http://localhost:1/jwks.json" }))],
  ])("when the key set %s, the sign-in is reported as the provider being unavailable", async (_what, breakIt) => {
    await withFreshServer(async (server) => {
      breakIt();
      const attempt = await signInTo(server, { sub: "usr_keyless", username: "keyless" });
      expect(attempt.location).toBe("/login?sso_error=unavailable");
      expect(attempt.setCookies).toEqual([CLEARED_LOGIN_COOKIE]);
      expect(await server.sql`SELECT 1 FROM users WHERE auth_sub = 'usr_keyless'`).toHaveLength(0);
    });
  });

  test("after a failed fetch the keys are not asked for again for 30 seconds: sign-ins stay unavailable though the provider is back", async () => {
    await withFreshServer(async (server) => {
      fresh.clearRequests();
      fresh.hooks.jwks = answers.status(503, {});
      expect((await signInTo(server, { sub: "usr_keyless", username: "keyless" })).location).toBe("/login?sso_error=unavailable");
      expect(fresh.count("jwks")).toBe(1);
      fresh.heal();
      // (sso.slow.test.ts waits the 30 seconds out.)
      expect((await signInTo(server, { sub: "usr_keyless", username: "keyless" })).location).toBe("/login?sso_error=unavailable");
      expect(fresh.count("jwks")).toBe(1);
      expect(fresh.count("token")).toBe(2);
    });
  });

  test("a key set without a list of keys is an empty one: tokens are refused, not the provider called unavailable", async () => {
    for (const body of [{}, { keys: "k1" }, { keys: null }]) {
      await withFreshServer(async (server) => {
        fresh.hooks.jwks = answers.json(body);
        const mark = server.logs.length;
        expect((await signInTo(server, { sub: "usr_keyless", username: "keyless" })).location).toBe("/login?sso_error=login_failed");
        await refusalLogged(server, mark, "signed with an unknown key");
      });
    }
  });

  test("only Ed25519 signing keys with a key id are taken from the key set", async () => {
    await withFreshServer(async (server) => {
      const forEncryption = signingKey("enc1");
      const otherAlgorithm = signingKey("es1");
      const noKeyId = signingKey("nokid");
      const bare = signingKey("bare");
      fresh.extraJwks = [
        "a string",
        null,
        42,
        { kty: "RSA", kid: "rsa1", n: "sXchDaQebHnPiGvyDOAT4saGEUetSyo9MKLOoWFsueri23bOdgWp4Dy1WlUzewbgBHod5pcM9H95GQRV3JDXboIRROSBigeC5yjU1hGzHHyXss8UDprecbAYxknTcQkhslANGRUZmdTOQ5qTRsLAt6BTYuyvVRdhS8exSZEy_c4gs_7svlJJQ4H9_NxsiIoLwAEk7-Q3UXERGYw_75IDrGA84-lA_-Ct4eTlXHBIY2EaV7t7LjJaynVJCpkv4LKjTTAumiGUIuQhrNhZLuF_RJLqHpM2kgWFLU7-VTdL1VbC2tejvcI2BlMkEpk1BzBZI0KQB0GaDWFLN-aEAw3vRw", e: "AQAB", use: "sig" },
        { kty: "OKP", crv: "X25519", kid: "x1", x: forEncryption.jwk.x },
        { ...forEncryption.jwk, use: "enc" },
        { ...otherAlgorithm.jwk, alg: "ES256" },
        { ...noKeyId.jwk, kid: undefined },
        { kty: "OKP", crv: "Ed25519", kid: "nox" },
        { kty: "OKP", crv: "Ed25519", kid: "numx", x: 42 },
        // Without `alg` and `use`, a key is taken for what its type says.
        { kty: "OKP", crv: "Ed25519", kid: "bare", x: bare.jwk.x },
      ];
      fresh.clearRequests();
      const signedWith = (key: ReturnType<typeof signingKey>): SignInOptions => ({
        accessToken: { header: { kid: key.kid }, key: key.privateKey },
        idToken: { header: { kid: key.kid }, key: key.privateKey },
      });
      // The first sign-in fetches the set.
      expect((await signInTo(server, alice)).location).toBe("/");
      expect((await signInTo(server, alice, signedWith(bare))).location).toBe("/");
      for (const key of [forEncryption, otherAlgorithm]) {
        const mark = server.logs.length;
        expect((await signInTo(server, alice, signedWith(key))).location).toBe("/login?sso_error=login_failed");
        await refusalLogged(server, mark, "signed with an unknown key");
      }
      expect(fresh.count("jwks")).toBe(1);
    });
  });

  test("when two keys of the set share a key id, the one listed last is used", async () => {
    await withFreshServer(async (server) => {
      const first = signingKey("k1");
      fresh.keys = [first, fresh.signer];
      expect((await signInTo(server, alice)).location).toBe("/");
      const mark = server.logs.length;
      const attempt = await signInTo(server, alice, { accessToken: { key: first.privateKey }, idToken: { key: first.privateKey } });
      expect(attempt.location).toBe("/login?sso_error=login_failed");
      await refusalLogged(server, mark, "bad signature");
    });
  });
});
