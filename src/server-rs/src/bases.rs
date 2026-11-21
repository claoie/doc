//! Port of `src/server/lib/bases.ts`.

use base64::Engine;
use serde_json::{json, Map, Value};

use crate::auth::AuthUser;
use crate::common::bases::{
    cell_text, column_kind, date_range, default_status_choices, is_filter_group, ColumnKind, Property, RowMeta, TextContext, FILTER_OPERATORS,
    LIMITS,
};
use crate::common::ids::{is_uuid, short_id};
use crate::common::jsdate::to_iso_string;
use crate::common::positions::key_between;
use crate::db::{array, db, micros_to_iso, Conn, Row, Sql};
use crate::http::{bad_request, not_found, AppError, Result};
use crate::jsutil::{js_json, js_number, js_string, js_trim, js_truthy_opt, number_to_string};
use crate::pages::{require_page, PageAccess, PageOptions};
use crate::permissions::{has_role, readable_space_ids};
use crate::sql;
use crate::users::user_refs;

/// A `base_rows` row.
#[derive(Debug, Clone)]
pub struct RowRecord {
    pub id: String,
    pub cells: Map<String, Value>,
    pub position: String,
    pub creator_id: Option<String>,
    pub last_editor_id: Option<String>,
    /// Microseconds since the Unix epoch.
    pub created_at: i64,
    pub updated_at: i64,
}

impl RowRecord {
    pub fn from_row(row: &Row) -> RowRecord {
        RowRecord {
            id: row.str("id"),
            cells: match row.json("cells") {
                Value::Object(cells) => cells,
                _ => Map::new(),
            },
            position: row.str("position"),
            creator_id: row.opt_str("creator_id"),
            last_editor_id: row.opt_str("last_editor_id"),
            created_at: row.opt_micros("created_at").unwrap_or(0),
            updated_at: row.opt_micros("updated_at").unwrap_or(0),
        }
    }

    /// `row.created_at.toISOString()`.
    pub fn created_iso(&self) -> String {
        micros_to_iso(self.created_at)
    }

    pub fn updated_iso(&self) -> String {
        micros_to_iso(self.updated_at)
    }

    /// `toRow(row)`.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "cells": self.cells,
            "position": self.position,
            "creatorId": self.creator_id,
            "lastEditorId": self.last_editor_id,
            "createdAt": self.created_iso(),
            "updatedAt": self.updated_iso(),
        })
    }
}

/// `toProperty(row)`.
pub fn to_property(row: &Row) -> Property {
    Property {
        id: row.str("id"),
        name: row.str("name"),
        type_: row.str("type"),
        options: match row.json("options") {
            Value::Object(options) => options,
            _ => Map::new(),
        },
        is_primary: row.bool("is_primary"),
        position: row.str("position"),
    }
}

/// `toView(row)`.
pub fn to_view(row: &Row) -> Value {
    json!({
        "id": row.str("id"),
        "name": row.str("name"),
        "type": row.str("type"),
        "config": row.opt_json("config").filter(|config| !config.is_null()).unwrap_or_else(|| json!({})),
        "position": row.str("position"),
    })
}

pub fn row_columns() -> Sql {
    Sql::raw("r.id, r.cells, r.position, r.creator_id, r.last_editor_id, r.created_at, r.updated_at")
}

pub async fn load_properties(page_id: &str, conn: Conn<'_>) -> Result<Vec<Property>> {
    let rows = conn
        .query(sql!(
            "SELECT id, name, type, options, is_primary, position FROM base_properties
             WHERE page_id = {} ORDER BY position, id",
            page_id
        ))
        .await?;
    Ok(rows.iter().map(to_property).collect())
}

pub async fn load_views(page_id: &str, conn: Conn<'_>) -> Result<Vec<Value>> {
    let rows = conn.query(sql!("SELECT id, name, type, config, position FROM base_views WHERE page_id = {} ORDER BY position, id", page_id)).await?;
    Ok(rows.iter().map(to_view).collect())
}

