import type { SQL } from "bun";
import type { Page, SpaceRole, TreeItem } from "common/api-types";
import type { Node } from "common/editor/model";
import { isSlugId, isUuid } from "common/ids";
import { keyBetween } from "common/positions";
import { docLinks, docMentionedUserIds, docText } from "common/text";
import { sql } from "server/db";
import { syncedBlocksOf } from "./content";
import { conflict, forbidden, notFound } from "./http";
import { log } from "./logger";
import { notify, watchPage } from "./notifications";
import { hasRole, rankToRole, roleRank } from "./permissions";
import { storage } from "./storage";
import { iso, userRefs } from "./users";
import type { AuthUser } from "./auth";

type Db = SQL;

export interface PageRow {
  id: string;
  slug_id: string;
  space_id: string;
  parent_id: string | null;
  position: string;
  title: string | null;
  icon: string | null;
  cover: string | null;
  content?: Node | null;
  doc_version: string | number;
  creator_id: string | null;
  last_editor_id: string | null;
  contributor_ids: string[];
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_by: string | null;
  is_base: boolean;
  has_children: boolean;
}

/** Columns needed for a `TreeItem`, for a pages row aliased `p`. */
export const treeColumns = () =>
  sql.unsafe(
    `p.id, p.slug_id, p.title, p.icon, p.parent_id, p.space_id, p.position, p.is_base,
     EXISTS (SELECT 1 FROM pages c WHERE c.parent_id = p.id AND c.deleted_at IS NULL) AS has_children`,
  );

/** Every page column except `content`, `text_content` and `search`, for a pages row aliased `p`. */
export const pageColumns = () =>
  sql.unsafe(
    `p.id, p.slug_id, p.space_id, p.parent_id, p.position, p.title, p.icon, p.cover, p.doc_version,
     p.creator_id, p.last_editor_id, p.contributor_ids::text[] AS contributor_ids, p.created_at, p.updated_at,
     p.deleted_at, p.deleted_by, p.is_base,
     EXISTS (SELECT 1 FROM pages c WHERE c.parent_id = p.id AND c.deleted_at IS NULL) AS has_children`,
  );

export const toTreeItem = (
  row: Pick<PageRow, "id" | "slug_id" | "title" | "icon" | "parent_id" | "space_id" | "position" | "has_children"> & { is_base?: boolean },
): TreeItem => ({
  id: row.id,
  slugId: row.slug_id,
  title: row.title,
  icon: row.icon,
  parentId: row.parent_id,
  spaceId: row.space_id,
  position: row.position,
  hasChildren: !!row.has_children,
  isBase: !!row.is_base,
});

export const toPage = async (row: PageRow): Promise<Page> => {
  const contributorIds = row.contributor_ids ?? [];
  const ids = [row.creator_id, row.last_editor_id, ...contributorIds].filter((id): id is string => !!id);
  const refs = new Map((await userRefs([...new Set(ids)])).map((ref) => [ref.id, ref]));
  return {
    ...toTreeItem(row),
    cover: row.cover,
    content: row.content ?? null,
    docVersion: Number(row.doc_version),
    creator: (row.creator_id && refs.get(row.creator_id)) || null,
    lastEditor: (row.last_editor_id && refs.get(row.last_editor_id)) || null,
    contributors: contributorIds.flatMap((id) => refs.get(id) ?? []),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    deletedAt: iso(row.deleted_at),
  };
};

export interface PageAccess {
  page: PageRow;
  role: SpaceRole | null;
}

const pageRefCondition = (ref: string) => {
  if (isUuid(ref)) return sql`p.id = ${ref.toLowerCase()}`;
  if (isSlugId(ref)) return sql`p.slug_id = ${ref}`;
  return null;
};

/** Loads a page by id or slugId with the user's role in its space; null when it does not exist. */
export const findPage = async (userId: string, ref: string, withContent = false): Promise<PageAccess | null> => {
  const condition = pageRefCondition(ref);
  if (!condition) return null;
  const [row] = await sql`
    SELECT ${pageColumns()}, ${withContent ? sql`p.content` : sql`NULL AS content`}, ${roleRank("p.space_id", userId)} AS rank
    FROM pages p WHERE ${condition}`;
  if (!row) return null;
  const { rank, ...page } = row;
  return { page: page as PageRow, role: rankToRole(rank) };
};

