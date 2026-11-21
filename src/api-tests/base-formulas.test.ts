import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, startServer, type Client, type TestServer } from "./harness";
import {
  addProperty,
  addRow,
  allRows,
  createBase,
  emptyBase,
  expectError,
  expectInvalid,
  getBase,
  getRow,
  ISO,
  nextBaseEvent,
  ok,
  updateProperty,
  updateRow,
} from "./harness/base-fixtures";

/**
 * The formula language, seen through formula properties. The tables read
 * `[source, stored result, result type]`, or `[source, bad(message)]` when the
 * formula is refused with a 400. A stored result is a number, a text, a
 * boolean, a date as text (`YYYY-MM-DD` or an ISO date-time), `null` for an
 * empty cell, or `{ error, message }` when the evaluation failed.
 *
 * Numbers are rounded to 12 significant digits; texts count UTF-16 units;
 * dates are UTC and are read by JavaScript's `Date.parse`.
 */

let t: TestServer;
let owner: Client;
let ownerId: string;
let spaceId: string;
let sheet: Sheet;

interface Sheet {
  baseId: string;
  rowId: string;
  /** The formula property whose source the tables rewrite. */
  formulaId: string;
  props: Record<string, string>;
}

/**
 * One row for the formulas of the tables to read:
 *
 *   Amount 21 (number)         Name "hi" (text)              Note "long\ntext" (longText)
 *   Site "https://x.io" (url)  Mail "a@b.co" (email)         Done true, Off never set (checkbox)
 *   Due "2026-03-10" (date)    When "2026-03-10T15:30:45Z" (date)
 *   Stage, State (select and status "x"), Tags (multiSelect ["x"]), Who (person), Docs (file), Link (page), Editor (last edited by)
 *   Zero (number), Blank (text) and Never (date) are empty
 *   Num10 = 10, Txt = "t" and Err = 1 / 0 are formulas
 *
 * The formula under test is the property "F".
 */
const buildSheet = async (owner: Client, spaceId: string, ownerId: string): Promise<Sheet> => {
  const base = await createBase(owner, spaceId, { title: "Formulas" });
  await emptyBase(owner, base.id);
  const p: Record<string, string> = {};
  const add = async (name: string, type: string, options?: unknown) => {
    p[name] = (await addProperty(owner, base.id, name, type, options)).id;
  };
  const choices = { choices: [{ id: "x", name: "X" }] };
  await add("Amount", "number");
  await add("Name", "text");
  await add("Note", "longText");
  await add("Site", "url");
  await add("Mail", "email");
  await add("Done", "checkbox");
  await add("Off", "checkbox");
  await add("Due", "date");
  await add("When", "date");
  await add("Stage", "select", choices);
  await add("State", "status", choices);
  await add("Tags", "multiSelect", choices);
  await add("Who", "person");
  await add("Docs", "file");
  await add("Link", "page");
  await add("Editor", "lastEditedBy");
  await add("Zero", "number");
  await add("Blank", "text");
  await add("Never", "date");
  await add("Num10", "formula", { source: "10" });
  await add("Txt", "formula", { source: '"t"' });
  await add("Err", "formula", { source: "1 / 0" });
  await add("F", "formula", { source: "0" });
  const row = await addRow(owner, base.id, {
    [p.Amount!]: 21,
    [p.Name!]: "hi",
    [p.Note!]: "long\ntext",
    [p.Site!]: "https://x.io",
    [p.Mail!]: "a@b.co",
    [p.Done!]: true,
    [p.Due!]: "2026-03-10",
    [p.When!]: "2026-03-10T15:30:45Z",
    [p.Stage!]: "x",
    [p.State!]: "x",
    [p.Tags!]: ["x"],
    [p.Who!]: ownerId,
    [p.Docs!]: [{ id: "f1", fileName: "a.txt" }],
    [p.Link!]: "some-page",
  });
  return { baseId: base.id, rowId: row.id, formulaId: p.F!, props: p };
};

/** Sets the formula under test: the compile error, or the stored result and the result type. */
const evaluate = async (owner: Client, sheet: Sheet, source: string): Promise<{ error: string } | { value: unknown; type: string }> => {
  const res = await owner.post(`/bases/${sheet.baseId}/properties/${sheet.formulaId}/update`, { options: { source } });
  if (res.status === 400) return { error: res.body.error!.message };
  if (res.status !== 200) return { error: `HTTP ${res.status}` };
  const row = (await owner.get(`/bases/${sheet.baseId}/rows/${sheet.rowId}`)).body.data.row;
  return { value: row.cells[sheet.formulaId] ?? null, type: res.body.data.options.resultType };
};

beforeAll(async () => {
  t = await startServer();
  let user: { id: string };
  ({ owner, user, spaceId } = await t.setupOwner());
  ownerId = user.id;
  sheet = await buildSheet(owner, spaceId, ownerId);
});

afterAll(async () => {
  await t.close();
});

class Bad {
  constructor(readonly message: string) {}
}
const bad = (message: string) => new Bad(message);
type Case = [source: string, result: unknown, type?: string];

const run = async (cases: Case[]) => {
  const actual: unknown[] = [];
  const expected: unknown[] = [];
  for (const [source, result, type] of cases) {
    actual.push([source, await evaluate(owner, sheet, source)]);
    expected.push([source, result instanceof Bad ? { error: result.message } : { value: result, type }]);
  }
  expect(actual).toEqual(expected);
};

const MISSING = { error: "MISSING_PROP", message: "A property this formula uses was deleted" };

describe("operators", () => {
  test("arithmetic, joining, comparison and logic, with their precedence", () =>
    run([
      ["1 + 2 * 3", 7, "number"],
      ["(1 + 2) * 3", 9, "number"],
      ["-2^2", -4, "number"],
      ["(-2)^2", 4, "number"],
      ["2^3^2", 512, "number"],
      ["2^-1", 0.5, "number"],
      ["2 ^ 0.5", 1.41421356237, "number"],
      ["10 - 4 - 3", 3, "number"],
      ["2 * 3 % 4", 2, "number"],
      ["7 % 3", 1, "number"],
      ["-7 % 3", -1, "number"],
      ["7 % -3", 1, "number"],
      ["5.5 % 2", 1.5, "number"],
      ["1 % 0", {"error":"DIV_BY_ZERO","message":"Cannot take a remainder by zero"}, "number"],
      ["1 / 0", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "number"],
      ["0 / 5", 0, "number"],
      ["1 / 3", 0.333333333333, "number"],
      ["2 / 3", 0.666666666667, "number"],
      ["10 / 4", 2.5, "number"],
      ["0.1 + 0.2", 0.3, "number"],
      ["0.1 * 3", 0.3, "number"],
      ["1e21 + 1", 1e+21, "number"],
      ["1e308 * 10", null, "number"],
      ["-1e308 * 10", null, "number"],
      ["2 ^ 1024", null, "number"],
      ["(-8) ^ (1/3)", null, "number"],
      ["0 ^ 0", 1, "number"],
      ["+5", 5, "number"],
      ["+-5", -5, "number"],
      ["--5", 5, "number"],
      ["- - 5", 5, "number"],
      ["1 + 2 & 3", "33", "string"],
      ["1 & 2 + 3", "15", "string"],
      ["\"a\" & \"b\" & 1 & true & blank", "ab1true", "string"],
      ["1 & 2 = 12", true, "boolean"],
      ["1 < 2 = true", true, "boolean"],
      ["1 = 1 = 1", true, "boolean"],
      ["not 1 = 2", true, "boolean"],
      ["not(1) = 2", false, "boolean"],
      ["not true and false", false, "boolean"],
      ["not (true and false)", true, "boolean"],
      ["true or false and false", true, "boolean"],
      ["(true or false) and false", false, "boolean"],
      ["TRUE AND FALSE", false, "boolean"],
      ["1 Or 0", true, "boolean"],
      ["not not true", true, "boolean"],
      ["NOT TRUE", false, "boolean"],
      ["1 == 1", true, "boolean"],
      ["1 <> 2", true, "boolean"],
      ["1 != 1", false, "boolean"],
      ["1 <= 1", true, "boolean"],
      ["1 >= 2", false, "boolean"],
      ["2 > 1", true, "boolean"],
      ["2 < 1", false, "boolean"],
      ["false and (1 / 0) > 0", false, "boolean"],
      ["true or (1 / 0) > 0", true, "boolean"],
      ["true and (1 / 0) > 0", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "boolean"],
      ["false or 1 / 0", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "boolean"],
      ["1 and 2", true, "boolean"],
      ["0 or \"\"", false, "boolean"],
      ["\"no\" or \"false\"", false, "boolean"],
      ["\"x\" and 5", true, "boolean"],
      ["5 - -5", 10, "number"],
      ["5 + +5", 10, "number"],
      ["2 * -3", -6, "number"],
      ["-2 * -3", 6, "number"],
      ["6 / -2", -3, "number"],
      ["1 + true", 2, "number"],
      ["true * 5", 5, "number"],
      ["blank + 1", 1, "number"],
      ["blank * 5", 0, "number"],
      ["1 - blank", 1, "number"],
      ["blank / 5", 0, "number"],
      ["5 / blank", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "number"],
      ["-blank", 0, "number"],
      ["-true", -1, "number"],
      ["- \"5\"", -5, "number"],
      ["- \"abc\"", {"error":"VALUE","message":"\"abc\" is not a number"}, "number"],
      ["not blank", true, "boolean"],
      ["not 0", true, "boolean"],
      ["not \"x\"", false, "boolean"],
    ]));
});

describe("literals and syntax", () => {
  test("numbers, texts, true/false/blank, and what the parser refuses", () =>
    run([
      ["1.", 1, "number"],
      [".5", 0.5, "number"],
      ["1e3", 1000, "number"],
      ["1E-2", 0.01, "number"],
      ["1e+2", 100, "number"],
      ["007", 7, "number"],
      ["1.5e", bad("Unexpected \"e\"")],
      ["1e", bad("Unexpected \"e\"")],
      ["1.2.3", bad("Unexpected \".3\"")],
      ["0x10", bad("Unexpected \"x10\"")],
      ["1_000", bad("Unexpected \"_000\"")],
      ["1 2", bad("Unexpected \"2\"")],
      ["12abc", bad("Unexpected \"abc\"")],
      ["9007199254740993", 9007199254740992, "number"],
      ["0.1", 0.1, "number"],
      ["1.10", 1.1, "number"],
      ["123456789.123456789", 123456789.123, "number"],
      ["1e-7", 1e-7, "number"],
      ["1e400", null, "number"],
      ["\"a\"", "a", "string"],
      ["'a'", "a", "string"],
      ["\"it's\"", "it's", "string"],
      ["'say \"hi\"'", "say \"hi\"", "string"],
      ["\"a\\\"b\"", "a\"b", "string"],
      ["'a\\'b'", "a'b", "string"],
      ["\"line\\nbreak\"", "line\nbreak", "string"],
      ["\"tab\\there\"", "tab\there", "string"],
      ["\"back\\\\slash\"", "back\\slash", "string"],
      ["\"\\q\"", "q", "string"],
      ["\"unterminated", bad("Unterminated text value")],
      ["'unterminated", bad("Unterminated text value")],
      ["\"ends with backslash\\", bad("Unterminated text value")],
      ["\"\"", "", "string"],
      ["\"multi\nline\"", "multi\nline", "string"],
      ["\"😀 日本語\"", "😀 日本語", "string"],
      ["true", true, "boolean"],
      ["FALSE", false, "boolean"],
      ["null", null, "null"],
      ["Blank", null, "null"],
      ["EMPTY", null, "null"],
      ["true + 1", 2, "number"],
      ["null & 1", "1", "string"],
      ["TRUE()", bad("Unknown function \"TRUE\"")],
      ["null()", bad("Unknown function \"NULL\"")],
      ["prop", bad("Unknown name \"prop\". Reference a property with prop(\"prop\").")],
      ["amount", bad("Unknown name \"amount\". Reference a property with prop(\"amount\").")],
      ["Amount", bad("Unknown name \"Amount\". Reference a property with prop(\"Amount\").")],
      ["x y", bad("Unknown name \"x\". Reference a property with prop(\"x\").")],
      ["TRUE FALSE", bad("Unexpected \"FALSE\"")],
      [" 1\t+\n2\r", 3, "number"],
      ["1\u00a0+ 2", bad("Unexpected character \"\u00a0\"")],
      ["", bad("Formula is empty")],
      ["   ", bad("Formula is empty")],
      ["\n", bad("Formula is empty")],
      ["1 +", bad("The formula ended unexpectedly")],
      ["(1", bad("The formula ended unexpectedly")],
      ["1)", bad("Unexpected \")\"")],
      ["()", bad("Unexpected \")\"")],
      [", 1", bad("Unexpected \",\"")],
      ["1 ,", bad("Unexpected \",\"")],
      ["@", bad("Unexpected character \"@\"")],
      ["1 # 2", bad("Unexpected character \"#\"")],
      ["{1}", bad("Unexpected character \"{\"")],
      ["1 ! 2", bad("Unexpected character \"!\"")],
      ["!1", bad("Unexpected character \"!\"")],
      ["1 | 2", bad("Unexpected character \"|\"")],
      ["a.b", bad("Unexpected character \".\"")],
      ["é", bad("Unexpected character \"é\"")],
      ["1 . 2", bad("Unexpected character \".\"")],
      ["IF(1,", bad("The formula ended unexpectedly")],
      ["IF(1,)", bad("Unexpected \")\"")],
      ["IF(,1)", bad("Unexpected \",\"")],
      ["ABS 5", bad("Unknown name \"ABS\". Reference a property with prop(\"ABS\").")],
      ["ABS(5", bad("The formula ended unexpectedly")],
      ["5 ABS", bad("Unexpected \"ABS\"")],
      ["\"a\" \"b\"", bad("Unexpected \"\"b\"\"")],
      ["=1", bad("Unexpected \"=\"")],
      ["1 =", bad("The formula ended unexpectedly")],
      ["<", bad("Unexpected \"<\"")],
      ["1 <<< 2", bad("Unexpected \"<\"")],
      ["1 === 1", bad("Unexpected \"=\"")],
      ["1 => 2", bad("Unexpected \">\"")],
      ["1 ** 2", bad("Unexpected \"*\"")],
      ["1 +* 2", bad("Unexpected \"*\"")],
      ["((1)", bad("The formula ended unexpectedly")],
      ["1 + (2", bad("The formula ended unexpectedly")],
      ["and", bad("Unknown name \"and\". Reference a property with prop(\"and\").")],
      ["1 and", bad("The formula ended unexpectedly")],
      ["or 1", bad("Unknown name \"or\". Reference a property with prop(\"or\").")],
      ["not", bad("The formula ended unexpectedly")],
    ]));

  test("a formula may be 10 000 characters long, and is stored as sent", async () => {
    const longest = `1${" ".repeat(9999)}`;
    expect(await evaluate(owner, sheet, longest)).toEqual({ value: 1, type: "number" });
    expect((await getBase(owner, sheet.baseId)).properties.find((p) => p.id === sheet.formulaId)!.options.source).toBe(longest);
    expect(await evaluate(owner, sheet, `${longest} `)).toEqual({ error: "Formula is too long" });
    expect(await evaluate(owner, sheet, "  1 +\n 1  ")).toEqual({ value: 2, type: "number" });
    expect((await getBase(owner, sheet.baseId)).properties.find((p) => p.id === sheet.formulaId)!.options.source).toBe("  1 +\n 1  ");
    // Long flat expressions are fine.
    expect(await evaluate(owner, sheet, `1${"+1".repeat(4999)}`)).toEqual({ value: 5000, type: "number" });
    expect(await evaluate(owner, sheet, `${"-".repeat(999)}1`)).toEqual({ value: -1, type: "number" });
    expect(await evaluate(owner, sheet, `${"(".repeat(200)}1${")".repeat(200)}`)).toEqual({ value: 1, type: "number" });
  });
});

