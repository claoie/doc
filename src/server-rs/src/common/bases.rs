//! Port of `src/common/bases.ts`.
//!
//! Cells, property options and filter values are untyped JSON, exactly as
//! the TypeScript handles them: `typeof`, truthiness and `String(value)` are
//! spelled out with the `jsutil` helpers, and the difference between
//! `undefined` and `null` is kept (`Option<&Value>` on the way in,
//! `Option<Value>` on the way out of [`normalize_cell`]).

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use crate::common::jsdate::{date_parse, date_utc, utc_fields};
use crate::common::jsnum::{is_integer, to_precision};
use crate::jsutil::{
    is_js_whitespace, js_json, js_number, js_slice, js_string, js_trim, js_truthy, js_truthy_opt, number_json, number_to_string, number_value,
    string_to_number, utf16_len,
};

pub const PROPERTY_TYPES: [&str; 17] = [
    "text",
    "longText",
    "number",
    "select",
    "status",
    "multiSelect",
    "date",
    "person",
    "file",
    "page",
    "checkbox",
    "url",
    "email",
    "createdAt",
    "lastEditedAt",
    "lastEditedBy",
    "formula",
];

/// Values come from row metadata, never from cells.
pub const SYSTEM_TYPES: [&str; 3] = ["createdAt", "lastEditedAt", "lastEditedBy"];

pub fn is_system_type(type_: &str) -> bool {
    SYSTEM_TYPES.contains(&type_)
}

/// Types whose cells a user can edit. (A type this code does not know counts
/// as editable here, as in TypeScript; [`normalize_cell`] then ignores it.)
pub fn is_editable_type(type_: &str) -> bool {
    type_ != "formula" && !is_system_type(type_)
}

pub fn is_choice_type(type_: &str) -> bool {
    matches!(type_, "select" | "status" | "multiSelect")
}

pub const VIEW_TYPES: [&str; 3] = ["table", "kanban", "calendar"];

pub const FILTER_OPERATORS: [&str; 20] = [
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "ncontains",
    "startsWith",
    "endsWith",
    "isEmpty",
    "isNotEmpty",
    "before",
    "after",
    "onOrBefore",
    "onOrAfter",
    "any",
    "none",
    "all",
    "isWithin",
];

pub const RELATIVE_DAYS: [&str; 7] = ["today", "tomorrow", "yesterday", "oneWeekAgo", "oneWeekFromNow", "oneMonthAgo", "oneMonthFromNow"];
pub const DATE_RANGES: [&str; 9] = ["pastWeek", "pastMonth", "pastYear", "thisWeek", "thisMonth", "thisYear", "nextWeek", "nextMonth", "nextYear"];

/// `"children" in node`: a filter group rather than a single condition.
pub fn is_filter_group(node: &Value) -> bool {
    node.as_object().is_some_and(|object| object.contains_key("children"))
}

/// Kanban column for rows without a value.
pub const NO_VALUE: &str = "__no_value";

pub struct Limits {
    pub text: usize,
    pub url: usize,
    pub email: usize,
    pub name: usize,
    pub choices: usize,
    pub files: usize,
    pub rows_per_page: usize,
    pub sorts: usize,
    pub filter_children: usize,
    pub formula: usize,
}

/// Lengths are in UTF-16 code units, as `string.length` counts them.
pub const LIMITS: Limits = Limits {
    text: 100_000,
    url: 2048,
    email: 320,
    name: 200,
    choices: 500,
    files: 100,
    rows_per_page: 500,
    sorts: 10,
    filter_children: 200,
    formula: 10_000,
};

pub const CHOICE_COLORS: [&str; 13] =
    ["gray", "red", "pink", "grape", "violet", "indigo", "blue", "cyan", "teal", "green", "lime", "yellow", "orange"];

/// The choices a new status property starts with.
pub fn default_status_choices() -> Value {
    json!([
        { "id": "status-todo", "name": "Not started", "color": "gray", "category": "todo" },
        { "id": "status-doing", "name": "In progress", "color": "blue", "category": "inProgress" },
        { "id": "status-done", "name": "Done", "color": "green", "category": "complete" },
    ])
}

