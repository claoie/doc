// Writes numbers.json: JavaScript number behaviour as Bun has it, for
// tests/numbers.rs to hold common/jsnum.rs (and `numberText` of
// common/bases.rs) to.
//
//   bun src/server-rs/tests/fixtures/gen-numbers.ts
import path from "node:path";
import { numberText } from "common/bases";
import { anyDouble, enc, int, pick, seeded } from "./rng";

const random = seeded(12);

const EDGES = [
  0, -0, NaN, Infinity, -Infinity, 1, -1, 0.5, -0.5, 1.5, 2.5, -1.5, -2.5, 0.1, 0.2, 0.3, 0.1 + 0.2, 1 / 3, 2 / 3, 1e21, 1e-7, 1e-6, 123456, 123456789012, 1234567890123, 12345678901234567890,
  0.000001234, 1.45, 1.55, 8.345, 1.005, 5e-324, 1.7976931348623157e308, 2.2250738585072014e-308, 999999999999.5, 99999999999.95, 0.9999999999995, 2.5e-7, 0.0000152587890625, 1234.5, -1234.5,
  1e-10, 123.456, 9.995, 0.045, 1e15, 1e15 + 0.5, 4503599627370495.5, 4503599627370496, 9007199254740991, 9007199254740993, 0.49999999999999994, -0.49999999999999994, 2 ** 53, 2 ** -1074,
  999999.9999995, 99999.99999995, 0.00000099999999999995, 9.9999999999995e20, 9.99999999999949e20, 1.00000000000005, 1.000000000000049, 1e100, 1e-100, 4.35, 4.345, 0.615, 1.255, 2.675,
];

/** Numbers with a short exact decimal expansion: where rounding ties happen. */
const dyadic = (): number => {
  const bits = int(random, 1, 12);
  const value = (int(random, 0, 2 ** int(random, 1, 30)) * 2 + 1) / 2 ** bits;
  const scaled = value * 2 ** int(random, -8, 8);
  return random() < 0.3 ? -scaled : scaled;
};
/** Decimal-looking numbers, the kind people type: a few digits, a decimal point, sometimes a trailing 5. */
const decimal = (): number => {
  const digits = int(random, 1, 16);
  let text = "";
  for (let i = 0; i < digits; i++) text += int(random, 0, 9);
  if (random() < 0.4) text += "5";
  const point = int(random, 0, text.length);
  const n = Number(`${text.slice(0, point) || "0"}.${text.slice(point) || "0"}e${random() < 0.7 ? 0 : int(random, -12, 25)}`);
  return random() < 0.2 ? -n : n;
};
const ordinary = (): number => {
  const r = random();
  if (r < 0.3) return decimal();
  if (r < 0.5) return dyadic();
  if (r < 0.7) return (random() - 0.5) * 10 ** int(random, -10, 22);
  if (r < 0.8) return int(random, -1000, 1000) + pick(random, [0, 0.5, 0.25, 0.125, 0.75, 0.05, 0.005]);
  return anyDouble(random);
};

// toPrecision: [number, precision, text]
const toPrecision: [string, number, string][] = [];
for (const n of EDGES) for (const p of [1, 2, 3, 4, 7, 12, 15, 16, 17, 21, 22, 50, 100]) toPrecision.push([enc(n), p, n.toPrecision(p)]);
for (let i = 0; i < 1000; i++) {
  const n = ordinary();
  toPrecision.push([enc(n), 12, n.toPrecision(12)], [enc(n), 15, n.toPrecision(15)]);
}
for (let i = 0; i < 450; i++) {
  // an exact tie at some precision: one significant digit short of the exact expansion
  const n = dyadic();
  const exact = Math.abs(n).toPrecision(60).replace(/^0\.0*/, "").replace(".", "").replace(/0+$/, "");
  for (const p of [exact.length - 1, exact.length, exact.length + 1, int(random, 1, 20)]) if (p >= 1 && p <= 100) toPrecision.push([enc(n), p, n.toPrecision(p)]);
}

// Math.round: [number, result]
const round: [string, string][] = [];
for (const n of EDGES) round.push([enc(n), enc(Math.round(n))]);
for (let i = 0; i < 1500; i++) {
  const r = random();
  const n = r < 0.4 ? int(random, -1e6, 1e6) + pick(random, [0.5, -0.5, 0.49999999999999994, 0.5000000000000001, 0.25, 0]) : r < 0.5 ? (int(random, 0, 2 ** 22) + 2 ** 52 - 2 ** 21) / pick(random, [1, 2, 4]) : ordinary();
  round.push([enc(n), enc(Math.round(n))]);
}