/// `toBase(access)`.
pub async fn to_base(access: &PageAccess) -> Result<Value> {
    let id = access.id();
    let (properties, views) = tokio::try_join!(load_properties(&id, db()), load_views(&id, db()))?;
    Ok(json!({
        "id": id,
        "slugId": access.page.str("slug_id"),
        "spaceId": access.space_id(),
        "title": access.page.opt_str("title"),
        "icon": access.page.opt_str("icon"),
        "properties": properties.iter().map(Property::to_json).collect::<Vec<_>>(),
        "views": views,
        "canEdit": !access.is_deleted() && has_role(access.role, "writer"),
    }))
}

/// Like `require_page`, but the page must be a base.
pub async fn require_base(user: &AuthUser, reference: &str, min: &str) -> Result<PageAccess> {
    let access = require_page(user, reference, min, PageOptions { with_content: false, allow_deleted: false }).await?;
    if !access.page.bool("is_base") {
        return Err(not_found("Base"));
    }
    Ok(access)
}

pub fn new_property_id() -> String {
    short_id("p")
}

pub fn new_choice_id() -> String {
    short_id("c")
}

fn next_key(after: Option<&str>, before: Option<&str>) -> Result<String> {
    key_between(after, before).map_err(AppError::other)
}

/// Default properties, one empty row and a table view (plus a kanban board for the kanban template).
pub async fn seed_base(conn: Conn<'_>, page_id: &str, user_id: &str, template: &str) -> Result<()> {
    let kanban = template == "kanban";
    let mut props: Vec<(String, &str, &str, Value, bool)> = vec![
        (new_property_id(), "Title", "text", json!({}), true),
        (new_property_id(), "Text 1", "text", json!({}), false),
        (new_property_id(), "Text 2", "text", json!({}), false),
    ];
    if kanban {
        let choices = default_status_choices();
        let ids: Vec<Value> = choices.as_array().into_iter().flatten().map(|choice| choice["id"].clone()).collect();
        let first = ids.first().cloned().unwrap_or(Value::Null);
        props.push((new_property_id(), "Status", "status", json!({ "choices": choices, "choiceOrder": ids, "defaultValue": first }), false));
    }
    let mut position: Option<String> = None;
    for (id, name, type_, options, primary) in &props {
        let next = next_key(position.as_deref(), None)?;
        conn.execute(sql!(
            "INSERT INTO base_properties (page_id, id, name, type, options, is_primary, position)
             VALUES ({}, {}, {}, {}, {}::jsonb, {}, {})",
            page_id,
            id,
            *name,
            *type_,
            options,
            *primary,
            &next
        ))
        .await?;
        position = Some(next);
    }
    let first = next_key(None, None)?;
    let second = next_key(Some(&first), None)?;
    conn.execute(sql!("INSERT INTO base_rows (page_id, position, creator_id, last_editor_id) VALUES ({}, {}, {}, {})", page_id, &first, user_id, user_id))
        .await?;
    // The kanban template opens on its board.
    conn.execute(sql!(
        "INSERT INTO base_views (page_id, name, type, position, creator_id)
         VALUES ({}, 'Table', 'table', {}, {})",
        page_id,
        if kanban { &second } else { &first },
        user_id
    ))
    .await?;
    if kanban {
        let status = props.last().map(|prop| prop.0.clone()).unwrap_or_default();
        conn.execute(sql!(
            "INSERT INTO base_views (page_id, name, type, config, position, creator_id)
             VALUES ({}, 'Board', 'kanban', {}::jsonb, {}, {})",
            page_id,
            json!({ "groupByPropertyId": status }),
            &first,
            user_id
        ))
        .await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Filters and sorts compile to SQL over a `base_rows` row aliased `r`.

fn join(parts: Vec<Sql>, glue: &str) -> Sql {
    let mut parts = parts.into_iter();
    let Some(mut acc) = parts.next() else { return Sql::raw("true") };
    for part in parts {
        acc = sql!("{} {} {}", acc, Sql::raw(glue), part);
    }
    acc
}

fn cell(prop: &Property) -> Sql {
    sql!("(r.cells -> {}::text)", &prop.id)
}

/// The comparable expression for a property, per its column kind; bare dates are local days at `tz_offset`.
fn column_expr(prop: &Property, tz_offset: i64) -> Sql {
    match prop.type_.as_str() {
        "createdAt" => return Sql::raw("r.created_at"),
        "lastEditedAt" => return Sql::raw("r.updated_at"),
        "lastEditedBy" => return Sql::raw("coalesce(r.last_editor_id, r.creator_id)::text"),
        _ => {}
    }
    match column_kind(prop) {
        ColumnKind::Number => sql!("cell_number({})", cell(prop)),
        ColumnKind::Time => sql!("cell_time({}, {}::int)", cell(prop), tz_offset),
        ColumnKind::Flag => sql!("cell_flag({})", cell(prop)),
        ColumnKind::List => sql!("cell_list({})", cell(prop)),
        ColumnKind::Text => sql!("(r.cells ->> {}::text)", &prop.id),
    }
}

fn escape_like(s: &str) -> String {
    crate::search::escape_like(s)
}

fn as_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => js_json(other),
    }
}

