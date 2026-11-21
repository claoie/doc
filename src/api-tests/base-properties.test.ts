import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Base, Property } from "common/bases";
import { connect, startServer, type Client, type Socket, type TestServer } from "./harness";
import {
  addProperty,
  addRow,
  addView,
  allRows,
  createBase,
  emptyBase,
  expectError,
  expectInvalid,
  getBase,
  getRow,
  nextBaseEvent,
  ok,
  PROPERTY_ID,
} from "./harness/base-fixtures";

let t: TestServer;
let owner: Client;
let ownerId: string;
let spaceId: string;
let reader: Client;
let socket: Socket;

const TYPES = "text, longText, number, select, status, multiSelect, date, person, file, page, checkbox, url, email, createdAt, lastEditedAt, lastEditedBy, formula";

beforeAll(async () => {
  t = await startServer();
  let user: { id: string };
  ({ owner, user, spaceId } = await t.setupOwner());
  ownerId = user.id;
  const member = await t.addMember(owner, "reader@example.com");
  ok(await owner.post(`/spaces/${spaceId}/members/add`, { role: "reader", userIds: [member.user.id] }));
  reader = member.client;
  socket = await connect(reader);
});

afterAll(async () => {
  await socket.close();
  await t.close();
});

const newBase = (title = "Properties") => createBase(owner, spaceId, { title });
const create = (baseId: string, body: unknown) => owner.post(`/bases/${baseId}/properties`, body);
const update = (baseId: string, propertyId: string, body: unknown) => owner.post(`/bases/${baseId}/properties/${propertyId}/update`, body);
const remove = (baseId: string, propertyId: string, body: unknown = {}) => owner.post(`/bases/${baseId}/properties/${propertyId}/delete`, body);
const cellsOf = async (baseId: string, propertyId: string) => (await allRows(owner, baseId)).map((r) => r.cells[propertyId] ?? null);
const baseEventOf = (base: Base, requestId?: string) => ({
  t: "event",
  kind: "base",
  pageId: base.id,
  spaceId,
  // The base is described as the acting user sees it; the receiver here is a reader.
  event: { op: "base", base: { ...base, canEdit: true } },
  ...(requestId === undefined ? {} : { requestId }),
});
const rowsChangedOf = (baseId: string) => ({ t: "event", kind: "base", pageId: baseId, spaceId, event: { op: "rowsChanged" } });

