//! Port of `src/server/routes/notifications.ts`.

use serde_json::{json, Value};

use crate::db::{array, db, Sql};
use crate::http::{bad_request, empty, get, post, read_json, Ctx, Reply, Result, Route};
use crate::permissions::readable_space_ids;
use crate::users::user_ref_json;
use crate::validate::{input, Input};
use crate::{handler, sql};

async fn list(ctx: &mut Ctx) -> Result<Reply> {
    let query = Input::query(ctx);
    let limit = query.integer("limit", 1, 100)?.unwrap_or(30);
    let offset = query.integer("offset", 0, 100_000)?.unwrap_or(0);
    let unread_only = query.boolean("unread")?.unwrap_or(false);
    let user_id = ctx.user().id.clone();
    let rows = db()
        .query(sql!(
            "SELECT n.id, n.kind, n.data, n.created_at, n.read_at, {} AS actor,
               CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object(
                 'id', p.id, 'slugId', p.slug_id, 'title', p.title, 'icon', p.icon, 'spaceId', p.space_id, 'spaceSlug', s.slug) END AS page,
               CASE WHEN c.id IS NULL OR p.id IS NULL THEN NULL ELSE json_build_object('id', c.id, 'parentId', c.parent_id) END AS comment
             FROM notifications n
             LEFT JOIN users a ON a.id = n.actor_id
             LEFT JOIN pages p ON p.id = n.page_id AND p.deleted_at IS NULL AND p.space_id IN {}
             LEFT JOIN spaces s ON s.id = p.space_id
             LEFT JOIN comments c ON c.id = n.comment_id
             WHERE n.user_id = {} AND (NOT {} OR n.read_at IS NULL)
             ORDER BY n.created_at DESC, n.id LIMIT {} OFFSET {}",
            Sql::raw(user_ref_json("a")),
            readable_space_ids(&user_id),
            &user_id,
            unread_only,
            limit,
            offset
        ))
        .await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.str("id"),
                "kind": r.str("kind"),
                "actor": r.json("actor"),
                "page": r.json("page"),
                "comment": r.json("comment"),
                "data": r.opt_json("data").filter(|data| !data.is_null()).unwrap_or_else(|| json!({})),
                "createdAt": r.iso("created_at"),
                "readAt": r.opt_iso("read_at"),
            })
        })
        .collect();
    Ok(Value::Array(list).into())
}

async fn unread_count(ctx: &mut Ctx) -> Result<Reply> {
    let row = db().first(sql!("SELECT count(*)::int AS count FROM notifications WHERE user_id = {} AND read_at IS NULL", &ctx.user().id)).await?;
    Ok(json!({ "count": row.map_or(0, |r| r.i64("count")) }).into())
}

async fn read(ctx: &mut Ctx) -> Result<Reply> {
    let ids = input(read_json(ctx).await?).uuids("ids", 500)?.ok_or_else(|| bad_request("ids is required"))?;
    if !ids.is_empty() {
        db().execute(sql!(
            "UPDATE notifications SET read_at = now()
             WHERE user_id = {} AND id = ANY({}::uuid[]) AND read_at IS NULL",
            &ctx.user().id,
            array(&ids)
        ))
        .await?;
    }
    empty()
}

async fn read_all(ctx: &mut Ctx) -> Result<Reply> {
    db().execute(sql!("UPDATE notifications SET read_at = now() WHERE user_id = {} AND read_at IS NULL", &ctx.user().id)).await?;
    empty()
}

pub fn routes() -> Vec<Route> {
    vec![
        get("/notifications", handler!(list)),
        get("/notifications/unread-count", handler!(unread_count)),
        post("/notifications/read", handler!(read)),
        post("/notifications/read-all", handler!(read_all)),
    ]
}
