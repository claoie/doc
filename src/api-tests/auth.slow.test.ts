import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, startServer, until, type Client, type Socket, type TestServer } from "./harness";
import { resetToken, rows, sha256, signIn, waitForMailsTo } from "./harness/admin";

/*
 * What the server does on its own about a minute after it started: it closes
 * the sockets of sessions that ended without it being told at once (sign-out,
 * a revoked session, a changed password, an expiry), and it removes expired
 * sessions and expired reset links. All scenarios are set up first, so the
 * file waits once.
 */
describe.skipIf(process.env.API_TEST_SKIP_SLOW === "1")("about a minute after the server started", () => {
  let t: TestServer;
  let owner: Client;

  beforeAll(async () => {
    t = await startServer();
    ({ owner } = await t.setupOwner());
  });

  afterAll(async () => {
    await t.close();
  });

  const closedWithin = (socket: Socket, ms: number) =>
    Promise.race([socket.closed, Bun.sleep(ms).then(() => ({ code: 0, reason: `still open after ${ms} ms` }))]);

  test(
    "sockets of ended sessions are closed with 4001, expired sessions and reset links are deleted, and what is live stays",
    async () => {
      const { client: first, user } = await t.addMember(owner, "slow@example.com");
      const fresh = () => signIn(t, "slow@example.com", "member-password");

      // A session that signs out.
      const signedOut = await connect(first);
      await first.post("/auth/logout");

      // A session revoked from another one, and that other one, which stays.
      const keeper = await fresh();
      const revoked = await fresh();
      const revokedSocket = await connect(revoked);
      const keeperSocket = await connect(keeper);
      const revokedId = (await rows(t.sql`SELECT id FROM sessions WHERE token_hash = ${sha256(revoked.cookie!)}`))[0].id;
      await keeper.post("/auth/sessions/revoke", { id: revokedId });

      // A session that expires.
      const expiring = await fresh();
      const expiringSocket = await connect(expiring);
      await t.sql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = ${sha256(expiring.cookie!)}`;

      // The other session of someone who changes their password.
      const { client: changer } = await t.addMember(owner, "slow-changer@example.com");
      const other = await signIn(t, "slow-changer@example.com", "member-password");
      const otherSocket = await connect(other);
      await changer.post("/auth/change-password", { currentPassword: "member-password", newPassword: "next-password" });
      const changerSocket = await connect(changer);

      // An expired reset link next to a live one, and an expired session next to live ones.
      await t.client().post("/auth/forgot-password", { email: "slow-changer@example.com" });
      const liveToken = resetToken((await waitForMailsTo(t, "slow-changer@example.com", 3))[2]!);
      await t.sql`INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES (${user.id}, 'password-reset', 'expired-link', now() - interval '1 minute')`;
      await t.sql`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (${user.id}, 'expired-session', now() - interval '1 minute')`;

      // None of this closed anything at once.
      for (const socket of [signedOut, revokedSocket, expiringSocket, otherSocket]) {
        socket.send({ t: "ping" });
        expect(await socket.nextOf("pong")).toEqual({ t: "pong" });
      }

      const ended = await Promise.all([signedOut, revokedSocket, expiringSocket, otherSocket].map((socket) => closedWithin(socket, 80_000)));
      expect(ended).toEqual(Array(4).fill({ code: 4001, reason: "signed out" }));

      await until(async () => (await rows(t.sql`SELECT 1 AS n FROM sessions WHERE token_hash = 'expired-session'`)).length === 0, 20_000, "the expired session to be deleted");
      await until(async () => (await rows(t.sql`SELECT 1 AS n FROM user_tokens WHERE token_hash = 'expired-link'`)).length === 0, 20_000, "the expired reset link to be deleted");
      expect(await rows(t.sql`SELECT 1 AS n FROM sessions WHERE token_hash = ${sha256(expiring.cookie!)}`)).toEqual([]);

      // What is live was left alone: sessions, their sockets and the reset link.
      for (const socket of [keeperSocket, changerSocket]) {
        socket.send({ t: "ping" });
        expect(await socket.nextOf("pong")).toEqual({ t: "pong" });
        await socket.close();
      }
      expect((await keeper.get("/me")).status).toBe(200);
      expect((await owner.get("/me")).status).toBe(200);
      expect(await rows(t.sql`SELECT 1 AS n FROM user_tokens WHERE token_hash = ${sha256(liveToken)}`)).toEqual([{ n: 1 }]);
      expect((await t.client().post("/auth/reset-password", { token: liveToken, password: "third-password" })).status).toBe(200);
    },
    120_000,
  );
});
