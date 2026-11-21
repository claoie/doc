import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { connect, startServer, type Client, type TestServer } from "./harness";
import { answers, logged, sessionRow, sha256Hex, signIn, signingKey, startFakeProvider, withBadSignature, type Person, type SignInOptions } from "./harness/oidc";

/*
 * Sessions started through the identity provider: the re-check of access
 * every 10 minutes, the events the provider pushes (`POST /auth/events`),
 * signing out, and what happens to open sockets. Long waits (the minute
 * between socket checks, the back-off after a failed re-check) are in
 * sso.slow.test.ts.
 */

const ISSUER = "https://auth.example.test";
const UNAUTHORIZED = { error: { code: "unauthorized", message: "Sign in required" } };
const INVALID_TOKEN = { error: { code: "invalid_token", message: "The event did not verify" } };

const idp = startFakeProvider({ issuer: ISSUER });
const stranger = signingKey("k1");

let t: TestServer;
let alice: Client;

let people = 0;
/** A person of their own for a test, so sessions and back-offs never mix. */
const person = (changes: Partial<Person> = {}): Person => {
  const n = ++people;
  return { sub: `usr_p${n}`, username: `p${n}`, name: `Person ${n}`, ...changes };
};

const enter = (who: Person, options: SignInOptions = {}) => signIn(t.base, idp, who, options);
const userBySub = async (sub: string): Promise<Record<string, any> | undefined> => (await t.sql`SELECT * FROM users WHERE auth_sub = ${sub}`)[0];

/** Makes the session's re-check due `minutesAgo` minutes ago. */
const due = (client: Client, minutesAgo: number) =>
  t.sql`UPDATE sessions SET auth_recheck_at = now() - make_interval(mins => ${minutesAgo}) WHERE token_hash = ${sha256Hex(client.cookie!)}`;

const refreshes = () => idp.seen("token").filter((request) => request.form.get("grant_type") === "refresh_token");

