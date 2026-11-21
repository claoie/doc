//! Port of `src/common/editor/tokens.ts`.
//!
//! Documents are addressed by integer positions over a flat token view of the
//! tree: entering or leaving a non-leaf node costs one position, each UTF-16
//! code unit of text costs one, and each leaf node costs one. Position 0 is
//! the start of the document's content.
//!
//! Edits are expressed as splices of that token stream, so one primitive
//! covers typing, deleting, splitting and joining blocks. The splice is
//! applied to the smallest subtree that stays balanced, so an edit inside a
//! paragraph only re-tokenizes that paragraph.
//!
//! `descendants` and `textBetween` serve the browser only and are not ported.

use std::sync::Arc;

use serde_json::{Map, Value};

use super::doc_schema::schema;
use super::model::{children, node_type, same_marks};
use super::steps::StepError;
use crate::jsutil::{js_truthy, utf16_len};

/// The marks of a run of tokens, shared rather than copied per code unit.
pub type Marks = Option<Arc<Vec<Value>>>;

#[derive(Debug, Clone)]
pub enum Token {
    Open { node_type: Value, attrs: Option<Value>, marks: Marks },
    Close,
    /// One UTF-16 code unit of text.
    Char { unit: u16, marks: Marks, parent: Arc<str> },
    Leaf { node: Value, parent: Arc<str> },
}

fn marks_slice(marks: &Marks) -> &[Value] {
    marks.as_ref().map_or(&[], |m| m.as_slice())
}

/// `node.marks?.length ? node.marks : undefined`.
fn node_marks(node: &Value) -> Marks {
    match node.get("marks") {
        Some(Value::Array(marks)) if !marks.is_empty() => Some(Arc::new(marks.clone())),
        _ => None,
    }
}

/// `node.text?.length ?? 0` for text, 1 for a leaf, 2 plus the content otherwise.
pub fn node_size(node: &Value) -> usize {
    let ty = node_type(node);
    if ty == "text" {
        return node.get("text").and_then(Value::as_str).map_or(0, utf16_len);
    }
    if schema().is_leaf(ty) {
        return 1;
    }
    2 + content_size(node)
}

pub fn content_size(node: &Value) -> usize {
    children(node).iter().map(node_size).sum()
}

pub fn flatten(nodes: &[Value], parent: &Arc<str>, out: &mut Vec<Token>) {
    for node in nodes {
        let ty = node_type(node);
        if ty == "text" {
            let marks = node_marks(node);
            for unit in crate::jsutil::utf16_units(node.get("text").and_then(Value::as_str).unwrap_or("")) {
                out.push(Token::Char { unit, marks: marks.clone(), parent: parent.clone() });
            }
        } else if schema().is_leaf(ty) {
            out.push(Token::Leaf { node: node.clone(), parent: parent.clone() });
        } else {
            out.push(Token::Open {
                node_type: node.get("type").cloned().unwrap_or(Value::Null),
                attrs: node.get("attrs").filter(|a| js_truthy(a)).cloned(),
                marks: node_marks(node),
            });
            flatten(children(node), &Arc::from(ty), out);
            out.push(Token::Close);
        }
    }
}

/// Text is rebuilt from UTF-16 units. An edit may have cut a surrogate pair
/// in two, which JavaScript keeps as lone surrogates and Postgres then
/// refuses to store; here such an edit is refused instead.
fn units_to_string(units: &[u16]) -> Result<String, StepError> {
    String::from_utf16(units).map_err(|_| StepError::Invalid("An edit may not split a surrogate pair".into()))
}

fn text_node(text: String, marks: &Marks) -> Value {
    let mut node = Map::new();
    node.insert("type".into(), Value::String("text".into()));
    node.insert("text".into(), Value::String(text));
    if let Some(marks) = marks.as_ref().filter(|m| !m.is_empty()) {
        node.insert("marks".into(), Value::Array(marks.as_ref().clone()));
    }
    Value::Object(node)
}

fn push_text(into: &mut Vec<Value>, text: String, marks: &Marks) {
    if let Some(last) = into.last_mut() {
        if last.is_object() && node_type(last) == "text" && same_marks(super::model::marks(last), marks_slice(marks)) {
            let joined = format!("{}{}", last.get("text").and_then(Value::as_str).unwrap_or(""), text);
            last.as_object_mut().expect("object").insert("text".into(), Value::String(joined));
            return;
        }
    }
    into.push(text_node(text, marks));
}

/// How deep a document may be nested: the limit `validate_doc` puts on a
/// document that arrives whole.
pub const MAX_DOC_DEPTH: usize = 100;

