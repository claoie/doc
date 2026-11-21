//! Port of `src/server/routes/shares.ts`.

use serde_json::{json, Map, Value};

use crate::bases::{load_properties, load_views, query_rows, RowQuery, RowRecord};
use crate::common::bases::Property;
use crate::common::ids::{is_slug_id, is_uuid, share_key};
use crate::content::public_doc;
use crate::db::{db, Row, Sql};
use crate::http::{empty, get, http_error, not_found, post, public_get, read_json, AppError, Ctx, Reply, Result, Route};
use crate::pages::{require_page, to_tree_item, tree_columns, PageOptions};
use crate::permissions::require_space_role;
use crate::ratelimit::rate_limit;
use crate::search::{search_pages, SearchOptions};
use crate::shares::{find_public_share, share_allows_page, share_json, share_query, sharing_enabled, to_share, ShareParts};
use crate::validate::{input, min_max, Input};
use crate::{handler, sql};

const MAX_TREE: i64 = 5000;
const PUBLIC_BASE_ROWS: i64 = 1000;

fn sharing_disabled() -> AppError {
    http_error(403, "sharing_disabled", "Sharing is disabled for this space or workspace")
}

async fn public_base(page_id: &str) -> Result<Value> {
    let (properties, views) = tokio::try_join!(load_properties(page_id, db()), load_views(page_id, db()))?;
    let view = views.first().cloned();
    let config = view.as_ref().and_then(|view| view.get("config"));
    let stored = RowQuery {
        filter: config.and_then(|config| config.get("filter")).filter(|filter| !filter.is_null()).cloned(),
        sorts: config.and_then(|config| config.get("sorts")).filter(|sorts| !sorts.is_null()).cloned(),
        cursor: None,
        limit: PUBLIC_BASE_ROWS,
        tz_offset: 0,
    };
    let (rows, next_cursor) = match query_rows(page_id, &properties, &stored).await {
        Ok(found) => found,
        Err(_) => query_rows(page_id, &properties, &RowQuery { limit: PUBLIC_BASE_ROWS, ..RowQuery::default() }).await?,
    };
    Ok(json!({
        "properties": properties.iter().map(Property::to_json).collect::<Vec<_>>(),
        "view": view,
        "rows": rows.iter().map(RowRecord::to_json).collect::<Vec<_>>(),
        "truncated": next_cursor.is_some(),
    }))
}

async fn public_page(row: &Row, key: &str) -> Result<Value> {
    let mut page = to_tree_item(row);
    page.insert("cover".into(), row.value("cover"));
    page.insert("content".into(), public_doc(row.opt_json("content").as_ref().filter(|content| !content.is_null()), key).unwrap_or(Value::Null));
    page.insert("createdAt".into(), Value::String(row.iso("created_at")));
    page.insert("updatedAt".into(), Value::String(row.iso("updated_at")));
    if row.bool("is_base") {
        page.insert("base".into(), public_base(&row.str("id")).await?);
    }
    Ok(Value::Object(page))
}

fn joined_share_columns() -> Sql {
    sql!("sh.id AS share_id, sh.key, sh.include_children, sh.search_indexing, sh.created_at AS share_created_at, {}", tree_columns())
}

/// Splits a share joined to its page (aliased `p`) into the share and the page's tree item.
fn split_joined(row: &Row) -> Result<(Value, Map<String, Value>)> {
    let share = share_json(&ShareParts {
        id: &row.str("share_id"),
        key: &row.str("key"),
        page_id: &row.str("id"),
        include_children: row.bool("include_children"),
        search_indexing: row.bool("search_indexing"),
        created_at: row.iso("share_created_at"),
        page_title: row.opt_str("title").as_deref(),
        page_slug_id: &row.str("slug_id"),
    })?;
    Ok((share, to_tree_item(row)))
}

async fn load_public_page(page_ref: &str) -> Result<Option<Row>> {
    let condition = if is_uuid(page_ref) {
        sql!("p.id = {}", page_ref.to_lowercase())
    } else if is_slug_id(page_ref) {
        sql!("p.slug_id = {}", page_ref)
    } else {
        return Ok(None);
    };
    Ok(db()
        .first(sql!(
            "SELECT {}, p.cover, p.content, p.created_at, p.updated_at
             FROM pages p WHERE {} AND p.deleted_at IS NULL",
            tree_columns(),
            condition
        ))
        .await?)
}