describe("POST /bases/:id/properties", () => {
  test("adds a property after the last one and answers with it", async () => {
    const base = await newBase();
    const res = await create(base.id, { name: "  Amount  ", type: "number" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { id: expect.stringMatching(PROPERTY_ID), name: "Amount", type: "number", options: { format: "plain" }, isPrimary: false, position: "a3" },
    });
    const second = ok(await create(base.id, { name: "Second", type: "text" }));
    expect(second.position).toBe("a4");
    const after = await getBase(owner, base.id);
    expect(after.properties).toEqual([...base.properties, res.body.data, second]);
    const [row] = await t.sql`SELECT name, type, options, is_primary, position FROM base_properties WHERE page_id = ${base.id} AND id = ${second.id}`;
    expect(row).toEqual({ name: "Second", type: "text", options: {}, is_primary: false, position: "a4" });
    // The new property goes after the largest position, wherever that property is listed.
    ok(await update(base.id, base.properties[0]!.id, { position: "c" }));
    expect(ok(await create(base.id, { name: "Third", type: "text" })).position).toBe("o");
  });

  test("every type can be added; each has its default options", async () => {
    const base = await newBase();
    const defaults: [string, unknown][] = [
      ["text", {}],
      ["longText", {}],
      ["number", { format: "plain" }],
      ["select", { choices: [], choiceOrder: [] }],
      ["status", {}],
      ["multiSelect", { choices: [], choiceOrder: [] }],
      ["date", { includeTime: false }],
      ["person", { allowMultiple: false }],
      ["file", {}],
      ["page", {}],
      ["checkbox", {}],
      ["url", {}],
      ["email", {}],
      ["createdAt", {}],
      ["lastEditedAt", {}],
      ["lastEditedBy", {}],
    ];
    for (const [type, options] of defaults) {
      expect(ok(await create(base.id, { name: `A ${type}`, type })).options).toEqual(options);
      // null options are the same as none.
      expect(ok(await create(base.id, { name: `B ${type}`, type, options: null })).options).toEqual(options);
    }
    const formula = ok(await create(base.id, { name: "A formula", type: "formula", options: { source: "1 + 1" } }));
    expect(formula).toEqual({
      id: expect.stringMatching(PROPERTY_ID),
      name: "A formula",
      type: "formula",
      options: { source: "1 + 1", resultType: "number", dependencies: [] },
      isPrimary: false,
      position: expect.any(String),
    });
    const after = await getBase(owner, base.id);
    expect<unknown>(after.properties.map((p) => p.type)).toEqual(["text", "text", "text", ...defaults.flatMap(([type]) => [type, type]), "formula"]);
    expect(new Set(after.properties.map((p) => p.id)).size).toBe(36);
    expect(after.properties.filter((p) => p.isPrimary).map((p) => p.name)).toEqual(["Title"]);
  });

  test("the name is required, trimmed and at most 200 characters", async () => {
    const base = await newBase();
    for (const name of [undefined, null, 5, ["x"], {}]) expectInvalid(await create(base.id, { name, type: "text" }), "name must be a string");
    for (const name of ["", "   ", "\n\t"]) expectInvalid(await create(base.id, { name, type: "text" }), "name is required");
    expectInvalid(await create(base.id, { name: "x".repeat(201), type: "text" }), "name must be at most 200 characters");
    const longest = "😀".repeat(200);
    expect(ok(await create(base.id, { name: ` ${longest} `, type: "text" })).name).toBe(longest);
    expect(ok(await create(base.id, { name: "مرحبا 日本語 e\u0301", type: "text" })).name).toBe("مرحبا 日本語 e\u0301");
    // The name is checked before the type.
    expectInvalid(await create(base.id, { name: "", type: "nope" }), "name is required");
  });

  test("the type is required and must be a known one", async () => {
    const base = await newBase();
    expectInvalid(await create(base.id, { name: "X" }), "type is required");
    for (const type of ["nope", "Text", "", null, 5, ["text"]]) {
      expectInvalid(await create(base.id, { name: "X", type }), `type must be one of ${TYPES}`);
    }
    expect((await getBase(owner, base.id)).properties).toHaveLength(3);
  });

  test("names are unique in a base, whatever the case and the surrounding blanks", async () => {
    const base = await newBase();
    for (const name of ["Text 1", " text 1 ", "TEXT 1", "title"]) {
      expectInvalid(await create(base.id, { name, type: "number" }), "A property with this name already exists");
    }
    // The name is compared before the options are looked at.
    expectInvalid(await create(base.id, { name: "Title", type: "number", options: "bad" }), "A property with this name already exists");
    expect(ok(await create(base.id, { name: "Text  1", type: "text" })).name).toBe("Text  1");
    expect(ok(await create(base.id, { name: "Títle", type: "text" })).name).toBe("Títle");
    // Another base may use the same names, and a deleted property frees its name.
    const other = await newBase("Other");
    const spare = ok(await create(other.id, { name: "Spare", type: "text" }));
    ok(await remove(other.id, spare.id));
    expect(ok(await create(other.id, { name: "spare", type: "number" })).name).toBe("spare");
  });

  describe("options", () => {
    let base: Base;
    let n = 0;
    beforeAll(async () => {
      base = await newBase("Options");
    });
    const options = async (type: string, value: unknown) => {
      const res = await create(base.id, { name: `P${n++}`, type, options: value });
      return res.status === 200 ? res.body.data.options : res.body.error!.message;
    };
    const INVALID = "Invalid property options";

    test("must be an object, for every type but formula", async () => {
      for (const type of ["text", "number", "select", "date", "person", "checkbox", "createdAt"]) {
        for (const value of ["x", 5, true, [], [{}]]) expect([type, value, await options(type, value)]).toEqual([type, value, INVALID]);
      }
    });

    test("keys the server does not know are kept, over the defaults of the type", async () => {
      expect(await options("text", { richText: true, custom: { nested: [1, "two", null] }, defaultValue: "x" })).toEqual({
        richText: true,
        custom: { nested: [1, "two", null] },
        defaultValue: "x",
      });
      expect(await options("number", { currencyCode: "EUR", separators: "." })).toEqual({ format: "plain", currencyCode: "EUR", separators: "." });
      expect(await options("date", { dateFormat: "DD/MM/YYYY" })).toEqual({ includeTime: false, dateFormat: "DD/MM/YYYY" });
      expect(await options("person", { note: 1 })).toEqual({ allowMultiple: false, note: 1 });
      // What only matters to another type is not checked.
      expect(await options("text", { choices: "x", format: "nope", precision: -1, timeFormat: 5 })).toEqual({ choices: "x", format: "nope", precision: -1, timeFormat: 5 });
      expect(await options("checkbox", {})).toEqual({});
    });

    test("may be up to 256 KiB of JSON", async () => {
      // `{"note":"…"}` is 11 characters around the text.
      expect((await options("text", { note: "x".repeat(256 * 1024 - 11) })).note).toHaveLength(256 * 1024 - 11);
      expect(await options("text", { note: "x".repeat(256 * 1024 - 10) })).toBe(INVALID);
      expect(await options("select", { note: "x".repeat(256 * 1024 - 10) })).toBe(INVALID);
    });

    test("choices get the colour gray by default, keep a category, lose other keys; choiceOrder lists them all", async () => {
      for (const type of ["select", "status", "multiSelect"]) {
        expect(await options(type, {})).toEqual({ choices: [], choiceOrder: [] });
        expect(await options(type, { choiceOrder: ["a"], disableColors: true })).toEqual({ choices: [], choiceOrder: [], disableColors: true });
        expect(
          await options(type, {
            choices: [
              { id: "a", name: "Alpha" },
              { id: "b", name: "", color: "red", category: "todo", extra: 1, position: "a0" },
              { id: "c", name: "Gamma", color: "not-a-colour", category: "inProgress" },
              { id: "d".repeat(64), name: "n".repeat(200), color: "c".repeat(32), category: "complete" },
            ],
          }),
        ).toEqual({
          choices: [
            { id: "a", name: "Alpha", color: "gray" },
            { id: "b", name: "", color: "red", category: "todo" },
            { id: "c", name: "Gamma", color: "not-a-colour", category: "inProgress" },
            { id: "d".repeat(64), name: "n".repeat(200), color: "c".repeat(32), category: "complete" },
          ],
          choiceOrder: ["a", "b", "c", "d".repeat(64)],
        });
      }
    });

    test("choiceOrder keeps the known ids in the order given and appends the choices it leaves out", async () => {
      const choices = [
        { id: "a", name: "A", color: "gray" },
        { id: "b", name: "B", color: "gray" },
        { id: "c", name: "C", color: "gray" },
      ];
      const order = async (choiceOrder: unknown) => (await options("select", { choices, choiceOrder })).choiceOrder;
      expect(await order(["c", "a", "b"])).toEqual(["c", "a", "b"]);
      expect(await order(["b", "zzz", 5, null, "a", "b"])).toEqual(["b", "a", "c"]);
      expect(await order([])).toEqual(["a", "b", "c"]);
      for (const notAList of ["c", { 0: "c" }, 5, null, undefined]) expect(await order(notAList)).toEqual(["a", "b", "c"]);
    });

    test("invalid choices are refused", async () => {
      const one = { id: "a", name: "A" };
      const invalid: unknown[] = [
        "x",
        {},
        5,
        null,
        [null],
        ["a"],
        [[one]],
        [{ name: "A" }],
        [{ id: "", name: "A" }],
        [{ id: 5, name: "A" }],
        [{ id: "i".repeat(65), name: "A" }],
        [one, { id: "a", name: "Again" }],
        [{ id: "a" }],
        [{ id: "a", name: 5 }],
        [{ id: "a", name: null }],
        [{ id: "a", name: "n".repeat(201) }],
        [{ ...one, color: 5 }],
        [{ ...one, color: null }],
        [{ ...one, color: "c".repeat(33) }],
        [{ ...one, category: "done" }],
        [{ ...one, category: "" }],
        [{ ...one, category: null }],
        [{ ...one, category: "Todo" }],
        Array.from({ length: 501 }, (_, i) => ({ id: `c${i}`, name: "x" })),
      ];
      for (const type of ["select", "status", "multiSelect"]) {
        for (const choices of invalid) {
          const result = await options(type, { choices });
          expect([type, JSON.stringify(choices).slice(0, 60), result]).toEqual([type, JSON.stringify(choices).slice(0, 60), INVALID]);
        }
      }
      const most = Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, name: "x" }));
      const accepted = await options("multiSelect", { choices: most });
      expect(accepted.choices).toHaveLength(500);
      expect(accepted.choiceOrder).toEqual(most.map((c) => c.id));
      // Ids only need to differ exactly; names may repeat.
      expect((await options("select", { choices: [one, { id: "A", name: "A" }, { id: " a", name: "A" }] })).choiceOrder).toEqual(["a", "A", " a"]);
    });

    test("number: the format is one of four and the precision an integer from 0 to 20, or null", async () => {
      for (const format of ["plain", "currency", "percent", "progress"]) expect(await options("number", { format })).toEqual({ format });
      for (const format of ["money", "Plain", "", 5, null]) expect(await options("number", { format })).toBe(INVALID);
      for (const precision of [0, 2, 20, null]) expect(await options("number", { precision })).toEqual({ format: "plain", precision });
      for (const precision of [-1, 21, 1.5, "2", true, [2]]) expect(await options("number", { precision })).toBe(INVALID);
      expect(await options("number", { format: "currency", precision: 2, currencyCode: "USD", currencySymbol: "$" })).toEqual({
        format: "currency",
        precision: 2,
        currencyCode: "USD",
        currencySymbol: "$",
      });
    });

    test("date: the timeFormat is 12h or 24h; includeTime is kept as sent", async () => {
      expect(await options("date", { timeFormat: "12h" })).toEqual({ includeTime: false, timeFormat: "12h" });
      expect(await options("date", { timeFormat: "24h", includeTime: true })).toEqual({ includeTime: true, timeFormat: "24h" });
      for (const timeFormat of ["am", "", 12, null]) expect(await options("date", { timeFormat })).toBe(INVALID);
      expect(await options("date", { includeTime: "yes" })).toEqual({ includeTime: "yes" });
    });

    test("person: allowMultiple is kept as sent", async () => {
      expect(await options("person", { allowMultiple: true })).toEqual({ allowMultiple: true });
      expect(await options("person", {})).toEqual({ allowMultiple: false });
      expect(await options("person", { allowMultiple: "yes" })).toEqual({ allowMultiple: "yes" });
    });

    test("a refused property is not created", async () => {
      const before = (await getBase(owner, base.id)).properties.length;
      expect(await options("number", { format: "nope" })).toBe(INVALID);
      expect((await getBase(owner, base.id)).properties).toHaveLength(before);
    });
  });

  test("a body over 1 MiB is refused", async () => {
    const base = await newBase();
    expectError(await create(base.id, { name: "Big", type: "text", padding: "x".repeat(1024 * 1024) }), 413, "payload_too_large", "Request body is too large");
  });

  test("members receive the whole base, with the requestId; a formula is followed by rowsChanged", async () => {
    const base = await newBase("Announced properties");
    const added = ok(await create(base.id, { name: "Amount", type: "number", requestId: "prop-1" }));
    const withAmount = { ...base, properties: [...base.properties, added] };
    expect(await nextBaseEvent(socket, base.id)).toEqual(baseEventOf(withAmount, "prop-1"));
    // A refused property announces nothing.
    expectInvalid(await create(base.id, { name: "Amount", type: "text" }), "A property with this name already exists");
    const formula = ok(await create(base.id, { name: "Double", type: "formula", options: { source: 'prop("Amount") * 2' } }));
    const withFormula = { ...withAmount, properties: [...withAmount.properties, formula] };
    expect(await nextBaseEvent(socket, base.id)).toEqual(baseEventOf(withFormula));
    expect(await nextBaseEvent(socket, base.id)).toEqual(rowsChangedOf(base.id));
    // Accident: an invalid requestId answers 400 although the property was created; no event is sent for it.
    expectInvalid(await create(base.id, { name: "Ghost", type: "text", requestId: "x".repeat(65) }), "requestId must be at most 64 characters");
    const after = await getBase(owner, base.id);
    expect(after.properties.map((p) => p.name)).toEqual(["Title", "Text 1", "Text 2", "Amount", "Double", "Ghost"]);
    const last = ok(await create(base.id, { name: "Last", type: "text", requestId: "prop-2" }));
    expect(await nextBaseEvent(socket, base.id)).toEqual(baseEventOf({ ...after, properties: [...after.properties, last] }, "prop-2"));
  });
});

