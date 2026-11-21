// Writes dates.json and date-parse.json: what Bun's Date does, for
// tests/dates.rs to hold common/jsdate.rs to.
//
//   bun src/server-rs/tests/fixtures/gen-dates.ts
//
// dates.json holds the zone-independent parts (Date.UTC, the UTC getters,
// toISOString, setUTCDate). date-parse.json holds a corpus of strings and
// what Date.parse makes of each in three time zones; the script runs itself
// once per zone with TZ set (`TZ=America/New_York bun gen-dates.ts --parse`),
// since text without an offset is local time.
//
// For a longer fuzz run than the repository should carry:
//
//   bun src/server-rs/tests/fixtures/gen-dates.ts --extra <seed> <count> <file> [zone...]
//   DATE_PARSE_EXTRA=<file> cargo test -p doc-server --test dates -- --ignored
import path from "node:path";
import { enc, pick, seeded } from "./rng";

const ZONES = ["UTC", "America/New_York", "Europe/Berlin"];
/**
 * Zones that only get a short list of strings (`edges` below): ones whose
 * rules changed lately, end without a rule, or have unusual offsets, which
 * is what tells apart the ways an offset can be found for the far future
 * and for wall-clock times just outside the range of time values.
 */
const EDGE_ZONES = ["Africa/Cairo", "Asia/Tehran", "Africa/Casablanca", "Pacific/Apia", "Europe/Moscow", "Australia/Lord_Howe", "America/Santiago", "America/St_Johns", "Asia/Kathmandu", "Pacific/Kiritimati", "America/Sao_Paulo"];

// ---------------------------------------------------------------------------
// The corpus

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number, width = 2) => String(n).padStart(width, "0");

const isoShapes = (): string[] => {
  const out: string[] = [];
  const years = ["0000", "0001", "0049", "0050", "0099", "0100", "1000", "1582", "1600", "1883", "1900", "1969", "1970", "1999", "2000", "2023", "2024", "2038", "2100", "9999"];
  for (const y of years) {
    out.push(y, `${y}-01`, `${y}-12`, `${y}-02-29`, `${y}-12-31`, `${y}-01-01T00:00:00Z`, `${y}-06-15T12:30:45`, `${y}-06-15T12:30:45.678+02:00`);
  }
  // every month with the days around its end, in a leap year, a common year and two century years
  for (const y of ["2023", "2024", "1900", "2000"]) {
    for (let m = 0; m <= 13; m++) {
      out.push(`${y}-${pad(m)}`);
      for (const d of [0, 1, 28, 29, 30, 31, 32]) out.push(`${y}-${pad(m)}-${pad(d)}`, `${y}-${pad(m)}-${pad(d)}T12:00:00Z`, `${y}-${pad(m)}-${pad(d)}T12:00`);
    }
  }
  const times = [
    "10", "10:30", "10:30:15", "10:30:15.1", "10:30:15.12", "10:30:15.123", "10:30:15.1234", "10:30:15.123456789", "10:30:15.1234567891", "10:30:15.0001",
    "10:30:15.0123456789123", "10:30:15.000000000999", "10:30:15.999999999999", "10:30:15.", "10:30:15,5", "10:30.5", "1:30", "10:3", "10:30:1", "010:30", "10:030",
    "00:00", "00:00:00", "23:59", "23:59:59", "23:59:59.999", "24:00", "24:00:00", "24:00:00.0", "24:00:00.000", "24:00:00.001", "24:00:01", "24:01", "25:00",
    "23:60", "23:59:60", "23:59:61", "12:00:00.5", "1030", "103015", "10:30:15:20", "10-30", "", ":", "10:", "10:30:",
  ];
  const zones = [
    "", "Z", "z", "+00:00", "-00:00", "+01:00", "-05:30", "+0100", "-0530", "+01", "-01", "+1", "+01:0", "+1:00", "+23:59", "+24:00", "+2359", "+2400", "+12:60", "+1260",
    "+01:00:00", "+010000", " Z", " +01:00", "UTC", "GMT", " UTC", " PST", "ZZ", "Z ", "+", "-", "Z+01:00", "+01:00Z",
  ];
  for (const t of times) for (const z of zones) out.push(`2024-03-05T${t}${z}`);
  for (const sep of ["t", " ", "  ", "_", "T ", " T", "", "\t", "\n", " "]) {
    for (const rest of ["10:30", "10:30:15Z", "10:30:15.5+01:00", "10:30 PM", "10:30:15 PST"]) out.push(`2024-03-05${sep}${rest}`);
  }
  const expanded = [
    "+002024-03-05", "-002024-03-05", "+000000-01-01", "-000000-01-01", "-000000", "+000000", "-000001", "-000001-12-31", "+275760-09-13", "+275760-09-14", "+275760-09-12",
    "-271821-04-20", "-271821-04-19", "-271821-04-21", "+999999-12-31", "-999999-01-01", "+02024-03-05", "+0002024-03-05", "+2024-03-05", "-2024-03-05", "+010000-01-01",
    "+009999-12-31", "-000100-06-15", "+100000-06-15", "-100000-06-15", "+002024", "+002024-03", "+002024-13", "+002024-03-32", "002024-03-05", "+ 002024-03-05", "++002024-03-05",
  ];
  for (const e of expanded) {
    out.push(e, `${e}T00:00:00Z`, `${e}T00:00:00.000Z`, `${e}T00:00:00.001Z`, `${e}T12:00:00`, `${e}T23:59:59.999`, `${e}T00:00:00`, `${e}T00:00:00+14:00`, `${e}T00:00:00-12:00`, `${e} 01:00`);
  }
  for (const s of ["2024-03-05", "2024-03-05T10:30:15Z", "2024-03-05T10:30:15", "2024-03"]) {
    out.push(` ${s}`, `${s} `, `\t${s}`, `${s}\n`, ` ${s}`, `${s} `, `(x)${s}`, `${s}(x)`, `${s} (x)`, `x${s}`, `${s}x`, `x ${s}`, `${s} x`, `${s},`, `,${s}`, `${s}.`, `${s}-`, `-${s}`, `+${s}`, `${s}+`);
  }
  out.push("2024-3-5", "2024-03-5", "2024-3-05", "24-03-05", "024-03-05", "02024-03-05", "2024-003-05", "2024-03-005", "2024--03-05", "2024-03--05", "2024-03-05-", "2024-03-05-01", "2024-03-05--01");
  out.push("2024/03/05T10:30", "2024.03.05T10:30", "20240305", "20240305T103015Z", "2024-065", "2024-W10", "2024-W10-2", "T10:30", "10:30", "10:30Z", "--03-05", "2024-03-05T10:30:15Z[UTC]");
  return out;
};

