import type { SQL } from "bun";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import { Client } from "./client";

/*
 * A stand-in for the OpenID Connect provider the servers under test sign
 * people in with: discovery, keys, the token endpoint (authorization codes with
 * PKCE, and refresh tokens), revocation and an end-session address. It keeps a
 * log of every request it received, mints access tokens, ID tokens and event
 * tokens, and has a switch for every way a provider fails.
 *
 * Nothing here knows the server's code: the provider behaves as a real one
 * would (it refuses a wrong client secret, a wrong `code_verifier`, a used
 * code, a revoked refresh token), so a sign-in that works in a test would work
 * against a real provider.
 */

/** An Ed25519 key the provider signs with, and its public half as a JWK. */
export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  /** `{ kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" }` */
  jwk: Record<string, unknown>;
}

export const signingKey = (kid: string): SigningKey => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" } };
};

export const b64url = (value: string | Uint8Array | object): string =>
  Buffer.from(typeof value === "string" || value instanceof Uint8Array ? value : JSON.stringify(value)).toString("base64url");

/** Decodes a base64url segment holding JSON (a JWT part, the login cookie). */
export const decodeSegment = (segment: string): any => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

/** A compact JWT over exactly this header and payload, signed with `key` (Ed25519). */
export const signJwt = (header: object, payload: object, key: KeyObject): string => {
  const h = b64url(header);
  const p = b64url(payload);
  return `${h}.${p}.${edSign(null, Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
};

/** The same token with its signature replaced by one that is as long but wrong. */
export const withBadSignature = (jwt: string): string => {
  const [h, p, s] = jwt.split(".") as [string, string, string];
  const signature = Buffer.from(s, "base64url");
  signature[0] = signature[0]! ^ 0xff;
  return `${h}.${p}.${signature.toString("base64url")}`;
};

export const sha256Base64Url = (value: string): string => createHash("sha256").update(value).digest("base64url");

export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Seconds since the epoch, as tokens count time. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A person as the provider knows them. Tests may change one after sign-in: refreshes answer with what it holds then. */
export interface Person {
  sub: string;
  username: string;
  /** Default: the username. */
  name?: string;
  /** Default: `member`. */
  role?: string;
  /** The provider's session. Default: `ses_<username>`. */
  sid?: string;
  /** Default: `<username>@example.com`; `null` leaves the email claims out of the ID token. */
  email?: string | null;
  /** Default: true. */
  emailVerified?: boolean;
}

/** Changes to a minted token: keys set to `undefined` are left out of the token. */
export interface TokenOverrides {
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  /** Sign with this key instead of the provider's current one (the `kid` in the header is not changed by it). */
  key?: KeyObject;
}

/** One request the provider received. */
export interface ProviderRequest {
  method: string;
  /** Which endpoint it reached: `discovery`, `jwks`, `token`, `revocation`, `authorize`, `logout`, or `unknown`. */
  endpoint: Endpoint | "unknown";
  /** Path and query as sent. */
  path: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
  /** The body read as a form (empty for GET requests). */
  form: URLSearchParams;
  /** HTTP Basic credentials, each part form-decoded as RFC 6749 §2.3.1 says; `raw` is the pair before decoding. */
  basic: { id: string; secret: string; raw: string } | null;
  /** When it arrived (ms since the epoch). */
  at: number;
}

export type Endpoint = "discovery" | "jwks" | "token" | "revocation" | "authorize" | "logout";

/** What the token endpoint answers a code or a refresh token with. */
export interface TokenAnswer {
  access_token?: unknown;
  id_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  [field: string]: unknown;
}

/** An authorization the provider gave: the code the browser carries back to the app's callback. */
export interface Authorization {
  code: string;
  state: string;
  /** Path and query of the app's callback on the server under test, with the code and state the provider sends the browser back with. */
  callback: string;
  /** The `redirect_uri` the app asked for. */
  redirectUri: string;
}

export interface AuthorizeOptions {
  /**
   * Changes what the token endpoint answers for this code. It receives the
   * answer a healthy provider gives (and the nonce of the request), and returns
   * the body to send (status 200) or a whole `Response`.
   */
  answer?: (normal: TokenAnswer, context: { nonce: string; person: Person }) => TokenAnswer | Response;
  /** Changes to the access token and the ID token of the normal answer. */
  accessToken?: TokenOverrides;
  idToken?: TokenOverrides;
  /** Issue no refresh token. */
  noRefreshToken?: boolean;
}

/** How an endpoint answers instead of normally. `normal()` gives the healthy answer. */
export type Hook = (request: ProviderRequest, normal: () => Response | Promise<Response>) => Response | Promise<Response>;

export interface ProviderOptions {
  /**
   * The issuer the provider says it is, in discovery and in tokens. Default:
   * its own address, `http://localhost:<port>`. With another value (say
   * `https://auth.example.test`), point the server's `AUTH_BACKCHANNEL_URL` at
   * `url`. A function receives the provider's own address, for an issuer on a
   * path of it.
   */
  issuer?: string | ((url: string) => string);
  /** Default `doc`. */
  clientId?: string;
  /** Default `s3cret`. */
  clientSecret?: string;
  /** The `aud` of access tokens and events. Default: the client id. */
  audience?: string;
  /**
   * The path the provider serves its endpoints under, on its own address.
   * Default: the issuer's path. Another value stands for a back channel that
   * reaches the issuer under a different path.
   */
  mount?: string;
}

