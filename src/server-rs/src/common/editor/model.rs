//! Port of `src/common/editor/model.ts`.
//!
//! A document is a plain JSON tree and stays one here: a node is a
//! `serde_json::Value` object with `type` and, optionally, `attrs`, `content`,
//! `marks` and `text`. Keys the editor does not know are carried along
//! untouched, as they are in the TypeScript implementation.

use serde_json::{Map, Value};

use crate::jsutil::number_value;

pub type Node = Value;
pub type Mark = Value;
pub type Attrs = Map<String, Value>;

/// `node.type`, or `""` when it is missing or not a string.
pub fn node_type(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or("")
}

/// `node.content ?? []`.
pub fn children(node: &Value) -> &[Value] {
    node.get("content").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `node.marks ?? []`.
pub fn marks(node: &Value) -> &[Value] {
    node.get("marks").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `node.attrs`, when it is an object.
pub fn attrs(node: &Value) -> Option<&Attrs> {
    node.get("attrs").and_then(Value::as_object)
}

/// `node.attrs?.[key]`; a JSON null reads as present.
pub fn attr<'a>(node: &'a Value, key: &str) -> Option<&'a Value> {
    attrs(node).and_then(|a| a.get(key))
}

/// `node.text ?? ""`.
pub fn text(node: &Value) -> &str {
    node.get("text").and_then(Value::as_str).unwrap_or("")
}

pub fn is_text(node: &Value) -> bool {
    node_type(node) == "text"
}

/// `sameValue`: deep equality where numbers compare by value.
pub fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => number_value(x) == number_value(y),
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_value(p, q)),
        // Keys are compared through `a`'s only, as the original does: with the
        // same number of keys, every key of `a` present in `b` means equal sets.
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(key, value)| y.get(key).is_some_and(|other| same_value(value, other)))
        }
        _ => false,
    }
}

/// `sameAttrs(a, b)`: missing attrs equal empty ones.
pub fn same_attrs(a: Option<&Value>, b: Option<&Value>) -> bool {
    let empty = Value::Object(Map::new());
    same_value(a.unwrap_or(&empty), b.unwrap_or(&empty))
}

pub fn same_mark(a: &Value, b: &Value) -> bool {
    node_type(a) == node_type(b) && same_attrs(a.get("attrs"), b.get("attrs"))
}

pub fn same_marks(a: &[Value], b: &[Value]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same_mark(x, y))
}

pub fn has_mark(marks: &[Value], mark: &Value) -> bool {
    marks.iter().any(|m| same_mark(m, mark))
}

pub fn has_mark_type(marks: &[Value], mark_type: &str) -> bool {
    marks.iter().any(|m| node_type(m) == mark_type)
}

/// `textContent(node)`: the text of every text node below it, concatenated.
pub fn text_content(node: &Value) -> String {
    if let Some(text) = node.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    children(node).iter().map(text_content).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compares_values_deeply() {
        assert!(same_value(&json!({"a": [1, {"b": null}]}), &json!({"a": [1.0, {"b": null}]})));
        assert!(!same_value(&json!({"a": 1}), &json!({"a": 1, "b": 2})));
        assert!(!same_value(&json!([]), &json!({})));
        assert!(!same_value(&json!(null), &json!({})));
        assert!(same_attrs(None, Some(&json!({}))));
        assert!(same_marks(&[json!({"type": "bold"})], &[json!({"type": "bold", "attrs": {}})]));
        assert!(!same_mark(&json!({"type": "link", "attrs": {"href": "a"}}), &json!({"type": "link", "attrs": {"href": "b"}})));
    }

    #[test]
    fn reads_text_content() {
        let node = json!({"type": "paragraph", "content": [{"type": "text", "text": "a"}, {"type": "mention"}, {"type": "text", "text": "b"}]});
        assert_eq!(text_content(&node), "ab");
    }
}
