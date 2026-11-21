import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { doc, startServer, type Client, type TestServer } from "./harness";
import {
  NO_SUCH_ID,
  SLUG_ID_RE,
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
  paragraph,
  person,
  spaceRef,
  text,
  titles,
  treeItem,
  userRef,
  type Person,
} from "./harness/spaces-pages";
import { openSocket, takeEvents, treeEvent } from "./harness/spaces-pages-ws";

let t: TestServer;
let owner: Client;
let ownerUser: any;
let generalId: string;
let general: any;
/** The space most tests work in: the owner is its admin. */
let team: any;
let spaceAdmin: Person;
let writer: Person;
let reader: Person;
/** A member of the workspace with no access to `team`. */
let outsider: Person;
/** A workspace admin with no access to `team`. */
let wsAdmin: Person;

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph", attrs: { id: null, textAlign: null, indent: 0 } }] };

/** The whole `page` object of a page the owner just created with default values. */
const newPage = (overrides: Record<string, unknown> = {}) => ({
  id: anyId(),
  slugId: expect.stringMatching(SLUG_ID_RE),
  title: null,
  icon: null,
  parentId: null,
  spaceId: team.id,
  position: expect.any(String),
  hasChildren: false,
  isBase: false,
  cover: null,
  content: EMPTY_DOC,
  docVersion: 0,
  creator: userRef(ownerUser),
  lastEditor: userRef(ownerUser),
  contributors: [userRef(ownerUser)],
  createdAt: anyTime(),
  updatedAt: anyTime(),
  deletedAt: null,
  ...overrides,
});

const pageMention = (attrs: Record<string, unknown>) => ({ type: "mention", attrs: { entityType: "page", ...attrs } });

beforeAll(async () => {
  t = await startServer();
  ({ owner, user: ownerUser, spaceId: generalId } = await t.setupOwner());
  general = data(await owner.get(`/spaces/${generalId}`)).space;
  team = await createSpace(owner, "Team", "team");
  spaceAdmin = await person(t, owner, "space-admin@example.com", { space: team.id, spaceRole: "admin" });
  writer = await person(t, owner, "writer@example.com", { space: team.id, spaceRole: "writer" });
  reader = await person(t, owner, "reader@example.com", { space: team.id, spaceRole: "reader" });
  outsider = await person(t, owner, "outsider@example.com");
  wsAdmin = await person(t, owner, "ws-admin@example.com", { role: "admin" });
  team = data(await owner.get(`/spaces/${team.id}`)).space;
});

afterAll(async () => {
  await t.close();
});

describe("without a session", () => {
  test("every page endpoint answers 401", async () => {
    const anonymous = t.client();
    const page = await createPage(owner, { spaceId: team.id });
    for (const path of [
      `/spaces/${team.id}/pages`,
      "/pages/recent",
      `/pages/${page.id}`,
      `/pages/${page.slugId}`,
      `/spaces/${team.id}/trash`,
      `/pages/${page.id}/versions`,
      `/versions/${NO_SUCH_ID}`,
      `/pages/${page.id}/files`,
      `/pages/${page.id}/backlinks`,
      `/pages/${page.id}/links`,
    ]) {
      expectUnauthorized(await anonymous.get(path));
    }
    for (const path of [
      "/pages",
      `/pages/${page.id}/update`,
      `/pages/${page.id}/move`,
      `/pages/${page.id}/move-to-space`,
      `/pages/${page.id}/duplicate`,
      `/pages/${page.id}/delete`,
      `/pages/${page.id}/restore`,
      `/pages/${page.id}/delete-permanently`,
      "/synced-blocks/lookup",
    ]) {
      expectUnauthorized(await anonymous.post(path, {}));
    }
    expect(data(await owner.get(`/pages/${page.id}`)).page.deletedAt).toBeNull();
  });
});

