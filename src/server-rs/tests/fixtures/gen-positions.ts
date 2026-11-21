// Writes positions.json: what `keyBetween` of common/positions.ts answers,
// for tests/positions.rs to hold common/positions.rs to.
//
//   bun src/server-rs/tests/fixtures/gen-positions.ts
//
// Each case is `[a, b, key]`, or `[a, b, null, message]` where the
// TypeScript throws. The most common message, that `a` is not before `b`,
// repeats both keys, so it is written as `0` (after checking that it reads
// `position "<a>" is not before "<b>"`).
import path from "node:path";
import { keyBetween } from "common/positions";
import { int, pick, seeded } from "./rng";

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
type Case = [string | null, string | null, string | null] | [string | null, string | null, null, string | 0];

const cases: Case[] = [];
const record = (a: string | null, b: string | null): string | null => {
  try {
    const key = keyBetween(a, b);
    cases.push([a, b, key]);
    return key;
  } catch (e) {
    const message = (e as Error).message;
    cases.push([a, b, null, message === `position ${JSON.stringify(a)} is not before ${JSON.stringify(b)}` ? 0 : message]);
    return null;
  }
};
const bytewise = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Every branch: well-formed and plain keys, open bounds, the head character
// rolling over in both directions, the smallest and largest integers, errors.
const SMALLEST = "A" + "0".repeat(26);
const LARGEST = "z".repeat(27);
const singles: (string | null)[] = [
  null, "", "0", "1", "V", "z", "a", "A", "Z", "a0", "a1", "a0V", "az", "b00", "b0z", "bzz", "c000", "Zz", "Zy", "Z0", "Yzz", "Yz0", "Y00", "X000", "Xzzz", "a00", "a0V0", "a10", "a1V", "a0VW3k",
  "Zz8", "ZzV", "m", "0001", "001", "zz", "zzz", "z0", "z1", "y" + "z".repeat(25), "y" + "z".repeat(24) + "y", "B" + "0".repeat(25), "B" + "0".repeat(24) + "1", SMALLEST, SMALLEST + "1", SMALLEST + "V",
  SMALLEST + "0V", SMALLEST + "0", LARGEST, LARGEST + "V", LARGEST + "z", LARGEST + "zz", LARGEST.slice(0, 26), LARGEST.slice(0, 26) + "y", "a", "b", "b0", "b0Ab", "b10", "A0", "a-", "a ", "aé", "😀",
  "a\n", "A00000000000000000000000001", "a0000", "aV", "aVV", "Zzz", "Zzzz", "a1Vx3", "a2", "a21", "a3",
];
for (const a of singles) for (const b of singles) record(a, b);

// Neighbours in a sorted list of existing keys, as the TypeScript tests do.
const existing = ["0001", "A00000000000000000000000001", "Zy", "Zz", "Zz8", "a0", "a00V", "a0V", "a0VW3k", "a1", "a1V", "a1Vx3", "a2", "a21", "a3", "b0Ab", "b10", "m", LARGEST, LARGEST + "V"].sort(bytewise);
record(null, existing[0]!);
for (let i = 0; i + 1 < existing.length; i++) record(existing[i]!, existing[i + 1]!);
record(existing[existing.length - 1]!, null);

// Random adjacent pairs of arbitrary keys.
{
  const random = seeded(7);
  const keys = new Set<string>();
  while (keys.size < 400) {
    const length = int(random, 1, 6);
    let key = "";
    for (let i = 0; i < length; i++) key += pick(random, [...DIGITS]);
    keys.add(key);
  }
  const sorted = [...keys].sort(bytewise);
  for (let i = 0; i + 1 < sorted.length; i++) record(sorted[i]!, sorted[i + 1]!);
  for (let i = 0; i < 150; i++) record(pick(random, sorted), pick(random, sorted));
}

// Random insert sequences: between random neighbours and at both ends.
for (const seed of [1, 2, 3, 4, 5, 6]) {
  const random = seeded(seed);
  const list: string[] = [];
  for (let i = 0; i < 350; i++) {
    const r = random();
    const index = r < 0.15 ? 0 : r < 0.3 ? list.length : int(random, 0, list.length);
    const key = record(list[index - 1] ?? null, list[index] ?? null);
    if (key === null) throw new Error("no room in a list of generated keys");
    list.splice(index, 0, key);
  }
  if ([...list].sort(bytewise).join() !== list.join() || new Set(list).size !== list.length) throw new Error("the generated list is out of order");
}

// Appending and prepending for a long time: the head character rolls over.
{
  let last: string | null = null;
  let first: string | null = null;
  for (let i = 0; i < 4200; i++) {
    const nextLast: string | null = keyBetween(last, null);
    const nextFirst: string | null = keyBetween(null, first);
    // Keep the fixture small: the steps around a change of length, and a sample of the rest.
    if (i < 80 || nextLast.length !== (last ?? "").length || i % 37 === 0) record(last, null);
    if (i < 80 || nextFirst.length !== (first ?? "").length || i % 37 === 0) record(null, first);
    last = nextLast;
    first = nextFirst;
  }
}

// Inserting at the same spot again and again.
{
  let low = "a0";
  let high = "a1";
  for (let i = 0; i < 200; i++) {
    const key = record(low, high)!;
    if (i % 2) low = key;
    else high = key;
  }
  let after = "Zz";
  for (let i = 0; i < 120; i++) after = record("Zz", after === "Zz" ? "a0" : after)!;
  let before = "a1";
  for (let i = 0; i < 120; i++) before = record(before, "a2")!;
}

await Bun.write(path.join(import.meta.dir, "positions.json"), JSON.stringify(cases) + "\n");
console.log(`positions.json: ${cases.length} calls, ${cases.filter((c) => c[2] === null).length} of them errors`);