/// Rebuilds nodes from tokens; `Ok(None)` when the tokens are not balanced.
/// `base_depth` is the depth of the node the tokens are the content of (0 for
/// the document itself).
///
/// The slice of a step is a flat list, so one message could open tens of
/// thousands of nodes inside each other, and everything that then walks the
/// tree would run out of stack. JavaScript catches that (`RangeError`) and
/// refuses the step; here the process would die. So nesting past
/// `MAX_DOC_DEPTH` is refused while the tree is still a list.
pub fn build(tokens: &[Token], base_depth: usize) -> Result<Option<Vec<Value>>, StepError> {
    struct Frame {
        node: Map<String, Value>,
        content: Vec<Value>,
    }
    let mut root: Vec<Value> = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();
    let mut run: Vec<u16> = Vec::new();
    let mut run_marks: Marks = None;

    fn flush(run: &mut Vec<u16>, run_marks: &mut Marks, into: &mut Vec<Value>) -> Result<(), StepError> {
        if !run.is_empty() {
            push_text(into, units_to_string(run)?, run_marks);
        }
        run.clear();
        *run_marks = None;
        Ok(())
    }

    for token in tokens {
        if let Token::Char { unit, marks, .. } = token {
            if !run.is_empty() && !same_marks(marks_slice(&run_marks), marks_slice(marks)) {
                let into = stack.last_mut().map_or(&mut root, |frame| &mut frame.content);
                flush(&mut run, &mut run_marks, into)?;
            }
            if run.is_empty() {
                run_marks = marks.clone();
            }
            run.push(*unit);
            continue;
        }
        {
            let into = stack.last_mut().map_or(&mut root, |frame| &mut frame.content);
            flush(&mut run, &mut run_marks, into)?;
        }
        match token {
            Token::Leaf { node, .. } => stack.last_mut().map_or(&mut root, |frame| &mut frame.content).push(node.clone()),
            Token::Open { node_type, attrs, marks } => {
                if base_depth + 1 + stack.len() > MAX_DOC_DEPTH {
                    return Err(StepError::Invalid("The document would be nested too deeply".into()));
                }
                let mut node = Map::new();
                node.insert("type".into(), node_type.clone());
                if let Some(attrs) = attrs {
                    node.insert("attrs".into(), attrs.clone());
                }
                if let Some(marks) = marks.as_ref().filter(|m| !m.is_empty()) {
                    node.insert("marks".into(), Value::Array(marks.as_ref().clone()));
                }
                stack.push(Frame { node, content: Vec::new() });
            }
            Token::Close => {
                let Some(mut top) = stack.pop() else { return Ok(None) };
                top.node.insert("content".into(), Value::Array(top.content));
                stack.last_mut().map_or(&mut root, |frame| &mut frame.content).push(Value::Object(top.node));
            }
            Token::Char { .. } => unreachable!("handled above"),
        }
    }
    {
        let into = stack.last_mut().map_or(&mut root, |frame| &mut frame.content);
        flush(&mut run, &mut run_marks, into)?;
    }
    if !stack.is_empty() {
        return Ok(None);
    }
    Ok(Some(root))
}

/// The serializable form of a token run, as steps carry it over the wire:
/// `{ o, a?, m? }` opens a node, `{ c: 1 }` closes one, `{ t, m? }` is text
/// and `{ n }` a leaf node.
pub fn to_items(tokens: &[Token]) -> Vec<Value> {
    let mut items: Vec<Value> = Vec::new();
    let mut run: Vec<u16> = Vec::new();
    let mut run_marks: Marks = None;
    fn flush(run: &mut Vec<u16>, run_marks: &Marks, items: &mut Vec<Value>) {
        if run.is_empty() {
            return;
        }
        let mut item = Map::new();
        item.insert("t".into(), Value::String(crate::jsutil::from_utf16_units(run)));
        if let Some(marks) = run_marks.as_ref().filter(|m| !m.is_empty()) {
            item.insert("m".into(), Value::Array(marks.as_ref().clone()));
        }
        items.push(Value::Object(item));
        run.clear();
    }
    for token in tokens {
        match token {
            Token::Char { unit, marks, .. } => {
                if !run.is_empty() && !same_marks(marks_slice(&run_marks), marks_slice(marks)) {
                    flush(&mut run, &run_marks, &mut items);
                }
                if run.is_empty() {
                    run_marks = marks.clone();
                }
                run.push(*unit);
            }
            Token::Leaf { node, .. } => {
                flush(&mut run, &run_marks, &mut items);
                let mut item = Map::new();
                item.insert("n".into(), node.clone());
                items.push(Value::Object(item));
            }
            Token::Open { node_type, attrs, marks } => {
                flush(&mut run, &run_marks, &mut items);
                let mut item = Map::new();
                item.insert("o".into(), node_type.clone());
                if let Some(attrs) = attrs {
                    item.insert("a".into(), attrs.clone());
                }
                if let Some(marks) = marks.as_ref().filter(|m| !m.is_empty()) {
                    item.insert("m".into(), Value::Array(marks.as_ref().clone()));
                }
                items.push(Value::Object(item));
            }
            Token::Close => {
                flush(&mut run, &run_marks, &mut items);
                let mut item = Map::new();
                item.insert("c".into(), Value::from(1));
                items.push(Value::Object(item));
            }
        }
    }
    flush(&mut run, &run_marks, &mut items);
    items
}

