import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Base } from "common/bases";
import { startServer, type Client, type TestServer } from "./harness";
import { addProperty, addRow, and, createBase, decodeCursor, emptyBase, expectInvalid, ok, queryRows, updateRow } from "./harness/base-fixtures";

/**
 * Sorting of `POST /bases/:id/rows/query`. Rows are labelled in their title;
 * the expectations are the labels in the order the server returns them.
 * Empty cells always come last, ascending or descending, and ties keep the
 * order of the rows (position, then id).
 *
 * Text sorts follow the database's collation, so the texts compared here are
 * ones every collation orders the same way (lower-case words, digits).
 */

let t: TestServer;
let owner: Client;
let ownerId: string;
let spaceId: string;

beforeAll(async () => {
  t = await startServer();
  let user: { id: string };
  ({ owner, user, spaceId } = await t.setupOwner());
  ownerId = user.id;
});

afterAll(async () => {
  await t.close();
});

interface Table {
  base: Base;
  title: string;
  ids: Record<string, string>;
}

/** A base with one row per entry of `rows`, labelled by its key, in that order. */
const table = async (properties: [name: string, type: string, options?: unknown][], rows: Record<string, Record<string, unknown>>): Promise<Table> => {
  const base = await createBase(owner, spaceId, { title: "Sorts" });
  await emptyBase(owner, base.id);
  const title = base.properties[0]!.id;
  const ids: Record<string, string> = {};
  for (const [name, type, options] of properties) ids[name] = (await addProperty(owner, base.id, name, type, options)).id;
  for (const [label, cells] of Object.entries(rows)) {
    await addRow(owner, base.id, { [title]: label, ...Object.fromEntries(Object.entries(cells).map(([name, value]) => [ids[name]!, value])) });
  }
  return { base, title, ids };
};

const sorted = async (tb: Table, sorts: [name: string, direction: string][], extra: Record<string, unknown> = {}) =>
  (await queryRows(owner, tb.base.id, { sorts: sorts.map(([name, direction]) => ({ propertyId: tb.ids[name] ?? name, direction })), ...extra })).items
    .map((r) => r.cells[tb.title])
    .join(" ");

