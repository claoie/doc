//! Port of `src/server/routes/bases.ts`.

use std::sync::OnceLock;

use bytes::Bytes;
use futures_util::StreamExt;
use regex::Regex;
use serde_json::{json, Map, Value};

use crate::bases::{
    all_rows, load_properties, load_views, new_property_id, parse_filter, parse_sorts, query_rows, require_base, resolve_pages, row_columns,
    row_references, row_text, seed_base, text_context, to_base, to_view, AllRows, RowQuery, RowRecord,
};
use crate::common::bases::{
    convert_cell, is_choice_type, is_editable_type, is_filter_group, is_system_type, normalize_cells, Property, RowMeta, TextContext, LIMITS,
    PROPERTY_TYPES, VIEW_TYPES,
};
use crate::common::editor::doc_schema::empty_doc;
use crate::common::formula::{affected_formulas, compile_formula, compute_formulas, rename_in_source};
use crate::common::ids::{is_uuid, slug_id};
use crate::common::positions::key_between;
use crate::common::text::doc_text;
use crate::db::{array, begin, db, Conn};
use crate::files::try_content_disposition;
use crate::http::{bad_request, conflict, empty, get, not_found, post, read_json, read_json_limit, response, AppError, Ctx, Reply, Result, Route};
use crate::jsutil::{is_integer, js_json, js_number, js_slice, js_trim, js_truthy_opt, same_json, utf16_len};
use crate::logger;
use crate::notifications::watch_page;
use crate::pages::{require_page, sibling_position, to_tree_item, tree_columns, PageAccess, PageOptions, Place};
use crate::permissions::require_space_role;
use crate::realtime::hub::emit_to_space;
use crate::storage::{stream_body, ByteStream};
use crate::validate::{input, max, min_max, Input, StringRule};
use crate::{handler, sql};

const NAME_RULE: StringRule = min_max(1, LIMITS.name);
const VIEW_NAME_RULE: StringRule = min_max(0, LIMITS.name);
const TITLE_RULE: StringRule = min_max(0, 500);
const BODY_LIMIT: usize = 4 * 1024 * 1024;
const OPTIONS_LIMIT: usize = 256 * 1024;

fn emit(access: &PageAccess, event: Value, request_id: Option<String>) {
    let space_id = access.space_id();
    let mut message = Map::new();
    message.insert("kind".into(), json!("base"));
    message.insert("pageId".into(), json!(access.id()));
    message.insert("spaceId".into(), json!(space_id));
    message.insert("event".into(), event);
    if let Some(request_id) = request_id {
        message.insert("requestId".into(), Value::String(request_id));
    }
    emit_to_space(&space_id, &Value::Object(message));
}

async fn emit_base(access: &PageAccess, request_id: Option<String>) -> Result<()> {
    emit(access, json!({ "op": "base", "base": to_base(access).await? }), request_id);
    Ok(())
}

fn request_id(body: &Input) -> Result<Option<String>> {
    body.optional_string("requestId", max(64))
}

fn position(body: &Input) -> Result<Option<String>> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^[0-9A-Za-z]{1,512}$").expect("position pattern"));
    let value = body.optional_string("position", max(512))?;
    if value.as_deref().is_some_and(|value| !re.is_match(value)) {
        return Err(bad_request("position is invalid"));
    }
    Ok(value)
}

fn next_key(after: Option<&str>, before: Option<&str>) -> Result<String> {
    key_between(after, before).map_err(AppError::other)
}

// ---------------------------------------------------------------------------
// Property options

fn invalid_options() -> AppError {
    bad_request("Invalid property options")
}

fn parse_choices(value: Option<&Value>) -> Result<Vec<Value>> {
    let items = match value {
        None => return Ok(Vec::new()),
        Some(Value::Array(items)) if items.len() <= LIMITS.choices => items,
        Some(_) => return Err(invalid_options()),
    };
    let mut seen: Vec<&str> = Vec::new();
    let mut choices = Vec::with_capacity(items.len());
    for item in items {
        let Value::Object(choice) = item else { return Err(invalid_options()) };
        let id = match choice.get("id") {
            Some(Value::String(id)) if !id.is_empty() && utf16_len(id) <= 64 && !seen.contains(&id.as_str()) => id,
            _ => return Err(invalid_options()),
        };
        let name = match choice.get("name") {
            Some(Value::String(name)) if utf16_len(name) <= 200 => name,
            _ => return Err(invalid_options()),
        };
        let color = match choice.get("color") {
            None => "gray",
            Some(Value::String(color)) if utf16_len(color) <= 32 => color.as_str(),
            Some(_) => return Err(invalid_options()),
        };
        let category = match choice.get("category") {
            None => None,
            Some(Value::String(category)) if matches!(category.as_str(), "todo" | "inProgress" | "complete") => Some(category),
            Some(_) => return Err(invalid_options()),
        };
        seen.push(id);
        let mut out = Map::new();
        out.insert("id".into(), json!(id));
        out.insert("name".into(), json!(name));
        out.insert("color".into(), json!(color));
        if let Some(category) = category {
            out.insert("category".into(), json!(category));
        }
        choices.push(Value::Object(out));
    }
    Ok(choices)
}

