//! Port of `src/common/editor/sanitize.ts`.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

use super::model::node_type;
use super::steps::StepError;
use crate::jsutil::{is_js_whitespace, js_trim};

fn scheme_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i-u)^([a-z][a-z0-9+.-]*):").expect("scheme pattern"))
}

fn allowed_scheme_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i-u)^(https?|mailto|tel):").expect("allowed scheme pattern"))
}

fn data_image_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i-u)^data:image/(png|jpe?g|gif|webp|avif|svg\+xml);").expect("data image pattern"))
}

/// A URL that is safe to put in `href`/`src`: relative, fragment, http(s),
/// mailto or tel, and `data:image/` when `allow_data_image`. Anything else
/// (javascript:, data:text/html, vbscript:, ...) becomes `""`, and so does a
/// value that is not a string.
pub fn clean_url(value: Option<&Value>, allow_data_image: bool) -> String {
    match value.and_then(Value::as_str) {
        Some(s) => clean_url_str(s, allow_data_image),
        None => String::new(),
    }
}

/// `clean_url` for a value known to be a string.
pub fn clean_url_str(value: &str, allow_data_image: bool) -> String {
    let s = js_trim(value);
    if s.is_empty() {
        return String::new();
    }
    // Browsers ignore control characters and whitespace inside the scheme.
    let compact: String = s.chars().filter(|c| !(is_js_whitespace(*c) || (*c as u32) <= 0x1f || *c == '\u{7f}')).collect();
    if !scheme_re().is_match(&compact) {
        return s.to_string();
    }
    if allowed_scheme_re().is_match(&compact) {
        return s.to_string();
    }
    if allow_data_image && data_image_re().is_match(&compact) {
        return s.to_string();
    }
    String::new()
}

const URL_ATTRS: [&str; 3] = ["src", "url", "href"];

/// `cleanAttrs`: the attributes with every URL made safe, or `None` when nothing changed.
fn clean_attrs(attrs: Option<&Value>, allow_data_image: bool) -> Option<Value> {
    let Some(Value::Object(attrs)) = attrs else { return None };
    let mut out: Option<Map<String, Value>> = None;
    for (key, value) in attrs {
        if !URL_ATTRS.contains(&key.as_str()) || value.is_null() {
            continue;
        }
        let clean = clean_url(Some(value), allow_data_image);
        if value.as_str() != Some(clean.as_str()) {
            out.get_or_insert_with(|| attrs.clone()).insert(key.clone(), Value::String(clean));
        }
    }
    out.map(Value::Object)
}

/// `cleanMarks`: `Ok(None)` when nothing changed. A mark that is `null`, or
/// marks given as a string, is where the original fails with a `TypeError`.
fn clean_marks(marks: Option<&Value>) -> Result<Option<Value>, StepError> {
    let marks = match marks {
        Some(Value::Array(marks)) if !marks.is_empty() => marks,
        Some(Value::String(text)) if !text.is_empty() => return Err(StepError::Malformed("marks are not a list".into())),
        _ => return Ok(None),
    };
    let mut out: Option<Vec<Value>> = None;
    for (index, mark) in marks.iter().enumerate() {
        if mark.is_null() {
            return Err(StepError::Malformed("a mark is empty".into()));
        }
        if let Some(attrs) = clean_attrs(mark.get("attrs"), false) {
            let changed = out.get_or_insert_with(|| marks.clone());
            changed[index].as_object_mut().expect("a mark with attrs is an object").insert("attrs".into(), attrs);
        }
    }
    Ok(out.map(Value::Array))
}

/// Images may come from `data:` URLs; nothing else may.
fn allows_data_image(node_type: &str) -> bool {
    matches!(node_type, "image" | "drawio" | "excalidraw")
}

fn sanitize(node: &Value) -> Result<Value, StepError> {
    if node.is_null() {
        return Err(StepError::Malformed("a node is empty".into()));
    }
    let Value::Object(object) = node else { return Ok(node.clone()) };
    let mut out = object.clone();
    if let Some(attrs) = clean_attrs(object.get("attrs"), allows_data_image(node_type(node))) {
        out.insert("attrs".into(), attrs);
    }
    if let Some(marks) = clean_marks(object.get("marks"))? {
        out.insert("marks".into(), marks);
    }
    if let Some(Value::Array(content)) = object.get("content") {
        out.insert("content".into(), Value::Array(content.iter().map(sanitize).collect::<Result<_, _>>()?));
    }
    Ok(Value::Object(out))
}

/// Returns the node with every URL attribute (node or mark) made safe. The
/// tree must be one `validate_doc` accepted; anything else comes back as it is.
pub fn sanitize_node(node: &Value) -> Value {
    sanitize(node).unwrap_or_else(|_| node.clone())
}

fn sanitize_item(item: &Value) -> Result<Value, StepError> {
    let object = match item {
        Value::Object(object) => object,
        Value::Array(_) => return Ok(item.clone()),
        _ => return Err(StepError::Malformed("a slice item is not an object".into())),
    };
    if let Some(node) = object.get("n") {
        let mut out = Map::new();
        out.insert("n".into(), sanitize(node)?);
        return Ok(Value::Object(out));
    }
    let mut out = object.clone();
    if let Some(opened) = object.get("o") {
        if let Some(attrs) = clean_attrs(object.get("a"), allows_data_image(opened.as_str().unwrap_or(""))) {
            out.insert("a".into(), attrs);
        }
        if let Some(marks) = clean_marks(object.get("m"))? {
            out.insert("m".into(), marks);
        }
    } else if object.contains_key("t") {
        if let Some(marks) = clean_marks(object.get("m"))? {
            out.insert("m".into(), marks);
        }
    }
    Ok(Value::Object(out))
}

