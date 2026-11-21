//! Port of `src/server/routes/favorites.ts`.

use serde_json::{json, Value};

use crate::db::db;
use crate::http::{bad_request, empty, get, post, read_json, Ctx, Reply, Result, Route};
use crate::pages::{require_page, to_tree_item, tree_columns, PageOptions};
use crate::permissions::{readable_space_ids, require_space_role};
use crate::spaces::{space_query, space_ref_json, to_space};
use crate::validate::input;
use crate::{handler, sql};

async fn list(ctx: &mut Ctx) -> Result<Reply> {
    let user_id = ctx.user().id.clone();
    let pages = db()
        .query(sql!(
            "SELECT {}, {} AS space
             FROM favorites f JOIN pages p ON p.id = f.page_id JOIN spaces s ON s.id = p.space_id
             WHERE f.user_id = {} AND p.deleted_at IS NULL AND p.space_id IN {}
             ORDER BY f.created_at",
            tree_columns(),
            space_ref_json("s"),
            &user_id,
            readable_space_ids(&user_id)
        ))
        .await?;
    let spaces = db()
        .query(sql!(
            "SELECT s.* FROM ({}) s JOIN favorites f ON f.space_id = s.id
             WHERE f.user_id = {} AND s.rank IS NOT NULL ORDER BY f.created_at",
            space_query(&user_id),
            &user_id
        ))
        .await?;
    let pages: Vec<Value> = pages
        .iter()
        .map(|r| {
            let mut item = to_tree_item(r);
            item.insert("space".into(), r.json("space"));
            Value::Object(item)
        })
        .collect();
    Ok(json!({ "pages": pages, "spaces": spaces.iter().map(to_space).collect::<Vec<_>>() }).into())
}

async fn add(ctx: &mut Ctx) -> Result<Reply> {
    let body = input(read_json(ctx).await?);
    let user = ctx.user().clone();
    let page_id = body.optional_uuid("pageId")?.into_option();
    let space_id = body.optional_uuid("spaceId")?.into_option();
    match (page_id, space_id) {
        (Some(page_id), None) => {
            let page_id = require_page(&user, &page_id, "reader", PageOptions { with_content: false, allow_deleted: false }).await?.id();
            db().execute(sql!(
                "INSERT INTO favorites (user_id, page_id) VALUES ({}, {})
                 ON CONFLICT (user_id, page_id) WHERE page_id IS NOT NULL DO NOTHING",
                &user.id,
                &page_id
            ))
            .await?;
        }
        (None, Some(space_id)) => {
            require_space_role(&user, &space_id, "reader").await?;
            db().execute(sql!(
                "INSERT INTO favorites (user_id, space_id) VALUES ({}, {})
                 ON CONFLICT (user_id, space_id) WHERE space_id IS NOT NULL DO NOTHING",
                &user.id,
                &space_id
            ))
            .await?;
        }
        _ => return Err(bad_request("Provide either pageId or spaceId")),
    }
    empty()
}

async fn remove(ctx: &mut Ctx) -> Result<Reply> {
    let body = input(read_json(ctx).await?);
    let user_id = ctx.user().id.clone();
    let page_id = body.optional_uuid("pageId")?.into_option();
    let space_id = body.optional_uuid("spaceId")?.into_option();
    if let Some(page_id) = page_id {
        db().execute(sql!("DELETE FROM favorites WHERE user_id = {} AND page_id = {}", &user_id, &page_id)).await?;
    } else if let Some(space_id) = space_id {
        db().execute(sql!("DELETE FROM favorites WHERE user_id = {} AND space_id = {}", &user_id, &space_id)).await?;
    } else {
        return Err(bad_request("Provide either pageId or spaceId"));
    }
    empty()
}

pub fn routes() -> Vec<Route> {
    vec![get("/favorites", handler!(list)), post("/favorites", handler!(add)), post("/favorites/remove", handler!(remove))]
}
