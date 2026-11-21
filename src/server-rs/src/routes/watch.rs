//! Port of `src/server/routes/watch.ts`.

use serde_json::json;

use crate::common::ids::is_uuid;
use crate::db::db;
use crate::http::{bad_request, empty, get, not_found, post, read_json, Ctx, Reply, Result, Route};
use crate::notifications::watch_page;
use crate::pages::{require_page, PageOptions};
use crate::permissions::require_space_role;
use crate::validate::input;
use crate::{handler, sql};

const PLAIN: PageOptions = PageOptions { with_content: false, allow_deleted: false };

async fn watching_flag(ctx: &mut Ctx) -> Result<bool> {
    input(read_json(ctx).await?).boolean("watching")?.ok_or_else(|| bad_request("watching is required"))
}

fn space_id_param(ctx: &Ctx) -> Result<String> {
    let value = ctx.param("id");
    if !is_uuid(value) {
        return Err(not_found("Space"));
    }
    Ok(value.to_lowercase())
}

async fn page_state(ctx: &mut Ctx) -> Result<Reply> {
    let page_id = require_page(ctx.user(), ctx.param("id"), "reader", PLAIN).await?.id();
    let row = db().first(sql!("SELECT 1 AS one FROM watchers WHERE user_id = {} AND page_id = {}", &ctx.user().id, &page_id)).await?;
    Ok(json!({ "watching": row.is_some() }).into())
}

async fn page_set(ctx: &mut Ctx) -> Result<Reply> {
    let user_id = ctx.user().id.clone();
    let page_id = require_page(ctx.user(), ctx.param("id"), "reader", PLAIN).await?.id();
    if watching_flag(ctx).await? {
        watch_page(&page_id, std::slice::from_ref(&user_id)).await?;
    } else {
        db().execute(sql!("DELETE FROM watchers WHERE user_id = {} AND page_id = {}", &user_id, &page_id)).await?;
    }
    empty()
}

async fn space_state(ctx: &mut Ctx) -> Result<Reply> {
    let space_id = space_id_param(ctx)?;
    require_space_role(ctx.user(), &space_id, "reader").await?;
    let row = db().first(sql!("SELECT 1 AS one FROM watchers WHERE user_id = {} AND space_id = {}", &ctx.user().id, &space_id)).await?;
    Ok(json!({ "watching": row.is_some() }).into())
}

async fn space_set(ctx: &mut Ctx) -> Result<Reply> {
    let user_id = ctx.user().id.clone();
    let space_id = space_id_param(ctx)?;
    require_space_role(ctx.user(), &space_id, "reader").await?;
    if watching_flag(ctx).await? {
        db().execute(sql!(
            "INSERT INTO watchers (user_id, space_id) VALUES ({}, {})
             ON CONFLICT (user_id, space_id) WHERE space_id IS NOT NULL DO NOTHING",
            &user_id,
            &space_id
        ))
        .await?;
    } else {
        db().execute(sql!("DELETE FROM watchers WHERE user_id = {} AND space_id = {}", &user_id, &space_id)).await?;
    }
    empty()
}

pub fn routes() -> Vec<Route> {
    vec![
        get("/pages/:id/watch", handler!(page_state)),
        post("/pages/:id/watch", handler!(page_set)),
        get("/spaces/:id/watch", handler!(space_state)),
        post("/spaces/:id/watch", handler!(space_set)),
    ]
}
