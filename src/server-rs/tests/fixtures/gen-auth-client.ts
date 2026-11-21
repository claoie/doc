// Writes auth-client.json: what the TypeScript OpenID Connect client
// (server/lib/auth-client.ts) does in each scenario, for tests/auth_client.rs
// to hold the Rust port to. A scenario is one client, a table of canned
// provider answers, and steps; each step may move the clock, change answers,
// and makes one or more calls at once. The fixture records every result (the
// value, or the error's class and message) and every request the client made.
//
// Everything is fixed: the keys come from constant seeds, the clock starts at
// NOW, and Ed25519 signatures are deterministic. Only startLogin draws random
// values; the Rust test compares those results by structure.
//
//   bun src/server-rs/tests/fixtures/gen-auth-client.ts
import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import path from "node:path";
import { createAuthClient, type AuthClient, type AuthClientOptions, type StartLoginOptions } from "server/lib/auth-client";

const ISSUER = "https://auth.example.test";
/** Stand-ins the Rust test replaces with the address of its own provider. */
const BACK = "http://backchannel.test/back";
const OTHER = "http://other.test/other";
const NOW = 1_800_000_000_000;
const T = NOW / 1000;
const REDIRECT = "https://doc.example.test/api/auth/callback";

// --- keys and tokens

const keyFromSeed = (byte: number) => {
  const seed = Buffer.alloc(32, byte);
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const x = (createPublicKey(privateKey).export({ format: "jwk" }) as { x: string }).x;
  return { privateKey, x, seed: seed.toString("hex") };
};
type Key = { privateKey: KeyObject; x: string; seed: string };
const k1 = keyFromSeed(1);
const k2 = keyFromSeed(2);
const stranger = keyFromSeed(3);
const jwk = (kid: unknown, key: { x: unknown }, extra: object = {}) => ({ kty: "OKP", crv: "Ed25519", x: key.x, kid, alg: "EdDSA", use: "sig", ...extra });

const b64 = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");
const segment = (value: unknown) => (typeof value === "string" ? value : b64(JSON.stringify(value)));
/** A signed token. A string header or payload is used as the segment itself. */
const jwt = (header: unknown, payload: unknown, key: Key = k1) => {
  const signed = `${segment(header)}.${segment(payload)}`;
  return `${signed}.${sign(null, Buffer.from(signed), key.privateKey).toString("base64url")}`;
};
const access = (claims: object = {}, header: object = {}, key: Key = k1) =>
  jwt(
    { alg: "EdDSA", typ: "at+jwt", kid: "k1", ...header },
    { iss: ISSUER, sub: "usr_alice", aud: "doc", iat: T, exp: T + 600, sid: "ses_1", username: "alice", name: "Alice", role: "owner", ...claims },
    key,
  );
const idToken = (claims: object = {}, header: object = {}) =>
  jwt(
    { alg: "EdDSA", typ: "JWT", kid: "k1", ...header },
    { iss: ISSUER, sub: "usr_alice", aud: "doc", iat: T, exp: T + 600, nonce: "n0nce", auth_time: T - 10, email: "alice@example.com", email_verified: true, ...claims },
  );
const eventToken = (events: unknown, claims: object = {}, header: object = {}, key: Key = k1) =>
  jwt({ alg: "EdDSA", typ: "secevent+jwt", kid: "k1", ...header }, { iss: ISSUER, aud: "doc", iat: T, jti: "evt_1", events, ...claims }, key);

// --- the provider's canned answers

interface Canned {
  status?: number;
  body?: string;
  /** The body as bytes, where a string could not hold them. */
  hex?: string;
  /** The request fails before any answer, as an unreachable provider does. */
  fail?: true;
}
const json = (status: number, body: unknown): Canned => ({ status, body: JSON.stringify(body) });

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  end_session_endpoint: `${ISSUER}/logout`,
};
const D = `GET ${BACK}/.well-known/openid-configuration`;
const K = `GET ${BACK}/.well-known/jwks.json`;
const TOKEN = `POST ${BACK}/oauth/token`;
const REVOKE = `POST ${BACK}/oauth/revoke`;
const KEYS = json(200, { keys: [jwk("k1", k1)] });
const provider = (discovery: object = {}): Record<string, Canned> => ({ [D]: json(200, { ...DISCOVERY, ...discovery }), [K]: KEYS });

// --- scenarios

interface Call {
  method: "startLogin" | "finishLogin" | "refresh" | "revoke" | "readEvent" | "logoutUrl";
  args: unknown[];
}
interface Step {
  now?: number;
  routes?: Record<string, Canned>;
  calls: Call[];
}

const run = async (client: AuthClient, { method, args }: Call) => {
  try {
    let value: unknown;
    if (method === "startLogin") {
      value = await client.startLogin(new Request("https://doc.example.test/api/auth/login"), args[0] as StartLoginOptions | undefined);
    } else if (method === "finishLogin") {
      const { cookie, url } = args[0] as { cookie: string | null; url: string };
      value = await client.finishLogin(new Request(url, { headers: cookie === null ? {} : { cookie } }));
    } else if (method === "refresh") value = await client.refresh(args[0] as string);
    else if (method === "revoke") value = await client.revoke(args[0] as string);
    else if (method === "readEvent") value = await client.readEvent(args[0] as string);
    else value = await client.logoutUrl(args[0] as string | undefined);
    return { ok: value ?? null };
  } catch (thrown) {
    const error = thrown as Error & { code?: string; error?: string };
    const known = ["InvalidGrant", "Unavailable", "InvalidToken", "LoginError"].includes(error.name);
    return {
      error: {
        class: known ? error.name : "Other",
        message: error.message,
        ...(error.name === "LoginError" ? { code: error.code, error: error.error ?? null } : {}),
      },
    };
  }
};

const scenarios: unknown[] = [];