/// Makes the content a step inserts safe. Attribute steps do not carry the
/// node type, so data-image URLs are not allowed through them. The step must
/// have passed `is_step`.
pub fn sanitize_step(step: &Value) -> Result<Value, StepError> {
    let Value::Object(object) = step else { return Err(StepError::Malformed("a step is not an object".into())) };
    let mut out = object.clone();
    match object.get("stepType").and_then(Value::as_str) {
        Some("replace" | "replaceAround") => {
            let items = object.get("slice").and_then(Value::as_array).ok_or_else(|| StepError::Malformed("the step has no slice".into()))?;
            out.insert("slice".into(), Value::Array(items.iter().map(sanitize_item).collect::<Result<_, _>>()?));
        }
        Some("addMark" | "removeMark") => {
            let mark = object.get("mark").cloned().unwrap_or(Value::Null);
            let cleaned = clean_marks(Some(&Value::Array(vec![mark.clone()])))?;
            let mark = cleaned.and_then(|list| list.as_array().and_then(|l| l.first().cloned())).unwrap_or(mark);
            out.insert("mark".into(), mark);
        }
        Some("attr") => {
            if let Some(attrs) = clean_attrs(object.get("attrs"), false) {
                out.insert("attrs".into(), attrs);
            }
        }
        _ => {}
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cleans_urls() {
        assert_eq!(clean_url_str(" https://example.com/a b ", false), "https://example.com/a b");
        assert_eq!(clean_url_str("/relative/path", false), "/relative/path");
        assert_eq!(clean_url_str("#anchor", false), "#anchor");
        assert_eq!(clean_url_str("MAILTO:a@b.c", false), "MAILTO:a@b.c");
        assert_eq!(clean_url_str("javascript:alert(1)", false), "");
        assert_eq!(clean_url_str("java\tscript:alert(1)", false), "");
        assert_eq!(clean_url_str("data:image/png;base64,AAAA", false), "");
        assert_eq!(clean_url_str("data:image/png;base64,AAAA", true), "data:image/png;base64,AAAA");
        assert_eq!(clean_url_str("data:text/html,<script>", true), "");
        assert_eq!(clean_url_str("1:2", false), "1:2");
        assert_eq!(clean_url(Some(&json!(5)), false), "");
        assert_eq!(clean_url(None, false), "");
    }

    #[test]
    fn sanitizes_nodes_and_steps() {
        let node = json!({ "type": "paragraph", "content": [
            { "type": "text", "text": "x", "marks": [{ "type": "link", "attrs": { "href": "javascript:alert(1)", "target": "_blank" } }] },
            { "type": "image", "attrs": { "src": "data:image/png;base64,AA", "alt": null } },
            { "type": "video", "attrs": { "src": "data:image/png;base64,AA" } },
            { "type": "attachment", "attrs": { "url": 5, "name": "a" } },
        ]});
        let clean = sanitize_node(&node);
        assert_eq!(clean["content"][0]["marks"][0]["attrs"], json!({ "href": "", "target": "_blank" }));
        assert_eq!(clean["content"][1]["attrs"]["src"], "data:image/png;base64,AA");
        assert_eq!(clean["content"][2]["attrs"]["src"], "");
        assert_eq!(clean["content"][3]["attrs"], json!({ "url": "", "name": "a" }));
        let step = json!({ "stepType": "replace", "from": 0, "to": 0, "slice": [
            { "o": "image", "a": { "src": "data:image/png;base64,AA" } }, { "c": 1 },
            { "t": "x", "m": [{ "type": "link", "attrs": { "href": "vbscript:x" } }] },
            { "n": { "type": "embed", "attrs": { "src": "javascript:1" } }, "t": "dropped" },
            {},
        ]});
        let clean = sanitize_step(&step).unwrap();
        assert_eq!(clean["slice"][0]["a"]["src"], "data:image/png;base64,AA");
        assert_eq!(clean["slice"][2]["m"][0]["attrs"]["href"], "");
        assert_eq!(clean["slice"][3], json!({ "n": { "type": "embed", "attrs": { "src": "" } } }));
        assert_eq!(clean["slice"][4], json!({}));
        let mark = sanitize_step(&json!({ "stepType": "addMark", "from": 0, "to": 1, "mark": { "type": "link", "attrs": { "href": "javascript:1" } } })).unwrap();
        assert_eq!(mark["mark"]["attrs"]["href"], "");
        let attr = sanitize_step(&json!({ "stepType": "attr", "pos": 0, "attrs": { "src": "data:image/png;base64,AA" } })).unwrap();
        assert_eq!(attr["attrs"]["src"], "");
        assert!(sanitize_step(&json!({ "stepType": "replace", "from": 0, "to": 0, "slice": [5] })).is_err());
        assert!(sanitize_step(&json!({ "stepType": "replace", "from": 0, "to": 0, "slice": [{ "n": null }] })).is_err());
        assert!(sanitize_step(&json!({ "stepType": "replace", "from": 0, "to": 0, "slice": [{ "t": "x", "m": [null] }] })).is_err());
    }
}
