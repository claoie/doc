// Writes text.json and unicode.json: what the string functions of
// common/text.ts make of many titles and hrefs, and digests of what the ports
// make of every Unicode code point, for tests/text.rs to hold the Rust port
// (and the Unicode tables of its crates) to.
//
//   bun src/server-rs/tests/fixtures/gen-text.ts
import { nodeToHtml, safeColor } from "common/editor/html";
import { docToMarkdown } from "common/editor/markdown";
import type { Node } from "common/editor/model";
import { pagePath, pageSlugIdFromHref, titleSlug } from "common/text";
import { attempt, digest, mulberry32, writeFixture } from "./lib";

const random = mulberry32(0x7e47);
const int = (below: number) => Math.floor(random() * below);
const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;

// ---------------------------------------------------------------------------
// Titles

/**
 * `titleSlug` cuts at 60 UTF-16 units and may leave half a surrogate pair,
 * which neither JSON nor a Rust string can hold: the fixture then has the slug
 * without that half and `split: true`. `path` is null where `pagePath` throws
 * (it does exactly for those titles).
 */
const slugCase = (title: string | null | undefined) => {
  let slug = titleSlug(title);
  const split = !slug.isWellFormed();
  if (split) slug = slug.slice(0, -1);
  const path = attempt(() => pagePath("my space/ü", title, "AbC123"));
  return { ...(title === undefined ? {} : { title }), slug, split, path: typeof path === "string" ? path : null };
};

const a59 = "a".repeat(59);
const titles: (string | null | undefined)[] = [
  undefined, null, "", " ", "untitled", "Hello, World!", "  Crème brûlée  ", "한글 제목", "日本語のタイトル", "Ünïcödé Tïtlé", "éàñ", "ﬁne ﬂow ½ x² Ⅻ ①", "１２３ ＡＢＣ",
  "ΑΣ ΣΑΣ Σ ΌΣΟΣ.", "İstanbul I ı", "Straße ẞ", "ǅ ǈ ǋ", "عنوان ١٢٣", "עִבְרִית", "हिन्दी शीर्षक", "ไทย ภาษา", "emoji 😀 only 👨‍👩‍👧", "😀", "!!!", "---", "-a-", "a_b-c.d/e", "C++ & C#", "snake_case_title",
  "tab\tand\nnewline", " nbsp﻿", "𝒜𝓑 math letters", "𐌰𐌱 gothic", "𠀀𠀁 cjk b", "a⃐b᪰c", "x​y‍z", "Ω ohm K kelvin Å", "ǆ Ǆ", "ŉ ǰ ΐ", "ß".repeat(70), "ab ".repeat(40),
  "a".repeat(60), "a".repeat(61), `${a59}-b`, `${"a".repeat(58)} - b`, `${a59}\u{20000}b`, `${"a".repeat(58)}\u{20000}b`, `${a59}😀`, `${a59}𝒜`, `${"한".repeat(59)}\u{10330}`, `${"-".repeat(70)}x`,
  `${"é".repeat(59)}\u{2f800}`, "ﷺ".repeat(5), "㍿".repeat(30), "가".repeat(61), "Ạ̇", "ẛ̣", "0", "００", "Ⅷ", "x".repeat(200),
];

const ALPHABET = [
  ..."abcXYZ019 -_.,!?/()[]", "é", "Ü", "ß", "İ", "Σ", "σ", "ς", "ǅ", "ﬁ", "²", "½", "Ⅻ", "한", "글", "日", "本", "あ", "ア", "ｱ", "١", "ع", "א", "ִ", "ह", "ि", "ก", "ั", "😀", "👨‍👩‍👧", "🇰🇷", "𝒜", "𐌰", "𠀀",
  "́", "̀", "̧", "⃐", "‍", " ", "﻿", "\t", "\n", "–", "—", "…", "©", "™", "µ", "ª", "Ω", "K", "Å",
];
const randomTitle = () => Array.from({ length: int(int(4) === 0 ? 90 : 30) }, () => pick(ALPHABET)).join("");

// ---------------------------------------------------------------------------
// Hrefs

/** A value that may be absent: `{ v }`, or `{}` for undefined. */
const hrefCase = (href: unknown) => ({ ...(href === undefined ? {} : { v: href }), slugId: pageSlugIdFromHref(href) });