fn as_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().map(js_string).collect(),
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(s)) if s.is_empty() => Vec::new(),
        Some(other) => vec![js_string(other)],
    }
}

fn is_true(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(true)) => true,
        Some(Value::String(s)) => {
            let folded = js_trim(s).to_ascii_lowercase();
            matches!(folded.as_str(), "true" | "1" | "yes" | "on")
        }
        _ => false,
    }
}

fn sql_false() -> Sql {
    Sql::raw("false")
}

fn sql_true() -> Sql {
    Sql::raw("true")
}

fn is_empty(prop: &Property, expr: &Sql) -> Sql {
    match column_kind(prop) {
        ColumnKind::Text => sql!("({} IS NULL OR {} = '')", expr, expr),
        ColumnKind::List => sql!("coalesce(jsonb_array_length({}), 0) = 0", expr),
        _ => sql!("{} IS NULL", expr),
    }
}

fn unsupported(op: &str, kind: ColumnKind) -> AppError {
    bad_request(format!("Operator {op} is not supported for {} properties", kind.as_str()))
}

fn compile_condition(prop: &Property, condition: &Value, now: f64, tz_offset: i64) -> Result<Sql> {
    let kind = column_kind(prop);
    let op = condition.get("op").and_then(Value::as_str).unwrap_or("");
    let value = condition.get("value");
    if !kind.operators().contains(&op) {
        return Err(unsupported(op, kind));
    }
    let expr = column_expr(prop, tz_offset);
    if op == "isEmpty" {
        return Ok(is_empty(prop, &expr));
    }
    if op == "isNotEmpty" {
        return Ok(sql!("NOT {}", is_empty(prop, &expr)));
    }
    match kind {
        ColumnKind::Text => {
            let v = as_text(value);
            let like = |pattern: String| sql!("{} ILIKE {}", &expr, pattern);
            Ok(match op {
                "eq" => sql!("{} = {}", &expr, v),
                "neq" => sql!("{} IS DISTINCT FROM {}", &expr, v),
                "contains" => like(format!("%{}%", escape_like(&v))),
                "ncontains" => sql!("NOT coalesce({}, false)", like(format!("%{}%", escape_like(&v)))),
                "startsWith" => like(format!("{}%", escape_like(&v))),
                "endsWith" => like(format!("%{}", escape_like(&v))),
                "gt" => sql!("{} > {}", &expr, v),
                "gte" => sql!("{} >= {}", &expr, v),
                "lt" => sql!("{} < {}", &expr, v),
                "lte" => sql!("{} <= {}", &expr, v),
                "any" => {
                    let list = as_list(value);
                    if list.is_empty() {
                        sql_false()
                    } else {
                        sql!("{} = ANY({}::text[])", &expr, array(&list))
                    }
                }
                "none" => {
                    let list = as_list(value);
                    if list.is_empty() {
                        sql_true()
                    } else {
                        sql!("({} IS NULL OR NOT ({} = ANY({}::text[])))", &expr, &expr, array(&list))
                    }
                }
                "all" => {
                    let list = as_list(value);
                    match list.as_slice() {
                        [] => sql_true(),
                        [only] => sql!("{} = {}", &expr, only),
                        _ => sql_false(),
                    }
                }
                _ => return Err(unsupported(op, kind)),
            })
        }
        ColumnKind::Number => {
            let n = match value {
                Some(Value::Number(_)) => js_number(value.unwrap_or(&Value::Null)),
                Some(Value::String(s)) if s.is_empty() => f64::NAN,
                Some(Value::Null) | None => f64::NAN,
                Some(other) => js_number(other),
            };
            if !n.is_finite() {
                return Ok(if op == "neq" { sql_true() } else { sql_false() });
            }
            let v = number_to_string(n);
            Ok(match op {
                "eq" => sql!("{} = {}::numeric", &expr, v),
                "neq" => sql!("{} IS DISTINCT FROM {}::numeric", &expr, v),
                "gt" => sql!("{} > {}::numeric", &expr, v),
                "gte" => sql!("{} >= {}::numeric", &expr, v),
                "lt" => sql!("{} < {}::numeric", &expr, v),
                "lte" => sql!("{} <= {}::numeric", &expr, v),
                _ => return Err(unsupported(op, kind)),
            })
        }
        ColumnKind::Flag => {
            let matches = if is_true(value) { sql!("coalesce({}, false) = true", &expr) } else { sql!("coalesce({}, false) = false", &expr) };
            Ok(if op == "eq" { matches } else { sql!("NOT ({})", matches) })
        }
        ColumnKind::Time => {
            let Some((from, to)) = date_range(value, now, tz_offset as f64) else { return Ok(sql_false()) };
            // `new Date(x).toISOString()` throws for a time out of range.
            let start = to_iso_string(from).ok_or_else(|| AppError::other("Invalid time value"))?;
            let end = to_iso_string(to).ok_or_else(|| AppError::other("Invalid time value"))?;
            let within = sql!("({} >= {}::timestamptz AND {} < {}::timestamptz)", &expr, &start, &expr, &end);
            Ok(match op {
                "eq" | "isWithin" => within,
                "neq" => sql!("NOT coalesce({}, false)", within),
                "before" | "lt" => sql!("{} < {}::timestamptz", &expr, &start),
                "onOrBefore" | "lte" => sql!("{} < {}::timestamptz", &expr, &end),
                "after" | "gt" => sql!("{} >= {}::timestamptz", &expr, &end),
                "onOrAfter" | "gte" => sql!("{} >= {}::timestamptz", &expr, &start),
                _ => return Err(unsupported(op, kind)),
            })
        }
        ColumnKind::List => {
            let list = as_list(value);
            let none = list.is_empty();
            let first = list.first().cloned().unwrap_or_default();
            Ok(match op {
                "eq" if none => sql_false(),
                "eq" => sql!("coalesce({} ? {}, false)", &expr, first),
                "neq" if none => sql_true(),
                "neq" => sql!("NOT coalesce({} ? {}, false)", &expr, first),
                "any" if none => sql_false(),
                "any" => sql!("coalesce({} ?| {}::text[], false)", &expr, array(&list)),
                "none" if none => sql_true(),
                "none" => sql!("NOT coalesce({} ?| {}::text[], false)", &expr, array(&list)),
                "all" if none => sql_true(),
                "all" => sql!("coalesce({} ?& {}::text[], false)", &expr, array(&list)),
                "contains" => {
                    let v = as_text(value);
                    if v.is_empty() {
                        sql_false()
                    } else {
                        sql!("coalesce({}::text ILIKE {}, false)", &expr, format!("%{}%", escape_like(&v)))
                    }
                }
                "ncontains" => {
                    let v = as_text(value);
                    if v.is_empty() {
                        sql_true()
                    } else {
                        sql!("NOT coalesce({}::text ILIKE {}, false)", &expr, format!("%{}%", escape_like(&v)))
                    }
                }
                _ => return Err(unsupported(op, kind)),
            })
        }
    }
}