describe("POST /bases/:id/properties/:propertyId/update", () => {
  test("renames, moves and answers with the property; what is not sent stays", async () => {
    const base = await newBase();
    const amount = await addProperty(owner, base.id, "Amount", "number", { format: "percent", precision: 1 });
    const renamed = await update(base.id, amount.id, { name: "  Share  " });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ data: { ...amount, name: "Share" } });
    const moved = ok(await update(base.id, amount.id, { position: " a0V " }));
    expect(moved).toEqual({ ...amount, name: "Share", position: "a0V" });
    expect((await getBase(owner, base.id)).properties.map((p) => p.name)).toEqual(["Title", "Share", "Text 1", "Text 2"]);
    // An empty update changes nothing but is still an update.
    const [before] = await t.sql`SELECT updated_at FROM base_properties WHERE page_id = ${base.id} AND id = ${amount.id}`;
    expect(ok(await update(base.id, amount.id, {}))).toEqual(moved);
    expect(ok(await owner.request("POST", `/bases/${base.id}/properties/${amount.id}/update`))).toEqual(moved);
    const [after] = await t.sql`SELECT updated_at FROM base_properties WHERE page_id = ${base.id} AND id = ${amount.id}`;
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    // The primary property can be renamed and moved too.
    expect(ok(await update(base.id, base.properties[0]!.id, { name: "Name", position: "z" }))).toEqual({ ...base.properties[0]!, name: "Name", position: "z" });
  });

  test("the name follows the same rules as on creation; a property may take its own name in another case", async () => {
    const base = await newBase();
    const [title, text1] = base.properties;
    for (const name of [null, 5, ["x"]]) expectInvalid(await update(base.id, text1!.id, { name }), "name must be a string");
    for (const name of ["", "  "]) expectInvalid(await update(base.id, text1!.id, { name }), "name is required");
    expectInvalid(await update(base.id, text1!.id, { name: "x".repeat(201) }), "name must be at most 200 characters");
    for (const name of ["Title", " title ", "TEXT 2"]) expectInvalid(await update(base.id, text1!.id, { name }), "A property with this name already exists");
    expect(ok(await update(base.id, text1!.id, { name: "TEXT 1" })).name).toBe("TEXT 1");
    expect(ok(await update(base.id, text1!.id, { name: "TEXT 1" })).name).toBe("TEXT 1");
    expect(ok(await update(base.id, title!.id, { name: "😀".repeat(200) })).name).toBe("😀".repeat(200));
  });

  test("the position must be 1 to 512 characters of 0-9, A-Z, a-z; positions may repeat", async () => {
    const base = await newBase();
    const id = base.properties[1]!.id;
    for (const position of ["a-1", "a 1", "é"]) expectInvalid(await update(base.id, id, { position }), "position is invalid");
    expectInvalid(await update(base.id, id, { position: "" }), "position is required");
    expectInvalid(await update(base.id, id, { position: 5 }), "position must be a string");
    expectInvalid(await update(base.id, id, { position: null }), "position must be a string");
    expectInvalid(await update(base.id, id, { position: "a".repeat(513) }), "position must be at most 512 characters");
    expect(ok(await update(base.id, id, { position: "a0" })).position).toBe("a0");
    const order = (await getBase(owner, base.id)).properties.map((p) => p.id);
    expect(order).toEqual([...[base.properties[0]!.id, id].sort(), base.properties[2]!.id]);
  });

  test("an unknown property is not found, before anything else is checked", async () => {
    const base = await newBase();
    const other = await newBase("Other");
    for (const id of ["pzzzzzzzzz", "nope", other.properties[1]!.id, base.properties[1]!.id.toUpperCase()]) {
      expectError(await update(base.id, id, { name: "" }), 404, "not_found", "Property not found");
    }
  });

  test("options replace the old ones entirely, over the defaults of the type; null resets them", async () => {
    const base = await newBase();
    const amount = await addProperty(owner, base.id, "Amount", "number", { format: "percent", precision: 1, custom: true });
    expect(ok(await update(base.id, amount.id, { options: { precision: 3 } })).options).toEqual({ format: "plain", precision: 3 });
    expect(ok(await update(base.id, amount.id, { name: "Still", position: "b" })).options).toEqual({ format: "plain", precision: 3 });
    expect(ok(await update(base.id, amount.id, { options: null })).options).toEqual({ format: "plain" });
    expectInvalid(await update(base.id, amount.id, { options: { format: "nope" } }), "Invalid property options");
    expectInvalid(await update(base.id, amount.id, { options: "x" }), "Invalid property options");
    // The same type named again is not a change of type: the options stay unless sent.
    ok(await update(base.id, amount.id, { options: { format: "currency" } }));
    expect(ok(await update(base.id, amount.id, { type: "number" })).options).toEqual({ format: "currency" });
    // A refused update changes nothing, the name included.
    expectInvalid(await update(base.id, amount.id, { name: "Renamed", options: { precision: 99 } }), "Invalid property options");
    expect((await getBase(owner, base.id)).properties[3]).toMatchObject({ name: "Still", options: { format: "currency" } });
  });

  test("which properties can change type, and to what", async () => {
    const base = await newBase();
    const [title, text1] = base.properties;
    expectInvalid(await update(base.id, title!.id, { type: "number" }), "The primary property cannot change type");
    expect(ok(await update(base.id, title!.id, { type: "text" })).type).toBe("text");
    for (const type of ["createdAt", "lastEditedAt", "lastEditedBy", "formula"]) {
      expectInvalid(await update(base.id, text1!.id, { type }), `A property cannot be converted to ${type}`);
      const fixed = await addProperty(owner, base.id, `A ${type}`, type, type === "formula" ? { source: "1" } : undefined);
      expectInvalid(await update(base.id, fixed.id, { type: "text" }), "This property cannot change type");
      if (type !== "formula") expectInvalid(await update(base.id, fixed.id, { type: "formula" }), "This property cannot change type");
      expect(ok(await update(base.id, fixed.id, { type, name: `Still ${type}` })).type).toBe(type);
    }
    for (const type of ["nope", "", null, 5]) expectInvalid(await update(base.id, text1!.id, { type }), `type must be one of ${TYPES}`);
    expect((await getBase(owner, base.id)).properties[1]).toEqual(text1!);
  });

  test("a change of type takes the options sent, or the defaults of the new type", async () => {
    const base = await newBase();
    const p = await addProperty(owner, base.id, "Shifting", "number", { format: "percent", custom: 1 });
    expect(ok(await update(base.id, p.id, { type: "date" })).options).toEqual({ includeTime: false });
    expect(ok(await update(base.id, p.id, { type: "select", options: { choices: [{ id: "a", name: "A" }] } })).options).toEqual({
      choices: [{ id: "a", name: "A", color: "gray" }],
      choiceOrder: ["a"],
    });
    // To status without options: none at all, so the choices are gone.
    expect(ok(await update(base.id, p.id, { type: "status" })).options).toEqual({});
    expect(ok(await update(base.id, p.id, { type: "multiSelect" })).options).toEqual({ choices: [], choiceOrder: [] });
    expectInvalid(await update(base.id, p.id, { type: "number", options: { format: "nope" } }), "Invalid property options");
    expect((await getBase(owner, base.id)).properties[3]!.type).toBe("multiSelect");
    expect(ok(await update(base.id, p.id, { type: "person", options: { allowMultiple: true } }))).toEqual({ ...p, type: "person", options: { allowMultiple: true } });
  });

  test("removing a choice clears it from the cells, without counting as an edit of the rows", async () => {
    const base = await newBase();
    await emptyBase(owner, base.id);
    const choices = [
      { id: "a", name: "A", color: "red" },
      { id: "b", name: "B", color: "blue" },
      { id: "c", name: "C", color: "green" },
    ];
    const one = await addProperty(owner, base.id, "One", "select", { choices });
    const state = await addProperty(owner, base.id, "State", "status", { choices });
    const many = await addProperty(owner, base.id, "Many", "multiSelect", { choices });
    const rows = [];
    for (const [single, list] of [["a", ["a", "b", "c"]], ["b", ["b"]], ["c", ["c", "a"]], [null, null]] as const) {
      rows.push(await addRow(owner, base.id, { [one.id]: single, [state.id]: single, [many.id]: list }));
    }
    const kept = { choices: [choices[0]!, choices[2]!] };
    for (const property of [one, state, many]) {
      expect(ok(await update(base.id, property.id, { options: kept })).options).toEqual({ choices: kept.choices, choiceOrder: ["a", "c"] });
    }
    expect(await cellsOf(base.id, one.id)).toEqual(["a", null, "c", null]);
    expect(await cellsOf(base.id, state.id)).toEqual(["a", null, "c", null]);
    expect(await cellsOf(base.id, many.id)).toEqual([["a", "c"], null, ["c", "a"], null]);
    const after = await allRows(owner, base.id);
    expect(after.map((r) => [r.updatedAt, r.lastEditorId])).toEqual(rows.map((r) => [r.updatedAt, r.lastEditorId]));
    // Renaming, recolouring, reordering or adding choices leaves the cells alone.
    const renamed = { choices: [{ id: "c", name: "See", color: "pink" }, { id: "a", name: "Ay", color: "red" }, { id: "d", name: "D" }], choiceOrder: ["d"] };
    expect(ok(await update(base.id, many.id, { options: renamed })).options).toEqual({
      choices: [{ id: "c", name: "See", color: "pink" }, { id: "a", name: "Ay", color: "red" }, { id: "d", name: "D", color: "gray" }],
      choiceOrder: ["d", "c", "a"],
    });
    expect(await cellsOf(base.id, many.id)).toEqual([["a", "c"], null, ["c", "a"], null]);
    // Options without choices remove them all.
    ok(await update(base.id, one.id, { options: {} }));
    expect(await cellsOf(base.id, one.id)).toEqual([null, null, null, null]);
  });

  test("turning allowMultiple on wraps each person in a list; turning it off keeps the first", async () => {
    const base = await newBase();
    await emptyBase(owner, base.id);
    const who = await addProperty(owner, base.id, "Who", "person");
    await addRow(owner, base.id, { [who.id]: "u1" });
    await addRow(owner, base.id, {});
    expect(ok(await update(base.id, who.id, { options: { allowMultiple: true } })).options).toEqual({ allowMultiple: true });
    expect(await cellsOf(base.id, who.id)).toEqual([["u1"], null]);
    await addRow(owner, base.id, { [who.id]: ["u2", "u3"] });
    // Options that leave the setting as it is do not touch the cells.
    ok(await update(base.id, who.id, { options: { allowMultiple: true, note: "x" } }));
    expect(await cellsOf(base.id, who.id)).toEqual([["u1"], null, ["u2", "u3"]]);
    expect(ok(await update(base.id, who.id, { options: {} })).options).toEqual({ allowMultiple: false });
    expect(await cellsOf(base.id, who.id)).toEqual(["u1", null, "u2"]);
  });

  test("renaming a property rewrites the formulas that use it", async () => {
    const base = await newBase();
    const price = await addProperty(owner, base.id, "Price", "number");
    const qty = await addProperty(owner, base.id, "Qty", "number");
    const total = await addProperty(owner, base.id, "Total", "formula", { source: 'prop("Price") * prop( \'price\' ) + prop("Qty") & "Price"' });
    const other = await addProperty(owner, base.id, "Other", "formula", { source: 'prop("Qty") + 1' });
    const row = await addRow(owner, base.id, { [price.id]: 3, [qty.id]: 1 });
    expect(row.cells[total.id]).toBe("10Price");
    ok(await update(base.id, price.id, { name: 'Unit "net" \\ price' }));
    const after = await getBase(owner, base.id);
    const formula = (id: string) => after.properties.find((p) => p.id === id)!.options;
    expect(formula(total.id)).toEqual({
      source: 'prop("Unit \\"net\\" \\\\ price") * prop( "Unit \\"net\\" \\\\ price" ) + prop("Qty") & "Price"',
      resultType: "string",
      dependencies: [price.id, qty.id],
    });
    expect(formula(other.id)).toEqual(other.options);
    // The rewritten formula still computes.
    expect((await getRow(owner, base.id, row.id)).cells[total.id]).toBe("10Price");
    ok(await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { cells: { [price.id]: 2 } }));
    expect((await getRow(owner, base.id, row.id)).cells[total.id]).toBe("5Price");
    // A change of case only is a rename too.
    ok(await update(base.id, qty.id, { name: "QTY" }));
    expect((await getBase(owner, base.id)).properties.find((p) => p.id === other.id)!.options.source).toBe('prop("QTY") + 1');
  });

  test("members receive the base, then rowsChanged when cells were rewritten", async () => {
    const base = await newBase("Announced updates");
    const tag = await addProperty(owner, base.id, "Tag", "select", { choices: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
    await nextBaseEvent(socket, base.id, "base");
    await addRow(owner, base.id, { [tag.id]: "a" });
    await nextBaseEvent(socket, base.id, "rowCreated");
    const current = async () => baseEventOf(await getBase(owner, base.id));
    // A rename: the base only.
    ok(await update(base.id, tag.id, { name: "Label", requestId: "u-1" }));
    expect(await nextBaseEvent(socket, base.id)).toEqual({ ...(await current()), requestId: "u-1" });
    // A choice added: the base only.
    ok(await update(base.id, tag.id, { options: { choices: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }] } }));
    expect(await nextBaseEvent(socket, base.id)).toEqual(await current());
    // A choice removed: the base, then rowsChanged without the requestId.
    ok(await update(base.id, tag.id, { options: { choices: [{ id: "a", name: "A" }] }, requestId: "u-2" }));
    expect(await nextBaseEvent(socket, base.id)).toEqual({ ...(await current()), requestId: "u-2" });
    expect(await nextBaseEvent(socket, base.id)).toEqual(rowsChangedOf(base.id));
    // A change of type: rowsChanged even when no row holds a value.
    const spare = await addProperty(owner, base.id, "Spare", "text");
    await nextBaseEvent(socket, base.id, "base");
    ok(await update(base.id, spare.id, { type: "number" }));
    expect(await nextBaseEvent(socket, base.id)).toEqual(await current());
    expect(await nextBaseEvent(socket, base.id)).toEqual(rowsChangedOf(base.id));
    // An empty update still announces the base; a refused one announces nothing.
    ok(await update(base.id, spare.id, {}));
    expect(await nextBaseEvent(socket, base.id)).toEqual(await current());
    expectInvalid(await update(base.id, spare.id, { name: "Label" }), "A property with this name already exists");
    // Accident: an invalid requestId answers 400 after the update was written, without an event.
    expectInvalid(await update(base.id, spare.id, { name: "Written", requestId: 5 }), "requestId must be a string");
    expect((await getBase(owner, base.id)).properties.find((p) => p.id === spare.id)!.name).toBe("Written");
    ok(await update(base.id, spare.id, { name: "Final", requestId: "u-3" }));
    expect(await nextBaseEvent(socket, base.id)).toEqual({ ...(await current()), requestId: "u-3" });
  });
});

