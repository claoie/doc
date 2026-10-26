import type { Node } from "common/editor/model";
import { docToHtml, escapeHtml } from "common/editor/html";
import { docToMarkdown } from "common/editor/markdown";
import { pagePath, pageSlugIdFromHref } from "common/text";
import { config } from "server/config";
import { sql } from "server/db";
import { parseFileUrl, rewriteLinks } from "./content";
import { contentDisposition } from "./files";
import { safeFileName, storage } from "./storage";
import { zipStream, type ZipInput } from "./zip";
import { baseText } from "./bases";

export type ExportFormat = "markdown" | "html";

interface ExportPage {
  id: string;
  slug_id: string;
  parent_id: string | null;
  title: string | null;
  is_base: boolean;
  /** Directory segments inside the archive. */
  dir: string[];
  /** Base name (no extension), unique within its directory. */
  base: string;
}

const CONTENT_BATCH = 50;

const exportName = (title: string | null) =>
  safeFileName((title || "Untitled").replace(/[<>:"|?*]/g, "_").replace(/[.\s]+$/, ""))
    .slice(0, 100)
    .trim() || "Untitled";

const extension = (format: ExportFormat) => (format === "markdown" ? "md" : "html");

const encodePath = (parts: string[]) => parts.map(encodeURIComponent).join("/");

/** Assigns directory paths so each page with children gets a folder of the same name. */
const layout = (rows: Omit<ExportPage, "dir" | "base">[], rootIds: Set<string>): ExportPage[] => {
  const children = new Map<string | null, typeof rows>();
  for (const row of rows) {
    const key = rootIds.has(row.id) ? null : row.parent_id;
    children.set(key, [...(children.get(key) ?? []), row]);
  }
  const out: ExportPage[] = [];
  const visit = (parentKey: string | null, dir: string[]) => {
    const used = new Set<string>();
    for (const row of children.get(parentKey) ?? []) {
      const name = exportName(row.title);
      let base = name;
      for (let n = 1; used.has(base.toLowerCase()) || base.toLowerCase() === "files"; n++) base = `${name} (${n})`;
      used.add(base.toLowerCase());
      out.push({ ...row, dir, base });
      if (children.has(row.id)) visit(row.id, [...dir, base]);
    }
  };
  visit(null, []);
  return out;
};

const htmlDocument = (title: string, body: string) =>
  `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;line-height:1.6}img,video{max-width:100%}pre{background:#f6f8fa;padding:1rem;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`;

const markdownCell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** A base's rows as a Markdown or HTML table. */
const baseTable = (format: ExportFormat, table: { headers: string[]; rows: string[][] }) => {
  if (format === "html") {
    const head = table.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
    const body = table.rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("\n");
    return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
  }
  const line = (cells: string[]) => `| ${cells.map(markdownCell).join(" | ")} |`;
  return [line(table.headers), line(table.headers.map(() => "---")), ...table.rows.map(line)].join("\n") + "\n";
};

interface Renderer {
  render(page: { title: string | null; content: Node | null; dir: string[]; table?: { headers: string[]; rows: string[][] } }): string;
  referencedFiles: Set<string>;
}

interface RenderContext {
  format: ExportFormat;
  /** slugId → archive path segments of exported pages. */
  exported: Map<string, string[]>;
  /** slugId → absolute app URL of pages outside the export. */
  external: Map<string, string>;
  /** Files written into the archive: id → archive path segments. */
  files: Map<string, string[]>;
}

const createRenderer = (ctx: RenderContext): Renderer => {
  const referencedFiles = new Set<string>();
  const render: Renderer["render"] = ({ title, content, dir, table }) => {
    if (table) {
      const name = title || "Untitled base";
      return ctx.format === "html" ? htmlDocument(name, baseTable("html", table)) : `# ${name}\n\n${baseTable("markdown", table)}`;
    }
    const up = (path: string[]) => "../".repeat(dir.length) + encodePath(path);
    const fileUrl = (src: string) => {
      const parsed = parseFileUrl(src);
      if (!parsed) return src;
      const path = ctx.files.get(parsed.fileId);
      if (path) {
        referencedFiles.add(parsed.fileId);
        return up(path);
      }
      return `${config.appUrl}${src}`;
    };
    const pageHref = (slugId: string, anchorId?: string | null) => {
      const anchor = anchorId ? `#${encodeURIComponent(anchorId)}` : "";
      const path = ctx.exported.get(slugId);
      if (path) return up(path) + anchor;
      return (ctx.external.get(slugId) ?? `${config.appUrl}/`) + anchor;
    };
    let doc = content ?? { type: "doc", content: [] };
    doc = rewriteLinks(doc, (href) => {
      if (parseFileUrl(href)) return fileUrl(href);
      const slugId = pageSlugIdFromHref(href);
      if (!slugId) return null;
      const anchor = href.includes("#") ? href.slice(href.indexOf("#") + 1) : null;
      return pageHref(slugId, anchor ? decodeURIComponent(anchor) : null);
    });
    const name = title || "Untitled";
    if (ctx.format === "html") return htmlDocument(name, docToHtml(doc, { fileUrl, pageHref }));
    return `# ${name}\n\n${docToMarkdown(doc, { fileUrl, pageHref })}`;
  };
  return { render, referencedFiles };
};

/** slugIds referenced by mentions or internal links in the given documents. */
const referencedSlugIds = (docs: (Node | null)[]) => {
  const ids = new Set<string>();
  const visit = (node: Node) => {
    if (node.type === "mention" && node.attrs?.entityType === "page" && typeof node.attrs.slugId === "string") {
      ids.add(node.attrs.slugId);
    }
    for (const mark of node.marks ?? []) {
      if (mark.type === "link") {
        const slugId = pageSlugIdFromHref(mark.attrs?.href);
        if (slugId) ids.add(slugId);
      }
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const doc of docs) if (doc) visit(doc);
  return ids;
};

const externalUrls = async (slugIds: string[], readableBy: string): Promise<Map<string, string>> => {
  if (slugIds.length === 0) return new Map();
  const rows: { slug_id: string; title: string | null; space_slug: string }[] = await sql`
    SELECT p.slug_id, p.title, s.slug AS space_slug FROM pages p JOIN spaces s ON s.id = p.space_id
    WHERE p.slug_id = ANY(${sql.array(slugIds, "text")}) AND p.deleted_at IS NULL
      AND p.space_id IN (
        SELECT sm.space_id FROM space_members sm
        WHERE sm.user_id = ${readableBy}
          OR sm.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = ${readableBy})
      )`;
  return new Map(rows.map((r) => [r.slug_id, config.appUrl + pagePath(r.space_slug, r.title, r.slug_id)]));
};

export interface ExportRequest {
  userId: string;
  format: ExportFormat;
  includeFiles: boolean;
  /** Export this page (and its subtree when `children`), or the whole space when null. */
  pageId: string | null;
  spaceId: string;
  children: boolean;
  archiveName: string;
}

/** Builds the export response: a single document, or a streamed zip archive. */
export const exportPages = async (request: ExportRequest): Promise<Response> => {
  const { format } = request;
  const ext = extension(format);
  const rows: Omit<ExportPage, "dir" | "base">[] = request.pageId
    ? request.children
      ? await sql`
          WITH RECURSIVE subtree AS (
            SELECT id, 0 AS depth FROM pages WHERE id = ${request.pageId}
            UNION ALL
            SELECT p.id, s.depth + 1 FROM pages p JOIN subtree s ON p.parent_id = s.id
            WHERE p.deleted_at IS NULL AND s.depth < 1000
          )
          SELECT p.id, p.slug_id, p.parent_id, p.title, p.is_base FROM subtree s JOIN pages p ON p.id = s.id
          ORDER BY s.depth, p.position, p.id`
      : await sql`SELECT id, slug_id, parent_id, title, is_base FROM pages WHERE id = ${request.pageId}`
    : await sql`
        SELECT id, slug_id, parent_id, title, is_base FROM pages
        WHERE space_id = ${request.spaceId} AND deleted_at IS NULL ORDER BY position, id`;
  const rootIds = new Set(request.pageId ? [request.pageId] : rows.filter((r) => !r.parent_id).map((r) => r.id));
  const pages = layout(rows, rootIds);
  const pageIds = pages.map((p) => p.id);

  const files: { id: string; name: string; size: string; storage_key: string }[] = request.includeFiles
    ? await sql`SELECT id, name, size, storage_key FROM files WHERE page_id = ANY(${sql.array(pageIds, "uuid")})`
    : [];
  const ctx: RenderContext = {
    format,
    exported: new Map(pages.map((p) => [p.slug_id, [...p.dir, `${p.base}.${ext}`]])),
    external: new Map(),
    files: new Map(files.map((f) => [f.id, ["files", f.id, safeFileName(f.name)]])),
  };

  const loadContents = async (ids: string[]) => {
    const contentRows: { id: string; content: Node | null }[] = await sql`
      SELECT id, content FROM pages WHERE id = ANY(${sql.array(ids, "uuid")})`;
    const byId = new Map(contentRows.map((r) => [r.id, r.content]));
    const missing = [...referencedSlugIds([...byId.values()])].filter((s) => !ctx.exported.has(s) && !ctx.external.has(s));
    for (const [slugId, url] of await externalUrls(missing, request.userId)) ctx.external.set(slugId, url);
    return byId;
  };

  const renderer = createRenderer(ctx);
  if (request.pageId && pages.length === 1 && !request.includeFiles) {
    const page = pages[0]!;
    const contents = await loadContents([page.id]);
    const table = page.is_base ? await baseText(page.id, request.userId) : undefined;
    const body = renderer.render({ title: page.title, content: contents.get(page.id) ?? null, dir: [], table });
    return new Response(body, {
      headers: {
        "Content-Type": format === "markdown" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8",
        "Content-Disposition": contentDisposition("attachment", `${page.base}.${ext}`),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "no-store",
      },
    });
  }

  async function* entries(): AsyncGenerator<ZipInput> {
    for (let i = 0; i < pages.length; i += CONTENT_BATCH) {
      const batch = pages.slice(i, i + CONTENT_BATCH);
      const contents = await loadContents(batch.map((p) => p.id));
      for (const page of batch) {
        const content = contents.get(page.id) ?? null;
        yield {
          name: [...page.dir, `${page.base}.${ext}`].join("/"),
          data: renderer.render({ title: page.title, content, dir: page.dir, table: page.is_base ? await baseText(page.id, request.userId) : undefined }),
        };
      }
    }
    for (const file of files) {
      if (!renderer.referencedFiles.has(file.id)) continue;
      const object = await storage.get(file.storage_key);
      if (!object) continue;
      yield {
        name: ctx.files.get(file.id)!.join("/"),
        size: object.size,
        open: () => new Response(object.body()).body!,
      };
    }
  }

  return new Response(zipStream(entries()), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition("attachment", `${exportName(request.archiveName)}.zip`),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
};