fn invalid_filter() -> AppError {
    bad_request("Invalid filter")
}

/// Validates the shape of an untrusted filter tree; the result holds only the keys the server reads.
pub fn parse_filter(value: Option<&Value>, depth: usize) -> Result<Option<Value>> {
    let value = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(value) => value,
    };
    let Value::Object(group) = value else { return Err(invalid_filter()) };
    if depth > 10 {
        return Err(invalid_filter());
    }
    let op = match group.get("op") {
        Some(Value::String(op)) if op == "and" || op == "or" => op.clone(),
        _ => return Err(invalid_filter()),
    };
    let Some(Value::Array(children)) = group.get("children") else { return Err(invalid_filter()) };
    if children.len() > LIMITS.filter_children {
        return Err(invalid_filter());
    }
    let mut parsed: Vec<Value> = Vec::with_capacity(children.len());
    for child in children {
        match child {
            Value::Object(object) if object.contains_key("children") => {
                parsed.push(parse_filter(Some(child), depth + 1)?.ok_or_else(invalid_filter)?);
            }
            Value::Object(object) => {
                let property_id = object.get("propertyId").and_then(Value::as_str).ok_or_else(invalid_filter)?;
                let op = object.get("op").and_then(Value::as_str).filter(|op| FILTER_OPERATORS.contains(op)).ok_or_else(invalid_filter)?;
                let mut condition = Map::new();
                condition.insert("propertyId".into(), Value::String(property_id.to_string()));
                condition.insert("op".into(), Value::String(op.to_string()));
                if let Some(value) = object.get("value") {
                    condition.insert("value".into(), value.clone());
                }
                parsed.push(Value::Object(condition));
            }
            _ => return Err(invalid_filter()),
        }
    }
    Ok(Some(json!({ "op": op, "children": parsed })))
}