const postEvent = async (token: string, headers: Record<string, string> = { "Content-Type": "application/secevent+jwt" }, server: TestServer = t) => {
  const res = await server.client().raw("POST", "/auth/events", { body: token, headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
};

beforeAll(async () => {
  t = await startServer({ env: idp.env });
  // The first person in sets the workspace up and owns it.
  alice = (await enter({ sub: "usr_alice", username: "alice", name: "Alice", role: "owner" })).client;
});

afterEach(() => {
  idp.heal();
});

afterAll(async () => {
  await t.close();
  await idp.stop();
});

describe("re-checking a session with the provider", () => {
  test("is not done before it is due", async () => {
    const { client } = await enter(person());
    const before = refreshes().length;
    expect((await client.get("/me")).status).toBe(200);
    expect(refreshes()).toHaveLength(before);
  });

  test("once due, asks the provider with the session's refresh token, applies its answer, and waits another 10 minutes", async () => {
    const who = person({ role: "member", email: "recheck@example.com" });
    const { client } = await enter(who);
    const session = (await sessionRow(t.sql, client))!;
    await due(client, 1);
    // What the provider knows has changed since sign-in.
    who.role = "admin";
    who.name = "Renamed";
    who.email = "changed@example.com";
    const count = refreshes().length;
    const before = Date.now();
    const res = await client.get("/me");
    const after = Date.now();
    expect(res.status).toBe(200);
    // The same request already sees the new role and name. A re-check carries no ID token: the email stays, still the provider's.
    expect(res.body.data.user).toMatchObject({ role: "admin", name: "Renamed", email: "recheck@example.com", ssoManaged: true, ssoManagedEmail: true });

    const asked = refreshes().slice(count);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.path).toBe("/oauth/token");
    expect(asked[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(asked[0]!.headers.accept).toBe("application/json");
    expect(Object.fromEntries(asked[0]!.form)).toEqual({ grant_type: "refresh_token", refresh_token: session.auth_refresh_token });
    expect(asked[0]!.basic).toEqual({ id: "doc", secret: "s3cret", raw: "doc:s3cret" });

    const now = (await sessionRow(t.sql, client))!;
    const recheckAt = new Date(now.auth_recheck_at).getTime();
    expect(recheckAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(recheckAt).toBeLessThanOrEqual(after + 600_000);
    // The provider sent no new refresh token: the session keeps the one it has.
    expect(now.auth_refresh_token).toBe(session.auth_refresh_token);
    expect(now.auth_sid).toBe(session.auth_sid);
    expect((await client.get("/me")).status).toBe(200);
    expect(refreshes()).toHaveLength(count + 1);
  });

  test("stores the refresh token the provider rotated to, and uses it at the next re-check", async () => {
    const { client } = await enter(person());
    const first = (await sessionRow(t.sql, client))!.auth_refresh_token;
    idp.rotateRefreshTokens = true;
    await due(client, 1);
    expect((await client.get("/me")).status).toBe(200);
    const second = (await sessionRow(t.sql, client))!.auth_refresh_token;
    expect(second).not.toBe(first);
    expect(idp.refreshTokens.has(second)).toBe(true);
    await due(client, 1);
    expect((await client.get("/me")).status).toBe(200);
    expect(refreshes().at(-1)!.form.get("refresh_token")).toBe(second);
    expect((await sessionRow(t.sql, client))!.auth_refresh_token).not.toBe(second);
  });

  test("makes an unknown role a member, and runs whatever the endpoint asked for", async () => {
    const who = person({ role: "admin" });
    const { client } = await enter(who);
    who.role = "wizard";
    await due(client, 1);
    const count = refreshes().length;
    // A public endpoint, asked with the session's cookie.
    expect((await client.get("/auth/config")).status).toBe(200);
    expect(refreshes()).toHaveLength(count + 1);
    expect((await userBySub(who.sub))!.role).toBe("member");
  });

  test("ends the session when the provider refuses the refresh token, and closes its sockets", async () => {
    const who = person();
    const { client } = await enter(who);
    const session = (await sessionRow(t.sql, client))!;
    const socket = await connect(client);
    // Revoked at the provider.
    idp.refreshTokens.delete(session.auth_refresh_token);
    await due(client, 1);
    const res = await client.get("/me");
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED as never);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await sessionRow(t.sql, client)).toBeUndefined();
    expect(await socket.closed).toEqual({ code: 4001, reason: "signed out" });
    // The account is not deactivated: the provider refuses the person itself.
    expect((await userBySub(who.sub))!.deactivated_at).toBeNull();
    expect((await client.get("/me")).status).toBe(401);
  });

  test("ends a session that has no refresh token at its first re-check, without asking the provider", async () => {
    const { client } = await enter(person(), { noRefreshToken: true });
    expect((await client.get("/me")).status).toBe(200);
    await due(client, 0);
    const count = idp.count("token");
    expect((await client.get("/me")).status).toBe(401);
    expect(await sessionRow(t.sql, client)).toBeUndefined();
    expect(idp.count("token")).toBe(count);
  });

  test("ends the session when the refreshed token is about someone else, and applies none of it", async () => {
    const who = person({ role: "member" });
    const { client } = await enter(who);
    await due(client, 1);
    idp.hooks.token = () =>
      new Response(JSON.stringify({ access_token: idp.accessToken({ sub: "usr_someone_else", username: who.username, role: "owner" }), token_type: "Bearer", expires_in: 600 }), {
        headers: { "Content-Type": "application/json" },
      });
    expect((await client.get("/me")).status).toBe(401);
    expect(await sessionRow(t.sql, client)).toBeUndefined();
    expect((await userBySub(who.sub))!.role).toBe("member");
  });

  describe("while the provider cannot answer", () => {
    const tokenAnswer = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

    /** What goes wrong, and the error the server logs when it is not simply the provider being unreachable. */
    const FAILURES: [string, (who: Person) => void, string | null][] = [
      ["answers 503", () => (idp.hooks.token = answers.status(503, { error: "temporarily_unavailable" })), null],
      ["is down", () => idp.down(), null],
      ["answers 429", () => (idp.hooks.token = answers.status(429, { error: "slow_down" })), null],
      ["answers with something that is not JSON", () => (idp.hooks.token = answers.text("<html>")), null],
      ["answers without an access token", () => (idp.hooks.token = () => tokenAnswer({ token_type: "Bearer" })), null],
      [
        "refuses the client",
        () => (idp.hooks.token = answers.status(401, { error: "invalid_client" })),
        "the token endpoint refused the request (invalid_client)",
      ],
      [
        "answers with a token whose signature is wrong",
        (who) => (idp.hooks.token = () => tokenAnswer({ access_token: withBadSignature(idp.accessToken(who)) })),
        "bad signature",
      ],
      [
        "answers with a token that has expired",
        (who) => (idp.hooks.token = () => tokenAnswer({ access_token: idp.accessToken(who, { claims: { exp: Math.floor(Date.now() / 1000) - 32 } }) })),
        "expired",
      ],
    ];

    test.each(FAILURES)("when the provider %s, the session is still served, and the provider is not asked again right away", async (_what, breakIt, error) => {
      const who = person({ role: "member" });
      const { client } = await enter(who);
      await due(client, 30);
      const dueAt = (await sessionRow(t.sql, client))!.auth_recheck_at;
      who.role = "admin";
      breakIt(who);
      const mark = t.logs.length;
      const count = refreshes().length;
      const down = idp.hooks.token === undefined || idp.hooks.token === null;
      const res = await client.get("/me");
      expect(res.status).toBe(200);
      // As the account was: nothing of the failed answer is applied.
      expect(res.body.data.user.role).toBe("member");
      if (error) await logged(t, { level: "error", msg: "re-checking a single sign-on session failed", error }, mark);
      // Within the minute after, its requests do not wait on the provider again.
      expect((await client.get("/me")).status).toBe(200);
      expect((await client.get("/spaces")).status).toBe(200);
      expect(refreshes()).toHaveLength(down ? count : count + 1);
      // The re-check stays due.
      expect((await sessionRow(t.sql, client))!.auth_recheck_at).toEqual(dueAt);
    });

    test("a session is served up to an hour past its re-check", async () => {
      const { client } = await enter(person());
      await due(client, 59);
      idp.hooks.token = answers.status(503, {});
      expect((await client.get("/me")).status).toBe(200);
    });

    test("a session more than an hour past its re-check ends", async () => {
      const { client } = await enter(person());
      await due(client, 61);
      idp.hooks.token = answers.status(503, {});
      const count = refreshes().length;
      const res = await client.get("/me");
      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED as never);
      // It asked one last time.
      expect(refreshes()).toHaveLength(count + 1);
      expect(await sessionRow(t.sql, client)).toBeUndefined();
    });

    test("a session that passes the hour during the minute it is not asking ends too, without asking", async () => {
      const { client } = await enter(person());
      await due(client, 30);
      idp.hooks.token = answers.status(503, {});
      const count = refreshes().length;
      expect((await client.get("/me")).status).toBe(200);
      expect(refreshes()).toHaveLength(count + 1);
      await due(client, 61);
      expect((await client.get("/me")).status).toBe(401);
      expect(refreshes()).toHaveLength(count + 1);
      expect(await sessionRow(t.sql, client)).toBeUndefined();
    });
  });

  test("requests of one session that arrive together share one re-check", async () => {
    const who = person({ role: "member" });
    const { client } = await enter(who);
    who.role = "admin";
    await due(client, 1);
    const count = refreshes().length;
    const release = idp.hold("token");
    const requests = Array.from({ length: 6 }, () => client.get("/me"));
    await idp.waitFor("token", idp.count("token") + 1);
    // Time for the others to reach the server while the provider keeps the first waiting.
    await Bun.sleep(150);
    release();
    const answersGiven = await Promise.all(requests);
    expect(answersGiven.map((res) => res.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(answersGiven.map((res) => res.body.data.user.role)).toEqual(["admin", "admin", "admin", "admin", "admin", "admin"]);
    expect(refreshes()).toHaveLength(count + 1);
  });

  test("requests that arrive together while the provider refuses are all turned away after one question", async () => {
    const { client } = await enter(person());
    idp.refreshTokens.delete((await sessionRow(t.sql, client))!.auth_refresh_token);
    await due(client, 1);
    const count = refreshes().length;
    const release = idp.hold("token");
    const requests = Array.from({ length: 4 }, () => client.get("/me"));
    await idp.waitFor("token", idp.count("token") + 1);
    await Bun.sleep(150);
    release();
    expect((await Promise.all(requests)).map((res) => res.status)).toEqual([401, 401, 401, 401]);
    expect(refreshes()).toHaveLength(count + 1);
  });
});

describe("POST /auth/events", () => {
  const signedOut = async (sub: string, client: Client) => {
    expect((await client.get("/me")).status).toBe(401);
    const user = (await userBySub(sub))!;
    // Ended, not deactivated or deleted: the provider refuses their sign-in itself.
    expect(user.deactivated_at).toBeNull();
    expect(await t.sql`SELECT 1 FROM sessions WHERE user_id = ${user.id}`).toHaveLength(0);
  };

  test("session.ended ends the sessions started from that provider session, and closes their sockets", async () => {
    const who = person();
    const one = await enter({ ...who, sid: "ses_one" });
    const same = await enter({ ...who, sid: "ses_one" });
    const two = await enter({ ...who, sid: "ses_two" });
    const sockets = [await connect(one.client), await connect(two.client)];
    const res = await postEvent(idp.eventToken({ "session.ended": { sid: "ses_one" } }));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ data: {} });
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await sockets[0]!.closed).toEqual({ code: 4001, reason: "signed out" });
    expect((await one.client.get("/me")).status).toBe(401);
    expect((await same.client.get("/me")).status).toBe(401);
    // The person's other provider session goes on, socket included.
    expect((await two.client.get("/me")).status).toBe(200);
    sockets[1]!.send({ t: "ping" });
    expect(await sockets[1]!.nextOf("pong")).toEqual({ t: "pong" });
    // Delivered again, or about a session nobody has: nothing to do, and still acknowledged.
    expect((await postEvent(idp.eventToken({ "session.ended": { sid: "ses_one" } }))).status).toBe(202);
    expect((await postEvent(idp.eventToken({ "session.ended": { sid: "ses_unknown" } }))).status).toBe(202);
    expect((await two.client.get("/me")).status).toBe(200);
    await sockets[1]!.close();
  });

  test("access.changed with a role sets the person's role and leaves their sessions", async () => {
    const who = person({ role: "member" });
    const { client } = await enter(who);
    for (const [role, expected] of [["admin", "admin"], ["owner", "owner"], ["editor", "member"], ["", "member"]]) {
      const res = await postEvent(idp.eventToken({ "access.changed": { sub: who.sub, role } }));
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ data: {} });
      expect((await client.get("/me")).body.data.user.role).toBe(expected!);
    }
  });

  test("access.changed with a null role ends every session of the person, without deactivating them", async () => {
    const who = person();
    const one = await enter({ ...who, sid: "ses_a" });
    const two = await enter({ ...who, sid: "ses_b" });
    const socket = await connect(one.client);
    expect((await postEvent(idp.eventToken({ "access.changed": { sub: who.sub, role: null } }))).status).toBe(202);
    expect(await socket.closed).toEqual({ code: 4001, reason: "signed out" });
    await signedOut(who.sub, one.client);
    expect((await two.client.get("/me")).status).toBe(401);
    // A role granted again while signed out is taken, and the person can sign in again.
    expect((await postEvent(idp.eventToken({ "access.changed": { sub: who.sub, role: "admin" } }))).status).toBe(202);
    expect((await userBySub(who.sub))!.role).toBe("admin");
    expect((await enter({ ...who, role: "admin" })).location).toBe("/");
  });

  test.each(["user.disabled", "user.deleted"])("%s ends every session of the person and closes their sockets; the account stays", async (type) => {
    const who = person();
    const one = await enter({ ...who, sid: "ses_a" });
    const two = await enter({ ...who, sid: "ses_b" });
    const other = await enter(person());
    const socket = await connect(one.client);
    const res = await postEvent(idp.eventToken({ [type]: { sub: who.sub } }));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ data: {} });
    expect(await socket.closed).toEqual({ code: 4001, reason: "signed out" });
    await signedOut(who.sub, one.client);
    expect((await two.client.get("/me")).status).toBe(401);
    expect((await other.client.get("/me")).status).toBe(200);
    // Their pages and their membership stay: the member list still has them.
    const members = (await alice.get("/members?limit=500")).body.data.items;
    expect(members.find((m: { name: string }) => m.name === who.name)).toMatchObject({ deactivatedAt: null, ssoManaged: true });
  });

  test("events about people and sessions nobody here has are acknowledged", async () => {
    for (const events of [
      { "access.changed": { sub: "usr_nobody", role: "owner" } },
      { "access.changed": { sub: "usr_nobody", role: null } },
      { "user.disabled": { sub: "usr_nobody" } },
      { "user.deleted": { sub: "usr_nobody" } },
    ]) {
      const res = await postEvent(idp.eventToken(events));
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ data: {} });
    }
  });

  test("invite.accepted, credential.revoked and types the server does not know are acknowledged and change nothing", async () => {
    const who = person({ role: "member" });
    const { client } = await enter(who);
    for (const events of [
      { "invite.accepted": { invite: "inv_1", sub: who.sub } },
      { "credential.revoked": { sub: who.sub, id: "key_1" } },
      { "something.new": {} },
      { "something.new": { sub: who.sub, sid: `ses_${who.username}`, role: null } },
      { "https://schemas.openid.net/secevent/risc/event-type/account-disabled": { subject: { sub: who.sub } } },
    ]) {
      const res = await postEvent(idp.eventToken(events));
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ data: {} });
    }
    expect((await client.get("/me")).body.data.user).toMatchObject({ role: "member", name: who.name });
  });

  test("the body is read whatever its content type, with or without white space around the token", async () => {
    const token = () => idp.eventToken({ "something.new": {} });
    for (const type of ["application/secevent+jwt", "text/plain", "application/json", "application/x-www-form-urlencoded", null]) {
      expect((await postEvent(token(), type === null ? {} : { "Content-Type": type })).status).toBe(202);
    }
    expect((await postEvent(`\n  ${token()}\r\n`)).status).toBe(202);
  });

  test("an event may carry no expiry, or one that has passed, and claims the server does not know", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect((await postEvent(idp.eventToken({ "something.new": {} }, { claims: { exp: past } }))).status).toBe(202);
    expect((await postEvent(idp.eventToken({ "something.new": {} }, { claims: { iat: past, txn: "t1", toe: past } }))).status).toBe(202);
    expect((await postEvent(idp.eventToken({ "something.new": {} }, { header: { typ: "SECEVENT+JWT" }, claims: { aud: ["other", "doc"] } }))).status).toBe(202);
  });

  test.each([
    ["typed as a plain JWT", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { header: { typ: "JWT" } })],
    ["that is an access token", () => idp.accessToken({ sub: "usr_alice", username: "alice" }, { claims: { jti: "evt_1", events: { "user.disabled": { sub: "usr_alice" } } } })],
    ["without a type", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { header: { typ: undefined } })],
    ["naming another algorithm", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { header: { alg: "HS256" } })],
    ["with a critical header", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { header: { crit: ["events"] } })],
    ["without a key id", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { header: { kid: undefined } })],
    ["with a key id the provider does not publish", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { header: { kid: "k9" } })],
    ["with a wrong signature", () => withBadSignature(idp.eventToken({ "user.disabled": { sub: "usr_alice" } }))],
    ["signed by another key under the same key id", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { key: stranger.privateKey })],
    ["from another issuer", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { claims: { iss: "https://auth.example.com" } })],
    ["for another audience", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { claims: { aud: "another-service" } })],
    ["without an audience", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { claims: { aud: undefined } })],
    ["issued 40 seconds from now", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { claims: { iat: Math.floor(Date.now() / 1000) + 40 } })],
    ["without an issue time", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { claims: { iat: undefined } })],
    ["without an id", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { claims: { jti: undefined } })],
    ["with an empty id", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { claims: { jti: "" } })],
    ["with an id that is not a string", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" } }, { claims: { jti: 7 } })],
    ["carrying two events", () => idp.eventToken({ "user.disabled": { sub: "usr_alice" }, "session.ended": { sid: "ses_alice" } })],
    ["carrying no event", () => idp.eventToken({})],
    ["without the events claim", () => idp.eventToken({}, { claims: { events: undefined } })],
    ["whose events are a list", () => idp.eventToken({}, { claims: { events: [{ "user.disabled": { sub: "usr_alice" } }] } })],
    ["whose event is not an object", () => idp.eventToken({ "user.disabled": "usr_alice" })],
    ["whose unknown event is not an object", () => idp.eventToken({ "something.new": null })],
    ["session.ended without a session", () => idp.eventToken({ "session.ended": { sub: "usr_alice" } })],
    ["session.ended with a session that is not a string", () => idp.eventToken({ "session.ended": { sid: 7 } })],
    ["access.changed without a subject", () => idp.eventToken({ "access.changed": { role: "owner" } })],
    ["access.changed without a role", () => idp.eventToken({ "access.changed": { sub: "usr_alice" } })],
    ["access.changed with a role that is neither a string nor null", () => idp.eventToken({ "access.changed": { sub: "usr_alice", role: ["owner"] } })],
    ["user.disabled without a subject", () => idp.eventToken({ "user.disabled": {} })],
    ["user.deleted without a subject", () => idp.eventToken({ "user.deleted": { sid: "ses_alice" } })],
    ["invite.accepted without the invitation", () => idp.eventToken({ "invite.accepted": { sub: "usr_alice" } })],
    ["invite.accepted without a subject", () => idp.eventToken({ "invite.accepted": { invite: "inv_1" } })],
    ["credential.revoked without the credential", () => idp.eventToken({ "credential.revoked": { sub: "usr_alice" } })],
    ["that is not a token", () => "not a token"],
    ["that is empty", () => ""],
    ["that is JSON", () => JSON.stringify({ events: { "user.disabled": { sub: "usr_alice" } } })],
  ])("an event %s is refused, and nothing is done", async (_what, token) => {
    const res = await postEvent(token());
    expect(res.status).toBe(400);
    expect(res.body).toEqual(INVALID_TOKEN);
    expect((await alice.get("/me")).status).toBe(200);
  });

  test("is not held to the origin check that other POST routes keep", async () => {
    for (const Origin of ["https://auth.example.test", "https://evil.example", "null"]) {
      expect((await postEvent(idp.eventToken({ "something.new": {} }), { Origin })).status).toBe(202);
    }
    const { client } = await enter(person());
    const crossOrigin = await client.request("POST", "/auth/logout", {}, { Origin: "https://auth.example.test" });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body).toEqual({ error: { code: "forbidden_origin", message: "Cross-origin request rejected" } } as never);
    expect((await client.get("/me")).status).toBe(200);
  });

  test("answers only POST", async () => {
    const res = await t.client().get("/auth/events");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found", message: "Endpoint not found" } } as never);
  });

  test("reads at most 64 KiB", async () => {
    const token = idp.eventToken({ "something.new": {} });
    const padded = (bytes: number) => token + " ".repeat(bytes - token.length);
    expect((await postEvent(padded(65_536))).status).toBe(202);
    const tooLarge = await postEvent(padded(65_537));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body).toEqual({ error: { code: "payload_too_large", message: "Request body is too large" } });
    // The same when the size is not announced up front.
    const chunks = [padded(65_537).slice(0, 40_000), padded(65_537).slice(40_000)];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const streamed = await t.client().raw("POST", "/auth/events", { body: stream, duplex: "half" } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(await streamed.json()).toEqual({ error: { code: "payload_too_large", message: "Request body is too large" } });
  });

  test("keeps verifying with the keys it has while the provider is down", async () => {
    const before = idp.count("jwks");
    idp.down();
    expect((await postEvent(idp.eventToken({ "something.new": {} }))).status).toBe(202);
    // A key id it does not have cannot be looked up: within 30 seconds of the last fetch it is not even tried.
    expect((await postEvent(idp.eventToken({ "something.new": {} }, { header: { kid: "k9" } }))).status).toBe(400);
    idp.up();
    expect(idp.count("jwks")).toBe(before);
  });

  test("answers 600 events a minute per address, then 429", async () => {
    const client = t.client();
    const send = () => client.raw("POST", "/auth/events", { body: "x" }).then(async (res) => (await res.body?.cancel(), res.status));
    const statuses: number[] = [];
    for (let batch = 0; batch < 12; batch++) statuses.push(...(await Promise.all(Array.from({ length: 50 }, send))));
    // Counted before the event is read: these 600 were all refused as events.
    expect(statuses.filter((status) => status === 400)).toHaveLength(600);
    const limited = await client.request("POST", "/auth/events", undefined);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: { code: "rate_limited", message: "Too many attempts. Try again in a minute." } } as never);
    // Another address is not held back.
    expect((await postEvent(idp.eventToken({ "something.new": {} }))).status).toBe(202);
  });
});

