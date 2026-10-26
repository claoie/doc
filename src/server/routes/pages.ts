import type { PageFile, PageVersion, PageVersionSummary, RecentPage, SyncedBlock, TrashItem, TreeItem } from "common/api-types";
import { emptyDoc } from "common/editor/doc-schema";
import { isUuid, slugId } from "common/ids";
import { docText } from "common/text";
import { sql } from "server/db";
import { validateDoc } from "server/lib/content";
import { duplicatePage } from "server/lib/duplicate";
import { badRequest, get, notFound, post, readJson } from "server/lib/http";
import { watchPage } from "server/lib/notifications";
import {
  breadcrumbs,
  deletePagePermanently,
  indexPageContent,
  isInSubtree,
  pageColumns,
  requirePage,
  restorePage,
  siblingPosition,
  toPage,
  toTreeItem,
  trashPage,
  treeColumns,
  type PageRow,
} from "server/lib/pages";
import { readableSpaceIds, requireSpaceRole } from "server/lib/permissions";
import { findSpace, spaceRefJson, toSpace } from "server/lib/spaces";
import { iso, userRefs } from "server/lib/users";
import { Input, input } from "server/lib/validate";
import { emitToSpace } from "server/realtime/hub";
import { refreshOpenSessions, replacePageContent } from "server/realtime/collab";
import { log } from "server/lib/logger";

const TITLE_RULE = { min: 0, max: 500 };
const ICON_RULE = { max: 100 };
const COVER_RULE = { max: 2000 };
const PAGE_BODY_LIMIT = 8 * 1024 * 1024;

const pageById = async (id: string) => {
  const [row] = await sql`SELECT ${pageColumns()}, p.content FROM pages p WHERE p.id = ${id}`;
  return toPage(row as PageRow);
};

/**
 * Open editors of a moved, trashed or restored subtree may have gained or lost
 * access. Runs after the response; pass the ids when the subtree is about to
 * be deleted, or null to re-check every open editor.
 */
const recheckEditors = (pageId: string, known?: string[] | null) => {
  const run = async () => {
    const pageIds = known === undefined ? await subtreeIds(pageId) : known;
    await refreshOpenSessions(pageIds ? { pageIds } : {});
  };
  run().catch((error) => log.error("re-checking editor access failed", error));
};

/** Ids of a page and all of its descendants, trashed or not. */
const subtreeIds = async (pageId: string): Promise<string[]> =>
  (
    await sql`
      WITH RECURSIVE subtree AS (
        SELECT id, 0 AS depth FROM pages WHERE id = ${pageId}
        UNION ALL
        SELECT p.id, s.depth + 1 FROM pages p JOIN subtree s ON p.parent_id = s.id WHERE s.depth < 1000
      )
      SELECT id FROM subtree`
  ).map((r: { id: string }) => r.id);

const emitTree = (...spaceIds: string[]) => {
  for (const spaceId of new Set(spaceIds)) emitToSpace(spaceId, { kind: "tree", spaceId });
};

const requireSpaceId = (value: string) => {
  if (!isUuid(value)) throw notFound("Space");
  return value.toLowerCase();
};

