//! Port of `src/server/lib/duplicate.ts`.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::common::ids::{is_uuid, slug_id, uuid};
use crate::common::text::{doc_links, doc_text};
use crate::content::{rewrite_file_refs, strip_comment_marks, synced_blocks_of};
use crate::db::{array, begin, db, Row};
use crate::http::{http_error, AppError, Result};
use crate::jsutil::{js_json, js_slice, parse_json};
use crate::pages::{sibling_position, Place};
use crate::sql;
use crate::storage::{self, file_storage_key};

const MAX_PAGES: usize = 2000;

/// Points inline base embeds at the copies of their pages.
fn remap_base_embeds(node: &mut Value, page_ids: &HashMap<String, String>) {
    if node.get("type").and_then(Value::as_str) == Some("base") {
        let mapped = node.get("attrs").and_then(|a| a.get("pageId")).and_then(Value::as_str).and_then(|id| page_ids.get(id)).cloned();
        if let Some(mapped) = mapped {
            node["attrs"]["pageId"] = Value::String(mapped);
        }
    }
    if let Some(Value::Array(content)) = node.get_mut("content") {
        for child in content {
            remap_base_embeds(child, page_ids);
        }
    }
}

/// Copies a page and its non-deleted descendants into `target_space_id` with
/// new ids, a `Copy of ` root title, comment marks removed and uploaded files
/// duplicated. Returns the new root page id.
pub async fn duplicate_page(source: &Row, target_space_id: &str, user_id: &str) -> Result<String> {
    let source_id = source.str("id");
    let pages = db()
        .query(sql!(
            "WITH RECURSIVE subtree AS (
               SELECT id, 0 AS depth FROM pages WHERE id = {}
               UNION ALL
               SELECT p.id, s.depth + 1 FROM pages p JOIN subtree s ON p.parent_id = s.id
               WHERE p.deleted_at IS NULL AND s.depth < 1000
             )
             SELECT p.id, p.parent_id, p.position, p.title, p.icon, p.cover, p.content, p.is_base
             FROM subtree s JOIN pages p ON p.id = s.id ORDER BY s.depth, p.position LIMIT {}",
            &source_id,
            MAX_PAGES + 1
        ))
        .await?;
    if pages.len() > MAX_PAGES {
        return Err(http_error(413, "too_large", format!("Cannot duplicate more than {MAX_PAGES} pages at once")));
    }

    let page_ids: HashMap<String, String> = pages.iter().map(|p| (p.str("id"), uuid())).collect();
    let old_page_ids: Vec<String> = pages.iter().map(|p| p.str("id")).collect();
    let files = db()
        .query(sql!(
            "SELECT id, page_id, name, mime, size, storage_key FROM files
             WHERE purpose = 'page' AND page_id = ANY({}::uuid[])",
            array(&old_page_ids)
        ))
        .await?;
    let file_ids: HashMap<String, String> = files.iter().map(|f| (f.str("id"), uuid())).collect();

    let mut copied: Vec<String> = Vec::new();
    let outcome = copy_into(source, target_space_id, user_id, &pages, &page_ids, &files, &file_ids, &mut copied).await;
    if outcome.is_err() {
        // Nothing of a failed copy is kept.
        let _ = storage::remove_many(&copied).await;
    }
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn copy_into(
    source: &Row,
    target_space_id: &str,
    user_id: &str,
    pages: &[Row],
    page_ids: &HashMap<String, String>,
    files: &[Row],
    file_ids: &HashMap<String, String>,
    copied: &mut Vec<String>,
) -> Result<String> {
    let mut file_rows: Vec<Value> = Vec::new();
    for file in files {
        let id = &file_ids[&file.str("id")];
        let key = file_storage_key(id, &file.str("name"));
        storage::copy(&file.str("storage_key"), &key).await?;
        copied.push(key.clone());
        file_rows.push(json!({
            "id": id,
            "page_id": page_ids[&file.str("page_id")],
            "name": file.str("name"),
            "mime": file.str("mime"),
            "size": file.i64("size"),
            "storage_key": key,
        }));
    }

    struct Copy {
        row: Value,
        link_page_ids: Vec<String>,
        link_slug_ids: Vec<String>,
        synced: Vec<(String, Vec<Value>)>,
    }
    let mut rows: Vec<Copy> = Vec::with_capacity(pages.len());
    for (index, page) in pages.iter().enumerate() {
        let content = page.opt_json("content").filter(|c| !c.is_null()).map(|content| {
            let mut rewritten = rewrite_file_refs(
                &strip_comment_marks(&content),
                &|parsed, _| file_ids.get(&parsed.file_id).map(|id| format!("/api/files/{id}{}{}", parsed.rest, parsed.suffix)),
                Some(file_ids),
            );
            remap_base_embeds(&mut rewritten, page_ids);
            rewritten
        });
        let links = doc_links(content.as_ref());
        let title = page.opt_str("title");
        let title = if index == 0 { Some(js_slice(&format!("Copy of {}", title.as_deref().unwrap_or("Untitled")), 0, Some(500))) } else { title };
        let parent_id = if index == 0 { None } else { page.opt_str("parent_id").and_then(|id| page_ids.get(&id).cloned()) };
        rows.push(Copy {
            row: json!({
                "id": page_ids[&page.str("id")],
                "slug_id": slug_id(),
                "parent_id": parent_id,
                "position": page.str("position"),
                "title": title,
                "icon": page.opt_str("icon"),
                "cover": page.opt_str("cover"),
                "content": content,
                "text_content": doc_text(content.as_ref()),
                "is_base": page.bool("is_base"),
            }),
            link_page_ids: links.page_ids.into_iter().filter(|id| is_uuid(id)).collect(),
            link_slug_ids: links.slug_ids,
            synced: content.as_ref().map(synced_blocks_of).unwrap_or_default(),
        });
    }

    let source_id = source.str("id");
    let same_space = target_space_id == source.str("space_id");
    let root_parent = if same_space { source.opt_str("parent_id") } else { None };
    let bases: Vec<Value> = pages.iter().filter(|p| p.bool("is_base")).map(|p| json!({ "old": p.str("id"), "new": page_ids[&p.str("id")] })).collect();
    begin(async |tx| -> Result<String> {
        let place = if same_space { Place::After(&source_id) } else { Place::Last };
        let position = sibling_position(tx, target_space_id, root_parent.as_deref(), place, None).await?;
        let mut page_rows: Vec<Value> = rows.iter().map(|copy| copy.row.clone()).collect();
        page_rows[0]["parent_id"] = json!(root_parent);
        page_rows[0]["position"] = json!(position);
        let root_id = page_rows[0]["id"].as_str().unwrap_or_default().to_string();
        tx.execute(sql!(
            "INSERT INTO pages (id, slug_id, space_id, parent_id, position, title, icon, cover, content, text_content,
               creator_id, last_editor_id, contributor_ids, is_base)
             SELECT r.id, r.slug_id, {}::uuid, r.parent_id, r.position, r.title, r.icon, r.cover, r.content,
               r.text_content, {}::uuid, {}::uuid, ARRAY[{}]::uuid[], r.is_base
             FROM jsonb_to_recordset({}::jsonb)
               AS r(id uuid, slug_id text, parent_id uuid, position text, title text, icon text, cover text, content jsonb, text_content text,
                 is_base boolean)",
            target_space_id,
            user_id,
            user_id,
            user_id,
            Value::Array(page_rows)
        ))
        .await?;
        if !bases.is_empty() {
            let map = || sql!("jsonb_to_recordset({}::jsonb) AS m(old uuid, new uuid)", Value::Array(bases.clone()));
            tx.execute(sql!(
                "INSERT INTO base_properties (page_id, id, name, type, options, is_primary, position)
                 SELECT m.new, bp.id, bp.name, bp.type, bp.options, bp.is_primary, bp.position
                 FROM {} JOIN base_properties bp ON bp.page_id = m.old",
                map()
            ))
            .await?;
            tx.execute(sql!(
                "INSERT INTO base_rows (page_id, cells, position, creator_id, last_editor_id, created_at, updated_at)
                 SELECT m.new, br.cells, br.position, br.creator_id, {}::uuid, br.created_at, now()
                 FROM {} JOIN base_rows br ON br.page_id = m.old",
                user_id,
                map()
            ))
            .await?;
            tx.execute(sql!(
                "INSERT INTO base_views (page_id, name, type, config, position, creator_id)
                 SELECT m.new, bv.name, bv.type, bv.config, bv.position, {}::uuid
                 FROM {} JOIN base_views bv ON bv.page_id = m.old",
                user_id,
                map()
            ))
            .await?;
            if !file_ids.is_empty() {
                // File cells point at the copied files (ids and URLs).
                let pattern = file_ids.keys().cloned().collect::<Vec<_>>().join("|");
                let new_bases: Vec<String> = bases.iter().filter_map(|b| b["new"].as_str().map(str::to_string)).collect();
                let holding = tx
                    .query(sql!(
                        "SELECT id, cells FROM base_rows
                         WHERE page_id = ANY({}::uuid[]) AND cells::text ~ {}",
                        array(&new_bases),
                        &pattern
                    ))
                    .await?;
                let mut updates: Vec<Value> = Vec::new();
                for row in &holding {
                    let mut text = js_json(&row.json("cells"));
                    for (old, new) in file_ids {
                        text = text.replace(old.as_str(), new);
                    }
                    let cells = parse_json(text.as_bytes()).map_err(AppError::other)?;
                    updates.push(json!({ "id": row.str("id"), "cells": cells }));
                }
                if !updates.is_empty() {
                    tx.execute(sql!(
                        "UPDATE base_rows br SET cells = u.cells
                         FROM jsonb_to_recordset({}::jsonb) AS u(id uuid, cells jsonb)
                         WHERE br.id = u.id",
                        Value::Array(updates)
                    ))
                    .await?;
                }
            }
        }
        if !file_rows.is_empty() {
            tx.execute(sql!(
                "INSERT INTO files (id, purpose, page_id, space_id, uploader_id, name, mime, size, storage_key)
                 SELECT r.id, 'page', r.page_id, {}::uuid, {}::uuid, r.name, r.mime, r.size, r.storage_key
                 FROM jsonb_to_recordset({}::jsonb)
                   AS r(id uuid, page_id uuid, name text, mime text, size bigint, storage_key text)",
                target_space_id,
                user_id,
                Value::Array(file_rows.clone())
            ))
            .await?;
        }
        let link_rows: Vec<Value> = rows
            .iter()
            .filter(|copy| !copy.link_page_ids.is_empty() || !copy.link_slug_ids.is_empty())
            .map(|copy| json!({ "id": copy.row["id"], "page_ids": copy.link_page_ids, "slug_ids": copy.link_slug_ids }))
            .collect();
        if !link_rows.is_empty() {
            tx.execute(sql!(
                "INSERT INTO page_links (source_id, target_id)
                 SELECT r.id, p.id
                 FROM jsonb_to_recordset({}::jsonb)
                   AS r(id uuid, page_ids text[], slug_ids text[])
                 JOIN pages p ON (p.id::text = ANY(r.page_ids) OR p.slug_id = ANY(r.slug_ids)) AND p.id <> r.id
                 ON CONFLICT DO NOTHING",
                Value::Array(link_rows)
            ))
            .await?;
        }
        let synced_rows: Vec<Value> = rows
            .iter()
            .flat_map(|copy| copy.synced.iter().map(|(block_id, content)| json!({ "page_id": copy.row["id"], "block_id": block_id, "content": content })))
            .collect();
        if !synced_rows.is_empty() {
            tx.execute(sql!(
                "INSERT INTO synced_blocks (page_id, block_id, content)
                 SELECT r.page_id, r.block_id, r.content
                 FROM jsonb_to_recordset({}::jsonb) AS r(page_id uuid, block_id text, content jsonb)
                 ON CONFLICT DO NOTHING",
                Value::Array(synced_rows)
            ))
            .await?;
        }
        let new_ids: Vec<String> = rows.iter().filter_map(|copy| copy.row["id"].as_str().map(str::to_string)).collect();
        tx.execute(sql!(
            "INSERT INTO watchers (user_id, page_id)
             SELECT {}::uuid, unnest({}::uuid[])
             ON CONFLICT (user_id, page_id) WHERE page_id IS NOT NULL DO NOTHING",
            user_id,
            array(&new_ids)
        ))
        .await?;
        Ok(root_id)
    })
    .await
}
