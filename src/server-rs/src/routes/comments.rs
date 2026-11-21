//! Port of `src/server/routes/comments.ts`.

use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::common::ids::is_uuid;
use crate::common::text::{doc_mentioned_user_ids, doc_text};
use crate::content::validate_doc;
use crate::db::{db, Row, Sql};
use crate::http::{bad_request, empty, forbidden_with, get, not_found, post, read_json, AppError, Ctx, Reply, Result, Route};
use crate::jsutil::{js_slice, js_trim};
use crate::logger;
use crate::notifications::{notify, watch_page, NotifyInput};
use crate::pages::{require_page, PageAccess, PageOptions};
use crate::permissions::has_role;
use crate::realtime::hub::emit_to_page;
use crate::users::user_ref_json;
use crate::validate::{input, max};
use crate::{handler, sql};

const PLAIN: PageOptions = PageOptions { with_content: false, allow_deleted: false };

fn comment_query() -> Sql {
    sql!(
        "SELECT c.id, c.page_id, c.parent_id, c.author_id, c.body, c.quote, c.anchored, c.created_at, c.edited_at, c.resolved_at,
           {} AS author, {} AS resolver
         FROM comments c LEFT JOIN users a ON a.id = c.author_id LEFT JOIN users r ON r.id = c.resolved_by",
        Sql::raw(user_ref_json("a")),
        Sql::raw(user_ref_json("r"))
    )
}

fn to_comment(row: &Row) -> Value {
    json!({
        "id": row.str("id"),
        "pageId": row.str("page_id"),
        "parentId": row.opt_str("parent_id"),
        "author": row.json("author"),
        "body": row.json("body"),
        "quote": row.opt_str("quote"),
        "anchored": row.bool("anchored"),
        "createdAt": row.iso("created_at"),
        "editedAt": row.opt_iso("edited_at"),
        "resolvedAt": row.opt_iso("resolved_at"),
        "resolvedBy": row.json("resolver"),
    })
}

async fn load_comment(id: &str) -> Result<Row> {
    if !is_uuid(id) {
        return Err(not_found("Comment"));
    }
    db().first(sql!("{} WHERE c.id = {}", comment_query(), id)).await?.ok_or_else(|| not_found("Comment"))
}

/// Loads a comment the user can see, with their role on its page.
async fn comment_access(user: &AuthUser, id: &str, min: &str) -> Result<(Row, PageAccess)> {
    let comment = load_comment(id).await?;
    let access = require_page(user, &comment.str("page_id"), min, PLAIN).await?;
    Ok((comment, access))
}

fn parse_body(value: Option<&Value>) -> Result<(Value, String)> {
    let body = validate_doc(value.unwrap_or(&Value::Null), "body", "doc").map_err(bad_request)?;
    let text = doc_text(Some(&body));
    if js_trim(&text).is_empty() {
        return Err(bad_request("Comment cannot be empty"));
    }
    Ok((body, text))
}

async fn send_comment_notifications(comment: Row, author_id: String, text: String) -> Result<()> {
    let excerpt = js_slice(&text, 0, Some(300));
    let page_id = comment.str("page_id");
    let comment_id = comment.str("id");
    let mentioned = notify(NotifyInput {
        kind: "comment.mention",
        recipient_ids: doc_mentioned_user_ids(Some(&comment.json("body"))).into_iter().filter(|id| is_uuid(id)).collect(),
        actor_id: Some(&author_id),
        page_id: &page_id,
        comment_id: Some(&comment_id),
        excerpt: Some(&excerpt),
    })
    .await?;
    let (kind, rows) = match comment.opt_str("parent_id") {
        Some(parent_id) => (
            "comment.reply",
            db().query(sql!(
                "SELECT DISTINCT author_id AS id FROM comments
                 WHERE (id = {} OR parent_id = {}) AND author_id IS NOT NULL",
                &parent_id,
                &parent_id
            ))
            .await?,
        ),
        None => ("comment.created", db().query(sql!("SELECT user_id AS id FROM watchers WHERE page_id = {}", &page_id)).await?),
    };
    notify(NotifyInput {
        kind,
        recipient_ids: rows.iter().map(|r| r.str("id")).filter(|id| !mentioned.contains(id)).collect(),
        actor_id: Some(&author_id),
        page_id: &page_id,
        comment_id: Some(&comment_id),
        excerpt: Some(&excerpt),
    })
    .await?;
    Ok(())
}

fn comments_changed(page_id: &str) {
    emit_to_page(page_id, &json!({ "kind": "comments", "pageId": page_id }));
}

