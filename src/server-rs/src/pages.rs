//! Port of `src/server/lib/pages.ts`.

use serde_json::{json, Map, Value};

use crate::auth::AuthUser;
use crate::common::ids::{is_slug_id, is_uuid};
use crate::common::positions::key_between;
use crate::common::text::{doc_links, doc_mentioned_user_ids, doc_text};
use crate::content::synced_blocks_of;
use crate::db::{array, begin, db, Conn, Row, Sql};
use crate::http::{conflict, forbidden, not_found, Result};
use crate::jsutil::{js_number_opt, number_to_string};
use crate::logger;
use crate::notifications::{notify, watch_page, NotifyInput};
use crate::permissions::{has_role, rank_to_role, role_rank};
use crate::sql;
use crate::storage;
use crate::users::user_refs;

/// Columns needed for a `TreeItem`, for a pages row aliased `p`.
pub fn tree_columns() -> Sql {
    Sql::raw(
        "p.id, p.slug_id, p.title, p.icon, p.parent_id, p.space_id, p.position, p.is_base,
     EXISTS (SELECT 1 FROM pages c WHERE c.parent_id = p.id AND c.deleted_at IS NULL) AS has_children",
    )
}

/// Every page column except `content`, `text_content` and `search`, for a pages row aliased `p`.
pub fn page_columns() -> Sql {
    Sql::raw(
        "p.id, p.slug_id, p.space_id, p.parent_id, p.position, p.title, p.icon, p.cover, p.doc_version,
     p.creator_id, p.last_editor_id, p.contributor_ids::text[] AS contributor_ids, p.created_at, p.updated_at,
     p.deleted_at, p.deleted_by, p.is_base,
     EXISTS (SELECT 1 FROM pages c WHERE c.parent_id = p.id AND c.deleted_at IS NULL) AS has_children",
    )
}

/// `toTreeItem(row)`.
pub fn to_tree_item(row: &Row) -> Map<String, Value> {
    let mut item = Map::new();
    item.insert("id".into(), row.value("id"));
    item.insert("slugId".into(), row.value("slug_id"));
    item.insert("title".into(), row.value("title"));
    item.insert("icon".into(), row.value("icon"));
    item.insert("parentId".into(), row.value("parent_id"));
    item.insert("spaceId".into(), row.value("space_id"));
    item.insert("position".into(), row.value("position"));
    item.insert("hasChildren".into(), Value::Bool(row.has("has_children") && row.bool("has_children")));
    item.insert("isBase".into(), Value::Bool(row.has("is_base") && row.bool("is_base")));
    item
}

