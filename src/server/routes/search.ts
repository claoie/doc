import type { Suggestions } from "common/api-types";
import { sql } from "server/db";
import { get } from "server/lib/http";
import { toTreeItem, treeColumns, type PageRow } from "server/lib/pages";
import { readableSpaceIds } from "server/lib/permissions";
import { escapeLike, searchPages } from "server/lib/search";
import { spaceRefJson } from "server/lib/spaces";
import { toUser, type UserRow } from "server/lib/users";
import { Input } from "server/lib/validate";

export const routes = [
  get("/search", async (ctx) => {
    const query = Input.query(ctx.url);
    const q = query.optionalString("q", { min: 0, max: 500 }) ?? "";
    const spaceId = query.optionalUuid("spaceId") ?? null;
    return searchPages({
      query: q,
      scope: sql`p.space_id IN ${readableSpaceIds(ctx.user.id)} AND (${spaceId}::uuid IS NULL OR p.space_id = ${spaceId}::uuid)`,
      titleOnly: query.boolean("titleOnly") ?? false,
      limit: query.integer("limit", 1, 50) ?? 20,
      offset: query.integer("offset", 0, 10_000) ?? 0,
    });
  }),

  get("/search/suggest", async (ctx): Promise<Suggestions> => {
    const query = Input.query(ctx.url);
    const q = (query.optionalString("q", { min: 0, max: 100 }) ?? "").toLowerCase();
    const spaceId = query.optionalUuid("spaceId") ?? null;
    const limit = query.integer("limit", 1, 25) ?? 10;
    const wantUsers = query.boolean("users") ?? !query.has("pages");
    const wantPages = query.boolean("pages") ?? !query.has("users");
    const contains = `%${escapeLike(q)}%`;
    const prefix = `${escapeLike(q)}%`;
    const users: UserRow[] = wantUsers
      ? await sql`
          SELECT * FROM users u
          WHERE u.deactivated_at IS NULL AND (lower(u.name) LIKE ${contains} OR lower(u.email) LIKE ${contains})
          ORDER BY lower(u.name) LIKE ${prefix} DESC, lower(u.name), u.id LIMIT ${limit}`
      : [];
    const pages = wantPages
      ? await sql`
          SELECT ${treeColumns()}, ${spaceRefJson("s")} AS space
          FROM pages p JOIN spaces s ON s.id = p.space_id
          WHERE p.deleted_at IS NULL AND p.space_id IN ${readableSpaceIds(ctx.user.id)}
            AND (${spaceId}::uuid IS NULL OR p.space_id = ${spaceId}::uuid)
            AND lower(coalesce(p.title, '')) LIKE ${contains}
          ORDER BY lower(coalesce(p.title, '')) LIKE ${prefix} DESC, p.updated_at DESC, p.id LIMIT ${limit}`
      : [];
    return {
      users: users.map((u) => toUser(u, ctx.user.id)),
      pages: pages.map((r: PageRow & { space: Suggestions["pages"][number]["space"] }) => ({ ...toTreeItem(r), space: r.space })),
    };
  }),
];