/// A column of a base. `type_` stays a string because rows in the database
/// may hold types this code does not know, and `options` stays JSON so keys
/// written by newer clients survive.
#[derive(Debug, Clone, PartialEq)]
pub struct Property {
    pub id: String,
    pub name: String,
    pub type_: String,
    pub options: Map<String, Value>,
    pub is_primary: bool,
    pub position: String,
}

impl Property {
    /// Reads `{id, name, type, options, isPrimary, position}`. `None` unless
    /// the value is an object with string `id`, `name` and `type`; missing or
    /// malformed `options`, `isPrimary` and `position` take their empty value.
    pub fn from_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(Property {
            id: text("id")?,
            name: text("name")?,
            type_: text("type")?,
            options: object.get("options").and_then(Value::as_object).cloned().unwrap_or_default(),
            is_primary: js_truthy_opt(object.get("isPrimary")),
            position: text("position").unwrap_or_default(),
        })
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "type": self.type_,
            "options": self.options,
            "isPrimary": self.is_primary,
            "position": self.position,
        })
    }

    /// `prop.options.choices ?? []`, as a slice. Anything but an array reads
    /// as no choices (TypeScript would throw on such options).
    fn choices(&self) -> &[Value] {
        choices_of(&self.options)
    }
}

fn choices_of(options: &Map<String, Value>) -> &[Value] {
    options.get("choices").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// The ids of the choices in `options`, for `Set.has` with a string.
fn choice_ids(options: &Map<String, Value>) -> HashSet<&str> {
    choices_of(options).iter().filter_map(|choice| choice.get("id").and_then(Value::as_str)).collect()
}

/// The parts of a row that are not cells.
#[derive(Debug, Clone, Copy)]
pub struct RowMeta<'a> {
    pub created_at: &'a str,
    pub updated_at: &'a str,
    pub creator_id: Option<&'a str>,
    pub last_editor_id: Option<&'a str>,
}

/// Names for the ids cells refer to.
#[derive(Debug, Clone, Default)]
pub struct TextContext {
    /// User id to display name.
    pub users: HashMap<String, String>,
    /// Page id to title (`None` for an untitled page).
    pub pages: HashMap<String, Option<String>>,
}

/// The keys every JavaScript object inherits. TypeScript looks users and
/// pages up in plain objects, so an id spelled like one of these finds a
/// built-in function instead of nothing; [`cell_text`] reproduces what comes
/// out of that.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "toString",
    "toLocaleString",
    "valueOf",
    "hasOwnProperty",
    "propertyIsEnumerable",
    "isPrototypeOf",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
    "constructor",
];

impl TextContext {
    /// `ctx.users?.[id]?.name ?? ""`.
    fn user_name(&self, id: &str) -> String {
        if let Some(name) = self.users.get(id) {
            return name.clone();
        }
        match id {
            // The inherited functions are named after their keys, except the constructor.
            "constructor" => "Object".to_owned(),
            "__proto__" => String::new(),
            _ if OBJECT_PROTOTYPE_KEYS.contains(&id) => id.to_owned(),
            _ => String::new(),
        }
    }

    /// `page ? page.title || "Untitled" : ""` for `page = ctx.pages?.[id]`.
    fn page_title(&self, id: &str) -> String {
        match self.pages.get(id) {
            Some(Some(title)) if !title.is_empty() => title.clone(),
            Some(_) => "Untitled".to_owned(),
            None if OBJECT_PROTOTYPE_KEYS.contains(&id) => "Untitled".to_owned(),
            None => String::new(),
        }
    }
}

/// A cell value that its property does not accept. The message reads
/// `Invalid value for "<property name>": <reason>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellError(pub String);

impl std::fmt::Display for CellError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CellError {}

/// `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`: no white space, exactly one `@` with
/// something before it, and after it a dot that is neither the first nor
/// the last character.
fn is_email(s: &str) -> bool {
    if s.chars().any(is_js_whitespace) {
        return false;
    }
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    if local.is_empty() || domain.contains('@') {
        return false;
    }
    let mut chars = domain.chars();
    let (first, last) = (chars.next(), chars.next_back());
    first.is_some() && last.is_some() && chars.any(|ch| ch == '.')
}

