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
