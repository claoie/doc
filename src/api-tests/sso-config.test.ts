import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type TestServer } from "./harness";
import { finishLogin, logged, signIn, startFakeProvider, startLogin, type FakeProvider, type Person } from "./harness/oidc";

/*
 * Single sign-on settings: what the server refuses to start with, what it
 * accepts, the defaults it fills in, and `GET /auth/config`.
 *
 * The settings are environment variables, so every case is its own server
 * process. One server without single sign-on runs for the whole file (it also
 * migrates the database); the others start on the same database.
 */

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A complete configuration that needs no provider to be running: nothing contacts it before a sign-in. */
const VALID = { AUTH_ISSUER: "https://auth.example.com", AUTH_CLIENT_ID: "doc", AUTH_CLIENT_SECRET: "s3cret" };

let plain: TestServer;
const providers: FakeProvider[] = [];

const provider = (options: Parameters<typeof startFakeProvider>[0] = {}) => {
  const idp = startFakeProvider(options);
  providers.push(idp);
  return idp;
};

/** Runs `run` against a server on the file's database with these settings, and stops it. */
const withServer = async <T>(env: Record<string, string | undefined>, run: (server: TestServer) => Promise<T>): Promise<T> => {
  const server = await startServer({ env: { DATABASE_POOL_MAX: "2", ...env }, keepDatabase: true });
  try {
    return await run(server);
  } finally {
    await server.close();
  }
};

beforeAll(async () => {
  plain = await startServer();
});

afterAll(async () => {
  await plain.close();
  await Promise.all(providers.map((idp) => idp.stop()));
});