pub fn parse_sorts(value: Option<&Value>) -> Result<Option<Value>> {
    let value = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(value) => value,
    };
    let invalid = || bad_request("Invalid sorts");
    let Value::Array(items) = value else { return Err(invalid()) };
    if items.len() > LIMITS.sorts {
        return Err(invalid());
    }
    let mut sorts = Vec::with_capacity(items.len());
    for item in items {
        // `s.propertyId` of an array is undefined, so only objects pass.
        let property_id = item.as_object().and_then(|s| s.get("propertyId")).and_then(Value::as_str).ok_or_else(invalid)?;
        let direction = item.get("direction").and_then(Value::as_str).filter(|d| *d == "asc" || *d == "desc").ok_or_else(invalid)?;
        sorts.push(json!({ "propertyId": property_id, "direction": direction }));
    }
    Ok(Some(Value::Array(sorts)))
}

pub fn compile_filter(props: &[Property], group: Option<&Value>, now: f64, tz_offset: i64) -> Result<Sql> {
    fn walk(props: &[Property], group: &Value, now: f64, tz_offset: i64) -> Result<Option<Sql>> {
        let mut parts: Vec<Sql> = Vec::new();
        for child in group.get("children").and_then(Value::as_array).into_iter().flatten() {
            if is_filter_group(child) {
                if let Some(part) = walk(props, child, now, tz_offset)? {
                    parts.push(part);
                }
                continue;
            }
            let property_id = child.get("propertyId").and_then(Value::as_str).unwrap_or("");
            // `new Map(props.map(...))`: of two properties with one id, the later wins.
            let prop = props.iter().rev().find(|p| p.id == property_id);
            let Some(prop) = prop else { return Err(bad_request(format!("Filter references unknown property {property_id}"))) };
            parts.push(compile_condition(prop, child, now, tz_offset)?);
        }
        if parts.is_empty() {
            return Ok(None);
        }
        let glue = if group.get("op").and_then(Value::as_str) == Some("and") { "AND" } else { "OR" };
        Ok(Some(sql!("({})", join(parts, glue))))
    }
    match group {
        None => Ok(sql_true()),
        Some(group) => Ok(walk(props, group, now, tz_offset)?.unwrap_or_else(sql_true)),
    }
}

fn choices_order(prop: &Property) -> Vec<String> {
    let ids: Vec<String> = prop
        .options
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|choice| choice.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut order: Vec<String> = prop
        .options
        .get("choiceOrder")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|id| ids.iter().any(|known| known == id))
        .map(str::to_string)
        .collect();
    let rest: Vec<String> = ids.into_iter().filter(|id| !order.contains(id)).collect();
    order.extend(rest);
    order
}

