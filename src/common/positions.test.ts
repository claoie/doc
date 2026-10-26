import { describe, expect, test } from "bun:test";
import { keyBetween } from "./positions";

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const bytewise = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const assertBetween = (a: string | null, b: string | null) => {
  const key = keyBetween(a, b);
  if (a !== null) expect(bytewise(a, key)).toBe(-1);
  if (b !== null) expect(bytewise(key, b)).toBe(-1);
  for (const ch of key) expect(DIGITS.includes(ch)).toBe(true);
  return key;
};

const seeded = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

describe("keyBetween", () => {
  test("first key and simple neighbours", () => {
    expect(keyBetween(null, null)).toBe("a0");
    expect(keyBetween("a0", null)).toBe("a1");
    expect(keyBetween(null, "a0")).toBe("Zz");
    expect(keyBetween("a0", "a1")).toBe("a0V");
    expect(keyBetween("az", null)).toBe("b00");
    expect(keyBetween(null, "b00")).toBe("az");
  });

  test("rejects out-of-order and invalid input", () => {
    expect(() => keyBetween("a1", "a0")).toThrow();
    expect(() => keyBetween("a1", "a1")).toThrow();
    expect(() => keyBetween("a-", null)).toThrow();
    expect(() => keyBetween("a", "a0")).toThrow(/no key exists/);
  });

  test("works between existing keys of the alphabet, including jittered and irregular ones", () => {
    const existing = [
      "0001",
      "A00000000000000000000000001",
      "Zy",
      "Zz",
      "Zz8",
      "a0",
      "a00V",
      "a0V",
      "a0VW3k",
      "a1",
      "a1V",
      "a1Vx3",
      "a2",
      "a21",
      "a3",
      "b0Ab",
      "b10",
      "m",
      "zzzzzzzzzzzzzzzzzzzzzzzzzzz",
      "zzzzzzzzzzzzzzzzzzzzzzzzzzzV",
    ].sort(bytewise);
    assertBetween(null, existing[0]!);
    for (let i = 0; i + 1 < existing.length; i++) assertBetween(existing[i]!, existing[i + 1]!);
    assertBetween(existing[existing.length - 1]!, null);
  });

  test("random adjacent pairs of arbitrary keys", () => {
    const random = seeded(7);
    const keys = new Set<string>();
    while (keys.size < 500) {
      const length = 1 + Math.floor(random() * 6);
      let key = "";
      for (let i = 0; i < length; i++) key += DIGITS[Math.floor(random() * DIGITS.length)];
      if (!key.endsWith("0")) keys.add(key);
    }
    const sorted = [...keys].sort(bytewise);
    for (let i = 0; i + 1 < sorted.length; i++) assertBetween(sorted[i]!, sorted[i + 1]!);
  });

  test("random insert sequences keep order", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const random = seeded(seed);
      const list: string[] = [];
      for (let i = 0; i < 400; i++) {
        const index = Math.floor(random() * (list.length + 1));
        const key = assertBetween(list[index - 1] ?? null, list[index] ?? null);
        list.splice(index, 0, key);
      }
      expect([...list].sort(bytewise)).toEqual(list);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  test("append and prepend forever stay short", () => {
    let last: string | null = null;
    let first: string | null = null;
    for (let i = 0; i < 10_000; i++) {
      last = assertBetween(last, null);
      first = assertBetween(null, first);
    }
    expect(last!.length).toBeLessThan(6);
    expect(first!.length).toBeLessThan(6);
  });

  test("repeatedly inserting at the same spot works", () => {
    let low = "a0";
    let high = "a1";
    for (let i = 0; i < 300; i++) {
      const key = assertBetween(low, high);
      if (i % 2) low = key;
      else high = key;
    }
    let after = "Zz";
    for (let i = 0; i < 300; i++) after = assertBetween("Zz", after === "Zz" ? "a0" : after);
  });
});
