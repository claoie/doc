import type { Node } from "common/editor/model";
import { isUuid, slugId } from "common/ids";
import { docLinks, docText } from "common/text";
import { sql } from "server/db";
import { rewriteFileRefs, stripCommentMarks, syncedBlocksOf } from "./content";
import { HttpError } from "./http";
import { siblingPosition, type PageRow } from "./pages";
import { fileStorageKey, storage } from "./storage";

const MAX_PAGES = 2000;

interface SourcePage {
  id: string;
  parent_id: string | null;
  position: string;
  title: string | null;
  icon: string | null;
  cover: string | null;
  content: Node | null;
  is_base: boolean;
}

/** Points inline base embeds at the copies of their pages. */
const remapBaseEmbeds = (node: Node, pageIds: Map<string, string>): Node => {
  const pageId = node.type === "base" ? node.attrs?.pageId : undefined;
  const attrs = typeof pageId === "string" && pageIds.has(pageId) ? { ...node.attrs, pageId: pageIds.get(pageId) } : node.attrs;
  return { ...node, ...(attrs ? { attrs } : {}), ...(node.content ? { content: node.content.map((c) => remapBaseEmbeds(c, pageIds)) } : {}) };
};

/**
 * Copies a page and its non-deleted descendants into `targetSpaceId` with
 * new ids, a `Copy of ` root title, comment marks removed and uploaded files
 * duplicated. Returns the new root page id.
 */