/// `toPage(row)`: the page with its people resolved.
pub async fn to_page(row: &Row) -> Result<Value> {
    let contributor_ids = row.strings("contributor_ids");
    let creator_id = row.opt_str("creator_id");
    let last_editor_id = row.opt_str("last_editor_id");
    let mut ids: Vec<String> = Vec::new();
    for id in creator_id.iter().chain(last_editor_id.iter()).chain(contributor_ids.iter()) {
        if !id.is_empty() && !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    let refs = user_refs(db(), &ids).await?;
    let find = |id: &Option<String>| id.as_ref().and_then(|id| refs.iter().find(|r| r["id"] == id.as_str()).cloned()).unwrap_or(Value::Null);
    let mut page = to_tree_item(row);
    page.insert("cover".into(), row.value("cover"));
    page.insert("content".into(), if row.has("content") { row.json("content") } else { Value::Null });
    page.insert("docVersion".into(), Value::from(row.i64("doc_version")));
    page.insert("creator".into(), find(&creator_id));
    page.insert("lastEditor".into(), find(&last_editor_id));
    let contributors: Vec<Value> = contributor_ids.iter().filter_map(|id| refs.iter().find(|r| r["id"] == id.as_str()).cloned()).collect();
    page.insert("contributors".into(), Value::Array(contributors));
    page.insert("createdAt".into(), Value::String(row.iso("created_at")));
    page.insert("updatedAt".into(), Value::String(row.iso("updated_at")));
    page.insert("deletedAt".into(), row.opt_iso("deleted_at").map_or(Value::Null, Value::String));
    Ok(Value::Object(page))
}

pub struct PageAccess {
    pub page: Row,
    pub role: Option<&'static str>,
}

impl PageAccess {
    pub fn id(&self) -> String {
        self.page.str("id")
    }

    pub fn space_id(&self) -> String {
        self.page.str("space_id")
    }

    pub fn is_deleted(&self) -> bool {
        !self.page.is_null("deleted_at")
    }
}

/// The condition that finds a page by id or slugId, for a pages row aliased `p`.
pub fn page_ref_condition(reference: &str) -> Option<Sql> {
    if is_uuid(reference) {
        Some(sql!("p.id = {}", reference.to_lowercase()))
    } else if is_slug_id(reference) {
        Some(sql!("p.slug_id = {}", reference))
    } else {
        None
    }
}

/// Loads a page by id or slugId with the user's role in its space; `None` when it does not exist.
pub async fn find_page(user_id: &str, reference: &str, with_content: bool) -> Result<Option<PageAccess>> {
    let Some(condition) = page_ref_condition(reference) else { return Ok(None) };
    let row = db()
        .first(sql!(
            "SELECT {}, {}, {} AS rank FROM pages p WHERE {}",
            page_columns(),
            Sql::raw(if with_content { "p.content" } else { "NULL::jsonb AS content" }),
            role_rank("p.space_id", user_id),
            condition
        ))
        .await?;
    Ok(row.map(|page| {
        let role = rank_to_role(page.opt_i64("rank"));
        PageAccess { page, role }
    }))
}

#[derive(Default, Clone, Copy)]
pub struct PageOptions {
    pub with_content: bool,
    pub allow_deleted: bool,
}

/// Resolves a page the user may access with at least `min`. Non-members get
/// 404 so page existence is not revealed; trashed pages only allow reads.
pub async fn require_page(user: &AuthUser, reference: &str, min: &str, options: PageOptions) -> Result<PageAccess> {
    let access = find_page(&user.id, reference, options.with_content).await?;
    let Some(access) = access.filter(|a| a.role.is_some()) else { return Err(not_found("Page")) };
    if !has_role(access.role, min) {
        return Err(forbidden());
    }
    if access.is_deleted() && min != "reader" && !options.allow_deleted {
        return Err(not_found("Page"));
    }
    Ok(access)
}

pub async fn can_read_page(user_id: &str, page_id: &str) -> Result<bool> {
    Ok(find_page(user_id, page_id, false).await?.is_some_and(|access| has_role(access.role, "reader")))
}

pub async fn can_edit_page(user_id: &str, page_id: &str) -> Result<bool> {
    Ok(find_page(user_id, page_id, false).await?.is_some_and(|access| !access.is_deleted() && has_role(access.role, "writer")))
}

pub struct CollabPage {
    pub content: Value,
    pub doc_version: f64,
}

pub async fn load_page_for_collab(page_id: &str) -> Result<Option<CollabPage>> {
    if !is_uuid(page_id) {
        return Ok(None);
    }
    let row = db().first(sql!("SELECT content, doc_version, space_id, deleted_at FROM pages WHERE id = {}", page_id)).await?;
    Ok(row.map(|row| CollabPage { content: row.json("content"), doc_version: row.i64("doc_version") as f64 }))
}

/// The stored document version, or `None` when the page is gone.
pub async fn stored_doc_version(page_id: &str) -> Result<Option<f64>> {
    let row = db().first(sql!("SELECT doc_version FROM pages WHERE id = {}", page_id)).await?;
    Ok(row.map(|row| row.i64("doc_version") as f64))
}

/// Ancestors of a page from the root down, ending with the page itself.
pub async fn breadcrumbs(page_id: &str) -> Result<Vec<Value>> {
    let rows = db()
        .query(sql!(
            "WITH RECURSIVE chain AS (
               SELECT id, parent_id, 0 AS depth FROM pages WHERE id = {}
               UNION ALL
               SELECT p.id, p.parent_id, chain.depth + 1 FROM pages p JOIN chain ON p.id = chain.parent_id WHERE chain.depth < 1000
             )
             SELECT {} FROM chain JOIN pages p ON p.id = chain.id ORDER BY chain.depth DESC",
            page_id,
            tree_columns()
        ))
        .await?;
    Ok(rows.iter().map(|row| Value::Object(to_tree_item(row))).collect())
}

/// Where a page goes among its siblings.
#[derive(Clone, Copy)]
pub enum Place<'a> {
    /// After every sibling (`afterId` undefined).
    Last,
    /// Before every sibling (`afterId` null).
    First,
    After(&'a str),
}