/// `/^(https?:\/\/|mailto:|tel:)\S+$/i`.
fn is_url(s: &str) -> bool {
    let lower_starts = |prefix: &str| s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes());
    let Some(prefix) = ["http://", "https://", "mailto:", "tel:"].into_iter().find(|prefix| lower_starts(prefix)) else {
        return false;
    };
    let rest = &s[prefix.len()..];
    !rest.is_empty() && !rest.chars().any(is_js_whitespace)
}

/// `asIdList`: the value as a list (a lone value is a list of one), keeping
/// the non-empty strings, each once, in first-seen order.
fn as_id_list(value: &Value) -> Vec<&str> {
    let single = std::slice::from_ref(value);
    let list = value.as_array().map_or(single, Vec::as_slice);
    let mut seen = HashSet::new();
    list.iter().filter_map(Value::as_str).filter(|id| !id.is_empty() && seen.insert(*id)).collect()
}

fn strings(ids: &[&str]) -> Value {
    Value::Array(ids.iter().map(|id| Value::String((*id).to_owned())).collect())
}

/// Validates one incoming cell value against its property and returns what
/// is stored. `Ok(Some(Value::Null))` clears the cell; `Ok(None)` is
/// JavaScript's `undefined` and means the key is ignored (properties that
/// are not user-editable, and types this code does not know).
pub fn normalize_cell(prop: &Property, value: Option<&Value>) -> Result<Option<Value>, CellError> {
    if !is_editable_type(&prop.type_) {
        return Ok(None);
    }
    let value = match value {
        None | Some(Value::Null) => return Ok(Some(Value::Null)),
        Some(value) => value,
    };
    let fail = |detail: &str| Err(CellError(format!("Invalid value for \"{}\": {detail}", prop.name)));
    let text_or_null = |s: String| Ok(Some(if s.is_empty() { Value::Null } else { Value::String(s) }));
    match prop.type_.as_str() {
        "text" | "longText" => {
            let s = js_string(value);
            if utf16_len(&s) > LIMITS.text {
                return fail("text too long");
            }
            text_or_null(s)
        }
        "url" => {
            let s = js_trim(&js_string(value)).to_owned();
            if s.is_empty() {
                return Ok(Some(Value::Null));
            }
            if utf16_len(&s) > LIMITS.url || s.chars().any(is_js_whitespace) {
                return fail("not a URL");
            }
            text_or_null(s)
        }
        "email" => {
            let s = js_trim(&js_string(value)).to_owned();
            if s.is_empty() {
                return Ok(Some(Value::Null));
            }
            if utf16_len(&s) > LIMITS.email || !is_email(&s) {
                return fail("not an email address");
            }
            text_or_null(s)
        }
        "number" => {
            if value.as_str().is_some_and(|s| js_trim(s).is_empty()) {
                return Ok(Some(Value::Null));
            }
            let n = js_number(value);
            if !n.is_finite() {
                return fail("not a number");
            }
            Ok(Some(number_json(n)))
        }
        "checkbox" => match value {
            Value::Bool(b) => Ok(Some(Value::Bool(*b))),
            Value::Number(n) => Ok(Some(Value::Bool(number_value(n) != 0.0))),
            Value::String(s) => match js_trim(s).to_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => Ok(Some(Value::Bool(true))),
                "false" | "0" | "no" | "off" | "" => Ok(Some(Value::Bool(false))),
                _ => fail("not a checkbox value"),
            },
            _ => fail("not a checkbox value"),
        },
        "date" => {
            let s = js_trim(&js_string(value)).to_owned();
            if s.is_empty() {
                return Ok(Some(Value::Null));
            }
            if date_parse(&s).is_nan() {
                return fail("not a date");
            }
            text_or_null(s)
        }
        "select" | "status" => {
            // `Array.isArray(value) ? value[0] : value`; a missing first element is `undefined`.
            let id = match value {
                Value::Array(items) => items.first(),
                other => Some(other),
            };
            match id {
                None | Some(Value::Null) => Ok(Some(Value::Null)),
                Some(Value::String(s)) if s.is_empty() => Ok(Some(Value::Null)),
                Some(Value::String(s)) if choice_ids(&prop.options).contains(s.as_str()) => Ok(Some(Value::String(s.clone()))),
                Some(_) => fail("unknown option"),
            }
        }
        "multiSelect" => {
            let ids = as_id_list(value);
            let known = choice_ids(&prop.options);
            if ids.iter().any(|id| !known.contains(id)) {
                return fail("unknown option");
            }
            Ok(Some(if ids.is_empty() { Value::Null } else { strings(&ids) }))
        }
        "person" => {
            let ids = as_id_list(value);
            if ids.iter().any(|id| utf16_len(id) > 64) {
                return fail("invalid user id");
            }
            if ids.is_empty() {
                return Ok(Some(Value::Null));
            }
            Ok(Some(if js_truthy_opt(prop.options.get("allowMultiple")) { strings(&ids) } else { Value::String(ids[0].to_owned()) }))
        }
        "page" => {
            let s = js_trim(&js_string(value)).to_owned();
            if s.is_empty() {
                return Ok(Some(Value::Null));
            }
            if utf16_len(&s) > 64 {
                return fail("invalid page id");
            }
            text_or_null(s)
        }
        "file" => {
            let Value::Array(items) = value else {
                return fail("expected a list of files");
            };
            if items.len() > LIMITS.files {
                return fail("too many files");
            }
            let mut files = Vec::with_capacity(items.len());
            for item in items {
                // `!f || typeof f !== "object"`: arrays pass as objects without the fields.
                let fields = match item {
                    Value::Object(fields) => Some(fields),
                    Value::Array(_) => None,
                    _ => return fail("invalid file"),
                };
                let field = |key: &str| fields.and_then(|f| f.get(key));
                let id = match field("id") {
                    Some(Value::String(id)) if !id.is_empty() && utf16_len(id) <= 128 => id,
                    _ => return fail("invalid file id"),
                };
                let file_name = match field("fileName") {
                    Some(Value::String(name)) if utf16_len(name) <= 1024 => name,
                    _ => return fail("invalid file name"),
                };
                let url = match field("url") {
                    None => None,
                    Some(Value::String(url)) if utf16_len(url) <= LIMITS.url => Some(url),
                    Some(_) => return fail("invalid file url"),
                };
                let mut file = Map::new();
                file.insert("id".to_owned(), Value::String(id.clone()));
                file.insert("fileName".to_owned(), Value::String(file_name.clone()));
                if let Some(Value::String(mime_type)) = field("mimeType") {
                    file.insert("mimeType".to_owned(), Value::String(mime_type.clone()));
                }
                if let Some(Value::Number(size)) = field("fileSize") {
                    file.insert("fileSize".to_owned(), number_json(number_value(size)));
                }
                if let Some(url) = url {
                    file.insert("url".to_owned(), Value::String(url.clone()));
                }
                files.push(Value::Object(file));
            }
            Ok(Some(if files.is_empty() { Value::Null } else { Value::Array(files) }))
        }
        _ => Ok(None),
    }
}