/// Subtree pages under the shared root, flat and ordered by depth then position.
async fn shared_tree(root_id: &str) -> Result<Vec<Value>> {
    let rows = db()
        .query(sql!(
            "WITH RECURSIVE subtree AS (
               SELECT id, 0 AS depth FROM pages WHERE id = {}
               UNION ALL
               SELECT p.id, s.depth + 1 FROM pages p JOIN subtree s ON p.parent_id = s.id
               WHERE p.deleted_at IS NULL AND s.depth < 1000
             )
             SELECT {} FROM subtree s JOIN pages p ON p.id = s.id
             WHERE s.depth > 0 ORDER BY s.depth, p.parent_id, p.position, p.id LIMIT {}",
            root_id,
            tree_columns(),
            MAX_TREE
        ))
        .await?;
    Ok(rows.iter().map(|row| Value::Object(to_tree_item(row))).collect())
}

const PLAIN: PageOptions = PageOptions { with_content: false, allow_deleted: false };

async fn state(ctx: &mut Ctx) -> Result<Reply> {
    let page_id = require_page(ctx.user(), ctx.param("id"), "reader", PLAIN).await?.id();
    let own = db().first(sql!("{} WHERE sh.page_id = {}", share_query(), &page_id)).await?;
    let inherited = db()
        .first(sql!(
            "WITH RECURSIVE chain AS (
               SELECT id, parent_id, 0 AS depth FROM pages WHERE id = {}
               UNION ALL
               SELECT p.id, p.parent_id, chain.depth + 1 FROM pages p JOIN chain ON p.id = chain.parent_id WHERE chain.depth < 1000
             )
             SELECT {}
             FROM chain JOIN shares sh ON sh.page_id = chain.id JOIN pages p ON p.id = chain.id
             WHERE chain.depth > 0 AND sh.include_children
             ORDER BY chain.depth LIMIT 1",
            &page_id,
            joined_share_columns()
        ))
        .await?;
    let own = own.as_ref().map(to_share).transpose()?;
    let inherited = match inherited {
        Some(row) => {
            let (share, page) = split_joined(&row)?;
            Some(json!({ "share": share, "page": page }))
        }
        None => None,
    };
    Ok(json!({ "share": own, "inheritedFrom": inherited }).into())
}

async fn create(ctx: &mut Ctx) -> Result<Reply> {
    let user_id = ctx.user().id.clone();
    let access = require_page(ctx.user(), ctx.param("id"), "writer", PLAIN).await?;
    let body = input(read_json(ctx).await?);
    let include_children = body.boolean("includeChildren")?;
    let search_indexing = body.boolean("searchIndexing")?;
    let enabled = db().first(sql!("SELECT {} AS ok FROM spaces s WHERE s.id = {}", sharing_enabled("s"), &access.space_id())).await?;
    if !enabled.is_some_and(|row| row.bool("ok")) {
        return Err(sharing_disabled());
    }
    let page_id = access.id();
    db().execute(sql!(
        "INSERT INTO shares (key, page_id, include_children, search_indexing, created_by)
         VALUES ({}, {}, {}, {}, {})
         ON CONFLICT (page_id) DO UPDATE SET
           include_children = COALESCE({}::boolean, shares.include_children),
           search_indexing = COALESCE({}::boolean, shares.search_indexing),
           updated_at = now()",
        share_key(),
        &page_id,
        include_children.unwrap_or(false),
        search_indexing.unwrap_or(false),
        &user_id,
        include_children,
        search_indexing
    ))
    .await?;
    let row = db().first(sql!("{} WHERE sh.page_id = {}", share_query(), &page_id)).await?;
    Ok(json!({ "share": to_share(&row.ok_or_else(|| AppError::other("the share disappeared"))?)? }).into())
}

async fn delete(ctx: &mut Ctx) -> Result<Reply> {
    let page_id = require_page(ctx.user(), ctx.param("id"), "writer", PageOptions { with_content: false, allow_deleted: true }).await?.id();
    db().execute(sql!("DELETE FROM shares WHERE page_id = {}", &page_id)).await?;
    empty()
}

