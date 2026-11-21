import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Base } from "common/bases";
import { connect, startServer, type Client, type Socket, type TestServer } from "./harness";
import { addView, createBase, expectError, expectInvalid, getBase, nextBaseEvent, ok, UUID } from "./harness/base-fixtures";

let t: TestServer;
let owner: Client;
let ownerId: string;
let spaceId: string;
let writer: Client;
let writerId: string;
let socket: Socket;

const NOWHERE = "00000000-0000-4000-8000-000000000000";
const INVALID = "Invalid view config";

beforeAll(async () => {
  t = await startServer();
  let user: { id: string };
  ({ owner, user, spaceId } = await t.setupOwner());
  ownerId = user.id;
  const member = await t.addMember(owner, "writer@example.com");
  ok(await owner.post(`/spaces/${spaceId}/members/add`, { role: "writer", userIds: [member.user.id] }));
  writer = member.client;
  writerId = member.user.id;
  socket = await connect(writer);
});

afterAll(async () => {
  await socket.close();
  await t.close();
});

const newBase = (title = "Views") => createBase(owner, spaceId, { title });
const create = (baseId: string, body: unknown) => owner.post(`/bases/${baseId}/views`, body);
const update = (baseId: string, viewId: string, body: unknown) => owner.post(`/bases/${baseId}/views/${viewId}/update`, body);
const remove = (baseId: string, viewId: string, body: unknown = {}) => owner.post(`/bases/${baseId}/views/${viewId}/delete`, body);
const baseEventOf = (base: Base, requestId?: string) => ({
  t: "event",
  kind: "base",
  pageId: base.id,
  spaceId,
  event: { op: "base", base },
  ...(requestId === undefined ? {} : { requestId }),
});

/** A config that uses every key the server knows, and one it does not. */
const fullConfig = (a: string, b: string) => ({
  sorts: [{ propertyId: a, direction: "asc" }, { propertyId: b, direction: "desc" }],
  filter: { op: "or", children: [{ propertyId: a, op: "contains", value: "x" }, { op: "and", children: [{ propertyId: b, op: "isEmpty" }] }] },
  hiddenPropertyIds: [a],
  visiblePropertyIds: [b, a],
  propertyOrder: [b, a],
  propertyWidths: { [a]: 120, [b]: 80.5 },
  groupByPropertyId: a,
  datePropertyId: b,
  hiddenChoiceIds: ["c1"],
  choiceOrder: ["c2", "c1"],
  rowHeight: "tall",
  nested: { anything: [1, null, { deep: true }] },
});

