import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Client, type TestServer } from "./harness";
import { addProperty, addRow, and, createBase, emptyBase, expectError, expectInvalid, ok, or, queryRows } from "./harness/base-fixtures";

/**
 * Filters of `POST /bases/:id/rows/query`, per column kind (text, number,
 * time, flag, list) and operator. The tables read
 * `[property, operator, value, the labels of the rows that match]`, with
 * `NONE` for a condition without a value and an optional fifth item for the
 * `tzOffset` of the request.
 *
 * Text comparisons (`gt`, `lt`…) follow the database's collation; the cases
 * here are chosen so that every collation agrees on them.
 */

let t: TestServer;
let owner: Client;
let spaceId: string;
let ids: Record<string, string>;
let main: Fixture;
let odd: Fixture;

const CHOICES = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];
const TAGS = [
  { id: "x", name: "Ex" },
  { id: "y", name: "Why" },
  { id: "z", name: "Zed" },
];

interface Fixture {
  baseId: string;
  /** Property ids by the short names used in the tables. */
  props: Record<string, string>;
}

/**
 * The rows the filter tables run on, labelled `a` to `h` in the title:
 *
 *   row  T              N      C      D                            S/ST  M      P1   PM        F            formulas (FN, FS, FB, FD)
 *   a    apple          3      true   2026-01-10                   a     x      u1   u1        a.txt        2, "APPLE", true, 2026-01-11
 *   b    banana         1      false  2026-02-10T12:00:00Z         b     x,y    u2   u2,u1     a.txt,b.png  6, "BANANA", true, 2026-02-11T12:00:00.000Z
 *   c    cherry 100%    -2.5          2026-02-10                         z                                  -2.4, error, false, 2026-02-11
 *   d    apple_pie      0      true   2026-02-10T23:30:00-05:00          y,z                                error, "APPLE_PIE", error, 2026-02-12T04:30:00.000Z
 *   e    x\y            3             March 5, 2026                                                         2, "X\Y", true, 2026-03-06T00:00:00.000Z
 *   f    (nothing)                                                                                          empty, "", empty, error
 *   g    3              1e21          2026                                                                  6e-21, "3", false, 2026-01-02T00:00:00.000Z
 *   h    true           0.1           2026-02-30                                                            60, "TRUE", true, 2026-03-03
 *
 * The dates of g and h are accepted by the API but cannot be read by the database, so they filter as empty;
 * formulas read them the way JavaScript does (1 January 2026, and 30 February rolled over to 2 March).
 */
const buildMain = async (owner: Client, spaceId: string, ids: Record<string, string>): Promise<Fixture> => {
  const base = await createBase(owner, spaceId, { title: "Filters" });
  await emptyBase(owner, base.id);
  const p: Record<string, string> = { title: base.properties[0]!.id };
  const add = async (key: string, type: string, options?: unknown) => {
    p[key] = (await addProperty(owner, base.id, key, type, options)).id;
  };
  await add("T", "text");
  await add("L", "longText");
  await add("N", "number");
  await add("C", "checkbox");
  await add("D", "date");
  await add("S", "select", { choices: CHOICES });
  await add("ST", "status", { choices: CHOICES });
  await add("M", "multiSelect", { choices: TAGS });
  await add("P1", "person");
  await add("PM", "person", { allowMultiple: true });
  await add("F", "file");
  await add("PG", "page");
  await add("U", "url");
  await add("E", "email");
  await add("FN", "formula", { source: 'IF(ISBLANK(prop("N")), blank, 6 / prop("N"))' });
  await add("FS", "formula", { source: 'IF(prop("N") < 0, ERROR("neg"), UPPER(prop("T")))' });
  await add("FB", "formula", { source: 'IF(ISBLANK(prop("N")), blank, 6 / prop("N") > 1)' });
  await add("FD", "formula", { source: 'DATEADD(prop("D"), 1, "days")' });
  await add("FX", "formula", { source: 'prop("S")' });
  const rows: Record<string, Record<string, unknown>> = {
    a: { T: "apple", L: "first line\nsecond line", N: 3, C: true, D: "2026-01-10", S: "a", ST: "a", M: ["x"], P1: ids.u1, PM: [ids.u1], F: [{ id: "f1", fileName: "a.txt" }], PG: ids.pg1, U: "https://a.example", E: "a@x.io" },
    b: { T: "banana", L: "only", N: 1, C: false, D: "2026-02-10T12:00:00Z", S: "b", ST: "b", M: ["x", "y"], P1: ids.u2, PM: [ids.u2, ids.u1], F: [{ id: "f1", fileName: "a.txt" }, { id: "f2", fileName: "b.png" }], PG: ids.pg2, U: "https://b.example/path", E: "b@y.io" },
    c: { T: "cherry 100%", N: -2.5, D: "2026-02-10", M: ["z"] },
    d: { T: "apple_pie", N: 0, C: true, D: "2026-02-10T23:30:00-05:00", M: ["y", "z"] },
    e: { T: "x\\y", N: 3, D: "March 5, 2026" },
    f: {},
    g: { T: "3", N: 1e21, D: "2026" },
    h: { T: "true", N: 0.1, D: "2026-02-30" },
  };
  for (const [label, cells] of Object.entries(rows)) {
    await addRow(owner, base.id, { [p.title!]: label, ...Object.fromEntries(Object.entries(cells).map(([key, value]) => [p[key]!, value])) });
  }
  return { baseId: base.id, props: p };
};

/**
 * Rows whose cells hold JSON of another type than their property stores, which only a direct write can arrange:
 *
 *   row  T            N        C          D               M
 *   r1   12           "12"     "yes"      5               "x"
 *   r2   true         " 3.5 "  "no"       true            5
 *   r3   ["a","b"]    "abc"    "maybe"    ["2026-01-10"]  {}
 *   r4   {"k":1}      "1e2"    1          " 2026-01-10 "  []
 *   r5   ""           true     0          ""              ["x",5]
 *   r6   null         null     null       null            null
 *   r7   (nothing)    ".5"     " TRUE "   (nothing)       (nothing)
 */
