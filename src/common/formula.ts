/**
 * Formula language for base properties.
 *
 * Expressions combine literals, `prop("Name")` references and function calls
 * with `or`, `and`, `not`, comparisons, `&` (join text), `+ - * / %` and `^`.
 * Names are case-insensitive. Compilation resolves property names to ids and
 * infers a result type; evaluation never throws for a formula problem and
 * returns an error value instead.
 */
import type { FormulaResultType, Property, PropertyType } from "./bases";

export const MAX_SOURCE_LENGTH = 10_000;
const MAX_DEPTH = 16;
const MAX_TEXT = 10_000;

export interface Span {
  start: number;
  end: number;
}

export class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    readonly span?: Span,
  ) {
    super(message);
  }
}

export type ErrorCode = "TYPE" | "VALUE" | "DIV_BY_ZERO" | "DEPTH" | "CYCLE" | "MISSING_PROP";

/** A failed evaluation, stored in the cell in place of a value. */
export interface ErrorValue {
  error: ErrorCode;
  message: string;
}

export const isErrorValue = (v: unknown): v is ErrorValue =>
  !!v && typeof v === "object" && typeof (v as ErrorValue).error === "string" && typeof (v as ErrorValue).message === "string";

class EvalError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Tokens

type TokenKind = "number" | "string" | "ident" | "op" | "(" | ")" | "," | "eof";
interface Token {
  kind: TokenKind;
  text: string;
  value?: number | string;
  span: Span;
}

const OPERATORS = ["!=", "<>", "<=", ">=", "==", "+", "-", "*", "/", "%", "^", "&", "=", "<", ">"];

const tokenize = (src: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  const isDigit = (c: string | undefined) => !!c && c >= "0" && c <= "9";
  const isIdentStart = (c: string | undefined) => !!c && /[A-Za-z_]/.test(c);
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    const start = i;
    if (c === "(" || c === ")" || c === ",") {
      tokens.push({ kind: c, text: c, span: { start, end: ++i } });
      continue;
    }
    if (c === '"' || c === "'") {
      let out = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new FormulaSyntaxError("Unterminated text value", { start, end: src.length });
        const ch = src[i]!;
        if (ch === c) {
          i++;
          break;
        }
        if (ch === "\\" && i + 1 < src.length) {
          const next = src[i + 1]!;
          out += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
          continue;
        }
        out += ch;
        i++;
      }
      tokens.push({ kind: "string", text: src.slice(start, i), value: out, span: { start, end: i } });
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      while (isDigit(src[i])) i++;
      if (src[i] === ".") {
        i++;
        while (isDigit(src[i])) i++;
      }
      if (src[i] === "e" || src[i] === "E") {
        let j = i + 1;
        if (src[j] === "+" || src[j] === "-") j++;
        if (isDigit(src[j])) {
          while (isDigit(src[j])) j++;
          i = j;
        }
      }
      const text = src.slice(start, i);
      tokens.push({ kind: "number", text, value: Number(text), span: { start, end: i } });
      continue;
    }
    if (isIdentStart(c)) {
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      tokens.push({ kind: "ident", text: src.slice(start, i), span: { start, end: i } });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      i += op.length;
      tokens.push({ kind: "op", text: op, span: { start, end: i } });
      continue;
    }
    throw new FormulaSyntaxError(`Unexpected character "${c}"`, { start, end: start + 1 });
  }
  tokens.push({ kind: "eof", text: "", span: { start: src.length, end: src.length } });
  return tokens;
};

// ---------------------------------------------------------------------------
// Syntax tree

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "^" | "&" | "=" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";

export type Expr =
  | { k: "lit"; v: number | string | boolean | null }
  | { k: "prop"; name: string; id?: string; span: Span }
  | { k: "call"; fn: string; args: Expr[]; span: Span }
  | { k: "neg" | "not"; arg: Expr }
  | { k: "bin"; op: BinaryOp; l: Expr; r: Expr };

const NULL_WORDS = new Set(["null", "blank", "empty"]);