/// What a property sorts by: choices by their option order, people by name, everything else by value.
fn sort_expr(prop: &Property, tz_offset: i64) -> Sql {
    if prop.type_ == "select" || prop.type_ == "status" {
        return sql!("array_position({}::text[], {})", array(&choices_order(prop)), column_expr(prop, tz_offset));
    }
    if prop.type_ == "lastEditedBy" {
        return Sql::raw("(SELECT lower(u.name) FROM users u WHERE u.id = coalesce(r.last_editor_id, r.creator_id))");
    }
    if prop.type_ == "person" && !js_truthy_opt(prop.options.get("allowMultiple")) {
        let id = column_expr(prop, tz_offset);
        return sql!(
            "(SELECT lower(u.name) FROM users u WHERE u.id = CASE WHEN {} ~* '^[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}$' THEN ({})::uuid END)",
            &id,
            &id
        );
    }
    if column_kind(prop) == ColumnKind::List {
        sql!("{}::text", column_expr(prop, tz_offset))
    } else {
        column_expr(prop, tz_offset)
    }
}

pub fn compile_sorts(props: &[Property], sorts: Option<&Value>, tz_offset: i64) -> Result<Option<Sql>> {
    let items = sorts.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let mut seen: Vec<&str> = Vec::new();
    let mut parts: Vec<Sql> = Vec::new();
    for sort in items {
        let property_id = sort.get("propertyId").and_then(Value::as_str).unwrap_or("");
        if seen.contains(&property_id) {
            continue;
        }
        seen.push(property_id);
        let prop = props.iter().rev().find(|p| p.id == property_id);
        let Some(prop) = prop else { return Err(bad_request(format!("Sort references unknown property {property_id}"))) };
        let expr = sort_expr(prop, tz_offset);
        parts.push(if sort.get("direction").and_then(Value::as_str) == Some("asc") {
            sql!("{} ASC NULLS LAST", expr)
        } else {
            sql!("{} DESC NULLS LAST", expr)
        });
    }
    let mut parts = parts.into_iter();
    let Some(mut acc) = parts.next() else { return Ok(None) };
    for part in parts {
        acc = sql!("{}, {}", acc, part);
    }
    Ok(Some(acc))
}

// ---------------------------------------------------------------------------
// Pagination cursors are opaque base64url JSON.

fn encode_cursor(value: &Value) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(js_json(value))
}

/// `Buffer.from(text, "base64url")`: either alphabet, padding optional, everything else skipped.
fn lenient_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut bits, mut count) = (0u32, 0u8);
    for byte in text.bytes() {
        let six = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(six);
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]);
            (bits, count) = (0, 0);
        }
    }
    match count {
        2 => out.push((bits >> 4) as u8),
        3 => out.extend_from_slice(&[(bits >> 10) as u8, (bits >> 2) as u8]),
        _ => {}
    }
    out
}

fn decode_cursor(cursor: Option<&str>) -> Option<Value> {
    let cursor = cursor.filter(|cursor| !cursor.is_empty())?;
    let bytes = lenient_base64(cursor);
    let text = String::from_utf8_lossy(&bytes);
    let value = crate::jsutil::parse_json(text.as_bytes()).ok()?;
    (value.is_object() || value.is_array()).then_some(value)
}

#[derive(Default)]
pub struct RowQuery {
    pub filter: Option<Value>,
    pub sorts: Option<Value>,
    pub cursor: Option<String>,
    pub limit: i64,
    pub tz_offset: i64,
}

fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

