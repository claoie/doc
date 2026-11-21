// Writes bases.json: what the runtime code of common/bases.ts answers, for
// tests/bases.rs to hold common/bases.rs to.
//
//   bun src/server-rs/tests/fixtures/gen-bases.ts
//
// Results are written as text so they compare exactly: `=<JSON>` for a
// value, `u` for `undefined`, `!<message>` for a thrown error. Inputs go
// through `encode`, which spells numbers exactly (`{"$n": "0.1"}`), long
// repeated strings as a recipe (`{"$repeat": [prefix, unit, count, suffix]}`)
// and objects as their entries (`{"$o": [[key, value], ...]}`), so nothing
// depends on how a JSON parser reads numbers or orders keys.
import path from "node:path";
import {
  CHOICE_COLORS,
  DATE_RANGES,
  DEFAULT_STATUS_CHOICES,
  FILTER_OPERATORS,
  LIMITS,
  NO_VALUE,
  OPERATORS_BY_KIND,
  PROPERTY_TYPES,
  RELATIVE_DAYS,
  SYSTEM_TYPES,
  VIEW_TYPES,
  cellText,
  columnKind,
  convertCell,
  dateRange,
  isChoiceType,
  isEditableType,
  isFilterGroup,
  isSystemType,
  normalizeCell,
  normalizeCells,
} from "common/bases";
import type { Choice, Property, PropertyOptions, PropertyType, TextContext } from "common/bases";
import { enc, int, pick, seeded } from "./rng";

// Dates without an offset are local time; the fixtures are made with UTC as the local zone.
process.env.TZ = "UTC";
if (new Date(0).getTimezoneOffset() !== 0 || new Date(Date.UTC(2024, 6, 1)).getTimezoneOffset() !== 0) throw new Error("could not make UTC the local zone");

// ---------------------------------------------------------------------------
// Encoding

const recipes = new Map<string, [string, string, number, string]>();
/** A long string made of a repeated unit; the fixture stores how to make it instead of the string. */
const long = (unit: string, count: number, prefix = "", suffix = ""): string => {
  const s = prefix + unit.repeat(count) + suffix;
  recipes.set(s, [prefix, unit, count, suffix]);
  return s;
};
const encode = (value: unknown): unknown => {
  if (typeof value === "number") return { $n: enc(value) };
  if (typeof value === "string") return recipes.has(value) ? { $repeat: recipes.get(value) } : value;
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return { $o: Object.entries(value).map(([k, v]) => [k, encode(v)]) };
  return value;
};
/**
 * A patch as a request body could list it: JavaScript moves keys that are
 * array indexes to the front, in ascending order, wherever the body had
 * them. Here they come last and descending, so the port has to reorder.
 */
const encodeReversed = (patch: Record<string, unknown>): unknown => {
  const entries = Object.entries(patch).map(([k, v]) => [k, encode(v)] as [string, unknown]);
  const isIndex = ([k]: [string, unknown]) => String(Number(k) >>> 0) === k && Number(k) !== 4294967295;
  return { $o: [...entries.filter((e) => !isIndex(e)), ...entries.filter(isIndex).reverse()] };
};
/** Long results are compared by length and both ends (in code points). */
const digest = (json: string): string => {
  const points = [...json];
  return points.length > 400 ? `#${points.length}:${points.slice(0, 60).join("")}…${points.slice(-60).join("")}` : json;
};
const outcome = (f: () => unknown): string => {
  try {
    const value = f();
    return value === undefined ? "u" : `=${digest(JSON.stringify(value))}`;
  } catch (e) {
    return `!${(e as Error).message}`;
  }
};

// ---------------------------------------------------------------------------
// Properties

