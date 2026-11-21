import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, doc, startServer, until, type Client, type Socket, type TestServer } from "./harness";
import { ISO, errorEntry } from "./harness/logs";
import {
  ERRORS,
  SETTLE_MS,
  addToSpace,
  createPage,
  docOf,
  editAfterBothLeave as leaveEdited,
  hold,
  insertText,
  join,
  liveDoc,
  nextPresence,
  p,
  pushSteps,
  sendSteps,
  storedPage,
  text,
  untilBlocked,
  untilStored,
  type PageRef,
} from "./harness/realtime";

/**
 * How documents edited over the socket are saved: when, what is stored, the
 * version snapshots and notifications a save brings, saves that are refused or
 * fail, the sessions kept for editors who reconnect, and replacing a page's
 * content over HTTP (`POST /pages/:id/content`).
 */

let t: TestServer;
let owner: Client;
let ownerId: string;
let spaceId: string;
let writer: Client;
let writerId: string;
let reader: Client;
let readerId: string;
const sockets: Socket[] = [];

const open = async (client: Client) => {
  const socket = await connect(client);
  sockets.push(socket);
  return socket;
};

const about = (pageId: string) => (m: Record<string, any>) => m.pageId === pageId && m.t !== "presence";

let counter = 0;
/** A title no other test of this file uses, so mail and notifications can be told apart. */
const unique = (label: string) => `${label} ${++counter}`;

const page = (content: unknown = doc("hello"), fields: Record<string, unknown> = {}) => createPage(owner, spaceId, content, fields);

/** `client` joins, applies `steps` and leaves again; resolves once the page is stored at the new version. */
const edit = async (client: Client, target: PageRef, version: number, steps: Record<string, any>[], clientId = "e") => {
  const socket = await connect(client);
  await join(socket, target.id, version, clientId);
  await sendSteps(socket, target.id, version, steps, clientId);
  await socket.close();
  return untilStored(t, target.id, version + steps.length);
};

/**
 * `b` drops off at version 0, then `a` adds a "!" and leaves too: nobody has
 * the page open, it is stored at version 1 and `b` is one step behind.
 */
const editAfterBothLeave = () => leaveEdited(t, owner, spaceId);

const versionsOf = (pageId: string) =>
  t.sql`
    SELECT title, icon, content, editor_id, contributor_ids::text[] AS contributor_ids, created_at
    FROM page_versions WHERE page_id = ${pageId} ORDER BY created_at, id`;

const notificationsOf = (pageId: string) =>
  t.sql`
    SELECT user_id, kind, actor_id, comment_id, data, read_at, emailed_at IS NOT NULL AS emailed
    FROM notifications WHERE page_id = ${pageId} ORDER BY created_at, kind, user_id`;

const untilNotified = (pageId: string, userId: string, kind: string, count = 1) =>
  until(
    async () => {
      const [row] = await t.sql`SELECT count(*)::int AS n FROM notifications WHERE page_id = ${pageId} AND user_id = ${userId} AND kind = ${kind}`;
      return row.n >= count;
    },
    5000,
    `a ${kind} notification`,
  );

const watchersOf = async (pageId: string): Promise<string[]> =>
  (await t.sql`SELECT user_id FROM watchers WHERE page_id = ${pageId} ORDER BY user_id`).map((r: { user_id: string }) => r.user_id);

const mailsAbout = (title: string) => t.outbox.filter((m) => m.subject.includes(title));

const untilMail = (title: string, count = 1) => until(() => mailsAbout(title).length >= count, 5000, `${count} mail(s) about ${title}`);

const mention = (userId: unknown, label = "someone") => ({
  type: "mention",
  attrs: { id: `m-${label}`, label, entityType: "user", entityId: userId, slugId: null, creatorId: null, anchorId: null },
});

const sorted = (ids: string[]) => [...ids].sort();

beforeAll(async () => {
  t = await startServer();
  const setup = await t.setupOwner();
  owner = setup.owner;
  ownerId = setup.user.id;
  spaceId = setup.spaceId;
  const w = await t.addMember(owner, "writer@example.com");
  writer = w.client;
  writerId = w.user.id;
  await addToSpace(owner, spaceId, writerId, "writer");
  const r = await t.addMember(owner, "reader@example.com");
  reader = r.client;
  readerId = r.user.id;
  await addToSpace(owner, spaceId, readerId, "reader");
});

afterAll(async () => {
  for (const socket of sockets) socket.ws.close();
  await t.close();
});

describe("when a page is saved", () => {
  test("when its last editor leaves, at once", async () => {
    const target = await page();
    const a = await open(owner);
    await join(a, target.id, 0);
    await sendSteps(a, target.id, 0, [insertText(6, "!")]);
    a.send({ t: "leave", pageId: target.id });
    const row = await untilStored(t, target.id, 1, 1500);
    expect(row.content).toEqual(doc("hello!"));
  });

  test("when its last editor's socket closes, at once: every page the socket had open", async () => {
    const target = await page();
    const second = await page();
    const a = await open(owner);
    await join(a, target.id, 0);
    await join(a, second.id, 0);
    await sendSteps(a, target.id, 0, [insertText(6, "!")]);
    await sendSteps(a, second.id, 0, [insertText(1, "?")]);
    await a.close();
    expect((await untilStored(t, target.id, 1, 1500)).content).toEqual(doc("hello!"));
    expect((await untilStored(t, second.id, 1, 1500)).content).toEqual(doc("?hello"));
  });

  test("about two seconds after the last step while someone stays; a reader who stays counts", async () => {
    const target = await page();
    const a = await open(writer);
    const r = await open(reader);
    await join(a, target.id, 0);
    await join(r, target.id, 0);
    const clock = async () => new Date((await t.sql`SELECT clock_timestamp() AS now`)[0].now).getTime();
    await sendSteps(a, target.id, 0, [insertText(6, "!")]);
    const before = await clock();
    await sendSteps(a, target.id, 1, [insertText(7, "?")]);
    const after = await clock();
    // The writer leaves; the reader keeps the page open, so nothing is saved for it.
    a.send({ t: "leave", pageId: target.id });
    await nextPresence(r, target.id, (users) => users.length === 1);

    const row = await untilStored(t, target.id, 2, 6000);
    const savedAt = new Date(row.updated_at).getTime();
    // Two seconds after the second step, not the first.
    expect(savedAt - before).toBeGreaterThanOrEqual(1950);
    expect(savedAt - after).toBeLessThan(3500);
    expect(row.content).toEqual(doc("hello!?"));
  }, 10_000);

  test("nothing is saved for a page that was only looked at", async () => {
    const target = await page();
    const before = await storedPage(t.sql, target.id);
    const a = await open(writer);
    await join(a, target.id, 0);
    a.send({ t: "presence", pageId: target.id, selection: { anchor: 1, head: 2 } });
    await nextPresence(a, target.id, (users) => users[0].selection !== null);
    await a.close();
    // A refused batch saves nothing either.
    const b = await open(writer);
    await join(b, target.id, 0);
    pushSteps(b, target.id, 0, [insertText(100, "x")]);
    await b.nextOf("error");
    await b.close();
    await Bun.sleep(SETTLE_MS);
    expect(await storedPage(t.sql, target.id)).toEqual(before);
    expect(await watchersOf(target.id)).toEqual([ownerId]);
    expect(await versionsOf(target.id)).toEqual([]);
  });
});

