import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Client, type TestServer } from "./harness";
import { addProperty, addRow, createBase, expectError, expectInvalid, getRow, ok, updateRow } from "./harness/base-fixtures";

/**
 * What the server stores for a cell, per property type and per kind of value.
 * Every table row is `[value sent, what is stored]`, where `EMPTY` means the
 * cell stays empty and `bad(detail)` means a 400 with
 * `Invalid value for "P": <detail>`. Each table is sent twice: as the cell of
 * a new row and as an update of an existing row.
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

const EMPTY = Symbol("empty");
class Bad {
  constructor(readonly detail: string) {}
}
const bad = (detail: string) => new Bad(detail);
type Case = [value: unknown, stored: unknown];

const label = (value: unknown) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 90 ? `${text.slice(0, 90)}… (${text.length})` : text;
};
const expectedOutcome = (expected: unknown) =>
  expected === EMPTY ? { empty: true } : expected instanceof Bad ? { error: `Invalid value for "P": ${expected.detail}` } : { stored: expected };
const outcome = (res: { status: number; body: any; text: string }, propertyId: string) => {
  if (res.status === 400) return { error: res.body.error.message };
  if (res.status !== 200) return { status: res.status, text: res.text };
  return propertyId in res.body.data.cells ? { stored: res.body.data.cells[propertyId] } : { empty: true };
};

/** Runs `fn` over `items`, a few at a time, keeping the order of the results. */
const pooled = async <T, R>(items: T[], fn: (item: T) => Promise<R>, size = 12): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!);
      }
    }),
  );
  return results;
};

const check = async (type: string, options: unknown, cases: Case[]) => {
  const base = await createBase(owner, spaceId, { title: type });
  const property = await addProperty(owner, base.id, "P", type, options);
  const expected = cases.map(([value, stored]) => [label(value), expectedOutcome(stored)]);
  const created = await pooled(cases, async ([value]) => [label(value), outcome(await owner.post(`/bases/${base.id}/rows`, { cells: { [property.id]: value } }), property.id)]);
  expect(created).toEqual(expected);
  // The same values as updates of one row: a refused value leaves the cell as it was.
  const row = await addRow(owner, base.id);
  const updated: unknown[] = [];
  for (const [value] of cases) {
    updated.push([label(value), outcome(await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { cells: { [property.id]: value } }), property.id)]);
  }
  expect(updated).toEqual(expected);
};

describe("text and longText cells", () => {
  const cases: Case[] = [
    ["hello", "hello"],
    ["  padded  ", "  padded  "],
    ["", EMPTY],
    ["   ", "   "],
    [0, "0"],
    [5, "5"],
    [-2.5, "-2.5"],
    [1e+21, "1e+21"],
    [true, "true"],
    [false, "false"],
    [[], EMPTY],
    [["a"], "a"],
    [["a", "b"], "a,b"],
    [[" x "], " x "],
    [[null], EMPTY],
    [[1, 2], "1,2"],
    [[["a"]], "a"],
    [{}, "[object Object]"],
    [{"a": 1}, "[object Object]"],
    ["😀 مرحبا 日本語 e\u0301", "😀 مرحبا 日本語 e\u0301"],
    ["line1\nline2", "line1\nline2"],
    ["\t", "\t"],
    ["0", "0"],
    ["null", "null"],
  ];
  test("text keeps any string as it is (blanks included), reads other values as JavaScript's String() does, and treats \"\" as empty", () => check("text", undefined, cases));
  test("longText behaves the same", () => check("longText", undefined, cases));

  test("a text may have 100 000 UTF-16 units; one more is too long", async () => {
    const base = await createBase(owner, spaceId);
    const text = await addProperty(owner, base.id, "T", "text");
    const long = await addProperty(owner, base.id, "L", "longText");
    for (const property of [text, long]) {
      const most = "x".repeat(100_000);
      expect((await addRow(owner, base.id, { [property.id]: most })).cells[property.id]).toBe(most);
      expectInvalid(await owner.post(`/bases/${base.id}/rows`, { cells: { [property.id]: `${most}x` } }), `Invalid value for "${property.name}": text too long`);
      // An emoji is two units: 50 000 of them fill the cell.
      const emoji = "😀".repeat(50_000);
      expect((await addRow(owner, base.id, { [property.id]: emoji })).cells[property.id]).toBe(emoji);
      expectInvalid(await owner.post(`/bases/${base.id}/rows`, { cells: { [property.id]: `${emoji}a` } }), `Invalid value for "${property.name}": text too long`);
      // The limit applies to the text a list is joined into.
      expectInvalid(
        await owner.post(`/bases/${base.id}/rows`, { cells: { [property.id]: ["x".repeat(50_000), "y".repeat(50_000)] } }),
        `Invalid value for "${property.name}": text too long`,
      );
    }
  });

  test("a NUL character or a lone surrogate in a text makes the request fail", async () => {
    const base = await createBase(owner, spaceId);
    const text = await addProperty(owner, base.id, "T", "text");
    const url = await addProperty(owner, base.id, "U", "url");
    const send = async (cells: string) => {
      const res = await owner.raw("POST", `/bases/${base.id}/rows`, { body: `{"cells":${cells}}`, headers: { "Content-Type": "application/json" } });
      return { status: res.status, body: await res.json() };
    };
    const failed = { status: 500, body: { error: { code: "internal_error", message: "Something went wrong" } } };
    // Accident: the database refuses these strings in JSON, and the error is not turned into a 400.
    expect(await send(`{"${text.id}":"a\\u0000b"}`)).toEqual(failed);
    expect(await send(`{"${url.id}":"a\\u0000b"}`)).toEqual(failed);
    expect(await send(`{"${text.id}":"a\\ud83db"}`)).toEqual(failed);
    const [{ count }] = await t.sql`SELECT count(*)::int AS count FROM base_rows WHERE page_id = ${base.id}`;
    expect(count).toBe(1);
  });
});

