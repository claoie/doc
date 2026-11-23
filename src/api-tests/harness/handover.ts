import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, doc, startServer, until, type Client, type Target, type TestServer } from "./index";
import { ISO, errorEntry } from "./logs";
import {
  claimSleeping,
  createPage,
  hold,
  insertText,
  join,
  leads,
  leaseRows,
  sameSessionOn,
  sendSteps,
  slowClaims,
  storedPage,
  untilBlocked,
  untilLeading,
  type PageRef,
} from "./realtime";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_LEADER = { error: { code: "not_leader", message: "Another copy of the server runs realtime; try again" } };

/**
 * Two copies of the server on one database, as during a rolling deploy. One of
 * them leads realtime: it holds a lease (the single row of `realtime_leader`),
 * and only it keeps sockets open and replaces page content. The tests run in
 * order and hand the lead from copy to copy, three copies in all.
 *
 * `targets` says which server each copy is, so the same scenario runs for
 * copies of one server and for a Bun and a Rust copy side by side, as when
 * one replaces the other.
 */
export const describeHandover = (name: string, targets: [Target, Target, Target]) =>
  describe(name, () => {
    let first: TestServer;
    let second: TestServer;
    let third: TestServer | null = null;
    let owner: Client;
    let onSecond: Client;
    let spaceId: string;
    let page: PageRef;

    const msgs = (server: TestServer) => server.logEntries().map((e) => e.msg);

    beforeAll(async () => {
      first = await startServer({ target: targets[0] });
      ({ owner, spaceId } = await first.setupOwner());
      page = await createPage(owner, spaceId, doc("hello"));
      second = await startServer({ keepDatabase: true, target: targets[1] });
      onSecond = sameSessionOn(second, owner);
    });

    afterAll(async () => {
      await Promise.all([first.close(), second.close(), third?.close()]);
    });

    test("the copy that started first holds the lease, and renews it", async () => {
      const [lease, ...others] = await leaseRows(first.sql);
      expect(others).toEqual([]);
      expect(lease).toEqual({ id: 1, holder: expect.stringMatching(UUID), expires_at: expect.any(Date), remaining_ms: expect.any(Number) });
      // A lease runs ten seconds from when it was last renewed, every three seconds.
      expect(lease!.remaining_ms).toBeGreaterThan(6000);
      expect(lease!.remaining_ms).toBeLessThanOrEqual(10_000);
      expect(msgs(first)).toContain("leading realtime");
      expect(msgs(second)).not.toContain("leading realtime");
      expect(msgs(second)).toContain("server started");

      const renewed = await until(async () => {
        const [now] = await leaseRows(first.sql);
        return now && now.expires_at.getTime() > lease!.expires_at.getTime() ? now : null;
      }, 6000);
      expect(renewed.holder).toBe(lease!.holder);
      expect(renewed.expires_at.getTime() - lease!.expires_at.getTime()).toBeLessThan(4500);
      expect(renewed.remaining_ms).toBeGreaterThan(9000);
    }, 15_000);

    test("a renewal that fails is logged and tried again; the leader goes on leading while its lease runs", async () => {
      const editor = await connect(owner);
      const failures = () => first.logEntries().filter((e) => e.msg === "claiming the realtime lease failed");
      await first.sql.unsafe(`CREATE FUNCTION refuse_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no lease today'; END $$`);
      await first.sql.unsafe(`CREATE TRIGGER refuse_claim BEFORE INSERT OR UPDATE ON realtime_leader FOR EACH ROW EXECUTE FUNCTION refuse_claim()`);
      try {
        await until(() => failures().length >= 1, 6000, "a renewal to fail");
      } finally {
        await first.sql.unsafe(`DROP TRIGGER refuse_claim ON realtime_leader`);
        await first.sql.unsafe(`DROP FUNCTION refuse_claim`);
      }
      expect(failures()[0]!.error).toContain("no lease today");
      expect(errorEntry(failures()[0])).toEqual({ t: expect.stringMatching(ISO), level: "error", msg: "claiming the realtime lease failed" });
      // Its lease had seven seconds or more left: nothing changed for its sockets.
      editor.send({ t: "ping" });
      expect(await editor.nextOf("pong")).toEqual({ t: "pong" });
      expect(msgs(first)).not.toContain("no longer leading realtime");
      expect(msgs(second)).not.toContain("leading realtime");
      await editor.close();
    }, 15_000);

    test("the other copy closes sockets with 1013 as soon as they open", async () => {
      expect(await leads(owner)).toBe(true);
      const socket = await connect(onSecond);
      socket.send({ t: "ping" });
      socket.send({ t: "join", pageId: page.id, version: 0 });
      expect(await socket.closed).toEqual({ code: 1013, reason: "not the realtime leader" });
      expect(socket.inbox).toEqual([]);
      // Without a session it is refused as on any copy.
      await expect(connect(second.client())).rejects.toThrow();
    });

    test("the other copy serves the rest of the API, but does not replace page content", async () => {
      const read = await onSecond.get(`/pages/${page.slugId}`);
      expect(read.status).toBe(200);
      expect(read.body.data.page.content).toEqual(doc("hello"));
      const created = await onSecond.post("/pages", { spaceId, title: "Made on the other copy", content: doc("there") });
      expect(created.status).toBe(200);
      expect((await owner.get(`/pages/${created.body.data.page.id}`)).body.data.page.content).toEqual(doc("there"));

      const refused = await onSecond.post(`/pages/${page.id}/content`, { content: doc("imported") });
      expect(refused.status).toBe(503);
      expect(refused.body).toEqual(NOT_LEADER as never);
      expect(refused.headers.get("cache-control")).toBe("no-store");
      // The request is checked as on the leader before that.
      expect((await second.client().post(`/pages/${page.id}/content`, { content: doc("x") })).status).toBe(401);
      expect((await onSecond.post("/pages/00000000-0000-4000-8000-000000000000/content", { content: doc("x") })).status).toBe(404);
      const invalid = await onSecond.post(`/pages/${page.id}/content`, { content: { type: "paragraph" } });
      expect(invalid.status).toBe(400);
      expect(invalid.body).toEqual({ error: { code: "invalid_input", message: "content must be a doc node" } } as never);
      expect(await storedPage(first.sql, page.id)).toMatchObject({ doc_version: 0, content: doc("hello") });

      const taken = await owner.post(`/pages/${page.id}/content`, { content: doc("imported") });
      expect(taken.status).toBe(200);
      expect(taken.body.data.page.docVersion).toBe(1);
    });

    test("a leader told to stop saves what it holds, gives up the lease, and the other copy takes over within about a second", async () => {
      const [before] = await leaseRows(first.sql);
      const editor = await connect(owner);
      await join(editor, page.id, 1, "a");
      expect((await sendSteps(editor, page.id, 1, [insertText(9, "!")])).version).toBe(2);

      // The page's row is held, so the leader's last save has to wait. Until it is through, the lease is not given up.
      const unlock = await hold(first.sql, `SELECT id FROM pages WHERE id = '${page.id}' FOR UPDATE`);
      let exitCode: number;
      try {
        const stopping = first.stop("SIGTERM");
        expect(await editor.closed).toEqual({ code: 1001, reason: "server shutting down" });
        await untilBlocked(first.sql);
        // The stopping copy takes no new sockets, and the other does not lead yet.
        expect(await leads(owner)).toBe(false);
        expect(await leads(onSecond)).toBe(false);
        expect((await leaseRows(first.sql)).map((row) => row.holder)).toEqual([before!.holder]);
        expect((await storedPage(first.sql, page.id))!.doc_version).toBe(1);
        await unlock();
        exitCode = await stopping;
      } finally {
        await unlock();
      }
      expect(exitCode).toBe(0);
      expect(await storedPage(first.sql, page.id)).toMatchObject({ doc_version: 2, content: doc("imported!") });

      expect(await untilLeading(onSecond, 4000)).toBeLessThan(3000);
      const [after, ...others] = await leaseRows(second.sql);
      expect(others).toEqual([]);
      expect(after!.holder).toMatch(UUID);
      expect(after!.holder).not.toBe(before!.holder);
      expect(msgs(second)).toContain("leading realtime");
      expect(first.logEntries().find((e) => e.msg === "shutting down")).toMatchObject({ level: "info", signal: "SIGTERM" });

      // The new leader loads the page as it was saved: the editor is current.
      const again = await connect(onSecond);
      expect(await join(again, page.id, 2, "a")).toEqual({ t: "joined", pageId: page.id, version: 2, readOnly: false });
      expect((await sendSteps(again, page.id, 2, [insertText(10, "?")])).version).toBe(3);
      await again.close();
      const replaced = await onSecond.post(`/pages/${page.id}/content`, { content: doc("on the second copy") });
      expect(replaced.status).toBe(200);
      expect(replaced.body.data.page.docVersion).toBe(4);
    }, 20_000);

    test("a leader whose lease is taken closes its sockets with 1013, and leads again once the lease is free", async () => {
      const editor = await connect(onSecond);
      await join(editor, page.id, 4);
      await second.sql`UPDATE realtime_leader SET holder = 'someone else', expires_at = now() + interval '1 hour'`;
      // The editor sends nothing: it is turned away at the next renewal, not at its next message.
      const closed = await Promise.race([editor.closed, Bun.sleep(6000).then(() => "still open")]);
      expect(closed).toEqual({ code: 1013, reason: "not the realtime leader" });
      expect(await leads(onSecond)).toBe(false);
      const refused = await onSecond.post(`/pages/${page.id}/content`, { content: doc("x") });
      expect(refused.status).toBe(503);
      expect(refused.body).toEqual(NOT_LEADER as never);
      expect(second.logEntries().filter((e) => e.msg === "no longer leading realtime")).toEqual([
        { t: expect.any(String), level: "info", msg: "no longer leading realtime" },
      ]);
      // The row is left alone while someone else holds it.
      expect((await leaseRows(second.sql)).map((row) => row.holder)).toEqual(["someone else"]);

      await second.sql`DELETE FROM realtime_leader`;
      expect(await untilLeading(onSecond, 4000)).toBeLessThan(3000);
      expect(msgs(second).filter((m) => m === "leading realtime")).toHaveLength(2);
    }, 20_000);

    test("when a leader dies without stopping, the other copy takes over once its lease has run out", async () => {
      third = await startServer({ keepDatabase: true, target: targets[2] });
      const onThird = sameSessionOn(third, owner);
      expect(await leads(onThird)).toBe(false);
      const [lease] = await leaseRows(second.sql);
      await second.stop("SIGKILL");
      // Nobody gave the lease up: it runs for what is left of its ten seconds.
      expect((await leaseRows(third.sql)).map((row) => row.holder)).toEqual([lease!.holder]);
      expect(await leads(onThird)).toBe(false);
      const took = await untilLeading(onThird, 14_000);
      expect(took).toBeGreaterThan(4000);
      expect(took).toBeLessThan(12_500);
      const [after] = await leaseRows(third.sql);
      expect(after!.holder).not.toBe(lease!.holder);
      // It took the lease when the old one had expired, not before.
      expect(after!.expires_at.getTime() - lease!.expires_at.getTime()).toBeGreaterThan(9000);
      expect(await storedPage(third.sql, page.id)).toMatchObject({ doc_version: 4, content: doc("on the second copy") });
    }, 30_000);

    test("a renewal still running when the leader stops does not bring the lease back", async () => {
      const restore = await slowClaims(third!.sql, 1);
      try {
        await until(() => claimSleeping(third!.sql), 6000, "a renewal to start");
        expect(await third!.stop("SIGTERM")).toBe(0);
        await until(async () => !(await claimSleeping(third!.sql)), 5000, "the renewal to end");
        expect(await leaseRows(third!.sql)).toEqual([]);
      } finally {
        await restore();
      }
    }, 20_000);
  });
