import type { PageShareState, PublicPage, PublicSearchResult, ShareWithPage, TreeItem } from "common/api-types";
import { isSlugId, isUuid, shareKey } from "common/ids";
import { sql } from "server/db";
import { publicDoc } from "server/lib/content";
import { HttpError, get, notFound, post, publicGet, readJson } from "server/lib/http";
import { requirePage, toTreeItem, treeColumns, type PageRow } from "server/lib/pages";
import { requireSpaceRole } from "server/lib/permissions";
import { rateLimit } from "server/lib/ratelimit";
import { searchPages } from "server/lib/search";
import { findPublicShare, shareAllowsPage, shareQuery, sharingEnabled, toShare, type ShareRow } from "server/lib/shares";
import { iso } from "server/lib/users";
import { loadProperties, loadViews, queryRows, toRow } from "server/lib/bases";
import { Input, input } from "server/lib/validate";

const MAX_TREE = 5000;

const sharingDisabled = () => new HttpError(403, "sharing_disabled", "Sharing is disabled for this space or workspace");

const PUBLIC_BASE_ROWS = 1000;

const publicBase = async (pageId: string): Promise<PublicPage["base"]> => {
  const [properties, views] = await Promise.all([loadProperties(pageId), loadViews(pageId)]);
  const view = views[0] ?? null;
  const { rows, nextCursor } = await queryRows(pageId, properties, {
    filter: view?.config.filter,
    sorts: view?.config.sorts,
    limit: PUBLIC_BASE_ROWS,
    tzOffset: 0,
  }).catch(() => queryRows(pageId, properties, { limit: PUBLIC_BASE_ROWS, tzOffset: 0 }));
  return { properties, view, rows: rows.map(toRow), truncated: !!nextCursor };
};

const publicPage = async (row: PageRow, key: string): Promise<PublicPage> => ({
  ...toTreeItem(row),
  cover: row.cover,
  content: publicDoc(row.content ?? null, key),
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!,
  ...(row.is_base ? { base: await publicBase(row.id) } : {}),
});

const JOINED_SHARE_COLUMNS = () =>
  sql`sh.id AS share_id, sh.key, sh.include_children, sh.search_indexing, sh.created_at AS share_created_at, ${treeColumns()}`;

type JoinedShareRow = PageRow & {
  share_id: string;
  key: string;
  include_children: boolean;
  search_indexing: boolean;
  share_created_at: Date;
};

/** Splits a share joined to its page (aliased `p`) into the share and the page's tree item. */
const splitJoined = (row: JoinedShareRow) => ({
  share: toShare({
    id: row.share_id,
    key: row.key,
    page_id: row.id,
    include_children: row.include_children,
    search_indexing: row.search_indexing,
    created_at: row.share_created_at,
    page_title: row.title,
    page_slug_id: row.slug_id,
  }),
  page: toTreeItem(row),
});

const loadPublicPage = async (pageRef: string): Promise<PageRow | null> => {
  const condition = isUuid(pageRef) ? sql`p.id = ${pageRef.toLowerCase()}` : isSlugId(pageRef) ? sql`p.slug_id = ${pageRef}` : null;
  if (!condition) return null;
  const [row] = await sql`
    SELECT ${treeColumns()}, p.cover, p.content, p.created_at, p.updated_at
    FROM pages p WHERE ${condition} AND p.deleted_at IS NULL`;
  return (row as PageRow | undefined) ?? null;
};

/** Subtree pages under the shared root, flat and ordered by depth then position. */
const sharedTree = async (rootId: string): Promise<TreeItem[]> => {
  const rows = await sql`
    WITH RECURSIVE subtree AS (
      SELECT id, 0 AS depth FROM pages WHERE id = ${rootId}
      UNION ALL
      SELECT p.id, s.depth + 1 FROM pages p JOIN subtree s ON p.parent_id = s.id
      WHERE p.deleted_at IS NULL AND s.depth < 1000
    )
    SELECT ${treeColumns()} FROM subtree s JOIN pages p ON p.id = s.id
    WHERE s.depth > 0 ORDER BY s.depth, p.parent_id, p.position, p.id LIMIT ${MAX_TREE}`;
  return rows.map(toTreeItem);
};

