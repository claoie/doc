import type { SQL } from "bun";
import type { Space, Workspace } from "common/api-types";
import { isUuid } from "common/ids";
import { sql } from "server/db";
import { rankToRole, roleRank } from "./permissions";
import { imageUrl, iso } from "./users";

export interface SpaceRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  settings: Record<string, unknown>;
  created_at: Date;
  rank: number | null;
  member_count: number;
}

/** Spaces aliased `s` with the user's role rank and member count. */
export const spaceQuery = (userId: string) => sql`
  SELECT s.id, s.name, s.slug, s.description, s.icon, s.settings, s.created_at,
    ${roleRank("s.id", userId)} AS rank,
    (SELECT count(*)::int FROM space_members sm WHERE sm.space_id = s.id) AS member_count
  FROM spaces s`;

export const toSpace = (row: SpaceRow): Space => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  description: row.description,
  iconUrl: imageUrl(row.icon),
  settings: row.settings ?? {},
  role: rankToRole(row.rank),
  memberCount: Number(row.member_count ?? 0),
  createdAt: iso(row.created_at)!,
});

/** SQL expression building a `SpaceRef` JSON object from a spaces row alias. */
export const spaceRefJson = (alias: string) =>
  sql.unsafe(
    `json_build_object('id', ${alias}.id, 'name', ${alias}.name, 'slug', ${alias}.slug, 'iconUrl', CASE WHEN ${alias}.icon IS NULL THEN NULL ELSE '/api/images/' || ${alias}.icon END)`,
  );

/** Finds a space by id or slug, with the user's role. */
export const findSpace = async (userId: string, ref: string): Promise<SpaceRow | null> => {
  const key = ref.toLowerCase();
  const condition = isUuid(key) ? sql`s.id = ${key}` : sql`lower(s.slug) = ${key}`;
  const [row] = await sql`${spaceQuery(userId)} WHERE ${condition}`;
  return (row as SpaceRow | undefined) ?? null;
};

export const getWorkspace = async (): Promise<Workspace> => {
  const [row] = await sql`SELECT * FROM workspace WHERE id = 1`;
  return {
    name: row?.name ?? "",
    description: row?.description ?? null,
    logoUrl: imageUrl(row?.logo),
    emailDomains: row?.email_domains ?? [],
    settings: row?.settings ?? {},
    defaultSpaceId: row?.default_space_id ?? null,
    createdAt: iso(row?.created_at ?? new Date())!,
  };
};

/** Serializes first-run setup until the transaction ends, so a workspace is set up once even when two first sign-ins race. */
export const lockSetup = (tx: SQL) => tx`SELECT pg_advisory_xact_lock(4815162342)`;

/**
 * First-run setup for the workspace's first user, inside the transaction that
 * created them: names the workspace, creates the default group `Everyone` and
 * a `General` space with that user as its admin.
 */
export const initWorkspace = async (tx: SQL, workspaceName: string, userId: string) => {
  await tx`
    INSERT INTO workspace (id, name) VALUES (1, ${workspaceName})
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = now()`;
  const [group] = await tx`
    INSERT INTO groups (name, description, is_default, created_by)
    VALUES ('Everyone', 'Every member of the workspace', true, ${userId}) RETURNING id`;
  await tx`INSERT INTO group_members (group_id, user_id) VALUES (${group.id}, ${userId})`;
  const [space] = await tx`
    INSERT INTO spaces (name, slug, created_by) VALUES ('General', 'general', ${userId}) RETURNING id`;
  await tx`INSERT INTO space_members (space_id, user_id, role, added_by) VALUES (${space.id}, ${userId}, 'admin', ${userId})`;
  await tx`UPDATE workspace SET default_space_id = ${space.id} WHERE id = 1`;
};
