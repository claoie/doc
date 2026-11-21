import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Base, Row } from "common/bases";
import { connect, startServer, type Client, type Message, type Socket, type TestServer } from "./harness";
import {
  addProperty,
  addRow,
  allRows,
  createBase,
  decodeCursor,
  emptyBase,
  encodeCursor,
  expectError,
  expectInvalid,
  getRow,
  ISO,
  nextBaseEvent,
  ok,
  queryRows,
  settle,
  updateRow,
  UUID,
} from "./harness/base-fixtures";

let t: TestServer;
let owner: Client;
let ownerId: string;
let spaceId: string;
let writer: Client;
let writerId: string;
let reader: Client;
let readerId: string;
let outsider: Client;
let otherSpaceId: string;

const NOWHERE = "00000000-0000-4000-8000-000000000000";

/** The events of bases among `messages`, optionally of one page. */
const baseEvents = (messages: Message[], pageId?: string) => messages.filter((m) => m.t === "event" && m.kind === "base" && (!pageId || m.pageId === pageId));

beforeAll(async () => {
  t = await startServer();
  let user: { id: string };
  ({ owner, user, spaceId } = await t.setupOwner());
  ownerId = user.id;
  const join = async (email: string, role: "writer" | "reader") => {
    const member = await t.addMember(owner, email);
    ok(await owner.post(`/spaces/${spaceId}/members/add`, { role, userIds: [member.user.id] }));
    return member;
  };
  const w = await join("writer@example.com", "writer");
  writer = w.client;
  writerId = w.user.id;
  const r = await join("reader@example.com", "reader");
  reader = r.client;
  readerId = r.user.id;
  outsider = (await t.addMember(owner, "outsider@example.com")).client;
  otherSpaceId = ok(await owner.post("/spaces", { name: "Private", slug: "private" })).space.id;
});

afterAll(async () => {
  await t.close();
});

const newBase = (title = "Rows") => createBase(owner, spaceId, { title });
const positions = async (baseId: string) => (await allRows(owner, baseId)).map((r) => r.position);
const stored = async (rowId: string) => {
  const [row] = await t.sql`SELECT cells, position, creator_id, last_editor_id, created_at, updated_at FROM base_rows WHERE id = ${rowId}`;
  return row;
};

