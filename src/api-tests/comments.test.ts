import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { doc, startServer, type Client, type TestServer } from "./harness";
import {
  NO_SUCH_ID,
  anyId,
  anyTime,
  createPage,
  createSpace,
  data,
  docOf,
  expectError,
  expectForbidden,
  expectInvalid,
  expectNotFound,
  expectUnauthorized,
  memberRow,
  paragraph,
  person,
  text,
  userRef,
  type Person,
} from "./harness/spaces-pages";
import { joinPage, openSocket, takeEvents } from "./harness/spaces-pages-ws";

let t: TestServer;
let owner: Client;
let ownerUser: any;
let team: any;
let spaceAdmin: Person;
let writer: Person;
let other: Person;
let reader: Person;
let outsider: Person;

const newPage = (title = "Discussed") => createPage(owner, { spaceId: team.id, title });
const comment = async (client: Client, body: Record<string, unknown>) => data(await client.post("/comments", body)).comment;
const say = (client: Client, pageId: string, words: string, extra: Record<string, unknown> = {}) => comment(client, { pageId, body: doc(words), ...extra });
const listed = async (client: Client, pageId: string) => data(await client.get(`/pages/${pageId}/comments`)) as any[];

/** A comment as created, with nothing optional set. */
const shape = (pageId: string, author: any, words: string, overrides: Record<string, unknown> = {}) => ({
  id: anyId(),
  pageId,
  parentId: null,
  author: userRef(author),
  body: doc(words),
  quote: null,
  anchored: false,
  createdAt: anyTime(),
  editedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  ...overrides,
});

beforeAll(async () => {
  t = await startServer();
  ({ owner, user: ownerUser } = await t.setupOwner());
  team = await createSpace(owner, "Team", "team");
  spaceAdmin = await person(t, owner, "space-admin@example.com", { space: team.id, spaceRole: "admin" });
  writer = await person(t, owner, "writer@example.com", { space: team.id, spaceRole: "writer" });
  other = await person(t, owner, "other@example.com", { space: team.id, spaceRole: "writer" });
  reader = await person(t, owner, "reader@example.com", { space: team.id, spaceRole: "reader" });
  outsider = await person(t, owner, "outsider@example.com");
});

afterAll(async () => {
  await t.close();
});

describe("without a session", () => {
  test("every comment endpoint answers 401", async () => {
    const page = await newPage();
    const c = await say(owner, page.id, "hello");
    const anonymous = t.client();
    expectUnauthorized(await anonymous.get(`/pages/${page.id}/comments`));
    for (const path of ["/comments", `/comments/${c.id}/update`, `/comments/${c.id}/resolve`, `/comments/${c.id}/delete`]) {
      expectUnauthorized(await anonymous.post(path, { pageId: page.id, body: doc("x"), resolved: true }));
    }
    expect(await listed(owner, page.id)).toHaveLength(1);
  });
});

