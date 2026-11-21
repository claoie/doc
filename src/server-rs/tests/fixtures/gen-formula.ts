// Writes formula.json: what common/formula.ts compiles and computes, for
// tests/formula.rs to hold common/formula.rs to.
//
//   bun src/server-rs/tests/fixtures/gen-formula.ts
//
// For a longer run of random expressions than the repository should carry:
//
//   bun src/server-rs/tests/fixtures/gen-formula.ts --extra <seed> <count> <file>
//   FORMULA_EXTRA=<file> cargo test -p doc-server --test formula -- --ignored
//
// Outcomes are text so they compare exactly. A compilation is
// `<resultType>|<dependency ids>` or `!<message>[@start,end]`; a computed
// value is its JSON. Text that JavaScript cut in the middle of a surrogate
// pair cannot exist in Rust; where that happened on the way to a value (the
// script watches the string methods that cut), the outcome is written as `~`
// and the port is only required to answer something. Outcomes repeat a lot,
// so cases refer to them by index into one table.
import path from "node:path";
import type { Property, PropertyOptions } from "common/bases";
import { FUNCTIONS, FormulaSyntaxError, affectedFormulas, compileFormula, computeFormulas, isErrorValue, renameInSource } from "common/formula";
import { enc, int, pick, seeded } from "./rng";

// Dates without an offset are local time; the fixtures are made with UTC as the local zone.
process.env.TZ = "UTC";
if (new Date(0).getTimezoneOffset() !== 0 || new Date(Date.UTC(2024, 6, 1)).getTimezoneOffset() !== 0) throw new Error("could not make UTC the local zone");

const NOW = Date.parse("2026-03-10T12:00:00Z");

// ---------------------------------------------------------------------------
// Encoding

const encode = (value: unknown): unknown => {
  if (typeof value === "number") return { $n: enc(value) };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return { $o: Object.entries(value).map(([k, v]) => [k, encode(v)]) };
  return value;
};
const wellFormed = (value: unknown): boolean => {
  if (typeof value === "string") return value.isWellFormed();
  if (Array.isArray(value)) return value.every(wellFormed);
  if (value && typeof value === "object") return Object.values(value).every(wellFormed);
  return true;
};
const outcomes: string[] = [];
const outcomeIndex = new Map<string, number>();
const intern = (text: string): number => {
  let index = outcomeIndex.get(text);
  if (index === undefined) {
    index = outcomes.length;
    outcomes.push(text);
    outcomeIndex.set(text, index);
  }
  return index;
};
// Half characters. `slice`, `substr` and `split` are the methods the formula
// code cuts text with; each is wrapped to notice when it makes ill-formed
// text out of well-formed text. `computed` runs a computation and answers
// `~` if that happened anywhere in it, even where the final value hides it
// (the length of a text with half a character in it, say).
let halved = false;
for (const name of ["slice", "substr", "split"] as const) {
  const original = String.prototype[name] as (this: string, ...args: unknown[]) => unknown;
  Object.defineProperty(String.prototype, name, {
    value(this: string, ...args: unknown[]) {
      const result = original.apply(this, args);
      if (!halved && !wellFormed(result) && this.isWellFormed()) halved = true;
      return result;
    },
  });
}
const computed = (compute: () => unknown): string => {
  halved = false;
  const value = compute();
  return halved || !wellFormed(value) ? "~" : JSON.stringify(value);
};

// ---------------------------------------------------------------------------
// Properties and rows

/** A property; the type and the options need not be ones the TypeScript types allow. */
const prop = (id: string, name: string, type: string, options: Record<string, unknown> = {}): Property => ({ id, name, type: type as Property["type"], options: options as PropertyOptions, isPrimary: false, position: id });
/** A property as the fixture writes it: `[id, name, type, options]`. */
const compact = (p: Property) => [p.id, p.name, p.type, p.options];
const compileOutcome = (source: string, props: Property[], selfId: string | null): { text: string; options: PropertyOptions } => {
  try {
    const c = compileFormula(source, props, selfId);
    return { text: `${c.resultType}|${c.dependencies.join(",")}`, options: { source, resultType: c.resultType, dependencies: c.dependencies } };
  } catch (e) {
    if (!(e instanceof FormulaSyntaxError)) return { text: `!!${(e as Error).constructor.name}: ${(e as Error).message}`, options: { source } };
    const text = `!${e.message}${e.span ? `@${e.span.start},${e.span.end}` : ""}`;
    return { text: text.isWellFormed() ? text : "~", options: { source } };
  }
};
const choices = [{ id: "x", name: "X", color: "gray" }, { id: "y", name: "Y", color: "red" }];
const BASE: Property[] = [
  prop("n", "Amount", "number"),
  prop("n2", "Rate", "number"),
  prop("t", "Name", "text"),
  prop("t2", "Notes", "longText"),
  prop("d", "Due", "date"),
  prop("d2", "Start", "date"),
  prop("c", "Done", "checkbox"),
  prop("s", "Stage", "select", { choices }),
  prop("ms", "Tags", "multiSelect", { choices }),
  prop("p", "Owner", "person"),
  prop("u", "Link", "url"),
  prop("e", "Mail", "email"),
  prop("fl", "Files", "file"),
  prop("pg", "Page", "page"),
  prop("ca", "Created", "createdAt"),
  prop("le", "Edited", "lastEditedAt"),
  prop("lb", "Editor", "lastEditedBy"),
  prop("x", " Spaced  Name ", "number"),
  prop("q", 'Quote "q"', "text"),
  prop("tw1", "Twin", "number"),
  prop("tw2", "twin", "text"),
  prop("tw3", "TWIN ", "checkbox"),
  prop("uni", "Ärger 😀", "text"),
];
for (const [id, name, source] of [
  ["fn", "Total", 'prop("Amount") * 2'],
  ["ft", "Label", 'prop("Name") & "!"'],
  ["fd", "Later", 'DATEADD(prop("Due"), 1, "day")'],
  ["fb", "Big", 'prop("Amount") > 10'],
  ["fe", "Broken", '1 / (prop("Amount") - prop("Amount"))'],
  ["fz", "Nothing", "null"],
  ["ff", "Twice", 'prop("Total") + prop("Total")'],
] as const) {
  BASE.push(prop(id, name, "formula", compileOutcome(source, BASE, id).options));
}