const buildOdd = async (owner: Client, spaceId: string, sql: TestServer["sql"]): Promise<Fixture> => {
  const base = await createBase(owner, spaceId, { title: "Odd cells" });
  await emptyBase(owner, base.id);
  const p: Record<string, string> = { title: base.properties[0]!.id };
  for (const [key, type] of [["T", "text"], ["N", "number"], ["C", "checkbox"], ["D", "date"], ["M", "multiSelect"]] as const) {
    p[key] = (await addProperty(owner, base.id, key, type, type === "multiSelect" ? { choices: TAGS } : undefined)).id;
  }
  const rows: Record<string, Record<string, unknown>> = {
    r1: { T: 12, N: "12", C: "yes", D: 5, M: "x" },
    r2: { T: true, N: " 3.5 ", C: "no", D: true, M: 5 },
    r3: { T: ["a", "b"], N: "abc", C: "maybe", D: ["2026-01-10"], M: {} },
    r4: { T: { k: 1 }, N: "1e2", C: 1, D: " 2026-01-10 ", M: [] },
    r5: { T: "", N: true, C: 0, D: "", M: ["x", 5] },
    r6: { T: null, N: null, C: null, D: null, M: null },
    r7: { N: ".5", C: " TRUE " },
  };
  for (const [label, cells] of Object.entries(rows)) {
    const row = await addRow(owner, base.id, { [p.title!]: label });
    const stored = { [p.title!]: label, ...Object.fromEntries(Object.entries(cells).map(([key, value]) => [p[key]!, value])) };
    await sql`UPDATE base_rows SET cells = ${stored}::jsonb WHERE id = ${row.id}`;
  }
  return { baseId: base.id, props: p };
};

beforeAll(async () => {
  t = await startServer();
  let user: { id: string };
  ({ owner, user, spaceId } = await t.setupOwner());
  const member = await t.addMember(owner, "second@example.com");
  ids = {
    u1: user.id,
    u2: member.user.id,
    pg1: ok(await owner.post("/pages", { spaceId, title: "One" })).page.id,
    pg2: ok(await owner.post("/pages", { spaceId, title: "Two" })).page.id,
  };
  main = await buildMain(owner, spaceId, ids);
  odd = await buildOdd(owner, spaceId, t.sql);
});

afterAll(async () => {
  await t.close();
});

const NONE = Symbol("no value");
type Case = [property: string, op: string, value: unknown, matches: string, tzOffset?: number];

/** `$u1`, `$u2`, `$pg1` and `$pg2` in a table stand for the ids of the two users and the two pages. */
const real = (value: unknown): unknown => (Array.isArray(value) ? value.map(real) : typeof value === "string" && value.startsWith("$") ? ids[value.slice(1)] : value);

const labels = async (fixture: Fixture, filter: unknown, extra: Record<string, unknown> = {}) =>
  (await queryRows(owner, fixture.baseId, { filter, ...extra })).items.map((r) => r.cells[fixture.props.title!]).join("");

const run = async (fixture: Fixture, cases: Case[]) => {
  const actual: unknown[] = [];
  for (const [property, op, value, , tzOffset] of cases) {
    const condition: Record<string, unknown> = { propertyId: fixture.props[property], op };
    if (value !== NONE) condition.value = real(value);
    const res = await owner.post(`/bases/${fixture.baseId}/rows/query`, { filter: and(condition), ...(tzOffset === undefined ? {} : { tzOffset }) });
    const found = res.status === 200 ? res.body.data.items.map((r: any) => r.cells[fixture.props.title!]).join("") : `${res.status} ${res.body.error?.message}`;
    actual.push([property, op, value === NONE ? "(none)" : JSON.stringify(value), found, tzOffset ?? 0]);
  }
  expect(actual).toEqual(cases.map(([property, op, value, matches, tzOffset]) => [property, op, value === NONE ? "(none)" : JSON.stringify(value), matches, tzOffset ?? 0]));
};