describe("number cells", () => {
  test("numbers are kept; strings are read as JavaScript's Number() reads them; anything not finite is refused", () =>
    check("number", undefined, [
      ["hello", bad("not a number")],
      ["  padded  ", bad("not a number")],
      ["", EMPTY],
      ["   ", EMPTY],
      [0, 0],
      [5, 5],
      [-2.5, -2.5],
      [1e+21, 1e+21],
      [true, 1],
      [false, 0],
      // Accident: a list is read through its text ("" for [] and [null], "5" for [5]), so some lists are numbers.
      [[], 0],
      [["a"], bad("not a number")],
      [["a", "b"], bad("not a number")],
      [[" x "], bad("not a number")],
      [[null], 0],
      [[1, 2], bad("not a number")],
      [[["a"]], bad("not a number")],
      [{}, bad("not a number")],
      [{"a": 1}, bad("not a number")],
      ["😀 مرحبا 日本語 e\u0301", bad("not a number")],
      ["12.5", 12.5],
      [" 7 ", 7],
      ["1e3", 1000],
      ["1E-2", 0.01],
      ["0x10", 16],
      ["0b11", 3],
      ["0o17", 15],
      ["Infinity", bad("not a number")],
      ["-Infinity", bad("not a number")],
      ["+Infinity", bad("not a number")],
      ["NaN", bad("not a number")],
      ["1,234", bad("not a number")],
      ["abc", bad("not a number")],
      ["+5", 5],
      ["5.", 5],
      [".5", 0.5],
      ["-.5", -0.5],
      ["1_000", bad("not a number")],
      ["١٢", bad("not a number")],
      ["  12  \n", 12],
      ["-0", 0],
      ["1e308", 1e+308],
      ["1e309", bad("not a number")],
      ["12px", bad("not a number")],
      ["0.1", 0.1],
      ["00012", 12],
      ["1 2", bad("not a number")],
      ["$5", bad("not a number")],
      ["5%", bad("not a number")],
      ["--5", bad("not a number")],
      ["0x", bad("not a number")],
      ["1e", bad("not a number")],
      ["\u00a05\u00a0", 5],
      [0.30000000000000004, 0.30000000000000004],
      [123456789012345680000, 123456789012345680000],
      [1e-07, 1e-07],
      [[5], 5],
      [["7"], 7],
      [["1", "2"], bad("not a number")],
      [[[3]], 3],
      [[""], 0],
      [[" "], 0],
      [[true], bad("not a number")],
      [{"valueOf": 1}, bad("not a number")],
    ]));

  test("numbers arrive as IEEE doubles: precision beyond that is lost, and what overflows is refused", async () => {
    const base = await createBase(owner, spaceId);
    const number = await addProperty(owner, base.id, "N", "number");
    const send = async (literal: string) => {
      const res = await owner.raw("POST", `/bases/${base.id}/rows`, { body: `{"cells":{"${number.id}":${literal}}}`, headers: { "Content-Type": "application/json" } });
      const text = await res.text();
      return res.status === 200 ? /"cells":\{"[^"]+":([^}]+)\}/.exec(text)?.[1] : JSON.parse(text).error.message;
    };
    expect(await send("9007199254740993")).toBe("9007199254740992");
    expect(await send('"9007199254740993"')).toBe("9007199254740992");
    expect(await send("1.2345678901234567890123")).toBe("1.2345678901234567");
    expect(await send("0.30000000000000004")).toBe("0.30000000000000004");
    expect(await send("1e400")).toBe('Invalid value for "N": not a number');
    expect(await send("-1e400")).toBe('Invalid value for "N": not a number');
    expect(await send("1e-400")).toBe("0");
    expect(await send("-0")).toBe("0");
    expect(await send("-0.0")).toBe("0");
    expect(await send("1.0")).toBe("1");
    expect(await send("1e2")).toBe("100");
    // A key given twice: the last one counts.
    const twice = await owner.raw("POST", `/bases/${base.id}/rows`, { body: `{"cells":{"${number.id}":1,"${number.id}":2}}`, headers: { "Content-Type": "application/json" } });
    expect(((await twice.json()) as any).data.cells).toEqual({ [number.id]: 2 });
  });
});

