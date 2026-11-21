//! Port of `src/server/lib/shares.ts`.

use serde_json::{json, Value};

use crate::common::text::try_encoded_title_slug;
use crate::config::config;
use crate::db::{db, Row, Sql};
use crate::http::{AppError, Result};
use crate::sql;

/// Shares aliased `sh` joined to their page (`sp`) so the public URL can be built.
pub fn share_query() -> Sql {
    Sql::raw(
        "SELECT sh.id, sh.key, sh.page_id, sh.include_children, sh.search_indexing, sh.created_at,
           sp.title AS page_title, sp.slug_id AS page_slug_id
         FROM shares sh JOIN pages sp ON sp.id = sh.page_id",
    )
}

/// The parts of a share and its page that make up the `Share` the API returns.
pub struct ShareParts<'a> {
    pub id: &'a str,
    pub key: &'a str,
    pub page_id: &'a str,
    pub include_children: bool,
    pub search_indexing: bool,
    pub created_at: String,
    pub page_title: Option<&'a str>,
    pub page_slug_id: &'a str,
}

/// The `Share` the API returns. Fails where `encodeURIComponent` throws in
/// the Bun server: for a title whose slug was cut inside a surrogate pair.
pub fn share_json(share: &ShareParts) -> Result<Value> {
    let slug = try_encoded_title_slug(share.page_title).ok_or_else(|| AppError::other("URI malformed"))?;
    Ok(json!({
        "id": share.id,
        "key": share.key,
        "pageId": share.page_id,
        "includeChildren": share.include_children,
        "searchIndexing": share.search_indexing,
        "url": format!("{}/share/{}/p/{}-{}", config().app_url, share.key, slug, share.page_slug_id),
        "createdAt": share.created_at,
    }))
}

/// `toShare(row)` for a row of [`share_query`].
pub fn to_share(row: &Row) -> Result<Value> {
    share_json(&ShareParts {
        id: &row.str("id"),
        key: &row.str("key"),
        page_id: &row.str("page_id"),
        include_children: row.bool("include_children"),
        search_indexing: row.bool("search_indexing"),
        created_at: row.iso("created_at"),
        page_title: row.opt_str("page_title").as_deref(),
        page_slug_id: &row.str("page_slug_id"),
    })
}

/// SQL condition: sharing is not disabled for the workspace or for the space aliased `alias`.
pub fn sharing_enabled(space_alias: &str) -> Sql {
    Sql::raw(format!(
        "NOT coalesce((SELECT (settings->>'sharingDisabled')::boolean FROM workspace WHERE id = 1), false)
         AND NOT coalesce(({space_alias}.settings->>'sharingDisabled')::boolean, false)"
    ))
}

fn is_share_key(key: &str) -> bool {
    (1..=32).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
}

/// A live share by key: its page is not trashed and sharing is enabled for
/// the workspace and the page's space. The row also carries `space_id`.
pub async fn find_public_share(key: &str) -> Result<Option<Row>> {
    if !is_share_key(key) {
        return Ok(None);
    }
    Ok(db()
        .first(sql!(
            "SELECT sh.id, sh.key, sh.page_id, sh.include_children, sh.search_indexing, sh.created_at,
               sp.title AS page_title, sp.slug_id AS page_slug_id, sp.space_id
             FROM shares sh JOIN pages sp ON sp.id = sh.page_id JOIN spaces s ON s.id = sp.space_id
             WHERE sh.key = {} AND sp.deleted_at IS NULL AND {}",
            key,
            sharing_enabled("s")
        ))
        .await?)
}

/// Whether the share `key` exposes `page_id`: the page is the shared page, or a
/// non-trashed descendant of it when the share includes children.
pub async fn share_allows_page(key: &str, page_id: &str) -> Result<bool> {
    let Some(share) = find_public_share(key).await? else { return Ok(false) };
    let shared = share.str("page_id");
    if shared == page_id {
        return Ok(true);
    }
    if !share.bool("include_children") {
        return Ok(false);
    }
    let row = db()
        .first(sql!(
            "WITH RECURSIVE chain AS (
               SELECT id, parent_id, 0 AS depth FROM pages WHERE id = {} AND deleted_at IS NULL
               UNION ALL
               SELECT p.id, p.parent_id, chain.depth + 1 FROM pages p JOIN chain ON p.id = chain.parent_id
               WHERE chain.depth < 1000 AND chain.id <> {}
             )
             SELECT EXISTS (SELECT 1 FROM chain WHERE id = {}) AS allowed",
            page_id,
            &shared,
            &shared
        ))
        .await?;
    Ok(row.is_some_and(|row| row.bool("allowed")))
}