describe("events on a server that has not fetched the provider's keys yet", () => {
  const fresh = startFakeProvider({ issuer: ISSUER });

  afterEach(() => {
    fresh.heal();
  });

  afterAll(async () => {
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

  test("an event makes the server fetch the discovery document and the keys, then is applied", async () => {
    await withFreshServer(async (server) => {
      fresh.clearRequests();
      expect((await postEvent(fresh.eventToken({ "something.new": {} }), {}, server)).status).toBe(202);
      expect((await postEvent(fresh.eventToken({ "something.new": {} }), {}, server)).status).toBe(202);
      expect(fresh.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /.well-known/openid-configuration", "GET /.well-known/jwks.json"]);
    });
  });

  test.each([
    ["the key set answers 503", () => (fresh.hooks.jwks = answers.status(503, {}))],
    ["the key set answers 404", () => (fresh.hooks.jwks = answers.status(404, {}))],
    ["the key set is not JSON", () => (fresh.hooks.jwks = answers.text("keys"))],
    ["the discovery document answers 503", () => (fresh.hooks.discovery = answers.status(503, {}))],
    ["the provider is down", () => fresh.down()],
  ])("when %s, the event is answered 503 so that the provider sends it again", async (_what, breakIt) => {
    await withFreshServer(async (server) => {
      breakIt();
      const res = await postEvent(fresh.eventToken({ "user.disabled": { sub: "usr_alice" } }), {}, server);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: { code: "unavailable", message: "The identity provider is unreachable" } });
      // An event that could never verify is not looked at before the keys are had.
      expect((await postEvent(fresh.eventToken({}), {}, server)).status).toBe(503);
      expect((await alice.get("/me")).status).toBe(200);
      // A token that is not one at all is refused without the keys.
      expect((await postEvent("not a token", {}, server)).status).toBe(400);
    });
  });

  test("after a failed fetch the keys are not asked for again for 30 seconds: events stay 503 though the provider is back", async () => {
    await withFreshServer(async (server) => {
      fresh.clearRequests();
      fresh.hooks.jwks = answers.status(503, {});
      expect((await postEvent(fresh.eventToken({ "something.new": {} }), {}, server)).status).toBe(503);
      fresh.heal();
      expect((await postEvent(fresh.eventToken({ "something.new": {} }), {}, server)).status).toBe(503);
      expect(fresh.count("jwks")).toBe(1);
    });
  });

  test("a discovery document naming another issuer fails the first event with a 500", async () => {
    await withFreshServer(async (server) => {
      fresh.editDiscovery = (document) => ({ ...document, issuer: "https://auth.example.com" });
      const mark = server.logs.length;
      const res = await postEvent(fresh.eventToken({ "something.new": {} }), {}, server);
      // Accident: a provider that is there but misconfigured is not "unavailable" here, so the event falls through to the catch-all.
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: "internal_error", message: "Something went wrong" } });
      await logged(server, { level: "error", msg: "request failed", method: "POST", path: "/api/auth/events", error: "the discovery document names a different issuer" }, mark);
      // The events after it, for 30 seconds, are answered 503: the keys are not asked for again.
      expect((await postEvent(fresh.eventToken({ "something.new": {} }), {}, server)).status).toBe(503);
    });
  });
});