describe("POST /bases/:id/views", () => {
  test("adds a table view named View with an empty config after the last view", async () => {
    const base = await newBase();
    const res = await writer.post(`/bases/${base.id}/views`, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { id: expect.stringMatching(UUID), name: "View", type: "table", config: {}, position: "a1" } });
    const bare = await owner.raw("POST", `/bases/${base.id}/views`);
    expect(((await bare.json()) as any).data).toEqual({ id: expect.stringMatching(UUID), name: "View", type: "table", config: {}, position: "a2" });
    const views = (await getBase(owner, base.id)).views;
    expect(views).toEqual([base.views[0]!, res.body.data, expect.objectContaining({ position: "a2" })]);
    const rows = await t.sql`SELECT creator_id FROM base_views WHERE page_id = ${base.id} ORDER BY position`;
    expect(rows.map((r: { creator_id: string }) => r.creator_id)).toEqual([ownerId, writerId, ownerId]);
    // The new view goes after the largest position.
    ok(await update(base.id, base.views[0]!.id, { position: "z" }));
    expect(ok(await create(base.id, {})).position).toBe("zV");
  });

  test("the name is trimmed and at most 200 characters; a blank one becomes View", async () => {
    const base = await newBase();
    expect(ok(await create(base.id, { name: "  Board  " })).name).toBe("Board");
    for (const name of ["", "   ", "\t\n"]) expect(ok(await create(base.id, { name })).name).toBe("View");
    const longest = "😀".repeat(200);
    expect(ok(await create(base.id, { name: longest })).name).toBe(longest);
    expect(ok(await create(base.id, { name: "Board" })).name).toBe("Board");
    expectInvalid(await create(base.id, { name: "x".repeat(201) }), "name must be at most 200 characters");
    for (const name of [null, 5, ["x"], {}]) expectInvalid(await create(base.id, { name }), "name must be a string");
  });

  test("the type is table, kanban or calendar", async () => {
    const base = await newBase();
    for (const type of ["table", "kanban", "calendar"]) expect(ok(await create(base.id, { type })).type).toBe(type);
    for (const type of ["gallery", "Table", "", null, 5]) expectInvalid(await create(base.id, { type }), "type must be one of table, kanban, calendar");
    expect((await getBase(owner, base.id)).views.map((v) => v.type)).toEqual(["table", "table", "kanban", "calendar"]);
  });

  test("the config is stored with every known key checked and unknown keys kept", async () => {
    const base = await newBase();
    const [a, b] = base.properties.map((p) => p.id);
    const config = fullConfig(a!, b!);
    const view = ok(await create(base.id, { name: "Full", type: "calendar", config }));
    expect(view).toEqual({ id: expect.stringMatching(UUID), name: "Full", type: "calendar", config, position: "a1" });
    expect((await getBase(owner, base.id)).views[1]).toEqual(view);
    // Nothing checks that the ids are properties or choices of this base.
    const foreign = fullConfig("pnotathing", "");
    expect(ok(await create(base.id, { config: foreign })).config).toEqual(foreign);
    expect(ok(await create(base.id, { config: null })).config).toEqual({});
    expect(ok(await create(base.id, { config: {} })).config).toEqual({});
  });

  test("filters and sorts are reduced to what the server understands; null ones are dropped", async () => {
    const base = await newBase();
    const a = base.properties[0]!.id;
    const view = ok(
      await create(base.id, {
        config: {
          filter: { op: "and", children: [{ propertyId: a, op: "eq", value: [1, "two"], label: "dropped" }, { op: "or", children: [], collapsed: true }], id: "dropped" },
          sorts: [{ propertyId: a, direction: "desc", nulls: "first" }],
        },
      }),
    );
    expect(view.config).toEqual({
      filter: { op: "and", children: [{ propertyId: a, op: "eq", value: [1, "two"] }, { op: "or", children: [] }] },
      sorts: [{ propertyId: a, direction: "desc" }],
    });
    expect(ok(await create(base.id, { config: { filter: null, sorts: null, other: null } })).config).toEqual({ other: null });
    expect(ok(await create(base.id, { config: { sorts: [] } })).config).toEqual({ sorts: [] });
    expectInvalid(await create(base.id, { config: { filter: { op: "xor", children: [] } } }), "Invalid filter");
    expectInvalid(await create(base.id, { config: { filter: "x" } }), "Invalid filter");
    expectInvalid(await create(base.id, { config: { filter: { op: "and", children: [{ propertyId: a, op: "like" }] } } }), "Invalid filter");
    expectInvalid(await create(base.id, { config: { sorts: [{ propertyId: a, direction: "up" }] } }), "Invalid sorts");
    expectInvalid(await create(base.id, { config: { sorts: {} } }), "Invalid sorts");
    expectInvalid(await create(base.id, { config: { sorts: Array(11).fill({ propertyId: a, direction: "asc" }) } }), "Invalid sorts");
  });

  test("a config that is not an object, or has a malformed key, is refused", async () => {
    const base = await newBase();
    const invalid: unknown[] = ["x", 5, true, [], [{}]];
    for (const key of ["hiddenPropertyIds", "visiblePropertyIds", "propertyOrder", "hiddenChoiceIds", "choiceOrder"]) {
      for (const value of ["x", null, {}, 5, [5], [null], ["ok", "x".repeat(65)], Array(501).fill("x")]) invalid.push({ [key]: value });
    }
    for (const value of ["x", null, 5, [], [100], { a: 0 }, { a: 0.99 }, { a: 5001 }, { a: "100" }, { a: null }, { a: 100, b: true }]) invalid.push({ propertyWidths: value });
    for (const key of ["groupByPropertyId", "datePropertyId"]) {
      for (const value of [null, 5, true, ["x"], {}, "x".repeat(65)]) invalid.push({ [key]: value });
    }
    for (const config of invalid) {
      const res = await create(base.id, { config });
      expect([JSON.stringify(config).slice(0, 70), res.status, res.body.error?.message]).toEqual([JSON.stringify(config).slice(0, 70), 400, INVALID]);
    }
    expect((await getBase(owner, base.id)).views).toEqual(base.views);
    // The limits themselves are fine.
    const most = Array(500).fill("x".repeat(64));
    const accepted = ok(
      await create(base.id, {
        config: { hiddenPropertyIds: most, choiceOrder: [], propertyWidths: { a: 1, b: 5000, c: 1.5 }, groupByPropertyId: "x".repeat(64), datePropertyId: "" },
      }),
    );
    expect(accepted.config).toEqual({ hiddenPropertyIds: most, choiceOrder: [], propertyWidths: { a: 1, b: 5000, c: 1.5 }, groupByPropertyId: "x".repeat(64), datePropertyId: "" });
    expect(ok(await create(base.id, { config: { propertyWidths: {} } })).config).toEqual({ propertyWidths: {} });
  });

  test("a config may be up to 256 KiB of JSON", async () => {
    const base = await newBase();
    // `{"note":"…"}` is 11 characters around the text.
    expect(ok(await create(base.id, { config: { note: "x".repeat(256 * 1024 - 11) } })).config.note).toHaveLength(256 * 1024 - 11);
    expectInvalid(await create(base.id, { config: { note: "x".repeat(256 * 1024 - 10) } }), INVALID);
    expectError(await create(base.id, { config: { note: "x".repeat(1024 * 1024) } }), 413, "payload_too_large", "Request body is too large");
  });

  test("members receive the base with the new view, and the requestId", async () => {
    const base = await newBase("Announced views");
    const view = ok(await create(base.id, { name: "Shown", requestId: "v-1" }));
    expect(await nextBaseEvent(socket, base.id)).toEqual(baseEventOf({ ...base, views: [...base.views, view] }, "v-1"));
    expectInvalid(await create(base.id, { type: "nope" }), "type must be one of table, kanban, calendar");
    // Accident: an invalid requestId answers 400 after the view was created, and no event is sent.
    expectInvalid(await create(base.id, { name: "Ghost", requestId: "x".repeat(65) }), "requestId must be at most 64 characters");
    const after = await getBase(owner, base.id);
    expect(after.views.map((v) => v.name)).toEqual(["Table", "Shown", "Ghost"]);
    const last = ok(await create(base.id, { name: "Last" }));
    expect(await nextBaseEvent(socket, base.id)).toEqual(baseEventOf({ ...after, views: [...after.views, last] }));
  });
});