const parse = (src: string): Expr => {
  if (!src.trim()) throw new FormulaSyntaxError("Formula is empty");
  if (src.length > MAX_SOURCE_LENGTH) throw new FormulaSyntaxError("Formula is too long");
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos]!;
  const next = () => tokens[pos++]!;
  const word = (t: Token) => (t.kind === "ident" ? t.text.toLowerCase() : null);
  const isOp = (...ops: string[]) => peek().kind === "op" && ops.includes(peek().text);
  const unexpected = (t: Token) =>
    t.kind === "eof" ? new FormulaSyntaxError("The formula ended unexpectedly", t.span) : new FormulaSyntaxError(`Unexpected "${t.text}"`, t.span);
  const expect = (kind: TokenKind) => {
    const t = next();
    if (t.kind !== kind) throw unexpected(t);
    return t;
  };

  const orExpr = (): Expr => {
    let l = andExpr();
    while (word(peek()) === "or") {
      next();
      l = { k: "bin", op: "or", l, r: andExpr() };
    }
    return l;
  };
  const andExpr = (): Expr => {
    let l = notExpr();
    while (word(peek()) === "and") {
      next();
      l = { k: "bin", op: "and", l, r: notExpr() };
    }
    return l;
  };
  const notExpr = (): Expr => {
    if (word(peek()) === "not" && tokens[pos + 1]?.kind !== "(") {
      next();
      return { k: "not", arg: notExpr() };
    }
    return comparison();
  };
  const comparison = (): Expr => {
    let l = concat();
    while (isOp("=", "==", "!=", "<>", "<", "<=", ">", ">=")) {
      const t = next().text;
      const op = (t === "==" ? "=" : t === "<>" ? "!=" : t) as BinaryOp;
      l = { k: "bin", op, l, r: concat() };
    }
    return l;
  };
  const concat = (): Expr => {
    let l = additive();
    while (isOp("&")) {
      next();
      l = { k: "bin", op: "&", l, r: additive() };
    }
    return l;
  };
  const additive = (): Expr => {
    let l = multiplicative();
    while (isOp("+", "-")) {
      const op = next().text as BinaryOp;
      l = { k: "bin", op, l, r: multiplicative() };
    }
    return l;
  };
  const multiplicative = (): Expr => {
    let l = unary();
    while (isOp("*", "/", "%")) {
      const op = next().text as BinaryOp;
      l = { k: "bin", op, l, r: unary() };
    }
    return l;
  };
  const unary = (): Expr => {
    if (isOp("-")) {
      next();
      return { k: "neg", arg: unary() };
    }
    if (isOp("+")) {
      next();
      return unary();
    }
    return power();
  };
  const power = (): Expr => {
    const base = primary();
    if (isOp("^")) {
      next();
      return { k: "bin", op: "^", l: base, r: unary() };
    }
    return base;
  };
  const primary = (): Expr => {
    const t = next();
    if (t.kind === "number") return { k: "lit", v: t.value as number };
    if (t.kind === "string") return { k: "lit", v: t.value as string };
    if (t.kind === "(") {
      const e = orExpr();
      expect(")");
      return e;
    }
    if (t.kind === "ident") {
      const lower = t.text.toLowerCase();
      const isCall = peek().kind === "(";
      if (!isCall) {
        if (lower === "true" || lower === "false") return { k: "lit", v: lower === "true" };
        if (NULL_WORDS.has(lower)) return { k: "lit", v: null };
        throw new FormulaSyntaxError(`Unknown name "${t.text}". Reference a property with prop("${t.text}").`, t.span);
      }
      next();
      if (lower === "prop") {
        const arg = next();
        if (arg.kind !== "string") throw new FormulaSyntaxError('prop() takes a property name in quotes, like prop("Status")', arg.span);
        const close = expect(")");
        const name = String(arg.value);
        if (!name.trim()) throw new FormulaSyntaxError("prop() needs a property name", arg.span);
        return { k: "prop", name, span: { start: t.span.start, end: close.span.end } };
      }
      const args: Expr[] = [];
      if (peek().kind !== ")") {
        for (;;) {
          args.push(orExpr());
          if (peek().kind === ",") {
            next();
            continue;
          }
          break;
        }
      }
      const close = expect(")");
      return { k: "call", fn: t.text.toUpperCase(), args, span: { start: t.span.start, end: close.span.end } };
    }
    throw unexpected(t);
  };

  const expr = orExpr();
  if (peek().kind !== "eof") throw unexpected(peek());
  return expr;
};

// ---------------------------------------------------------------------------
// Values

export interface FormulaDate {
  ms: number;
  dateOnly: boolean;
}
type Value = number | string | boolean | null | FormulaDate;

const isDate = (v: Value): v is FormulaDate => !!v && typeof v === "object";
const isBlank = (v: Value | undefined) => v === null || v === undefined || v === "";

const snap = (n: number) => (Number.isFinite(n) && !Number.isInteger(n) ? Number(n.toPrecision(12)) : n);

const formatNumber = (n: number): string => {
  if (Number.isInteger(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1e21 || abs < 1e-7) return String(n);
  return String(Number(n.toPrecision(12)));
};

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const dateText = (d: FormulaDate) => {
  if (!Number.isFinite(d.ms)) return "";
  const x = new Date(d.ms);
  return d.dateOnly ? `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}` : x.toISOString();
};

const toDate = (v: Value): FormulaDate | null => {
  if (isDate(v)) return v;
  if (typeof v === "number") return { ms: v, dateOnly: false };
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(`${s}T00:00:00.000Z`);
    return Number.isNaN(ms) ? null : { ms, dateOnly: true };
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : { ms, dateOnly: false };
};

const toNumber = (v: Value): number => {
  if (typeof v === "number") return v;
  if (isBlank(v)) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isDate(v)) return v.ms;
  const s = (v as string).trim().replace(/,/g, "");
  if (!s) return 0;
  const n = Number(s);
  if (Number.isNaN(n)) throw new EvalError("VALUE", `"${v}" is not a number`);
  return n;
};

const toText = (v: Value): string => {
  if (v === null || v === undefined) return "";
  if (isDate(v)) return dateText(v);
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return v;
};

const toBoolean = (v: Value): boolean => {
  if (typeof v === "boolean") return v;
  if (isBlank(v)) return false;
  if (typeof v === "number") return v !== 0;
  if (isDate(v)) return true;
  const s = (v as string).trim().toLowerCase();
  return !(s === "false" || s === "no" || s === "0" || s === "");
};

const valuesEqual = (a: Value, b: Value): boolean => {
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) || isBlank(b)) return false;
  if (isDate(a) || isDate(b)) {
    const da = toDate(a);
    const db = toDate(b);
    return !!da && !!db && da.ms === db.ms;
  }
  if (typeof a === "boolean" || typeof b === "boolean") return toBoolean(a) === toBoolean(b);
  if (typeof a === "number" || typeof b === "number") return toNumber(a) === toNumber(b);
  return a === b;
};

