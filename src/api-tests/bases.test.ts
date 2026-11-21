import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Base, Row } from "common/bases";
import { connect, doc, startServer, type Client, type TestServer } from "./harness";
import {
  addProperty,
  addRow,
  addView,
  createBase,
  expectError,
  expectInvalid,
  getBase,
  ISO,
  ok,
  PROPERTY_ID,
  queryRows,
  settle,
  SLUG_ID,
  UUID,
} from "./harness/base-fixtures";

let t: TestServer;
let owner: Client;
let ownerId: string;
let spaceId: string;
/** Members of the default space, one per space role. */
let admin: Client;
let writer: Client;
let writerId: string;
let reader: Client;
/** A workspace member who is not in the default space. */
let outsider: Client;
/** A workspace admin who is not in the default space. */
let workspaceAdmin: Client;
/** A space of the owner that nobody else is in. */
let otherSpaceId: string;

const NOWHERE = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  t = await startServer();
  let user: { id: string };
  ({ owner, user, spaceId } = await t.setupOwner());
  ownerId = user.id;
  const join = async (email: string, role: "admin" | "writer" | "reader") => {
    const member = await t.addMember(owner, email);
    ok(await owner.post(`/spaces/${spaceId}/members/add`, { role, userIds: [member.user.id] }));
    return member;
  };
  admin = (await join("admin@example.com", "admin")).client;
  const w = await join("writer@example.com", "writer");
  writer = w.client;
  writerId = w.user.id;
  reader = (await join("reader@example.com", "reader")).client;
  outsider = (await t.addMember(owner, "outsider@example.com")).client;
  workspaceAdmin = (await t.addMember(owner, "wsadmin@example.com", "admin")).client;
  otherSpaceId = ok(await owner.post("/spaces", { name: "Private", slug: "private" })).space.id;
});

afterAll(async () => {
  await t.close();
});

const seededProperty = (name: string, position: string, isPrimary = false) => ({
  id: expect.stringMatching(PROPERTY_ID),
  name,
  type: "text",
  options: {},
  isPrimary,
  position,
});

const STATUS_OPTIONS = {
  choices: [
    { id: "status-todo", name: "Not started", color: "gray", category: "todo" },
    { id: "status-doing", name: "In progress", color: "blue", category: "inProgress" },
    { id: "status-done", name: "Done", color: "green", category: "complete" },
  ],
  choiceOrder: ["status-todo", "status-doing", "status-done"],
  defaultValue: "status-todo",
};

const seededRow = (userId: string) => ({
  id: expect.stringMatching(UUID),
  cells: {},
  position: "a0",
  creatorId: userId,
  lastEditorId: userId,
  createdAt: expect.stringMatching(ISO),
  updatedAt: expect.stringMatching(ISO),
});