describe("POST /pages", () => {
  test("with only a space: an untitled root page holding an empty paragraph", async () => {
    const res = await owner.post("/pages", { spaceId: team.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { page: newPage() } });
    const page = res.body.data.page;
    expect(page.updatedAt).toBe(page.createdAt);
    const [row] = await t.sql`
      SELECT text_content, creator_id, last_editor_id, contributor_ids::text[] AS contributor_ids, deleted_by, cover FROM pages WHERE id = ${page.id}`;
    expect(row).toEqual({ text_content: "", creator_id: ownerUser.id, last_editor_id: ownerUser.id, contributor_ids: [ownerUser.id], deleted_by: null, cover: null });
  });

  test("with every field", async () => {
    const parent = await createPage(owner, { spaceId: team.id, title: "Parent" });
    const first = await createPage(owner, { spaceId: team.id, parentId: parent.id, title: "First" });
    await createPage(owner, { spaceId: team.id, parentId: parent.id, title: "Last" });
    const content = docOf({ type: "heading", attrs: { level: 2 }, content: [text("Plan")] }, paragraph(text("Ship it "), text("soon", [{ type: "bold" }])));
    const res = await writer.client.post("/pages", {
      spaceId: team.id.toUpperCase(),
      parentId: parent.id.toUpperCase(),
      afterId: first.id.toUpperCase(),
      title: "  Roadmap 2026  ",
      icon: " 🗺️ ",
      content,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        page: newPage({
          title: "Roadmap 2026",
          icon: "🗺️",
          parentId: parent.id,
          position: "a0V",
          content,
          creator: userRef(writer.user),
          lastEditor: userRef(writer.user),
          contributors: [userRef(writer.user)],
        }),
      },
    });
    expect(titles(await owner.get(`/spaces/${team.id}/pages?parentId=${parent.id}`))).toEqual(["First", "Roadmap 2026", "Last"]);
    const [row] = await t.sql`SELECT text_content FROM pages WHERE id = ${res.body.data.page.id}`;
    expect(row.text_content).toBe("Plan\nShip it soon");
  });

  test("title and icon: absent, null and blank are stored as null; otherwise trimmed and kept", async () => {
    const create = (body: Record<string, unknown>) => owner.post("/pages", { spaceId: team.id, ...body });
    for (const value of [null, "", "   ", "\n\t"]) {
      expect(data(await create({ title: value, icon: value })).page).toMatchObject({ title: null, icon: null });
    }
    for (const title of ["Été à Zürich", "été", "東京の計画", "خطة المشروع", "🎉🎊 party 👨‍👩‍👧‍👦", "<b>bold</b> & \"quotes\"", "a\tb\nc", "😀".repeat(500), "x".repeat(500)]) {
      expect(data(await create({ title })).page.title).toBe(title);
    }
    expect(data(await create({ title: `  ${"y".repeat(500)}  ` })).page.title).toBe("y".repeat(500));
    expectInvalid(await create({ title: "x".repeat(501) }), "title must be at most 500 characters");
    expectInvalid(await create({ title: "😀".repeat(501) }), "title must be at most 500 characters");
    for (const title of [5, true, ["a"], { a: 1 }]) expectInvalid(await create({ title }), "title must be a string");
    for (const icon of ["📄", "👩‍💻", "star", "i".repeat(100), "😀".repeat(100)]) {
      expect(data(await create({ icon })).page.icon).toBe(icon);
    }
    expectInvalid(await create({ icon: "i".repeat(101) }), "icon must be at most 100 characters");
    expectInvalid(await create({ icon: 1 }), "icon must be a string");
  });

  test("content: absent and null give the empty document; anything else must be a document", async () => {
    expect(data(await owner.post("/pages", { spaceId: team.id, content: null })).page.content).toEqual(EMPTY_DOC);
    const sent = doc("One", "", "Two");
    const page = data(await owner.post("/pages", { spaceId: team.id, content: sent })).page;
    expect(page.content).toEqual(sent);
    expect(page.docVersion).toBe(0);
    expect(data(await owner.get(`/pages/${page.id}`)).page.content).toEqual(sent);
    expectInvalid(await owner.post("/pages", { spaceId: team.id, content: "text" }), "content has an invalid node");
    expectInvalid(await owner.post("/pages", { spaceId: team.id, content: paragraph(text("not a doc")) }), "content must be a doc node");
  });

  test("the space is required, and the user must be a writer in it", async () => {
    for (const spaceId of [undefined, null, "", "general", team.slug, 5, [team.id], `${team.id}x`]) {
      expectInvalid(await owner.post("/pages", { spaceId, title: "Nowhere" }), "spaceId must be a valid id");
    }
    expectNotFound(await owner.post("/pages", { spaceId: NO_SUCH_ID }), "Space");
    expectNotFound(await outsider.client.post("/pages", { spaceId: team.id }), "Space");
    // Workspace admins manage spaces, but they need membership to write in them.
    expectNotFound(await wsAdmin.client.post("/pages", { spaceId: team.id }), "Space");
    expectForbidden(await reader.client.post("/pages", { spaceId: team.id }));
    expect(data(await writer.client.post("/pages", { spaceId: team.id })).page.creator).toEqual(userRef(writer.user));
    expect(data(await spaceAdmin.client.post("/pages", { spaceId: team.id })).page.creator).toEqual(userRef(spaceAdmin.user));
    // Membership is checked before the rest of the body.
    expectNotFound(await outsider.client.post("/pages", { spaceId: team.id, title: 5, parentId: "x" }), "Space");
    expectForbidden(await reader.client.post("/pages", { spaceId: team.id, content: "bad" }));
  });

  test("the parent must be a page of that space that is not in the trash", async () => {
    const parent = await createPage(owner, { spaceId: team.id, title: "A parent" });
    const elsewhere = await createPage(owner, { spaceId: generalId, title: "In General" });
    const trashed = await createPage(owner, { spaceId: team.id, title: "Trashed parent" });
    data(await owner.post(`/pages/${trashed.id}/delete`));
    const create = (parentId: unknown) => owner.post("/pages", { spaceId: team.id, parentId });
    for (const parentId of ["nope", 7, parent.slugId, {}]) expectInvalid(await create(parentId), "parentId must be a valid id");
    expectNotFound(await create(NO_SUCH_ID), "Parent page");
    expectNotFound(await create(elsewhere.id), "Parent page");
    expectNotFound(await create(trashed.id), "Parent page");
    // null and "" mean a root page.
    expect(data(await create(null)).page.parentId).toBeNull();
    expect(data(await create("")).page.parentId).toBeNull();
    const child = data(await create(parent.id)).page;
    expect(child).toMatchObject({ parentId: parent.id, position: "a0" });
    expect(data(await owner.get(`/pages/${parent.id}`)).page.hasChildren).toBe(true);
  });

  test("afterId places the page right after that sibling; absent, null and \"\" place it last", async () => {
    const parent = await createPage(owner, { spaceId: team.id, title: "Ordered" });
    const other = await createPage(owner, { spaceId: team.id, title: "Other parent" });
    const cousin = await createPage(owner, { spaceId: team.id, parentId: other.id, title: "Cousin" });
    const create = async (title: string, extra: Record<string, unknown> = {}) =>
      (await owner.post("/pages", { spaceId: team.id, parentId: parent.id, title, ...extra }));
    const a = data(await create("A")).page;
    const b = data(await create("B", { afterId: null })).page;
    const c = data(await create("C", { afterId: "" })).page;
    expect([a.position, b.position, c.position]).toEqual(["a0", "a1", "a2"]);
    const d = data(await create("D", { afterId: a.id })).page;
    expect(d.position).toBe("a0V");
    const e = data(await create("E", { afterId: c.id })).page;
    expect(e.position).toBe("a3");
    expect(titles(await owner.get(`/spaces/${team.id}/pages?parentId=${parent.id}`))).toEqual(["A", "D", "B", "C", "E"]);

    for (const afterId of ["x", 3, a.slugId]) expectInvalid(await create("Bad", { afterId }), "afterId must be a valid id");
    expectNotFound(await create("Bad", { afterId: NO_SUCH_ID }), "Sibling page");
    // A page that is not a child of the same parent: the parent itself, a cousin, a root page.
    expectNotFound(await create("Bad", { afterId: parent.id }), "Sibling page");
    expectNotFound(await create("Bad", { afterId: cousin.id }), "Sibling page");
    expectNotFound(await owner.post("/pages", { spaceId: team.id, afterId: a.id }), "Sibling page");
    // A sibling in the trash.
    data(await owner.post(`/pages/${d.id}/delete`));
    expectNotFound(await create("Bad", { afterId: d.id }), "Sibling page");
    expect(titles(await owner.get(`/spaces/${team.id}/pages?parentId=${parent.id}`))).toEqual(["A", "B", "C", "E"]);
  });

  test("the creator watches the page, and nobody is notified, not even people mentioned in it", async () => {
    const content = docOf(paragraph(text("cc "), { type: "mention", attrs: { entityType: "user", entityId: reader.id, label: "reader" } }));
    const page = await createPage(writer.client, { spaceId: team.id, title: "Mentions at birth", content });
    expect(data(await writer.client.get(`/pages/${page.id}/watch`))).toEqual({ watching: true });
    expect(data(await owner.get(`/pages/${page.id}/watch`))).toEqual({ watching: false });
    const watchers = await t.sql`SELECT user_id FROM watchers WHERE page_id = ${page.id}`;
    expect(watchers.map((w: any) => w.user_id)).toEqual([writer.id]);
    expect(data(await reader.client.get("/notifications"))).toEqual([]);
  });

  test("everyone with the space open hears a tree event; others hear nothing", async () => {
    const members = [owner, writer.client, reader.client];
    const sockets = await Promise.all(members.map((client) => openSocket(client)));
    const strangers = await Promise.all([outsider.client, wsAdmin.client].map((client) => openSocket(client)));
    const page = await createPage(writer.client, { spaceId: team.id, title: "Announced" });
    for (const socket of sockets) expect(await takeEvents(socket)).toEqual([treeEvent(team.id)]);
    for (const socket of strangers) expect(await takeEvents(socket)).toEqual([]);
    // A refused creation announces nothing.
    expectNotFound(await owner.post("/pages", { spaceId: team.id, parentId: NO_SUCH_ID }), "Parent page");
    expectInvalid(await owner.post("/pages", { spaceId: team.id, content: 1 }), "content has an invalid node");
    for (const socket of sockets) expect(await takeEvents(socket)).toEqual([]);
    await Promise.all([...sockets, ...strangers].map((socket) => socket.close()));
    expect(page.spaceId).toBe(team.id);
  });

  test("bodies up to 8 MB are read, larger ones are refused", async () => {
    const post = (body: string) => owner.raw("POST", "/pages", { body, headers: { "Content-Type": "application/json" } });
    // Over the 1 MB limit of other JSON endpoints.
    const large = await post(JSON.stringify({ spaceId: team.id, title: "Large", content: doc("x".repeat(1_500_000)) }));
    expect(large.status).toBe(200);
    const page = (await large.json()).data.page;
    expect(page.content.content[0].content[0].text).toHaveLength(1_500_000);
    const padding = " ".repeat(8 * 1024 * 1024);
    const tooBig = await post(`{"spaceId":"${team.id}",${padding}"title":"Too big"}`);
    expect([tooBig.status, await tooBig.json()]).toEqual([413, { error: { code: "payload_too_large", message: "Request body is too large" } }]);
    const frame = `{"spaceId":"${team.id}","title":"Exactly 8 MB"}`;
    const exact = frame.replace(",", `,${" ".repeat(8 * 1024 * 1024 - frame.length)}`);
    expect(new TextEncoder().encode(exact).length).toBe(8 * 1024 * 1024);
    expect((await post(exact)).status).toBe(200);
    expect((await post(`${exact} `)).status).toBe(413);
    data(await owner.post(`/pages/${page.id}/delete-permanently`));
  });

  test("a NUL character in a title or in the text is a server error", async () => {
    // Accident: PostgreSQL refuses the character and the failure surfaces as a 500 instead of a 400.
    expectError(await owner.post("/pages", { spaceId: team.id, title: "a\u0000b" }), 500, "internal_error", "Something went wrong");
    expectError(await owner.post("/pages", { spaceId: team.id, content: doc("a\u0000b") }), 500, "internal_error", "Something went wrong");
    expectError(await owner.post("/pages", { spaceId: team.id, icon: "\u0000x" }), 500, "internal_error", "Something went wrong");
  });

  test("an unpaired surrogate in a title is stored as U+FFFD", async () => {
    const raw = await owner.raw("POST", "/pages", {
      body: `{"spaceId":"${team.id}","title":"half \\ud83d smile"}`,
      headers: { "Content-Type": "application/json" },
    });
    expect(raw.status).toBe(200);
    // Accident: the lone surrogate is not refused; it becomes the replacement character on its way to the database.
    expect((await raw.json()).data.page.title).toBe("half � smile");
  });
});

