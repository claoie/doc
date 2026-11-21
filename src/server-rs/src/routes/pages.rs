//! Port of `src/server/routes/pages.ts`.

use serde_json::{json, Map, Value};

use crate::common::editor::doc_schema::empty_doc;
use crate::common::ids::{is_uuid, slug_id};
use crate::common::text::doc_text;
use crate::content::validate_doc;
use crate::db::{begin, db, Row};
use crate::duplicate::duplicate_page;
use crate::http::{bad_request, empty, get, http_error, not_found, post, read_json, read_json_limit, AppError, Ctx, Reply, Result, Route};
use crate::jsutil::{encode_uri_component, utf16_len};
use crate::logger;
use crate::notifications::watch_page;
use crate::pages::{
    breadcrumbs, delete_page_permanently, index_page_content, is_in_subtree, page_columns, require_page, restore_page, sibling_position, to_page,
    to_tree_item, trash_page, tree_columns, PageOptions, Place,
};
use crate::permissions::{readable_space_ids, require_space_role};
use crate::realtime::collab::{refresh_open_sessions, replace_page_content, Recheck, ReplaceError};
use crate::realtime::hub::emit_to_space;
use crate::realtime::leader::is_leader;
use crate::spaces::{find_space, space_ref_json, to_space};
use crate::users::{user_ref, user_refs};
use crate::validate::{input, max, min_max, Input, Nullable, StringRule};
use crate::{handler, sql};

const TITLE_RULE: StringRule = min_max(0, 500);
const ICON_RULE: StringRule = max(100);
const COVER_RULE: StringRule = max(2000);
const PAGE_BODY_LIMIT: usize = 8 * 1024 * 1024;

const READER: PageOptions = PageOptions { with_content: false, allow_deleted: false };
const ALLOW_DELETED: PageOptions = PageOptions { with_content: false, allow_deleted: true };

async fn page_by_id(id: &str) -> Result<Value> {
    let row = db().first(sql!("SELECT {}, p.content FROM pages p WHERE p.id = {}", page_columns(), id)).await?;
    to_page(&row.ok_or_else(|| AppError::other("the page disappeared"))?).await
}

async fn page_reply(id: &str) -> Result<Reply> {
    Ok(json!({ "page": page_by_id(id).await? }).into())
}

/// Ids of a page and all of its descendants, trashed or not.
async fn subtree_ids(page_id: &str) -> Result<Vec<String>> {
    let rows = db()
        .query(sql!(
            "WITH RECURSIVE subtree AS (
               SELECT id, 0 AS depth FROM pages WHERE id = {}
               UNION ALL
               SELECT p.id, s.depth + 1 FROM pages p JOIN subtree s ON p.parent_id = s.id WHERE s.depth < 1000
             )
             SELECT id FROM subtree",
            page_id
        ))
        .await?;
    Ok(rows.iter().map(|r| r.str("id")).collect())
}

/// Which editors to re-check after a subtree changed.
enum Known {
    /// Work the subtree out now.
    Subtree,
    /// The subtree as it was before it was deleted; `None` re-checks every open editor.
    Ids(Option<Vec<String>>),
}

/// Open editors of a moved, trashed or restored subtree may have gained or lost
/// access. Runs after the response.
fn recheck_editors(page_id: &str, known: Known) {
    let page_id = page_id.to_string();
    tokio::spawn(async move {
        let run = async {
            let page_ids = match known {
                Known::Subtree => Some(subtree_ids(&page_id).await?),
                Known::Ids(ids) => ids,
            };
            refresh_open_sessions(Recheck { user_ids: None, page_ids }).await
        };
        if let Err(error) = run.await {
            logger::error("re-checking editor access failed", &error);
        }
    });
}

fn emit_tree(space_ids: &[&str]) {
    let mut seen: Vec<&str> = Vec::new();
    for space_id in space_ids {
        if !seen.contains(space_id) {
            seen.push(space_id);
            emit_to_space(space_id, &json!({ "kind": "tree", "spaceId": space_id }));
        }
    }
}

fn require_space_id(value: &str) -> Result<String> {
    if !is_uuid(value) {
        return Err(not_found("Space"));
    }
    Ok(value.to_lowercase())
}