/** Local wall-clock times at and around clock changes, and spread over the centuries. */
const localTimes = (random: () => number): string[] => {
  const out: string[] = [];
  const years = [1900, 1916, 1918, 1920, 1940, 1942, 1945, 1946, 1947, 1949, 1966, 1967, 1973, 1974, 1975, 1976, 1979, 1980, 1981, 1986, 1987, 1995, 1996, 2006, 2007, 2024, 2037, 2038, 2071, 2072, 2099, 2100, 2101, 2400, 3000];
  for (const y of years) {
    for (const m of [3, 4, 9, 10, 11]) {
      for (let d = 1; d <= 30; d++) {
        if (random() < 0.5) continue;
        out.push(`${y}-${pad(m)}-${pad(d)}T02:30:00`, `${y}-${pad(m)}-${pad(d)}T01:30:00`);
      }
    }
  }
  for (const day of ["2024-03-10", "2024-11-03", "2024-03-31", "2024-10-27", "1945-05-24", "1945-09-24", "1883-11-18", "1893-04-01", "2100-03-14", "2100-11-07", "2101-03-27", "2101-10-30"]) {
    for (let minutes = 0; minutes < 5 * 60; minutes += 10) out.push(`${day}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`);
    out.push(`${day}T11:56:02`, `${day}T12:00:00`, `${day}T12:03:57`, `${day}T12:03:58`, `${day}T00:06:31`, `${day}T00:06:32`);
  }
  // instants spread from 1700 to 2300, written as local ISO, as a legacy date and as m/d/y
  for (let i = 0; i < 900; i++) {
    const t = new Date(Date.UTC(1700, 0, 1) + Math.floor(random() * 600 * 365.25 * 86_400_000));
    const [y, m, d, h, mi, s] = [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds()];
    const shape = i % 3;
    if (shape === 0) out.push(`${pad(y, 4)}-${pad(m + 1)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`);
    else if (shape === 1) out.push(`${MONTHS[m]!.slice(0, 3)} ${d} ${y} ${pad(h)}:${pad(mi)}`);
    else out.push(`${m + 1}/${d}/${y} ${h % 12 || 12}:${pad(mi)}:${pad(s)} ${h < 12 ? "AM" : "PM"}`);
  }
  for (const y of ["-271821", "-271820", "-100000", "-000001", "0000", "0001", "0099", "0100", "1000", "+010000", "+100000", "+275759", "+275760"]) {
    for (const rest of ["-01-01T00:00:00", "-04-19T23:00:00", "-04-20T00:00:00", "-04-20T12:00:00", "-07-01T12:00:00", "-09-12T23:00:00", "-09-13T00:00:00", "-09-13T01:30:00", "-09-13T06:00:00", "-12-31T23:59:59.999"]) {
      out.push(`${y}${rest}`);
    }
  }
  return out;
};