const scenario = async (name: string, options: Partial<AuthClientOptions>, routes: Record<string, Canned>, steps: Step[]) => {
  let now = NOW;
  const table = { ...routes };
  let requests: unknown[] = [];
  const settings = { issuer: ISSUER, backChannelUrl: BACK, clientId: "doc", clientSecret: "s3cret", redirectUri: REDIRECT, ...options };
  const fakeFetch = async (input: unknown, init: RequestInit = {}) => {
    // As the real `fetch` does, refuse what is not an absolute http(s) URL
    // before any request is made.
    if (typeof input !== "string" || !/^https?:$/.test(new URL(input).protocol)) throw new TypeError("fetch() URL is invalid");
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    requests.push({
      method,
      url: String(input),
      accept: headers.get("accept"),
      contentType: headers.get("content-type"),
      authorization: headers.get("authorization"),
      body: init.body == null ? "" : String(init.body),
    });
    await Bun.sleep(1);
    const canned = table[`${method} ${String(input)}`] ?? json(404, { error: "not_found" });
    if (canned.fail) throw new TypeError("fetch failed");
    return new Response(canned.hex !== undefined ? Buffer.from(canned.hex, "hex") : (canned.body ?? null), { status: canned.status ?? 200 });
  };
  const client = createAuthClient({ ...settings, fetch: fakeFetch as unknown as typeof fetch, now: () => now });
  const done = [];
  for (const step of steps) {
    if (step.now !== undefined) now = step.now;
    Object.assign(table, step.routes ?? {});
    requests = [];
    const results = await Promise.all(step.calls.map((call) => run(client, call)));
    done.push({ now, routes: step.routes ?? {}, calls: step.calls, results, requests });
  }
  scenarios.push({ name, options: settings, routes, steps: done });
};

const logoutUrl = (redirect?: string): Call => ({ method: "logoutUrl", args: redirect === undefined ? [] : [redirect] });
const refresh = (token = "rt_alice"): Call => ({ method: "refresh", args: [token] });
const revoke = (token = "rt_alice"): Call => ({ method: "revoke", args: [token] });
const readEvent = (body: string): Call => ({ method: "readEvent", args: [body] });
/** The options are whatever a caller might pass, valid or not. */
const startLogin = (options?: object): Call => ({ method: "startLogin", args: options === undefined ? [] : [options] });
/** One step: the token endpoint answers with this, and the client refreshes. */
const refreshWith = (answer: Canned, now?: number): Step => ({ now, routes: { [TOKEN]: answer }, calls: [refresh()] });
const refreshToken = (token: string, now?: number) => refreshWith(json(200, { access_token: token }), now);
/** One step per discovery answer, each on a client that has no document yet. */
const discoveries = async (name: string, answers: Canned[]) => {
  for (const [i, answer] of answers.entries()) await scenario(`${name} ${i + 1}`, {}, { [D]: answer }, [{ calls: [logoutUrl()] }]);
};

// Discovery.

await scenario("discovery: a failed fetch is forgotten, a successful one is kept", {}, { [D]: json(404, {}) }, [
  { calls: [logoutUrl()] },
  { routes: { [D]: json(200, DISCOVERY) }, calls: [logoutUrl()] },
  { routes: { [D]: json(500, {}) }, calls: [logoutUrl("https://doc.example.test/")] },
]);
await discoveries("discovery: refused answers", [
  { fail: true },
  json(500, DISCOVERY),
  json(503, {}),
  { status: 302, body: JSON.stringify(DISCOVERY) },
  { status: 200, body: "not json" },
  { status: 200, body: "" },
  json(200, [DISCOVERY]),
  json(200, null),
  json(200, "text"),
  json(200, { ...DISCOVERY, issuer: `${ISSUER}/` }),
  json(200, { ...DISCOVERY, issuer: undefined }),
  json(200, { ...DISCOVERY, authorization_endpoint: undefined }),
  json(200, { ...DISCOVERY, token_endpoint: 7 }),
  json(200, { ...DISCOVERY, jwks_uri: null }),
  json(200, { ...DISCOVERY, issuer: "https://other.example.test", jwks_uri: null }),
  { status: 204 },
]);
await discoveries("discovery: lenient decoding of the body", [
  // A byte order mark is dropped, and invalid UTF-8 becomes U+FFFD.
  { hex: "efbbbf" + Buffer.from(JSON.stringify(DISCOVERY)).toString("hex") },
  { hex: Buffer.from(JSON.stringify({ ...DISCOVERY, extra: "<>" })).toString("hex").replace("3c3e", "ffc3") },
  { status: 200, body: ` \n\t${JSON.stringify(DISCOVERY)}\r\n ` },
  { status: 200, body: ` ${JSON.stringify(DISCOVERY)}` },
]);
await scenario("discovery: concurrent callers share one fetch", {}, { [D]: json(200, DISCOVERY) }, [
  { calls: [logoutUrl(), logoutUrl("https://doc.example.test/"), logoutUrl()] },
  { calls: [logoutUrl()] },
]);
await scenario("discovery: concurrent callers share one failure, and the next call asks again", {}, { [D]: json(503, {}) }, [
  { calls: [logoutUrl(), logoutUrl(), revoke()] },
  { calls: [logoutUrl()] },
]);
await scenario("discovery: an issuer with a trailing slash", { issuer: `${ISSUER}/`, backChannelUrl: `${BACK}//` }, { [D]: json(200, { ...DISCOVERY, issuer: `${ISSUER}/` }) }, [
  { calls: [logoutUrl()] },
]);

// The logout URL.

for (const [i, endpoint] of [
  `${ISSUER}/logout?theme=dark&client_id=old&client_id=older&post_logout_redirect_uri=x#top`,
  `${ISSUER}/logout?a=b%20c&d&e=%zz&f=%C3%A9+g`,
  undefined,
  "",
  null,
  0,
  false,
  123,
  true,
  {},
  [`${ISSUER}/logout`],
  "nope",
  "/logout",
  "HTTPS://Auth.Example.Test:443/a/../logout",
].entries()) {
  await scenario(`logout URL: end_session_endpoint ${i + 1}`, { clientId: "doc & co/é" }, provider({ end_session_endpoint: endpoint }), [
    { calls: [logoutUrl()] },
    { calls: [logoutUrl("https://doc.example.test/?a=b c&d=é*~'()!")] },
  ]);
}