describe("POST /bases", () => {
  test("creates a base page and answers with its tree item", async () => {
    const res = await owner.post("/bases", { spaceId: otherSpaceId, title: "Tasks" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        page: {
          id: expect.stringMatching(UUID),
          slugId: expect.stringMatching(SLUG_ID),
          title: "Tasks",
          icon: null,
          parentId: null,
          spaceId: otherSpaceId,
          position: "a0",
          hasChildren: false,
          isBase: true,
        },
      },
    });
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("the table template seeds Title, Text 1 and Text 2, one empty row and a table view", async () => {
    const page = ok(await owner.post("/bases", { spaceId, title: "Tasks", template: "table" })).page;
    const base = await getBase(owner, page.id);
    expect<unknown>(base).toEqual({
      id: page.id,
      slugId: page.slugId,
      spaceId,
      title: "Tasks",
      icon: null,
      properties: [seededProperty("Title", "a0", true), seededProperty("Text 1", "a1"), seededProperty("Text 2", "a2")],
      views: [{ id: expect.stringMatching(UUID), name: "Table", type: "table", config: {}, position: "a0" }],
      canEdit: true,
    });
    expect(new Set(base.properties.map((p) => p.id)).size).toBe(3);
    const rows = await queryRows(owner, page.id);
    expect(rows).toEqual({
      items: [seededRow(ownerId)],
      nextCursor: null,
      references: { users: { [ownerId]: { id: ownerId, name: "Owner", avatarUrl: null } }, pages: {} },
    });
    expect(rows.items[0]!.updatedAt).toBe(rows.items[0]!.createdAt);
  });

  test("the template defaults to table", async () => {
    const page = ok(await owner.post("/bases", { spaceId })).page;
    const base = await getBase(owner, page.id);
    expect(base.properties.map((p) => p.name)).toEqual(["Title", "Text 1", "Text 2"]);
    expect(base.views.map((v) => [v.name, v.type])).toEqual([["Table", "table"]]);
  });

  test("the kanban template adds a Status property with three choices and opens on a board grouped by it", async () => {
    const page = ok(await writer.post("/bases", { spaceId, title: "Board", template: "kanban" })).page;
    const base = await getBase(writer, page.id);
    const status = base.properties[3]!;
    expect<unknown>(base).toEqual({
      id: page.id,
      slugId: page.slugId,
      spaceId,
      title: "Board",
      icon: null,
      properties: [
        seededProperty("Title", "a0", true),
        seededProperty("Text 1", "a1"),
        seededProperty("Text 2", "a2"),
        { id: expect.stringMatching(PROPERTY_ID), name: "Status", type: "status", options: STATUS_OPTIONS, isPrimary: false, position: "a3" },
      ],
      views: [
        { id: expect.stringMatching(UUID), name: "Board", type: "kanban", config: { groupByPropertyId: status.id }, position: "a0" },
        { id: expect.stringMatching(UUID), name: "Table", type: "table", config: {}, position: "a1" },
      ],
      canEdit: true,
    });
    // The seeded row has no status; rows created afterwards get the default.
    expect((await queryRows(writer, page.id)).items).toEqual([seededRow(writerId)]);
    expect((await addRow(writer, page.id)).cells).toEqual({ [status.id]: "status-todo" });
  });

  test("stores the page with an empty document, the creator as editor and contributor, and makes the creator watch it", async () => {
    const page = ok(await writer.post("/bases", { spaceId, title: "Stored" })).page;
    const [row] = await t.sql`
      SELECT is_base, content, text_content, creator_id, last_editor_id, contributor_ids::text[] AS contributor_ids, doc_version::int AS doc_version,
        deleted_at, cover FROM pages WHERE id = ${page.id}`;
    expect(row).toEqual({
      is_base: true,
      content: { type: "doc", content: [{ type: "paragraph", attrs: { id: null, indent: 0, textAlign: null } }] },
      text_content: "",
      creator_id: writerId,
      last_editor_id: writerId,
      contributor_ids: [writerId],
      doc_version: 0,
      deleted_at: null,
      cover: null,
    });
    expect<unknown>(await t.sql`SELECT user_id FROM watchers WHERE page_id = ${page.id}`).toEqual([{ user_id: writerId }]);
    // The page API shows it as a page that is a base.
    const fetched = ok(await owner.get(`/pages/${page.id}`)).page;
    expect(fetched).toMatchObject({ id: page.id, isBase: true, title: "Stored", docVersion: 0 });
    const tree = ok(await owner.get(`/spaces/${spaceId}/pages`)) as { id: string; isBase: boolean }[];
    expect(tree.find((p) => p.id === page.id)).toEqual(page);
  });

  test("title and icon are trimmed; null, blank and absent mean none", async () => {
    const create = async (body: Record<string, unknown>) => ok(await owner.post("/bases", { spaceId: otherSpaceId, ...body })).page;
    expect(await create({ title: "  Padded  ", icon: " 📊 " })).toMatchObject({ title: "Padded", icon: "📊" });
    expect(await create({})).toMatchObject({ title: null, icon: null });
    expect(await create({ title: null, icon: null })).toMatchObject({ title: null, icon: null });
    expect(await create({ title: " \t\n ", icon: "" })).toMatchObject({ title: null, icon: null });
    expect(await create({ title: "مرحبا 日本語 e\u0301" })).toMatchObject({ title: "مرحبا 日本語 e\u0301" });
  });

  test("title and icon lengths count code points: 500 and 100 are the most", async () => {
    const title = "😀".repeat(500);
    const icon = "界".repeat(100);
    expect(ok(await owner.post("/bases", { spaceId: otherSpaceId, title, icon })).page).toMatchObject({ title, icon });
    expectInvalid(await owner.post("/bases", { spaceId: otherSpaceId, title: "😀".repeat(501) }), "title must be at most 500 characters");
    expectInvalid(await owner.post("/bases", { spaceId: otherSpaceId, icon: "x".repeat(101) }), "icon must be at most 100 characters");
    // Surrounding blanks do not count.
    expect(ok(await owner.post("/bases", { spaceId: otherSpaceId, title: ` ${"x".repeat(500)} ` })).page.title).toBe("x".repeat(500));
  });

  test("rejects fields of the wrong type", async () => {
    expectInvalid(await owner.post("/bases", { spaceId, title: 5 }), "title must be a string");
    expectInvalid(await owner.post("/bases", { spaceId, title: ["a"] }), "title must be a string");
    expectInvalid(await owner.post("/bases", { spaceId, icon: true }), "icon must be a string");
    expectInvalid(await owner.post("/bases", { spaceId, icon: {} }), "icon must be a string");
    for (const template of ["calendar", "Table", "", null, 1, ["table"]]) {
      expectInvalid(await owner.post("/bases", { spaceId, template }), "template must be one of table, kanban");
    }
  });

  test("spaceId must be a UUID of a space the user is in; upper case is accepted", async () => {
    for (const body of [{}, { spaceId: null }, { spaceId: "" }, { spaceId: "general" }, { spaceId: 5 }, { spaceId: [spaceId] }, { spaceId: `${spaceId} ` }]) {
      expectInvalid(await owner.post("/bases", body), "spaceId must be a valid id");
    }
    expectError(await owner.post("/bases", { spaceId: NOWHERE }), 404, "not_found", "Space not found");
    const page = ok(await owner.post("/bases", { spaceId: spaceId.toUpperCase() })).page;
    expect(page.spaceId).toBe(spaceId);
  });

  test("the body must be a JSON object sent as application/json", async () => {
    const send = async (body: string | undefined, type?: string) => {
      const res = await owner.raw("POST", "/bases", { body, headers: type ? { "Content-Type": type } : {} });
      return { status: res.status, body: await res.json() };
    };
    // No body at all reads as an empty object.
    expect(await send(undefined)).toEqual({ status: 400, body: { error: { code: "invalid_input", message: "spaceId must be a valid id" } } });
    expect(await send("{}", "text/plain")).toEqual({ status: 415, body: { error: { code: "unsupported_media_type", message: "Expected application/json" } } });
    expect(await send("{", "application/json")).toEqual({ status: 400, body: { error: { code: "invalid_input", message: "Malformed JSON" } } });
    expect(await send("[]", "application/json")).toEqual({ status: 400, body: { error: { code: "invalid_input", message: "Expected a JSON object" } } });
    expect(await send("null", "application/json")).toEqual({ status: 400, body: { error: { code: "invalid_input", message: "Expected a JSON object" } } });
    expect(await send(JSON.stringify({ spaceId }), "Application/JSON; charset=utf-8")).toMatchObject({ status: 200 });
  });

  test("a body over 1 MiB is refused", async () => {
    const res = await owner.post("/bases", { spaceId, title: "x", padding: "x".repeat(1024 * 1024) });
    expectError(res, 413, "payload_too_large", "Request body is too large");
  });

  test("unknown fields are ignored", async () => {
    const page = ok(await owner.post("/bases", { spaceId: otherSpaceId, title: "Extra", isBase: false, position: "zz", id: NOWHERE, cells: {} })).page;
    expect(page).toMatchObject({ title: "Extra", isBase: true });
    expect(page.id).not.toBe(NOWHERE);
    expect(page.position).not.toBe("zz");
  });

  describe("placement", () => {
    let space: string;
    beforeAll(async () => {
      space = ok(await owner.post("/spaces", { name: "Placement", slug: "placement" })).space.id;
    });
    const create = async (body: Record<string, unknown> = {}) => ok(await owner.post("/bases", { spaceId: space, ...body })).page;

    test("a base goes last among the root pages, or right after afterId", async () => {
      const first = await create();
      const second = await create();
      expect([first.position, second.position]).toEqual(["a0", "a1"]);
      const between = await create({ afterId: first.id });
      expect(between.position).toBe("a0V");
      const afterLast = await create({ afterId: second.id.toUpperCase() });
      expect(afterLast.position).toBe("a2");
      // null and "" do not mean "first": they are the same as leaving afterId out.
      expect((await create({ afterId: null })).position).toBe("a3");
      expect((await create({ afterId: "" })).position).toBe("a4");
      // Pages and bases share one order.
      const page = ok(await owner.post("/pages", { spaceId: space, title: "A page" })).page;
      expect(page.position).toBe("a5");
      expect((await create({ afterId: page.id })).position).toBe("a6");
    });

    test("parentId nests the base under a page of the same space", async () => {
      const parent = ok(await owner.post("/pages", { spaceId: space, title: "Parent" })).page;
      const child = await create({ parentId: parent.id });
      expect(child).toMatchObject({ parentId: parent.id, position: "a0", hasChildren: false });
      const sibling = await create({ parentId: parent.id.toUpperCase() });
      expect(sibling).toMatchObject({ parentId: parent.id, position: "a1" });
      expect((await create({ parentId: parent.id, afterId: child.id })).position).toBe("a0V");
      expect(ok(await owner.get(`/pages/${parent.id}`)).page.hasChildren).toBe(true);
      // A base can be a parent too.
      const nested = await create({ parentId: child.id });
      expect(nested).toMatchObject({ parentId: child.id, position: "a0" });
      // null and "" mean the root.
      expect((await create({ parentId: null })).parentId).toBeNull();
      expect((await create({ parentId: "" })).parentId).toBeNull();
    });

    test("afterId must be a sibling under the same parent", async () => {
      const parent = await create();
      const root = await create();
      const child = await create({ parentId: parent.id });
      expectInvalid(await owner.post("/bases", { spaceId: space, afterId: "x" }), "afterId must be a valid id");
      expectInvalid(await owner.post("/bases", { spaceId: space, afterId: 5 }), "afterId must be a valid id");
      expectError(await owner.post("/bases", { spaceId: space, afterId: NOWHERE }), 404, "not_found", "Sibling page not found");
      expectError(await owner.post("/bases", { spaceId: space, afterId: child.id }), 404, "not_found", "Sibling page not found");
      expectError(await owner.post("/bases", { spaceId: space, parentId: parent.id, afterId: root.id }), 404, "not_found", "Sibling page not found");
      // A trashed sibling is not a sibling any more.
      ok(await owner.post(`/pages/${root.id}/delete`));
      expectError(await owner.post("/bases", { spaceId: space, afterId: root.id }), 404, "not_found", "Sibling page not found");
    });

    test("parentId must be a page of that space that is not in the trash", async () => {
      const elsewhere = ok(await owner.post("/pages", { spaceId, title: "Elsewhere" })).page;
      const trashed = await create();
      ok(await owner.post(`/pages/${trashed.id}/delete`));
      expectInvalid(await owner.post("/bases", { spaceId: space, parentId: "x" }), "parentId must be a valid id");
      expectInvalid(await owner.post("/bases", { spaceId: space, parentId: 1 }), "parentId must be a valid id");
      for (const parentId of [NOWHERE, elsewhere.id, trashed.id]) {
        expectError(await owner.post("/bases", { spaceId: space, parentId }), 404, "not_found", "Parent page not found");
      }
      // Nothing was created by the refused requests.
      const [{ count }] = await t.sql`SELECT count(*)::int AS count FROM pages WHERE space_id = ${space} AND parent_id IN (${elsewhere.id}, ${trashed.id})`;
      expect(count).toBe(0);
    });
  });

  test("needs a session, membership of the space and at least the writer role", async () => {
    expectError(await t.client().post("/bases", { spaceId }), 401, "unauthorized", "Sign in required");
    expectError(await outsider.post("/bases", { spaceId }), 404, "not_found", "Space not found");
    // Workspace admins get no special access to spaces they are not in.
    expectError(await workspaceAdmin.post("/bases", { spaceId }), 404, "not_found", "Space not found");
    expectError(await reader.post("/bases", { spaceId }), 403, "forbidden", "You do not have permission to do this");
    expect((await writer.post("/bases", { spaceId })).status).toBe(200);
    expect((await admin.post("/bases", { spaceId })).status).toBe(200);
    // The input is checked before the role.
    expectInvalid(await reader.post("/bases", { spaceId: "x" }), "spaceId must be a valid id");
    // The role is checked before the other fields.
    expectError(await reader.post("/bases", { spaceId, template: "nope" }), 403, "forbidden", "You do not have permission to do this");
  });

  test("a role held through a group counts", async () => {
    const member = await t.addMember(owner, "grouped@example.com");
    const group = ok(await owner.post("/groups", { name: "Base makers" })).group;
    ok(await owner.post(`/groups/${group.id}/members/add`, { userIds: [member.user.id] }));
    ok(await owner.post(`/spaces/${otherSpaceId}/members/add`, { role: "writer", groupIds: [group.id] }));
    const page = ok(await member.client.post("/bases", { spaceId: otherSpaceId, title: "By a group member" })).page;
    expect((await getBase(member.client, page.id)).canEdit).toBe(true);
    expect((await member.client.post(`/bases/${page.id}/rows`, {})).status).toBe(200);
  });

  test("tells the members of the space, and nobody else, that the tree changed", async () => {
    const [ownerSocket, readerSocket, outsiderSocket] = await Promise.all([connect(owner), connect(reader), connect(outsider)]);
    ok(await writer.post("/bases", { spaceId, title: "Announced" }));
    const event = { t: "event", kind: "tree", spaceId };
    expect(await ownerSocket.next()).toEqual(event);
    expect(await readerSocket.next()).toEqual(event);
    expect(await settle(outsiderSocket)).toEqual([]);
    // A refused request announces nothing: the next event is the one of the next success.
    expectInvalid(await writer.post("/bases", { spaceId, template: "nope" }), "template must be one of table, kanban");
    ok(await writer.post("/bases", { spaceId, title: "Second" }));
    expect(await ownerSocket.next()).toEqual(event);
    expect(await settle(ownerSocket)).toEqual([]);
    await Promise.all([ownerSocket.close(), readerSocket.close(), outsiderSocket.close()]);
  });
});

describe("POST /pages/:id/convert-to-base", () => {
  const newPage = async (title: string, content?: unknown) => ok(await owner.post("/pages", { spaceId, title, content })).page;

  test("turns a page into a base seeded from the table template and answers with the base", async () => {
    const page = await newPage("Later a base", doc("kept"));
    const res = await writer.post(`/pages/${page.id}/convert-to-base`, {});
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: page.id,
      slugId: page.slugId,
      spaceId,
      title: "Later a base",
      icon: null,
      properties: [seededProperty("Title", "a0", true), seededProperty("Text 1", "a1"), seededProperty("Text 2", "a2")],
      views: [{ id: expect.stringMatching(UUID), name: "Table", type: "table", config: {}, position: "a0" }],
      canEdit: true,
    });
    expect(await getBase(owner, page.id)).toEqual(res.body.data);
    expect((await queryRows(owner, page.id)).items).toEqual([seededRow(writerId)]);
    // The page keeps its document; the converter becomes its last editor.
    const after = ok(await owner.get(`/pages/${page.id}`)).page;
    expect(after.isBase).toBe(true);
    expect(after.content).toEqual(page.content);
    expect(after.lastEditor.id).toBe(writerId);
    expect(after.creator.id).toBe(ownerId);
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(page.updatedAt));
    expect(after.docVersion).toBe(page.docVersion);
  });

  test("the kanban template, a missing body and the slug id all work", async () => {
    const kanban = await newPage("Kanban later");
    const converted = ok(await owner.post(`/pages/${kanban.slugId}/convert-to-base`, { template: "kanban" })) as Base;
    expect(converted.properties.map((p) => [p.name, p.type, p.position])).toEqual([
      ["Title", "text", "a0"],
      ["Text 1", "text", "a1"],
      ["Text 2", "text", "a2"],
      ["Status", "status", "a3"],
    ]);
    expect<unknown>(converted.properties[3]!.options).toEqual(STATUS_OPTIONS);
    expect(converted.views.map((v) => [v.name, v.type, v.position, v.config])).toEqual([
      ["Board", "kanban", "a0", { groupByPropertyId: converted.properties[3]!.id }],
      ["Table", "table", "a1", {}],
    ]);
    const bare = await newPage("No body");
    const res = await owner.raw("POST", `/pages/${bare.id.toUpperCase()}/convert-to-base`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Base }).data.views.map((v) => v.type)).toEqual(["table"]);
  });

  test("a page that is already a base is refused, whatever the body", async () => {
    const base = await createBase(owner, spaceId);
    expectInvalid(await owner.post(`/pages/${base.id}/convert-to-base`, {}), "This page is already a base");
    expectInvalid(await owner.post(`/pages/${base.id}/convert-to-base`, { template: "nope" }), "This page is already a base");
    const converted = await newPage("Twice");
    ok(await owner.post(`/pages/${converted.id}/convert-to-base`, {}));
    expectInvalid(await owner.post(`/pages/${converted.id}/convert-to-base`, { template: "kanban" }), "This page is already a base");
    expect((await getBase(owner, converted.id)).views).toHaveLength(1);
  });

  test("a template other than table or kanban is refused and leaves the page a page", async () => {
    const page = await newPage("Stays a page");
    for (const template of ["calendar", "", null, 2]) {
      expectInvalid(await owner.post(`/pages/${page.id}/convert-to-base`, { template }), "template must be one of table, kanban");
    }
    expect(ok(await owner.get(`/pages/${page.id}`)).page.isBase).toBe(false);
    expectError(await owner.get(`/bases/${page.id}`), 404, "not_found", "Base not found");
  });

  test("a page that is not marked as a base but still holds base data answers 409", async () => {
    const base = await createBase(owner, spaceId);
    // No endpoint turns a base back into a page; the state is arranged directly.
    await t.sql`UPDATE pages SET is_base = false WHERE id = ${base.id}`;
    expectError(await owner.post(`/pages/${base.id}/convert-to-base`, {}), 409, "already_base", "This page already has base data");
    const [row] = await t.sql`SELECT is_base FROM pages WHERE id = ${base.id}`;
    expect(row.is_base).toBe(false);
    const [{ count }] = await t.sql`SELECT count(*)::int AS count FROM base_properties WHERE page_id = ${base.id}`;
    expect(count).toBe(3);
  });

  test("needs a session and the writer role on the page's space; trashed and unknown pages are not found", async () => {
    const page = await newPage("Guarded");
    expectError(await t.client().post(`/pages/${page.id}/convert-to-base`, {}), 401, "unauthorized", "Sign in required");
    expectError(await outsider.post(`/pages/${page.id}/convert-to-base`, {}), 404, "not_found", "Page not found");
    expectError(await workspaceAdmin.post(`/pages/${page.id}/convert-to-base`, {}), 404, "not_found", "Page not found");
    expectError(await reader.post(`/pages/${page.id}/convert-to-base`, {}), 403, "forbidden", "You do not have permission to do this");
    expectError(await owner.post(`/pages/${NOWHERE}/convert-to-base`, {}), 404, "not_found", "Page not found");
    expectError(await owner.post(`/pages/not-a-page!/convert-to-base`, {}), 404, "not_found", "Page not found");
    ok(await owner.post(`/pages/${page.id}/delete`));
    expectError(await owner.post(`/pages/${page.id}/convert-to-base`, {}), 404, "not_found", "Page not found");
    ok(await owner.post(`/pages/${page.id}/restore`));
    expect((await admin.post(`/pages/${page.id}/convert-to-base`, {})).status).toBe(200);
  });

  test("tells the members of the space that the tree changed", async () => {
    const page = await newPage("Announced conversion");
    const socket = await connect(reader);
    ok(await owner.post(`/pages/${page.id}/convert-to-base`, {}));
    expect(await socket.next()).toEqual({ t: "event", kind: "tree", spaceId });
    expect(await settle(socket)).toEqual([]);
    await socket.close();
  });
});