describe("checkbox cells", () => {
  test("booleans are kept, numbers are true unless zero, and a few words are read; a blank string is false, not empty", () =>
    check("checkbox", undefined, [
      ["hello", bad("not a checkbox value")],
      ["  padded  ", bad("not a checkbox value")],
      ["", false],
      ["   ", false],
      [0, false],
      [5, true],
      [-2.5, true],
      [1e+21, true],
      [true, true],
      [false, false],
      [[], bad("not a checkbox value")],
      [["a"], bad("not a checkbox value")],
      [["a", "b"], bad("not a checkbox value")],
      [[" x "], bad("not a checkbox value")],
      [[null], bad("not a checkbox value")],
      [[1, 2], bad("not a checkbox value")],
      [[["a"]], bad("not a checkbox value")],
      [{}, bad("not a checkbox value")],
      [{"a": 1}, bad("not a checkbox value")],
      ["😀 مرحبا 日本語 e\u0301", bad("not a checkbox value")],
      ["true", true],
      ["TRUE", true],
      [" True ", true],
      ["1", true],
      ["yes", true],
      ["YES", true],
      ["on", true],
      ["On", true],
      ["false", false],
      ["0", false],
      ["no", false],
      ["off", false],
      ["OFF", false],
      ["y", bad("not a checkbox value")],
      ["n", bad("not a checkbox value")],
      ["t", bad("not a checkbox value")],
      ["f", bad("not a checkbox value")],
      ["2", bad("not a checkbox value")],
      ["checked", bad("not a checkbox value")],
      ["null", bad("not a checkbox value")],
      [1, true],
      [2, true],
      [-1, true],
      [0.5, true],
      [["true"], bad("not a checkbox value")],
      [[true], bad("not a checkbox value")],
      ["truee", bad("not a checkbox value")],
      ["ON ", true],
      ["да", bad("not a checkbox value")],
    ]));
});

