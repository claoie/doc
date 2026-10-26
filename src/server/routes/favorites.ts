import type { Favorites } from "common/api-types";
import { sql } from "server/db";
import { badRequest, get, post, readJson } from "server/lib/http";
import { requirePage, toTreeItem, treeColumns, type PageRow } from "server/lib/pages";
import { readableSpaceIds, requireSpaceRole } from "server/lib/permissions";
import { spaceQuery, spaceRefJson, toSpace } from "server/lib/spaces";
import { input, type Input } from "server/lib/validate";
import type { AuthUser } from "server/lib/auth";

/** Resolves `{ pageId } | { spaceId }` to a target the user can read. */
const target = async (user: AuthUser, body: Input) => {
  const pageId = body.optionalUuid("pageId");
  const spaceId = body.optionalUuid("spaceId");
  if (pageId && !spaceId) return { pageId: (await requirePage(user, pageId, "reader")).page.id, spaceId: null };
  if (spaceId && !pageId) {
    await requireSpaceRole(user, spaceId, "reader");
    return { pageId: null, spaceId };
  }
  throw badRequest("Provide either pageId or spaceId");
};

export const routes = [
  get("/favorites", async (ctx): Promise<Favorites> => {
    const pages = await sql`
      SELECT ${treeColumns()}, ${spaceRefJson("s")} AS space
      FROM favorites f JOIN pages p ON p.id = f.page_id JOIN spaces s ON s.id = p.space_id
      WHERE f.user_id = ${ctx.user.id} AND p.deleted_at IS NULL AND p.space_id IN ${readableSpaceIds(ctx.user.id)}
      ORDER BY f.created_at`;
    const spaces = await sql`
      SELECT s.* FROM (${spaceQuery(ctx.user.id)}) s JOIN favorites f ON f.space_id = s.id
      WHERE f.user_id = ${ctx.user.id} AND s.rank IS NOT NULL ORDER BY f.created_at`;
    return {
      pages: pages.map((r: PageRow & { space: Favorites["pages"][number]["space"] }) => ({ ...toTreeItem(r), space: r.space })),
      spaces: spaces.map(toSpace),
    };
  }),

  post("/favorites", async (ctx) => {
    const { pageId, spaceId } = await target(ctx.user, input(await readJson(ctx)));
    if (pageId) {
      await sql`
        INSERT INTO favorites (user_id, page_id) VALUES (${ctx.user.id}, ${pageId})
        ON CONFLICT (user_id, page_id) WHERE page_id IS NOT NULL DO NOTHING`;
    } else {
      await sql`
        INSERT INTO favorites (user_id, space_id) VALUES (${ctx.user.id}, ${spaceId})
        ON CONFLICT (user_id, space_id) WHERE space_id IS NOT NULL DO NOTHING`;
    }
    return {};
  }),

  post("/favorites/remove", async (ctx) => {
    const body = input(await readJson(ctx));
    const pageId = body.optionalUuid("pageId");
    const spaceId = body.optionalUuid("spaceId");
    if (pageId) await sql`DELETE FROM favorites WHERE user_id = ${ctx.user.id} AND page_id = ${pageId}`;
    else if (spaceId) await sql`DELETE FROM favorites WHERE user_id = ${ctx.user.id} AND space_id = ${spaceId}`;
    else throw badRequest("Provide either pageId or spaceId");
    return {};
  }),
];