fn default_options(type_: &str) -> Map<String, Value> {
    let defaults = match type_ {
        "select" | "multiSelect" => json!({ "choices": [], "choiceOrder": [] }),
        "number" => json!({ "format": "plain" }),
        "date" => json!({ "includeTime": false }),
        "person" => json!({ "allowMultiple": false }),
        _ => json!({}),
    };
    match defaults {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Validates options for a non-formula type and merges them over the type's defaults.
fn parse_options(type_: &str, raw: Option<&Value>) -> Result<Map<String, Value>> {
    let mut options = default_options(type_);
    let raw = match raw {
        None | Some(Value::Null) => return Ok(options),
        Some(Value::Object(raw)) => raw,
        Some(_) => return Err(invalid_options()),
    };
    if utf16_len(&js_json(&Value::Object(raw.clone()))) > OPTIONS_LIMIT {
        return Err(invalid_options());
    }
    for (key, value) in raw {
        options.insert(key.clone(), value.clone());
    }
    if is_choice_type(type_) {
        let choices = parse_choices(raw.get("choices"))?;
        let ids: Vec<String> = choices.iter().filter_map(|choice| choice["id"].as_str().map(str::to_string)).collect();
        let mut order: Vec<String> = Vec::new();
        let given = raw.get("choiceOrder").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str);
        for id in given.filter(|id| ids.iter().any(|known| known == id)).map(str::to_string).chain(ids.iter().cloned()) {
            if !order.contains(&id) {
                order.push(id);
            }
        }
        options.insert("choices".into(), Value::Array(choices));
        options.insert("choiceOrder".into(), json!(order));
    }
    if type_ == "number" {
        if let Some(format) = raw.get("format") {
            if !matches!(format.as_str(), Some("plain" | "currency" | "percent" | "progress")) {
                return Err(invalid_options());
            }
        }
        if let Some(precision) = raw.get("precision").filter(|precision| !precision.is_null()) {
            let n = js_number(precision);
            if !precision.is_number() || !is_integer(precision) || !(0.0..=20.0).contains(&n) {
                return Err(invalid_options());
            }
        }
    }
    if type_ == "date" {
        if let Some(format) = raw.get("timeFormat") {
            if !matches!(format.as_str(), Some("12h" | "24h")) {
                return Err(invalid_options());
            }
        }
    }
    Ok(options)
}

/// Compiles a formula; its source, result type and dependencies are derived on the server.
fn formula_options(raw: Option<&Value>, props: &[Property], self_id: &str) -> Result<Map<String, Value>> {
    let none = Map::new();
    let options = raw.and_then(Value::as_object).unwrap_or(&none);
    let source = options.get("source").and_then(Value::as_str).unwrap_or("");
    let compiled = compile_formula(source, props, Some(self_id)).map_err(|error| bad_request(error.message))?;
    let mut out = Map::new();
    if let Some(format @ Value::Object(_)) = options.get("formatOptions") {
        out.insert("formatOptions".into(), format.clone());
    }
    out.insert("source".into(), json!(source));
    out.insert("resultType".into(), json!(compiled.result_type));
    out.insert("dependencies".into(), json!(compiled.dependencies));
    Ok(out)
}

fn name_taken() -> AppError {
    bad_request("A property with this name already exists")
}

// ---------------------------------------------------------------------------
// Bulk cell rewrites

/// Applies per-row cell patches in one statement; a null value removes a key.
async fn patch_rows(conn: Conn<'_>, page_id: &str, patches: Map<String, Value>) -> Result<()> {
    if patches.is_empty() {
        return Ok(());
    }
    conn.execute(sql!(
        "UPDATE base_rows r SET cells = apply_cell_patch(r.cells, p.value)
         FROM jsonb_each({}::jsonb) p
         WHERE r.page_id = {} AND r.id = p.key::uuid",
        Value::Object(patches),
        page_id
    ))
    .await?;
    Ok(())
}

fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

/// Recomputes the given formulas on every row, writing only values that changed.
async fn backfill_formulas(conn: Conn<'_>, page_id: &str, props: &[Property], formula_ids: &[String]) -> Result<usize> {
    if formula_ids.is_empty() {
        return Ok(0);
    }
    let mut changed = 0;
    let now = now_ms();
    let mut batches = all_rows(page_id);
    while let Some(rows) = batches.next(conn).await? {
        let mut patches = Map::new();
        for row in &rows {
            let values = compute_formulas(props, &row.cells, &row.created_iso(), &row.updated_iso(), Some(formula_ids), now);
            let mut patch = Map::new();
            for (id, value) in values {
                if !same_json(row.cells.get(&id), Some(&value)) {
                    patch.insert(id, value);
                }
            }
            if !patch.is_empty() {
                patches.insert(row.id.clone(), Value::Object(patch));
            }
        }
        changed += patches.len();
        patch_rows(conn, page_id, patches).await?;
    }
    Ok(changed)
}

/// Rewrites one property's cells into another type.
async fn convert_rows(conn: Conn<'_>, user_id: &str, page_id: &str, from: &Property, to: &Property) -> Result<()> {
    let mut batches = all_rows(page_id);
    while let Some(rows) = batches.next(conn).await? {
        let holding: Vec<RowRecord> = rows.into_iter().filter(|row| row.cells.contains_key(&from.id)).collect();
        if holding.is_empty() {
            continue;
        }
        let mut ctx = TextContext::default();
        if from.type_ == "person" || from.type_ == "lastEditedBy" {
            ctx.users = text_context(&row_references(user_id, std::slice::from_ref(from), &holding).await?).users;
        }
        if from.type_ == "page" {
            let ids: Vec<String> = holding.iter().map(|row| crate::jsutil::js_string_opt(row.cells.get(&from.id))).collect();
            ctx.pages = text_context(&json!({ "pages": resolve_pages(user_id, &ids).await? })).pages;
        }
        let mut patches = Map::new();
        for row in &holding {
            let (created, updated) = (row.created_iso(), row.updated_iso());
            let meta =
                RowMeta { created_at: &created, updated_at: &updated, creator_id: row.creator_id.as_deref(), last_editor_id: row.last_editor_id.as_deref() };
            let current = row.cells.get(&from.id);
            let next = convert_cell(current, from, &to.type_, &to.options, &meta, &ctx).map_err(AppError::other)?;
            if !same_json(current, Some(&next)) {
                patches.insert(row.id.clone(), json!({ from.id.clone(): next }));
            }
        }
        patch_rows(conn, page_id, patches).await?;
    }
    Ok(())
}

fn strip_filter(group: &Value, property_id: &str) -> Value {
    let children: Vec<Value> = group
        .get("children")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|child| if is_filter_group(child) { strip_filter(child, property_id) } else { child.clone() })
        .filter(|child| {
            if is_filter_group(child) {
                child.get("children").and_then(Value::as_array).is_some_and(|children| !children.is_empty())
            } else {
                child.get("propertyId").and_then(Value::as_str) != Some(property_id)
            }
        })
        .collect();
    json!({ "op": group.get("op").cloned().unwrap_or(Value::Null), "children": children })
}