fn with_space(row: &Row) -> Value {
    let mut item = to_tree_item(row);
    item.insert("space".into(), row.json("space"));
    Value::Object(item)
}

fn person(row: &Row, prefix: &str) -> Value {
    match row.opt_str(&format!("{prefix}_id")) {
        Some(id) => user_ref(&id, &row.str(&format!("{prefix}_name")), row.opt_str(&format!("{prefix}_avatar")).as_deref()),
        None => Value::Null,
    }
}

async fn space_pages(ctx: &mut Ctx) -> Result<Reply> {
    let space_id = require_space_id(ctx.param("id"))?;
    require_space_role(ctx.user(), &space_id, "reader").await?;
    let parent_id = Input::query(ctx).optional_uuid("parentId")?.into_option();
    let rows = db()
        .query(sql!(
            "SELECT {} FROM pages p
             WHERE p.space_id = {} AND p.parent_id IS NOT DISTINCT FROM {}::uuid AND p.deleted_at IS NULL
             ORDER BY p.position, p.id",
            tree_columns(),
            &space_id,
            parent_id
        ))
        .await?;
    Ok(Value::Array(rows.iter().map(|r| Value::Object(to_tree_item(r))).collect()).into())
}

async fn recent(ctx: &mut Ctx) -> Result<Reply> {
    let query = Input::query(ctx);
    let space_id = query.optional_uuid("spaceId")?.into_option();
    let creator_id = query.optional_uuid("creatorId")?.into_option();
    let limit = query.integer("limit", 1, 100)?.unwrap_or(20);
    let offset = query.integer("offset", 0, 100_000)?.unwrap_or(0);
    let rows = db()
        .query(sql!(
            "SELECT {}, p.updated_at, {} AS space,
               u.id AS editor_id, u.name AS editor_name, u.avatar AS editor_avatar
             FROM pages p JOIN spaces s ON s.id = p.space_id LEFT JOIN users u ON u.id = p.last_editor_id
             WHERE p.deleted_at IS NULL AND p.space_id IN {}
               AND ({}::uuid IS NULL OR p.space_id = {}::uuid)
               AND ({}::uuid IS NULL OR p.creator_id = {}::uuid)
             ORDER BY p.updated_at DESC, p.id LIMIT {} OFFSET {}",
            tree_columns(),
            space_ref_json("s"),
            readable_space_ids(&ctx.user().id),
            space_id.clone(),
            space_id,
            creator_id.clone(),
            creator_id,
            limit,
            offset
        ))
        .await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut item = to_tree_item(r);
            item.insert("space".into(), r.json("space"));
            item.insert("updatedAt".into(), Value::String(r.iso("updated_at")));
            item.insert("lastEditor".into(), person(r, "editor"));
            Value::Object(item)
        })
        .collect();
    Ok(Value::Array(list).into())
}

async fn show(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let access = require_page(&user, ctx.param("page"), "reader", PageOptions { with_content: true, allow_deleted: false }).await?;
    let space = find_space(&user.id, &access.space_id()).await?.ok_or_else(|| AppError::other("the page's space disappeared"))?;
    Ok(json!({
        "page": to_page(&access.page).await?,
        "space": to_space(&space),
        "breadcrumbs": breadcrumbs(&access.id()).await?,
        "canEdit": !access.is_deleted() && matches!(access.role, Some("writer" | "admin")),
    })
    .into())
}