describe("GET /bases/:id", () => {
  let base: Base;
  beforeAll(async () => {
    base = await createBase(owner, spaceId, { title: "Readable" });
  });

  test("answers by id (in either case) and by slug id", async () => {
    const byId = await owner.get(`/bases/${base.id}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual({ data: base });
    expect(byId.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(byId.headers.get("cache-control")).toBe("no-store");
    expect(byId.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok(await owner.get(`/bases/${base.id.toUpperCase()}`))).toEqual(base);
    expect(ok(await owner.get(`/bases/${base.slugId}`))).toEqual(base);
  });

  test("canEdit is true for writers and admins of the space and false for readers", async () => {
    expect((await getBase(admin, base.id)).canEdit).toBe(true);
    expect((await getBase(writer, base.id)).canEdit).toBe(true);
    expect(await getBase(reader, base.id)).toEqual({ ...base, canEdit: false });
  });

  test("properties and views come in position order, ties by id", async () => {
    const ordered = await createBase(owner, spaceId);
    const late = await addProperty(owner, ordered.id, "Late", "number");
    const early = ok(await owner.post(`/bases/${ordered.id}/properties/${late.id}/update`, { position: "Zz" }));
    expect(early.position).toBe("Zz");
    // Two views on the same position as the seeded one.
    const one = await addView(owner, ordered.id, { name: "One" });
    const two = await addView(owner, ordered.id, { name: "Two" });
    for (const view of [one, two]) ok(await owner.post(`/bases/${ordered.id}/views/${view.id}/update`, { position: "a0" }));
    const fetched = await getBase(owner, ordered.id);
    expect(fetched.properties.map((p) => p.name)).toEqual(["Late", "Title", "Text 1", "Text 2"]);
    const expected = [ordered.views[0]!.id, one.id, two.id].sort();
    expect(fetched.views.map((v) => v.id)).toEqual(expected);
    // Positions compare bytewise: upper case sorts before lower case.
    ok(await owner.post(`/bases/${ordered.id}/views/${two.id}/update`, { position: "Zz" }));
    ok(await owner.post(`/bases/${ordered.id}/views/${one.id}/update`, { position: "a00" }));
    expect((await getBase(owner, ordered.id)).views.map((v) => v.id)).toEqual([two.id, ordered.views[0]!.id, one.id]);
  });

  test("reflects the page's title and icon", async () => {
    const titled = await createBase(owner, spaceId, { title: "Before" });
    ok(await owner.post(`/pages/${titled.id}/update`, { title: "After 🚀", icon: "🚀" }));
    expect(await getBase(owner, titled.id)).toMatchObject({ title: "After 🚀", icon: "🚀" });
    ok(await owner.post(`/pages/${titled.id}/update`, { title: null, icon: null }));
    expect(await getBase(owner, titled.id)).toMatchObject({ title: null, icon: null });
  });

  test("a base in the trash can still be read, but not edited by anyone", async () => {
    const trashed = await createBase(owner, spaceId, { title: "Trashed" });
    ok(await owner.post(`/pages/${trashed.id}/delete`));
    expect(await getBase(owner, trashed.id)).toEqual({ ...trashed, canEdit: false });
    expect((await getBase(reader, trashed.id)).canEdit).toBe(false);
    ok(await owner.post(`/pages/${trashed.id}/restore`));
    expect((await getBase(owner, trashed.id)).canEdit).toBe(true);
  });

  test("needs a session and membership; pages that are not bases and unknown references are not found", async () => {
    expectError(await t.client().get(`/bases/${base.id}`), 401, "unauthorized", "Sign in required");
    expectError(await outsider.get(`/bases/${base.id}`), 404, "not_found", "Page not found");
    expectError(await outsider.get(`/bases/${base.slugId}`), 404, "not_found", "Page not found");
    expectError(await workspaceAdmin.get(`/bases/${base.id}`), 404, "not_found", "Page not found");
    expectError(await owner.get(`/bases/${NOWHERE}`), 404, "not_found", "Page not found");
    expectError(await owner.get(`/bases/NoSuchSlug`), 404, "not_found", "Page not found");
    expectError(await owner.get(`/bases/not-a-ref!`), 404, "not_found", "Page not found");
    expectError(await owner.get(`/bases/${"x".repeat(33)}`), 404, "not_found", "Page not found");
    const page = ok(await owner.post("/pages", { spaceId, title: "Plain page" })).page;
    expectError(await owner.get(`/bases/${page.id}`), 404, "not_found", "Base not found");
    expectError(await reader.get(`/bases/${page.slugId}`), 404, "not_found", "Base not found");
    // Outsiders cannot tell a plain page from a missing one.
    expectError(await outsider.get(`/bases/${page.id}`), 404, "not_found", "Page not found");
  });
});

describe("POST /bases/resolve-pages", () => {
  test("resolves the ids of readable pages to what a link needs, keyed by lower-case id", async () => {
    const page = ok(await owner.post("/pages", { spaceId, title: "Linked", icon: "🔗" })).page;
    const untitled = await createBase(owner, otherSpaceId, { title: null });
    const res = await owner.post("/bases/resolve-pages", {
      pageIds: [page.id.toUpperCase(), "junk", page.id, NOWHERE, untitled.id, page.slugId],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        pages: {
          [page.id]: { id: page.id, slugId: page.slugId, title: "Linked", icon: "🔗", spaceSlug: "general" },
          [untitled.id]: { id: untitled.id, slugId: untitled.slugId, title: null, icon: null, spaceSlug: "private" },
        },
      },
    });
  });

  test("leaves out pages in the trash and pages of spaces the user is not in", async () => {
    const visible = ok(await owner.post("/pages", { spaceId, title: "Visible" })).page;
    const trashed = ok(await owner.post("/pages", { spaceId, title: "Trashed" })).page;
    ok(await owner.post(`/pages/${trashed.id}/delete`));
    const secret = ok(await owner.post("/pages", { spaceId: otherSpaceId, title: "Secret" })).page;
    const pageIds = [visible.id, trashed.id, secret.id];
    expect(Object.keys(ok(await owner.post("/bases/resolve-pages", { pageIds })).pages).sort()).toEqual([visible.id, secret.id].sort());
    expect(Object.keys(ok(await reader.post("/bases/resolve-pages", { pageIds })).pages)).toEqual([visible.id]);
    expect(ok(await outsider.post("/bases/resolve-pages", { pageIds }))).toEqual({ pages: {} });
    expect(ok(await workspaceAdmin.post("/bases/resolve-pages", { pageIds }))).toEqual({ pages: {} });
  });

  test("no ids, or none that are UUIDs, resolve to nothing", async () => {
    expect(ok(await owner.post("/bases/resolve-pages", {}))).toEqual({ pages: {} });
    expect(ok(await owner.post("/bases/resolve-pages", { pageIds: [] }))).toEqual({ pages: {} });
    expect(ok(await owner.post("/bases/resolve-pages", { pageIds: ["a", "b".repeat(64)] }))).toEqual({ pages: {} });
    const res = await owner.raw("POST", "/bases/resolve-pages");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { pages: {} } });
  });

  test("pageIds must be a list of at most 500 strings of 1 to 64 characters", async () => {
    const page = ok(await owner.post("/pages", { spaceId, title: "Many" })).page;
    const many = ok(await owner.post("/bases/resolve-pages", { pageIds: [...Array(499).fill("x"), ` ${page.id} `] }));
    expect(Object.keys(many.pages)).toEqual([page.id]);
    for (const pageIds of ["x", null, 5, { 0: "x" }, Array(501).fill("x")]) {
      expectInvalid(await owner.post("/bases/resolve-pages", { pageIds }), "pageIds must be a list of at most 500 items");
    }
    expectInvalid(await owner.post("/bases/resolve-pages", { pageIds: [page.id, 1] }), "pageIds must be a string");
    expectInvalid(await owner.post("/bases/resolve-pages", { pageIds: [null] }), "pageIds must be a string");
    expectInvalid(await owner.post("/bases/resolve-pages", { pageIds: [""] }), "pageIds is required");
    expectInvalid(await owner.post("/bases/resolve-pages", { pageIds: ["  "] }), "pageIds is required");
    expectInvalid(await owner.post("/bases/resolve-pages", { pageIds: ["x".repeat(65)] }), "pageIds must be at most 64 characters");
  });

  test("needs a session", async () => {
    expectError(await t.client().post("/bases/resolve-pages", { pageIds: [] }), 401, "unauthorized", "Sign in required");
  });
});

describe("access to the endpoints of a base", () => {
  interface Fixture {
    base: Base;
    rows: Row[];
    propertyId: string;
    viewId: string;
  }
  /** A base with two spare rows, a spare property and a spare view, so every endpoint has something to act on. */
  const fixture = async (): Promise<Fixture> => {
    const base = await createBase(owner, spaceId, { title: "Guarded" });
    const rows = [await addRow(owner, base.id), await addRow(owner, base.id)];
    const property = await addProperty(owner, base.id, "Spare", "number");
    const view = await addView(owner, base.id, { name: "Spare" });
    return { base, rows, propertyId: property.id, viewId: view.id };
  };

  type Endpoint = [method: "GET" | "POST", path: string, body: unknown, needs: "reader" | "writer"];
  const endpoints = (f: Fixture, ref = f.base.id): Endpoint[] => [
    ["GET", `/bases/${ref}`, undefined, "reader"],
    ["POST", `/bases/${ref}/rows/query`, {}, "reader"],
    ["GET", `/bases/${ref}/rows/${f.rows[0]!.id}`, undefined, "reader"],
    ["GET", `/bases/${ref}/export.csv`, undefined, "reader"],
    ["POST", `/bases/${ref}/rows`, { cells: {} }, "writer"],
    ["POST", `/bases/${ref}/rows/${f.rows[0]!.id}/update`, { cells: {} }, "writer"],
    ["POST", `/bases/${ref}/rows/delete`, { rowIds: [f.rows[1]!.id] }, "writer"],
    ["POST", `/bases/${ref}/properties`, { name: "Another", type: "text" }, "writer"],
    ["POST", `/bases/${ref}/properties/${f.propertyId}/update`, { name: "Renamed" }, "writer"],
    ["POST", `/bases/${ref}/properties/${f.propertyId}/delete`, {}, "writer"],
    ["POST", `/bases/${ref}/views`, { name: "More" }, "writer"],
    ["POST", `/bases/${ref}/views/${f.viewId}/update`, { name: "Renamed" }, "writer"],
    ["POST", `/bases/${ref}/views/${f.viewId}/delete`, {}, "writer"],
  ];
  const call = (client: Client, [method, path, body]: Endpoint) => client.request(method, path, body);

  /** What the database holds for a base, to prove a refused request changed nothing. */
  const snapshot = async (baseId: string) => ({
    properties: await t.sql`SELECT id, name, type, options, position, updated_at FROM base_properties WHERE page_id = ${baseId} ORDER BY id`,
    rows: await t.sql`SELECT id, cells, position, updated_at FROM base_rows WHERE page_id = ${baseId} ORDER BY id`,
    views: await t.sql`SELECT id, name, type, config, position, updated_at FROM base_views WHERE page_id = ${baseId} ORDER BY id`,
  });

  test("every endpoint needs a session", async () => {
    const f = await fixture();
    const before = await snapshot(f.base.id);
    for (const endpoint of endpoints(f)) {
      expectError(await call(t.client(), endpoint), 401, "unauthorized", "Sign in required");
    }
    expect(await snapshot(f.base.id)).toEqual(before);
  });

  test("people outside the space, workspace admins included, find no page", async () => {
    const f = await fixture();
    const before = await snapshot(f.base.id);
    for (const client of [outsider, workspaceAdmin]) {
      for (const endpoint of [...endpoints(f), ...endpoints(f, f.base.slugId)]) {
        expectError(await call(client, endpoint), 404, "not_found", "Page not found");
      }
    }
    expect(await snapshot(f.base.id)).toEqual(before);
  });

  test("readers can read, query and export, and are refused every change", async () => {
    const f = await fixture();
    const before = await snapshot(f.base.id);
    for (const endpoint of endpoints(f)) {
      const res = await call(reader, endpoint);
      if (endpoint[3] === "reader") expect([endpoint[1], res.status]).toEqual([endpoint[1], 200]);
      else expectError(res, 403, "forbidden", "You do not have permission to do this");
    }
    expect(await snapshot(f.base.id)).toEqual(before);
    // The role is checked before the body is read.
    const res = await reader.raw("POST", `/bases/${f.base.id}/rows`, { body: "{", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "You do not have permission to do this" } });
  });

  test("writers and space admins can use every endpoint, by id or slug id", async () => {
    for (const [client, bySlug] of [
      [writer, false],
      [admin, true],
    ] as const) {
      const f = await fixture();
      for (const endpoint of endpoints(f, bySlug ? f.base.slugId : f.base.id.toUpperCase())) {
        const res = await call(client, endpoint);
        expect([endpoint[1], res.status]).toEqual([endpoint[1], 200]);
      }
      const after = await getBase(owner, f.base.id);
      expect(after.properties.map((p) => p.name)).toEqual(["Title", "Text 1", "Text 2", "Another"]);
      expect(after.views.map((v) => v.name)).toEqual(["Table", "More"]);
      expect((await queryRows(owner, f.base.id)).items).toHaveLength(3);
    }
  });

  test("a page that is not a base has none of them", async () => {
    const f = await fixture();
    const page = ok(await owner.post("/pages", { spaceId, title: "Not a base" })).page;
    for (const endpoint of endpoints(f, page.id)) {
      expectError(await call(owner, endpoint), 404, "not_found", "Base not found");
    }
    // A reader is told the same on the endpoints a reader may use, and is refused on the others before the page is looked at more closely.
    for (const endpoint of endpoints(f, page.id)) {
      const res = await call(reader, endpoint);
      if (endpoint[3] === "reader") expectError(res, 404, "not_found", "Base not found");
      else expectError(res, 403, "forbidden", "You do not have permission to do this");
    }
  });

  test("a base in the trash stays readable and refuses every change as if the page were gone", async () => {
    const f = await fixture();
    ok(await owner.post(`/pages/${f.base.id}/delete`));
    const before = await snapshot(f.base.id);
    for (const client of [owner, reader]) {
      for (const endpoint of endpoints(f)) {
        const res = await call(client, endpoint);
        if (endpoint[3] === "reader") expect([endpoint[1], res.status]).toEqual([endpoint[1], 200]);
        else if (client === reader) expectError(res, 403, "forbidden", "You do not have permission to do this");
        else expectError(res, 404, "not_found", "Page not found");
      }
    }
    expect(await snapshot(f.base.id)).toEqual(before);
  });

  test("a base deleted for good is gone, with its properties, rows and views", async () => {
    const f = await fixture();
    ok(await owner.post(`/pages/${f.base.id}/delete`));
    ok(await owner.post(`/pages/${f.base.id}/delete-permanently`));
    for (const endpoint of endpoints(f)) {
      expectError(await call(owner, endpoint), 404, "not_found", "Page not found");
    }
    expect(await snapshot(f.base.id)).toEqual({ properties: [], rows: [], views: [] });
  });

  test("a member who loses the space loses its bases", async () => {
    const f = await fixture();
    const member = await t.addMember(owner, "leaver@example.com");
    ok(await owner.post(`/spaces/${spaceId}/members/add`, { role: "writer", userIds: [member.user.id] }));
    expect((await member.client.post(`/bases/${f.base.id}/rows`, {})).status).toBe(200);
    const members = ok(await owner.get(`/spaces/${spaceId}/members`)) as { id: string; user?: { id: string } | null }[];
    const membership = members.find((m) => m.user?.id === member.user.id)!;
    ok(await owner.post(`/spaces/${spaceId}/members/role`, { memberId: membership.id, role: "reader" }));
    expectError(await member.client.post(`/bases/${f.base.id}/rows`, {}), 403, "forbidden", "You do not have permission to do this");
    expect((await getBase(member.client, f.base.id)).canEdit).toBe(false);
    ok(await owner.post(`/spaces/${spaceId}/members/remove`, { memberId: membership.id }));
    expectError(await member.client.get(`/bases/${f.base.id}`), 404, "not_found", "Page not found");
  });
});

describe("the in-process tests of bases that involve other features", () => {
  test("duplicating a base copies its properties, rows and views", async () => {
    const base = await createBase(owner, spaceId);
    const title = base.properties[0]!;
    const files = await addProperty(owner, base.id, "Files", "file");
    const up = ok(await owner.uploadFile(new File(["attached"], "a.txt", { type: "text/plain" }), base.id));
    await addRow(owner, base.id, { [title.id]: "copied row", [files.id]: [{ id: up.id, fileName: up.name, url: up.url }] });
    const res = await owner.post(`/pages/${base.id}/duplicate`, {});
    expect(res.status).toBe(200);
    const copy = await getBase(owner, res.body.data.page.id);
    expect(copy.properties.map((p) => p.id)).toEqual([...base.properties.map((p) => p.id), files.id]);
    expect(copy.views).toHaveLength(1);
    const rows = (await queryRows(owner, copy.id)).items;
    expect(rows.map((r) => r.cells[title.id] ?? null)).toEqual([null, "copied row"]);
    const [copied] = rows[1]!.cells[files.id] as { id: string; url: string }[];
    expect(copied!.id).not.toBe(up.id);
    expect(copied!.url).toContain(copied!.id);
    // The copy survives the original being deleted.
    ok(await owner.post(`/pages/${base.id}/delete-permanently`));
    const file = await owner.raw("GET", copied!.url.replace("/api", ""));
    expect(await file.text()).toBe("attached");
  });

  test("a base exports as a Markdown table", async () => {
    const base = await createBase(owner, spaceId);
    await addRow(owner, base.id, { [base.properties[0]!.id]: "a | b" });
    const res = await owner.raw("GET", `/pages/${base.id}/export?format=markdown`);
    expect(await res.text()).toBe("# Tasks\n\n| Title | Text 1 | Text 2 |\n| --- | --- | --- |\n|  |  |  |\n| a \\| b |  |  |\n");
  });

  test("a published base shows its rows to anonymous visitors", async () => {
    const base = await createBase(owner, spaceId);
    const title = base.properties[0]!;
    await addRow(owner, base.id, { [title.id]: "public row" });
    const share = ok(await owner.post(`/pages/${base.id}/share`, {}));
    const res = await t.client().get(`/public/shares/${share.share.key}`);
    expect(res.status).toBe(200);
    expect(res.body.data.page.base.properties.map((p: { name: string }) => p.name)).toEqual(["Title", "Text 1", "Text 2"]);
    expect(res.body.data.page.base.rows.map((r: Row) => r.cells[title.id] ?? null)).toEqual([null, "public row"]);
  });
});
