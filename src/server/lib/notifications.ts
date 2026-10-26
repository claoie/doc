import type { NotificationKind, UserPreferences } from "common/api-types";
import { pagePath } from "common/text";
import { config } from "server/config";
import { sql } from "server/db";
import { emitToUser } from "server/realtime/hub";
import { renderMail } from "./emails";
import { log } from "./logger";
import { sendMail } from "./mail";

const PREFERENCE: Record<NotificationKind, keyof UserPreferences> = {
  "comment.created": "notifyComments",
  "comment.reply": "notifyComments",
  "comment.mention": "notifyCommentMentions",
  "page.mention": "notifyPageMentions",
  "page.updated": "notifyPageUpdates",
};

const subject = (kind: NotificationKind, actor: string, title: string) => {
  switch (kind) {
    case "comment.created":
      return `${actor} commented on ${title}`;
    case "comment.reply":
      return `${actor} replied to a comment on ${title}`;
    case "comment.mention":
      return `${actor} mentioned you in a comment on ${title}`;
    case "page.mention":
      return `${actor} mentioned you on ${title}`;
    case "page.updated":
      return `${actor} updated ${title}`;
  }
};

export interface NotifyInput {
  kind: NotificationKind;
  recipientIds: readonly string[];
  actorId: string | null;
  pageId: string;
  commentId?: string | null;
  data?: Record<string, unknown>;
  /** Plain-text excerpt included in the email body. */
  excerpt?: string;
}

/**
 * Creates notifications for recipients who are active and can read the page
 * (the actor is never notified), pushes realtime events and queues emails
 * according to each recipient's preferences.
 */
export const notify = async (input: NotifyInput): Promise<string[]> => {
  const ids = [...new Set(input.recipientIds)].filter((id) => id !== input.actorId);
  if (ids.length === 0) return [];
  const rows: { id: string; user_id: string; email: string; preferences: UserPreferences }[] = await sql`
    WITH target AS (SELECT space_id FROM pages WHERE id = ${input.pageId} AND deleted_at IS NULL),
    inserted AS (
      INSERT INTO notifications (user_id, kind, actor_id, page_id, comment_id, data)
      SELECT u.id, ${input.kind}, ${input.actorId}, ${input.pageId}, ${input.commentId ?? null}, ${input.data ?? {}}::jsonb
      FROM users u, target t
      WHERE u.id = ANY(${sql.array(ids, "uuid")}) AND u.deactivated_at IS NULL
        AND EXISTS (
          SELECT 1 FROM space_members sm
          WHERE sm.space_id = t.space_id
            AND (sm.user_id = u.id OR sm.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = u.id))
        )
      RETURNING id, user_id
    )
    SELECT i.id, i.user_id, u.email, u.preferences FROM inserted i JOIN users u ON u.id = i.user_id`;
  for (const row of rows) emitToUser(row.user_id, { kind: "notification" });

  const recipients = rows.filter((row) => row.preferences?.[PREFERENCE[input.kind]] !== false);
  if (recipients.length > 0) {
    try {
      const [context] = await sql`
        SELECT p.title, p.slug_id, s.slug AS space_slug, (SELECT name FROM users WHERE id = ${input.actorId}) AS actor_name
        FROM pages p JOIN spaces s ON s.id = p.space_id WHERE p.id = ${input.pageId}`;
      if (context) {
        const title = context.title || "Untitled";
        const actor = context.actor_name || "Someone";
        const url = config.appUrl + pagePath(context.space_slug, context.title, context.slug_id);
        for (const recipient of recipients) {
          sendMail(
            renderMail({
              to: recipient.email,
              subject: subject(input.kind, actor, title),
              paragraphs: [subject(input.kind, actor, title) + ".", ...(input.excerpt ? [input.excerpt] : [])],
              action: { label: "Open page", url },
            }),
          );
        }
        await sql`UPDATE notifications SET emailed_at = now() WHERE id = ANY(${sql.array(recipients.map((r) => r.id), "uuid")})`;
      }
    } catch (error) {
      log.error("notification email failed", error);
    }
  }
  return rows.map((row) => row.user_id);
};

/** Adds page watchers, ignoring ones that already exist. */
export const watchPage = async (pageId: string, userIds: readonly string[]) => {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  await sql`
    INSERT INTO watchers (user_id, page_id)
    SELECT id, ${pageId} FROM users WHERE id = ANY(${sql.array(ids, "uuid")})
    ON CONFLICT (user_id, page_id) WHERE page_id IS NOT NULL DO NOTHING`;
};