async fn list(ctx: &mut Ctx) -> Result<Reply> {
    let page_id = require_page(ctx.user(), ctx.param("id"), "reader", PLAIN).await?.id();
    let rows = db().query(sql!("{} WHERE c.page_id = {} ORDER BY c.created_at, c.id", comment_query(), &page_id)).await?;
    Ok(Value::Array(rows.iter().map(to_comment).collect()).into())
}

async fn create(ctx: &mut Ctx) -> Result<Reply> {
    let data = input(read_json(ctx).await?);
    let user = ctx.user().clone();
    let page_id = require_page(&user, &data.uuid("pageId")?, "writer", PLAIN).await?.id();
    let (body, text) = parse_body(data.raw("body"))?;
    let quote = data.nullable_string("quote", max(2000))?.into_option();
    let anchored = data.boolean("anchored")?.unwrap_or(false);
    let mut parent_id = data.optional_uuid("parentId")?.into_option();
    if let Some(id) = &parent_id {
        let parent = db().first(sql!("SELECT id, parent_id FROM comments WHERE id = {} AND page_id = {}", id, &page_id)).await?;
        let Some(parent) = parent else { return Err(not_found("Parent comment")) };
        parent_id = Some(parent.opt_str("parent_id").unwrap_or_else(|| parent.str("id")));
    }
    let row = db()
        .first(sql!(
            "INSERT INTO comments (page_id, parent_id, author_id, body, quote, anchored)
             VALUES ({}, {}, {}, {}::jsonb, {}, {})
             RETURNING id",
            &page_id,
            parent_id.clone(),
            &user.id,
            &body,
            quote,
            anchored && parent_id.is_none()
        ))
        .await?
        .ok_or_else(|| AppError::other("the comment was not saved"))?;
    let comment = load_comment(&row.str("id")).await?;
    watch_page(&page_id, std::slice::from_ref(&user.id)).await?;
    comments_changed(&page_id);
    let reply = json!({ "comment": to_comment(&comment) });
    tokio::spawn(async move {
        if let Err(error) = send_comment_notifications(comment, user.id.clone(), text).await {
            logger::error("comment notifications failed", &error);
        }
    });
    Ok(reply.into())
}

async fn update(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let (comment, _) = comment_access(&user, ctx.param("id"), "reader").await?;
    if comment.opt_str("author_id").as_deref() != Some(user.id.as_str()) {
        return Err(forbidden_with("Only the author can edit a comment"));
    }
    let (body, _) = parse_body(input(read_json(ctx).await?).raw("body"))?;
    let id = comment.str("id");
    db().execute(sql!("UPDATE comments SET body = {}::jsonb, edited_at = now(), updated_at = now() WHERE id = {}", &body, &id)).await?;
    comments_changed(&comment.str("page_id"));
    Ok(json!({ "comment": to_comment(&load_comment(&id).await?) }).into())
}

async fn resolve(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let (comment, _) = comment_access(&user, ctx.param("id"), "writer").await?;
    if comment.opt_str("parent_id").is_some() {
        return Err(bad_request("Only top-level comments can be resolved"));
    }
    let resolved = input(read_json(ctx).await?).boolean("resolved")?.ok_or_else(|| bad_request("resolved is required"))?;
    let id = comment.str("id");
    db().execute(sql!(
        "UPDATE comments SET
           resolved_at = {},
           resolved_by = {},
           updated_at = now()
         WHERE id = {}",
        Sql::raw(if resolved { "COALESCE(resolved_at, now())" } else { "NULL" }),
        resolved.then(|| user.id.clone()),
        &id
    ))
    .await?;
    comments_changed(&comment.str("page_id"));
    Ok(json!({ "comment": to_comment(&load_comment(&id).await?) }).into())
}

async fn delete(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let (comment, access) = comment_access(&user, ctx.param("id"), "reader").await?;
    if comment.opt_str("author_id").as_deref() != Some(user.id.as_str()) && !has_role(access.role, "admin") {
        return Err(forbidden_with("Only the author or a space admin can delete a comment"));
    }
    db().execute(sql!("DELETE FROM comments WHERE id = {}", &comment.str("id"))).await?;
    comments_changed(&comment.str("page_id"));
    empty()
}

pub fn routes() -> Vec<Route> {
    vec![
        get("/pages/:id/comments", handler!(list)),
        post("/comments", handler!(create)),
        post("/comments/:id/update", handler!(update)),
        post("/comments/:id/resolve", handler!(resolve)),
        post("/comments/:id/delete", handler!(delete)),
    ]
}