describe("starting with single sign-on settings that are wrong", () => {
  /** Starts a server that should refuse to: its exit code and what it logged. */
  const refused = async (env: Record<string, string | undefined>) => {
    const server = await startServer({ env, keepDatabase: true, expectExit: true });
    const code = await Promise.race([server.exited, Bun.sleep(10_000).then(() => "still running" as const)]);
    await server.close();
    return { code, entries: server.logEntries(), logs: server.logs };
  };

  const expectRefusal = async (env: Record<string, string | undefined>, problems: string[]) => {
    const { code, entries, logs } = await refused(env);
    expect(code).toBe(1);
    // One line says everything that is wrong; nothing else is logged, and the server never listens.
    expect(entries).toEqual([{ t: expect.stringMatching(ISO), level: "error", msg: "invalid configuration, not starting", problems }]);
    expect(logs).toHaveLength(1);
  };

  const ISSUER_PROBLEM = "AUTH_ISSUER must be an https URL (http only for localhost), without a query or fragment";
  const BACKCHANNEL_PROBLEM = "AUTH_BACKCHANNEL_URL must be an http or https URL, without a query or fragment";
  const REDIRECT_PROBLEM = "AUTH_REDIRECT_URI must be an absolute http or https URL (it defaults to APP_URL/api/auth/callback)";

  test.each([
    ["no client id", { ...VALID, AUTH_CLIENT_ID: undefined }, "AUTH_CLIENT_ID is required when AUTH_ISSUER is set"],
    ["an empty client id", { ...VALID, AUTH_CLIENT_ID: "" }, "AUTH_CLIENT_ID is required when AUTH_ISSUER is set"],
    ["no client secret", { ...VALID, AUTH_CLIENT_SECRET: undefined }, "AUTH_CLIENT_SECRET is required when AUTH_ISSUER is set"],
    ["an empty client secret", { ...VALID, AUTH_CLIENT_SECRET: "" }, "AUTH_CLIENT_SECRET is required when AUTH_ISSUER is set"],
    ["an http issuer that is not this machine", { ...VALID, AUTH_ISSUER: "http://auth.example.com" }, ISSUER_PROBLEM],
    ["an http issuer whose name only starts with localhost", { ...VALID, AUTH_ISSUER: "http://localhost.example.com:4000" }, ISSUER_PROBLEM],
    ["an http issuer on another loopback address", { ...VALID, AUTH_ISSUER: "http://127.0.0.2:4000" }, ISSUER_PROBLEM],
    ["an issuer with a query", { ...VALID, AUTH_ISSUER: "https://auth.example.com/?tenant=1" }, ISSUER_PROBLEM],
    ["an issuer with a fragment", { ...VALID, AUTH_ISSUER: "https://auth.example.com/#tenant" }, ISSUER_PROBLEM],
    ["an issuer that is not a URL", { ...VALID, AUTH_ISSUER: "auth.example.com" }, ISSUER_PROBLEM],
    ["an issuer of another scheme", { ...VALID, AUTH_ISSUER: "ftp://auth.example.com" }, ISSUER_PROBLEM],
    ["a back channel of another scheme", { ...VALID, AUTH_BACKCHANNEL_URL: "ftp://auth.internal" }, BACKCHANNEL_PROBLEM],
    ["a back channel with a query", { ...VALID, AUTH_BACKCHANNEL_URL: "http://auth.internal:4000/?x=1" }, BACKCHANNEL_PROBLEM],
    ["a back channel with a fragment", { ...VALID, AUTH_BACKCHANNEL_URL: "http://auth.internal:4000/#x" }, BACKCHANNEL_PROBLEM],
    ["a back channel that is not a URL", { ...VALID, AUTH_BACKCHANNEL_URL: "auth.internal:4000/path with spaces" }, BACKCHANNEL_PROBLEM],
    ["a redirect URI that is only a path", { ...VALID, AUTH_REDIRECT_URI: "/api/auth/callback" }, REDIRECT_PROBLEM],
    ["a redirect URI of another scheme", { ...VALID, AUTH_REDIRECT_URI: "app://docs/api/auth/callback" }, REDIRECT_PROBLEM],
    ["a redirect URI with a query", { ...VALID, AUTH_REDIRECT_URI: "https://docs.example.com/api/auth/callback?from=sso" }, REDIRECT_PROBLEM],
    ["a redirect URI with a fragment", { ...VALID, AUTH_REDIRECT_URI: "https://docs.example.com/api/auth/callback#done" }, REDIRECT_PROBLEM],
    ["a link entry without =", { ...VALID, AUTH_LINK_USERS: "bob" }, 'AUTH_LINK_USERS: "bob" is not <email>=<username>'],
    ["a link entry without an email", { ...VALID, AUTH_LINK_USERS: "=carol" }, 'AUTH_LINK_USERS: "=carol" is not <email>=<username>'],
    ["a link entry whose email is not one", { ...VALID, AUTH_LINK_USERS: "carol.example.com=carol" }, 'AUTH_LINK_USERS: "carol.example.com=carol" is not <email>=<username>'],
    ["a link entry without a username", { ...VALID, AUTH_LINK_USERS: "dave@example.com=" }, 'AUTH_LINK_USERS: "dave@example.com=" is not <email>=<username>'],
    ["a link entry whose username is only spaces", { ...VALID, AUTH_LINK_USERS: "dave@example.com=  ,erin@example.com=erin" }, 'AUTH_LINK_USERS: "dave@example.com=" is not <email>=<username>'],
    ["a link entry with a space in the username", { ...VALID, AUTH_LINK_USERS: "alice@example.com=al ice" }, 'AUTH_LINK_USERS: "alice@example.com=al ice" is not <email>=<username>'],
    ["a link entry with a tab in the username", { ...VALID, AUTH_LINK_USERS: "alice@example.com=al\tice" }, 'AUTH_LINK_USERS: "alice@example.com=al\tice" is not <email>=<username>'],
    [
      "one provider username listed for two accounts",
      { ...VALID, AUTH_LINK_USERS: "alice@example.com=alice,erin@example.com=alice" },
      "AUTH_LINK_USERS: alice is listed more than once",
    ],
    [
      "one account listed for two provider usernames, whatever the case of its email",
      { ...VALID, AUTH_LINK_USERS: "alice@example.com=alice,Alice@Example.COM=al" },
      "AUTH_LINK_USERS: alice@example.com is listed more than once",
    ],
  ])("the server does not start with %s", async (_what, env, problem) => {
    await expectRefusal(env, [problem]);
  });

  test("every problem is listed at once, in a fixed order", async () => {
    await expectRefusal(
      {
        AUTH_ISSUER: "auth.example.com",
        AUTH_REDIRECT_URI: "/api/auth/callback",
        AUTH_BACKCHANNEL_URL: "ftp://auth.internal",
        AUTH_LINK_USERS: "alice@example.com=alice,bob,=carol,dave@example.com=,erin@example.com=alice,alice@example.com=al ice,alice@example.com=al",
      },
      [
        "AUTH_CLIENT_ID is required when AUTH_ISSUER is set",
        "AUTH_CLIENT_SECRET is required when AUTH_ISSUER is set",
        "AUTH_ISSUER must be an https URL (http only for localhost), without a query or fragment",
        "AUTH_BACKCHANNEL_URL must be an http or https URL, without a query or fragment",
        "AUTH_REDIRECT_URI must be an absolute http or https URL (it defaults to APP_URL/api/auth/callback)",
        'AUTH_LINK_USERS: "bob" is not <email>=<username>',
        'AUTH_LINK_USERS: "=carol" is not <email>=<username>',
        'AUTH_LINK_USERS: "dave@example.com=" is not <email>=<username>',
        "AUTH_LINK_USERS: alice is listed more than once",
        'AUTH_LINK_USERS: "alice@example.com=al ice" is not <email>=<username>',
        "AUTH_LINK_USERS: alice@example.com is listed more than once",
      ],
    );
  });

  test("the other settings are not looked at while AUTH_ISSUER is unset or empty", async () => {
    for (const AUTH_ISSUER of [undefined, ""]) {
      const env = {
        AUTH_ISSUER,
        AUTH_CLIENT_ID: "",
        AUTH_BACKCHANNEL_URL: "ftp://auth.internal",
        AUTH_REDIRECT_URI: "/api/auth/callback",
        AUTH_LINK_USERS: "not a pair",
        AUTH_LOCAL_LOGIN: "false",
      };
      const res = await withServer(env, (server) => server.client().get("/auth/config"));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { sso: { enabled: false, localLogin: true } } });
    }
  });

  test("a refused start touches nothing: no database tables, no listening port", async () => {
    // The only server of the file on an empty database: `plain` is stopped for it and started again after.
    await plain.close();
    const server = await startServer({ env: { ...VALID, AUTH_CLIENT_SECRET: undefined }, expectExit: true });
    expect(await server.exited).toBe(1);
    const tables = await server.sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    expect([...tables]).toEqual([]);
    expect(await fetch(`${server.base}/api/health`).then(
      () => "answered",
      () => "refused",
    )).toBe("refused");
    await server.close();
    plain = await startServer();
  });
});