const compare = (a: Value, b: Value): number => {
  if (isDate(a) || isDate(b)) {
    const da = toDate(a);
    const db = toDate(b);
    if (!da || !db) throw new EvalError("TYPE", "These values cannot be compared");
    return da.ms - db.ms;
  }
  if (typeof a === "string" && typeof b === "string" && a !== "" && b !== "") return a < b ? -1 : a > b ? 1 : 0;
  if (isBlank(a) && isBlank(b)) return 0;
  return toNumber(a) - toNumber(b);
};

/** Final value stored in a cell. */
const toStored = (v: Value): number | string | boolean | null => {
  if (isDate(v)) return dateText(v) || null;
  if (typeof v === "number") return Number.isFinite(v) ? snap(v) : null;
  return v;
};

// ---------------------------------------------------------------------------
// Functions

type ParamType = "any" | "number" | "string" | "boolean" | "date";
type StaticType = FormulaResultType;
type Category = "logic" | "math" | "text" | "date" | "conversion";

interface Ctx {
  now: number;
  depth: number;
  eval: (e: Expr) => Value;
}

interface FunctionDef {
  category: Category;
  doc: string;
  min: number;
  max: number | null;
  params: ParamType[];
  result: StaticType | ((args: StaticType[]) => StaticType);
  call?: (args: Value[], ctx: Ctx) => Value;
  lazy?: (args: Expr[], ctx: Ctx) => Value;
}

const unify = (types: StaticType[]): StaticType => {
  const known = types.filter((t) => t !== "null");
  if (known.length === 0) return "null";
  return known.every((t) => t === known[0]) ? known[0]! : "string";
};

const digitsArg = (v: Value | undefined) => {
  if (v === undefined || isBlank(v)) return 0;
  const d = toNumber(v);
  if (!Number.isInteger(d)) throw new EvalError("VALUE", "Digits must be a whole number");
  return d;
};
const roundWith = (mode: "half" | "up" | "down"): FunctionDef["call"] => (args) => {
  const n = toNumber(args[0]!);
  const factor = 10 ** digitsArg(args[1]);
  const scaled = snap(Math.abs(n) * factor);
  const r = mode === "half" ? Math.round(scaled) : mode === "up" ? Math.ceil(scaled) : Math.floor(scaled);
  return snap((Math.sign(n) * r) / factor);
};
const count = (v: Value | undefined, fallback: number) => {
  if (v === undefined || isBlank(v)) return fallback;
  const n = Math.trunc(toNumber(v));
  if (n < 0) throw new EvalError("VALUE", "Length cannot be negative");
  return n;
};
const dateArg = (fn: string, v: Value) => {
  const d = isBlank(v) ? null : toDate(v);
  if (!d) throw new EvalError("TYPE", `${fn} expects a date`);
  return d;
};

const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
const unitName = (fn: string, v: Value | undefined): string => {
  const s = toText(v ?? "day").trim().toLowerCase();
  const map: Record<string, string> = {
    s: "second", sec: "second", second: "second", seconds: "second",
    m: "minute", min: "minute", minute: "minute", minutes: "minute",
    h: "hour", hour: "hour", hours: "hour",
    d: "day", day: "day", days: "day",
    w: "week", week: "week", weeks: "week",
    mo: "month", month: "month", months: "month",
    y: "year", year: "year", years: "year",
  };
  const unit = map[s];
  if (!unit) throw new EvalError("VALUE", `${fn} does not know the unit "${s}". Use days, weeks, months, years, hours, minutes or seconds.`);
  return unit;
};

const addMonths = (ms: number, months: number) => {
  const d = new Date(ms);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return target.getTime();
};

const dateAdd = (fn: string, args: Value[], sign: 1 | -1): Value => {
  const d = dateArg(fn, args[0]!);
  const amount = toNumber(args[1]!) * sign;
  const unit = unitName(fn, args[2]);
  if (unit === "month" || unit === "year") return { ms: addMonths(d.ms, Math.trunc(amount) * (unit === "year" ? 12 : 1)), dateOnly: d.dateOnly };
  return { ms: d.ms + amount * UNIT_MS[unit]!, dateOnly: d.dateOnly };
};

const monthsBetween = (from: number, to: number) => {
  const a = new Date(from);
  const b = new Date(to);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (months > 0 && addMonths(from, months) > to) months--;
  if (months < 0 && addMonths(from, months) < to) months++;
  return months;
};

const field = (fn: string, get: (d: Date) => number): FunctionDef => ({
  category: "date",
  doc: `${fn.charAt(0)}${fn.slice(1).toLowerCase()} of a date (UTC).`,
  min: 1,
  max: 1,
  params: ["date"],
  result: "number",
  call: (args) => get(new Date(dateArg(fn, args[0]!).ms)),
});

const mathFn = (doc: string, fn: (n: number) => number, check?: (n: number) => void): FunctionDef => ({
  category: "math",
  doc,
  min: 1,
  max: 1,
  params: ["number"],
  result: "number",
  call: (args) => {
    const n = toNumber(args[0]!);
    check?.(n);
    return snap(fn(n));
  },
});

const textFn = (doc: string, fn: (s: string) => string): FunctionDef => ({
  category: "text",
  doc,
  min: 1,
  max: 1,
  params: ["string"],
  result: "string",
  call: (args) => fn(toText(args[0]!)),
});

const textTest = (doc: string, fn: (s: string, t: string) => boolean): FunctionDef => ({
  category: "text",
  doc,
  min: 2,
  max: 2,
  params: ["string", "string"],
  result: "boolean",
  call: (args) => fn(toText(args[0]!), toText(args[1]!)),
});

const numbers = (args: Value[]) => args.map(toNumber);