/// Drops references to a property from view configs so stored filters stay valid.
async fn strip_from_views(conn: Conn<'_>, page_id: &str, property_id: &str) -> Result<()> {
    for view in load_views(page_id, conn).await? {
        let Some(config) = view.get("config").and_then(Value::as_object) else { continue };
        let mut next = config.clone();
        if let Some(Value::Array(sorts)) = config.get("sorts") {
            let kept: Vec<Value> = sorts.iter().filter(|sort| sort.get("propertyId").and_then(Value::as_str) != Some(property_id)).cloned().collect();
            next.insert("sorts".into(), Value::Array(kept));
        }
        if let Some(filter) = config.get("filter").filter(|filter| crate::jsutil::js_truthy(filter)) {
            next.insert("filter".into(), strip_filter(filter, property_id));
        }
        for key in ["hiddenPropertyIds", "visiblePropertyIds", "propertyOrder"] {
            if let Some(Value::Array(ids)) = config.get(key) {
                let kept: Vec<Value> = ids.iter().filter(|id| id.as_str() != Some(property_id)).cloned().collect();
                next.insert(key.into(), Value::Array(kept));
            }
        }
        if let Some(Value::Object(widths)) = config.get("propertyWidths") {
            let kept: Map<String, Value> = widths.iter().filter(|(id, _)| id.as_str() != property_id).map(|(id, width)| (id.clone(), width.clone())).collect();
            next.insert("propertyWidths".into(), Value::Object(kept));
        }
        for key in ["groupByPropertyId", "datePropertyId"] {
            if config.get(key).and_then(Value::as_str) == Some(property_id) {
                next.shift_remove(key);
            }
        }
        let next = Value::Object(next);
        if js_json(&Value::Object(config.clone())) != js_json(&next) {
            conn.execute(sql!("UPDATE base_views SET config = {}::jsonb, updated_at = now() WHERE id = {}", &next, view["id"].as_str().unwrap_or_default()))
                .await?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// View config

fn invalid_config() -> AppError {
    bad_request("Invalid view config")
}

fn parse_config(raw: Option<&Value>) -> Result<Value> {
    let raw = match raw {
        None | Some(Value::Null) => return Ok(json!({})),
        Some(Value::Object(raw)) => raw,
        Some(_) => return Err(invalid_config()),
    };
    if utf16_len(&js_json(&Value::Object(raw.clone()))) > OPTIONS_LIMIT {
        return Err(invalid_config());
    }
    let mut config = raw.clone();
    if raw.contains_key("filter") {
        match parse_filter(raw.get("filter"), 0)? {
            Some(filter) => config.insert("filter".into(), filter),
            None => config.shift_remove("filter"),
        };
    }
    if raw.contains_key("sorts") {
        match parse_sorts(raw.get("sorts"))? {
            Some(sorts) => config.insert("sorts".into(), sorts),
            None => config.shift_remove("sorts"),
        };
    }
    for key in ["hiddenPropertyIds", "visiblePropertyIds", "propertyOrder", "hiddenChoiceIds", "choiceOrder"] {
        match raw.get(key) {
            None => {}
            Some(Value::Array(ids)) if ids.len() <= 500 && ids.iter().all(|id| id.as_str().is_some_and(|id| utf16_len(id) <= 64)) => {}
            Some(_) => return Err(invalid_config()),
        }
    }
    match raw.get("propertyWidths") {
        None => {}
        Some(Value::Object(widths)) if widths.values().all(|w| w.is_number() && (1.0..=5000.0).contains(&js_number(w))) => {}
        Some(_) => return Err(invalid_config()),
    }
    for key in ["groupByPropertyId", "datePropertyId"] {
        match raw.get(key) {
            None => {}
            Some(Value::String(id)) if utf16_len(id) <= 64 => {}
            Some(_) => return Err(invalid_config()),
        }
    }
    Ok(Value::Object(config))
}

/// A patch: `null` removes a key, absent keys are kept, anything else replaces the key.
fn apply_config_patch(config: &Value, patch: &Map<String, Value>) -> Result<Value> {
    let mut next = config.as_object().cloned().unwrap_or_default();
    for (key, value) in patch {
        if value.is_null() {
            next.shift_remove(key);
        } else {
            next.insert(key.clone(), value.clone());
        }
    }
    parse_config(Some(&Value::Object(next)))
}

// ---------------------------------------------------------------------------
// CSV

/// Spreadsheets run cells starting with these as formulas; plain numbers are left alone.
fn neutralize(value: &str) -> String {
    static NUMBER: OnceLock<Regex> = OnceLock::new();
    let number = NUMBER.get_or_init(|| Regex::new(r"^-?[0-9]+(\.[0-9]+)?$").expect("number pattern"));
    let risky = matches!(value.chars().next(), Some('=' | '+' | '-' | '@' | '\t' | '\r'));
    if risky && !number.is_match(value) {
        format!("'{value}")
    } else {
        value.to_string()
    }
}

fn csv_field(raw: &str) -> String {
    let value = neutralize(raw);
    if value.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

fn csv_line(fields: &[String]) -> String {
    format!("{}\r\n", fields.iter().map(|field| csv_field(field)).collect::<Vec<_>>().join(","))
}

struct NewBase {
    space_id: String,
    parent_id: Option<String>,
    after_id: Option<String>,
    title: Option<String>,
    icon: Option<String>,
    template: String,
}

async fn create_base_page(user_id: &str, options: NewBase) -> Result<Value> {
    let space_id = options.space_id.clone();
    let id = begin(async |tx| -> Result<String> {
        if let Some(parent_id) = &options.parent_id {
            let parent =
                tx.first(sql!("SELECT id FROM pages WHERE id = {} AND space_id = {} AND deleted_at IS NULL", parent_id, &options.space_id)).await?;
            if parent.is_none() {
                return Err(not_found("Parent page"));
            }
        }
        let place = options.after_id.as_deref().map_or(Place::Last, Place::After);
        let pos = sibling_position(tx, &options.space_id, options.parent_id.as_deref(), place, None).await?;
        let content = empty_doc();
        let row = tx
            .first(sql!(
                "INSERT INTO pages (slug_id, space_id, parent_id, position, title, icon, content, text_content,
                   creator_id, last_editor_id, contributor_ids, is_base)
                 VALUES ({}, {}, {}, {}, {}, {}, {}::jsonb,
                   {}, {}, {}, ARRAY[{}]::uuid[], true)
                 RETURNING id",
                slug_id(),
                &options.space_id,
                options.parent_id.clone(),
                pos,
                options.title.clone(),
                options.icon.clone(),
                &content,
                doc_text(Some(&content)),
                user_id,
                user_id,
                user_id
            ))
            .await?;
        let id = row.map(|row| row.str("id")).unwrap_or_default();
        seed_base(tx, &id, user_id, &options.template).await?;
        Ok(id)
    })
    .await?;
    watch_page(&id, &[user_id.to_string()]).await?;
    emit_to_space(&space_id, &json!({ "kind": "tree", "spaceId": space_id }));
    let tree = db().first(sql!("SELECT {} FROM pages p WHERE p.id = {}", tree_columns(), &id)).await?;
    Ok(Value::Object(to_tree_item(&tree.ok_or_else(|| AppError::other("the base disappeared"))?)))
}

const TEMPLATES: &[&str] = &["table", "kanban"];

async fn create(ctx: &mut Ctx) -> Result<Reply> {
    let body = input(read_json(ctx).await?);
    let user = ctx.user().clone();
    let space_id = body.uuid("spaceId")?;
    require_space_role(&user, &space_id, "writer").await?;
    let options = NewBase {
        space_id,
        parent_id: body.optional_uuid("parentId")?.into_option(),
        after_id: body.optional_uuid("afterId")?.into_option(),
        title: body.nullable_string("title", TITLE_RULE)?.into_option(),
        icon: body.nullable_string("icon", max(100))?.into_option(),
        template: body.one_of("template", TEMPLATES)?.unwrap_or_else(|| "table".to_string()),
    };
    Ok(json!({ "page": create_base_page(&user.id, options).await? }).into())
}

async fn convert(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let access = require_page(&user, ctx.param("id"), "writer", PageOptions { with_content: false, allow_deleted: false }).await?;
    if access.page.bool("is_base") {
        return Err(bad_request("This page is already a base"));
    }
    let template = input(read_json(ctx).await?).one_of("template", TEMPLATES)?.unwrap_or_else(|| "table".to_string());
    let page_id = access.id();
    begin(async |tx| -> Result<()> {
        let existing = tx.first(sql!("SELECT 1 AS one FROM base_properties WHERE page_id = {} LIMIT 1", &page_id)).await?;
        if existing.is_some() {
            return Err(conflict("already_base", "This page already has base data"));
        }
        tx.execute(sql!("UPDATE pages SET is_base = true, updated_at = now(), last_editor_id = {} WHERE id = {}", &user.id, &page_id)).await?;
        seed_base(tx, &page_id, &user.id, &template).await
    })
    .await?;
    let space_id = access.space_id();
    emit_to_space(&space_id, &json!({ "kind": "tree", "spaceId": space_id }));
    Ok(to_base(&access).await?.into())
}

async fn resolve(ctx: &mut Ctx) -> Result<Reply> {
    let body = input(read_json(ctx).await?);
    let ids = body.strings("pageIds", 500, max(64))?.unwrap_or_default();
    Ok(json!({ "pages": resolve_pages(&ctx.user().id, &ids).await? }).into())
}

async fn show(ctx: &mut Ctx) -> Result<Reply> {
    Ok(to_base(&require_base(ctx.user(), ctx.param("id"), "reader").await?).await?.into())
}

// Rows ----------------------------------------------------------------------

fn rows_json(rows: &[RowRecord]) -> Vec<Value> {
    rows.iter().map(RowRecord::to_json).collect()
}

async fn query(ctx: &mut Ctx) -> Result<Reply> {
    let user_id = ctx.user().id.clone();
    let access = require_base(ctx.user(), ctx.param("id"), "reader").await?;
    let body = input(read_json(ctx).await?);
    let page_id = access.id();
    let props = load_properties(&page_id, db()).await?;
    let q = RowQuery {
        filter: parse_filter(body.raw("filter"), 0)?,
        sorts: parse_sorts(body.raw("sorts"))?,
        cursor: body.optional_string("cursor", max(2000))?,
        limit: body.integer("limit", 1, LIMITS.rows_per_page as i64)?.unwrap_or(100),
        tz_offset: body.integer("tzOffset", -900, 900)?.unwrap_or(0),
    };
    let (rows, next_cursor) = query_rows(&page_id, &props, &q).await?;
    Ok(json!({ "items": rows_json(&rows), "nextCursor": next_cursor, "references": row_references(&user_id, &props, &rows).await? }).into())
}

async fn create_row(ctx: &mut Ctx) -> Result<Reply> {
    let user_id = ctx.user().id.clone();
    let access = require_base(ctx.user(), ctx.param("id"), "writer").await?;
    let body = input(read_json_limit(ctx, BODY_LIMIT).await?);
    let page_id = access.id();
    let props = load_properties(&page_id, db()).await?;
    let none = Map::new();
    let mut cells = normalize_cells(&props, body.object("cells")?.unwrap_or(&none), true).map_err(|error| bad_request(error.0))?;
    cells.retain(|_, value| !value.is_null());
    let explicit = position(&body)?;
    let after_row_id = body.optional_uuid("afterRowId")?.into_option();
    let row = begin(async |tx| -> Result<RowRecord> {
        let mut pos = explicit.clone().filter(|pos| !pos.is_empty());
        if let (None, Some(after_row_id)) = (&pos, &after_row_id) {
            let after = tx.first(sql!("SELECT position FROM base_rows WHERE id = {} AND page_id = {}", after_row_id, &page_id)).await?;
            if let Some(after) = after {
                let after_position = after.str("position");
                let next =
                    tx.first(sql!("SELECT min(position) AS position FROM base_rows WHERE page_id = {} AND position > {}", &page_id, &after_position)).await?;
                pos = Some(next_key(Some(&after_position), next.and_then(|next| next.opt_str("position")).as_deref())?);
            }
        }
        let pos = match pos {
            Some(pos) => pos,
            None => {
                let last = tx.first(sql!("SELECT max(position) AS position FROM base_rows WHERE page_id = {}", &page_id)).await?;
                next_key(last.and_then(|last| last.opt_str("position")).as_deref(), None)?
            }
        };
        let now = logger::now_iso();
        for (id, value) in compute_formulas(&props, &cells, &now, &now, None, now_ms()) {
            if !value.is_null() {
                cells.insert(id, value);
            }
        }
        let inserted = tx
            .first(sql!(
                "INSERT INTO base_rows (page_id, cells, position, creator_id, last_editor_id)
                 VALUES ({}, {}::jsonb, {}, {}, {})
                 RETURNING id, cells, position, creator_id, last_editor_id, created_at, updated_at",
                &page_id,
                Value::Object(cells),
                pos,
                &user_id,
                &user_id
            ))
            .await?;
        Ok(RowRecord::from_row(&inserted.ok_or_else(|| AppError::other("the row was not saved"))?))
    })
    .await?;
    let row = row.to_json();
    emit(&access, json!({ "op": "rowCreated", "row": row }), request_id(&body)?);
    Ok(row.into())
}

async fn show_row(ctx: &mut Ctx) -> Result<Reply> {
    let user_id = ctx.user().id.clone();
    let access = require_base(ctx.user(), ctx.param("id"), "reader").await?;
    let row_id = ctx.param("rowId").to_string();
    if !is_uuid(&row_id) {
        return Err(not_found("Row"));
    }
    let page_id = access.id();
    let row = db().first(sql!("SELECT {} FROM base_rows r WHERE r.id = {} AND r.page_id = {}", row_columns(), &row_id, &page_id)).await?;
    let Some(row) = row else { return Err(not_found("Row")) };
    let record = RowRecord::from_row(&row);
    let props = load_properties(&page_id, db()).await?;
    let references = row_references(&user_id, &props, std::slice::from_ref(&record)).await?;
    Ok(json!({ "row": record.to_json(), "references": references }).into())
}

async fn update_row(ctx: &mut Ctx) -> Result<Reply> {
    let user_id = ctx.user().id.clone();
    let access = require_base(ctx.user(), ctx.param("id"), "writer").await?;
    let body = input(read_json_limit(ctx, BODY_LIMIT).await?);
    let page_id = access.id();
    let props = load_properties(&page_id, db()).await?;
    let none = Map::new();
    let mut patch = normalize_cells(&props, body.object("cells")?.unwrap_or(&none), false).map_err(|error| bad_request(error.0))?;
    let pos = position(&body)?;
    let row_id = ctx.param("rowId").to_string();
    if !is_uuid(&row_id) {
        return Err(not_found("Row"));
    }
    let (row, changed) = begin(async |tx| -> Result<(RowRecord, Option<Map<String, Value>>)> {
        let current =
            tx.first(sql!("SELECT {} FROM base_rows r WHERE r.id = {} AND r.page_id = {} FOR UPDATE", row_columns(), &row_id, &page_id)).await?;
        let Some(current) = current else { return Err(not_found("Row")) };
        let row = RowRecord::from_row(&current);
        patch.retain(|key, value| !same_json(row.cells.get(key), Some(value)));
        if patch.is_empty() && pos.as_ref().is_none_or(|pos| *pos == row.position) {
            return Ok((row, None));
        }
        let mut merged = row.cells.clone();
        for (key, value) in &patch {
            if value.is_null() {
                merged.shift_remove(key);
            } else {
                merged.insert(key.clone(), value.clone());
            }
        }
        let keys: Vec<String> = patch.keys().cloned().collect();
        let affected = affected_formulas(&props, &keys);
        if !affected.is_empty() {
            let values = compute_formulas(&props, &merged, &row.created_iso(), &logger::now_iso(), Some(&affected), now_ms());
            for (id, value) in values {
                if !same_json(row.cells.get(&id), Some(&value)) {
                    patch.insert(id, value);
                }
            }
        }
        let updated = tx
            .first(sql!(
                "UPDATE base_rows SET cells = apply_cell_patch(cells, {}::jsonb), updated_at = now(), last_editor_id = {},
                   position = coalesce({}::text, position)
                 WHERE id = {}
                 RETURNING id, cells, position, creator_id, last_editor_id, created_at, updated_at",
                Value::Object(patch.clone()),
                &user_id,
                pos.clone(),
                &row.id
            ))
            .await?;
        Ok((RowRecord::from_row(&updated.ok_or_else(|| AppError::other("the row disappeared"))?), Some(patch)))
    })
    .await?;
    if let Some(changed) = changed {
        let mut event = Map::new();
        event.insert("op".into(), json!("rowUpdated"));
        event.insert("rowId".into(), json!(row.id));
        event.insert("cells".into(), Value::Object(changed));
        if pos.is_some() {
            event.insert("position".into(), json!(row.position));
        }
        event.insert("updatedAt".into(), json!(row.updated_iso()));
        event.insert("lastEditorId".into(), json!(user_id));
        emit(&access, Value::Object(event), request_id(&body)?);
    }
    Ok(row.to_json().into())
}

async fn delete_rows(ctx: &mut Ctx) -> Result<Reply> {
    let access = require_base(ctx.user(), ctx.param("id"), "writer").await?;
    let body = input(read_json(ctx).await?);
    let ids = body.uuids("rowIds", 500)?.unwrap_or_default();
    if ids.is_empty() {
        return Err(bad_request("rowIds is required"));
    }
    let deleted = db().query(sql!("DELETE FROM base_rows WHERE page_id = {} AND id = ANY({}::uuid[]) RETURNING id", &access.id(), array(&ids))).await?;
    let row_ids: Vec<String> = deleted.iter().map(|row| row.str("id")).collect();
    if !row_ids.is_empty() {
        emit(&access, json!({ "op": "rowsDeleted", "rowIds": row_ids }), request_id(&body)?);
    }
    Ok(json!({ "rowIds": row_ids }).into())
}

// Properties ------------------------------------------------------------------

fn folded(name: &str) -> String {
    js_trim(name).to_lowercase()
}

async fn create_property(ctx: &mut Ctx) -> Result<Reply> {
    let access = require_base(ctx.user(), ctx.param("id"), "writer").await?;
    let body = input(read_json(ctx).await?);
    let name = body.string("name", NAME_RULE)?;
    let type_ = body.one_of("type", &PROPERTY_TYPES)?.ok_or_else(|| bad_request("type is required"))?;
    let page_id = access.id();
    let props = load_properties(&page_id, db()).await?;
    if props.iter().any(|p| folded(&p.name) == name.to_lowercase()) {
        return Err(name_taken());
    }
    let id = new_property_id();
    let options = if type_ == "formula" { formula_options(body.raw("options"), &props, &id)? } else { parse_options(&type_, body.raw("options"))? };
    let last = props.iter().map(|p| p.position.as_str()).max();
    let property = Property { id, name, type_, options, is_primary: false, position: next_key(last, None)? };
    let saved = begin(async |tx| -> Result<()> {
        tx.execute(sql!(
            "INSERT INTO base_properties (page_id, id, name, type, options, position)
             VALUES ({}, {}, {}, {}, {}::jsonb, {})",
            &page_id,
            &property.id,
            &property.name,
            &property.type_,
            Value::Object(property.options.clone()),
            &property.position
        ))
        .await?;
        if property.type_ == "formula" {
            let mut all = props.clone();
            all.push(property.clone());
            backfill_formulas(tx, &page_id, &all, std::slice::from_ref(&property.id)).await?;
        }
        Ok(())
    })
    .await;
    match saved {
        Err(error) if error.is_unique_violation() => return Err(name_taken()),
        other => other?,
    }
    emit_base(&access, request_id(&body)?).await?;
    if property.type_ == "formula" {
        emit(&access, json!({ "op": "rowsChanged" }), None);
    }
    Ok(property.to_json().into())
}

fn choice_ids(options: &Map<String, Value>) -> Vec<&str> {
    options.get("choices").and_then(Value::as_array).into_iter().flatten().filter_map(|choice| choice.get("id").and_then(Value::as_str)).collect()
}

async fn update_property(ctx: &mut Ctx) -> Result<Reply> {
    let user_id = ctx.user().id.clone();
    let access = require_base(ctx.user(), ctx.param("id"), "writer").await?;
    let body = input(read_json(ctx).await?);
    let page_id = access.id();
    let props = load_properties(&page_id, db()).await?;
    let Some(prop) = props.iter().find(|p| p.id == ctx.param("propertyId")).cloned() else { return Err(not_found("Property")) };
    let name = body.optional_string("name", NAME_RULE)?;
    let type_ = body.one_of("type", &PROPERTY_TYPES)?.unwrap_or_else(|| prop.type_.clone());
    let pos = position(&body)?;
    if let Some(name) = &name {
        if props.iter().any(|p| p.id != prop.id && folded(&p.name) == name.to_lowercase()) {
            return Err(name_taken());
        }
    }
    let type_changed = type_ != prop.type_;
    if type_changed {
        if prop.is_primary {
            return Err(bad_request("The primary property cannot change type"));
        }
        if !is_editable_type(&prop.type_) {
            return Err(bad_request("This property cannot change type"));
        }
        if is_system_type(&type_) || type_ == "formula" {
            return Err(bad_request(format!("A property cannot be converted to {type_}")));
        }
    }
    let renamed = name.as_ref().is_some_and(|name| *name != prop.name);
    let next_name = name.clone().unwrap_or_else(|| prop.name.clone());
    let others: Vec<Property> = props.iter().map(|p| if p.id == prop.id && renamed { Property { name: next_name.clone(), ..p.clone() } } else { p.clone() }).collect();
    let has_options = body.has("options");
    let mut options = prop.options.clone();
    if has_options || type_changed {
        options = if type_ == "formula" {
            formula_options(body.raw("options"), &others, &prop.id)?
        } else {
            parse_options(&type_, if has_options { body.raw("options") } else { None })?
        };
    }
    let next = Property {
        id: prop.id.clone(),
        name: next_name,
        type_: type_.clone(),
        options,
        is_primary: prop.is_primary,
        position: pos.unwrap_or_else(|| prop.position.clone()),
    };
    let mut next_props: Vec<Property> = others.into_iter().map(|p| if p.id == prop.id { next.clone() } else { p }).collect();
    let saved = begin(async |tx| -> Result<bool> {
        let mut rows_changed = false;
        tx.execute(sql!(
            "UPDATE base_properties SET name = {}, type = {}, options = {}::jsonb,
               position = {}, updated_at = now()
             WHERE page_id = {} AND id = {}",
            &next.name,
            &next.type_,
            Value::Object(next.options.clone()),
            &next.position,
            &page_id,
            &prop.id
        ))
        .await?;
        if renamed {
            for formula in next_props.iter_mut().filter(|p| p.type_ == "formula") {
                let depends = formula.options.get("dependencies").and_then(Value::as_array).is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(&prop.id)));
                if !depends {
                    continue;
                }
                let current = formula.options.get("source").and_then(Value::as_str);
                let source = rename_in_source(current.unwrap_or(""), &prop.name, &next.name);
                if current == Some(source.as_str()) {
                    continue;
                }
                formula.options.insert("source".into(), Value::String(source));
                tx.execute(sql!(
                    "UPDATE base_properties SET options = {}::jsonb, updated_at = now() WHERE page_id = {} AND id = {}",
                    Value::Object(formula.options.clone()),
                    &page_id,
                    &formula.id
                ))
                .await?;
            }
        }
        if type_changed {
            convert_rows(tx, &user_id, &page_id, &prop, &next).await?;
            rows_changed = true;
        } else if is_choice_type(&type_) && has_options {
            // Removing an option clears it from cells.
            let kept = choice_ids(&next.options);
            let removed = prop.options.get("choices").and_then(Value::as_array).into_iter().flatten().any(|choice| match choice.get("id") {
                Some(Value::String(id)) => !kept.contains(&id.as_str()),
                _ => true,
            });
            if removed {
                convert_rows(tx, &user_id, &page_id, &prop, &next).await?;
                rows_changed = true;
            }
        } else if type_ == "person" && has_options && js_truthy_opt(prop.options.get("allowMultiple")) != js_truthy_opt(next.options.get("allowMultiple")) {
            convert_rows(tx, &user_id, &page_id, &prop, &next).await?;
            rows_changed = true;
        }
        let mut recompute = affected_formulas(&next_props, std::slice::from_ref(&prop.id));
        if type_ == "formula" && has_options && !recompute.contains(&prop.id) {
            recompute.push(prop.id.clone());
        }
        if (type_changed || !recompute.is_empty()) && backfill_formulas(tx, &page_id, &next_props, &recompute).await? > 0 {
            rows_changed = true;
        }
        Ok(rows_changed)
    })
    .await;
    let rows_changed = match saved {
        Err(error) if error.is_unique_violation() => return Err(name_taken()),
        other => other?,
    };
    emit_base(&access, request_id(&body)?).await?;
    if rows_changed {
        emit(&access, json!({ "op": "rowsChanged" }), None);
    }
    Ok(next.to_json().into())
}

async fn delete_property(ctx: &mut Ctx) -> Result<Reply> {
    let access = require_base(ctx.user(), ctx.param("id"), "writer").await?;
    let body = input(read_json(ctx).await?);
    let page_id = access.id();
    let props = load_properties(&page_id, db()).await?;
    let Some(prop) = props.iter().find(|p| p.id == ctx.param("propertyId")).cloned() else { return Err(not_found("Property")) };
    if prop.is_primary {
        return Err(bad_request("The primary property cannot be deleted"));
    }
    let rest: Vec<Property> = props.iter().filter(|p| p.id != prop.id).cloned().collect();
    begin(async |tx| -> Result<()> {
        tx.execute(sql!("DELETE FROM base_properties WHERE page_id = {} AND id = {}", &page_id, &prop.id)).await?;
        tx.execute(sql!("UPDATE base_rows SET cells = cells - {}::text WHERE page_id = {} AND cells ? {}::text", &prop.id, &page_id, &prop.id)).await?;
        strip_from_views(tx, &page_id, &prop.id).await?;
        backfill_formulas(tx, &page_id, &rest, &affected_formulas(&props, std::slice::from_ref(&prop.id))).await?;
        Ok(())
    })
    .await?;
    emit_base(&access, request_id(&body)?).await?;
    emit(&access, json!({ "op": "rowsChanged" }), None);
    empty()
}

// Views -----------------------------------------------------------------------

async fn create_view(ctx: &mut Ctx) -> Result<Reply> {
    let user_id = ctx.user().id.clone();
    let access = require_base(ctx.user(), ctx.param("id"), "writer").await?;
    let body = input(read_json(ctx).await?);
    let name = body.optional_string("name", VIEW_NAME_RULE)?.filter(|name| !name.is_empty()).unwrap_or_else(|| "View".to_string());
    let type_ = body.one_of("type", &VIEW_TYPES)?.unwrap_or_else(|| "table".to_string());
    let config = parse_config(body.raw("config"))?;
    let page_id = access.id();
    let last = db().first(sql!("SELECT max(position) AS position FROM base_views WHERE page_id = {}", &page_id)).await?;
    let pos = next_key(last.and_then(|last| last.opt_str("position")).as_deref(), None)?;
    let row = db()
        .first(sql!(
            "INSERT INTO base_views (page_id, name, type, config, position, creator_id)
             VALUES ({}, {}, {}, {}::jsonb, {}, {})
             RETURNING id, name, type, config, position",
            &page_id,
            name,
            type_,
            config,
            pos,
            &user_id
        ))
        .await?
        .ok_or_else(|| AppError::other("the view was not saved"))?;
    emit_base(&access, request_id(&body)?).await?;
    Ok(to_view(&row).into())
}

async fn update_view(ctx: &mut Ctx) -> Result<Reply> {
    let access = require_base(ctx.user(), ctx.param("id"), "writer").await?;
    let body = input(read_json(ctx).await?);
    let view_id = ctx.param("viewId").to_string();
    if !is_uuid(&view_id) {
        return Err(not_found("View"));
    }
    let view = db().first(sql!("SELECT id, name, type, config, position FROM base_views WHERE page_id = {} AND id = {}", &access.id(), &view_id)).await?;
    let Some(view) = view else { return Err(not_found("View")) };
    let name = body.optional_string("name", VIEW_NAME_RULE)?.filter(|name| !name.is_empty()).unwrap_or_else(|| view.str("name"));
    let type_ = body.one_of("type", &VIEW_TYPES)?.unwrap_or_else(|| view.str("type"));
    let stored = view.json("config");
    let config = match body.object("config")? {
        Some(patch) => apply_config_patch(if stored.is_null() { &Value::Null } else { &stored }, patch)?,
        None => stored.clone(),
    };
    let pos = position(&body)?.unwrap_or_else(|| view.str("position"));
    let row = db()
        .first(sql!(
            "UPDATE base_views SET name = {}, type = {}, config = {}::jsonb, position = {}, updated_at = now()
             WHERE id = {} RETURNING id, name, type, config, position",
            name,
            type_,
            config,
            pos,
            &view.str("id")
        ))
        .await?
        .ok_or_else(|| AppError::other("the view disappeared"))?;
    emit_base(&access, request_id(&body)?).await?;
    Ok(to_view(&row).into())
}

async fn delete_view(ctx: &mut Ctx) -> Result<Reply> {
    let access = require_base(ctx.user(), ctx.param("id"), "writer").await?;
    let body = input(read_json(ctx).await?);
    let view_id = ctx.param("viewId").to_string();
    if !is_uuid(&view_id) {
        return Err(not_found("View"));
    }
    let page_id = access.id();
    begin(async |tx| -> Result<()> {
        let views = tx.query(sql!("SELECT id FROM base_views WHERE page_id = {} FOR UPDATE", &page_id)).await?;
        if !views.iter().any(|view| view.str("id") == view_id.to_lowercase()) {
            return Err(not_found("View"));
        }
        if views.len() <= 1 {
            return Err(bad_request("A base must keep at least one view"));
        }
        tx.execute(sql!("DELETE FROM base_views WHERE id = {}", &view_id)).await?;
        Ok(())
    })
    .await?;
    emit_base(&access, request_id(&body)?).await?;
    empty()
}

// Export ----------------------------------------------------------------------

struct CsvState {
    batches: AllRows,
    props: Vec<Property>,
    user_id: String,
    failed: bool,
}

async fn csv_chunk(state: &mut CsvState) -> Result<Option<String>> {
    let Some(rows) = state.batches.next(db()).await? else { return Ok(None) };
    let ctx = text_context(&row_references(&state.user_id, &state.props, &rows).await?);
    Ok(Some(rows.iter().map(|row| csv_line(&row_text(&state.props, row, &ctx))).collect()))
}

async fn export_csv(ctx: &mut Ctx) -> Result<Reply> {
    static UNSAFE: OnceLock<Regex> = OnceLock::new();
    let user_id = ctx.user().id.clone();
    let access = require_base(ctx.user(), ctx.param("id"), "reader").await?;
    let page_id = access.id();
    let props = load_properties(&page_id, db()).await?;
    let names: Vec<String> = props.iter().map(|p| p.name.clone()).collect();
    let head = Bytes::from(format!("\u{FEFF}{}", csv_line(&names)));
    let state = CsvState { batches: all_rows(&page_id), props, user_id, failed: false };
    let rest = futures_util::stream::unfold(state, |mut state| async move {
        if state.failed {
            return None;
        }
        match csv_chunk(&mut state).await {
            Ok(Some(chunk)) => Some((Ok(Bytes::from(chunk)), state)),
            Ok(None) => None,
            Err(error) => {
                logger::error("base export failed", &error);
                state.failed = true;
                Some((Err(std::io::Error::other(error.to_string())), state))
            }
        }
    });
    let stream: ByteStream = Box::pin(futures_util::stream::once(async move { Ok(head) }).chain(rest));
    let unsafe_chars = UNSAFE.get_or_init(|| Regex::new(r#"[\\/:*?"<>|\x00-\x1f]"#).expect("file name pattern"));
    let title = access.page.opt_str("title").filter(|title| !title.is_empty()).unwrap_or_else(|| "Untitled base".to_string());
    let name = js_slice(&unsafe_chars.replace_all(&title, "_"), 0, Some(150));
    let disposition = try_content_disposition("attachment", &format!("{name}.csv"))?;
    Ok(response(
        200,
        &[
            ("Content-Type", "text/csv; charset=utf-8"),
            ("Content-Disposition", &disposition),
            ("Cache-Control", "no-store"),
        ],
        stream_body(stream),
    )
    .into())
}

pub fn routes() -> Vec<Route> {
    vec![
        post("/bases", handler!(create)),
        post("/pages/:id/convert-to-base", handler!(convert)),
        post("/bases/resolve-pages", handler!(resolve)),
        get("/bases/:id", handler!(show)),
        post("/bases/:id/rows/query", handler!(query)),
        post("/bases/:id/rows", handler!(create_row)),
        get("/bases/:id/rows/:rowId", handler!(show_row)),
        post("/bases/:id/rows/:rowId/update", handler!(update_row)),
        post("/bases/:id/rows/delete", handler!(delete_rows)),
        post("/bases/:id/properties", handler!(create_property)),
        post("/bases/:id/properties/:propertyId/update", handler!(update_property)),
        post("/bases/:id/properties/:propertyId/delete", handler!(delete_property)),
        post("/bases/:id/views", handler!(create_view)),
        post("/bases/:id/views/:viewId/update", handler!(update_view)),
        post("/bases/:id/views/:viewId/delete", handler!(delete_view)),
        get("/bases/:id/export.csv", handler!(export_csv)),
    ]
}