/** A property; the type and the options need not be ones the TypeScript types allow. */
const prop = (id: string, name: string, type: string, options: Record<string, unknown> = {}): Property => ({ id, name, type: type as PropertyType, options: options as PropertyOptions, isPrimary: false, position: id });
const choices: Choice[] = [
  { id: "c1", name: "One", color: "gray" },
  { id: "c2", name: "Two", color: "red" },
  { id: "c3", name: "", color: "blue" },
  { id: "😀", name: "Emoji 😀", color: "x" },
  { id: "c5", name: "With, comma", color: "green", category: "todo" },
];
const PROPS: Property[] = [
  prop("text", "Text", "text"),
  prop("long", "Long \"quoted\" name", "longText"),
  prop("num", "Number", "number", { format: "plain" }),
  prop("sel", "Select", "select", { choices, choiceOrder: choices.map((c) => c.id) }),
  prop("stat", "Status", "status", { choices: DEFAULT_STATUS_CHOICES }),
  prop("multi", "Multi", "multiSelect", { choices }),
  prop("date", "Date", "date", { includeTime: false }),
  prop("who", "Person", "person", { allowMultiple: false }),
  prop("team", "People", "person", { allowMultiple: true }),
  prop("crew", "People too", "person", { allowMultiple: "yes" }),
  prop("file", "Files", "file"),
  prop("page", "Page", "page"),
  prop("check", "Checkbox", "checkbox"),
  prop("url", "Link", "url"),
  prop("mail", "Email", "email"),
  prop("made", "Created", "createdAt"),
  prop("edited", "Edited", "lastEditedAt"),
  prop("editor", "Edited by", "lastEditedBy"),
  prop("calc", "Formula", "formula", { source: "1", resultType: "number", dependencies: [] }),
  prop("odd", "Unknown type", "rollup"),
  prop("bare", "Select without choices", "select"),
  prop("none", "Multi with no choices", "multiSelect", { choices: [] }),
  prop("solo", "Person, default options", "person"),
];

const emoji = "😀";
const VALUES: unknown[] = [
  null, "", " ", "abc", "  padded  ", " nb ", "﻿", "line\nbreak", "0", "1", "-1.5", "1e3", "0x10", " 12 ", "1,000", "1 000", "Infinity", "-Infinity", "NaN", "1e400", ".5", "5.", "+7", "--1", "١٢",
  "true", "TRUE", " Yes ", "on", "off", "no", "false", "0.0", "checked", "y", "N", "tRuE", "ja",
  0, 1, -1, 1.5, -0, 1e21, 1e-7, 123456789012345680000, 0.1 + 0.2, 2 ** 53, -2.5e-10, 1e300,
  true, false,
  [], [""], ["c1"], ["c1", "c2"], ["c2", "c1", "c2"], ["zz"], ["c1", 5, null, "c2", "", "c1"], [null], [[]], [["c1"]], [5], [true], ["u1", "u3"], [emoji], ["status-done"], ["a", "b"], [1, 2], [1.5],
  {}, { a: 1 }, { id: "c1" }, { error: "VALUE", message: "x" }, { error: 1 }, { mode: "exact" },
  "c1", "c2", "c3", "c5", "zz", emoji, "status-todo", "u1", "u2", "u3", "p1", "p2", "p3", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf",
  "2024-03-05", "2024-03-05T10:00:00Z", "2024-03-05T10:00:00", "Mar 5 2024", "3/5/2024", "tomorrow", "2024-02-30", "12", " 2024-03-05 ", 20240305, "2024-13-01", "10:30", "5", "0", "99", "Thursday",
  "a@b.c", "a@b", " a@b.co ", "a b@c.d", "a@b@c.d", "@b.c", "a@.c", "a@b.", "a@b..c", "a@.b.c", "ä@ö.ü", "a@b.c\n", "a b@c.d", "a @b.c",
  "http://x.y", "HTTPS://X", "ftp://x", "mailto:a@b", "tel:123", "http://a b", "http://", "x http://y", "Http://ä", "http://a　b", "mailto:", "TEL:+1", "https:/x", "javascript:alert(1)",
  long("x", 64), long("x", 65), long(emoji, 32), long(emoji, 33), long("x", 2000), long("x", 2001), long(emoji, 1000), long(emoji, 999, "a"), long("x", 100_000), long("x", 100_001),
  long(emoji, 50_000), long(emoji, 50_000, "a"), long("x", 2041, "http://"), long("x", 2042, "http://"), long("x", 310, "a@b.", "end"), long("x", 320, "a@b."), long("1", 400), long(" ", 300, "", "7"),
];