describe("references to properties", () => {
  test("prop() finds a property by name, whatever the case and the surrounding blanks; each type reads as a kind of value", () =>
    run([
      ["prop(\"Amount\")", 21, "number"],
      ["PROP(\"amount\")", 21, "number"],
      ["Prop ( \" Amount \" )", 21, "number"],
      ["prop('Name')", "hi", "string"],
      ["prop(\"Nope\")", bad("No property named \"Nope\"")],
      ["prop(\"Nope\") + prop(\"Nada\")", bad("No property named \"Nope\"")],
      ["prop(Amount)", bad("prop() takes a property name in quotes, like prop(\"Status\")")],
      ["prop()", bad("prop() takes a property name in quotes, like prop(\"Status\")")],
      ["prop(\"\")", bad("prop() needs a property name")],
      ["prop(\"  \")", bad("prop() needs a property name")],
      ["prop(\"Amount\", 1)", bad("Unexpected \",\"")],
      ["prop(1)", bad("prop() takes a property name in quotes, like prop(\"Status\")")],
      ["prop(\"Amount\"", bad("The formula ended unexpectedly")],
      ["prop \"Amount\"", bad("Unknown name \"prop\". Reference a property with prop(\"prop\").")],
      ["prop(\"F\")", bad("No property named \"F\"")],
      ["prop(\"AMOUNT\") + prop(\"Amount\")", 42, "number"],
      ["prop(\"Name\")", "hi", "string"],
      ["prop(\"Note\")", "long\ntext", "string"],
      ["prop(\"Site\")", "https://x.io", "string"],
      ["prop(\"Mail\")", "a@b.co", "string"],
      ["prop(\"Done\")", true, "boolean"],
      ["prop(\"Off\")", false, "boolean"],
      ["prop(\"Due\")", "2026-03-10", "date"],
      ["prop(\"When\")", "2026-03-10T15:30:45.000Z", "date"],
      ["prop(\"Stage\")", null, "null"],
      ["prop(\"State\")", null, "null"],
      ["prop(\"Tags\")", null, "null"],
      ["prop(\"Who\")", null, "null"],
      ["prop(\"Docs\")", null, "null"],
      ["prop(\"Link\")", null, "null"],
      ["prop(\"Editor\")", null, "null"],
      ["prop(\"Zero\")", null, "number"],
      ["prop(\"Blank\")", null, "string"],
      ["prop(\"Never\")", null, "date"],
      ["prop(\"Num10\")", 10, "number"],
      ["prop(\"Txt\")", "t", "string"],
      ["prop(\"Err\")", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "number"],
      ["ISBLANK(prop(\"Stage\"))", true, "boolean"],
      ["prop(\"Stage\") & \"!\"", "!", "string"],
      ["prop(\"Tags\") + 1", 1, "number"],
      ["prop(\"Who\") = blank", true, "boolean"],
      ["LEN(prop(\"Docs\"))", 0, "number"],
      ["ISBLANK(prop(\"Link\"))", true, "boolean"],
      ["ISBLANK(prop(\"Editor\"))", true, "boolean"],
      ["ISBLANK(prop(\"Zero\"))", true, "boolean"],
      ["prop(\"Zero\") + 1", 1, "number"],
      ["prop(\"Blank\") & \"x\"", "x", "string"],
      ["LEN(prop(\"Blank\"))", 0, "number"],
      ["prop(\"Off\") = false", true, "boolean"],
      ["ISBLANK(prop(\"Off\"))", false, "boolean"],
      ["YEAR(prop(\"Never\"))", {"error":"TYPE","message":"YEAR expects a date"}, "number"],
      ["prop(\"Num10\") * prop(\"Amount\")", 210, "number"],
      ["prop(\"Txt\") & prop(\"Name\")", "thi", "string"],
      ["prop(\"Err\") + 1", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "number"],
      ["IFERROR(prop(\"Err\"), \"caught\")", "caught", "string"],
      ["ISERROR(prop(\"Err\"))", true, "boolean"],
      ["prop(\"Amount\") + prop(\"Name\")", bad("The right side of \"+\" must be a number, not text")],
      ["prop(\"Name\") + 1", bad("The left side of \"+\" must be a number, not text")],
      ["prop(\"Name\") * 2", bad("The left side of \"*\" must be a number, not text")],
      ["prop(\"Done\") + 1", 2, "number"],
      ["prop(\"Due\") + 1", bad("The left side of \"+\" must be a number, not a date")],
      ["1 - prop(\"Due\")", bad("The right side of \"-\" must be a number, not a date")],
      ["prop(\"Note\") / 2", bad("The left side of \"/\" must be a number, not text")],
      ["prop(\"Site\") % 2", bad("The left side of \"%\" must be a number, not text")],
      ["prop(\"Mail\") ^ 2", bad("The left side of \"^\" must be a number, not text")],
      ["prop(\"Txt\") + 1", bad("The left side of \"+\" must be a number, not text")],
      ["prop(\"Stage\") + 1", 1, "number"],
      ["-prop(\"Name\")", {"error":"VALUE","message":"\"hi\" is not a number"}, "number"],
      ["-prop(\"Due\")", -1773100800000, "number"],
      ["not prop(\"Due\")", false, "boolean"],
      ["not prop(\"Name\")", false, "boolean"],
      ["prop(\"Name\") & prop(\"Amount\")", "hi21", "string"],
      ["prop(\"Due\") & \"\"", "2026-03-10", "string"],
      ["prop(\"When\") & \"\"", "2026-03-10T15:30:45.000Z", "string"],
      ["prop(\"Done\") & \"\"", "true", "string"],
      ["prop(\"Amount\") & \"\"", "21", "string"],
      ["prop(\"Note\") & \"|\" & prop(\"Site\") & \"|\" & prop(\"Mail\")", "long\ntext|https://x.io|a@b.co", "string"],
    ]));

  test("cells that hold JSON of another type than their property read as empty", async () => {
    const base = await createBase(owner, spaceId, { title: "Odd cells" });
    await emptyBase(owner, base.id);
    const ids: Record<string, string> = {};
    for (const [name, type] of [["N", "number"], ["T", "text"], ["C", "checkbox"], ["D", "date"]] as const) ids[name] = (await addProperty(owner, base.id, name, type)).id;
    const row = await addRow(owner, base.id);
    // Only a direct write can leave these behind.
    await t.sql`UPDATE base_rows SET cells = ${{ [ids.N!]: "21", [ids.T!]: 5, [ids.C!]: "yes", [ids.D!]: 5 }}::jsonb WHERE id = ${row.id}`;
    const f = await addProperty(owner, base.id, "F", "formula", { source: 'JOIN("|", ISBLANK(prop("N")), ISBLANK(prop("T")), prop("C"), ISBLANK(prop("D")))' });
    expect((await getRow(owner, base.id, row.id)).cells[f.id]).toBe("true|true|false|true");
  });
});

describe("equality and comparison", () => {
  test("= compares like a spreadsheet; < and > compare texts as texts, dates as dates and everything else as numbers", () =>
    run([
      ["1 = 1", true, "boolean"],
      ["1 = \"1\"", true, "boolean"],
      ["\"1\" = 1", true, "boolean"],
      ["\"1.0\" = 1", true, "boolean"],
      ["\"1,000\" = 1000", true, "boolean"],
      ["\"abc\" = 1", {"error":"VALUE","message":"\"abc\" is not a number"}, "boolean"],
      ["1 = \"abc\"", {"error":"VALUE","message":"\"abc\" is not a number"}, "boolean"],
      ["\"a\" = \"a\"", true, "boolean"],
      ["\"a\" = \"A\"", false, "boolean"],
      ["\"a \" = \"a\"", false, "boolean"],
      ["\"\" = blank", true, "boolean"],
      ["blank = blank", true, "boolean"],
      ["0 = blank", false, "boolean"],
      ["0 = \"\"", false, "boolean"],
      ["false = blank", false, "boolean"],
      ["\"\" = 0", false, "boolean"],
      ["true = 1", true, "boolean"],
      ["true = \"yes\"", true, "boolean"],
      ["true = \"no\"", false, "boolean"],
      ["false = \"false\"", true, "boolean"],
      ["false = 0", true, "boolean"],
      ["true = 2", true, "boolean"],
      ["\"true\" = true", true, "boolean"],
      ["\"TRUE\" = true", true, "boolean"],
      ["true = \"abc\"", true, "boolean"],
      ["true = true", true, "boolean"],
      ["\"a\" != \"b\"", true, "boolean"],
      ["1 != \"1\"", false, "boolean"],
      ["blank != 0", true, "boolean"],
      ["1 <> 1", false, "boolean"],
      ["prop(\"Due\") = \"2026-03-10\"", true, "boolean"],
      ["prop(\"Due\") = \"2026-03-11\"", false, "boolean"],
      ["prop(\"Due\") = prop(\"Due\")", true, "boolean"],
      ["prop(\"Due\") = \"garbage\"", false, "boolean"],
      ["prop(\"Due\") = TONUMBER(prop(\"Due\"))", true, "boolean"],
      ["prop(\"Due\") = true", false, "boolean"],
      ["prop(\"Due\") = blank", false, "boolean"],
      ["prop(\"Never\") = blank", true, "boolean"],
      ["prop(\"When\") = \"2026-03-10T15:30:45Z\"", true, "boolean"],
      ["prop(\"When\") = \"2026-03-10T16:30:45+01:00\"", true, "boolean"],
      ["prop(\"Due\") = prop(\"When\")", false, "boolean"],
      ["prop(\"Due\") != prop(\"When\")", true, "boolean"],
      ["prop(\"Due\") = \"2026-03-10T00:00:00Z\"", true, "boolean"],
      ["prop(\"Due\") = \"March 10, 2026\"", true, "boolean"],
      ["1 < 2", true, "boolean"],
      ["2 < 10", true, "boolean"],
      ["\"2\" < \"10\"", false, "boolean"],
      ["\"10\" < \"9\"", true, "boolean"],
      ["\"a\" < \"b\"", true, "boolean"],
      ["\"B\" < \"a\"", true, "boolean"],
      ["\"a\" < \"A\"", false, "boolean"],
      ["\"é\" > \"z\"", true, "boolean"],
      ["\"a\" < \"ab\"", true, "boolean"],
      ["\"\" < \"a\"", {"error":"VALUE","message":"\"a\" is not a number"}, "boolean"],
      ["blank < 1", true, "boolean"],
      ["blank < blank", false, "boolean"],
      ["blank <= blank", true, "boolean"],
      ["blank >= \"\"", true, "boolean"],
      ["\"\" > blank", false, "boolean"],
      ["1 < \"2\"", true, "boolean"],
      ["1 < \"abc\"", {"error":"VALUE","message":"\"abc\" is not a number"}, "boolean"],
      ["true > false", true, "boolean"],
      ["true > 0", true, "boolean"],
      ["\"abc\" < 1", {"error":"VALUE","message":"\"abc\" is not a number"}, "boolean"],
      ["1 < blank", false, "boolean"],
      ["-1 < blank", true, "boolean"],
      ["prop(\"Due\") < prop(\"When\")", true, "boolean"],
      ["prop(\"Due\") > \"2026-01-01\"", true, "boolean"],
      ["prop(\"Due\") < \"2026-03-10\"", false, "boolean"],
      ["prop(\"Due\") <= \"2026-03-10\"", true, "boolean"],
      ["prop(\"Due\") >= \"2026-03-10\"", true, "boolean"],
      ["prop(\"Due\") < \"garbage\"", {"error":"TYPE","message":"These values cannot be compared"}, "boolean"],
      ["prop(\"Due\") < 3", bad("Cannot compare a date with a number")],
      ["prop(\"Due\") < true", bad("Cannot compare a date with a true/false value")],
      ["3 < prop(\"Due\")", bad("Cannot compare a number with a date")],
      ["true >= prop(\"When\")", bad("Cannot compare a true/false value with a date")],
      ["prop(\"Due\") < blank", {"error":"TYPE","message":"These values cannot be compared"}, "boolean"],
      ["prop(\"Due\") > prop(\"Never\")", {"error":"TYPE","message":"These values cannot be compared"}, "boolean"],
      ["prop(\"Never\") > prop(\"Never\")", false, "boolean"],
      ["prop(\"Due\") > IF(true, 5, \"x\")", true, "boolean"],
      ["\"2026-01-01\" < prop(\"Due\")", true, "boolean"],
      ["prop(\"Due\") > prop(\"Name\")", {"error":"TYPE","message":"These values cannot be compared"}, "boolean"],
      ["prop(\"Due\") < prop(\"Stage\")", {"error":"TYPE","message":"These values cannot be compared"}, "boolean"],
    ]));
});