async fn create(ctx: &mut Ctx) -> Result<Reply> {
    let body = input(read_json_limit(ctx, PAGE_BODY_LIMIT).await?);
    let user = ctx.user().clone();
    let space_id = body.uuid("spaceId")?;
    require_space_role(&user, &space_id, "writer").await?;
    let parent_id = body.optional_uuid("parentId")?.into_option();
    let after_id = body.optional_uuid("afterId")?.into_option();
    let title = body.nullable_string("title", TITLE_RULE)?.into_option();
    let icon = body.nullable_string("icon", ICON_RULE)?.into_option();
    let content = match body.raw("content").filter(|c| !c.is_null()) {
        Some(raw) => validate_doc(raw, "content", "doc").map_err(bad_request)?,
        None => empty_doc(),
    };
    let id = begin(async |tx| -> Result<String> {
        if let Some(parent_id) = &parent_id {
            let parent = tx.first(sql!("SELECT id FROM pages WHERE id = {} AND space_id = {} AND deleted_at IS NULL", parent_id, &space_id)).await?;
            if parent.is_none() {
                return Err(not_found("Parent page"));
            }
        }
        let place = after_id.as_deref().map_or(Place::Last, Place::After);
        let position = sibling_position(tx, &space_id, parent_id.as_deref(), place, None).await?;
        let row = tx
            .first(sql!(
                "INSERT INTO pages (slug_id, space_id, parent_id, position, title, icon, content, text_content,
                   creator_id, last_editor_id, contributor_ids)
                 VALUES ({}, {}, {}, {}, {}, {}, {}::jsonb, {},
                   {}, {}, ARRAY[{}]::uuid[])
                 RETURNING id",
                slug_id(),
                &space_id,
                parent_id.clone(),
                position,
                title.clone(),
                icon.clone(),
                &content,
                doc_text(Some(&content)),
                &user.id,
                &user.id,
                &user.id
            ))
            .await?;
        let id = row.map(|r| r.str("id")).unwrap_or_default();
        index_page_content(tx, &id, &content).await?;
        Ok(id)
    })
    .await?;
    watch_page(&id, std::slice::from_ref(&user.id)).await?;
    emit_tree(&[&space_id]);
    page_reply(&id).await
}

async fn update(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let access = require_page(&user, ctx.param("id"), "writer", READER).await?;
    let (page_id, space_id) = (access.id(), access.space_id());
    let body = input(read_json(ctx).await?);
    let title = body.nullable_string("title", TITLE_RULE)?;
    let icon = body.nullable_string("icon", ICON_RULE)?;
    let cover = body.nullable_string("cover", COVER_RULE)?;
    let tree_changed = title.is_given() || icon.is_given();
    db().execute(sql!(
        "UPDATE pages SET
           title = CASE WHEN {} THEN {} ELSE title END,
           icon = CASE WHEN {} THEN {} ELSE icon END,
           cover = CASE WHEN {} THEN {} ELSE cover END,
           last_editor_id = {},
           updated_at = now()
         WHERE id = {}",
        title.is_given(),
        title.into_option(),
        icon.is_given(),
        icon.into_option(),
        cover.is_given(),
        cover.into_option(),
        &user.id,
        &page_id
    ))
    .await?;
    let updated = page_by_id(&page_id).await?;
    if tree_changed {
        emit_tree(&[&space_id]);
        emit_to_space(&space_id, &json!({ "kind": "page", "pageId": page_id, "spaceId": space_id, "title": updated["title"], "icon": updated["icon"] }));
    }
    Ok(json!({ "page": updated }).into())
}

async fn replace_content(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let page_id = require_page(&user, ctx.param("id"), "writer", READER).await?.id();
    let body = read_json_limit(ctx, PAGE_BODY_LIMIT).await?;
    let content = validate_doc(body.get("content").unwrap_or(&Value::Null), "content", "doc").map_err(bad_request)?;
    if !is_leader() {
        return Err(http_error(503, "not_leader", "Another copy of the server runs realtime; try again"));
    }
    match replace_page_content(&page_id, &content, &user.id).await {
        Ok(true) => page_reply(&page_id).await,
        Ok(false) => Err(not_found("Page")),
        Err(ReplaceError::TooLarge) => Err(bad_request("content is too large")),
        Err(ReplaceError::Invalid) => Err(bad_request("Content does not fit the document format")),
        Err(ReplaceError::Other(error)) => Err(error),
    }
}

async fn move_page(ctx: &mut Ctx) -> Result<Reply> {
    let access = require_page(ctx.user(), ctx.param("id"), "writer", READER).await?;
    let (page_id, space_id) = (access.id(), access.space_id());
    let body = input(read_json(ctx).await?);
    let parent_id = body.optional_uuid("parentId")?.into_option();
    let after_id = body.optional_uuid("afterId")?.into_option();
    begin(async |tx| -> Result<()> {
        if let Some(parent_id) = &parent_id {
            let parent = tx.first(sql!("SELECT id FROM pages WHERE id = {} AND space_id = {} AND deleted_at IS NULL", parent_id, &space_id)).await?;
            if parent.is_none() {
                return Err(not_found("Parent page"));
            }
            if is_in_subtree(tx, &page_id, parent_id).await? {
                return Err(bad_request("A page cannot be moved under itself or its descendants"));
            }
        }
        if after_id.as_deref() == Some(page_id.as_str()) {
            return Err(bad_request("afterId cannot be the page itself"));
        }
        let place = after_id.as_deref().map_or(Place::First, Place::After);
        let position = sibling_position(tx, &space_id, parent_id.as_deref(), place, Some(&page_id)).await?;
        tx.execute(sql!("UPDATE pages SET parent_id = {}, position = {} WHERE id = {}", parent_id.clone(), position, &page_id)).await?;
        Ok(())
    })
    .await?;
    emit_tree(&[&space_id]);
    page_reply(&page_id).await
}