export interface FakeProvider {
  port: number;
  /** `http://localhost:<port>`: where the provider listens. */
  url: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  audience: string;
  /** `AUTH_*` variables for a server that uses this provider. */
  env: Record<string, string>;

  /** The key new tokens are signed with. */
  signer: SigningKey;
  /** The keys the key set lists. */
  keys: SigningKey[];
  /** Entries the key set lists besides `keys`, as given. */
  extraJwks: unknown[];

  /** Every request received, in order. */
  requests: ProviderRequest[];
  /** The requests one endpoint received. */
  seen(endpoint: Endpoint | "unknown"): ProviderRequest[];
  count(endpoint: Endpoint | "unknown"): number;
  /** Resolves once `endpoint` has received `count` requests. */
  waitFor(endpoint: Endpoint, count: number, timeoutMs?: number): Promise<ProviderRequest[]>;
  /** Forgets the requests received so far. */
  clearRequests(): void;

  /** Switches: how each endpoint misbehaves, or `null` for a healthy one. */
  hooks: Partial<Record<Endpoint, Hook | null>>;
  /** Changes the discovery document before it is sent (rename the issuer, drop an endpoint). */
  editDiscovery: ((document: Record<string, unknown>) => unknown) | null;
  /** Refresh tokens are replaced at each use (the answer carries a new one, and the old one stops working). Default false. */
  rotateRefreshTokens: boolean;
  /**
   * Makes requests to `endpoint` wait, after they are logged, until the
   * returned function is called. For answers slower than the caller's timeout,
   * and for lining up requests that must overlap.
   */
  hold(endpoint: Endpoint): () => void;
  /** Stops listening, as a provider that is down: connections are refused. */
  down(): void;
  /** Listens again on the same port. */
  up(): void;
  /** Back to a healthy provider: no hooks, no holds, the normal discovery document, no rotation. Keys and the log stay. */
  heal(): void;

  /** The discovery document a healthy provider serves. */
  discovery(): Record<string, unknown>;

  accessToken(person: Person, overrides?: TokenOverrides): string;
  idToken(person: Person, nonce: string, overrides?: TokenOverrides): string;
  /** A security event token (RFC 8417) carrying `events`. */
  eventToken(events: Record<string, unknown>, overrides?: TokenOverrides): string;

  /** What the provider does when a signed-in person approves the request at `authorizeUrl`: issues a code for the app's callback. */
  authorize(authorizeUrl: string | URL, person: Person, options?: AuthorizeOptions): Authorization;
  /** Issues a code for a request described directly (for callbacks driven with a forged login cookie). */
  issueCode(grant: { person: Person; nonce: string; codeChallenge: string; redirectUri: string } & AuthorizeOptions): string;
  /** The refresh tokens issued so far that still work, with the person each belongs to. */
  refreshTokens: Map<string, Person>;
  /** Refresh tokens the app revoked. */
  revoked: string[];