describe("what a save stores", () => {
  test("the document, its text, its version, who edited it and when", async () => {
    const target = await page(doc("hello"), { title: unique("Stored") });
    const before = (await storedPage(t.sql, target.id))!;
    expect(before).toMatchObject({ doc_version: 0, last_editor_id: ownerId, contributor_ids: [ownerId], text_content: "hello" });

    const a = await open(writer);
    const b = await open(owner);
    await join(a, target.id, 0, "w");
    await join(b, target.id, 0, "o");
    await sendSteps(b, target.id, 0, [insertText(1, ">")], "o");
    await sendSteps(a, target.id, 1, [insertText(7, "!"), { stepType: "replace", from: 8, to: 8, slice: [{ c: 1 }, { o: "paragraph" }, { t: "second" }] }], "w");
    a.send({ t: "leave", pageId: target.id });
    b.send({ t: "leave", pageId: target.id });

    const row = await untilStored(t, target.id, 3);
    expect(row.content).toEqual(doc(">hello!", "second"));
    expect(row.text_content).toBe(">hello!\nsecond");
    // The one whose steps came last.
    expect(row.last_editor_id).toBe(writerId);
    expect(sorted(row.contributor_ids)).toEqual(sorted([ownerId, writerId]));
    expect(new Date(row.updated_at).getTime()).toBeGreaterThan(new Date(before.updated_at).getTime());
    expect(new Date(row.created_at).getTime()).toBe(new Date(before.created_at).getTime());

    const read = (await reader.get(`/pages/${target.id}`)).body.data.page;
    expect(read.content).toEqual(doc(">hello!", "second"));
    expect(read.docVersion).toBe(3);
    expect(read.lastEditor).toEqual({ id: writerId, name: "writer", avatarUrl: null });
    expect(read.creator).toEqual({ id: ownerId, name: "Owner", avatarUrl: null });
    expect(sorted(read.contributors.map((c: any) => c.id))).toEqual(sorted([ownerId, writerId]));
    expect(read.updatedAt).toBe(new Date(row.updated_at).toISOString());
    expect(read.updatedAt).toMatch(ISO);
  });

  test("a contributor is listed once however often they edit", async () => {
    const target = await page();
    await edit(writer, target, 0, [insertText(1, "a")]);
    await edit(writer, target, 1, [insertText(1, "b")]);
    const row = await edit(owner, target, 2, [insertText(1, "c")]);
    expect(sorted(row.contributor_ids)).toEqual(sorted([ownerId, writerId]));
    expect(row.last_editor_id).toBe(ownerId);
  });

  test("the text of every kind of block, one line per text block", async () => {
    const target = await page(doc(""));
    const content = [
      { type: "heading", attrs: { level: 1 }, content: [text("Title")] },
      p("first ", { type: "mention", attrs: { label: "Ann", entityType: "user", entityId: readerId } }, " and ", { type: "mathInline", attrs: { text: "x^2" } }, " ", { type: "status", attrs: { text: "Done", color: "green" } }),
      p("line", { type: "hardBreak" }, "break"),
      p("   "),
      p(),
      { type: "mathBlock", attrs: { text: "E=mc^2" } },
      { type: "attachment", attrs: { url: "/api/files/x/report.pdf", name: "report.pdf" } },
      { type: "pdf", attrs: { src: "/api/files/x/doc.pdf", name: "doc.pdf" } },
      { type: "image", attrs: { src: "/api/files/x/pic.png", alt: "not indexed" } },
      { type: "codeBlock", attrs: { language: null }, content: [text("let a = 1;\nlet b = 2;")] },
      { type: "bulletList", content: [{ type: "listItem", content: [p("item one"), { type: "bulletList", content: [{ type: "listItem", content: [p("nested")] }] }] }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p("cell a")] }, { type: "tableCell", content: [p("cell b")] }] }] },
      { type: "details", content: [{ type: "detailsSummary", content: [text("summary")] }, { type: "detailsContent", content: [p("hidden")] }] },
    ];
    expect((await owner.post(`/pages/${target.id}/content`, { content: { type: "doc", content } })).status).toBe(200);
    // Typed over the socket, so that the text is what a collaborative save derives.
    const row = await edit(owner, target, 1, [insertText(6, "!")]);
    expect(row.text_content).toBe(
      ["Title!", "first Ann and x^2 Done", "line\nbreak", "E=mc^2", "report.pdf", "doc.pdf", "let a = 1;\nlet b = 2;", "item one", "nested", "cell a", "cell b", "summary", "hidden"].join("\n"),
    );
  });

  test("the pages it links to", async () => {
    const first = await page(doc("target one"), { title: "Target One" });
    const second = await page(doc("target two"), { title: "Target Two" });
    const third = await page(doc("target three"));
    const trashed = await page(doc("trashed target"));
    await owner.post(`/pages/${trashed.id}/delete`);
    const source = await page();
    const linksOf = async () => (await t.sql`SELECT target_id FROM page_links WHERE source_id = ${source.id} ORDER BY target_id`).map((r: { target_id: string }) => r.target_id);
    const link = (href: string) => ({ type: "link", attrs: { href } });
    const pageMention = (attrs: Record<string, unknown>) => ({ n: { type: "mention", attrs: { entityType: "page", ...attrs } } });

    // A mention by id, a mention by slug id, and links in each form the app writes.
    await edit(owner, source, 0, [
      {
        stepType: "replace",
        from: 6,
        to: 6,
        slice: [
          pageMention({ entityId: first.id }),
          pageMention({ entityId: null, slugId: second.slugId }),
          // The slug id is the end of the path; the title before it and the host of an absolute link are not looked at.
          { t: "a", m: [link(`https://elsewhere.example/s/any-space/p/any-title-${third.slugId}`)] },
          { t: "b", m: [link(`http://doc.test/p/${trashed.slugId}`)] },
          // A second link to a page that is mentioned already, with a query and a fragment.
          { t: "c", m: [link(`/p/${first.slugId}/?x=1#top`)] },
          // Not links to pages of this workspace: no such page, the page itself, another kind of path.
          { t: "d", m: [link("/s/general/p/x-0000000000"), { type: "bold" }] },
          { t: "e", m: [link(`/s/general/p/self-${source.slugId}`)] },
          { t: "f", m: [link(`/files/${first.slugId}`)] },
          pageMention({ entityId: "00000000-0000-4000-8000-000000000000" }),
          pageMention({ entityId: "not-an-id" }),
          { n: { type: "mention", attrs: { entityType: "user", entityId: second.id } } },
        ],
      },
    ]);
    expect(await linksOf()).toEqual(sorted([first.id, second.id, third.id, trashed.id]));

    // The list follows the document. Taking the two mentions out removes the second page, which nothing else links to.
    await edit(owner, source, 1, [{ stepType: "replace", from: 6, to: 8, slice: [] }]);
    expect(await linksOf()).toEqual(sorted([first.id, third.id, trashed.id]));
    // What is left: "hello", six linked letters and three mentions.
    await edit(owner, source, 2, [{ stepType: "replace", from: 1, to: 15, slice: [{ t: "plain" }] }]);
    expect(await linksOf()).toEqual([]);
    expect((await storedPage(t.sql, source.id))!.content).toEqual(doc("plain"));
  });

  test("its synced blocks", async () => {
    const target = await page();
    const blocksOf = () => t.sql`SELECT block_id, content, updated_at FROM synced_blocks WHERE page_id = ${target.id} ORDER BY block_id`;
    const source = (id: unknown, value: string) => [{ o: "transclusionSource", a: { id } }, { o: "paragraph" }, { t: value }, { c: 1 }, { c: 1 }];
    // <p>hello</p> is 7 positions; each block below is 2 + 2 + its text.
    await edit(owner, target, 0, [
      { stepType: "replace", from: 7, to: 7, slice: [...source("block-a", "one"), ...source("block-b", "two"), ...source("", "nameless"), ...source(null, "null"), ...source(7, "number"), ...source("x".repeat(101), "long"), ...source("x".repeat(100), "hundred")] },
    ]);
    const first = await blocksOf();
    expect(first.map((r: any) => [r.block_id, r.content])).toEqual([
      ["block-a", [p("one")]],
      ["block-b", [p("two")]],
      ["x".repeat(100), [p("hundred")]],
    ]);

    // Typing into one block updates that row only.
    await edit(owner, target, 1, [insertText(12, "!")]);
    const second = await blocksOf();
    expect(second.map((r: any) => [r.block_id, r.content])).toEqual([
      ["block-a", [p("one!")]],
      ["block-b", [p("two")]],
      ["x".repeat(100), [p("hundred")]],
    ]);
    expect(new Date(second[0].updated_at).getTime()).toBeGreaterThan(new Date(first[0].updated_at).getTime());
    expect(second[1].updated_at).toEqual(first[1].updated_at);

    // A block taken out of the document is forgotten; a second one with the same id wins over the first.
    await edit(owner, target, 2, [
      { stepType: "replace", from: 7, to: 15, slice: [] },
      { stepType: "replace", from: 7, to: 7, slice: source("block-b", "earlier") },
    ]);
    expect((await blocksOf()).map((r: any) => [r.block_id, r.content])).toEqual([
      ["block-b", [p("two")]],
      ["x".repeat(100), [p("hundred")]],
    ]);
    await edit(owner, target, 4, [{ stepType: "replace", from: 0, to: 7, slice: [] }, { stepType: "replace", from: 0, to: 11, slice: [{ o: "paragraph" }, { c: 1 }] }]);
    expect((await blocksOf()).map((r: any) => [r.block_id, r.content])).toEqual([
      ["block-b", [p("two")]],
      ["x".repeat(100), [p("hundred")]],
    ]);
    const lookup = await reader.post("/synced-blocks/lookup", { refs: [{ pageId: target.id, blockId: "block-b" }, { pageId: target.id, blockId: "block-a" }] });
    expect(lookup.body.data).toEqual([
      { pageId: target.id, blockId: "block-b", content: [p("two")] },
      { pageId: target.id, blockId: "block-a", content: null },
    ]);
  });
});