async fn move_to_space(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let access = require_page(&user, ctx.param("id"), "writer", READER).await?;
    let (page_id, space_id) = (access.id(), access.space_id());
    let target = input(read_json(ctx).await?).uuid("spaceId")?;
    require_space_role(&user, &target, "writer").await?;
    if target != space_id {
        begin(async |tx| -> Result<()> {
            let position = sibling_position(tx, &target, None, Place::Last, None).await?;
            tx.execute(sql!(
                "WITH RECURSIVE subtree AS (
                   SELECT id FROM pages WHERE id = {}
                   UNION
                   SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
                 ),
                 moved_files AS (UPDATE files SET space_id = {} WHERE page_id IN (SELECT id FROM subtree)),
                 dropped_shares AS (
                   DELETE FROM shares WHERE page_id IN (SELECT id FROM subtree)
                     AND (SELECT coalesce((settings->>'sharingDisabled')::boolean, false) FROM spaces WHERE id = {})
                 )
                 UPDATE pages SET space_id = {},
                   parent_id = CASE WHEN id = {} THEN NULL ELSE parent_id END,
                   position = CASE WHEN id = {} THEN {} ELSE position END
                 WHERE id IN (SELECT id FROM subtree)",
                &page_id,
                &target,
                &target,
                &target,
                &page_id,
                &page_id,
                position
            ))
            .await?;
            Ok(())
        })
        .await?;
        emit_tree(&[&space_id, &target]);
        recheck_editors(&page_id, Known::Subtree);
    }
    page_reply(&page_id).await
}

async fn duplicate(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let access = require_page(&user, ctx.param("id"), "writer", READER).await?;
    let target = input(read_json(ctx).await?).optional_uuid("spaceId")?.into_option().unwrap_or_else(|| access.space_id());
    if target != access.space_id() {
        require_space_role(&user, &target, "writer").await?;
    }
    let id = duplicate_page(&access.page, &target, &user.id).await?;
    emit_tree(&[&target]);
    page_reply(&id).await
}

async fn trash(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let access = require_page(&user, ctx.param("id"), "writer", READER).await?;
    trash_page(&access.id(), &user.id).await?;
    emit_tree(&[&access.space_id()]);
    recheck_editors(&access.id(), Known::Subtree);
    empty()
}

async fn restore(ctx: &mut Ctx) -> Result<Reply> {
    let access = require_page(ctx.user(), ctx.param("id"), "writer", ALLOW_DELETED).await?;
    restore_page(&access.id()).await?;
    emit_tree(&[&access.space_id()]);
    recheck_editors(&access.id(), Known::Subtree);
    page_reply(&access.id()).await
}

async fn delete_permanently(ctx: &mut Ctx) -> Result<Reply> {
    let access = require_page(ctx.user(), ctx.param("id"), "admin", ALLOW_DELETED).await?;
    let affected = subtree_ids(&access.id()).await.ok();
    delete_page_permanently(&access.id()).await?;
    emit_tree(&[&access.space_id()]);
    recheck_editors(&access.id(), Known::Ids(affected));
    empty()
}