describe("POST /auth/logout", () => {
  test("of a session started through the provider ends it, revokes its refresh token, and says where to end the provider's session", async () => {
    const { client } = await enter(person());
    const session = (await sessionRow(t.sql, client))!;
    const revocations = idp.count("revocation");
    const res = await client.post("/auth/logout");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { logoutUrl: "https://auth.example.test/logout?client_id=doc&post_logout_redirect_uri=http%3A%2F%2Fdoc.test%2F" } });
    expect(res.headers.getSetCookie()).toEqual(["session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]);
    expect(await t.sql`SELECT 1 FROM sessions WHERE id = ${session.id}`).toHaveLength(0);
    // The revocation goes out in the background.
    const request = (await idp.waitFor("revocation", revocations + 1)).at(-1)!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/oauth/revoke");
    expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(request.form)).toEqual({ token: session.auth_refresh_token, token_type_hint: "refresh_token" });
    expect(request.basic).toEqual({ id: "doc", secret: "s3cret", raw: "doc:s3cret" });
    const again = t.client();
    again.cookie = sha256Hex("x");
    expect((await again.post("/auth/logout")).status).toBe(401);
  });

  test("of a session without a refresh token revokes nothing, and still says where to go", async () => {
    const without = await enter(person(), { noRefreshToken: true });
    const revocations = idp.count("revocation");
    expect((await without.client.post("/auth/logout")).body).toEqual({
      data: { logoutUrl: "https://auth.example.test/logout?client_id=doc&post_logout_redirect_uri=http%3A%2F%2Fdoc.test%2F" },
    });
    // The next sign-out's revocation is the next one the provider sees.
    const withToken = await enter(person());
    const token = (await sessionRow(t.sql, withToken.client))!.auth_refresh_token;
    await withToken.client.post("/auth/logout");
    const seen = await idp.waitFor("revocation", revocations + 1);
    expect(seen.slice(revocations).map((request) => request.form.get("token"))).toEqual([token]);
  });

  test("still answers when the provider refuses or fails the revocation", async () => {
    for (const [hook, error] of [
      [answers.status(400, { error: "unsupported_token_type" }), "revocation refused the request (400)"],
      [answers.status(503, {}), "auth answered 503"],
    ] as const) {
      idp.hooks.revocation = hook;
      const { client } = await enter(person());
      const mark = t.logs.length;
      const res = await client.post("/auth/logout");
      expect(res.status).toBe(200);
      expect(res.body.data.logoutUrl).toBe("https://auth.example.test/logout?client_id=doc&post_logout_redirect_uri=http%3A%2F%2Fdoc.test%2F");
      await logged(t, { level: "warn", msg: "revoking a refresh token failed", error }, mark);
      expect((await client.get("/me")).status).toBe(401);
    }
  });

  describe("with a provider whose discovery document differs", () => {
    const other = startFakeProvider({ issuer: ISSUER });

    afterEach(() => {
      other.heal();
    });

    afterAll(async () => {
      await other.stop();
    });

    const withServer = async (run: (server: TestServer) => Promise<void>) => {
      const server = await startServer({ env: { ...other.env, DATABASE_POOL_MAX: "2" }, keepDatabase: true });
      try {
        await run(server);
      } finally {
        await server.close();
      }
    };

    test("no end-session endpoint: the session ends and the answer names no address", async () => {
      await withServer(async (server) => {
        other.editDiscovery = (document) => ({ ...document, end_session_endpoint: undefined });
        const { client } = await signIn(server.base, other, person());
        const revocations = other.count("revocation");
        const mark = server.logs.length;
        const res = await client.post("/auth/logout");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ data: {} });
        expect(res.headers.getSetCookie()).toEqual(["session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]);
        await logged(server, { level: "warn", msg: "the provider's sign-out address is unavailable", error: "the provider has no end_session_endpoint" }, mark);
        // The refresh token is revoked all the same.
        await other.waitFor("revocation", revocations + 1);
        expect((await client.get("/me")).status).toBe(401);
      });
    });

    test("no revocation endpoint: nothing is revoked, and the address is still given", async () => {
      await withServer(async (server) => {
        other.editDiscovery = (document) => ({ ...document, revocation_endpoint: undefined });
        const { client } = await signIn(server.base, other, person());
        const mark = server.logs.length;
        const res = await client.post("/auth/logout");
        expect(res.body).toEqual({ data: { logoutUrl: "https://auth.example.test/logout?client_id=doc&post_logout_redirect_uri=http%3A%2F%2Fdoc.test%2F" } });
        await logged(server, { level: "warn", msg: "revoking a refresh token failed", error: "the provider has no revocation endpoint" }, mark);
      });
    });

    test("endpoints that carry a query of their own keep it", async () => {
      await withServer(async (server) => {
        other.editDiscovery = (document) => ({
          ...document,
          authorization_endpoint: `${document.authorization_endpoint}?tenant=acme&state=theirs`,
          end_session_endpoint: `${document.end_session_endpoint}?tenant=acme`,
        });
        const client = server.client();
        const res = await client.fetch("/api/auth/login");
        const authorize = new URL(res.headers.get("location")!);
        expect(authorize.origin + authorize.pathname).toBe("https://auth.example.test/oauth/authorize");
        expect(authorize.searchParams.get("tenant")).toBe("acme");
        // The server's own parameters replace the endpoint's of the same name.
        expect(authorize.searchParams.getAll("state")).toEqual([expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)]);
        expect(authorize.searchParams.get("client_id")).toBe("doc");
        const signedIn = await signIn(server.base, other, person());
        expect((await signedIn.client.post("/auth/logout")).body).toEqual({
          data: { logoutUrl: "https://auth.example.test/logout?tenant=acme&client_id=doc&post_logout_redirect_uri=http%3A%2F%2Fdoc.test%2F" },
        });
      });
    });

    test("a server that cannot reach the provider at sign-out still ends the session, and names no address", async () => {
      // Signed in through the main server; signed out on a copy that has never reached the provider.
      const { client } = await enter(person());
      const session = (await sessionRow(t.sql, client))!;
      await withServer(async (server) => {
        other.down();
        const there = server.client();
        there.cookie = client.cookie;
        const mark = server.logs.length;
        const res = await there.post("/auth/logout");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ data: {} });
        await logged(server, { level: "warn", msg: "the provider's sign-out address is unavailable", error: "auth is unreachable" }, mark);
        await logged(server, { level: "warn", msg: "revoking a refresh token failed", error: "auth is unreachable" }, mark);
      });
      expect(await t.sql`SELECT 1 FROM sessions WHERE id = ${session.id}`).toHaveLength(0);
      expect((await client.get("/me")).status).toBe(401);
    });
  });
});