const legacyShapes = (): string[] => {
  const out: string[] = [];
  for (const month of MONTHS) {
    const short = month.slice(0, 3);
    for (const name of [month, short, month.toUpperCase(), short.toLowerCase(), `${short}.`, `${short}x`, month.slice(0, 2), month.slice(0, 4)]) {
      out.push(`${name} 5 2024`, `5 ${name} 2024`, `${name} 2024`, `2024 ${name} 5`, `${name} 5`, `05-${name}-2024 10:30`, `${name}`);
    }
  }
  for (const day of WEEKDAYS) {
    const short = day.slice(0, 3);
    for (const name of [day, short, short.toUpperCase(), `${short},`, `${day},`]) {
      out.push(`${name} Mar 05 2024`, `${name} 05 Mar 2024 10:00:00 GMT`, `${name} 3/5/2024`, `${name}`, `${name} 5`, `Mar 5 2024 ${name}`, `5 ${name} Mar 2024`, `${name}5 Mar 2024`);
    }
  }
  const dates = [
    "Mar 5 2024", "Mar 5, 2024", "5 Mar 2024", "5 March 2024", "March 5th 2024", "March 5th, 2024", "1st Mar 2024", "2024 Mar 5", "2024 5 Mar", "Mar 2024", "Mar 5", "5 Mar", "Mar",
    "05-Mar-2024", "05/Mar/2024", "Mar/5/2024", "Mar-05-24", "Mar 5 99", "Mar 5 49", "Mar 5 50", "Mar 5 100", "Mar 05 0099", "Mar 05 0049", "Mar 32 2024", "Mar 0 2024", "Mar 31 2024",
    "Feb 30 2024", "Feb 29 2023", "Feb 31 2023", "Apr 31 2024", "Mar 5 2024 6", "Mar 5 6 7", "Mar 32 5", "Mar 5 32", "Mar 32 33", "Mar 0 0", "Mar 00 00", "Jan 1 1", "Jan 1 0", "Jan 0 1",
    "3/5/2024", "03/05/2024", "3/5/24", "3/5", "13/5/2024", "5/13/2024", "2024/3/5", "2024/03/05", "2024/13/05", "2024/03/32", "3-5-2024", "3.5.2024", "2024.03.05", "3 5 2024", "2024 3 5",
    "1/2/3", "32/1/2", "1/32/2", "1/2/32", "0/0/0", "12/31/1999", "1/1/1970", "12/31/9999", "1/1/10000", "1/1/275760", "9/13/275760", "9/14/275760", "9/12/275760", "4/20/-271821",
    "Mar 5 275760", "Sep 13 275760", "Sep 14 275760", "Sep 12 275760", "Mar 5 -2024", "Mar -5 2024", "Mar +5 2024", "Mar 5 +2024", "Mar 5-2024", "Mar-5-2024", "Mar--5", "5--Mar--2024",
    "Mar5 2024", "Mar52024", "5Mar2024", "2024Mar5", "Mar,5,2024", "Mar;5;2024", "Mar_5_2024", "Mar 5 2024,", "Mar 5 2024.", "Mar 5 2024 -", "Mar 5 2024 +", "- Mar 5 2024", "+ Mar 5 2024",
    "(x) Mar 5 2024", "Mar (x) 5 2024", "Mar 5 (x) 2024", "Mar 5 2024 (x)", "Mar 5 2024 (x", "Mar 5 2024 )", ") Mar 5 2024", "Mar 5 ) 2024", "Mar (x(y)z) 5 2024", "Mar (x(y) 5 2024", "Mar (5) 2024", "(Mar 5 2024)",
    "Mar 5 2024 x", "x Mar 5 2024", "x5 Mar 2024", "x 5 Mar 2024", "of Mar 5 2024", "the 5 of Mar 2024", "Mar 5 2024 at 10:00", "Mar 5 2024 10:00:00 o'clock", "date: Mar 5 2024", "Mar 5 2024 A.D.",
    "Mar 5 2024", " Mar 5 2024", "Mar　5　2024", "﻿Mar 5 2024", "Mar\u00855 2024", "Mar\u0085 5 2024", "Mär 5 2024", "März 5 2024", "Μar 5 2024", "５ Mar 2024", "５Mar 2024",
    "Mar 5 2024\u0000garbage", "\u0000Mar 5 2024", "Mar 5\u00002024", "😀 Mar 5 2024", "Mar 😀 5 2024", "Mar 5 2024 😀", "Mar😀 5 2024", "[Mar] 5 2024", "Mar_ 5 2024", "{5} Mar 2024", "Mar 5 2024 ~", "`Mar 5 2024", "Mar ^5 2024",
    "", " ", "\n", "null", "undefined", "NaN", "Invalid Date", "now", "today", "tomorrow", "yesterday", "noon", "midnight", "Z", "T", "AM", "PM", "UTC", "GMT", "1 GMT", "GMT 1", "Z 1", "T 1", "1 T", "1T", "1Z", "AM 1", "1 AM", "1 1 1 AM",
    "Tue Mar 05 2024 10:00:00 GMT+0000 (Coordinated Universal Time)", "Tue Mar 05 2024 10:00:00 GMT+0100 (Central European Standard Time)", "Tue Mar 05 2024 10:00:00 GMT-0500 (Eastern Standard Time)",
    "Tue, 05 Mar 2024 10:00:00 GMT", "3/5/2024, 10:00:00 AM", "Tuesday, March 5, 2024 at 10:00:00 AM", "Tuesday, March 5, 2024 at 10:00:00 AM Eastern Standard Time", "March 5, 2024", "5 March 2024 at 10:00",
    "Tue, 5 Mar 2024 10:00:00 +0100", "5 Mar 2024 10:00 -0800 (PST)", "05 Mar 24 10:00 UT", "Tue, 05-Mar-24 10:00:00 GMT", "Tuesday, 05-Mar-24 10:00:00 GMT", "Tue Mar  5 10:00:00 2024", "Tue Mar  5 10:00:00 EST 2024",
  ];
  out.push(...dates);
  const times = [
    "10:00", "10:00:00", "10:00:00.123", "10:00 AM", "10:00 PM", "12:00 AM", "12:00 PM", "0:00 AM", "0:00 PM", "13:00 PM", "13:00 AM", "10 AM", "10AM", "10:00AM", "10:00 am", "10:00 Am", "10:00 A.M.", "10:00 AMX",
    "10:00:00 PM", "24:00", "24:00:00", "24:00:00.000", "24:00 AM", "24:01", "25:00", "23:59:59.999", "23:60", "23:59:60", "1:2:3", "1:2:3.4", "1:2:3.45678", "10::30", "10::30:15", "10:30:", "10:", ":10", "::10",
    "10:30:15:20", "10:30:15:999", "10:30:15:1000", "10:30:15:20:25", "10.30", "10:30.5", "10:30:15.5", "10:30:15.", "10:30:15,5", "10:30:15.5.5", "T10:00", "at 10:00", "10h", "1000", "10 : 30", "10: 30", "10 :30",
    "10:30 15", "10:30:15 20", "10:30:15.5 20", "10:60", "10:30:60", "10:99", "99:00", "100:00", "010:030", "10:30-", "10:30+", "10:30Z", "10:30 Z", "10:30z", "10:30PST", "10:30:15PST", "10:30 PM PST", "10:30 PST PM",
    "PM 10:30", "10 PM", "10:30 AM PM", "10:30 PM AM", "0:0", "00:00:00.000", "10:30:15.123456789", "10:30:15.0123456789123", "10:30:15.000000000999",
  ];
  for (const t of times) out.push(`Mar 5 2024 ${t}`, `${t} Mar 5 2024`, `Mar 5 ${t} 2024`, `3/5/2024 ${t}`, `2024-03-05 ${t}`, `${t}`);
  const zones = [
    "Z", "z", "UT", "UTC", "GMT", "EST", "EDT", "CST", "CDT", "MST", "MDT", "PST", "PDT", "est", "Pst", "CET", "BST", "IST", "UTCX", "GMTZ", "UTC+1", "UTC+01", "UTC+0100", "UTC+01:00", "UTC+1:30",
    "UTC-1", "UTC +1", "UTC+ 1", "GMT+0530", "GMT-08:00", "GMT+1234", "GMT+12345", "GMT+", "GMT-", "+1", "-1", "+01", "+0100", "+01:00", "+1:00", "+01:30", "+0130", "+130", "+99", "+9999",
    "+99:99", "+24", "+2400", "+12:60", "+12:59", "+00", "-00:00", "+300000:00", "+596523:00", "+596524:00", "+600000:00", "+01:00:00", "+01:", "+:30", "+01:30:45", "+01 30", "+01: 30",
    "(PST)", "PST (Pacific Standard Time)", "GMT+0100 (CET)", "EST EDT", "Z Z", "Z+1", "PST+1", "PST-1", "+1 PST", "+1 +1", "+1 -1", "-0800 (PST)", "PST8PDT", "America/New_York", "Europe/Berlin",
  ];
  for (const z of zones) out.push(`Mar 5 2024 10:00 ${z}`, `Mar 5 2024 10:00:00${z}`, `Mar 5 2024 ${z}`, `${z} Mar 5 2024 10:00`, `Mar 5 ${z} 2024 10:00`, `2024-03-05 10:00 ${z}`, `3/5/2024 ${z}`);
  return out;
};