describe("sorting by value", () => {
  test("numbers sort numerically", async () => {
    const tb = await table([["N", "number"]], { a: { N: 3 }, b: { N: 1 }, c: { N: -2.5 }, d: {}, e: { N: 1 }, f: { N: 1e21 }, g: { N: 0.1 }, h: { N: 10 } });
    expect(await sorted(tb, [["N", "asc"]])).toBe("c g b e a h f d");
    expect(await sorted(tb, [["N", "desc"]])).toBe("f h a b e g c d");
  });

  test("texts sort as text, so \"10\" comes before \"9\"", async () => {
    const tb = await table([["T", "text"], ["L", "longText"], ["U", "url"], ["E", "email"]], {
      a: { T: "cherry", L: "b", U: "https://b.example", E: "c@x.io" },
      b: { T: "apple", L: "c", U: "https://a.example", E: "a@x.io" },
      c: {},
      d: { T: "banana", L: "a", U: "https://c.example", E: "b@x.io" },
      e: { T: "apple" },
    });
    expect(await sorted(tb, [["T", "asc"]])).toBe("b e d a c");
    expect(await sorted(tb, [["T", "desc"]])).toBe("a d b e c");
    expect(await sorted(tb, [["L", "asc"]])).toBe("d a b c e");
    expect(await sorted(tb, [["U", "desc"]])).toBe("d a b c e");
    expect(await sorted(tb, [["E", "asc"]])).toBe("b d a c e");
    const digits = await table([["T", "text"]], { a: { T: "9" }, b: { T: "10" }, c: { T: "100" } });
    expect(await sorted(digits, [["T", "asc"]])).toBe("b c a");
    // The title is a text property like any other.
    expect(await sorted({ ...digits, ids: { Title: digits.title } }, [["Title", "desc"]])).toBe("c b a");
  });

  test("checkboxes sort unchecked before checked; a cell never set is empty, not unchecked", async () => {
    const tb = await table([["C", "checkbox"]], { a: { C: true }, b: {}, c: { C: false }, d: { C: true }, e: { C: false } });
    expect(await sorted(tb, [["C", "asc"]])).toBe("c e a d b");
    expect(await sorted(tb, [["C", "desc"]])).toBe("a d c e b");
  });

  test("dates sort by the moment they mean; a date without a time is midnight in the viewer's zone", async () => {
    const tb = await table([["D", "date"]], {
      a: { D: "2026-01-02" },
      b: { D: "2026-01-01T20:00:00Z" },
      c: {},
      d: { D: "2026-01-01T23:30:00+05:00" },
      e: { D: "2025-12-31" },
      // Accepted by the API, but not a date the database can read: sorts as empty.
      f: { D: "2026" },
    });
    expect(await sorted(tb, [["D", "asc"]])).toBe("e d b a c f");
    expect(await sorted(tb, [["D", "desc"]])).toBe("a b d e c f");
    // Ten hours east of UTC, 2 January starts at 14:00 UTC on the 1st: before b, after d.
    expect(await sorted(tb, [["D", "asc"]], { tzOffset: 600 })).toBe("e a d b c f");
    // Ten hours west, it starts at 10:00 UTC on the 2nd.
    expect(await sorted(tb, [["D", "asc"]], { tzOffset: -600 })).toBe("e d b a c f");
    expect(await sorted(tb, [["D", "desc"]], { tzOffset: 600 })).toBe("b d a e c f");
  });

  test("page cells sort by the text they hold, not by the title of the page", async () => {
    const zebra = ok(await owner.post("/pages", { spaceId, title: "Zebra" })).page.id as string;
    const aardvark = ok(await owner.post("/pages", { spaceId, title: "Aardvark" })).page.id as string;
    const [low, high] = [zebra, aardvark].sort();
    const tb = await table([["P", "page"]], { x: { P: high }, y: {}, z: { P: low } });
    expect(await sorted(tb, [["P", "asc"]])).toBe("z x y");
    expect(await sorted(tb, [["P", "desc"]])).toBe("x z y");
  });

  test("lists sort by their JSON text", async () => {
    const tags = { choices: [{ id: "x", name: "Zulu" }, { id: "y", name: "Mike" }, { id: "z", name: "Alpha" }] };
    const tb = await table([["M", "multiSelect", tags], ["PM", "person", { allowMultiple: true }], ["F", "file"]], {
      a: { M: ["y"], PM: ["bbb"], F: [{ id: "f2", fileName: "a.txt" }] },
      b: {},
      c: { M: ["z"], PM: ["aaa"], F: [{ id: "f1", fileName: "z.txt" }] },
      d: { M: ["x"], PM: ["ccc"], F: [{ id: "f3", fileName: "m.txt" }] },
    });
    // By choice id, whatever the names and the order of the choices.
    expect(await sorted(tb, [["M", "asc"]])).toBe("d a c b");
    expect(await sorted(tb, [["M", "desc"]])).toBe("c a d b");
    expect(await sorted(tb, [["PM", "asc"]])).toBe("c a d b");
    // A file object's text starts with its id.
    expect(await sorted(tb, [["F", "asc"]])).toBe("c a d b");
    expect(await sorted(tb, [["F", "desc"]])).toBe("d a c b");
  });
});

