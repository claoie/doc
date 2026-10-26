import type { Notification } from "common/api-types";
import { sql } from "server/db";
import { badRequest, get, post, readJson } from "server/lib/http";
import { readableSpaceIds } from "server/lib/permissions";
import { iso, userRefJson } from "server/lib/users";
import { Input, input } from "server/lib/validate";

export const routes = [
  get("/notifications", async (ctx): Promise<Notification[]> => {
    const query = Input.query(ctx.url);
    const limit = query.integer("limit", 1, 100) ?? 30;
    const offset = query.integer("offset", 0, 100_000) ?? 0;
    const unreadOnly = query.boolean("unread") ?? false;
    const rows = await sql`
      SELECT n.id, n.kind, n.data, n.created_at, n.read_at, ${sql.unsafe(userRefJson("a"))} AS actor,
        CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object(
          'id', p.id, 'slugId', p.slug_id, 'title', p.title, 'icon', p.icon, 'spaceId', p.space_id, 'spaceSlug', s.slug) END AS page,
        CASE WHEN c.id IS NULL OR p.id IS NULL THEN NULL ELSE json_build_object('id', c.id, 'parentId', c.parent_id) END AS comment
      FROM notifications n
      LEFT JOIN users a ON a.id = n.actor_id
      LEFT JOIN pages p ON p.id = n.page_id AND p.deleted_at IS NULL AND p.space_id IN ${readableSpaceIds(ctx.user.id)}
      LEFT JOIN spaces s ON s.id = p.space_id
      LEFT JOIN comments c ON c.id = n.comment_id
      WHERE n.user_id = ${ctx.user.id} AND (NOT ${unreadOnly} OR n.read_at IS NULL)
      ORDER BY n.created_at DESC, n.id LIMIT ${limit} OFFSET ${offset}`;
    return rows.map((r: Record<string, unknown> & { created_at: Date; read_at: Date | null }) => ({
      id: r.id as string,
      kind: r.kind as Notification["kind"],
      actor: r.actor as Notification["actor"],
      page: r.page as Notification["page"],
      comment: r.comment as Notification["comment"],
      data: (r.data as Record<string, unknown>) ?? {},
      createdAt: iso(r.created_at)!,
      readAt: iso(r.read_at),
    }));
  }),

  get("/notifications/unread-count", async (ctx) => {
    const [row] = await sql`SELECT count(*)::int AS count FROM notifications WHERE user_id = ${ctx.user.id} AND read_at IS NULL`;
    return { count: row.count };
  }),

  post("/notifications/read", async (ctx) => {
    const ids = input(await readJson(ctx)).uuids("ids", 500);
    if (!ids) throw badRequest("ids is required");
    if (ids.length) {
      await sql`
        UPDATE notifications SET read_at = now()
        WHERE user_id = ${ctx.user.id} AND id = ANY(${sql.array(ids, "uuid")}) AND read_at IS NULL`;
    }
    return {};
  }),

  post("/notifications/read-all", async (ctx) => {
    await sql`UPDATE notifications SET read_at = now() WHERE user_id = ${ctx.user.id} AND read_at IS NULL`;
    return {};
  }),
];