describe("version snapshots", () => {
  const backdate = (pageId: string, interval: string) => t.sql`UPDATE page_versions SET created_at = now() - ${interval}::interval WHERE page_id = ${pageId}`;

  test("the first save of a page snapshots it; further saves within a minute do not", async () => {
    const target = await page(doc("hello"), { title: "Snapshots", icon: "📸" });
    expect(await versionsOf(target.id)).toEqual([]);
    const row = await edit(writer, target, 0, [insertText(6, "!")]);
    const [first, ...rest] = await versionsOf(target.id);
    expect(rest).toEqual([]);
    expect({ ...first, contributor_ids: sorted(first.contributor_ids) }).toEqual({
      title: "Snapshots",
      icon: "📸",
      content: doc("hello!"),
      editor_id: writerId,
      contributor_ids: sorted([ownerId, writerId]),
      created_at: expect.any(Date),
    });
    expect(Math.abs(new Date(first.created_at).getTime() - new Date(row.updated_at).getTime())).toBeLessThan(1000);

    await edit(owner, target, 1, [insertText(7, "!")]);
    await edit(owner, target, 2, [insertText(8, "!")]);
    expect(await versionsOf(target.id)).toHaveLength(1);
    // The list a reader sees.
    const listed = (await reader.get(`/pages/${target.id}/versions`)).body.data;
    expect(listed).toEqual([{ id: expect.any(String), title: "Snapshots", editor: { id: writerId, name: "writer", avatarUrl: null }, createdAt: expect.stringMatching(ISO) }]);
  });

  test("a page younger than five minutes is snapshot again once its last snapshot is a minute old", async () => {
    const target = await page();
    await edit(owner, target, 0, [insertText(6, "1")]);
    await backdate(target.id, "58 seconds");
    await edit(owner, target, 1, [insertText(7, "2")]);
    expect(await versionsOf(target.id)).toHaveLength(1);
    await backdate(target.id, "61 seconds");
    await edit(writer, target, 2, [insertText(8, "3")]);
    const versions = await versionsOf(target.id);
    expect(versions.map((v: any) => [v.content, v.editor_id])).toEqual([
      [doc("hello1"), ownerId],
      [doc("hello123"), writerId],
    ]);
  });

  test("an older page is snapshot again once its last snapshot is five minutes old", async () => {
    const target = await page();
    await edit(owner, target, 0, [insertText(6, "1")]);
    await t.sql`UPDATE pages SET created_at = now() - interval '5 minutes 2 seconds' WHERE id = ${target.id}`;
    await backdate(target.id, "61 seconds");
    await edit(owner, target, 1, [insertText(7, "2")]);
    expect(await versionsOf(target.id)).toHaveLength(1);
    await backdate(target.id, "4 minutes 58 seconds");
    await edit(owner, target, 2, [insertText(8, "3")]);
    expect(await versionsOf(target.id)).toHaveLength(1);
    await backdate(target.id, "5 minutes 1 second");
    await edit(owner, target, 3, [insertText(9, "4")]);
    expect((await versionsOf(target.id)).map((v: any) => v.content)).toEqual([doc("hello1"), doc("hello1234")]);
  });

  test("a save that leaves the document as the last snapshot has it adds none", async () => {
    const target = await page();
    await edit(owner, target, 0, [insertText(6, "!")]);
    await backdate(target.id, "2 minutes");
    // Typed and deleted again within one save.
    const row = await edit(writer, target, 1, [insertText(7, "?"), { stepType: "replace", from: 7, to: 8, slice: [] }]);
    expect(row.content).toEqual(doc("hello!"));
    expect(row.doc_version).toBe(3);
    expect(row.last_editor_id).toBe(writerId);
    expect(await versionsOf(target.id)).toHaveLength(1);
    // The next real change is snapshot.
    await edit(writer, target, 3, [insertText(7, "?")]);
    expect(await versionsOf(target.id)).toHaveLength(2);
  });
});