describe("date cells", () => {
  test("a date is stored as the trimmed text sent, if JavaScript's Date.parse can read it", () =>
    check("date", undefined, [
      ["hello", bad("not a date")],
      ["  padded  ", bad("not a date")],
      ["", EMPTY],
      ["   ", EMPTY],
      // Accident: numbers and lists are read through their text, and Date.parse reads some bare numbers as dates.
      [0, "0"],
      [5, "5"],
      [-2.5, "-2.5"],
      [1e+21, bad("not a date")],
      [true, bad("not a date")],
      [false, bad("not a date")],
      [[], EMPTY],
      [["a"], bad("not a date")],
      [["a", "b"], bad("not a date")],
      [[" x "], bad("not a date")],
      [[null], EMPTY],
      [[1, 2], "1,2"],
      [[["a"]], bad("not a date")],
      [{}, bad("not a date")],
      [{"a": 1}, bad("not a date")],
      ["😀 مرحبا 日本語 e\u0301", bad("not a date")],
      ["2024-03-05", "2024-03-05"],
      [" 2024-03-05 ", "2024-03-05"],
      ["2024-03-05\n", "2024-03-05"],
      ["2024-03-05T10:20:30Z", "2024-03-05T10:20:30Z"],
      ["2024-03-05T10:20:30.123Z", "2024-03-05T10:20:30.123Z"],
      ["2024-03-05T10:20:30+02:00", "2024-03-05T10:20:30+02:00"],
      ["2024-03-05T10:20:30+0200", "2024-03-05T10:20:30+0200"],
      ["2024-03-05T10:20", "2024-03-05T10:20"],
      ["2024-03-05T10:20:30", "2024-03-05T10:20:30"],
      ["2024-03", "2024-03"],
      ["2024", "2024"],
      ["+002024-03-05T00:00:00Z", "+002024-03-05T00:00:00Z"],
      ["-000001-01-01T00:00:00Z", "-000001-01-01T00:00:00Z"],
      ["2024-03-05T24:00:00Z", "2024-03-05T24:00:00Z"],
      ["2024-03-05T25:00:00Z", bad("not a date")],
      ["2024-02-30", "2024-02-30"],
      ["2024-02-29", "2024-02-29"],
      ["2023-02-29", "2023-02-29"],
      ["2024-13-01", bad("not a date")],
      ["2024-00-10", bad("not a date")],
      ["2024-01-32", bad("not a date")],
      ["2024-3-5", "2024-3-5"],
      ["2024-03-05 10:20", "2024-03-05 10:20"],
      ["2024-03-05 10:20:30Z", "2024-03-05 10:20:30Z"],
      ["2024/03/05", "2024/03/05"],
      ["20240305", bad("not a date")],
      ["2024-03-05T10:20:30.123456Z", "2024-03-05T10:20:30.123456Z"],
      ["2024-03-05t10:20:30z", "2024-03-05t10:20:30z"],
      ["2024-03-05T10:20:30 Z", bad("not a date")],
      ["2024-03-05T10:20Z", "2024-03-05T10:20Z"],
      ["2024-03-05T10Z", bad("not a date")],
      ["2024-03-05T", bad("not a date")],
      ["2024-03-05Z", "2024-03-05Z"],
      ["3/5/2024", "3/5/2024"],
      ["03/05/2024", "03/05/2024"],
      ["13/5/2024", bad("not a date")],
      ["3/32/2024", bad("not a date")],
      ["3/5/24", "3/5/24"],
      ["3/5", "3/5"],
      ["3-5-2024", "3-5-2024"],
      ["3.5.2024", "3.5.2024"],
      ["05.03.2024", "05.03.2024"],
      ["5 March 2024", "5 March 2024"],
      ["March 5, 2024", "March 5, 2024"],
      ["march 5, 2024", "march 5, 2024"],
      ["MARCH 5 2024", "MARCH 5 2024"],
      ["Mar 5 2024", "Mar 5 2024"],
      ["Mar 5, 2024", "Mar 5, 2024"],
      ["March 2024", "March 2024"],
      ["Mar 5", "Mar 5"],
      ["5 Mar", "5 Mar"],
      ["5 Mar 2024 10:20", "5 Mar 2024 10:20"],
      ["Tue Mar 05 2024", "Tue Mar 05 2024"],
      ["Tue, 05 Mar 2024 10:20:30 GMT", "Tue, 05 Mar 2024 10:20:30 GMT"],
      ["Wed, 05 Mar 2024 10:20:30 GMT", "Wed, 05 Mar 2024 10:20:30 GMT"],
      ["Tue Mar 05 2024 10:20:30 GMT+0100 (CET)", "Tue Mar 05 2024 10:20:30 GMT+0100 (CET)"],
      ["March 5, 2024 10:20 PM", "March 5, 2024 10:20 PM"],
      ["March 5, 2024 10:20 pm", "March 5, 2024 10:20 pm"],
      ["March 5, 2024 13:20 PM", bad("not a date")],
      ["March 5, 2024 10:20:30.5", "March 5, 2024 10:20:30.5"],
      ["12:30", bad("not a date")],
      ["10:20:30", bad("not a date")],
      ["today", bad("not a date")],
      ["now", bad("not a date")],
      ["tomorrow", bad("not a date")],
      ["yesterday", bad("not a date")],
      ["0", "0"],
      ["1", "1"],
      ["12", "12"],
      ["13", bad("not a date")],
      ["32", "32"],
      ["99", "99"],
      ["100", "100"],
      ["999", "999"],
      ["1000", "1000"],
      ["99999", "99999"],
      ["275760", "275760"],
      ["1709630000000", bad("not a date")],
      ["-1", "-1"],
      ["1e3", bad("not a date")],
      ["abc", bad("not a date")],
      ["2024-03-05abc", bad("not a date")],
      ["T10:20", bad("not a date")],
      ["Mar", bad("not a date")],
      ["March", bad("not a date")],
      ["Monday", bad("not a date")],
      ["Sept 5 2024", "Sept 5 2024"],
      ["Sep 5 2024", "Sep 5 2024"],
      ["December 17, 1995 03:24:00", "December 17, 1995 03:24:00"],
      ["Jan 1 1970 00:00:00 UTC", "Jan 1 1970 00:00:00 UTC"],
      ["Jan 1 1970 00:00:00 +0530", "Jan 1 1970 00:00:00 +0530"],
      ["Jan 1 1970 00:00:00 EST", "Jan 1 1970 00:00:00 EST"],
      ["Jan 1 1970 00:00:00 PST", "Jan 1 1970 00:00:00 PST"],
      ["Jan 1 1970 00:00:00 CET", bad("not a date")],
      ["Jan 1 1970 00:00:00 Z", "Jan 1 1970 00:00:00 Z"],
      ["1 Jan 70", "1 Jan 70"],
      ["1 Jan 49", "1 Jan 49"],
      ["1 Jan 50", "1 Jan 50"],
      ["2024-W10", bad("not a date")],
      ["٢٠٢٤-٠٣-٠٥", bad("not a date")],
      ["2024年3月5日", bad("not a date")],
      ["5/3", "5/3"],
      ["2024-03-05 +01:00", bad("not a date")],
      ["Feb 30 2024", "Feb 30 2024"],
      ["Feb 31 2024", "Feb 31 2024"],
      ["Apr 31 2024", "Apr 31 2024"],
      ["Jan 32 2024", bad("not a date")],
      ["2024 March 5", "2024 March 5"],
      ["2024 Mar 5 10:20", "2024 Mar 5 10:20"],
      ["5th March 2024", bad("not a date")],
      ["March 5th, 2024", bad("not a date")],
      ["Mar. 5, 2024", "Mar. 5, 2024"],
      ["2024-03-05T10:20:30,5Z", bad("not a date")],
      ["(comment) Mar 5 2024", "(comment) Mar 5 2024"],
      ["Mar 5 2024 (comment)", "Mar 5 2024 (comment)"],
      ["Mar 5 2024 10:20 AM GMT", "Mar 5 2024 10:20 AM GMT"],
      ["Mar 5 2024 0:00", "Mar 5 2024 0:00"],
      ["Mar 5 2024 24:00", "Mar 5 2024 24:00"],
      ["Mar 5 2024 23:59:60", "Mar 5 2024 23:59:60"],
      ["Mar 5 12024", "Mar 5 12024"],
      ["Mar 5 -2024", bad("not a date")],
      ["Mar 5 0024", "Mar 5 0024"],
      ["1/1/1", "1/1/1"],
      ["1/1/0001", "1/1/0001"],
      ["12/31/9999", "12/31/9999"],
      ["1/1/10000", "1/1/10000"],
      ["1970-01-01T00:00:00.000+00:00", "1970-01-01T00:00:00.000+00:00"],
      ["1970-01-01T00:00:00-00:00", "1970-01-01T00:00:00-00:00"],
      ["0000-01-01", "0000-01-01"],
      ["0001-01-01", "0001-01-01"],
      ["9999-12-31", "9999-12-31"],
      ["10000-01-01", "10000-01-01"],
      ["+275760-09-13T00:00:00.000Z", "+275760-09-13T00:00:00.000Z"],
      ["+275760-09-13T00:00:00.001Z", bad("not a date")],
      [20240305, bad("not a date")],
      [1709630000000, bad("not a date")],
      [-5, "-5"],
      [1.5, "1.5"],
      [["2024-03-05"], "2024-03-05"],
      [["2024", "03"], "2024,03"],
      [["Mar 5", "2024"], "Mar 5,2024"],
    ]));

  test("the includeTime option makes no difference to what is accepted", async () => {
    const base = await createBase(owner, spaceId);
    const date = await addProperty(owner, base.id, "D", "date", { includeTime: true });
    const row = await addRow(owner, base.id, { [date.id]: "2024-03-05" });
    expect(row.cells[date.id]).toBe("2024-03-05");
    expect((await updateRow(owner, base.id, row.id, { [date.id]: "2024-03-05T10:20:30Z" })).cells[date.id]).toBe("2024-03-05T10:20:30Z");
  });
});

