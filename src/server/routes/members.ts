import type { WorkspaceRole } from "common/api-types";
import { sql } from "server/db";
import { revokeUserSessions } from "server/lib/auth";
import { removeImage } from "server/lib/files";
import { badRequest, forbidden, get, notFound, post, readJson } from "server/lib/http";
import { requireWorkspaceAdmin } from "server/lib/permissions";
import { escapeLike } from "server/lib/search";
import { findUserById, toMember, toUser, type UserRow } from "server/lib/users";
import { Input, input } from "server/lib/validate";
import { disconnectUser, membershipChanged } from "server/realtime/hub";
import type { AuthUser } from "server/lib/auth";

const ROLES: readonly WorkspaceRole[] = ["owner", "admin", "member"];

/** Loads the target of an admin action, enforcing that admins never act on owners or themselves. */
const targetUser = async (actor: AuthUser, userId: string, allowSelf = false): Promise<UserRow> => {
  requireWorkspaceAdmin(actor);
  const target = await findUserById(userId);
  if (!target) throw notFound("User");
  if (!allowSelf && target.id === actor.id) throw forbidden("You cannot do this to your own account");
  if (target.role === "owner" && actor.role !== "owner") throw forbidden("Only owners can manage owners");
  return target;
};

export const routes = [
  get("/members", async (ctx) => {
    const query = Input.query(ctx.url);
    const q = (query.optionalString("query", { min: 0, max: 100 }) ?? "").toLowerCase();
    const limit = query.integer("limit", 1, 500) ?? 50;
    const offset = query.integer("offset", 0, 1_000_000) ?? 0;
    const like = `%${escapeLike(q)}%`;
    const rows = await sql`
      SELECT u.*, count(*) OVER () AS total FROM users u
      WHERE ${q} = '' OR lower(u.name) LIKE ${like} OR lower(u.email) LIKE ${like}
      ORDER BY u.deactivated_at IS NOT NULL, lower(u.name), u.id
      LIMIT ${limit} OFFSET ${offset}`;
    const total = rows.length
      ? Number(rows[0].total)
      : Number(
          (await sql`SELECT count(*) AS n FROM users u WHERE ${q} = '' OR lower(u.name) LIKE ${like} OR lower(u.email) LIKE ${like}`)[0]
            .n,
        );
    return { items: rows.map((row: UserRow) => toMember(row, ctx.user.id)), total };
  }),

  post("/members/role", async (ctx) => {
    const body = input(await readJson(ctx));
    const role = body.oneOf("role", ROLES);
    if (!role) throw badRequest("role is required");
    const target = await targetUser(ctx.user, body.uuid("userId"), true);
    if ((role === "owner" || target.role === "owner") && ctx.user.role !== "owner") {
      throw forbidden("Only owners can grant or remove the owner role");
    }
    const updated = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(1618033988)`;
      if (target.role === "owner" && role !== "owner") {
        const [{ owners }] = await tx`SELECT count(*)::int AS owners FROM users WHERE role = 'owner' AND deactivated_at IS NULL`;
        if (owners <= 1) throw forbidden("The last owner cannot be demoted");
      }
      const [row] = await tx`UPDATE users SET role = ${role}, updated_at = now() WHERE id = ${target.id} RETURNING *`;
      return row as UserRow;
    });
    return { user: toUser(updated, ctx.user.id) };
  }),

  post("/members/deactivate", async (ctx) => {
    const target = await targetUser(ctx.user, input(await readJson(ctx)).uuid("userId"));
    await sql`UPDATE users SET deactivated_at = COALESCE(deactivated_at, now()), updated_at = now() WHERE id = ${target.id}`;
    await revokeUserSessions(target.id);
    disconnectUser(target.id);
    return {};
  }),

  post("/members/activate", async (ctx) => {
    const target = await targetUser(ctx.user, input(await readJson(ctx)).uuid("userId"));
    await sql`UPDATE users SET deactivated_at = NULL, updated_at = now() WHERE id = ${target.id}`;
    return {};
  }),

  post("/members/delete", async (ctx) => {
    const target = await targetUser(ctx.user, input(await readJson(ctx)).uuid("userId"));
    if (target.role === "owner") {
      const [{ owners }] = await sql`SELECT count(*)::int AS owners FROM users WHERE role = 'owner'`;
      if (owners <= 1) throw forbidden("The last owner cannot be deleted");
    }
    disconnectUser(target.id);
    await sql`DELETE FROM users WHERE id = ${target.id}`;
    await removeImage(target.avatar);
    membershipChanged([target.id]);
    return {};
  }),
];