export const routes = [
  get("/pages/:id/share", async (ctx): Promise<PageShareState> => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "reader");
    const [own] = await sql`${shareQuery()} WHERE sh.page_id = ${page.id}`;
    const [inherited] = await sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, 0 AS depth FROM pages WHERE id = ${page.id}
        UNION ALL
        SELECT p.id, p.parent_id, chain.depth + 1 FROM pages p JOIN chain ON p.id = chain.parent_id WHERE chain.depth < 1000
      )
      SELECT ${JOINED_SHARE_COLUMNS()}
      FROM chain JOIN shares sh ON sh.page_id = chain.id JOIN pages p ON p.id = chain.id
      WHERE chain.depth > 0 AND sh.include_children
      ORDER BY chain.depth LIMIT 1`;
    return {
      share: own ? toShare(own as ShareRow) : null,
      inheritedFrom: inherited ? splitJoined(inherited as JoinedShareRow) : null,
    };
  }),

  post("/pages/:id/share", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "writer");
    const body = input(await readJson(ctx));
    const includeChildren = body.boolean("includeChildren");
    const searchIndexing = body.boolean("searchIndexing");
    const [enabled] = await sql`SELECT ${sharingEnabled("s")} AS ok FROM spaces s WHERE s.id = ${page.space_id}`;
    if (!enabled?.ok) throw sharingDisabled();
    await sql`
      INSERT INTO shares (key, page_id, include_children, search_indexing, created_by)
      VALUES (${shareKey()}, ${page.id}, ${includeChildren ?? false}, ${searchIndexing ?? false}, ${ctx.user.id})
      ON CONFLICT (page_id) DO UPDATE SET
        include_children = COALESCE(${includeChildren ?? null}::boolean, shares.include_children),
        search_indexing = COALESCE(${searchIndexing ?? null}::boolean, shares.search_indexing),
        updated_at = now()`;
    const [row] = await sql`${shareQuery()} WHERE sh.page_id = ${page.id}`;
    return { share: toShare(row as ShareRow) };
  }),

  post("/pages/:id/share/delete", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "writer", { allowDeleted: true });
    await sql`DELETE FROM shares WHERE page_id = ${page.id}`;
    return {};
  }),

  get("/spaces/:id/shares", async (ctx): Promise<ShareWithPage[]> => {
    if (!isUuid(ctx.params.id)) throw notFound("Space");
    await requireSpaceRole(ctx.user, ctx.params.id, "reader");
    const rows = await sql`
      SELECT ${JOINED_SHARE_COLUMNS()}
      FROM shares sh JOIN pages p ON p.id = sh.page_id
      WHERE p.space_id = ${ctx.params.id} AND p.deleted_at IS NULL ORDER BY sh.created_at DESC`;
    return rows.map((r: JoinedShareRow) => {
      const { share, page } = splitJoined(r);
      return { ...share, page };
    });
  }),

  publicGet("/public/shares/:key", async (ctx) => {
    const share = await findPublicShare(ctx.params.key!);
    if (!share) throw notFound("Share");
    const page = await loadPublicPage(share.page_id);
    if (!page) throw notFound("Share");
    return {
      share: toShare(share),
      page: await publicPage(page, share.key),
      ...(share.include_children ? { tree: await sharedTree(share.page_id) } : {}),
    };
  }),

  publicGet("/public/shares/:key/pages/:page", async (ctx) => {
    const share = await findPublicShare(ctx.params.key!);
    if (!share) throw notFound("Page");
    const page = await loadPublicPage(ctx.params.page!);
    if (!page || !(await shareAllowsPage(share.key, page.id))) throw notFound("Page");
    const rows = await sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, 0 AS depth FROM pages WHERE id = ${page.id}
        UNION ALL
        SELECT p.id, p.parent_id, chain.depth + 1 FROM pages p JOIN chain ON p.id = chain.parent_id
        WHERE chain.depth < 1000 AND chain.id <> ${share.page_id}
      )
      SELECT ${treeColumns()} FROM chain JOIN pages p ON p.id = chain.id ORDER BY chain.depth DESC`;
    return { page: await publicPage(page, share.key), breadcrumbs: rows.map(toTreeItem) };
  }),

  publicGet("/public/shares/:key/search", async (ctx): Promise<PublicSearchResult[]> => {
    rateLimit("public-search", ctx.ip, 60);
    const share = await findPublicShare(ctx.params.key!);
    if (!share) throw notFound("Share");
    const q = Input.query(ctx.url).optionalString("q", { min: 0, max: 200 }) ?? "";
    const scope = share.include_children
      ? sql`p.id IN (
          WITH RECURSIVE subtree AS (
            SELECT id FROM pages WHERE id = ${share.page_id}
            UNION
            SELECT c.id FROM pages c JOIN subtree t ON c.parent_id = t.id WHERE c.deleted_at IS NULL
          ) SELECT id FROM subtree)`
      : sql`p.id = ${share.page_id}`;
    const results = await searchPages({ query: q, scope, limit: 20, offset: 0 });
    return results.map(({ space: _, ...rest }) => rest);
  }),
];