describe("url, email and page cells", () => {
  test("a url is any text without whitespace, trimmed, of at most 2048 characters", async () => {
    await check("url", undefined, [
      ["hello", "hello"],
      ["  padded  ", "padded"],
      ["", EMPTY],
      ["   ", EMPTY],
      [0, "0"],
      [5, "5"],
      [-2.5, "-2.5"],
      [1e+21, "1e+21"],
      [true, "true"],
      [false, "false"],
      [[], EMPTY],
      [["a"], "a"],
      [["a", "b"], "a,b"],
      [[" x "], "x"],
      [[null], EMPTY],
      [[1, 2], "1,2"],
      [[["a"]], "a"],
      [{}, bad("not a URL")],
      [{"a": 1}, bad("not a URL")],
      ["😀 مرحبا 日本語 e\u0301", bad("not a URL")],
      ["https://example.com", "https://example.com"],
      [" https://example.com/a b ", bad("not a URL")],
      ["not a url", bad("not a URL")],
      ["abc", "abc"],
      ["javascript:alert(1)", "javascript:alert(1)"],
      ["http://exa\tmple.com", bad("not a URL")],
      ["http://exa\u00a0mple.com", bad("not a URL")],
      ["//x", "//x"],
      ["mailto:a@b.co", "mailto:a@b.co"],
      ["u".repeat(2048), "u".repeat(2048)],
      [` ${"u".repeat(2048)} `, "u".repeat(2048)],
      ["u".repeat(2049), bad("not a URL")],
    ]);
  });

  test("an email is something@something.something without blanks, trimmed, of at most 320 characters", async () => {
    await check("email", undefined, [
      ["hello", bad("not an email address")],
      ["  padded  ", bad("not an email address")],
      ["", EMPTY],
      ["   ", EMPTY],
      [0, bad("not an email address")],
      [5, bad("not an email address")],
      [-2.5, bad("not an email address")],
      [1e+21, bad("not an email address")],
      [true, bad("not an email address")],
      [false, bad("not an email address")],
      [[], EMPTY],
      [["a"], bad("not an email address")],
      [["a", "b"], bad("not an email address")],
      [[" x "], bad("not an email address")],
      [[null], EMPTY],
      [[1, 2], bad("not an email address")],
      [[["a"]], bad("not an email address")],
      [{}, bad("not an email address")],
      [{"a": 1}, bad("not an email address")],
      ["😀 مرحبا 日本語 e\u0301", bad("not an email address")],
      ["a@b.co", "a@b.co"],
      [" a@b.co ", "a@b.co"],
      ["A@B.CO", "A@B.CO"],
      ["a@b", bad("not an email address")],
      ["a b@c.de", bad("not an email address")],
      ["a@b@c.de", bad("not an email address")],
      ["@b.co", bad("not an email address")],
      ["a@.co", bad("not an email address")],
      ["a@b.", bad("not an email address")],
      ["a@b.c", "a@b.c"],
      ["ü@ü.de", "ü@ü.de"],
      ["a@b.co, c@d.ef", bad("not an email address")],
      ["a.b+c@d-e.fg", "a.b+c@d-e.fg"],
      [["a@b.co"], "a@b.co"],
      [["a@b.co", "c@d.ef"], bad("not an email address")],
      [`${"e".repeat(314)}@b.com`, `${"e".repeat(314)}@b.com`],
      [`${"e".repeat(315)}@b.com`, bad("not an email address")],
    ]);
  });

  test("a page cell is any trimmed text of at most 64 characters; it is not checked against the pages", () =>
    check("page", undefined, [
      ["hello", "hello"],
      ["  padded  ", "padded"],
      ["", EMPTY],
      ["   ", EMPTY],
      [0, "0"],
      [5, "5"],
      [-2.5, "-2.5"],
      [1e+21, "1e+21"],
      [true, "true"],
      [false, "false"],
      [[], EMPTY],
      [["a"], "a"],
      [["a", "b"], "a,b"],
      [[" x "], "x"],
      [[null], EMPTY],
      [[1, 2], "1,2"],
      [[["a"]], "a"],
      [{}, "[object Object]"],
      [{"a": 1}, "[object Object]"],
      ["😀 مرحبا 日本語 e\u0301", "😀 مرحبا 日本語 e\u0301"],
      ["00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000000"],
      [" abc ", "abc"],
      ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
      ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", bad("invalid page id")],
      [" xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx ", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
    ]));
});

describe("select, status and multiSelect cells", () => {
  const options = {
    choices: [
      { id: "a", name: "Alpha", color: "red" },
      { id: "b", name: "Beta", color: "blue" },
    ],
  };
  const single: Case[] = [
    ["a", "a"],
    ["b", "b"],
    ["zzz", bad("unknown option")],
    ["", EMPTY],
    ["   ", bad("unknown option")],
    [" a ", bad("unknown option")],
    ["A", bad("unknown option")],
    ["Alpha", bad("unknown option")],
    [0, bad("unknown option")],
    [5, bad("unknown option")],
    [true, bad("unknown option")],
    [false, bad("unknown option")],
    [[], EMPTY],
    [["a"], "a"],
    // Of a list only the first item is looked at.
    [["a", "b"], "a"],
    [["b", "a", "b"], "b"],
    [["a", "zzz"], "a"],
    [["zzz", "a"], bad("unknown option")],
    [[null], EMPTY],
    [[null, "a"], EMPTY],
    [["", "a"], EMPTY],
    [[1, "a"], bad("unknown option")],
    [[["a"]], bad("unknown option")],
    [{}, bad("unknown option")],
    [{ id: "a" }, bad("unknown option")],
    [[{ id: "a" }], bad("unknown option")],
  ];
  test("select holds the id of one of the property's choices", () => check("select", options, single));
  test("status behaves the same", () => check("status", options, single));

  test("multiSelect holds a list of distinct choice ids in the order given; what is not a string is skipped", () =>
    check("multiSelect", options, [
      ["a", ["a"]],
      ["b", ["b"]],
      ["zzz", bad("unknown option")],
      ["", EMPTY],
      ["   ", bad("unknown option")],
      [" a ", bad("unknown option")],
      ["A", bad("unknown option")],
      [0, EMPTY],
      [5, EMPTY],
      [true, EMPTY],
      [false, EMPTY],
      [[], EMPTY],
      [["a"], ["a"]],
      [["a", "b"], ["a", "b"]],
      [["b", "a", "b"], ["b", "a"]],
      [["a", "zzz"], bad("unknown option")],
      [["zzz", "a"], bad("unknown option")],
      [[null], EMPTY],
      [[null, "a"], ["a"]],
      [["", "a"], ["a"]],
      [[1, "a"], ["a"]],
      [[["a"]], EMPTY],
      [{}, EMPTY],
      [{ id: "a" }, EMPTY],
      [[{ id: "a" }], EMPTY],
    ]));

  test("a choice property without choices accepts nothing but empty", async () => {
    await check("select", undefined, [
      ["a", bad("unknown option")],
      ["", EMPTY],
      [[], EMPTY],
    ]);
    await check("status", undefined, [
      ["status-todo", bad("unknown option")],
      [[""], EMPTY],
    ]);
    await check("multiSelect", {}, [
      [["a"], bad("unknown option")],
      [[5], EMPTY],
    ]);
  });
});

describe("person cells", () => {
  const id64 = "u".repeat(64);
  const values: unknown[] = [
    "a", "zzz", "", "   ", " a ", "00000000-0000-4000-8000-000000000000", 0, 5, true, false, [], ["a"], ["a", "b"], ["b", "a", "b"], [null], [null, "a"], ["", "a"], [1, "a"], [["a"]], {}, { id: "a" }, [{ id: "a" }],
    id64, `${id64}u`, [id64, "ok"], ["ok", `${id64}u`],
  ];
  // What each value becomes as a list; a single-person property keeps the first item.
  const lists: unknown[] = [
    ["a"], ["zzz"], EMPTY, ["   "], [" a "], ["00000000-0000-4000-8000-000000000000"], EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, ["a"], ["a", "b"], ["b", "a"], EMPTY, ["a"], ["a"], ["a"], EMPTY, EMPTY, EMPTY, EMPTY,
    [id64], bad("invalid user id"), [id64, "ok"], bad("invalid user id"),
  ];

  test("a person cell holds one id: any string of at most 64 characters, not checked against the users", () =>
    check("person", undefined, values.map((value, i): Case => [value, Array.isArray(lists[i]) ? (lists[i] as string[])[0] : lists[i]])));

  test("with allowMultiple it holds the list of distinct ids", () =>
    check("person", { allowMultiple: true }, values.map((value, i): Case => [value, lists[i]])));
});

describe("file cells", () => {
  const f = { id: "f1", fileName: "a.txt" };
  const id128 = "i".repeat(128);
  const name1024 = "n".repeat(1024);
  const url2048 = "u".repeat(2048);
  const hundred = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, fileName: `${i}.txt` }));

  test("a file cell holds a list of at most 100 files with an id, a name and optionally a type, a size and a url", () =>
    check("file", undefined, [
      ["a", bad("expected a list of files")],
      ["", bad("expected a list of files")],
      [5, bad("expected a list of files")],
      [true, bad("expected a list of files")],
      [{}, bad("expected a list of files")],
      [f, bad("expected a list of files")],
      [[], EMPTY],
      [[f], [f]],
      [[f, f], [f, f]],
      [[null], bad("invalid file")],
      [["x"], bad("invalid file")],
      [[5], bad("invalid file")],
      [[[]], bad("invalid file id")],
      [[{}], bad("invalid file id")],
      [[{ id: "f1" }], bad("invalid file name")],
      [[{ fileName: "a.txt" }], bad("invalid file id")],
      [[{ id: "", fileName: "a" }], bad("invalid file id")],
      [[{ id: 5, fileName: "a" }], bad("invalid file id")],
      [[{ id: "f1", fileName: "" }], [{ id: "f1", fileName: "" }]],
      [[{ id: "f1", fileName: 5 }], bad("invalid file name")],
      [[{ id: "f1", fileName: null }], bad("invalid file name")],
      [[{ id: id128, fileName: name1024, url: url2048 }], [{ id: id128, fileName: name1024, url: url2048 }]],
      [[{ id: `${id128}i`, fileName: "a" }], bad("invalid file id")],
      [[{ id: "f1", fileName: `${name1024}n` }], bad("invalid file name")],
      [[{ id: "f1", fileName: "a", url: `${url2048}u` }], bad("invalid file url")],
      [[{ id: "f1", fileName: "a", url: null }], bad("invalid file url")],
      [[{ id: "f1", fileName: "a", url: 5 }], bad("invalid file url")],
      [[{ id: "f1", fileName: "a", url: "" }], [{ id: "f1", fileName: "a", url: "" }]],
      // Unknown keys are dropped; a type that is not a string and a size that is not a number are dropped too.
      [
        [{ id: "f1", fileName: "a.txt", mimeType: "text/plain", fileSize: 12, url: "/api/files/f1", extra: "dropped", width: 5 }],
        [{ id: "f1", fileName: "a.txt", mimeType: "text/plain", fileSize: 12, url: "/api/files/f1" }],
      ],
      [[{ id: "f1", fileName: "a.txt", mimeType: 5, fileSize: "12" }], [f]],
      [[{ id: "f1", fileName: "a.txt", mimeType: null, fileSize: null }], [f]],
      [[{ ...f, fileSize: 1.5 }], [{ ...f, fileSize: 1.5 }]],
      [[{ ...f, fileSize: -1 }], [{ ...f, fileSize: -1 }]],
      [hundred, hundred],
      [[...hundred, f], bad("too many files")],
      // The count is checked before the files themselves.
      [Array(101).fill(null), bad("too many files")],
      [[{ id: " f1 ", fileName: " a.txt " }], [{ id: " f1 ", fileName: " a.txt " }]],
      [[{ id: "😀", fileName: "日本語.txt" }], [{ id: "😀", fileName: "日本語.txt" }]],
    ]));

  test("sending the files a cell already holds is a change when a file has a url, a type or a size", async () => {
    const base = await createBase(owner, spaceId);
    const files = await addProperty(owner, base.id, "Files", "file");
    const plain = await addRow(owner, base.id, { [files.id]: [f] });
    expect(await updateRow(owner, base.id, plain.id, { [files.id]: [f] })).toEqual(plain);
    const full = [{ id: "f1", fileName: "a.txt", mimeType: "text/plain", fileSize: 12, url: "/api/files/f1" }];
    const row = await addRow(owner, base.id, { [files.id]: full });
    // Accident: the stored object's keys come back from the database in another order than the one the
    // comparison builds, so identical files look different and the row counts as edited.
    const again = await updateRow(owner, base.id, row.id, { [files.id]: full });
    expect(again.cells).toEqual(row.cells);
    expect(Date.parse(again.updatedAt)).toBeGreaterThan(Date.parse(row.updatedAt));
  });
});