describe("POST /bases/:id/views/:viewId/update", () => {
  test("renames, retypes and moves a view; what is not sent stays", async () => {
    const base = await newBase();
    const [a, b] = base.properties.map((p) => p.id);
    const view = await addView(owner, base.id, { name: "Start", type: "kanban", config: fullConfig(a!, b!) });
    const renamed = await writer.post(`/bases/${base.id}/views/${view.id}/update`, { name: "  Renamed  " });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ data: { ...view, name: "Renamed" } });
    expect(ok(await update(base.id, view.id, { type: "calendar" }))).toEqual({ ...view, name: "Renamed", type: "calendar" });
    expect(ok(await update(base.id, view.id.toUpperCase(), { position: " Zz " }))).toEqual({ ...view, name: "Renamed", type: "calendar", position: "Zz" });
    expect((await getBase(owner, base.id)).views.map((v) => v.name)).toEqual(["Renamed", "Table"]);
    // A blank name keeps the current one; an empty update changes nothing but the time of the update.
    const [before] = await t.sql`SELECT updated_at, creator_id FROM base_views WHERE id = ${view.id}`;
    expect(ok(await update(base.id, view.id, { name: "  " })).name).toBe("Renamed");
    expect(ok(await update(base.id, view.id, {}))).toEqual({ ...view, name: "Renamed", type: "calendar", position: "Zz" });
    const [after] = await t.sql`SELECT updated_at, creator_id FROM base_views WHERE id = ${view.id}`;
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after.creator_id).toBe(ownerId);
  });

  test("name, type and position are validated", async () => {
    const base = await newBase();
    const id = base.views[0]!.id;
    for (const name of [null, 5, ["x"]]) expectInvalid(await update(base.id, id, { name }), "name must be a string");
    expectInvalid(await update(base.id, id, { name: "x".repeat(201) }), "name must be at most 200 characters");
    for (const type of ["gallery", "", null, 5]) expectInvalid(await update(base.id, id, { type }), "type must be one of table, kanban, calendar");
    for (const position of ["a-1", "a 1", "é"]) expectInvalid(await update(base.id, id, { position }), "position is invalid");
    expectInvalid(await update(base.id, id, { position: "" }), "position is required");
    expectInvalid(await update(base.id, id, { position: 5 }), "position must be a string");
    expectInvalid(await update(base.id, id, { position: null }), "position must be a string");
    expectInvalid(await update(base.id, id, { position: "a".repeat(513) }), "position must be at most 512 characters");
    expect((await getBase(owner, base.id)).views).toEqual(base.views);
  });

  test("config is a patch: null removes a key, an absent key stays, anything else replaces the key whole", async () => {
    const base = await newBase();
    const [a, b] = base.properties.map((p) => p.id);
    const start = fullConfig(a!, b!);
    const view = await addView(owner, base.id, { config: start });
    const one = ok(await update(base.id, view.id, { config: { hiddenPropertyIds: [b], sorts: null, added: 1 } }));
    const { sorts: _sorts, ...withoutSorts } = start;
    expect(one.config).toEqual({ ...withoutSorts, hiddenPropertyIds: [b], added: 1 });
    // A key is replaced, never merged: the other widths and the rest of the nested object are gone.
    const two = ok(await update(base.id, view.id, { config: { propertyWidths: { [a!]: 300 }, nested: { other: true }, filter: { op: "and", children: [] } } }));
    expect(two.config).toEqual({ ...withoutSorts, hiddenPropertyIds: [b], added: 1, propertyWidths: { [a!]: 300 }, nested: { other: true }, filter: { op: "and", children: [] } });
    // An empty patch, or no config at all, keeps everything.
    expect(ok(await update(base.id, view.id, { config: {} })).config).toEqual(two.config);
    expect(ok(await update(base.id, view.id, { name: "Same config" })).config).toEqual(two.config);
    // Removing a key that is not there is fine; unknown keys can be removed too.
    const three = ok(await update(base.id, view.id, { config: { sorts: null, added: null, nested: null, rowHeight: null, never: null } }));
    const { rowHeight: _rowHeight, nested: _nested, ...rest } = withoutSorts;
    expect(three.config).toEqual({ ...rest, hiddenPropertyIds: [b], propertyWidths: { [a!]: 300 }, filter: { op: "and", children: [] } });
    // Every key removed leaves an empty config.
    const all = Object.fromEntries(Object.keys(three.config).map((key) => [key, null]));
    expect(ok(await update(base.id, view.id, { config: all })).config).toEqual({});
    expect((await getBase(owner, base.id)).views.find((v) => v.id === view.id)!.config).toEqual({});
  });

  test("the patched config is validated as a whole; a refused patch changes nothing", async () => {
    const base = await newBase();
    const a = base.properties[0]!.id;
    const view = await addView(owner, base.id, { name: "Guarded", config: { propertyWidths: { [a]: 100 }, sorts: [{ propertyId: a, direction: "asc" }] } });
    for (const config of ["x", 5, null, [], true]) expectInvalid(await update(base.id, view.id, { config }), "config must be an object");
    expectInvalid(await update(base.id, view.id, { name: "Renamed", config: { propertyWidths: { [a]: 0 } } }), INVALID);
    expectInvalid(await update(base.id, view.id, { config: { hiddenPropertyIds: "x" } }), INVALID);
    expectInvalid(await update(base.id, view.id, { config: { groupByPropertyId: 5 } }), INVALID);
    expectInvalid(await update(base.id, view.id, { config: { filter: { op: "and" } } }), "Invalid filter");
    expectInvalid(await update(base.id, view.id, { config: { sorts: [{ propertyId: a }] } }), "Invalid sorts");
    expectInvalid(await update(base.id, view.id, { config: { note: "x".repeat(256 * 1024) } }), INVALID);
    expect((await getBase(owner, base.id)).views.find((v) => v.id === view.id)).toEqual(view);
    // Filters and sorts in a patch are reduced like on creation.
    const patched = ok(await update(base.id, view.id, { config: { sorts: [{ propertyId: a, direction: "desc", extra: 1 }], filter: { op: "or", children: [{ propertyId: a, op: "isEmpty", note: "x" }] } } }));
    expect(patched.config).toEqual({ propertyWidths: { [a]: 100 }, sorts: [{ propertyId: a, direction: "desc" }], filter: { op: "or", children: [{ propertyId: a, op: "isEmpty" }] } });
  });

  test("a view id that is malformed, unknown or of another base is not found", async () => {
    const base = await newBase();
    const other = await newBase("Other");
    for (const id of ["xyz", "1", NOWHERE, other.views[0]!.id]) {
      expectError(await update(base.id, id, { name: "Nope" }), 404, "not_found", "View not found");
    }
    // The view is looked up before the fields are checked.
    expectError(await update(base.id, NOWHERE, { name: 5 }), 404, "not_found", "View not found");
    expect((await getBase(owner, other.id)).views).toEqual(other.views);
  });

  test("members receive the base after every update, even one that changes nothing", async () => {
    const base = await newBase("Announced view updates");
    const view = base.views[0]!;
    ok(await update(base.id, view.id, { name: "Renamed", requestId: "v-2" }));
    const renamed = { ...base, views: [{ ...view, name: "Renamed" }] };
    expect(await nextBaseEvent(socket, base.id)).toEqual(baseEventOf(renamed, "v-2"));
    ok(await update(base.id, view.id, {}));
    expect(await nextBaseEvent(socket, base.id)).toEqual(baseEventOf(renamed));
    expectInvalid(await update(base.id, view.id, { config: [] }), "config must be an object");
    // Accident: an invalid requestId answers 400 after the update was written, and no event is sent.
    expectInvalid(await update(base.id, view.id, { name: "Written", requestId: 5 }), "requestId must be a string");
    ok(await update(base.id, view.id, { config: { groupByPropertyId: "p" } }));
    expect(await nextBaseEvent(socket, base.id)).toEqual(baseEventOf({ ...base, views: [{ ...view, name: "Written", config: { groupByPropertyId: "p" } }] }));
  });
});