describe("text columns: text, longText, select, status, single person, page, url, email, text formulas", () => {
  test("every operator, with matching and odd values", () =>
    run(main, [
      ["T", "eq", "apple", "a"],
      ["T", "eq", "Apple", ""],
      ["T", "eq", " apple", ""],
      ["T", "eq", "", ""],
      ["T", "eq", null, ""],
      ["T", "eq", NONE, ""],
      ["T", "eq", 3, "g"],
      ["T", "eq", true, "h"],
      ["T", "eq", ["apple"], ""],
      ["T", "eq", {"a":1}, ""],
      ["T", "neq", "apple", "bcdefgh"],
      ["T", "neq", "", "abcdefgh"],
      ["T", "neq", null, "abcdefgh"],
      ["T", "neq", 3, "abcdefh"],
      ["T", "neq", NONE, "abcdefgh"],
      ["T", "contains", "AN", "b"],
      ["T", "contains", "pp", "ad"],
      ["T", "contains", "100%", "c"],
      ["T", "contains", "%", "c"],
      ["T", "contains", "_", "d"],
      ["T", "contains", "\\", "e"],
      ["T", "contains", "", "abcdegh"],
      ["T", "contains", null, "abcdegh"],
      ["T", "contains", 3, "g"],
      ["T", "contains", NONE, "abcdegh"],
      ["T", "ncontains", "an", "acdefgh"],
      ["T", "ncontains", "%", "abdefgh"],
      ["T", "ncontains", "_", "abcefgh"],
      ["T", "ncontains", "", "f"],
      ["T", "ncontains", null, "f"],
      ["T", "startsWith", "APP", "ad"],
      ["T", "startsWith", "apple_", "d"],
      ["T", "startsWith", "%", ""],
      ["T", "startsWith", "", "abcdegh"],
      ["T", "startsWith", "pple", ""],
      ["T", "endsWith", "PIE", "d"],
      ["T", "endsWith", "%", "c"],
      ["T", "endsWith", "y", "e"],
      ["T", "endsWith", "", "abcdegh"],
      ["T", "endsWith", "appl", ""],
      ["T", "gt", "b", "bceh"],
      ["T", "gte", "b", "bceh"],
      ["T", "gt", "banana", "ceh"],
      ["T", "gte", "banana", "bceh"],
      ["T", "lt", "b", "adg"],
      ["T", "lte", "b", "adg"],
      ["T", "lt", "banana", "adg"],
      ["T", "lte", "banana", "abdg"],
      ["T", "gt", "", "abcdegh"],
      ["T", "lt", "", ""],
      ["T", "gte", null, "abcdegh"],
      ["T", "gt", 2, "abcdegh"],
      ["T", "any", ["apple","banana"], "ab"],
      ["T", "any", "apple", "a"],
      ["T", "any", [], ""],
      ["T", "any", "", ""],
      ["T", "any", null, ""],
      ["T", "any", NONE, ""],
      ["T", "any", [3,true], "gh"],
      ["T", "any", ["nope"], ""],
      ["T", "any", 3, "g"],
      ["T", "none", ["apple","banana"], "cdefgh"],
      ["T", "none", "apple", "bcdefgh"],
      ["T", "none", [], "abcdefgh"],
      ["T", "none", null, "abcdefgh"],
      ["T", "none", ["nope"], "abcdefgh"],
      ["T", "none", "", "abcdefgh"],
      ["T", "all", ["apple"], "a"],
      ["T", "all", "apple", "a"],
      ["T", "all", ["apple","banana"], ""],
      ["T", "all", ["apple","apple"], ""],
      ["T", "all", [], "abcdefgh"],
      ["T", "all", null, "abcdefgh"],
      ["T", "all", "", "abcdefgh"],
      ["T", "isEmpty", NONE, "f"],
      ["T", "isEmpty", "x", "f"],
      ["T", "isNotEmpty", NONE, "abcdegh"],
      ["T", "isNotEmpty", false, "abcdegh"],
      ["L", "contains", "SECOND", "a"],
      ["L", "eq", "only", "b"],
      ["L", "isEmpty", NONE, "cdefgh"],
      ["L", "startsWith", "first line\n", "a"],
      ["S", "eq", "a", "a"],
      ["S", "neq", "a", "bcdefgh"],
      ["S", "any", ["a","b"], "ab"],
      ["S", "none", ["a"], "bcdefgh"],
      ["S", "all", ["b"], "b"],
      ["S", "isEmpty", NONE, "cdefgh"],
      ["S", "isNotEmpty", NONE, "ab"],
      ["S", "contains", "A", "a"],
      ["S", "eq", "Alpha", ""],
      ["S", "eq", ["a"], ""],
      ["ST", "eq", "b", "b"],
      ["ST", "any", "b", "b"],
      ["ST", "isNotEmpty", NONE, "ab"],
      ["P1", "eq", "$u1", "a"],
      ["P1", "neq", "$u1", "bcdefgh"],
      ["P1", "any", ["$u1","$u2"], "ab"],
      ["P1", "none", ["$u2"], "acdefgh"],
      ["P1", "isEmpty", NONE, "cdefgh"],
      ["P1", "contains", "-", "ab"],
      ["PG", "eq", "$pg1", "a"],
      ["PG", "any", ["$pg2"], "b"],
      ["PG", "isNotEmpty", NONE, "ab"],
      ["U", "contains", "EXAMPLE/", "b"],
      ["U", "startsWith", "https://a", "a"],
      ["U", "isEmpty", NONE, "cdefgh"],
      ["E", "endsWith", ".IO", "ab"],
      ["E", "eq", "a@x.io", "a"],
      ["E", "eq", "A@X.IO", ""],
      ["FS", "eq", "APPLE", "a"],
      ["FS", "contains", "neg", "c"],
      ["FS", "contains", "error", "c"],
      ["FS", "isEmpty", NONE, "f"],
      ["FS", "isNotEmpty", NONE, "abcdegh"],
      ["FS", "startsWith", "{", "c"],
      ["FX", "isEmpty", NONE, "abcdefgh"],
      ["FX", "eq", "a", ""],
      ["FX", "neq", "a", "abcdefgh"],
    ]));
});

describe("number columns: number and number formulas", () => {
  // Accident: the value is read with JavaScript's Number(), so true is 1, false and [] are 0, [3] is 3 and "0x3" is 3.
  // A value that is not a finite number matches nothing, except with neq, where it matches every row.
  test("every operator, with matching and odd values", () =>
    run(main, [
      ["N", "eq", 3, "ae"],
      ["N", "eq", "3", "ae"],
      ["N", "eq", " 3 ", "ae"],
      ["N", "eq", "3.0", "ae"],
      ["N", "eq", "+3", "ae"],
      ["N", "eq", 0, "d"],
      ["N", "eq", -2.5, "c"],
      ["N", "eq", "abc", ""],
      ["N", "eq", "", ""],
      ["N", "eq", null, ""],
      ["N", "eq", NONE, ""],
      ["N", "eq", true, "b"],
      ["N", "eq", false, "d"],
      ["N", "eq", [3], "ae"],
      ["N", "eq", [], "d"],
      ["N", "eq", [1,2], ""],
      ["N", "eq", {}, ""],
      ["N", "eq", "0x3", "ae"],
      ["N", "eq", 1e+21, "g"],
      ["N", "eq", "1e21", "g"],
      ["N", "eq", 0.1, "h"],
      ["N", "eq", "Infinity", ""],
      ["N", "eq", "3,0", ""],
      ["N", "neq", 3, "bcdfgh"],
      ["N", "neq", "abc", "abcdefgh"],
      ["N", "neq", null, "abcdefgh"],
      ["N", "neq", NONE, "abcdefgh"],
      ["N", "neq", 0, "abcefgh"],
      ["N", "neq", "", "abcdefgh"],
      ["N", "gt", 1, "aeg"],
      ["N", "gte", 1, "abeg"],
      ["N", "lt", 0, "c"],
      ["N", "lte", 0, "cd"],
      ["N", "gt", "0.05", "abegh"],
      ["N", "lt", "abc", ""],
      ["N", "gte", null, ""],
      ["N", "lte", 1e+21, "abcdegh"],
      ["N", "lt", 1e+21, "abcdeh"],
      ["N", "gt", -2.5, "abdegh"],
      ["N", "gte", -2.5, "abcdegh"],
      ["N", "gt", "abc", ""],
      ["N", "isEmpty", NONE, "f"],
      ["N", "isNotEmpty", NONE, "abcdegh"],
      ["N", "isEmpty", 3, "f"],
      ["FN", "eq", 2, "ae"],
      ["FN", "neq", 2, "bcdfgh"],
      ["FN", "gt", 2, "bh"],
      ["FN", "lt", 0, "c"],
      ["FN", "gte", "60", "h"],
      ["FN", "isEmpty", NONE, "df"],
      ["FN", "isNotEmpty", NONE, "abcegh"],
      ["FN", "lt", 1e-20, "cg"],
    ]));
});