const numericShapes = (): string[] => {
  const out: string[] = [];
  for (let n = 0; n <= 130; n++) out.push(String(n));
  for (let length = 1; length <= 13; length++) out.push("1234567890123".slice(0, length), "0".repeat(length), "9".repeat(length), "0".repeat(length - 1) + "7");
  out.push("999", "1000", "1899", "1900", "9999", "10000", "99999", "100000", "275760", "275761", "999999", "1000000", "032", "0032", "1e3", "1.5", "1,5", "+1", "-1", "+01", "-0001", "+2024", "-2024", "1709632800000", "17096328");
  const parts = [0, 1, 12, 13, 31, 32, 49, 50, 99, 100, 2024];
  for (const a of parts) {
    for (const b of parts) {
      out.push(`${a} ${b}`, `${a}/${b}`);
      for (const c of parts) out.push(`${a} ${b} ${c}`);
    }
  }
  for (const [a, b, c] of [[3, 5, 2024], [2024, 3, 5], [5, 3, 24], [13, 5, 2024], [3, 31, 0], [0, 3, 5], [31, 12, 31], [12, 31, 31]] as const) {
    for (const sep of ["/", "-", ".", ",", ", ", " - ", "--", "//", ":", " / ", "\\", "_", "|", ";"]) out.push(`${a}${sep}${b}${sep}${c}`, `${a}${sep}${b}`, `${pad(a)}${sep}${pad(b)}${sep}${pad(c)}`);
  }
  for (const s of ["Mar 5 2024", "3/5/2024", "2024-03-05", "2024-03-05T10:00:00", "12", "Mar 5 2024 10:00 PM"]) {
    for (const [before, after] of [[" ", ""], ["", " "], ["  ", "  "], ["\t", "\t"], ["\n", "\n"], ["\r\n", "\r\n"], [" ", " "], ["　", ""], ["", "﻿"], ["\u0085", ""], ["​", ""], ["᠎", ""]] as const) {
      out.push(`${before}${s}${after}`);
    }
    out.push(s.replaceAll(" ", "  "), s.replaceAll(" ", "\t"), s.replaceAll(" ", "\n"), s.replaceAll(" ", ""), s.replaceAll(" ", " "));
  }
  return out;
};

