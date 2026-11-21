//! Port of `src/common/editor/steps.ts`, as far as the server needs it.
//!
//! Steps are the unit of change. Every edit — local or remote — is a list of
//! steps; they are plain JSON so they travel over the wire:
//!
//! - `{ stepType: "replace", from, to, slice }`
//! - `{ stepType: "replaceAround", from, to, gapFrom, gapTo, slice, insert }`:
//!   replaces `[from, to)` but keeps `[gapFrom, gapTo)` in place, inserted at
//!   position `insert` of the slice (wrapping, unwrapping and retyping blocks
//!   without touching their content)
//! - `{ stepType: "addMark" | "removeMark", from, to, mark }`
//! - `{ stepType: "attr", pos, attrs }`
//!
//! The server only applies steps. Their inverses, `StepMap`, `Mapping` and
//! `mapStep` serve the browser's undo history and rebasing and are not ported.

use std::sync::Arc;

use serde_json::Value;

use super::doc_schema::schema;
use super::model::{children, marks as node_marks, node_type, same_mark, same_marks};
use super::tokens::{build, child_offsets, flatten, from_items, node_at, resolve, Marks, Token};
use crate::jsutil::{is_integer, js_number, js_truthy};

#[derive(Debug, Clone, PartialEq)]
pub enum StepError {
    /// The step does not fit the document: a `StepError` or `RangeError` in
    /// the original, which the authority answers as a rejection.
    Invalid(String),
    /// The step is not shaped like one: where the original fails with some
    /// other exception (a `TypeError`), which nothing answers.
    Malformed(String),
}

impl std::fmt::Display for StepError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StepError::Invalid(message) | StepError::Malformed(message) => write!(f, "{message}"),
        }
    }
}

/// `isStep` of `server/realtime/collab.ts`: the shape check a step from a client must pass.
pub fn is_step(value: &Value) -> bool {
    let Value::Object(step) = value else { return false };
    let num = |key: &str| step.get(key).is_some_and(|v| v.is_number() && is_integer(v) && js_number(v) >= 0.0);
    match step.get("stepType").and_then(Value::as_str) {
        Some("replace") => num("from") && num("to") && step.get("slice").is_some_and(Value::is_array),
        Some("replaceAround") => {
            num("from") && num("to") && num("gapFrom") && num("gapTo") && num("insert") && step.get("slice").is_some_and(Value::is_array)
        }
        Some("addMark" | "removeMark") => {
            num("from") && num("to") && step.get("mark").is_some_and(|mark| mark.get("type").is_some_and(Value::is_string))
        }
        Some("attr") => num("pos") && step.get("attrs").is_some_and(|attrs| attrs.is_object() || attrs.is_array()),
        _ => false,
    }
}

/// A position of a step. Positions past any document (a client may send
/// `1e300`) saturate, and then fail as out of range like any other.
fn position(step: &Value, key: &str) -> Result<usize, StepError> {
    match step.get(key) {
        Some(value) if value.is_number() && is_integer(value) && js_number(value) >= 0.0 => Ok(js_number(value) as usize),
        _ => Err(StepError::Malformed(format!("the step has no position {key}"))),
    }
}

fn slice(step: &Value) -> Result<&[Value], StepError> {
    step.get("slice").and_then(Value::as_array).map(Vec::as_slice).ok_or_else(|| StepError::Malformed("the step has no slice".into()))
}

pub fn add_to_mark_set(marks: &[Value], mark: &Value) -> Vec<Value> {
    let s = schema();
    let mark_type = node_type(mark);
    let stackable = s.mark_spec(mark_type).is_some_and(|spec| spec.stackable);
    let mut next: Vec<Value> = marks.iter().filter(|m| if stackable { !same_mark(m, mark) } else { node_type(m) != mark_type }).cloned().collect();
    next.push(mark.clone());
    // A stable sort, as `Array.prototype.sort` is.
    next.sort_by_key(|m| s.mark_rank(node_type(m)));
    next
}

pub fn remove_from_mark_set(marks: &[Value], mark: &Value) -> Vec<Value> {
    marks.iter().filter(|m| !same_mark(m, mark)).cloned().collect()
}

