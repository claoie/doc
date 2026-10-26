import type { SpaceMember, SpaceRole } from "common/api-types";
import { isUuid } from "common/ids";
import { sql } from "server/db";
import { removeImage, saveImage } from "server/lib/files";
import { HttpError, badRequest, conflict, forbidden, formFile, get, notFound, post, readForm, readJson } from "server/lib/http";
import { isWorkspaceAdmin, requireSpaceManager, requireWorkspaceAdmin } from "server/lib/permissions";
import { findSpace, spaceQuery, toSpace, type SpaceRow } from "server/lib/spaces";
import { storage } from "server/lib/storage";
import { toUser, type UserRow } from "server/lib/users";
import { input } from "server/lib/validate";
import { membershipChanged } from "server/realtime/hub";
import { toGroup } from "./groups";

const ROLES: readonly SpaceRole[] = ["admin", "writer", "reader"];
const SLUG_RULE = { min: 2, max: 50 };
const SLUG_RE = /^[a-z0-9-]{2,50}$/;

const parseSlug = (value: string) => {
  const slug = value.toLowerCase();
  if (!SLUG_RE.test(slug)) throw badRequest("slug must be 2–50 characters of a-z, 0-9 and -");
  return slug;
};

const isUniqueViolation = (error: unknown) => (error as { errno?: string })?.errno === "23505";

const spaceById = async (userId: string, id: string): Promise<SpaceRow> => {
  if (!isUuid(id)) throw notFound("Space");
  const space = await findSpace(userId, id);
  if (!space) throw notFound("Space");
  return space;
};

/** User ids affected by a space membership row (the user, or every member of the group). */
const affectedUsers = async (spaceMemberIds: string[]): Promise<string[]> => {
  const rows: { user_id: string }[] = await sql`
    SELECT sm.user_id FROM space_members sm WHERE sm.id = ANY(${sql.array(spaceMemberIds, "uuid")}) AND sm.user_id IS NOT NULL
    UNION
    SELECT gm.user_id FROM space_members sm JOIN group_members gm ON gm.group_id = sm.group_id
    WHERE sm.id = ANY(${sql.array(spaceMemberIds, "uuid")})`;
  return rows.map((r) => r.user_id);
};

