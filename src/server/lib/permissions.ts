import type { SpaceRole } from "common/api-types";
import { sql } from "server/db";
import { forbidden, notFound } from "./http";
import type { AuthUser } from "./auth";

const RANK: Record<SpaceRole, number> = { reader: 1, writer: 2, admin: 3 };

export const rankToRole = (rank: number | null | undefined): SpaceRole | null =>
  rank === 3 ? "admin" : rank === 2 ? "writer" : rank === 1 ? "reader" : null;

export const hasRole = (role: SpaceRole | null | undefined, min: SpaceRole): boolean =>
  !!role && RANK[role] >= RANK[min];

export const isWorkspaceAdmin = (user: Pick<AuthUser, "role">) => user.role === "owner" || user.role === "admin";

export const requireWorkspaceAdmin = (user: AuthUser) => {
  if (!isWorkspaceAdmin(user)) throw forbidden("Only workspace admins can do this");
};

/**
 * SQL fragment evaluating to the user's effective role rank (1–3, or null) in
 * the space referenced by `spaceColumn`: the highest of direct and group grants.
 */
export const roleRank = (spaceColumn: string, userId: string) => sql`(
  SELECT max(CASE sm.role WHEN 'admin' THEN 3 WHEN 'writer' THEN 2 ELSE 1 END)
  FROM space_members sm
  WHERE sm.space_id = ${sql.unsafe(spaceColumn)}
    AND (sm.user_id = ${userId}
      OR sm.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = ${userId}))
)`;

/** SQL fragment selecting the ids of every space the user is a member of. */
export const readableSpaceIds = (userId: string) => sql`(
  SELECT sm.space_id FROM space_members sm
  WHERE sm.user_id = ${userId}
    OR sm.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = ${userId})
)`;

export const spaceRole = async (userId: string, spaceId: string): Promise<SpaceRole | null> => {
  const [row] = await sql`SELECT ${roleRank("s.id", userId)} AS rank FROM spaces s WHERE s.id = ${spaceId}`;
  return rankToRole(row?.rank);
};

/**
 * Throws 404 when the user is not a member of the space (its existence is not
 * revealed) and 403 when their role is below `min`.
 */
export const requireSpaceRole = async (user: AuthUser, spaceId: string, min: SpaceRole): Promise<SpaceRole> => {
  const role = await spaceRole(user.id, spaceId);
  if (!role) throw notFound("Space");
  if (!hasRole(role, min)) throw forbidden();
  return role;
};

/**
 * Space management (settings, members, icon, deletion) is open to space
 * admins and to workspace admins, who manage every space.
 */
export const requireSpaceManager = async (user: AuthUser, spaceId: string) => {
  const [space] = await sql`SELECT id, ${roleRank("s.id", user.id)} AS rank FROM spaces s WHERE s.id = ${spaceId}`;
  if (!space) throw notFound("Space");
  const role = rankToRole(space.rank);
  if (hasRole(role, "admin") || isWorkspaceAdmin(user)) return role;
  if (!role) throw notFound("Space");
  throw forbidden();
};

export const listReadableSpaceIds = async (userId: string): Promise<string[]> => {
  const rows: { space_id: string }[] = await sql`SELECT DISTINCT space_id FROM ${readableSpaceIds(userId)} AS r`;
  return rows.map((row) => row.space_id);
};