/// `item.m` as marks: an array with members, or nothing.
fn item_marks(item: &Map<String, Value>) -> Marks {
    match item.get("m") {
        Some(Value::Array(marks)) if !marks.is_empty() => Some(Arc::new(marks.clone())),
        _ => None,
    }
}

/// Expands slice items into tokens; `parent` is a placeholder resolved on build.
///
/// Items come straight from a client. Where the TypeScript would fail with a
/// `TypeError` (an item that is not an object, text that is not a string) the
/// error is `Malformed`, which callers treat as that exception: nothing is
/// answered. An object without `t`, `n` or `o` closes a node, whatever it holds.
pub fn from_items(items: &[Value]) -> Result<Vec<Token>, StepError> {
    let placeholder: Arc<str> = Arc::from("");
    let mut tokens = Vec::new();
    for item in items {
        let item = match item {
            Value::Object(item) => item,
            // `"t" in []` is false three times over: an array closes a node.
            Value::Array(_) => {
                tokens.push(Token::Close);
                continue;
            }
            _ => return Err(StepError::Malformed("a slice item is not an object".into())),
        };
        if let Some(text) = item.get("t") {
            let Value::String(text) = text else { return Err(StepError::Malformed("slice text is not a string".into())) };
            let marks = item_marks(item);
            for unit in crate::jsutil::utf16_units(text) {
                tokens.push(Token::Char { unit, marks: marks.clone(), parent: placeholder.clone() });
            }
        } else if let Some(node) = item.get("n") {
            tokens.push(Token::Leaf { node: node.clone(), parent: placeholder.clone() });
        } else if let Some(node_type) = item.get("o") {
            tokens.push(Token::Open { node_type: node_type.clone(), attrs: item.get("a").filter(|a| js_truthy(a)).cloned(), marks: item_marks(item) });
        } else {
            tokens.push(Token::Close);
        }
    }
    Ok(tokens)
}

/// Slice items for a list of whole nodes.
pub fn nodes_to_items(nodes: &[Value]) -> Vec<Value> {
    let mut tokens = Vec::new();
    flatten(nodes, &Arc::from(""), &mut tokens);
    to_items(&tokens)
}

pub struct ResolvedPos<'a> {
    pub pos: usize,
    /// Depth of the innermost node whose content contains `pos` (0 = doc).
    pub depth: usize,
    /// `nodes[d]` is the ancestor at depth d; `nodes[depth]` is the parent.
    pub nodes: Vec<&'a Value>,
    /// Position where `nodes[d]`'s content starts.
    pub starts: Vec<usize>,
    /// Index of the child of `nodes[d]` at or after the position.
    pub indices: Vec<usize>,
    /// Offset into the text node at `indices[depth]`, when `pos` falls inside one.
    pub text_offset: usize,
}

/// Resolves a position; out of range is the `RangeError` of the original.
pub fn resolve(doc: &Value, pos: usize) -> Result<ResolvedPos<'_>, StepError> {
    let total = content_size(doc);
    if pos > total {
        return Err(StepError::Invalid(format!("Position {pos} out of range 0..{total}")));
    }
    let mut nodes = vec![doc];
    let mut starts = vec![0usize];
    let mut indices = Vec::new();
    let mut node = doc;
    let mut start = 0usize;
    let mut text_offset = 0usize;
    loop {
        let kids = children(node);
        let mut offset = start;
        let mut index = 0;
        let mut descend = None;
        while index < kids.len() {
            let child = &kids[index];
            let end = offset + node_size(child);
            if pos < end {
                let ty = node_type(child);
                if ty == "text" {
                    text_offset = pos - offset;
                } else if pos > offset && !schema().is_leaf(ty) {
                    descend = Some(child);
                    start = offset + 1;
                }
                break;
            }
            offset = end;
            index += 1;
        }
        indices.push(index);
        let Some(next) = descend else { break };
        node = next;
        nodes.push(node);
        starts.push(start);
    }
    Ok(ResolvedPos { pos, depth: nodes.len() - 1, nodes, starts, indices, text_offset })
}

/// The child offsets of a node's content, relative to its content start.
pub fn child_offsets(node: &Value) -> Vec<usize> {
    let kids = children(node);
    let mut offsets = Vec::with_capacity(kids.len() + 1);
    let mut offset = 0;
    for child in kids {
        offsets.push(offset);
        offset += node_size(child);
    }
    offsets.push(offset);
    offsets
}

