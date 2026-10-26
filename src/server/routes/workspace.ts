import { sql } from "server/db";
import { removeImage, saveImage } from "server/lib/files";
import { badRequest, formFile, post, publicGet, readForm, readJson } from "server/lib/http";
import { requireWorkspaceAdmin } from "server/lib/permissions";
import { getWorkspace } from "server/lib/spaces";
import { imageUrl } from "server/lib/users";
import { input } from "server/lib/validate";

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const parseSettings = (raw: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  if (raw.sharingDisabled !== undefined) {
    if (typeof raw.sharingDisabled !== "boolean") throw badRequest("settings.sharingDisabled must be a boolean");
    out.sharingDisabled = raw.sharingDisabled;
  }
  if (raw.trashRetentionDays !== undefined) {
    const days = raw.trashRetentionDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650) {
      throw badRequest("settings.trashRetentionDays must be an integer between 1 and 3650");
    }
    out.trashRetentionDays = days;
  }
  if (raw.defaultPageEditMode !== undefined) {
    if (raw.defaultPageEditMode !== "read" && raw.defaultPageEditMode !== "edit") {
      throw badRequest("settings.defaultPageEditMode must be read or edit");
    }
    out.defaultPageEditMode = raw.defaultPageEditMode;
  }
  return out;
};

export const routes = [
  publicGet("/workspace/public", async () => {
    const [row] = await sql`SELECT name, logo FROM workspace WHERE id = 1`;
    return { name: row?.name ?? "", logoUrl: imageUrl(row?.logo) };
  }),

  post("/workspace/update", async (ctx) => {
    requireWorkspaceAdmin(ctx.user);
    const body = input(await readJson(ctx));
    const name = body.optionalString("name", { max: 100 });
    const description = body.nullableString("description", { max: 500 });
    const domains = body.strings("emailDomains", 50, { max: 253 })?.map((d) => d.toLowerCase().replace(/^@/, ""));
    if (domains?.some((d) => !DOMAIN_RE.test(d))) throw badRequest("emailDomains must contain valid domain names");
    const settingsInput = body.object("settings");
    const settings = settingsInput ? parseSettings(settingsInput) : null;
    await sql`
      UPDATE workspace SET
        name = COALESCE(${name ?? null}, name),
        description = CASE WHEN ${description !== undefined} THEN ${description ?? null} ELSE description END,
        email_domains = COALESCE(${domains ? sql.array([...new Set(domains)], "text") : null}::text[], email_domains),
        settings = settings || ${settings ?? {}}::jsonb,
        updated_at = now()
      WHERE id = 1`;
    return { workspace: await getWorkspace() };
  }),

  post("/workspace/logo", async (ctx) => {
    requireWorkspaceAdmin(ctx.user);
    const form = await readForm(ctx, 11 * 1024 * 1024);
    const name = await saveImage(formFile(form), "workspace-logo", ctx.user.id);
    const [previous] = await sql`
      UPDATE workspace w SET logo = ${name}, updated_at = now() FROM workspace old
      WHERE w.id = 1 AND old.id = 1 RETURNING old.logo`;
    await removeImage(previous?.logo);
    return { workspace: await getWorkspace() };
  }),

  post("/workspace/logo/remove", async (ctx) => {
    requireWorkspaceAdmin(ctx.user);
    const [previous] = await sql`SELECT logo FROM workspace WHERE id = 1`;
    await sql`UPDATE workspace SET logo = NULL, updated_at = now() WHERE id = 1`;
    await removeImage(previous?.logo);
    return { workspace: await getWorkspace() };
  }),
];