  stop(): Promise<void>;
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

/** Ready-made hooks for `provider.hooks`. */
export const answers = {
  /** This status with a JSON body (5xx, 429, 404, 400 with an `error`…). */
  status:
    (status: number, body: unknown = {}, headers: Record<string, string> = {}): Hook =>
    () =>
      jsonResponse(status, body, headers),
  /** 200 with this text as the body, whatever was asked. */
  text:
    (body: string, contentType = "application/json"): Hook =>
    () =>
      new Response(body, { status: 200, headers: { "Content-Type": contentType } }),
  /** 200 with this JSON value. */
  json:
    (body: unknown): Hook =>
    () =>
      jsonResponse(200, body),
  /** A redirect to `location`. */
  redirect:
    (location: string, status = 302): Hook =>
    () =>
      new Response(null, { status, headers: { Location: location } }),
};

const formDecode = (value: string) => decodeURIComponent(value.replace(/\+/g, " "));

const parseBasic = (header: string | undefined): ProviderRequest["basic"] => {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header ?? "");
  if (!match) return null;
  const raw = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = raw.indexOf(":");
  if (colon < 0) return null;
  try {
    return { id: formDecode(raw.slice(0, colon)), secret: formDecode(raw.slice(colon + 1)), raw };
  } catch {
    return null;
  }
};

const merge = (base: Record<string, unknown>, changes: Record<string, unknown> | undefined) => {
  const out: Record<string, unknown> = { ...base, ...changes };
  for (const [key, value] of Object.entries(out)) if (value === undefined) delete out[key];
  return out;
};

interface Grant {
  person: Person;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  options: AuthorizeOptions;
}