describe("watching and notifications after a save", () => {
  test("everyone who edited becomes a watcher of the page", async () => {
    const target = await page();
    expect(await watchersOf(target.id)).toEqual([ownerId]);
    await edit(writer, target, 0, [insertText(6, "!")]);
    await until(async () => (await watchersOf(target.id)).length === 2);
    expect(await watchersOf(target.id)).toEqual(sorted([ownerId, writerId]));
    // Once: editing again, or having stopped watching and editing again, adds one row at most.
    expect((await writer.post(`/pages/${target.id}/watch`, { watching: false })).status).toBe(200);
    await edit(writer, target, 1, [insertText(7, "!")]);
    await until(async () => (await watchersOf(target.id)).length === 2);
    await edit(writer, target, 2, [insertText(8, "!")]);
    await Bun.sleep(SETTLE_MS);
    expect(await watchersOf(target.id)).toEqual(sorted([ownerId, writerId]));
  });

  test("watchers of the page who did not edit are told it was updated, in the app and by mail", async () => {
    const title = unique("Updated");
    const target = await page(doc("hello"), { title });
    expect((await reader.post(`/pages/${target.id}/watch`, { watching: true })).status).toBe(200);
    const ownerSocket = await open(owner);
    const writerSocket = await open(writer);
    await edit(writer, target, 0, [insertText(6, "!")]);

    await untilMail(title, 2);
    expect(await notificationsOf(target.id)).toEqual(
      [ownerId, readerId].sort().map((user_id) => ({ user_id, kind: "page.updated", actor_id: writerId, comment_id: null, data: {}, read_at: null, emailed: true })),
    );
    expect(await ownerSocket.nextOf("event", { kind: "notification" })).toEqual({ t: "event", kind: "notification" });
    expect(writerSocket.inbox.filter((m) => m.kind === "notification")).toEqual([]);

    const url = `http://doc.test/s/general/p/${title.toLowerCase().replace(" ", "-")}-${target.slugId}`;
    const mails = mailsAbout(title);
    expect(mails.map((m) => m.to).sort()).toEqual(["owner@example.com", "reader@example.com"]);
    for (const mail of mails) {
      expect(mail.from).toBe("docs@doc.test");
      expect(mail.subject).toBe(`writer updated ${title}`);
      expect(mail.text).toBe(`writer updated ${title}.\n\nOpen page: ${url}`);
      expect(mail.html).toBe(
        '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#222;line-height:1.5">' +
          '<div style="max-width:560px;margin:0 auto;padding:24px">' +
          `<p style="margin:0 0 16px">writer updated ${title}.</p>` +
          `<p style="margin:24px 0"><a href="${url}" style="background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open page</a></p>` +
          `<p style="color:#666;font-size:12px">${url}</p></div></body></html>`,
      );
    }
    // What the recipient reads in the app.
    const listed = (await reader.get("/notifications")).body.data.filter((n: any) => n.page?.id === target.id);
    expect(listed).toEqual([
      {
        id: expect.any(String),
        kind: "page.updated",
        actor: { id: writerId, name: "writer", avatarUrl: null },
        page: { id: target.id, slugId: target.slugId, title, icon: null, spaceId, spaceSlug: "general" },
        comment: null,
        data: {},
        createdAt: expect.stringMatching(ISO),
        readAt: null,
      },
    ]);
  });

  test("the editors themselves are not told", async () => {
    const title = unique("Editors");
    const target = await page(doc("hello"), { title });
    await reader.post(`/pages/${target.id}/watch`, { watching: true });
    // The owner (who watches the page they created) and the writer both edit before the save.
    const a = await open(owner);
    const b = await open(writer);
    await join(a, target.id, 0, "o");
    await join(b, target.id, 0, "w");
    await sendSteps(a, target.id, 0, [insertText(1, "o")], "o");
    await sendSteps(b, target.id, 1, [insertText(1, "w")], "w");
    a.send({ t: "leave", pageId: target.id });
    b.send({ t: "leave", pageId: target.id });
    await untilMail(title, 1);
    await t.smtp.settle();
    // The reader is told, by the editor whose steps came last.
    expect(await notificationsOf(target.id)).toEqual([{ user_id: readerId, kind: "page.updated", actor_id: writerId, comment_id: null, data: {}, read_at: null, emailed: true }]);
    expect(mailsAbout(title).map((m) => [m.to, m.subject])).toEqual([["reader@example.com", `writer updated ${title}`]]);
  });

  test("watchers of the space are told about every page in it", async () => {
    const title = unique("Space watched");
    const { client: fan, user } = await t.addMember(owner, "space-watcher@example.com");
    await addToSpace(owner, spaceId, user.id, "reader");
    expect((await fan.post(`/spaces/${spaceId}/watch`, { watching: true })).status).toBe(200);
    try {
      const target = await page(doc("hello"), { title });
      // Watching the page as well does not double the notification.
      await fan.post(`/pages/${target.id}/watch`, { watching: true });
      await edit(owner, target, 0, [insertText(6, "!")]);
      await untilMail(title, 1);
      await t.smtp.settle();
      expect(await notificationsOf(target.id)).toEqual([{ user_id: user.id, kind: "page.updated", actor_id: ownerId, comment_id: null, data: {}, read_at: null, emailed: true }]);
      expect(mailsAbout(title).map((m) => [m.to, m.subject])).toEqual([["space-watcher@example.com", `Owner updated ${title}`]]);
    } finally {
      await fan.post(`/spaces/${spaceId}/watch`, { watching: false });
    }
  });

  test("at most once in seven hours per page and person", async () => {
    const title = unique("Cooldown");
    const target = await page(doc("hello"), { title });
    await reader.post(`/pages/${target.id}/watch`, { watching: true });
    const count = async (userId: string) =>
      (await t.sql`SELECT count(*)::int AS n FROM notifications WHERE page_id = ${target.id} AND user_id = ${userId}`)[0].n as number;
    const age = (userId: string, interval: string) =>
      t.sql`UPDATE notifications SET created_at = now() - ${interval}::interval WHERE page_id = ${target.id} AND user_id = ${userId}`;

    await edit(writer, target, 0, [insertText(6, "1")]);
    await untilMail(title, 2);
    expect([await count(ownerId), await count(readerId)]).toEqual([1, 1]);

    // The owner was told just under seven hours ago, the reader just over.
    await age(ownerId, "6 hours 59 minutes");
    await age(readerId, "7 hours 1 minute");
    await edit(writer, target, 1, [insertText(7, "2")]);
    await untilMail(title, 3);
    await t.smtp.settle();
    expect([await count(ownerId), await count(readerId)]).toEqual([1, 2]);
    expect(mailsAbout(title).map((m) => m.to).sort()).toEqual(["owner@example.com", "reader@example.com", "reader@example.com"]);

    // Reading a notification does not shorten the wait; another page has its own.
    await reader.post("/notifications/read-all");
    const other = await page(doc("hello"), { title: `${title} other` });
    await edit(writer, target, 2, [insertText(8, "3")]);
    await edit(writer, other, 0, [insertText(6, "!")]);
    await untilNotified(other.id, ownerId, "page.updated");
    expect([await count(ownerId), await count(readerId)]).toEqual([1, 2]);
  });

  test("someone who turned update mails off is told in the app only", async () => {
    const title = unique("Quiet");
    const { client: quiet, user } = await t.addMember(owner, "quiet@example.com");
    await addToSpace(owner, spaceId, user.id, "reader");
    expect((await quiet.post("/me/update", { preferences: { notifyPageUpdates: false } })).status).toBe(200);
    const target = await page(doc("hello"), { title });
    await quiet.post(`/pages/${target.id}/watch`, { watching: true });
    const socket = await open(quiet);
    await edit(writer, target, 0, [insertText(6, "!")]);
    // The owner's mail shows the save's mails went out.
    await untilMail(title, 1);
    await t.smtp.settle();
    expect(await socket.nextOf("event", { kind: "notification" })).toEqual({ t: "event", kind: "notification" });
    const rows = await notificationsOf(target.id);
    expect(rows.find((r: any) => r.user_id === user.id)).toEqual({ user_id: user.id, kind: "page.updated", actor_id: writerId, comment_id: null, data: {}, read_at: null, emailed: false });
    expect(rows.find((r: any) => r.user_id === ownerId)).toMatchObject({ emailed: true });
    expect(mailsAbout(title).map((m) => m.to)).toEqual(["owner@example.com"]);
  });

  test("a watcher who cannot read the page any more, or was deactivated, is not told", async () => {
    const title = unique("Gone");
    const left = await t.addMember(owner, "left-space@example.com");
    const membership = await addToSpace(owner, spaceId, left.user.id, "reader");
    const off = await t.addMember(owner, "deactivated-watcher@example.com");
    await addToSpace(owner, spaceId, off.user.id, "reader");
    const target = await page(doc("hello"), { title });
    await left.client.post(`/pages/${target.id}/watch`, { watching: true });
    await off.client.post(`/pages/${target.id}/watch`, { watching: true });
    expect((await owner.post(`/spaces/${spaceId}/members/remove`, { memberId: membership })).status).toBe(200);
    expect((await owner.post("/members/deactivate", { userId: off.user.id })).status).toBe(200);

    await edit(writer, target, 0, [insertText(6, "!")]);
    await untilMail(title, 1);
    await t.smtp.settle();
    expect((await notificationsOf(target.id)).map((r: any) => r.user_id)).toEqual([ownerId]);
    expect(mailsAbout(title).map((m) => m.to)).toEqual(["owner@example.com"]);
  });

  test("a page without a title is called Untitled", async () => {
    const target = await page(doc("hello"), { title: null });
    const before = t.outbox.length;
    await edit(writer, target, 0, [insertText(6, "!")]);
    await untilNotified(target.id, ownerId, "page.updated");
    const mail = await until(() => t.outbox.slice(before).find((m) => m.text.includes(target.slugId)));
    expect(mail.subject).toBe("writer updated Untitled");
    expect(mail.text).toBe(`writer updated Untitled.\n\nOpen page: http://doc.test/s/general/p/untitled-${target.slugId}`);
  });

  test("someone newly mentioned is told so, instead of being told about the update", async () => {
    const title = unique("Mention");
    const target = await page(doc("hello"), { title });
    await reader.post(`/pages/${target.id}/watch`, { watching: true });
    const socket = await open(reader);
    await edit(writer, target, 0, [{ stepType: "replace", from: 6, to: 6, slice: [{ n: mention(readerId, "reader") }] }]);
    await untilMail(title, 2);
    await t.smtp.settle();
    // The mention is announced first, then the update to the watchers that are left.
    expect(await notificationsOf(target.id)).toEqual([
      { user_id: readerId, kind: "page.mention", actor_id: writerId, comment_id: null, data: {}, read_at: null, emailed: true },
      { user_id: ownerId, kind: "page.updated", actor_id: writerId, comment_id: null, data: {}, read_at: null, emailed: true },
    ]);
    expect(await socket.nextOf("event", { kind: "notification" })).toEqual({ t: "event", kind: "notification" });
    expect(await socket.quiet((m) => m.kind === "notification", 100)).toBe(true);
    const url = `http://doc.test/s/general/p/${title.toLowerCase().replace(" ", "-")}-${target.slugId}`;
    const mail = mailsAbout(title).find((m) => m.to === "reader@example.com")!;
    expect(mail.subject).toBe(`writer mentioned you on ${title}`);
    expect(mail.text).toBe(`writer mentioned you on ${title}.\n\nOpen page: ${url}`);
    expect(mailsAbout(title).map((m) => [m.to, m.subject]).sort()).toEqual([
      ["owner@example.com", `writer updated ${title}`],
      ["reader@example.com", `writer mentioned you on ${title}`],
    ]);
  });

  test("a mention that was there before the save is not announced again; one that comes back is", async () => {
    const title = unique("Mentioned before");
    const target = await page(docOf(p("hello", mention(readerId, "reader"))), { title });
    const count = async (kind: string) =>
      (await t.sql`SELECT count(*)::int AS n FROM notifications WHERE page_id = ${target.id} AND user_id = ${readerId} AND kind = ${kind}`)[0].n as number;
    // Typing next to the mention: the owner hears of the update, the reader of nothing.
    await edit(writer, target, 0, [insertText(1, ">")]);
    await untilNotified(target.id, ownerId, "page.updated");
    expect([await count("page.mention"), await count("page.updated")]).toEqual([0, 0]);

    // A second mention of the same person is not new either. The writer is mentioned to have someone who is told.
    const second = await t.addMember(owner, "second-mention@example.com");
    await addToSpace(owner, spaceId, second.user.id, "reader");
    await edit(writer, target, 1, [{ stepType: "replace", from: 1, to: 1, slice: [{ n: mention(readerId, "reader") }, { n: mention(second.user.id, "second") }] }]);
    await untilNotified(target.id, second.user.id, "page.mention");
    expect(await count("page.mention")).toBe(0);

    // Both mentions of the reader go, and one comes back in a later save.
    await edit(writer, target, 2, [{ stepType: "replace", from: 1, to: 2, slice: [] }, { stepType: "replace", from: 8, to: 9, slice: [] }]);
    expect((await storedPage(t.sql, target.id))!.content).toEqual(docOf(p(mention(second.user.id, "second"), ">hello")));
    await edit(writer, target, 4, [{ stepType: "replace", from: 2, to: 2, slice: [{ n: mention(readerId, "reader") }] }]);
    await untilNotified(target.id, readerId, "page.mention");
    expect(await count("page.mention")).toBe(1);
  });

  test("mentions of the editor, of people outside the space and of things that are not users notify nobody", async () => {
    const title = unique("Mention nobody");
    const outsider = await t.addMember(owner, "outside-space@example.com");
    const off = await t.addMember(owner, "deactivated-mention@example.com");
    await addToSpace(owner, spaceId, off.user.id, "reader");
    await owner.post("/members/deactivate", { userId: off.user.id });
    const target = await page(doc("hello"), { title });
    await edit(writer, target, 0, [
      {
        stepType: "replace",
        from: 6,
        to: 6,
        slice: [
          { n: mention(writerId, "myself") },
          { n: mention(outsider.user.id, "outsider") },
          { n: mention(off.user.id, "deactivated") },
          { n: mention("not-an-id", "nobody") },
          { n: mention(null, "null") },
          { n: mention("00000000-0000-4000-8000-000000000000", "unknown") },
          { n: { type: "mention", attrs: { entityType: "page", entityId: readerId, label: "a page" } } },
          // The one mention that counts, written in upper case.
          { n: mention(readerId.toUpperCase(), "reader") },
        ],
      },
    ]);
    await untilMail(title, 2);
    await t.smtp.settle();
    expect((await notificationsOf(target.id)).map((r: any) => [r.kind, r.user_id])).toEqual([
      ["page.mention", readerId],
      ["page.updated", ownerId],
    ]);
  });

  test("someone who turned mention mails off is told in the app only", async () => {
    const title = unique("Quiet mention");
    const { user } = await t.addMember(owner, "quiet-mention@example.com");
    await addToSpace(owner, spaceId, user.id, "reader");
    await t.sql`UPDATE users SET preferences = '{"notifyPageMentions": false}' WHERE id = ${user.id}`;
    const target = await page(doc("hello"), { title });
    await edit(writer, target, 0, [{ stepType: "replace", from: 6, to: 6, slice: [{ n: mention(user.id, "quiet") }] }]);
    await untilMail(title, 1);
    await t.smtp.settle();
    expect(await notificationsOf(target.id)).toEqual([
      { user_id: user.id, kind: "page.mention", actor_id: writerId, comment_id: null, data: {}, read_at: null, emailed: false },
      { user_id: ownerId, kind: "page.updated", actor_id: writerId, comment_id: null, data: {}, read_at: null, emailed: true },
    ]);
    expect(mailsAbout(title).map((m) => m.to)).toEqual(["owner@example.com"]);
  });

  test("a page that went to the trash before its save notifies nobody and adds no watcher", async () => {
    const title = unique("Trashed");
    const target = await page(doc("hello"), { title });
    const a = await open(writer);
    await join(a, target.id, 0);
    await sendSteps(a, target.id, 0, [insertText(6, "!"), { stepType: "replace", from: 7, to: 7, slice: [{ n: mention(readerId, "reader") }] }]);
    expect((await owner.post(`/pages/${target.id}/delete`)).status).toBe(200);
    await a.nextOf("joined", { readOnly: true });
    a.send({ t: "leave", pageId: target.id });
    // What was typed is still saved.
    const row = await untilStored(t, target.id, 2);
    expect(row.content).toEqual(docOf(p("hello!", mention(readerId, "reader"))));
    expect(row.last_editor_id).toBe(writerId);
    await Bun.sleep(SETTLE_MS);
    await t.smtp.settle();
    expect(await notificationsOf(target.id)).toEqual([]);
    expect(await watchersOf(target.id)).toEqual([ownerId]);
    expect(mailsAbout(title)).toEqual([]);
  });

  test("a failure after the save is stored does not make the next save a conflict", async () => {
    const target = await page();
    // Adding the editor as a watcher is the first thing after the save itself.
    await t.sql.unsafe(`CREATE OR REPLACE FUNCTION refuse_watcher() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no watchers'; END $$`);
    await t.sql.unsafe(`CREATE OR REPLACE TRIGGER refuse_watcher BEFORE INSERT ON watchers FOR EACH ROW WHEN (NEW.page_id = '${target.id}') EXECUTE FUNCTION refuse_watcher()`);
    try {
      await edit(owner, target, 0, [insertText(6, "!")]);
      const logged = await until(() => t.logEntries().find((e) => e.msg === "page notifications failed" && e.pageId === target.id));
      expect(logged.error).toContain("no watchers");
      expect(errorEntry(logged)).toEqual({ t: expect.stringMatching(ISO), level: "error", msg: "page notifications failed", pageId: target.id });
      const row = await edit(owner, target, 1, [insertText(7, "!")]);
      expect(row.content).toEqual(doc("hello!!"));
    } finally {
      await t.sql.unsafe(`DROP TRIGGER refuse_watcher ON watchers`);
      await t.sql.unsafe(`DROP FUNCTION refuse_watcher`);
    }
  });
});