describe("GET /pages/:page", () => {
  test("answers the page, its space, its breadcrumbs and whether the user may edit", async () => {
    const root = await createPage(owner, { spaceId: team.id, title: "Root", icon: "🌳" });
    const middle = await createPage(writer.client, { spaceId: team.id, parentId: root.id, title: "Middle" });
    const leaf = await createPage(owner, { spaceId: team.id, parentId: middle.id, title: "Leaf", content: doc("leaf text") });
    const res = await owner.get(`/pages/${leaf.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        page: leaf,
        space: team,
        breadcrumbs: [treeItem(root, { hasChildren: true }), treeItem(middle, { hasChildren: true }), treeItem(leaf)],
        canEdit: true,
      },
    });
    expect(Object.keys(res.body.data.page).sort()).toEqual([
      "content", "contributors", "cover", "createdAt", "creator", "deletedAt", "docVersion", "hasChildren", "icon", "id", "isBase",
      "lastEditor", "parentId", "position", "slugId", "spaceId", "title", "updatedAt",
    ]);
    const rootDetails = data(await owner.get(`/pages/${root.id}`));
    expect(rootDetails.page).toEqual({ ...root, hasChildren: true });
    expect(rootDetails.breadcrumbs).toEqual([treeItem(root, { hasChildren: true })]);
    expect(data(await owner.get(`/pages/${middle.id}`)).page.creator).toEqual(userRef(writer.user));
  });

  test("a page is found by its id in any case and by its slugId exactly", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Findable" });
    for (const ref of [page.id, page.id.toUpperCase(), page.slugId]) {
      expect(data(await owner.get(`/pages/${ref}`)).page).toEqual(page);
    }
    const flipped = [...page.slugId].map((c: string) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
    if (flipped !== page.slugId) expectNotFound(await owner.get(`/pages/${flipped}`), "Page");
  });

  test("references that name no page are 404", async () => {
    for (const ref of [NO_SUCH_ID, "0000000000", "nope", "a".repeat(32), "a".repeat(33), "not-a-page", "with space", "%25", "é", `${NO_SUCH_ID}0`, "a.b"]) {
      expectNotFound(await owner.get(`/pages/${encodeURIComponent(ref)}`), "Page");
    }
    // A reference that cannot be URL-decoded matches no route at all.
    expectError(await owner.get("/pages/%E0%A4%A"), 404, "not_found", "Endpoint not found");
  });

  test("canEdit and the space's role follow the user's role", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Roles" });
    for (const [who, role, canEdit] of [[spaceAdmin, "admin", true], [writer, "writer", true], [reader, "reader", false]] as const) {
      const details = data(await who.client.get(`/pages/${page.slugId}`));
      expect(details).toEqual({ page, space: { ...team, role }, breadcrumbs: [treeItem(page)], canEdit });
    }
    for (const who of [outsider, wsAdmin]) {
      expectNotFound(await who.client.get(`/pages/${page.id}`), "Page");
      expectNotFound(await who.client.get(`/pages/${page.slugId}`), "Page");
    }
  });

  test("a page in the trash can still be read, by nobody edited", async () => {
    const parent = await createPage(owner, { spaceId: team.id, title: "Trashed parent" });
    const page = await createPage(owner, { spaceId: team.id, parentId: parent.id, title: "Trashed child" });
    data(await writer.client.post(`/pages/${parent.id}/delete`));
    for (const who of [owner, writer.client, reader.client]) {
      const details = data(await who.get(`/pages/${page.id}`));
      expect(details.canEdit).toBe(false);
      expect(details.page).toEqual({ ...page, deletedAt: anyTime() });
      // Ancestors in the trash stay in the breadcrumbs; their children do not count while trashed.
      expect(details.breadcrumbs).toEqual([treeItem(parent), treeItem(page)]);
    }
    expectNotFound(await outsider.client.get(`/pages/${page.id}`), "Page");
  });
});

describe("GET /spaces/:id/pages", () => {
  test("lists the root pages, or the children of parentId, as tree items in position order", async () => {
    const space = await createSpace(owner, "Listing", "listing");
    const b = await createPage(owner, { spaceId: space.id, title: "B", icon: "🅱️" });
    const c = await createPage(owner, { spaceId: space.id });
    const a = await createPage(owner, { spaceId: space.id, title: "A", afterId: b.id });
    const child = await createPage(owner, { spaceId: space.id, parentId: a.id, title: "Child" });
    const res = await owner.get(`/spaces/${space.id}/pages`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        { id: b.id, slugId: b.slugId, title: "B", icon: "🅱️", parentId: null, spaceId: space.id, position: "a0", hasChildren: false, isBase: false },
        { id: a.id, slugId: a.slugId, title: "A", icon: null, parentId: null, spaceId: space.id, position: "a0V", hasChildren: true, isBase: false },
        { id: c.id, slugId: c.slugId, title: null, icon: null, parentId: null, spaceId: space.id, position: "a1", hasChildren: false, isBase: false },
      ],
    });
    for (const query of ["?parentId=", "?other=1"]) {
      expect(data(await owner.get(`/spaces/${space.id}/pages${query}`))).toEqual(res.body.data);
    }
    for (const ref of [a.id, a.id.toUpperCase()]) {
      expect(data(await owner.get(`/spaces/${space.id.toUpperCase()}/pages?parentId=${ref}`))).toEqual([treeItem(child)]);
    }
    expect(data(await owner.get(`/spaces/${space.id}/pages?parentId=${child.id}`))).toEqual([]);
    expect(data(await owner.get(`/spaces/${space.id}/pages?parentId=${NO_SUCH_ID}`))).toEqual([]);
    // A parent of another space has no children here.
    expect(data(await owner.get(`/spaces/${team.id}/pages?parentId=${a.id}`))).toEqual([]);
    expectInvalid(await owner.get(`/spaces/${space.id}/pages?parentId=nope`), "parentId must be a valid id");
    expectInvalid(await owner.get(`/spaces/${space.id}/pages?parentId=${a.slugId}`), "parentId must be a valid id");
  });

  test("pages in the trash are left out, and do not count as children", async () => {
    const space = await createSpace(owner, "Listing trash", "listing-trash");
    const parent = await createPage(owner, { spaceId: space.id, title: "Parent" });
    const child = await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "Child" });
    const sibling = await createPage(owner, { spaceId: space.id, title: "Sibling" });
    data(await owner.post(`/pages/${child.id}/delete`));
    data(await owner.post(`/pages/${sibling.id}/delete`));
    expect(data(await owner.get(`/spaces/${space.id}/pages`))).toEqual([treeItem(parent)]);
    expect(data(await owner.get(`/spaces/${space.id}/pages?parentId=${parent.id}`))).toEqual([]);
  });

  test("positions sort bytewise: upper-case keys come before lower-case ones", async () => {
    const space = await createSpace(owner, "Bytewise", "bytewise");
    const first = await createPage(owner, { spaceId: space.id, title: "created first" });
    const second = await createPage(owner, { spaceId: space.id, title: "moved to the front" });
    expect(data(await owner.post(`/pages/${second.id}/move`, { parentId: null, afterId: null })).page.position).toBe("Zz");
    expect(data(await owner.get(`/spaces/${space.id}/pages`)).map((p: any) => [p.id, p.position])).toEqual([
      [second.id, "Zz"],
      [first.id, "a0"],
    ]);
  });

  test("needs membership of the space, named by id", async () => {
    expect(data(await reader.client.get(`/spaces/${team.id}/pages`)).length).toBeGreaterThan(0);
    for (const who of [outsider, wsAdmin]) expectNotFound(await who.client.get(`/spaces/${team.id}/pages`), "Space");
    expectNotFound(await owner.get(`/spaces/${team.slug}/pages`), "Space");
    expectNotFound(await owner.get(`/spaces/${NO_SUCH_ID}/pages`), "Space");
    // The space is checked before the query.
    expectNotFound(await outsider.client.get(`/spaces/${team.id}/pages?parentId=nope`), "Space");
  });
});

describe("POST /pages/:id/update", () => {
  test("changes title, icon and cover; the editor becomes lastEditor but not a contributor", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Old", icon: "📄" });
    const res = await writer.client.post(`/pages/${page.id}/update`, { title: "  New  ", icon: " 🚀 ", cover: "  /api/files/abc/cover.png  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { page: { ...page, title: "New", icon: "🚀", cover: "/api/files/abc/cover.png", lastEditor: userRef(writer.user), updatedAt: anyTime() } },
    });
    expect(Date.parse(res.body.data.page.updatedAt)).toBeGreaterThanOrEqual(Date.parse(page.updatedAt));
    expect(data(await owner.get(`/pages/${page.id}`)).page).toEqual(res.body.data.page);
    const [row] = await t.sql`SELECT contributor_ids::text[] AS ids, doc_version::int AS v FROM pages WHERE id = ${page.id}`;
    expect(row).toEqual({ ids: [ownerUser.id], v: 0 });
  });

  test("absent fields are kept; null and blank clear; an empty body only records the editor", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Keep", icon: "🔒" });
    const update = async (body: unknown) => data(await owner.post(`/pages/${page.slugId}/update`, body)).page;
    expect(await update({ cover: "c1" })).toMatchObject({ title: "Keep", icon: "🔒", cover: "c1" });
    expect(await update({ title: "Kept" })).toMatchObject({ title: "Kept", icon: "🔒", cover: "c1" });
    expect(await update({ icon: null })).toMatchObject({ title: "Kept", icon: null, cover: "c1" });
    expect(await update({ title: "  ", icon: "🔑" })).toMatchObject({ title: null, icon: "🔑", cover: "c1" });
    expect(await update({ cover: "" })).toMatchObject({ title: null, icon: "🔑", cover: null });
    expect(await update({ title: "Back", cover: null })).toMatchObject({ title: "Back", icon: "🔑", cover: null });
    await t.sql`UPDATE pages SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ${page.id}`;
    const touched = data(await writer.client.post(`/pages/${page.id}/update`, {})).page;
    expect(touched).toMatchObject({ title: "Back", icon: "🔑", cover: null, lastEditor: userRef(writer.user) });
    expect(Date.parse(touched.updatedAt)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
    // Unknown fields, content among them, are ignored.
    const same = await update({ content: doc("ignored"), position: "zz", parentId: NO_SUCH_ID, spaceId: generalId, docVersion: 9 });
    expect(same).toEqual({ ...touched, lastEditor: userRef(ownerUser), updatedAt: anyTime() });
  });

  test("limits: title 500, icon 100, cover 2000 characters", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Limits" });
    const update = (body: unknown) => owner.post(`/pages/${page.id}/update`, body);
    expect(data(await update({ title: "字".repeat(500), icon: "😀".repeat(100), cover: "c".repeat(2000) })).page).toMatchObject({
      title: "字".repeat(500),
      icon: "😀".repeat(100),
      cover: "c".repeat(2000),
    });
    expectInvalid(await update({ title: "字".repeat(501) }), "title must be at most 500 characters");
    expectInvalid(await update({ icon: "😀".repeat(101) }), "icon must be at most 100 characters");
    expectInvalid(await update({ cover: "c".repeat(2001) }), "cover must be at most 2000 characters");
    expectInvalid(await update({ title: 1 }), "title must be a string");
    expectInvalid(await update({ icon: false }), "icon must be a string");
    expectInvalid(await update({ cover: {} }), "cover must be a string");
    // One bad field refuses the whole update.
    expectInvalid(await update({ title: "Applied?", cover: 5 }), "cover must be a string");
    expect(data(await owner.get(`/pages/${page.id}`)).page.title).toBe("字".repeat(500));
    // The cover is stored as sent: it is not checked to be a safe URL.
    expect(data(await update({ cover: "javascript:alert(1)" })).page.cover).toBe("javascript:alert(1)");
  });

  test("readers, strangers and pages in the trash", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Guarded" });
    expectForbidden(await reader.client.post(`/pages/${page.id}/update`, { title: "nope" }));
    expectForbidden(await reader.client.post(`/pages/${page.id}/update`, { title: 5 }));
    for (const who of [outsider, wsAdmin]) expectNotFound(await who.client.post(`/pages/${page.id}/update`, { title: "nope" }), "Page");
    expectNotFound(await owner.post(`/pages/${NO_SUCH_ID}/update`, { title: "nope" }), "Page");
    expectNotFound(await owner.post("/pages/not-a-page/update", { title: "nope" }), "Page");
    expect(data(await spaceAdmin.client.post(`/pages/${page.id.toUpperCase()}/update`, { title: "By the admin" })).page.title).toBe("By the admin");
    data(await owner.post(`/pages/${page.id}/delete`));
    for (const who of [owner, writer.client, spaceAdmin.client]) expectNotFound(await who.post(`/pages/${page.id}/update`, { title: "nope" }), "Page");
    // A reader is told about their role before the trash is considered.
    expectForbidden(await reader.client.post(`/pages/${page.id}/update`, { title: "nope" }));
    expect(data(await owner.get(`/pages/${page.id}`)).page.title).toBe("By the admin");
  });

  test("a change of title or icon is announced to the space; a change of cover alone is not", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Quiet", icon: "🤫" });
    const sockets = await Promise.all([owner, reader.client].map((client) => openSocket(client)));
    const stranger = await openSocket(outsider.client);
    const pageEvent = (title: string | null, icon: string | null) => ({ t: "event", kind: "page", pageId: page.id, spaceId: team.id, title, icon });
    const expectEvents = async (events: unknown[]) => {
      for (const socket of sockets) expect(await takeEvents(socket)).toEqual(events as never);
      expect(await takeEvents(stranger)).toEqual([]);
    };
    data(await writer.client.post(`/pages/${page.id}/update`, { title: "Loud" }));
    await expectEvents([treeEvent(team.id), pageEvent("Loud", "🤫")]);
    data(await writer.client.post(`/pages/${page.id}/update`, { icon: null }));
    await expectEvents([treeEvent(team.id), pageEvent("Loud", null)]);
    // Sending the same title again still announces it.
    data(await writer.client.post(`/pages/${page.id}/update`, { title: "Loud", cover: "c" }));
    await expectEvents([treeEvent(team.id), pageEvent("Loud", null)]);
    data(await writer.client.post(`/pages/${page.id}/update`, { title: null, icon: "🔔" }));
    await expectEvents([treeEvent(team.id), pageEvent(null, "🔔")]);
    data(await writer.client.post(`/pages/${page.id}/update`, { cover: "only the cover" }));
    data(await writer.client.post(`/pages/${page.id}/update`, {}));
    expectInvalid(await writer.client.post(`/pages/${page.id}/update`, { title: 1 }), "title must be a string");
    await expectEvents([]);
    await Promise.all([...sockets, stranger].map((socket) => socket.close()));
  });

  test("other JSON endpoints read at most 1 MB", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Small bodies" });
    const res = await owner.post(`/pages/${page.id}/update`, { title: "t", padding: "x".repeat(1024 * 1024) });
    expectError(res, 413, "payload_too_large", "Request body is too large");
  });
});

describe("GET /pages/recent", () => {
  let space: any;
  let other: any;
  let pages: any[];

  beforeAll(async () => {
    space = await createSpace(owner, "Recent", "recent");
    other = await createSpace(owner, "Recent too", "recent-too");
    const mine = await person(t, owner, "recent-writer@example.com", { space: space.id, spaceRole: "writer" });
    pages = [
      await createPage(owner, { spaceId: space.id, title: "Oldest", icon: "1️⃣" }),
      await createPage(mine.client, { spaceId: space.id, title: "By the writer" }),
      await createPage(owner, { spaceId: other.id, title: "In the other space" }),
      await createPage(owner, { spaceId: space.id, title: "Newest" }),
    ];
    const child = await createPage(owner, { spaceId: space.id, parentId: pages[3].id, title: "Trashed child" });
    data(await owner.post(`/pages/${child.id}/delete`));
    for (const [i, page] of pages.entries()) {
      await t.sql`UPDATE pages SET updated_at = ${`2025-03-0${i + 1}T10:00:00.250Z`}::timestamptz WHERE id = ${page.id}`;
    }
    pages.push(mine);
  });

  const recent = async (client: Client, query = "") => data(await client.get(`/pages/recent${query}`)) as any[];
  const inScope = (rows: any[]) => rows.filter((r) => r.spaceId === space.id || r.spaceId === other.id);

  test("lists pages of every readable space, most recently updated first", async () => {
    const [oldest, byWriter, inOther, newest, mine] = pages;
    const rows = inScope(await recent(owner, "?limit=100"));
    expect(rows).toEqual([
      { ...treeItem(newest), space: spaceRef(space), updatedAt: "2025-03-04T10:00:00.250Z", lastEditor: userRef(ownerUser) },
      { ...treeItem(inOther), space: spaceRef(other), updatedAt: "2025-03-03T10:00:00.250Z", lastEditor: userRef(ownerUser) },
      { ...treeItem(byWriter), space: spaceRef(space), updatedAt: "2025-03-02T10:00:00.250Z", lastEditor: userRef(mine.user) },
      { ...treeItem(oldest), space: spaceRef(space), updatedAt: "2025-03-01T10:00:00.250Z", lastEditor: userRef(ownerUser) },
    ]);
    // Only what the user can read.
    expect((await recent(mine.client)).map((r) => r.title)).toEqual(["Newest", "By the writer", "Oldest"]);
    expect(await recent(outsider.client)).toEqual([]);
  });

  test("filters by space and by creator", async () => {
    const [, , , , mine] = pages;
    expect((await recent(owner, `?spaceId=${space.id}`)).map((r) => r.title)).toEqual(["Newest", "By the writer", "Oldest"]);
    expect((await recent(owner, `?spaceId=${other.id.toUpperCase()}`)).map((r) => r.title)).toEqual(["In the other space"]);
    expect((await recent(owner, `?creatorId=${mine.id}`)).map((r) => r.title)).toEqual(["By the writer"]);
    expect((await recent(owner, `?creatorId=${mine.id}&spaceId=${other.id}`)).map((r) => r.title)).toEqual([]);
    expect(inScope(await recent(owner, `?creatorId=${ownerUser.id.toUpperCase()}&spaceId=${space.id}`)).map((r) => r.title)).toEqual(["Newest", "Oldest"]);
    expect(await recent(owner, `?creatorId=${NO_SUCH_ID}`)).toEqual([]);
    expect(await recent(owner, `?spaceId=${NO_SUCH_ID}`)).toEqual([]);
    // A space the user cannot read gives nothing rather than an error.
    expect(await recent(mine.client, `?spaceId=${other.id}`)).toEqual([]);
    // Empty values are no filter.
    expect((await recent(mine.client, "?spaceId=&creatorId=")).map((r) => r.title)).toEqual(["Newest", "By the writer", "Oldest"]);
    expectInvalid(await owner.get("/pages/recent?spaceId=recent"), "spaceId must be a valid id");
    expectInvalid(await owner.get("/pages/recent?creatorId=me"), "creatorId must be a valid id");
  });

  test("limit and offset page through the list; the default limit is 20", async () => {
    const [, , , , mine] = pages;
    const q = (query: string) => recent(mine.client, query);
    expect((await q("?limit=1")).map((r) => r.title)).toEqual(["Newest"]);
    expect((await q("?limit=2&offset=1")).map((r) => r.title)).toEqual(["By the writer", "Oldest"]);
    expect((await q("?offset=3")).map((r) => r.title)).toEqual([]);
    expect((await q("?limit=100&offset=100000")).map((r) => r.title)).toEqual([]);
    expect((await q("?limit=&offset=")).map((r) => r.title)).toEqual(["Newest", "By the writer", "Oldest"]);
    for (const limit of ["0", "101", "-1", "1.5", "abc", "1,5", "NaN", "Infinity"]) {
      expectInvalid(await mine.client.get(`/pages/recent?limit=${limit}`), "limit must be an integer between 1 and 100");
    }
    for (const offset of ["-1", "100001", "x", "0.5"]) {
      expectInvalid(await mine.client.get(`/pages/recent?offset=${offset}`), "offset must be an integer between 0 and 100000");
    }
    // When a parameter is repeated the last one counts.
    expect((await q("?limit=3&limit=1")).map((r) => r.title)).toEqual(["Newest"]);
    const many = await createSpace(mine.client, "Many", "recent-many");
    for (let i = 0; i < 21; i++) await createPage(mine.client, { spaceId: many.id, title: `Page ${i}` });
    expect(await recent(mine.client, `?spaceId=${many.id}`)).toHaveLength(20);
    expect(await recent(mine.client, `?spaceId=${many.id}&limit=100`)).toHaveLength(21);
  });

  test("numbers in the query are read the way JavaScript reads them", async () => {
    const [, , , , mine] = pages;
    // Accident: any spelling `Number()` turns into an integer in range is accepted.
    for (const [limit, count] of [["1e0", 1], ["0x2", 2], ["%202%20", 2], ["%2B1", 1], ["2.0", 2], ["0b1", 1], ["01", 1]] as const) {
      expect(await recent(mine.client, `?spaceId=${space.id}&limit=${limit}`)).toHaveLength(count);
    }
  });

  test("pages in the trash are left out and come back when restored; lastEditor is null once that user is deleted", async () => {
    const solo = await createSpace(owner, "Recent solo", "recent-solo");
    const temp = await person(t, owner, "temp-editor@example.com", { space: solo.id, spaceRole: "writer" });
    const page = await createPage(temp.client, { spaceId: solo.id, title: "Orphaned" });
    expect(await recent(owner, `?spaceId=${solo.id}`)).toEqual([
      { ...treeItem(page), space: spaceRef(solo), updatedAt: page.updatedAt, lastEditor: userRef(temp.user) },
    ]);
    data(await owner.post("/members/delete", { userId: temp.id }));
    expect((await recent(owner, `?spaceId=${solo.id}`))[0].lastEditor).toBeNull();
    const details = data(await owner.get(`/pages/${page.id}`)).page;
    expect(details).toMatchObject({ creator: null, lastEditor: null, contributors: [] });
    data(await owner.post(`/pages/${page.id}/delete`));
    expect(await recent(owner, `?spaceId=${solo.id}`)).toEqual([]);
    data(await owner.post(`/pages/${page.id}/restore`));
    expect((await recent(owner, `?spaceId=${solo.id}`)).map((r) => r.id)).toEqual([page.id]);
  });
});

describe("GET /pages/:id/versions and GET /versions/:id", () => {
  // Versions are written when content is saved through the realtime path; here their rows are arranged directly.
  const insertVersion = async (pageId: string, v: { title?: string | null; icon?: string | null; content?: unknown; editorId?: string | null; contributorIds?: string[]; at: string }) => {
    const [row] = await t.sql`
      INSERT INTO page_versions (page_id, title, icon, content, editor_id, contributor_ids, created_at)
      VALUES (${pageId}, ${v.title ?? null}, ${v.icon ?? null}, ${v.content === undefined ? null : v.content}::jsonb, ${v.editorId ?? null},
        ${t.sql.array(v.contributorIds ?? [], "uuid")}::uuid[], ${v.at}::timestamptz)
      RETURNING id`;
    return row.id as string;
  };

  test("a new page has no versions", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Fresh", content: doc("hello") });
    const res = await owner.get(`/pages/${page.id}/versions`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  test("lists versions newest first, and serves each with its content, editor and contributors", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Versioned" });
    const content = docOf(paragraph(text("second draft", [{ type: "italic" }])));
    const first = await insertVersion(page.id, { title: "v1", at: "2025-05-01T08:00:00.123456Z", editorId: ownerUser.id, contributorIds: [ownerUser.id] });
    const second = await insertVersion(page.id, {
      title: "v2",
      icon: "✌️",
      content,
      at: "2025-05-02T08:00:00Z",
      editorId: writer.id,
      contributorIds: [writer.id, NO_SUCH_ID, ownerUser.id],
    });
    const third = await insertVersion(page.id, { at: "2025-05-03T08:00:00Z" });
    for (const ref of [page.id, page.slugId]) {
      const list = await reader.client.get(`/pages/${ref}/versions`);
      expect(list.status).toBe(200);
      expect(list.body).toEqual({
        data: [
          { id: third, title: null, editor: null, createdAt: "2025-05-03T08:00:00.000Z" },
          { id: second, title: "v2", editor: userRef(writer.user), createdAt: "2025-05-02T08:00:00.000Z" },
          { id: first, title: "v1", editor: userRef(ownerUser), createdAt: "2025-05-01T08:00:00.123Z" },
        ],
      });
    }
    const full = await reader.client.get(`/versions/${second.toUpperCase()}`);
    expect(full.status).toBe(200);
    expect(full.body).toEqual({
      data: {
        id: second,
        pageId: page.id,
        title: "v2",
        icon: "✌️",
        content,
        editor: userRef(writer.user),
        // In the stored order; ids that name nobody are skipped.
        contributors: [userRef(writer.user), userRef(ownerUser)],
        createdAt: "2025-05-02T08:00:00.000Z",
      },
    });
    expect(data(await owner.get(`/versions/${third}`))).toEqual({
      id: third,
      pageId: page.id,
      title: null,
      icon: null,
      content: null,
      editor: null,
      contributors: [],
      createdAt: "2025-05-03T08:00:00.000Z",
    });
    expect(data(await owner.get(`/versions/${first}`))).toMatchObject({ editor: userRef(ownerUser), contributors: [userRef(ownerUser)], content: null });
  });

  test("versions follow the access to their page, trashed or not", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Private history" });
    const version = await insertVersion(page.id, { title: "secret", at: "2025-06-01T00:00:00Z" });
    for (const who of [outsider, wsAdmin]) {
      expectNotFound(await who.client.get(`/pages/${page.id}/versions`), "Page");
      // The version exists, but the answer names the page the user cannot see.
      expectNotFound(await who.client.get(`/versions/${version}`), "Page");
    }
    expectNotFound(await owner.get(`/versions/${NO_SUCH_ID}`), "Version");
    expectNotFound(await owner.get("/versions/nope"), "Version");
    expectNotFound(await owner.get(`/versions/${page.slugId}`), "Version");
    expectNotFound(await owner.get(`/pages/${NO_SUCH_ID}/versions`), "Page");
    data(await owner.post(`/pages/${page.id}/delete`));
    expect(data(await reader.client.get(`/pages/${page.id}/versions`))).toHaveLength(1);
    expect(data(await reader.client.get(`/versions/${version}`)).title).toBe("secret");
    data(await owner.post(`/pages/${page.id}/delete-permanently`));
    expectNotFound(await owner.get(`/versions/${version}`), "Version");
  });

  test("at most the 500 newest versions are listed", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Long history" });
    await t.sql`
      INSERT INTO page_versions (page_id, title, created_at)
      SELECT ${page.id}, 'v' || n, '2025-01-01T00:00:00Z'::timestamptz + make_interval(mins => n) FROM generate_series(1, 501) AS n`;
    const list = data(await owner.get(`/pages/${page.id}/versions`));
    expect(list).toHaveLength(500);
    expect([list[0].title, list[499].title]).toEqual(["v501", "v2"]);
  });
});

describe("GET /pages/:id/files", () => {
  test("lists the files uploaded to the page, newest first", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "With files" });
    const other = await createPage(owner, { spaceId: team.id, title: "Other files" });
    expect(data(await owner.get(`/pages/${page.id}/files`))).toEqual([]);
    const first = data(await owner.uploadFile(new File(["first file"], "notes.txt", { type: "text/plain" }), page.id));
    const second = data(await writer.client.uploadFile(new File([new Uint8Array(2048)], "my report (final) é 100%.pdf", { type: "application/pdf" }), page.id));
    data(await owner.uploadFile(new File(["elsewhere"], "elsewhere.txt", { type: "text/plain" }), other.id));
    for (const ref of [page.id, page.slugId]) {
      const res = await reader.client.get(`/pages/${ref}/files`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: [
          {
            id: second.id,
            name: "my report (final) é 100%.pdf",
            mime: "application/pdf",
            size: 2048,
            url: `/api/files/${second.id}/my%20report%20(final)%20%C3%A9%20100%25.pdf`,
            uploader: userRef(writer.user),
            createdAt: anyTime(),
          },
          { id: first.id, name: "notes.txt", mime: "text/plain", size: 10, url: `/api/files/${first.id}/notes.txt`, uploader: userRef(ownerUser), createdAt: anyTime() },
        ],
      });
    }
    expect(data(await owner.get(`/pages/${other.id}/files`)).map((f: any) => f.name)).toEqual(["elsewhere.txt"]);
  });

  test("follows the access to the page; the uploader is null once that user is deleted", async () => {
    const space = await createSpace(owner, "Files", "files-space");
    const temp = await person(t, owner, "temp-uploader@example.com", { space: space.id, spaceRole: "writer" });
    const page = await createPage(owner, { spaceId: space.id, title: "Shared files" });
    const file = data(await temp.client.uploadFile(new File(["x"], "x.bin"), page.id));
    expectNotFound(await outsider.client.get(`/pages/${page.id}/files`), "Page");
    expectNotFound(await owner.get(`/pages/${NO_SUCH_ID}/files`), "Page");
    data(await owner.post("/members/delete", { userId: temp.id }));
    expect(data(await owner.get(`/pages/${page.id}/files`))).toEqual([
      { id: file.id, name: "x.bin", mime: "application/octet-stream", size: 1, url: `/api/files/${file.id}/x.bin`, uploader: null, createdAt: anyTime() },
    ]);
    data(await owner.post(`/pages/${page.id}/delete`));
    expect(data(await owner.get(`/pages/${page.id}/files`))).toHaveLength(1);
  });

  test("at most the 500 newest files are listed", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Many files" });
    // Rows only: listing does not look at the stored bytes.
    await t.sql`
      INSERT INTO files (purpose, page_id, space_id, name, size, storage_key, created_at)
      SELECT 'page', ${page.id}, ${team.id}, 'f' || n || '.txt', n, 'files/none/' || n, '2025-01-01T00:00:00Z'::timestamptz + make_interval(mins => n)
      FROM generate_series(1, 501) AS n`;
    const list = data(await owner.get(`/pages/${page.id}/files`));
    expect(list).toHaveLength(500);
    expect([list[0].name, list[0].size, list[499].name]).toEqual(["f501.txt", 501, "f2.txt"]);
    await t.sql`DELETE FROM files WHERE page_id = ${page.id}`;
  });
});

describe("GET /pages/:id/backlinks and /links", () => {
  test("a page mention or an internal link in the content of a new page links it to the target", async () => {
    const space = await createSpace(owner, "Linked", "linked");
    const target = await createPage(owner, { spaceId: space.id, title: "Target", icon: "🎯" });
    const bySlug = await createPage(owner, { spaceId: space.id, title: "Target by slug" });
    const byHref = await createPage(owner, { spaceId: space.id, title: "target by href" });
    const source = await createPage(owner, {
      spaceId: space.id,
      title: "Source",
      content: docOf(
        paragraph(
          pageMention({ entityId: target.id, label: "Target" }),
          pageMention({ slugId: bySlug.slugId, label: "By slug" }),
          text("see", [{ type: "link", attrs: { href: `/s/linked/p/target-by-href-${byHref.slugId}` } }]),
        ),
      ),
    });
    const res = await owner.get(`/pages/${source.id}/links`);
    expect(res.status).toBe(200);
    // Ordered by title without regard to case.
    expect(res.body).toEqual({
      data: [
        { ...treeItem(target), space: spaceRef(space) },
        { ...treeItem(byHref), space: spaceRef(space) },
        { ...treeItem(bySlug), space: spaceRef(space) },
      ],
    });
    for (const page of [target, bySlug, byHref]) {
      const back = await owner.get(`/pages/${page.slugId}/backlinks`);
      expect(back.status).toBe(200);
      expect(back.body).toEqual({ data: [{ ...treeItem(source), space: spaceRef(space) }] });
    }
    expect(data(await owner.get(`/pages/${target.id}/links`))).toEqual([]);
    expect(data(await owner.get(`/pages/${source.id}/backlinks`))).toEqual([]);
    const rows = await t.sql`SELECT target_id FROM page_links WHERE source_id = ${source.id}`;
    expect(rows.map((r: any) => r.target_id).sort()).toEqual([target.id, bySlug.id, byHref.id].sort());
  });

  test("backlinks are ordered by title, and hide sources that are trashed or unreadable", async () => {
    const space = await createSpace(owner, "Backlinks", "backlinks");
    const hidden = await createSpace(owner, "Hidden sources", "hidden-sources");
    const viewer = await person(t, owner, "link-viewer@example.com", { space: space.id, spaceRole: "reader" });
    const target = await createPage(owner, { spaceId: space.id, title: "Hub" });
    const mention = docOf(paragraph(pageMention({ entityId: target.id.toUpperCase(), label: "Hub" })));
    const beta = await createPage(owner, { spaceId: space.id, title: "beta", content: mention });
    const untitled = await createPage(owner, { spaceId: space.id, content: mention });
    const alpha = await createPage(owner, { spaceId: space.id, title: "Alpha", content: mention });
    const trashed = await createPage(owner, { spaceId: space.id, title: "Aardvark (trashed)", content: mention });
    const secret = await createPage(owner, { spaceId: hidden.id, title: "Charlie (hidden space)", content: mention });
    data(await owner.post(`/pages/${trashed.id}/delete`));
    const forOwner = data(await owner.get(`/pages/${target.id}/backlinks`));
    expect(forOwner).toEqual([
      { ...treeItem(untitled), space: spaceRef(space) },
      { ...treeItem(alpha), space: spaceRef(space) },
      { ...treeItem(beta), space: spaceRef(space) },
      { ...treeItem(secret), space: spaceRef(hidden) },
    ]);
    expect(data(await viewer.client.get(`/pages/${target.id}/backlinks`)).map((p: any) => p.title)).toEqual([null, "Alpha", "beta"]);
    // The same filters apply to outgoing links.
    const hiddenTarget = await createPage(owner, { spaceId: hidden.id, title: "Hidden target" });
    const source = await createPage(owner, {
      spaceId: space.id,
      title: "Points around",
      content: docOf(paragraph(pageMention({ entityId: hiddenTarget.id }), pageMention({ entityId: trashed.id }), pageMention({ entityId: beta.id }))),
    });
    expect(data(await owner.get(`/pages/${source.id}/links`)).map((p: any) => p.title)).toEqual(["beta", "Hidden target"]);
    expect(data(await viewer.client.get(`/pages/${source.id}/links`)).map((p: any) => p.title)).toEqual(["beta"]);
    data(await owner.post(`/pages/${trashed.id}/restore`));
    expect(data(await viewer.client.get(`/pages/${source.id}/links`)).map((p: any) => p.title)).toEqual(["Aardvark (trashed)", "beta"]);
    expect(data(await viewer.client.get(`/pages/${target.id}/backlinks`)).map((p: any) => p.title)).toEqual([null, "Aardvark (trashed)", "Alpha", "beta"]);
    // A trashed target still lists what links to it.
    data(await owner.post(`/pages/${target.id}/delete`));
    expect(data(await viewer.client.get(`/pages/${target.id}/backlinks`))).toHaveLength(4);
    for (const kind of ["backlinks", "links"]) {
      expectNotFound(await outsider.client.get(`/pages/${target.id}/${kind}`), "Page");
      expectNotFound(await viewer.client.get(`/pages/${secret.id}/${kind}`), "Page");
      expectNotFound(await owner.get(`/pages/${NO_SUCH_ID}/${kind}`), "Page");
    }
  });
});

describe("POST /synced-blocks/lookup", () => {
  const synced = (id: unknown, ...content: unknown[]) => ({ type: "transclusionSource", attrs: { id }, content });

  test("answers the content of each block asked for, in the order asked", async () => {
    const space = await createSpace(owner, "Synced", "synced");
    const hidden = await createSpace(owner, "Synced hidden", "synced-hidden");
    const viewer = await person(t, owner, "synced-viewer@example.com", { space: space.id, spaceRole: "reader" });
    const one = [paragraph(text("first block"))];
    const two = [{ type: "heading", attrs: { level: 3 }, content: [text("second")] }, paragraph(text("block", [{ type: "bold" }]))];
    const page = await createPage(owner, { spaceId: space.id, title: "Blocks", content: docOf(synced("block-1", ...one), paragraph(text("between")), synced("block-2", ...two)) });
    const secret = await createPage(owner, { spaceId: hidden.id, title: "Secret blocks", content: docOf(synced("block-1", paragraph(text("secret")))) });
    const trashed = await createPage(owner, { spaceId: space.id, title: "Trashed blocks", content: docOf(synced("block-1", paragraph(text("trashed")))) });
    data(await owner.post(`/pages/${trashed.id}/delete`));
    const refs = [
      { pageId: page.id, blockId: "block-2" },
      { pageId: page.id.toUpperCase(), blockId: "block-1", extra: "ignored" },
      { pageId: page.id, blockId: "missing" },
      { pageId: secret.id, blockId: "block-1" },
      { pageId: trashed.id, blockId: "block-1" },
      { pageId: NO_SUCH_ID, blockId: "block-1" },
      { pageId: page.id, blockId: "block-2" },
      { pageId: page.id, blockId: "BLOCK-1" },
    ];
    const res = await viewer.client.post("/synced-blocks/lookup", { refs });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        { pageId: page.id, blockId: "block-2", content: two },
        { pageId: page.id, blockId: "block-1", content: one },
        { pageId: page.id, blockId: "missing", content: null },
        { pageId: secret.id, blockId: "block-1", content: null },
        { pageId: trashed.id, blockId: "block-1", content: null },
        { pageId: NO_SUCH_ID, blockId: "block-1", content: null },
        { pageId: page.id, blockId: "block-2", content: two },
        { pageId: page.id, blockId: "BLOCK-1", content: null },
      ],
    });
    // The owner reads the hidden space too.
    expect(data(await owner.post("/synced-blocks/lookup", { refs: [refs[3]] }))).toEqual([
      { pageId: secret.id, blockId: "block-1", content: [paragraph(text("secret"))] },
    ]);
    expect(data(await outsider.client.post("/synced-blocks/lookup", { refs: [refs[0]] }))).toEqual([{ pageId: page.id, blockId: "block-2", content: null }]);
  });

  test("refs must be a list of at most 100 references, each with a page id and a block id", async () => {
    const lookup = (body: unknown) => owner.post("/synced-blocks/lookup", body);
    const ref = { pageId: NO_SUCH_ID, blockId: "b" };
    for (const refs of [undefined, null, "x", {}, 5, ref]) expectInvalid(await lookup({ refs }), "refs must be a list of at most 100 references");
    expectInvalid(await lookup({ refs: Array(101).fill(ref) }), "refs must be a list of at most 100 references");
    expect(data(await lookup({ refs: [] }))).toEqual([]);
    expect(data(await lookup({ refs: Array(100).fill(ref) }))).toHaveLength(100);
    for (const bad of [
      null,
      "ref",
      7,
      [],
      {},
      { pageId: NO_SUCH_ID },
      { blockId: "b" },
      { pageId: "nope", blockId: "b" },
      { pageId: null, blockId: "b" },
      { pageId: NO_SUCH_ID, blockId: "" },
      { pageId: NO_SUCH_ID, blockId: 5 },
      { pageId: NO_SUCH_ID, blockId: null },
      { pageId: NO_SUCH_ID, blockId: "b".repeat(101) },
    ]) {
      expectInvalid(await lookup({ refs: [ref, bad] }), "Each ref needs a pageId and blockId");
    }
    expect(data(await lookup({ refs: [{ pageId: NO_SUCH_ID, blockId: "b".repeat(100) }] }))).toEqual([{ pageId: NO_SUCH_ID, blockId: "b".repeat(100), content: null }]);
    // The block id is measured in UTF-16 units: 50 emoji are 100.
    expect(data(await lookup({ refs: [{ pageId: NO_SUCH_ID, blockId: "😀".repeat(50) }] }))).toHaveLength(1);
    expectInvalid(await lookup({ refs: [{ pageId: NO_SUCH_ID, blockId: "😀".repeat(51) }] }), "Each ref needs a pageId and blockId");
  });
});

describe("user references", () => {
  test("carry the avatar once the user has one", async () => {
    const space = await createSpace(owner, "Avatars", "avatars");
    const pictured = await person(t, owner, "pictured@example.com", { space: space.id, spaceRole: "writer" });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const me = data(await pictured.client.upload("/me/avatar", { file: new File([png], "me.png") })).user;
    expect(me.avatarUrl).toMatch(/^\/api\/images\/[0-9a-f-]{36}\.png$/);
    const ref = { id: pictured.id, name: "pictured", avatarUrl: me.avatarUrl };
    const page = await createPage(pictured.client, { spaceId: space.id, title: "Self portrait" });
    expect(page).toMatchObject({ creator: ref, lastEditor: ref, contributors: [ref] });
    expect(data(await owner.get(`/pages/recent?spaceId=${space.id}`))[0].lastEditor).toEqual(ref);
    data(await pictured.client.post(`/pages/${page.id}/delete`));
    expect(data(await owner.get(`/spaces/${space.id}/trash`))[0].deletedBy).toEqual(ref);
  });
});

describe("page routes and notifications", () => {
  test("creating, updating and listing pages notified nobody", async () => {
    for (const who of [owner, writer.client, reader.client, spaceAdmin.client]) {
      expect(data(await who.get("/notifications"))).toEqual([]);
    }
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM notifications`;
    expect(n).toBe(0);
    expect(general.slug).toBe("general");
  });
});