describe("flag columns: checkbox and true/false formulas", () => {
  // The value is true when it is `true` or one of the words true, 1, yes, on; anything else, the number 1 included, is false.
  // An empty cell counts as false for eq and neq, and only isEmpty tells it apart.
  test("every operator, with matching and odd values", () =>
    run(main, [
      ["C", "eq", true, "ad"],
      ["C", "eq", false, "bcefgh"],
      ["C", "eq", "true", "ad"],
      ["C", "eq", "TRUE", "ad"],
      ["C", "eq", " yes ", "ad"],
      ["C", "eq", "1", "ad"],
      ["C", "eq", "on", "ad"],
      ["C", "eq", "false", "bcefgh"],
      ["C", "eq", "0", "bcefgh"],
      ["C", "eq", "no", "bcefgh"],
      ["C", "eq", "", "bcefgh"],
      ["C", "eq", null, "bcefgh"],
      ["C", "eq", NONE, "bcefgh"],
      ["C", "eq", 1, "bcefgh"],
      ["C", "eq", 0, "bcefgh"],
      ["C", "eq", "x", "bcefgh"],
      ["C", "eq", [true], "bcefgh"],
      ["C", "eq", "y", "bcefgh"],
      ["C", "neq", true, "bcefgh"],
      ["C", "neq", false, "ad"],
      ["C", "neq", "yes", "bcefgh"],
      ["C", "neq", null, "ad"],
      ["C", "neq", 1, "ad"],
      ["C", "neq", NONE, "ad"],
      ["C", "isEmpty", NONE, "cefgh"],
      ["C", "isNotEmpty", NONE, "abd"],
      ["FB", "eq", true, "abeh"],
      ["FB", "eq", false, "cdfg"],
      ["FB", "neq", true, "cdfg"],
      ["FB", "neq", false, "abeh"],
      ["FB", "isEmpty", NONE, "df"],
      ["FB", "isNotEmpty", NONE, "abcegh"],
    ]));
});

describe("list columns: multiSelect, person with allowMultiple, file", () => {
  // eq and neq look at the first item of the value only; contains searches the JSON text of the cell,
  // so it finds ids and file names but not choice names; file cells hold objects, which eq, any and all never match.
  test("every operator, with matching and odd values", () =>
    run(main, [
      ["M", "eq", "x", "ab"],
      ["M", "eq", ["y","x"], "bd"],
      ["M", "eq", [], ""],
      ["M", "eq", "", ""],
      ["M", "eq", null, ""],
      ["M", "eq", NONE, ""],
      ["M", "eq", "zzz", ""],
      ["M", "eq", 5, ""],
      ["M", "eq", "X", ""],
      ["M", "neq", "x", "cdefgh"],
      ["M", "neq", [], "abcdefgh"],
      ["M", "neq", null, "abcdefgh"],
      ["M", "neq", ["y","x"], "acefgh"],
      ["M", "neq", "zzz", "abcdefgh"],
      ["M", "any", ["x","z"], "abcd"],
      ["M", "any", "y", "bd"],
      ["M", "any", [], ""],
      ["M", "any", null, ""],
      ["M", "any", ["zzz"], ""],
      ["M", "any", NONE, ""],
      ["M", "none", ["x","z"], "efgh"],
      ["M", "none", "y", "acefgh"],
      ["M", "none", [], "abcdefgh"],
      ["M", "none", null, "abcdefgh"],
      ["M", "none", ["zzz"], "abcdefgh"],
      ["M", "all", ["x","y"], "b"],
      ["M", "all", "y", "bd"],
      ["M", "all", ["y","z","x"], ""],
      ["M", "all", [], "abcdefgh"],
      ["M", "all", null, "abcdefgh"],
      ["M", "all", ["y","y"], "bd"],
      ["M", "contains", "x", "ab"],
      ["M", "contains", "X", "ab"],
      ["M", "contains", "Ex", ""],
      ["M", "contains", "\"", "abcd"],
      ["M", "contains", "[", "abcd"],
      ["M", "contains", "y\", \"z", "d"],
      ["M", "contains", "", ""],
      ["M", "contains", null, ""],
      ["M", "contains", ["x"], "a"],
      ["M", "contains", 5, ""],
      ["M", "contains", "%", ""],
      ["M", "ncontains", "x", "cdefgh"],
      ["M", "ncontains", "", "abcdefgh"],
      ["M", "ncontains", null, "abcdefgh"],
      ["M", "ncontains", "[", "efgh"],
      ["M", "isEmpty", NONE, "efgh"],
      ["M", "isNotEmpty", NONE, "abcd"],
      ["PM", "eq", "$u1", "ab"],
      ["PM", "neq", "$u1", "cdefgh"],
      ["PM", "any", ["$u2"], "b"],
      ["PM", "all", ["$u1","$u2"], "b"],
      ["PM", "none", ["$u1"], "cdefgh"],
      ["PM", "contains", "-", "ab"],
      ["PM", "isEmpty", NONE, "cdefgh"],
      ["PM", "isNotEmpty", NONE, "ab"],
      ["F", "eq", "f1", ""],
      ["F", "any", ["f1"], ""],
      ["F", "none", ["f1"], "abcdefgh"],
      ["F", "all", ["f1"], ""],
      ["F", "contains", "a.txt", "ab"],
      ["F", "contains", "B.PNG", "b"],
      ["F", "contains", "fileName", "ab"],
      ["F", "contains", "f2", "b"],
      ["F", "ncontains", "b.png", "acdefgh"],
      ["F", "isEmpty", NONE, "cdefgh"],
      ["F", "isNotEmpty", NONE, "ab"],
    ]));
});