/// A canonical array index (`"0"`, `"42"`, up to 2^32 - 2). JavaScript lists
/// such keys of an object first, in ascending order, before the other keys
/// in insertion order.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u64>().ok().filter(|n| *n < u64::from(u32::MAX)).map(|n| n as u32)
}

/// `Object.entries(object)` in JavaScript's order.
fn js_entries(object: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, &String, &Value)> = object.iter().filter_map(|(k, v)| array_index(k).map(|i| (i, k, v))).collect();
    indexed.sort_by_key(|(index, _, _)| *index);
    let mut entries: Vec<(&String, &Value)> = indexed.into_iter().map(|(_, k, v)| (k, v)).collect();
    entries.extend(object.iter().filter(|(k, _)| array_index(k).is_none()));
    entries
}

/// Normalizes a patch; unknown and read-only keys are dropped, `null` values
/// remain (they clear). With `apply_defaults`, properties the patch does not
/// mention get their `defaultValue` when it still validates.
///
/// The result lists the patch's keys in the order JavaScript enumerates them
/// and then the defaults in property order. The first invalid value in that
/// order is the error.
pub fn normalize_cells(props: &[Property], patch: &Map<String, Value>, apply_defaults: bool) -> Result<Map<String, Value>, CellError> {
    // `new Map(props.map(...))`: of two properties with one id, the later wins.
    let by_id: HashMap<&str, &Property> = props.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut out = Map::new();
    for (key, value) in js_entries(patch) {
        let Some(prop) = by_id.get(key.as_str()) else {
            continue;
        };
        if let Some(normalized) = normalize_cell(prop, Some(value))? {
            out.insert(key.clone(), normalized);
        }
    }
    if apply_defaults {
        for prop in props {
            let fallback = match prop.options.get("defaultValue") {
                None | Some(Value::Null) => continue,
                Some(Value::String(s)) if s.is_empty() => continue,
                Some(fallback) => fallback,
            };
            if out.contains_key(&prop.id) {
                continue;
            }
            // A default that no longer validates (e.g. a deleted option) is skipped.
            if let Ok(Some(normalized)) = normalize_cell(prop, Some(fallback)) {
                if !normalized.is_null() {
                    out.insert(prop.id.clone(), normalized);
                }
            }
        }
    }
    Ok(out)
}