/// Unsorted lists page by `(position, id)` keyset so concurrent inserts do not
/// shift pages; sorted lists page by offset because the sort keys are nullable
/// expressions.
pub async fn query_rows(page_id: &str, props: &[Property], q: &RowQuery) -> Result<(Vec<RowRecord>, Option<String>)> {
    let filter = compile_filter(props, q.filter.as_ref(), now_ms(), q.tz_offset)?;
    let order = compile_sorts(props, q.sorts.as_ref(), q.tz_offset)?;
    let cursor = decode_cursor(q.cursor.as_deref());
    let limit = q.limit.max(0) as usize;
    if let Some(order) = order {
        let offset = match cursor.as_ref().and_then(|c| c.get("o")) {
            Some(Value::Number(n)) => {
                let o = crate::jsutil::number_value(n);
                if o >= 0.0 {
                    o.floor()
                } else {
                    0.0
                }
            }
            _ => 0.0,
        };
        let rows = db()
            .query(sql!(
                "SELECT {} FROM base_rows r
                 WHERE r.page_id = {} AND {}
                 ORDER BY {}, r.position, r.id
                 LIMIT {} OFFSET {}",
                row_columns(),
                page_id,
                filter,
                order,
                q.limit + 1,
                offset
            ))
            .await?;
        let more = rows.len() > limit;
        let records: Vec<RowRecord> = rows.iter().take(limit).map(RowRecord::from_row).collect();
        let next = more.then(|| encode_cursor(&json!({ "o": crate::jsutil::number_json(offset + q.limit as f64) })));
        return Ok((records, next));
    }
    let after = match cursor.as_ref().map(|c| (c.get("p"), c.get("i"))) {
        Some((Some(Value::String(position)), Some(Value::String(id)))) if is_uuid(id) => {
            sql!("(r.position, r.id) > ({}::text COLLATE \"C\", {}::uuid)", position, id)
        }
        _ => sql_true(),
    };
    let rows = db()
        .query(sql!(
            "SELECT {} FROM base_rows r
             WHERE r.page_id = {} AND {} AND {}
             ORDER BY r.position, r.id
             LIMIT {}",
            row_columns(),
            page_id,
            filter,
            after,
            q.limit + 1
        ))
        .await?;
    let more = rows.len() > limit;
    let records: Vec<RowRecord> = rows.iter().take(limit).map(RowRecord::from_row).collect();
    let next = match records.last() {
        Some(last) if more => Some(encode_cursor(&json!({ "p": last.position, "i": last.id }))),
        _ => None,
    };
    Ok((records, next))
}

/// Every row of a base in display order, in batches, for exports and recomputation.
pub struct AllRows {
    page_id: String,
    after: Option<(String, String)>,
    batch: usize,
    done: bool,
}

pub fn all_rows(page_id: &str) -> AllRows {
    AllRows { page_id: page_id.to_string(), after: None, batch: 500, done: false }
}

impl AllRows {
    pub async fn next(&mut self, conn: Conn<'_>) -> Result<Option<Vec<RowRecord>>> {
        if self.done {
            return Ok(None);
        }
        let condition = match &self.after {
            Some((position, id)) => sql!("(r.position, r.id) > ({}::text COLLATE \"C\", {}::uuid)", position, id),
            None => sql_true(),
        };
        let rows = conn
            .query(sql!(
                "SELECT {} FROM base_rows r WHERE r.page_id = {} AND {}
                 ORDER BY r.position, r.id LIMIT {}",
                row_columns(),
                &self.page_id,
                condition,
                self.batch
            ))
            .await?;
        if rows.is_empty() {
            self.done = true;
            return Ok(None);
        }
        if rows.len() < self.batch {
            self.done = true;
        }
        let records: Vec<RowRecord> = rows.iter().map(RowRecord::from_row).collect();
        self.after = records.last().map(|last| (last.position.clone(), last.id.clone()));
        Ok(Some(records))
    }
}

// ---------------------------------------------------------------------------
// References: names for users and titles for pages mentioned by cells.

fn ids_in(value: Option<&Value>) -> Vec<&str> {
    match value {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
        Some(Value::String(id)) => vec![id.as_str()],
        _ => Vec::new(),
    }
}

/// Pages the user may read, resolved to what a cell needs to render a link, keyed by id.
pub async fn resolve_pages(user_id: &str, ids: &[String]) -> Result<Map<String, Value>> {
    let mut valid: Vec<String> = Vec::new();
    for id in ids.iter().filter(|id| is_uuid(id)).map(|id| id.to_lowercase()) {
        if !valid.contains(&id) {
            valid.push(id);
        }
    }
    let mut pages = Map::new();
    if valid.is_empty() {
        return Ok(pages);
    }
    let rows = db()
        .query(sql!(
            "SELECT p.id, p.slug_id, p.title, p.icon, s.slug AS space_slug FROM pages p JOIN spaces s ON s.id = p.space_id
             WHERE p.id = ANY({}::uuid[]) AND p.deleted_at IS NULL AND p.space_id IN {}",
            array(&valid),
            readable_space_ids(user_id)
        ))
        .await?;
    for row in &rows {
        pages.insert(
            row.str("id"),
            json!({
                "id": row.str("id"),
                "slugId": row.str("slug_id"),
                "title": row.opt_str("title"),
                "icon": row.opt_str("icon"),
                "spaceSlug": row.str("space_slug"),
            }),
        );
    }
    Ok(pages)
}