const FILES: unknown[] = [
  [{ id: "f1", fileName: "a.png" }],
  [{ id: "f1", fileName: "a.png", mimeType: "image/png", fileSize: 12.5, url: "/files/f1" }, { fileName: "b", id: "f2", extra: true, url: "u" }],
  [{ url: "u", fileSize: 1, mimeType: "m", fileName: "n", id: "i" }],
  [{ id: "f1", fileName: "" }],
  [{ id: "f1" }],
  [{ fileName: "a" }],
  [{ id: "", fileName: "a" }],
  [{ id: 5, fileName: "a" }],
  [{ id: long("i", 128), fileName: long("n", 1024) }],
  [{ id: long("i", 129), fileName: "a" }],
  [{ id: long(emoji, 64), fileName: long(emoji, 512) }],
  [{ id: long(emoji, 64, "a"), fileName: "a" }],
  [{ id: "f1", fileName: long("n", 1025) }],
  [{ id: "f1", fileName: 7 }],
  [{ id: "f1", fileName: "a", url: null }],
  [{ id: "f1", fileName: "a", url: 5 }],
  [{ id: "f1", fileName: "a", url: long("u", 2048) }],
  [{ id: "f1", fileName: "a", url: long("u", 2049) }],
  [{ id: "f1", fileName: "a", mimeType: 5, fileSize: "big" }],
  [{ id: "f1", fileName: "a", mimeType: null, fileSize: null }],
  [{ id: "f1", fileName: "a", fileSize: 1e21 }],
  [null],
  ["x"],
  [[]],
  [5],
  [false],
  [{}],
  [{ id: "f1", fileName: "a" }, null],
  [{ id: "f1", fileName: "a" }, { id: "f1", fileName: "a" }],
  Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, fileName: `n${i}` })),
  Array.from({ length: 101 }, (_, i) => ({ id: `f${i}`, fileName: `n${i}` })),
  Array.from({ length: 101 }, () => null),
  { id: "f1", fileName: "a" },
  "f1",
];

// ---------------------------------------------------------------------------
// normalizeCell: every property against every value

// `[property id, index into the values, outcome]`; index -1 is `undefined`.
const ALL_VALUES = [...VALUES, ...FILES];
const normalize: unknown[] = [];
for (const p of PROPS) {
  ALL_VALUES.forEach((value, index) => {
    if (index < VALUES.length + 3 || p.type === "file") normalize.push([p.id, index, outcome(() => normalizeCell(p, value))]);
  });
  normalize.push([p.id, -1, outcome(() => normalizeCell(p, undefined))]);
}

// ---------------------------------------------------------------------------
// normalizeCells: patches, key order, defaults