// Starting a sign-in.

await scenario("start login: options", { clientId: "doc & co/é", redirectUri: "https://doc.example.test/api/auth/callback?x=a b" }, provider(), [
  { calls: [startLogin()] },
  ...[
    {},
    { returnTo: "/s/general" },
    { returnTo: "/s/general?tab=1&q=a%20b#frag" },
    { returnTo: "//evil.example/x" },
    { returnTo: "/\\evil.example" },
    { returnTo: "/a b" },
    { returnTo: "/a\tb" },
    { returnTo: "/a\u007fb" },
    { returnTo: "https://evil.example/" },
    { returnTo: "relative" },
    { returnTo: "" },
    { returnTo: "/" },
    { returnTo: "/é/\u{1F600}/\"quoted\"" },
    { returnTo: `/${"a".repeat(2047)}` },
    { returnTo: `/${"a".repeat(2048)}` },
    { returnTo: `/${"\u{1F600}".repeat(1023)}a` },
    { returnTo: `/${"\u{1F600}".repeat(1024)}` },
    { prompt: "none" },
    { prompt: "login", maxAge: 0, loginHint: "alice@example.com & co +é" },
    { prompt: "consent" },
    { prompt: "" },
    { maxAge: 3600 },
    { maxAge: 2 ** 53 - 1 },
    { maxAge: 2 ** 53 },
    { maxAge: -1 },
    { maxAge: 1.5 },
    { maxAge: 1e21 },
    { prompt: "consent", maxAge: -1 },
    { loginHint: "" },
  ].map((options) => ({ calls: [startLogin(options)] })),
  { now: NOW + 1999, calls: [startLogin({ returnTo: "/later" })] },
]);
for (const [i, endpoint] of [
  `${ISSUER}/oauth/authorize?tenant=a b&state=old&scope=x&state=older&nonce=n#frag`,
  `${ISSUER}/oauth/authorize?a=b%20c&d&=e&f=%zz&g=%C3%A9+h&&i==j`,
  "nope",
  "",
  "app://authorize/path?x=1",
  `  ${ISSUER}/oauth/authorize \n`,
].entries()) {
  await scenario(`start login: authorization_endpoint ${i + 1}`, {}, provider({ authorization_endpoint: endpoint }), [
    { calls: [startLogin({ returnTo: "/x", prompt: "login", maxAge: 60 })] },
    // The endpoint is read before the options are checked.
    { calls: [startLogin({ prompt: "consent" })] },
  ]);
}
await scenario("start login: discovery comes first", {}, { [D]: json(503, {}) }, [{ calls: [startLogin({ prompt: "consent" })] }]);

// The token endpoint, through refresh.

await scenario("token endpoint: answers", {}, provider(), [
  refreshToken(access()),
  refreshWith(json(200, { access_token: access(), refresh_token: "rt_next", token_type: "Bearer", expires_in: 600 })),
  refreshWith(json(200, { access_token: access(), refresh_token: 7 })),
  refreshWith(json(201, { access_token: access({ role: "member", extra: [1, { a: null }] }) })),
  refreshWith(json(400, { error: "invalid_grant" })),
  refreshWith(json(429, { error: "invalid_grant" })),
  refreshWith(json(429, { error: "slow_down" })),
  refreshWith(json(429, {})),
  refreshWith({ status: 429, body: "slow down" }),
  refreshWith(json(400, { error: "invalid_client" })),
  refreshWith(json(401, { error: "bad code" })),
  refreshWith(json(401, { error: "a".repeat(64) })),
  refreshWith(json(401, { error: "a".repeat(65) })),
  refreshWith(json(401, { error: "" })),
  refreshWith(json(403, { error: "ok\n" })),
  refreshWith(json(403, { error: "café" })),
  refreshWith(json(403, { error: "A_z.0-9" })),
  refreshWith(json(403, { error: ["invalid_grant"] })),
  refreshWith(json(404, {})),
  refreshWith(json(302, { access_token: access() })),
  refreshWith({ status: 400, body: "<html>" }),
  refreshWith({ status: 302 }),
  refreshWith({ status: 204 }),
  refreshWith(json(400, [{ error: "invalid_grant" }])),
  refreshWith(json(500, { error: "invalid_grant" })),
  refreshWith(json(502, {})),
  refreshWith({ fail: true }),
  refreshWith({ status: 200, body: "[]" }),
  refreshWith(json(200, {})),
  refreshWith(json(200, { access_token: null })),
  refreshWith(json(200, { access_token: 7, refresh_token: "rt_next" })),
  refreshWith(json(200, { access_token: "not a token" })),
  { routes: { [TOKEN]: json(200, { access_token: access() }) }, calls: [refresh("rt a+b&c=d/é*~'()!")] },
]);
await scenario("token endpoint: a public client names itself in the body", { clientSecret: undefined }, provider(), [refreshToken(access()), { calls: [revoke()] }]);
await scenario("token endpoint: the credentials are form-encoded before Basic", { clientId: "doc & co/é*~'()!", clientSecret: "s3 cr+t:%é" }, provider(), [
  refreshToken(access({ aud: "doc & co/é*~'()!" })),
]);
await scenario(
  "token endpoint: only endpoints under the issuer use the back channel",
  {},
  {
    [D]: json(200, { ...DISCOVERY, token_endpoint: `${OTHER}/token`, jwks_uri: `${OTHER}/keys`, revocation_endpoint: `${OTHER}/revoke` }),
    [`POST ${OTHER}/token`]: json(200, { access_token: access() }),
    [`GET ${OTHER}/keys`]: KEYS,
    [`POST ${OTHER}/revoke`]: { status: 200 },
  },
  [{ calls: [refresh()] }, { calls: [revoke()] }],
);
await scenario("token endpoint: the issuer itself is under the issuer", {}, { ...provider({ token_endpoint: ISSUER }), [`POST ${BACK}`]: json(200, { access_token: access() }) }, [
  { calls: [refresh()] },
]);
await scenario("token endpoint: a custom audience", { audience: "wiki" }, provider(), [
  refreshToken(access({ aud: "wiki" })),
  refreshToken(access({ aud: "doc" })),
  refreshToken(access({ aud: ["other", "wiki"] })),
]);