export const FUNCTIONS: Record<string, FunctionDef> = {
  IF: {
    category: "logic",
    doc: "Returns the second argument when the condition is true, otherwise the third.",
    min: 2,
    max: 3,
    params: ["boolean", "any", "any"],
    result: (t) => unify([t[1]!, t[2] ?? "null"]),
    lazy: (args, ctx) => (toBoolean(ctx.eval(args[0]!)) ? ctx.eval(args[1]!) : args[2] ? ctx.eval(args[2]) : null),
  },
  IFS: {
    category: "logic",
    doc: "Checks condition/value pairs in order and returns the value of the first true condition; an extra last argument is the default.",
    min: 2,
    max: null,
    params: ["any"],
    result: (t) => unify(t.filter((_, i) => i % 2 === 1 || (t.length % 2 === 1 && i === t.length - 1))),
    lazy: (args, ctx) => {
      for (let i = 0; i + 1 < args.length; i += 2) if (toBoolean(ctx.eval(args[i]!))) return ctx.eval(args[i + 1]!);
      return args.length % 2 === 1 ? ctx.eval(args[args.length - 1]!) : null;
    },
  },
  SWITCH: {
    category: "logic",
    doc: "Compares a value with each case and returns the matching result; an extra last argument is the default.",
    min: 3,
    max: null,
    params: ["any"],
    result: (t) => unify(t.filter((_, i) => (i > 0 && i % 2 === 0) || (t.length % 2 === 0 && i === t.length - 1))),
    lazy: (args, ctx) => {
      const subject = ctx.eval(args[0]!);
      for (let i = 1; i + 1 < args.length; i += 2) if (valuesEqual(subject, ctx.eval(args[i]!))) return ctx.eval(args[i + 1]!);
      return args.length % 2 === 0 ? ctx.eval(args[args.length - 1]!) : null;
    },
  },
  AND: {
    category: "logic",
    doc: "True when every argument is true.",
    min: 1,
    max: null,
    params: ["boolean"],
    result: "boolean",
    lazy: (args, ctx) => args.every((a) => toBoolean(ctx.eval(a))),
  },
  OR: {
    category: "logic",
    doc: "True when any argument is true.",
    min: 1,
    max: null,
    params: ["boolean"],
    result: "boolean",
    lazy: (args, ctx) => args.some((a) => toBoolean(ctx.eval(a))),
  },
  NOT: { category: "logic", doc: "Flips true and false.", min: 1, max: 1, params: ["boolean"], result: "boolean", call: (a) => !toBoolean(a[0]!) },
  ISBLANK: { category: "logic", doc: "True when the value is empty.", min: 1, max: 1, params: ["any"], result: "boolean", call: (a) => isBlank(a[0]) },
  ISERROR: {
    category: "logic",
    doc: "True when evaluating the value fails.",
    min: 1,
    max: 1,
    params: ["any"],
    result: "boolean",
    lazy: (args, ctx) => {
      try {
        ctx.eval(args[0]!);
        return false;
      } catch (e) {
        if (e instanceof EvalError) return true;
        throw e;
      }
    },
  },
  IFERROR: {
    category: "logic",
    doc: "Returns the value, or the fallback when evaluating the value fails.",
    min: 2,
    max: 2,
    params: ["any", "any"],
    result: (t) => unify(t),
    lazy: (args, ctx) => {
      try {
        return ctx.eval(args[0]!);
      } catch (e) {
        if (e instanceof EvalError) return ctx.eval(args[1]!);
        throw e;
      }
    },
  },
  COALESCE: {
    category: "logic",
    doc: "The first argument that is not empty.",
    min: 1,
    max: null,
    params: ["any"],
    result: (t) => unify(t),
    lazy: (args, ctx) => {
      for (const a of args) {
        const v = ctx.eval(a);
        if (!isBlank(v)) return v;
      }
      return null;
    },
  },
  ERROR: {
    category: "logic",
    doc: "Fails with the given message.",
    min: 0,
    max: 1,
    params: ["string"],
    result: "null",
    call: (a) => {
      throw new EvalError("VALUE", a[0] !== undefined && !isBlank(a[0]) ? toText(a[0]) : "Formula raised an error");
    },
  },

  SUM: { category: "math", doc: "Adds numbers.", min: 1, max: null, params: ["number"], result: "number", call: (a) => snap(numbers(a).reduce((x, y) => x + y, 0)) },
  AVERAGE: {
    category: "math",
    doc: "The mean of the numbers.",
    min: 1,
    max: null,
    params: ["number"],
    result: "number",
    call: (a) => snap(numbers(a).reduce((x, y) => x + y, 0) / a.length),
  },
  MIN: { category: "math", doc: "The smallest number.", min: 1, max: null, params: ["number"], result: "number", call: (a) => Math.min(...numbers(a)) },
  MAX: { category: "math", doc: "The largest number.", min: 1, max: null, params: ["number"], result: "number", call: (a) => Math.max(...numbers(a)) },
  ABS: mathFn("The number without its sign.", Math.abs),
  ROUND: { category: "math", doc: "Rounds to the given digits, halves away from zero.", min: 1, max: 2, params: ["number", "number"], result: "number", call: roundWith("half") },
  ROUNDUP: { category: "math", doc: "Rounds away from zero.", min: 1, max: 2, params: ["number", "number"], result: "number", call: roundWith("up") },
  ROUNDDOWN: { category: "math", doc: "Rounds toward zero.", min: 1, max: 2, params: ["number", "number"], result: "number", call: roundWith("down") },
  FLOOR: mathFn("Rounds down to a whole number.", Math.floor),
  CEILING: mathFn("Rounds up to a whole number.", Math.ceil),
  TRUNC: mathFn("Drops the fractional part.", Math.trunc),
  MOD: {
    category: "math",
    doc: "The remainder of a division.",
    min: 2,
    max: 2,
    params: ["number", "number"],
    result: "number",
    call: (a) => {
      const d = toNumber(a[1]!);
      if (d === 0) throw new EvalError("DIV_BY_ZERO", "Cannot take a remainder by zero");
      return snap(toNumber(a[0]!) % d);
    },
  },
  POWER: { category: "math", doc: "A number raised to a power.", min: 2, max: 2, params: ["number", "number"], result: "number", call: (a) => snap(toNumber(a[0]!) ** toNumber(a[1]!)) },
  SQRT: mathFn("The square root.", Math.sqrt, (n) => {
    if (n < 0) throw new EvalError("VALUE", "SQRT needs a number that is not negative");
  }),
  SIGN: mathFn("-1, 0 or 1 by the sign of the number.", Math.sign),
  EXP: mathFn("e raised to the number.", Math.exp),
  LN: mathFn("The natural logarithm.", Math.log, (n) => {
    if (n <= 0) throw new EvalError("VALUE", "LN needs a positive number");
  }),
  LOG10: mathFn("The base-10 logarithm.", Math.log10, (n) => {
    if (n <= 0) throw new EvalError("VALUE", "LOG10 needs a positive number");
  }),

  CONCAT: { category: "text", doc: "Joins values into one text.", min: 1, max: null, params: ["any"], result: "string", call: (a) => a.map(toText).join("") },
  JOIN: {
    category: "text",
    doc: "Joins values with a separator.",
    min: 2,
    max: null,
    params: ["string", "any"],
    result: "string",
    call: (a) => a.slice(1).map(toText).join(toText(a[0]!)),
  },
  LEN: { category: "text", doc: "The number of characters.", min: 1, max: 1, params: ["string"], result: "number", call: (a) => toText(a[0]!).length },
  LOWER: textFn("Lower-cases text.", (s) => s.toLowerCase()),
  UPPER: textFn("Upper-cases text.", (s) => s.toUpperCase()),
  TRIM: textFn("Removes surrounding spaces.", (s) => s.trim()),
  LEFT: {
    category: "text",
    doc: "The first characters of a text.",
    min: 1,
    max: 2,
    params: ["string", "number"],
    result: "string",
    call: (a) => toText(a[0]!).slice(0, count(a[1], 1)),
  },
  RIGHT: {
    category: "text",
    doc: "The last characters of a text.",
    min: 1,
    max: 2,
    params: ["string", "number"],
    result: "string",
    call: (a) => {
      const s = toText(a[0]!);
      const n = count(a[1], 1);
      return n === 0 ? "" : s.slice(-n);
    },
  },
  MID: {
    category: "text",
    doc: "Characters from a 1-based position.",
    min: 2,
    max: 3,
    params: ["string", "number", "number"],
    result: "string",
    call: (a) => {
      const s = toText(a[0]!);
      const start = Math.trunc(toNumber(a[1]!));
      if (start < 1) throw new EvalError("VALUE", "MID starts counting at 1");
      return s.substr(start - 1, count(a[2], s.length));
    },
  },
  FIND: {
    category: "text",
    doc: "1-based position of the search text, or 0.",
    min: 2,
    max: 2,
    params: ["string", "string"],
    result: "number",
    call: (a) => toText(a[0]!).indexOf(toText(a[1]!)) + 1,
  },
  CONTAINS: textTest("True when the text contains the search text.", (s, t) => s.includes(t)),
  STARTSWITH: textTest("True when the text starts with the prefix.", (s, t) => s.startsWith(t)),
  ENDSWITH: textTest("True when the text ends with the suffix.", (s, t) => s.endsWith(t)),
  SUBSTITUTE: {
    category: "text",
    doc: "Replaces every occurrence of a text.",
    min: 3,
    max: 3,
    params: ["string", "string", "string"],
    result: "string",
    call: (a) => {
      const from = toText(a[1]!);
      return from ? toText(a[0]!).split(from).join(toText(a[2]!)) : toText(a[0]!);
    },
  },
  REPLACE: {
    category: "text",
    doc: "Replaces characters at a 1-based position.",
    min: 4,
    max: 4,
    params: ["string", "number", "number", "string"],
    result: "string",
    call: (a) => {
      const s = toText(a[0]!);
      const start = Math.max(1, Math.trunc(toNumber(a[1]!)));
      const len = count(a[2], 0);
      return s.slice(0, start - 1) + toText(a[3]!) + s.slice(start - 1 + len);
    },
  },
  REPEAT: {
    category: "text",
    doc: "Repeats a text.",
    min: 2,
    max: 2,
    params: ["string", "number"],
    result: "string",
    call: (a) => {
      const s = toText(a[0]!);
      const n = count(a[1], 0);
      if (s.length * n > MAX_TEXT) throw new EvalError("VALUE", "REPEAT would produce too much text");
      return s.repeat(n);
    },
  },
  SPLITPART: {
    category: "text",
    doc: "The 1-based part of a text split by a separator.",
    min: 3,
    max: 3,
    params: ["string", "string", "number"],
    result: "string",
    call: (a) => {
      const parts = toText(a[0]!).split(toText(a[1]!));
      const i = Math.trunc(toNumber(a[2]!));
      return parts[i - 1] ?? "";
    },
  },

  NOW: { category: "date", doc: "The current date and time.", min: 0, max: 0, params: [], result: "date", call: (_a, ctx) => ({ ms: ctx.now, dateOnly: false }) },
  TODAY: {
    category: "date",
    doc: "Today's date (UTC).",
    min: 0,
    max: 0,
    params: [],
    result: "date",
    call: (_a, ctx) => {
      const d = new Date(ctx.now);
      return { ms: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), dateOnly: true };
    },
  },
  DATE: {
    category: "date",
    doc: "A date from year, month and day.",
    min: 3,
    max: 3,
    params: ["number", "number", "number"],
    result: "date",
    call: (a) => ({ ms: Date.UTC(toNumber(a[0]!), toNumber(a[1]!) - 1, toNumber(a[2]!)), dateOnly: true }),
  },
  YEAR: field("YEAR", (d) => d.getUTCFullYear()),
  MONTH: field("MONTH", (d) => d.getUTCMonth() + 1),
  DAY: field("DAY", (d) => d.getUTCDate()),
  HOUR: field("HOUR", (d) => d.getUTCHours()),
  MINUTE: field("MINUTE", (d) => d.getUTCMinutes()),
  WEEKDAY: field("WEEKDAY", (d) => d.getUTCDay() + 1),
  DATEADD: {
    category: "date",
    doc: "Adds an amount of a unit (days, weeks, months, years, hours, minutes, seconds).",
    min: 3,
    max: 3,
    params: ["date", "number", "string"],
    result: "date",
    call: (a) => dateAdd("DATEADD", a, 1),
  },
  DATESUBTRACT: {
    category: "date",
    doc: "Subtracts an amount of a unit.",
    min: 3,
    max: 3,
    params: ["date", "number", "string"],
    result: "date",
    call: (a) => dateAdd("DATESUBTRACT", a, -1),
  },
  DATEDIFF: {
    category: "date",
    doc: "Whole units from the first date to the second.",
    min: 2,
    max: 3,
    params: ["date", "date", "string"],
    result: "number",
    call: (a) => {
      const from = dateArg("DATEDIFF", a[0]!).ms;
      const to = dateArg("DATEDIFF", a[1]!).ms;
      const unit = unitName("DATEDIFF", a[2]);
      if (unit === "month") return monthsBetween(from, to);
      if (unit === "year") return Math.trunc(monthsBetween(from, to) / 12);
      return Math.trunc((to - from) / UNIT_MS[unit]!);
    },
  },
  FORMATDATE: {
    category: "date",
    doc: "Formats a date with YYYY, YY, MM, DD, HH, mm and ss (UTC).",
    min: 2,
    max: 2,
    params: ["date", "string"],
    result: "string",
    call: (a) => {
      const d = new Date(dateArg("FORMATDATE", a[0]!).ms);
      const parts: Record<string, string> = {
        YYYY: String(d.getUTCFullYear()),
        YY: pad(d.getUTCFullYear() % 100),
        MM: pad(d.getUTCMonth() + 1),
        DD: pad(d.getUTCDate()),
        HH: pad(d.getUTCHours()),
        mm: pad(d.getUTCMinutes()),
        ss: pad(d.getUTCSeconds()),
      };
      return toText(a[1]!).replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (m) => parts[m]!);
    },
  },

  TONUMBER: { category: "conversion", doc: "Reads a value as a number.", min: 1, max: 1, params: ["any"], result: "number", call: (a) => toNumber(a[0]!) },
  TOTEXT: { category: "conversion", doc: "Reads a value as text.", min: 1, max: 1, params: ["any"], result: "string", call: (a) => toText(a[0]!) },
  TOBOOLEAN: { category: "conversion", doc: "Reads a value as true or false.", min: 1, max: 1, params: ["any"], result: "boolean", call: (a) => toBoolean(a[0]!) },
  TODATE: {
    category: "conversion",
    doc: "Reads a value as a date.",
    min: 1,
    max: 1,
    params: ["any"],
    result: "date",
    call: (a) => {
      if (isBlank(a[0])) return null;
      const d = toDate(a[0]!);
      if (!d) throw new EvalError("VALUE", `Cannot read "${toText(a[0]!)}" as a date`);
      return d;
    },
  },
};