const ORDER_PROPS: Property[] = ["b", "10", "a", "2", "01", "4294967294", "4294967295", "-1", "1.5"].map((id) => prop(id, `Text ${id}`, "text"));
const withDefault = (id: string, type: string, defaultValue: unknown, options: Record<string, unknown> = {}) => prop(id, `Default ${id}`, type, { ...options, defaultValue });
const DEFAULT_PROPS: Property[] = [
  withDefault("d1", "text", "dflt"),
  withDefault("d2", "number", 5),
  withDefault("d3", "number", "abc"),
  withDefault("d4", "select", "c1", { choices }),
  withDefault("d5", "select", "gone", { choices }),
  withDefault("d6", "checkbox", false),
  withDefault("d7", "date", "today"),
  withDefault("d8", "date", "2024-03-05"),
  withDefault("d9", "text", ""),
  withDefault("d10", "text", null),
  withDefault("d11", "multiSelect", ["c1", "c2"], { choices }),
  withDefault("d12", "person", "u1"),
  withDefault("d13", "formula", 1),
  withDefault("d14", "text", 0),
  withDefault("d15", "checkbox", "maybe"),
  withDefault("d16", "multiSelect", [], { choices }),
  withDefault("d17", "url", "  http://x  "),
  withDefault("d18", "number", " "),
  withDefault("d19", "createdAt", "x"),
  withDefault("d20", "rollup", "x"),
  withDefault("d1", "number", 99),
  withDefault("d21", "text", [1, 2]),
  withDefault("d22", "number", true),
  withDefault("d23", "file", [{ id: "f", fileName: "n" }]),
  withDefault("d24", "select", ""),
  withDefault("d25", "text", undefined),
];
const PROP_SETS: Record<string, Property[]> = { all: PROPS, order: ORDER_PROPS, defaults: DEFAULT_PROPS, both: [...PROPS, ...DEFAULT_PROPS], none: [] };
const patches: [string, Record<string, unknown>][] = [
  ["all", {}],
  ["all", { text: "a", num: "5", check: "yes", nope: 1 }],
  ["all", { num: "x", text: "a" }],
  ["all", { text: "a", num: "x" }],
  ["all", { made: "x", edited: "y", editor: "z", calc: 5, odd: 1 }],
  ["all", { text: null, num: null, sel: null, multi: null, check: null, file: null, made: null, odd: null }],
  ["all", { sel: ["c2"], multi: "c1", who: ["u1", "u2"], team: "u1", crew: ["u1", "u1", "u2"], page: " p1 ", date: " 2024-03-05 ", url: " http://x ", mail: " a@b.c " }],
  ["all", { file: FILES[1], long: long("y", 500) }],
  ["all", { sel: "zz", multi: ["zz"] }],
  ["all", { multi: ["c1", "zz"], sel: "c1" }],
  ["order", { b: 1, "10": "x", a: null, "2": "y", "01": "z", zz: 1, "4294967294": "p", "4294967295": "q", "-1": "m", "1.5": "n" }],
  ["order", { b: long("x", 100_001), "2": long("y", 100_001), "10": long("z", 100_001) }],
  ["order", { a: long("x", 100_001), b: long("y", 100_001) }],
  ["order", { "01": "first", "1.5": "second", "-1": "third", b: "fourth", "10": "fifth", "2": "sixth" }],
  ["defaults", {}],
  ["defaults", { d1: null, d2: null, d4: null, d6: null }],
  ["defaults", { d1: "given", d2: 0, d6: true, d11: [], d12: "" }],
  ["defaults", { d5: "c2", d7: "2020-01-01", d3: 4 }],
  ["defaults", { d3: "bad" }],
  ["both", { text: "t", d8: "tomorrow" }],
  ["both", { text: "t", num: 1.5, d2: "7" }],
  ["none", { a: 1 }],
];
const cells: unknown[] = [];
for (const [set, patch] of patches) {
  for (const applyDefaults of [false, true]) cells.push([set, encodeReversed(patch), applyDefaults, outcome(() => normalizeCells(PROP_SETS[set]!, patch, applyDefaults))]);
}
{
  const random = seeded(31);
  const ids = PROPS.map((p) => p.id);
  for (let i = 0; i < 250; i++) {
    const patch: Record<string, unknown> = {};
    for (let k = int(random, 1, 6); k > 0; k--) patch[random() < 0.1 ? "unknown" : pick(random, ids)] = pick(random, VALUES.slice(0, 115));
    const applyDefaults = random() < 0.5;
    cells.push(["both", encodeReversed(patch), applyDefaults, outcome(() => normalizeCells(PROP_SETS.both!, patch, applyDefaults))]);
  }
}

// ---------------------------------------------------------------------------
// cellText