/// Position for a page placed among the non-deleted children of `parent_id`.
pub async fn sibling_position(db: Conn<'_>, space_id: &str, parent_id: Option<&str>, place: Place<'_>, exclude_id: Option<&str>) -> Result<String> {
    let siblings = || {
        sql!(
            "p.space_id = {} AND p.parent_id IS NOT DISTINCT FROM {}::uuid
             AND p.deleted_at IS NULL AND p.id IS DISTINCT FROM {}::uuid",
            space_id,
            parent_id,
            exclude_id
        )
    };
    let mut low: Option<String> = None;
    let mut high: Option<String> = None;
    match place {
        Place::Last => {
            let row = db.first(sql!("SELECT max(p.position) AS position FROM pages p WHERE {}", siblings())).await?;
            low = row.and_then(|r| r.opt_str("position"));
        }
        Place::First => {
            let row = db.first(sql!("SELECT min(p.position) AS position FROM pages p WHERE {}", siblings())).await?;
            high = row.and_then(|r| r.opt_str("position"));
        }
        Place::After(after_id) => {
            let after = db.first(sql!("SELECT p.position FROM pages p WHERE p.id = {} AND {}", after_id, siblings())).await?;
            let Some(after) = after else { return Err(not_found("Sibling page")) };
            let position = after.str("position");
            let next = db.first(sql!("SELECT min(p.position) AS position FROM pages p WHERE {} AND p.position > {}", siblings(), &position)).await?;
            high = next.and_then(|r| r.opt_str("position"));
            low = Some(position);
        }
    }
    key_between(low.as_deref(), high.as_deref()).map_err(|_| conflict("position_conflict", "Could not place the page between its neighbours"))
}

/// Replaces the page's outgoing links and synced blocks with those found in `content`.
pub async fn index_page_content(db: Conn<'_>, page_id: &str, content: &Value) -> Result<()> {
    let links = doc_links(Some(content));
    db.execute(sql!("DELETE FROM page_links WHERE source_id = {}", page_id)).await?;
    if !links.page_ids.is_empty() || !links.slug_ids.is_empty() {
        let page_ids: Vec<&String> = links.page_ids.iter().filter(|id| is_uuid(id)).collect();
        db.execute(sql!(
            "INSERT INTO page_links (source_id, target_id)
             SELECT {}::uuid, id FROM pages
             WHERE (id = ANY({}::uuid[]) OR slug_id = ANY({}::text[]))
               AND id <> {}
             ON CONFLICT DO NOTHING",
            page_id,
            array(&page_ids),
            array(&links.slug_ids),
            page_id
        ))
        .await?;
    }
    let blocks = synced_blocks_of(content);
    let block_ids: Vec<&String> = blocks.iter().map(|(id, _)| id).collect();
    db.execute(sql!("DELETE FROM synced_blocks WHERE page_id = {} AND NOT (block_id = ANY({}::text[]))", page_id, array(&block_ids))).await?;
    if !blocks.is_empty() {
        let rows: Vec<Value> = blocks.iter().map(|(id, content)| json!({ "block_id": id, "content": content })).collect();
        db.execute(sql!(
            "INSERT INTO synced_blocks (page_id, block_id, content)
             SELECT {}::uuid, r.block_id, r.content FROM jsonb_to_recordset({}::jsonb) AS r(block_id text, content jsonb)
             ON CONFLICT (page_id, block_id) DO UPDATE SET content = excluded.content, updated_at = now()
             WHERE synced_blocks.content IS DISTINCT FROM excluded.content",
            page_id,
            Value::Array(rows)
        ))
        .await?;
    }
    Ok(())
}

pub struct SaveContentInput {
    pub content: Value,
    pub doc_version: f64,
    pub editor_id: Option<String>,
    pub contributor_ids: Vec<String>,
    /// The stored version this save replaces; any other version refuses it.
    pub base_version: Option<f64>,
}

const UPDATE_NOTIFY_COOLDOWN: &str = "7 hours";

enum Saved {
    Gone,
    Conflict,
    Done { previous_content: Value, space_id: String, deleted: bool },
}