const hrefs: unknown[] = [
  // common/text.test.ts
  "/s/space/p/a-b-c-SLUG1", "/s/space/p/SLUG2", "/p/SLUG3?x=1", "/s/space/p/%ED%95%9C-SLUG4", "/settings", "/s/space/p/title-sl/ug", undefined,
  null, 5, true, {}, [], ["/p/abc"], "", " ", "/p/abc", " /p/abc ", "\n/p/abc\t", " /p/abc﻿", "\u0085/p/abc", "/p/abc\n", "/p/abc/", "/p/abc//", "/p/abc/x", "/p/", "/p", "p/abc", "//p/abc",
  "/p/abc?", "/p/abc#", "/p/abc?q=1#f", "/p/abc/?q", "/p/abc/#f", "/p/abc?x\ny", "/p/abc#x\ry", "/p/abc?x y", "/p/abc#x y", "/p/abc?x\u0085y", "/p/a\nb-c", "/p/a b-c", "/p/a-b c",
  "http://host/p/abc", "https://host/p/abc", "https://host:8080/s/sp/p/t-abc", "HTTPS://host/p/abc", "ftp://host/p/abc", "https:///p/abc", "https://host", "https://host/", "https://ho st/p/abc",
  "https://user@host/p/abc", "https://host?/p/abc", "http://a/s/b/p/c-d/", "/s//p/abc", "/s/a/b/p/abc", "/s/a/p/", "/s/a/p", "/S/a/P/abc", "/s/a/p/abc/p/def", "/x/s/a/p/abc",
  "/p/-", "/p/a-", "/p/-a", "/p/a--b", "/p/abc_def", "/p/abc.def", "/p/ABCxyz019", `/p/${"x".repeat(32)}`, `/p/${"x".repeat(33)}`, `/p/t-${"9".repeat(32)}`, `/p/t-${"9".repeat(33)}`,
  "/p/%61%62%63", "/p/a%2Db", "/p/a%2Fb", "/p/a%2fb-c", "/p/%zz", "/p/%", "/p/%4", "/p/abc%", "/p/%E0%A4%A", "/p/%C3%28", "/p/%ED%A0%80", "/p/%F4%90%80%80", "/p/%C0%80-abc", "/p/%EF%BF%BE-abc",
  "/p/%00-abc", "/p/t-%41bc", "/p/ünï-abc", "/p/ünï", "/p/한-글", "/p/😀-ok", "/p/a-ｂ", "/p/a-١", "/s/%2F/p/x-abc", "/s/a?b/p/abc", "/s/a#b/p/abc", "/p/abc?/p/def", "/p/abc#/s/x/p/y-z",
];

const PREFIXES = ["", "", "", "http://host", "https://h.example:8080", "https://", "ftp://host", "HTTP://host", "//host", " https://h.example", "https://a/b"];
const PATHS = ["/s/space/p/", "/s/space/p/", "/p/", "/p/", "/s//p/", "/s/a/b/p/", "/S/space/P/", "/s/space/p", "/x/", "", "/s/sp ace/p/", "/s/%20/p/"];
const SEGMENTS = [
  "title-AbC123", "AbC123", "a-b-c-", "-", "abc_def", "%ED%95%9C-SLUG4", "%zz-abc", "%E0%A4%A", "a%2Db", "a%2Fb", "x".repeat(32), "x".repeat(33), "ünï-abc", "a b", "a\nb-c", "😀-ok", "", "t-0",
  "%41", "a%", "A-b-C-d9",
];
const SUFFIXES = ["", "", "", "/", "//", "?q=1", "#frag", "/?q#f", "?a\nb", "# ", "/extra", " ", "\n", "?", "#", "/#", "?\r"];
const randomHref = () => pick(PREFIXES) + pick(PATHS) + pick(SEGMENTS) + pick(SUFFIXES);

// ---------------------------------------------------------------------------
// Every code point, in blocks of 4096, as digests.

const BLOCK = 0x1000;
const isSurrogate = (codePoint: number) => codePoint >= 0xd800 && codePoint <= 0xdfff;
const blocks = (end: number, line: (ch: string) => string, skip: readonly (readonly [number, number])[] = []) => {
  const out: string[] = [];
  for (let start = 0; start < end; start += BLOCK) {
    const lines: string[] = [];
    for (let codePoint = start; codePoint < start + BLOCK; codePoint++) {
      if (isSurrogate(codePoint) || skip.some(([from, to]) => codePoint >= from && codePoint <= to)) continue;
      lines.push(line(String.fromCodePoint(codePoint)));
    }
    out.push(digest(lines.join("\n")));
  }
  return out;
};