type Row = { createdAt: string; updatedAt: string; creatorId: string | null; lastEditorId: string | null };
const ROWS: Row[] = [
  { createdAt: "2026-01-05T10:00:00.000Z", updatedAt: "2026-01-06T11:30:00.000Z", creatorId: "u1", lastEditorId: null },
  { createdAt: "2026-01-05T10:00:00.000Z", updatedAt: "2026-01-06T11:30:00.000Z", creatorId: "u1", lastEditorId: "u3" },
  { createdAt: "", updatedAt: "not a date", creatorId: null, lastEditorId: null },
  { createdAt: "c", updatedAt: "u", creatorId: "constructor", lastEditorId: null },
  { createdAt: "c", updatedAt: "u", creatorId: "u1", lastEditorId: "nobody" },
  { createdAt: "c", updatedAt: "u", creatorId: "u1", lastEditorId: "" },
  { createdAt: "c", updatedAt: "u", creatorId: "u1", lastEditorId: "u2" },
];
// As the server builds it: plain objects keyed by id.
const CTX = {
  users: { u1: { name: "Ann" }, u2: { name: "" }, u3: { name: "Bob, Jr." } },
  pages: { p1: { title: "Home" }, p2: { title: null }, p3: { title: "" } },
} satisfies TextContext;
const EMPTY_CTX = { users: {}, pages: {} } satisfies TextContext;
// `[property id, index into the values (-1: undefined), row, outcome]`, then
// the cases where the names are unknown: `[property id, index, outcome]`.
const TEXT_EXTRA = [[{ fileName: 5 }, { fileName: 0 }, { fileName: ["a", "b"] }, { fileName: {} }, { fileName: true }, "s", 7]];
const TEXT_VALUES = [...ALL_VALUES, ...TEXT_EXTRA];
const text: unknown[] = [];
const textUnknown: unknown[] = [];
for (const p of PROPS) {
  TEXT_VALUES.forEach((value, index) => {
    if (typeof value === "string" && value.length > 3000) return;
    if (index >= VALUES.length + 8 && p.type !== "file" && p.type !== "text") return;
    text.push([p.id, index, 0, outcome(() => cellText(p, value, ROWS[0]!, CTX))]);
    if (["person", "page", "lastEditedBy"].includes(p.type) && (typeof value === "string" || Array.isArray(value))) textUnknown.push([p.id, index, outcome(() => cellText(p, value, ROWS[0]!, EMPTY_CTX))]);
  });
  text.push([p.id, -1, 0, outcome(() => cellText(p, undefined, ROWS[0]!, CTX))]);
  const u3 = VALUES.indexOf("u3");
  for (let row = 1; row < ROWS.length; row++) text.push([p.id, u3, row, outcome(() => cellText(p, "u3", ROWS[row]!, CTX))]);
}

// ---------------------------------------------------------------------------
// convertCell: every property to every type

const TARGETS: [string, PropertyOptions][] = [
  ...PROPERTY_TYPES.filter((t) => !isChoiceType(t) && t !== "person").map((t): [string, PropertyOptions] => [t, {}]),
  ["select", { choices }],
  ["select", { choices: [choices[1]!] }],
  ["select", {}],
  ["status", { choices: DEFAULT_STATUS_CHOICES }],
  ["status", { choices }],
  ["multiSelect", { choices }],
  ["multiSelect", { choices: [choices[1]!, choices[0]!] }],
  ["multiSelect", { choices: [] }],
  ["person", {}],
  ["person", { allowMultiple: true }],
  ["rollup", {}],
];
const STORED: Record<string, unknown[]> = {
  text: ["abc", " 12 ", "1,234.5", "yes", "No", "2024-03-05", "Mar 5 2024 10:00", "http://x.y", " a@b.c ", "c1", "u1", "", " ", "true", "0", "1e3", "Infinity", "tomorrow", "checked", "y", long("x", 2001), long(emoji, 1000, "a"), long(emoji, 1001), " 1 000 "],
  num: [0, 1, -1, 1.5, 0.1 + 0.2, 1e21, 123456789012345680000, 20240305, 1e-7, -0],
  sel: ["c1", "c2", "c3", "c5", "zz", emoji, ["c1"], 5],
  stat: ["status-todo", "status-done", "c1", "zz"],
  multi: [["c1", "c2"], ["c2", "c1", "c2", "zz"], ["zz"], [], "c1", ["c3"], [emoji, "c5"], ["c5", "c1"]],
  date: ["2024-03-05", "2024-03-05T10:00:00Z", "Mar 5 2024", "12", "garbage", " 2024-03-05 "],
  who: ["u1", "u2", "u3", "zz", ["u1", "u3"], long("u", 65), "constructor", "", ["u1", long("u", 65)]],
  team: [["u1", "u3"], ["u2"], ["zz", "u1"], "u1", [], ["u1", "u1"], [long("u", 64)]],
  file: [FILES[0], FILES[1], [], [{ id: "f", fileName: "http://x.y" }], [{ id: "f", fileName: "12" }]],
  page: ["p1", "p2", "p3", "zz", "constructor", ["p1"]],
  check: [true, false],
  url: ["http://x.y", "mailto:a@b.c", "12"],
  mail: ["a@b.c", "x"],
  made: ["x", 5],
  edited: ["x"],
  editor: ["x", "u1"],
  calc: [5, 1.5, "abc", "12", true, false, { error: "VALUE", message: "m" }, "2024-03-05", 0, "", { other: 1 }, [1, 2]],
  odd: ["x", 5, true, ["a"], { a: 1 }],
  long: ["multi\nline", "  7  "],
};
STORED.crew = STORED.team!;
STORED.solo = STORED.who!;
STORED.bare = STORED.sel!;
STORED.none = STORED.multi!;
// `[from property id, stored value, outcome per target]`; a missing value is `undefined`.
const convert: unknown[] = [];
for (const from of PROPS) {
  for (const value of [...STORED[from.id]!, null]) {
    convert.push([from.id, encode(value), TARGETS.map(([type, options]) => outcome(() => convertCell(value, from, { type: type as PropertyType, options }, ROWS[1]!, CTX)))]);
  }
  convert.push([from.id, TARGETS.map(([type, options]) => outcome(() => convertCell(undefined, from, { type: type as PropertyType, options }, ROWS[1]!, CTX)))]);
}

