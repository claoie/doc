import type { Invitation } from "common/api-types";
import { isUuid, token } from "common/ids";
import { config } from "server/config";
import { sql } from "server/db";
import { hashToken, sameHash, signIn } from "server/lib/auth";
import { renderMail } from "server/lib/emails";
import { HttpError, badRequest, conflict, get, notFound, post, publicGet, publicPost, readJson } from "server/lib/http";
import { sendMail } from "server/lib/mail";
import { requireWorkspaceAdmin } from "server/lib/permissions";
import { rateLimit } from "server/lib/ratelimit";
import { getWorkspace } from "server/lib/spaces";
import { hashPassword, iso, toUser, type UserRow } from "server/lib/users";
import { Input, NAME_RULE, PASSWORD_RULE, input, normalizeEmail } from "server/lib/validate";

const inviteUrl = (id: string, value: string) => `${config.appUrl}/invites/${id}?token=${encodeURIComponent(value)}`;

const invitationMail = async (email: string, url: string, inviterName: string) => {
  const workspace = await getWorkspace();
  const name = workspace.name || "a workspace";
  sendMail(
    renderMail({
      to: email,
      subject: `${inviterName} invited you to ${name}`,
      paragraphs: [`${inviterName} invited you to join ${name}.`],
      action: { label: "Accept invitation", url },
    }),
  );
};

const invalidInvitation = () => new HttpError(400, "invalid_invitation", "This invitation is invalid, expired or has been revoked");

/** Invitation links stop working this long after they were sent; resending renews them. */
const INVITATION_TTL_DAYS = 14;

/** Looks up an invitation and checks its token in constant time. */
const verifyInvitation = async (id: unknown, value: unknown) => {
  if (!isUuid(id) || typeof value !== "string" || value.length > 200) throw invalidInvitation();
  const [invitation] = await sql`
    SELECT id, email, role, group_ids::text[] AS group_ids, token_hash, invited_by FROM invitations
    WHERE id = ${id} AND created_at > now() - make_interval(days => ${INVITATION_TTL_DAYS})`;
  if (!invitation || !sameHash(invitation.token_hash, hashToken(value))) throw invalidInvitation();
  return invitation;
};

const rotate = async (id: string) => {
  const value = token();
  const [row] = await sql`UPDATE invitations SET token_hash = ${hashToken(value)}, created_at = now() WHERE id = ${id} RETURNING id, email`;
  if (!row) throw notFound("Invitation");
  return { url: inviteUrl(row.id, value), email: row.email as string };
};