/** Starts a provider on a free port of this machine. */
export const startFakeProvider = (options: ProviderOptions = {}): FakeProvider => {
  const clientId = options.clientId ?? "doc";
  const clientSecret = options.clientSecret ?? "s3cret";
  const audience = options.audience ?? clientId;
  const firstKey = signingKey("k1");
  const grants = new Map<string, Grant>();
  const holds = new Map<Endpoint, Promise<void>>();
  const arrivals: (() => void)[] = [];
  let nextId = 1;

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.text() : "";
    const headers: Record<string, string> = {};
    req.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
    const local = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
    const endpoint = (local && ROUTES[`${req.method} ${local}`]) || "unknown";
    const request: ProviderRequest = {
      method: req.method,
      endpoint,
      path: url.pathname + url.search,
      headers,
      body,
      form: new URLSearchParams(body),
      basic: parseBasic(headers.authorization),
      at: Date.now(),
    };
    provider.requests.push(request);
    for (const wake of arrivals.splice(0)) wake();
    if (endpoint === "unknown") return jsonResponse(404, { error: "not_found" });
    await holds.get(endpoint);
    const normal = () => NORMAL[endpoint](request);
    const hook = provider.hooks[endpoint];
    return hook ? hook(request, normal) : normal();
  };

  let listener = Bun.serve({ port: 0, fetch: handle });
  const port = listener.port!;
  const url = `http://localhost:${port}`;
  const issuer = typeof options.issuer === "function" ? options.issuer(url) : (options.issuer ?? url);
  const issuerBase = issuer.replace(/\/+$/, "");
  /** Where the endpoints live on the provider's own address: under the issuer's path, unless mounted elsewhere. */
  const prefix = (options.mount ?? new URL(issuerBase).pathname).replace(/\/+$/, "");
  let up = true;

  const ROUTES: Record<string, Endpoint> = {
    "GET /.well-known/openid-configuration": "discovery",
    "GET /.well-known/jwks.json": "jwks",
    "POST /oauth/token": "token",
    "POST /oauth/revoke": "revocation",
    "GET /oauth/authorize": "authorize",
    "GET /logout": "logout",
  };

  const clientAuthenticated = (request: ProviderRequest) => request.basic?.id === clientId && request.basic.secret === clientSecret;

  const answerFor = (person: Person, nonce: string | null, opts: AuthorizeOptions, refreshToken: string | null): TokenAnswer => ({
    access_token: provider.accessToken(person, opts.accessToken),
    ...(nonce === null ? {} : { id_token: provider.idToken(person, nonce, opts.idToken) }),
    ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
    token_type: "Bearer",
    expires_in: 600,
  });

  const newRefreshToken = (person: Person) => {
    const value = `rt_${person.username}_${nextId++}_${randomBytes(6).toString("hex")}`;
    provider.refreshTokens.set(value, person);
    return value;
  };

  const tokenEndpoint = (request: ProviderRequest): Response => {
    if (!clientAuthenticated(request)) return jsonResponse(401, { error: "invalid_client" }, { "WWW-Authenticate": "Basic" });
    const { form } = request;
    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code") ?? "";
      const grant = grants.get(code);
      // A code works once.
      grants.delete(code);
      if (!grant || form.get("redirect_uri") !== grant.redirectUri || sha256Base64Url(form.get("code_verifier") ?? "") !== grant.codeChallenge) {
        return jsonResponse(400, { error: "invalid_grant" });
      }
      const refreshToken = grant.options.noRefreshToken ? null : newRefreshToken(grant.person);
      const normal = answerFor(grant.person, grant.nonce, grant.options, refreshToken);
      const answer = grant.options.answer ? grant.options.answer(normal, { nonce: grant.nonce, person: grant.person }) : normal;
      return answer instanceof Response ? answer : jsonResponse(200, answer);
    }
    if (form.get("grant_type") === "refresh_token") {
      const presented = form.get("refresh_token") ?? "";
      const person = provider.refreshTokens.get(presented);
      if (!person) return jsonResponse(400, { error: "invalid_grant" });
      let rotated: string | null = null;
      if (provider.rotateRefreshTokens) {
        provider.refreshTokens.delete(presented);
        rotated = newRefreshToken(person);
      }
      return jsonResponse(200, answerFor(person, null, {}, rotated));
    }
    return jsonResponse(400, { error: "unsupported_grant_type" });
  };

  const NORMAL: Record<Endpoint, (request: ProviderRequest) => Response> = {
    discovery: () => jsonResponse(200, provider.editDiscovery ? provider.editDiscovery(provider.discovery()) : provider.discovery()),
    jwks: () => jsonResponse(200, { keys: [...provider.extraJwks, ...provider.keys.map((key) => key.jwk)] }),
    token: tokenEndpoint,
    revocation: (request) => {
      if (!clientAuthenticated(request)) return jsonResponse(401, { error: "invalid_client" }, { "WWW-Authenticate": "Basic" });
      const token = request.form.get("token") ?? "";
      if (provider.refreshTokens.delete(token)) provider.revoked.push(token);
      return new Response(null, { status: 200 });
    },
    // The browser's side of the provider; the servers under test never call these.
    authorize: () => new Response("sign in", { status: 200 }),
    logout: () => new Response("signed out", { status: 200 }),
  };

  const mint = (header: Record<string, unknown>, claims: Record<string, unknown>, overrides: TokenOverrides = {}) =>
    signJwt(merge(header, overrides.header), merge(claims, overrides.claims), overrides.key ?? provider.signer.privateKey);

  const provider: FakeProvider = {
    port,
    url,
    issuer,
    clientId,
    clientSecret,
    audience,
    env: {
      AUTH_ISSUER: issuer,
      ...(issuerBase === url + prefix ? {} : { AUTH_BACKCHANNEL_URL: url + prefix }),
      AUTH_CLIENT_ID: clientId,
      AUTH_CLIENT_SECRET: clientSecret,
      ...(audience === clientId ? {} : { AUTH_AUDIENCE: audience }),
    },
    signer: firstKey,
    keys: [firstKey],
    extraJwks: [],
    requests: [],
    seen: (endpoint) => provider.requests.filter((request) => request.endpoint === endpoint),
    count: (endpoint) => provider.seen(endpoint).length,
    async waitFor(endpoint, count, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (provider.count(endpoint) < count) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`the provider saw ${provider.count(endpoint)} ${endpoint} requests, not ${count}, after ${timeoutMs} ms`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left);
          arrivals.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return provider.seen(endpoint);
    },
    clearRequests() {
      provider.requests.length = 0;
    },
    hooks: {},
    editDiscovery: null,
    rotateRefreshTokens: false,
    hold(endpoint) {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      holds.set(endpoint, held);
      return () => {
        if (holds.get(endpoint) === held) holds.delete(endpoint);
        release();
      };
    },
    down() {
      if (!up) return;
      up = false;
      void listener.stop(true);
    },
    up() {
      if (up) return;
      listener = Bun.serve({ port, fetch: handle });
      up = true;
    },
    heal() {
      provider.hooks = {};
      provider.editDiscovery = null;
      provider.rotateRefreshTokens = false;
      holds.clear();
      provider.up();
    },
    discovery: () => ({
      issuer,
      authorization_endpoint: `${issuerBase}/oauth/authorize`,
      token_endpoint: `${issuerBase}/oauth/token`,
      revocation_endpoint: `${issuerBase}/oauth/revoke`,
      jwks_uri: `${issuerBase}/.well-known/jwks.json`,
      end_session_endpoint: `${issuerBase}/logout`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["EdDSA"],
      code_challenge_methods_supported: ["S256"],
    }),
    accessToken: (person, overrides) =>
      mint(
        { alg: "EdDSA", typ: "at+jwt", kid: provider.signer.kid },
        {
          iss: issuer,
          sub: person.sub,
          aud: audience,
          iat: nowSeconds(),
          exp: nowSeconds() + 600,
          sid: person.sid ?? `ses_${person.username}`,
          username: person.username,
          name: person.name ?? person.username,
          role: person.role ?? "member",
        },
        overrides,
      ),
    idToken: (person, nonce, overrides) =>
      mint(
        { alg: "EdDSA", typ: "JWT", kid: provider.signer.kid },
        {
          iss: issuer,
          sub: person.sub,
          aud: clientId,
          iat: nowSeconds(),
          exp: nowSeconds() + 600,
          nonce,
          auth_time: nowSeconds(),
          ...(person.email === null ? {} : { email: person.email ?? `${person.username}@example.com`, email_verified: person.emailVerified ?? true }),
        },
        overrides,
      ),
    eventToken: (events, overrides) =>
      mint(
        { alg: "EdDSA", typ: "secevent+jwt", kid: provider.signer.kid },
        { iss: issuer, aud: audience, iat: nowSeconds(), jti: `evt_${crypto.randomUUID()}`, events },
        overrides,
      ),
    authorize(authorizeUrl, person, opts = {}) {
      const asked = new URL(authorizeUrl);
      const param = (name: string) => asked.searchParams.get(name) ?? "";
      const expected = `${issuerBase}/oauth/authorize`;
      if (asked.origin + asked.pathname !== expected) throw new Error(`the app sent the browser to ${asked.origin}${asked.pathname}, not ${expected}`);
      if (param("response_type") !== "code") throw new Error(`response_type is ${param("response_type")}`);
      if (param("client_id") !== clientId) throw new Error(`client_id is ${param("client_id")}`);
      if (param("code_challenge_method") !== "S256" || !param("code_challenge")) throw new Error("the request carries no S256 code challenge");
      if (!param("scope").split(" ").includes("openid")) throw new Error(`scope is ${param("scope")}`);
      if (!param("state") || !param("nonce") || !param("redirect_uri")) throw new Error("the request lacks state, nonce or redirect_uri");
      const redirectUri = param("redirect_uri");
      const code = provider.issueCode({ person, nonce: param("nonce"), codeChallenge: param("code_challenge"), redirectUri, ...opts });
      const back = new URLSearchParams({ code, state: param("state") });
      return { code, state: param("state"), callback: `${CALLBACK}?${back}`, redirectUri };
    },
    issueCode({ person, nonce, codeChallenge, redirectUri, ...opts }) {
      const code = `code_${nextId++}_${randomBytes(6).toString("hex")}`;
      grants.set(code, { person, nonce, codeChallenge, redirectUri, options: opts });
      return code;
    },
    refreshTokens: new Map(),
    revoked: [],
    async stop() {
      holds.clear();
      if (up) await listener.stop(true);
      up = false;
    },
  };
  return provider;
};