/**
 * Resolves a page the user may access with at least `min`. Non-members get
 * 404 so page existence is not revealed; trashed pages only allow reads.
 */
export const requirePage = async (
  user: AuthUser,
  ref: string,
  min: SpaceRole,
  options: { withContent?: boolean; allowDeleted?: boolean } = {},
): Promise<PageAccess> => {
  const access = await findPage(user.id, ref, options.withContent);
  if (!access || !access.role) throw notFound("Page");
  if (!hasRole(access.role, min)) throw forbidden();
  if (access.page.deleted_at && min !== "reader" && !options.allowDeleted) throw notFound("Page");
  return access;
};

export const canReadPage = async (userId: string, pageId: string): Promise<boolean> => {
  const access = await findPage(userId, pageId);
  return !!access && hasRole(access.role, "reader");
};

export const canEditPage = async (userId: string, pageId: string): Promise<boolean> => {
  const access = await findPage(userId, pageId);
  return !!access && !access.page.deleted_at && hasRole(access.role, "writer");
};

export const loadPageForCollab = async (
  pageId: string,
): Promise<{ content: Node | null; docVersion: number; spaceId: string; deletedAt: Date | null } | null> => {
  if (!isUuid(pageId)) return null;
  const [row] = await sql`SELECT content, doc_version, space_id, deleted_at FROM pages WHERE id = ${pageId}`;
  if (!row) return null;
  return { content: row.content, docVersion: Number(row.doc_version), spaceId: row.space_id, deletedAt: row.deleted_at };
};

/** Ancestors of a page from the root down, ending with the page itself. */
export const breadcrumbs = async (pageId: string, db: Db = sql): Promise<TreeItem[]> => {
  const rows = await db`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, 0 AS depth FROM pages WHERE id = ${pageId}
      UNION ALL
      SELECT p.id, p.parent_id, chain.depth + 1 FROM pages p JOIN chain ON p.id = chain.parent_id WHERE chain.depth < 1000
    )
    SELECT ${treeColumns()} FROM chain JOIN pages p ON p.id = chain.id ORDER BY chain.depth DESC`;
  return rows.map(toTreeItem);
};

/**
 * Position for a page placed among the non-deleted children of `parentId`:
 * after `afterId`, first when `afterId` is null, last when undefined.
 */
export const siblingPosition = async (
  db: Db,
  spaceId: string,
  parentId: string | null,
  afterId: string | null | undefined,
  excludeId: string | null = null,
): Promise<string> => {
  const siblings = sql`
    p.space_id = ${spaceId} AND p.parent_id IS NOT DISTINCT FROM ${parentId}::uuid
    AND p.deleted_at IS NULL AND p.id IS DISTINCT FROM ${excludeId}::uuid`;
  let low: string | null = null;
  let high: string | null = null;
  if (afterId === undefined) {
    const [row] = await db`SELECT max(p.position) AS position FROM pages p WHERE ${siblings}`;
    low = row?.position ?? null;
  } else if (afterId === null) {
    const [row] = await db`SELECT min(p.position) AS position FROM pages p WHERE ${siblings}`;
    high = row?.position ?? null;
  } else {
    const [after] = await db`SELECT p.position FROM pages p WHERE p.id = ${afterId} AND ${siblings}`;
    if (!after) throw notFound("Sibling page");
    low = after.position;
    const [next] = await db`SELECT min(p.position) AS position FROM pages p WHERE ${siblings} AND p.position > ${low}`;
    high = next?.position ?? null;
  }
  try {
    return keyBetween(low, high);
  } catch {
    throw conflict("position_conflict", "Could not place the page between its neighbours");
  }
};