/** Every character whose class matters to the parser, in the positions that tell the classes apart. */
const characterShapes = (): string[] => {
  const out: string[] = [];
  const codes = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x180e, 0x2000, 0x2001, 0x2005, 0x200a, 0x200b, 0x2028, 0x2029, 0x202f, 0x205f, 0x2060, 0x3000, 0xfeff, 0xff10, 0x660];
  for (let code = 0x21; code < 0x7f; code++) if (!/[0-9A-Za-z]/.test(String.fromCharCode(code))) codes.push(code);
  for (const code of codes) {
    const c = String.fromCharCode(code);
    out.push(`Mar 5 2024 10:30${c}`, `Mar 5 2024 10:30${c}PM`, `Mar 5${c}2024`, `${c}Mar 5 2024`, `Mar${c}5 2024`, `2024-03-05T10:30:15${c}`, `2024-03-05${c}10:30`, `3${c}5${c}2024`, `Mar 5 2024 10${c}30`, `Mar 5 2024 10:30 ${c}1`);
  }
  for (const c of "ZzTt") out.push(`Mar 5 2024 10:30${c}`, `Mar 5${c}2024`, `${c}Mar 5 2024`, `2024-03-05${c}`, `2024-03-05${c}10:30${c}`, `5${c}`, `${c}5`);
  // wall-clock times just outside the range of time values, which are still instants in some zones
  for (const t of ["18:00:00", "19:00:00", "19:03:57", "19:03:58", "19:59:59", "20:00:00", "21:07:15", "23:59:59.999"]) out.push(`-271821-04-19T${t}`, `Apr 19 -271821 ${t}`);
  for (const t of ["00:00:00.001", "01:00:00", "02:00:00", "02:00:00.001", "05:30:00", "10:30:00", "14:00:00", "14:00:00.001"]) out.push(`+275760-09-13T${t}`, `Sep 13 275760 ${t}`, `9/13/275760 ${t}`);
  return out;
};

const FUZZ_BASES = [
  "2024-03-05", "2024-03-05T10:30:15Z", "2024-03-05T10:30:15.123+01:00", "2024-03-05T10:30", "2024-03-05T24:00:00", "+002024-03-05T10:30:15Z", "-000001-12-31T23:59:59.999Z", "2024-03",
  "2024", "2024-03-05 10:30:15", "2024-03-05 10:30 PM", "Mar 5 2024", "March 5, 2024 10:00 PM", "5 March 2024 22:15:30", "Tue Mar 05 2024 10:00:00 GMT+0100 (CET)", "Tue, 05 Mar 2024 10:00:00 GMT",
  "3/5/2024", "3/5/2024, 10:00:00 AM", "12/31/1999 23:59:59", "2024/03/05 10:30", "05-Mar-2024", "2024.03.05", "Mar 5 2024 10:00 PST", "Mar 5 2024 10:00 UTC+2", "Mar 5 2024 10:00 +0530",
  "Mar 5 2024 10:00:00.5", "Sat Nov 2 2024 01:30 EDT", "Jan 1 99", "1/2/3", "12", "2024 Mar", "Mar 5", "10:00 Mar 5 2024", "Dec 31 49 12:00 AM", "Jul 4 1776", "Sep 13 275760 00:00 UTC",
  "2024-11-03T01:30:00", "2024-03-10T02:30:00", "2024-03-31T02:30:00", "1883-11-18T12:00:00", "Mar 10 2024 2:30 AM", "Oct 27 2024 2:30", "6/15/1850 12:00", "Feb 29 2024 23:59:59 GMT-11",
];
const FUZZ_ALPHABET = [
  ..."0123456789", ..."0123456789", ..."::--++..//,, ()TZtz", " ", " ", "\t", "\n", " ", ..."AaPpMmUuCcGgEeSsDdJjNnFfOoYyLlRrVvBb", "x", "_", "@", "#", "'", "\"", "[", "ä", "😀", "\u0000", " ",
];
const FUZZ_TOKENS = [
  "Jan", "Feb", "Mar", "March", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec", "December", "Mon", "Tue", "Friday", "AM", "PM", "am", "pm", "Z", "UT", "UTC", "GMT", "EST", "EDT", "CST", "CDT", "MST", "MDT",
  "PST", "PDT", "T", "t", "CET", "th", "of", "at", ":", "::", "-", "+", ".", "/", ",", "(", ")", "(x)", "0", "1", "5", "12", "13", "24", "31", "32", "49", "50", "59", "60", "99", "100", "999", "1000", "1970", "2024", "9999", "12345",
  "00", "01", "05", "000", "0123", "002024", "275760", "10:30", "10:30:15", "10:30:15.5", "2024-03-05", "3/5", "+01:00", "-0800", "+1", "-1",
];