describe("changing the type of a property converts its cells", () => {
  const CHOICES = [
    { id: "a", name: "Alpha", color: "red" },
    { id: "n", name: "42", color: "blue" },
    { id: "y", name: "yes", color: "green" },
    { id: "d", name: "2024-03-05", color: "gray" },
    { id: "u", name: "https://x.io", color: "gray" },
    { id: "e", name: "a@b.co", color: "gray" },
  ];
  const TEXTS = ["hello", "1,234.5", " 42 ", "-0.5e1", "true", "Yes", "no", "0", "checked", "2024-03-05", "March 5, 2024", " https://example.com/a ", "mailto:x@y.z", "tel:+123", "ftp://x", " a@b.co ", "12"];
  /** The cells each type starts with; `$…` stand for ids made in `beforeAll`. */
  const SOURCES: Record<string, { options?: unknown; values: unknown[] }> = {
    text: { values: TEXTS },
    longText: { values: [...TEXTS, "line1\nline2"] },
    number: { values: [0, 1, -2.5, 1e21, 0.30000000000000004, 12] },
    select: { options: { choices: CHOICES }, values: ["a", "n", "y", "d", "u", "e"] },
    status: { options: { choices: CHOICES }, values: ["a", "n", "y", "d", "u", "e"] },
    multiSelect: { options: { choices: CHOICES }, values: [["a"], ["n"], ["y"], ["d"], ["u"], ["e"], ["n", "a"], ["a", "n", "y"]] },
    date: { values: ["2024-03-05", "2024-03-05T10:20:30Z", "March 5, 2024", "12"] },
    // A person reads as the user's name: "Owner", a member named "42", and nobody.
    person: { values: ["$owner", "$member", "nobody"] },
    file: { values: [[{ id: "f1", fileName: "a.txt" }], [{ id: "f1", fileName: "7" }], [{ id: "f1", fileName: "7" }, { id: "f2", fileName: "b.png", url: "/x" }]] },
    // A page reads as its title: "Target", an untitled page, a page titled "99", and no page.
    page: { values: ["$page", "$untitled", "$numbered", "nothing"] },
    checkbox: { values: [true, false] },
    url: { values: ["https://example.com", "abc", "42", "true"] },
    email: { values: ["a@b.co"] },
  };
  /**
   * `MATRIX[from][to]`: what the cells of `SOURCES[from]` become, in order; null is an empty cell.
   * Conversions to a choice type are made with the same six choices as options.
   * Texts are read as dates by JavaScript's Date.parse, which also takes "42", "0" and "tel:+123".
   */
  const MATRIX: Record<string, Record<string, unknown[]>> = {
    text: {
      longText: ["hello", "1,234.5", " 42 ", "-0.5e1", "true", "Yes", "no", "0", "checked", "2024-03-05", "March 5, 2024", " https://example.com/a ", "mailto:x@y.z", "tel:+123", "ftp://x", " a@b.co ", "12"],
      number: [null, 1234.5, 42, -5, null, null, null, 0, null, null, null, null, null, null, null, null, 12],
      select: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      status: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      multiSelect: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      date: [null, null, "42", null, null, null, null, "0", null, "2024-03-05", "March 5, 2024", null, null, "tel:+123", null, null, "12"],
      person: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      file: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      page: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      checkbox: [null, null, null, null, true, true, false, false, true, null, null, null, null, null, null, null, null],
      url: [null, null, null, null, null, null, null, null, null, null, null, "https://example.com/a", "mailto:x@y.z", "tel:+123", null, null, null],
      email: [null, null, null, null, null, null, null, null, null, null, null, null, "mailto:x@y.z", null, null, "a@b.co", null],
    },
    longText: {
      text: ["hello", "1,234.5", " 42 ", "-0.5e1", "true", "Yes", "no", "0", "checked", "2024-03-05", "March 5, 2024", " https://example.com/a ", "mailto:x@y.z", "tel:+123", "ftp://x", " a@b.co ", "12", "line1\nline2"],
      number: [null, 1234.5, 42, -5, null, null, null, 0, null, null, null, null, null, null, null, null, 12, null],
      select: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      status: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      multiSelect: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      date: [null, null, "42", null, null, null, null, "0", null, "2024-03-05", "March 5, 2024", null, null, "tel:+123", null, null, "12", null],
      person: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      file: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      page: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      checkbox: [null, null, null, null, true, true, false, false, true, null, null, null, null, null, null, null, null, null],
      url: [null, null, null, null, null, null, null, null, null, null, null, "https://example.com/a", "mailto:x@y.z", "tel:+123", null, null, null, null],
      email: [null, null, null, null, null, null, null, null, null, null, null, null, "mailto:x@y.z", null, null, "a@b.co", null, null],
    },
    number: {
      text: ["0", "1", "-2.5", "1e+21", "0.3", "12"],
      longText: ["0", "1", "-2.5", "1e+21", "0.3", "12"],
      select: [null, null, null, null, null, null],
      status: [null, null, null, null, null, null],
      multiSelect: [null, null, null, null, null, null],
      date: ["0", "1", "-2.5", null, "0.3", "12"],
      person: [null, null, null, null, null, null],
      file: [null, null, null, null, null, null],
      page: [null, null, null, null, null, null],
      checkbox: [false, true, true, true, true, true],
      url: [null, null, null, null, null, null],
      email: [null, null, null, null, null, null],
    },
    select: {
      text: ["Alpha", "42", "yes", "2024-03-05", "https://x.io", "a@b.co"],
      longText: ["Alpha", "42", "yes", "2024-03-05", "https://x.io", "a@b.co"],
      number: [null, 42, null, null, null, null],
      status: ["a", "n", "y", "d", "u", "e"],
      multiSelect: [["a"], ["n"], ["y"], ["d"], ["u"], ["e"]],
      date: [null, "42", null, "2024-03-05", null, null],
      person: [null, null, null, null, null, null],
      file: [null, null, null, null, null, null],
      page: [null, null, null, null, null, null],
      checkbox: [null, null, true, null, null, null],
      url: [null, null, null, null, "https://x.io", null],
      email: [null, null, null, null, null, "a@b.co"],
    },
    status: {
      text: ["Alpha", "42", "yes", "2024-03-05", "https://x.io", "a@b.co"],
      longText: ["Alpha", "42", "yes", "2024-03-05", "https://x.io", "a@b.co"],
      number: [null, 42, null, null, null, null],
      select: ["a", "n", "y", "d", "u", "e"],
      multiSelect: [["a"], ["n"], ["y"], ["d"], ["u"], ["e"]],
      date: [null, "42", null, "2024-03-05", null, null],
      person: [null, null, null, null, null, null],
      file: [null, null, null, null, null, null],
      page: [null, null, null, null, null, null],
      checkbox: [null, null, true, null, null, null],
      url: [null, null, null, null, "https://x.io", null],
      email: [null, null, null, null, null, "a@b.co"],
    },
    multiSelect: {
      text: ["Alpha", "42", "yes", "2024-03-05", "https://x.io", "a@b.co", "42, Alpha", "Alpha, 42, yes"],
      longText: ["Alpha", "42", "yes", "2024-03-05", "https://x.io", "a@b.co", "42, Alpha", "Alpha, 42, yes"],
      number: [null, 42, null, null, null, null, null, null],
      select: ["a", "n", "y", "d", "u", "e", "n", "a"],
      status: ["a", "n", "y", "d", "u", "e", "n", "a"],
      date: [null, "42", null, "2024-03-05", null, null, null, null],
      person: [null, null, null, null, null, null, null, null],
      file: [null, null, null, null, null, null, null, null],
      page: [null, null, null, null, null, null, null, null],
      checkbox: [null, null, true, null, null, null, null, null],
      url: [null, null, null, null, "https://x.io", null, null, null],
      email: [null, null, null, null, null, "a@b.co", null, null],
    },
    date: {
      text: ["2024-03-05", "2024-03-05T10:20:30Z", "March 5, 2024", "12"],
      longText: ["2024-03-05", "2024-03-05T10:20:30Z", "March 5, 2024", "12"],
      number: [null, null, null, 12],
      select: [null, null, null, null],
      status: [null, null, null, null],
      multiSelect: [null, null, null, null],
      person: [null, null, null, null],
      file: [null, null, null, null],
      page: [null, null, null, null],
      checkbox: [null, null, null, null],
      url: [null, null, null, null],
      email: [null, null, null, null],
    },
    person: {
      text: ["Owner", "42", null],
      longText: ["Owner", "42", null],
      number: [null, 42, null],
      select: [null, null, null],
      status: [null, null, null],
      multiSelect: [null, null, null],
      date: [null, "42", null],
      file: [null, null, null],
      page: [null, null, null],
      checkbox: [null, null, null],
      url: [null, null, null],
      email: [null, null, null],
    },
    file: {
      text: ["a.txt", "7", "7, b.png"],
      longText: ["a.txt", "7", "7, b.png"],
      number: [null, 7, null],
      select: [null, null, null],
      status: [null, null, null],
      multiSelect: [null, null, null],
      date: [null, "7", null],
      person: [null, null, null],
      page: [null, null, null],
      checkbox: [null, null, null],
      url: [null, null, null],
      email: [null, null, null],
    },
    page: {
      text: ["Target", "Untitled", "99", null],
      longText: ["Target", "Untitled", "99", null],
      number: [null, null, 99, null],
      select: [null, null, null, null],
      status: [null, null, null, null],
      multiSelect: [null, null, null, null],
      date: [null, null, "99", null],
      person: [null, null, null, null],
      file: [null, null, null, null],
      checkbox: [null, null, null, null],
      url: [null, null, null, null],
      email: [null, null, null, null],
    },
    checkbox: {
      text: ["true", "false"],
      longText: ["true", "false"],
      number: [1, 0],
      select: [null, null],
      status: [null, null],
      multiSelect: [null, null],
      date: [null, null],
      person: [null, null],
      file: [null, null],
      page: [null, null],
      url: [null, null],
      email: [null, null],
    },
    url: {
      text: ["https://example.com", "abc", "42", "true"],
      longText: ["https://example.com", "abc", "42", "true"],
      number: [null, null, 42, null],
      select: [null, null, null, null],
      status: [null, null, null, null],
      multiSelect: [null, null, null, null],
      date: [null, null, "42", null],
      person: [null, null, null, null],
      file: [null, null, null, null],
      page: [null, null, null, null],
      checkbox: [null, null, null, true],
      email: [null, null, null, null],
    },
    email: {
      text: ["a@b.co"],
      longText: ["a@b.co"],
      number: [null],
      select: [null],
      status: [null],
      multiSelect: [null],
      date: [null],
      person: [null],
      file: [null],
      page: [null],
      checkbox: [null],
      url: [null],
    },
  };
  const symbols: Record<string, string> = {};

  beforeAll(async () => {
    const member = await t.addMember(owner, "forty-two@example.com");
    ok(await member.client.post("/me/update", { name: "42" }));
    symbols.$owner = ownerId;
    symbols.$member = member.user.id;
    symbols.$page = ok(await owner.post("/pages", { spaceId, title: "Target" })).page.id;
    symbols.$untitled = ok(await owner.post("/pages", { spaceId })).page.id;
    symbols.$numbered = ok(await owner.post("/pages", { spaceId, title: "99" })).page.id;
  });

  const types = Object.keys(SOURCES);
  test("the matrix covers every pair of editable types", () => {
    expect(Object.keys(MATRIX)).toEqual(types);
    for (const from of types) {
      expect(Object.keys(MATRIX[from]!).sort()).toEqual(types.filter((type) => type !== from).sort());
      for (const values of Object.values(MATRIX[from]!)) expect(values).toHaveLength(SOURCES[from]!.values.length);
    }
  });

  for (const from of types) {
    test(`from ${from} to every other type`, async () => {
      const base = await newBase(`From ${from}`);
      await emptyBase(owner, base.id);
      const targets = types.filter((type) => type !== from);
      const properties: Record<string, Property> = {};
      for (const to of targets) properties[to] = await addProperty(owner, base.id, `to ${to}`, from, SOURCES[from]!.options);
      const rows = [];
      for (const value of SOURCES[from]!.values) {
        const cell = typeof value === "string" && value in symbols ? symbols[value] : value;
        rows.push(await addRow(owner, base.id, Object.fromEntries(targets.map((to) => [properties[to]!.id, cell]))));
      }
      for (const to of targets) {
        const options = ["select", "status", "multiSelect"].includes(to) ? { choices: CHOICES } : undefined;
        expect(ok(await update(base.id, properties[to]!.id, { type: to, options })).type).toBe(to);
      }
      const after = await allRows(owner, base.id);
      const actual = Object.fromEntries(targets.map((to) => [to, after.map((r) => r.cells[properties[to]!.id] ?? null)]));
      expect<unknown>(actual).toEqual(MATRIX[from]!);
      // Converting is not an edit of the rows.
      expect(after.map((r) => r.updatedAt)).toEqual(rows.map((r) => r.updatedAt));
    });
  }

  test("a choice type converted to another without the same choices loses its cells", async () => {
    const base = await newBase();
    await emptyBase(owner, base.id);
    const options = { choices: CHOICES };
    const toStatus = await addProperty(owner, base.id, "To status", "select", options);
    const toMulti = await addProperty(owner, base.id, "To multi", "select", options);
    const toSelect = await addProperty(owner, base.id, "To select", "multiSelect", options);
    await addRow(owner, base.id, { [toStatus.id]: "a", [toMulti.id]: "n", [toSelect.id]: ["y", "a"] });
    ok(await update(base.id, toStatus.id, { type: "status" }));
    ok(await update(base.id, toMulti.id, { type: "multiSelect", options: { choices: [CHOICES[0]] } }));
    ok(await update(base.id, toSelect.id, { type: "select", options: { choices: [CHOICES[0]] } }));
    const [row] = await allRows(owner, base.id);
    // Of ["y", "a"] only "a" is still a choice, so it is the one kept.
    expect(row!.cells).toEqual({ [toSelect.id]: "a" });
  });

  test("a long text converted to text is cut to 2000 UTF-16 units", async () => {
    const base = await newBase();
    await emptyBase(owner, base.id);
    const long = await addProperty(owner, base.id, "Long", "longText");
    const back = await addProperty(owner, base.id, "Back", "text");
    await addRow(owner, base.id, { [long.id]: "x".repeat(2001), [back.id]: "y".repeat(2001) });
    await addRow(owner, base.id, { [long.id]: `${"x".repeat(1998)}😀z` });
    ok(await update(base.id, long.id, { type: "text" }));
    ok(await update(base.id, back.id, { type: "longText" }));
    expect(await cellsOf(base.id, long.id)).toEqual(["x".repeat(2000), `${"x".repeat(1998)}😀`]);
    expect(await cellsOf(base.id, back.id)).toEqual(["y".repeat(2001), null]);
  });

  test("a long text whose 2000th unit is the first half of an emoji cannot be converted to text", async () => {
    const base = await newBase();
    const long = await addProperty(owner, base.id, "Long", "longText");
    const value = `${"x".repeat(1999)}😀`;
    await addRow(owner, base.id, { [long.id]: value });
    // Accident: the cut leaves half a character, which the database refuses, so the whole update fails.
    expectError(await update(base.id, long.id, { type: "text" }), 500, "internal_error", "Something went wrong");
    expect((await getBase(owner, base.id)).properties[3]).toEqual(long);
    expect(await cellsOf(base.id, long.id)).toEqual([null, value]);
  });

  test("formulas over a converted property are recomputed", async () => {
    const base = await newBase();
    await emptyBase(owner, base.id);
    const raw = await addProperty(owner, base.id, "Raw", "text");
    const length = await addProperty(owner, base.id, "Length", "formula", { source: 'LEN(prop("Raw"))' });
    const row = await addRow(owner, base.id, { [raw.id]: "1,234" });
    expect(row.cells[length.id]).toBe(5);
    ok(await update(base.id, raw.id, { type: "number" }));
    expect((await getRow(owner, base.id, row.id)).cells).toEqual({ [raw.id]: 1234, [length.id]: 4 });
  });
});