describe("POST /bases/:id/views/:viewId/delete", () => {
  test("deletes a view and answers with an empty object", async () => {
    const base = await newBase();
    const spare = await addView(owner, base.id, { name: "Spare" });
    const res = await writer.post(`/bases/${base.id}/views/${spare.id.toUpperCase()}/delete`, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: {} });
    expect((await getBase(owner, base.id)).views).toEqual(base.views);
    expectError(await remove(base.id, spare.id), 404, "not_found", "View not found");
    const bare = await owner.raw("POST", `/bases/${base.id}/views/${(await addView(owner, base.id)).id}/delete`);
    expect(bare.status).toBe(200);
  });

  test("a base keeps at least one view, whichever it is", async () => {
    const base = await createBase(owner, spaceId, { template: "kanban" });
    const [board, table] = base.views;
    expect(ok(await remove(base.id, table!.id))).toEqual({});
    expectInvalid(await remove(base.id, board!.id), "A base must keep at least one view");
    expect((await getBase(owner, base.id)).views).toEqual([board!]);
    const again = await addView(owner, base.id, { name: "Again" });
    expect(ok(await remove(base.id, board!.id))).toEqual({});
    expectInvalid(await remove(base.id, again.id), "A base must keep at least one view");
  });

  test("a view id that is malformed, unknown or of another base is not found, even when it is the last view", async () => {
    const base = await newBase();
    const other = await newBase("Other");
    await addView(owner, other.id, { name: "Second" });
    for (const id of ["xyz", NOWHERE, other.views[0]!.id]) expectError(await remove(base.id, id), 404, "not_found", "View not found");
    expect((await getBase(owner, other.id)).views).toHaveLength(2);
    expect((await getBase(owner, base.id)).views).toEqual(base.views);
  });

  test("members receive the base without the view", async () => {
    const base = await newBase("Announced view deletions");
    const one = await addView(owner, base.id, { name: "One" });
    const two = await addView(owner, base.id, { name: "Two" });
    await nextBaseEvent(socket, base.id);
    await nextBaseEvent(socket, base.id);
    ok(await remove(base.id, one.id, { requestId: "v-3" }));
    expect(await nextBaseEvent(socket, base.id)).toEqual(baseEventOf({ ...base, views: [...base.views, two] }, "v-3"));
    expectError(await remove(base.id, one.id), 404, "not_found", "View not found");
    // Accident: an invalid requestId answers 400 after the view was deleted, and no event is sent.
    expectInvalid(await remove(base.id, two.id, { requestId: "" }), "requestId is required");
    expect((await getBase(owner, base.id)).views).toEqual(base.views);
    expectInvalid(await remove(base.id, base.views[0]!.id), "A base must keep at least one view");
    const last = await addView(owner, base.id, { name: "Last" });
    expect(await nextBaseEvent(socket, base.id)).toEqual(baseEventOf({ ...base, views: [...base.views, last] }));
  });
});