// Verifying tokens, through refresh.

const good = access();
const [goodHead, goodBody, goodSignature] = good.split(".") as [string, string, string];
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const strayBits = goodSignature.slice(0, -1) + ALPHABET[ALPHABET.indexOf(goodSignature.at(-1)!) | 3];
await scenario("tokens: shape, header, signature and claims", {}, provider(), [
  ...[
    good,
    `${goodHead}.${goodBody}`,
    `${good}.x`,
    `.${goodBody}.${goodSignature}`,
    `${goodHead}..${goodSignature}`,
    `${goodHead}.${goodBody}.`,
    `${goodHead}.${goodBody}.${goodSignature}=`,
    `${goodHead}.${goodBody}.${goodSignature.replace(/[-_]/, "+")}+`,
    `${good}\n`,
    ` ${good}`,
    "",
    "a.b.c",
    // Lenient base64url: a dangling character and stray bits are ignored.
    `${good}A`,
    `${goodHead}.${goodBody}.${strayBits}`,
    `${goodHead}.${goodBody}.${goodSignature.slice(0, -2)}`,
    `${goodHead}.${goodBody}.${goodSignature}AA`,
    `${goodHead}.${goodBody}.${b64(Buffer.alloc(64))}`,
    `${goodHead}A.${goodBody}.${goodSignature}`,
    jwt(b64("not json"), {}),
    jwt(b64("[]"), {}),
    jwt(b64("null"), {}),
    jwt({ alg: "EdDSA", typ: "at+jwt", kid: "k1" }, b64('"text"')),
    jwt({ alg: "EdDSA", typ: "at+jwt", kid: "k1" }, b64("7")),
    jwt(b64(`﻿${JSON.stringify({ alg: "EdDSA", typ: "at+jwt", kid: "k1" })}`), {}),
    jwt("e30", "e30"),
    access({}, { alg: "none" }),
    access({}, { alg: "HS256" }),
    access({}, { alg: "eddsa" }),
    access({}, { alg: undefined }),
    access({}, { alg: ["EdDSA"] }),
    access({}, { typ: undefined }),
    access({}, { typ: 7 }),
    access({}, { typ: "JWT" }),
    access({}, { typ: "application/at+jwt" }),
    access({}, { typ: "AT+JWT" }),
    access({}, { typ: "At+Jwt " }),
    access({}, { crit: [] }),
    access({}, { crit: null }),
    access({}, { kid: undefined }),
    access({}, { kid: 1 }),
    access({}, { kid: null }),
    access({}, {}, stranger),
    access({ iss: `${ISSUER}/` }),
    access({ iss: undefined }),
    access({ iss: [ISSUER] }),
    access({ aud: "other" }),
    access({ aud: undefined }),
    access({ aud: 7 }),
    access({ aud: [] }),
    access({ aud: ["other", "doc"] }),
    access({ aud: ["other"] }),
    access({ aud: [["doc"]] }),
    access({ aud: { doc: true } }),
    access({ iat: undefined }),
    access({ iat: String(T) }),
    access({ iat: null }),
    access({ iat: T + 30 }),
    access({ iat: T + 30.001 }),
    access({ iat: T + 31 }),
    access({ iat: -1.5e300 }),
    access({ exp: undefined }),
    access({ exp: String(T + 600) }),
    access({ exp: T - 30 }),
    access({ exp: T - 30.001 }),
    access({ exp: T - 31 }),
    access({ exp: 1.5e300 }),
    access({ sub: undefined }),
    access({ sid: 7 }),
    access({ username: null }),
    access({ name: ["Alice"] }),
    access({ role: { name: "owner" } }),
    access({ sub: undefined, role: undefined }),
    access({ sub: "", sid: "", username: "", name: "", role: "" }),
    // Invalid UTF-8 inside a string becomes U+FFFD; the token still verifies.
    jwt({ alg: "EdDSA", typ: "at+jwt", kid: "k1" }, b64(Buffer.from(Buffer.from(JSON.stringify(JSON.parse(Buffer.from(access({ name: "<>" }).split(".")[1]!, "base64url").toString()))).toString("hex").replace("3c3e", "ffc3"), "hex"))),
  ].map((token) => refreshToken(token)),
  // The clock decides: the same token a moment before it is valid, and after it has expired.
  refreshToken(access({ iat: T + 31 }), NOW + 1000),
  refreshToken(access({ iat: T + 31 }), NOW + 999),
  refreshToken(good, NOW + 630_000),
  refreshToken(good, NOW + 630_001),
]);