// ---------------------------------------------------------------------------
// dateRange

const at = (iso: string) => Date.parse(iso);
const NOWS = [
  at("2024-01-01T00:00:00.000Z"), at("2024-02-29T23:59:59.999Z"), at("2024-03-31T12:00:00Z"), at("2023-12-31T23:30:00Z"), at("2024-12-30T08:00:00Z"), at("2024-03-10T00:00:00Z"), at("2024-03-11T00:00:00Z"),
  at("2025-01-31T06:00:00Z"), at("2024-05-31T18:45:00Z"), at("2021-01-01T04:59:59Z"), at("1970-01-01T00:00:00Z"), at("1969-12-31T23:59:59.999Z"), at("0099-12-31T20:00:00Z"), at("0050-06-15T00:00:00Z"),
  at("0000-01-01T00:00:00Z"), at("-000001-12-31T12:00:00Z"), 8.64e15, -8.64e15, 8.64e15 - 86_400_000, 8.64e15 + 1, NaN, 1709632800123.75,
];
const OFFSETS = [0, -900, -720, -330, -300, -60, 1, 60, 330, 345, 720, 900, 0.5, NaN];
const presets: unknown[] = [...RELATIVE_DAYS.map((preset) => ({ mode: "relative", preset })), ...DATE_RANGES.map((preset) => ({ mode: "range", preset }))];
const exactDates: unknown[] = [
  "2024-03-05", "2024-03-05T23:30:00Z", "2024-03-05T23:30:00", "2024-03-05T23:30:00-08:00", "2024-02-30", "2024-13-45", "2024-00-00", "0050-01-01", "0099-12-31", "0100-01-01", "9999-12-31", "2024-03-05garbage",
  "2024-3-5", " 2024-03-05", "Mar 5 2024", "Mar 5 2024 23:30 PST", "3/5/2024", "5", "12", "", "garbage", "+275760-09-13", "-271821-04-20", "+275760-09-13T00:00:00Z", "275760-09-13", "0000-01-01",
  { mode: "exact", date: "2024-03-05" }, { mode: "exact", date: "Mar 5 2024 23:30" }, { mode: "exact", date: "nope" }, { mode: "exact" }, { mode: "exact", date: null }, { mode: "exact", date: 5 },
  { mode: "exact", date: 20240305 }, { mode: "exact", date: ["2024-03-05"] }, { mode: "exact", date: true }, { mode: "exact", date: {} }, { mode: "exact", date: "" }, { mode: "exact", date: "2024-03-05", preset: "today" },
];
const invalid: unknown[] = [
  null, 5, 0, true, false, [], ["2024-03-05"], {}, { mode: "relative" }, { mode: "relative", preset: "nope" }, { mode: "relative", preset: "thisWeek" }, { mode: "range", preset: "today" }, { mode: "range" },
  { mode: "x", preset: "today" }, { preset: "today" }, { mode: 5 }, { mode: "relative", preset: 5 }, { mode: "range", preset: null }, { mode: ["relative"], preset: "today" }, { mode: "Relative", preset: "today" },
];
// `[value, [index of now, index of offset or null for the default, "start,end" or null]...]`
const RANGE_VALUES = [...presets, ...exactDates, ...invalid];
const ranges: unknown[] = [];
RANGE_VALUES.forEach((value, index) => {
  const results: unknown[] = [];
  const range = (now: number, offset: number | undefined) => {
    const result = offset === undefined ? dateRange(value, NOWS[now]!) : dateRange(value, NOWS[now]!, OFFSETS[offset]!);
    results.push([now, offset ?? null, result ? `${enc(result[0])},${enc(result[1])}` : null]);
  };
  const nows = index < presets.length ? NOWS.map((_, i) => i) : index < presets.length + exactDates.length ? [0, 12, 20] : [0];
  for (const now of nows) for (let offset = 0; offset < OFFSETS.length; offset++) range(now, offset);
  for (let now = 0; now < NOWS.length; now += 5) range(now, undefined);
  ranges.push([encode(value), results]);
});
{
  const results: unknown[] = [];
  for (let offset = 0; offset < OFFSETS.length; offset++) results.push([0, offset, dateRange(undefined, NOWS[0]!, OFFSETS[offset]!)]);
  ranges.push([results]);
}