async fn trash_list(ctx: &mut Ctx) -> Result<Reply> {
    let space_id = require_space_id(ctx.param("id"))?;
    require_space_role(ctx.user(), &space_id, "reader").await?;
    let rows = db()
        .query(sql!(
            "SELECT {}, p.deleted_at, u.id AS deleter_id, u.name AS deleter_name, u.avatar AS deleter_avatar
             FROM pages p
             LEFT JOIN pages parent ON parent.id = p.parent_id
             LEFT JOIN users u ON u.id = p.deleted_by
             WHERE p.space_id = {} AND p.deleted_at IS NOT NULL
               AND (parent.id IS NULL OR parent.deleted_at IS NULL OR parent.deleted_at <> p.deleted_at)
             ORDER BY p.deleted_at DESC, p.id
             LIMIT 1000",
            tree_columns(),
            &space_id
        ))
        .await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut item = to_tree_item(r);
            item.insert("deletedAt".into(), Value::String(r.iso("deleted_at")));
            item.insert("deletedBy".into(), person(r, "deleter"));
            Value::Object(item)
        })
        .collect();
    Ok(Value::Array(list).into())
}

fn unique(ids: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !id.is_empty() && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

fn find_ref(refs: &[Value], id: Option<&str>) -> Value {
    id.and_then(|id| refs.iter().find(|r| r["id"] == id).cloned()).unwrap_or(Value::Null)
}

async fn versions(ctx: &mut Ctx) -> Result<Reply> {
    let page_id = require_page(ctx.user(), ctx.param("id"), "reader", READER).await?.id();
    let rows = db()
        .query(sql!(
            "SELECT v.id, v.title, v.created_at, v.editor_id FROM page_versions v
             WHERE v.page_id = {} ORDER BY v.created_at DESC LIMIT 500",
            &page_id
        ))
        .await?;
    let editors = user_refs(db(), &unique(rows.iter().filter_map(|r| r.opt_str("editor_id")))).await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.str("id"),
                "title": r.opt_str("title"),
                "editor": find_ref(&editors, r.opt_str("editor_id").as_deref()),
                "createdAt": r.iso("created_at"),
            })
        })
        .collect();
    Ok(Value::Array(list).into())
}

async fn version(ctx: &mut Ctx) -> Result<Reply> {
    let id = ctx.param("id").to_string();
    if !is_uuid(&id) {
        return Err(not_found("Version"));
    }
    let row = db()
        .first(sql!(
            "SELECT v.id, v.page_id, v.title, v.icon, v.content, v.editor_id, v.contributor_ids::text[] AS contributor_ids, v.created_at
             FROM page_versions v WHERE v.id = {}",
            &id
        ))
        .await?;
    let Some(row) = row else { return Err(not_found("Version")) };
    require_page(ctx.user(), &row.str("page_id"), "reader", READER).await?;
    let contributor_ids = row.strings("contributor_ids");
    let editor_id = row.opt_str("editor_id");
    let refs = user_refs(db(), &unique(editor_id.iter().cloned().chain(contributor_ids.iter().cloned()))).await?;
    let contributors: Vec<Value> = contributor_ids.iter().filter_map(|id| refs.iter().find(|r| r["id"] == id.as_str()).cloned()).collect();
    Ok(json!({
        "id": row.str("id"),
        "pageId": row.str("page_id"),
        "title": row.opt_str("title"),
        "icon": row.opt_str("icon"),
        "content": row.json("content"),
        "editor": find_ref(&refs, editor_id.as_deref()),
        "contributors": contributors,
        "createdAt": row.iso("created_at"),
    })
    .into())
}

async fn files(ctx: &mut Ctx) -> Result<Reply> {
    let page_id = require_page(ctx.user(), ctx.param("id"), "reader", READER).await?.id();
    let rows = db()
        .query(sql!(
            "SELECT f.id, f.name, f.mime, f.size, f.created_at, f.uploader_id
             FROM files f WHERE f.page_id = {} AND f.purpose = 'page' ORDER BY f.created_at DESC LIMIT 500",
            &page_id
        ))
        .await?;
    let uploaders = user_refs(db(), &unique(rows.iter().filter_map(|r| r.opt_str("uploader_id")))).await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.str("id"),
                "name": r.str("name"),
                "mime": r.str("mime"),
                "size": r.i64("size"),
                "url": format!("/api/files/{}/{}", r.str("id"), encode_uri_component(&r.str("name"))),
                "uploader": find_ref(&uploaders, r.opt_str("uploader_id").as_deref()),
                "createdAt": r.iso("created_at"),
            })
        })
        .collect();
    Ok(Value::Array(list).into())
}