describe("POST /comments", () => {
  test("adds a comment to a page", async () => {
    const page = await newPage();
    expect(await listed(owner, page.id)).toEqual([]);
    const res = await writer.client.post("/comments", { pageId: page.id.toUpperCase(), body: doc("First!") });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { comment: shape(page.id, writer.user, "First!") } });
    const list = await reader.client.get(`/pages/${page.slugId}/comments`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ data: [res.body.data.comment] });
    const [row] = await t.sql`SELECT author_id, resolved_by, updated_at = created_at AS untouched FROM comments WHERE id = ${res.body.data.comment.id}`;
    expect(row).toEqual({ author_id: writer.id, resolved_by: null, untouched: true });
  });

  test("with a quote and an anchor", async () => {
    const page = await newPage();
    const c = await comment(owner, { pageId: page.id, body: doc("About this"), quote: "  the quoted\n  words  ", anchored: true, extra: "ignored", author: writer.id, resolvedAt: "2020-01-01" });
    expect(c).toEqual(shape(page.id, ownerUser, "About this", { quote: "the quoted\n  words", anchored: true }));
    for (const quote of [null, "", "   "]) expect((await comment(owner, { pageId: page.id, body: doc("x"), quote })).quote).toBeNull();
    for (const quote of ["é😀".repeat(1000), "引用".repeat(1000), "<i>&amp;</i>"]) expect((await comment(owner, { pageId: page.id, body: doc("x"), quote })).quote).toBe(quote);
    expectInvalid(await owner.post("/comments", { pageId: page.id, body: doc("x"), quote: "q".repeat(2001) }), "quote must be at most 2000 characters");
    expectInvalid(await owner.post("/comments", { pageId: page.id, body: doc("x"), quote: 5 }), "quote must be a string");
    for (const [anchored, stored] of [[false, false], ["true", true], ["1", true], ["false", false], ["0", false], ["", false]] as const) {
      expect((await comment(owner, { pageId: page.id, body: doc("x"), anchored })).anchored).toBe(stored);
    }
    for (const anchored of [1, 0, null, "yes", []]) expectInvalid(await owner.post("/comments", { pageId: page.id, body: doc("x"), anchored }), "anchored must be a boolean");
  });

  test("the body is a document: validated, made safe and kept as sent", async () => {
    const page = await newPage();
    const body = docOf(
      paragraph(
        text("Rich ", [{ type: "bold" }, { type: "italic" }]),
        { type: "mention", attrs: { entityType: "user", entityId: reader.id, label: "reader" } },
        text(" link", [{ type: "link", attrs: { href: "https://example.com/" } }]),
        text(" bad", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
      ),
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("第二 🎉"))] }] },
      { type: "image", attrs: { src: "data:image/png;base64,AAAA" } },
      { type: "pdf", attrs: { src: " vbscript:x" } },
    );
    const c = await comment(owner, { pageId: page.id, body });
    const stored = JSON.parse(JSON.stringify(body));
    stored.content[0].content[3].marks[0].attrs.href = "";
    stored.content[3].attrs.src = "";
    expect(c.body).toEqual(stored);
    expect((await listed(owner, page.id))[0].body).toEqual(stored);

    const post = (value: unknown) => owner.post("/comments", { pageId: page.id, body: value });
    for (const value of [undefined, null, "text", 5, []]) expectInvalid(await post(value), "body has an invalid node");
    expectInvalid(await post({ type: "nope" }), "body has an unknown node type");
    expectInvalid(await post(docOf({ type: "paragraph", attrs: 1 })), "body has invalid attributes");
    expectInvalid(await post(docOf(paragraph({ type: "text", text: 1 }))), "body has invalid text");
    expectInvalid(await post(docOf(paragraph({ type: "text", text: "x", marks: "bold" }))), "body has invalid marks");
    expectInvalid(await post(docOf(paragraph({ type: "text", text: "x", marks: [{ type: "nope" }] }))), "body has an unknown mark");
    expectInvalid(await post({ type: "doc", content: "x" }), "body has invalid content");
    expectInvalid(await post(paragraph(text("not a doc"))), "body must be a doc node");
    let deep: unknown = paragraph(text("deep"));
    for (let i = 0; i < 100; i++) deep = { type: "blockquote", content: [deep] };
    expectInvalid(await post(docOf(deep)), "body is nested too deeply");
    expect(await listed(owner, page.id)).toHaveLength(1);
  });

  test("a comment needs some text", async () => {
    const page = await newPage();
    const post = (body: unknown) => owner.post("/comments", { pageId: page.id, body });
    for (const body of [
      { type: "doc" },
      docOf(),
      docOf(paragraph()),
      docOf(paragraph(text(""))),
      docOf(paragraph(text("   ")), paragraph(text("\n\t"))),
      docOf(paragraph({ type: "hardBreak" })),
      docOf({ type: "image", attrs: { src: "/x.png", alt: "words that are not text" } }),
      docOf(paragraph({ type: "mention", attrs: { entityType: "user", entityId: reader.id } })),
      docOf({ type: "horizontalRule" }),
    ]) {
      expectInvalid(await post(body), "Comment cannot be empty");
    }
    // What reads as text is enough: a mention's label, a file name, a formula.
    for (const body of [
      docOf(paragraph({ type: "mention", attrs: { entityType: "user", entityId: reader.id, label: "reader" } })),
      docOf({ type: "attachment", attrs: { url: "/x", name: "file.zip" } }),
      docOf({ type: "mathBlock", attrs: { text: "x" } }),
      docOf(paragraph(text(" . "))),
      docOf(paragraph(text("👍"))),
    ]) {
      expect((await post(body)).status).toBe(200);
    }
    expect(await listed(owner, page.id)).toHaveLength(5);
  });

  test("needs a writer on a page that is not in the trash", async () => {
    const page = await newPage();
    for (const pageId of [undefined, null, "", "nope", page.slugId, 5]) {
      expectInvalid(await owner.post("/comments", { pageId, body: doc("x") }), "pageId must be a valid id");
    }
    expectNotFound(await owner.post("/comments", { pageId: NO_SUCH_ID, body: doc("x") }), "Page");
    expectNotFound(await outsider.client.post("/comments", { pageId: page.id, body: doc("x") }), "Page");
    expectForbidden(await reader.client.post("/comments", { pageId: page.id, body: doc("x") }));
    // The page is checked before the body.
    expectForbidden(await reader.client.post("/comments", { pageId: page.id }));
    expectNotFound(await outsider.client.post("/comments", { pageId: page.id, body: "bad" }), "Page");
    expect((await say(spaceAdmin.client, page.id, "admins too")).author).toEqual(userRef(spaceAdmin.user));
    data(await owner.post(`/pages/${page.id}/delete`));
    expectNotFound(await owner.post("/comments", { pageId: page.id, body: doc("x") }), "Page");
    // Readers still see the comments of a trashed page.
    expect((await listed(reader.client, page.id)).map((c) => c.body)).toEqual([doc("admins too")]);
  });

  test("a NUL character in the quote is a server error", async () => {
    const page = await newPage();
    // Accident: PostgreSQL refuses the character and the failure surfaces as a 500.
    expectError(await owner.post("/comments", { pageId: page.id, body: doc("x"), quote: "a\u0000b" }), 500, "internal_error", "Something went wrong");
  });
});

