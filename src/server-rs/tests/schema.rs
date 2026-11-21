//! Holds the Rust document schema to the TypeScript one, through
//! `fixtures/schema.json` (written by `fixtures/gen-schema.ts`).

use doc_server::common::editor::doc_schema::schema;
use doc_server::common::editor::model::same_value;
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/schema.json")).expect("schema.json")
}

fn strings(value: &Value) -> Vec<&str> {
    value.as_array().expect("array").iter().map(|v| v.as_str().expect("string")).collect()
}

#[test]
fn node_types_match() {
    let fixture = fixture();
    let s = schema();
    let nodes = fixture["nodes"].as_array().unwrap();
    assert_eq!(s.node_names().collect::<Vec<_>>(), nodes.iter().map(|n| n["name"].as_str().unwrap()).collect::<Vec<_>>());
    for node in nodes {
        let name = node["name"].as_str().unwrap();
        let spec = s.node_spec(name).unwrap();
        let expected = &node["spec"];
        assert_eq!(spec.content, expected.get("content").and_then(Value::as_str), "{name} content");
        assert_eq!(spec.group, expected.get("group").and_then(Value::as_str).unwrap_or(""), "{name} group");
        assert_eq!(spec.inline, expected.get("inline") == Some(&json!(true)), "{name} inline");
        assert_eq!(spec.marks, expected.get("marks").and_then(Value::as_str), "{name} marks");
        assert_eq!(spec.code, expected.get("code") == Some(&json!(true)), "{name} code");
        assert_eq!(spec.isolating, expected.get("isolating") == Some(&json!(true)), "{name} isolating");
        assert_eq!(spec.selectable, expected.get("selectable") == Some(&json!(true)), "{name} selectable");
        match (&spec.attrs, expected.get("attrs")) {
            (None, None) => {}
            (Some(a), Some(b)) => {
                assert!(same_value(a, b), "{name} attrs");
                assert_eq!(a.as_object().unwrap().keys().collect::<Vec<_>>(), b.as_object().unwrap().keys().collect::<Vec<_>>(), "{name} attr order");
            }
            _ => panic!("{name} attrs presence"),
        }
        assert_eq!(s.is_leaf(name), node["isLeaf"], "{name} isLeaf");
        assert_eq!(s.is_inline(name), node["isInline"], "{name} isInline");
        assert_eq!(s.is_textblock(name), node["isTextblock"], "{name} isTextblock");
        let allowed: Vec<&str> = s.mark_names().filter(|mark| s.allows_mark(name, mark)).collect();
        assert_eq!(allowed, strings(&node["allowedMarks"]), "{name} allowed marks");
        let children: Vec<&str> = s.node_names().filter(|child| s.valid_content(name, &[json!({ "type": child })])).collect();
        assert_eq!(children, strings(&node["validChildren"]), "{name} valid children");
        assert_eq!(s.valid_content(name, &[]), node["validEmpty"], "{name} valid when empty");
    }
}

#[test]
fn mark_types_match() {
    let fixture = fixture();
    let s = schema();
    let marks = fixture["marks"].as_array().unwrap();
    assert_eq!(s.mark_names().collect::<Vec<_>>(), marks.iter().map(|m| m["name"].as_str().unwrap()).collect::<Vec<_>>());
    for mark in marks {
        let name = mark["name"].as_str().unwrap();
        let spec = s.mark_spec(name).unwrap();
        let expected = &mark["spec"];
        assert_eq!(spec.stackable, expected.get("stackable") == Some(&json!(true)), "{name} stackable");
        assert_eq!(spec.inclusive, expected.get("inclusive").and_then(Value::as_bool), "{name} inclusive");
        match (&spec.attrs, expected.get("attrs")) {
            (None, None) => {}
            (Some(a), Some(b)) => assert!(same_value(a, b), "{name} attrs"),
            _ => panic!("{name} attrs presence"),
        }
    }
}

#[test]
fn groups_match() {
    let fixture = fixture();
    let s = schema();
    for (group, members) in fixture["groups"].as_object().unwrap() {
        assert_eq!(s.group_members(group), strings(members).as_slice(), "{group}");
    }
}