fn node_at_path<'a>(doc: &'a Value, path: &[usize]) -> &'a Value {
    path.iter().fold(doc, |node, index| &children(node)[*index])
}

fn node_at_path_mut<'a>(doc: &'a mut Value, path: &[usize]) -> &'a mut Value {
    path.iter().fold(doc, |node, index| &mut node["content"][*index])
}

/// Joins text nodes that became neighbours at the two edges of an edit.
fn merge_seams(children: &mut Vec<Value>, seams: [usize; 2]) {
    // Higher seam first, so the lower one keeps its index.
    for seam in seams {
        if seam == 0 || seam >= children.len() {
            continue;
        }
        let (left, right) = (&children[seam - 1], &children[seam]);
        if !left.is_object() || !right.is_object() || node_type(left) != "text" || node_type(right) != "text" {
            continue;
        }
        if !same_marks(node_marks(left), node_marks(right)) {
            continue;
        }
        let text = |node: &Value| node.get("text").and_then(Value::as_str).unwrap_or("").to_string();
        let joined = format!("{}{}", text(left), text(right));
        children.remove(seam);
        children[seam - 1].as_object_mut().expect("object").insert("text".into(), Value::String(joined));
    }
}

/// Splices the token stream in `[from, to)` with `make(segment, a, b)`,
/// operating on the smallest balanced subtree. On an error the document is
/// left in an unspecified state: callers work on a copy they then discard.
fn splice(doc: &mut Value, from: usize, to: usize, make: &mut dyn FnMut(Vec<Token>, usize, usize) -> Result<Vec<Token>, StepError>) -> Result<(), StepError> {
    if from > to {
        return Err(StepError::Invalid(format!("Invalid range {from}..{to}")));
    }
    let (from_indices, from_starts, from_depth) = {
        let resolved = resolve(doc, from)?;
        (resolved.indices, resolved.starts, resolved.depth)
    };
    let (to_indices, to_depth) = {
        let resolved = resolve(doc, to)?;
        (resolved.indices, resolved.depth)
    };
    // The two positions share an ancestor as long as they went down the same children.
    let mut shared = 0;
    while shared < from_depth && shared < to_depth && from_indices[shared] == to_indices[shared] {
        shared += 1;
    }
    let s = schema();
    for d in (0..=shared).rev() {
        let path = &from_indices[..d];
        let (i, j, replaced, container_type) = {
            let container = node_at_path(doc, path);
            let start = from_starts[d];
            let kids = children(container);
            let offsets = child_offsets(container);
            let (local_from, local_to) = (from - start, to - start);
            let mut i = 0;
            while i < kids.len() && offsets[i + 1] <= local_from {
                i += 1;
            }
            let mut j = i;
            while j < kids.len() && offsets[j] < local_to {
                j += 1;
            }
            let seg_start = offsets[i];
            let container_type: Arc<str> = Arc::from(node_type(container));
            let mut segment = Vec::new();
            flatten(&kids[i..j], &container_type, &mut segment);
            let replaced = make(segment, local_from - seg_start, local_to - seg_start)?;
            (i, j, replaced, container_type)
        };
        let Some(built) = build(&replaced, d)? else { continue };
        // Reading the type of a child that is `null` is where the original throws.
        if built.iter().any(Value::is_null) {
            return Err(StepError::Malformed("a slice holds an empty node".into()));
        }
        let container = node_at_path_mut(doc, path);
        let Some(object) = container.as_object_mut() else { return Err(StepError::Invalid("Unbalanced edit".into())) };
        let mut merged = match object.remove("content") {
            Some(Value::Array(content)) => content,
            _ => Vec::new(),
        };
        let count = built.len();
        merged.splice(i..j, built.iter().cloned());
        merge_seams(&mut merged, [i + count, i]);
        let valid = s.valid_content(&container_type, &merged);
        // `{ ...container, content: merged }`: an existing key keeps its place.
        object.insert("content".into(), Value::Array(merged));
        if !valid {
            return Err(StepError::Invalid(format!("Invalid content for {container_type}")));
        }
        for node in &built {
            if s.check(node).is_some() {
                return Err(StepError::Invalid(format!("Invalid {} after edit", node_type(node))));
            }
            for mark in node_marks(node) {
                if !s.allows_mark(&container_type, node_type(mark)) {
                    return Err(StepError::Invalid(format!("Mark {} not allowed in {container_type}", node_type(mark))));
                }
            }
        }
        return Ok(());
    }
    Err(StepError::Invalid(format!("Unbalanced edit at {from}..{to}")))
}