describe("replies", () => {
  test("a reply hangs under the top-level comment, also when it answers another reply", async () => {
    const page = await newPage();
    const top = await say(owner, page.id, "Top");
    const first = await comment(writer.client, { pageId: page.id, parentId: top.id.toUpperCase(), body: doc("Reply"), anchored: true, quote: "quoted in a reply" });
    // Only top-level comments are anchored; a reply keeps its quote.
    expect(first).toEqual(shape(page.id, writer.user, "Reply", { parentId: top.id, quote: "quoted in a reply", anchored: false }));
    const second = await comment(other.client, { pageId: page.id, parentId: first.id, body: doc("Reply to the reply") });
    expect(second.parentId).toBe(top.id);
    const another = await say(owner, page.id, "Another top", { parentId: null });
    const blank = await say(owner, page.id, "Blank parent", { parentId: "" });
    expect([another.parentId, blank.parentId]).toEqual([null, null]);
    // Listed flat, oldest first.
    expect((await listed(owner, page.id)).map((c) => [c.body.content[0].content[0].text, c.parentId])).toEqual([
      ["Top", null],
      ["Reply", top.id],
      ["Reply to the reply", top.id],
      ["Another top", null],
      ["Blank parent", null],
    ]);
  });

  test("the parent must be a comment of the same page", async () => {
    const page = await newPage();
    const elsewhere = await newPage("Elsewhere");
    const foreign = await say(owner, elsewhere.id, "On another page");
    const reply = (parentId: unknown) => owner.post("/comments", { pageId: page.id, parentId, body: doc("x") });
    for (const parentId of ["nope", 5, {}]) expectInvalid(await reply(parentId), "parentId must be a valid id");
    expectNotFound(await reply(NO_SUCH_ID), "Parent comment");
    expectNotFound(await reply(foreign.id), "Parent comment");
    expectNotFound(await reply(page.id), "Parent comment");
    expect(await listed(owner, page.id)).toEqual([]);
  });

  test("comments made at the same moment are listed by id", async () => {
    const page = await newPage();
    const made = [await say(owner, page.id, "a"), await say(owner, page.id, "b"), await say(owner, page.id, "c")];
    await t.sql`UPDATE comments SET created_at = '2025-02-02T02:02:02Z' WHERE page_id = ${page.id}`;
    expect((await listed(owner, page.id)).map((c) => c.id)).toEqual(made.map((c) => c.id).sort());
    expect((await listed(owner, page.id))[0].createdAt).toBe("2025-02-02T02:02:02.000Z");
  });
});