describe("cells of every type", () => {
  const editable: [type: string, options: unknown, value: unknown][] = [
    ["text", undefined, "x"],
    ["longText", undefined, "x\ny"],
    ["number", undefined, 1.5],
    ["select", { choices: [{ id: "a", name: "A" }] }, "a"],
    ["status", { choices: [{ id: "a", name: "A" }] }, "a"],
    ["multiSelect", { choices: [{ id: "a", name: "A" }] }, ["a"]],
    ["date", undefined, "2024-03-05"],
    ["person", undefined, "someone"],
    ["file", undefined, [{ id: "f", fileName: "f.txt" }]],
    ["page", undefined, "some-page"],
    ["checkbox", undefined, true],
    ["url", undefined, "https://example.com"],
    ["email", undefined, "a@b.co"],
  ];

  test("null leaves a new cell empty and clears an existing one, for every editable type", async () => {
    const base = await createBase(owner, spaceId);
    const properties = [];
    for (const [type, options] of editable) properties.push(await addProperty(owner, base.id, `A ${type}`, type, options));
    const values = Object.fromEntries(properties.map((p, i) => [p.id, editable[i]![2]]));
    const nulls = Object.fromEntries(properties.map((p) => [p.id, null]));
    expect((await addRow(owner, base.id, nulls)).cells).toEqual({});
    const row = await addRow(owner, base.id, values);
    expect(row.cells).toEqual(values);
    const [stored] = await t.sql`SELECT cells FROM base_rows WHERE id = ${row.id}`;
    expect(stored.cells).toEqual(values);
    // One at a time, then all at once.
    const first = properties[0]!;
    const { [first.id]: _gone, ...rest } = values;
    expect((await updateRow(owner, base.id, row.id, { [first.id]: null })).cells).toEqual(rest);
    expect((await updateRow(owner, base.id, row.id, nulls)).cells).toEqual({});
    expect((await getRow(owner, base.id, row.id)).cells).toEqual({});
  });

  test("created time, last edited time, last edited by and formula cells ignore whatever is sent", async () => {
    const base = await createBase(owner, spaceId);
    const readOnly = [];
    for (const type of ["createdAt", "lastEditedAt", "lastEditedBy"]) readOnly.push(await addProperty(owner, base.id, `A ${type}`, type));
    const formula = await addProperty(owner, base.id, "A formula", "formula", { source: '"computed"' });
    readOnly.push(formula);
    const row = await addRow(owner, base.id);
    expect(row.cells).toEqual({ [formula.id]: "computed" });
    for (const value of ["x", "", 5, true, null, [], ["a"], {}, "2020-01-01T00:00:00Z"]) {
      const cells = Object.fromEntries(readOnly.map((p) => [p.id, value]));
      expect((await addRow(owner, base.id, cells)).cells).toEqual({ [formula.id]: "computed" });
      expect(await updateRow(owner, base.id, row.id, cells)).toEqual(row);
    }
  });

  test("the message names the property as it is, and the first invalid cell of the request is the one reported", async () => {
    const base = await createBase(owner, spaceId);
    const quoted = await addProperty(owner, base.id, 'Say "hi" \\ 😀', "number");
    const email = await addProperty(owner, base.id, "Mail", "email");
    expectInvalid(await owner.post(`/bases/${base.id}/rows`, { cells: { [quoted.id]: "x" } }), 'Invalid value for "Say "hi" \\ 😀": not a number');
    expectInvalid(await owner.post(`/bases/${base.id}/rows`, { cells: { [email.id]: "nope", [quoted.id]: "x" } }), 'Invalid value for "Mail": not an email address');
    expectInvalid(await owner.post(`/bases/${base.id}/rows`, { cells: { [quoted.id]: "x", [email.id]: "nope" } }), 'Invalid value for "Say "hi" \\ 😀": not a number');
    const [row] = ok(await owner.post(`/bases/${base.id}/rows/query`, {})).items;
    expectInvalid(await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { cells: { [email.id]: "nope", [quoted.id]: "x" } }), 'Invalid value for "Mail": not an email address');
    expectError(await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { cells: { [email.id]: 5 } }), 400, "invalid_input", 'Invalid value for "Mail": not an email address');
  });
});