describe("time columns: date and date formulas", () => {
  // A value is a date text (its first YYYY-MM-DD is the day; other texts are read by Date.parse) or
  // { mode: "exact", date }. A value that gives no day matches nothing, with every operator.
  // A date-only cell is the day in the viewer's zone; a cell the database cannot read is empty.
  test("every operator with exact dates, odd values and other time zones", () =>
    run(main, [
      ["D", "eq", "2026-02-10", "bc"],
      ["D", "eq", {"mode":"exact","date":"2026-02-10"}, "bc"],
      ["D", "eq", {"mode":"exact","date":"2026-02-10T23:59:59+14:00"}, "bc"],
      ["D", "eq", "2026-02-10 and more", "bc"],
      ["D", "eq", "2026-02-11", "d"],
      ["D", "eq", "Feb 10 2026 12:00 GMT", "bc"],
      ["D", "eq", "2026-01-10", "a"],
      ["D", "isWithin", "2026-02-10", "bc"],
      ["D", "isWithin", {"mode":"exact","date":"2026-01-10"}, "a"],
      ["D", "neq", "2026-02-10", "adefgh"],
      ["D", "neq", {"mode":"exact","date":"2026-01-10"}, "bcdefgh"],
      ["D", "before", "2026-02-10", "a"],
      ["D", "lt", "2026-02-10", "a"],
      ["D", "onOrBefore", "2026-02-10", "abc"],
      ["D", "lte", "2026-02-10", "abc"],
      ["D", "after", "2026-02-10", "de"],
      ["D", "gt", "2026-02-10", "de"],
      ["D", "onOrAfter", "2026-02-10", "bcde"],
      ["D", "gte", "2026-02-10", "bcde"],
      ["D", "before", "2026-01-10", ""],
      ["D", "after", "2026-02-20", "e"],
      ["D", "before", "2026-03-10", "abcde"],
      ["D", "onOrAfter", "2026-02-11", "de"],
      ["D", "onOrBefore", "2026-01-09", ""],
      ["D", "isEmpty", NONE, "fgh"],
      ["D", "isNotEmpty", NONE, "abcde"],
      ["D", "eq", "", ""],
      ["D", "neq", "", ""],
      ["D", "eq", null, ""],
      ["D", "neq", null, ""],
      ["D", "eq", NONE, ""],
      ["D", "neq", NONE, ""],
      ["D", "before", NONE, ""],
      ["D", "eq", 5, ""],
      ["D", "eq", true, ""],
      ["D", "eq", [], ""],
      ["D", "eq", ["2026-02-10"], ""],
      ["D", "eq", {"mode":"exact"}, ""],
      ["D", "eq", {"mode":"exact","date":"garbage"}, ""],
      ["D", "eq", {"mode":"exact","date":20260210}, ""],
      ["D", "eq", {"mode":"exact","date":null}, ""],
      ["D", "eq", {"mode":"relative","preset":"nope"}, ""],
      ["D", "eq", {"mode":"range","preset":"nope"}, ""],
      ["D", "eq", {"mode":"nope"}, ""],
      ["D", "eq", {"date":"2026-02-10"}, ""],
      ["D", "neq", {"mode":"exact","date":"garbage"}, ""],
      ["D", "after", {"mode":"exact","date":"garbage"}, ""],
      ["D", "eq", "2026-02-30", ""],
      ["D", "onOrAfter", "2026-02-30", "e"],
      ["D", "onOrAfter", "2026-03-06", ""],
      ["D", "eq", "2026-13-45", ""],
      ["D", "before", "2026-13-45", "abcde"],
      ["D", "after", "0000-00-00", "abcde"],
      ["D", "eq", "2026-02-10", "bcd", -300],
      ["D", "eq", "2026-02-10", "bc", 600],
      ["D", "eq", "2026-02-11", "d", 600],
      ["D", "eq", "2026-02-11", "", -300],
      ["D", "before", "2026-02-10", "a", -300],
      ["D", "onOrAfter", "2026-02-11", "de", 600],
      ["D", "eq", "2026-01-10", "a", 900],
      ["D", "eq", "2026-01-10", "a", -900],
      ["D", "eq", "Feb 10 2026 23:00 GMT", "d", 120],
      ["D", "eq", "Feb 10 2026 23:00 GMT", "bc", 0],
      ["FD", "eq", "2026-02-11", "bc"],
      ["FD", "after", "2026-03-01", "eh"],
      ["FD", "before", "2026-01-12", "ag"],
      ["FD", "isEmpty", NONE, "f"],
      ["FD", "isNotEmpty", NONE, "abcdegh"],
      ["FD", "neq", "2026-02-11", "adefgh"],
      ["FD", "eq", "2026-02-11", "bcd", -300],
    ]));

  test("a day so far out that the database cannot read it fails the request", async () => {
    // Accident: 9999-99-99 overflows into the year 10007, which is sent to the database in a form it rejects.
    expectError(await owner.post(`/bases/${main.baseId}/rows/query`, { filter: and({ propertyId: main.props.D, op: "before", value: "9999-99-99" }) }), 500, "internal_error", "Something went wrong");
  });
});

describe("cells that hold JSON of another type than the property stores", () => {
  test("text reads any JSON as its text; number, checkbox, date and list columns read what converts cleanly and treat the rest as empty", () =>
    run(odd, [
      ["T", "eq", "12", "r1"],
      ["T", "eq", 12, "r1"],
      ["T", "eq", "true", "r2"],
      ["T", "contains", "a", "r3"],
      ["T", "eq", "[\"a\", \"b\"]", "r3"],
      ["T", "contains", "k", "r4"],
      ["T", "isEmpty", NONE, "r5r6r7"],
      ["T", "isNotEmpty", NONE, "r1r2r3r4"],
      ["T", "eq", "", "r5"],
      ["T", "neq", "", "r1r2r3r4r6r7"],
      ["T", "any", ["12","true"], "r1r2"],
      ["T", "ncontains", "1", "r2r3r5r6r7"],
      ["N", "eq", 12, "r1"],
      ["N", "eq", 3.5, "r2"],
      ["N", "eq", 100, "r4"],
      ["N", "eq", 0.5, "r7"],
      ["N", "eq", 1, ""],
      ["N", "gt", 0, "r1r2r4r7"],
      ["N", "isEmpty", NONE, "r3r5r6"],
      ["N", "isNotEmpty", NONE, "r1r2r4r7"],
      ["N", "neq", 12, "r2r3r4r5r6r7"],
      ["C", "eq", true, "r1r4r7"],
      ["C", "eq", false, "r2r3r5r6"],
      ["C", "neq", true, "r2r3r5r6"],
      ["C", "isEmpty", NONE, "r3r6"],
      ["C", "isNotEmpty", NONE, "r1r2r4r5r7"],
      ["D", "eq", "2026-01-10", "r4"],
      ["D", "isEmpty", NONE, "r1r2r3r5r6r7"],
      ["D", "isNotEmpty", NONE, "r4"],
      ["D", "neq", "2026-01-10", "r1r2r3r5r6r7"],
      ["M", "eq", "x", "r1r5"],
      ["M", "any", ["x"], "r1r5"],
      ["M", "any", ["5"], ""],
      ["M", "contains", "5", "r5"],
      ["M", "contains", "x", "r1r5"],
      ["M", "isEmpty", NONE, "r2r3r4r6r7"],
      ["M", "isNotEmpty", NONE, "r1r5"],
      ["M", "none", ["x"], "r2r3r4r6r7"],
    ]));
});