describe("GET /pages/:id/comments", () => {
  test("needs read access to the page", async () => {
    const page = await newPage();
    await say(owner, page.id, "visible to members");
    for (const who of [spaceAdmin, writer, reader]) expect(await listed(who.client, page.id)).toHaveLength(1);
    expectNotFound(await outsider.client.get(`/pages/${page.id}/comments`), "Page");
    expectNotFound(await owner.get(`/pages/${NO_SUCH_ID}/comments`), "Page");
    expectNotFound(await owner.get("/pages/not-a-page/comments"), "Page");
  });

  test("the author is null once that user is deleted, and so is the resolver", async () => {
    const page = await newPage();
    const temp = await person(t, owner, "temp-commenter@example.com", { space: team.id, spaceRole: "writer" });
    const theirs = await say(temp.client, page.id, "I will be gone");
    const mine = await say(owner, page.id, "Resolved by someone who leaves");
    const resolved = data(await temp.client.post(`/comments/${mine.id}/resolve`, { resolved: true })).comment;
    data(await owner.post("/members/delete", { userId: temp.id }));
    expect(await listed(owner, page.id)).toEqual([
      { ...theirs, author: null },
      { ...resolved, resolvedBy: null },
    ]);
    expect(resolved.resolvedAt).toMatch(/Z$/);
  });
});