/** A slug with what a Rust string can hold of it: see `slugCase`. */
const wellFormedSlug = (title: string) => {
  const slug = titleSlug(title);
  return slug.isWellFormed() ? slug : slug.slice(0, -1);
};

/**
 * Code points whose slug depends on the Unicode version of whoever computes
 * it. Bun 1.4.4 has Unicode 17.0; the Rust port reads \p{L}\p{N} from the
 * regex crate (16.0 as of regex-syntax 0.8.12) and decomposes with
 * unicode-normalization (0.1.26 decomposes code points 17.0 does not assign).
 * `settledSlugs` leaves these out; `slugs` does not.
 */
const UNSETTLED: readonly (readonly [number, number])[] = [
  // Letters since Unicode 17.0: Bun keeps them, the regex crate sees a separator.
  [0x088f, 0x088f], [0x0c5c, 0x0c5c], [0x0cdc, 0x0cdc], [0xa7ce, 0xa7cf], [0x10940, 0x10959], [0x10ec5, 0x10ec7], [0x11db0, 0x11ddb], [0x11de0, 0x11de9],
  [0x16ea0, 0x16eb8], [0x16ebb, 0x16ed3], [0x16ff2, 0x16ff6], [0x187f8, 0x187ff], [0x18d09, 0x18d1e], [0x18d80, 0x18df2], [0x1e6c0, 0x1e6de], [0x1e6e0, 0x1e6e2],
  [0x1e6e4, 0x1e6e5], [0x1e6e7, 0x1e6ed], [0x1e6f0, 0x1e6f4], [0x1e6fe, 0x1e6ff], [0x2b73a, 0x2b73f], [0x2cea2, 0x2cead], [0x323b0, 0x33479],
  // Unassigned for Bun, decomposed to letters by unicode-normalization.
  [0x0558, 0x0558], [0x058b, 0x058c], [0x209d, 0x209f], [0x107bb, 0x107bf], [0x1b123, 0x1b126], [0x1d6a6, 0x1d6a6], [0x1df95, 0x1df95], [0x1dfd0, 0x1dfd6],
  [0x1dfd9, 0x1dfda], [0x1dfdc, 0x1dfdf], [0x1dfe1, 0x1dfe3], [0x1dfe5, 0x1dfff],
];

const text = (value: string, ...marks: unknown[]) => ({ type: "text", text: value, ...(marks.length ? { marks } : {}) });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });

const unicode = {
  // Lower-casing, NFKD, NFC and \p{L}\p{N}. The second and third words put the
  // character after a capital sigma, whose lower-case form depends on whether
  // what follows is cased or case-ignorable.
  slugs: blocks(0x110000, (ch) => wellFormedSlug(`a${ch}b aΣ${ch} aΣ${ch}b`)),
  settledSlugs: blocks(0x110000, (ch) => wellFormedSlug(`a${ch}b aΣ${ch} aΣ${ch}b`), UNSETTLED),
  unsettled: UNSETTLED.map(([from, to]) => [from, to]),
  // Lower-casing on its own, through an attribute the HTML serializer lower-cases.
  lower: blocks(0x110000, (ch) => nodeToHtml({ type: "tableCell", attrs: { backgroundColorName: ch } })),
  // \s in every place the ports spell it out by hand. JavaScript's \s has no
  // character outside the Basic Multilingual Plane.
  spaces: blocks(0x10000, (ch) => {
    const doc = {
      type: "doc",
      content: [
        paragraph(text(`#${ch}x`)),
        paragraph(text("y"), text(`${ch}x${ch}`, { type: "bold" }), text("z")),
        paragraph(text("l", { type: "link", attrs: { href: `a${ch}b` } })),
        paragraph(text(`$${ch}y`)),
        paragraph(text(`${ch}> q${ch}`)),
      ],
    };
    return [
      docToMarkdown(doc as Node),
      String(safeColor(`rgb(1${ch}2)`)),
      String(safeColor(`${ch}red${ch}`)),
      String(pageSlugIdFromHref(`${ch}/p/abc${ch}`)),
      String(pageSlugIdFromHref(`/p/abc?${ch}`)),
    ].join("\u0000");
  }),
};

await writeFixture("text.json", {
  slugs: [...titles, ...Array.from({ length: 1500 }, randomTitle)].map(slugCase),
  hrefs: [...hrefs, ...Array.from({ length: 1500 }, randomHref)].map(hrefCase),
});
await writeFixture("unicode.json", unicode);