describe("logic functions", () => {
  test("IF, IFS, SWITCH, AND, OR, NOT, ISBLANK, ISERROR, IFERROR, COALESCE, ERROR", () =>
    run([
      ["IF(true, 1, 2)", 1, "number"],
      ["IF(false, 1, 2)", 2, "number"],
      ["IF(false, 1)", null, "number"],
      ["IF(true, 1)", 1, "number"],
      ["IF(1, \"a\", \"b\")", "a", "string"],
      ["IF(0, \"a\", \"b\")", "b", "string"],
      ["IF(\"\", \"a\", \"b\")", "b", "string"],
      ["IF(\"no\", \"a\", \"b\")", "b", "string"],
      ["IF(\"false\", \"a\", \"b\")", "b", "string"],
      ["IF(\"0\", \"a\", \"b\")", "b", "string"],
      ["IF(\" NO \", \"a\", \"b\")", "b", "string"],
      ["IF(\"x\", \"a\", \"b\")", "a", "string"],
      ["IF(blank, \"a\", \"b\")", "b", "string"],
      ["IF(-1, \"a\", \"b\")", "a", "string"],
      ["IF(prop(\"Due\"), \"a\", \"b\")", bad("IF argument 1 must be a true/false value, not a date")],
      ["IF(true, 1, \"b\")", 1, "string"],
      ["IF(true, 1, 1/0)", 1, "number"],
      ["IF(false, 1/0, 2)", 2, "number"],
      ["IF(1/0, 1, 2)", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "number"],
      ["IF()", bad("IF takes between 2 and 3 arguments, but got 0")],
      ["IF(true)", bad("IF takes between 2 and 3 arguments, but got 1")],
      ["IF(true, 1, 2, 3)", bad("IF takes between 2 and 3 arguments, but got 4")],
      ["if(TRUE, \"a\", \"b\")", "a", "string"],
      ["IF(true, blank, blank)", null, "null"],
      ["IF(true, prop(\"Due\"), prop(\"When\"))", "2026-03-10", "date"],
      ["IF(true, true, false)", true, "boolean"],
      ["IF(true, prop(\"Due\"), \"x\")", "2026-03-10", "string"],
      ["IF(true, 1, true)", 1, "string"],
      ["IFS(false, 1, true, 2)", 2, "number"],
      ["IFS(false, 1, false, 2)", null, "number"],
      ["IFS(false, 1, false, 2, 3)", 3, "number"],
      ["IFS(true, \"a\", 1/0, \"b\")", "a", "string"],
      ["IFS(false, 1/0, true, \"b\")", "b", "string"],
      ["IFS(true)", bad("IFS takes at least 2 arguments, but got 1")],
      ["IFS(true, 1)", 1, "number"],
      ["IFS(false, 1, \"default\")", "default", "string"],
      ["IFS(false, 1, true, \"x\")", "x", "string"],
      ["IFS()", bad("IFS takes at least 2 arguments, but got 0")],
      ["IFS(1/0, 1, 2)", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "number"],
      ["SWITCH(\"b\", \"a\", 1, \"b\", 2, 0)", 2, "number"],
      ["SWITCH(\"z\", \"a\", 1, \"b\", 2, 0)", 0, "number"],
      ["SWITCH(\"z\", \"a\", 1, \"b\", 2)", null, "number"],
      ["SWITCH(1, \"1\", \"one\", \"two\")", "one", "string"],
      ["SWITCH(blank, \"\", \"empty\", \"other\")", "empty", "string"],
      ["SWITCH(true, \"yes\", \"y\", \"n\")", "y", "string"],
      ["SWITCH(1, 1)", bad("SWITCH takes at least 3 arguments, but got 2")],
      ["SWITCH(1, 1, \"a\")", "a", "string"],
      ["SWITCH(2, 1, \"a\")", null, "string"],
      ["SWITCH(1, 1/0, \"a\", \"b\")", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "string"],
      ["SWITCH(1, 1, \"a\", 1/0, \"b\")", "a", "string"],
      ["SWITCH(\"B\", \"b\", 1, 2)", 2, "number"],
      ["SWITCH()", bad("SWITCH takes at least 3 arguments, but got 0")],
      ["AND(true, true)", true, "boolean"],
      ["AND(true, false)", false, "boolean"],
      ["AND(true)", true, "boolean"],
      ["AND()", bad("AND takes at least 1 argument, but got 0")],
      ["AND(1, \"yes\", 2)", true, "boolean"],
      ["AND(false, 1/0)", false, "boolean"],
      ["AND(true, 1/0)", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "boolean"],
      ["OR(false, false)", false, "boolean"],
      ["OR(false, true)", true, "boolean"],
      ["OR(true, 1/0)", true, "boolean"],
      ["OR(false, 1/0)", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "boolean"],
      ["OR()", bad("OR takes at least 1 argument, but got 0")],
      ["OR(0, \"\", blank)", false, "boolean"],
      ["AND(prop(\"Due\"))", bad("AND argument 1 must be a true/false value, not a date")],
      ["OR(true, prop(\"Due\"))", bad("OR argument 2 must be a true/false value, not a date")],
      ["NOT(true)", false, "boolean"],
      ["NOT(0)", true, "boolean"],
      ["NOT(\"no\")", true, "boolean"],
      ["NOT(\"\")", true, "boolean"],
      ["NOT(\"abc\")", false, "boolean"],
      ["NOT(blank)", true, "boolean"],
      ["NOT()", bad("NOT takes exactly 1 argument, but got 0")],
      ["NOT(1, 2)", bad("NOT takes exactly 1 argument, but got 2")],
      ["NOT(prop(\"Due\"))", bad("NOT argument 1 must be a true/false value, not a date")],
      ["ISBLANK(blank)", true, "boolean"],
      ["ISBLANK(\"\")", true, "boolean"],
      ["ISBLANK(\" \")", false, "boolean"],
      ["ISBLANK(0)", false, "boolean"],
      ["ISBLANK(false)", false, "boolean"],
      ["ISBLANK(prop(\"Never\"))", true, "boolean"],
      ["ISBLANK(prop(\"Due\"))", false, "boolean"],
      ["ISBLANK()", bad("ISBLANK takes exactly 1 argument, but got 0")],
      ["ISBLANK(1, 2)", bad("ISBLANK takes exactly 1 argument, but got 2")],
      ["ISBLANK(1/0)", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "boolean"],
      ["ISERROR(1/0)", true, "boolean"],
      ["ISERROR(1)", false, "boolean"],
      ["ISERROR(TONUMBER(\"abc\"))", true, "boolean"],
      ["ISERROR(ERROR(\"x\"))", true, "boolean"],
      ["ISERROR()", bad("ISERROR takes exactly 1 argument, but got 0")],
      ["ISERROR(1, 2)", bad("ISERROR takes exactly 1 argument, but got 2")],
      ["IFERROR(1/0, \"none\")", "none", "string"],
      ["IFERROR(5, \"none\")", 5, "string"],
      ["IFERROR(1/0, 1/0)", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "number"],
      ["IFERROR(1/0)", bad("IFERROR takes exactly 2 arguments, but got 1")],
      ["IFERROR(1, 2, 3)", bad("IFERROR takes exactly 2 arguments, but got 3")],
      ["IFERROR(blank, 1)", null, "number"],
      ["IFERROR(1/0, blank)", null, "number"],
      ["COALESCE(blank, \"\", 0, 5)", 0, "string"],
      ["COALESCE(blank, \"\")", null, "string"],
      ["COALESCE(\"a\", 1/0)", "a", "string"],
      ["COALESCE(1/0, \"a\")", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "string"],
      ["COALESCE()", bad("COALESCE takes at least 1 argument, but got 0")],
      ["COALESCE(prop(\"Blank\"), prop(\"Name\"))", "hi", "string"],
      ["COALESCE(blank)", null, "null"],
      ["COALESCE(false, true)", false, "boolean"],
      ["COALESCE(blank, 1, 2)", 1, "number"],
      ["COALESCE(prop(\"Never\"), prop(\"Due\"))", "2026-03-10", "date"],
      ["ERROR()", {"error":"VALUE","message":"Formula raised an error"}, "null"],
      ["ERROR(\"boom\")", {"error":"VALUE","message":"boom"}, "null"],
      ["ERROR(\"\")", {"error":"VALUE","message":"Formula raised an error"}, "null"],
      ["ERROR(5)", {"error":"VALUE","message":"5"}, "null"],
      ["ERROR(blank)", {"error":"VALUE","message":"Formula raised an error"}, "null"],
      ["ERROR(\"a\", \"b\")", bad("ERROR takes between 0 and 1 argument, but got 2")],
      ["IF(false, ERROR(\"x\"), 1)", 1, "number"],
      ["IFERROR(ERROR(\"x\"), \"y\")", "y", "string"],
    ]));
});

