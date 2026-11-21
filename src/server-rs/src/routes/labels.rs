//! Port of `src/server/routes/labels.ts`.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::common::ids::is_uuid;
use crate::db::{array, begin, db};
use crate::http::{bad_request, empty, get, not_found, post, read_json, Ctx, Reply, Result, Route};
use crate::jsutil::{js_trim, take_chars};
use crate::pages::{require_page, to_tree_item, tree_columns, PageOptions};
use crate::permissions::readable_space_ids;
use crate::search::escape_like;
use crate::spaces::space_ref_json;
use crate::validate::{input, max, min_max, Input, JS_SPACE};
use crate::{handler, sql};

const PLAIN: PageOptions = PageOptions { with_content: false, allow_deleted: false };

/// Trimmed, lower-cased, whitespace runs become `-`.
pub fn normalize_label(name: &str) -> String {
    static SPACES: OnceLock<Regex> = OnceLock::new();
    let spaces = SPACES.get_or_init(|| Regex::new(&format!("[{JS_SPACE}]+")).expect("space pattern"));
    let lowered = js_trim(name).to_lowercase();
    let dashed = spaces.replace_all(&lowered, "-");
    take_chars(&dashed, 50).trim_end_matches('-').to_string()
}

async fn page_labels(page_id: &str) -> Result<Reply> {
    let rows = db()
        .query(sql!(
            "SELECT l.id, l.name FROM page_labels pl JOIN labels l ON l.id = pl.label_id
             WHERE pl.page_id = {} ORDER BY l.name",
            page_id
        ))
        .await?;
    Ok(Value::Array(rows.iter().map(|r| json!({ "id": r.str("id"), "name": r.str("name") })).collect()).into())
}

async fn list_for_page(ctx: &mut Ctx) -> Result<Reply> {
    let page_id = require_page(ctx.user(), ctx.param("id"), "reader", PLAIN).await?.id();
    page_labels(&page_id).await
}

async fn add(ctx: &mut Ctx) -> Result<Reply> {
    let page_id = require_page(ctx.user(), ctx.param("id"), "writer", PLAIN).await?.id();
    let given = input(read_json(ctx).await?).strings("names", 25, max(100))?.unwrap_or_default();
    let mut names: Vec<String> = Vec::new();
    for name in given.iter().map(|name| normalize_label(name)) {
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    if names.is_empty() {
        return Err(bad_request("names is required"));
    }
    begin(async |tx| -> Result<()> {
        tx.execute(sql!("INSERT INTO labels (name) SELECT unnest({}::text[]) ON CONFLICT (name) DO NOTHING", array(&names))).await?;
        tx.execute(sql!(
            "INSERT INTO page_labels (page_id, label_id)
             SELECT {}, id FROM labels WHERE name = ANY({}::text[])
             ON CONFLICT DO NOTHING",
            &page_id,
            array(&names)
        ))
        .await?;
        Ok(())
    })
    .await?;
    page_labels(&page_id).await
}

async fn remove(ctx: &mut Ctx) -> Result<Reply> {
    let page_id = require_page(ctx.user(), ctx.param("id"), "writer", PLAIN).await?.id();
    let label_id = input(read_json(ctx).await?).uuid("labelId")?;
    db().execute(sql!("DELETE FROM page_labels WHERE page_id = {} AND label_id = {}", &page_id, &label_id)).await?;
    db().execute(sql!("DELETE FROM labels l WHERE l.id = {} AND NOT EXISTS (SELECT 1 FROM page_labels WHERE label_id = l.id)", &label_id)).await?;
    empty()
}

async fn list(ctx: &mut Ctx) -> Result<Reply> {
    let q = normalize_label(&Input::query(ctx).optional_string("query", min_max(0, 100))?.unwrap_or_default());
    let rows = db()
        .query(sql!(
            "SELECT l.id, l.name, count(p.id)::int AS page_count
             FROM labels l
             JOIN page_labels pl ON pl.label_id = l.id
             JOIN pages p ON p.id = pl.page_id AND p.deleted_at IS NULL AND p.space_id IN {}
             WHERE {}::text = '' OR l.name LIKE {}
             GROUP BY l.id ORDER BY count(p.id) DESC, l.name LIMIT 200",
            readable_space_ids(&ctx.user().id),
            &q,
            format!("%{}%", escape_like(&q))
        ))
        .await?;
    let list: Vec<Value> = rows.iter().map(|r| json!({ "id": r.str("id"), "name": r.str("name"), "pageCount": r.i64("page_count") })).collect();
    Ok(Value::Array(list).into())
}

async fn pages(ctx: &mut Ctx) -> Result<Reply> {
    let id = ctx.param("id").to_string();
    if !is_uuid(&id) {
        return Err(not_found("Label"));
    }
    let rows = db()
        .query(sql!(
            "SELECT {}, {} AS space
             FROM page_labels pl JOIN pages p ON p.id = pl.page_id JOIN spaces s ON s.id = p.space_id
             WHERE pl.label_id = {} AND p.deleted_at IS NULL AND p.space_id IN {}
             ORDER BY p.updated_at DESC, p.id LIMIT 500",
            tree_columns(),
            space_ref_json("s"),
            &id,
            readable_space_ids(&ctx.user().id)
        ))
        .await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut item = to_tree_item(r);
            item.insert("space".into(), r.json("space"));
            Value::Object(item)
        })
        .collect();
    Ok(Value::Array(list).into())
}

pub fn routes() -> Vec<Route> {
    vec![
        get("/pages/:id/labels", handler!(list_for_page)),
        post("/pages/:id/labels", handler!(add)),
        post("/pages/:id/labels/remove", handler!(remove)),
        get("/labels", handler!(list)),
        get("/labels/:id/pages", handler!(pages)),
    ]
}