describe("members linked to the provider", () => {
  test("can be deactivated, which signs them out and refuses their sign-in, and reactivated", async () => {
    const who = person();
    const { client } = await enter(who);
    const id = (await userBySub(who.sub))!.id;
    const socket = await connect(client);
    expect((await alice.post("/members/deactivate", { userId: id })).body).toEqual({ data: {} });
    expect(await socket.closed).toEqual({ code: 4001, reason: "signed out" });
    expect((await client.get("/me")).status).toBe(401);
    expect(await t.sql`SELECT 1 FROM sessions WHERE user_id = ${id}`).toHaveLength(0);
    const refused = await enter(who);
    expect(refused.location).toBe("/login?sso_error=deactivated");
    expect(refused.client.cookie).toBeNull();
    expect((await alice.post("/members/activate", { userId: id })).body).toEqual({ data: {} });
    const again = await enter(who);
    expect(again.location).toBe("/");
    expect((await again.client.get("/me")).body.data.user.id).toBe(id);
  });

  test("can be removed; signing in again makes them a new account", async () => {
    const who = person();
    const { client } = await enter(who);
    const id = (await userBySub(who.sub))!.id;
    const socket = await connect(client);
    expect((await alice.post("/members/delete", { userId: id })).body).toEqual({ data: {} });
    expect(await socket.closed).toEqual({ code: 4001, reason: "signed out" });
    expect((await client.get("/me")).status).toBe(401);
    expect(await userBySub(who.sub)).toBeUndefined();
    const again = await enter(who);
    expect(again.location).toBe("/");
    expect((await again.client.get("/me")).body.data.user.id).not.toBe(id);
  });
});