describe("saves that are refused or fail", () => {
  test("a page that was stored at another version underneath its editors resets them instead of being overwritten", async () => {
    const target = await page();
    const a = await open(writer);
    const r = await open(reader);
    await join(a, target.id, 0);
    await join(r, target.id, 0);
    await t.sql`UPDATE pages SET content = ${doc("elsewhere")}::jsonb, doc_version = 7 WHERE id = ${target.id}`;

    await sendSteps(a, target.id, 0, [insertText(6, "!")]);
    await r.nextOf("steps", { version: 1 });
    // The save, two seconds later, finds version 7 where it expected 0.
    expect(await a.next(about(target.id), 6000)).toEqual({ t: "error", pageId: target.id, message: ERRORS.changedElsewhere });
    expect(await a.next(about(target.id))).toEqual({ t: "joined", pageId: target.id, version: 7, doc: doc("elsewhere"), readOnly: false });
    expect(await r.next(about(target.id))).toEqual({ t: "error", pageId: target.id, message: ERRORS.changedElsewhere });
    expect(await r.next(about(target.id))).toEqual({ t: "joined", pageId: target.id, version: 7, doc: doc("elsewhere"), readOnly: true });

    const row = (await storedPage(t.sql, target.id))!;
    expect(row.content).toEqual(doc("elsewhere"));
    expect(row.doc_version).toBe(7);
    expect(row.contributor_ids).toEqual([ownerId]);
    expect(t.logEntries().find((e) => e.msg === "page changed outside its session; reloading it" && e.pageId === target.id)).toEqual({
      t: expect.stringMatching(ISO),
      level: "warn",
      msg: "page changed outside its session; reloading it",
      pageId: target.id,
    });

    // Editing goes on from what is stored.
    expect((await sendSteps(a, target.id, 7, [insertText(10, "!")])).version).toBe(8);
    a.send({ t: "leave", pageId: target.id });
    r.send({ t: "leave", pageId: target.id });
    expect((await untilStored(t, target.id, 8)).content).toEqual(doc("elsewhere!"));
  }, 15_000);

  test("a save that fails is logged, keeps the changes, and is tried again when the page is next left", async () => {
    const target = await page();
    await t.sql.unsafe(`CREATE OR REPLACE FUNCTION refuse_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no saving today'; END $$`);
    await t.sql.unsafe(`CREATE OR REPLACE TRIGGER refuse_save BEFORE UPDATE OF content ON pages FOR EACH ROW WHEN (NEW.id = '${target.id}') EXECUTE FUNCTION refuse_save()`);
    const failures = () => t.logEntries().filter((e) => e.msg === "saving page content failed" && e.pageId === target.id);
    try {
      const a = await open(writer);
      await join(a, target.id, 0);
      await sendSteps(a, target.id, 0, [insertText(6, "!")]);
      a.send({ t: "leave", pageId: target.id });
      await until(() => failures().length === 1);
      expect(failures()[0]!.error).toContain("no saving today");
      expect(errorEntry(failures()[0])).toEqual({ t: expect.stringMatching(ISO), level: "error", msg: "saving page content failed", pageId: target.id });
      expect((await storedPage(t.sql, target.id))!.doc_version).toBe(0);

      // The session still holds the step: a client at version 1 is current, and leaving tries again.
      expect(await join(a, target.id, 1)).toEqual({ t: "joined", pageId: target.id, version: 1, readOnly: false });
      a.send({ t: "leave", pageId: target.id });
      await until(() => failures().length === 2);
      expect((await storedPage(t.sql, target.id))!.doc_version).toBe(0);
    } finally {
      await t.sql.unsafe(`DROP TRIGGER refuse_save ON pages`);
      await t.sql.unsafe(`DROP FUNCTION refuse_save`);
    }
    // Once saving works again, another editor's step and the kept one are stored together.
    const row = await edit(owner, target, 1, [insertText(7, "?")]);
    expect(row.content).toEqual(doc("hello!?"));
    expect(sorted(row.contributor_ids)).toEqual(sorted([ownerId, writerId]));
    expect(row.last_editor_id).toBe(ownerId);
  });

  test("a page deleted for good while it was being edited is not brought back by its save", async () => {
    const target = await page();
    const a = await open(owner);
    await join(a, target.id, 0);
    await sendSteps(a, target.id, 0, [insertText(6, "!")]);
    expect((await owner.post(`/pages/${target.id}/delete-permanently`)).status).toBe(200);
    expect(await a.next(about(target.id))).toEqual({ t: "error", pageId: target.id, message: ERRORS.accessLost });
    await Bun.sleep(SETTLE_MS);
    expect(await storedPage(t.sql, target.id)).toBeNull();
    expect(t.logEntries().filter((e) => e.level === "error" && e.pageId === target.id)).toEqual([]);
  });
});