const fuzz = (random: () => number, count: number): string[] => {
  const out: string[] = [];
  const mutate = (s: string): string => {
    const chars = [...s];
    const at = Math.floor(random() * (chars.length + 1));
    switch (Math.floor(random() * 9)) {
      case 0:
        chars.splice(at, 1);
        break;
      case 1:
      case 2:
        chars.splice(at, 0, pick(random, FUZZ_ALPHABET));
        break;
      case 3:
      case 4:
        chars.splice(at, 1, pick(random, FUZZ_ALPHABET));
        break;
      case 5: {
        const length = 1 + Math.floor(random() * 4);
        chars.splice(at, 0, ...chars.slice(at, at + length));
        break;
      }
      case 6:
        if (at + 1 < chars.length) [chars[at], chars[at + 1]] = [chars[at + 1]!, chars[at]!];
        break;
      case 7:
        chars.length = at;
        break;
      default:
        if (at < chars.length) chars[at] = random() < 0.5 ? chars[at]!.toUpperCase() : chars[at]!.toLowerCase();
    }
    return chars.join("");
  };
  for (let i = 0; i < count; i++) {
    if (i % 3 === 2) {
      // a soup of tokens
      const n = 1 + Math.floor(random() * 8);
      let s = "";
      for (let k = 0; k < n; k++) s += pick(random, FUZZ_TOKENS) + pick(random, [" ", " ", " ", "", "", "-", "/", ", ", ":", "."]);
      out.push(s.trimEnd());
      continue;
    }
    let s = pick(random, FUZZ_BASES);
    const mutations = 1 + Math.floor(random() * 3);
    for (let k = 0; k < mutations; k++) s = mutate(s);
    out.push(s);
  }
  return out;
};

/**
 * The strings of the fixture, or with `extra` a bigger, purely fuzzed set
 * for a longer run (a count of 0 gives the systematic strings instead, to
 * try them in more zones).
 */
const corpus = (extra?: { seed: number; count: number }) => {
  if (extra?.count) return { strict: [], fuzzed: [...new Set(fuzz(seeded(extra.seed), extra.count))] };
  const random = seeded(20240305);
  const strict = [...new Set([...isoShapes(), ...localTimes(random), ...legacyShapes(), ...numericShapes(), ...characterShapes()])];
  if (extra) return { strict, fuzzed: [] };
  const seen = new Set(strict);
  const fuzzed = [...new Set(fuzz(random, 6500))].filter((s) => !seen.has(s));
  return { strict, fuzzed };
};

/** `--extra <seed> <count> <file> [zone...]`: a longer fuzz run, written outside the repository. */
const extraArgs = () => {
  const at = process.argv.indexOf("--extra");
  if (at < 0) return undefined;
  const [seed, count, file, ...zones] = process.argv.slice(at + 1);
  return { seed: Number(seed), count: Number(count), file: file!, zones: zones.filter((z) => z !== "--parse") };
};

const edges = (): string[] => {
  const out: string[] = [];
  for (const t of ["00:00:00", "12:00:00", "18:00:00", "19:30:00", "20:00:00", "21:00:00", "22:30:00", "23:59:59.999"]) out.push(`-271821-04-19T${t}`, `-271821-04-20T${t}`);
  for (const t of ["00:00:00", "00:00:00.001", "00:08:00", "03:30:00", "05:45:00", "10:30:00", "13:00:00", "14:00:00", "23:00:00"]) out.push(`+275760-09-13T${t}`, `+275760-09-12T${t}`);
  for (const year of [1890, 1920, 1950, 1985, 2000, 2008, 2011, 2015, 2021, 2022, 2023, 2026, 2027, 2032, 2037, 2038, 2087, 2088, 2099, 2100, 2101, 2206, 2524, 9999, 12345]) {
    for (const rest of ["-01-15T12:00:00", "-04-19T23:00:00", "-07-15T12:00:00", "-09-13T00:08:00", "-10-05T02:30:00", "-12-30T12:00:00"]) out.push(`${year > 9999 ? `+0${year}` : year}${rest}`);
  }
  return out;
};

// ---------------------------------------------------------------------------
// One zone's answers (run with TZ set)

const parseWorker = async () => {
  const { strict, fuzzed } = process.argv.includes("--edges") ? { strict: edges(), fuzzed: [] } : corpus(extraArgs());
  const answers = [...strict, ...fuzzed].map((s) => {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  });
  await Bun.write(Bun.stdout, JSON.stringify({ zone: process.env.TZ, answers }));
};

// ---------------------------------------------------------------------------
// The fixtures