describe("sorting choices", () => {
  const choices = [
    { id: "zz", name: "First", color: "red" },
    { id: "aa", name: "Second", color: "blue" },
    { id: "mm", name: "Third", color: "green" },
  ];

  test("select and status sort by the order of the options, not by id or name", async () => {
    const options = { choices, choiceOrder: ["zz", "aa", "mm"] };
    const tb = await table([["S", "select", options], ["ST", "status", options]], { r3: { S: "mm", ST: "mm" }, r1: { S: "zz", ST: "zz" }, none: {}, r2: { S: "aa", ST: "aa" }, again: { S: "zz", ST: "zz" } });
    for (const name of ["S", "ST"]) {
      expect(await sorted(tb, [[name, "asc"]])).toBe("r1 again r2 r3 none");
      expect(await sorted(tb, [[name, "desc"]])).toBe("r3 r2 r1 again none");
    }
  });

  test("choiceOrder decides, with the choices it leaves out after it", async () => {
    const tb = await table([["S", "select", { choices, choiceOrder: ["mm"] }]], { r1: { S: "zz" }, r2: { S: "aa" }, r3: { S: "mm" }, none: {} });
    const stored = ok(await owner.get(`/bases/${tb.base.id}`)).properties.find((p: { id: string }) => p.id === tb.ids.S);
    expect(stored.options.choiceOrder).toEqual(["mm", "zz", "aa"]);
    expect(await sorted(tb, [["S", "asc"]])).toBe("r3 r1 r2 none");
    // Reordering the options reorders the rows.
    ok(await owner.post(`/bases/${tb.base.id}/properties/${tb.ids.S}/update`, { options: { choices, choiceOrder: ["aa", "mm", "zz"] } }));
    expect(await sorted(tb, [["S", "asc"]])).toBe("r2 r3 r1 none");
    expect(await sorted(tb, [["S", "desc"]])).toBe("r1 r3 r2 none");
  });

  test("a stored choiceOrder that names unknown or too few choices is repaired when sorting, and unknown cell values are empty", async () => {
    const tb = await table([["S", "select", { choices }]], { r1: { S: "zz" }, r2: { S: "aa" }, r3: { S: "mm" }, odd: {} });
    // Only a direct write can leave such options and such a cell behind.
    await t.sql`UPDATE base_properties SET options = ${{ choices, choiceOrder: ["gone", "mm"] }}::jsonb WHERE page_id = ${tb.base.id} AND id = ${tb.ids.S!}`;
    await t.sql`UPDATE base_rows SET cells = cells || ${{ [tb.ids.S!]: "gone" }}::jsonb WHERE page_id = ${tb.base.id} AND cells ->> ${tb.title} = 'odd'`;
    expect(await sorted(tb, [["S", "asc"]])).toBe("r3 r1 r2 odd");
    await t.sql`UPDATE base_properties SET options = ${{ choices }}::jsonb WHERE page_id = ${tb.base.id} AND id = ${tb.ids.S!}`;
    expect(await sorted(tb, [["S", "asc"]])).toBe("r1 r2 r3 odd");
    await t.sql`UPDATE base_properties SET options = '{}'::jsonb WHERE page_id = ${tb.base.id} AND id = ${tb.ids.S!}`;
    expect(await sorted(tb, [["S", "asc"]])).toBe("r1 r2 r3 odd");
  });
});