/// Number to text without float noise (`0.1 + 0.2` reads `0.3`).
pub fn number_text(n: f64) -> String {
    if !n.is_finite() {
        return String::new();
    }
    if is_integer(n) {
        return number_to_string(n);
    }
    number_to_string(string_to_number(&to_precision(n, 15)))
}

/// `a === b` for JSON values that came from different places: primitives
/// compare by value, arrays and objects are never the same object.
fn strict_equals(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => number_value(x) == number_value(y),
        (Value::String(x), Value::String(y)) => x == y,
        _ => false,
    }
}

/// `value ?? ""` then what `Array.prototype.join` or a template would make
/// of it; `None` when the value is falsy (dropped by `.filter(Boolean)`).
fn truthy_text(value: Option<&Value>) -> Option<String> {
    value.filter(|v| js_truthy(v)).map(js_string)
}

/// Plain-text rendering of a cell, used by CSV export, search and type conversion.
pub fn cell_text(prop: &Property, value: Option<&Value>, row: &RowMeta, ctx: &TextContext) -> String {
    // `prop.options.choices?.find((c) => c.id === id)?.name ?? ""`
    let choice_name = |id: &Value| -> Option<&Value> {
        let choice = prop.choices().iter().find(|choice| choice.get("id").is_some_and(|choice_id| strict_equals(choice_id, id)))?;
        choice.get("name").filter(|name| !name.is_null())
    };
    match prop.type_.as_str() {
        "createdAt" => return row.created_at.to_owned(),
        "lastEditedAt" => return row.updated_at.to_owned(),
        "lastEditedBy" => return row.last_editor_id.or(row.creator_id).map(|id| ctx.user_name(id)).unwrap_or_default(),
        "checkbox" => return if value == Some(&Value::Bool(true)) { "true" } else { "false" }.to_owned(),
        _ => {}
    }
    let value = match value {
        None | Some(Value::Null) => return String::new(),
        Some(value) => value,
    };
    match prop.type_.as_str() {
        "select" | "status" => choice_name(value).map(js_string).unwrap_or_default(),
        "multiSelect" => {
            as_id_list(value).into_iter().filter_map(|id| truthy_text(choice_name(&Value::String(id.to_owned())))).collect::<Vec<_>>().join(", ")
        }
        "person" => as_id_list(value).into_iter().map(|id| ctx.user_name(id)).filter(|name| !name.is_empty()).collect::<Vec<_>>().join(", "),
        "page" => value.as_str().map(|id| ctx.page_title(id)).unwrap_or_default(),
        "file" => match value {
            // `f?.fileName ?? ""`, falsy names dropped
            Value::Array(files) => files.iter().filter_map(|file| truthy_text(file.get("fileName"))).collect::<Vec<_>>().join(", "),
            _ => String::new(),
        },
        "number" => match value {
            Value::Number(n) => number_text(number_value(n)),
            other => js_string(other),
        },
        "formula" => match value {
            Value::Object(fields) if fields.contains_key("error") => "#ERROR".to_owned(),
            Value::Number(n) => number_text(number_value(n)),
            other => js_string(other),
        },
        _ => match value {
            Value::String(s) => s.clone(),
            other => js_json(other),
        },
    }
}