/// `{ users, pages }` for the people and pages a set of rows refers to.
pub async fn row_references(user_id: &str, props: &[Property], rows: &[RowRecord]) -> Result<Value> {
    let people: Vec<&str> = props.iter().filter(|p| p.type_ == "person").map(|p| p.id.as_str()).collect();
    let links: Vec<&str> = props.iter().filter(|p| p.type_ == "page").map(|p| p.id.as_str()).collect();
    let mut user_ids: Vec<String> = Vec::new();
    let mut page_ids: Vec<String> = Vec::new();
    fn add(set: &mut Vec<String>, id: &str) {
        if !set.iter().any(|known| known == id) {
            set.push(id.to_string());
        }
    }
    for row in rows {
        if let Some(id) = row.creator_id.as_deref().filter(|id| !id.is_empty()) {
            add(&mut user_ids, id);
        }
        if let Some(id) = row.last_editor_id.as_deref().filter(|id| !id.is_empty()) {
            add(&mut user_ids, id);
        }
        for id in &people {
            for value in ids_in(row.cells.get(*id)) {
                add(&mut user_ids, value);
            }
        }
        for id in &links {
            for value in ids_in(row.cells.get(*id)) {
                add(&mut page_ids, value);
            }
        }
    }
    let wanted: Vec<String> = user_ids.into_iter().filter(|id| is_uuid(id)).collect();
    let (users, pages) = tokio::try_join!(user_refs(db(), &wanted), resolve_pages(user_id, &page_ids))?;
    let mut by_id = Map::new();
    for user in users {
        let id = user["id"].as_str().unwrap_or_default().to_string();
        by_id.insert(id, user);
    }
    Ok(json!({ "users": by_id, "pages": pages }))
}

/// The names `cell_text` needs out of `{ users, pages }` references.
pub fn text_context(references: &Value) -> TextContext {
    let mut ctx = TextContext::default();
    for (id, user) in references.get("users").and_then(Value::as_object).into_iter().flatten() {
        if let Some(name) = user.get("name").and_then(Value::as_str) {
            ctx.users.insert(id.clone(), name.to_string());
        }
    }
    for (id, page) in references.get("pages").and_then(Value::as_object).into_iter().flatten() {
        ctx.pages.insert(id.clone(), page.get("title").and_then(Value::as_str).map(str::to_string));
    }
    ctx
}

/// One row as plain text, a field per property.
pub fn row_text(props: &[Property], record: &RowRecord, ctx: &TextContext) -> Vec<String> {
    let (created, updated) = (record.created_iso(), record.updated_iso());
    let meta =
        RowMeta { created_at: &created, updated_at: &updated, creator_id: record.creator_id.as_deref(), last_editor_id: record.last_editor_id.as_deref() };
    props.iter().map(|p| cell_text(p, record.cells.get(&p.id), &meta, ctx)).collect()
}

pub struct BaseText {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// Every row of a base as plain text, in display order, for exports.
pub async fn base_text(page_id: &str, user_id: &str, max_rows: usize) -> Result<BaseText> {
    let props = load_properties(page_id, db()).await?;
    let headers: Vec<String> = props.iter().map(|p| p.name.clone()).collect();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut batches = all_rows(page_id);
    while let Some(batch) = batches.next(db()).await? {
        let ctx = text_context(&row_references(user_id, &props, &batch).await?);
        for record in &batch {
            rows.push(row_text(&props, record, &ctx));
            if rows.len() >= max_rows {
                return Ok(BaseText { headers, rows });
            }
        }
    }
    Ok(BaseText { headers, rows })
}
