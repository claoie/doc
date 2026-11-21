//! Port of `src/server/routes/files.ts`.

use http_body::Body as _;
use serde_json::json;

use crate::common::ids::{is_uuid, uuid};
use crate::config::config;
use crate::db::db;
use crate::files::{is_image_name, mime_for, serve_object, ServeOptions};
use crate::http::{bad_request, declared_length, http_error, not_found, post, public_get, unauthorized, AppError, Ctx, Reply, Result, Route};
use crate::jsutil::{encode_uri_component, js_trim};
use crate::pages::{require_page, PageOptions};
use crate::permissions::space_role;
use crate::shares::share_allows_page;
use crate::storage::{self, file_storage_key, safe_file_name, PutError};
use crate::validate::{max, Input};
use crate::{handler, sql};

fn file_url(id: &str, name: &str) -> String {
    format!("/api/files/{id}/{}", encode_uri_component(name))
}

fn too_large(limit: u64) -> AppError {
    http_error(413, "payload_too_large", format!("Files must be at most {limit} bytes"))
}

async fn store(ctx: &mut Ctx, key: &str, limit: u64) -> Result<u64> {
    let Some(mut body) = ctx.body.take() else { return Err(bad_request("The file is empty")) };
    match storage::put_stream(key, &mut body, limit).await {
        Ok(size) => Ok(size),
        Err(PutError::TooLarge) => Err(too_large(limit)),
        Err(error) => Err(error.into()),
    }
}

fn uploaded(id: &str, name: &str, mime: &str, size: u64) -> Reply {
    json!({ "id": id, "name": name, "mime": mime, "size": size, "url": file_url(id, name) }).into()
}

/// The request body is the file itself (query: `pageId`, `name`, optional
/// `replaceId`); it is streamed to storage, never buffered.
async fn upload(ctx: &mut Ctx) -> Result<Reply> {
    let limit = config().file_size_limit;
    let query = Input::query(ctx);
    let user = ctx.user().clone();
    let access = require_page(&user, &query.string("pageId", max(64))?, "writer", PageOptions { with_content: false, allow_deleted: false }).await?;
    if declared_length(&ctx.headers) > limit as f64 {
        return Err(too_large(limit));
    }
    if ctx.body.as_ref().is_none_or(|body| body.is_end_stream()) {
        return Err(bad_request("The file is empty"));
    }
    let declared = ctx.header("content-type").unwrap_or_default();
    let type_ = js_trim(declared.split(';').next().unwrap_or("")).to_string();
    let replace_id = query.optional_string("replaceId", max(64))?.filter(|id| !id.is_empty());
    let space_id = access.space_id();

    if let Some(replace_id) = replace_id {
        if !is_uuid(&replace_id) {
            return Err(not_found("File"));
        }
        let existing = db()
            .first(sql!(
                "SELECT id, name, storage_key FROM files
                 WHERE id = {} AND purpose = 'page' AND space_id = {}",
                &replace_id,
                &space_id
            ))
            .await?;
        let Some(existing) = existing else { return Err(not_found("File")) };
        let (id, name) = (existing.str("id"), existing.str("name"));
        let mime = mime_for(&name, Some(&type_));
        // Write beside the old object so a failed upload leaves the file intact.
        let key = file_storage_key(&uuid(), &name);
        let size = store(ctx, &key, limit).await?;
        // The locked read returns the key current at swap time, so concurrent
        // replacements each remove the object they superseded.
        let swapped = db()
            .query(sql!(
                "UPDATE files f SET size = {}, mime = {}, storage_key = {}, updated_at = now()
                 FROM (SELECT id, storage_key FROM files WHERE id = {} FOR UPDATE) prev
                 WHERE f.id = prev.id
                 RETURNING prev.storage_key AS old_key",
                size,
                &mime,
                &key,
                &id
            ))
            .await;
        let swapped = match swapped {
            Ok(rows) => rows,
            Err(error) => {
                let _ = storage::remove(&key).await;
                return Err(error.into());
            }
        };
        let Some(previous) = swapped.first() else {
            storage::remove(&key).await.map_err(AppError::other)?;
            return Err(not_found("File"));
        };
        storage::remove(&previous.str("old_key")).await.map_err(AppError::other)?;
        return Ok(uploaded(&id, &name, &mime, size));
    }

    let id = uuid();
    let name = safe_file_name(&query.optional_string("name", max(1024))?.filter(|name| !name.is_empty()).unwrap_or_else(|| "file".to_string()));
    let mime = mime_for(&name, Some(&type_));
    let key = file_storage_key(&id, &name);
    let size = store(ctx, &key, limit).await?;
    let inserted = db()
        .execute(sql!(
            "INSERT INTO files (id, purpose, page_id, space_id, uploader_id, name, mime, size, storage_key)
             VALUES ({}, 'page', {}, {}, {}, {}, {}, {}, {})",
            &id,
            &access.id(),
            &space_id,
            &user.id,
            &name,
            &mime,
            size,
            &key
        ))
        .await;
    if let Err(error) = inserted {
        let _ = storage::remove(&key).await;
        return Err(error.into());
    }
    Ok(uploaded(&id, &name, &mime, size))
}