describe("relative and range dates", () => {
  const DAY = 86_400_000;
  const OPS = ["eq", "isWithin", "neq", "before", "lt", "onOrBefore", "lte", "after", "gt", "onOrAfter", "gte"];
  /** Whether a cell at local time `x` matches, for a filter value that means the local days `[start, end)`. */
  const matches = (op: string, x: number, start: number, end: number) => {
    switch (op) {
      case "eq":
      case "isWithin":
        return x >= start && x < end;
      case "neq":
        return !(x >= start && x < end);
      case "before":
      case "lt":
        return x < start;
      case "onOrBefore":
      case "lte":
        return x < end;
      case "after":
      case "gt":
        return x >= end;
      default:
        return x >= start;
    }
  };

  /**
   * Builds rows on the days around every preset as seen from a zone `tzOffset` minutes east of UTC, and checks
   * every preset with every operator. Local times are handled as UTC milliseconds of the local clock reading.
   */
  const check = async (tzOffset: number) => {
    const local = new Date(Date.now() + tzOffset * 60_000);
    const [y, m, d] = [local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()];
    const at = (yy: number, mm: number, dd: number) => Date.UTC(yy, mm, dd);
    const today = at(y, m, d);
    const monday = today - ((local.getUTCDay() + 6) % 7) * DAY;
    const presets: [mode: string, preset: string, start: number, end: number][] = [
      ["relative", "today", today, today + DAY],
      ["relative", "tomorrow", today + DAY, today + 2 * DAY],
      ["relative", "yesterday", today - DAY, today],
      ["relative", "oneWeekAgo", today - 7 * DAY, today - 6 * DAY],
      ["relative", "oneWeekFromNow", today + 7 * DAY, today + 8 * DAY],
      // The same day number of the neighbouring month; a day that month does not have rolls over into the next.
      ["relative", "oneMonthAgo", at(y, m - 1, d), at(y, m - 1, d) + DAY],
      ["relative", "oneMonthFromNow", at(y, m + 1, d), at(y, m + 1, d) + DAY],
      ["range", "pastWeek", today - 7 * DAY, today + DAY],
      ["range", "pastMonth", at(y, m - 1, d), today + DAY],
      ["range", "pastYear", at(y - 1, m, d), today + DAY],
      // Weeks start on Monday.
      ["range", "thisWeek", monday, monday + 7 * DAY],
      ["range", "thisMonth", at(y, m, 1), at(y, m + 1, 1)],
      ["range", "thisYear", at(y, 0, 1), at(y + 1, 0, 1)],
      ["range", "nextWeek", today, today + 7 * DAY],
      ["range", "nextMonth", today, at(y, m + 1, d)],
      ["range", "nextYear", today, at(y + 1, m, d)],
    ];
    const base = await createBase(owner, spaceId, { title: `Dates at ${tzOffset}` });
    await emptyBase(owner, base.id);
    const title = base.properties[0]!.id;
    const date = (await addProperty(owner, base.id, "Day", "date")).id;
    // Date-only cells on the days at and next to every boundary, and two instants at the very start of today.
    const days = [...new Set(presets.flatMap(([, , start, end]) => [start - DAY, start, end - DAY, end]))].sort((a, b) => a - b);
    const rows: [label: string, localTime: number][] = [];
    for (const day of days) {
      const label = new Date(day).toISOString().slice(0, 10);
      await addRow(owner, base.id, { [title]: label, [date]: label });
      rows.push([label, day]);
    }
    for (const [label, localTime] of [["first instant of today", today], ["last instant of yesterday", today - 1]] as const) {
      await addRow(owner, base.id, { [title]: label, [date]: new Date(localTime - tzOffset * 60_000).toISOString() });
      rows.push([label, localTime]);
    }
    const actual: unknown[] = [];
    const expected: unknown[] = [];
    for (const [mode, preset, start, end] of presets) {
      for (const op of OPS) {
        const { items } = await queryRows(owner, base.id, { filter: and({ propertyId: date, op, value: { mode, preset } }), tzOffset, limit: 500 });
        actual.push([preset, op, items.map((r) => r.cells[title]).sort()]);
        expected.push([preset, op, rows.filter(([, x]) => matches(op, x, start, end)).map(([label]) => label).sort()]);
      }
    }
    expect(actual).toEqual(expected);
    // Sanity of the fixture itself: today's preset finds today's row and the first instant of today.
    expect(actual[0]).toEqual(["today", "eq", [new Date(today).toISOString().slice(0, 10), "first instant of today"].sort()]);
  };

  test(
    "every preset with every operator, in UTC",
    async () => {
      // The rows are built around "today"; a run that would straddle midnight UTC waits for the new day.
      const untilMidnight = DAY - (Date.now() % DAY);
      if (untilMidnight < 20_000) await Bun.sleep(untilMidnight + 50);
      await check(0);
    },
    60_000,
  );

  test("every preset with every operator, in the viewer's zone", async () => {
    // A zone where it is now between 02:00 and 22:00, so the day cannot change under the test.
    const tzOffset = [-420, 330, 600, -660, 840, -120].find((offset) => {
      const hour = new Date(Date.now() + offset * 60_000).getUTCHours();
      return hour >= 2 && hour < 22;
    })!;
    await check(tzOffset);
  });
});

