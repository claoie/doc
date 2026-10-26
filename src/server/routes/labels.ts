import type { Label, LabelWithCount } from "common/api-types";
import { isUuid } from "common/ids";
import { sql } from "server/db";
import { badRequest, get, notFound, post, readJson } from "server/lib/http";
import { requirePage, toTreeItem, treeColumns, type PageRow } from "server/lib/pages";
import { readableSpaceIds } from "server/lib/permissions";
import { escapeLike } from "server/lib/search";
import { spaceRefJson } from "server/lib/spaces";
import { Input, input } from "server/lib/validate";

/** Trimmed, lower-cased, whitespace runs become `-`. */
export const normalizeLabel = (name: string) =>
  [...name.trim().toLowerCase().replace(/\s+/g, "-")].slice(0, 50).join("").replace(/-+$/, "");

const pageLabels = async (pageId: string): Promise<Label[]> =>
  sql`
    SELECT l.id, l.name FROM page_labels pl JOIN labels l ON l.id = pl.label_id
    WHERE pl.page_id = ${pageId} ORDER BY l.name`;

export const routes = [
  get("/pages/:id/labels", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "reader");
    return pageLabels(page.id);
  }),

  post("/pages/:id/labels", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "writer");
    const names = [...new Set((input(await readJson(ctx)).strings("names", 25, { max: 100 }) ?? []).map(normalizeLabel))].filter(
      Boolean,
    );
    if (names.length === 0) throw badRequest("names is required");
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO labels (name) SELECT unnest(${sql.array(names, "text")}::text[]) ON CONFLICT (name) DO NOTHING`;
      await tx`
        INSERT INTO page_labels (page_id, label_id)
        SELECT ${page.id}, id FROM labels WHERE name = ANY(${sql.array(names, "text")})
        ON CONFLICT DO NOTHING`;
    });
    return pageLabels(page.id);
  }),

  post("/pages/:id/labels/remove", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "writer");
    const labelId = input(await readJson(ctx)).uuid("labelId");
    await sql`DELETE FROM page_labels WHERE page_id = ${page.id} AND label_id = ${labelId}`;
    await sql`DELETE FROM labels l WHERE l.id = ${labelId} AND NOT EXISTS (SELECT 1 FROM page_labels WHERE label_id = l.id)`;
    return {};
  }),

  get("/labels", async (ctx): Promise<LabelWithCount[]> => {
    const q = normalizeLabel(Input.query(ctx.url).optionalString("query", { min: 0, max: 100 }) ?? "");
    const rows = await sql`
      SELECT l.id, l.name, count(p.id)::int AS page_count
      FROM labels l
      JOIN page_labels pl ON pl.label_id = l.id
      JOIN pages p ON p.id = pl.page_id AND p.deleted_at IS NULL AND p.space_id IN ${readableSpaceIds(ctx.user.id)}
      WHERE ${q} = '' OR l.name LIKE ${`%${escapeLike(q)}%`}
      GROUP BY l.id ORDER BY count(p.id) DESC, l.name LIMIT 200`;
    return rows.map((r: { id: string; name: string; page_count: number }) => ({ id: r.id, name: r.name, pageCount: r.page_count }));
  }),

  get("/labels/:id/pages", async (ctx) => {
    if (!isUuid(ctx.params.id)) throw notFound("Label");
    const rows = await sql`
      SELECT ${treeColumns()}, ${spaceRefJson("s")} AS space
      FROM page_labels pl JOIN pages p ON p.id = pl.page_id JOIN spaces s ON s.id = p.space_id
      WHERE pl.label_id = ${ctx.params.id} AND p.deleted_at IS NULL AND p.space_id IN ${readableSpaceIds(ctx.user.id)}
      ORDER BY p.updated_at DESC, p.id LIMIT 500`;
    return rows.map((r: PageRow & { space: unknown }) => ({ ...toTreeItem(r), space: r.space }));
  }),
];