describe("POST /bases/:id/properties/:propertyId/delete", () => {
  test("removes the property and its cells, and answers with an empty object", async () => {
    const base = await newBase();
    const [title, text1] = base.properties;
    const row = await addRow(owner, base.id, { [title!.id]: "kept", [text1!.id]: "gone" });
    const res = await remove(base.id, text1!.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: {} });
    expect((await getBase(owner, base.id)).properties).toEqual([base.properties[0]!, base.properties[2]!]);
    // The rows lose the cell without counting as edited.
    expect(await getRow(owner, base.id, row.id)).toEqual({ ...row, cells: { [title!.id]: "kept" } });
    const [stored] = await t.sql`SELECT cells FROM base_rows WHERE id = ${row.id}`;
    expect(stored.cells).toEqual({ [title!.id]: "kept" });
    expectError(await remove(base.id, text1!.id), 404, "not_found", "Property not found");
    // A value sent for it afterwards is ignored like any unknown key.
    expect((await addRow(owner, base.id, { [text1!.id]: "late" })).cells).toEqual({});
  });

  test("the primary property cannot be deleted; unknown properties are not found", async () => {
    const base = await newBase();
    const other = await newBase("Other");
    expectInvalid(await remove(base.id, base.properties[0]!.id), "The primary property cannot be deleted");
    for (const id of ["pzzzzzzzzz", other.properties[1]!.id, "x y"]) expectError(await remove(base.id, encodeURIComponent(id)), 404, "not_found", "Property not found");
    expect((await getBase(owner, base.id)).properties).toEqual(base.properties);
    expect((await getBase(owner, other.id)).properties).toEqual(other.properties);
    // Every other property can go, system and formula ones included.
    for (const type of ["createdAt", "lastEditedBy", "formula"]) {
      const p = await addProperty(owner, base.id, `A ${type}`, type, type === "formula" ? { source: "1" } : undefined);
      expect((await remove(base.id, p.id)).status).toBe(200);
    }
    for (const p of base.properties.slice(1)) expect((await remove(base.id, p.id)).status).toBe(200);
    expect((await getBase(owner, base.id)).properties).toEqual([base.properties[0]!]);
  });

  test("the property disappears from every part of every view's config", async () => {
    const base = await newBase();
    const gone = await addProperty(owner, base.id, "Gone", "number");
    const stays = await addProperty(owner, base.id, "Stays", "number");
    const g = gone.id;
    const s = stays.id;
    const config = {
      sorts: [{ propertyId: g, direction: "asc" }, { propertyId: s, direction: "desc" }],
      filter: {
        op: "and",
        children: [
          { propertyId: g, op: "gt", value: 1 },
          { propertyId: s, op: "lt", value: 9 },
          { op: "or", children: [{ propertyId: g, op: "isEmpty" }] },
          { op: "or", children: [{ propertyId: g, op: "eq", value: 2 }, { op: "and", children: [{ propertyId: s, op: "eq", value: 3 }, { propertyId: g, op: "neq", value: 4 }] }] },
        ],
      },
      hiddenPropertyIds: [g, s],
      visiblePropertyIds: [s, g],
      propertyOrder: [g, s, g],
      propertyWidths: { [g]: 120, [s]: 80 },
      groupByPropertyId: g,
      datePropertyId: g,
      hiddenChoiceIds: [g],
      choiceOrder: [g],
      custom: { propertyId: g },
    };
    const view = await addView(owner, base.id, { name: "Full", type: "kanban", config });
    const untouched = await addView(owner, base.id, { name: "Untouched", config: { groupByPropertyId: s, datePropertyId: s, sorts: [{ propertyId: s, direction: "asc" }] } });
    const stamp = async (id: string) => (await t.sql`SELECT updated_at FROM base_views WHERE id = ${id}`)[0].updated_at.getTime();
    const before = [await stamp(view.id), await stamp(untouched.id)];
    ok(await remove(base.id, g));
    const views = (await getBase(owner, base.id)).views;
    expect(views.find((v) => v.id === view.id)!.config).toEqual({
      sorts: [{ propertyId: s, direction: "desc" }],
      // Groups left without conditions are dropped, except the outermost.
      filter: { op: "and", children: [{ propertyId: s, op: "lt", value: 9 }, { op: "or", children: [{ op: "and", children: [{ propertyId: s, op: "eq", value: 3 }] }] }] },
      hiddenPropertyIds: [s],
      visiblePropertyIds: [s],
      propertyOrder: [s],
      propertyWidths: { [s]: 80 },
      // Lists of choices and keys the server does not know are left alone.
      hiddenChoiceIds: [g],
      choiceOrder: [g],
      custom: { propertyId: g },
    });
    expect(views.find((v) => v.id === untouched.id)).toEqual(untouched);
    expect(views.find((v) => v.id === base.views[0]!.id)).toEqual(base.views[0]!);
    // Only the views that changed were written.
    expect(await stamp(view.id)).toBeGreaterThan(before[0]!);
    expect(await stamp(untouched.id)).toBe(before[1]!);
    // Deleting the last property a filter uses leaves an empty outer group.
    ok(await remove(base.id, s));
    const config2 = (await getBase(owner, base.id)).views.find((v) => v.id === view.id)!.config;
    expect(config2.filter).toEqual({ op: "and", children: [] });
    expect(config2.sorts).toEqual([]);
    expect((await getBase(owner, base.id)).views.find((v) => v.id === untouched.id)!.config).toEqual({ sorts: [] });
  });

  test("an empty group inside a stored filter is dropped whenever any property is deleted", async () => {
    const base = await newBase();
    const spare = await addProperty(owner, base.id, "Spare", "text");
    const view = await addView(owner, base.id, { config: { filter: { op: "and", children: [{ op: "or", children: [] }, { propertyId: base.properties[0]!.id, op: "isEmpty" }] } } });
    ok(await remove(base.id, spare.id));
    expect((await getBase(owner, base.id)).views.find((v) => v.id === view.id)!.config).toEqual({
      filter: { op: "and", children: [{ propertyId: base.properties[0]!.id, op: "isEmpty" }] },
    });
  });

  test("formulas that used the property become errors, in every row", async () => {
    const base = await newBase();
    await emptyBase(owner, base.id);
    const price = await addProperty(owner, base.id, "Price", "number");
    const qty = await addProperty(owner, base.id, "Qty", "number");
    const total = await addProperty(owner, base.id, "Total", "formula", { source: 'prop("Price") * prop("Qty")' });
    const label = await addProperty(owner, base.id, "Label", "formula", { source: 'IF(prop("Total") > 5, "big", "small")' });
    const safe = await addProperty(owner, base.id, "Safe", "formula", { source: 'prop("Price") + 1' });
    const a = await addRow(owner, base.id, { [price.id]: 2.5, [qty.id]: 4 });
    const b = await addRow(owner, base.id, {});
    ok(await remove(base.id, qty.id));
    const missing = { error: "MISSING_PROP", message: "A property this formula uses was deleted" };
    expect((await getRow(owner, base.id, a.id)).cells).toEqual({ [price.id]: 2.5, [total.id]: missing, [label.id]: missing, [safe.id]: 3.5 });
    expect((await getRow(owner, base.id, b.id)).cells).toEqual({ [total.id]: missing, [label.id]: missing, [safe.id]: 1 });
    // The formulas keep their source and their list of dependencies.
    const after = await getBase(owner, base.id);
    expect(after.properties.find((p) => p.id === total.id)).toEqual(total);
    // New rows get the error too.
    expect((await addRow(owner, base.id, { [price.id]: 1 })).cells).toEqual({ [price.id]: 1, [total.id]: missing, [label.id]: missing, [safe.id]: 2 });
    // Deleting a formula makes the formulas over it errors as well.
    ok(await remove(base.id, safe.id));
    const chained = await addProperty(owner, base.id, "Chained", "formula", { source: 'prop("Price") * 2' });
    const top = await addProperty(owner, base.id, "Top", "formula", { source: 'prop("Chained") + 1' });
    expect((await getRow(owner, base.id, a.id)).cells[top.id]).toBe(6);
    ok(await remove(base.id, chained.id));
    expect((await getRow(owner, base.id, a.id)).cells).toEqual({ [price.id]: 2.5, [total.id]: missing, [label.id]: missing, [top.id]: missing });
  });

  test("members receive the base, then rowsChanged", async () => {
    const base = await newBase("Announced deletions");
    const spare = await addProperty(owner, base.id, "Spare", "text");
    await nextBaseEvent(socket, base.id, "base");
    ok(await remove(base.id, spare.id, { requestId: "d-1" }));
    expect(await nextBaseEvent(socket, base.id)).toEqual(baseEventOf(base, "d-1"));
    expect(await nextBaseEvent(socket, base.id)).toEqual(rowsChangedOf(base.id));
    // Refused deletions announce nothing.
    expectInvalid(await remove(base.id, base.properties[0]!.id), "The primary property cannot be deleted");
    expectError(await remove(base.id, spare.id), 404, "not_found", "Property not found");
    // Accident: an invalid requestId answers 400 after the property was deleted, without any event.
    expectInvalid(await remove(base.id, base.properties[2]!.id, { requestId: "" }), "requestId is required");
    ok(await remove(base.id, base.properties[1]!.id));
    expect(await nextBaseEvent(socket, base.id)).toEqual(baseEventOf({ ...base, properties: [base.properties[0]!] }));
    expect(await nextBaseEvent(socket, base.id)).toEqual(rowsChangedOf(base.id));
  });
});