/** Replaces the page's outgoing links and synced blocks with those found in `content`. */
export const indexPageContent = async (db: Db, pageId: string, content: Node) => {
  const links = docLinks(content);
  await db`DELETE FROM page_links WHERE source_id = ${pageId}`;
  if (links.pageIds.length || links.slugIds.length) {
    await db`
      INSERT INTO page_links (source_id, target_id)
      SELECT ${pageId}, id FROM pages
      WHERE (id = ANY(${sql.array(links.pageIds.filter(isUuid), "uuid")}) OR slug_id = ANY(${sql.array(links.slugIds, "text")}))
        AND id <> ${pageId}
      ON CONFLICT DO NOTHING`;
  }
  const blocks = syncedBlocksOf(content);
  await db`
    DELETE FROM synced_blocks
    WHERE page_id = ${pageId} AND NOT (block_id = ANY(${sql.array(blocks.map((b) => b.blockId), "text")}))`;
  if (blocks.length) {
    const rows = blocks.map((b) => ({ block_id: b.blockId, content: b.content }));
    await db`
      INSERT INTO synced_blocks (page_id, block_id, content)
      SELECT ${pageId}, r.block_id, r.content FROM jsonb_to_recordset(${rows}::jsonb) AS r(block_id text, content jsonb)
      ON CONFLICT (page_id, block_id) DO UPDATE SET content = excluded.content, updated_at = now()
      WHERE synced_blocks.content IS DISTINCT FROM excluded.content`;
  }
};

export interface SaveContentInput {
  content: Node;
  docVersion: number;
  editorId: string | null;
  contributorIds: readonly string[];
}

const UPDATE_NOTIFY_COOLDOWN = "7 hours";

/**
 * Persists collaborative content: text, version, editors, links and synced
 * blocks; snapshots a version when the last one is old enough; notifies newly
 * mentioned users and page/space watchers.
 */
export const savePageContent = async (pageId: string, input: SaveContentInput): Promise<void> => {
  const editors = [...new Set([input.editorId, ...input.contributorIds].filter(isUuid))];
  const result = await sql.begin(async (tx) => {
    const [previous] = await tx`SELECT content, space_id, deleted_at FROM pages WHERE id = ${pageId} FOR UPDATE`;
    if (!previous) return null;
    await tx`
      UPDATE pages SET
        content = ${input.content}::jsonb,
        text_content = ${docText(input.content)},
        doc_version = ${input.docVersion},
        last_editor_id = COALESCE(${isUuid(input.editorId) ? input.editorId : null}::uuid, last_editor_id),
        contributor_ids = ARRAY(SELECT DISTINCT unnest(contributor_ids || ${sql.array(editors, "uuid")}::uuid[])),
        updated_at = now()
      WHERE id = ${pageId}`;
    await indexPageContent(tx, pageId, input.content);
    await tx`
      INSERT INTO page_versions (page_id, title, icon, content, editor_id, contributor_ids)
      SELECT p.id, p.title, p.icon, p.content, p.last_editor_id, p.contributor_ids FROM pages p
      WHERE p.id = ${pageId}
        AND NOT EXISTS (
          SELECT 1 FROM page_versions v WHERE v.page_id = p.id
            AND v.created_at > now() - CASE WHEN p.created_at > now() - interval '5 minutes'
              THEN interval '60 seconds' ELSE interval '5 minutes' END
        )
        AND p.content IS DISTINCT FROM (
          SELECT v.content FROM page_versions v WHERE v.page_id = p.id ORDER BY v.created_at DESC LIMIT 1
        )`;
    return { previousContent: previous.content as Node | null, spaceId: previous.space_id as string, deleted: !!previous.deleted_at };
  });
  if (!result || result.deleted) return;

  await watchPage(pageId, editors);
  const actorId = isUuid(input.editorId) ? input.editorId : (editors[0] ?? null);
  try {
    const before = new Set(docMentionedUserIds(result.previousContent));
    const mentioned = docMentionedUserIds(input.content).filter((id) => isUuid(id) && !before.has(id));
    const notified = new Set(
      await notify({ kind: "page.mention", recipientIds: mentioned, actorId, pageId }),
    );
    const watchers: { user_id: string }[] = await sql`
      SELECT DISTINCT w.user_id FROM watchers w
      WHERE (w.page_id = ${pageId} OR w.space_id = ${result.spaceId})
        AND NOT (w.user_id = ANY(${sql.array(editors, "uuid")}))
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.user_id = w.user_id AND n.page_id = ${pageId} AND n.kind = 'page.updated'
            AND n.created_at > now() - ${UPDATE_NOTIFY_COOLDOWN}::interval
        )`;
    await notify({
      kind: "page.updated",
      recipientIds: watchers.map((w) => w.user_id).filter((id) => !notified.has(id)),
      actorId,
      pageId,
    });
  } catch (error) {
    log.error("page notifications failed", error, { pageId });
  }
};

