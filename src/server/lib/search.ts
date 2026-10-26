import type { SQL } from "bun";
import type { SpaceRef, TreeItem } from "common/api-types";
import { escapeHtml } from "common/editor/html";
import { sql } from "server/db";
import { toTreeItem, treeColumns } from "./pages";
import { spaceRefJson } from "./spaces";
import { iso } from "./users";

const MAX_WORDS = 8;
const WINDOW = 200;

/** Search words: letters and digits only (so they are inert in tsquery syntax), lower-cased. */
export const searchWords = (query: string): string[] =>
  [
    ...new Set(
      query
        .normalize("NFKC")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .map((w) => [...w].slice(0, 50).join("")),
    ),
  ].slice(0, MAX_WORDS);

/** Prefix query over every word: `w1:* & w2:*`, or null when there are no words. */
export const prefixTsQuery = (words: readonly string[]): string | null =>
  words.length ? words.map((w) => `${w}:*`).join(" & ") : null;

export const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A ~200 character excerpt of `text` around the first match, HTML-escaped,
 * with every occurrence of a search word wrapped in `<mark>`.
 */
export const highlight = (text: string | null | undefined, words: readonly string[], rawQuery = ""): string => {
  const source = (text ?? "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  const terms = [...new Set([rawQuery.trim().toLowerCase(), ...words].filter((t) => t.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (terms.length === 0) return escapeHtml(source.slice(0, WINDOW));
  const alternatives = terms.map(escapeRegExp).join("|");
  // A match at the start of a word is extended to the whole word, mirroring prefix search.
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})[\\p{L}\\p{N}]*|(?:${alternatives})`, "giu");
  const first = pattern.exec(source);
  pattern.lastIndex = 0;
  let start = 0;
  if (first && first.index > WINDOW / 3) {
    start = first.index - Math.floor(WINDOW / 3);
    const space = source.indexOf(" ", start);
    if (space >= 0 && space < first.index) start = space + 1;
  }
  let end = Math.min(source.length, start + WINDOW);
  if (end < source.length) {
    const space = source.lastIndexOf(" ", end);
    if (space > start + WINDOW / 2) end = space;
  }
  const excerpt = source.slice(start, end);
  let html = "";
  let last = 0;
  for (const match of excerpt.matchAll(pattern)) {
    html += escapeHtml(excerpt.slice(last, match.index)) + `<mark>${escapeHtml(match[0])}</mark>`;
    last = match.index + match[0].length;
  }
  html += escapeHtml(excerpt.slice(last));
  return (start > 0 ? "…" : "") + html + (end < source.length ? "…" : "");
};

export interface SearchOptions {
  query: string;
  /** SQL condition restricting which pages (aliased `p`) may match. */
  scope: SQL.Query<unknown>;
  titleOnly?: boolean;
  limit: number;
  offset: number;
}

export interface SearchRow extends TreeItem {
  space: SpaceRef;
  highlight: string;
  updatedAt: string;
}

const MAX_QUERY = 200;

/**
 * Full-text prefix search over titles and text, with a substring fallback so
 * text without word boundaries (e.g. CJK) still matches.
 */
export const searchPages = async (options: SearchOptions): Promise<SearchRow[]> => {
  const raw = [...options.query.trim()].slice(0, MAX_QUERY).join("");
  const words = searchWords(raw);
  if (!raw) return [];
  const tsquery = prefixTsQuery(words);
  const like = `%${escapeLike(raw.toLowerCase())}%`;
  const first = words[0] ?? raw.toLowerCase();
  const vector = options.titleOnly ? sql`to_tsvector('simple', coalesce(p.title, ''))` : sql`p.search`;
  const columns = sql`
    ${treeColumns()}, p.updated_at, ${spaceRefJson("s")} AS space,
    ${options.titleOnly ? sql`p.title` : sql`substring(p.text_content FROM greatest(1, strpos(lower(p.text_content), ${first}) - 100) FOR 400)`} AS snippet`;
  let rows = await sql`
    SELECT ${columns}
    FROM pages p JOIN spaces s ON s.id = p.space_id
    LEFT JOIN LATERAL (SELECT CASE WHEN ${tsquery}::text IS NULL THEN NULL ELSE to_tsquery('simple', ${tsquery}) END AS q) query ON true
    WHERE p.deleted_at IS NULL AND ${options.scope}
      AND ((query.q IS NOT NULL AND ${vector} @@ query.q) OR lower(coalesce(p.title, '')) LIKE ${like})
    ORDER BY lower(coalesce(p.title, '')) = ${raw.toLowerCase()} DESC,
      coalesce(ts_rank(${vector}, query.q), 0) DESC, p.updated_at DESC, p.id
    LIMIT ${options.limit} OFFSET ${options.offset}`;
  if (rows.length === 0 && !options.titleOnly && options.offset === 0) {
    rows = await sql`
      SELECT ${treeColumns()}, p.updated_at, ${spaceRefJson("s")} AS space,
        substring(p.text_content FROM greatest(1, strpos(lower(p.text_content), ${raw.toLowerCase()}) - 100) FOR 400) AS snippet
      FROM pages p JOIN spaces s ON s.id = p.space_id
      WHERE p.deleted_at IS NULL AND ${options.scope} AND p.text_content ILIKE ${like}
      ORDER BY p.updated_at DESC, p.id LIMIT ${Math.min(options.limit, 20)}`;
  }
  return rows.map((row: Parameters<typeof toTreeItem>[0] & { space: SpaceRef; updated_at: Date; snippet: string | null; title: string | null }) => {
    const fromText = highlight(row.snippet, words, raw);
    return {
      ...toTreeItem(row),
      space: row.space,
      highlight: fromText.includes("<mark>") || !row.title ? fromText : highlight(row.title, words, raw) || fromText,
      updatedAt: iso(row.updated_at)!,
    };
  });
};