describe("math functions", () => {
  test("SUM, AVERAGE, MIN, MAX, ABS, ROUND, ROUNDUP, ROUNDDOWN, FLOOR, CEILING, TRUNC, MOD, POWER, SQRT, SIGN, EXP, LN, LOG10", () =>
    run([
      ["SUM(1, 2, 3)", 6, "number"],
      ["SUM(1)", 1, "number"],
      ["SUM()", bad("SUM takes at least 1 argument, but got 0")],
      ["SUM(0.1, 0.2)", 0.3, "number"],
      ["SUM(true, 2)", 3, "number"],
      ["SUM(blank, 2)", 2, "number"],
      ["SUM(\"1\", 2)", bad("SUM argument 1 must be a number, not text")],
      ["SUM(prop(\"Amount\"), prop(\"Zero\"))", 21, "number"],
      ["SUM(prop(\"Stage\"), 1)", 1, "number"],
      ["SUM(1, prop(\"Due\"))", bad("SUM argument 2 must be a number, not a date")],
      ["AVERAGE(2, 4)", 3, "number"],
      ["AVERAGE(1, 2)", 1.5, "number"],
      ["AVERAGE(5)", 5, "number"],
      ["AVERAGE()", bad("AVERAGE takes at least 1 argument, but got 0")],
      ["AVERAGE(1, blank)", 0.5, "number"],
      ["AVERAGE(0.1, 0.2, 0.3)", 0.2, "number"],
      ["MIN(3, 1, 2)", 1, "number"],
      ["MAX(3, 1, 2)", 3, "number"],
      ["MIN(5)", 5, "number"],
      ["MIN()", bad("MIN takes at least 1 argument, but got 0")],
      ["MAX()", bad("MAX takes at least 1 argument, but got 0")],
      ["MAX(-1, blank)", 0, "number"],
      ["MIN(true, 2)", 1, "number"],
      ["MAX(1e308, 1e308 * 10)", null, "number"],
      ["MIN(-0.5, 0.5)", -0.5, "number"],
      ["ABS(-5)", 5, "number"],
      ["ABS(5)", 5, "number"],
      ["ABS(-0.5)", 0.5, "number"],
      ["ABS()", bad("ABS takes exactly 1 argument, but got 0")],
      ["ABS(1, 2)", bad("ABS takes exactly 1 argument, but got 2")],
      ["ABS(\"5\")", bad("ABS argument 1 must be a number, not text")],
      ["ABS(blank)", 0, "number"],
      ["ABS(true)", 1, "number"],
      ["ABS(prop(\"Due\"))", bad("ABS argument 1 must be a number, not a date")],
      ["ABS(prop(\"Name\"))", bad("ABS argument 1 must be a number, not text")],
      ["ROUND(2.5)", 3, "number"],
      ["ROUND(-2.5)", -3, "number"],
      ["ROUND(2.4)", 2, "number"],
      ["ROUND(2.345, 2)", 2.35, "number"],
      ["ROUND(1.005, 2)", 1.01, "number"],
      ["ROUND(1234.5678, -2)", 1200, "number"],
      ["ROUND(1234.5678, 0)", 1235, "number"],
      ["ROUND(2.5, blank)", 3, "number"],
      ["ROUND(2.5, 0.5)", {"error":"VALUE","message":"Digits must be a whole number"}, "number"],
      ["ROUND(2.55, true)", 2.6, "number"],
      ["ROUND()", bad("ROUND takes between 1 and 2 arguments, but got 0")],
      ["ROUND(1, 2, 3)", bad("ROUND takes between 1 and 2 arguments, but got 3")],
      ["ROUND(0.5)", 1, "number"],
      ["ROUND(-0.4)", 0, "number"],
      ["ROUND(1e21)", 1e+21, "number"],
      ["ROUND(5, 400)", null, "number"],
      ["ROUND(0.1 + 0.2, 15)", 0.3, "number"],
      ["ROUNDUP(2.01)", 3, "number"],
      ["ROUNDUP(-2.01)", -3, "number"],
      ["ROUNDUP(2.1, 1)", 2.1, "number"],
      ["ROUNDUP(2.11, 1)", 2.2, "number"],
      ["ROUNDUP(2)", 2, "number"],
      ["ROUNDUP()", bad("ROUNDUP takes between 1 and 2 arguments, but got 0")],
      ["ROUNDUP(1231, -1)", 1240, "number"],
      ["ROUNDDOWN(2.99)", 2, "number"],
      ["ROUNDDOWN(-2.99)", -2, "number"],
      ["ROUNDDOWN(2.99, 1)", 2.9, "number"],
      ["ROUNDDOWN(2.3, 1)", 2.3, "number"],
      ["ROUNDDOWN()", bad("ROUNDDOWN takes between 1 and 2 arguments, but got 0")],
      ["ROUNDDOWN(1239, -1)", 1230, "number"],
      ["FLOOR(1.5)", 1, "number"],
      ["FLOOR(-1.5)", -2, "number"],
      ["CEILING(1.2)", 2, "number"],
      ["CEILING(-1.5)", -1, "number"],
      ["CEILING(-0.5)", 0, "number"],
      ["TRUNC(1.7)", 1, "number"],
      ["TRUNC(-1.7)", -1, "number"],
      ["FLOOR()", bad("FLOOR takes exactly 1 argument, but got 0")],
      ["CEILING(1, 2)", bad("CEILING takes exactly 1 argument, but got 2")],
      ["TRUNC(\"1\")", bad("TRUNC argument 1 must be a number, not text")],
      ["FLOOR(5)", 5, "number"],
      ["MOD(7, 3)", 1, "number"],
      ["MOD(-7, 3)", -1, "number"],
      ["MOD(7, -3)", 1, "number"],
      ["MOD(5.5, 2)", 1.5, "number"],
      ["MOD(1, 0)", {"error":"DIV_BY_ZERO","message":"Cannot take a remainder by zero"}, "number"],
      ["MOD(1)", bad("MOD takes exactly 2 arguments, but got 1")],
      ["MOD(1, 2, 3)", bad("MOD takes exactly 2 arguments, but got 3")],
      ["MOD(0.3, 0.1)", 0.1, "number"],
      ["MOD(1, blank)", {"error":"DIV_BY_ZERO","message":"Cannot take a remainder by zero"}, "number"],
      ["POWER(2, 10)", 1024, "number"],
      ["POWER(2, -1)", 0.5, "number"],
      ["POWER(4, 0.5)", 2, "number"],
      ["POWER(-8, 1/3)", null, "number"],
      ["POWER(0, 0)", 1, "number"],
      ["POWER(2)", bad("POWER takes exactly 2 arguments, but got 1")],
      ["POWER(10, 400)", null, "number"],
      ["SQRT(16)", 4, "number"],
      ["SQRT(2)", 1.41421356237, "number"],
      ["SQRT(0)", 0, "number"],
      ["SQRT(-1)", {"error":"VALUE","message":"SQRT needs a number that is not negative"}, "number"],
      ["SQRT()", bad("SQRT takes exactly 1 argument, but got 0")],
      ["SIGN(-3)", -1, "number"],
      ["SIGN(0)", 0, "number"],
      ["SIGN(2.5)", 1, "number"],
      ["SIGN()", bad("SIGN takes exactly 1 argument, but got 0")],
      ["EXP(0)", 1, "number"],
      ["EXP(1)", 2.71828182846, "number"],
      ["EXP(1000)", null, "number"],
      ["LN(1)", 0, "number"],
      ["LN(EXP(1))", 1, "number"],
      ["LN(0)", {"error":"VALUE","message":"LN needs a positive number"}, "number"],
      ["LN(-1)", {"error":"VALUE","message":"LN needs a positive number"}, "number"],
      ["LOG10(1000)", 3, "number"],
      ["LOG10(0.001)", -3, "number"],
      ["LOG10(0)", {"error":"VALUE","message":"LOG10 needs a positive number"}, "number"],
      ["LOG10(2)", 0.301029995664, "number"],
      ["LN(10)", 2.30258509299, "number"],
      ["EXP()", bad("EXP takes exactly 1 argument, but got 0")],
      ["LN()", bad("LN takes exactly 1 argument, but got 0")],
      ["LOG10()", bad("LOG10 takes exactly 1 argument, but got 0")],
    ]));
});

describe("text functions", () => {
  test("CONCAT, JOIN, LEN, LOWER, UPPER, TRIM, LEFT, RIGHT, MID, FIND, CONTAINS, STARTSWITH, ENDSWITH, SUBSTITUTE, REPLACE, REPEAT, SPLITPART", () =>
    run([
      ["CONCAT(\"a\", 1, true, blank, \"b\")", "a1trueb", "string"],
      ["CONCAT(1.50)", "1.5", "string"],
      ["CONCAT()", bad("CONCAT takes at least 1 argument, but got 0")],
      ["CONCAT(prop(\"Due\"), \" \", prop(\"When\"))", "2026-03-10 2026-03-10T15:30:45.000Z", "string"],
      ["CONCAT(1/3)", "0.333333333333", "string"],
      ["CONCAT(1e21)", "1e+21", "string"],
      ["CONCAT(0.00000001)", "1e-8", "string"],
      ["CONCAT(1e-7)", "1e-7", "string"],
      ["CONCAT(123456789.123456789)", "123456789.123", "string"],
      ["CONCAT(100)", "100", "string"],
      ["CONCAT(false)", "false", "string"],
      ["CONCAT(2/3, \"|\", 1e20, \"|\", 0.000001)", "0.666666666667|100000000000000000000|0.000001", "string"],
      ["JOIN(\"-\", 1, \"b\", true)", "1-b-true", "string"],
      ["JOIN(\", \", \"a\", blank, \"b\")", "a, , b", "string"],
      ["JOIN(\"\", \"a\", \"b\")", "ab", "string"],
      ["JOIN(\"-\", \"a\")", "a", "string"],
      ["JOIN(\"-\")", bad("JOIN takes at least 2 arguments, but got 1")],
      ["JOIN()", bad("JOIN takes at least 2 arguments, but got 0")],
      ["JOIN(1, 2, 3)", "213", "string"],
      ["LEN(\"hello\")", 5, "number"],
      ["LEN(\"\")", 0, "number"],
      ["LEN(blank)", 0, "number"],
      ["LEN(12345)", 5, "number"],
      ["LEN(true)", 4, "number"],
      ["LEN(\"😀\")", 2, "number"],
      ["LEN(\"é\")", 1, "number"],
      ["LEN(\"e\u0301\")", 2, "number"],
      ["LEN(\"日本語\")", 3, "number"],
      ["LEN(\"🇯🇵\")", 4, "number"],
      ["LEN(\"👨\u200d👩\u200d👧\")", 8, "number"],
      ["LEN()", bad("LEN takes exactly 1 argument, but got 0")],
      ["LEN(\"a\", \"b\")", bad("LEN takes exactly 1 argument, but got 2")],
      ["LEN(prop(\"Due\"))", 10, "number"],
      ["LEN(1/3)", 14, "number"],
      ["LOWER(\"HeLLo\")", "hello", "string"],
      ["UPPER(\"HeLLo\")", "HELLO", "string"],
      ["UPPER(\"straße\")", "STRASSE", "string"],
      ["LOWER(\"İ\")", "i\u0307", "string"],
      ["LOWER(\"ΑΣ\")", "ας", "string"],
      ["UPPER(\"ǆ ﬁ\")", "Ǆ FI", "string"],
      ["TRIM(\"  a b  \")", "a b", "string"],
      ["TRIM(\"\u00a0a\u3000\")", "a", "string"],
      ["TRIM(\"\")", "", "string"],
      ["TRIM(\"\\ta\\n\")", "a", "string"],
      ["LOWER(5)", "5", "string"],
      ["UPPER(true)", "TRUE", "string"],
      ["LOWER()", bad("LOWER takes exactly 1 argument, but got 0")],
      ["TRIM(\"a\", \"b\")", bad("TRIM takes exactly 1 argument, but got 2")],
      ["LEFT(\"hello\")", "h", "string"],
      ["LEFT(\"hello\", 2)", "he", "string"],
      ["LEFT(\"hello\", 0)", "", "string"],
      ["LEFT(\"hello\", 99)", "hello", "string"],
      ["LEFT(\"hello\", 2.9)", "he", "string"],
      ["LEFT(\"hello\", -1)", {"error":"VALUE","message":"Length cannot be negative"}, "string"],
      ["LEFT(\"hello\", blank)", "h", "string"],
      ["LEFT(\"😀a\", 2)", "😀", "string"],
      ["LEFT(\"hello\", \"2\")", bad("LEFT argument 2 must be a number, not text")],
      ["LEFT()", bad("LEFT takes between 1 and 2 arguments, but got 0")],
      ["LEFT(12345, 2)", "12", "string"],
      ["LEFT(\"hello\", true)", "h", "string"],
      ["RIGHT(\"hello\")", "o", "string"],
      ["RIGHT(\"hello\", 2)", "lo", "string"],
      ["RIGHT(\"hello\", 0)", "", "string"],
      ["RIGHT(\"hello\", 99)", "hello", "string"],
      ["RIGHT(\"hello\", -1)", {"error":"VALUE","message":"Length cannot be negative"}, "string"],
      ["RIGHT(\"a😀\", 2)", "😀", "string"],
      ["RIGHT()", bad("RIGHT takes between 1 and 2 arguments, but got 0")],
      ["RIGHT(\"hello\", 1.9)", "o", "string"],
      ["MID(\"abcdef\", 2, 3)", "bcd", "string"],
      ["MID(\"abcdef\", 2)", "bcdef", "string"],
      ["MID(\"abcdef\", 1, 0)", "", "string"],
      ["MID(\"abcdef\", 6, 5)", "f", "string"],
      ["MID(\"abcdef\", 7, 1)", "", "string"],
      ["MID(\"abcdef\", 0, 1)", {"error":"VALUE","message":"MID starts counting at 1"}, "string"],
      ["MID(\"abcdef\", 1.9, 2)", "ab", "string"],
      ["MID(\"abcdef\", 2, -1)", {"error":"VALUE","message":"Length cannot be negative"}, "string"],
      ["MID(\"abcdef\")", bad("MID takes between 2 and 3 arguments, but got 1")],
      ["MID(\"a😀b\", 2, 2)", "😀", "string"],
      ["MID(\"abcdef\", 2, blank)", "bcdef", "string"],
      ["FIND(\"hello\", \"l\")", 3, "number"],
      ["FIND(\"hello\", \"z\")", 0, "number"],
      ["FIND(\"hello\", \"\")", 1, "number"],
      ["FIND(\"\", \"a\")", 0, "number"],
      ["FIND(\"Hello\", \"h\")", 0, "number"],
      ["FIND(\"a😀b\", \"b\")", 4, "number"],
      ["FIND(\"hello\")", bad("FIND takes exactly 2 arguments, but got 1")],
      ["FIND(12345, 3)", 3, "number"],
      ["CONTAINS(\"hello\", \"ell\")", true, "boolean"],
      ["CONTAINS(\"hello\", \"ELL\")", false, "boolean"],
      ["CONTAINS(\"hello\", \"\")", true, "boolean"],
      ["CONTAINS(123, 2)", true, "boolean"],
      ["STARTSWITH(\"hello\", \"he\")", true, "boolean"],
      ["STARTSWITH(\"hello\", \"lo\")", false, "boolean"],
      ["ENDSWITH(\"hello\", \"lo\")", true, "boolean"],
      ["ENDSWITH(\"hello\", \"he\")", false, "boolean"],
      ["CONTAINS(\"a\")", bad("CONTAINS takes exactly 2 arguments, but got 1")],
      ["STARTSWITH(\"a\", \"b\", \"c\")", bad("STARTSWITH takes exactly 2 arguments, but got 3")],
      ["ENDSWITH(blank, \"\")", true, "boolean"],
      ["SUBSTITUTE(\"a-b-c\", \"-\", \"+\")", "a+b+c", "string"],
      ["SUBSTITUTE(\"aaa\", \"a\", \"aa\")", "aaaaaa", "string"],
      ["SUBSTITUTE(\"abc\", \"\", \"x\")", "abc", "string"],
      ["SUBSTITUTE(\"abc\", \"z\", \"x\")", "abc", "string"],
      ["SUBSTITUTE(\"a.b\", \".\", \"\")", "ab", "string"],
      ["SUBSTITUTE(\"abc\", \"b\")", bad("SUBSTITUTE takes exactly 3 arguments, but got 2")],
      ["SUBSTITUTE(12321, 2, 0)", "10301", "string"],
      ["SUBSTITUTE(\"a$b\", \"$\", \"$&\")", "a$&b", "string"],
      ["REPLACE(\"abcdef\", 2, 0, \"X\")", "aXbcdef", "string"],
      ["REPLACE(\"abcdef\", 2, 3, \"X\")", "aXef", "string"],
      ["REPLACE(\"abcdef\", 1, 6, \"\")", "", "string"],
      ["REPLACE(\"abcdef\", 0, 1, \"X\")", "Xbcdef", "string"],
      ["REPLACE(\"abcdef\", -5, 1, \"X\")", "Xbcdef", "string"],
      ["REPLACE(\"abcdef\", 10, 1, \"X\")", "abcdefX", "string"],
      ["REPLACE(\"abcdef\", 2, -1, \"X\")", {"error":"VALUE","message":"Length cannot be negative"}, "string"],
      ["REPLACE(\"abcdef\", 2, 3)", bad("REPLACE takes exactly 4 arguments, but got 3")],
      ["REPLACE(\"abcdef\", 2.9, 1.9, \"X\")", "aXcdef", "string"],
      ["REPEAT(\"ab\", 3)", "ababab", "string"],
      ["REPEAT(\"ab\", 0)", "", "string"],
      ["REPEAT(\"ab\", -1)", {"error":"VALUE","message":"Length cannot be negative"}, "string"],
      ["REPEAT(\"ab\", 1.9)", "ab", "string"],
      ["REPEAT(\"\", 1000000)", "", "string"],
      ["LEN(REPEAT(\"a\", 10000))", 10000, "number"],
      ["REPEAT(\"a\", 10001)", {"error":"VALUE","message":"REPEAT would produce too much text"}, "string"],
      ["REPEAT(\"ab\", 5001)", {"error":"VALUE","message":"REPEAT would produce too much text"}, "string"],
      ["REPEAT(\"ab\")", bad("REPEAT takes exactly 2 arguments, but got 1")],
      ["SPLITPART(\"a,b,c\", \",\", 2)", "b", "string"],
      ["SPLITPART(\"a,b,c\", \",\", 1)", "a", "string"],
      ["SPLITPART(\"a,b,c\", \",\", 3)", "c", "string"],
      ["SPLITPART(\"a,b,c\", \",\", 4)", "", "string"],
      ["SPLITPART(\"a,b,c\", \",\", 0)", "", "string"],
      ["SPLITPART(\"a,b,c\", \",\", -1)", "", "string"],
      ["SPLITPART(\"a,b,c\", \"\", 2)", ",", "string"],
      ["SPLITPART(\"a,b,c\", \";\", 1)", "a,b,c", "string"],
      ["SPLITPART(\"a,b,c\", \",\", 2.9)", "b", "string"],
      ["SPLITPART(\"a,b,c\", \",\")", bad("SPLITPART takes exactly 3 arguments, but got 2")],
    ]));
});

