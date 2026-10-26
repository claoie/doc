import type { Share } from "common/api-types";
import { titleSlug } from "common/text";
import { config } from "server/config";
import { sql } from "server/db";
import { iso } from "./users";

export interface ShareRow {
  id: string;
  key: string;
  page_id: string;
  include_children: boolean;
  search_indexing: boolean;
  created_at: Date;
  page_title: string | null;
  page_slug_id: string;
}

/** Shares aliased `sh` joined to their page (`sp`) so the public URL can be built. */
export const shareQuery = () => sql`
  SELECT sh.id, sh.key, sh.page_id, sh.include_children, sh.search_indexing, sh.created_at,
    sp.title AS page_title, sp.slug_id AS page_slug_id
  FROM shares sh JOIN pages sp ON sp.id = sh.page_id`;

export const toShare = (row: ShareRow): Share => ({
  id: row.id,
  key: row.key,
  pageId: row.page_id,
  includeChildren: row.include_children,
  searchIndexing: row.search_indexing,
  url: `${config.appUrl}/share/${row.key}/p/${encodeURIComponent(titleSlug(row.page_title))}-${row.page_slug_id}`,
  createdAt: iso(row.created_at)!,
});

/** SQL condition: sharing is not disabled for the workspace or for the space aliased `alias`. */
export const sharingEnabled = (spaceAlias: string) =>
  sql.unsafe(
    `NOT coalesce((SELECT (settings->>'sharingDisabled')::boolean FROM workspace WHERE id = 1), false)
     AND NOT coalesce((${spaceAlias}.settings->>'sharingDisabled')::boolean, false)`,
  );

/**
 * A live share by key: its page is not trashed and sharing is enabled for
 * the workspace and the page's space.
 */
export const findPublicShare = async (key: string): Promise<(ShareRow & { space_id: string }) | null> => {
  if (!/^[0-9a-z]{1,32}$/.test(key)) return null;
  const [row] = await sql`
    SELECT sh.id, sh.key, sh.page_id, sh.include_children, sh.search_indexing, sh.created_at,
      sp.title AS page_title, sp.slug_id AS page_slug_id, sp.space_id
    FROM shares sh JOIN pages sp ON sp.id = sh.page_id JOIN spaces s ON s.id = sp.space_id
    WHERE sh.key = ${key} AND sp.deleted_at IS NULL AND ${sharingEnabled("s")}`;
  return (row as (ShareRow & { space_id: string }) | undefined) ?? null;
};

/**
 * Whether the share `key` exposes `pageId`: the page is the shared page, or a
 * non-trashed descendant of it when the share includes children.
 */
export const shareAllowsPage = async (key: string, pageId: string): Promise<boolean> => {
  const share = await findPublicShare(key);
  if (!share) return false;
  if (share.page_id === pageId) return true;
  if (!share.include_children) return false;
  const [row] = await sql`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, 0 AS depth FROM pages WHERE id = ${pageId} AND deleted_at IS NULL
      UNION ALL
      SELECT p.id, p.parent_id, chain.depth + 1 FROM pages p JOIN chain ON p.id = chain.parent_id
      WHERE chain.depth < 1000 AND chain.id <> ${share.page_id}
    )
    SELECT EXISTS (SELECT 1 FROM chain WHERE id = ${share.page_id}) AS allowed`;
  return !!row?.allowed;
};