fn apply_replace(doc: &mut Value, step: &Value) -> Result<(), StepError> {
    let inserted = from_items(slice(step)?)?;
    splice(doc, position(step, "from")?, position(step, "to")?, &mut |segment, a, b| {
        let mut out = Vec::with_capacity(segment.len() + inserted.len());
        out.extend_from_slice(&segment[..a]);
        out.extend(inserted.iter().cloned());
        out.extend_from_slice(&segment[b..]);
        Ok(out)
    })
}

fn apply_replace_around(doc: &mut Value, step: &Value) -> Result<(), StepError> {
    let (from, to) = (position(step, "from")?, position(step, "to")?);
    let (gap_from, gap_to, insert) = (position(step, "gapFrom")?, position(step, "gapTo")?, position(step, "insert")?);
    if gap_from < from || gap_to > to || gap_from > gap_to {
        return Err(StepError::Invalid("Invalid gap".into()));
    }
    let inserted = from_items(slice(step)?)?;
    if insert > inserted.len() {
        return Err(StepError::Invalid("Invalid insert offset".into()));
    }
    splice(doc, from, to, &mut |segment, a, b| {
        let gap = &segment[a + gap_from - from..a + gap_to - from];
        let mut out = Vec::with_capacity(segment.len() + inserted.len());
        out.extend_from_slice(&segment[..a]);
        out.extend(inserted[..insert].iter().cloned());
        out.extend_from_slice(gap);
        out.extend(inserted[insert..].iter().cloned());
        out.extend_from_slice(&segment[b..]);
        Ok(out)
    })
}

