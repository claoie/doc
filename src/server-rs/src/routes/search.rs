//! Port of `src/server/routes/search.ts`.

use serde_json::{json, Value};

use crate::db::db;
use crate::http::{get, Ctx, Reply, Result, Route};
use crate::pages::{to_tree_item, tree_columns};
use crate::permissions::readable_space_ids;
use crate::search::{escape_like, search_pages, SearchOptions};
use crate::spaces::space_ref_json;
use crate::users::{to_user, UserRow};
use crate::validate::{min_max, Input};
use crate::{handler, sql};

async fn search(ctx: &mut Ctx) -> Result<Reply> {
    let query = Input::query(ctx);
    let q = query.optional_string("q", min_max(0, 500))?.unwrap_or_default();
    let space_id = query.optional_uuid("spaceId")?.into_option();
    let scope = sql!(
        "p.space_id IN {} AND ({}::uuid IS NULL OR p.space_id = {}::uuid)",
        readable_space_ids(&ctx.user().id),
        space_id.clone(),
        space_id
    );
    let title_only = query.boolean("titleOnly")?.unwrap_or(false);
    let limit = query.integer("limit", 1, 50)?.unwrap_or(20);
    let offset = query.integer("offset", 0, 10_000)?.unwrap_or(0);
    let results = search_pages(SearchOptions { query: q, scope, title_only, limit, offset }).await?;
    Ok(Value::Array(results.into_iter().map(Value::Object).collect()).into())
}

async fn suggest(ctx: &mut Ctx) -> Result<Reply> {
    let query = Input::query(ctx);
    let q = query.optional_string("q", min_max(0, 100))?.unwrap_or_default().to_lowercase();
    let space_id = query.optional_uuid("spaceId")?.into_option();
    let limit = query.integer("limit", 1, 25)?.unwrap_or(10);
    let want_users = query.boolean("users")?.unwrap_or(!query.has("pages"));
    let want_pages = query.boolean("pages")?.unwrap_or(!query.has("users"));
    let contains = format!("%{}%", escape_like(&q));
    let prefix = format!("{}%", escape_like(&q));
    let viewer = ctx.user().id.clone();
    let users = if want_users {
        db().query(sql!(
            "SELECT * FROM users u
             WHERE u.deactivated_at IS NULL AND (lower(u.name) LIKE {} OR lower(u.email) LIKE {})
             ORDER BY lower(u.name) LIKE {} DESC, lower(u.name), u.id LIMIT {}",
            &contains,
            &contains,
            &prefix,
            limit
        ))
        .await?
    } else {
        Vec::new()
    };
    let pages = if want_pages {
        db().query(sql!(
            "SELECT {}, {} AS space
             FROM pages p JOIN spaces s ON s.id = p.space_id
             WHERE p.deleted_at IS NULL AND p.space_id IN {}
               AND ({}::uuid IS NULL OR p.space_id = {}::uuid)
               AND lower(coalesce(p.title, '')) LIKE {}
             ORDER BY lower(coalesce(p.title, '')) LIKE {} DESC, p.updated_at DESC, p.id LIMIT {}",
            tree_columns(),
            space_ref_json("s"),
            readable_space_ids(&viewer),
            space_id.clone(),
            space_id,
            &contains,
            &prefix,
            limit
        ))
        .await?
    } else {
        Vec::new()
    };
    let users: Vec<Value> = users.iter().map(|row| Value::Object(to_user(&UserRow::from_row(row), Some(&viewer)))).collect();
    let pages: Vec<Value> = pages
        .iter()
        .map(|row| {
            let mut item = to_tree_item(row);
            item.insert("space".into(), row.json("space"));
            Value::Object(item)
        })
        .collect();
    Ok(json!({ "users": users, "pages": pages }).into())
}

pub fn routes() -> Vec<Route> {
    vec![get("/search", handler!(search)), get("/search/suggest", handler!(suggest))]
}