describe("created time, last edited time and last edited by", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    const base = await createBase(owner, spaceId, { title: "System columns" });
    await emptyBase(owner, base.id);
    const p: Record<string, string> = { title: base.properties[0]!.id };
    for (const [key, type] of [["CA", "createdAt"], ["EA", "lastEditedAt"], ["EB", "lastEditedBy"]] as const) p[key] = (await addProperty(owner, base.id, key, type)).id;
    const rows = [];
    for (const label of ["1", "2", "3"]) rows.push(await addRow(owner, base.id, { [p.title!]: label }));
    // Row 1: created by u1 on 10 January, last edited by u2 on 11 January. Row 2: created by u2 on 10 February at
    // 03:00 UTC and never edited by anyone else. Row 3: created just now; its creator and editor are gone.
    await t.sql`UPDATE base_rows SET created_at = '2026-01-10T12:00:00Z', updated_at = '2026-01-11T12:00:00Z', last_editor_id = ${ids.u2!} WHERE id = ${rows[0]!.id}`;
    await t.sql`UPDATE base_rows SET created_at = '2026-02-10T03:00:00Z', updated_at = '2026-02-10T03:00:00Z', creator_id = ${ids.u2!}, last_editor_id = NULL WHERE id = ${rows[1]!.id}`;
    await t.sql`UPDATE base_rows SET creator_id = NULL, last_editor_id = NULL WHERE id = ${rows[2]!.id}`;
    fixture = { baseId: base.id, props: p };
  });

  test("the time columns filter on the row's own timestamps", () =>
    run(fixture, [
      ["CA", "eq", "2026-01-10", "1"],
      ["CA", "before", "2026-02-10", "1"],
      ["CA", "onOrAfter", "2026-02-10", "23"],
      ["CA", "eq", "2026-02-10", "2"],
      // 03:00 UTC is still the 9th five hours west of UTC.
      ["CA", "eq", "2026-02-10", "", -300],
      ["CA", "eq", "2026-02-09", "2", -300],
      ["CA", "neq", "2026-01-10", "23"],
      ["CA", "isEmpty", NONE, ""],
      ["CA", "isNotEmpty", NONE, "123"],
      ["CA", "eq", { mode: "relative", preset: "today" }, "3", new Date().getUTCHours() < 12 ? 300 : -300],
      ["EA", "eq", "2026-01-11", "1"],
      ["EA", "eq", "2026-01-10", ""],
      ["EA", "after", "2026-01-11", "23"],
      ["EA", "lte", "2026-02-10", "12"],
      ["EA", "isEmpty", NONE, ""],
    ]));

  test("last edited by is a text column holding the id of the last editor, or of the creator when there is none", () =>
    run(fixture, [
      ["EB", "eq", "$u1", ""],
      ["EB", "eq", "$u2", "12"],
      ["EB", "neq", "$u2", "3"],
      ["EB", "any", ["$u1", "$u2"], "12"],
      ["EB", "none", ["$u2"], "3"],
      ["EB", "contains", "-", "12"],
      ["EB", "isEmpty", NONE, "3"],
      ["EB", "isNotEmpty", NONE, "12"],
    ]));
});

describe("operators a kind of column does not have", () => {
  const ALL = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "ncontains", "startsWith", "endsWith", "isEmpty", "isNotEmpty", "before", "after", "onOrBefore", "onOrAfter", "any", "none", "all", "isWithin"];
  const KINDS: Record<string, { properties: string[]; unsupported: string[] }> = {
    text: { properties: ["T", "L", "S", "ST", "P1", "PG", "U", "E", "FS", "FX"], unsupported: ["before", "after", "onOrBefore", "onOrAfter", "isWithin"] },
    number: { properties: ["N", "FN"], unsupported: ["contains", "ncontains", "startsWith", "endsWith", "before", "after", "onOrBefore", "onOrAfter", "any", "none", "all", "isWithin"] },
    time: { properties: ["D", "FD"], unsupported: ["contains", "ncontains", "startsWith", "endsWith", "any", "none", "all"] },
    flag: { properties: ["C", "FB"], unsupported: ["gt", "gte", "lt", "lte", "contains", "ncontains", "startsWith", "endsWith", "before", "after", "onOrBefore", "onOrAfter", "any", "none", "all", "isWithin"] },
    list: { properties: ["M", "PM", "F"], unsupported: ["gt", "gte", "lt", "lte", "startsWith", "endsWith", "before", "after", "onOrBefore", "onOrAfter", "isWithin"] },
  };

  for (const [kind, { properties, unsupported }] of Object.entries(KINDS)) {
    test(`${kind} columns answer 400 for ${unsupported.length} operators and accept the other ${ALL.length - unsupported.length}`, async () => {
      const actual: unknown[] = [];
      const expected: unknown[] = [];
      for (const property of properties) {
        for (const op of ALL) {
          const res = await owner.post(`/bases/${main.baseId}/rows/query`, { filter: and({ propertyId: main.props[property], op, value: "2026-01-01" }), limit: 1 });
          actual.push([property, op, res.status, res.body.error ?? null]);
          expected.push([
            property,
            op,
            unsupported.includes(op) ? 400 : 200,
            unsupported.includes(op) ? { code: "invalid_input", message: `Operator ${op} is not supported for ${kind} properties` } : null,
          ]);
        }
      }
      expect(actual).toEqual(expected);
    });
  }

  test("the system columns have the operators of their kind", async () => {
    const base = await createBase(owner, spaceId, { title: "System kinds" });
    const created = await addProperty(owner, base.id, "CA", "createdAt");
    const edited = await addProperty(owner, base.id, "EA", "lastEditedAt");
    const editor = await addProperty(owner, base.id, "EB", "lastEditedBy");
    const query = (propertyId: string, op: string) => owner.post(`/bases/${base.id}/rows/query`, { filter: and({ propertyId, op, value: "x" }) });
    for (const time of [created, edited]) {
      expectInvalid(await query(time.id, "contains"), "Operator contains is not supported for time properties");
      expect((await query(time.id, "isWithin")).status).toBe(200);
    }
    expectInvalid(await query(editor.id, "before"), "Operator before is not supported for text properties");
    expect((await query(editor.id, "startsWith")).status).toBe(200);
  });

  test("a person column changes kind with allowMultiple, and a formula with its result type", async () => {
    const base = await createBase(owner, spaceId, { title: "Changing kinds" });
    const who = await addProperty(owner, base.id, "Who", "person");
    const formula = await addProperty(owner, base.id, "F", "formula", { source: "1" });
    const query = (propertyId: string, op: string) => owner.post(`/bases/${base.id}/rows/query`, { filter: and({ propertyId, op, value: "1" }) });
    expect((await query(who.id, "startsWith")).status).toBe(200);
    ok(await owner.post(`/bases/${base.id}/properties/${who.id}/update`, { options: { allowMultiple: true } }));
    expectInvalid(await query(who.id, "startsWith"), "Operator startsWith is not supported for list properties");
    expectInvalid(await query(formula.id, "contains"), "Operator contains is not supported for number properties");
    for (const [source, kind] of [['"a"', "text"], ["true", "flag"], ["TODAY()", "time"], ["blank", "text"]] as const) {
      ok(await owner.post(`/bases/${base.id}/properties/${formula.id}/update`, { options: { source } }));
      const res = await query(formula.id, kind === "text" ? "before" : "startsWith");
      expectInvalid(res, `Operator ${kind === "text" ? "before" : "startsWith"} is not supported for ${kind} properties`);
    }
  });
});