describe("POST /comments/:id/update", () => {
  test("the author rewrites the body; nothing else changes", async () => {
    const page = await newPage();
    const c = await comment(writer.client, { pageId: page.id, body: doc("Frist"), quote: "q", anchored: true });
    const res = await writer.client.post(`/comments/${c.id.toUpperCase()}/update`, { body: doc("First"), quote: "changed?", anchored: false, pageId: NO_SUCH_ID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { comment: { ...c, body: doc("First"), editedAt: anyTime() } } });
    expect(await listed(owner, page.id)).toEqual([res.body.data.comment]);
    // Edited again, the time moves on.
    await t.sql`UPDATE comments SET edited_at = '2020-01-01T00:00:00Z' WHERE id = ${c.id}`;
    const again = data(await writer.client.post(`/comments/${c.id}/update`, { body: docOf(paragraph(text("x", [{ type: "link", attrs: { href: "javascript:x" } }]))) })).comment;
    expect(Date.parse(again.editedAt)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
    expect(again.body).toEqual(docOf(paragraph(text("x", [{ type: "link", attrs: { href: "" } }]))));
  });

  test("the body is validated as at creation", async () => {
    const page = await newPage();
    const c = await say(owner, page.id, "Original");
    const update = (body: unknown) => owner.post(`/comments/${c.id}/update`, { body });
    expectInvalid(await owner.post(`/comments/${c.id}/update`, {}), "body has an invalid node");
    expectInvalid(await update(null), "body has an invalid node");
    expectInvalid(await update(paragraph(text("x"))), "body must be a doc node");
    expectInvalid(await update(docOf({ type: "nope" })), "body has an unknown node type");
    expectInvalid(await update(doc("  ")), "Comment cannot be empty");
    expect((await listed(owner, page.id))[0]).toEqual(c);
  });

  test("only the author may edit, whatever their role is now", async () => {
    const space = await createSpace(owner, "Edit rights", "edit-rights");
    const author = await person(t, owner, "comment-author@example.com", { space: space.id, spaceRole: "writer" });
    const admin = await person(t, owner, "comment-admin@example.com", { space: space.id, spaceRole: "admin" });
    const page = await createPage(owner, { spaceId: space.id, title: "Edit rights" });
    const c = await say(author.client, page.id, "Mine");
    const message = "Only the author can edit a comment";
    expectForbidden(await owner.post(`/comments/${c.id}/update`, { body: doc("hijacked") }), message);
    expectForbidden(await admin.client.post(`/comments/${c.id}/update`, { body: doc("hijacked") }), message);
    // Authorship is checked before the body.
    expectForbidden(await admin.client.post(`/comments/${c.id}/update`, { body: "bad" }), message);
    expectNotFound(await outsider.client.post(`/comments/${c.id}/update`, { body: doc("hijacked") }), "Page");
    expectNotFound(await author.client.post(`/comments/${NO_SUCH_ID}/update`, { body: doc("x") }), "Comment");
    expectNotFound(await author.client.post("/comments/nope/update", { body: doc("x") }), "Comment");
    expectNotFound(await author.client.post(`/comments/${page.id}/update`, { body: doc("x") }), "Comment");
    // Demoted to reader, the author still edits; so they do on a page in the trash.
    data(await owner.post(`/spaces/${space.id}/members/role`, { memberId: await memberRow(owner, space.id, author.id), role: "reader" }));
    expect(data(await author.client.post(`/comments/${c.id}/update`, { body: doc("Still mine") })).comment.body).toEqual(doc("Still mine"));
    data(await owner.post(`/pages/${page.id}/delete`));
    expect(data(await author.client.post(`/comments/${c.id}/update`, { body: doc("Even now") })).comment.body).toEqual(doc("Even now"));
    // Without access to the page, not even the author.
    data(await owner.post(`/spaces/${space.id}/members/remove`, { memberId: await memberRow(owner, space.id, author.id) }));
    expectNotFound(await author.client.post(`/comments/${c.id}/update`, { body: doc("locked out") }), "Page");
  });
});

describe("POST /comments/:id/resolve", () => {
  test("a writer resolves a top-level comment and opens it again", async () => {
    const page = await newPage();
    const c = await say(owner, page.id, "To resolve");
    const res = await writer.client.post(`/comments/${c.id}/resolve`, { resolved: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { comment: { ...c, resolvedAt: anyTime(), resolvedBy: userRef(writer.user) } } });
    const first = res.body.data.comment;
    // Resolved again by someone else: the time stays, the name changes.
    await t.sql`UPDATE comments SET resolved_at = '2025-03-03T03:03:03Z' WHERE id = ${c.id}`;
    const second = data(await other.client.post(`/comments/${c.id.toUpperCase()}/resolve`, { resolved: "true" })).comment;
    expect(second).toEqual({ ...c, resolvedAt: "2025-03-03T03:03:03.000Z", resolvedBy: userRef(other.user) });
    const reopened = data(await spaceAdmin.client.post(`/comments/${c.id}/resolve`, { resolved: false })).comment;
    expect(reopened).toEqual(c);
    expect(data(await owner.post(`/comments/${c.id}/resolve`, { resolved: "0" })).comment).toEqual(c);
    expect(await listed(reader.client, page.id)).toEqual([c]);
    expect(first.editedAt).toBeNull();
  });

  test("replies cannot be resolved, and resolved must be a boolean", async () => {
    const page = await newPage();
    const top = await say(owner, page.id, "Top");
    const reply = await say(owner, page.id, "Reply", { parentId: top.id });
    expectInvalid(await owner.post(`/comments/${reply.id}/resolve`, { resolved: true }), "Only top-level comments can be resolved");
    // That is said before the body is looked at.
    expectInvalid(await owner.post(`/comments/${reply.id}/resolve`, {}), "Only top-level comments can be resolved");
    expectInvalid(await owner.post(`/comments/${top.id}/resolve`, {}), "resolved is required");
    for (const resolved of [null, 1, "yes", []]) expectInvalid(await owner.post(`/comments/${top.id}/resolve`, { resolved }), "resolved must be a boolean");
    expect(await listed(owner, page.id)).toEqual([top, reply]);
  });

  test("needs a writer on a page that is not in the trash", async () => {
    const page = await newPage();
    const top = await say(owner, page.id, "Top");
    const reply = await say(owner, page.id, "Reply", { parentId: top.id });
    expectForbidden(await reader.client.post(`/comments/${top.id}/resolve`, { resolved: true }));
    // The role is checked before anything about the comment or the body.
    expectForbidden(await reader.client.post(`/comments/${reply.id}/resolve`, {}));
    expectNotFound(await outsider.client.post(`/comments/${top.id}/resolve`, { resolved: true }), "Page");
    expectNotFound(await owner.post(`/comments/${NO_SUCH_ID}/resolve`, { resolved: true }), "Comment");
    expectNotFound(await owner.post("/comments/nope/resolve", { resolved: true }), "Comment");
    data(await owner.post(`/pages/${page.id}/delete`));
    expectNotFound(await owner.post(`/comments/${top.id}/resolve`, { resolved: true }), "Page");
    expect((await listed(owner, page.id))[0].resolvedAt).toBeNull();
  });
});

describe("POST /comments/:id/delete", () => {
  test("the author deletes their comment; a top-level comment takes its replies along", async () => {
    const page = await newPage();
    const top = await say(writer.client, page.id, "Top");
    const reply = await say(other.client, page.id, "Reply", { parentId: top.id });
    const reply2 = await say(owner, page.id, "Second reply", { parentId: top.id });
    const bystander = await say(owner, page.id, "Bystander");
    // A reply goes alone.
    const one = await other.client.post(`/comments/${reply.id.toUpperCase()}/delete`);
    expect(one.status).toBe(200);
    expect(one.body).toEqual({ data: {} });
    expect((await listed(owner, page.id)).map((c) => c.id)).toEqual([top.id, reply2.id, bystander.id]);
    expect(data(await writer.client.post(`/comments/${top.id}/delete`))).toEqual({});
    expect(await listed(owner, page.id)).toEqual([bystander]);
    expectNotFound(await writer.client.post(`/comments/${top.id}/delete`), "Comment");
    expectNotFound(await owner.post(`/comments/${reply2.id}/delete`), "Comment");
  });

  test("besides the author only a space admin may delete", async () => {
    const space = await createSpace(owner, "Delete rights", "delete-rights");
    const author = await person(t, owner, "delete-author@example.com", { space: space.id, spaceRole: "writer" });
    const peer = await person(t, owner, "delete-peer@example.com", { space: space.id, spaceRole: "writer" });
    const admin = await person(t, owner, "delete-admin@example.com", { space: space.id, spaceRole: "admin" });
    // A workspace admin who is only a writer in the space has no say.
    const wsAdmin = await person(t, owner, "delete-ws-admin@example.com", { role: "admin", space: space.id, spaceRole: "writer" });
    const lurker = await person(t, owner, "delete-lurker@example.com", { space: space.id, spaceRole: "reader" });
    const page = await createPage(owner, { spaceId: space.id, title: "Delete rights" });
    const a = await say(author.client, page.id, "A");
    const b = await say(author.client, page.id, "B");
    const c = await say(author.client, page.id, "C");
    const message = "Only the author or a space admin can delete a comment";
    for (const who of [peer, wsAdmin, lurker]) expectForbidden(await who.client.post(`/comments/${a.id}/delete`), message);
    expectNotFound(await outsider.client.post(`/comments/${a.id}/delete`), "Page");
    expectNotFound(await author.client.post(`/comments/${NO_SUCH_ID}/delete`), "Comment");
    expectNotFound(await author.client.post("/comments/nope/delete"), "Comment");
    expect(data(await admin.client.post(`/comments/${a.id}/delete`))).toEqual({});
    expect(data(await owner.post(`/comments/${b.id}/delete`))).toEqual({});
    // A reader deletes their own comment, also on a page in the trash.
    data(await owner.post(`/spaces/${space.id}/members/role`, { memberId: await memberRow(owner, space.id, author.id), role: "reader" }));
    data(await owner.post(`/pages/${page.id}/delete`));
    expect(data(await author.client.post(`/comments/${c.id}/delete`))).toEqual({});
    expect(await listed(owner, page.id)).toEqual([]);
  });
});

describe("the comments event", () => {
  test("every change to a page's comments is announced to the sockets that joined the page", async () => {
    const page = await newPage("Live comments");
    const elsewhere = await newPage("Not this one");
    const joined = await openSocket(reader.client);
    const actor = await openSocket(writer.client);
    const notJoined = await openSocket(other.client);
    const onAnotherPage = await openSocket(owner);
    expect(await joinPage(joined, page.id)).toEqual({ t: "joined", pageId: page.id, version: 0, readOnly: true });
    expect((await joinPage(actor, page.id)).readOnly).toBe(false);
    expect((await joinPage(onAnotherPage, elsewhere.id)).t).toBe("joined");
    const event = { t: "event", kind: "comments", pageId: page.id };
    // Notification events reach the people notified at their own pace; they are not what is looked at here.
    const heard = async (socket: (typeof joined)) => (await takeEvents(socket)).filter((e) => e.kind !== "notification");
    const expectAnnounced = async (times = 1) => {
      // The one who made the change hears it too.
      for (const socket of [joined, actor]) expect(await heard(socket)).toEqual(Array(times).fill(event));
      for (const socket of [notJoined, onAnotherPage]) expect(await heard(socket)).toEqual([]);
    };
    const c = await say(writer.client, page.id, "Created");
    await expectAnnounced();
    await say(other.client, page.id, "A reply", { parentId: c.id });
    await expectAnnounced();
    data(await writer.client.post(`/comments/${c.id}/update`, { body: doc("Edited") }));
    await expectAnnounced();
    data(await other.client.post(`/comments/${c.id}/resolve`, { resolved: true }));
    data(await other.client.post(`/comments/${c.id}/resolve`, { resolved: false }));
    await expectAnnounced(2);
    data(await writer.client.post(`/comments/${c.id}/delete`));
    await expectAnnounced();
    // Refused requests announce nothing.
    expectInvalid(await writer.client.post("/comments", { pageId: page.id, body: doc(" ") }), "Comment cannot be empty");
    expectForbidden(await reader.client.post("/comments", { pageId: page.id, body: doc("x") }));
    expectNotFound(await writer.client.post(`/comments/${c.id}/delete`), "Comment");
    await expectAnnounced(0);
    // After leaving the page a socket hears no more.
    joined.send({ t: "leave", pageId: page.id });
    await say(writer.client, page.id, "After leaving");
    expect(await heard(actor)).toEqual([event]);
    expect(await heard(joined)).toEqual([]);
    await Promise.all([joined, actor, notJoined, onAnotherPage].map((socket) => socket.close()));
  });
});
