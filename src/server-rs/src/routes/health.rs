//! Port of `src/server/routes/health.ts`.

use serde_json::json;

use crate::db::db;
use crate::http::{public_get, Ctx, Reply, Result, Route};
use crate::{handler, sql};

async fn health(_ctx: &mut Ctx) -> Result<Reply> {
    db().execute(sql!("SELECT 1")).await?;
    Ok(json!({ "ok": true }).into())
}

pub fn routes() -> Vec<Route> {
    vec![public_get("/health", handler!(health))]
}
