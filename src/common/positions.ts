/**
 * Fractional ordering keys over the digits `0-9A-Za-z`, compared bytewise
 * (`COLLATE "C"`). Well-formed keys have a variable-length integer part whose
 * head character encodes its length (`a0`, `a1`, `b10`, `Zz`, ...) followed by
 * an optional fraction, so appending and prepending grow keys logarithmically.
 * Keys that do not follow that format are still accepted and ordered by
 * treating them as plain base-62 fractions.
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const SMALLEST_INTEGER = "A" + "0".repeat(26);

const digitValue = (ch: string): number => {
  const value = DIGITS.indexOf(ch);
  if (value < 0) throw new Error(`invalid position character: ${JSON.stringify(ch)}`);
  return value;
};

/**
 * A key strictly between `a` and `b`, treating both as base-62 fractions
 * (`a` may be `""`, `b === null` means no upper bound).
 */
const midpoint = (a: string, b: string | null): string => {
  if (b !== null) {
    let n = 0;
    while (n < b.length && (a[n] ?? "0") === b[n]) n++;
    if (n > 0) {
      if (n === b.length) throw new Error(`no key exists between ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
    }
  }
  const low = a ? digitValue(a[0]!) : 0;
  const high = b !== null ? digitValue(b[0]!) : BASE;
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[low]! + midpoint(a.slice(1), null);
};

const integerLength = (head: string): number | null => {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  return null;
};

const integerPart = (key: string): string => key.slice(0, integerLength(key[0]!)!);

const isWellFormed = (key: string): boolean => {
  if (!key || key === SMALLEST_INTEGER) return false;
  const length = integerLength(key[0]!);
  if (length === null || key.length < length) return false;
  return !key.slice(length).endsWith("0");
};

const incrementInteger = (integer: string): string | null => {
  const head = integer[0]!;
  const digits = integer.slice(1).split("");
  for (let i = digits.length - 1; i >= 0; i--) {
    const next = digitValue(digits[i]!) + 1;
    if (next < BASE) {
      digits[i] = DIGITS[next]!;
      return head + digits.join("");
    }
    digits[i] = "0";
  }
  if (head === "Z") return "a0";
  if (head === "z") return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > "a") digits.push("0");
  else digits.pop();
  return nextHead + digits.join("");
};

const decrementInteger = (integer: string): string | null => {
  const head = integer[0]!;
  const digits = integer.slice(1).split("");
  for (let i = digits.length - 1; i >= 0; i--) {
    const next = digitValue(digits[i]!) - 1;
    if (next >= 0) {
      digits[i] = DIGITS[next]!;
      return head + digits.join("");
    }
    digits[i] = DIGITS[BASE - 1]!;
  }
  if (head === "a") return "Z" + DIGITS[BASE - 1];
  if (head === "A") return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (nextHead < "Z") digits.push(DIGITS[BASE - 1]!);
  else digits.pop();
  return nextHead + digits.join("");
};

const wellFormedBetween = (a: string | null, b: string | null): string => {
  if (a === null) {
    if (b === null) return "a0";
    const ib = integerPart(b);
    if (ib === SMALLEST_INTEGER) return ib + midpoint("", b.slice(ib.length));
    if (ib < b) return ib;
    const decremented = decrementInteger(ib);
    return decremented ?? ib + midpoint("", b.slice(ib.length));
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  if (b === null) return incrementInteger(ia) ?? ia + midpoint(fa, null);
  const ib = integerPart(b);
  if (ia === ib) return ia + midpoint(fa, b.slice(ib.length));
  const incremented = incrementInteger(ia);
  if (incremented !== null && incremented < b) return incremented;
  return ia + midpoint(fa, null);
};

/**
 * Returns a key that sorts strictly after `a` and strictly before `b`
 * (`null` = unbounded on that side).
 */
export const keyBetween = (a: string | null, b: string | null): string => {
  for (const key of [a, b]) {
    if (key !== null) for (const ch of key) digitValue(ch);
  }
  if (a !== null && b !== null && a >= b) {
    throw new Error(`position ${JSON.stringify(a)} is not before ${JSON.stringify(b)}`);
  }
  const wellFormed = (a === null || isWellFormed(a)) && (b === null || isWellFormed(b));
  return wellFormed ? wellFormedBetween(a, b) : midpoint(a ?? "", b);
};
