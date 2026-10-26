import type { Comment } from "common/api-types";
import type { Node } from "common/editor/model";
import { isUuid } from "common/ids";
import { docMentionedUserIds, docText } from "common/text";
import { sql } from "server/db";
import { validateDoc } from "server/lib/content";
import { badRequest, forbidden, get, notFound, post, readJson } from "server/lib/http";
import { log } from "server/lib/logger";
import { notify, watchPage } from "server/lib/notifications";
import { requirePage } from "server/lib/pages";
import { hasRole } from "server/lib/permissions";
import { iso, userRefJson } from "server/lib/users";
import { input } from "server/lib/validate";
import { emitToPage } from "server/realtime/hub";
import type { AuthUser } from "server/lib/auth";

interface CommentRow {
  id: string;
  page_id: string;
  parent_id: string | null;
  author_id: string | null;
  author: Comment["author"];
  body: Node;
  quote: string | null;
  anchored: boolean;
  created_at: Date;
  edited_at: Date | null;
  resolved_at: Date | null;
  resolver: Comment["resolvedBy"];
}

const commentQuery = () => sql`
  SELECT c.id, c.page_id, c.parent_id, c.author_id, c.body, c.quote, c.anchored, c.created_at, c.edited_at, c.resolved_at,
    ${sql.unsafe(userRefJson("a"))} AS author, ${sql.unsafe(userRefJson("r"))} AS resolver
  FROM comments c LEFT JOIN users a ON a.id = c.author_id LEFT JOIN users r ON r.id = c.resolved_by`;

const toComment = (row: CommentRow): Comment => ({
  id: row.id,
  pageId: row.page_id,
  parentId: row.parent_id,
  author: row.author,
  body: row.body,
  quote: row.quote,
  anchored: row.anchored,
  createdAt: iso(row.created_at)!,
  editedAt: iso(row.edited_at),
  resolvedAt: iso(row.resolved_at),
  resolvedBy: row.resolver,
});

const loadComment = async (id: string): Promise<CommentRow> => {
  if (!isUuid(id)) throw notFound("Comment");
  const [row] = await sql`${commentQuery()} WHERE c.id = ${id}`;
  if (!row) throw notFound("Comment");
  return row as CommentRow;
};

/** Loads a comment the user can see, with their role on its page. */
const commentAccess = async (user: AuthUser, id: string, min: "reader" | "writer" = "reader") => {
  const comment = await loadComment(id);
  const { page, role } = await requirePage(user, comment.page_id, min);
  return { comment, page, role };
};

const parseBody = (value: unknown) => {
  const body = validateDoc(value, "body");
  const text = docText(body);
  if (!text.trim()) throw badRequest("Comment cannot be empty");
  return { body, text };
};

const sendCommentNotifications = async (comment: CommentRow, authorId: string, text: string) => {
  const excerpt = text.slice(0, 300);
  const mentioned = new Set(
    await notify({
      kind: "comment.mention",
      recipientIds: docMentionedUserIds(comment.body).filter(isUuid),
      actorId: authorId,
      pageId: comment.page_id,
      commentId: comment.id,
      excerpt,
    }),
  );
  if (comment.parent_id) {
    const participants: { author_id: string }[] = await sql`
      SELECT DISTINCT author_id FROM comments
      WHERE (id = ${comment.parent_id} OR parent_id = ${comment.parent_id}) AND author_id IS NOT NULL`;
    await notify({
      kind: "comment.reply",
      recipientIds: participants.map((p) => p.author_id).filter((id) => !mentioned.has(id)),
      actorId: authorId,
      pageId: comment.page_id,
      commentId: comment.id,
      excerpt,
    });
  } else {
    const watchers: { user_id: string }[] = await sql`SELECT user_id FROM watchers WHERE page_id = ${comment.page_id}`;
    await notify({
      kind: "comment.created",
      recipientIds: watchers.map((w) => w.user_id).filter((id) => !mentioned.has(id)),
      actorId: authorId,
      pageId: comment.page_id,
      commentId: comment.id,
      excerpt,
    });
  }
};

export const routes = [
  get("/pages/:id/comments", async (ctx) => {
    const { page } = await requirePage(ctx.user, ctx.params.id!, "reader");
    const rows = await sql`${commentQuery()} WHERE c.page_id = ${page.id} ORDER BY c.created_at, c.id`;
    return rows.map(toComment);
  }),

  post("/comments", async (ctx) => {
    const data = input(await readJson(ctx));
    const { page } = await requirePage(ctx.user, data.uuid("pageId"), "writer");
    const { body, text } = parseBody(data.raw("body"));
    const quote = data.nullableString("quote", { max: 2000 }) ?? null;
    const anchored = data.boolean("anchored") ?? false;
    let parentId = data.optionalUuid("parentId") ?? null;
    if (parentId) {
      const [parent] = await sql`SELECT id, parent_id FROM comments WHERE id = ${parentId} AND page_id = ${page.id}`;
      if (!parent) throw notFound("Parent comment");
      parentId = parent.parent_id ?? parent.id;
    }
    const [row] = await sql`
      INSERT INTO comments (page_id, parent_id, author_id, body, quote, anchored)
      VALUES (${page.id}, ${parentId}, ${ctx.user.id}, ${body}::jsonb, ${quote}, ${anchored && !parentId})
      RETURNING id`;
    const comment = await loadComment(row.id);
    await watchPage(page.id, [ctx.user.id]);
    emitToPage(page.id, { kind: "comments", pageId: page.id });
    sendCommentNotifications(comment, ctx.user.id, text).catch((error) => log.error("comment notifications failed", error));
    return { comment: toComment(comment) };
  }),

  post("/comments/:id/update", async (ctx) => {
    const { comment } = await commentAccess(ctx.user, ctx.params.id!);
    if (comment.author_id !== ctx.user.id) throw forbidden("Only the author can edit a comment");
    const { body } = parseBody(input(await readJson(ctx)).raw("body"));
    await sql`UPDATE comments SET body = ${body}::jsonb, edited_at = now(), updated_at = now() WHERE id = ${comment.id}`;
    emitToPage(comment.page_id, { kind: "comments", pageId: comment.page_id });
    return { comment: toComment(await loadComment(comment.id)) };
  }),

  post("/comments/:id/resolve", async (ctx) => {
    const { comment } = await commentAccess(ctx.user, ctx.params.id!, "writer");
    if (comment.parent_id) throw badRequest("Only top-level comments can be resolved");
    const resolved = input(await readJson(ctx)).boolean("resolved");
    if (resolved === undefined) throw badRequest("resolved is required");
    await sql`
      UPDATE comments SET
        resolved_at = ${resolved ? sql`COALESCE(resolved_at, now())` : sql`NULL`},
        resolved_by = ${resolved ? ctx.user.id : null},
        updated_at = now()
      WHERE id = ${comment.id}`;
    emitToPage(comment.page_id, { kind: "comments", pageId: comment.page_id });
    return { comment: toComment(await loadComment(comment.id)) };
  }),

  post("/comments/:id/delete", async (ctx) => {
    const { comment, role } = await commentAccess(ctx.user, ctx.params.id!);
    if (comment.author_id !== ctx.user.id && !hasRole(role, "admin")) {
      throw forbidden("Only the author or a space admin can delete a comment");
    }
    await sql`DELETE FROM comments WHERE id = ${comment.id}`;
    emitToPage(comment.page_id, { kind: "comments", pageId: comment.page_id });
    return {};
  }),
];