describe("POST /bases/:id/rows", () => {
  test("creates an empty row after the last one and answers with it", async () => {
    const base = await newBase();
    const res = await writer.post(`/bases/${base.id}/rows`, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        id: expect.stringMatching(UUID),
        cells: {},
        position: "a1",
        creatorId: writerId,
        lastEditorId: writerId,
        createdAt: expect.stringMatching(ISO),
        updatedAt: expect.stringMatching(ISO),
      },
    });
    const row = res.body.data as Row;
    expect(row.updatedAt).toBe(row.createdAt);
    expect(Math.abs(Date.parse(row.createdAt) - Date.now())).toBeLessThan(60_000);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await getRow(owner, base.id, row.id)).toEqual(row);
    // No body at all is an empty row too.
    const bare = await owner.raw("POST", `/bases/${base.id}/rows`);
    expect(bare.status).toBe(200);
    expect(((await bare.json()) as { data: Row }).data).toMatchObject({ cells: {}, position: "a2", creatorId: ownerId });
    expect((await addRow(owner, base.id)).position).toBe("a3");
    expect(await positions(base.id)).toEqual(["a0", "a1", "a2", "a3"]);
  });

  test("the first row of a base without rows is a0", async () => {
    const base = await newBase();
    await emptyBase(owner, base.id);
    expect((await addRow(owner, base.id)).position).toBe("a0");
  });

  test("afterRowId places the row between that row and the next one", async () => {
    const base = await newBase();
    const [seed] = await allRows(owner, base.id);
    const second = await addRow(owner, base.id);
    const third = await addRow(owner, base.id);
    expect([second.position, third.position]).toEqual(["a1", "a2"]);
    expect((await addRow(owner, base.id, {}, { afterRowId: seed!.id })).position).toBe("a0V");
    expect((await addRow(owner, base.id, {}, { afterRowId: seed!.id.toUpperCase() })).position).toBe("a0G");
    expect((await addRow(owner, base.id, {}, { afterRowId: seed!.id })).position).toBe("a08");
    expect((await addRow(owner, base.id, {}, { afterRowId: second.id })).position).toBe("a1V");
    // After the last row is the end.
    expect((await addRow(owner, base.id, {}, { afterRowId: third.id })).position).toBe("a3");
    expect(await positions(base.id)).toEqual(["a0", "a08", "a0G", "a0V", "a1", "a1V", "a2", "a3"]);
  });

  test("an afterRowId that is null, blank, unknown or of another base means the end", async () => {
    const base = await newBase();
    const other = await newBase("Other");
    const [foreign] = await allRows(owner, other.id);
    expect((await addRow(owner, base.id, {}, { afterRowId: null })).position).toBe("a1");
    expect((await addRow(owner, base.id, {}, { afterRowId: "" })).position).toBe("a2");
    expect((await addRow(owner, base.id, {}, { afterRowId: NOWHERE })).position).toBe("a3");
    expect((await addRow(owner, base.id, {}, { afterRowId: foreign!.id })).position).toBe("a4");
    for (const afterRowId of ["x", 5, true, [NOWHERE], `${NOWHERE}0`]) {
      expectInvalid(await owner.post(`/bases/${base.id}/rows`, { afterRowId }), "afterRowId must be a valid id");
    }
    expect(await positions(base.id)).toEqual(["a0", "a1", "a2", "a3", "a4"]);
  });

  test("position sets the place outright, wins over afterRowId and may repeat an existing one", async () => {
    const base = await newBase();
    const [seed] = await allRows(owner, base.id);
    const first = await addRow(owner, base.id, {}, { position: "Zz", afterRowId: seed!.id });
    expect(first.position).toBe("Zz");
    // Surrounding blanks are trimmed.
    const twin = await addRow(owner, base.id, {}, { position: " a0 " });
    expect(twin.position).toBe("a0");
    const digits = await addRow(owner, base.id, {}, { position: "0" });
    // Rows order by position bytewise (digits, upper case, lower case), then by id.
    const order = (await allRows(owner, base.id)).map((r) => r.id);
    expect(order).toEqual([digits.id, first.id, ...[seed!.id, twin.id].sort()]);
    // The next appended row goes after the largest position.
    expect((await addRow(owner, base.id)).position).toBe("a1");
  });

  test("position must be 1 to 512 characters of 0-9, A-Z, a-z", async () => {
    const base = await newBase();
    for (const position of ["a-1", "a 1", "a.5", "é", "a_", "a0\n1", "😀"]) {
      expectInvalid(await owner.post(`/bases/${base.id}/rows`, { position }), "position is invalid");
    }
    expectInvalid(await owner.post(`/bases/${base.id}/rows`, { position: "" }), "position is required");
    expectInvalid(await owner.post(`/bases/${base.id}/rows`, { position: "   " }), "position is required");
    expectInvalid(await owner.post(`/bases/${base.id}/rows`, { position: 5 }), "position must be a string");
    expectInvalid(await owner.post(`/bases/${base.id}/rows`, { position: null }), "position must be a string");
    expectInvalid(await owner.post(`/bases/${base.id}/rows`, { position: "a".repeat(513) }), "position must be at most 512 characters");
    expect(await positions(base.id)).toEqual(["a0"]);
    const longest = "z".repeat(512);
    expect((await addRow(owner, base.id, {}, { position: longest })).position).toBe(longest);
    // Appending after the largest key there is still finds a larger one.
    expect((await addRow(owner, base.id)).position).toBe(`${longest}V`);
  });

  test("positions that are not of the usual form still get a key between them", async () => {
    const base = await newBase();
    await emptyBase(owner, base.id);
    const low = await addRow(owner, base.id, {}, { position: "5" });
    const high = await addRow(owner, base.id, {}, { position: "9" });
    expect((await addRow(owner, base.id, {}, { afterRowId: low.id })).position).toBe("7");
    expect((await addRow(owner, base.id, {}, { afterRowId: low.id })).position).toBe("6");
    expect((await addRow(owner, base.id, {}, { afterRowId: low.id })).position).toBe("5V");
    // With no upper bound the key is halfway to the end of the alphabet.
    expect((await addRow(owner, base.id, {}, { afterRowId: high.id })).position).toBe("a");
    expect((await addRow(owner, base.id)).position).toBe("n");
    expect(await positions(base.id)).toEqual(["5", "5V", "6", "7", "9", "a", "n"]);
  });

  test("no key exists between a position and the same position followed by zeros: the request fails", async () => {
    const base = await newBase();
    const low = await addRow(owner, base.id, {}, { position: "a1" });
    await addRow(owner, base.id, {}, { position: "a100" });
    // Accident: the error of the key generator is not caught, so the answer is a 500.
    expectError(await owner.post(`/bases/${base.id}/rows`, { afterRowId: low.id }), 500, "internal_error", "Something went wrong");
    expect(await positions(base.id)).toEqual(["a0", "a1", "a100"]);
  });

  test("cells of unknown properties are dropped and null leaves a cell empty", async () => {
    const base = await newBase();
    const [title, text1, text2] = base.properties;
    const row = await addRow(owner, base.id, { [title!.id]: "Hello", [text1!.id]: null, [text2!.id]: "", pzzzzzzzzz: "nope", "": "x", constructor: "y" });
    expect(row.cells).toEqual({ [title!.id]: "Hello" });
    expect((await stored(row.id)).cells).toEqual({ [title!.id]: "Hello" });
  });

  test("cells must be an object", async () => {
    const base = await newBase();
    for (const cells of [[], null, "x", 5, true]) {
      expectInvalid(await owner.post(`/bases/${base.id}/rows`, { cells }), "cells must be an object");
    }
    expect(await positions(base.id)).toEqual(["a0"]);
  });

  test("an invalid cell refuses the whole row", async () => {
    const base = await newBase();
    const amount = await addProperty(owner, base.id, "Amount", "number");
    const res = await owner.post(`/bases/${base.id}/rows`, { cells: { [base.properties[0]!.id]: "kept?", [amount.id]: "abc" } });
    expectInvalid(res, 'Invalid value for "Amount": not a number');
    expect(await positions(base.id)).toEqual(["a0"]);
    // The cells are checked before the position.
    expectInvalid(await owner.post(`/bases/${base.id}/rows`, { cells: { [amount.id]: "abc" }, position: "!" }), 'Invalid value for "Amount": not a number');
    expectInvalid(await owner.post(`/bases/${base.id}/rows`, { cells: { [amount.id]: "1" }, position: "!", afterRowId: "x" }), "position is invalid");
  });

  test("values for created time, last edited time, last edited by and formula properties are ignored", async () => {
    const base = await newBase();
    const created = await addProperty(owner, base.id, "Created", "createdAt");
    const edited = await addProperty(owner, base.id, "Edited", "lastEditedAt");
    const editor = await addProperty(owner, base.id, "Editor", "lastEditedBy");
    const formula = await addProperty(owner, base.id, "Two", "formula", { source: "1 + 1" });
    const row = await addRow(owner, base.id, { [created.id]: "2020-01-01", [edited.id]: "2020-01-01", [editor.id]: NOWHERE, [formula.id]: 99 });
    expect(row.cells).toEqual({ [formula.id]: 2 });
    const updated = await updateRow(owner, base.id, row.id, { [created.id]: "x", [edited.id]: 5, [editor.id]: null, [formula.id]: null });
    expect(updated).toEqual(row);
  });

  describe("default values", () => {
    test("a property's defaultValue fills the cell of a new row when the request has no value for it", async () => {
      const base = await newBase();
      const text = await addProperty(owner, base.id, "Note", "text", { defaultValue: "n/a" });
      const number = await addProperty(owner, base.id, "Count", "number", { defaultValue: "5" });
      const checkbox = await addProperty(owner, base.id, "Done", "checkbox", { defaultValue: "yes" });
      const date = await addProperty(owner, base.id, "Day", "date", { defaultValue: " 2026-01-02 " });
      const select = await addProperty(owner, base.id, "Stage", "select", { choices: [{ id: "a", name: "A" }, { id: "b", name: "B" }], defaultValue: "b" });
      const multi = await addProperty(owner, base.id, "Tags", "multiSelect", { choices: [{ id: "x", name: "X" }, { id: "y", name: "Y" }], defaultValue: ["y", "x", "y"] });
      const person = await addProperty(owner, base.id, "Who", "person", { defaultValue: ownerId });
      const row = await addRow(owner, base.id);
      expect(row.cells).toEqual({
        [text.id]: "n/a",
        [number.id]: 5,
        [checkbox.id]: true,
        [date.id]: "2026-01-02",
        [select.id]: "b",
        [multi.id]: ["y", "x"],
        [person.id]: ownerId,
      });
      // A value in the request wins; an explicit null (or a value that clears) keeps the cell empty.
      const chosen = await addRow(owner, base.id, { [text.id]: "mine", [number.id]: null, [checkbox.id]: false, [date.id]: "", [select.id]: "a", [multi.id]: [] });
      expect(chosen.cells).toEqual({ [text.id]: "mine", [checkbox.id]: false, [select.id]: "a", [person.id]: ownerId });
      // Defaults are for new rows only.
      const cleared = await updateRow(owner, base.id, row.id, { [text.id]: null, [number.id]: null });
      expect(cleared.cells).toEqual({ [checkbox.id]: true, [date.id]: "2026-01-02", [select.id]: "b", [multi.id]: ["y", "x"], [person.id]: ownerId });
    });

    test("a default that is null, blank or no longer valid is skipped", async () => {
      const base = await newBase();
      await addProperty(owner, base.id, "Null", "text", { defaultValue: null });
      await addProperty(owner, base.id, "Blank", "text", { defaultValue: "" });
      await addProperty(owner, base.id, "Bad number", "number", { defaultValue: "abc" });
      await addProperty(owner, base.id, "Bad date", "date", { defaultValue: "not a date" });
      await addProperty(owner, base.id, "Bad email", "email", { defaultValue: "nope" });
      await addProperty(owner, base.id, "Spaces", "url", { defaultValue: "   " });
      const select = await addProperty(owner, base.id, "Stage", "select", { choices: [{ id: "a", name: "A" }], defaultValue: "gone" });
      await addProperty(owner, base.id, "Created", "createdAt", { defaultValue: "2020-01-01" });
      const zero = await addProperty(owner, base.id, "Zero", "number", { defaultValue: 0 });
      const off = await addProperty(owner, base.id, "Off", "checkbox", { defaultValue: false });
      const row = await addRow(owner, base.id);
      expect(row.cells).toEqual({ [zero.id]: 0, [off.id]: false });
      // An invalid default never makes the request fail, but an invalid value does.
      expectInvalid(await owner.post(`/bases/${base.id}/rows`, { cells: { [select.id]: "gone" } }), 'Invalid value for "Stage": unknown option');
    });

    test("the status of the kanban template defaults to its first choice until that choice is removed", async () => {
      const base = await createBase(owner, spaceId, { template: "kanban" });
      const status = base.properties[3]!;
      expect((await addRow(owner, base.id)).cells).toEqual({ [status.id]: "status-todo" });
      expect((await addRow(owner, base.id, { [status.id]: "status-done" })).cells).toEqual({ [status.id]: "status-done" });
      const choices = (status.options.choices as { id: string }[]).filter((c) => c.id !== "status-todo");
      ok(await owner.post(`/bases/${base.id}/properties/${status.id}/update`, { options: { ...status.options, choices } }));
      expect((await addRow(owner, base.id)).cells).toEqual({});
    });
  });

  test("formulas are computed for the new row; empty results are not stored", async () => {
    const base = await newBase();
    const price = await addProperty(owner, base.id, "Price", "number", { defaultValue: 2 });
    const qty = await addProperty(owner, base.id, "Qty", "number");
    const total = await addProperty(owner, base.id, "Total", "formula", { source: 'prop("Price") * prop("Qty")' });
    const label = await addProperty(owner, base.id, "Label", "formula", { source: 'IF(prop("Qty") > 3, "many")' });
    const broken = await addProperty(owner, base.id, "Ratio", "formula", { source: 'prop("Price") / prop("Qty")' });
    const row = await addRow(owner, base.id, { [qty.id]: 4 });
    expect(row.cells).toEqual({ [price.id]: 2, [qty.id]: 4, [total.id]: 8, [label.id]: "many", [broken.id]: 0.5 });
    const empty = await addRow(owner, base.id);
    expect(empty.cells).toEqual({ [price.id]: 2, [total.id]: 0, [broken.id]: { error: "DIV_BY_ZERO", message: "Cannot divide by zero" } });
    expect((await stored(empty.id)).cells).toEqual(empty.cells);
  });

  test("the body may be up to 4 MiB", async () => {
    const base = await newBase();
    const megabyte = "x".repeat(1024 * 1024);
    const res = await owner.post(`/bases/${base.id}/rows`, { cells: { unknown: megabyte + megabyte } });
    expect(res.status).toBe(200);
    expect(res.body.data.cells).toEqual({});
    expectError(await owner.post(`/bases/${base.id}/rows`, { cells: { unknown: megabyte.repeat(4) } }), 413, "payload_too_large", "Request body is too large");
    expect(await positions(base.id)).toEqual(["a0", "a1"]);
  });

  describe("realtime", () => {
    let sockets: { owner: Socket; reader: Socket; outsider: Socket };
    beforeAll(async () => {
      const [o, r, x] = await Promise.all([connect(owner), connect(reader), connect(outsider)]);
      sockets = { owner: o, reader: r, outsider: x };
    });
    afterAll(async () => {
      await Promise.all(Object.values(sockets).map((s) => s.close()));
    });

    test("members of the space receive rowCreated with the row; the requestId is echoed when given", async () => {
      const base = await newBase("Realtime rows");
      const row = await addRow(writer, base.id, { [base.properties[0]!.id]: "Announced" });
      const plain = { t: "event", kind: "base", pageId: base.id, spaceId, event: { op: "rowCreated", row } };
      expect(await nextBaseEvent(sockets.owner)).toEqual(plain);
      expect(await nextBaseEvent(sockets.reader)).toEqual(plain);
      const tagged = await addRow(writer, base.id, {}, { requestId: " req-1 " });
      const echoed = { t: "event", kind: "base", pageId: base.id, spaceId, event: { op: "rowCreated", row: tagged }, requestId: "req-1" };
      expect(await nextBaseEvent(sockets.owner)).toEqual(echoed);
      expect(await nextBaseEvent(sockets.reader)).toEqual(echoed);
      expect(baseEvents(await settle(sockets.outsider))).toEqual([]);
      expect(baseEvents(await settle(sockets.owner))).toEqual([]);
    });

    test("a refused row is not announced", async () => {
      const base = await newBase("Refused rows");
      expectInvalid(await owner.post(`/bases/${base.id}/rows`, { cells: [] }), "cells must be an object");
      const row = await addRow(owner, base.id, {}, { requestId: "x".repeat(64) });
      expect(await nextBaseEvent(sockets.owner)).toEqual({
        t: "event",
        kind: "base",
        pageId: base.id,
        spaceId,
        event: { op: "rowCreated", row },
        requestId: "x".repeat(64),
      });
    });

    test("a requestId that is not a string of 1 to 64 characters answers 400, after the row was created and without announcing it", async () => {
      const base = await newBase("Bad request ids");
      // Accident: the requestId is only looked at when the event is sent, so the row exists although the request failed.
      expectInvalid(await owner.post(`/bases/${base.id}/rows`, { requestId: "x".repeat(65) }), "requestId must be at most 64 characters");
      expectInvalid(await owner.post(`/bases/${base.id}/rows`, { requestId: 5 }), "requestId must be a string");
      expectInvalid(await owner.post(`/bases/${base.id}/rows`, { requestId: "" }), "requestId is required");
      expectInvalid(await owner.post(`/bases/${base.id}/rows`, { requestId: null }), "requestId must be a string");
      expect(await positions(base.id)).toEqual(["a0", "a1", "a2", "a3", "a4"]);
      const row = await addRow(owner, base.id);
      expect(row.position).toBe("a5");
      expect((await nextBaseEvent(sockets.owner)).event).toEqual({ op: "rowCreated", row });
    });
  });
});