describe("date functions", () => {
  test("DATE, YEAR, MONTH, DAY, HOUR, MINUTE, WEEKDAY, DATEADD, DATESUBTRACT, DATEDIFF, FORMATDATE", () =>
    run([
      ["DATE(2024, 2, 29)", "2024-02-29", "date"],
      ["DATE(2024, 2, 30)", "2024-03-01", "date"],
      ["DATE(2023, 2, 29)", "2023-03-01", "date"],
      ["DATE(2024, 13, 1)", "2025-01-01", "date"],
      ["DATE(2024, 0, 1)", "2023-12-01", "date"],
      ["DATE(2024, 1, 0)", "2023-12-31", "date"],
      ["DATE(99, 1, 1)", "1999-01-01", "date"],
      ["DATE(0, 1, 1)", "1900-01-01", "date"],
      ["DATE(2024.9, 1.9, 1.9)", "2024-01-01", "date"],
      ["DATE(2024, 1)", bad("DATE takes exactly 3 arguments, but got 2")],
      ["DATE(\"2024\", 1, 1)", bad("DATE argument 1 must be a number, not text")],
      ["DATE(1e9, 1, 1)", null, "date"],
      ["DATE(275760, 9, 13)", "275760-09-13", "date"],
      ["DATE(275760, 9, 14)", null, "date"],
      ["DATE(blank, blank, blank)", "1899-11-30", "date"],
      ["DATE(2024, true, true)", "2024-01-01", "date"],
      ["YEAR(\"2026-03-10\")", 2026, "number"],
      ["MONTH(\"2026-03-10\")", 3, "number"],
      ["DAY(\"2026-03-10\")", 10, "number"],
      ["HOUR(\"2026-03-10\")", 0, "number"],
      ["MINUTE(\"2026-03-10\")", 0, "number"],
      ["WEEKDAY(\"2026-03-10\")", 3, "number"],
      ["WEEKDAY(\"2026-03-08\")", 1, "number"],
      ["WEEKDAY(\"2026-03-14\")", 7, "number"],
      ["HOUR(prop(\"When\"))", 15, "number"],
      ["MINUTE(prop(\"When\"))", 30, "number"],
      ["HOUR(\"2026-03-10T23:30:00-05:00\")", 4, "number"],
      ["DAY(\"2026-03-10T23:30:00-05:00\")", 11, "number"],
      ["YEAR(\"\")", {"error":"TYPE","message":"YEAR expects a date"}, "number"],
      ["YEAR(blank)", {"error":"TYPE","message":"YEAR expects a date"}, "number"],
      ["YEAR(\"garbage\")", {"error":"TYPE","message":"YEAR expects a date"}, "number"],
      ["YEAR(5)", bad("YEAR argument 1 must be a date, not a number")],
      ["YEAR(true)", bad("YEAR argument 1 must be a date, not a true/false value")],
      ["YEAR()", bad("YEAR takes exactly 1 argument, but got 0")],
      ["YEAR(\"March 5, 2024\")", 2024, "number"],
      ["MONTH(\"3/5/2024\")", 3, "number"],
      ["YEAR(prop(\"Name\"))", {"error":"TYPE","message":"YEAR expects a date"}, "number"],
      ["YEAR(\"2024\")", 2024, "number"],
      ["MONTH(\"2024-06\")", 6, "number"],
      ["DAY(\"2024-02-30\")", 1, "number"],
      ["MONTH(\"2024-02-30\")", 3, "number"],
      ["YEAR(prop(\"Due\"), 1)", bad("YEAR takes exactly 1 argument, but got 2")],
      ["WEEKDAY(prop(\"Due\"))", 3, "number"],
      ["DAY(\" 2026-03-10 \")", 10, "number"],
      ["DATEADD(\"2026-01-31\", 1, \"month\")", "2026-02-28", "date"],
      ["DATEADD(\"2026-01-31\", 1, \"day\")", "2026-02-01", "date"],
      ["DATEADD(\"2024-01-31\", 1, \"months\")", "2024-02-29", "date"],
      ["DATEADD(\"2024-02-29\", 1, \"year\")", "2025-02-28", "date"],
      ["DATEADD(\"2024-02-29\", 4, \"years\")", "2028-02-29", "date"],
      ["DATEADD(\"2024-03-31\", -1, \"month\")", "2024-02-29", "date"],
      ["DATEADD(\"2024-12-31\", 2, \"mo\")", "2025-02-28", "date"],
      ["DATEADD(\"2026-03-10\", 1.9, \"months\")", "2026-04-10", "date"],
      ["DATEADD(\"2026-03-10\", -1.9, \"months\")", "2026-02-10", "date"],
      ["DATEADD(\"2026-03-10\", 1, \"week\")", "2026-03-17", "date"],
      ["DATEADD(\"2026-03-10\", 2, \"w\")", "2026-03-24", "date"],
      ["DATEADD(\"2026-03-10\", 0.5, \"day\")", "2026-03-10", "date"],
      ["DATEADD(\"2026-03-10\", 25, \"hours\")", "2026-03-11", "date"],
      ["DATEADD(\"2026-03-10T10:00:00Z\", 25, \"h\")", "2026-03-11T11:00:00.000Z", "date"],
      ["DATEADD(\"2026-03-10T10:00:00Z\", 90, \"minutes\")", "2026-03-10T11:30:00.000Z", "date"],
      ["DATEADD(\"2026-03-10T10:00:00Z\", 30, \"s\")", "2026-03-10T10:00:30.000Z", "date"],
      ["DATEADD(\"2026-03-10T10:00:00Z\", 1, \"m\")", "2026-03-10T10:01:00.000Z", "date"],
      ["DATEADD(\"2026-03-10T10:00:00Z\", 1, \"month\")", "2026-04-10T10:00:00.000Z", "date"],
      ["DATEADD(\"2026-03-10T10:00:00Z\", 1.5, \"sec\")", "2026-03-10T10:00:01.500Z", "date"],
      ["DATEADD(\"2026-03-10T10:00:00Z\", 2, \"min\")", "2026-03-10T10:02:00.000Z", "date"],
      ["DATEADD(\"2026-03-10T10:00:00Z\", 1, \"y\")", "2027-03-10T10:00:00.000Z", "date"],
      ["DATEADD(\"2026-03-10T10:00:00Z\", 1, \"d\")", "2026-03-11T10:00:00.000Z", "date"],
      ["DATEADD(\"2026-03-10\", 1, \"D\")", "2026-03-11", "date"],
      ["DATEADD(\"2026-03-10\", 1, \" Days \")", "2026-03-11", "date"],
      ["DATEADD(\"2026-03-10\", 1, \"fortnight\")", {"error":"VALUE","message":"DATEADD does not know the unit \"fortnight\". Use days, weeks, months, years, hours, minutes or seconds."}, "date"],
      ["DATEADD(\"2026-03-10\", 1, \"\")", {"error":"VALUE","message":"DATEADD does not know the unit \"\". Use days, weeks, months, years, hours, minutes or seconds."}, "date"],
      ["DATEADD(\"2026-03-10\", 1, blank)", "2026-03-11", "date"],
      ["DATEADD(\"2026-03-10\", blank, \"day\")", "2026-03-10", "date"],
      ["DATEADD(blank, 1, \"day\")", {"error":"TYPE","message":"DATEADD expects a date"}, "date"],
      ["DATEADD(\"x\", 1, \"day\")", {"error":"TYPE","message":"DATEADD expects a date"}, "date"],
      ["DATEADD(\"2026-03-10\", \"1\", \"day\")", bad("DATEADD argument 2 must be a number, not text")],
      ["DATEADD(\"2026-03-10\", 1)", bad("DATEADD takes exactly 3 arguments, but got 2")],
      ["DATEADD(\"2026-03-10\", 1, 5)", {"error":"VALUE","message":"DATEADD does not know the unit \"5\". Use days, weeks, months, years, hours, minutes or seconds."}, "date"],
      ["DATEADD(prop(\"Due\"), 1, \"day\")", "2026-03-11", "date"],
      ["DATEADD(prop(\"When\"), 1, \"year\")", "2027-03-10T15:30:45.000Z", "date"],
      ["DATEADD(5, 1, \"day\")", bad("DATEADD argument 1 must be a date, not a number")],
      ["DATEADD(\"2026-03-10\", true, \"day\")", "2026-03-11", "date"],
      ["DATESUBTRACT(\"2026-03-31\", 1, \"month\")", "2026-02-28", "date"],
      ["DATESUBTRACT(\"2026-03-10\", 10, \"days\")", "2026-02-28", "date"],
      ["DATESUBTRACT(\"2024-02-29\", 1, \"year\")", "2023-02-28", "date"],
      ["DATESUBTRACT(\"2026-03-10\", 1, \"nope\")", {"error":"VALUE","message":"DATESUBTRACT does not know the unit \"nope\". Use days, weeks, months, years, hours, minutes or seconds."}, "date"],
      ["DATESUBTRACT(\"2026-03-10\", 1)", bad("DATESUBTRACT takes exactly 3 arguments, but got 2")],
      ["DATESUBTRACT(blank, 1, \"day\")", {"error":"TYPE","message":"DATESUBTRACT expects a date"}, "date"],
      ["DATESUBTRACT(\"2026-03-10T10:00:00Z\", 36, \"hours\")", "2026-03-08T22:00:00.000Z", "date"],
      ["DATESUBTRACT(\"2026-03-10\", -1, \"week\")", "2026-03-17", "date"],
      ["DATEDIFF(\"2026-01-20\", \"2026-03-15\", \"months\")", 1, "number"],
      ["DATEDIFF(\"2026-03-15\", \"2026-03-10\")", -5, "number"],
      ["DATEDIFF(\"2026-03-10\", \"2026-03-15\")", 5, "number"],
      ["DATEDIFF(\"2026-03-10\", \"2026-03-15\", \"weeks\")", 0, "number"],
      ["DATEDIFF(\"2026-03-10\", \"2026-03-24\", \"w\")", 2, "number"],
      ["DATEDIFF(\"2026-03-10T00:00:00Z\", \"2026-03-10T23:59:59Z\", \"days\")", 0, "number"],
      ["DATEDIFF(\"2026-03-10T00:00:00Z\", \"2026-03-10T23:59:59Z\", \"hours\")", 23, "number"],
      ["DATEDIFF(\"2026-03-10T00:00:00Z\", \"2026-03-10T00:01:30Z\", \"seconds\")", 90, "number"],
      ["DATEDIFF(\"2026-03-10T00:00:00Z\", \"2026-03-10T00:01:30Z\", \"minutes\")", 1, "number"],
      ["DATEDIFF(\"2024-01-31\", \"2024-02-29\", \"months\")", 1, "number"],
      ["DATEDIFF(\"2024-01-31\", \"2024-02-28\", \"months\")", 0, "number"],
      ["DATEDIFF(\"2024-03-31\", \"2024-02-29\", \"months\")", -1, "number"],
      ["DATEDIFF(\"2024-03-31\", \"2024-03-01\", \"months\")", 0, "number"],
      ["DATEDIFF(\"2020-02-29\", \"2024-02-28\", \"years\")", 3, "number"],
      ["DATEDIFF(\"2020-02-29\", \"2024-02-29\", \"years\")", 4, "number"],
      ["DATEDIFF(\"2026-03-10\", \"2025-03-11\", \"years\")", 0, "number"],
      ["DATEDIFF(\"2026-03-10\", \"2025-03-10\", \"y\")", -1, "number"],
      ["DATEDIFF(\"2026-03-10\", \"2026-03-10\")", 0, "number"],
      ["DATEDIFF(\"2026-03-10\", blank)", {"error":"TYPE","message":"DATEDIFF expects a date"}, "number"],
      ["DATEDIFF(blank, \"2026-03-10\")", {"error":"TYPE","message":"DATEDIFF expects a date"}, "number"],
      ["DATEDIFF(\"2026-03-10\")", bad("DATEDIFF takes between 2 and 3 arguments, but got 1")],
      ["DATEDIFF(\"2026-03-10\", \"2026-03-15\", \"nope\")", {"error":"VALUE","message":"DATEDIFF does not know the unit \"nope\". Use days, weeks, months, years, hours, minutes or seconds."}, "number"],
      ["DATEDIFF(prop(\"Due\"), prop(\"When\"), \"hours\")", 15, "number"],
      ["DATEDIFF(\"2026-03-10\", \"2026-03-15\", \"days\", 1)", bad("DATEDIFF takes between 2 and 3 arguments, but got 4")],
      ["DATEDIFF(\"2026-03-10\", \"2027-06-09\", \"mo\")", 14, "number"],
      ["DATEDIFF(\"2026-03-10T12:00:00Z\", \"2026-03-09T11:00:00Z\", \"days\")", -1, "number"],
      ["DATEDIFF(\"2026-03-10\", 5)", bad("DATEDIFF argument 2 must be a date, not a number")],
      ["FORMATDATE(\"2026-07-04\", \"DD/MM/YYYY\")", "04/07/2026", "string"],
      ["FORMATDATE(\"2026-07-04T05:06:07Z\", \"YYYY-MM-DD HH:mm:ss\")", "2026-07-04 05:06:07", "string"],
      ["FORMATDATE(\"2026-07-04\", \"YY\")", "26", "string"],
      ["FORMATDATE(\"2026-07-04\", \"YYYYY\")", "2026Y", "string"],
      ["FORMATDATE(\"2026-07-04\", \"D M Y h s\")", "D M Y h s", "string"],
      ["FORMATDATE(\"2026-07-04\", \"\")", "", "string"],
      ["FORMATDATE(\"2026-07-04\", \"MMMM DDD\")", "0707 04D", "string"],
      ["FORMATDATE(\"2026-07-04\", 5)", "5", "string"],
      ["FORMATDATE(blank, \"YYYY\")", {"error":"TYPE","message":"FORMATDATE expects a date"}, "string"],
      ["FORMATDATE(\"2026-07-04\")", bad("FORMATDATE takes exactly 2 arguments, but got 1")],
      ["FORMATDATE(\"0005-07-04\", \"YYYY YY\")", "5 05", "string"],
      ["FORMATDATE(prop(\"When\"), \"HH:mm\")", "15:30", "string"],
      ["FORMATDATE(\"2026-07-04T23:30:00-05:00\", \"DD HH\")", "05 04", "string"],
    ]));

  test("NOW is the current moment and TODAY the current day in UTC", async () => {
    const before = Date.now();
    const now = await evaluate(owner, sheet, "NOW()");
    const after = Date.now();
    expect(now).toEqual({ value: expect.stringMatching(ISO), type: "date" });
    const moment = Date.parse((now as { value: string }).value);
    expect(moment).toBeGreaterThanOrEqual(before - 1000);
    expect(moment).toBeLessThanOrEqual(after + 1000);
    const today = (await evaluate(owner, sheet, "TODAY()")) as { value: string; type: string };
    expect(today.type).toBe("date");
    expect(today.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Around midnight the day may be either of two.
    expect([new Date(before).toISOString().slice(0, 10), new Date(Date.now()).toISOString().slice(0, 10)]).toContain(today.value);
    expect(await evaluate(owner, sheet, "TODAY() <= NOW()")).toEqual({ value: true, type: "boolean" });
    expect(await evaluate(owner, sheet, 'DATEDIFF(TODAY(), NOW(), "days")')).toEqual({ value: 0, type: "number" });
    expect(await evaluate(owner, sheet, "HOUR(TODAY()) + MINUTE(TODAY())")).toEqual({ value: 0, type: "number" });
    expect(await evaluate(owner, sheet, "now() = NOW()")).toEqual({ value: true, type: "boolean" });
    expect(await evaluate(owner, sheet, "NOW(1)")).toEqual({ error: "NOW takes exactly 0 arguments, but got 1" });
    expect(await evaluate(owner, sheet, 'TODAY("x")')).toEqual({ error: "TODAY takes exactly 0 arguments, but got 1" });
  });

  test("one moment is used for every row when a formula is filled in", async () => {
    const base = await createBase(owner, spaceId, { title: "Now" });
    await addRow(owner, base.id);
    await addRow(owner, base.id);
    const now = await addProperty(owner, base.id, "Now", "formula", { source: "NOW()" });
    const values = (await allRows(owner, base.id)).map((r) => r.cells[now.id]);
    expect(values).toHaveLength(3);
    expect(new Set(values).size).toBe(1);
    // A new row gets its own moment; the old rows keep theirs.
    await Bun.sleep(5);
    const later = await addRow(owner, base.id);
    expect(Date.parse(later.cells[now.id] as string)).toBeGreaterThan(Date.parse(values[0] as string));
    expect((await allRows(owner, base.id)).slice(0, 3).map((r) => r.cells[now.id])).toEqual(values);
  });

  test("created time and last edited time read as the row's timestamps", async () => {
    const base = await createBase(owner, spaceId, { title: "Timestamps" });
    await emptyBase(owner, base.id);
    await addProperty(owner, base.id, "Created", "createdAt");
    await addProperty(owner, base.id, "Edited", "lastEditedAt");
    const note = await addProperty(owner, base.id, "Note", "text");
    const row = await addRow(owner, base.id);
    await t.sql`UPDATE base_rows SET created_at = '2026-01-05T10:00:00.123Z', updated_at = '2026-01-06T11:30:00.456Z' WHERE id = ${row.id}`;
    const created = await addProperty(owner, base.id, "C", "formula", { source: 'prop("Created")' });
    const edited = await addProperty(owner, base.id, "E", "formula", { source: 'prop("Edited")' });
    const age = await addProperty(owner, base.id, "Age", "formula", { source: 'DATEDIFF(prop("Created"), prop("Edited"), "minutes") & " " & YEAR(prop("Created"))' });
    expect([created, edited].map((p) => p.options.resultType)).toEqual(["date", "date"]);
    expect((await getRow(owner, base.id, row.id)).cells).toEqual({ [created.id]: "2026-01-05T10:00:00.123Z", [edited.id]: "2026-01-06T11:30:00.456Z", [age.id]: "1530 2026" });
    // A new row: the formulas see the time of the request, a moment after the row's own timestamps.
    const fresh = await addRow(owner, base.id);
    for (const id of [created.id, edited.id]) {
      expect(fresh.cells[id]).toMatch(ISO);
      expect(Math.abs(Date.parse(fresh.cells[id] as string) - Date.parse(fresh.createdAt))).toBeLessThan(5000);
    }
    // Accident: a formula over the last edited time is not recomputed when the row is edited.
    const updated = await updateRow(owner, base.id, row.id, { [note.id]: "edited" });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse("2026-01-06T11:30:00.456Z"));
    expect(updated.cells[edited.id]).toBe("2026-01-06T11:30:00.456Z");
  });
});