/** Permanently deletes pages matching `rootCondition` and all their descendants, with their files. */
const deleteSubtrees = async (rootCondition: SQL.Query<unknown>): Promise<number> => {
  const rows: { storage_key: string | null; page_id: string | null }[] = await sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM pages WHERE ${rootCondition}
      UNION
      SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
    ),
    removed_files AS (DELETE FROM files WHERE page_id IN (SELECT id FROM subtree) RETURNING storage_key),
    removed_pages AS (DELETE FROM pages WHERE id IN (SELECT id FROM subtree) RETURNING id)
    SELECT storage_key, NULL::uuid AS page_id FROM removed_files
    UNION ALL
    SELECT NULL, id FROM removed_pages`;
  await storage.removeMany(rows.flatMap((row) => (row.storage_key ? [row.storage_key] : [])));
  return rows.filter((row) => row.page_id).length;
};

export const deletePagePermanently = (pageId: string) => deleteSubtrees(sql`id = ${pageId}`);

/** Permanently removes pages that have been in the trash longer than the workspace retention. */
export const purgeTrash = async (): Promise<number> => {
  const [workspace] = await sql`SELECT settings FROM workspace WHERE id = 1`;
  const days = Number(workspace?.settings?.trashRetentionDays);
  const retention = Number.isInteger(days) && days >= 1 ? days : 30;
  return deleteSubtrees(sql`deleted_at IS NOT NULL AND deleted_at < now() - make_interval(days => ${retention}::int)`);
};

/** Moves a page and its non-deleted descendants to the trash and removes their shares. */
export const trashPage = async (pageId: string, userId: string) => {
  await sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM pages WHERE id = ${pageId} AND deleted_at IS NULL
      UNION
      SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id WHERE p.deleted_at IS NULL
    ),
    removed_shares AS (DELETE FROM shares WHERE page_id IN (SELECT id FROM subtree))
    UPDATE pages SET deleted_at = now(), deleted_by = ${userId} WHERE id IN (SELECT id FROM subtree)`;
};

/**
 * Restores a trashed page with the descendants trashed together with it. When
 * its parent is still trashed (or gone) it becomes the last root page.
 */
export const restorePage = async (pageId: string) =>
  sql.begin(async (tx) => {
    const [page] = await tx`
      SELECT p.id, p.space_id, p.parent_id, p.deleted_at, parent.deleted_at AS parent_deleted_at,
        parent.id AS existing_parent
      FROM pages p LEFT JOIN pages parent ON parent.id = p.parent_id
      WHERE p.id = ${pageId} FOR UPDATE OF p`;
    if (!page?.deleted_at) return;
    if (page.parent_id && (!page.existing_parent || page.parent_deleted_at)) {
      const position = await siblingPosition(tx, page.space_id, null, undefined, pageId);
      await tx`UPDATE pages SET parent_id = NULL, position = ${position} WHERE id = ${pageId}`;
    }
    await tx`
      WITH RECURSIVE root AS (SELECT deleted_at FROM pages WHERE id = ${pageId}),
      subtree AS (
        SELECT id FROM pages WHERE id = ${pageId}
        UNION
        SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id JOIN root ON p.deleted_at = root.deleted_at
      )
      UPDATE pages SET deleted_at = NULL, deleted_by = NULL WHERE id IN (SELECT id FROM subtree)`;
  });

/** True when `candidateId` is `pageId` itself or one of its descendants. */
export const isInSubtree = async (db: Db, pageId: string, candidateId: string): Promise<boolean> => {
  const [row] = await db`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, 0 AS depth FROM pages WHERE id = ${candidateId}
      UNION ALL
      SELECT p.id, p.parent_id, chain.depth + 1 FROM pages p JOIN chain ON p.id = chain.parent_id WHERE chain.depth < 1000
    )
    SELECT EXISTS (SELECT 1 FROM chain WHERE id = ${pageId}) AS inside`;
  return !!row?.inside;
};