describe("starting with single sign-on settings that are right", () => {
  const config = async (env: Record<string, string | undefined>) => {
    const res = await withServer(env, (server) => server.client().get("/auth/config"));
    expect(res.status).toBe(200);
    return res.body.data;
  };

  test("an issuer may use plain http on this machine only: localhost, 127.0.0.1 and [::1]", async () => {
    for (const AUTH_ISSUER of ["http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000", "http://LOCALHOST:4000/realm/"]) {
      expect(await config({ ...VALID, AUTH_ISSUER })).toEqual({ sso: { enabled: true, localLogin: false } });
    }
  });

  test("the back channel may be plain http to any host, and the redirect URI any http or https URL", async () => {
    expect(
      await config({ ...VALID, AUTH_BACKCHANNEL_URL: "http://auth.internal:4000/base/", AUTH_REDIRECT_URI: "http://wiki.internal:8080/api/auth/callback" }),
    ).toEqual({ sso: { enabled: true, localLogin: false } });
  });

  test("AUTH_LINK_USERS may hold spaces around its entries, empty entries, and emails in any case", async () => {
    expect(
      await config({ ...VALID, AUTH_LINK_USERS: " Alice@Example.com=alice , bob@example.com = bob ,,carol+wiki@example.com=carol=c, " }),
    ).toEqual({ sso: { enabled: true, localLogin: false } });
  });

  test("the provider is not contacted when the server starts, nor to answer /auth/config", async () => {
    const idp = provider({ issuer: "https://auth.example.test" });
    expect(await config(idp.env)).toEqual({ sso: { enabled: true, localLogin: false } });
    expect(idp.requests).toEqual([]);
  });

  test.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["yes", true],
    ["on", true],
    ["On", true],
    ["false", false],
    ["0", false],
    ["no", false],
    ["off", false],
    ["", false],
    ["2", false],
    ["truthy", false],
    [" true", false],
    ["enabled", false],
  ])("AUTH_LOCAL_LOGIN=%j keeps passwords: %j", async (AUTH_LOCAL_LOGIN, localLogin) => {
    expect(await config({ ...VALID, AUTH_LOCAL_LOGIN })).toEqual({ sso: { enabled: true, localLogin } });
  });
});

