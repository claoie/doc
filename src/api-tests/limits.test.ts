import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, doc, startServer, until, type Client, type TestServer } from "./harness";
import { createPage, join } from "./harness/realtime";

/**
 * What the server holds to when a client does not behave like the app: a step
 * that nests without end, an upload that never says how long it is, a
 * connection that closes before the answer.
 */

let t: TestServer;
let owner: Client;
let spaceId: string;

beforeAll(async () => {
  t = await startServer();
  ({ owner, spaceId } = await t.setupOwner());
});

afterAll(async () => {
  await t.close();
});

describe("a step whose slice opens nodes inside each other", () => {
  /** A slice that opens `depth` blockquotes inside each other around one empty paragraph. */
  const nested = (depth: number) => {
    const slice: unknown[] = [];
    for (let i = 0; i < depth; i++) slice.push({ o: "blockquote" });
    slice.push({ o: "paragraph" });
    for (let i = 0; i <= depth; i++) slice.push({ c: 1 });
    return [{ stepType: "replace", from: 0, to: 0, slice }];
  };

  test("is taken while the document stays within a hundred levels", async () => {
    const page = await createPage(owner, spaceId, doc("hello"));
    const editor = await connect(owner);
    await join(editor, page.id, 0, "a");
    editor.send({ t: "steps", pageId: page.id, version: 0, clientId: "a", steps: nested(99) });
    expect(await editor.nextOf("steps", { pageId: page.id })).toMatchObject({ version: 1, clientIds: ["a"] });
    await editor.close();
  });

  test("is refused when it is tens of thousands deep, and the server goes on", async () => {
    const page = await createPage(owner, spaceId, doc("hello"));
    const editor = await connect(owner);
    const other = await connect(owner);
    await join(editor, page.id, 0, "a");
    await join(other, page.id, 0, "b");
    // About 1.9 MB: under the size limit of a message, and flat as JSON.
    editor.send({ t: "steps", pageId: page.id, version: 0, clientId: "a", steps: nested(70_000) });
    expect(await editor.nextOf("error", { pageId: page.id }, 30_000)).toEqual({
      t: "error",
      pageId: page.id,
      message: "A change could not be applied; the page was reloaded.",
    });
    expect(await editor.nextOf("joined", { pageId: page.id })).toMatchObject({ version: 0, doc: doc("hello") });
    // Nobody else was sent anything, the page is as it was, and the server answers.
    expect(await other.quiet((m) => m.t === "steps", 200)).toBe(true);
    editor.send({ t: "ping" });
    expect(await editor.nextOf("pong")).toEqual({ t: "pong" });
    expect((await owner.get(`/pages/${page.id}`)).body.data.page.content).toEqual(doc("hello"));
    expect((await owner.get("/health")).status).toBe(200);
    await editor.close();
    await other.close();
  }, 60_000);
});

describe("an upload that does not say how long it is", () => {
  test("is refused with 413 once it has passed the limit, not read to its end", async () => {
    const boundary = "----limits";
    const encoder = new TextEncoder();
    const image = new Uint8Array(12 * 1024 * 1024);
    image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const parts = [
      encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      image,
      encoder.encode(`\r\n--${boundary}--\r\n`),
    ];
    // A stream as the body is sent in chunks, without a Content-Length.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = parts.shift();
        if (!next) return controller.close();
        for (let at = 0; at < next.length; at += 256 * 1024) controller.enqueue(next.subarray(at, at + 256 * 1024));
      },
    });
    const res = await owner.raw("POST", "/me/avatar", { body, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } });
    expect(res.status).toBe(413);
    // The two servers word it differently: one stops at the size of a form, the other reads on and weighs the image.
    expect((await res.json()).error.code).toBe("payload_too_large");
    expect((await owner.get("/me")).body.data.user.avatarUrl).toBeNull();
    expect((await owner.get("/health")).status).toBe(200);
  }, 30_000);
});

describe("a request whose client goes away before the answer", () => {
  test("is still carried out to its end: a member removed from a group stops hearing of its space", async () => {
    const { client: member, user } = await t.addMember(owner, "leaver@example.com");
    const space = (await owner.post("/spaces", { name: "Guarded", slug: "guarded" })).body.data.space.id as string;
    const group = (await owner.post("/groups", { name: "Guards" })).body.data.group.id as string;
    expect((await owner.post(`/spaces/${space}/members/add`, { role: "reader", groupIds: [group] })).status).toBe(200);
    expect((await owner.post(`/groups/${group}/members/add`, { userIds: [user.id] })).status).toBe(200);
    const socket = await connect(member);
    let pages = 0;
    /** Whether the member's open socket hears about a page created in the space now. */
    const hears = async () => {
      await owner.post("/pages", { spaceId: space, title: `Page ${++pages}` });
      return !(await socket.quiet((m) => m.t === "event" && m.kind === "tree" && m.spaceId === space, 150));
    };
    await until(hears, 5000, "space events while in the group");

    // Leaving the group takes a second in the database; the administrator's connection closes meanwhile.
    await t.sql.unsafe(`CREATE FUNCTION slow_leave() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN OLD; END $$`);
    await t.sql.unsafe(`CREATE TRIGGER slow_leave BEFORE DELETE ON group_members FOR EACH ROW EXECUTE FUNCTION slow_leave()`);
    try {
      const gone = new AbortController();
      const request = owner
        .raw("POST", `/groups/${group}/members/remove`, {
          body: JSON.stringify({ userId: user.id }),
          headers: { "Content-Type": "application/json" },
          signal: gone.signal,
        })
        .then(
          () => "answered",
          () => "aborted",
        );
      await Bun.sleep(300);
      gone.abort();
      expect(await request).toBe("aborted");
      // The removal happened, and what follows it did too: the open socket was looked at again.
      await until(async () => (await member.get(`/spaces/${space}/pages`)).status === 404, 5000, "the member to be out of the space");
      await until(async () => !(await hears()), 5000, "no space events after leaving the group");
    } finally {
      await t.sql.unsafe(`DROP TRIGGER slow_leave ON group_members`);
      await t.sql.unsafe(`DROP FUNCTION slow_leave`);
      await socket.close();
    }
  }, 30_000);
});