export const duplicatePage = async (source: PageRow, targetSpaceId: string, userId: string): Promise<string> => {
  const pages: SourcePage[] = await sql`
    WITH RECURSIVE subtree AS (
      SELECT id, 0 AS depth FROM pages WHERE id = ${source.id}
      UNION ALL
      SELECT p.id, s.depth + 1 FROM pages p JOIN subtree s ON p.parent_id = s.id
      WHERE p.deleted_at IS NULL AND s.depth < 1000
    )
    SELECT p.id, p.parent_id, p.position, p.title, p.icon, p.cover, p.content, p.is_base
    FROM subtree s JOIN pages p ON p.id = s.id ORDER BY s.depth, p.position LIMIT ${MAX_PAGES + 1}`;
  if (pages.length > MAX_PAGES) throw new HttpError(413, "too_large", `Cannot duplicate more than ${MAX_PAGES} pages at once`);

  const pageIds = new Map<string, string>(pages.map((p) => [p.id, crypto.randomUUID()]));
  const files: { id: string; page_id: string; name: string; mime: string; size: string; storage_key: string }[] = await sql`
    SELECT id, page_id, name, mime, size, storage_key FROM files
    WHERE purpose = 'page' AND page_id = ANY(${sql.array([...pageIds.keys()], "uuid")})`;
  const fileIds = new Map<string, string>(files.map((f) => [f.id, crypto.randomUUID()]));

  const copied: string[] = [];
  try {
    const fileRows: { id: string; page_id: string; name: string; mime: string; size: number; storage_key: string }[] = [];
    for (const file of files) {
      const id = fileIds.get(file.id)!;
      const key = fileStorageKey(id, file.name);
      await storage.copy(file.storage_key, key);
      copied.push(key);
      fileRows.push({
        id,
        page_id: pageIds.get(file.page_id)!,
        name: file.name,
        mime: file.mime,
        size: Number(file.size),
        storage_key: key,
      });
    }

    const rewrite = (content: Node | null) =>
      content &&
      rewriteFileRefs(
        stripCommentMarks(content),
        (parsed) => {
          const id = fileIds.get(parsed.fileId);
          return id ? `/api/files/${id}${parsed.rest}${parsed.suffix}` : null;
        },
        fileIds,
      );

    const rows = pages.map((page, index) => {
      const rewritten = rewrite(page.content);
      const content = rewritten && remapBaseEmbeds(rewritten, pageIds);
      const links = content ? docLinks(content) : { pageIds: [], slugIds: [] };
      return {
        id: pageIds.get(page.id)!,
        slug_id: slugId(),
        parent_id: index === 0 ? null : pageIds.get(page.parent_id!)!,
        position: page.position,
        title: index === 0 ? `Copy of ${page.title ?? "Untitled"}`.slice(0, 500) : page.title,
        icon: page.icon,
        cover: page.cover,
        content,
        text_content: docText(content),
        link_page_ids: links.pageIds.filter(isUuid),
        link_slug_ids: links.slugIds,
        synced: content ? syncedBlocksOf(content) : [],
        is_base: page.is_base,
      };
    });

    const sameSpace = targetSpaceId === source.space_id;
    return await sql.begin(async (tx) => {
      const root = rows[0]!;
      root.parent_id = sameSpace ? source.parent_id : null;
      root.position = await siblingPosition(tx, targetSpaceId, root.parent_id, sameSpace ? source.id : undefined);
      await tx`
        INSERT INTO pages (id, slug_id, space_id, parent_id, position, title, icon, cover, content, text_content,
          creator_id, last_editor_id, contributor_ids, is_base)
        SELECT r.id, r.slug_id, ${targetSpaceId}, r.parent_id, r.position, r.title, r.icon, r.cover, r.content,
          r.text_content, ${userId}, ${userId}, ARRAY[${userId}]::uuid[], r.is_base
        FROM jsonb_to_recordset(${rows.map(({ synced: _, link_page_ids: __, link_slug_ids: ___, ...r }) => r)}::jsonb)
          AS r(id uuid, slug_id text, parent_id uuid, position text, title text, icon text, cover text, content jsonb, text_content text,
            is_base boolean)`;
      const bases = pages.filter((p) => p.is_base).map((p) => ({ old: p.id, new: pageIds.get(p.id)! }));
      if (bases.length) {
        const map = sql`jsonb_to_recordset(${bases}::jsonb) AS m(old uuid, new uuid)`;
        await tx`
          INSERT INTO base_properties (page_id, id, name, type, options, is_primary, position)
          SELECT m.new, bp.id, bp.name, bp.type, bp.options, bp.is_primary, bp.position
          FROM ${map} JOIN base_properties bp ON bp.page_id = m.old`;
        await tx`
          INSERT INTO base_rows (page_id, cells, position, creator_id, last_editor_id, created_at, updated_at)
          SELECT m.new, br.cells, br.position, br.creator_id, ${userId}, br.created_at, now()
          FROM ${map} JOIN base_rows br ON br.page_id = m.old`;
        await tx`
          INSERT INTO base_views (page_id, name, type, config, position, creator_id)
          SELECT m.new, bv.name, bv.type, bv.config, bv.position, ${userId}
          FROM ${map} JOIN base_views bv ON bv.page_id = m.old`;
        if (fileIds.size) {
          // File cells point at the copied files (ids and URLs).
          const pattern = new RegExp([...fileIds.keys()].join("|"), "g");
          const rows: { id: string; cells: Record<string, unknown> }[] = await tx`
            SELECT id, cells FROM base_rows
            WHERE page_id = ANY(${sql.array(bases.map((b) => b.new), "uuid")}) AND cells::text ~ ${pattern.source}`;
          const updates = rows.map((r) => ({ id: r.id, cells: JSON.parse(JSON.stringify(r.cells).replace(pattern, (id) => fileIds.get(id)!)) }));
          if (updates.length) {
            await tx`
              UPDATE base_rows br SET cells = u.cells
              FROM jsonb_to_recordset(${updates}::jsonb) AS u(id uuid, cells jsonb)
              WHERE br.id = u.id`;
          }
        }
      }
      if (fileRows.length) {
        await tx`
          INSERT INTO files (id, purpose, page_id, space_id, uploader_id, name, mime, size, storage_key)
          SELECT r.id, 'page', r.page_id, ${targetSpaceId}, ${userId}, r.name, r.mime, r.size, r.storage_key
          FROM jsonb_to_recordset(${fileRows}::jsonb)
            AS r(id uuid, page_id uuid, name text, mime text, size bigint, storage_key text)`;
      }
      const linkRows = rows.filter((r) => r.link_page_ids.length || r.link_slug_ids.length);
      if (linkRows.length) {
        await tx`
          INSERT INTO page_links (source_id, target_id)
          SELECT r.id, p.id
          FROM jsonb_to_recordset(${linkRows.map((r) => ({ id: r.id, page_ids: r.link_page_ids, slug_ids: r.link_slug_ids }))}::jsonb)
            AS r(id uuid, page_ids text[], slug_ids text[])
          JOIN pages p ON (p.id::text = ANY(r.page_ids) OR p.slug_id = ANY(r.slug_ids)) AND p.id <> r.id
          ON CONFLICT DO NOTHING`;
      }
      const syncedRows = rows.flatMap((r) => r.synced.map((b) => ({ page_id: r.id, block_id: b.blockId, content: b.content })));
      if (syncedRows.length) {
        await tx`
          INSERT INTO synced_blocks (page_id, block_id, content)
          SELECT r.page_id, r.block_id, r.content
          FROM jsonb_to_recordset(${syncedRows}::jsonb) AS r(page_id uuid, block_id text, content jsonb)
          ON CONFLICT DO NOTHING`;
      }
      await tx`
        INSERT INTO watchers (user_id, page_id)
        SELECT ${userId}, unnest(${sql.array(rows.map((r) => r.id), "uuid")}::uuid[])
        ON CONFLICT (user_id, page_id) WHERE page_id IS NOT NULL DO NOTHING`;
      return root.id;
    });
  } catch (error) {
    await storage.removeMany(copied);
    throw error;
  }
};
