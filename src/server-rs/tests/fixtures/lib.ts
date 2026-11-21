// Shared by the fixture generators of the serializer and text ports
// (gen-export.ts, gen-text.ts, gen-unicode.ts).
import { createHash } from "node:crypto";
import path from "node:path";
import { docToHtml, type HtmlOptions } from "common/editor/html";
import { docToMarkdown } from "common/editor/markdown";
import type { Node } from "common/editor/model";
import { docLinks, docMentionedUserIds, docText } from "common/text";

/** A document tree that need not be well typed: odd shapes are the point. */
export type Tree = Record<string, unknown>;

/**
 * Callbacks that show exactly what the serializers passed them; tests/export.rs
 * has the same two. The file URL gains a space and parentheses, which the
 * Markdown serializer must then encode, and the page href characters that
 * HTML must escape. null and undefined anchors read the same: the Rust
 * callback gets `None` for both.
 */
export const probe: HtmlOptions = {
  fileUrl: (src) => `FILE (${src})`,
  pageHref: (slugId, anchorId) => `PAGE<${slugId}|${anchorId == null ? "none" : JSON.stringify(anchorId)}>`,
};

export const EXPORTED_FILE = "0b8e6f2c-1d3a-4c5b-9e7f-112233445566";

/**
 * The callbacks of server/lib/export.ts for a page `depth` folders down an
 * archive that holds one file and one other page; tests/export.rs has the
 * same two.
 */
export const exportLike = (depth: number): HtmlOptions => {
  const up = (parts: string[]) => "../".repeat(depth) + parts.map(encodeURIComponent).join("/");
  return {
    fileUrl: (src) => (src.startsWith(`/api/files/${EXPORTED_FILE}`) ? up(["files", EXPORTED_FILE, "diagram one.png"]) : `https://doc.example.com${src}`),
    pageHref: (slugId, anchorId) => {
      const anchor = anchorId ? `#${encodeURIComponent(anchorId)}` : "";
      return (slugId === "Setup1" ? up(["Guide", "Setup.html"]) : "https://doc.example.com/") + anchor;
    },
  };
};

/** The result, or the name of the error where the function throws. */
export const attempt = <T>(run: () => T): T | { throws: string } => {
  try {
    return run();
  } catch (error) {
    return { throws: (error as Error).name };
  }
};

/** Everything the ports make of one document. */
export const outputs = (tree: unknown) => {
  const doc = tree as Node;
  return {
    html: attempt(() => docToHtml(doc)),
    htmlWith: attempt(() => docToHtml(doc, probe)),
    md: attempt(() => docToMarkdown(doc)),
    mdWith: attempt(() => docToMarkdown(doc, probe)),
    text: attempt(() => docText(doc)),
    links: attempt(() => docLinks(doc)),
    users: attempt(() => docMentionedUserIds(doc)),
  };
};

/**
 * The first 16 hex digits of the SHA-256 of a string's UTF-8 bytes. Fixtures
 * hold it in place of outputs that would otherwise make them tens of megabytes.
 */
export const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

/** A small seeded generator (mulberry32), so every run writes the same fixtures. */
export const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

/** JSON.stringify writes a lone surrogate as an escape, which the Rust JSON parser rejects. */
const assertWellFormed = (value: unknown, where: string) => {
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new Error(`${where} would hold a lone surrogate`);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      assertWellFormed(key, where);
      assertWellFormed(inner, where);
    }
  }
};

/** Writes `{ section: [case, …], … }` with one case per line, next to this file. */
export const writeFixture = async (name: string, sections: Record<string, unknown[]>) => {
  const body = Object.entries(sections)
    .map(([key, cases]) => ` ${JSON.stringify(key)}: [\n${cases.map((entry) => `  ${JSON.stringify(entry)}`).join(",\n")}\n ]`)
    .join(",\n");
  const text = `{\n${body}\n}\n`;
  assertWellFormed(sections, name);
  await Bun.write(path.join(import.meta.dir, name), text);
  console.log(`${name}: ${(text.length / 1024).toFixed(0)} KiB`);
};