describe("GET /auth/config", () => {
  test("says, without a session, that only passwords are used when single sign-on is off", async () => {
    const res = await plain.client().get("/auth/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { sso: { enabled: false, localLogin: true } } });
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("says whether passwords are kept alongside single sign-on", async () => {
    const only = await withServer(VALID, (server) => server.client().get("/auth/config"));
    expect(only.body).toEqual({ data: { sso: { enabled: true, localLogin: false } } });
    const both = await withServer({ ...VALID, AUTH_LOCAL_LOGIN: "true" }, (server) => server.client().get("/auth/config"));
    expect(both.body).toEqual({ data: { sso: { enabled: true, localLogin: true } } });
    expect(both.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(both.headers.get("cache-control")).toBe("no-store");
  });

  test("answers the same with a session, and only to GET", async () => {
    const { owner } = await plain.setupOwner();
    expect((await owner.get("/auth/config")).body).toEqual({ data: { sso: { enabled: false, localLogin: true } } });
    const posted = await owner.post("/auth/config", {});
    expect(posted.status).toBe(404);
    expect(posted.body).toEqual({ error: { code: "not_found", message: "Endpoint not found" } } as never);
  });
});

describe("defaults and where the server calls the provider", () => {
  const alice: Person = { sub: "usr_alice", username: "alice", name: "Alice", role: "owner" };

  /** A server on the file's database with these settings, stopped when the test ends. */
  const started: TestServer[] = [];
  const start = async (env: Record<string, string | undefined>) => {
    const server = await startServer({ env: { DATABASE_POOL_MAX: "2", ...env }, keepDatabase: true });
    started.push(server);
    return server;
  };

  afterEach(async () => {
    await Promise.all(started.splice(0).map((server) => server.close()));
  });

  test("the redirect URI defaults to APP_URL + /api/auth/callback, and an https APP_URL makes the session cookie Secure", async () => {
    const idp = provider({ issuer: "https://auth.example.test" });
    // A trailing slash on APP_URL is dropped.
    const server = await start({ ...idp.env, APP_URL: "https://docs.example.com/" });
    const signedIn = await signIn(server.base, idp, alice);
    expect(signedIn.start.authorize!.searchParams.get("redirect_uri")).toBe("https://docs.example.com/api/auth/callback");
    expect(idp.seen("token")[0]!.form.get("redirect_uri")).toBe("https://docs.example.com/api/auth/callback");
    expect(signedIn.location).toBe("/");
    expect(signedIn.setCookies).toEqual([
      expect.stringMatching(/^session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/),
      "__Host-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    ]);
    // Signing out sends the browser back to the origin of the redirect URI.
    const out = await signedIn.client.post("/auth/logout");
    expect(out.body).toEqual({ data: { logoutUrl: "https://auth.example.test/logout?client_id=doc&post_logout_redirect_uri=https%3A%2F%2Fdocs.example.com%2F" } });
    expect(out.headers.getSetCookie()).toEqual(["session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure"]);
  });

  test("without APP_URL the redirect URI is on localhost at the server's port", async () => {
    const idp = provider({ issuer: "https://auth.example.test" });
    const server = await start({ ...idp.env, APP_URL: undefined });
    const started = await startLogin(server.client());
    expect(started.authorize!.searchParams.get("redirect_uri")).toBe(`http://localhost:${server.port}/api/auth/callback`);
  });

  test("AUTH_REDIRECT_URI replaces the default in the authorization request, the token request and the sign-out address", async () => {
    const idp = provider({ issuer: "https://auth.example.test" });
    const server = await start({ ...idp.env, AUTH_REDIRECT_URI: "https://wiki.example.com:8443/base/api/auth/callback" });
    const signedIn = await signIn(server.base, idp, alice);
    expect(signedIn.start.authorize!.searchParams.get("redirect_uri")).toBe("https://wiki.example.com:8443/base/api/auth/callback");
    expect(idp.seen("token")[0]!.form.get("redirect_uri")).toBe("https://wiki.example.com:8443/base/api/auth/callback");
    expect(signedIn.location).toBe("/");
    // APP_URL is still http://doc.test, so the session cookie is not Secure.
    expect(signedIn.setCookies[0]).toMatch(/^session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    expect((await signedIn.client.post("/auth/logout")).body).toEqual({
      data: { logoutUrl: "https://auth.example.test/logout?client_id=doc&post_logout_redirect_uri=https%3A%2F%2Fwiki.example.com%3A8443%2F" },
    });
  });

  test("without AUTH_AUDIENCE, access tokens and events must be for the client id", async () => {
    const idp = provider({ issuer: "https://auth.example.test", clientId: "wiki" });
    expect(idp.env.AUTH_AUDIENCE).toBeUndefined();
    const server = await start(idp.env);
    expect((await signIn(server.base, idp, alice)).location).toBe("/");
    const mark = server.logs.length;
    const other = await signIn(server.base, idp, alice, { accessToken: { claims: { aud: "doc" } } });
    expect(other.location).toBe("/login?sso_error=login_failed");
    await logged(server, { level: "warn", msg: "single sign-on refused", reason: "wrong audience" }, mark);
    const event = (token: string) => server.client().raw("POST", "/auth/events", { body: token });
    expect((await event(idp.eventToken({ "something.new": {} }))).status).toBe(202);
    expect((await event(idp.eventToken({ "something.new": {} }, { claims: { aud: "doc" } }))).status).toBe(400);
  });

  test("with AUTH_AUDIENCE, access tokens and events must be for it, and ID tokens still for the client id", async () => {
    const idp = provider({ issuer: "https://auth.example.test", clientId: "wiki", audience: "doc-service" });
    expect(idp.env.AUTH_AUDIENCE).toBe("doc-service");
    const server = await start(idp.env);
    const signedIn = await signIn(server.base, idp, alice);
    expect(signedIn.location).toBe("/");
    expect(signedIn.start.authorize!.searchParams.get("client_id")).toBe("wiki");

    const refusals: [string, Parameters<typeof signIn>[3], string][] = [
      ["an access token for the client id", { accessToken: { claims: { aud: "wiki" } } }, "wrong audience"],
      ["an ID token for the audience", { idToken: { claims: { aud: "doc-service" } } }, "wrong audience"],
    ];
    for (const [, options, reason] of refusals) {
      const mark = server.logs.length;
      expect((await signIn(server.base, idp, alice, options)).location).toBe("/login?sso_error=login_failed");
      await logged(server, { level: "warn", msg: "single sign-on refused", reason }, mark);
    }
    const event = (token: string) => server.client().raw("POST", "/auth/events", { body: token });
    expect((await event(idp.eventToken({ "something.new": {} }))).status).toBe(202);
    expect((await event(idp.eventToken({ "something.new": {} }, { claims: { aud: "wiki" } }))).status).toBe(400);
    // The sign-out address names the client, not the audience.
    expect((await signedIn.client.post("/auth/logout")).body.data.logoutUrl).toBe(
      "https://auth.example.test/logout?client_id=wiki&post_logout_redirect_uri=http%3A%2F%2Fdoc.test%2F",
    );
  });

  test("a client id and secret that need encoding are form-encoded for HTTP Basic, and the id is sent as it is elsewhere", async () => {
    const idp = provider({ issuer: "https://auth.example.test", clientId: "doc wiki:1", clientSecret: "p@ss word+/=&%:é" });
    const server = await start(idp.env);
    const signedIn = await signIn(server.base, idp, alice);
    expect(signedIn.location).toBe("/");
    expect(signedIn.start.authorize!.searchParams.get("client_id")).toBe("doc wiki:1");
    const [request] = idp.seen("token");
    // RFC 6749 §2.3.1: each part form-encoded, then joined with a colon and base64-encoded.
    expect(request!.basic).toEqual({ id: "doc wiki:1", secret: "p@ss word+/=&%:é", raw: "doc+wiki%3A1:p%40ss+word%2B%2F%3D%26%25%3A%C3%A9" });
    expect(request!.form.has("client_id")).toBe(false);
    expect(request!.form.has("client_secret")).toBe(false);
    expect((await signedIn.client.post("/auth/logout")).body.data.logoutUrl).toBe(
      "https://auth.example.test/logout?client_id=doc+wiki%3A1&post_logout_redirect_uri=http%3A%2F%2Fdoc.test%2F",
    );
  });

  test("with an issuer on localhost and no back channel, every call goes to the issuer itself", async () => {
    const idp = provider();
    expect(idp.env).toEqual({ AUTH_ISSUER: `http://localhost:${idp.port}`, AUTH_CLIENT_ID: "doc", AUTH_CLIENT_SECRET: "s3cret" });
    const server = await start(idp.env);
    const signedIn = await signIn(server.base, idp, alice);
    expect(signedIn.location).toBe("/");
    expect(signedIn.start.authorize!.origin + signedIn.start.authorize!.pathname).toBe(`http://localhost:${idp.port}/oauth/authorize`);
    expect(idp.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /.well-known/openid-configuration",
      "POST /oauth/token",
      "GET /.well-known/jwks.json",
    ]);
    const out = await signedIn.client.post("/auth/logout");
    expect(out.body.data.logoutUrl).toBe(`http://localhost:${idp.port}/logout?client_id=doc&post_logout_redirect_uri=http%3A%2F%2Fdoc.test%2F`);
    await idp.waitFor("revocation", 1);
  });

  test("an issuer on a path, written with a trailing slash, is asked under that path and must be named exactly so", async () => {
    const idp = provider({ issuer: (url) => `${url}/realms/doc/` });
    expect(idp.env.AUTH_BACKCHANNEL_URL).toBeUndefined();
    const server = await start(idp.env);
    const signedIn = await signIn(server.base, idp, alice);
    expect(signedIn.location).toBe("/");
    expect(idp.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /realms/doc/.well-known/openid-configuration",
      "POST /realms/doc/oauth/token",
      "GET /realms/doc/.well-known/jwks.json",
    ]);
    // Tokens carry the issuer as configured, slash included: one without it is another issuer.
    const mark = server.logs.length;
    const other = await signIn(server.base, idp, alice, { accessToken: { claims: { iss: `${idp.url}/realms/doc` } } });
    expect(other.location).toBe("/login?sso_error=login_failed");
    await logged(server, { level: "warn", msg: "single sign-on refused", reason: "wrong issuer" }, mark);
  });

  test("a discovery document that drops the issuer's trailing slash names a different issuer", async () => {
    const idp = provider({ issuer: (url) => `${url}/realms/doc/` });
    idp.editDiscovery = (document) => ({ ...document, issuer: `${idp.url}/realms/doc` });
    const server = await start(idp.env);
    const started = await startLogin(server.client());
    expect(started.location).toBe("/login?sso_error=unavailable");
    await logged(server, { level: "error", msg: "starting single sign-on failed", error: "the discovery document names a different issuer" });
  });

  test("the back channel stands in for the issuer, path included, in every server-to-server call", async () => {
    const idp = provider({ issuer: "https://auth.example.test/realms/doc", mount: "/internal/" });
    expect(idp.env.AUTH_BACKCHANNEL_URL).toBe(`http://localhost:${idp.port}/internal`);
    // The back channel may be written with a trailing slash too.
    const server = await start({ ...idp.env, AUTH_BACKCHANNEL_URL: `http://localhost:${idp.port}/internal/` });
    const signedIn = await signIn(server.base, idp, alice);
    expect(signedIn.location).toBe("/");
    // The browser is sent to the issuer's public address.
    expect(signedIn.start.authorize!.origin + signedIn.start.authorize!.pathname).toBe("https://auth.example.test/realms/doc/oauth/authorize");
    const out = await signedIn.client.post("/auth/logout");
    expect(out.body.data.logoutUrl).toBe("https://auth.example.test/realms/doc/logout?client_id=doc&post_logout_redirect_uri=http%3A%2F%2Fdoc.test%2F");
    await idp.waitFor("revocation", 1);
    expect(idp.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /internal/.well-known/openid-configuration",
      "POST /internal/oauth/token",
      "GET /internal/.well-known/jwks.json",
      "POST /internal/oauth/revoke",
    ]);
  });

  test("an endpoint the discovery document puts outside the issuer is called where it is, not through the back channel", async () => {
    const idp = provider({ issuer: "https://auth.example.test" });
    // The keys live on another host: only that one publishes the key the tokens are signed with.
    const keyHost = provider();
    idp.editDiscovery = (document) => ({ ...document, jwks_uri: `${keyHost.url}/.well-known/jwks.json` });
    idp.signer = keyHost.signer;
    const server = await start(idp.env);
    const signedIn = await signIn(server.base, idp, alice);
    expect(signedIn.location).toBe("/");
    expect(idp.count("jwks")).toBe(0);
    expect(keyHost.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /.well-known/jwks.json"]);
  });

  test("a callback on another server of the same settings completes the sign-in: the login cookie carries all it needs", async () => {
    const idp = provider({ issuer: "https://auth.example.test" });
    const one = await start(idp.env);
    const two = await start(idp.env);
    const browser = one.client();
    const started = await startLogin(browser);
    const authorization = idp.authorize(started.authorize!, alice);
    // The same browser, reaching the other copy of the server for the callback.
    const other = two.client({ ip: browser.ip });
    other.cookies.set("__Host-login", started.cookie!);
    const finished = await finishLogin(other, authorization.callback);
    expect(finished.location).toBe("/");
    expect((await other.get("/me")).body.data.user.email).toBe("alice@example.com");
    // The session is in the database, so the first copy serves it too.
    browser.cookie = other.cookie;
    expect((await browser.get("/me")).status).toBe(200);
  });
});