// x ** y: [x, y, result]
const pow: [string, string, string][] = [];
const bases = [0, -0, 1, -1, 2, -2, 3, 7, 10, -10, 0.1, 0.5, 1.1, 1.0000001, 2.5, 1.5, 123.456, 1e-5, 1e5, 1e154, 1e-154, 0.999, NaN, Infinity, -Infinity, 5e-324, 1.7976931348623157e308, Math.E, Math.PI];
const exponents = [0, -0, 1, -1, 2, -2, 3, -3, 4, 5, 10, 15, 16, 22, 23, 100, 308, 309, 323, 324, 999, 1000, 1001, 1024, -1074, -1075, 0.5, -0.5, 1 / 3, 2.5, -2.5, 0.1, 1e-10, 1e10, 2 ** 31, 2 ** 31 - 1, 2 ** 32, NaN, Infinity, -Infinity, 1.5, 0.49999999999999994, 0.5000000000000001];
for (const x of bases) for (const y of exponents) pow.push([enc(x), enc(y), enc(x ** y)]);
for (let i = 0; i < 1800; i++) {
  const r = random();
  const x = r < 0.3 ? 10 : r < 0.6 ? (random() < 0.2 ? -1 : 1) * random() * 10 ** int(random, -3, 4) : r < 0.8 ? int(random, -20, 20) : ordinary();
  const s = random();
  const y = s < 0.45 ? int(random, -30, 60) : s < 0.6 ? int(random, 0, 1100) : s < 0.7 ? pick(random, [0.5, -0.5]) : s < 0.9 ? (random() - 0.5) * 20 : ordinary();
  pow.push([enc(x), enc(y), enc(x ** y)]);
}

// Math.sign, and Math.min / Math.max over lists: [values, min, max]
const sign = [...EDGES, ...Array.from({ length: 200 }, ordinary)].map((n) => [enc(n), enc(Math.sign(n))]);
const minMax: [string[], string, string][] = [[[], enc(Math.min()), enc(Math.max())]];
for (let i = 0; i < 600; i++) {
  const values = Array.from({ length: int(random, 1, 5) }, () => (random() < 0.5 ? pick(random, [0, -0, NaN, 1, -1, Infinity, -Infinity, 0.5]) : ordinary()));
  minMax.push([values.map(enc), enc(Math.min(...values)), enc(Math.max(...values))]);
}

// The functions whose last bit may depend on the maths library: [name, x, result]
const transcendental: [string, string, string][] = [];
for (let i = 0; i < 450; i++) {
  const positive = random() < 0.5 ? random() * 10 ** int(random, -8, 12) : Math.abs(ordinary());
  const any = random() < 0.5 ? (random() - 0.5) * 1400 : (random() - 0.5) * 10;
  transcendental.push(["exp", enc(any), enc(Math.exp(any))], ["log", enc(positive), enc(Math.log(positive))], ["log10", enc(positive), enc(Math.log10(positive))], ["sqrt", enc(positive), enc(Math.sqrt(positive))]);
}
for (const x of [0, -0, 1, -1, NaN, Infinity, -Infinity, 10, 100, 1000, 1e-3, Math.E, 2, 0.5, 709.78, 709.79, -745.13, -745.14, 5e-324]) {
  transcendental.push(["exp", enc(x), enc(Math.exp(x))], ["log", enc(x), enc(Math.log(x))], ["log10", enc(x), enc(Math.log10(x))], ["sqrt", enc(x), enc(Math.sqrt(x))]);
}

// numberText of common/bases.ts: [number, text]
const text = [...EDGES, ...Array.from({ length: 1500 }, ordinary)].map((n) => [enc(n), numberText(n)]);

await Bun.write(path.join(import.meta.dir, "numbers.json"), JSON.stringify({ toPrecision, round, pow, sign, minMax, transcendental, numberText: text }) + "\n");
console.log(`numbers.json: ${toPrecision.length} toPrecision, ${round.length} round, ${pow.length} pow, ${transcendental.length} transcendental, ${text.length} numberText`);