describe("GET /bases/:id/rows/:rowId", () => {
  test("answers with the row and the users and pages it refers to", async () => {
    const base = await newBase();
    const who = await addProperty(owner, base.id, "Who", "person");
    const link = await addProperty(owner, base.id, "Link", "page");
    const page = ok(await owner.post("/pages", { spaceId, title: "Target", icon: "🎯" })).page;
    const row = await addRow(writer, base.id, { [who.id]: readerId, [link.id]: page.id });
    const res = await reader.get(`/bases/${base.id}/rows/${row.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        row: {
          id: row.id,
          cells: { [who.id]: readerId, [link.id]: page.id },
          position: "a1",
          creatorId: writerId,
          lastEditorId: writerId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
        references: {
          users: {
            [writerId]: { id: writerId, name: "writer", avatarUrl: null },
            [readerId]: { id: readerId, name: "reader", avatarUrl: null },
          },
          pages: { [page.id]: { id: page.id, slugId: page.slugId, title: "Target", icon: "🎯", spaceSlug: "general" } },
        },
      },
    });
    expect(ok(await owner.get(`/bases/${base.slugId}/rows/${row.id.toUpperCase()}`))).toEqual(res.body.data);
  });

  test("a row id that is malformed, unknown or of another base is not found", async () => {
    const base = await newBase();
    const other = await newBase("Other");
    const [foreign] = await allRows(owner, other.id);
    for (const rowId of ["xyz", "123", NOWHERE, foreign!.id, `${foreign!.id}0`]) {
      expectError(await owner.get(`/bases/${base.id}/rows/${rowId}`), 404, "not_found", "Row not found");
    }
    expect((await owner.get(`/bases/${other.id}/rows/${foreign!.id}`)).status).toBe(200);
  });
});

describe("POST /bases/:id/rows/:rowId/update", () => {
  test("patches cells: given keys are set, null and blank text clear, absent keys stay", async () => {
    const base = await newBase();
    const [title, text1, text2] = base.properties;
    const row = await addRow(owner, base.id, { [title!.id]: "One", [text1!.id]: "Two", [text2!.id]: "Three" });
    const res = await writer.post(`/bases/${base.id}/rows/${row.id}/update`, { cells: { [title!.id]: "Uno", [text1!.id]: null } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        id: row.id,
        cells: { [title!.id]: "Uno", [text2!.id]: "Three" },
        position: row.position,
        creatorId: ownerId,
        lastEditorId: writerId,
        createdAt: row.createdAt,
        updatedAt: expect.stringMatching(ISO),
      },
    });
    expect(Date.parse(res.body.data.updatedAt)).toBeGreaterThan(Date.parse(row.updatedAt));
    const cleared = await updateRow(owner, base.id, row.id, { [text2!.id]: "" });
    expect(cleared.cells).toEqual({ [title!.id]: "Uno" });
    expect(cleared.lastEditorId).toBe(ownerId);
    expect(await getRow(owner, base.id, row.id)).toEqual(cleared);
    expect((await stored(row.id)).cells).toEqual({ [title!.id]: "Uno" });
  });

  test("an update that changes nothing answers with the row as it is: no new updatedAt, no new editor", async () => {
    const base = await newBase();
    const [title, text1] = base.properties;
    const amount = await addProperty(owner, base.id, "Amount", "number");
    const tags = await addProperty(owner, base.id, "Tags", "multiSelect", { choices: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
    const row = await addRow(owner, base.id, { [title!.id]: "Same", [amount.id]: 5, [tags.id]: ["a", "b"] }, { position: "b7" });
    const before = await stored(row.id);
    const same = [
      {},
      { cells: {} },
      { cells: { [title!.id]: "Same" } },
      // The values are compared after normalising: "5" is 5, a blank text is an empty cell, repeated options collapse.
      { cells: { [amount.id]: " 5 ", [text1!.id]: "", [tags.id]: ["a", "b", "a"] } },
      { cells: { [text1!.id]: null, unknown: "x" } },
      { position: "b7" },
      { cells: { [title!.id]: "Same" }, position: " b7 ", requestId: "ignored" },
    ];
    for (const body of same) {
      const res = await writer.post(`/bases/${base.id}/rows/${row.id}/update`, body);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(row);
    }
    expect(await stored(row.id)).toEqual(before);
    // The order of a list is part of its value.
    const reordered = await updateRow(writer, base.id, row.id, { [tags.id]: ["b", "a"] });
    expect(reordered.cells[tags.id]).toEqual(["b", "a"]);
    expect(reordered.lastEditorId).toBe(writerId);
    expect(Date.parse(reordered.updatedAt)).toBeGreaterThan(Date.parse(row.updatedAt));
  });

  test("position moves the row; it is trimmed and validated like on creation", async () => {
    const base = await newBase();
    const row = await addRow(owner, base.id, { [base.properties[0]!.id]: "Mover" });
    const moved = ok(await writer.post(`/bases/${base.id}/rows/${row.id}/update`, { position: " Zz " }));
    expect(moved).toEqual({ ...row, position: "Zz", lastEditorId: writerId, updatedAt: expect.stringMatching(ISO) });
    expect(Date.parse(moved.updatedAt)).toBeGreaterThan(Date.parse(row.updatedAt));
    expect(await positions(base.id)).toEqual(["Zz", "a0"]);
    for (const position of ["a-1", "b 5", "é"]) {
      expectInvalid(await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { position }), "position is invalid");
    }
    expectInvalid(await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { position: "" }), "position is required");
    expectInvalid(await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { position: 1 }), "position must be a string");
    expectInvalid(await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { position: null }), "position must be a string");
    expectInvalid(await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { position: "a".repeat(513) }), "position must be at most 512 characters");
    expect((await getRow(owner, base.id, row.id)).position).toBe("Zz");
    // Cells and position can change together.
    const both = await updateRow(owner, base.id, row.id, { [base.properties[0]!.id]: "Moved" }, { position: "a5" });
    expect(both).toMatchObject({ cells: { [base.properties[0]!.id]: "Moved" }, position: "a5" });
  });

  test("cells must be an object of valid values; nothing is written otherwise", async () => {
    const base = await newBase();
    const amount = await addProperty(owner, base.id, "Amount", "number");
    const row = await addRow(owner, base.id, { [amount.id]: 1 });
    for (const cells of [[], null, "x", 5]) {
      expectInvalid(await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { cells }), "cells must be an object");
    }
    const res = await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { cells: { [base.properties[0]!.id]: "kept?", [amount.id]: "abc" }, position: "b1" });
    expectInvalid(res, 'Invalid value for "Amount": not a number');
    expect(await getRow(owner, base.id, row.id)).toEqual(row);
  });

  test("the cells and the position are checked before the row is looked up", async () => {
    const base = await newBase();
    const amount = await addProperty(owner, base.id, "Amount", "number");
    const other = await newBase("Other");
    const [foreign] = await allRows(owner, other.id);
    for (const rowId of ["xyz", NOWHERE, foreign!.id]) {
      expectError(await owner.post(`/bases/${base.id}/rows/${rowId}/update`, { cells: { [amount.id]: 1 } }), 404, "not_found", "Row not found");
      expectInvalid(await owner.post(`/bases/${base.id}/rows/${rowId}/update`, { cells: { [amount.id]: "abc" } }), 'Invalid value for "Amount": not a number');
      expectInvalid(await owner.post(`/bases/${base.id}/rows/${rowId}/update`, { position: "!" }), "position is invalid");
    }
    expect((await getRow(owner, other.id, foreign!.id)).cells).toEqual({});
  });

  test("formulas that depend on a changed cell are recomputed, the others are left alone", async () => {
    const base = await newBase();
    const price = await addProperty(owner, base.id, "Price", "number");
    const qty = await addProperty(owner, base.id, "Qty", "number");
    const note = await addProperty(owner, base.id, "Note", "text");
    const total = await addProperty(owner, base.id, "Total", "formula", { source: 'prop("Price") * prop("Qty")' });
    const label = await addProperty(owner, base.id, "Label", "formula", { source: 'IF(prop("Total") > 5, "big", "small")' });
    const shout = await addProperty(owner, base.id, "Shout", "formula", { source: 'UPPER(prop("Note"))' });
    const row = await addRow(owner, base.id, { [price.id]: 2.5, [qty.id]: 4, [note.id]: "hi" });
    expect(row.cells).toEqual({ [price.id]: 2.5, [qty.id]: 4, [note.id]: "hi", [total.id]: 10, [label.id]: "big", [shout.id]: "HI" });
    const updated = await updateRow(owner, base.id, row.id, { [qty.id]: 1 });
    expect(updated.cells).toEqual({ [price.id]: 2.5, [qty.id]: 1, [note.id]: "hi", [total.id]: 2.5, [label.id]: "small", [shout.id]: "HI" });
    // Clearing an input: the formula over it becomes empty text, which is stored as "".
    const cleared = await updateRow(owner, base.id, row.id, { [note.id]: null, [price.id]: null });
    expect(cleared.cells).toEqual({ [qty.id]: 1, [total.id]: 0, [label.id]: "small", [shout.id]: "" });
  });

  test("the body may be up to 4 MiB", async () => {
    const base = await newBase();
    const [row] = await allRows(owner, base.id);
    const megabyte = "x".repeat(1024 * 1024);
    expect((await owner.post(`/bases/${base.id}/rows/${row!.id}/update`, { cells: { unknown: megabyte + megabyte } })).status).toBe(200);
    expectError(await owner.post(`/bases/${base.id}/rows/${row!.id}/update`, { cells: { unknown: megabyte.repeat(4) } }), 413, "payload_too_large", "Request body is too large");
  });

  describe("realtime", () => {
    let socket: Socket;
    let outside: Socket;
    beforeAll(async () => {
      [socket, outside] = await Promise.all([connect(reader), connect(outsider)]);
    });
    afterAll(async () => {
      await Promise.all([socket.close(), outside.close()]);
    });

    test("rowUpdated carries only the cells that changed (null for a cleared one), the new updatedAt and the editor", async () => {
      const base = await newBase("Realtime updates");
      const [title, text1, text2] = base.properties;
      const qty = await addProperty(owner, base.id, "Qty", "number");
      const double = await addProperty(owner, base.id, "Double", "formula", { source: 'prop("Qty") * 2' });
      const row = await addRow(owner, base.id, { [title!.id]: "T", [text1!.id]: "kept", [text2!.id]: "gone soon", [qty.id]: 1 });
      const updated = await updateRow(writer, base.id, row.id, { [title!.id]: "T", [text1!.id]: "kept", [text2!.id]: null, [qty.id]: 2 }, { requestId: "req-7" });
      expect(await nextBaseEvent(socket, base.id, "rowUpdated")).toEqual({
        t: "event",
        kind: "base",
        pageId: base.id,
        spaceId,
        event: {
          op: "rowUpdated",
          rowId: row.id,
          cells: { [text2!.id]: null, [qty.id]: 2, [double.id]: 4 },
          updatedAt: updated.updatedAt,
          lastEditorId: writerId,
        },
        requestId: "req-7",
      });
      expect(baseEvents(await settle(outside))).toEqual([]);
    });

    test("the event has the position only when the request had one", async () => {
      const base = await newBase("Realtime moves");
      const row = await addRow(owner, base.id, { [base.properties[0]!.id]: "T" });
      const moved = await updateRow(owner, base.id, row.id, {}, { position: "c3" });
      expect(await nextBaseEvent(socket, base.id, "rowUpdated")).toEqual({
        t: "event",
        kind: "base",
        pageId: base.id,
        spaceId,
        event: { op: "rowUpdated", rowId: row.id, cells: {}, position: "c3", updatedAt: moved.updatedAt, lastEditorId: ownerId },
      });
      // The same position again, with a cell change: the position is still in the event.
      const again = await updateRow(owner, base.id, row.id, { [base.properties[0]!.id]: "U" }, { position: "c3" });
      expect((await nextBaseEvent(socket, base.id, "rowUpdated")).event).toEqual({
        op: "rowUpdated",
        rowId: row.id,
        cells: { [base.properties[0]!.id]: "U" },
        position: "c3",
        updatedAt: again.updatedAt,
        lastEditorId: ownerId,
      });
    });

    test("an update that changes nothing, or is refused, sends no event", async () => {
      const base = await newBase("Realtime no-ops");
      const title = base.properties[0]!;
      const row = await addRow(owner, base.id, { [title.id]: "T" });
      ok(await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { cells: { [title.id]: "T" }, position: row.position }));
      // A no-op never looks at the requestId either.
      ok(await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { cells: {}, requestId: 5 }));
      expectInvalid(await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { cells: [] }), "cells must be an object");
      expectError(await owner.post(`/bases/${base.id}/rows/${NOWHERE}/update`, { cells: { [title.id]: "x" } }), 404, "not_found", "Row not found");
      const real = await updateRow(owner, base.id, row.id, { [title.id]: "changed" });
      expect((await nextBaseEvent(socket, base.id, "rowUpdated")).event).toEqual({
        op: "rowUpdated",
        rowId: row.id,
        cells: { [title.id]: "changed" },
        updatedAt: real.updatedAt,
        lastEditorId: ownerId,
      });
      expect(baseEvents(await settle(socket), base.id).filter((m) => m.event.op === "rowUpdated")).toEqual([]);
    });

    test("an invalid requestId answers 400 after the change was written, and the change is not announced", async () => {
      const base = await newBase("Realtime bad ids");
      const title = base.properties[0]!;
      const row = await addRow(owner, base.id, { [title.id]: "T" });
      // Accident: as on creation, the requestId is validated when the event is about to be sent.
      expectInvalid(await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { cells: { [title.id]: "written" }, requestId: "x".repeat(65) }), "requestId must be at most 64 characters");
      expect((await getRow(owner, base.id, row.id)).cells).toEqual({ [title.id]: "written" });
      const next = await updateRow(owner, base.id, row.id, { [title.id]: "again" });
      expect((await nextBaseEvent(socket, base.id, "rowUpdated")).event).toMatchObject({ op: "rowUpdated", cells: { [title.id]: "again" }, updatedAt: next.updatedAt });
    });
  });
});

describe("POST /bases/:id/rows/delete", () => {
  test("deletes the given rows of this base and answers with the ids it deleted", async () => {
    const base = await newBase();
    const other = await newBase("Other");
    const [foreign] = await allRows(owner, other.id);
    const [seed] = await allRows(owner, base.id);
    const a = await addRow(owner, base.id);
    const b = await addRow(owner, base.id);
    const c = await addRow(owner, base.id);
    const res = await writer.post(`/bases/${base.id}/rows/delete`, { rowIds: [a.id, a.id.toUpperCase(), NOWHERE, foreign!.id, c.id] });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data)).toEqual(["rowIds"]);
    expect([...res.body.data.rowIds].sort()).toEqual([a.id, c.id].sort());
    expect((await allRows(owner, base.id)).map((r) => r.id)).toEqual([seed!.id, b.id]);
    expect((await allRows(owner, other.id)).map((r) => r.id)).toEqual([foreign!.id]);
    expectError(await owner.get(`/bases/${base.id}/rows/${a.id}`), 404, "not_found", "Row not found");
    // Deleting them again deletes nothing.
    expect(ok(await owner.post(`/bases/${base.id}/rows/delete`, { rowIds: [a.id, c.id] }))).toEqual({ rowIds: [] });
    // A base may lose all its rows.
    expect(ok(await owner.post(`/bases/${base.id}/rows/delete`, { rowIds: [seed!.id, b.id] })).rowIds.sort()).toEqual([seed!.id, b.id].sort());
    expect(await queryRows(owner, base.id)).toEqual({ items: [], nextCursor: null, references: { users: {}, pages: {} } });
  });

  test("rowIds must be a non-empty list of at most 500 UUIDs", async () => {
    const base = await newBase();
    expectInvalid(await owner.post(`/bases/${base.id}/rows/delete`, {}), "rowIds is required");
    expectInvalid(await owner.post(`/bases/${base.id}/rows/delete`, { rowIds: [] }), "rowIds is required");
    for (const rowIds of ["x", null, 5, { 0: NOWHERE }, Array(501).fill(NOWHERE)]) {
      expectInvalid(await owner.post(`/bases/${base.id}/rows/delete`, { rowIds }), "rowIds must be a list of at most 500 ids");
    }
    for (const rowIds of [["x"], [NOWHERE, 5], [null], [`${NOWHERE} `]]) {
      expectInvalid(await owner.post(`/bases/${base.id}/rows/delete`, { rowIds }), "rowIds must contain valid ids");
    }
    const [seed] = await allRows(owner, base.id);
    const many = [...Array(499).keys()].map((i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(ok(await owner.post(`/bases/${base.id}/rows/delete`, { rowIds: [...many, seed!.id] }))).toEqual({ rowIds: [seed!.id] });
  });

  test("members receive rowsDeleted with the deleted ids, and nothing when no row was deleted", async () => {
    const base = await newBase("Realtime deletes");
    const a = await addRow(owner, base.id);
    const b = await addRow(owner, base.id);
    const [socket, outside] = await Promise.all([connect(reader), connect(outsider)]);
    expect(ok(await owner.post(`/bases/${base.id}/rows/delete`, { rowIds: [NOWHERE], requestId: "nothing" }))).toEqual({ rowIds: [] });
    // Nothing deleted: not even the requestId is looked at.
    expect(ok(await owner.post(`/bases/${base.id}/rows/delete`, { rowIds: [NOWHERE], requestId: 5 }))).toEqual({ rowIds: [] });
    ok(await owner.post(`/bases/${base.id}/rows/delete`, { rowIds: [a.id, NOWHERE], requestId: "del-1" }));
    expect(await nextBaseEvent(socket)).toEqual({ t: "event", kind: "base", pageId: base.id, spaceId, event: { op: "rowsDeleted", rowIds: [a.id] }, requestId: "del-1" });
    // Accident: an invalid requestId answers 400 after the rows were deleted, and no event is sent.
    expectInvalid(await owner.post(`/bases/${base.id}/rows/delete`, { rowIds: [b.id], requestId: "x".repeat(65) }), "requestId must be at most 64 characters");
    expectError(await owner.get(`/bases/${base.id}/rows/${b.id}`), 404, "not_found", "Row not found");
    const [seed] = await allRows(owner, base.id);
    ok(await owner.post(`/bases/${base.id}/rows/delete`, { rowIds: [seed!.id] }));
    expect(await nextBaseEvent(socket)).toEqual({ t: "event", kind: "base", pageId: base.id, spaceId, event: { op: "rowsDeleted", rowIds: [seed!.id] } });
    expect(baseEvents(await settle(socket))).toEqual([]);
    expect(baseEvents(await settle(outside))).toEqual([]);
    await Promise.all([socket.close(), outside.close()]);
  });
});

describe("POST /bases/:id/rows/query", () => {
  /** A base with rows `r0` … `r{n-1}` in that order and nothing else. */
  const numbered = async (n: number): Promise<{ base: Base; rows: Row[] }> => {
    const base = await newBase("Paged");
    await emptyBase(owner, base.id);
    const rows: Row[] = [];
    for (let i = 0; i < n; i++) rows.push(await addRow(owner, base.id, { [base.properties[0]!.id]: `r${String(i).padStart(3, "0")}` }));
    return { base, rows };
  };
  const ids = (rows: Row[]) => rows.map((r) => r.id);

  test("answers with the rows in position order, a null cursor when that is all, and the references", async () => {
    const { base, rows } = await numbered(3);
    const res = await reader.post(`/bases/${base.id}/rows/query`, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        items: rows,
        nextCursor: null,
        references: { users: { [ownerId]: { id: ownerId, name: "Owner", avatarUrl: null } }, pages: {} },
      },
    });
    expect(rows.map((r) => r.position)).toEqual(["a0", "a1", "a2"]);
    // No body, null filter and sorts, and unknown fields make no difference.
    const bare = await owner.raw("POST", `/bases/${base.id}/rows/query`);
    expect(await bare.json()).toEqual(res.body);
    expect(ok(await owner.post(`/bases/${base.id}/rows/query`, { filter: null, sorts: null, view: "x", offset: 2 }))).toEqual(res.body.data);
    expect(ok(await owner.post(`/bases/${base.slugId}/rows/query`, { sorts: [] }))).toEqual(res.body.data);
  });

  test("limit defaults to 100 and may be 1 to 500", async () => {
    const { base, rows } = await numbered(102);
    const first = await queryRows(owner, base.id);
    expect(ids(first.items)).toEqual(ids(rows.slice(0, 100)));
    expect(decodeCursor(first.nextCursor!)).toEqual({ p: rows[99]!.position, i: rows[99]!.id });
    const rest = await queryRows(owner, base.id, { cursor: first.nextCursor });
    expect(ids(rest.items)).toEqual(ids(rows.slice(100)));
    expect(rest.nextCursor).toBeNull();
    expect((await queryRows(owner, base.id, { limit: 500 })).items).toHaveLength(102);
    expect((await queryRows(owner, base.id, { limit: 1 })).items).toEqual([rows[0]!]);
    // Exactly as many rows as the limit: there is no next page.
    expect((await queryRows(owner, base.id, { limit: 102 })).nextCursor).toBeNull();
    expect((await queryRows(owner, base.id, { limit: 101 })).nextCursor).not.toBeNull();
    // Numbers in strings are accepted the way a query string would carry them; a blank string means the default.
    for (const [limit, count] of [["2", 2], [" 3 ", 3], ["1e1", 10], ["4.0", 4], [5.0, 5], ["", 100]] as const) {
      expect((await queryRows(owner, base.id, { limit })).items).toHaveLength(count);
    }
    // Accident: any text JavaScript's Number() reads is accepted, hexadecimal included.
    expect((await queryRows(owner, base.id, { limit: "0x10" })).items).toHaveLength(16);
    for (const limit of [0, 501, -1, 1.5, "abc", "1,000", null, true, [5], {}]) {
      expectInvalid(await owner.post(`/bases/${base.id}/rows/query`, { limit }), "limit must be an integer between 1 and 500");
    }
  });

  test("tzOffset must be an integer between -900 and 900", async () => {
    const { base } = await numbered(1);
    for (const tzOffset of [-900, 900, 0, "60", "", "-0"]) {
      expect((await owner.post(`/bases/${base.id}/rows/query`, { tzOffset })).status).toBe(200);
    }
    for (const tzOffset of [-901, 901, 0.5, "abc", null, false, [60]]) {
      expectInvalid(await owner.post(`/bases/${base.id}/rows/query`, { tzOffset }), "tzOffset must be an integer between -900 and 900");
    }
  });

  test("an unsorted list pages by the position and id of the last row seen, so inserts do not shift the pages", async () => {
    const { base, rows } = await numbered(7);
    const first = await queryRows(owner, base.id, { limit: 3 });
    expect(ids(first.items)).toEqual(ids(rows.slice(0, 3)));
    expect(first.nextCursor).toBe(encodeCursor({ p: "a2", i: rows[2]!.id }));
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    // Rows inserted before the cursor do not show up later; rows inserted after it do.
    const before = await addRow(owner, base.id, {}, { afterRowId: rows[0]!.id });
    const after = await addRow(owner, base.id, {}, { afterRowId: rows[3]!.id });
    ok(await owner.post(`/bases/${base.id}/rows/delete`, { rowIds: [rows[2]!.id] }));
    const second = await queryRows(owner, base.id, { limit: 3, cursor: first.nextCursor });
    expect(ids(second.items)).toEqual([rows[3]!.id, after.id, rows[4]!.id]);
    const third = await queryRows(owner, base.id, { limit: 3, cursor: second.nextCursor });
    expect(ids(third.items)).toEqual([rows[5]!.id, rows[6]!.id]);
    expect(third.nextCursor).toBeNull();
    expect(ids(await allRows(owner, base.id))).toEqual([rows[0]!.id, before.id, rows[1]!.id, rows[3]!.id, after.id, rows[4]!.id, rows[5]!.id, rows[6]!.id]);
  });

  test("rows that share a position are told apart by id in the cursor", async () => {
    const base = await newBase("Twins");
    await emptyBase(owner, base.id);
    const twins: Row[] = [];
    for (let i = 0; i < 5; i++) twins.push(await addRow(owner, base.id, {}, { position: "a0" }));
    const sorted = ids(twins).sort();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const res = await queryRows(owner, base.id, { limit: 2, cursor });
      seen.push(...ids(res.items));
      cursor = res.nextCursor ?? undefined;
    }
    expect(seen).toEqual(sorted);
    expect(cursor).toBeUndefined();
    // A cursor made by hand works: rows strictly after (position, id).
    const from = encodeCursor({ p: "a0", i: sorted[1] });
    expect(ids((await queryRows(owner, base.id, { cursor: from })).items)).toEqual(sorted.slice(2));
    expect(ids((await queryRows(owner, base.id, { cursor: encodeCursor({ p: "a0", i: NOWHERE.replace(/[48]/g, "0") }) })).items)).toEqual(sorted);
    expect(ids((await queryRows(owner, base.id, { cursor: encodeCursor({ p: "Zz", i: "ffffffff-ffff-ffff-ffff-ffffffffffff" }) })).items)).toEqual(sorted);
    expect(ids((await queryRows(owner, base.id, { cursor: encodeCursor({ p: "a0", i: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF" }) })).items)).toEqual([]);
  });

  test("a sorted list pages by offset", async () => {
    const { base, rows } = await numbered(7);
    const sorts = [{ propertyId: base.properties[0]!.id, direction: "desc" }];
    const reversed = ids(rows).reverse();
    const first = await queryRows(owner, base.id, { limit: 3, sorts });
    expect(ids(first.items)).toEqual(reversed.slice(0, 3));
    expect(first.nextCursor).toBe(encodeCursor({ o: 3 }));
    const second = await queryRows(owner, base.id, { limit: 3, sorts, cursor: first.nextCursor });
    expect(ids(second.items)).toEqual(reversed.slice(3, 6));
    expect(decodeCursor(second.nextCursor!)).toEqual({ o: 6 });
    const third = await queryRows(owner, base.id, { limit: 3, sorts, cursor: second.nextCursor });
    expect(ids(third.items)).toEqual(reversed.slice(6));
    expect(third.nextCursor).toBeNull();
    // The limit may change between pages; the offset is what the cursor holds.
    expect(ids((await queryRows(owner, base.id, { limit: 500, sorts, cursor: first.nextCursor })).items)).toEqual(reversed.slice(3));
    // A row sorted in before the offset pushes the rest down: the last row of a page is seen again.
    await addRow(owner, base.id, { [base.properties[0]!.id]: "zzz" });
    expect(ids((await queryRows(owner, base.id, { limit: 3, sorts, cursor: first.nextCursor })).items)).toEqual(reversed.slice(2, 5));
    // Offsets made by hand: fractions round down; an offset past the end is an empty page.
    expect(ids((await queryRows(owner, base.id, { limit: 2, sorts, cursor: encodeCursor({ o: 5.9 }) })).items)).toEqual(reversed.slice(4, 6));
    expect(await queryRows(owner, base.id, { sorts, cursor: encodeCursor({ o: 100 }) })).toMatchObject({ items: [], nextCursor: null });
  });

  test("a cursor that cannot be read, or belongs to the other kind of list, is ignored", async () => {
    const { base, rows } = await numbered(4);
    const sorts = [{ propertyId: base.properties[0]!.id, direction: "asc" }];
    const all = ids(rows);
    const keyset = (await queryRows(owner, base.id, { limit: 2 })).nextCursor!;
    const offset = (await queryRows(owner, base.id, { limit: 2, sorts })).nextCursor!;
    const garbage = [
      "!!!",
      "not base64 at all",
      encodeCursor("text"),
      encodeCursor(5),
      encodeCursor(null),
      encodeCursor([1, 2]),
      encodeCursor({}),
      Buffer.from("{broken").toString("base64url"),
    ];
    for (const cursor of garbage) {
      expect(ids((await queryRows(owner, base.id, { cursor })).items)).toEqual(all);
      expect(ids((await queryRows(owner, base.id, { cursor, sorts })).items)).toEqual(all);
    }
    // Unsorted: both the position and a valid id are needed.
    for (const value of [{ o: 2 }, { p: "a1" }, { i: rows[1]!.id }, { p: "a1", i: "nope" }, { p: 5, i: rows[1]!.id }, { p: "a1", i: null }]) {
      expect(ids((await queryRows(owner, base.id, { cursor: encodeCursor(value) })).items)).toEqual(all);
    }
    expect(ids((await queryRows(owner, base.id, { cursor: offset })).items)).toEqual(all);
    // Sorted: the offset must be a number that is not negative.
    for (const value of [{ p: "a1", i: rows[1]!.id }, { o: "2" }, { o: -1 }, { o: null }, { o: [2] }]) {
      expect(ids((await queryRows(owner, base.id, { sorts, cursor: encodeCursor(value) })).items)).toEqual(all);
    }
    expect(ids((await queryRows(owner, base.id, { sorts, cursor: keyset })).items)).toEqual(all);
    // The cursor itself must be a string of 1 to 2000 characters.
    expectInvalid(await owner.post(`/bases/${base.id}/rows/query`, { cursor: 5 }), "cursor must be a string");
    expectInvalid(await owner.post(`/bases/${base.id}/rows/query`, { cursor: null }), "cursor must be a string");
    expectInvalid(await owner.post(`/bases/${base.id}/rows/query`, { cursor: "" }), "cursor is required");
    expectInvalid(await owner.post(`/bases/${base.id}/rows/query`, { cursor: "x".repeat(2001) }), "cursor must be at most 2000 characters");
    expect(ids((await queryRows(owner, base.id, { cursor: "x".repeat(2000) })).items)).toEqual(all);
    // Surrounding blanks are trimmed off a cursor.
    expect(ids((await queryRows(owner, base.id, { cursor: ` ${keyset} ` })).items)).toEqual(all.slice(2));
  });

  test("pagination covers every row once, sorted or not, and filters apply before paging", async () => {
    const { base, rows } = await numbered(8);
    const title = base.properties[0]!.id;
    for (const sorts of [undefined, [{ propertyId: title, direction: "asc" }]]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await queryRows(owner, base.id, { limit: 3, sorts, ...(cursor ? { cursor } : {}) });
        expect(page.items.length).toBeLessThanOrEqual(3);
        seen.push(...ids(page.items));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(ids(rows));
    }
    const filter = { op: "and", children: [{ propertyId: title, op: "gte", value: "r004" }] };
    const first = await queryRows(owner, base.id, { limit: 3, filter });
    expect(ids(first.items)).toEqual(ids(rows.slice(4, 7)));
    const second = await queryRows(owner, base.id, { limit: 3, filter, cursor: first.nextCursor });
    expect(ids(second.items)).toEqual([rows[7]!.id]);
    expect(second.nextCursor).toBeNull();
  });

  describe("references", () => {
    test("users are the creators, last editors and the people in person cells of the rows on the page", async () => {
      const base = await newBase("People");
      await emptyBase(owner, base.id);
      const one = await addProperty(owner, base.id, "One", "person");
      const many = await addProperty(owner, base.id, "Many", "person", { allowMultiple: true });
      const text = await addProperty(owner, base.id, "Text", "text");
      const guest = await t.addMember(owner, "guest@example.com");
      const first = await addRow(owner, base.id, { [one.id]: readerId, [text.id]: guest.user.id });
      const second = await addRow(writer, base.id, { [many.id]: [guest.user.id, NOWHERE, "not-a-uuid", ownerId] });
      const ref = (id: string, name: string) => ({ [id]: { id, name, avatarUrl: null } });
      const page = await queryRows(reader, base.id);
      expect(page.references).toEqual({
        users: { ...ref(ownerId, "Owner"), ...ref(readerId, "reader"), ...ref(writerId, "writer"), ...ref(guest.user.id, "guest") },
        pages: {},
      });
      // Only the rows of the page count.
      expect((await queryRows(reader, base.id, { limit: 1 })).references.users).toEqual({ ...ref(ownerId, "Owner"), ...ref(readerId, "reader") });
      // The last editor is added, and a renamed user shows the new name.
      await updateRow(writer, base.id, first.id, { [text.id]: "edited" });
      ok(await guest.client.post("/me/update", { name: "Guest Star" }));
      expect((await queryRows(reader, base.id, { limit: 1 })).references.users).toEqual({
        ...ref(ownerId, "Owner"),
        ...ref(readerId, "reader"),
        ...ref(writerId, "writer"),
      });
      expect(ok(await reader.get(`/bases/${base.id}/rows/${second.id}`)).references.users).toEqual({
        ...ref(writerId, "writer"),
        ...ref(ownerId, "Owner"),
        ...ref(guest.user.id, "Guest Star"),
      });
    });

    test("a deleted user leaves the rows without creator and editor, and is not among the references", async () => {
      const base = await newBase("Leavers");
      await emptyBase(owner, base.id);
      const who = await addProperty(owner, base.id, "Who", "person");
      const leaver = await t.addMember(owner, "row-leaver@example.com");
      ok(await owner.post(`/spaces/${spaceId}/members/add`, { role: "writer", userIds: [leaver.user.id] }));
      const row = await addRow(leaver.client, base.id, { [who.id]: leaver.user.id });
      ok(await owner.post("/members/delete", { userId: leaver.user.id }));
      const page = await queryRows(owner, base.id);
      expect(page.items).toEqual([{ ...row, creatorId: null, lastEditorId: null }]);
      expect(page.references).toEqual({ users: {}, pages: {} });
    });

    test("pages are those in page cells that the user may read and that are not in the trash", async () => {
      const base = await newBase("Links");
      await emptyBase(owner, base.id);
      const link = await addProperty(owner, base.id, "Link", "page");
      const text = await addProperty(owner, base.id, "Text", "text");
      const visible = ok(await owner.post("/pages", { spaceId, title: "Visible" })).page;
      const untitled = ok(await owner.post("/pages", { spaceId })).page;
      const trashed = ok(await owner.post("/pages", { spaceId, title: "Trashed" })).page;
      ok(await owner.post(`/pages/${trashed.id}/delete`));
      const secret = ok(await owner.post("/pages", { spaceId: otherSpaceId, title: "Secret", icon: "🤫" })).page;
      for (const id of [visible.id.toUpperCase(), untitled.id, trashed.id, secret.id, NOWHERE, "not-a-uuid", base.slugId]) {
        await addRow(owner, base.id, { [link.id]: id });
      }
      // A page id in a text cell is just text.
      await addRow(owner, base.id, { [text.id]: visible.id });
      const resolved = (p: { id: string; slugId: string; title: string | null; icon: string | null }, spaceSlug: string) => ({
        [p.id]: { id: p.id, slugId: p.slugId, title: p.title, icon: p.icon, spaceSlug },
      });
      expect((await queryRows(owner, base.id)).references.pages).toEqual({
        ...resolved(visible, "general"),
        ...resolved(untitled, "general"),
        ...resolved(secret, "private"),
      });
      expect((await queryRows(reader, base.id)).references.pages).toEqual({ ...resolved(visible, "general"), ...resolved(untitled, "general") });
      expect((await queryRows(reader, base.id, { limit: 1, cursor: encodeCursor({ o: 0 }) })).references.pages).toEqual(resolved(visible, "general"));
    });
  });
});
