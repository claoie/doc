import { describe, expect, test } from "bun:test";
import type { Property } from "./bases";
import { compileFormula, computeFormulas, renameInSource } from "./formula";

const prop = (id: string, name: string, type: Property["type"], options: Property["options"] = {}): Property => ({
  id,
  name,
  type,
  options,
  isPrimary: false,
  position: id,
});

const meta = { createdAt: "2026-01-05T10:00:00.000Z", updatedAt: "2026-01-06T10:00:00.000Z" };

/** Compiles `source` as formula `f` over `others` and evaluates it for one row. */
const run = (source: string, cells: Record<string, unknown> = {}, others: Property[] = []) => {
  const compiled = compileFormula(source, others, "f");
  const f = prop("f", "F", "formula", { source, resultType: compiled.resultType, dependencies: compiled.dependencies });
  return computeFormulas([...others, f], cells, meta, undefined, Date.parse("2026-03-10T12:00:00Z")).f;
};

const props = [
  prop("n", "Amount", "number"),
  prop("t", "Name", "text"),
  prop("d", "Due", "date"),
  prop("c", "Done", "checkbox"),
  prop("s", "Stage", "select", { choices: [{ id: "x", name: "X", color: "gray" }] }),
  prop("ca", "Created", "createdAt"),
];

describe("formula syntax", () => {
  test("operator precedence", () => {
    expect(run("1 + 2 * 3")).toBe(7);
    expect(run("-2^2")).toBe(-4);
    expect(run("(-2)^2")).toBe(4);
    expect(run("2^3^2")).toBe(512);
    expect(run("2^-1")).toBe(0.5);
    expect(run("1 < 2 and not false")).toBe(true);
    expect(run("1 = 2 or 2 <> 3")).toBe(true);
  });

  test("float results are snapped", () => {
    expect(run("0.1 + 0.2")).toBe(0.3);
  });

  test("names are case-insensitive and literals have aliases", () => {
    expect(run('if(TRUE, "a", "b")')).toBe("a");
    expect(run("isblank(blank)")).toBe(true);
    expect(run("isBlank(Empty)")).toBe(true);
  });

  test("strings support both quotes and escapes", () => {
    expect(run(`'it\\'s' & "\\"q\\""`)).toBe(`it's"q"`);
  });

  test("errors name the problem", () => {
    expect(() => compileFormula("", props, "f")).toThrow("Formula is empty");
    expect(() => compileFormula("1 +", props, "f")).toThrow("The formula ended unexpectedly");
    expect(() => compileFormula("1 + @", props, "f")).toThrow('Unexpected character "@"');
    expect(() => compileFormula("Amount", props, "f")).toThrow('Unknown name "Amount"');
    expect(() => compileFormula("prop(Amount)", props, "f")).toThrow("prop() takes a property name in quotes");
    expect(() => compileFormula('prop("Nope")', props, "f")).toThrow('No property named "Nope"');
    expect(() => compileFormula("FOO(1)", props, "f")).toThrow('Unknown function "FOO"');
    expect(() => compileFormula("ROUND()", props, "f")).toThrow("ROUND takes between 1 and 2 arguments, but got 0");
    expect(() => compileFormula('prop("Name") + 1', props, "f")).toThrow('The left side of "+" must be a number, not text');
    expect(() => compileFormula('prop("Due") < 3', props, "f")).toThrow("Cannot compare a date with a number");
  });
});