describe("groups", () => {
  const cond = (property: string, op: string, value?: unknown) => ({ propertyId: main.props[property], op, ...(value === undefined ? {} : { value }) });
  const found = (filter: unknown) => labels(main, filter);

  test("and needs every child, or needs one; groups nest", async () => {
    expect(await found(and(cond("T", "contains", "apple"), cond("N", "gt", 0)))).toBe("a");
    expect(await found(or(cond("N", "lt", 0), cond("C", "eq", true)))).toBe("acd");
    expect(await found(or(cond("N", "eq", 1), and(cond("T", "eq", "cherry 100%"))))).toBe("bc");
    expect(await found(and(or(cond("S", "eq", "a"), cond("S", "eq", "b")), cond("C", "eq", false)))).toBe("b");
    expect(await found(or(and(cond("N", "gte", 1), cond("M", "isEmpty")), and(cond("C", "eq", true), or(cond("T", "endsWith", "pie"), cond("N", "lt", 0)))))).toBe("deg");
    // The same property may be used more than once.
    expect(await found(and(cond("N", "gt", 0), cond("N", "lt", 3)))).toBe("bh");
    expect(await found(and(cond("T", "eq", "apple"), cond("T", "eq", "banana")))).toBe("");
  });

  test("no filter, a null filter and empty groups match every row; an empty group inside another is skipped", async () => {
    const all = "abcdefgh";
    expect(await labels(main, undefined)).toBe(all);
    expect(await found(null)).toBe(all);
    expect(await found(and())).toBe(all);
    expect(await found(or())).toBe(all);
    expect(await found(and(or()))).toBe(all);
    expect(await found(or(and(), and(or())))).toBe(all);
    expect(await found(or(and(), cond("T", "eq", "apple")))).toBe("a");
    expect(await found(and(cond("T", "eq", "apple"), or()))).toBe("a");
  });

  test("a group may have 200 children and be nested 10 deep", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => cond("T", "eq", i === 0 ? "apple" : `nothing ${i}`));
    expect(await found(or(...many(200)))).toBe("a");
    expectInvalid(await owner.post(`/bases/${main.baseId}/rows/query`, { filter: or(...many(201)) }), "Invalid filter");
    expectInvalid(await owner.post(`/bases/${main.baseId}/rows/query`, { filter: and(or(...many(201))) }), "Invalid filter");
    const nested = (groups: number): unknown => (groups === 0 ? cond("T", "eq", "apple") : and(nested(groups - 1)));
    // Eleven groups: the outermost and ten inside it.
    expect(await found(nested(11))).toBe("a");
    expectInvalid(await owner.post(`/bases/${main.baseId}/rows/query`, { filter: nested(12) }), "Invalid filter");
  });

  test("a filter of the wrong shape is refused", async () => {
    const p = main.props.T!;
    const invalid: unknown[] = [
      "x",
      5,
      true,
      [],
      [and()],
      {},
      { op: "and" },
      { children: [] },
      { op: "xor", children: [] },
      { op: "AND", children: [] },
      { op: "and", children: "x" },
      { op: "and", children: {} },
      and(null),
      and(5),
      and("x"),
      and([]),
      and({}),
      and({ propertyId: 5, op: "eq" }),
      and({ op: "eq", value: 1 }),
      and({ propertyId: p }),
      and({ propertyId: p, op: "like" }),
      and({ propertyId: p, op: 5 }),
      and({ propertyId: p, op: "EQ" }),
      and({ propertyId: p, op: "eq" }, { op: "and", children: "x" }),
      and({ children: [] }),
      and({ op: "or", children: [null] }),
      // Anything with a `children` key is read as a group.
      and({ propertyId: p, op: "eq", value: "apple", children: [] }),
    ];
    for (const filter of invalid) {
      const res = await owner.post(`/bases/${main.baseId}/rows/query`, { filter });
      expect([JSON.stringify(filter), res.status, res.body.error?.message]).toEqual([JSON.stringify(filter), 400, "Invalid filter"]);
    }
    // Other keys of a condition or a group are ignored.
    expect(await found({ op: "and", children: [{ propertyId: p, op: "eq", value: "apple", id: 1, extra: { op: "nope" } }], name: "saved" })).toBe("a");
  });

  test("a condition on a property the base does not have is refused", async () => {
    const query = (filter: unknown) => owner.post(`/bases/${main.baseId}/rows/query`, { filter });
    expectInvalid(await query(and({ propertyId: "pnope", op: "eq", value: 1 })), "Filter references unknown property pnope");
    expectInvalid(await query(and({ propertyId: "", op: "isEmpty" })), "Filter references unknown property ");
    expectInvalid(await query(and({ propertyId: odd.props.T, op: "isEmpty" })), `Filter references unknown property ${odd.props.T}`);
    expectInvalid(await query(or(cond("T", "eq", "apple"), and(or({ propertyId: "deep", op: "eq" })))), "Filter references unknown property deep");
    // The conditions are checked in order: the first problem is the one reported.
    expectInvalid(await query(and({ propertyId: "first", op: "eq" }, cond("N", "contains", "x"))), "Filter references unknown property first");
    expectInvalid(await query(and(cond("N", "contains", "x"), { propertyId: "second", op: "eq" })), "Operator contains is not supported for number properties");
    // The shape is checked before the properties.
    expectInvalid(await query(and({ propertyId: "pnope", op: "eq" }, { propertyId: "x", op: "like" })), "Invalid filter");
    // A deleted property is unknown from then on.
    const base = await createBase(owner, spaceId, { title: "Deleted property" });
    const spare = await addProperty(owner, base.id, "Spare", "text");
    ok(await owner.post(`/bases/${base.id}/properties/${spare.id}/delete`, {}));
    expectInvalid(await owner.post(`/bases/${base.id}/rows/query`, { filter: and({ propertyId: spare.id, op: "isEmpty" }) }), `Filter references unknown property ${spare.id}`);
  });
});