/// The ids in `value` that are choices of `options`: the whole list for a
/// multi-select, the first for a select or status, `null` for none.
fn convert_choices(value: &Value, to_type: &str, to_options: &Map<String, Value>) -> Value {
    let known = choice_ids(to_options);
    let ids: Vec<&str> = as_id_list(value).into_iter().filter(|id| known.contains(id)).collect();
    if to_type == "multiSelect" {
        if ids.is_empty() {
            Value::Null
        } else {
            strings(&ids)
        }
    } else {
        ids.first().map_or(Value::Null, |id| Value::String((*id).to_owned()))
    }
}

/// Converts a stored cell to another property type. `Value::Null` means there
/// is no sensible representation and the cell is cleared.
///
/// The only error is the one TypeScript throws too: converting a person cell
/// to a person property re-validates it, and an id longer than 64 characters
/// is a [`CellError`].
///
/// Text converted to a `text` property is cut to 2000 UTF-16 code units.
/// Where that cut falls between the two halves of a surrogate pair,
/// JavaScript keeps half a character; here the whole character is kept.
pub fn convert_cell(
    value: Option<&Value>,
    from: &Property,
    to_type: &str,
    to_options: &Map<String, Value>,
    row: &RowMeta,
    ctx: &TextContext,
) -> Result<Value, CellError> {
    let value = match value {
        None | Some(Value::Null) => return Ok(Value::Null),
        Some(value) => value,
    };
    if from.type_ == to_type {
        if to_type == "person" {
            let retyped = Property { options: to_options.clone(), ..from.clone() };
            return Ok(normalize_cell(&retyped, Some(value))?.unwrap_or(Value::Null));
        }
        if is_choice_type(to_type) {
            return Ok(convert_choices(value, to_type, to_options));
        }
        return Ok(value.clone());
    }
    // Choice, people and page cells hold ids; convert their display text instead.
    let by_reference = is_choice_type(&from.type_) || matches!(from.type_.as_str(), "person" | "page" | "lastEditedBy");
    let text = match value {
        Value::String(s) if !by_reference => s.clone(),
        _ => cell_text(from, Some(value), row, ctx),
    };
    let text_or_null = |s: &str| if s.is_empty() { Value::Null } else { Value::String(s.to_owned()) };
    Ok(match to_type {
        "text" => text_or_null(&js_slice(&text, 0, Some(2000))),
        "longText" => text_or_null(&text),
        "select" | "status" | "multiSelect" => {
            if is_choice_type(&from.type_) {
                convert_choices(value, to_type, to_options)
            } else {
                Value::Null
            }
        }
        "number" => match value {
            Value::Number(n) => number_json(number_value(n)),
            Value::Bool(b) => json!(u8::from(*b)),
            _ => {
                let cleaned: String = text.chars().filter(|ch| *ch != ',' && !is_js_whitespace(*ch)).collect();
                let n = string_to_number(&cleaned);
                if cleaned.is_empty() || !n.is_finite() {
                    Value::Null
                } else {
                    number_json(n)
                }
            }
        },
        "date" => {
            let s = js_trim(&text);
            if !s.is_empty() && !date_parse(s).is_nan() {
                Value::String(s.to_owned())
            } else {
                Value::Null
            }
        }
        "checkbox" => match value {
            Value::Bool(b) => Value::Bool(*b),
            Value::Number(n) => Value::Bool(number_value(n) != 0.0),
            _ => match js_trim(&text).to_lowercase().as_str() {
                "yes" | "true" | "1" | "y" | "on" | "checked" => Value::Bool(true),
                "no" | "false" | "0" | "n" | "off" => Value::Bool(false),
                _ => Value::Null,
            },
        },
        "url" => {
            let s = js_trim(&text);
            if is_url(s) && utf16_len(s) <= LIMITS.url {
                Value::String(s.to_owned())
            } else {
                Value::Null
            }
        }
        "email" => {
            let s = js_trim(&text);
            if is_email(s) && utf16_len(s) <= LIMITS.email {
                Value::String(s.to_owned())
            } else {
                Value::Null
            }
        }
        _ => Value::Null,
    })
}