async fn list(ctx: &mut Ctx) -> Result<Reply> {
    let space_id = ctx.param("id").to_string();
    if !is_uuid(&space_id) {
        return Err(not_found("Space"));
    }
    require_space_role(ctx.user(), &space_id, "reader").await?;
    let rows = db()
        .query(sql!(
            "SELECT {}
             FROM shares sh JOIN pages p ON p.id = sh.page_id
             WHERE p.space_id = {} AND p.deleted_at IS NULL ORDER BY sh.created_at DESC",
            joined_share_columns(),
            &space_id
        ))
        .await?;
    let mut list: Vec<Value> = Vec::with_capacity(rows.len());
    for row in &rows {
        let (share, page) = split_joined(row)?;
        let mut item = match share {
            Value::Object(share) => share,
            _ => Map::new(),
        };
        item.insert("page".into(), Value::Object(page));
        list.push(Value::Object(item));
    }
    Ok(Value::Array(list).into())
}

async fn public_share(ctx: &mut Ctx) -> Result<Reply> {
    let Some(share) = find_public_share(ctx.param("key")).await? else { return Err(not_found("Share")) };
    let Some(page) = load_public_page(&share.str("page_id")).await? else { return Err(not_found("Share")) };
    let mut out = Map::new();
    out.insert("share".into(), to_share(&share)?);
    out.insert("page".into(), public_page(&page, &share.str("key")).await?);
    if share.bool("include_children") {
        out.insert("tree".into(), Value::Array(shared_tree(&share.str("page_id")).await?));
    }
    Ok(Value::Object(out).into())
}

async fn public_share_page(ctx: &mut Ctx) -> Result<Reply> {
    let Some(share) = find_public_share(ctx.param("key")).await? else { return Err(not_found("Page")) };
    let key = share.str("key");
    let page = match load_public_page(ctx.param("page")).await? {
        Some(page) if share_allows_page(&key, &page.str("id")).await? => page,
        _ => return Err(not_found("Page")),
    };
    let rows = db()
        .query(sql!(
            "WITH RECURSIVE chain AS (
               SELECT id, parent_id, 0 AS depth FROM pages WHERE id = {}
               UNION ALL
               SELECT p.id, p.parent_id, chain.depth + 1 FROM pages p JOIN chain ON p.id = chain.parent_id
               WHERE chain.depth < 1000 AND chain.id <> {}
             )
             SELECT {} FROM chain JOIN pages p ON p.id = chain.id ORDER BY chain.depth DESC",
            &page.str("id"),
            &share.str("page_id"),
            tree_columns()
        ))
        .await?;
    let breadcrumbs: Vec<Value> = rows.iter().map(|row| Value::Object(to_tree_item(row))).collect();
    Ok(json!({ "page": public_page(&page, &key).await?, "breadcrumbs": breadcrumbs }).into())
}

async fn public_search(ctx: &mut Ctx) -> Result<Reply> {
    rate_limit("public-search", &ctx.ip, 60)?;
    let Some(share) = find_public_share(ctx.param("key")).await? else { return Err(not_found("Share")) };
    let q = Input::query(ctx).optional_string("q", min_max(0, 200))?.unwrap_or_default();
    let shared = share.str("page_id");
    let scope = if share.bool("include_children") {
        sql!(
            "p.id IN (
               WITH RECURSIVE subtree AS (
                 SELECT id FROM pages WHERE id = {}
                 UNION
                 SELECT c.id FROM pages c JOIN subtree t ON c.parent_id = t.id WHERE c.deleted_at IS NULL
               ) SELECT id FROM subtree)",
            &shared
        )
    } else {
        sql!("p.id = {}", &shared)
    };
    let results = search_pages(SearchOptions { query: q, scope, title_only: false, limit: 20, offset: 0 }).await?;
    let list: Vec<Value> = results
        .into_iter()
        .map(|mut result| {
            result.shift_remove("space");
            Value::Object(result)
        })
        .collect();
    Ok(Value::Array(list).into())
}

pub fn routes() -> Vec<Route> {
    vec![
        get("/pages/:id/share", handler!(state)),
        post("/pages/:id/share", handler!(create)),
        post("/pages/:id/share/delete", handler!(delete)),
        get("/spaces/:id/shares", handler!(list)),
        public_get("/public/shares/:key", handler!(public_share)),
        public_get("/public/shares/:key/pages/:page", handler!(public_share_page)),
        public_get("/public/shares/:key/search", handler!(public_search)),
    ]
}