export const routes = [
  get("/invitations", async (ctx): Promise<Invitation[]> => {
    requireWorkspaceAdmin(ctx.user);
    const rows = await sql`
      SELECT i.id, i.email, i.role, i.group_ids::text[] AS group_ids, i.created_at,
        u.id AS inviter_id, u.name AS inviter_name, u.avatar AS inviter_avatar
      FROM invitations i LEFT JOIN users u ON u.id = i.invited_by ORDER BY i.created_at DESC`;
    return rows.map((r: Record<string, never>) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      groupIds: r.group_ids ?? [],
      invitedBy: r.inviter_id
        ? { id: r.inviter_id, name: r.inviter_name, avatarUrl: r.inviter_avatar ? `/api/images/${r.inviter_avatar}` : null }
        : null,
      createdAt: iso(r.created_at)!,
    }));
  }),

  post("/invitations", async (ctx) => {
    requireWorkspaceAdmin(ctx.user);
    const body = input(await readJson(ctx));
    const emails = [...new Set((body.strings("emails", 50, { max: 254 }) ?? []).map(normalizeEmail))];
    if (emails.length === 0) throw badRequest("emails is required");
    const role = body.oneOf("role", ["admin", "member"] as const) ?? "member";
    const groupIds = body.uuids("groupIds", 50) ?? [];
    const workspace = await getWorkspace();
    if (workspace.emailDomains.length) {
      const outside = emails.filter((e) => !workspace.emailDomains.includes(e.split("@")[1]!));
      if (outside.length) throw badRequest(`Only ${workspace.emailDomains.join(", ")} addresses can be invited`);
    }
    const validGroups: { id: string }[] = await sql`
      SELECT id FROM groups WHERE id = ANY(${sql.array(groupIds, "uuid")}) AND NOT is_default`;
    const existing: { email: string }[] = await sql`
      SELECT lower(email) AS email FROM users WHERE lower(email) = ANY(${sql.array(emails, "text")})`;
    const members = new Set(existing.map((r) => r.email));
    const created = [];
    for (const email of emails.filter((e) => !members.has(e))) {
      const value = token();
      const [row] = await sql`
        INSERT INTO invitations (email, role, group_ids, token_hash, invited_by)
        VALUES (${email}, ${role}, ${sql.array(validGroups.map((g) => g.id), "uuid")}::uuid[], ${hashToken(value)}, ${ctx.user.id})
        ON CONFLICT (lower(email)) DO UPDATE SET
          role = excluded.role, group_ids = excluded.group_ids, token_hash = excluded.token_hash,
          invited_by = excluded.invited_by, created_at = now()
        RETURNING id`;
      const url = inviteUrl(row.id, value);
      await invitationMail(email, url, ctx.user.name);
      created.push({ id: row.id as string, email, url });
    }
    return created;
  }),

  post("/invitations/resend", async (ctx) => {
    requireWorkspaceAdmin(ctx.user);
    const { url, email } = await rotate(input(await readJson(ctx)).uuid("id"));
    await invitationMail(email, url, ctx.user.name);
    return { url };
  }),

  post("/invitations/link", async (ctx) => {
    requireWorkspaceAdmin(ctx.user);
    const { url } = await rotate(input(await readJson(ctx)).uuid("id"));
    return { url };
  }),

  post("/invitations/revoke", async (ctx) => {
    requireWorkspaceAdmin(ctx.user);
    await sql`DELETE FROM invitations WHERE id = ${input(await readJson(ctx)).uuid("id")}`;
    return {};
  }),

  publicGet("/invitations/:id", async (ctx) => {
    rateLimit("invitation-info", ctx.ip, 30);
    const invitation = await verifyInvitation(ctx.params.id, Input.query(ctx.url).raw("token"));
    const workspace = await getWorkspace();
    return { email: invitation.email, workspaceName: workspace.name };
  }),

  publicPost("/invitations/accept", async (ctx) => {
    rateLimit("invitation-accept", ctx.ip);
    const body = input(await readJson(ctx));
    const invitation = await verifyInvitation(body.raw("id"), body.raw("token"));
    const name = body.string("name", NAME_RULE);
    const passwordHash = await hashPassword(body.string("password", PASSWORD_RULE));
    const user = await sql.begin(async (tx) => {
      const [claimed] = await tx`DELETE FROM invitations WHERE id = ${invitation.id} RETURNING id`;
      if (!claimed) throw invalidInvitation();
      const [taken] = await tx`SELECT 1 FROM users WHERE lower(email) = ${invitation.email.toLowerCase()}`;
      if (taken) throw conflict("email_taken", "An account with this email already exists");
      const [created] = await tx`
        INSERT INTO users (email, name, password_hash, role, invited_by)
        VALUES (${invitation.email}, ${name}, ${passwordHash}, ${invitation.role}, ${invitation.invited_by})
        RETURNING *`;
      await tx`
        INSERT INTO group_members (group_id, user_id)
        SELECT id, ${created.id} FROM groups
        WHERE is_default OR id = ANY(${sql.array(invitation.group_ids ?? [], "uuid")})
        ON CONFLICT DO NOTHING`;
      return created as UserRow;
    });
    await signIn(ctx, user.id);
    if (invitation.invited_by) {
      const [inviter] = await sql`SELECT email, name FROM users WHERE id = ${invitation.invited_by} AND deactivated_at IS NULL`;
      if (inviter) {
        sendMail(
          renderMail({
            to: inviter.email,
            subject: `${user.name} accepted your invitation`,
            paragraphs: [`${user.name} (${user.email}) accepted your invitation and joined the workspace.`],
            action: { label: "Open workspace", url: config.appUrl },
          }),
        );
      }
    }
    return { user: toUser(user, user.id) };
  }),
];
