import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { connect, doc, startFakeSmtp, startServer, until, type Client, type Socket, type TestServer } from "./harness";
import { ISO, errorEntry } from "./harness/logs";
import {
  claimSleeping,
  createPage,
  editAfterBothLeave,
  hold,
  insertText,
  join,
  sameSessionOn,
  sendSteps,
  slowClaims,
  untilBlocked,
  untilLeading,
  untilStored,
} from "./harness/realtime";

/**
 * What can only be seen by waiting: the server's timers of a minute (ended
 * sessions' sockets, sessions kept for reconnecting editors, housekeeping),
 * the ten-second limits (a burst's save, a lease that cannot be renewed) and
 * the retries of refused mail.
 *
 * Every scenario is started in `beforeAll` and runs on its own clock in the
 * background; each test waits for its scenario and looks at what it saw. The
 * file takes about 100 seconds, whatever the number of scenarios.
 *
 * Three copies of the server share the database. `a` starts first and leads
 * realtime: all sockets are on it. `h2` and `h3` start 8 and 16 seconds later,
 * so their first housekeeping run comes 8 and 16 seconds after `a`'s, with a
 * different trash retention each time.
 */
describe.skipIf(process.env.API_TEST_SKIP_SLOW === "1")("with a minute's patience", () => {
  let a: TestServer;
  let h2: TestServer | null = null;
  let h3: TestServer | null = null;
  let owner: Client;
  let spaceId: string;
  /** When `a`'s timers started, in the test process's clock. */
  let startedAt: number;
  const sockets: Socket[] = [];
  const members: Record<string, { client: Client; user: any }> = {};

  const startTime = (server: TestServer) => new Date(server.logEntries().find((e) => e.msg === "server started")!.t).getTime();
  /** Sleeps until `ms` after `origin` (by default, after `a` started). */
  const at = (ms: number, origin = startedAt) => Bun.sleep(Math.max(0, origin + ms - Date.now()));
  const open = async (client: Client) => {
    const socket = await connect(client);
    sockets.push(socket);
    return socket;
  };
  const about = (pageId: string) => (m: Record<string, any>) => m.pageId === pageId && m.t !== "presence";
  /** Runs a scenario in the background; a failure surfaces in the test that waits for it. */
  const background = <T>(run: () => Promise<T>): Promise<T> => {
    const running = run();
    running.catch(() => undefined);
    return running;
  };
  const follower = (delayMs: number) =>
    background(async () => {
      await at(delayMs);
      // The copies share the uploaded files, as copies of a deployment do.
      return startServer({ keepDatabase: true, env: { STORAGE_PATH: a.storageDir, DATABASE_POOL_MAX: "2" } });
    });

  let burst: Promise<Awaited<ReturnType<typeof burstScenario>>>;
  let retried: Promise<Awaited<ReturnType<typeof retriedMailScenario>>>;
  let dropped: Promise<Awaited<ReturnType<typeof droppedMailScenario>>>;
  let ended: Promise<Awaited<ReturnType<typeof endedSessionsScenario>>>;
  let idle: Promise<Awaited<ReturnType<typeof idleScenario>>>;
  let housekeeping: Promise<Awaited<ReturnType<typeof housekeepingScenario>>>;
  let hang: Promise<Awaited<ReturnType<typeof hangScenario>>>;
  let silent: Promise<Awaited<ReturnType<typeof silentMailScenario>>>;

  /** A copy of the server whose mail server takes connections and never says a word. It is gone again well before the minute is over. */
  const silentMailScenario = async () => {
    let connections = 0;
    const mute = net.createServer((socket) => {
      connections++;
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => mute.listen(0, "127.0.0.1", resolve));
    const unused = await startFakeSmtp();
    const t = await startServer({ keepDatabase: true, smtp: { ...unused, port: (mute.address() as net.AddressInfo).port }, env: { DATABASE_POOL_MAX: "2" } });
    try {
      const asked = Date.now();
      expect((await sameSessionOn(t, owner).post("/invitations", { emails: ["silent@example.com"], role: "member" })).status).toBe(200);
      const failed = await until(() => t.logEntries().find((e) => e.msg === "mail delivery failed"), 40_000, "the delivery to be given up");
      return { failed, after: new Date(failed.t).getTime() - asked, connections };
    } finally {
      await t.close();
      mute.close();
      await unused.stop();
    }
  };

  /** An editor types a character every half second for 13 seconds. */
  const burstScenario = async () => {
    const page = await createPage(owner, spaceId, doc(""));
    const socket = await open(owner);
    await join(socket, page.id, 0);
    const first = new Date((await a.sql`SELECT clock_timestamp() AS now`)[0].now).getTime();
    for (let version = 0; version < 26; version++) {
      await sendSteps(socket, page.id, version, [insertText(1, "x")]);
      await Bun.sleep(500);
    }
    const last = await untilStored(a, page.id, 26, 8000);
    const snapshots = await a.sql`SELECT content, created_at FROM page_versions WHERE page_id = ${page.id} ORDER BY created_at`;
    return { first, last, snapshots };
  };

  /** `h2`'s mail server refuses one message. */
  const retriedMailScenario = async (server: Promise<TestServer>) => {
    const t = await server;
    t.smtp.failNext(1);
    expect((await sameSessionOn(t, owner).post("/invitations", { emails: ["retried@example.com"], role: "member" })).status).toBe(200);
    const failed = await until(() => t.logEntries().find((e) => e.msg === "mail delivery failed"), 5000);
    const [mail] = await t.smtp.waitFor(1, 25_000);
    const deliveredAfter = Date.now() - new Date(failed.t).getTime();
    await t.smtp.settle(500);
    return { failed, mail: mail!, deliveredAfter, sessions: t.smtp.sessions.length, failures: t.logEntries().filter((e) => e.msg === "mail delivery failed").length };
  };

  /** `a`'s mail server refuses a message three times. Nothing else is mailed from `a` after this starts. */
  const droppedMailScenario = async () => {
    a.smtp.clear();
    a.smtp.failNext(3);
    expect((await owner.post("/invitations", { emails: ["dropped@example.com"], role: "member" })).status).toBe(200);
    const failures = () => a.logEntries().filter((e) => e.msg === "mail delivery failed");
    await until(() => failures().length === 3, 60_000, "the third refusal");
    // Had the waits gone on growing (15, 30, 45 seconds), a fourth try would be due 45 seconds after the third.
    await Bun.sleep(Math.max(0, new Date(failures()[2]!.t).getTime() + 47_000 - Date.now()));
    return { failures: failures(), sessions: a.smtp.sessions.length, delivered: a.outbox.length };
  };

  /** Sessions end in every way that does not close their sockets at once; the sockets are on `a`. */
  const endedSessionsScenario = async (second: Promise<TestServer>, third: Promise<TestServer>) => {
    const closing = (socket: Socket) => socket.closed.then((closed) => ({ ...closed, after: Date.now() - startedAt }));
    const login = async (server: TestServer, email: string) => {
      const client = server.client();
      expect((await client.post("/auth/login", { email, password: "member-password" })).status).toBe(200);
      return client;
    };

    // Signing out.
    const signedOut = await open(members["signs-out"]!.client);
    const cookie = members["signs-out"]!.client.cookie!;
    expect((await members["signs-out"]!.client.post("/auth/logout")).status).toBe(200);
    signedOut.send({ t: "ping" });
    const answeredAfterSignOut = await signedOut.nextOf("pong").then(
      () => true,
      () => false,
    );
    const stale = a.client();
    stale.cookie = cookie;
    const upgradeAfterSignOut = (await stale.raw("GET", "/ws")).status;

    // Another session of the same person revokes this one.
    const revoked = await open(members.revoked!.client);
    const revoker = await login(a, "revoked@example.com");
    const listed = (await revoker.get("/auth/sessions")).body.data as { id: string; current: boolean }[];
    expect((await revoker.post("/auth/sessions/revoke", { id: listed.find((s) => !s.current)!.id })).status).toBe(200);
    const revokerSocket = await open(revoker);

    // The session runs out.
    const expired = await open(members.expires!.client);
    await a.sql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = ${members.expires!.user.id}`;

    // Someone who just keeps their session.
    const kept = await open(members.stays!.client);

    // On another copy of the server: an admin deactivates the person there.
    const deactivated = await open(members.deactivated!.client);
    expect((await sameSessionOn(await second, owner).post("/members/deactivate", { userId: members.deactivated!.user.id })).status).toBe(200);

    // On another copy: the person changes their password in a second session, which signs the first one out.
    const passwordChanged = await open(members["changes-password"]!.client);
    const changer = await login(await third, "changes-password@example.com");
    expect((await changer.post("/auth/change-password", { currentPassword: "member-password", newPassword: "another-password" })).status).toBe(200);
    const changerSocket = await open(sameSessionOn(a, changer));

    const closed = await Promise.all([signedOut, revoked, expired, deactivated, passwordChanged].map(closing));
    await at(63_000);
    const stillOpen: boolean[] = [];
    for (const socket of [kept, revokerSocket, changerSocket]) {
      socket.send({ t: "ping" });
      stillOpen.push(
        await socket.nextOf("pong").then(
          () => true,
          () => false,
        ),
      );
    }
    return { answeredAfterSignOut, upgradeAfterSignOut, closed, stillOpen };
  };

  /** Three pages are edited and left by everyone, a minute before they are looked at again. */
  const idleScenario = async () => {
    const gone = await editAfterBothLeave(a, owner, spaceId);
    const back = await editAfterBothLeave(a, owner, spaceId);
    const importing = await editAfterBothLeave(a, owner, spaceId);

    // An editor comes back to the second page at once, and stays.
    const returned = await open(owner);
    returned.send({ t: "join", pageId: back.id, version: 0, clientId: "b" });
    const caughtUp = [await returned.next(about(back.id)), await returned.next(about(back.id))];

    // Four seconds before the third page's minute is over its content is replaced, and the save is held up.
    await at(56_000, importing.leftAt);
    const unlock = await hold(a.sql, `SELECT id FROM pages WHERE id = '${importing.id}' FOR UPDATE`);
    try {
      const replacing = owner.post(`/pages/${importing.id}/content`, { content: doc("imported") });
      await untilBlocked(a.sql);
      await at(62_000, importing.leftAt);

      // The first page: its minute is over.
      const late = await open(owner);
      const lateJoin = await join(late, gone.id, 0, "b");

      // The second page: the editor who came back types on.
      const typedOn = await sendSteps(returned, back.id, 1, [insertText(7, "!")], "b");

      // The third page: an editor joins while the replacement is still being saved.
      const joiner = await open(owner);
      joiner.send({ t: "join", pageId: importing.id, version: 1, clientId: "e" });
      const duringImport = [await joiner.next(about(importing.id)), await joiner.next(about(importing.id))];
      await unlock();
      const replaced = await replacing;
      const afterImport = await sendSteps(joiner, importing.id, 2, [insertText(9, "!")], "e");
      return { gone, back, importing, caughtUp, lateJoin, typedOn, duringImport, replacedStatus: replaced.status, afterImport };
    } finally {
      await unlock();
    }
  };

  /** Trash, sessions and tokens of every age wait for the housekeeping of the three copies. */
  const housekeepingScenario = async (second: Promise<TestServer>, third: Promise<TestServer>) => {
    const fileOf = async (pageId: string) => {
      const [row] = await a.sql`SELECT storage_key FROM files WHERE page_id = ${pageId}`;
      return row ? path.join(a.storageDir, row.storage_key as string) : null;
    };
    /** A page trashed `age` ago, with an uploaded file and a child page. */
    const trashed = async (label: string, age: string) => {
      const page = await createPage(owner, spaceId, doc(label), { title: label });
      const child = await createPage(owner, spaceId, doc(`${label} child`), { parentId: page.id });
      expect((await owner.uploadFile(new File([`${label} file`], `${label}.txt`), page.id)).status).toBe(200);
      const file = (await fileOf(page.id))!;
      expect((await owner.post(`/pages/${page.id}/delete`)).status).toBe(200);
      await a.sql`UPDATE pages SET deleted_at = now() - ${age}::interval WHERE id IN (${page.id}, ${child.id})`;
      return { label, id: page.id, childId: child.id, file };
    };
    type Trashed = Awaited<ReturnType<typeof trashed>>;
    /** Which of the trashed pages are left, with their child and their file. */
    const left = async (pages: Trashed[]) => {
      const result: Record<string, string> = {};
      for (const page of pages) {
        const rows = await a.sql`SELECT id FROM pages WHERE id IN (${page.id}, ${page.childId})`;
        const files = await a.sql`SELECT id FROM files WHERE page_id = ${page.id}`;
        result[page.label] = rows.length === 2 && files.length === 1 && existsSync(page.file) ? "kept" : rows.length === 0 && files.length === 0 && !existsSync(page.file) ? "gone" : "partly gone";
      }
      return result;
    };
    const purgeLog = (server: TestServer) => until(() => server.logEntries().find((e) => e.msg === "trash purged"), 15_000, "the trash to be purged");

    // Before the first run: the workspace has no retention setting, which means 30 days.
    const pages = [
      await trashed("thirty days and a minute", "30 days 1 minute"),
      await trashed("just under thirty days", "29 days 23 hours 50 minutes"),
      await trashed("seven days and a minute", "7 days 1 minute"),
      await trashed("just under seven days", "6 days 23 hours 50 minutes"),
    ];
    const live = await createPage(owner, spaceId, doc("not in the trash"));
    await a.sql`UPDATE pages SET created_at = now() - interval '1 year', updated_at = now() - interval '1 year' WHERE id = ${live.id}`;
    // A password-reset token that has run out, and one that has not.
    await a.sql`UPDATE user_tokens SET expires_at = now() - interval '1 second' WHERE user_id = ${members["expired-token"]!.user.id}`;
    const tokens = async () => (await a.sql`SELECT u.email FROM user_tokens t JOIN users u ON u.id = t.user_id ORDER BY u.email`).map((r: { email: string }) => r.email);
    const tokensBefore = await tokens();
    const expiredSessions = async () => (await a.sql`SELECT count(*)::int AS n FROM sessions WHERE expires_at < now()`)[0].n as number;
    const liveSessions = async () => (await a.sql`SELECT count(*)::int AS n FROM sessions WHERE expires_at >= now()`)[0].n as number;

    // The first copy's run, a minute after it started.
    await at(58_000);
    const before = { pages: await left(pages), expiredSessions: await expiredSessions(), liveSessions: await liveSessions() };
    const firstLog = await purgeLog(a);
    await until(async () => (await expiredSessions()) === 0, 5000, "expired sessions to be deleted");
    const first = {
      ranAfter: new Date(firstLog.t).getTime() - startTime(a),
      log: firstLog,
      pages: await left(pages),
      liveKept: (await a.sql`SELECT count(*)::int AS n FROM pages WHERE id = ${live.id}`)[0].n === 1,
      tokensBefore,
      tokens: await tokens(),
      liveSessions: await liveSessions(),
    };

    // For the second copy's run, eight seconds later, an admin has set the retention to 7 days.
    expect((await owner.post("/workspace/update", { settings: { trashRetentionDays: 7 } })).status).toBe(200);
    const secondLog = await purgeLog(await second);
    const secondRun = { ranAfter: new Date(secondLog.t).getTime() - startTime(await second), log: secondLog, pages: await left(pages) };

    // For the third copy's run the stored setting is not a whole number of days: it counts as unset.
    await a.sql`UPDATE workspace SET settings = jsonb_set(settings, '{trashRetentionDays}', '2.5')`;
    const more = [await trashed("twenty days", "20 days"), await trashed("forty days", "40 days")];
    const thirdLog = await purgeLog(await third);
    const thirdRun = { log: thirdLog, pages: await left([...pages, ...more]) };
    return { before, first, second: secondRun, third: thirdRun };
  };

  /** Once the other copies are gone, every renewal of `a`'s lease is made to take 14 seconds. */
  const hangScenario = async () => {
    await housekeeping.catch(() => undefined);
    await Promise.all([retried.catch(() => undefined), ended.catch(() => undefined), idle.catch(() => undefined)]);
    await Promise.all([h2?.stop(), h3?.stop()]);
    const page = await createPage(owner, spaceId, doc("hello"));
    const editor = await open(owner);
    const lostBefore = a.logEntries().filter((e) => e.msg === "no longer leading realtime").length;
    const restore = await slowClaims(a.sql, 14);
    const began = Date.now();
    try {
      // The editor sends nothing.
      const closed = await Promise.race([editor.closed, Bun.sleep(13_000).then(() => "still open" as const)]);
      const closedAfter = Date.now() - began;
      const renewalStillRunning = await claimSleeping(a.sql);
      const refused = await owner.post(`/pages/${page.id}/content`, { content: doc("x") });
      await restore();
      const leadsAgainAfter = await untilLeading(owner, 15_000);
      return {
        closed,
        closedAfter,
        renewalStillRunning,
        refusedStatus: refused.status,
        lost: a.logEntries().filter((e) => e.msg === "no longer leading realtime").length - lostBefore,
        leadsAgainAfter,
      };
    } finally {
      await restore();
    }
  };

  beforeAll(async () => {
    a = await startServer();
    startedAt = startTime(a);
    const setup = await a.setupOwner();
    owner = setup.owner;
    spaceId = setup.spaceId;
    const names = ["signs-out", "revoked", "expires", "stays", "deactivated", "changes-password", "expired-token", "valid-token"];
    for (const name of names) members[name] = await a.addMember(owner, `${name}@example.com`);
    for (const name of ["expired-token", "valid-token"]) {
      expect((await a.client().post("/auth/forgot-password", { email: `${name}@example.com` })).status).toBe(200);
    }
    // Two mails per member (the invitation and its acceptance) and the two reset links: all out before mail is refused.
    await a.smtp.waitFor(names.length * 2 + 2);

    const second = follower(8000);
    const third = follower(16_000);
    void second.then((server) => (h2 = server));
    void third.then((server) => (h3 = server));
    dropped = background(droppedMailScenario);
    burst = background(burstScenario);
    idle = background(idleScenario);
    housekeeping = background(() => housekeepingScenario(second, third));
    ended = background(() => endedSessionsScenario(second, third));
    retried = background(() => retriedMailScenario(second));
    hang = background(hangScenario);
    silent = background(silentMailScenario);
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets) socket.ws.close();
    await Promise.all([a?.close(), h2?.close(), h3?.close()]);
  });

  test("steps that keep coming are saved ten seconds after the first of them", async () => {
    const { first, last, snapshots } = await burst;
    // The first save of the page made its only snapshot.
    expect(snapshots).toHaveLength(1);
    const savedAfter = new Date(snapshots[0].created_at).getTime() - first;
    expect(savedAfter).toBeGreaterThanOrEqual(9950);
    expect(savedAfter).toBeLessThan(12_500);
    // It holds what had been typed by then, at two characters a second.
    const typed = snapshots[0].content.content[0].content[0].text as string;
    expect(typed).toMatch(/^x{15,22}$/);
    // The rest was saved two seconds after the last step.
    expect(last.content).toEqual(doc("x".repeat(26)));
    expect(new Date(last.updated_at).getTime() - new Date(snapshots[0].created_at).getTime()).toBeGreaterThan(2000);
  }, 120_000);

  test("a mail server that does not answer is given 30 seconds", async () => {
    const { failed, after, connections } = await silent;
    expect(errorEntry(failed)).toEqual({ t: expect.stringMatching(ISO), level: "error", msg: "mail delivery failed", subject: "Owner invited you to Acme", attempt: 1 });
    expect(after).toBeGreaterThanOrEqual(29_900);
    expect(after).toBeLessThan(34_000);
    expect(connections).toBe(1);
  }, 120_000);

  test("mail that is refused once is sent again 15 seconds later", async () => {
    const { failed, mail, deliveredAfter, sessions, failures } = await retried;
    expect(errorEntry(failed)).toEqual({ t: expect.stringMatching(ISO), level: "error", msg: "mail delivery failed", subject: "Owner invited you to Acme", attempt: 1 });
    expect(mail).toMatchObject({ to: "retried@example.com", subject: "Owner invited you to Acme" });
    expect(deliveredAfter).toBeGreaterThanOrEqual(14_900);
    expect(deliveredAfter).toBeLessThan(19_000);
    expect(sessions).toBe(2);
    expect(failures).toBe(1);
  }, 120_000);

  test("a socket whose session ended without the server closing it at once is closed with 4001 within a minute", async () => {
    const { answeredAfterSignOut, upgradeAfterSignOut, closed, stillOpen } = await ended;
    // Accident: docs/api.md says a socket is closed at once when its session is signed out on the leader.
    // It is not: it goes on answering until the leader's next check of its sockets' sessions.
    expect(answeredAfterSignOut).toBe(true);
    // A new socket cannot be opened with the session, though.
    expect(upgradeAfterSignOut).toBe(401);
    // Signed out, revoked from another session, expired, deactivated on another copy, signed out by a password change on another copy.
    expect(closed.map(({ code, reason }) => ({ code, reason }))).toEqual(Array.from({ length: 5 }, () => ({ code: 4001, reason: "signed out" })));
    // All by the same check, a minute after the leader started.
    for (const { after } of closed) {
      expect(after).toBeGreaterThan(59_000);
      expect(after).toBeLessThan(62_500);
    }
    // Sessions that did not end keep their sockets: someone uninvolved, the session that revoked, the session that changed the password.
    expect(stillOpen).toEqual([true, true, true]);
  }, 120_000);

  test("a page nobody has open is let go of after a minute: who comes back later gets the whole document", async () => {
    const { gone, lateJoin } = await idle;
    expect(lateJoin).toEqual({ t: "joined", pageId: gone.id, version: 1, doc: doc("hello!"), readOnly: false });
  }, 120_000);

  test("a page an editor came back to within the minute is kept for as long as they stay", async () => {
    const { back, caughtUp, typedOn } = await idle;
    expect(caughtUp).toEqual([
      { t: "joined", pageId: back.id, version: 0, readOnly: false },
      { t: "steps", pageId: back.id, version: 1, steps: [insertText(6, "!")], clientIds: ["a"] },
    ]);
    expect(typedOn).toEqual({ t: "steps", pageId: back.id, version: 2, steps: [insertText(7, "!")], clientIds: ["b"] });
  }, 120_000);

  test("a page whose content is being replaced when its minute runs out is kept for the editor who joins meanwhile", async () => {
    const { importing, duringImport, replacedStatus, afterImport } = await idle;
    // The editor is behind by the replacement, which is not stored yet, and receives it as a step.
    expect(duringImport).toEqual([
      { t: "joined", pageId: importing.id, version: 1, readOnly: false },
      { t: "steps", pageId: importing.id, version: 2, steps: [{ stepType: "replace", from: 0, to: 8, slice: [{ o: "paragraph" }, { t: "imported" }, { c: 1 }] }], clientIds: ["server"] },
    ]);
    expect(replacedStatus).toBe(200);
    expect(afterImport).toEqual({ t: "steps", pageId: importing.id, version: 3, steps: [insertText(9, "!")], clientIds: ["e"] });
  }, 120_000);

  test("a minute after it starts, a server deletes trash older than 30 days with its files, and sessions and tokens that have run out", async () => {
    const { before, first } = await housekeeping;
    expect(before.pages).toEqual({
      "thirty days and a minute": "kept",
      "just under thirty days": "kept",
      "seven days and a minute": "kept",
      "just under seven days": "kept",
    });
    expect(first.pages).toEqual({
      "thirty days and a minute": "gone",
      "just under thirty days": "kept",
      "seven days and a minute": "kept",
      "just under seven days": "kept",
    });
    // The page and its child.
    expect(first.log).toEqual({ t: expect.stringMatching(ISO), level: "info", msg: "trash purged", pages: 2 });
    expect(first.ranAfter).toBeGreaterThan(59_500);
    expect(first.ranAfter).toBeLessThan(62_500);
    expect(first.liveKept).toBe(true);

    expect(before.expiredSessions).toBeGreaterThanOrEqual(1);
    expect(first.liveSessions).toBe(before.liveSessions);
    expect(first.tokensBefore).toEqual(["expired-token@example.com", "valid-token@example.com"]);
    expect(first.tokens).toEqual(["valid-token@example.com"]);
  }, 120_000);

  test("the workspace's trashRetentionDays is read at every run", async () => {
    const { second } = await housekeeping;
    expect(second.pages).toEqual({
      "thirty days and a minute": "gone",
      "just under thirty days": "gone",
      "seven days and a minute": "gone",
      "just under seven days": "kept",
    });
    expect(second.log).toEqual({ t: expect.stringMatching(ISO), level: "info", msg: "trash purged", pages: 4 });
    expect(second.ranAfter).toBeGreaterThan(59_500);
    expect(second.ranAfter).toBeLessThan(62_500);
  }, 120_000);

  test("a stored retention that is not a whole number of days counts as 30 days", async () => {
    const { third } = await housekeeping;
    expect(third.pages).toEqual({
      "thirty days and a minute": "gone",
      "just under thirty days": "gone",
      "seven days and a minute": "gone",
      "just under seven days": "kept",
      "twenty days": "kept",
      "forty days": "gone",
    });
    expect(third.log).toEqual({ t: expect.stringMatching(ISO), level: "info", msg: "trash purged", pages: 2 });
  }, 120_000);

  test("a leader whose renewals hang closes its sockets with 1013 when its lease runs out, and leads again afterwards", async () => {
    const { closed, closedAfter, renewalStillRunning, refusedStatus, lost, leadsAgainAfter } = await hang;
    expect(closed).toEqual({ code: 1013, reason: "not the realtime leader" });
    // The lease ran ten seconds from the last renewal that went through, at most three seconds before.
    expect(closedAfter).toBeGreaterThan(6500);
    expect(closedAfter).toBeLessThan(11_500);
    // It did not wait for the renewal to come back and say so.
    expect(renewalStillRunning).toBe(true);
    // From then on it does not replace page content either.
    expect(refusedStatus).toBe(503);
    expect(lost).toBe(1);
    expect(leadsAgainAfter).toBeLessThan(12_000);
  }, 150_000);

  test("mail that is refused three times, 15 and then 30 seconds apart, is given up", async () => {
    const { failures, sessions, delivered } = await dropped;
    expect(failures.map(errorEntry)).toEqual(
      [1, 2, 3].map((attempt) => ({ t: expect.stringMatching(ISO), level: "error", msg: "mail delivery failed", subject: "Owner invited you to Acme", attempt })),
    );
    const times = failures.map((entry) => new Date(entry.t).getTime());
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(14_900);
    expect(times[1]! - times[0]!).toBeLessThan(18_000);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(29_900);
    expect(times[2]! - times[1]!).toBeLessThan(33_000);
    // No fourth try, and nothing was delivered.
    expect(sessions).toBe(3);
    expect(delivered).toBe(0);
  }, 150_000);
});
