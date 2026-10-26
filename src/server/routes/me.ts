import type { UserPreferences } from "common/api-types";
import { sql } from "server/db";
import { removeImage, saveImage } from "server/lib/files";
import { HttpError, badRequest, conflict, formFile, get, post, readForm, readJson } from "server/lib/http";
import { isWorkspaceAdmin } from "server/lib/permissions";
import { getWorkspace } from "server/lib/spaces";
import { findUserById, toUser, verifyPassword } from "server/lib/users";
import { EMAIL_RULE, NAME_RULE, input, normalizeEmail } from "server/lib/validate";

const BOOLEAN_PREFERENCES = [
  "fullPageWidth",
  "editorToolbar",
  "notifyPageUpdates",
  "notifyPageMentions",
  "notifyCommentMentions",
  "notifyComments",
] as const;

/** Keeps known preference keys with valid values; `null` clears a key. */
const parsePreferences = (raw: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of BOOLEAN_PREFERENCES) {
    const value = raw[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "boolean") throw badRequest(`preferences.${key} must be a boolean`);
    out[key] = value;
  }
  if (raw.pageEditMode !== undefined) {
    if (raw.pageEditMode !== null && raw.pageEditMode !== "read" && raw.pageEditMode !== "edit") {
      throw badRequest("preferences.pageEditMode must be read or edit");
    }
    out.pageEditMode = raw.pageEditMode;
  }
  if (raw.theme !== undefined) {
    if (raw.theme !== null && (typeof raw.theme !== "string" || !/^[a-z-]{1,20}$/.test(raw.theme))) {
      throw badRequest("preferences.theme is invalid");
    }
    out.theme = raw.theme;
  }
  return out;
};

const validTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export const routes = [
  get("/me", async (ctx) => ({ user: toUser(ctx.user, ctx.user.id), workspace: await getWorkspace() })),

  post("/me/update", async (ctx) => {
    const body = input(await readJson(ctx));
    const name = body.optionalString("name", NAME_RULE);
    const emailInput = body.optionalString("email", EMAIL_RULE);
    const locale = body.nullableString("locale", { max: 20 });
    const timezone = body.nullableString("timezone", { max: 64 });
    const preferencesInput = body.object("preferences");
    if (locale && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) throw badRequest("Invalid locale");
    if (timezone && !validTimezone(timezone)) throw badRequest("Invalid timezone");
    const preferences: Partial<UserPreferences> | null = preferencesInput ? parsePreferences(preferencesInput) : null;

    let email: string | undefined;
    if (emailInput !== undefined) {
      email = normalizeEmail(emailInput);
      if (email !== ctx.user.email.toLowerCase()) {
        const password = body.optionalString("currentPassword", { max: 200, trim: false });
        const [row] = await sql`SELECT password_hash FROM users WHERE id = ${ctx.user.id}`;
        if (!password || !(await verifyPassword(password, row?.password_hash ?? null))) {
          throw new HttpError(400, "invalid_password", "Current password is incorrect");
        }
        const { emailDomains } = await getWorkspace();
        if (emailDomains.length && !isWorkspaceAdmin(ctx.user) && !emailDomains.includes(email.split("@")[1]!)) {
          throw badRequest(`Only ${emailDomains.join(", ")} addresses are allowed in this workspace`);
        }
        const [taken] = await sql`SELECT 1 FROM users WHERE lower(email) = ${email} AND id <> ${ctx.user.id}`;
        if (taken) throw conflict("email_taken", "That email is already in use");
      }
    }

    await sql`
      UPDATE users SET
        name = COALESCE(${name ?? null}, name),
        email = COALESCE(${email ?? null}, email),
        locale = CASE WHEN ${locale !== undefined} THEN ${locale ?? null} ELSE locale END,
        timezone = CASE WHEN ${timezone !== undefined} THEN ${timezone ?? null} ELSE timezone END,
        preferences = CASE WHEN ${preferences !== null} THEN jsonb_strip_nulls(preferences || ${preferences ?? {}}::jsonb) ELSE preferences END,
        updated_at = now()
      WHERE id = ${ctx.user.id}`;
    const user = await findUserById(ctx.user.id);
    return { user: toUser(user!, ctx.user.id) };
  }),

  post("/me/avatar", async (ctx) => {
    const form = await readForm(ctx, 11 * 1024 * 1024);
    const name = await saveImage(formFile(form), "avatar", ctx.user.id);
    const [previous] = await sql`
      UPDATE users u SET avatar = ${name}, updated_at = now() FROM users old
      WHERE u.id = ${ctx.user.id} AND old.id = u.id RETURNING old.avatar`;
    await removeImage(previous?.avatar);
    const user = await findUserById(ctx.user.id);
    return { user: toUser(user!, ctx.user.id) };
  }),

  post("/me/avatar/remove", async (ctx) => {
    await sql`UPDATE users SET avatar = NULL, updated_at = now() WHERE id = ${ctx.user.id}`;
    await removeImage(ctx.user.avatar);
    const user = await findUserById(ctx.user.id);
    return { user: toUser(user!, ctx.user.id) };
  }),
];
