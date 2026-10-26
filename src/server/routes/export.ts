import { isUuid } from "common/ids";
import { exportPages, type ExportFormat } from "server/lib/export";
import { get, notFound } from "server/lib/http";
import { requirePage } from "server/lib/pages";
import { requireSpaceRole } from "server/lib/permissions";
import { findSpace } from "server/lib/spaces";
import { Input } from "server/lib/validate";

const FORMATS: readonly ExportFormat[] = ["markdown", "html"];

export const routes = [
  get("/pages/:id/export", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "reader");
    const query = Input.query(ctx.url);
    return exportPages({
      userId: ctx.user.id,
      format: query.oneOf("format", FORMATS) ?? "markdown",
      includeFiles: query.boolean("files") ?? false,
      children: query.boolean("children") ?? false,
      pageId: page.id,
      spaceId: page.space_id,
      archiveName: page.title || "Untitled",
    });
  }),

  get("/spaces/:id/export", async (ctx) => {
    if (!isUuid(ctx.params.id)) throw notFound("Space");
    await requireSpaceRole(ctx.user, ctx.params.id, "admin");
    const space = await findSpace(ctx.user.id, ctx.params.id);
    const query = Input.query(ctx.url);
    return exportPages({
      userId: ctx.user.id,
      format: query.oneOf("format", FORMATS) ?? "markdown",
      includeFiles: query.boolean("files") ?? false,
      children: true,
      pageId: null,
      spaceId: space!.id,
      archiveName: space!.name,
    });
  }),
];