fn apply_mark(doc: &mut Value, step: &Value, add: bool) -> Result<(), StepError> {
    let mark = step.get("mark").filter(|m| js_truthy(m)).ok_or_else(|| StepError::Malformed("the step has no mark".into()))?;
    let mark_type = node_type(mark);
    let s = schema();
    if s.mark_spec(mark_type).is_none() {
        return Err(StepError::Invalid(format!("Unknown mark {mark_type}")));
    }
    let change = |current: &[Value]| if add { add_to_mark_set(current, mark) } else { remove_from_mark_set(current, mark) };
    splice(doc, position(step, "from")?, position(step, "to")?, &mut |mut segment, a, b| {
        // Neighbouring characters share their marks: change each distinct set once.
        let mut last: Option<(Marks, Marks)> = None;
        for token in segment.iter_mut().take(b).skip(a) {
            match token {
                Token::Char { marks, parent, .. } => {
                    if !s.allows_mark(parent, mark_type) {
                        continue;
                    }
                    let same_as_last = match (&last, &*marks) {
                        (Some((Some(seen), _)), Some(current)) => Arc::ptr_eq(seen, current),
                        (Some((None, _)), None) => true,
                        _ => false,
                    };
                    if !same_as_last {
                        let next = change(marks.as_ref().map_or(&[], |m| m.as_slice()));
                        last = Some((marks.clone(), if next.is_empty() { None } else { Some(Arc::new(next)) }));
                    }
                    *marks = last.as_ref().and_then(|(_, changed)| changed.clone());
                }
                Token::Leaf { node, parent } => {
                    if !s.allows_mark(parent, mark_type) {
                        continue;
                    }
                    let next = change(node_marks(node));
                    if let Some(object) = node.as_object_mut() {
                        // `{ marks: _old, ...node }`, then `marks` again at the end.
                        object.shift_remove("marks");
                        if !next.is_empty() {
                            object.insert("marks".into(), Value::Array(next));
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(segment)
    })
}

fn apply_attr(doc: &mut Value, step: &Value) -> Result<(), StepError> {
    let pos = position(step, "pos")?;
    let attrs = step.get("attrs").filter(|a| a.is_object() || a.is_array()).ok_or_else(|| StepError::Malformed("the step has no attrs".into()))?;
    let Some(path) = node_at(doc, pos)? else { return Err(StepError::Invalid(format!("No node at {pos}"))) };
    let node = node_at_path_mut(doc, &path);
    if node_type(node) == "text" {
        return Err(StepError::Invalid(format!("No node at {pos}")));
    }
    match node.as_object_mut() {
        Some(object) => {
            object.insert("attrs".into(), attrs.clone());
            Ok(())
        }
        None => Err(StepError::Invalid(format!("No node at {pos}"))),
    }
}

/// Applies a step to the document in place. On an error the document is left
/// in an unspecified state.
pub fn apply_step_in_place(doc: &mut Value, step: &Value) -> Result<(), StepError> {
    match step.get("stepType").and_then(Value::as_str) {
        Some("replace") => apply_replace(doc, step),
        Some("replaceAround") => apply_replace_around(doc, step),
        Some("addMark") => apply_mark(doc, step, true),
        Some("removeMark") => apply_mark(doc, step, false),
        Some("attr") => apply_attr(doc, step),
        _ => Err(StepError::Malformed("unknown step type".into())),
    }
}

/// `applyStep(doc, step).doc`.
pub fn apply_step(doc: &Value, step: &Value) -> Result<Value, StepError> {
    let mut next = doc.clone();
    apply_step_in_place(&mut next, step)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hello() -> Value {
        json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "hello" }] }] })
    }

    fn replace(from: usize, to: usize, slice: Value) -> Value {
        json!({ "stepType": "replace", "from": from, "to": to, "slice": slice })
    }

    #[test]
    fn types_deletes_splits_and_joins() {
        let typed = apply_step(&hello(), &replace(3, 3, json!([{ "t": "X" }]))).unwrap();
        assert_eq!(typed["content"][0]["content"], json!([{ "type": "text", "text": "heXllo" }]));
        let deleted = apply_step(&hello(), &replace(2, 5, json!([]))).unwrap();
        assert_eq!(deleted["content"][0]["content"], json!([{ "type": "text", "text": "ho" }]));
        let split = apply_step(&hello(), &replace(3, 3, json!([{ "c": 1 }, { "o": "paragraph" }]))).unwrap();
        assert_eq!(split["content"].as_array().unwrap().len(), 2);
        assert_eq!(split["content"][1]["content"][0]["text"], "llo");
        let joined = apply_step(&split, &replace(3, 5, json!([]))).unwrap();
        assert_eq!(joined["content"][0]["content"], json!([{ "type": "text", "text": "hello" }]));
    }

    #[test]
    fn refuses_what_does_not_fit() {
        let invalid = |step: Value| matches!(apply_step(&hello(), &step), Err(StepError::Invalid(_)));
        assert!(invalid(replace(5, 3, json!([]))));
        assert!(invalid(replace(0, 99, json!([]))));
        assert!(invalid(replace(3, 3, json!([{ "c": 1 }]))));
        assert!(invalid(replace(0, 0, json!([{ "t": "loose text" }]))));
        assert!(invalid(replace(0, 0, json!([{ "o": "nonsense" }, { "c": 1 }]))));
        assert!(invalid(json!({ "stepType": "attr", "pos": 2, "attrs": {} })));
        assert!(invalid(json!({ "stepType": "addMark", "from": 1, "to": 3, "mark": { "type": "blink" } })));
        assert!(invalid(json!({ "stepType": "replaceAround", "from": 0, "to": 7, "gapFrom": 0, "gapTo": 9, "slice": [], "insert": 0 })));
        assert!(invalid(json!({ "stepType": "replace", "from": 1e300, "to": 1e300, "slice": [] })));
        assert!(matches!(apply_step(&hello(), &replace(3, 3, json!([5]))), Err(StepError::Malformed(_))));
        assert!(matches!(apply_step(&hello(), &replace(3, 3, json!([{ "n": null }]))), Err(StepError::Malformed(_))));
    }

    #[test]
    fn keeps_the_quirks_of_leaf_text_nodes() {
        let step = |slice: Value| apply_step(&hello(), &replace(3, 3, slice));
        assert_eq!(step(json!([{ "n": { "type": "text", "text": "abc" } }])).unwrap()["content"][0]["content"], json!([{ "type": "text", "text": "he" }, { "type": "text", "text": "abcllo" }]));
        assert_eq!(step(json!([{ "n": { "type": "text", "text": "" } }])).unwrap()["content"][0]["content"], json!([{ "type": "text", "text": "he" }, { "type": "text", "text": "llo" }]));
        assert!(matches!(apply_step(&hello(), &replace(6, 6, json!([{ "n": { "type": "text", "text": "" } }]))), Err(StepError::Invalid(_))));
        assert_eq!(step(json!([{ "t": "x", "m": [{ "type": "blink" }] }])).unwrap()["content"][0]["content"][1], json!({ "type": "text", "text": "x", "marks": [{ "type": "blink" }] }));
    }

    #[test]
    fn wraps_marks_and_sets_attributes() {
        let wrapped = apply_step(&hello(), &json!({ "stepType": "replaceAround", "from": 0, "to": 7, "gapFrom": 0, "gapTo": 7, "slice": [{ "o": "blockquote" }, { "c": 1 }], "insert": 1 })).unwrap();
        assert_eq!(wrapped["content"][0]["type"], "blockquote");
        assert_eq!(wrapped["content"][0]["content"][0]["content"][0]["text"], "hello");
        let bold = apply_step(&hello(), &json!({ "stepType": "addMark", "from": 2, "to": 4, "mark": { "type": "bold" } })).unwrap();
        assert_eq!(bold["content"][0]["content"], json!([{ "type": "text", "text": "h" }, { "type": "text", "text": "el", "marks": [{ "type": "bold" }] }, { "type": "text", "text": "lo" }]));
        let link = apply_step(&bold, &json!({ "stepType": "addMark", "from": 2, "to": 4, "mark": { "type": "link", "attrs": { "href": "/x" } } })).unwrap();
        assert_eq!(link["content"][0]["content"][1]["marks"], json!([{ "type": "link", "attrs": { "href": "/x" } }, { "type": "bold" }]));
        let plain = apply_step(&bold, &json!({ "stepType": "removeMark", "from": 1, "to": 6, "mark": { "type": "bold" } })).unwrap();
        assert_eq!(plain, hello());
        let attrs = apply_step(&hello(), &json!({ "stepType": "attr", "pos": 0, "attrs": { "indent": 2 } })).unwrap();
        assert_eq!(attrs["content"][0]["attrs"], json!({ "indent": 2 }));
    }

    #[test]
    fn checks_step_shapes() {
        assert!(is_step(&replace(0, 0, json!([]))));
        assert!(is_step(&json!({ "stepType": "attr", "pos": 0, "attrs": [] })));
        assert!(is_step(&json!({ "stepType": "replace", "from": 1e300, "to": 0, "slice": [] })));
        for bad in [
            json!(null),
            json!([]),
            json!({ "stepType": "replace", "from": -1, "to": 0, "slice": [] }),
            json!({ "stepType": "replace", "from": 0.5, "to": 1, "slice": [] }),
            json!({ "stepType": "replace", "from": "0", "to": 1, "slice": [] }),
            json!({ "stepType": "replace", "from": 0, "to": 1, "slice": {} }),
            json!({ "stepType": "addMark", "from": 0, "to": 1, "mark": "bold" }),
            json!({ "stepType": "addMark", "from": 0, "to": 1, "mark": { "type": 5 } }),
            json!({ "stepType": "attr", "pos": 0, "attrs": null }),
            json!({ "stepType": "attr", "pos": 0, "attrs": "x" }),
            json!({ "stepType": "other" }),
        ] {
            assert!(!is_step(&bad), "{bad}");
        }
    }
}
