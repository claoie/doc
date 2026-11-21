//! Port of `src/server/routes/export.ts`.

use crate::common::ids::is_uuid;
use crate::export::{export_pages, ExportFormat, ExportRequest};
use crate::handler;
use crate::http::{get, not_found, AppError, Ctx, Reply, Result, Route};
use crate::pages::{require_page, PageOptions};
use crate::permissions::require_space_role;
use crate::spaces::find_space;
use crate::validate::Input;

const FORMATS: &[&str] = &["markdown", "html"];

async fn page(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let access = require_page(&user, ctx.param("id"), "reader", PageOptions { with_content: false, allow_deleted: false }).await?;
    let query = Input::query(ctx);
    let request = ExportRequest {
        user_id: user.id.clone(),
        format: ExportFormat::parse(query.one_of("format", FORMATS)?.as_deref()),
        include_files: query.boolean("files")?.unwrap_or(false),
        children: query.boolean("children")?.unwrap_or(false),
        page_id: Some(access.id()),
        space_id: access.space_id(),
        archive_name: access.page.opt_str("title").filter(|title| !title.is_empty()).unwrap_or_else(|| "Untitled".to_string()),
    };
    Ok(export_pages(request).await?.into())
}

async fn space(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let id = ctx.param("id").to_string();
    if !is_uuid(&id) {
        return Err(not_found("Space"));
    }
    require_space_role(&user, &id, "admin").await?;
    let space = find_space(&user.id, &id).await?.ok_or_else(|| AppError::other("the space disappeared"))?;
    let query = Input::query(ctx);
    let request = ExportRequest {
        user_id: user.id.clone(),
        format: ExportFormat::parse(query.one_of("format", FORMATS)?.as_deref()),
        include_files: query.boolean("files")?.unwrap_or(false),
        children: true,
        page_id: None,
        space_id: space.str("id"),
        archive_name: space.str("name"),
    };
    Ok(export_pages(request).await?.into())
}

pub fn routes() -> Vec<Route> {
    vec![get("/pages/:id/export", handler!(page)), get("/spaces/:id/export", handler!(space))]
}