describe("sorting people", () => {
  test("a person column sorts by the user's name, whatever the case; unknown users are empty", async () => {
    // Name the users against the order of their ids, so a sort by id cannot pass.
    const [low, high] = [await t.addMember(owner, "sort-a@example.com"), await t.addMember(owner, "sort-b@example.com")].sort((x, y) => (x.user.id < y.user.id ? -1 : 1));
    ok(await low!.client.post("/me/update", { name: "Zoe" }));
    ok(await high!.client.post("/me/update", { name: "amy" }));
    const tb = await table([["Who", "person"]], {
      zoe: { Who: low!.user.id },
      amy: { Who: high!.user.id },
      nobody: { Who: "not-a-uuid" },
      empty: {},
      owner: { Who: ownerId.toUpperCase() },
      stranger: { Who: "00000000-0000-4000-8000-000000000000" },
      zoe2: { Who: low!.user.id },
    });
    expect(await sorted(tb, [["Who", "asc"]])).toBe("amy owner zoe zoe2 nobody empty stranger");
    expect(await sorted(tb, [["Who", "desc"]])).toBe("zoe zoe2 owner amy nobody empty stranger");
    // A rename moves the rows.
    ok(await high!.client.post("/me/update", { name: "Zz Top" }));
    expect(await sorted(tb, [["Who", "asc"]])).toBe("owner zoe zoe2 amy nobody empty stranger");
  });

  test("last edited by sorts by the name of the last editor, or of the creator when there is none", async () => {
    const bob = await t.addMember(owner, "bob@example.com");
    const cat = await t.addMember(owner, "cat@example.com");
    for (const member of [bob, cat]) ok(await owner.post(`/spaces/${spaceId}/members/add`, { role: "writer", userIds: [member.user.id] }));
    const tb = await table([["By", "lastEditedBy"], ["T", "text"]], { one: {}, two: {}, three: {}, four: {} });
    const rows = (await queryRows(owner, tb.base.id)).items;
    // one: edited by cat. two: edited by bob. three: created by Owner, never edited. four: nobody left.
    await updateRow(cat.client, tb.base.id, rows[0]!.id, { [tb.ids.T!]: "x" });
    await updateRow(bob.client, tb.base.id, rows[1]!.id, { [tb.ids.T!]: "x" });
    await t.sql`UPDATE base_rows SET creator_id = NULL, last_editor_id = NULL WHERE id = ${rows[3]!.id}`;
    expect(await sorted(tb, [["By", "asc"]])).toBe("two one three four");
    expect(await sorted(tb, [["By", "desc"]])).toBe("three one two four");
    await t.sql`UPDATE base_rows SET last_editor_id = NULL, creator_id = ${bob.user.id} WHERE id = ${rows[2]!.id}`;
    expect(await sorted(tb, [["By", "asc"]])).toBe("two three one four");
  });
});

describe("sorting by system and formula columns", () => {
  test("created time and last edited time sort by the row's timestamps", async () => {
    const tb = await table([["CA", "createdAt"], ["EA", "lastEditedAt"]], { a: {}, b: {}, c: {} });
    const rows = (await queryRows(owner, tb.base.id)).items;
    await t.sql`UPDATE base_rows SET created_at = '2026-03-01T00:00:00Z', updated_at = '2026-03-05T00:00:00Z' WHERE id = ${rows[0]!.id}`;
    await t.sql`UPDATE base_rows SET created_at = '2026-01-01T00:00:00Z', updated_at = '2026-03-09T00:00:00Z' WHERE id = ${rows[1]!.id}`;
    await t.sql`UPDATE base_rows SET created_at = '2026-02-01T00:00:00Z', updated_at = '2026-02-02T00:00:00Z' WHERE id = ${rows[2]!.id}`;
    expect(await sorted(tb, [["CA", "asc"]])).toBe("b c a");
    expect(await sorted(tb, [["CA", "desc"]])).toBe("a c b");
    expect(await sorted(tb, [["EA", "asc"]])).toBe("c a b");
    expect(await sorted(tb, [["EA", "desc"]])).toBe("b a c");
  });

  test("a formula sorts by the kind of its result; errors and empty results come last", async () => {
    const tb = await table(
      [
        ["N", "number"],
        ["T", "text"],
        ["D", "date"],
        ["Num", "formula", { source: 'IF(ISBLANK(prop("N")), blank, 100 / prop("N"))' }],
        ["Text", "formula", { source: 'IF(ISBLANK(prop("T")), blank, LOWER(prop("T")))' }],
        ["Flag", "formula", { source: 'IF(ISBLANK(prop("N")), blank, prop("N") > 2)' }],
        ["Date", "formula", { source: 'DATEADD(prop("D"), 1, "day")' }],
      ],
      {
        a: { N: 4, T: "Cherry", D: "2026-01-02" },
        b: { N: 0, T: "APPLE", D: "2026-01-01T20:00:00Z" },
        c: {},
        d: { N: 50, T: "banana", D: "2025-06-01" },
        e: { N: 1, T: "apple", D: "2026-01-01T23:00:00Z" },
      },
    );
    // 100 / N: a 25, b an error, c empty, d 2, e 100.
    expect(await sorted(tb, [["Num", "asc"]])).toBe("d a e b c");
    expect(await sorted(tb, [["Num", "desc"]])).toBe("e a d b c");
    expect(await sorted(tb, [["Text", "asc"]])).toBe("b e d a c");
    // N > 2: a true, b false, d true, e false.
    expect(await sorted(tb, [["Flag", "asc"]])).toBe("b e a d c");
    expect(await sorted(tb, [["Flag", "desc"]])).toBe("a d b e c");
    // One day later: a 2026-01-03, b 2026-01-02T20:00Z, d 2025-06-02, e 2026-01-02T23:00Z; c is an error.
    expect(await sorted(tb, [["Date", "asc"]])).toBe("d b e a c");
    expect(await sorted(tb, [["Date", "asc"]], { tzOffset: 600 })).toBe("d a b e c");
  });
});