const DAY: f64 = 86_400_000.0;

/// `/^(\d{4})-(\d{2})-(\d{2})/`: the three numbers a text starts with.
fn leading_date(s: &str) -> Option<(f64, f64, f64)> {
    let b = s.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<f64> {
        let part = b.get(range)?;
        part.iter().all(u8::is_ascii_digit).then(|| part.iter().fold(0.0, |n, d| n * 10.0 + f64::from(d - b'0')))
    };
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    Some((digits(0..4)?, digits(5..7)?, digits(8..10)?))
}

/// Resolves a date filter value to a half-open range `[start, end)` in epoch
/// milliseconds. Days are aligned to the viewer's zone, given as minutes east
/// of UTC; weeks start on Monday.
///
/// `None` when the value is not a date filter. The bounds are NaN where the
/// JavaScript arithmetic gives NaN (a `now` or a date outside the range of
/// time values); such a range matches nothing.
pub fn date_range(value: Option<&Value>, now_ms: f64, offset_minutes: f64) -> Option<(f64, f64)> {
    let offset = offset_minutes * 60_000.0;
    // The getters of an invalid date are NaN, and so is everything computed from them.
    let fields_of = |time: f64| match utc_fields(time) {
        Some(f) => (f.year as f64, f.month as f64, f.date as f64, f.weekday as f64),
        None => (f64::NAN, f64::NAN, f64::NAN, f64::NAN),
    };
    let (y, m, d, weekday) = fields_of(now_ms + offset);
    let at = |year: f64, month: f64, day: f64| date_utc(&[year, month, day]) - offset;
    let today = at(y, m, d);
    let day = |start: f64| Some((start, start + DAY));

    // A string is an exact date; an object carries `mode` and `date` or `preset`.
    let (mode, date, preset) = match value? {
        Value::String(date) => (Some("exact"), Some(date.clone()), None),
        Value::Object(fields) => (
            fields.get("mode").and_then(Value::as_str),
            // `v.date ?? ""` for the pattern and `Date.parse(v.date)` both see the value as a string.
            fields.get("date").map(js_string),
            fields.get("preset").and_then(Value::as_str),
        ),
        _ => return None,
    };
    match mode? {
        "exact" => {
            // A missing date is `undefined` to `Date.parse`, which is not a date.
            let date = date?;
            if let Some((year, month, date)) = leading_date(&date) {
                return day(at(year, month - 1.0, date));
            }
            let t = date_parse(&date);
            if t.is_nan() {
                return None;
            }
            let (year, month, date, _) = fields_of(t + offset);
            day(at(year, month, date))
        }
        "relative" => match preset? {
            "today" => day(today),
            "tomorrow" => day(at(y, m, d + 1.0)),
            "yesterday" => day(at(y, m, d - 1.0)),
            "oneWeekAgo" => day(at(y, m, d - 7.0)),
            "oneWeekFromNow" => day(at(y, m, d + 7.0)),
            "oneMonthAgo" => day(at(y, m - 1.0, d)),
            "oneMonthFromNow" => day(at(y, m + 1.0, d)),
            _ => None,
        },
        "range" => {
            let tomorrow = at(y, m, d + 1.0);
            let monday = at(y, m, d - ((weekday + 6.0) % 7.0));
            match preset? {
                "pastWeek" => Some((at(y, m, d - 7.0), tomorrow)),
                "pastMonth" => Some((at(y, m - 1.0, d), tomorrow)),
                "pastYear" => Some((at(y - 1.0, m, d), tomorrow)),
                "thisWeek" => Some((monday, monday + 7.0 * DAY)),
                "thisMonth" => Some((at(y, m, 1.0), at(y, m + 1.0, 1.0))),
                "thisYear" => Some((at(y, 0.0, 1.0), at(y + 1.0, 0.0, 1.0))),
                "nextWeek" => Some((today, at(y, m, d + 7.0))),
                "nextMonth" => Some((today, at(y, m + 1.0, d))),
                "nextYear" => Some((today, at(y + 1.0, m, d))),
                _ => None,
            }
        }
        _ => None,
    }
}

