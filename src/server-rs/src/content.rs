//! Port of `src/server/lib/content.ts`: checks and rewrites of documents.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::common::editor::collab::MAX_DOC_SIZE;
use crate::common::editor::doc_schema::schema;
use crate::common::editor::model::{children, marks, node_type};
use crate::common::editor::sanitize::sanitize_node;
use crate::jsutil::utf16_len;

const MAX_DEPTH: usize = 100;
const MAX_NODES: usize = 200_000;

/// Names every JavaScript object answers `in` for. The original looks types
/// up with `type in nodeSpecs`, so these pass as known types; they are kept
/// passing so both servers accept the same documents.
fn is_inherited_name(name: &str) -> bool {
    matches!(
        name,
        "constructor"
            | "hasOwnProperty"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "toLocaleString"
            | "toString"
            | "valueOf"
            | "__proto__"
            | "__defineGetter__"
            | "__defineSetter__"
            | "__lookupGetter__"
            | "__lookupSetter__"
    )
}

struct Checker<'a> {
    field: &'a str,
    count: usize,
    positions: usize,
}

impl Checker<'_> {
    fn check(&mut self, node: &Value, depth: usize) -> Result<(), String> {
        let field = self.field;
        self.count += 1;
        if self.count > MAX_NODES {
            return Err(format!("{field} is too large"));
        }
        if depth > MAX_DEPTH {
            return Err(format!("{field} is nested too deeply"));
        }
        let Value::Object(n) = node else { return Err(format!("{field} has an invalid node")) };
        let s = schema();
        let ty = match n.get("type") {
            Some(Value::String(ty)) if s.is_known(ty) || is_inherited_name(ty) => ty.as_str(),
            _ => return Err(format!("{field} has an unknown node type")),
        };
        if n.get("attrs").is_some_and(|attrs| !attrs.is_object()) {
            return Err(format!("{field} has invalid attributes"));
        }
        if n.get("text").is_some_and(|text| !text.is_string()) {
            return Err(format!("{field} has invalid text"));
        }
        // Counted like the editor's positions: the root adds none, leaves one, other nodes two.
        if depth > 0 {
            self.positions += if ty == "text" {
                n.get("text").and_then(Value::as_str).map_or(0, utf16_len)
            } else if s.is_leaf(ty) {
                1
            } else {
                2
            };
        }
        if self.positions > MAX_DOC_SIZE {
            return Err(format!("{field} is too large"));
        }
        if let Some(node_marks) = n.get("marks") {
            let Value::Array(node_marks) = node_marks else { return Err(format!("{field} has invalid marks")) };
            for mark in node_marks {
                let known = mark.is_object()
                    && mark.get("type").and_then(Value::as_str).is_some_and(|ty| s.mark_spec(ty).is_some() || is_inherited_name(ty));
                if !known {
                    return Err(format!("{field} has an unknown mark"));
                }
            }
        }
        if let Some(content) = n.get("content") {
            let Value::Array(content) = content else { return Err(format!("{field} has invalid content")) };
            for child in content {
                self.check(child, depth + 1)?;
            }
        }
        Ok(())
    }
}

/// Structural check of an editor document from an untrusted client. The
/// error is the message of the 400 the original answers.
pub fn validate_doc(value: &Value, field: &str, root_type: &str) -> Result<Value, String> {
    Checker { field, count: 0, positions: 0 }.check(value, 0)?;
    if node_type(value) != root_type {
        return Err(format!("{field} must be a {root_type} node"));
    }
    Ok(sanitize_node(value))
}

/// Returns a copy of the tree with `f` applied to every node (children first).
pub fn map_doc(node: &Value, f: &dyn Fn(Value) -> Value) -> Value {
    let mut copy = node.clone();
    if let Some(Value::Array(content)) = node.get("content") {
        let mapped = content.iter().map(|child| map_doc(child, f)).collect();
        if let Some(object) = copy.as_object_mut() {
            object.insert("content".into(), Value::Array(mapped));
        }
    }
    f(copy)
}