interface Row {
  cells: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
const META = { createdAt: "2026-01-05T10:00:00.000Z", updatedAt: "2026-01-06T10:00:00.000Z" };
const emoji = "😀";
const ROWS: Row[] = [
  { cells: { n: 21, n2: 0.5, t: "hi", t2: "long\ntext", d: "2026-01-31", d2: "2026-01-01T08:30:00Z", c: true, s: "x", ms: ["x"], p: "u1", u: "http://x.y", e: "a@b.c", x: 4, q: "it's", tw1: 2, tw2: "two", tw3: true, uni: "über" }, ...META },
  { cells: {}, ...META },
  { cells: { n: 0, n2: -0.1, t: "", t2: " 12 ", d: "Mar 5 2024", d2: "2024-02-29", c: false, x: -1, q: "", tw1: 0 }, ...META },
  { cells: { n: -7.25, n2: 1e21, t: "abc,def", t2: "ABC", d: "garbage", d2: "2024-03-05T10:00:00", c: "yes", s: "zz", u: "", e: "nope" }, createdAt: "2020-02-29T23:59:59.999Z", updatedAt: "2021-01-01T00:00:00.000Z" },
  { cells: { n: "12", n2: true, t: 5, t2: ["a"], d: 1709632800000, d2: true, c: 1, x: null }, ...META },
  { cells: { n: 1e-7, n2: 123456789.12345679, t: `${emoji} emoji ${emoji}`, t2: "ÀÉÎõü ßΣ", d: "0099-12-31", d2: "+275760-09-13T00:00:00.000Z" }, ...META },
  { cells: { n: 0.1, n2: 0.2, t: "  padded  ", t2: "a-b-c", d: "2024-12-31T23:59:59.999Z", d2: "1970-01-01" }, ...META },
  { cells: { n: 9007199254740993, n2: -0, t: "1,234.5", t2: "true", d: "12", d2: "2024-02-30" }, ...META },
  { cells: { n: 2.5, n2: 3, t: "2024-03-05", t2: "FALSE", d: "2024-03-10T02:30:00", d2: "2023-11-05T01:30:00-04:00", c: true }, ...META },
  { cells: { n: 1e300, n2: -1e300, t: "no", t2: "0", d: "2024-01-31", d2: "2024-03-31" }, createdAt: "garbage", updatedAt: "" },
  { cells: { n: null, n2: null, t: null, d: null, c: null }, ...META },
  { cells: { n: 5e-324, n2: 1.7976931348623157e308, t: " nbsp ", t2: "", d: "-271821-04-20T00:00:00.000Z", d2: "2024-06-15T12:00:00+05:30" }, ...META },
  { cells: { n: 1234.5678, n2: -2, t: "Hello, World", t2: "o", d: "2026-03-10", d2: "2026-03-10T12:00:00Z", c: false }, ...META },
  { cells: { n: 86400000, n2: 12, t: "42", t2: "7", d: "2023-12-31", d2: "2025-01-01T00:00:00.000Z", c: true }, ...META },
];

/** Compiles `source` as formula `f` over `props` and computes it for a row: the two outcomes. */
const evaluate = (source: string, row: Row, props: Property[] = BASE): [number, number] => {
  const compiled = compileOutcome(source, props, "f");
  const f = prop("f", "F", "formula", compiled.options);
  return [intern(compiled.text), intern(computed(() => computeFormulas([...props, f], row.cells, row, ["f"], NOW).f))];
};

// ---------------------------------------------------------------------------
// Sources written by hand: `[source, row, compilation, value]`

const SOURCES: string[] = [
  // the cases of src/common/formula.test.ts
  "1 + 2 * 3", "-2^2", "(-2)^2", "2^3^2", "2^-1", "1 < 2 and not false", "1 = 2 or 2 <> 3", "0.1 + 0.2", 'if(TRUE, "a", "b")', "isblank(blank)", "isBlank(Empty)", `'it\\'s' & "\\"q\\""`,
  "", "1 +", "1 + @", "Amount", "prop(Amount)", 'prop("Nope")', "FOO(1)", "ROUND()", 'prop("Name") + 1', 'prop("Due") < 3', 'prop("Amount") * 2', 'prop("name") & "!"', 'prop("Done")', 'prop("Stage") & ""',
  'YEAR(prop("Created"))', "1 / 0", 'TONUMBER("abc")', 'IFERROR(1 / 0, "none")', "ISERROR(1 / 0)", "false and (1 / 0) > 0", '"1" = 1', 'true = "yes"', '"a" = "A"', '"10" < "9"', "ROUND(-2.5)", "ROUND(2.345, 2)",
  "ROUNDDOWN(2.99, 1)", "MOD(-7, 3)", "SUM(1, 2, 3) / AVERAGE(2, 4)", 'MID("abcdef", 2, 3)', 'SUBSTITUTE("a-b-c", "-", "+")', 'REPLACE("abcdef", 2, 0, "X")', 'SPLITPART("a,b,c", ",", 2)', 'FIND("hello", "l")',
  'JOIN("-", 1, "b", true)', "IFS(false, 1, true, 2)", 'SWITCH("b", "a", 1, "b", 2, 0)', 'DATEADD("2026-01-31", 1, "month")', 'DATEADD("2026-01-31", 1, "day")', 'DATEDIFF("2026-01-20", "2026-03-15", "months")',
  'DATEDIFF("2026-03-15", "2026-03-10")', "TODAY()", 'FORMATDATE("2026-07-04", "DD/MM/YYYY")', 'WEEKDAY("2026-03-08")', 'DATEADD("2026-01-01", 1, "fortnight")', 'YEAR("")', 'prop("Total") * 10', 'prop("Gone") + 1',
  // syntax: every error message and span
  " ", "\t\n", "1 2", "1 +", "(1", "(1 + 2", "1)", ")", "(", "()", "1 + * 2", "* 2", "1 +", "1,2", ",", "1 @ 2", "#", "1 $", "é", "1 + é", emoji, `1 + ${emoji} + 2`, '"abc', "'abc", '"abc\\', '"abc\\"', '"', "'",
  "1.2.3", "1..2", ".5", "5.", ".", "1e", "1e+", "1e5", "1E-2", "1e5e", "1e400", "0x10", "1_000", "00012", "1.5e3.2", "12abc", "abc12", "_a", "a_b(1)", "__proto__", "constructor", "toString(1)", "CONSTRUCTOR(1)", "__PROTO__(1)",
  "true", "FALSE", "True", "null", "Blank", "EMPTY", "nil", "undefined", "NaN", "Infinity", "not", "not not", "and", "or", "1 and", "and 1", "1 or", "or 1", "not true", "not not true", "not(true)", "NOT (true)", "not (1) + 1",
  "not true = false", "not 1 + 1", "1 + not 1", "- not 1", "1 = not 1", "true and not false", "true or not(false)", "not true and false", "not(true and false)", "NOT true", "nOt true", "1 AND 0", "1 Or 0", "and(1, 0)", "or(1, 0)",
  "prop", "prop(", "prop()", 'prop("")', 'prop("  ")', "prop('Amount')", 'prop("Amount"', 'prop("Amount",)', 'prop("Amount", 1)', "prop(1)", 'prop(prop("Amount"))', 'PROP("Amount")', 'Prop ( "Amount" )', 'prop("amount")', 'prop(" AMOUNT ")',
  'prop("Spaced  Name")', 'prop(" Spaced  Name ")', 'prop("spaced name")', 'prop("Quote \\"q\\"")', "prop('Quote \"q\"')", 'prop("Twin")', 'prop("twin")', 'prop("TWIN")', 'prop("TWIN ")', 'prop("tWiN")', 'prop("Ärger 😀")',
  'prop("äRGER 😀")', 'prop("F")', 'prop("f")', 'prop("Nope") + FOO(1)', 'FOO(prop("Nope"))', 'prop("Nope") + prop("Nada")', 'prop("Nope") + ("a" * 2)', 'ROUND(prop("Nope"), 1, 2)', 'prop("Amount") + prop("Nope") + "a" * 1',
  "f(", "f(1", "f(1,", "f(1,)", "f(,1)", "f(1,,2)", "f()", "IF(", "IF(1,2", "IF 1", "IF", "IF(1 2)", "ABS (1)", "ABS\n(\n-1\n)", "abs(-1)", "Abs(-1)", "ABS(-1))", "ABS((-1)", "1 ABS(1)", "ABS(1) 1", "ABS(1)(2)", '"a" "b"', '1 "b"',
  "1 == 1", "1 = = 1", "1 != 2", "1 <> 2", "1 < > 2", "1 ! 2", "1 =< 2", "1 => 2", "1 <= 2", "1 >= 2", "1 >> 2", "1 << 2", "1 <<= 2", "1 === 1", "1 !== 1", "1 && 1", "1 || 1", "1 & & 1", "1 ** 2", "1 // 2", "1 %% 2", "1 ^^ 2",
  "1 ++ 2", "1 -- 2", "1 +- 2", "1 -+ 2", "--1", "++1", "+-+-1", "-+-+1", "- - 1", "+ 1", "-(1)", "-(-1)", "+", "-", "1 -", "- * 1", "2 ^ -2", "2 ^ +2", "2 ^ - - 2", "-2 ^ -2", "2 ^ 2 ^ -1", "2 ^ not 1", "2 ^ (1 + 1)", "(2 ^ 3) ^ 2",
  "2 * -3", "2 - -3", "2 --3", "2 + +3", "2 / -4", "2 % -3", "-2 % 3", "2 ^ 0.5", "4 ^ -0.5", "-8 ^ (1/3)", "(-8) ^ (1/3)", "0 ^ 0", "0 ^ -1", "10 ^ 308", "10 ^ 309", "10 ^ -324", "2 ^ 1024", "1.1 ^ 10", "(0 - 1) ^ 0.5",
  "1 + 2 - 3 * 4 / 5 % 6 ^ 7", "1 - 2 - 3", "2 / 2 / 2", "2 ^ 2 ^ 3", "10 % 4 % 3", "1 & 2 & 3", "1 + 2 & 3 + 4", "1 & 2 + 3", "1 < 2 < 3", "3 > 2 > 1", "1 = 1 = 1", "1 = 1 = true", "1 < 2 = true", "1 & 2 = 12", '"a" & "b" = "ab"',
  "1 + 1 = 2 and 2 * 2 = 4", "true or false and false", "(true or false) and false", "false and false or true", "not false or true", "1 < 2 and 2 < 3 or 1 / 0", "true or 1 / 0", "false and 1 / 0", "false or 1 / 0", "true and 1 / 0",
  '1 and "a"', '"a" and 1', '"no" or "0"', '"false" and true', "null and true", "null or 5", '"" or "x"', "2 and 3", "0 or 0", '(1/0) and false', "not null", 'not ""', 'not "0"', 'not "no"', 'not " False "', 'not "x"', "not 0", "not 2",
  "  1  +  2  ", "1+2", "1\t+\n2\r", "1 + 2", "1 + 2", "﻿1", "1 + 2 // c", "1 /* c */ + 2", "1; 2", "1 + 2;", "{1}", "[1]", "1 ? 2 : 3", "a.b", "1 . 2", "a(1).b", '"a" . "b"', "\\", '"\\q\\n\\t\\\\\\""', "'\\''",
  `"${emoji}"`, `'a${emoji}b' & 1`, `LEN("${emoji}")`, `"${emoji}" @`, `"a" & "\\${emoji}"`, '"line\nbreak"', '"tab\there"', '"it\'s"', "'say \"hi\"'", '"\\u0041"', '"\\x41"', '"\\0"', '""', "''", '"" & \'\'',
  // values: literals, blanks, conversions between types
  "0", "-0", "0 * -1", "1e21", "1e21 + 1", "1e-7", "1e-7 * 1", "123456789012345680000", "0.1 * 3", "1 / 3", "2 / 3", "1e308 * 10", "-1e308 * 10", "1e308 * 10 - 1e308 * 10", "1e308 * 10 = 1e308 * 100", "0.30000000000000004",
  "1.0000000000005", "1.00000000000005", "999999999999.5", "0.9999999999995", "1234567890123.4567", "5e-324", "5e-324 * 1", "2.5e-10 + 0", "9007199254740993", "9007199254740993 + 0", "4503599627370495.5 + 0",
  'TOTEXT(1e21)', 'TOTEXT(1e-7)', 'TOTEXT(1.5e-7)', 'TOTEXT(0.1 + 0.2)', 'TOTEXT(1/3)', 'TOTEXT(-0)', 'TOTEXT(0 * -1)', 'TOTEXT(1e308 * 10)', 'TOTEXT(1e308 * 10 - 1e308 * 10)', 'TOTEXT(123456789012345680000)', 'TOTEXT(1234567.125)',
  'TOTEXT(0.000001)', 'TOTEXT(0.0000001)', 'TOTEXT(0.00000012345678901234)', 'TOTEXT(999999999999999900000)', 'TOTEXT(1e21 - 1)', 'TOTEXT(true)', 'TOTEXT(null)', 'TOTEXT("x")', 'TOTEXT(TODAY())', 'TOTEXT(NOW())', 'TOTEXT(DATE(5, 1, 1))',
  'TONUMBER("")', 'TONUMBER(" ")', 'TONUMBER(" 12 ")', 'TONUMBER("1,234.5")', 'TONUMBER("1,2,3")', 'TONUMBER(",")', 'TONUMBER("1e3")', 'TONUMBER("0x1F")', 'TONUMBER("0b11")', 'TONUMBER("Infinity")', 'TONUMBER("-Infinity")', 'TONUMBER("NaN")',
  'TONUMBER("12px")', 'TONUMBER("1 2")', 'TONUMBER(".5")', 'TONUMBER("5.")', 'TONUMBER("+5")', 'TONUMBER("--5")', 'TONUMBER(" 5 ")', 'TONUMBER("٥")', 'TONUMBER(true)', 'TONUMBER(false)', 'TONUMBER(null)', 'TONUMBER(TODAY())',
  'TONUMBER(NOW())', 'TONUMBER("2026-01-31")', 'TONUMBER(prop("Due"))', 'TONUMBER("1e400")', 'TONUMBER("a,b")', 'TONUMBER("1,")', 'TONUMBER("abc" & 1)', "TOBOOLEAN(1)", "TOBOOLEAN(0)", "TOBOOLEAN(-0)", 'TOBOOLEAN("")', 'TOBOOLEAN(" ")',
  'TOBOOLEAN("false")', 'TOBOOLEAN("FALSE")', 'TOBOOLEAN(" No ")', 'TOBOOLEAN("0")', 'TOBOOLEAN("0.0")', 'TOBOOLEAN("off")', 'TOBOOLEAN("x")', "TOBOOLEAN(null)", "TOBOOLEAN(TODAY())", "TOBOOLEAN(1e308 * 10 - 1e308 * 10)",
  "TODATE(null)", 'TODATE("")', 'TODATE(" ")', 'TODATE("2026-01-31")', 'TODATE(" 2026-01-31 ")', 'TODATE("2026-02-30")', 'TODATE("2026-13-01")', 'TODATE("2026-01-31T10:00:00")', 'TODATE("2026-01-31T10:00:00+02:00")',
  'TODATE("Mar 5 2024")', 'TODATE("3/5/2024")', 'TODATE("12")', 'TODATE("abc")', "TODATE(0)", "TODATE(86400000)", "TODATE(1.5)", "TODATE(-1)", "TODATE(8.64e15)", "TODATE(8.64e15 + 1)", "TODATE(1e300)", "TODATE(true)", "TODATE(false)",
  "TODATE(TODAY())", "TODATE(1e308 * 10)", "TODATE(1e308 * 10 - 1e308 * 10)", 'TODATE("0001-01-01")', 'TODATE("0000-01-01")', 'TODATE("9999-12-31")', 'TODATE("+010000-01-01")', 'TODATE("2026-01-31Z")', 'TODATE("2026-1-31")',
  "TOTEXT(TODATE(8.64e15))", "TOTEXT(TODATE(8.64e15 + 1))", "TOTEXT(TODATE(1e300))", 'TODATE(1e300) & ""', "ISERROR(TOTEXT(TODATE(1e300)))", 'IFERROR(TOTEXT(TODATE(1e300)), "caught")', "TODATE(1e300) = TODATE(1e300)", "YEAR(1e300)",
  'DATEADD("2026-01-31", 1e20, "days")', 'TOTEXT(DATEADD("2026-01-31", 1e20, "days"))', 'DATEADD("2026-01-31T00:00:00Z", 1e20, "days")', 'DATEADD("2026-01-31", 1e308 * 10, "days")', "DATE(300000, 1, 1)", "DATE(275760, 9, 13)",
  "DATE(275760, 9, 14)", "DATE(-271821, 4, 20)", "DATE(-271821, 4, 19)", "DATE(0, 1, 1)", "DATE(99, 12, 31)", "DATE(100, 1, 1)", "DATE(-1, 1, 1)", "DATE(2024, 13, 1)", "DATE(2024, 0, 0)", "DATE(2024, 2, 30)", "DATE(2024.9, 2.9, 1.9)",
  "DATE(2024, 1, 1e9)", "DATE(1e9, 1, 1)", "DATE(1e308 * 10, 1, 1)", 'DATE("2024", "3", "5")', "DATE(true, true, true)", "DATE(null, null, null)", "DATE(2024, 1, 1) = DATE(2024, 1, 1)", 'DATE(2024, 1, 1) = "2024-01-01"',
  'DATE(2024, 1, 1) = "2024-01-01T00:00:00Z"', "DATE(2024, 1, 1) = 1704067200000", 'DATE(2024, 1, 1) = "garbage"', "DATE(2024, 1, 1) = true", "DATE(2024, 1, 1) < DATE(2024, 1, 2)", 'DATE(2024, 1, 1) < "2024-01-02"', "DATE(2024, 1, 1) < 5",
  'DATE(2024, 1, 1) < "x"', "DATE(2024, 1, 1) < true", "DATE(2024, 1, 1) < null", 'DATE(2024, 1, 1) > ""', "DATE(2024, 1, 1) - DATE(2023, 1, 1)", "DATE(2024, 1, 1) + 1", "-DATE(2024, 1, 1)", "DATE(2024, 1, 1) & 1", "NOW() - TODAY()",
  // equality and comparison
  "1 = 1", '1 = "1"', '1 = "1.0"', '1 = " 1 "', '1 = "a"', '"a" = 1', "1 = true", "0 = false", '2 = true', 'true = "x"', 'false = "no"', 'false = ""', "null = null", 'null = ""', "null = 0", "null = false", '"" = 0', '"" = false', "0 = -0",
  '"a" = "a"', '"a" = "a "', '"1" = "1.0"', "1e308 * 10 - 1e308 * 10 = 1e308 * 10 - 1e308 * 10", "1 != 1", '1 != "a"', "null != null", "1 < 2", "2 < 1", '1 < "2"', '"1" < 2', '"a" < 1', '1 < "a"', '"a" < "b"', '"B" < "a"', '"a" < "B"', '"" < "a"',
  '"a" < ""', '"" < 1', '"" < -1', "null < 1", "null < -1", "null < null", 'null <= ""', "true < 2", "true > false", '"true" > false', `"${emoji}" < "￿"`, `"${emoji}" > ""`, '"é" > "z"', '"10" < "9"', '"10" < 9', '"abc" < "abd"',
  '"abc" < "ab"', '"ab" < "abc"', "1 <= 1", "1 >= 1", '"a" >= "a"', "1e308 * 10 - 1e308 * 10 < 1", "1e308 * 10 - 1e308 * 10 >= 1", "1e308 * 10 > 1e308", '"x" < "2024-01-01"', 'TODAY() > "2026-03-09"', 'TODAY() >= "2026-03-10"',
  // logic functions
  "IF(1, 2)", "IF(0, 2)", "IF(0, 2, 3)", 'IF("", 2, 3)', 'IF("no", 2, 3)', "IF(null, 2, 3)", "IF(1, 1/0, 3)", "IF(0, 1/0, 3)", "IF(1/0, 2, 3)", "IF(1, 2, 1/0)", 'IF(true, 1, "a")', 'IF(true, "a")', "IF(true, null, null)", "IF(true, TODAY(), 1)",
  "IF(true, TODAY(), NOW())", "IF(true, true, false)", "IF(TODAY(), 1, 2)", "IF()", "IF(1)", "IF(1, 2, 3, 4)", "IFS(true, 1)", "IFS(false, 1)", "IFS(false, 1, 2)", "IFS(false, 1, false, 2, 3)", "IFS(false, 1/0, true, 2)", "IFS(true, 1, 1/0, 2)",
  "IFS(1/0, 1, true, 2)", "IFS(false, 1, 1/0)", 'IFS(true, 1, true, "a")', 'IFS(false, 1, "d")', "IFS(1)", "IFS()", "IFS(false, 1, false, 2, false, 3, false, 4, 5)", "SWITCH(1, 1, 2)", "SWITCH(1, 2, 3)", "SWITCH(1, 2, 3, 4)",
  'SWITCH("b", "a", 1, "b", 2)', 'SWITCH("B", "a", 1, "b", 2)', 'SWITCH(1, "1", "text one", 1, "number one")', "SWITCH(1, 1/0, 2, 3)", "SWITCH(1/0, 1, 2)", "SWITCH(1, 1, 1/0, 3)", "SWITCH(1, 2, 1/0, 3)", 'SWITCH(1, "a", 2, 3)',
  'SWITCH("a", 1, 2, 3)', "SWITCH(null, null, 1, 2)", 'SWITCH("", null, 1, 2)', "SWITCH(TODAY(), TODAY(), 1, 2)", "SWITCH(1, 2)", "SWITCH(1)", "SWITCH()", "SWITCH(1, 1, 2, 1, 3)", "SWITCH(3, 1, 2, 3, 4, 5, 6, 7)", "SWITCH(true, 1, 2, 3)",
  "AND(true)", "AND(true, false)", "AND(false, 1/0)", "AND(true, 1/0)", "AND(1/0, false)", 'AND("x", 1, true)', "AND()", "OR(false)", "OR(false, true)", "OR(true, 1/0)", "OR(false, 1/0)", "OR(1/0, true)", 'OR("", 0, null)', "OR()",
  "NOT(true)", "NOT(0)", 'NOT("no")', "NOT(null)", "NOT()", "NOT(1, 2)", "NOT(TODAY())", "ISBLANK(null)", 'ISBLANK("")', 'ISBLANK(" ")', "ISBLANK(0)", "ISBLANK(false)", "ISBLANK(1/0)", "ISBLANK()", 'ISBLANK(prop("Stage"))',
  "ISERROR(1)", "ISERROR(1/0)", 'ISERROR(TONUMBER("x"))', "ISERROR(ERROR())", 'ISERROR(ERROR("m"))', "ISERROR(ISERROR(1/0))", "ISERROR(1/0) and ISERROR(2)", 'ISERROR(prop("Broken"))', 'ISERROR(prop("Total"))', "ISERROR()",
  "IFERROR(1, 2)", "IFERROR(1/0, 2)", "IFERROR(1/0, 2/0)", "IFERROR(IFERROR(1/0, 2/0), 3)", 'IFERROR(1/0, "a")', "IFERROR(1, 1/0)", 'IFERROR(prop("Broken"), 0)', "IFERROR(ERROR(), ERROR(\"second\"))", "IFERROR(1)", "IFERROR(1, 2, 3)",
  "1 + IFERROR(1/0, 2) * 3", "IFERROR(1 + (2 * (3 / 0)), 7) + 1", "SUM(1, IFERROR(1/0, 2), ISERROR(1/0))", "IF(ISERROR(1/0), IFERROR(2/0, 5), 6)", "COALESCE(null)", 'COALESCE(null, "", 0)', 'COALESCE("", "a", 1/0)',
  "COALESCE(1/0, 2)", "COALESCE(null, 1/0)", "COALESCE(false, 1)", 'COALESCE(prop("Stage"), prop("Name"), "none")', "COALESCE()", "COALESCE(null, null)", "COALESCE(TODAY(), 1)", "ERROR()", 'ERROR("boom")', 'ERROR("")', "ERROR(null)",
  "ERROR(5)", "ERROR(1.5 * 2)", "ERROR(true)", "ERROR(TODAY())", "ERROR(1/0)", 'ERROR("a", "b")', 'IFERROR(ERROR("x"), "y")', "ERROR(TODATE(1e300))",
  // text functions with awkward arguments
  'LEN("")', 'LEN("abc")', "LEN(12345)", "LEN(1.50)", "LEN(true)", "LEN(null)", "LEN(TODAY())", "LEN(NOW())", `LEN("${emoji}${emoji}")`, 'LEFT("abcdef")', 'LEFT("abcdef", 0)', 'LEFT("abcdef", 2)', 'LEFT("abcdef", 2.9)', 'LEFT("abcdef", -1)',
  'LEFT("abcdef", -0.5)', 'LEFT("abcdef", 100)', 'LEFT("abcdef", null)', 'LEFT("abcdef", "")', 'LEFT("abcdef", "2")', 'LEFT("abcdef", "x")', 'LEFT("abcdef", 1e308 * 10)', 'LEFT("abcdef", 1e308 * 10 - 1e308 * 10)', 'LEFT("abcdef", true)',
  `LEFT("${emoji}abc", 1)`, `LEFT("${emoji}abc", 2)`, `LEFT("a${emoji}bc", 2)`, `LEFT("a${emoji}bc", 3)`, 'RIGHT("abcdef")', 'RIGHT("abcdef", 0)', 'RIGHT("abcdef", 2)', 'RIGHT("abcdef", 100)', 'RIGHT("abcdef", -1)', 'RIGHT("abcdef", 0.5)',
  'RIGHT("abcdef", 1e308 * 10)', 'RIGHT("abcdef", 1e308 * 10 - 1e308 * 10)', `RIGHT("abc${emoji}", 1)`, `RIGHT("abc${emoji}", 2)`, 'MID("abcdef", 1)', 'MID("abcdef", 3)', 'MID("abcdef", 0)', 'MID("abcdef", 0.9)', 'MID("abcdef", 1.9, 2.9)',
  'MID("abcdef", 7)', 'MID("abcdef", 3, 0)', 'MID("abcdef", 3, -1)', 'MID("abcdef", 3, 100)', 'MID("abcdef", 3, null)', 'MID("abcdef", "2", "3")', 'MID("abcdef", 1e308 * 10)', 'MID("abcdef", 1e308 * 10 - 1e308 * 10, 2)',
  'MID("abcdef", 2, 1e308 * 10)', 'MID("abcdef", 2, 1e308 * 10 - 1e308 * 10)', `MID("a${emoji}b", 2, 1)`, `MID("a${emoji}b", 3, 1)`, `MID("a${emoji}b", 2, 2)`, 'FIND("abc", "")', 'FIND("", "")', 'FIND("", "a")', 'FIND("abc", "c")',
  'FIND("abc", "C")', `FIND("${emoji}x", "x")`, 'FIND(12345, 3)', 'FIND("true", true)', 'CONTAINS("abc", "")', 'CONTAINS("abc", "bc")', 'CONTAINS("abc", "BC")', "CONTAINS(123, 2)", 'STARTSWITH("abc", "ab")', 'STARTSWITH("abc", "")',
  'ENDSWITH("abc", "bc")', 'ENDSWITH("abc", "abcd")', 'SUBSTITUTE("aaa", "a", "b")', 'SUBSTITUTE("aaa", "aa", "b")', 'SUBSTITUTE("abc", "", "x")', 'SUBSTITUTE("abc", "b", "")', 'SUBSTITUTE("", "a", "b")', 'SUBSTITUTE("a.b", ".", "$&")',
  'SUBSTITUTE("abcabc", "bc", "$1")', "SUBSTITUTE(1212, 1, 3)", `SUBSTITUTE("${emoji}a${emoji}", "${emoji}", "x")`, 'REPLACE("abcdef", 1, 1, "X")', 'REPLACE("abcdef", 0, 1, "X")', 'REPLACE("abcdef", -5, 1, "X")', 'REPLACE("abcdef", 7, 1, "X")',
  'REPLACE("abcdef", 100, 1, "X")', 'REPLACE("abcdef", 2, 100, "X")', 'REPLACE("abcdef", 2, -1, "X")', 'REPLACE("abcdef", 2.9, 1.9, "X")', 'REPLACE("abcdef", 2, null, "X")', 'REPLACE("abcdef", null, 2, "X")',
  'REPLACE("abcdef", 1e308 * 10 - 1e308 * 10, 1, "X")', 'REPLACE("abcdef", 2, 1e308 * 10 - 1e308 * 10, "X")', 'REPLACE("abcdef", 1e308 * 10, 1, "X")', 'REPLACE("abcdef", 2, 1e308 * 10, "X")', 'REPLACE("abcdef", 2, 1, 5)',
  `REPLACE("a${emoji}b", 2, 1, "X")`, `REPLACE("a${emoji}b", 3, 1, "X")`, `REPLACE("a${emoji}b", 2, 2, "X")`, 'REPEAT("ab", 3)', 'REPEAT("ab", 0)', 'REPEAT("ab", -1)', 'REPEAT("ab", 2.9)', 'REPEAT("ab", 5000)', 'REPEAT("ab", 5001)',
  'LEN(REPEAT("x", 10000))', 'REPEAT("x", 10001)', `LEN(REPEAT("${emoji}", 5000))`, `REPEAT("${emoji}", 5001)`, 'REPEAT("", 1e300)', 'REPEAT("", 1e308 * 10)', 'REPEAT("a", 1e308 * 10)', 'REPEAT("", 1e308 * 10 - 1e308 * 10)',
  'REPEAT("a", 1e308 * 10 - 1e308 * 10)', 'REPEAT("ab", null)', 'REPEAT("ab", "2")', 'REPEAT("ab", "x")', "REPEAT(12, 2)", 'ISERROR(REPEAT("", 1e308 * 10))', 'IFERROR(REPEAT("", 1e308 * 10), "caught")', 'SPLITPART("a,b,c", ",", 1)',
  'SPLITPART("a,b,c", ",", 3)', 'SPLITPART("a,b,c", ",", 4)', 'SPLITPART("a,b,c", ",", 0)', 'SPLITPART("a,b,c", ",", -1)', 'SPLITPART("a,b,c", ",", 1.9)', 'SPLITPART("a,b,c", ",", 0.9)', 'SPLITPART("a,b,c", ",", "2")',
  'SPLITPART("a,b,c", ",", 1e308 * 10)', 'SPLITPART("a,b,c", ",", 1e308 * 10 - 1e308 * 10)', 'SPLITPART("a,b,c", ",", 4294967297)', 'SPLITPART("a,b,c", "", 2)', 'SPLITPART("", "", 1)', 'SPLITPART("", ",", 1)', 'SPLITPART("abc", "abc", 2)',
  'SPLITPART("a--b", "-", 2)', `SPLITPART("a${emoji}b", "", 1)`, `SPLITPART("a${emoji}b", "", 2)`, `SPLITPART("a${emoji}b", "", 3)`, `SPLITPART("a${emoji}b", "", 4)`, `SPLITPART("a${emoji}b", "${emoji}", 2)`, "SPLITPART(1.5, \".\", 2)",
  'UPPER("abc ß ﬁ ŉ")', 'LOWER("ABC İ Σ ΟΣ")', 'UPPER("i̇")', 'LOWER("ẞ")', 'UPPER(1e21)', "UPPER(true)", "LOWER(null)", 'TRIM("  a b  ")', 'TRIM(" ﻿a \n")', 'TRIM("\u0085a​")',
  "TRIM(5)", 'CONCAT("a", 1, true, null, TODAY())', "CONCAT(0.1 + 0.2, 1e21, 1e-7)", "CONCAT()", "CONCAT(1/0)", 'JOIN(", ", "a", "b")', 'JOIN("", "a", "b")', 'JOIN(1, "a", "b")', 'JOIN(null, "a", "b")', 'JOIN(", ", "a")', 'JOIN(", ")',
  'JOIN(TODAY(), 1, 2)', 'JOIN(", ", null, "", 0)',
  // dates
  "NOW()", "TODAY()", "NOW() = NOW()", "NOW(1)", "TODAY(1)", "YEAR(NOW())", "MONTH(NOW())", "DAY(NOW())", "HOUR(NOW())", "MINUTE(NOW())", "WEEKDAY(NOW())", "YEAR(TODAY())", "HOUR(TODAY())", "YEAR(0)", "YEAR(-1)", "MONTH(0)",
  'YEAR("2026-01-31")', 'YEAR("2026-01-31T23:59:59-05:00")', 'DAY("2026-02-30")', 'YEAR("abc")', "YEAR(null)", "YEAR(true)", 'YEAR(" ")', "YEAR()", "YEAR(1, 2)", 'WEEKDAY("2026-03-07")', 'WEEKDAY("1969-12-31")', "WEEKDAY(-1)",
  'HOUR("2026-01-31T10:30:00")', 'MINUTE("2026-01-31T10:30:59.999Z")', 'YEAR("0001-01-01")', 'YEAR("-000001-06-15")', 'YEAR("+275760-09-13")', "YEAR(8.64e15)", "YEAR(8.64e15 + 1)", "MONTH(8.64e15 + 1)", "YEAR(0.5)", "YEAR(-0.5)",
  'DATEADD("2026-01-31", 1, "day")', 'DATEADD("2026-01-31", 1, "days")', 'DATEADD("2026-01-31", 1, "d")', 'DATEADD("2026-01-31", 1, " Days ")', 'DATEADD("2026-01-31", 1, "DAY")', 'DATEADD("2026-01-31", 1, "week")', 'DATEADD("2026-01-31", 1, "w")',
  'DATEADD("2026-01-31", 1, "month")', 'DATEADD("2026-01-31", 1, "mo")', 'DATEADD("2026-01-31", 1, "m")', 'DATEADD("2026-01-31", 1, "min")', 'DATEADD("2026-01-31", 1, "year")', 'DATEADD("2026-01-31", 1, "y")', 'DATEADD("2026-01-31", 1, "hour")',
  'DATEADD("2026-01-31", 1, "h")', 'DATEADD("2026-01-31", 1, "second")', 'DATEADD("2026-01-31", 1, "s")', 'DATEADD("2026-01-31", 1, "sec")', 'DATEADD("2026-01-31", 1, "ms")', 'DATEADD("2026-01-31", 1, "")', 'DATEADD("2026-01-31", 1, null)',
  'DATEADD("2026-01-31", 1, 5)', 'DATEADD("2026-01-31", 1, true)', 'DATEADD("2026-01-31", 1, "constructor")', 'DATEADD("2026-01-31", 1, "__proto__")', 'DATEADD("2026-01-31", 1, "toString")', 'DATEADD("2026-01-31", 1, "tostring")',
  'DATEADD("2026-01-31", 1, "valueOf")', 'DATEADD("2026-01-31", 1, "hasownproperty")', 'DATEDIFF("2026-01-31", "2026-03-01", "constructor")', 'DATEDIFF("2026-01-31", "2026-03-01", "__proto__")', 'TOTEXT(DATEADD("2026-01-31", 1, "constructor"))',
  'DATEADD("2026-01-31", 1.9, "day")', 'DATEADD("2026-01-31", -1.9, "month")', 'DATEADD("2026-01-31", 0.5, "day")', 'DATEADD("2026-01-31", "2", "day")', 'DATEADD("2026-01-31", null, "day")', 'DATEADD("2026-01-31", "x", "day")',
  'DATEADD("2024-02-29", 1, "year")', 'DATEADD("2024-02-29", 4, "year")', 'DATEADD("2024-02-29", -1, "year")', 'DATEADD("2024-01-31", 1, "month")', 'DATEADD("2023-01-31", 1, "month")', 'DATEADD("2024-03-31", -1, "month")',
  'DATEADD("2024-12-31", 2, "month")', 'DATEADD("2024-08-31", 13, "month")', 'DATEADD("2024-01-31T10:30:15.250Z", 1, "month")', 'DATEADD("2024-01-31T23:59:59.999Z", -11, "month")', 'DATEADD("0099-12-31", 1, "month")',
  'DATEADD("0100-01-31", -1, "month")', 'DATEADD("0050-06-15", 1, "year")', 'DATEADD("0000-01-01", 0, "month")', 'DATEADD("-000001-12-31", 1, "month")', 'DATEADD("+275760-08-13", 1, "month")', 'DATEADD("+275760-09-13", 0, "month")',
  'DATEADD("+275760-09-13", 1, "month")', 'DATEADD("2024-01-31", 1e10, "month")', 'DATEADD("2024-01-31", 1e300, "year")', 'DATEADD("2024-01-31", 1e308 * 10, "month")', 'DATEADD("2024-01-31", 1e308 * 10 - 1e308 * 10, "month")',
  'DATEADD("2024-01-31", 3271000, "month")', 'DATEADD("2024-01-31", -3287000, "month")', 'DATEADD(0, 1, "day")', 'DATEADD(1.5, 1, "day")', 'DATEADD(NOW(), 90, "minutes")', 'DATEADD(TODAY(), -1, "weeks")', 'DATEADD("", 1, "day")',
  'DATEADD(null, 1, "day")', 'DATEADD("abc", 1, "day")', 'DATEADD(true, 1, "day")', 'DATEADD("2026-01-31", 1)', 'DATEADD("2026-01-31")', 'DATESUBTRACT("2026-03-31", 1, "month")', 'DATESUBTRACT("2026-03-31", -1, "month")',
  'DATESUBTRACT("2026-03-01", 1, "day")', 'DATESUBTRACT("2026-03-01", 1.5, "hours")', 'DATESUBTRACT("2026-03-01", 1, "eon")', 'DATESUBTRACT("", 1, "day")', 'DATEDIFF("2026-01-20", "2026-03-15")', 'DATEDIFF("2026-01-20", "2026-03-15", "day")',
  'DATEDIFF("2026-01-20", "2026-03-15", "week")', 'DATEDIFF("2026-01-20", "2026-03-15", "month")', 'DATEDIFF("2026-01-20", "2026-03-20", "month")', 'DATEDIFF("2026-01-20", "2026-03-19", "month")', 'DATEDIFF("2026-03-20", "2026-01-20", "month")',
  'DATEDIFF("2026-03-19", "2026-01-20", "month")', 'DATEDIFF("2026-03-21", "2026-01-20", "month")', 'DATEDIFF("2024-01-31", "2024-02-29", "month")', 'DATEDIFF("2024-02-29", "2024-01-31", "month")', 'DATEDIFF("2024-01-31", "2024-03-30", "month")',
  'DATEDIFF("2020-02-29", "2024-02-28", "year")', 'DATEDIFF("2020-02-29", "2024-02-29", "year")', 'DATEDIFF("2024-02-29", "2020-02-29", "year")', 'DATEDIFF("2024-02-28", "2020-02-29", "year")', 'DATEDIFF("2026-01-20", "2026-01-20T23:59:59Z", "day")',
  'DATEDIFF("2026-01-20T12:00:00Z", "2026-01-20", "hour")', 'DATEDIFF("2026-01-20", "2026-01-19T23:59:59.999Z", "second")', 'DATEDIFF("2026-01-20", "2026-01-19T23:59:59.999Z", "day")', 'DATEDIFF(0, 86399999, "day")', 'DATEDIFF(0, -1, "day")',
  'DATEDIFF("0099-01-31", "0099-03-31", "month")', 'DATEDIFF("0001-01-01", "9999-12-31", "month")', 'DATEDIFF("0001-01-01", "9999-12-31", "year")', 'DATEDIFF("-271821-04-20", "+275760-09-13", "day")', 'DATEDIFF("-271821-04-20", "+275760-09-13", "month")',
  'DATEDIFF(1e300, 0, "month")', 'DATEDIFF(0, 1e300, "day")', 'DATEDIFF(0, 1e308 * 10, "day")', 'DATEDIFF("2026-01-20", "")', 'DATEDIFF("", "2026-01-20")', 'DATEDIFF("2026-01-20", "x", "day")', 'DATEDIFF("2026-01-20", "2026-01-21", "x")',
  'DATEDIFF("2026-01-20")', 'FORMATDATE("2026-07-04", "YYYY-MM-DD HH:mm:ss")', 'FORMATDATE("2026-07-04T15:09:07Z", "YYYYYY YYY YY Y MMM M DDD HHH mmm sss")', 'FORMATDATE("2026-07-04T15:09:07Z", "yyyy-mm-dd hh:MM:SS")',
  'FORMATDATE("2026-07-04T15:09:07Z", "")', 'FORMATDATE("2026-07-04T15:09:07Z", "no tokens")', 'FORMATDATE("2026-07-04T15:09:07Z", "DDMMYYYYHHmmss")', 'FORMATDATE("2026-07-04T15:09:07Z", "YYMMDD")', 'FORMATDATE("0005-07-04", "YYYY/YY")',
  'FORMATDATE("-000105-07-04", "YYYY/YY")', 'FORMATDATE("-000100-07-04", "YYYY/YY")', 'FORMATDATE("+275760-09-13", "YYYY/YY")', 'FORMATDATE("-271821-04-20", "YYYY/YY/MM/DD")', 'FORMATDATE(1e300, "YYYY-YY-MM-DD HH:mm:ss")',
  'FORMATDATE("2026-07-04", 5)', 'FORMATDATE("2026-07-04", null)', 'FORMATDATE("2026-07-04", true)', `FORMATDATE("2026-07-04", "${emoji}YYYY${emoji}")`, 'FORMATDATE("", "YYYY")', 'FORMATDATE("x", "YYYY")', 'FORMATDATE(NOW(), "HH:mm")',
  'FORMATDATE("2026-07-04")', 'FORMATDATE(0, "YYYY-MM-DD")', 'FORMATDATE(-1, "YYYY-MM-DD HH:mm:ss")',
  // maths
  "ROUND(2.5)", "ROUND(-2.5)", "ROUND(0.5)", "ROUND(-0.5)", "ROUND(1.005, 2)", "ROUND(2.675, 2)", "ROUND(1.45, 1)", "ROUND(-1.45, 1)", "ROUND(1234.5678, -2)", "ROUND(1250, -2)", "ROUND(-1250, -2)", "ROUND(5, -1)", "ROUND(15, -1)",
  "ROUND(0.000123456, 8)", "ROUND(1e21, 2)", "ROUND(1e-7, 3)", "ROUND(123.456, 0)", "ROUND(123.456, null)", 'ROUND(123.456, "")', 'ROUND(123.456, "1")', "ROUND(123.456, 1.5)", "ROUND(123.456, 1e308 * 10)", "ROUND(123.456, 400)",
  "ROUND(123.456, -400)", "ROUND(123.456, 308)", "ROUND(123.456, 309)", "ROUND(123.456, 22)", "ROUND(123.456, 23)", "ROUND(0, 400)", "ROUND(0, -400)", "ROUND(1e308 * 10, 2)", "ROUND(1e308 * 10 - 1e308 * 10, 2)", 'ROUND("2.5")',
  'ROUND("x")', "ROUND(true)", "ROUND(null)", "ROUND(1, 2, 3)", "ROUNDUP(2.1)", "ROUNDUP(-2.1)", "ROUNDUP(2.01, 1)", "ROUNDUP(2.0000000000001, 1)", "ROUNDUP(0.1 + 0.2, 1)", "ROUNDUP(1234, -2)", "ROUNDDOWN(2.9)", "ROUNDDOWN(-2.9)",
  "ROUNDDOWN(0.3, 1)", "ROUNDDOWN(0.1 + 0.2, 1)", "ROUNDDOWN(0.7 + 0.1, 1)", "ROUNDDOWN(1299, -2)", "FLOOR(2.5)", "FLOOR(-2.5)", "FLOOR(-0.5)", "CEILING(2.5)", "CEILING(-2.5)", "CEILING(-0.5)", "TRUNC(2.9)", "TRUNC(-2.9)", "TRUNC(-0.9)",
  "ABS(-5)", "ABS(-0)", 'ABS("-5")', "SIGN(-5)", "SIGN(0)", "SIGN(-0)", "SIGN(5)", "SIGN(1e308 * 10 - 1e308 * 10)", "SQRT(16)", "SQRT(2)", "SQRT(0)", "SQRT(-0)", "SQRT(-1)", "SQRT(1e308 * 10)", "EXP(0)", "EXP(1)", "EXP(-1)", "EXP(710)",
  "EXP(-750)", "LN(1)", "LN(0)", "LN(-1)", "LN(2.718281828459045)", "LN(1e308 * 10)", "LOG10(1000)", "LOG10(0.001)", "LOG10(0)", "LOG10(2)", "POWER(2, 10)", "POWER(2, 0.5)", "POWER(2, -0.5)", "POWER(-8, 1/3)", "POWER(10, 308)",
  "POWER(10, 309)", "POWER(1.1, 10)", "POWER(0, 0)", "POWER(1, 1e308 * 10)", "POWER(-1, 1e308 * 10)", "POWER(1, 1e308 * 10 - 1e308 * 10)", "POWER(1e308 * 10 - 1e308 * 10, 0)", "POWER(2, 1000)", "POWER(1.0000001, 1000)", "POWER(1.0000001, 1001)",
  "MOD(7, 3)", "MOD(-7, 3)", "MOD(7, -3)", "MOD(7.5, 2)", "MOD(1, 0)", "MOD(1, -0)", 'MOD(1, "")', "MOD(1, null)", 'MOD("x", 0)', 'MOD("x", "y")', "MOD(0.3, 0.1)", "MOD(1e21, 7)", "MOD(5, 1e308 * 10)", "5 % 0", '"x" % 0', '"x" / 0', '"x" / "y"',
  '"x" + "y"', '"x" - 1', '1 - "x"', '"x" * "y"', '"x" ^ "y"', "-\"x\"", 'SUM("x", 1/0)', 'SUM(1, "x", "y")', "SUM(1)", "SUM(0.1, 0.2)", "SUM(0.1, 0.2, 0.3, 0.4)", 'SUM("1", true, null, "2,5")', "SUM()", "SUM(1e308, 1e308)", "SUM(1e308, 1e308, -1e308 * 10)",
  "AVERAGE(1, 2, 4)", "AVERAGE(0.1, 0.2)", "AVERAGE(1e308, 1e308)", "AVERAGE(1)", 'AVERAGE("a")', "MIN(1, 2)", "MIN(0, -0)", "MIN(-0, 0)", "MAX(0, -0)", "MAX(1, 1e308 * 10 - 1e308 * 10)", "MIN(1e308 * 10, 1)", 'MIN("3", 2, true)', "MIN(0.1 + 0.2, 1)",
  "MAX(0.1 + 0.2, 0.3)", "MIN()", "1 / MIN(0, -0)", "1 / -0", "0 / 1", "-0 / 1", "0 / -1 = 0", "1 / 3 * 3", "0.1 * 0.1", "1e-320 / 10", "1e21 * 10", "2 ^ 53 + 1", "(2 ^ 53 + 1) - 2 ^ 53", "0.1 + 0.7", "1.15 * 100", "1.005 * 1000", "4.35 * 100",
];

const cases: unknown[] = [];
{
  const random = seeded(99);
  for (const source of SOURCES) {
    // Row 0 has every cell; another row shows the same source over other values.
    for (const row of new Set([0, int(random, 1, ROWS.length - 1)])) cases.push([source, row, ...evaluate(source, ROWS[row]!)]);
  }
}

// ---------------------------------------------------------------------------
// Every function with every argument count and type; every operator on every pair.
// `[kind, name, [[indexes of arguments in the pool..., compilation, value]...]]`, where the
// source is `NAME(a, b)` for a call, `a op b` for a binary and `op a` (closing an
// opened parenthesis) for a unary operator.

const POOL = [
  "0", "2.5", "-1", '"abc"', '"12"', '"2026-01-31"', "true", "null", "DATE(2024, 2, 29)", 'prop("Name")', '""', "3", "1e21", '" 7 "', '"Mar 5 2024 10:30"', '"days"', "false", "NOW()", 'prop("Amount")', 'prop("Due")', 'prop("Done")',
  'prop("Stage")', "(1/0)", 'prop("Total")', 'prop("Broken")', 'prop("Later")', "(1e308 * 10)", '"month"', '"-"',
];
const PAIR_POOL = 9;
const calls: unknown[] = [];
{
  const random = seeded(5);
  for (const [name, def] of Object.entries(FUNCTIONS)) {
    const lists: number[][] = [[]];
    for (let i = 0; i < POOL.length; i++) lists.push([i]);
    for (let i = 0; i < PAIR_POOL; i++) for (let j = 0; j < PAIR_POOL; j++) lists.push([i, j]);
    const most = Math.min((def.max ?? def.min + 3) + 1, 7);
    for (let n = 2; n <= most; n++) {
      for (let k = n === 2 ? 25 : n === 3 ? 50 : n === 4 ? 20 : 6; k > 0; k--) lists.push(Array.from({ length: n }, () => int(random, 0, POOL.length - 1)));
    }
    calls.push(["call", name, lists.map((list) => [...list, ...evaluate(`${name}(${list.map((i) => POOL[i]).join(", ")})`, ROWS[0]!)])]);
  }
  for (const op of ["+", "-", "*", "/", "%", "^", "&", "=", "==", "!=", "<>", "<", "<=", ">", ">=", "and", "or"]) {
    const lists: number[][] = [];
    for (let i = 0; i < POOL.length; i++) for (let j = 0; j < POOL.length; j++) if ((i < 12 && j < 12) || random() < 0.12) lists.push([i, j]);
    calls.push(["binary", op, lists.map((list) => [...list, ...evaluate(`${POOL[list[0]!]} ${op} ${POOL[list[1]!]}`, ROWS[0]!)])]);
  }
  for (const op of ["-", "+", "not ", "- -", "not not ", "-(", "NOT("]) {
    calls.push(["unary", op, POOL.map((arg, i) => [i, ...evaluate(`${op}${arg}${op.endsWith("(") ? ")" : ""}`, ROWS[0]!)])]);
  }
}

// ---------------------------------------------------------------------------
// One template over many values: `[template, [value per tuple...]]`

const anyNumber = (random: () => number): number => {
  const r = random();
  if (r < 0.25) return int(random, -20, 20);
  if (r < 0.45) return Number((random() * 10 ** int(random, -3, 6)).toFixed(int(random, 0, 6))) * (random() < 0.3 ? -1 : 1);
  if (r < 0.6) return int(random, -1000, 1000) + pick(random, [0.5, 0.05, 0.005, 0.25, 0.125, 0.045, 0.0005]);
  if (r < 0.75) return (random() - 0.5) * 10 ** int(random, -12, 22);
  if (r < 0.85) return pick(random, [0, -0, 1, -1, 0.1, 0.2, 0.3, 1e21, 1e-7, 2 ** 53, 5e-324, 1e300, -1e300, 0.5, -0.5, 1.5, 2.5, 100, 1e15, 86400000, 1709632800000, 8.64e15, -8.64e15, 0.49999999999999994]);
  return Math.round((random() - 0.5) * 1e6) / pick(random, [1, 10, 100, 1000, 3, 7]);
};
const NUMBER_TEMPLATES = [
  "A + B", "A - B", "A * B", "A / B", "A % B", "A ^ 2", "A ^ B", "2 ^ B", "-A", "A = B", "A < B", "A + 0", "A & \"\"", "TOTEXT(A)", "TONUMBER(TOTEXT(A))", "ROUND(A)", "ROUND(A, 2)", "ROUND(A, -1)", "ROUND(A, TRUNC(MOD(B, 12)))",
  "ROUNDUP(A, 1)", "ROUNDDOWN(A, 1)", "ROUNDUP(A)", "ROUNDDOWN(A, -2)", "FLOOR(A)", "CEILING(A)", "TRUNC(A)", "ABS(A)", "SIGN(A)", "SQRT(ABS(A))", "EXP(A / 1000)", "EXP(B)", "LN(ABS(A))", "LOG10(ABS(A))", "POWER(A, B)",
  "POWER(ABS(A), 0.5)", "POWER(ABS(A), 1 / 3)", "POWER(10, TRUNC(MOD(B, 30)))", "POWER(1 + ABS(A) / 1e9, ABS(TRUNC(B)))", "MOD(A, B)", "SUM(A, B, 0.1)", "AVERAGE(A, B)", "MIN(A, B)", "MAX(A, B)", "A * 100", "A / 3", "A * B / B",
  "YEAR(A)", "WEEKDAY(A)", "TOTEXT(TODATE(A))", "DATEADD(0, A, \"days\")", "DATEADD(B, A, \"months\")", "DATEDIFF(A, B, \"days\")", "DATEDIFF(A, B, \"months\")", "FORMATDATE(A, \"YYYY-MM-DD HH:mm:ss\")", "LEFT(\"abcdefghij\", A)",
  "MID(\"abcdefghij\", A, B)", "REPEAT(\"ab\", A)", "DATE(A, B, 1)", "DATE(2024, A, B)",
];
const DATE_STRINGS = [
  "2026-01-31", "2024-02-29", "2023-02-28", "2024-12-31", "2025-01-01", "2024-03-31T12:00:00Z", "2024-01-31T23:59:59.999Z", "2024-10-31T00:00:00.000Z", "2020-02-29T10:30:15Z", "2024-03-10T02:30:00", "1970-01-01", "1969-12-31T23:59:59.999Z",
  "0099-12-31", "0100-03-31", "0000-02-29", "0001-01-01", "-000001-05-31", "9999-12-31", "+010000-01-31", "+275760-08-31", "+275760-09-13T00:00:00.000Z", "-271821-04-20T00:00:00.000Z", "-271821-05-31", "1900-02-28", "2000-02-29", "2100-02-28",
  "Mar 5 2024", "3/31/2024 11:59 PM", "2024-02-30", "2024-06-15T12:00:00+05:30", "12", "garbage", "", "2024-13-01", "1 Jan 2024 00:00 GMT", "2024-08-31", "2024-05-31", "2024-11-30T23:00:00-01:00",
];
const DATE_TEMPLATES = [
  'DATEADD(A, N, "days")', 'DATEADD(A, N, "weeks")', 'DATEADD(A, N, "months")', 'DATEADD(A, N, "years")', 'DATEADD(A, N, "hours")', 'DATEADD(A, N, "minutes")', 'DATEADD(A, N, "seconds")', 'DATESUBTRACT(A, N, "months")',
  'DATESUBTRACT(A, N, "days")', "DATEDIFF(A, B)", 'DATEDIFF(A, B, "weeks")', 'DATEDIFF(A, B, "months")', 'DATEDIFF(A, B, "years")', 'DATEDIFF(A, B, "hours")', 'DATEDIFF(A, B, "seconds")', 'FORMATDATE(A, "YYYY-MM-DD HH:mm:ss / YY")', "YEAR(A)",
  "MONTH(A)", "DAY(A)", "HOUR(A)", "MINUTE(A)", "WEEKDAY(A)", "A < B", "A = B", "A >= B", "TOTEXT(A)", "TONUMBER(A)", 'A & "|" & B', "TODATE(A)", "IF(A > B, A, B)", "COALESCE(A, B)", 'DATEADD(DATEADD(A, N, "months"), -N, "months")',
  'DATEDIFF(A, DATEADD(A, N, "months"), "months")', "TODATE(TONUMBER(A) + N)",
];
const TEXTS = [
  "", "a", "abc", "abcdef", "Hello, World", "  padded  ", "a-b-c", "a,b,,c", "ABC", "äöüß", "İstanbul ΣΟΣ", `${emoji}`, `a${emoji}b${emoji}c`, `${emoji}${emoji}`, "12", " 7 ", "1,234.5", "true", "no", "0",
  "2024-03-05", "line\nbreak", "tab\tsep", "o", "l", "-", ",", " nb ", "aaa", "aa", "x".repeat(50), "ﬁŉǆ", "é", " ",
];
const TEXT_TEMPLATES = [
  "LEN(A)", "LEFT(A, N)", "RIGHT(A, N)", "MID(A, N, M)", "MID(A, N)", "FIND(A, B)", "CONTAINS(A, B)", "STARTSWITH(A, B)", "ENDSWITH(A, B)", 'SUBSTITUTE(A, B, "#")', "SUBSTITUTE(A, B, A)", "REPLACE(A, N, M, B)", "REPEAT(A, N)",
  "SPLITPART(A, B, N)", "UPPER(A)", "LOWER(A)", "TRIM(A)", "A < B", "A = B", "A >= B", "A & B", "TONUMBER(A)", "TOBOOLEAN(A)", "TODATE(A)", "CONCAT(A, N, B)", "JOIN(B, A, N, true)", "IF(A, 1, 2)", "A + N", "A = N", "A < N",
  "LEN(UPPER(A)) - LEN(A)", "LEFT(A, N) & RIGHT(A, LEN(A) - N)", "COALESCE(A, B, \"none\")", "SWITCH(A, B, 1, \"abc\", 2, 3)",
];
const templateProps: Property[] = [prop("a", "A", "number"), prop("b", "B", "number"), prop("da", "DA", "date"), prop("db", "DB", "date"), prop("ta", "TA", "text"), prop("tb", "TB", "text"), prop("nn", "N", "number"), prop("mm", "M", "number")];
const instantiate = (template: string, kind: "number" | "date" | "text") =>
  template.replace(/\b[ABNM]\b/g, (name) => (name === "N" || name === "M" ? `prop("${name}")` : `prop("${kind === "number" ? "" : kind === "date" ? "D" : "T"}${name}")`));
const templates: Record<string, unknown> = {};
{
  const random = seeded(2026);
  const numberTuples = Array.from({ length: 90 }, () => ({ a: anyNumber(random), b: random() < 0.3 ? int(random, -6, 12) : anyNumber(random) }));
  const smallInt = () => pick(random, [0, 1, 2, 3, 4, 5, 6, 7, 10, 12, 13, 24, 100, -1, -2, -12, -13, 0.5, 1.9, -0.5, 1200, -1200, 1e6, null]);
  const dateTuples = Array.from({ length: 120 }, () => ({ da: pick(random, DATE_STRINGS), db: pick(random, DATE_STRINGS), nn: smallInt() }));
  const textTuples = Array.from({ length: 110 }, () => ({ ta: pick(random, TEXTS), tb: pick(random, TEXTS), nn: smallInt(), mm: pick(random, [0, 1, 2, 3, 5, 100, -1, 1.5, null]) }));
  const run = (kind: "number" | "date" | "text", list: string[], tuples: Record<string, unknown>[]) =>
    list.map((template) => {
      const source = instantiate(template, kind);
      const compiled = compileOutcome(source, templateProps, "f");
      const f = prop("f", "F", "formula", compiled.options);
      return [source, intern(compiled.text), tuples.map((cells) => intern(computed(() => computeFormulas([...templateProps, f], cells, META, ["f"], NOW).f)))];
    });
  templates.props = templateProps.map(compact);
  templates.numbers = { tuples: numberTuples.map(encode), results: run("number", NUMBER_TEMPLATES, numberTuples) };
  templates.dates = { tuples: dateTuples.map(encode), results: run("date", DATE_TEMPLATES, dateTuples) };
  templates.texts = { tuples: textTuples.map(encode), results: run("text", TEXT_TEMPLATES, textTuples) };
}

// ---------------------------------------------------------------------------
// Random expressions: `[source, row, compilation, value]`

type Kind = "number" | "string" | "boolean" | "date" | "any";
const LEAVES: Record<Kind, string[]> = {
  number: ["0", "1", "2", "3", "10", "0.5", "2.5", "100", "1e3", "0.1", ".5", "7.", "12", "-1", 'prop("Amount")', 'prop("Rate")', 'prop("Total")', 'prop("spaced  name")', 'prop("Twice")', 'prop("Twin")'],
  string: ['""', '"a"', '"abc"', '"12"', '" x "', '"Hello World"', "'it\\'s'", '"a,b,c"', '"2026-01-31"', '"days"', '"month"', `"é${emoji}"`, '"no"', 'prop("Name")', 'prop("Notes")', 'prop("Label")', 'prop("Link")', 'prop("Mail")', 'prop("Quote \\"q\\"")'],
  boolean: ["true", "false", "TRUE", "False", 'prop("Done")', 'prop("Big")'],
  date: ['prop("Due")', 'prop("Start")', 'prop("Created")', 'prop("Edited")', 'prop("Later")', "DATE(2026, 1, 31)", "TODAY()", "NOW()", '"2026-02-28"', 'TODATE("2024-02-29T12:00:00Z")'],
  any: ["null", "blank", "Empty", 'prop("Stage")', 'prop("Tags")', 'prop("Owner")', 'prop("Nothing")', 'prop("Broken")', 'prop("Missing")', 'prop("Editor")'],
};
const KINDS: Kind[] = ["number", "string", "boolean", "date", "any"];
const POLYMORPHIC = ["IF", "IFS", "SWITCH", "IFERROR", "COALESCE"];
const returning = (kind: Kind) => Object.entries(FUNCTIONS).filter(([name, def]) => !POLYMORPHIC.includes(name) && def.result === kind).map(([name]) => name);
const generate = (random: () => number, kind: Kind, depth: number): string => {
  const wanted = kind === "any" || random() < 0.06 ? pick(random, KINDS) : kind;
  if (depth <= 0 || random() < 0.22) return pick(random, LEAVES[wanted]);
  const sub = (k: Kind) => generate(random, k, depth - 1);
  const call = (name: string): string => {
    const def = FUNCTIONS[name]!;
    const most = def.max ?? def.min + 3;
    const n = random() < 0.04 ? int(random, 0, most + 1) : int(random, def.min, most);
    const args = Array.from({ length: n }, (_, i) => {
      const param = def.params[Math.min(i, def.params.length - 1)] ?? "any";
      return sub(POLYMORPHIC.includes(name) && i > 0 ? wanted : param === "any" ? pick(random, KINDS) : param);
    });
    const spelled = random() < 0.1 ? name.toLowerCase() : random() < 0.05 ? name[0] + name.slice(1).toLowerCase() : name;
    return `${spelled}(${args.join(random() < 0.1 ? "," : ", ")})`;
  };
  const r = random();
  if (r < 0.12) return call(pick(random, POLYMORPHIC));
  if (r < 0.17) return `(${sub(wanted)})`;
  if (wanted === "number") {
    if (r < 0.5) return `${sub("number")} ${pick(random, ["+", "-", "*", "/", "%", "^", "+", "-", "*"])} ${sub("number")}`;
    if (r < 0.56) return `-${sub("number")}`;
    return call(pick(random, returning("number")));
  }
  if (wanted === "boolean") {
    if (r < 0.4) return `${sub(pick(random, KINDS))} ${pick(random, ["=", "==", "!=", "<>", "<", "<=", ">", ">="])} ${sub(pick(random, KINDS))}`;
    if (r < 0.55) return `${sub("boolean")} ${pick(random, ["and", "or", "AND", "Or"])} ${sub("boolean")}`;
    if (r < 0.63) return `not ${sub("boolean")}`;
    return call(pick(random, returning("boolean")));
  }
  if (wanted === "string") {
    if (r < 0.4) return `${sub(pick(random, KINDS))} & ${sub("string")}`;
    return call(pick(random, returning("string")));
  }
  if (wanted === "date") return call(pick(random, returning("date")));
  return call(pick(random, Object.keys(FUNCTIONS)));
};
const breakIt = (random: () => number, source: string): string => {
  const at = int(random, 0, source.length);
  const r = random();
  if (r < 0.3) return source.slice(0, at) + source.slice(at + 1);
  if (r < 0.6) return source.slice(0, at) + pick(random, ["(", ")", ",", '"', "'", "+", " ", "not ", "and ", "1", "x", "@", "=", "<", "prop(", ".", "^", "-"]) + source.slice(at);
  if (r < 0.8) return source.slice(0, at);
  return source.slice(0, at) + source.slice(at).replace(/[A-Z]{2,}/, (name) => name.slice(0, -1));
};
/** Tokens in no particular order: mostly not formulas, which is the point. They exercise the parser's errors and its precedence. */
const SOUP = [
  "1", "2", "2.5", ".5", "1e3", '"a"', "'b'", '""', "true", "false", "null", "not", "not", "and", "or", "NOT", "AND", "(", "(", ")", ")", ",", "+", "-", "-", "*", "/", "%", "^", "^", "&", "=", "==", "!=", "<>", "<", "<=", ">", ">=",
  "IF", "ABS", "SUM", "ISERROR", "prop", 'prop("Amount")', 'prop("Name")', 'prop("Done")', "NOW()", "ABS(", "IF(", "SUM(1,", "x", "@", "blank",
];
const soup = (random: () => number): string => {
  let source = "";
  for (let n = int(random, 1, 12); n > 0; n--) source += pick(random, SOUP) + pick(random, [" ", " ", " ", "", "  "]);
  return source;
};
const randomExpressions = (seed: number, count: number): unknown[] => {
  const random = seeded(seed);
  const seen = new Set(SOURCES);
  const list: unknown[] = [];
  while (list.length < count) {
    let source = list.length % 4 === 3 ? soup(random) : generate(random, pick(random, KINDS), int(random, 1, 4));
    if (random() < 0.07) source = breakIt(random, source);
    if (source.length > 220 || seen.has(source) || !source.isWellFormed()) continue;
    seen.add(source);
    const row = int(random, 0, ROWS.length - 1);
    list.push([source, row, ...evaluate(source, ROWS[row]!)]);
  }
  return list;
};
// `--extra <seed> <count> <file>`: only random expressions, more of them, written outside the repository.
const extraAt = process.argv.indexOf("--extra");
if (extraAt >= 0) {
  const [seed, count, file] = process.argv.slice(extraAt + 1);
  const fuzz = randomExpressions(Number(seed), Number(count));
  await Bun.write(file!, JSON.stringify({ now: enc(NOW), outcomes, base: BASE.map(compact), rows: ROWS.map((row) => ({ ...row, cells: encode(row.cells) })), fuzz }) + "\n");
  console.log(`${path.basename(file!)}: ${fuzz.length} random expressions`);
  process.exit(0);
}
const fuzz = randomExpressions(4242, 4400);

// ---------------------------------------------------------------------------
// Whole bases: `{props, cells, createdAt, updatedAt, only, now, out}`

const scenarios: unknown[] = [];
let scenarioCount = 0;
const scenario = (label: string, props: Property[], cells: Record<string, unknown> = {}, extra: { only?: string[]; now?: number; createdAt?: string; updatedAt?: string } = {}) => {
  // A property of its own keeps the TypeScript compile cache from answering for another scenario.
  const all = [...props, prop(`scenario${scenarioCount++}`, label, "text")];
  const meta = { createdAt: extra.createdAt ?? META.createdAt, updatedAt: extra.updatedAt ?? META.updatedAt };
  const now = extra.now ?? NOW;
  const out = computed(() => computeFormulas(all, cells, meta, extra.only, now));
  scenarios.push({ label, props: all.map(compact), cells: encode(cells), ...meta, only: extra.only ?? null, now: enc(now), out });
};
const formula = (id: string, name: string, source: unknown, options: Record<string, unknown> = {}) => prop(id, name, "formula", { source, ...options });
const chain = (length: number, tail: string) => Array.from({ length }, (_, i) => formula(`c${i}`, `C${i}`, i === length - 1 ? tail : `prop("C${i + 1}") + 1`));
for (const length of [2, 16, 17, 18, 34]) {
  scenario(`a chain of ${length} formulas`, chain(length, "1"));
  if (length === 34) continue;
  scenario(`a chain of ${length} formulas, deepest first`, chain(length, "1").reverse());
  scenario(`a chain of ${length} formulas, only the first`, chain(length, "1"), {}, { only: ["c0"] });
  scenario(`a chain of ${length} formulas, the middle first`, chain(length, "1"), {}, { only: [`c${length >> 1}`, "c0", "c1"] });
}
scenario("a chain of 17 that catches the depth error", [...chain(17, "1").slice(1), formula("c0", "C0", 'IFERROR(prop("C1"), -1)'), formula("top", "Top", 'ISERROR(prop("C1"))')]);
scenario("a chain ending in an error", chain(5, "1 / 0"));
scenario("a chain ending in text", chain(4, '"x"'));
scenario("a chain ending in a missing property", chain(4, 'prop("Nope")'));
scenario("a loop of two, dependencies unknown", [formula("a", "A", 'prop("B") + 1'), formula("b", "B", 'prop("A") + 1')]);
scenario("a loop of two, dependencies known", [formula("a", "A", 'prop("B") + 1', { dependencies: ["b"] }), formula("b", "B", 'prop("A") + 1', { dependencies: ["a"] })]);
scenario("a loop of two, one side known", [formula("a", "A", 'prop("B") + 1', { dependencies: ["b"] }), formula("b", "B", 'prop("A") + 1')]);
scenario("a loop of three, caught", [formula("a", "A", 'IFERROR(prop("B"), 0) + 1'), formula("b", "B", 'prop("C") + 1'), formula("c", "C", 'prop("A") + 1'), formula("d", "D", 'ISERROR(prop("A")) & "/" & ISERROR(prop("B"))')]);
scenario("a formula that names itself", [formula("a", "A", 'prop("A") + 1')]);
scenario("a formula that names itself, another property has the name", [prop("n", "A", "number"), formula("a", "A", 'prop("A") + 1')], { n: 5 });
scenario("a diamond", [prop("n", "N", "number"), formula("a", "A", 'prop("N") + 1'), formula("b", "B", 'prop("A") * 2'), formula("c", "C", 'prop("A") * 3'), formula("d", "D", 'prop("B") + prop("C")')], { n: 1 });
scenario("an error used twice", [formula("e", "E", "1 / 0"), formula("a", "A", 'IFERROR(prop("E"), 1) + IFERROR(prop("E"), 2)'), formula("b", "B", 'prop("E") + prop("E")')]);
scenario("only: nothing", [formula("a", "A", "1"), formula("b", "B", "2")], {}, { only: [] });
scenario("only: one", [formula("a", "A", "1"), formula("b", "B", 'prop("A") + 1')], {}, { only: ["b"] });
scenario("only: unknown and repeated ids", [formula("a", "A", "1"), formula("b", "B", "2"), prop("n", "N", "number")], { n: 1 }, { only: ["zz", "b", "b", "n"] });
scenario("no formulas", [prop("n", "N", "number")], { n: 1 });
scenario("no properties", []);
scenario("two formulas with one id", [formula("a", "A", "1"), formula("a", "A2", "2"), formula("b", "B", 'prop("A") + prop("A2")')]);
scenario("a number and a formula with one id", [prop("a", "A", "number"), formula("a", "F", "2"), formula("b", "B", 'prop("A") & "/" & prop("F")')], { a: 7 });
scenario("a formula and a number with one id", [formula("a", "F", "2"), prop("a", "A", "number"), formula("b", "B", 'prop("A") & "/" & prop("F")')], { a: 7 });
scenario("sources that are not text", [formula("a", "A", 5), formula("b", "B", null), formula("c", "C", undefined), formula("d", "D", ["1"]), formula("e", "E", { source: "1" }), formula("f", "F", true), formula("g", "G", ""), formula("h", "H", " ")]);
scenario("sources that do not compile", [formula("a", "A", "1 +"), formula("b", "B", "FOO()"), formula("c", "C", '"a" * 2'), formula("d", "D", 'prop("A") + 1'), formula("e", "E", 'IFERROR(prop("A"), "caught")'), formula("g", "G", "x".repeat(10_001))]);
scenario("a source of exactly the longest length", [formula("a", "A", `${" ".repeat(9_999)}1`), formula("b", "B", `"${emoji.repeat(4_999)}"`), formula("c", "C", `"${emoji.repeat(5_000)}"`)]);
scenario("names: exact before folded", [prop("x", "total", "number"), prop("y", "Total", "number"), prop("z", " TOTAL ", "number"), formula("a", "A", 'prop("Total") & prop("total") & prop("TOTAL") & prop(" total ")')], { x: 1, y: 2, z: 3 });
scenario("names: the formula's own name belongs to another property", [prop("x", "Same", "number"), formula("a", "Same", 'prop("Same") + 1'), formula("b", "B", 'prop("Same")')], { x: 1 });
scenario("result types of formulas", [
  prop("n", "N", "number"),
  formula("a", "A", 'prop("N") > 1', { resultType: "boolean" }),
  formula("b", "B", 'IF(prop("A"), "big", "small")', { resultType: "string" }),
  formula("c", "C", "TODAY()", { resultType: "date" }),
  formula("d", "D", 'prop("C") < prop("N")'),
  formula("e", "E", 'prop("B") + 1'),
  formula("g", "G", 'YEAR(prop("C")) + prop("N")'),
  formula("h", "H", 'prop("A") + 1'),
], { n: 5 });
scenario("a stored result type that is no type", [formula("a", "A", "1", { resultType: "weird" }), formula("b", "B", 'prop("A") + 1'), formula("c", "C", 'prop("A") & ""'), formula("d", "D", 'NOT(prop("A"))'), formula("e", "E", 'YEAR(prop("A"))'), formula("g", "G", 'IF(true, prop("A"))')]);
scenario("row metadata", [prop("ca", "Created", "createdAt"), prop("le", "Edited", "lastEditedAt"), prop("lb", "By", "lastEditedBy"), formula("a", "A", 'prop("Created") & "|" & prop("Edited") & "|" & prop("By")'), formula("b", "B", 'DATEDIFF(prop("Created"), prop("Edited"), "hours")')]);
scenario("row metadata that is no date", [prop("ca", "Created", "createdAt"), prop("le", "Edited", "lastEditedAt"), formula("a", "A", 'ISBLANK(prop("Created")) & "|" & ISBLANK(prop("Edited"))'), formula("b", "B", 'YEAR(prop("Created"))')], {}, { createdAt: "garbage", updatedAt: "" });
scenario("row metadata as plain dates", [prop("ca", "Created", "createdAt"), prop("le", "Edited", "lastEditedAt"), formula("a", "A", 'prop("Created") & "|" & prop("Edited")')], {}, { createdAt: "2024-02-29", updatedAt: "Mar 5 2024 10:30" });
scenario("cells of the wrong type", [prop("n", "N", "number"), prop("t", "T", "text"), prop("d", "D", "date"), prop("c", "C", "checkbox"), formula("a", "A", 'ISBLANK(prop("N")) & ISBLANK(prop("T")) & ISBLANK(prop("D")) & prop("C")')], { n: "5", t: 5, d: 5, c: "true" });
scenario("properties named like built-ins", [prop("constructor", "K", "number"), prop("__proto__", "P", "text"), prop("toString", "S", "checkbox"), prop("hasOwnProperty", "H", "date"), formula("a", "A", 'ISBLANK(prop("K")) & ISBLANK(prop("P")) & prop("S") & ISBLANK(prop("H"))')]);
scenario("a property without an id", [prop("", "Blank", "number"), formula("a", "A", 'prop("Blank") + 1'), formula("b", "B", 'IFERROR(prop("Blank"), "caught")')], { "": 5 });
scenario("a formula without an id", [prop("n", "N", "number"), formula("", "Blank", 'prop("N") + 1'), formula("b", "B", 'IFERROR(prop("Blank"), "caught")')], { n: 5 });
scenario("types read as empty", [prop("s", "S", "select"), prop("m", "M", "multiSelect"), prop("p", "P", "person"), prop("f", "F", "file"), prop("g", "G", "page"), prop("r", "R", "rollup"), formula("a", "A", 'ISBLANK(prop("S")) and ISBLANK(prop("M")) and ISBLANK(prop("P")) and ISBLANK(prop("F")) and ISBLANK(prop("G")) and ISBLANK(prop("R"))')], { s: "x", m: ["x"], p: "u", f: [], g: "p", r: 1 });
for (const now of [NaN, 8.64e15, -8.64e15, 8.64e15 + 1, Date.parse("0050-06-15T12:00:00Z"), 0.5, -0.5, 1709632800123.75, Date.parse("2024-02-29T23:59:59.999Z"), Infinity]) {
  scenario(`now is ${enc(now)}`, [formula("a", "A", "NOW()"), formula("b", "B", "TODAY()"), formula("c", "C", "TONUMBER(NOW()) - TONUMBER(TODAY())"), formula("d", "D", 'FORMATDATE(NOW(), "YYYY-MM-DD HH:mm:ss")'), formula("e", "E", "YEAR(TODAY())")], {}, { now });
}
scenario("numbers are stored without float noise", [prop("n", "N", "number"), formula("a", "A", 'prop("N")'), formula("b", "B", 'prop("N") * 1'), formula("c", "C", 'IF(true, prop("N"))'), formula("d", "D", 'MIN(prop("N"), 1e300)')], { n: 0.1 + 0.2 });
scenario("a number too large for a cell", [formula("a", "A", "1e308 * 10"), formula("b", "B", "-1e308 * 10"), formula("c", "C", "1e308 * 10 - 1e308 * 10"), formula("d", "D", "MAX(1e308 * 10, 1)"), formula("e", "E", 'IF(true, -0)'), formula("g", "G", "0 * -1")]);
scenario("big numbers in cells", [prop("n", "N", "number"), formula("a", "A", 'prop("N")'), formula("b", "B", 'prop("N") + 1'), formula("c", "C", 'TOTEXT(prop("N"))')], { n: 12345678901234567890 });
scenario("text as long as REPEAT allows, joined", [formula("a", "A", 'REPEAT("x", 10000)'), formula("b", "B", 'LEN(prop("A") & prop("A") & prop("A"))'), formula("c", "C", 'LEN(SUBSTITUTE(prop("A"), "x", "yz"))'), formula("d", "D", 'LEN(UPPER(REPEAT("ß", 10000)))'), formula("e", "E", 'LEN(JOIN(prop("A"), 1, 2, 3))')]);

// ---------------------------------------------------------------------------
// compileFormula with other self ids and property sets: `[source, props, selfId, compilation]`

const compiles: unknown[] = [];
{
  const other = [prop("n", "N", "number"), formula("a", "A", 'prop("N") + 1', { resultType: "number", dependencies: ["n"] }), formula("b", "B", 'prop("A") + 1', { resultType: "number", dependencies: ["a"] }), formula("c", "C", 'prop("B") & prop("D")', { resultType: "string", dependencies: ["b", "d"] }), formula("d", "D", "1", { resultType: "number", dependencies: [] })];
  // Entries that are not ids are ignored; a list is all the TypeScript can take here.
  const sets: Record<string, Property[]> = { other, empty: [], loose: [formula("a", "A", "1", { dependencies: ["b", "b"] }), formula("b", "B", "1", { dependencies: [5, null, "c", ["a"]] }), formula("c", "C", "1", { dependencies: [] }), formula("d", "D", "1")] };
  const add = (source: string, set: string, selfId: string | null) => compiles.push([source, set, selfId, intern(compileOutcome(source, sets[set]!, selfId).text)]);
  for (const selfId of ["n", "a", "b", "c", "d", "zz", "", null]) {
    for (const source of ['prop("N")', 'prop("A")', 'prop("B")', 'prop("C")', 'prop("D")', 'prop("A") + prop("B")', 'prop("C") & prop("N") & prop("C")', "1", 'prop("D") + prop("N") + prop("D")']) add(source, "other", selfId);
  }
  for (const selfId of ["a", "b", "c", "d", null]) for (const source of ['prop("A")', 'prop("B")', 'prop("C")', 'prop("D")', 'prop("A") + prop("B") + prop("C") + prop("D")']) add(source, "loose", selfId);
  for (const source of ["1", 'prop("N")', "", "NOW()"]) add(source, "empty", "f");
  templates.sets = Object.fromEntries(Object.entries(sets).map(([name, props]) => [name, props.map(compact)]));
}

// ---------------------------------------------------------------------------
// renameInSource: `[source, old name, new name, result]`

const renames: unknown[] = [];
for (const [source, oldName, newName] of [
  ['prop("Amount") + prop( "amount" ) & "Amount"', "Amount", 'Total "net"'],
  ['prop("Amount")', "Amount", "Sum"],
  ['prop("Amount")', "amount", "Sum"],
  ['prop("Amount")', " AMOUNT ", "Sum"],
  ['prop(" Amount ")', "Amount", "Sum"],
  ["prop('Amount')", "Amount", "It's"],
  ["PROP ( 'Amount' )", "Amount", "Sum"],
  ['prop("Amount") + prop("Amount2")', "Amount", "Sum"],
  ['prop("Amount")+prop("Amount")*prop("Other")', "Amount", "Sum"],
  ['"prop(\\"Amount\\")" & prop("Amount")', "Amount", "Sum"],
  ['prop("Amount"', "Amount", "Sum"],
  ['prop("Amount" + 1', "Amount", "Sum"],
  ['prop "Amount"', "Amount", "Sum"],
  ['prop(("Amount"))', "Amount", "Sum"],
  ['props("Amount")', "Amount", "Sum"],
  ['prop("Amount") @', "Amount", "Sum"],
  ['prop("Amount) + 1', "Amount", "Sum"],
  ['prop("A\\"mount")', 'A"mount', "Sum"],
  ['prop("A\\nmount")', "A\nmount", "Tab\there \\ slash"],
  ['prop("Amount")', "Amount", "Line\nbreak \u0001 \u007f  "],
  ['prop("Amount")', "Amount", `${emoji} é`],
  [`prop("${emoji}") + "${emoji}" & prop('${emoji}')`, emoji, "plain"],
  [`"${emoji}" & prop("x") & "${emoji}" & prop("x")`, "x", emoji],
  ['prop("")', "", "Sum"],
  ['prop("  ")', "", "Sum"],
  ['prop("Amount")', "", "Sum"],
  ['prop("ÄRGER")', "ärger", "ok"],
  ['prop("STRASSE")', "straße", "ok"],
  ['prop("İ")', "i̇", "ok"],
  ['prop("Amount") prop("Amount") prop("Amount")', "Amount", ""],
  ["", "Amount", "Sum"],
  ["1 + 2", "Amount", "Sum"],
  ['  prop(\n"Amount"\n)  ', "Amount", "Sum"],
  ['prop("Amount", "Amount")', "Amount", "Sum"],
  ['IF(prop("Done"), prop("Amount"), prop("amount "))', "Amount", "A, B"],
] as const) {
  renames.push([source, oldName, newName, renameInSource(source, oldName, newName)]);
}

// ---------------------------------------------------------------------------
// affectedFormulas: `[property set, changed ids, result]`

const affected: unknown[] = [];
const graphs: Record<string, Property[]> = {
  line: [prop("n", "N", "number"), formula("a", "A", "", { dependencies: ["n"] }), formula("b", "B", "", { dependencies: ["a"] }), formula("c", "C", "", { dependencies: ["b"] })],
  diamond: [formula("d", "D", "", { dependencies: ["b", "c"] }), formula("c", "C", "", { dependencies: ["a"] }), formula("b", "B", "", { dependencies: ["a"] }), formula("a", "A", "", { dependencies: ["n"] }), prop("n", "N", "number")],
  loop: [formula("a", "A", "", { dependencies: ["b"] }), formula("b", "B", "", { dependencies: ["c"] }), formula("c", "C", "", { dependencies: ["a", "n"] }), prop("n", "N", "number")],
  loose: [formula("a", "A", ""), formula("b", "B", "", { dependencies: [] }), formula("c", "C", "", { dependencies: [5, null, "a"] }), prop("d", "D", "number", { dependencies: ["a"] }), formula("a", "A2", "", { dependencies: ["c"] })],
};
{
  const random = seeded(11);
  const wide: Property[] = Array.from({ length: 30 }, (_, i) => (i < 6 ? prop(`p${i}`, `P${i}`, "number") : formula(`p${i}`, `P${i}`, "", { dependencies: Array.from({ length: int(random, 0, 4) }, () => `p${int(random, 0, 29)}`) })));
  graphs.wide = wide;
  for (const [name, props] of Object.entries(graphs)) {
    const ids = [...new Set(props.map((p) => p.id)), "zz"];
    for (const id of ids) affected.push([name, [id], affectedFormulas(props, [id])]);
    affected.push([name, [], affectedFormulas(props, [])]);
    affected.push([name, ids, affectedFormulas(props, ids)]);
    for (let i = 0; i < 12; i++) {
      const changed = Array.from({ length: int(random, 1, 4) }, () => pick(random, ids));
      affected.push([name, changed, affectedFormulas(props, changed)]);
    }
  }
}

// ---------------------------------------------------------------------------
// isErrorValue

const errorValues = [{ error: "VALUE", message: "m" }, { error: "VALUE" }, { message: "m" }, { error: 1, message: "m" }, { error: "E", message: 2 }, { error: "", message: "" }, { error: "E", message: "m", more: 1 }, null, 0, "", "error", [], [{ error: "E", message: "m" }], {}, true].map(
  (value) => [value, isErrorValue(value)],
);

// ---------------------------------------------------------------------------
// toUpperCase and toLowerCase of every character they change: `[code point, result]`

const caseMap = (convert: (s: string) => string): [number, string][] => {
  const changed: [number, string][] = [];
  for (let code = 0; code <= 0x10ffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const ch = String.fromCodePoint(code);
    const result = convert(ch);
    if (result !== ch) changed.push([code, result]);
  }
  return changed;
};
const upper = caseMap((s) => s.toUpperCase());
const lower = caseMap((s) => s.toLowerCase());

const fixture = {
  now: enc(NOW),
  unicode: process.versions.unicode,
  upper,
  lower,
  functions: Object.keys(FUNCTIONS),
  outcomes,
  base: BASE.map(compact),
  rows: ROWS.map((row) => ({ ...row, cells: encode(row.cells) })),
  cases,
  pool: POOL,
  calls,
  templates,
  fuzz,
  scenarios,
  compiles,
  renames,
  affected,
  graphs: Object.fromEntries(Object.entries(graphs).map(([name, props]) => [name, props.map(compact)])),
  errorValues,
};
await Bun.write(path.join(import.meta.dir, "formula.json"), JSON.stringify(fixture) + "\n");
const count = (list: unknown[], at: number) => list.reduce<number>((n, item) => n + (item as unknown[][])[at]!.length, 0);
if (outcomes.some((o) => o.startsWith("!!"))) throw new Error(`a compilation threw something other than a syntax error: ${outcomes.find((o) => o.startsWith("!!"))}`);
const templateCount = ["numbers", "dates", "texts"].reduce((n, key) => {
  const group = templates[key] as { tuples: unknown[]; results: unknown[] };
  return n + group.tuples.length * group.results.length;
}, 0);
console.log(
  `formula.json: ${cases.length} written cases, ${count(calls, 2)} calls and operators, ${templateCount} template values, ${fuzz.length} random expressions, ${scenarios.length} scenarios, ${compiles.length} compilations, ${renames.length} renames, ${affected.length} dependency queries; ${outcomes.length} distinct outcomes`,
);