/// The path (child indices from the document down) of the node that starts
/// exactly at `pos`, or `None` when there is none.
pub fn node_at(doc: &Value, pos: usize) -> Result<Option<Vec<usize>>, StepError> {
    let resolved = resolve(doc, pos)?;
    if resolved.text_offset != 0 {
        return Ok(None);
    }
    let parent = resolved.nodes[resolved.depth];
    let index = resolved.indices[resolved.depth];
    match children(parent).get(index) {
        // `if (!node) return null`: a JSON null in the content counts as nothing there.
        Some(node) if js_truthy(node) => Ok(Some(resolved.indices.clone())),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc() -> Value {
        json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "a😀" }, { "type": "hardBreak" }, { "type": "text", "text": "b", "marks": [{ "type": "bold" }] }] },
            { "type": "horizontalRule" },
            { "type": "blockquote", "content": [{ "type": "paragraph", "content": [] }] },
        ]})
    }

    #[test]
    fn sizes_count_utf16_units() {
        let d = doc();
        assert_eq!(node_size(&d["content"][0]), 7);
        assert_eq!(content_size(&d), 7 + 1 + 4);
        assert_eq!(child_offsets(&d), vec![0, 7, 8, 12]);
    }

    #[test]
    fn tokens_round_trip() {
        let d = doc();
        let mut tokens = Vec::new();
        flatten(children(&d), &Arc::from("doc"), &mut tokens);
        assert_eq!(tokens.len(), content_size(&d));
        let built = build(&tokens, 0).unwrap().unwrap();
        assert_eq!(Value::Array(built), d["content"]);
        let items = nodes_to_items(children(&d));
        assert_eq!(items[0], json!({ "o": "paragraph" }));
        assert_eq!(items[1], json!({ "t": "a😀" }));
        assert_eq!(items[2], json!({ "n": { "type": "hardBreak" } }));
        assert_eq!(items[3], json!({ "t": "b", "m": [{ "type": "bold" }] }));
        assert_eq!(items[4], json!({ "c": 1 }));
        let again = build(&from_items(&items).unwrap(), 0).unwrap().unwrap();
        assert_eq!(Value::Array(again), d["content"]);
    }

    #[test]
    fn resolves_positions() {
        let d = doc();
        let at = |pos| resolve(&d, pos).unwrap();
        assert_eq!((at(0).depth, at(0).indices.clone()), (0, vec![0]));
        let inside = at(3);
        assert_eq!((inside.depth, inside.indices.clone(), inside.text_offset, inside.starts.clone()), (1, vec![0, 0], 2, vec![0, 1]));
        assert_eq!(at(7).indices, vec![1]);
        assert_eq!(at(10).indices, vec![2, 0, 0]);
        assert!(resolve(&d, 13).is_err());
        assert_eq!(node_at(&d, 7).unwrap(), Some(vec![1]));
        assert_eq!(node_at(&d, 2).unwrap(), None);
        assert_eq!(node_at(&d, 12).unwrap(), None);
    }

    #[test]
    fn nesting_past_the_limit_does_not_build() {
        let nested = |depth: usize| {
            let mut tokens: Vec<Token> = (0..depth).map(|_| Token::Open { node_type: json!("blockquote"), attrs: None, marks: None }).collect();
            tokens.extend((0..depth).map(|_| Token::Close));
            tokens
        };
        assert!(build(&nested(MAX_DOC_DEPTH), 0).unwrap().is_some());
        assert!(matches!(build(&nested(MAX_DOC_DEPTH + 1), 0), Err(StepError::Invalid(_))));
        // Inside a node that is itself one level down, one level less fits.
        assert!(matches!(build(&nested(MAX_DOC_DEPTH), 1), Err(StepError::Invalid(_))));
        // Deep enough to run out of stack if the tree were built and walked.
        assert!(matches!(build(&nested(200_000), 0), Err(StepError::Invalid(_))));
    }

    #[test]
    fn unbalanced_tokens_do_not_build() {
        assert!(build(&[Token::Close], 0).unwrap().is_none());
        assert!(build(&[Token::Open { node_type: json!("paragraph"), attrs: None, marks: None }], 0).unwrap().is_none());
        let lone = [Token::Char { unit: 0xD83D, marks: None, parent: Arc::from("") }];
        assert!(matches!(build(&lone, 0), Err(StepError::Invalid(_))));
        assert!(matches!(from_items(&[json!(5)]), Err(StepError::Malformed(_))));
        assert!(matches!(from_items(&[json!({ "t": 5 })]), Err(StepError::Malformed(_))));
        assert_eq!(from_items(&[json!({}), json!([])]).unwrap().len(), 2);
    }
}