export const functionSignature = (name: string): string => {
  const def = FUNCTIONS[name];
  if (!def) return name;
  const params: string[] = [];
  const shown = def.max ?? def.min + 1;
  for (let i = 0; i < Math.max(shown, def.min); i++) {
    const type = def.params[Math.min(i, def.params.length - 1)] ?? "any";
    const label = `${type}${i + 1}`;
    params.push(i < def.min ? label : `[${label}]`);
  }
  return `${name}(${params.join(", ")}${def.max === null ? ", …" : ""})`;
};

// ---------------------------------------------------------------------------
// Compilation: resolve names, infer types, detect cycles.

/** Static type a property contributes to a formula; choice, people, file and page values read as empty. */
export const propertyValueType = (prop: Pick<Property, "type" | "options">): StaticType => {
  const map: Partial<Record<PropertyType, StaticType>> = {
    number: "number",
    text: "string",
    longText: "string",
    url: "string",
    email: "string",
    checkbox: "boolean",
    date: "date",
    createdAt: "date",
    lastEditedAt: "date",
  };
  if (prop.type === "formula") return prop.options.resultType ?? "null";
  return map[prop.type] ?? "null";
};

export interface Compiled {
  expr: Expr;
  resultType: StaticType;
  dependencies: string[];
}

const accepts = (param: ParamType, type: StaticType): boolean => {
  if (type === "null" || param === "any" || param === "string") return true;
  if (param === "number") return type === "number" || type === "boolean";
  if (param === "boolean") return type !== "date";
  return type === "date" || type === "string";
};