describe("conversion functions", () => {
  test("TONUMBER, TOTEXT, TOBOOLEAN, TODATE", () =>
    run([
      ["TONUMBER(\"1,234.5\")", 1234.5, "number"],
      ["TONUMBER(\" 12 \")", 12, "number"],
      ["TONUMBER(\"\")", 0, "number"],
      ["TONUMBER(blank)", 0, "number"],
      ["TONUMBER(true)", 1, "number"],
      ["TONUMBER(false)", 0, "number"],
      ["TONUMBER(\"abc\")", {"error":"VALUE","message":"\"abc\" is not a number"}, "number"],
      ["TONUMBER(\"0x10\")", 16, "number"],
      ["TONUMBER(\"1e3\")", 1000, "number"],
      ["TONUMBER(\"Infinity\")", null, "number"],
      ["TONUMBER(\"-Infinity\")", null, "number"],
      ["TONUMBER(\"NaN\")", {"error":"VALUE","message":"\"NaN\" is not a number"}, "number"],
      ["TONUMBER(\"1 2\")", {"error":"VALUE","message":"\"1 2\" is not a number"}, "number"],
      ["TONUMBER(\"12px\")", {"error":"VALUE","message":"\"12px\" is not a number"}, "number"],
      ["TONUMBER(5)", 5, "number"],
      ["TONUMBER(prop(\"Due\"))", 1773100800000, "number"],
      ["TONUMBER(prop(\"When\"))", 1773156645000, "number"],
      ["TONUMBER()", bad("TONUMBER takes exactly 1 argument, but got 0")],
      ["TONUMBER(1, 2)", bad("TONUMBER takes exactly 1 argument, but got 2")],
      ["TONUMBER(\"٣\")", {"error":"VALUE","message":"\"٣\" is not a number"}, "number"],
      ["TONUMBER(\",,1,,\")", 1, "number"],
      ["TONUMBER(\"1.2.3\")", {"error":"VALUE","message":"\"1.2.3\" is not a number"}, "number"],
      ["TOTEXT(1.50)", "1.5", "string"],
      ["TOTEXT(1/3)", "0.333333333333", "string"],
      ["TOTEXT(1e21)", "1e+21", "string"],
      ["TOTEXT(1e-7)", "1e-7", "string"],
      ["TOTEXT(0.0000001234)", "1.234e-7", "string"],
      ["TOTEXT(123456789012345678)", "123456789012345680", "string"],
      ["TOTEXT(true)", "true", "string"],
      ["TOTEXT(blank)", "", "string"],
      ["TOTEXT(\"\")", "", "string"],
      ["TOTEXT(prop(\"Due\"))", "2026-03-10", "string"],
      ["TOTEXT(prop(\"When\"))", "2026-03-10T15:30:45.000Z", "string"],
      ["TOTEXT(\"x\")", "x", "string"],
      ["TOTEXT()", bad("TOTEXT takes exactly 1 argument, but got 0")],
      ["TOTEXT(-0.5)", "-0.5", "string"],
      ["TOTEXT(1e20)", "100000000000000000000", "string"],
      ["TOTEXT(0.1 + 0.2)", "0.3", "string"],
      ["TOTEXT(100 / 3)", "33.3333333333", "string"],
      ["TOTEXT(1/0)", {"error":"DIV_BY_ZERO","message":"Cannot divide by zero"}, "string"],
      ["TOBOOLEAN(\"yes\")", true, "boolean"],
      ["TOBOOLEAN(\"no\")", false, "boolean"],
      ["TOBOOLEAN(\"NO\")", false, "boolean"],
      ["TOBOOLEAN(\" false \")", false, "boolean"],
      ["TOBOOLEAN(\"0\")", false, "boolean"],
      ["TOBOOLEAN(\"\")", false, "boolean"],
      ["TOBOOLEAN(\"x\")", true, "boolean"],
      ["TOBOOLEAN(0)", false, "boolean"],
      ["TOBOOLEAN(2)", true, "boolean"],
      ["TOBOOLEAN(blank)", false, "boolean"],
      ["TOBOOLEAN(prop(\"Due\"))", true, "boolean"],
      ["TOBOOLEAN()", bad("TOBOOLEAN takes exactly 1 argument, but got 0")],
      ["TOBOOLEAN(\"off\")", true, "boolean"],
      ["TOBOOLEAN(\"0.0\")", true, "boolean"],
      ["TOBOOLEAN(true)", true, "boolean"],
      ["TODATE(\"2026-03-10\")", "2026-03-10", "date"],
      ["TODATE(\" 2026-03-10 \")", "2026-03-10", "date"],
      ["TODATE(\"2026-03-10T15:30:45Z\")", "2026-03-10T15:30:45.000Z", "date"],
      ["TODATE(\"2026-03-10T15:30:45+02:00\")", "2026-03-10T13:30:45.000Z", "date"],
      ["TODATE(\"2026-03-10T15:30\")", "2026-03-10T15:30:00.000Z", "date"],
      ["TODATE(0)", "1970-01-01T00:00:00.000Z", "date"],
      ["TODATE(1773156645000)", "2026-03-10T15:30:45.000Z", "date"],
      ["TODATE(blank)", null, "date"],
      ["TODATE(\"\")", null, "date"],
      ["TODATE(\"abc\")", {"error":"VALUE","message":"Cannot read \"abc\" as a date"}, "date"],
      ["TODATE(true)", {"error":"VALUE","message":"Cannot read \"true\" as a date"}, "date"],
      ["TODATE()", bad("TODATE takes exactly 1 argument, but got 0")],
      ["TODATE(prop(\"Due\"))", "2026-03-10", "date"],
      ["TODATE(-1)", "1969-12-31T23:59:59.999Z", "date"],
      ["TODATE(8.64e15)", "+275760-09-13T00:00:00.000Z", "date"],
      ["TODATE(prop(\"Amount\"))", "1970-01-01T00:00:00.021Z", "date"],
    ]));

  /** A text Date.parse cannot read. */
  const UNREADABLE = Symbol("unreadable");
  test("the texts TODATE reads as dates, and the moments they mean", async () => {
    // Texts without a zone are read as UTC; two-digit years below 50 are 20xx; overflowing days roll over.
    const texts: [text: string, result: string | typeof UNREADABLE][] = [
      ["March 5, 2024", "2024-03-05T00:00:00.000Z"],
      ["Mar 5 2024", "2024-03-05T00:00:00.000Z"],
      ["5 March 2024", "2024-03-05T00:00:00.000Z"],
      ["3/5/2024", "2024-03-05T00:00:00.000Z"],
      ["3/5/24", "2024-03-05T00:00:00.000Z"],
      ["3/5", "2001-03-05T00:00:00.000Z"],
      ["2024/03/05", "2024-03-05T00:00:00.000Z"],
      ["2024-3-5", "2024-03-05T00:00:00.000Z"],
      ["2024-03", "2024-03-01T00:00:00.000Z"],
      ["2024", "2024-01-01T00:00:00.000Z"],
      ["12", "2001-12-01T00:00:00.000Z"],
      ["32", "2032-01-01T00:00:00.000Z"],
      ["99", "1999-01-01T00:00:00.000Z"],
      ["0", "2000-01-01T00:00:00.000Z"],
      ["1", "2001-01-01T00:00:00.000Z"],
      ["Mar 5", "2001-03-05T00:00:00.000Z"],
      ["March 2024", "2024-03-01T00:00:00.000Z"],
      ["2024-03-05 10:20", "2024-03-05T10:20:00.000Z"],
      ["2024-03-05T24:00:00Z", "2024-03-06T00:00:00.000Z"],
      ["2024-03-05T10:20:30.123456Z", "2024-03-05T10:20:30.123Z"],
      ["2024-03-05t10:20:30z", "2024-03-05T10:20:30.000Z"],
      ["2024-03-05T10:20Z", "2024-03-05T10:20:00.000Z"],
      ["2024-03-05Z", "2024-03-05T00:00:00.000Z"],
      ["Tue, 05 Mar 2024 10:20:30 GMT", "2024-03-05T10:20:30.000Z"],
      ["Tue Mar 05 2024 10:20:30 GMT+0100 (CET)", "2024-03-05T09:20:30.000Z"],
      ["March 5, 2024 10:20 PM", "2024-03-05T22:20:00.000Z"],
      ["March 5, 2024 10:20:30.5", "2024-03-05T10:20:30.500Z"],
      ["Jan 1 1970 00:00:00 EST", "1970-01-01T05:00:00.000Z"],
      ["Jan 1 1970 00:00:00 PST", "1970-01-01T08:00:00.000Z"],
      ["Jan 1 1970 00:00:00 +0530", "1969-12-31T18:30:00.000Z"],
      ["Jan 1 1970 00:00:00 Z", "1970-01-01T00:00:00.000Z"],
      ["1 Jan 70", "1970-01-01T00:00:00.000Z"],
      ["1 Jan 49", "2049-01-01T00:00:00.000Z"],
      ["1 Jan 50", "1950-01-01T00:00:00.000Z"],
      ["Feb 30 2024", "2024-03-01T00:00:00.000Z"],
      ["2024-02-30", "2024-03-01"],
      ["2023-02-29", "2023-03-01"],
      ["Mar 5 2024 24:00", "2024-03-06T00:00:00.000Z"],
      ["Mar 5 2024 23:59:60", "2024-03-05T23:59:00.000Z"],
      ["12/31/9999", "9999-12-31T00:00:00.000Z"],
      ["1/1/10000", "+010000-01-01T00:00:00.000Z"],
      ["+275760-09-13T00:00:00.000Z", "+275760-09-13T00:00:00.000Z"],
      ["-000001-01-01T00:00:00Z", "-000001-01-01T00:00:00.000Z"],
      ["0000-01-01", "0-01-01"],
      ["0001-01-01", "1-01-01"],
      ["10000-01-01", "+010000-01-01T00:00:00.000Z"],
      ["Mar 5 0024", "2024-03-05T00:00:00.000Z"],
      ["Mar 5 12024", "+012024-03-05T00:00:00.000Z"],
      ["1/1/1", "2001-01-01T00:00:00.000Z"],
      ["-1", "2001-01-01T00:00:00.000Z"],
      ["99999", "+099999-01-01T00:00:00.000Z"],
      ["275760", "+275760-01-01T00:00:00.000Z"],
      ["Sept 5 2024", "2024-09-05T00:00:00.000Z"],
      ["Mar. 5, 2024", "2024-03-05T00:00:00.000Z"],
      ["(note) Mar 5 2024", "2024-03-05T00:00:00.000Z"],
      ["2024 March 5", "2024-03-05T00:00:00.000Z"],
      ["tel:+123", "0123-01-01T00:00:00.000Z"],
      ["3-5-2024", "2024-03-05T00:00:00.000Z"],
      ["05.03.2024", "2024-05-03T00:00:00.000Z"],
      ["13", UNREADABLE],
      ["20240305", UNREADABLE],
      ["today", UNREADABLE],
      ["13/5/2024", UNREADABLE],
      ["5th March 2024", UNREADABLE],
      ["2024-13-01", UNREADABLE],
      ["2024-03-05T25:00:00Z", UNREADABLE],
      ["Jan 1 1970 00:00:00 CET", UNREADABLE],
      ["2024年3月5日", UNREADABLE],
      ["12:30", UNREADABLE],
    ];
    await run(
      texts.map(([text, result]): Case => [
        `TODATE(${JSON.stringify(text)})`,
        result === UNREADABLE ? { error: "VALUE", message: `Cannot read "${text}" as a date` } : result,
        "date",
      ]),
    );
  });
});