// ---------------------------------------------------------------------------
// Constants and classifications

const kinds: unknown[] = [];
for (const p of [...PROPS, ...["number", "boolean", "date", "string", "null", "other", undefined, 5].map((resultType, i) => prop(`k${i}`, "K", "formula", { resultType })), prop("pm", "P", "person", { allowMultiple: 1 }), prop("p0", "P", "person", { allowMultiple: 0 }), prop("pn", "P", "person", { allowMultiple: null })]) {
  kinds.push([p, columnKind(p)]);
}
const types = [...PROPERTY_TYPES, "rollup", ""];
const fixture = {
  constants: { PROPERTY_TYPES, SYSTEM_TYPES, VIEW_TYPES, FILTER_OPERATORS, RELATIVE_DAYS, DATE_RANGES, LIMITS, OPERATORS_BY_KIND, DEFAULT_STATUS_CHOICES, NO_VALUE, CHOICE_COLORS },
  types: types.map((t) => [t, isSystemType(t as PropertyType), isEditableType(t as PropertyType), isChoiceType(t as PropertyType)]),
  filterGroups: [{ op: "and", children: [] }, { propertyId: "a", op: "eq" }, { children: null }, {}].map((node) => [node, isFilterGroup(node as never)]),
  props: PROP_SETS,
  rows: ROWS,
  ctx: { users: Object.fromEntries(Object.entries(CTX.users).map(([id, u]) => [id, u.name])), pages: Object.fromEntries(Object.entries(CTX.pages).map(([id, p]) => [id, p.title])) },
  values: TEXT_VALUES.map(encode),
  normalize,
  cells,
  text,
  textUnknown,
  targets: TARGETS,
  convert,
  nows: NOWS.map(enc),
  offsets: OFFSETS.map(enc),
  ranges,
  kinds,
};
await Bun.write(path.join(import.meta.dir, "bases.json"), JSON.stringify(fixture) + "\n");
const count = (list: unknown[], at: number) => list.reduce<number>((n, item) => n + ((item as unknown[][])[at]?.length ?? 0), 0);
console.log(
  `bases.json: ${normalize.length} normalizeCell, ${cells.length} normalizeCells, ${text.length + textUnknown.length} cellText, ${count(convert, 2) + count(convert, 1)} convertCell, ${count(ranges, 1) + OFFSETS.length} dateRange, ${kinds.length} columnKind`,
);