const TYPE_NAMES: Record<StaticType, string> = { number: "a number", string: "text", boolean: "a true/false value", date: "a date", null: "empty" };

/**
 * Parses and checks a formula for the property `selfId` against the other
 * properties of the base. Throws `FormulaSyntaxError` with a readable message.
 */
export const compileFormula = (source: string, props: Property[], selfId: string | null): Compiled => {
  const expr = parse(source);
  const others = props.filter((p) => p.id !== selfId);
  const deps: string[] = [];
  const byId = new Map(props.map((p) => [p.id, p]));
  const missing: FormulaSyntaxError[] = [];

  const resolve = (name: string): Property | undefined =>
    others.find((p) => p.name === name) ?? others.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());

  const check = (e: Expr): StaticType => {
    switch (e.k) {
      case "lit":
        return e.v === null ? "null" : typeof e.v === "number" ? "number" : typeof e.v === "boolean" ? "boolean" : "string";
      case "prop": {
        const prop = resolve(e.name);
        if (!prop) {
          missing.push(new FormulaSyntaxError(`No property named "${e.name}"`, e.span));
          return "null";
        }
        e.id = prop.id;
        if (!deps.includes(prop.id)) deps.push(prop.id);
        return propertyValueType(prop);
      }
      case "neg":
        check(e.arg);
        return "number";
      case "not":
        check(e.arg);
        return "boolean";
      case "bin": {
        const l = check(e.l);
        const r = check(e.r);
        switch (e.op) {
          case "+":
          case "-":
          case "*":
          case "/":
          case "%":
          case "^":
            if (!accepts("number", l)) throw new FormulaSyntaxError(`The left side of "${e.op}" must be a number, not ${TYPE_NAMES[l]}`);
            if (!accepts("number", r)) throw new FormulaSyntaxError(`The right side of "${e.op}" must be a number, not ${TYPE_NAMES[r]}`);
            return "number";
          case "&":
            return "string";
          case "<":
          case "<=":
          case ">":
          case ">=": {
            const loose = (t: StaticType) => t === "null" || t === "string";
            if ((l === "date") !== (r === "date") && !loose(l) && !loose(r)) {
              throw new FormulaSyntaxError(`Cannot compare ${TYPE_NAMES[l]} with ${TYPE_NAMES[r]}`);
            }
            return "boolean";
          }
          default:
            return "boolean";
        }
      }
      case "call": {
        const def = FUNCTIONS[e.fn];
        if (!def) throw new FormulaSyntaxError(`Unknown function "${e.fn}"`, e.span);
        const n = e.args.length;
        if (n < def.min || (def.max !== null && n > def.max)) {
          const plural = (k: number) => `${k} argument${k === 1 ? "" : "s"}`;
          const expected =
            def.max === def.min ? `exactly ${plural(def.min)}` : def.max === null ? `at least ${plural(def.min)}` : `between ${def.min} and ${plural(def.max)}`;
          throw new FormulaSyntaxError(`${e.fn} takes ${expected}, but got ${n}`, e.span);
        }
        const types = e.args.map(check);
        types.forEach((t, i) => {
          const param = def.params[Math.min(i, def.params.length - 1)] ?? "any";
          if (!accepts(param, t)) throw new FormulaSyntaxError(`${e.fn} argument ${i + 1} must be ${TYPE_NAMES[param === "any" ? "null" : param === "string" ? "string" : param]}, not ${TYPE_NAMES[t]}`);
        });
        return typeof def.result === "function" ? def.result(types) : def.result;
      }
    }
  };

  const resultType = check(expr);
  if (missing.length) throw missing[0]!;

  // A formula may not reach itself through other formulas.
  if (selfId) {
    const seen = new Set<string>();
    const stack = [...deps];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === selfId) throw new FormulaSyntaxError("Formula would create a circular reference");
      if (seen.has(id)) continue;
      seen.add(id);
      const p = byId.get(id);
      if (p?.type === "formula") stack.push(...(p.options.dependencies ?? []));
    }
  }
  return { expr, resultType, dependencies: deps };
};

