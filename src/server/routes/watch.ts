import { isUuid } from "common/ids";
import { sql } from "server/db";
import { badRequest, get, notFound, post, readJson, type AuthedContext } from "server/lib/http";
import { watchPage } from "server/lib/notifications";
import { requirePage } from "server/lib/pages";
import { requireSpaceRole } from "server/lib/permissions";
import { input } from "server/lib/validate";

const watchingFlag = async (ctx: AuthedContext) => {
  const watching = input(await readJson(ctx)).boolean("watching");
  if (watching === undefined) throw badRequest("watching is required");
  return watching;
};

const spaceIdParam = (value: string | undefined) => {
  if (!isUuid(value)) throw notFound("Space");
  return value.toLowerCase();
};

export const routes = [
  get("/pages/:id/watch", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "reader");
    const [row] = await sql`SELECT 1 FROM watchers WHERE user_id = ${ctx.user.id} AND page_id = ${page.id}`;
    return { watching: !!row };
  }),

  post("/pages/:id/watch", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "reader");
    if (await watchingFlag(ctx)) await watchPage(page.id, [ctx.user.id]);
    else await sql`DELETE FROM watchers WHERE user_id = ${ctx.user.id} AND page_id = ${page.id}`;
    return {};
  }),

  get("/spaces/:id/watch", async (ctx) => {
    const spaceId = spaceIdParam(ctx.params.id);
    await requireSpaceRole(ctx.user, spaceId, "reader");
    const [row] = await sql`SELECT 1 FROM watchers WHERE user_id = ${ctx.user.id} AND space_id = ${spaceId}`;
    return { watching: !!row };
  }),

  post("/spaces/:id/watch", async (ctx) => {
    const spaceId = spaceIdParam(ctx.params.id);
    await requireSpaceRole(ctx.user, spaceId, "reader");
    if (await watchingFlag(ctx)) {
      await sql`
        INSERT INTO watchers (user_id, space_id) VALUES (${ctx.user.id}, ${spaceId})
        ON CONFLICT (user_id, space_id) WHERE space_id IS NOT NULL DO NOTHING`;
    } else {
      await sql`DELETE FROM watchers WHERE user_id = ${ctx.user.id} AND space_id = ${spaceId}`;
    }
    return {};
  }),
];