/// Persists collaborative content: text, version, editors, links and synced
/// blocks; snapshots a version when the last one is old enough; notifies newly
/// mentioned users and page/space watchers. Returns false, saving nothing, when
/// the stored version isn't `base_version`. Nothing after the commit may fail:
/// the caller would retry from a version that's no longer stored, and be refused.
pub async fn save_page_content(page_id: &str, input: &SaveContentInput) -> Result<bool> {
    let mut editors: Vec<String> = Vec::new();
    for id in input.editor_id.iter().chain(input.contributor_ids.iter()) {
        if is_uuid(id) && !editors.contains(id) {
            editors.push(id.clone());
        }
    }
    let editor_id = input.editor_id.as_deref().filter(|id| is_uuid(id));
    let saved = begin(async |tx| -> Result<Saved> {
        let previous = tx.first(sql!("SELECT content, space_id, deleted_at, doc_version FROM pages WHERE id = {} FOR UPDATE", page_id)).await?;
        let Some(previous) = previous else { return Ok(Saved::Gone) };
        if input.base_version.is_some_and(|base| previous.i64("doc_version") as f64 != base) {
            return Ok(Saved::Conflict);
        }
        tx.execute(sql!(
            "UPDATE pages SET
               content = {}::jsonb,
               text_content = {},
               doc_version = {},
               last_editor_id = COALESCE({}::uuid, last_editor_id),
               contributor_ids = ARRAY(SELECT DISTINCT unnest(contributor_ids || {}::uuid[])),
               updated_at = now()
             WHERE id = {}",
            &input.content,
            doc_text(Some(&input.content)),
            number_to_string(input.doc_version),
            editor_id,
            array(&editors),
            page_id
        ))
        .await?;
        index_page_content(tx, page_id, &input.content).await?;
        tx.execute(sql!(
            "INSERT INTO page_versions (page_id, title, icon, content, editor_id, contributor_ids)
             SELECT p.id, p.title, p.icon, p.content, p.last_editor_id, p.contributor_ids FROM pages p
             WHERE p.id = {}
               AND NOT EXISTS (
                 SELECT 1 FROM page_versions v WHERE v.page_id = p.id
                   AND v.created_at > now() - CASE WHEN p.created_at > now() - interval '5 minutes'
                     THEN interval '60 seconds' ELSE interval '5 minutes' END
               )
               AND p.content IS DISTINCT FROM (
                 SELECT v.content FROM page_versions v WHERE v.page_id = p.id ORDER BY v.created_at DESC LIMIT 1
               )",
            page_id
        ))
        .await?;
        Ok(Saved::Done { previous_content: previous.json("content"), space_id: previous.str("space_id"), deleted: !previous.is_null("deleted_at") })
    })
    .await?;
    let (previous_content, space_id) = match saved {
        Saved::Conflict => return Ok(false),
        Saved::Gone | Saved::Done { deleted: true, .. } => return Ok(true),
        Saved::Done { previous_content, space_id, .. } => (previous_content, space_id),
    };

    let actor_id = editor_id.map(str::to_string).or_else(|| editors.first().cloned());
    let notified = async {
        watch_page(page_id, &editors).await?;
        let before = doc_mentioned_user_ids(Some(&previous_content));
        let mentioned: Vec<String> = doc_mentioned_user_ids(Some(&input.content)).into_iter().filter(|id| is_uuid(id) && !before.contains(id)).collect();
        let notified = notify(NotifyInput {
            kind: "page.mention",
            recipient_ids: mentioned,
            actor_id: actor_id.as_deref(),
            page_id,
            comment_id: None,
            excerpt: None,
        })
        .await?;
        let watchers = db()
            .query(sql!(
                "SELECT DISTINCT w.user_id FROM watchers w
                 WHERE (w.page_id = {} OR w.space_id = {})
                   AND NOT (w.user_id = ANY({}::uuid[]))
                   AND NOT EXISTS (
                     SELECT 1 FROM notifications n
                     WHERE n.user_id = w.user_id AND n.page_id = {} AND n.kind = 'page.updated'
                       AND n.created_at > now() - {}::interval
                   )",
                page_id,
                &space_id,
                array(&editors),
                page_id,
                UPDATE_NOTIFY_COOLDOWN
            ))
            .await?;
        notify(NotifyInput {
            kind: "page.updated",
            recipient_ids: watchers.iter().map(|w| w.str("user_id")).filter(|id| !notified.contains(id)).collect(),
            actor_id: actor_id.as_deref(),
            page_id,
            comment_id: None,
            excerpt: None,
        })
        .await?;
        Ok::<(), crate::http::AppError>(())
    };
    if let Err(error) = notified.await {
        logger::error_with("page notifications failed", &error, json!({ "pageId": page_id }));
    }
    Ok(true)
}