export const routes = [
  get("/spaces", async (ctx) => {
    const rows = await sql`
      SELECT * FROM (${spaceQuery(ctx.user.id)}) s WHERE s.rank IS NOT NULL ORDER BY lower(s.name), s.id`;
    return rows.map(toSpace);
  }),

  get("/spaces/all", async (ctx) => {
    requireWorkspaceAdmin(ctx.user);
    const rows = await sql`${spaceQuery(ctx.user.id)} ORDER BY lower(s.name), s.id`;
    return rows.map(toSpace);
  }),

  post("/spaces", async (ctx) => {
    const body = input(await readJson(ctx));
    const name = body.string("name", { max: 100 });
    const slug = parseSlug(body.string("slug", SLUG_RULE));
    const description = body.nullableString("description", { max: 500 }) ?? null;
    try {
      const id = await sql.begin(async (tx) => {
        const [space] = await tx`
          INSERT INTO spaces (name, slug, description, created_by) VALUES (${name}, ${slug}, ${description}, ${ctx.user.id})
          RETURNING id`;
        await tx`
          INSERT INTO space_members (space_id, user_id, role, added_by) VALUES (${space.id}, ${ctx.user.id}, 'admin', ${ctx.user.id})`;
        return space.id as string;
      });
      membershipChanged([ctx.user.id]);
      return { space: toSpace(await spaceById(ctx.user.id, id)) };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("slug_taken", "That slug is already in use");
      throw error;
    }
  }),

  get("/spaces/:space", async (ctx) => {
    const space = await findSpace(ctx.user.id, ctx.params.space!);
    if (!space || (space.rank === null && !isWorkspaceAdmin(ctx.user))) throw notFound("Space");
    return { space: toSpace(space) };
  }),

  post("/spaces/:id/update", async (ctx) => {
    const space = await spaceById(ctx.user.id, ctx.params.id!);
    await requireSpaceManager(ctx.user, space.id);
    const body = input(await readJson(ctx));
    const name = body.optionalString("name", { max: 100 });
    const slugInput = body.optionalString("slug", SLUG_RULE);
    const slug = slugInput === undefined ? undefined : parseSlug(slugInput);
    const description = body.nullableString("description", { max: 500 });
    const settingsInput = body.object("settings");
    const settings: Record<string, unknown> = {};
    if (settingsInput?.sharingDisabled !== undefined) {
      if (typeof settingsInput.sharingDisabled !== "boolean") throw badRequest("settings.sharingDisabled must be a boolean");
      settings.sharingDisabled = settingsInput.sharingDisabled;
    }
    try {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE spaces SET
            name = COALESCE(${name ?? null}, name),
            slug = COALESCE(${slug ?? null}, slug),
            description = CASE WHEN ${description !== undefined} THEN ${description ?? null} ELSE description END,
            settings = settings || ${settings}::jsonb,
            updated_at = now()
          WHERE id = ${space.id}`;
        if (settings.sharingDisabled === true) {
          await tx`DELETE FROM shares WHERE page_id IN (SELECT id FROM pages WHERE space_id = ${space.id})`;
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("slug_taken", "That slug is already in use");
      throw error;
    }
    return { space: toSpace(await spaceById(ctx.user.id, space.id)) };
  }),

  post("/spaces/:id/delete", async (ctx) => {
    const space = await spaceById(ctx.user.id, ctx.params.id!);
    await requireSpaceManager(ctx.user, space.id);
    const members = await sql`SELECT id FROM space_members WHERE space_id = ${space.id}`;
    const affected = await affectedUsers(members.map((m: { id: string }) => m.id));
    const rows: { storage_key: string }[] = await sql`
      WITH removed_files AS (
        DELETE FROM files WHERE space_id = ${space.id} OR page_id IN (SELECT id FROM pages WHERE space_id = ${space.id})
        RETURNING storage_key
      ),
      removed_space AS (DELETE FROM spaces WHERE id = ${space.id})
      SELECT storage_key FROM removed_files`;
    await storage.removeMany(rows.map((r) => r.storage_key));
    membershipChanged(affected);
    return {};
  }),

  post("/spaces/:id/icon", async (ctx) => {
    const space = await spaceById(ctx.user.id, ctx.params.id!);
    await requireSpaceManager(ctx.user, space.id);
    const form = await readForm(ctx, 11 * 1024 * 1024);
    const name = await saveImage(formFile(form), "space-icon", ctx.user.id, space.id);
    await sql`UPDATE spaces SET icon = ${name}, updated_at = now() WHERE id = ${space.id}`;
    await removeImage(space.icon);
    return { space: toSpace(await spaceById(ctx.user.id, space.id)) };
  }),

  post("/spaces/:id/icon/remove", async (ctx) => {
    const space = await spaceById(ctx.user.id, ctx.params.id!);
    await requireSpaceManager(ctx.user, space.id);
    await sql`UPDATE spaces SET icon = NULL, updated_at = now() WHERE id = ${space.id}`;
    await removeImage(space.icon);
    return { space: toSpace(await spaceById(ctx.user.id, space.id)) };
  }),

  get("/spaces/:id/members", async (ctx): Promise<SpaceMember[]> => {
    const space = await spaceById(ctx.user.id, ctx.params.id!);
    if (space.rank === null && !isWorkspaceAdmin(ctx.user)) throw notFound("Space");
    const rows = await sql`
      SELECT sm.id, sm.role,
        CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object(
          'id', u.id, 'email', u.email, 'name', u.name, 'avatar', u.avatar, 'role', u.role, 'locale', u.locale,
          'timezone', u.timezone, 'preferences', '{}'::json, 'created_at', u.created_at,
          'last_login_at', u.last_login_at, 'deactivated_at', u.deactivated_at) END AS "user",
        CASE WHEN g.id IS NULL THEN NULL ELSE json_build_object(
          'id', g.id, 'name', g.name, 'description', g.description, 'is_default', g.is_default,
          'member_count', (SELECT count(*) FROM group_members gm WHERE gm.group_id = g.id)) END AS "group"
      FROM space_members sm
      LEFT JOIN users u ON u.id = sm.user_id
      LEFT JOIN groups g ON g.id = sm.group_id
      WHERE sm.space_id = ${space.id}
      ORDER BY sm.group_id IS NULL, lower(coalesce(g.name, u.name)), sm.id`;
    return rows.map((r: { id: string; role: SpaceRole; user: UserRow | null; group: Parameters<typeof toGroup>[0] | null }) => ({
      id: r.id,
      role: r.role,
      ...(r.user ? { user: toUser(r.user, ctx.user.id) } : {}),
      ...(r.group ? { group: toGroup(r.group) } : {}),
    }));
  }),

  post("/spaces/:id/members/add", async (ctx) => {
    const space = await spaceById(ctx.user.id, ctx.params.id!);
    await requireSpaceManager(ctx.user, space.id);
    const body = input(await readJson(ctx));
    const role = body.oneOf("role", ROLES);
    if (!role) throw badRequest("role is required");
    const userIds = body.uuids("userIds", 25) ?? [];
    const groupIds = body.uuids("groupIds", 25) ?? [];
    if (!userIds.length && !groupIds.length) throw badRequest("userIds or groupIds is required");
    await sql.begin(async (tx) => {
      if (userIds.length) {
        await tx`
          INSERT INTO space_members (space_id, user_id, role, added_by)
          SELECT ${space.id}, id, ${role}, ${ctx.user.id} FROM users WHERE id = ANY(${sql.array(userIds, "uuid")})
          ON CONFLICT (space_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET role = excluded.role`;
      }
      if (groupIds.length) {
        await tx`
          INSERT INTO space_members (space_id, group_id, role, added_by)
          SELECT ${space.id}, id, ${role}, ${ctx.user.id} FROM groups WHERE id = ANY(${sql.array(groupIds, "uuid")})
          ON CONFLICT (space_id, group_id) WHERE group_id IS NOT NULL DO UPDATE SET role = excluded.role`;
      }
    });
    const groupUsers: { user_id: string }[] = await sql`
      SELECT user_id FROM group_members WHERE group_id = ANY(${sql.array(groupIds, "uuid")})`;
    membershipChanged([...userIds, ...groupUsers.map((r) => r.user_id)]);
    return {};
  }),

  post("/spaces/:id/members/role", async (ctx) => {
    const space = await spaceById(ctx.user.id, ctx.params.id!);
    await requireSpaceManager(ctx.user, space.id);
    const body = input(await readJson(ctx));
    const memberId = body.uuid("memberId");
    const role = body.oneOf("role", ROLES);
    if (!role) throw badRequest("role is required");
    await sql.begin(async (tx) => {
      const [member] = await tx`SELECT id, role FROM space_members WHERE id = ${memberId} AND space_id = ${space.id} FOR UPDATE`;
      if (!member) throw notFound("Space member");
      if (member.role === "admin" && role !== "admin") {
        const [{ admins }] = await tx`SELECT count(*)::int AS admins FROM space_members WHERE space_id = ${space.id} AND role = 'admin'`;
        if (admins <= 1) throw forbidden("The last space admin cannot be demoted");
      }
      await tx`UPDATE space_members SET role = ${role} WHERE id = ${memberId}`;
    });
    membershipChanged(await affectedUsers([memberId]));
    return {};
  }),

  post("/spaces/:id/members/remove", async (ctx) => {
    const space = await spaceById(ctx.user.id, ctx.params.id!);
    await requireSpaceManager(ctx.user, space.id);
    const memberId = input(await readJson(ctx)).uuid("memberId");
    const affected = await affectedUsers([memberId]);
    await sql.begin(async (tx) => {
      const [member] = await tx`SELECT id, role FROM space_members WHERE id = ${memberId} AND space_id = ${space.id} FOR UPDATE`;
      if (!member) throw notFound("Space member");
      if (member.role === "admin") {
        const [{ admins }] = await tx`SELECT count(*)::int AS admins FROM space_members WHERE space_id = ${space.id} AND role = 'admin'`;
        if (admins <= 1) throw new HttpError(403, "forbidden", "The last space admin cannot be removed");
      }
      await tx`DELETE FROM space_members WHERE id = ${memberId}`;
    });
    membershipChanged(affected);
    return {};
  }),
];