describe("a page nobody has open any more", () => {
  test("an editor who reconnects is caught up step by step", async () => {
    const target = await editAfterBothLeave();
    const b = await open(owner);
    b.send({ t: "join", pageId: target.id, version: 0, clientId: "b" });
    expect(await b.next(about(target.id))).toEqual({ t: "joined", pageId: target.id, version: 0, readOnly: false });
    expect(await b.next(about(target.id))).toEqual({ t: "steps", pageId: target.id, version: 1, steps: [insertText(6, "!")], clientIds: ["a"] });
  });

  test("is loaded again when it was stored at another version in the meantime", async () => {
    const target = await editAfterBothLeave();
    await t.sql`UPDATE pages SET content = ${doc("elsewhere")}::jsonb, doc_version = 7 WHERE id = ${target.id}`;
    const b = await open(owner);
    expect(await join(b, target.id, 1, "b")).toEqual({ t: "joined", pageId: target.id, version: 7, doc: doc("elsewhere"), readOnly: false });
    expect((await sendSteps(b, target.id, 7, [insertText(10, "!")], "b")).version).toBe(8);
  });

  test("is kept as it was edited while its stored version is the same", async () => {
    const target = await editAfterBothLeave();
    // Only the version tells whether the page was stored again.
    await t.sql`UPDATE pages SET content = ${doc("same version")}::jsonb WHERE id = ${target.id}`;
    const b = await open(owner);
    expect(await liveDoc(b, target.id)).toEqual({ version: 1, doc: doc("hello!") });
  });

  test("is not kept when no step was taken while it was open", async () => {
    const target = await page();
    const a = await open(owner);
    await join(a, target.id, 0);
    a.send({ t: "presence", pageId: target.id, selection: null });
    await nextPresence(a, target.id);
    await a.close();
    await Bun.sleep(SETTLE_MS);
    await t.sql`UPDATE pages SET content = ${doc("same version")}::jsonb WHERE id = ${target.id}`;
    const b = await open(owner);
    expect(await liveDoc(b, target.id)).toEqual({ version: 0, doc: doc("same version") });
  });

  test("a content replacement onto it when it went stale replaces what is stored", async () => {
    const target = await editAfterBothLeave();
    await t.sql`UPDATE pages SET content = ${doc("elsewhere")}::jsonb, doc_version = 7 WHERE id = ${target.id}`;
    const res = await owner.post(`/pages/${target.id}/content`, { content: doc("imported") });
    expect(res.status).toBe(200);
    const row = (await storedPage(t.sql, target.id))!;
    expect(row.content).toEqual(doc("imported"));
    expect(row.doc_version).toBe(8);
  });

  test("a refused content replacement leaves its history for reconnecting editors", async () => {
    const target = await editAfterBothLeave();
    // Text straight in the document does not fit it.
    const res = await owner.post(`/pages/${target.id}/content`, { content: { type: "doc", content: [{ type: "text", text: "x" }] } });
    expect(res.status).toBe(400);
    const b = await open(owner);
    b.send({ t: "join", pageId: target.id, version: 0, clientId: "b" });
    expect(await b.next(about(target.id))).toEqual({ t: "joined", pageId: target.id, version: 0, readOnly: false });
    expect(await b.next(about(target.id))).toEqual({ t: "steps", pageId: target.id, version: 1, steps: [insertText(6, "!")], clientIds: ["a"] });
  });

  test("a content replacement ends its history: who reconnects gets the whole document", async () => {
    const target = await editAfterBothLeave();
    expect((await owner.post(`/pages/${target.id}/content`, { content: doc("imported") })).status).toBe(200);
    const b = await open(owner);
    expect(await join(b, target.id, 1, "b")).toEqual({ t: "joined", pageId: target.id, version: 2, doc: doc("imported"), readOnly: false });
    expect(await join(b, target.id, 0, "b")).toEqual({ t: "joined", pageId: target.id, version: 2, doc: doc("imported"), readOnly: false });
  });

  test("an editor whose socket closes while it joins is not left on the page", async () => {
    const target = await page();
    const ghost = await open(owner);
    const b = await open(owner);
    // Hold the pages table, so the join waits until its socket has closed.
    const unlock = await hold(t.sql, "LOCK TABLE pages IN ACCESS EXCLUSIVE MODE");
    try {
      ghost.send({ t: "join", pageId: target.id, version: 0, clientId: "ghost" });
      await untilBlocked(t.sql);
      await ghost.close();
    } finally {
      await unlock();
    }
    await join(b, target.id, 0, "b");
    const presence = await nextPresence(b, target.id);
    expect(presence.users.map((u: any) => u.clientId)).toEqual(["b"]);
    expect(await b.quiet((m) => m.t === "presence", 200)).toBe(true);
  });
});

