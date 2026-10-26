import type { Group } from "common/api-types";
import { isUuid } from "common/ids";
import { sql } from "server/db";
import { HttpError, badRequest, conflict, forbidden, get, notFound, post, readJson } from "server/lib/http";
import { requireWorkspaceAdmin } from "server/lib/permissions";
import { toUser, type UserRow } from "server/lib/users";
import { Input, input } from "server/lib/validate";
import { membershipChanged } from "server/realtime/hub";

const groupQuery = () => sql`
  SELECT g.id, g.name, g.description, g.is_default,
    (SELECT count(*)::int FROM group_members gm WHERE gm.group_id = g.id) AS member_count
  FROM groups g`;

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  member_count: number | string;
}

export const toGroup = (row: GroupRow): Group => ({
  id: row.id,
  name: row.name,
  description: row.description,
  isDefault: row.is_default,
  memberCount: Number(row.member_count ?? 0),
});

const findGroup = async (id: string) => {
  if (!isUuid(id)) throw notFound("Group");
  const [row] = await sql`${groupQuery()} WHERE g.id = ${id}`;
  if (!row) throw notFound("Group");
  return row;
};

const groupMemberIds = async (groupId: string): Promise<string[]> =>
  (await sql`SELECT user_id FROM group_members WHERE group_id = ${groupId}`).map((r: { user_id: string }) => r.user_id);

const isUniqueViolation = (error: unknown) => (error as { errno?: string })?.errno === "23505";

export const routes = [
  get("/groups", async () => {
    const rows = await sql`${groupQuery()} ORDER BY g.is_default DESC, lower(g.name)`;
    return rows.map(toGroup);
  }),

  post("/groups", async (ctx) => {
    requireWorkspaceAdmin(ctx.user);
    const body = input(await readJson(ctx));
    const name = body.string("name", { max: 100 });
    const description = body.nullableString("description", { max: 500 }) ?? null;
    try {
      const [row] = await sql`
        INSERT INTO groups (name, description, created_by) VALUES (${name}, ${description}, ${ctx.user.id}) RETURNING id`;
      return { group: toGroup(await findGroup(row.id)) };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("name_taken", "A group with this name already exists");
      throw error;
    }
  }),

  post("/groups/:id/update", async (ctx) => {
    requireWorkspaceAdmin(ctx.user);
    const group = await findGroup(ctx.params.id!);
    const body = input(await readJson(ctx));
    const name = body.optionalString("name", { max: 100 });
    const description = body.nullableString("description", { max: 500 });
    if (group.is_default && name !== undefined && name !== group.name) throw forbidden("The default group cannot be renamed");
    try {
      await sql`
        UPDATE groups SET
          name = COALESCE(${name ?? null}, name),
          description = CASE WHEN ${description !== undefined} THEN ${description ?? null} ELSE description END,
          updated_at = now()
        WHERE id = ${group.id}`;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("name_taken", "A group with this name already exists");
      throw error;
    }
    return { group: toGroup(await findGroup(group.id)) };
  }),

  post("/groups/:id/delete", async (ctx) => {
    requireWorkspaceAdmin(ctx.user);
    const group = await findGroup(ctx.params.id!);
    if (group.is_default) throw forbidden("The default group cannot be deleted");
    const members = await groupMemberIds(group.id);
    await sql`DELETE FROM groups WHERE id = ${group.id}`;
    membershipChanged(members);
    return {};
  }),

  get("/groups/:id/members", async (ctx) => {
    const group = await findGroup(ctx.params.id!);
    const query = Input.query(ctx.url);
    const limit = query.integer("limit", 1, 500) ?? 50;
    const offset = query.integer("offset", 0, 1_000_000) ?? 0;
    const rows = await sql`
      SELECT u.* FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ${group.id} ORDER BY lower(u.name), u.id LIMIT ${limit} OFFSET ${offset}`;
    return { items: rows.map((row: UserRow) => toUser(row, ctx.user.id)), total: Number(group.member_count) };
  }),

  post("/groups/:id/members/add", async (ctx) => {
    requireWorkspaceAdmin(ctx.user);
    const group = await findGroup(ctx.params.id!);
    const userIds = input(await readJson(ctx)).uuids("userIds", 100);
    if (!userIds?.length) throw badRequest("userIds is required");
    await sql`
      INSERT INTO group_members (group_id, user_id)
      SELECT ${group.id}, id FROM users WHERE id = ANY(${sql.array(userIds, "uuid")})
      ON CONFLICT DO NOTHING`;
    membershipChanged(userIds);
    return {};
  }),

  post("/groups/:id/members/remove", async (ctx) => {
    requireWorkspaceAdmin(ctx.user);
    const group = await findGroup(ctx.params.id!);
    const userId = input(await readJson(ctx)).uuid("userId");
    if (group.is_default) throw new HttpError(403, "forbidden", "Members cannot be removed from the default group");
    await sql`DELETE FROM group_members WHERE group_id = ${group.id} AND user_id = ${userId}`;
    membershipChanged([userId]);
    return {};
  }),
];