async fn download(ctx: &mut Ctx) -> Result<Reply> {
    let id = ctx.param("id").to_string();
    if !is_uuid(&id) {
        return Err(not_found("File"));
    }
    let file = db()
        .first(sql!(
            "SELECT id, page_id, space_id, name, mime, size, storage_key, updated_at FROM files
             WHERE id = {} AND purpose = 'page'",
            &id
        ))
        .await?;
    let Some(file) = file else { return Err(not_found("File")) };
    match ctx.query_param("share").filter(|key| !key.is_empty()) {
        Some(share_key) => {
            let allowed = match file.opt_str("page_id") {
                Some(page_id) => share_allows_page(share_key, &page_id).await?,
                None => false,
            };
            if !allowed {
                return Err(not_found("File"));
            }
        }
        None => {
            let Some(user) = &ctx.user else { return Err(unauthorized()) };
            let allowed = match file.opt_str("space_id") {
                Some(space_id) => space_role(&user.id, &space_id).await?.is_some(),
                None => false,
            };
            if !allowed {
                return Err(not_found("File"));
            }
        }
    }
    let object = storage::get(&file.str("storage_key")).await.map_err(AppError::other)?;
    let Some(object) = object else { return Err(not_found("File")) };
    let updated = file.opt_millis("updated_at").unwrap_or(0);
    let etag = format!("\"{}-{}-{}\"", file.str("id"), updated, object.size);
    let options = ServeOptions {
        mime: &file.str("mime"),
        name: &file.str("name"),
        etag: &etag,
        last_modified: Some(updated),
        cache_control: "private, no-cache",
        download: false,
    };
    Ok(serve_object(&ctx.headers, &object, &options).await?.into())
}

async fn image(ctx: &mut Ctx) -> Result<Reply> {
    let name = ctx.param("name").to_string();
    if !is_image_name(&name) {
        return Err(not_found("Image"));
    }
    let object = storage::get(&format!("images/{name}")).await.map_err(AppError::other)?;
    let Some(object) = object else { return Err(not_found("Image")) };
    let mime = match name.rsplit('.').next() {
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("gif") => "image/gif",
        _ => "image/webp",
    };
    let etag = format!("\"{name}\"");
    let options =
        ServeOptions { mime, name: &name, etag: &etag, last_modified: None, cache_control: "public, max-age=31536000, immutable", download: false };
    Ok(serve_object(&ctx.headers, &object, &options).await?.into())
}

pub fn routes() -> Vec<Route> {
    vec![post("/files", handler!(upload)), public_get("/files/:id/:name", handler!(download)), public_get("/images/:name", handler!(image))]
}