describe("POST /pages/:id/content", () => {
  const rich = {
    type: "doc",
    content: [
      { type: "heading", attrs: { id: null, level: 2, textAlign: null, indent: 0 }, content: [text("Tit"), { type: "text", text: "" }, text("le"), text("d", { type: "bold" }), { type: "hardBreak" }] },
      { type: "paragraph", marks: [], extra: "dropped" },
      { type: "paragraph", attrs: {}, content: [{ type: "text", text: "link", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
      { type: "horizontalRule", extra: "kept" },
    ],
  };
  /**
   * How the server holds `rich`: rebuilt node by node, with URLs cleaned. Text
   * nodes next to each other with the same marks are one, empty ones are gone,
   * every node that can have content has a list of it, an empty list of marks
   * and keys a node does not have are dropped; leaves are kept whole.
   */
  const richStored = {
    type: "doc",
    content: [
      { type: "heading", attrs: { id: null, level: 2, textAlign: null, indent: 0 }, content: [text("Title"), text("d", { type: "bold" }), { type: "hardBreak" }] },
      { type: "paragraph", content: [] },
      { type: "paragraph", attrs: {}, content: [text("link", { type: "link", attrs: { href: "" } })] },
      { type: "horizontalRule", extra: "kept" },
    ],
  };

  test("replaces the document, bumps the version by one and returns the page", async () => {
    const target = await page(doc("hello"), { title: "Replaced", icon: "📄" });
    const before = (await storedPage(t.sql, target.id))!;
    const res = await writer.post(`/pages/${target.id}/content`, { content: rich, ignored: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toEqual({
      data: {
        page: {
          id: target.id,
          slugId: target.slugId,
          title: "Replaced",
          icon: "📄",
          parentId: null,
          spaceId,
          position: expect.any(String),
          hasChildren: false,
          isBase: false,
          cover: null,
          content: richStored,
          docVersion: 1,
          creator: { id: ownerId, name: "Owner", avatarUrl: null },
          lastEditor: { id: writerId, name: "writer", avatarUrl: null },
          contributors: expect.any(Array),
          createdAt: expect.stringMatching(ISO),
          updatedAt: expect.stringMatching(ISO),
          deletedAt: null,
        },
      },
    });
    expect(sorted(res.body.data.page.contributors.map((c: any) => c.id))).toEqual(sorted([ownerId, writerId]));

    const row = (await storedPage(t.sql, target.id))!;
    expect(row.content).toEqual(richStored);
    expect(row.text_content).toBe("Titled\n\nlink");
    expect(row.doc_version).toBe(1);
    expect(row.last_editor_id).toBe(writerId);
    expect(new Date(row.updated_at).getTime()).toBeGreaterThan(new Date(before.updated_at).getTime());
    expect(res.body.data.page.updatedAt).toBe(new Date(row.updated_at).toISOString());
    // Like any save: a snapshot, and the caller watches the page from now on.
    expect((await versionsOf(target.id)).map((v: any) => [v.content, v.editor_id])).toEqual([[richStored, writerId]]);
    await until(async () => (await watchersOf(target.id)).length === 2);
    expect(await watchersOf(target.id)).toEqual(sorted([ownerId, writerId]));

    // Again, by slug id and by upper-case id.
    const second = await owner.post(`/pages/${target.slugId}/content`, { content: doc("two") });
    expect(second.body.data.page).toMatchObject({ docVersion: 2, content: doc("two"), lastEditor: { id: ownerId } });
    const third = await owner.post(`/pages/${target.id.toUpperCase()}/content`, { content: doc("three") });
    expect(third.body.data.page).toMatchObject({ docVersion: 3, content: doc("three") });
  });

  test("open editors and readers receive it as one step from the client \"server\"", async () => {
    const target = await page();
    const a = await open(writer);
    const r = await open(reader);
    await join(a, target.id, 0, "a");
    await join(r, target.id, 0, "r");
    const res = await owner.post(`/pages/${target.id}/content`, { content: rich });
    expect(res.status).toBe(200);
    const step = {
      t: "steps",
      pageId: target.id,
      version: 1,
      steps: [
        {
          stepType: "replace",
          from: 0,
          // "hello" in a paragraph.
          to: 7,
          slice: [
            { o: "heading", a: { id: null, level: 2, textAlign: null, indent: 0 } },
            { t: "Title" },
            { t: "d", m: [{ type: "bold" }] },
            { n: { type: "hardBreak" } },
            { c: 1 },
            { o: "paragraph" },
            { c: 1 },
            { o: "paragraph", a: {} },
            { t: "link", m: [{ type: "link", attrs: { href: "" } }] },
            { c: 1 },
            { n: { type: "horizontalRule", extra: "kept" } },
          ],
        },
      ],
      clientIds: ["server"],
    };
    expect(await a.next(about(target.id))).toEqual(step);
    expect(await r.next(about(target.id))).toEqual(step);
    // The session goes on: the editor types into the new document.
    expect((await sendSteps(a, target.id, 1, [insertText(1, "My ")], "a")).version).toBe(2);
    expect((await liveDoc(a, target.id)).doc.content[0].content[0]).toEqual(text("My Title"));
    // A second replacement covers the whole of the new document: 9 + 2 + 6 + 1 + the three typed characters.
    await owner.post(`/pages/${target.id}/content`, { content: doc("again") });
    expect(await r.nextOf("steps", { version: 3 })).toEqual({
      t: "steps",
      pageId: target.id,
      version: 3,
      steps: [{ stepType: "replace", from: 0, to: 21, slice: [{ o: "paragraph" }, { t: "again" }, { c: 1 }] }],
      clientIds: ["server"],
    });
  });

  test("steps an editor has not had saved yet are stored with it", async () => {
    const target = await page();
    const a = await open(writer);
    await join(a, target.id, 0, "a");
    await sendSteps(a, target.id, 0, [insertText(6, "!")], "a");
    const res = await owner.post(`/pages/${target.id}/content`, { content: doc("replaced") });
    expect(res.body.data.page).toMatchObject({ docVersion: 2, content: doc("replaced"), lastEditor: { id: ownerId } });
    const row = (await storedPage(t.sql, target.id))!;
    expect(row.doc_version).toBe(2);
    expect(sorted(row.contributor_ids)).toEqual(sorted([ownerId, writerId]));
  });

  test("a page without content is replaced from its empty paragraph", async () => {
    const target = await createPage(owner, spaceId);
    const a = await open(owner);
    await join(a, target.id, 0);
    expect((await owner.post(`/pages/${target.id}/content`, { content: doc("filled") })).status).toBe(200);
    expect((await a.nextOf("steps")).steps).toEqual([{ stepType: "replace", from: 0, to: 2, slice: [{ o: "paragraph" }, { t: "filled" }, { c: 1 }] }]);
  });

  test("watchers are notified as after any save", async () => {
    const title = unique("Imported");
    const target = await page(doc("hello"), { title });
    expect((await writer.post(`/pages/${target.id}/content`, { content: docOf(p("hi ", mention(readerId, "reader"))) })).status).toBe(200);
    await untilMail(title, 2);
    expect((await notificationsOf(target.id)).map((r: any) => [r.kind, r.user_id, r.actor_id])).toEqual([
      ["page.mention", readerId, writerId],
      ["page.updated", ownerId, writerId],
    ]);
  });

  test("needs a session, the page, and the right to write it", async () => {
    const target = await page();
    const anonymous = await t.client().post(`/pages/${target.id}/content`, { content: doc("x") });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ error: { code: "unauthorized", message: "Sign in required" } } as never);

    const asReader = await reader.post(`/pages/${target.id}/content`, { content: doc("x") });
    expect(asReader.status).toBe(403);
    expect(asReader.body).toEqual({ error: { code: "forbidden", message: "You do not have permission to do this" } } as never);
    // A reader is refused before the content is looked at.
    expect((await reader.post(`/pages/${target.id}/content`, { content: "nonsense" })).status).toBe(403);

    const outsider = await t.addMember(owner, "content-outsider@example.com");
    const notFound = { error: { code: "not_found", message: "Page not found" } };
    const asOutsider = await outsider.client.post(`/pages/${target.id}/content`, { content: doc("x") });
    expect(asOutsider.status).toBe(404);
    expect(asOutsider.body).toEqual(notFound as never);
    for (const ref of ["00000000-0000-4000-8000-000000000000", "0000000000", "not-a-page-id"]) {
      const res = await owner.post(`/pages/${ref}/content`, { content: doc("x") });
      expect([ref, res.status, res.body as unknown]).toEqual([ref, 404, notFound]);
    }

    expect((await owner.post(`/pages/${target.id}/delete`)).status).toBe(200);
    const trashed = await owner.post(`/pages/${target.id}/content`, { content: doc("x") });
    expect(trashed.status).toBe(404);
    expect(trashed.body).toEqual(notFound as never);
    expect((await storedPage(t.sql, target.id))!.content).toEqual(doc("hello"));
  });

  test("content that is a document but does not fit the schema is refused", async () => {
    const target = await page();
    const a = await open(owner);
    await join(a, target.id, 0);
    const misfits: [string, unknown][] = [
      ["text straight in the document", { type: "doc", content: [{ type: "text", text: "x" }] }],
      ["no blocks", { type: "doc" }],
      ["an empty list of blocks", { type: "doc", content: [] }],
      ["a paragraph in a paragraph", { type: "doc", content: [{ type: "paragraph", content: [{ type: "paragraph" }] }] }],
      ["a list item outside a list", { type: "doc", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] }],
      ["marked text in a code block", { type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: "x", marks: [{ type: "bold" }] }] }] }],
      ["footnotes first", { type: "doc", content: [{ type: "footnotes" }, { type: "paragraph" }] }],
    ];
    for (const [label, content] of misfits) {
      const res = await owner.post(`/pages/${target.id}/content`, { content });
      expect([label, res.status, res.body as unknown]).toEqual([label, 400, { error: { code: "invalid_input", message: "Content does not fit the document format" } }]);
    }
    // What the format check itself refuses has its own messages.
    for (const body of [{}, { content: null }, { content: "text" }, { content: [] }]) {
      const res = await owner.post(`/pages/${target.id}/content`, body);
      expect([body, res.status, res.body as unknown]).toEqual([body, 400, { error: { code: "invalid_input", message: "content has an invalid node" } }]);
    }
    const notDoc = await owner.post(`/pages/${target.id}/content`, { content: { type: "paragraph" } });
    expect(notDoc.body).toEqual({ error: { code: "invalid_input", message: "content must be a doc node" } } as never);
    const empty = await owner.raw("POST", `/pages/${target.id}/content`);
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: { code: "invalid_input", message: "content has an invalid node" } });

    // Nothing reached the open editor or the stored page.
    expect(await a.quiet(about(target.id), 150)).toBe(true);
    expect(await storedPage(t.sql, target.id)).toMatchObject({ doc_version: 0, content: doc("hello") });
    expect(await liveDoc(a, target.id)).toEqual({ version: 0, doc: doc("hello") });
  });

  test("a document of 2 000 000 positions is taken, one position more is refused", async () => {
    const target = await page();
    const sized = (chars: number) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(chars) }] }] });
    const tooLarge = await owner.post(`/pages/${target.id}/content`, { content: sized(1_999_999) });
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body).toEqual({ error: { code: "invalid_input", message: "content is too large" } } as never);
    const atLimit = await owner.post(`/pages/${target.id}/content`, { content: sized(1_999_998) });
    expect(atLimit.status).toBe(200);
    expect(atLimit.body.data.page.docVersion).toBe(1);
    expect(atLimit.body.data.page.content.content[0].content[0].text).toHaveLength(1_999_998);
  }, 20_000);

  test("a body of 8 MiB is read, a larger one is refused with 413", async () => {
    const target = await page();
    const limit = 8 * 1024 * 1024;
    const body = (bytes: number) => {
      const start = `{"content":${JSON.stringify(doc("padded"))},"pad":"`;
      return `${start}${"x".repeat(bytes - start.length - 2)}"}`;
    };
    const send = (bytes: number) => owner.raw("POST", `/pages/${target.id}/content`, { body: body(bytes), headers: { "Content-Type": "application/json" } });
    const over = await send(limit + 1);
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: { code: "payload_too_large", message: "Request body is too large" } });
    const at = await send(limit);
    expect(at.status).toBe(200);
    expect((await at.json()).data.page.content).toEqual(doc("padded"));
    // The body has to be JSON, and say so.
    const typed = await owner.raw("POST", `/pages/${target.id}/content`, { body: JSON.stringify({ content: doc("x") }), headers: { "Content-Type": "text/plain" } });
    expect(typed.status).toBe(415);
    expect(await typed.json()).toEqual({ error: { code: "unsupported_media_type", message: "Expected application/json" } });
    const malformed = await owner.raw("POST", `/pages/${target.id}/content`, { body: "{", headers: { "Content-Type": "application/json" } });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: { code: "invalid_input", message: "Malformed JSON" } });
  }, 20_000);

  test("when the page was stored at another version underneath its editors, it fails with 500 and resets them", async () => {
    const target = await page();
    const a = await open(writer);
    await join(a, target.id, 0);
    await t.sql`UPDATE pages SET content = ${doc("elsewhere")}::jsonb, doc_version = 7 WHERE id = ${target.id}`;
    const res = await owner.post(`/pages/${target.id}/content`, { content: doc("imported") });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "internal_error", message: "Something went wrong" } } as never);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The editor saw the replacement, then the reset.
    expect(await a.next(about(target.id))).toMatchObject({ t: "steps", version: 1, clientIds: ["server"] });
    expect(await a.next(about(target.id))).toEqual({ t: "error", pageId: target.id, message: ERRORS.changedElsewhere });
    expect(await a.next(about(target.id))).toEqual({ t: "joined", pageId: target.id, version: 7, doc: doc("elsewhere"), readOnly: false });
    expect(await storedPage(t.sql, target.id)).toMatchObject({ doc_version: 7, content: doc("elsewhere") });

    const logged = t.logEntries().filter((e) => e.msg === "request failed" && e.path === `/api/pages/${target.id}/content`);
    // A request that fails for a reason of the server's own is logged with its method and path, and why.
    expect(logged.map(errorEntry)).toEqual([{ t: expect.stringMatching(ISO), level: "error", msg: "request failed", method: "POST", path: `/api/pages/${target.id}/content` }]);
    // Tried again, it goes through on top of what is stored.
    const again = await owner.post(`/pages/${target.id}/content`, { content: doc("imported") });
    expect(again.body.data.page).toMatchObject({ docVersion: 8, content: doc("imported") });
  });
});