describe("results the evaluator stumbles on", () => {
  test("numbers and dates out of range", () =>
    run([
      // Accident: a repeat count of infinity, and a date-time too far out to print, raise an error the evaluator
      // reports as nesting that is too deep.
      ['REPEAT("", 1e309)', { error: "DEPTH", message: "Formula is too deeply nested" }, "string"],
      ['DATEADD("2026-03-10T00:00:00Z", 1e20, "days")', { error: "DEPTH", message: "Formula is too deeply nested" }, "date"],
      ["TODATE(8.64e15 + 1)", { error: "DEPTH", message: "Formula is too deeply nested" }, "date"],
      // Accident: a date without a time that is too far out prints as NaN.
      ['DATEADD("2026-03-10", 1e20, "days")', "NaN-NaN-NaN", "date"],
      // Accident: years outside 1000 to 9999 are printed without padding in dates that have no time.
      ["DATE(-1, 1, 1)", "-1-01-01", "date"],
      ["DATE(10000, 1, 1)", "10000-01-01", "date"],
      ['TODATE("0001-01-01")', "1-01-01", "date"],
    ]));

  test("a result with half an emoji cannot be stored: the formula cannot be added, or rows cannot", async () => {
    const withRow = await createBase(owner, spaceId, { title: "Half an emoji" });
    // Accident: LEFT counts UTF-16 units, the cut leaves half a character, and the database refuses it.
    const failed = await owner.post(`/bases/${withRow.id}/properties`, { name: "Half", type: "formula", options: { source: 'LEFT("😀", 1)' } });
    expectError(failed, 500, "internal_error", "Something went wrong");
    expect((await getBase(owner, withRow.id)).properties).toEqual(withRow.properties);
    const withoutRows = await createBase(owner, spaceId, { title: "Half an emoji, no rows" });
    await emptyBase(owner, withoutRows.id);
    await addProperty(owner, withoutRows.id, "Half", "formula", { source: 'LEFT("😀", 1)' });
    expectError(await owner.post(`/bases/${withoutRows.id}/rows`, {}), 500, "internal_error", "Something went wrong");
    expect(await allRows(owner, withoutRows.id)).toEqual([]);
  });
});