/// Permanently deletes pages matching `root_condition` and all their descendants, with their files.
async fn delete_subtrees(root_condition: Sql) -> Result<i64> {
    let rows = db()
        .query(sql!(
            "WITH RECURSIVE subtree AS (
               SELECT id FROM pages WHERE {}
               UNION
               SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
             ),
             removed_files AS (DELETE FROM files WHERE page_id IN (SELECT id FROM subtree) RETURNING storage_key),
             removed_pages AS (DELETE FROM pages WHERE id IN (SELECT id FROM subtree) RETURNING id)
             SELECT storage_key, NULL::uuid AS page_id FROM removed_files
             UNION ALL
             SELECT NULL, id FROM removed_pages",
            root_condition
        ))
        .await?;
    let keys: Vec<String> = rows.iter().filter_map(|row| row.opt_str("storage_key")).filter(|key| !key.is_empty()).collect();
    storage::remove_many(&keys).await?;
    Ok(rows.iter().filter(|row| !row.is_null("page_id")).count() as i64)
}

pub async fn delete_page_permanently(page_id: &str) -> Result<i64> {
    delete_subtrees(sql!("id = {}", page_id)).await
}

/// Permanently removes pages that have been in the trash longer than the workspace retention.
pub async fn purge_trash() -> Result<i64> {
    let workspace = db().first(sql!("SELECT settings FROM workspace WHERE id = 1")).await?;
    let days = js_number_opt(workspace.map(|w| w.json("settings")).as_ref().and_then(|s| s.get("trashRetentionDays")));
    let retention = if days.is_finite() && days == days.trunc() && days >= 1.0 { days as i64 } else { 30 };
    delete_subtrees(sql!("deleted_at IS NOT NULL AND deleted_at < now() - make_interval(days => {}::int)", retention)).await
}

/// Moves a page and its non-deleted descendants to the trash and removes their shares.
pub async fn trash_page(page_id: &str, user_id: &str) -> Result<()> {
    db().execute(sql!(
        "WITH RECURSIVE subtree AS (
           SELECT id FROM pages WHERE id = {} AND deleted_at IS NULL
           UNION
           SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id WHERE p.deleted_at IS NULL
         ),
         removed_shares AS (DELETE FROM shares WHERE page_id IN (SELECT id FROM subtree))
         UPDATE pages SET deleted_at = now(), deleted_by = {} WHERE id IN (SELECT id FROM subtree)",
        page_id,
        user_id
    ))
    .await?;
    Ok(())
}

/// Restores a trashed page with the descendants trashed together with it. When
/// its parent is still trashed (or gone) it becomes the last root page.
pub async fn restore_page(page_id: &str) -> Result<()> {
    begin(async |tx| -> Result<()> {
        let page = tx
            .first(sql!(
                "SELECT p.id, p.space_id, p.parent_id, p.deleted_at, parent.deleted_at AS parent_deleted_at,
                   parent.id AS existing_parent
                 FROM pages p LEFT JOIN pages parent ON parent.id = p.parent_id
                 WHERE p.id = {} FOR UPDATE OF p",
                page_id
            ))
            .await?;
        let Some(page) = page.filter(|p| !p.is_null("deleted_at")) else { return Ok(()) };
        if !page.is_null("parent_id") && (page.is_null("existing_parent") || !page.is_null("parent_deleted_at")) {
            let position = sibling_position(tx, &page.str("space_id"), None, Place::Last, Some(page_id)).await?;
            tx.execute(sql!("UPDATE pages SET parent_id = NULL, position = {} WHERE id = {}", position, page_id)).await?;
        }
        tx.execute(sql!(
            "WITH RECURSIVE root AS (SELECT deleted_at FROM pages WHERE id = {}),
             subtree AS (
               SELECT id FROM pages WHERE id = {}
               UNION
               SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id JOIN root ON p.deleted_at = root.deleted_at
             )
             UPDATE pages SET deleted_at = NULL, deleted_by = NULL WHERE id IN (SELECT id FROM subtree)",
            page_id,
            page_id
        ))
        .await?;
        Ok(())
    })
    .await
}

/// True when `candidate_id` is `page_id` itself or one of its descendants.
pub async fn is_in_subtree(db: Conn<'_>, page_id: &str, candidate_id: &str) -> Result<bool> {
    let row = db
        .first(sql!(
            "WITH RECURSIVE chain AS (
               SELECT id, parent_id, 0 AS depth FROM pages WHERE id = {}
               UNION ALL
               SELECT p.id, p.parent_id, chain.depth + 1 FROM pages p JOIN chain ON p.id = chain.parent_id WHERE chain.depth < 1000
             )
             SELECT EXISTS (SELECT 1 FROM chain WHERE id = {}) AS inside",
            candidate_id,
            page_id
        ))
        .await?;
    Ok(row.is_some_and(|r| r.bool("inside")))
}