describe("formula evaluation", () => {
  test("reads typed property values", () => {
    expect(run('prop("Amount") * 2', { n: 21 }, props)).toBe(42);
    expect(run('prop("name") & "!"', { t: "hi" }, props)).toBe("hi!");
    expect(run('prop("Done")', {}, props)).toBe(false);
    expect(run('prop("Stage") & ""', { s: "x" }, props)).toBe("");
  });

  test("created time reads from row metadata", () => {
    expect(run('YEAR(prop("Created"))', {}, props)).toBe(2026);
  });

  test("runtime errors become error values", () => {
    expect(run("1 / 0")).toEqual({ error: "DIV_BY_ZERO", message: "Cannot divide by zero" });
    expect(run('TONUMBER("abc")')).toEqual({ error: "VALUE", message: '"abc" is not a number' });
    expect(run('IFERROR(1 / 0, "none")')).toBe("none");
    expect(run("ISERROR(1 / 0)")).toBe(true);
    expect(run("false and (1 / 0) > 0")).toBe(false);
  });

  test("equality coerces like a spreadsheet", () => {
    expect(run('"1" = 1')).toBe(true);
    expect(run('true = "yes"')).toBe(true);
    expect(run('"a" = "A"')).toBe(false);
    expect(run('"10" < "9"')).toBe(true);
  });

  test("math and text functions", () => {
    expect(run("ROUND(-2.5)")).toBe(-3);
    expect(run("ROUND(2.345, 2)")).toBe(2.35);
    expect(run("ROUNDDOWN(2.99, 1)")).toBe(2.9);
    expect(run("MOD(-7, 3)")).toBe(-1);
    expect(run("SUM(1, 2, 3) / AVERAGE(2, 4)")).toBe(2);
    expect(run('MID("abcdef", 2, 3)')).toBe("bcd");
    expect(run('SUBSTITUTE("a-b-c", "-", "+")')).toBe("a+b+c");
    expect(run('REPLACE("abcdef", 2, 0, "X")')).toBe("aXbcdef");
    expect(run('SPLITPART("a,b,c", ",", 2)')).toBe("b");
    expect(run('FIND("hello", "l")')).toBe(3);
    expect(run('JOIN("-", 1, "b", true)')).toBe("1-b-true");
    expect(run('IFS(false, 1, true, 2)')).toBe(2);
    expect(run('SWITCH("b", "a", 1, "b", 2, 0)')).toBe(2);
  });

  test("date functions", () => {
    expect(run('DATEADD("2026-01-31", 1, "month")')).toBe("2026-02-28");
    expect(run('DATEADD("2026-01-31", 1, "day")')).toBe("2026-02-01");
    expect(run('DATEDIFF("2026-01-20", "2026-03-15", "months")')).toBe(1);
    expect(run('DATEDIFF("2026-03-15", "2026-03-10")')).toBe(-5);
    expect(run("TODAY()")).toBe("2026-03-10");
    expect(run('FORMATDATE("2026-07-04", "DD/MM/YYYY")')).toBe("04/07/2026");
    expect(run('WEEKDAY("2026-03-08")')).toBe(1);
    expect(run('DATEADD("2026-01-01", 1, "fortnight")')).toMatchObject({ error: "VALUE" });
    expect(run('YEAR("")')).toMatchObject({ error: "TYPE", message: "YEAR expects a date" });
  });

  test("formulas can use other formulas but not loop", () => {
    const a = prop("a", "A", "formula", { source: 'prop("Amount") + 1', dependencies: ["n"], resultType: "number" });
    expect(run('prop("A") * 10', { n: 1 }, [...props, a])).toBe(20);
    const b = prop("b", "B", "formula", { source: 'prop("F")', dependencies: ["f"], resultType: "null" });
    expect(() => compileFormula('prop("B")', [...props, b], "f")).toThrow("circular reference");
  });

  test("a deleted dependency yields an error value", () => {
    const f = prop("f", "F", "formula", { source: 'prop("Gone") + 1', dependencies: ["g"], resultType: "number" });
    expect(computeFormulas([f], {}, meta).f).toMatchObject({ error: "MISSING_PROP" });
  });
});

describe("renameInSource", () => {
  test("rewrites only matching references", () => {
    expect(renameInSource('prop("Amount") + prop( "amount" ) & "Amount"', "Amount", 'Total "net"')).toBe(
      'prop("Total \\"net\\"") + prop( "Total \\"net\\"" ) & "Amount"',
    );
  });
});