/** What `GET /api/auth/login` answered. */
export interface StartedLogin {
  res: Response;
  /** `Location`, when it is a URL of the provider. */
  authorize: URL | null;
  location: string | null;
  /** The `Set-Cookie` values of the answer. */
  setCookies: string[];
  /** The login cookie's value, and what it holds. */
  cookie: string | null;
  saved: Record<string, any> | null;
}

const LOGIN_COOKIE = "__Host-login";
/** Where the servers under test take the provider's redirect, whatever host the redirect URI names. */
const CALLBACK = "/api/auth/callback";

/** Starts a sign-in as a browser does: `GET /api/auth/login`, keeping the login cookie in the client's jar. */
export const startLogin = async (client: Client, returnTo?: string): Promise<StartedLogin> => {
  const res = await client.fetch(`/api/auth/login${returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`}`);
  await res.body?.cancel();
  const location = res.headers.get("location");
  const setCookies = res.headers.getSetCookie();
  const cookie = client.cookies.get(LOGIN_COOKIE) ?? null;
  let saved: Record<string, any> | null = null;
  if (cookie) {
    try {
      saved = decodeSegment(cookie);
    } catch {
      saved = null;
    }
  }
  return { res, authorize: location && /^https?:/.test(location) ? new URL(location) : null, location, setCookies, cookie, saved };
};

/** What `GET /api/auth/callback` answered. */
export interface FinishedLogin {
  res: Response;
  status: number;
  location: string | null;
  setCookies: string[];
}

/** Follows the provider's redirect back to the app: `GET` on the callback, with the client's cookies. */
export const finishLogin = async (client: Client, callback: string, init: RequestInit = {}): Promise<FinishedLogin> => {
  const res = await client.fetch(callback, init);
  await res.body?.cancel();
  return { res, status: res.status, location: res.headers.get("location"), setCookies: res.headers.getSetCookie() };
};

export interface SignInOptions extends AuthorizeOptions {
  returnTo?: string;
  /** Sign in with this client (its cookie jar and address) instead of a new one. */
  client?: Client;
}

export interface SignedIn extends FinishedLogin {
  client: Client;
  start: StartedLogin;
  authorization: Authorization;
}

/**
 * Signs in through the provider as `person`: the app's login redirect, the
 * provider's approval, the app's callback. The returned client holds the
 * session cookie when the sign-in worked; check `location` for how it went.
 */
export const signIn = async (base: string, provider: FakeProvider, person: Person, options: SignInOptions = {}): Promise<SignedIn> => {
  const { returnTo, client = new Client(base), ...authorizeOptions } = options;
  const start = await startLogin(client, returnTo);
  if (start.res.status !== 302 || !start.authorize) throw new Error(`the login route answered ${start.res.status} with Location ${start.location}`);
  const authorization = provider.authorize(start.authorize, person, authorizeOptions);
  const finished = await finishLogin(client, authorization.callback);
  return { ...finished, client, start, authorization };
};

/** What a login cookie holds; the app does not sign it, so a test can make one. */
export interface LoginState {
  state?: unknown;
  nonce?: unknown;
  verifier?: unknown;
  returnTo?: unknown;
  iat?: unknown;
  [field: string]: unknown;
}

export interface ForgedLogin {
  state: string;
  nonce: string;
  verifier: string;
  /** The cookie's value. */
  cookie: string;
  /** Path and query of the callback, with a code the provider issued for `person`. */
  callback: string;
  code: string;
}

/**
 * Puts a login cookie of the test's own making in the client's jar, and has
 * the provider issue a code that goes with it, as if the sign-in had been
 * started `changes.iat` ago, or with whatever else `changes` holds.
 */
export const forgeLogin = (
  client: Client,
  provider: FakeProvider,
  person: Person,
  changes: LoginState = {},
  options: AuthorizeOptions & { redirectUri?: string } = {},
): ForgedLogin => {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const { redirectUri = "http://doc.test/api/auth/callback", ...authorizeOptions } = options;
  const saved: LoginState = { state, nonce, verifier, returnTo: "/", iat: nowSeconds(), ...changes };
  const cookie = b64url(saved);
  client.cookies.set(LOGIN_COOKIE, cookie);
  const code = provider.issueCode({ person, nonce, codeChallenge: sha256Base64Url(verifier), redirectUri, ...authorizeOptions });
  return { state, nonce, verifier, cookie, code, callback: `${CALLBACK}?code=${code}&state=${state}` };
};

/** The row of the session a client's cookie stands for, or undefined once it has ended. */
export const sessionRow = async (sql: SQL, client: Client): Promise<Record<string, any> | undefined> => {
  if (!client.cookie) return undefined;
  const [row] = await sql`SELECT * FROM sessions WHERE token_hash = ${sha256Hex(client.cookie)}`;
  return row;
};

/**
 * Waits for a line of the server's log, among those after the first `since`
 * lines, that is a JSON object holding these fields, and returns it.
 */
export const logged = async (
  server: { logs: string[] },
  fields: Record<string, unknown>,
  since = 0,
  timeoutMs = 3000,
): Promise<Record<string, any>> => {
  const deadline = Date.now() + timeoutMs;
  const wanted = Object.entries(fields);
  for (;;) {
    for (const line of server.logs.slice(since)) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry && typeof entry === "object" && wanted.every(([key, value]) => Bun.deepEquals((entry as Record<string, unknown>)[key], value))) {
        return entry as Record<string, any>;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`no log line with ${JSON.stringify(fields)} within ${timeoutMs} ms; the log since then:\n${server.logs.slice(since).join("\n")}`);
    }
    await Bun.sleep(10);
  }
};