describe("several sorts, ties and paging", () => {
  let tb: Table;
  beforeAll(async () => {
    tb = await table([["G", "text"], ["N", "number"], ["C", "checkbox"]], {
      a: { G: "x", N: 2, C: true },
      b: { G: "y", N: 1 },
      c: { G: "x", N: 3, C: false },
      d: { N: 2, C: true },
      e: { G: "y", N: 2, C: false },
      f: { G: "x", N: 2 },
    });
  });

  test("later sorts break the ties of earlier ones", async () => {
    expect(await sorted(tb, [["G", "asc"], ["N", "desc"]])).toBe("c a f e b d");
    expect(await sorted(tb, [["G", "desc"], ["N", "asc"]])).toBe("b e a f c d");
    expect(await sorted(tb, [["N", "asc"], ["G", "desc"], ["C", "asc"]])).toBe("b e a f d c");
    expect(await sorted(tb, [["C", "desc"], ["N", "desc"], ["G", "asc"]])).toBe("a d c e f b");
  });

  test("a property named twice sorts by its first mention only", async () => {
    expect(await sorted(tb, [["N", "asc"], ["N", "desc"]])).toBe(await sorted(tb, [["N", "asc"]]));
    expect(await sorted(tb, [["N", "desc"], ["G", "asc"], ["N", "asc"]])).toBe("c a f e d b");
    // Ten sorts are the most, repeats included.
    expect(await sorted(tb, Array(10).fill(["N", "desc"]))).toBe("c a d e f b");
  });

  test("rows that tie on every sort keep their order: position first, then id", async () => {
    expect(await sorted(tb, [["N", "asc"]])).toBe("b a d e f c");
    expect(await sorted(tb, [["N", "desc"]])).toBe("c a d e f b");
    const twins = await table([["N", "number"]], {});
    const made = [];
    for (let i = 0; i < 4; i++) made.push(await addRow(owner, twins.base.id, { [twins.ids.N!]: 7 }, { position: "a0" }));
    const first = await addRow(owner, twins.base.id, { [twins.ids.N!]: 7 }, { position: "Zz" });
    const order = (await queryRows(owner, twins.base.id, { sorts: [{ propertyId: twins.ids.N, direction: "desc" }] })).items.map((r) => r.id);
    expect(order).toEqual([first.id, ...made.map((r) => r.id).sort()]);
  });

  test("an empty list of sorts, or null, is no sort: the rows come in their own order with a position cursor", async () => {
    for (const sorts of [[], null, undefined]) {
      const page = await queryRows(owner, tb.base.id, { sorts, limit: 2 });
      expect(page.items.map((r) => r.cells[tb.title])).toEqual(["a", "b"]);
      expect(decodeCursor(page.nextCursor!)).toEqual({ p: "a1", i: page.items[1]!.id });
    }
    const page = await queryRows(owner, tb.base.id, { sorts: [{ propertyId: tb.ids.N, direction: "asc" }], limit: 2 });
    expect(decodeCursor(page.nextCursor!)).toEqual({ o: 2 });
  });

  test("sorting applies to the filtered rows", async () => {
    const filter = and({ propertyId: tb.ids.G, op: "eq", value: "x" });
    expect(await sorted(tb, [["N", "desc"]], { filter })).toBe("c a f");
    expect(await sorted(tb, [["N", "desc"]], { filter, limit: 2 })).toBe("c a");
  });
});