describe("formula properties", () => {
  test("the server derives the result type and the dependencies; of the options sent it keeps the source and formatOptions", async () => {
    const base = await createBase(owner, spaceId, { title: "Options" });
    const a = await addProperty(owner, base.id, "A", "number");
    const b = await addProperty(owner, base.id, "B", "text");
    const created = await owner.post(`/bases/${base.id}/properties`, {
      name: "F",
      type: "formula",
      options: {
        source: 'IF(prop("A") > 0, prop("B"), prop("b") & prop("A"))',
        resultType: "date",
        dependencies: ["nope"],
        formatOptions: { format: "percent", precision: 1, anything: [1, 2] },
        format: "currency",
        choices: [{ id: "x", name: "X" }],
        custom: true,
      },
    });
    expect(created.status).toBe(200);
    expect(created.body.data.options).toEqual({
      source: 'IF(prop("A") > 0, prop("B"), prop("b") & prop("A"))',
      resultType: "string",
      // In the order of their first mention, once each.
      dependencies: [a.id, b.id],
      formatOptions: { format: "percent", precision: 1, anything: [1, 2] },
    });
    const id = created.body.data.id as string;
    // formatOptions that are not an object are dropped; an update replaces the options whole.
    expect((await updateProperty(owner, base.id, id, { options: { source: "1", formatOptions: "percent" } })).options).toEqual({ source: "1", resultType: "number", dependencies: [] });
    expect((await updateProperty(owner, base.id, id, { options: { source: "1", formatOptions: [1] } })).options).toEqual({ source: "1", resultType: "number", dependencies: [] });
    expect((await updateProperty(owner, base.id, id, { options: { source: 'prop("B")', formatOptions: {} } })).options).toEqual({
      source: 'prop("B")',
      resultType: "string",
      dependencies: [b.id],
      formatOptions: {},
    });
    // Without options the formula stays as it is.
    expect((await updateProperty(owner, base.id, id, { name: "Renamed" })).options).toEqual({ source: 'prop("B")', resultType: "string", dependencies: [b.id], formatOptions: {} });
  });

  test("a formula needs a source that is a text", async () => {
    const base = await createBase(owner, spaceId, { title: "Sources" });
    for (const options of [undefined, null, {}, "1 + 1", 5, ["1"], { source: 5 }, { source: null }, { source: ["1"] }, { source: "" }, { Source: "1" }]) {
      expectInvalid(await owner.post(`/bases/${base.id}/properties`, { name: "F", type: "formula", options }), "Formula is empty");
    }
    const f = await addProperty(owner, base.id, "F", "formula", { source: "1" });
    for (const options of [null, {}, "2", { source: 2 }]) {
      expectInvalid(await owner.post(`/bases/${base.id}/properties/${f.id}/update`, { options }), "Formula is empty");
    }
    expectInvalid(await owner.post(`/bases/${base.id}/properties/${f.id}/update`, { options: { source: "1 +" } }), "The formula ended unexpectedly");
    expect((await getBase(owner, base.id)).properties.find((p) => p.id === f.id)).toEqual(f);
    // A formula cannot be named like another property, and its name is not a way to refer to itself.
    expectInvalid(await owner.post(`/bases/${base.id}/properties`, { name: "title", type: "formula", options: { source: "1" } }), "A property with this name already exists");
    expectInvalid(await owner.post(`/bases/${base.id}/properties`, { name: "Self", type: "formula", options: { source: 'prop("Self")' } }), 'No property named "Self"');
    expectInvalid(await owner.post(`/bases/${base.id}/properties/${f.id}/update`, { options: { source: 'prop("F") + 1' } }), 'No property named "F"');
  });

  test("a new formula is filled in for every row; empty results leave the cell empty", async () => {
    const base = await createBase(owner, spaceId, { title: "Backfill" });
    await emptyBase(owner, base.id);
    const n = await addProperty(owner, base.id, "N", "number");
    const rows = [];
    for (const value of [4, 0, null, -3]) rows.push(await addRow(owner, base.id, { [n.id]: value }));
    const f = await addProperty(owner, base.id, "F", "formula", { source: 'IF(ISBLANK(prop("N")), blank, 12 / prop("N"))' });
    const after = await allRows(owner, base.id);
    expect(after.map((r) => r.cells[f.id] ?? null)).toEqual([3, { error: "DIV_BY_ZERO", message: "Cannot divide by zero" }, null, -4]);
    expect(Object.keys(after[2]!.cells)).toEqual([]);
    // Filling in is not an edit of the rows.
    expect(after.map((r) => [r.updatedAt, r.lastEditorId])).toEqual(rows.map((r) => [r.updatedAt, r.lastEditorId]));
    // Changing the source fills in again, and a result that becomes empty clears the cell.
    await updateProperty(owner, base.id, f.id, { options: { source: 'IF(prop("N") > 0, "positive")' } });
    expect((await allRows(owner, base.id)).map((r) => r.cells[f.id] ?? null)).toEqual(["positive", null, null, null]);
  });

  test("formulas over formulas are recomputed along the chain, when a cell, a source or a type changes", async () => {
    const base = await createBase(owner, spaceId, { title: "Chain" });
    await emptyBase(owner, base.id);
    const n = await addProperty(owner, base.id, "N", "number");
    const a = await addProperty(owner, base.id, "A", "formula", { source: 'prop("N") + 1' });
    const b = await addProperty(owner, base.id, "B", "formula", { source: 'prop("A") * 10' });
    const c = await addProperty(owner, base.id, "C", "formula", { source: 'prop("B") & "!" & prop("N")' });
    const other = await addProperty(owner, base.id, "Other", "formula", { source: "NOW()" });
    expect([a, b, c].map((p) => [p.options.resultType, p.options.dependencies])).toEqual([
      ["number", [n.id]],
      ["number", [a.id]],
      ["string", [b.id, n.id]],
    ]);
    const row = await addRow(owner, base.id, { [n.id]: 1 });
    const stamp = row.cells[other.id];
    expect(row.cells).toEqual({ [n.id]: 1, [a.id]: 2, [b.id]: 20, [c.id]: "20!1", [other.id]: stamp });
    // A cell changes: the whole chain follows; a formula that does not depend on it is left alone.
    const updated = await updateRow(owner, base.id, row.id, { [n.id]: 2 });
    expect(updated.cells).toEqual({ [n.id]: 2, [a.id]: 3, [b.id]: 30, [c.id]: "30!2", [other.id]: stamp });
    // The source of the first formula changes: those over it follow.
    await updateProperty(owner, base.id, a.id, { options: { source: 'prop("N") * 100' } });
    expect((await getRow(owner, base.id, row.id)).cells).toEqual({ [n.id]: 2, [a.id]: 200, [b.id]: 2000, [c.id]: "2000!2", [other.id]: stamp });
    // The result type of the middle one changes: the stored type of the last one is not derived again, its value is.
    const retyped = await updateProperty(owner, base.id, b.id, { options: { source: 'prop("A") & " units"' } });
    expect(retyped.options).toEqual({ source: 'prop("A") & " units"', resultType: "string", dependencies: [a.id] });
    expect((await getRow(owner, base.id, row.id)).cells).toEqual({ [n.id]: 2, [a.id]: 200, [b.id]: "200 units", [c.id]: "200 units!2", [other.id]: stamp });
    // A formula may not be made to depend on itself through others.
    expectInvalid(await owner.post(`/bases/${base.id}/properties/${a.id}/update`, { options: { source: 'prop("C")' } }), "Formula would create a circular reference");
    expectInvalid(await owner.post(`/bases/${base.id}/properties/${a.id}/update`, { options: { source: 'IF(false, prop("B"), 1)' } }), "Formula would create a circular reference");
    expectInvalid(await owner.post(`/bases/${base.id}/properties/${b.id}/update`, { options: { source: 'prop("N") + LEN(prop("C"))' } }), "Formula would create a circular reference");
    expect((await getRow(owner, base.id, row.id)).cells[c.id]).toBe("200 units!2");
  });

  test("members are told that rows changed only when a new source changes some result", async () => {
    const base = await createBase(owner, spaceId, { title: "Formula events" });
    const f = await addProperty(owner, base.id, "F", "formula", { source: "1 + 1" });
    const socket = await connect(owner);
    await updateProperty(owner, base.id, f.id, { options: { source: "4 / 2" } });
    await updateProperty(owner, base.id, f.id, { options: { source: "2 + 1" }, requestId: "f-1" });
    const first = await nextBaseEvent(socket, base.id);
    expect(first.event).toMatchObject({ op: "base" });
    expect(first.requestId).toBeUndefined();
    // No rowsChanged for the first update: the next event is the base of the second one.
    const second = await nextBaseEvent(socket, base.id);
    expect(second).toMatchObject({ event: { op: "base" }, requestId: "f-1" });
    expect(second.event.base.properties.find((p: { id: string }) => p.id === f.id).options.source).toBe("2 + 1");
    expect(await nextBaseEvent(socket, base.id)).toEqual({ t: "event", kind: "base", pageId: base.id, spaceId, event: { op: "rowsChanged" } });
    await socket.close();
  });

  test("renaming a property keeps the formulas over it working, whatever the new name holds", async () => {
    const base = await createBase(owner, spaceId, { title: "Renames" });
    await emptyBase(owner, base.id);
    const n = await addProperty(owner, base.id, "N", "number");
    const f = await addProperty(owner, base.id, "F", "formula", { source: 'prop("N") + prop( "n" ) & "N"' });
    const g = await addProperty(owner, base.id, "G", "formula", { source: 'prop("F") & "?"' });
    const row = await addRow(owner, base.id, { [n.id]: 1 });
    const source = async (id: string) => (await getBase(owner, base.id)).properties.find((p) => p.id === id)!.options.source;
    for (const name of ['Say "hi"', "back\\slash", "new\nline and\ttab", "é 日本語 😀", "'single'"]) {
      await updateProperty(owner, base.id, n.id, { name });
      const quoted = JSON.stringify(name);
      expect(await source(f.id)).toBe(`prop(${quoted}) + prop( ${quoted} ) & "N"`);
      expect((await getRow(owner, base.id, row.id)).cells).toEqual({ [n.id]: 1, [f.id]: "2N", [g.id]: "2N?" });
    }
    // Renaming a formula rewrites the formulas over it too.
    await updateProperty(owner, base.id, f.id, { name: "Sum" });
    expect(await source(g.id)).toBe('prop("Sum") & "?"');
    await updateRow(owner, base.id, row.id, { [n.id]: 5 });
    expect((await getRow(owner, base.id, row.id)).cells).toEqual({ [n.id]: 5, [f.id]: "10N", [g.id]: "10N?" });
  });

  test("renaming a property to a name with a carriage return breaks the formulas over it", async () => {
    const base = await createBase(owner, spaceId, { title: "Broken rename" });
    await emptyBase(owner, base.id);
    const n = await addProperty(owner, base.id, "N", "number");
    const f = await addProperty(owner, base.id, "F", "formula", { source: 'prop("N") + 1' });
    const row = await addRow(owner, base.id, { [n.id]: 1 });
    await updateProperty(owner, base.id, n.id, { name: "A\rB" });
    // Accident: the name is written into the source with an escape the formula language does not have.
    expect((await getBase(owner, base.id)).properties.find((p) => p.id === f.id)!.options.source).toBe('prop("A\\rB") + 1');
    expect((await getRow(owner, base.id, row.id)).cells).toEqual({ [n.id]: 1, [f.id]: MISSING });
    // Later renames no longer find the reference, so the formula stays broken until its source is fixed.
    await updateProperty(owner, base.id, n.id, { name: "Plain" });
    expect((await getBase(owner, base.id)).properties.find((p) => p.id === f.id)!.options.source).toBe('prop("A\\rB") + 1');
    await updateProperty(owner, base.id, f.id, { options: { source: 'prop("Plain") + 1' } });
    expect((await getRow(owner, base.id, row.id)).cells).toEqual({ [n.id]: 1, [f.id]: 2 });
  });

  test("a formula over a property converted to a type it cannot use reads as if the property were deleted", async () => {
    const base = await createBase(owner, spaceId, { title: "Converted dependency" });
    await emptyBase(owner, base.id);
    const n = await addProperty(owner, base.id, "N", "number");
    const f = await addProperty(owner, base.id, "F", "formula", { source: 'prop("N") * 2' });
    const row = await addRow(owner, base.id, { [n.id]: 4 });
    await updateProperty(owner, base.id, n.id, { type: "text" });
    // Accident: the formula no longer type-checks, which is reported with the message of a deleted property.
    expect((await getRow(owner, base.id, row.id)).cells).toEqual({ [n.id]: "4", [f.id]: MISSING });
    expect((await getBase(owner, base.id)).properties.find((p) => p.id === f.id)).toEqual(f);
    await updateProperty(owner, base.id, n.id, { type: "number" });
    expect((await getRow(owner, base.id, row.id)).cells).toEqual({ [n.id]: 4, [f.id]: 8 });
    await updateProperty(owner, base.id, n.id, { type: "checkbox" });
    expect((await getRow(owner, base.id, row.id)).cells).toEqual({ [n.id]: true, [f.id]: 2 });
  });

  test("a deleted property that comes back under the same name does not revive the formulas by itself", async () => {
    const base = await createBase(owner, spaceId, { title: "Same name again" });
    await emptyBase(owner, base.id);
    const n = await addProperty(owner, base.id, "N", "number");
    const f = await addProperty(owner, base.id, "F", "formula", { source: 'prop("N") + 1' });
    const row = await addRow(owner, base.id, { [n.id]: 1 });
    ok(await owner.post(`/bases/${base.id}/properties/${n.id}/delete`, {}));
    expect((await getRow(owner, base.id, row.id)).cells).toEqual({ [f.id]: MISSING });
    const again = await addProperty(owner, base.id, "N", "number");
    // The formula still lists the old property as its dependency, so a value in the new one does not reach it…
    expect((await updateRow(owner, base.id, row.id, { [again.id]: 5 })).cells).toEqual({ [again.id]: 5, [f.id]: MISSING });
    // …but a new row computes every formula by name, and saving the source again repairs the old rows.
    expect((await addRow(owner, base.id, { [again.id]: 9 })).cells).toEqual({ [again.id]: 9, [f.id]: 10 });
    const saved = await updateProperty(owner, base.id, f.id, { options: { source: 'prop("N") + 1' } });
    expect(saved.options.dependencies).toEqual([again.id]);
    expect((await getRow(owner, base.id, row.id)).cells).toEqual({ [again.id]: 5, [f.id]: 6 });
  });

  test("a chain of formulas may be 16 long when one formula is filled in", async () => {
    const base = await createBase(owner, spaceId, { title: "Deep chain" });
    const [seed] = await allRows(owner, base.id);
    const ids: string[] = [(await addProperty(owner, base.id, "F1", "formula", { source: "1" })).id];
    for (let i = 2; i <= 17; i++) ids.push((await addProperty(owner, base.id, `F${i}`, "formula", { source: `prop("F${i - 1}") + 1` })).id);
    const filled = (await getRow(owner, base.id, seed!.id)).cells;
    expect(ids.slice(0, 16).map((id) => filled[id])).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(filled[ids[16]!]).toEqual({ error: "DEPTH", message: "Formulas are nested too deeply" });
    // Accident: when all formulas of a row are computed together, each result is reused by the next, so the
    // same chain has no limit for a new row.
    const fresh = await addRow(owner, base.id);
    expect(ids.map((id) => fresh.cells[id])).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
  });

  test("formulas that refer to each other in a loop evaluate to an error", async () => {
    const base = await createBase(owner, spaceId, { title: "Loop" });
    await emptyBase(owner, base.id);
    const a = await addProperty(owner, base.id, "A", "formula", { source: "1" });
    const b = await addProperty(owner, base.id, "B", "formula", { source: 'prop("A") + 1' });
    // The API refuses to create a loop; stored formulas whose list of dependencies hides one can only be written directly.
    await t.sql`UPDATE base_properties SET options = ${{ source: 'prop("B") + 1', resultType: "number", dependencies: [] }}::jsonb WHERE page_id = ${base.id} AND id = ${a.id}`;
    await t.sql`UPDATE base_properties SET options = ${{ source: 'prop("A") + 1', resultType: "number", dependencies: [] }}::jsonb WHERE page_id = ${base.id} AND id = ${b.id}`;
    const loop = { error: "CYCLE", message: "Formulas reference each other in a loop" };
    expect((await addRow(owner, base.id)).cells).toEqual({ [a.id]: loop, [b.id]: loop });
  });
});