const point = (first: number, last = 0, fill = 0) => {
  const bytes = Buffer.alloc(32, fill);
  bytes[0] = first;
  bytes[31] = last;
  return { x: b64(bytes) };
};
const identitySignature = b64(Buffer.concat([Buffer.from([1]), Buffer.alloc(63)]));
const unsigned = (kid: string) => {
  const [head, body] = access({}, { kid }).split(".");
  return `${head}.${body}.${identitySignature}`;
};
const wide = (x: string) => x.slice(0, 5) + String.fromCharCode(x.charCodeAt(5) + 0x100) + x.slice(6);
const xBytes = Buffer.from(k1.x, "base64url");
const ODD_KEYS: [string, object][] = [
  ["rsa", { kty: "RSA" }],
  ["nokty", { kty: undefined }],
  ["x25519", { crv: "X25519" }],
  ["enc", { use: "enc" }],
  ["usenull", { use: null }],
  ["rs256", { alg: "RS256" }],
  ["algnull", { alg: null }],
  ["nox", { x: undefined }],
  ["xnumber", { x: 7 }],
  ["short", { x: b64(xBytes.subarray(0, 31)) }],
  ["long", { x: b64(Buffer.concat([xBytes, Buffer.from([0])])) }],
  ["empty", { x: "" }],
  ["padded", { x: `${k1.x}=` }],
  ["standard", { x: xBytes.toString("base64") }],
  ["spaced", { x: `${k1.x.slice(0, 9)} \n${k1.x.slice(9)}` }],
  ["dangling", { x: `${k1.x}=A` }],
  ["stopped", { x: `${k1.x.slice(0, 20)}=${k1.x.slice(20)}` }],
  ["wide", { x: wide(k1.x) }],
  ["bare", { use: undefined, alg: undefined }],
  ["dup", { x: stranger.x }],
  ["dup", {}],
  ["", {}],
  ["identity", point(1)],
  ["noncanonical", point(0xee, 0x7f, 0xff)],
  ["negzero", point(1, 0x80)],
  ["offcurve", point(2)],
];
await scenario(
  "keys: what a key set may hold",
  {},
  { ...provider(), [K]: json(200, { keys: [null, "text", 7, [jwk("array", k1)], jwk(7, k1), ...ODD_KEYS.map(([kid, extra]) => jwk(kid, k1, extra))] }) },
  [
    ...[...new Set(ODD_KEYS.map(([kid]) => kid)), "array", "7"].map((kid) => refreshToken(access({}, { kid }))),
    // Keys of small order verify the all-zero signature; a key off the curve verifies nothing.
    ...["identity", "noncanonical", "negzero", "offcurve"].map((kid) => refreshToken(unsigned(kid))),
  ],
);
for (const [i, keys] of [json(200, { keys: { k1: jwk("k1", k1) } }), json(200, {}), json(200, { keys: [] })].entries()) {
  await scenario(`keys: an empty key set ${i + 1}`, {}, { ...provider(), [K]: keys }, [refreshToken(good), refreshToken(good), refreshToken(good, NOW + 30_000)]);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const byK2 = access({}, { kid: "k2" }, k2);
const BOTH = json(200, { keys: [jwk("k1", k1), jwk("k2", k2)] });
await scenario("keys: fetched on demand, at most every 30 s, and again after an hour", {}, provider(), [
  refreshToken(good),
  refreshToken(good, NOW + 10_000),
  // An unknown kid asks again, but not within 30 s of the last attempt.
  refreshToken(byK2, NOW + 29_999),
  { now: NOW + 29_999, routes: { [K]: BOTH }, calls: [refresh()] },
  refreshToken(byK2, NOW + 30_000),
  refreshToken(good, NOW + 30_000 + HOUR - 1),
  // An hour after the last successful fetch the keys are fetched again, whatever the kid.
  { now: NOW + 30_000 + HOUR, routes: { [K]: json(200, { keys: [jwk("k2", k2)] }), [TOKEN]: json(200, { access_token: byK2 }) }, calls: [refresh()] },
  // k1 is gone; asking for it is an attempt, and the next one waits 30 s.
  refreshToken(access({ iat: T + 3630, exp: T + 4300 }), NOW + 30_000 + HOUR + 1),
  refreshToken(access({ iat: T + 3630, exp: T + 4300 }), NOW + 60_000 + HOUR),
]);
await scenario("keys: the old ones keep verifying while the provider is unreachable", {}, provider(), [
  refreshToken(good),
  { now: NOW + HOUR, routes: { [K]: json(503, {}), [TOKEN]: json(200, { access_token: access({ iat: T + 3600, exp: T + 4200 }) }) }, calls: [refresh()] },
  { now: NOW + HOUR + 29_999, calls: [refresh()] },
  { now: NOW + HOUR + 30_000, routes: { [K]: { fail: true } }, calls: [refresh()] },
  { now: NOW + HOUR + 60_000, routes: { [K]: json(404, {}) }, calls: [refresh()] },
  { now: NOW + HOUR + 90_000, routes: { [K]: { status: 200, body: "oops" } }, calls: [refresh()] },
  { now: NOW + HOUR + 120_000, routes: { [K]: { status: 302 }, [TOKEN]: json(200, { access_token: access({ iat: T + 3600, exp: T + 4200 }, { kid: "k2" }, k2) }) }, calls: [refresh()] },
  { now: NOW + HOUR + 150_000, routes: { [K]: BOTH }, calls: [refresh()] },
]);
for (const [i, keys] of [json(503, {}), { fail: true } as Canned, json(404, {}), { status: 200, body: "oops" }, json(200, []), { status: 301 }].entries()) {
  await scenario(`keys: unavailable until a fetch succeeds ${i + 1}`, {}, { ...provider(), [K]: keys }, [
    refreshToken(good),
    refreshToken(good, NOW + 29_999),
    refreshToken(good, NOW + 30_000),
    { now: NOW + 60_000, routes: { [K]: KEYS }, calls: [refresh()] },
  ]);
}
await scenario("keys: concurrent verifications share one fetch", {}, provider(), [
  { routes: { [TOKEN]: json(200, { access_token: good }) }, calls: [refresh(), refresh(), readEvent(eventToken({ "user.disabled": { sub: "usr_alice" } })), readEvent("nope")] },
]);
await scenario("keys: concurrent verifications share one failed fetch", {}, { ...provider(), [K]: json(503, {}) }, [
  { calls: [readEvent(eventToken({ "user.disabled": { sub: "usr_alice" } })), readEvent(eventToken({ "user.deleted": { sub: "usr_bob" } }))] },
  { calls: [readEvent(eventToken({ "user.disabled": { sub: "usr_alice" } }))] },
]);
for (const [i, discovery] of [json(200, { ...DISCOVERY, issuer: "https://other.example.test" }), json(200, { ...DISCOVERY, token_endpoint: undefined }), json(503, {}), { fail: true } as Canned].entries()) {
  await scenario(`keys: a discovery document that is refused or missing ${i + 1}`, {}, { [D]: discovery }, [
    { calls: [readEvent(eventToken({ "user.disabled": { sub: "usr_alice" } }))] },
    { calls: [readEvent(eventToken({ "user.disabled": { sub: "usr_alice" } }))] },
    { now: NOW + 30_000, routes: provider(), calls: [readEvent(eventToken({ "user.disabled": { sub: "usr_alice" } }))] },
  ]);
}

// Finishing a sign-in.

const SAVED = { state: "st4te", nonce: "n0nce", verifier: "v3rifier", returnTo: "/s/general", iat: T - 10, fresh: false };
const cookie = (saved: unknown) => `__Host-login=${typeof saved === "string" ? saved : b64(JSON.stringify(saved))}`;
const callback = (query = "code=c0de&state=st4te", header: string | null = cookie(SAVED)): Call => ({
  method: "finishLogin",
  args: [{ cookie: header, url: `${REDIRECT}?${query}` }],
});
const TOKENS = json(200, { access_token: access(), id_token: idToken(), refresh_token: "rt_alice", token_type: "Bearer", expires_in: 600 });
const signIn = (answer: Canned, call: Call = callback()): Step => ({ routes: { [TOKEN]: answer }, calls: [call] });
const withId = (claims: object, header: object = {}, saved: object = SAVED) =>
  signIn(json(200, { access_token: access(), id_token: idToken(claims, header) }), callback(undefined, cookie(saved)));

await scenario("finish login: the cookie and the callback's parameters", {}, { ...provider(), [TOKEN]: TOKENS }, [
  { calls: [callback()] },
  ...[
    null,
    "",
    "session=abc; theme=dark",
    "__Host-login=",
    "__Host-login",
    "__Host-login=a.b",
    "__Host-login=abc=",
    "__Host-login=abc",
    cookie("bm90IGpzb24"),
    cookie(b64("[]")),
    cookie(b64("null")),
    cookie({}),
    cookie({ ...SAVED, state: undefined }),
    cookie({ ...SAVED, nonce: 7 }),
    cookie({ ...SAVED, verifier: null }),
    cookie({ ...SAVED, iat: String(T) }),
    cookie({ ...SAVED, iat: undefined }),
    // The first cookie of that name counts; spaces around names and values don't.
    `a=b;  __Host-login = ${cookie(SAVED).split("=")[1]} ; __Host-login=abc`,
    `__Host-login=abc; ${cookie(SAVED)}`,
    `=x; ${cookie(SAVED)}`,
    `x__Host-login=abc;${cookie(SAVED)};`,
    `__host-login=${cookie(SAVED).split("=")[1]}`,
    // `trim` strips a no-break space, but not U+0085.
    ` __Host-login = ${cookie(SAVED).split("=")[1]} `,
    `\u0085${cookie(SAVED)}`,
    cookie({ ...SAVED, iat: T - 300 }),
    cookie({ ...SAVED, iat: T - 300.001 }),
    cookie({ ...SAVED, iat: T - 301 }),
    cookie({ ...SAVED, iat: T + 30 }),
    cookie({ ...SAVED, iat: T + 30.001 }),
    cookie({ ...SAVED, returnTo: "//evil.example" }),
    cookie({ ...SAVED, returnTo: 7 }),
    cookie({ ...SAVED, returnTo: undefined }),
    cookie({ ...SAVED, returnTo: "/é?a=b#c" }),
  ].map((header) => ({ calls: [callback(undefined, header)] })),
  ...[
    "error=access_denied&state=st4te",
    "error=access_denied",
    "error=&code=c0de&state=st4te",
    `error=${"e".repeat(70)}&error_description=x`,
    // Cut after 64 UTF-16 units, here right after a surrogate pair. (A cut inside
    // a pair leaves half of it, which Rust cannot hold: tests/auth_client.rs.)
    `error=${"é".repeat(62)}%F0%9F%98%80z`,
    "error=a%20b+c%26&error=second",
    "code=c0de&state=other",
    "code=c0de",
    "code=c0de&state=",
    "code=c0de&state=st4te&state=other",
    "code=c0de&state=other&state=st4te",
    "state=st4te",
    "state=st4te&code=",
    "state=st4te&code=&code=c0de",
    "state=st4te&code=a%20b%2Bc+d%26%C3%A9&code=second",
    "STATE=st4te&code=c0de",
    "",
  ].map((query) => ({ calls: [callback(query)] })),
  // An expired cookie comes before everything the callback says.
  { calls: [callback("error=access_denied", cookie({ ...SAVED, iat: T - 301 }))] },
  { calls: [callback("error=access_denied", "__Host-login=abc")] },
  { now: NOW + 290_000, calls: [callback()] },
  { now: NOW + 290_001, calls: [callback()] },
]);
await scenario("finish login: the token endpoint's answers", {}, provider(), [
  signIn(json(400, { error: "invalid_grant" })),
  signIn(json(400, { error: "invalid_request" })),
  signIn(json(429, {})),
  signIn(json(500, {})),
  signIn({ fail: true }),
  signIn({ status: 200, body: "oops" }),
  signIn(json(200, { access_token: access() })),
  signIn(json(200, { id_token: idToken() })),
  signIn(json(200, { access_token: access(), id_token: 7 })),
  signIn(json(200, { access_token: 7, id_token: idToken() })),
  signIn(json(200, { access_token: access(), id_token: idToken() })),
  signIn(json(200, { access_token: access(), id_token: idToken(), refresh_token: null })),
  signIn(json(200, { access_token: access({ exp: T - 31 }), id_token: idToken() })),
  signIn(json(200, { access_token: access({ sid: undefined }), id_token: "nope" })),
  signIn(json(200, { access_token: idToken(), id_token: idToken() })),
  signIn(json(200, { access_token: access(), id_token: access() })),
  signIn(json(200, { access_token: access(), id_token: "nope" })),
]);
await scenario("finish login: the ID token", {}, provider(), [
  withId({}),
  withId({}, { typ: "jwt" }),
  withId({}, { typ: "at+jwt" }),
  withId({ exp: T - 31 }),
  withId({ exp: undefined }),
  withId({ aud: "other" }),
  withId({ aud: ["doc"] }),
  withId({ aud: ["doc", "other"] }),
  withId({ aud: ["doc", "other"], azp: "other" }),
  withId({ aud: ["doc", "other"], azp: "doc" }),
  withId({ aud: ["doc", "doc"], azp: ["doc"] }),
  withId({ aud: "doc", azp: "other" }),
  withId({ nonce: "other" }),
  withId({ nonce: undefined }),
  withId({ nonce: 7 }),
  withId({ nonce: "" }),
  withId({ sub: "usr_bob" }),
  withId({ sub: undefined }),
  withId({ sub: ["usr_alice"] }),
  withId({ sub: "usr_bob", nonce: "other" }),
  withId({ email: null, email_verified: "true", auth_time: undefined, amr: ["pwd"] }),
  withId({ email: undefined, email_verified: undefined }),
  withId({ email: 7, email_verified: 1 }),
  // max_age and prompt=login travel in the cookie and are checked against auth_time.
  withId({ auth_time: undefined }, {}, { ...SAVED, maxAge: 60 }),
  withId({ auth_time: "now" }, {}, { ...SAVED, fresh: true }),
  withId({ auth_time: T - 90 }, {}, { ...SAVED, maxAge: 60 }),
  withId({ auth_time: T - 90.001 }, {}, { ...SAVED, maxAge: 60 }),
  withId({ auth_time: T - 31 }, {}, { ...SAVED, maxAge: 0 }),
  withId({ auth_time: T - 30 }, {}, { ...SAVED, maxAge: 0 }),
  withId({ auth_time: T - 1000 }, {}, { ...SAVED, maxAge: "60" }),
  withId({ auth_time: undefined }, {}, { ...SAVED, maxAge: null, fresh: "true" }),
  withId({ auth_time: T - 40 }, {}, { ...SAVED, fresh: true }),
  withId({ auth_time: T - 40.001 }, {}, { ...SAVED, fresh: true }),
  withId({ auth_time: T - 41 }, {}, { ...SAVED, fresh: true, maxAge: 5 }),
  withId({ auth_time: T - 41 }, {}, { ...SAVED, fresh: true, maxAge: 3600 }),
  withId({ auth_time: T - 20 }, {}, { ...SAVED, fresh: true, maxAge: 3600 }),
  withId({ auth_time: T - 1000 }, {}, { ...SAVED, fresh: 1 }),
]);
await scenario("finish login: a custom audience is the access token's, not the ID token's", { audience: "wiki", clientSecret: undefined }, provider(), [
  signIn(json(200, { access_token: access({ aud: "wiki" }), id_token: idToken() })),
  signIn(json(200, { access_token: access({ aud: "wiki" }), id_token: idToken({ aud: "wiki" }) })),
  signIn(json(200, { access_token: access(), id_token: idToken() })),
]);
await scenario("finish login: discovery comes after the cookie and the parameters", {}, { [D]: json(503, {}) }, [
  { calls: [callback("code=c0de")] },
  { calls: [callback()] },
]);

// Revocation.

await scenario("revoke: answers", {}, provider(), [
  ...[{ status: 200 }, { status: 204 }, json(200, { ok: true }), json(400, { error: "invalid_request" }), { status: 302 }, { status: 404, body: "nope" }, json(500, {}), json(503, {}), { fail: true } as Canned].map(
    (answer) => ({ routes: { [REVOKE]: answer }, calls: [revoke()] }),
  ),
  { routes: { [REVOKE]: { status: 200 } }, calls: [revoke("rt a+b&c=d/é")] },
]);
for (const [i, endpoint] of [undefined, "", null, 0, false, 123, true, {}, [`${ISSUER}/oauth/revoke`], "nope"].entries()) {
  await scenario(`revoke: revocation_endpoint ${i + 1}`, {}, provider({ revocation_endpoint: endpoint }), [{ calls: [revoke()] }]);
}
await scenario("revoke: discovery comes first", {}, { [D]: { fail: true } }, [{ calls: [revoke()] }]);

// Events.

const INHERITED = Object.getOwnPropertyNames(Object.prototype);
await scenario("events: types, fields and refusals", {}, provider(), [
  ...[
    { "session.ended": { sid: "ses_1" } },
    { "session.ended": { sid: "ses_1", sub: "usr_alice", role: "admin", id: "x", invite: "y" } },
    { "session.ended": {} },
    { "session.ended": { sid: 7 } },
    { "access.changed": { sub: "usr_alice", role: "admin" } },
    { "access.changed": { sub: "usr_alice", role: null } },
    { "access.changed": { sub: "usr_alice", role: "" } },
    { "access.changed": { sub: "usr_alice" } },
    { "access.changed": { sub: "usr_alice", role: 7 } },
    { "access.changed": { sub: "usr_alice", role: ["admin"] } },
    { "access.changed": { role: "admin" } },
    { "user.disabled": { sub: "usr_alice" } },
    { "user.disabled": { sub: null } },
    { "user.deleted": { sub: "usr_alice" } },
    { "user.deleted": {} },
    { "invite.accepted": { invite: "inv_1", sub: "usr_zoe" } },
    { "invite.accepted": { sub: "usr_zoe" } },
    { "invite.accepted": { invite: "inv_1" } },
    { "invite.accepted": {} },
    { "credential.revoked": { sub: "usr_alice", id: "key_1" } },
    { "credential.revoked": { sub: "usr_alice" } },
    { "credential.revoked": { id: "key_1" } },
    { "something.new": {} },
    { "something.new": { sub: "usr_alice", sid: "ses_1" } },
    { "": {} },
    { "something.new": null },
    { "something.new": [] },
    { "session.ended": "ses_1" },
    { "session.ended": { sid: "ses_1" }, "user.disabled": { sub: "usr_alice" } },
    {},
    [],
    [{ "session.ended": { sid: "ses_1" } }],
    null,
    "session.ended",
    undefined,
    ...INHERITED.map((name) => JSON.parse(`{${JSON.stringify(name)}:{"sub":"usr_alice"}}`) as object),
    JSON.parse('{"__proto__":null}') as object,
  ].map((events) => ({ calls: [readEvent(eventToken(events))] })),
  ...[
    eventToken({ "user.disabled": { sub: "usr_alice" } }, { jti: undefined }),
    eventToken({ "user.disabled": { sub: "usr_alice" } }, { jti: "" }),
    eventToken({ "user.disabled": { sub: "usr_alice" } }, { jti: 7 }),
    eventToken({ "user.disabled": { sub: "usr_alice" } }, { exp: T - 1000 }),
    eventToken({ "user.disabled": { sub: "usr_alice" } }, { exp: "never" }),
    eventToken({ "user.disabled": { sub: "usr_alice" } }, { iat: undefined }),
    eventToken({ "user.disabled": { sub: "usr_alice" } }, { iat: T + 31 }),
    eventToken({ "user.disabled": { sub: "usr_alice" } }, { aud: "other" }),
    eventToken({ "user.disabled": { sub: "usr_alice" } }, { aud: ["other", "doc"] }),
    eventToken({ "user.disabled": { sub: "usr_alice" } }, { iss: "https://other.example.test" }),
    eventToken({ "user.disabled": { sub: "usr_alice" } }, {}, { typ: "JWT" }),
    eventToken({ "user.disabled": { sub: "usr_alice" } }, {}, { typ: "SecEvent+JWT" }),
    eventToken({ "user.disabled": { sub: "usr_alice" } }, {}, {}, stranger),
    eventToken({ "user.disabled": { sub: "usr_alice" } }, {}, { kid: "k9" }),
    `\n\t ${eventToken({ "user.disabled": { sub: "usr_alice" } })} ﻿\r\n`,
    `\u0085${eventToken({ "user.disabled": { sub: "usr_alice" } })}`,
    "not a token",
    "",
    access(),
  ].map((body) => ({ calls: [readEvent(body)] })),
]);
await scenario("events: a custom audience", { audience: "wiki" }, provider(), [
  { calls: [readEvent(eventToken({ "user.disabled": { sub: "usr_alice" } }, { aud: "wiki" }))] },
  { calls: [readEvent(eventToken({ "user.disabled": { sub: "usr_alice" } }))] },
]);
await scenario("events: the keys cannot be fetched", {}, { ...provider(), [K]: json(503, {}) }, [
  { calls: [readEvent(eventToken({ "user.disabled": { sub: "usr_alice" } }))] },
  // A token that is refused before its key is looked up doesn't need the keys.
  { calls: [readEvent("not a token")] },
  { calls: [readEvent(eventToken({ "user.disabled": { sub: "usr_alice" } }, {}, { alg: "none" }))] },
]);

// --- createAuthClient's own checks, and the lenient decoders

const VALID = { issuer: ISSUER, clientId: "doc", redirectUri: REDIRECT };
const options = [
  VALID,
  { ...VALID, backChannelUrl: BACK, clientSecret: "s3cret", audience: "wiki" },
  ...["", "auth.example.test", "/auth", "http://auth.example.test", "ftp://auth.example.test", "https://", "https://auth.example.test/?tenant=1", "https://auth.example.test/#top", "https://auth.example.test?"].map((issuer) => ({ ...VALID, issuer })),
  ...["https://auth.example.test/#", "https://auth.example.test/?#", "https://auth.example.test/tenant/", "  https://auth.example.test  ", "HTTPS://AUTH.example.test:443"].map((issuer) => ({ ...VALID, issuer })),
  ...["http://localhost:4000", "http://127.0.0.1:4000/auth", "http://[::1]:4000", "http://LOCALHOST", "http://127.1", "http://0x7f.0.0.1", "http://localhost.", "http://[::ffff:127.0.0.1]", "http://127.0.0.2", "http://user:pw@localhost", "http://localhost.example.test"].map((issuer) => ({ ...VALID, issuer })),
  ...["", "auth.internal", "ftp://auth.internal", "http://auth.internal:4000", "https://auth.internal/x/", "http://auth.internal/?a=1", "http://auth.internal/#a", "http://auth.internal/?", "http://user:pw@auth.internal"].map((backChannelUrl) => ({ ...VALID, backChannelUrl })),
  { ...VALID, clientId: "" },
  ...["", "/api/auth/callback", "doc.example.test/callback", "app://callback", "http://doc.example.test/cb?x=1#y", "urn:ietf:wg:oauth:2.0:oob"].map((redirectUri) => ({ ...VALID, redirectUri })),
  { ...VALID, clientSecret: "" },
  { ...VALID, audience: "" },
  { issuer: "", clientId: "", redirectUri: "", clientSecret: "", audience: "" },
  { ...VALID, backChannelUrl: "nope", clientId: "", redirectUri: "", clientSecret: "", audience: "" },
  { ...VALID, clientId: "", redirectUri: "", clientSecret: "", audience: "" },
  { ...VALID, redirectUri: "nope", clientSecret: "", audience: "" },
  { ...VALID, clientSecret: "", audience: "" },
].map((settings) => {
  try {
    createAuthClient(settings);
    return { options: settings, error: null };
  } catch (thrown) {
    return { options: settings, error: (thrown as Error).message };
  }
});

const base64url = [
  ...["", "Q", "QQ", "QR", "QUI", "QUJ", "QUL", "QUJD", "QUJDR", "____", "-_-_", "+/+/", "QQ==", "Q Q", "QUJD=QUJD", "QUJD.QUJD", "QQ=Q", "Q=QQ", "=QUJD", "QUJDQ=UJD", "QUJDQU=JD", "QUJDQUJ=D"],
  ...["QUJDéQUJD", "QUJDŁQUJD", "QUJDīQUJD", "QUJDĽQUJD", "QUJD\u{1F600}QUJD", "QUJD\u{1F601}QUJD", "\u0000Q\u007fQ\u0080"],
  k1.x,
  goodSignature,
].map((input) => ({ input, hex: Buffer.from(input, "base64url").toString("hex") }));

const fixture = {
  issuer: ISSUER,
  backChannel: BACK,
  other: OTHER,
  now: NOW,
  seeds: { k1: k1.seed, k2: k2.seed, stranger: stranger.seed },
  inheritedNames: INHERITED,
  options,
  base64url,
  scenarios,
};
await Bun.write(path.join(import.meta.dir, "auth-client.json"), JSON.stringify(fixture, null, 1) + "\n");
console.log(`${scenarios.length} scenarios, ${scenarios.reduce((n: number, s) => n + (s as { steps: unknown[] }).steps.length, 0)} steps`);