/** Rewrites `prop("old")` references after a property rename so sources stay readable. */
export const renameInSource = (source: string, oldName: string, newName: string): string => {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch {
    return source;
  }
  const quoted = JSON.stringify(newName);
  let out = "";
  let last = 0;
  for (let i = 0; i + 2 < tokens.length; i++) {
    const t = tokens[i]!;
    const arg = tokens[i + 2]!;
    if (t.kind === "ident" && t.text.toLowerCase() === "prop" && tokens[i + 1]!.kind === "(" && arg.kind === "string") {
      if (String(arg.value).trim().toLowerCase() !== oldName.trim().toLowerCase()) continue;
      out += source.slice(last, arg.span.start) + quoted;
      last = arg.span.end;
    }
  }
  return out + source.slice(last);
};

// ---------------------------------------------------------------------------
// Evaluation

export interface RowMeta {
  createdAt: string;
  updatedAt: string;
}

/** Ids of formulas that depend, directly or through other formulas, on any of `changed`. */
export const affectedFormulas = (props: Property[], changed: Iterable<string>): string[] => {
  const formulas = props.filter((p) => p.type === "formula");
  const result = new Set<string>();
  const queue = [...changed];
  while (queue.length) {
    const id = queue.shift()!;
    for (const f of formulas) {
      if (!result.has(f.id) && (f.options.dependencies ?? []).includes(id)) {
        result.add(f.id);
        queue.push(f.id);
      }
    }
  }
  return [...result];
};