pub fn walk_doc<'a>(node: &'a Value, visit: &mut dyn FnMut(&'a Value)) {
    visit(node);
    for child in children(node) {
        walk_doc(child, visit);
    }
}

pub fn strip_comment_marks(doc: &Value) -> Value {
    map_doc(doc, &|mut node| {
        if !marks(&node).iter().any(|m| node_type(m) == "comment") {
            return node;
        }
        let kept: Vec<Value> = marks(&node).iter().filter(|m| node_type(m) != "comment").cloned().collect();
        if let Some(object) = node.as_object_mut() {
            // `{ marks: _, ...rest }`, then `marks` again at the end when any are left.
            object.shift_remove("marks");
            if !kept.is_empty() {
                object.insert("marks".into(), Value::Array(kept));
            }
        }
        node
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileUrl {
    pub file_id: String,
    /// The path after the id, starting with `/`, or empty.
    pub rest: String,
    /// The query string and fragment, or empty.
    pub suffix: String,
}

fn file_url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // Letter cases are spelled out: the `i` flag of `regex` would also fold the long s and the Kelvin sign.
    RE.get_or_init(|| {
        let hex = |n: usize| format!("[0-9a-fA-F]{{{n}}}");
        let line = r"[^\n\r\u{2028}\u{2029}]";
        Regex::new(&format!(
            r"^/[aA][pP][iI]/[fF][iI][lL][eE][sS]/({}-{}-{}-{}-{})(/[^?#]*)?([?#]{line}*)?$",
            hex(8),
            hex(4),
            hex(4),
            hex(4),
            hex(12)
        ))
        .expect("file url pattern")
    })
}

pub fn parse_file_url_str(url: &str) -> Option<FileUrl> {
    let found = file_url_re().captures(url)?;
    Some(FileUrl {
        file_id: found[1].to_lowercase(),
        rest: found.get(2).map_or("", |m| m.as_str()).to_string(),
        suffix: found.get(3).map_or("", |m| m.as_str()).to_string(),
    })
}

pub fn parse_file_url(url: Option<&Value>) -> Option<FileUrl> {
    parse_file_url_str(url?.as_str()?)
}

const URL_ATTRS: [&str; 2] = ["src", "url"];

/// Ids of uploaded files referenced by a document (attachment ids and `/api/files/...` URLs), in order of first appearance.
pub fn file_ids_in_doc(doc: &Value) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let mut add = |id: String| {
        if !ids.contains(&id) {
            ids.push(id);
        }
    };
    walk_doc(doc, &mut |node| {
        let Some(Value::Object(attrs)) = node.get("attrs") else { return };
        if let Some(id) = attrs.get("attachmentId").and_then(Value::as_str).filter(|id| !id.is_empty()) {
            add(id.to_lowercase());
        }
        for key in URL_ATTRS {
            if let Some(parsed) = parse_file_url(attrs.get(key)) {
                add(parsed.file_id);
            }
        }
    });
    ids
}

/// Rewrites file references: `url(parsed, original)` returns the new URL for a
/// `/api/files/...` attribute (or `None` to keep it) and `ids` maps attachment ids.
pub fn rewrite_file_refs(doc: &Value, url: &dyn Fn(&FileUrl, &str) -> Option<String>, ids: Option<&HashMap<String, String>>) -> Value {
    map_doc(doc, &|mut node| {
        let Some(Value::Object(attrs)) = node.get("attrs") else { return node };
        let mut changed: Option<Map<String, Value>> = None;
        for key in URL_ATTRS {
            let Some(original) = attrs.get(key).and_then(Value::as_str) else { continue };
            let Some(parsed) = parse_file_url_str(original) else { continue };
            if let Some(next) = url(&parsed, original).filter(|next| next != original) {
                changed.get_or_insert_with(|| attrs.clone()).insert(key.to_string(), Value::String(next));
            }
        }
        if let (Some(ids), Some(attachment)) = (ids, attrs.get("attachmentId").and_then(Value::as_str)) {
            if let Some(mapped) = ids.get(&attachment.to_lowercase()) {
                changed.get_or_insert_with(|| attrs.clone()).insert("attachmentId".into(), Value::String(mapped.clone()));
            }
        }
        if let (Some(changed), Some(object)) = (changed, node.as_object_mut()) {
            object.insert("attrs".into(), Value::Object(changed));
        }
        node
    })
}

/// Rewrites link mark hrefs with `f` (return `None` to keep the href).
pub fn rewrite_links(doc: &Value, f: &dyn Fn(&str) -> Option<String>) -> Value {
    map_doc(doc, &|mut node| {
        if !marks(&node).iter().any(|m| node_type(m) == "link") {
            return node;
        }
        let mut changed = false;
        let next: Vec<Value> = marks(&node)
            .iter()
            .map(|mark| {
                let href = mark.get("attrs").and_then(|a| a.get("href")).and_then(Value::as_str);
                match href.filter(|_| node_type(mark) == "link").and_then(|href| f(href).filter(|next| next != href)) {
                    Some(next) => {
                        changed = true;
                        let mut mark = mark.clone();
                        mark["attrs"]["href"] = Value::String(next);
                        mark
                    }
                    None => mark.clone(),
                }
            })
            .collect();
        if changed {
            if let Some(object) = node.as_object_mut() {
                object.insert("marks".into(), Value::Array(next));
            }
        }
        node
    })
}

/// Public-share view of a document: no comment marks, file URLs authorized by the share key.
pub fn public_doc(doc: Option<&Value>, share_key: &str) -> Option<Value> {
    // `if (!doc) return doc`
    let doc = doc.filter(|d| !d.is_null())?;
    Some(rewrite_file_refs(
        &strip_comment_marks(doc),
        &|parsed, _original| {
            let (query, hash) = match parsed.suffix.find('#') {
                Some(at) => parsed.suffix.split_at(at),
                None => (parsed.suffix.as_str(), ""),
            };
            let joiner = if query.is_empty() { "?".to_string() } else { format!("{query}&") };
            Some(format!("/api/files/{}{}{joiner}share={share_key}{hash}", parsed.file_id, parsed.rest))
        },
        None,
    ))
}

/// Every `transclusionSource` block of a document: its id and its content.
/// A repeated id keeps its first place and its last content.
pub fn synced_blocks_of(doc: &Value) -> Vec<(String, Vec<Value>)> {
    let mut blocks: Vec<(String, Vec<Value>)> = Vec::new();
    walk_doc(doc, &mut |node| {
        if node_type(node) != "transclusionSource" {
            return;
        }
        let Some(id) = node.get("attrs").and_then(|a| a.get("id")).and_then(Value::as_str) else { return };
        if id.is_empty() || utf16_len(id) > 100 {
            return;
        }
        let content = children(node).to_vec();
        match blocks.iter_mut().find(|(block_id, _)| block_id == id) {
            Some(existing) => existing.1 = content,
            None => blocks.push((id.to_string(), content)),
        }
    });
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(value: Value) -> String {
        validate_doc(&value, "content", "doc").unwrap_err()
    }

    #[test]
    fn validates_structure() {
        assert!(validate_doc(&json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "a", "marks": [{ "type": "bold" }] }] }] }), "content", "doc").is_ok());
        assert_eq!(message(json!(5)), "content has an invalid node");
        assert_eq!(message(json!([])), "content has an invalid node");
        assert_eq!(message(json!({ "type": "nope" })), "content has an unknown node type");
        assert_eq!(message(json!({ "type": 5 })), "content has an unknown node type");
        assert_eq!(message(json!({ "type": "doc", "attrs": [] })), "content has invalid attributes");
        assert_eq!(message(json!({ "type": "doc", "attrs": null })), "content has invalid attributes");
        assert_eq!(message(json!({ "type": "doc", "text": 5 })), "content has invalid text");
        assert_eq!(message(json!({ "type": "doc", "marks": {} })), "content has invalid marks");
        assert_eq!(message(json!({ "type": "doc", "marks": [{ "type": "blink" }] })), "content has an unknown mark");
        assert_eq!(message(json!({ "type": "doc", "marks": [null] })), "content has an unknown mark");
        assert_eq!(message(json!({ "type": "doc", "content": {} })), "content has invalid content");
        assert_eq!(message(json!({ "type": "paragraph" })), "content must be a doc node");
        assert_eq!(validate_doc(&json!({ "type": "doc" }), "body", "paragraph").unwrap_err(), "body must be a paragraph node");
        let mut deep = json!({ "type": "paragraph" });
        for _ in 0..101 {
            deep = json!({ "type": "blockquote", "content": [deep] });
        }
        assert_eq!(message(json!({ "type": "doc", "content": [deep] })), "content is nested too deeply");
        assert!(validate_doc(&json!({ "type": "doc", "content": [{ "type": "toString" }] }), "content", "doc").is_ok());
    }

    #[test]
    fn rewrites_file_references() {
        let id = "0123abcd-89ef-4567-89ab-0123456789ab";
        assert_eq!(parse_file_url_str(&format!("/API/Files/{}/a%20b.png?x=1#h", id.to_uppercase())), Some(FileUrl { file_id: id.into(), rest: "/a%20b.png".into(), suffix: "?x=1#h".into() }));
        assert_eq!(parse_file_url_str(&format!("/api/files/{id}")).map(|p| p.rest), Some(String::new()));
        assert!(parse_file_url_str(&format!("https://x/api/files/{id}/a")).is_none());
        assert!(parse_file_url_str(&format!("/api/files/{id}/a?x\ny")).is_none());
        let doc = json!({ "type": "doc", "content": [
            { "type": "image", "attrs": { "src": format!("/api/files/{id}/a.png"), "attachmentId": id.to_uppercase() } },
            { "type": "attachment", "attrs": { "url": format!("/api/files/{id}/b.pdf?v=2#p" ) } },
            { "type": "paragraph", "content": [{ "type": "text", "text": "x", "marks": [{ "type": "comment", "attrs": { "commentId": "c" } }, { "type": "bold" }] }] },
        ]});
        assert_eq!(file_ids_in_doc(&doc), vec![id.to_string()]);
        let public = public_doc(Some(&doc), "key1").unwrap();
        assert_eq!(public["content"][0]["attrs"]["src"], format!("/api/files/{id}/a.png?share=key1"));
        assert_eq!(public["content"][1]["attrs"]["url"], format!("/api/files/{id}/b.pdf?v=2&share=key1#p"));
        assert_eq!(public["content"][2]["content"][0]["marks"], json!([{ "type": "bold" }]));
        assert_eq!(public_doc(None, "k"), None);
        let mut ids = HashMap::new();
        ids.insert(id.to_string(), "new".to_string());
        let copied = rewrite_file_refs(&doc, &|_, _| None, Some(&ids));
        assert_eq!(copied["content"][0]["attrs"]["attachmentId"], "new");
        let links = rewrite_links(&json!({ "type": "text", "text": "x", "marks": [{ "type": "link", "attrs": { "href": "/a" } }] }), &|href| Some(format!("{href}!")));
        assert_eq!(links["marks"][0]["attrs"]["href"], "/a!");
    }

    #[test]
    fn collects_synced_blocks() {
        let doc = json!({ "type": "doc", "content": [
            { "type": "transclusionSource", "attrs": { "id": "a" }, "content": [{ "type": "paragraph" }] },
            { "type": "transclusionSource", "attrs": { "id": "" } },
            { "type": "transclusionSource", "attrs": { "id": "a" } },
            { "type": "transclusionSource", "attrs": { "id": "b" }, "content": [] },
        ]});
        assert_eq!(synced_blocks_of(&doc), vec![("a".to_string(), vec![]), ("b".to_string(), vec![])]);
    }
}