/**
 * The first zone's answers in full; for the others only the answers that
 * differ from the first zone's, as `[index, answer]` pairs (text with an
 * offset, and text that is no date, read the same everywhere).
 */
const writeParseFixture = async () => {
  const extra = extraArgs();
  const { strict, fuzzed } = corpus(extra);
  const zoneNames = extra?.zones.length ? extra.zones : ZONES;
  const zones: Record<string, (number | null)[] | [number, number | null][]> = {};
  let first: (number | null)[] | undefined;
  for (const zone of zoneNames) {
    const run = Bun.spawnSync([process.execPath, ...process.argv.slice(1), "--parse"], { env: { ...process.env, TZ: zone }, stdout: "pipe", stderr: "inherit" });
    if (run.exitCode !== 0) throw new Error(`the ${zone} run failed`);
    const result = JSON.parse(run.stdout.toString()) as { zone: string; answers: (number | null)[] };
    if (result.zone !== zone || result.answers.length !== strict.length + fuzzed.length) throw new Error(`unexpected answer from the ${zone} run`);
    if (!first) {
      first = result.answers;
      zones[zone] = first;
    } else {
      const base = first;
      zones[zone] = result.answers.flatMap((answer, index): [number, number | null][] => (answer === base[index] ? [] : [[index, answer]]));
    }
  }
  const edgeZones: Record<string, (number | null)[]> = {};
  if (!extra) {
    for (const zone of EDGE_ZONES) {
      const run = Bun.spawnSync([process.execPath, import.meta.path, "--parse", "--edges"], { env: { ...process.env, TZ: zone }, stdout: "pipe", stderr: "inherit" });
      if (run.exitCode !== 0) throw new Error(`the ${zone} run failed`);
      edgeZones[zone] = (JSON.parse(run.stdout.toString()) as { answers: (number | null)[] }).answers;
    }
  }
  const file = extra?.file ?? path.join(import.meta.dir, "date-parse.json");
  await Bun.write(file, JSON.stringify({ strings: [...strict, ...fuzzed], fuzzFrom: strict.length, zones, edges: { strings: edges(), zones: edgeZones } }) + "\n");
  console.log(`${path.basename(file)}: ${strict.length} strings and ${fuzzed.length} fuzzed, in ${zoneNames.length} zones; ${edges().length} more in ${Object.keys(edgeZones).length} zones`);
};