const compileCache = new Map<string, Expr | null>();

const cachedExpr = (prop: Property, props: Property[]): Expr | null => {
  const key = `${prop.id}\u0000${prop.options.source ?? ""}\u0000${props.map((p) => `${p.id}:${p.name}:${p.type}`).join("|")}`;
  if (compileCache.has(key)) return compileCache.get(key)!;
  let expr: Expr | null = null;
  try {
    expr = compileFormula(prop.options.source ?? "", props, prop.id).expr;
  } catch {
    expr = null;
  }
  if (compileCache.size > 500) compileCache.clear();
  compileCache.set(key, expr);
  return expr;
};

/**
 * Computes formula values for one row. Returns the stored value per formula
 * id in `only` (all formulas when omitted): a number, text, boolean, date
 * string, `null`, or an `ErrorValue`.
 */
export const computeFormulas = (
  props: Property[],
  cells: Record<string, unknown>,
  meta: RowMeta,
  only?: readonly string[],
  now = Date.now(),
): Record<string, unknown> => {
  const byId = new Map(props.map((p) => [p.id, p]));
  const memo = new Map<string, Value>();
  const inFlight = new Set<string>();

  const readProperty = (id: string, depth: number): Value => {
    const prop = byId.get(id);
    if (!prop) throw new EvalError("MISSING_PROP", "A property this formula uses was deleted");
    if (prop.type === "formula") return evaluateFormula(prop, depth + 1);
    const raw = prop.type === "createdAt" ? meta.createdAt : prop.type === "lastEditedAt" ? meta.updatedAt : cells[id];
    switch (prop.type) {
      case "number":
        return typeof raw === "number" ? raw : null;
      case "text":
      case "longText":
      case "url":
      case "email":
        return typeof raw === "string" ? raw : null;
      case "checkbox":
        return raw === true;
      case "date":
      case "createdAt":
      case "lastEditedAt":
        return typeof raw === "string" ? toDate(raw) : null;
    }
    return null;
  };

  const evaluateFormula = (prop: Property, depth: number): Value => {
    if (memo.has(prop.id)) return memo.get(prop.id)!;
    if (inFlight.has(prop.id)) throw new EvalError("CYCLE", "Formulas reference each other in a loop");
    if (depth >= MAX_DEPTH) throw new EvalError("DEPTH", "Formulas are nested too deeply");
    const expr = cachedExpr(prop, props);
    if (!expr) throw new EvalError("MISSING_PROP", "A property this formula uses was deleted");
    inFlight.add(prop.id);
    try {
      const value = run(expr, depth);
      memo.set(prop.id, value);
      return value;
    } finally {
      inFlight.delete(prop.id);
    }
  };

  const run = (root: Expr, depth: number): Value => {
    const ctx: Ctx = { now, depth, eval: (e) => go(e) };
    const go = (e: Expr): Value => {
      switch (e.k) {
        case "lit":
          return e.v;
        case "prop":
          if (!e.id) throw new EvalError("MISSING_PROP", "A property this formula uses was deleted");
          return readProperty(e.id, depth);
        case "neg":
          return snap(-toNumber(go(e.arg)));
        case "not":
          return !toBoolean(go(e.arg));
        case "call": {
          const def = FUNCTIONS[e.fn]!;
          if (def.lazy) return def.lazy(e.args, ctx);
          return def.call!(e.args.map(go), ctx);
        }
        case "bin": {
          if (e.op === "and") return toBoolean(go(e.l)) ? toBoolean(go(e.r)) : false;
          if (e.op === "or") return toBoolean(go(e.l)) ? true : toBoolean(go(e.r));
          const l = go(e.l);
          const r = go(e.r);
          switch (e.op) {
            case "+":
              return snap(toNumber(l) + toNumber(r));
            case "-":
              return snap(toNumber(l) - toNumber(r));
            case "*":
              return snap(toNumber(l) * toNumber(r));
            case "/": {
              const d = toNumber(r);
              if (d === 0) throw new EvalError("DIV_BY_ZERO", "Cannot divide by zero");
              return snap(toNumber(l) / d);
            }
            case "%": {
              const d = toNumber(r);
              if (d === 0) throw new EvalError("DIV_BY_ZERO", "Cannot take a remainder by zero");
              return snap(toNumber(l) % d);
            }
            case "^":
              return snap(toNumber(l) ** toNumber(r));
            case "&":
              return toText(l) + toText(r);
            case "=":
              return valuesEqual(l, r);
            case "!=":
              return !valuesEqual(l, r);
            case "<":
              return compare(l, r) < 0;
            case "<=":
              return compare(l, r) <= 0;
            case ">":
              return compare(l, r) > 0;
            case ">=":
              return compare(l, r) >= 0;
          }
        }
      }
      return null;
    };
    return go(root);
  };

  const out: Record<string, unknown> = {};
  for (const prop of props) {
    if (prop.type !== "formula" || (only && !only.includes(prop.id))) continue;
    try {
      out[prop.id] = toStored(evaluateFormula(prop, 0));
    } catch (e) {
      if (e instanceof EvalError) out[prop.id] = { error: e.code, message: e.message } satisfies ErrorValue;
      else if (e instanceof RangeError) out[prop.id] = { error: "DEPTH", message: "Formula is too deeply nested" } satisfies ErrorValue;
      else out[prop.id] = { error: "VALUE", message: e instanceof Error ? e.message : String(e) } satisfies ErrorValue;
    }
  }
  return out;
};
