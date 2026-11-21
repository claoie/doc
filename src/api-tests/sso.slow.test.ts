import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, startServer, type Client, type Socket, type TestServer } from "./harness";
import {
  answers,
  finishLogin,
  forgeLogin,
  sessionRow,
  sha256Hex,
  signIn,
  signingKey,
  startFakeProvider,
  startLogin,
  type FakeProvider,
  type Person,
} from "./harness/oidc";

/*
 * The parts of single sign-on that only time shows: the minute between the
 * checks of open sockets, the minute a session waits before asking an
 * unreachable provider again, the 30 seconds between fetches of the provider's
 * keys, the minute of the sign-in rate limit, and the 5 seconds the server
 * gives the provider to answer. Everything is set in motion together in
 * `beforeAll`, so the file waits a little over a minute once.
 */

const MINUTE = 60_000;
const SIGNED_OUT = { code: 4001, reason: "signed out" };

describe.skipIf(process.env.API_TEST_SKIP_SLOW === "1")("single sign-on, over time", () => {
  let idp: FakeProvider;
  let lateKeys: FakeProvider;
  let slow: FakeProvider;
  /** The leader: sockets live here. Single sign-on with passwords kept. */
  let t: TestServer;
  /** Another copy of the server on the same database. */
  let copy: TestServer;
  /** A server whose provider's keys were down at first use. */
  let late: TestServer;
  /** A server whose provider answers too slowly. */
  let patient: TestServer;

  let startedAt: number;
  let backedOffAt: number;
  /** Refresh tokens the provider answers 503 for. */
  const failing = new Set<string>();

  const sockets: Record<string, Socket> = {};
  const clients: Record<string, Client> = {};
  const tokens: Record<string, string> = {};
  let limited: Client;
  let timeouts: Promise<{ what: string; ms: number; outcome: string | number | null }[]>;

  const enter = (person: Person) => signIn(t.base, idp, person);
  const refreshesOf = (token: string) => idp.seen("token").filter((request) => request.form.get("refresh_token") === token).length;
  const due = (client: Client, minutesAgo: number) =>
    t.sql`UPDATE sessions SET auth_recheck_at = now() - make_interval(mins => ${minutesAgo}) WHERE token_hash = ${sha256Hex(client.cookie!)}`;
  const until = async (time: number) => {
    const left = time - Date.now();
    if (left > 0) await Bun.sleep(left);
  };

  beforeAll(async () => {
    idp = startFakeProvider({ issuer: "https://auth.example.test" });
    lateKeys = startFakeProvider({ issuer: "https://late.example.test" });
    slow = startFakeProvider({ issuer: "https://slow.example.test" });
    idp.hooks.token = (request, normal) =>
      failing.has(request.form.get("refresh_token") ?? "") ? answers.status(503, { error: "temporarily_unavailable" })(request, normal) : normal();

    t = await startServer({ env: { ...idp.env, AUTH_LOCAL_LOGIN: "true" } });
    startedAt = Date.now();
    const { owner } = await t.setupOwner();
    copy = await startServer({ env: { ...idp.env, AUTH_LOCAL_LOGIN: "true", DATABASE_POOL_MAX: "2" }, keepDatabase: true });
    late = await startServer({ env: { ...lateKeys.env, DATABASE_POOL_MAX: "2" }, keepDatabase: true });
    patient = await startServer({ env: { ...slow.env, DATABASE_POOL_MAX: "2" }, keepDatabase: true });

    // Sessions with an open socket on the leader, and what happens to each elsewhere.
    for (const name of ["deleted", "deactivated", "event", "refused", "rechecked", "kept", "waiting", "recovering"]) {
      clients[name] = (await enter({ sub: `usr_${name}`, username: name })).client;
      tokens[name] = (await sessionRow(t.sql, clients[name]!))!.auth_refresh_token;
    }
    clients.password = owner;
    for (const name of ["deleted", "deactivated", "event", "refused", "rechecked", "kept", "password"]) sockets[name] = await connect(clients[name]!);

    // As another copy of the server would: in the database only.
    await t.sql`DELETE FROM sessions WHERE token_hash = ${sha256Hex(clients.deleted!.cookie!)}`;
    await t.sql`UPDATE users SET deactivated_at = now() WHERE auth_sub = 'usr_deactivated'`;
    await t.sql`DELETE FROM sessions WHERE token_hash = ${sha256Hex(clients.password!.cookie!)}`;
    // The provider's event reaches the other copy.
    const event = await copy.client().raw("POST", "/auth/events", { body: idp.eventToken({ "user.disabled": { sub: "usr_event" } }) });
    expect(event.status).toBe(202);
    // A re-check comes due with nobody asking: the provider will refuse one and answer the other.
    idp.refreshTokens.delete(tokens.refused!);
    await due(clients.refused!, 1);
    await due(clients.rechecked!, 1);

    // Two sessions whose re-check the provider cannot answer.
    for (const name of ["waiting", "recovering"]) {
      failing.add(tokens[name]!);
      await due(clients[name]!, 30);
      expect((await clients[name]!.get("/me")).status).toBe(200);
    }
    backedOffAt = Date.now();

    // An address that used up its minute of sign-in starts.
    limited = t.client();
    for (let i = 0; i < 60; i++) await (await limited.fetch("/api/auth/login")).body?.cancel();
    expect((await startLogin(limited)).location).toBe("/login?sso_error=rate_limited");

    // A server that could not get the keys the first time it needed them; the provider is back at once.
    lateKeys.hooks.jwks = answers.status(503, {});
    expect((await signIn(late.base, lateKeys, { sub: "usr_late", username: "late" })).location).toBe("/login?sso_error=unavailable");
    lateKeys.heal();

    // A provider that takes longer than the server waits, endpoint by endpoint.
    timeouts = (async () => {
      const results: { what: string; ms: number; outcome: string | number | null }[] = [];
      const timed = async (what: string, endpoint: "discovery" | "token" | "jwks", act: () => Promise<string | number | null>) => {
        const release = slow.hold(endpoint);
        const from = Date.now();
        const outcome = await act();
        results.push({ what, ms: Date.now() - from, outcome });
        release();
      };
      await timed("discovery", "discovery", async () => (await startLogin(patient.client())).location);
      // The session for the last step, while the provider still answers.
      const session = await signIn(patient.base, slow, { sub: "usr_patient", username: "patient" });
      await patient.sql`UPDATE sessions SET auth_recheck_at = now() - interval '1 minute' WHERE token_hash = ${sha256Hex(session.client.cookie!)}`;
      await timed("token", "token", async () => {
        const client = patient.client();
        return (await finishLogin(client, forgeLogin(client, slow, { sub: "usr_patient", username: "patient" }).callback)).location;
      });
      await timed("recheck", "token", async () => (await session.client.get("/me")).status);
      return results;
    })();
  }, 60_000);

  afterAll(async () => {
    for (const socket of Object.values(sockets)) socket.ws.close();
    await Promise.all([t, copy, late, patient].filter(Boolean).map((server) => server.close()));
    await Promise.all([idp, lateKeys, slow].filter(Boolean).map((provider) => provider.stop()));
  });

  test(
    "open sockets close within a minute once their session has ended elsewhere, by whatever means",
    async () => {
      const closed = await Promise.all(
        ["deleted", "deactivated", "event", "refused", "password"].map((name) =>
          Promise.race([sockets[name]!.closed, Bun.sleep(75_000).then(() => `${name} is still open`)]),
        ),
      );
      // The session row deleted, the user deactivated, the provider's event taken by another copy,
      // a re-check the provider refused, and a password session revoked.
      expect(closed).toEqual([SIGNED_OUT, SIGNED_OUT, SIGNED_OUT, SIGNED_OUT, SIGNED_OUT]);
      // All in one check, a minute after the server started.
      expect(Date.now() - startedAt).toBeGreaterThan(MINUTE - 5000);
      expect(Date.now() - startedAt).toBeLessThan(MINUTE + 10_000);
    },
    90_000,
  );

  test("a socket whose session is still good stays open through the check", async () => {
    sockets.kept!.send({ t: "ping" });
    expect(await sockets.kept!.nextOf("pong")).toEqual({ t: "pong" });
    expect((await clients.kept!.get("/me")).status).toBe(200);
  });

  test("the check re-checks a due session with the provider, though its browser asked for nothing", async () => {
    expect(refreshesOf(tokens.refused!)).toBe(1);
    expect(await sessionRow(t.sql, clients.refused!)).toBeUndefined();
    expect(refreshesOf(tokens.rechecked!)).toBe(1);
    const session = (await sessionRow(t.sql, clients.rechecked!))!;
    expect(new Date(session.auth_recheck_at).getTime()).toBeGreaterThan(Date.now() + 8 * MINUTE);
    sockets.rechecked!.send({ t: "ping" });
    expect(await sockets.rechecked!.nextOf("pong")).toEqual({ t: "pong" });
  });

  test(
    "a session asks an unreachable provider again a minute after the last try, and no sooner",
    async () => {
      // Since the failed try: served without asking.
      expect((await clients.waiting!.get("/me")).status).toBe(200);
      expect(refreshesOf(tokens.waiting!)).toBe(1);
      await until(backedOffAt + MINUTE + 1500);
      expect((await clients.waiting!.get("/me")).status).toBe(200);
      expect(refreshesOf(tokens.waiting!)).toBe(2);
      // And then waits another minute.
      expect((await clients.waiting!.get("/me")).status).toBe(200);
      expect(refreshesOf(tokens.waiting!)).toBe(2);
    },
    90_000,
  );

  test(
    "once the provider answers again, the session is re-checked and goes back to every 10 minutes",
    async () => {
      await until(backedOffAt + MINUTE + 1500);
      failing.delete(tokens.recovering!);
      expect((await clients.recovering!.get("/me")).status).toBe(200);
      expect(refreshesOf(tokens.recovering!)).toBe(2);
      const session = (await sessionRow(t.sql, clients.recovering!))!;
      expect(new Date(session.auth_recheck_at).getTime()).toBeGreaterThan(Date.now() + 9 * MINUTE);
      expect((await clients.recovering!.get("/me")).status).toBe(200);
      expect(refreshesOf(tokens.recovering!)).toBe(2);
    },
    90_000,
  );

  test(
    "an address held back from signing in may start again a minute after its first try",
    async () => {
      await until(backedOffAt + MINUTE + 1500);
      const started = await startLogin(limited);
      expect(started.res.status).toBe(302);
      expect(started.authorize!.origin).toBe("https://auth.example.test");
    },
    90_000,
  );

  test(
    "30 seconds after the last fetch, a key id the server does not have makes it fetch the keys once more",
    async () => {
      await until(startedAt + 35_000);
      const fetched = idp.count("jwks");
      // The provider has rotated to a new key.
      const next = signingKey("k2");
      idp.keys = [next, idp.signer];
      idp.signer = next;
      const rotated = await enter({ sub: "usr_kept", username: "kept" });
      expect(rotated.location).toBe("/");
      expect(idp.count("jwks")).toBe(fetched + 1);
      // The old key is still in the set, and tokens signed with it still verify.
      const old = idp.keys[1]!;
      const withOld = await signIn(t.base, idp, { sub: "usr_kept", username: "kept" }, { accessToken: { header: { kid: "k1" }, key: old.privateKey }, idToken: { header: { kid: "k1" }, key: old.privateKey } });
      expect(withOld.location).toBe("/");
      // A key id nobody publishes does not make it fetch again so soon.
      const unknown = await signIn(t.base, idp, { sub: "usr_kept", username: "kept" }, { accessToken: { header: { kid: "k9" } } });
      expect(unknown.location).toBe("/login?sso_error=login_failed");
      expect(idp.count("jwks")).toBe(fetched + 1);
    },
    90_000,
  );

  test(
    "a server that could not get the keys at first gets them 30 seconds later",
    async () => {
      await until(startedAt + 40_000);
      const fetched = lateKeys.count("jwks");
      expect(fetched).toBe(1);
      const signedIn = await signIn(late.base, lateKeys, { sub: "usr_late", username: "late" });
      expect(signedIn.location).toBe("/");
      expect(lateKeys.count("jwks")).toBe(2);
    },
    90_000,
  );

  test(
    "the server gives the provider five seconds to answer, then treats it as unreachable",
    async () => {
      const results = await timeouts;
      expect(results.map(({ what, outcome }) => [what, outcome])).toEqual([
        ["discovery", "/login?sso_error=unavailable"],
        ["token", "/login?sso_error=unavailable"],
        // A session is still served when its re-check times out.
        ["recheck", 200],
      ]);
      for (const { ms } of results) {
        expect(ms).toBeGreaterThanOrEqual(4500);
        expect(ms).toBeLessThan(9000);
      }
    },
    60_000,
  );
});