const writeDateFixture = async () => {
  const random = seeded(8640);
  const numbers = (): number => {
    const r = random();
    if (r < 0.03) return NaN;
    if (r < 0.05) return random() < 0.5 ? Infinity : -Infinity;
    if (r < 0.08) return random() < 0.5 ? 0 : -0;
    if (r < 0.5) return Math.floor(random() * 80) - 20;
    if (r < 0.65) return (random() - 0.3) * 100;
    if (r < 0.75) return Math.floor((random() - 0.5) * 20_000);
    if (r < 0.85) return (random() - 0.5) * 10 ** Math.floor(random() * 18);
    if (r < 0.9) return pick(random, [2147483647, 2147483648, -2147483648, -2147483649, 4294967296, 1e21, -1e21, 1e300, 8.64e15, -8.64e15, 5e-324, 0.5, -0.5, 0.9999999999999999, 99.99, 100, -1e-7]);
    return Math.floor(random() * 4000);
  };
  const years = (): number => {
    const r = random();
    if (r < 0.5) return 1900 + Math.floor(random() * 200);
    if (r < 0.6) return Math.floor(random() * 120) - 10;
    if (r < 0.7) return (random() - 0.5) * 600_000;
    if (r < 0.75) return pick(random, [275760, -271821, 275761, -271822, 2147483647, -2147483648, 2147483648, 5000000, -5877641, 1e9, -1e9]);
    return numbers();
  };
  const utcArgs: number[][] = [
    [], [NaN], [2024], [2024, 0], [2024, 0, 1], [2024, 0, 1.9], [2024.9, 0.9, 1.9, 1.9, 1.9, 1.9, 1.9], [2024, NaN], [2024, 0, 1, 0, 0, 0, 0.5], [2024, 0, 1, 0, 0, 0, -0.5],
    [1970, 0, 1, 0, 0, 0, 3e9], [1970, 0, 1, 0, 0, 3e9], [1e10], [2024, Infinity], [-0.5, 0, 1], [99.9, 0, 1], [100, 0, 1], [-1, 0, 1], [0, 0, 1], [50], [99], [2024, 12, 1], [2024, -1, 1],
    [2024, 0, 0], [2024, 0, -1], [2024, 1, 30], [2024, 25, 400], [2024, -25, -400], [275760, 8, 13], [275760, 8, 14], [275760, 8, 13, 0, 0, 0, 1], [-271821, 3, 20], [-271821, 3, 19],
    [-271821, 3, 20, 0, 0, 0, -1], [5000000, 0, -1826212500], [-5877641, 11, 2147483647], [-5877641, 0, 2147483647], [5879611, 0, -2147483648], [2147483647, 0, 1], [2147483647, 12, 1],
    [2147483647, 11, 1], [-2147483648, 0, 1], [-2147483648, -1, 1], [-2147483648, -12, 1], [2147483646, 12, 1], [2147483646, 24, 1], [300000, 0, -10000000], [1970, 2147483647, 1],
    [1970, -2147483648, 1], [1970, 25769803764, 1], [1970, 25769803776, 1], [1970, 0, 1, 2147483647], [1970, 0, 1, 0, 2147483647], [1970, 0, 1, 24, 60, 60, 1000], [1970, 0, 1, -1, -1, -1, -1],
    [2024, 0, 1, 0, 0, 0, 1e-7], [1970, 0, 1e300], [1970, 0, 1, 1e300], [1970, 1e300, 1], [1e300, -1e300, 1], [1970, 0, 1, 1e12, -6e13], [1970, 0, 1, 0, 0, 0, 8.64e15], [1970, 0, 1, 0, 0, 0, 8.64e15 + 2],
    [1970, 0, 1, 0, 0, 8.64e12, 0.5], [1970, 0, 2, 0, 0, 0, -8.64e15 - 86400000], [1970, 0, 100000001, 0, 0, 0, -8.64e15], [2024, 0, 1, 0, 0, 0.999], [2024, 0, 1, 0, 0.999], [2024, 0, -0.5],
    [2024, -0.5, 1], [2024, 11.99, 1], [1969.999, 0, 1], [-0.999, 0, 1], [-1.5, 0, 1], [2024, 0, 1, 0, 0, 0, 0, 99], [-0, 0, 1], [2024, -0, -0], [0.5], [99.5, 5.5], [-99, 0, 1], [1e9, 0, -365242134000],
  ];
  for (let i = 0; i < 1500; i++) {
    const length = 1 + Math.floor(random() * 7);
    utcArgs.push([years(), ...Array.from({ length: length - 1 }, (_, k) => (k === 0 && random() < 0.6 ? Math.floor(random() * 12) : k === 1 && random() < 0.6 ? 1 + Math.floor(random() * 31) : numbers()))]);
  }

  const timeValues = [
    0, -1, 1, 0.9, -0.9, -0, 86399999, 86400000, -86400000, -86400001, 8.64e15, -8.64e15, 8.64e15 + 1, -8.64e15 - 1, 8.64e15 - 0.5, 8.64e15 + 0.5, NaN, Infinity, -Infinity, 1e300, -62198755200000,
    -62167219200000, -62167219200001, 253402300799999, 253402300800000, 1709632800123.75, -1709632800123.75, 951782400000, 4107542400000, -2208988800000, 946684800000, 951868800000, 5e-324,
  ];
  for (let i = 0; i < 1500; i++) {
    const r = random();
    timeValues.push(r < 0.5 ? Math.floor((random() - 0.5) * 4e13) : r < 0.9 ? Math.floor((random() - 0.5) * 1.73e16) : (random() - 0.5) * 1.8e16);
  }
  // the first and last instant of every month of years around the calendar's edges
  for (const y of [-271821, -100, -1, 0, 1, 4, 99, 100, 400, 1582, 1600, 1700, 1800, 1899, 1900, 1901, 1969, 1970, 1972, 1999, 2000, 2001, 2023, 2024, 2100, 2400, 9999, 10000, 275760]) {
    for (let m = 0; m < 12; m++) {
      const start = new Date(Date.UTC(2000, m, 1)).setUTCFullYear(y);
      timeValues.push(start, start - 1);
    }
  }
  const fields = timeValues.map((value) => {
    const d = new Date(value);
    const valid = !Number.isNaN(d.getTime());
    return [
      enc(value),
      enc(d.getTime()),
      valid ? [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(), d.getUTCDay()] : null,
      valid ? d.toISOString() : null,
    ];
  });
  const setUtcDate = [
    [0, 31], [0, 0], [0, NaN], [NaN, 1], [8.64e15, 13], [8.64e15, 14], [1709632800123, 31], [1709632800123, 1.9], [-1, 28], [0, -0.5], [0, Infinity], [0, 1e300], [0, -1e9], [0, 1e8], [0, 100000001], [0.5, 1], [8.64e15 + 1, 1],
  ].concat(Array.from({ length: 300 }, () => [Math.floor((random() - 0.5) * 1.7e16), random() < 0.7 ? Math.floor(random() * 40) - 4 : numbers()]));

  await Bun.write(
    path.join(import.meta.dir, "dates.json"),
    JSON.stringify({
      utc: utcArgs.map((args) => [args.map(enc), enc(Date.UTC(...(args as [number])))]),
      fields,
      setUtcDate: setUtcDate.map(([value, day]) => {
        const d = new Date(value!);
        return [enc(value!), enc(day!), enc(d.setUTCDate(day!))];
      }),
    }) + "\n",
  );
  console.log(`dates.json: ${utcArgs.length} Date.UTC calls, ${fields.length} time values, ${setUtcDate.length} setUTCDate calls`);
};

if (process.argv.includes("--parse")) await parseWorker();
else {
  await writeParseFixture();
  if (!extraArgs()) await writeDateFixture();
}
