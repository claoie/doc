// Shared by the fixture generators: a seeded random source, so every run
// writes the same fixtures, and an exact text form for doubles.

/** mulberry32: a small deterministic generator of numbers in [0, 1). */
export const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

export const int = (random: () => number, low: number, high: number): number => low + Math.floor(random() * (high - low + 1));

/**
 * A double as text that reads back exactly: `String(n)`, with `-0` spelled
 * out. JSON numbers are avoided for doubles because not every JSON parser
 * rounds a 17-digit literal correctly, and NaN and the infinities have no
 * JSON form.
 */
export const enc = (n: number): string => (Object.is(n, -0) ? "-0" : String(n));

/** A random double: any bit pattern, so every magnitude and the special values turn up. */
export const anyDouble = (random: () => number): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, Math.floor(random() * 4294967296));
  view.setUint32(4, Math.floor(random() * 4294967296));
  return view.getFloat64(0);
};

/**
 * A JSON value with every number replaced by `{"$n": "<exact text>"}`, for
 * inputs whose numbers must reach the Rust side bit for bit.
 */
export const exact = (value: unknown): unknown => {
  if (typeof value === "number") return { $n: enc(value) };
  if (Array.isArray(value)) return value.map(exact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, exact(v)]));
  return value;
};