async fn linked(ctx: &mut Ctx, incoming: bool) -> Result<Reply> {
    let user = ctx.user().clone();
    let page_id = require_page(&user, ctx.param("id"), "reader", READER).await?.id();
    let (join, filter) = if incoming { ("l.source_id", "l.target_id") } else { ("l.target_id", "l.source_id") };
    let rows = db()
        .query(sql!(
            "SELECT {}, {} AS space
             FROM page_links l JOIN pages p ON p.id = {} JOIN spaces s ON s.id = p.space_id
             WHERE {} = {} AND p.deleted_at IS NULL AND p.space_id IN {}
             ORDER BY lower(coalesce(p.title, '')), p.id LIMIT 500",
            tree_columns(),
            space_ref_json("s"),
            crate::db::Sql::raw(join),
            crate::db::Sql::raw(filter),
            &page_id,
            readable_space_ids(&user.id)
        ))
        .await?;
    Ok(Value::Array(rows.iter().map(with_space).collect()).into())
}

async fn backlinks(ctx: &mut Ctx) -> Result<Reply> {
    linked(ctx, true).await
}

async fn links(ctx: &mut Ctx) -> Result<Reply> {
    linked(ctx, false).await
}

async fn synced_blocks(ctx: &mut Ctx) -> Result<Reply> {
    let body = input(read_json(ctx).await?);
    let raw = match body.raw("refs") {
        Some(Value::Array(raw)) if raw.len() <= 100 => raw,
        _ => return Err(bad_request("refs must be a list of at most 100 references")),
    };
    let mut refs: Vec<Value> = Vec::with_capacity(raw.len());
    for (ord, reference) in raw.iter().enumerate() {
        let page_id = reference.get("pageId").and_then(Value::as_str).filter(|id| is_uuid(id));
        let block_id = reference.get("blockId").and_then(Value::as_str).filter(|id| !id.is_empty() && utf16_len(id) <= 100);
        let (Some(page_id), Some(block_id)) = (page_id, block_id) else { return Err(bad_request("Each ref needs a pageId and blockId")) };
        refs.push(json!({ "page_id": page_id.to_lowercase(), "block_id": block_id, "ord": ord }));
    }
    if refs.is_empty() {
        return Ok(json!([]).into());
    }
    let rows = db()
        .query(sql!(
            "SELECT r.page_id, r.block_id, sb.content
             FROM jsonb_to_recordset({}::jsonb) AS r(page_id uuid, block_id text, ord int)
             LEFT JOIN pages p ON p.id = r.page_id AND p.deleted_at IS NULL AND p.space_id IN {}
             LEFT JOIN synced_blocks sb ON sb.page_id = p.id AND sb.block_id = r.block_id
             ORDER BY r.ord",
            Value::Array(refs),
            readable_space_ids(&ctx.user().id)
        ))
        .await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut block = Map::new();
            block.insert("pageId".into(), r.value("page_id"));
            block.insert("blockId".into(), r.value("block_id"));
            block.insert("content".into(), r.json("content"));
            Value::Object(block)
        })
        .collect();
    Ok(Value::Array(list).into())
}

/// The value of an optional id field, for callers that tell "absent" from "null".
#[allow(dead_code)]
fn given(value: &Nullable<String>) -> bool {
    value.is_given()
}

pub fn routes() -> Vec<Route> {
    vec![
        get("/spaces/:id/pages", handler!(space_pages)),
        get("/pages/recent", handler!(recent)),
        get("/pages/:page", handler!(show)),
        post("/pages", handler!(create)),
        post("/pages/:id/update", handler!(update)),
        post("/pages/:id/content", handler!(replace_content)),
        post("/pages/:id/move", handler!(move_page)),
        post("/pages/:id/move-to-space", handler!(move_to_space)),
        post("/pages/:id/duplicate", handler!(duplicate)),
        post("/pages/:id/delete", handler!(trash)),
        post("/pages/:id/restore", handler!(restore)),
        post("/pages/:id/delete-permanently", handler!(delete_permanently)),
        get("/spaces/:id/trash", handler!(trash_list)),
        get("/pages/:id/versions", handler!(versions)),
        get("/versions/:id", handler!(version)),
        get("/pages/:id/files", handler!(files)),
        get("/pages/:id/backlinks", handler!(backlinks)),
        get("/pages/:id/links", handler!(links)),
        post("/synced-blocks/lookup", handler!(synced_blocks)),
    ]
}