describe("invalid sorts", () => {
  let tb: Table;
  beforeAll(async () => {
    tb = await table([["N", "number"]], { a: { N: 1 } });
  });
  const query = (body: Record<string, unknown>) => owner.post(`/bases/${tb.base.id}/rows/query`, body);

  test("sorts must be a list of at most 10 { propertyId, direction } with direction asc or desc", async () => {
    const p = () => tb.ids.N!;
    const invalid: unknown[] = [
      "x",
      5,
      true,
      {},
      { propertyId: p(), direction: "asc" },
      [null],
      ["x"],
      [5],
      [{}],
      [{ propertyId: p() }],
      [{ direction: "asc" }],
      [{ propertyId: 5, direction: "asc" }],
      [{ propertyId: null, direction: "asc" }],
      [{ propertyId: p(), direction: "ASC" }],
      [{ propertyId: p(), direction: "up" }],
      [{ propertyId: p(), direction: 1 }],
      [{ propertyId: p(), direction: null }],
      [{ propertyId: p(), direction: "asc" }, { propertyId: p(), direction: "" }],
      Array(11).fill({ propertyId: p(), direction: "asc" }),
    ];
    for (const sorts of invalid) {
      const res = await query({ sorts });
      expect([JSON.stringify(sorts).slice(0, 80), res.status, res.body.error?.message]).toEqual([JSON.stringify(sorts).slice(0, 80), 400, "Invalid sorts"]);
    }
    // Other keys of a sort are ignored.
    expect((await query({ sorts: [{ propertyId: p(), direction: "asc", nulls: "first", extra: 1 }] })).status).toBe(200);
  });

  test("a sort on a property the base does not have is refused", async () => {
    expectInvalid(await query({ sorts: [{ propertyId: "pnope", direction: "asc" }] }), "Sort references unknown property pnope");
    expectInvalid(await query({ sorts: [{ propertyId: "", direction: "desc" }] }), "Sort references unknown property ");
    expectInvalid(await query({ sorts: [{ propertyId: tb.ids.N, direction: "asc" }, { propertyId: "second", direction: "asc" }] }), "Sort references unknown property second");
    expectInvalid(await query({ sorts: [{ propertyId: "first", direction: "asc" }, { propertyId: "second", direction: "asc" }] }), "Sort references unknown property first");
    // The shapes of the filter and of the sorts are checked first, then the filter's properties, then the sorts'.
    expectInvalid(await query({ filter: "x", sorts: "x" }), "Invalid filter");
    expectInvalid(await query({ filter: and({ propertyId: "pnope", op: "eq" }), sorts: "x" }), "Invalid sorts");
    expectInvalid(await query({ filter: and({ propertyId: "pnope", op: "eq" }), sorts: [{ propertyId: "pnope", direction: "asc" }] }), "Filter references unknown property pnope");
    // The sorts are checked before the limit and the cursor are.
    expectInvalid(await query({ sorts: "x", limit: 0 }), "Invalid sorts");
    expectInvalid(await query({ sorts: [{ propertyId: "pnope", direction: "asc" }], limit: 0 }), "limit must be an integer between 1 and 500");
  });
});