/// How a property behaves in filters and sorts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ColumnKind {
    Text,
    Number,
    Time,
    Flag,
    List,
}

impl ColumnKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ColumnKind::Text => "text",
            ColumnKind::Number => "number",
            ColumnKind::Time => "time",
            ColumnKind::Flag => "flag",
            ColumnKind::List => "list",
        }
    }

    /// `OPERATORS_BY_KIND[kind]`: the filter operators offered for this kind, in menu order.
    pub fn operators(self) -> &'static [&'static str] {
        match self {
            ColumnKind::Text => &[
                "eq",
                "neq",
                "contains",
                "ncontains",
                "startsWith",
                "endsWith",
                "gt",
                "gte",
                "lt",
                "lte",
                "any",
                "none",
                "all",
                "isEmpty",
                "isNotEmpty",
            ],
            ColumnKind::Number => &["eq", "neq", "gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"],
            ColumnKind::Time => {
                &["eq", "neq", "before", "after", "onOrBefore", "onOrAfter", "gt", "gte", "lt", "lte", "isWithin", "isEmpty", "isNotEmpty"]
            }
            ColumnKind::Flag => &["eq", "neq", "isEmpty", "isNotEmpty"],
            ColumnKind::List => &["eq", "neq", "any", "none", "all", "contains", "ncontains", "isEmpty", "isNotEmpty"],
        }
    }
}

/// The kinds in the order `OPERATORS_BY_KIND` lists them.
pub const OPERATORS_BY_KIND: [ColumnKind; 5] = [ColumnKind::Text, ColumnKind::Number, ColumnKind::Time, ColumnKind::Flag, ColumnKind::List];

pub fn column_kind(prop: &Property) -> ColumnKind {
    match prop.type_.as_str() {
        "number" => ColumnKind::Number,
        "date" | "createdAt" | "lastEditedAt" => ColumnKind::Time,
        "checkbox" => ColumnKind::Flag,
        "multiSelect" | "file" => ColumnKind::List,
        "person" => {
            if js_truthy_opt(prop.options.get("allowMultiple")) {
                ColumnKind::List
            } else {
                ColumnKind::Text
            }
        }
        "formula" => match prop.options.get("resultType").and_then(Value::as_str) {
            Some("number") => ColumnKind::Number,
            Some("boolean") => ColumnKind::Flag,
            Some("date") => ColumnKind::Time,
            _ => ColumnKind::Text,
        },
        _ => ColumnKind::Text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns() {
        for good in ["a@b.c", "a.b@c.d.e", "a@b..c", "a@.b.c"] {
            assert!(is_email(good), "{good}");
        }
        for bad in ["", "a@b", "a@b.", "a@.b", "@b.c", "a@@b.c", "a b@c.d", "a@b.c\n", "a@b@c.d"] {
            assert!(!is_email(bad), "{bad}");
        }
        for good in ["http://x", "HTTPS://x.y/z", "mailto:a", "TEL:1"] {
            assert!(is_url(good), "{good}");
        }
        for bad in ["http://", "ftp://x", "http://a b", "x http://a", "mailto:", "http:/x"] {
            assert!(!is_url(bad), "{bad}");
        }
        assert_eq!(leading_date("2024-03-05T10:00"), Some((2024.0, 3.0, 5.0)));
        assert_eq!(leading_date("2024-3-05"), None);
        assert_eq!(leading_date(" 2024-03-05"), None);
    }

    #[test]
    fn javascript_key_order() {
        let object: Map<String, Value> = serde_json::from_str(r#"{"b":1,"10":2,"a":3,"2":4,"01":5}"#).unwrap();
        let keys: Vec<&str> = js_entries(&object).into_iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["2", "10", "b", "a", "01"]);
    }
}