export const routes = [
  get("/spaces/:id/pages", async (ctx): Promise<TreeItem[]> => {
    const spaceId = requireSpaceId(ctx.params.id!);
    await requireSpaceRole(ctx.user, spaceId, "reader");
    const parentId = Input.query(ctx.url).optionalUuid("parentId") ?? null;
    const rows = await sql`
      SELECT ${treeColumns()} FROM pages p
      WHERE p.space_id = ${spaceId} AND p.parent_id IS NOT DISTINCT FROM ${parentId}::uuid AND p.deleted_at IS NULL
      ORDER BY p.position, p.id`;
    return rows.map(toTreeItem);
  }),

  get("/pages/recent", async (ctx): Promise<RecentPage[]> => {
    const query = Input.query(ctx.url);
    const spaceId = query.optionalUuid("spaceId") ?? null;
    const creatorId = query.optionalUuid("creatorId") ?? null;
    const limit = query.integer("limit", 1, 100) ?? 20;
    const offset = query.integer("offset", 0, 100_000) ?? 0;
    const rows = await sql`
      SELECT ${treeColumns()}, p.updated_at, ${spaceRefJson("s")} AS space,
        u.id AS editor_id, u.name AS editor_name, u.avatar AS editor_avatar
      FROM pages p JOIN spaces s ON s.id = p.space_id LEFT JOIN users u ON u.id = p.last_editor_id
      WHERE p.deleted_at IS NULL AND p.space_id IN ${readableSpaceIds(ctx.user.id)}
        AND (${spaceId}::uuid IS NULL OR p.space_id = ${spaceId}::uuid)
        AND (${creatorId}::uuid IS NULL OR p.creator_id = ${creatorId}::uuid)
      ORDER BY p.updated_at DESC, p.id LIMIT ${limit} OFFSET ${offset}`;
    return rows.map((r: PageRow & Record<string, never>) => ({
      ...toTreeItem(r),
      space: r.space,
      updatedAt: iso(r.updated_at)!,
      lastEditor: r.editor_id
        ? { id: r.editor_id, name: r.editor_name, avatarUrl: r.editor_avatar ? `/api/images/${r.editor_avatar}` : null }
        : null,
    }));
  }),

  get("/pages/:page", async (ctx) => {
    const { page, role } = await requirePage(ctx.user, ctx.params.page!, "reader", { withContent: true });
    const space = await findSpace(ctx.user.id, page.space_id);
    return {
      page: await toPage(page),
      space: toSpace(space!),
      breadcrumbs: await breadcrumbs(page.id),
      canEdit: !page.deleted_at && (role === "writer" || role === "admin"),
    };
  }),

  post("/pages", async (ctx) => {
    const body = input(await readJson(ctx, PAGE_BODY_LIMIT));
    const spaceId = body.uuid("spaceId");
    await requireSpaceRole(ctx.user, spaceId, "writer");
    const parentId = body.optionalUuid("parentId") ?? null;
    const afterId = body.optionalUuid("afterId");
    const title = body.nullableString("title", TITLE_RULE) ?? null;
    const icon = body.nullableString("icon", ICON_RULE) ?? null;
    const content = body.has("content") && body.raw("content") !== null ? validateDoc(body.raw("content")) : emptyDoc();
    const id = await sql.begin(async (tx) => {
      if (parentId) {
        const [parent] = await tx`SELECT id FROM pages WHERE id = ${parentId} AND space_id = ${spaceId} AND deleted_at IS NULL`;
        if (!parent) throw notFound("Parent page");
      }
      const position = await siblingPosition(tx, spaceId, parentId, afterId === null ? undefined : afterId);
      const [row] = await tx`
        INSERT INTO pages (slug_id, space_id, parent_id, position, title, icon, content, text_content,
          creator_id, last_editor_id, contributor_ids)
        VALUES (${slugId()}, ${spaceId}, ${parentId}, ${position}, ${title}, ${icon}, ${content}::jsonb, ${docText(content)},
          ${ctx.user.id}, ${ctx.user.id}, ARRAY[${ctx.user.id}]::uuid[])
        RETURNING id`;
      await indexPageContent(tx, row.id, content);
      return row.id as string;
    });
    await watchPage(id, [ctx.user.id]);
    emitTree(spaceId);
    return { page: await pageById(id) };
  }),

  post("/pages/:id/update", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "writer");
    const body = input(await readJson(ctx));
    const title = body.nullableString("title", TITLE_RULE);
    const icon = body.nullableString("icon", ICON_RULE);
    const cover = body.nullableString("cover", COVER_RULE);
    await sql`
      UPDATE pages SET
        title = CASE WHEN ${title !== undefined} THEN ${title ?? null} ELSE title END,
        icon = CASE WHEN ${icon !== undefined} THEN ${icon ?? null} ELSE icon END,
        cover = CASE WHEN ${cover !== undefined} THEN ${cover ?? null} ELSE cover END,
        last_editor_id = ${ctx.user.id},
        updated_at = now()
      WHERE id = ${page.id}`;
    const updated = await pageById(page.id);
    if (title !== undefined || icon !== undefined) {
      emitTree(page.space_id);
      emitToSpace(page.space_id, {
        kind: "page",
        pageId: page.id,
        spaceId: page.space_id,
        title: updated.title,
        icon: updated.icon,
      });
    }
    return { page: updated };
  }),

  post("/pages/:id/content", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "writer");
    const body = (await readJson(ctx, PAGE_BODY_LIMIT)) as { content?: unknown };
    const content = validateDoc(body?.content);
    const replaced = await replacePageContent(page.id, content, ctx.user.id).catch((error: Error) => {
      if (error.message === "too-large") throw badRequest("content is too large");
      if (error.message === "invalid") throw badRequest("Content does not fit the document format");
      throw error;
    });
    if (!replaced) throw notFound("Page");
    return { page: await pageById(page.id) };
  }),

  post("/pages/:id/move", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "writer");
    const body = input(await readJson(ctx));
    const parentId = body.optionalUuid("parentId") ?? null;
    const afterId = body.optionalUuid("afterId") ?? null;
    await sql.begin(async (tx) => {
      if (parentId) {
        const [parent] = await tx`SELECT id FROM pages WHERE id = ${parentId} AND space_id = ${page.space_id} AND deleted_at IS NULL`;
        if (!parent) throw notFound("Parent page");
        if (await isInSubtree(tx, page.id, parentId)) throw badRequest("A page cannot be moved under itself or its descendants");
      }
      if (afterId === page.id) throw badRequest("afterId cannot be the page itself");
      const position = await siblingPosition(tx, page.space_id, parentId, afterId, page.id);
      await tx`UPDATE pages SET parent_id = ${parentId}, position = ${position} WHERE id = ${page.id}`;
    });
    emitTree(page.space_id);
    return { page: await pageById(page.id) };
  }),

  post("/pages/:id/move-to-space", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "writer");
    const targetSpaceId = input(await readJson(ctx)).uuid("spaceId");
    await requireSpaceRole(ctx.user, targetSpaceId, "writer");
    if (targetSpaceId !== page.space_id) {
      await sql.begin(async (tx) => {
        const position = await siblingPosition(tx, targetSpaceId, null, undefined);
        await tx`
          WITH RECURSIVE subtree AS (
            SELECT id FROM pages WHERE id = ${page.id}
            UNION
            SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
          ),
          moved_files AS (UPDATE files SET space_id = ${targetSpaceId} WHERE page_id IN (SELECT id FROM subtree)),
          dropped_shares AS (
            DELETE FROM shares WHERE page_id IN (SELECT id FROM subtree)
              AND (SELECT coalesce((settings->>'sharingDisabled')::boolean, false) FROM spaces WHERE id = ${targetSpaceId})
          )
          UPDATE pages SET space_id = ${targetSpaceId},
            parent_id = CASE WHEN id = ${page.id} THEN NULL ELSE parent_id END,
            position = CASE WHEN id = ${page.id} THEN ${position} ELSE position END
          WHERE id IN (SELECT id FROM subtree)`;
      });
      emitTree(page.space_id, targetSpaceId);
      recheckEditors(page.id);
    }
    return { page: await pageById(page.id) };
  }),

  post("/pages/:id/duplicate", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "writer");
    const targetSpaceId = input(await readJson(ctx)).optionalUuid("spaceId") ?? page.space_id;
    if (targetSpaceId !== page.space_id) await requireSpaceRole(ctx.user, targetSpaceId, "writer");
    const id = await duplicatePage(page, targetSpaceId, ctx.user.id);
    emitTree(targetSpaceId);
    return { page: await pageById(id) };
  }),

  post("/pages/:id/delete", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "writer");
    await trashPage(page.id, ctx.user.id);
    emitTree(page.space_id);
    recheckEditors(page.id);
    return {};
  }),

  post("/pages/:id/restore", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "writer", { allowDeleted: true });
    await restorePage(page.id);
    emitTree(page.space_id);
    recheckEditors(page.id);
    return { page: await pageById(page.id) };
  }),

  post("/pages/:id/delete-permanently", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "admin", { allowDeleted: true });
    const affected = await subtreeIds(page.id).catch(() => null);
    await deletePagePermanently(page.id);
    emitTree(page.space_id);
    recheckEditors(page.id, affected);
    return {};
  }),

  get("/spaces/:id/trash", async (ctx): Promise<TrashItem[]> => {
    const spaceId = requireSpaceId(ctx.params.id!);
    await requireSpaceRole(ctx.user, spaceId, "reader");
    const rows = await sql`
      SELECT ${treeColumns()}, p.deleted_at, u.id AS deleter_id, u.name AS deleter_name, u.avatar AS deleter_avatar
      FROM pages p
      LEFT JOIN pages parent ON parent.id = p.parent_id
      LEFT JOIN users u ON u.id = p.deleted_by
      WHERE p.space_id = ${spaceId} AND p.deleted_at IS NOT NULL
        AND (parent.id IS NULL OR parent.deleted_at IS NULL OR parent.deleted_at <> p.deleted_at)
      ORDER BY p.deleted_at DESC, p.id
      LIMIT 1000`;
    return rows.map((r: PageRow & Record<string, never>) => ({
      ...toTreeItem(r),
      deletedAt: iso(r.deleted_at)!,
      deletedBy: r.deleter_id
        ? { id: r.deleter_id, name: r.deleter_name, avatarUrl: r.deleter_avatar ? `/api/images/${r.deleter_avatar}` : null }
        : null,
    }));
  }),

  get("/pages/:id/versions", async (ctx): Promise<PageVersionSummary[]> => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "reader");
    const rows = await sql`
      SELECT v.id, v.title, v.created_at, v.editor_id FROM page_versions v
      WHERE v.page_id = ${page.id} ORDER BY v.created_at DESC LIMIT 500`;
    const editors = new Map((await userRefs([...new Set<string>(rows.flatMap((r: { editor_id: string | null }) => r.editor_id ?? []))])).map((u) => [u.id, u]));
    return rows.map((r: { id: string; title: string | null; created_at: Date; editor_id: string | null }) => ({
      id: r.id,
      title: r.title,
      editor: (r.editor_id && editors.get(r.editor_id)) || null,
      createdAt: iso(r.created_at)!,
    }));
  }),

  get("/versions/:id", async (ctx): Promise<PageVersion> => {
    if (!isUuid(ctx.params.id)) throw notFound("Version");
    const [version] = await sql`
      SELECT v.id, v.page_id, v.title, v.icon, v.content, v.editor_id, v.contributor_ids::text[] AS contributor_ids, v.created_at
      FROM page_versions v WHERE v.id = ${ctx.params.id}`;
    if (!version) throw notFound("Version");
    await requirePage(ctx.user, version.page_id, "reader");
    const contributorIds: string[] = version.contributor_ids ?? [];
    const refs = new Map((await userRefs([...new Set([version.editor_id, ...contributorIds].filter(Boolean))])).map((u) => [u.id, u]));
    return {
      id: version.id,
      pageId: version.page_id,
      title: version.title,
      icon: version.icon,
      content: version.content,
      editor: (version.editor_id && refs.get(version.editor_id)) || null,
      contributors: contributorIds.flatMap((id) => refs.get(id) ?? []),
      createdAt: iso(version.created_at)!,
    };
  }),

  get("/pages/:id/files", async (ctx): Promise<PageFile[]> => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "reader");
    const rows = await sql`
      SELECT f.id, f.name, f.mime, f.size, f.created_at, f.uploader_id
      FROM files f WHERE f.page_id = ${page.id} AND f.purpose = 'page' ORDER BY f.created_at DESC LIMIT 500`;
    const uploaders = await userRefs([...new Set(rows.map((r: { uploader_id: string | null }) => r.uploader_id).filter(Boolean))] as string[]);
    return rows.map((r: { id: string; name: string; mime: string; size: string | number; created_at: Date; uploader_id: string | null }) => ({
      id: r.id,
      name: r.name,
      mime: r.mime,
      size: Number(r.size),
      url: `/api/files/${r.id}/${encodeURIComponent(r.name)}`,
      uploader: uploaders.find((u) => u.id === r.uploader_id) ?? null,
      createdAt: iso(r.created_at)!,
    }));
  }),

  get("/pages/:id/backlinks", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "reader");
    const rows = await sql`
      SELECT ${treeColumns()}, ${spaceRefJson("s")} AS space
      FROM page_links l JOIN pages p ON p.id = l.source_id JOIN spaces s ON s.id = p.space_id
      WHERE l.target_id = ${page.id} AND p.deleted_at IS NULL AND p.space_id IN ${readableSpaceIds(ctx.user.id)}
      ORDER BY lower(coalesce(p.title, '')), p.id LIMIT 500`;
    return rows.map((r: PageRow & { space: unknown }) => ({ ...toTreeItem(r), space: r.space }));
  }),

  get("/pages/:id/links", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "reader");
    const rows = await sql`
      SELECT ${treeColumns()}, ${spaceRefJson("s")} AS space
      FROM page_links l JOIN pages p ON p.id = l.target_id JOIN spaces s ON s.id = p.space_id
      WHERE l.source_id = ${page.id} AND p.deleted_at IS NULL AND p.space_id IN ${readableSpaceIds(ctx.user.id)}
      ORDER BY lower(coalesce(p.title, '')), p.id LIMIT 500`;
    return rows.map((r: PageRow & { space: unknown }) => ({ ...toTreeItem(r), space: r.space }));
  }),

  post("/synced-blocks/lookup", async (ctx): Promise<SyncedBlock[]> => {
    const raw = input(await readJson(ctx)).raw("refs");
    if (!Array.isArray(raw) || raw.length > 100) throw badRequest("refs must be a list of at most 100 references");
    const refs = raw.map((ref, ord) => {
      const r = ref as Record<string, unknown> | null;
      if (!r || !isUuid(r.pageId) || typeof r.blockId !== "string" || !r.blockId || r.blockId.length > 100) {
        throw badRequest("Each ref needs a pageId and blockId");
      }
      return { page_id: r.pageId.toLowerCase(), block_id: r.blockId, ord };
    });
    if (refs.length === 0) return [];
    const rows = await sql`
      SELECT r.page_id, r.block_id, sb.content
      FROM jsonb_to_recordset(${refs}::jsonb) AS r(page_id uuid, block_id text, ord int)
      LEFT JOIN pages p ON p.id = r.page_id AND p.deleted_at IS NULL AND p.space_id IN ${readableSpaceIds(ctx.user.id)}
      LEFT JOIN synced_blocks sb ON sb.page_id = p.id AND sb.block_id = r.block_id
      ORDER BY r.ord`;
    return rows.map((r: { page_id: string; block_id: string; content: SyncedBlock["content"] }) => ({
      pageId: r.page_id,
      blockId: r.block_id,
      content: r.content ?? null,
    }));
  }),
];
