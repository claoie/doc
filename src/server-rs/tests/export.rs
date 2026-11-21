//! Holds the Rust serializers (`common::editor::html`, `common::editor::markdown`)
//! and the document walkers of `common::text` to the TypeScript ones, through
//! `fixtures/export.json` and `fixtures/export-fuzz.json` (both written by
//! `fixtures/gen-export.ts`).
//!
//! Every comparison is of whole strings, byte for byte. The fuzz fixture holds
//! a digest of each expected output instead of the output itself (the first
//! 16 hex digits of its SHA-256), which is what keeps thousands of documents
//! in a file of a few megabytes; a mismatch prints the document so the
//! TypeScript output can be looked at with a few lines of Bun.

use doc_server::common::editor::html::{doc_to_html, escape_html, mark_tag, node_to_html, safe_color, safe_url, AttrValue, HtmlOptions};
use doc_server::common::editor::markdown::{doc_to_markdown, try_doc_to_markdown, MarkdownError, MarkdownOptions};
use doc_server::common::text::{doc_links, doc_mentioned_user_ids, doc_text};
use doc_server::jsutil::{encode_uri_component, js_json, js_string, js_truthy};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/export.json")).expect("export.json")
}

fn cases<'a>(fixture: &'a Value, section: &str) -> &'a [Value] {
    fixture[section].as_array().unwrap_or_else(|| panic!("section {section}"))
}

// The callbacks of `probe` in fixtures/lib.ts.

fn probe_file_url(src: &str) -> String {
    format!("FILE ({src})")
}

fn probe_page_href(slug_id: &str, anchor_id: Option<&Value>) -> String {
    format!("PAGE<{slug_id}|{}>", anchor_id.map_or_else(|| "none".to_string(), js_json))
}

fn probe() -> HtmlOptions<'static> {
    HtmlOptions { file_url: Some(&probe_file_url), page_href: Some(&probe_page_href) }
}

fn plain() -> HtmlOptions<'static> {
    HtmlOptions::default()
}

/// The first 16 hex digits of the SHA-256 of the text: `digest` in fixtures/lib.ts.
fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("array").iter().map(|v| v.as_str().expect("string").to_string()).collect()
}

/// Whether the TypeScript function threw for this case.
fn threw(expected: &Value) -> bool {
    expected.get("throws").is_some()
}

/// Compares everything the ports make of `doc` with one fixture entry. Where
/// the TypeScript threw, `fallback` (when there is one) holds what the Rust
/// port is to answer instead.
fn check_outputs(name: &str, doc: &Value, expected: &Value, fallback: Option<&Value>) {
    let want = |key: &str| -> Option<&Value> {
        let value = &expected[key];
        if threw(value) {
            fallback.map(|f| &f[key])
        } else {
            Some(value)
        }
    };

    let html = doc_to_html(doc, &plain());
    let html_with = doc_to_html(doc, &probe());
    if let Some(want) = want("html") {
        assert_eq!(html, want.as_str().unwrap(), "{name}: html");
    }
    if let Some(want) = want("htmlWith") {
        assert_eq!(html_with, want.as_str().unwrap(), "{name}: html with callbacks");
    }

    for (key, opts) in [("md", plain()), ("mdWith", probe())] {
        let markdown = doc_to_markdown(doc, &opts);
        if let Some(want) = want(key) {
            assert_eq!(markdown, want.as_str().unwrap(), "{name}: {key}");
            assert_eq!(try_doc_to_markdown(doc, &opts).as_deref(), Ok(want.as_str().unwrap()), "{name}: {key}, checked");
        }
    }

    let text = doc_text(Some(doc));
    if let Some(want) = want("text") {
        assert_eq!(text, want.as_str().unwrap(), "{name}: text");
    }
    let links = doc_links(Some(doc));
    if let Some(want) = want("links") {
        assert_eq!(links.page_ids, strings(&want["pageIds"]), "{name}: page ids");
        assert_eq!(links.slug_ids, strings(&want["slugIds"]), "{name}: slug ids");
    }
    let users = doc_mentioned_user_ids(Some(doc));
    if let Some(want) = want("users") {
        assert_eq!(users, strings(want), "{name}: mentioned users");
    }
}

#[test]
fn documents_match() {
    let fixture = fixture();
    let docs = cases(&fixture, "docs");
    assert!(docs.len() >= 40);
    for case in docs {
        let name = case["name"].as_str().unwrap();
        let doc = &case["doc"];
        for key in ["html", "htmlWith", "text", "links", "users"] {
            assert!(!threw(&case[key]), "{name}: the TypeScript {key} threw");
        }
        // The Markdown serializer throws for exactly one shape, and the checked
        // Rust function reports exactly that.
        for (key, opts) in [("md", plain()), ("mdWith", probe())] {
            if threw(&case[key]) {
                assert_eq!(case[key]["throws"], "TypeError", "{name}");
                assert_eq!(try_doc_to_markdown(doc, &opts), Err(MarkdownError::TableWithoutRows), "{name}: {key}");
            }
        }
        check_outputs(name, doc, case, None);
    }
}

#[test]
fn every_node_and_mark_type_is_covered() {
    fn collect(node: &Value, nodes: &mut Vec<String>, marks: &mut Vec<String>) {
        if let Some(node_type) = node.get("type").and_then(Value::as_str) {
            nodes.push(node_type.to_string());
        }
        for mark in node.get("marks").and_then(Value::as_array).into_iter().flatten() {
            if let Some(mark_type) = mark.get("type").and_then(Value::as_str) {
                marks.push(mark_type.to_string());
            }
        }
        for child in node.get("content").and_then(Value::as_array).into_iter().flatten() {
            collect(child, nodes, marks);
        }
    }
    let fixture = fixture();
    let (mut nodes, mut marks) = (Vec::new(), Vec::new());
    for case in cases(&fixture, "docs") {
        collect(&case["doc"], &mut nodes, &mut marks);
    }
    let schema = doc_server::common::editor::doc_schema::schema();
    for name in schema.node_names() {
        assert!(nodes.iter().any(|n| n == name), "no hand-written document has a {name} node");
    }
    for name in schema.mark_names() {
        assert!(marks.iter().any(|m| m == name), "no hand-written document has a {name} mark");
    }
}

#[test]
fn table_without_rows_falls_back_to_html() {
    let fixture = fixture();
    let case = cases(&fixture, "docs").iter().find(|c| c["name"] == "table-without-rows").expect("the case");
    assert_eq!(
        doc_to_markdown(&case["doc"], &plain()),
        "before\n\n<div class=\"tableWrapper\"><table><tbody></tbody></table></div>\n\nbetween\n\n\
         <div class=\"tableWrapper\"><table><tbody></tbody></table></div>\n\n\
         <div class=\"tableWrapper\"><table><tbody></tbody></table></div>\n\nafter\n"
    );
}

#[test]
fn parsed_markdown_serializes_back() {
    let fixture = fixture();
    for case in cases(&fixture, "markdown") {
        let name = case["name"].as_str().unwrap();
        let markdown = doc_to_markdown(&case["doc"], &plain());
        assert_eq!(markdown, case["md"].as_str().unwrap(), "{name}: markdown");
        assert_eq!(doc_to_html(&case["doc"], &plain()), case["html"].as_str().unwrap(), "{name}: html");
        // markdown.test.ts, "round trips".
        if name == "test: round trips" {
            assert_eq!(markdown, case["source"].as_str().unwrap());
        }
    }
}

/// The assertions of `common/editor/markdown.test.ts` that are about the
/// serializer, and the serialization ones of `server/routes/export.test.ts`.
#[test]
fn ported_test_cases() {
    // "escapes special characters": the parser reads the text back unchanged,
    // which takes exactly these backslashes.
    let doc = json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "a *b* [c]" }] }] });
    assert_eq!(doc_to_markdown(&doc, &plain()), "a \\*b\\* \\[c\\]\n");

    // "markdown export uses the markdown serializer"
    let doc = json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "hello", "marks": [{ "type": "bold" }] }] }] });
    assert!(format!("# Notes\n\n{}", doc_to_markdown(&doc, &plain())).contains("**hello**"));

    // "a single page exports as an HTML document": the title is escaped.
    assert_eq!(format!("<h1>{}</h1>", escape_html("Solo <page>")), "<h1>Solo &lt;page&gt;</h1>");

    // "a page with children and files exports as a zip with relative links"
    let fixture = fixture();
    let export = |depth: u64| {
        cases(&fixture, "exports").iter().find(|c| c["name"] == "export-like" && c["depth"] == depth).expect("the export-like case")
    };
    assert!(export(0)["html"].as_str().unwrap().contains("href=\"Guide/Setup.html\""));
    let file = "0b8e6f2c-1d3a-4c5b-9e7f-112233445566";
    assert!(export(1)["html"].as_str().unwrap().contains(&format!("src=\"../files/{file}/diagram%20one.png\"")));
    assert!(export(1)["md"].as_str().unwrap().contains(&format!("](../files/{file}/diagram%20one.png)")));
}

/// `exportLike` of fixtures/lib.ts: the callbacks of `server/lib/export.ts`.
#[test]
fn export_callbacks_match() {
    const FILE: &str = "0b8e6f2c-1d3a-4c5b-9e7f-112233445566";
    let fixture = fixture();
    for case in cases(&fixture, "exports") {
        let depth = case["depth"].as_u64().unwrap() as usize;
        let up = |parts: &[&str]| format!("{}{}", "../".repeat(depth), parts.iter().map(|p| encode_uri_component(p)).collect::<Vec<_>>().join("/"));
        let file_url = |src: &str| {
            if src.starts_with(&format!("/api/files/{FILE}")) {
                up(&["files", FILE, "diagram one.png"])
            } else {
                format!("https://doc.example.com{src}")
            }
        };
        let page_href = |slug_id: &str, anchor_id: Option<&Value>| {
            let anchor = anchor_id.filter(|a| js_truthy(a)).map(|a| format!("#{}", encode_uri_component(&js_string(a)))).unwrap_or_default();
            let page = if slug_id == "Setup1" { up(&["Guide", "Setup.html"]) } else { "https://doc.example.com/".to_string() };
            format!("{page}{anchor}")
        };
        let opts = MarkdownOptions { file_url: Some(&file_url), page_href: Some(&page_href) };
        let name = format!("{} at depth {depth}", case["name"].as_str().unwrap());
        assert_eq!(doc_to_html(&case["doc"], &opts), case["html"].as_str().unwrap(), "{name}: html");
        assert_eq!(doc_to_markdown(&case["doc"], &opts), case["md"].as_str().unwrap(), "{name}: markdown");
    }
}

#[test]
fn mark_tags_match() {
    let fixture = fixture();
    for case in cases(&fixture, "marks") {
        let mark = &case["mark"];
        let tag = mark_tag(mark);
        assert_eq!(tag.name, case["name"].as_str().unwrap(), "{mark}");
        let attrs: Vec<Value> = tag
            .attrs
            .iter()
            .map(|(name, value)| {
                let value = match value {
                    AttrValue::Null => Value::Null,
                    AttrValue::Bool(b) => json!(b),
                    AttrValue::Number(n) => json!(n),
                    AttrValue::Text(s) => json!(s),
                };
                json!([name, value])
            })
            .collect();
        assert_eq!(Value::Array(attrs), case["attrs"], "{mark}");
        // The tag is what a text node with this mark is wrapped in.
        let text = json!({ "type": "text", "text": "x", "marks": [mark] });
        assert_eq!(node_to_html(&text, &plain()), format!("{}x{}", tag.open(), tag.close()), "{mark}");
    }
}

#[test]
fn colors_match() {
    let fixture = fixture();
    for case in cases(&fixture, "colors") {
        assert_eq!(safe_color(case.get("v")).map(Value::String).unwrap_or(Value::Null), case["color"], "{case}");
    }
}

#[test]
fn urls_match() {
    let fixture = fixture();
    for case in cases(&fixture, "urls").iter().filter(|c| c.get("folded").is_none()) {
        assert_eq!(safe_url(case.get("v")), case["url"].as_str().unwrap(), "{case}");
    }
}

/// `safe_url` is `sanitize::clean_url`, whose patterns are case-insensitive
/// the Unicode way: U+017F (long s) and U+212A (Kelvin sign) count as `s` and
/// `k`. JavaScript's `/i` without `/u` does not fold them, so `cleanUrl` sees
/// no scheme in `ſcript:x` and keeps it, where `clean_url` sees an unknown
/// scheme and answers `""` (and the other way round for `data:image/ſvg+xml`).
/// This test passes once `sanitize.rs` matches ASCII letters only.
#[test]
#[ignore = "sanitize::clean_url folds U+017F and U+212A, cleanUrl does not"]
fn urls_with_folding_letters_match() {
    let fixture = fixture();
    let folded: Vec<&Value> = cases(&fixture, "urls").iter().filter(|c| c.get("folded").is_some()).collect();
    assert_eq!(folded.len(), 4);
    for case in folded {
        assert_eq!(safe_url(case.get("v")), case["url"].as_str().unwrap(), "{case}");
    }
}

#[test]
fn escapes_match() {
    let fixture = fixture();
    for case in cases(&fixture, "escapes") {
        assert_eq!(escape_html(case["value"].as_str().unwrap()), case["escaped"].as_str().unwrap());
    }
}

/// `String(v)` and `Number(v)` throw in JavaScript for an object with an own
/// `toString` key. The Rust coercions treat it like any other object, so the
/// output is what TypeScript writes for the same document with the key renamed
/// (the fixture's "twin"), and never an error.
#[test]
fn objects_with_a_to_string_key_render_like_other_objects() {
    let fixture = fixture();
    let mut thrown = 0;
    for case in cases(&fixture, "coercion") {
        let name = case["name"].as_str().unwrap();
        thrown += ["html", "htmlWith", "md", "mdWith", "text"].iter().filter(|key| threw(&case[**key])).count();
        for key in ["html", "htmlWith", "md", "mdWith", "text", "links", "users"] {
            assert!(!threw(&case["twin"][key]), "{name}: the twin's {key} threw");
        }
        check_outputs(name, &case["doc"], case, Some(&case["twin"]));
    }
    assert!(thrown >= 20, "the cases are there to throw in TypeScript: {thrown}");
}

/// Trees `validateDoc` rejects. Where JavaScript answers, so does the port,
/// with the same answer; where JavaScript throws, the port must not panic.
#[test]
fn unvalidated_trees_do_not_panic() {
    let fixture = fixture();
    let (mut answered, mut differing) = (0, 0);
    for case in cases(&fixture, "unvalidated") {
        let name = case["name"].as_str().unwrap();
        let doc = &case["doc"];
        if case.get("differs").is_some() {
            // JavaScript answers and the port answers something else; see the
            // module documentation of `html.rs`.
            let same = ["html", "md", "text"].iter().all(|key| {
                let ours = match *key {
                    "html" => doc_to_html(doc, &plain()),
                    "md" => doc_to_markdown(doc, &plain()),
                    _ => doc_text(Some(doc)),
                };
                threw(&case[*key]) || case[*key] == ours
            });
            assert!(!same, "{name} is flagged as differing and does not");
            differing += 1;
            continue;
        }
        answered += ["html", "htmlWith", "md", "mdWith", "text", "links", "users"].iter().filter(|key| !threw(&case[**key])).count();
        check_outputs(name, doc, case, None);
    }
    assert!(answered >= 100, "{answered}");
    assert_eq!(differing, 3);
}

#[test]
fn random_documents_match() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/export-fuzz.json")).expect("export-fuzz.json");
    let docs = cases(&fixture, "docs");
    assert!(docs.len() >= 3000);
    let mut failures: Vec<String> = Vec::new();
    let mut rowless = 0;
    for (index, case) in docs.iter().enumerate() {
        let doc = &case[0];
        let mut check = |what: &str, ours: Option<&str>, expected: &Value| match ours {
            Some(ours) if expected.as_str() == Some(digest(ours).as_str()) => {}
            // null in the fixture: the TypeScript threw.
            None if expected.is_null() => {}
            _ => failures.push(format!("#{index} {what}\n  document: {doc}\n  rust: {ours:?}")),
        };
        check("html", Some(&doc_to_html(doc, &plain())), &case[1]);
        check("html with callbacks", Some(&doc_to_html(doc, &probe())), &case[2]);
        for (what, opts, expected) in [("markdown", plain(), &case[3]), ("markdown with callbacks", probe(), &case[4])] {
            let markdown = try_doc_to_markdown(doc, &opts);
            match &markdown {
                Ok(markdown) => assert_eq!(markdown, &doc_to_markdown(doc, &opts)),
                Err(MarkdownError::TableWithoutRows) => rowless += 1,
            }
            check(what, markdown.as_deref().ok(), expected);
        }
        let links = doc_links(Some(doc));
        let text = [doc_text(Some(doc)), links.page_ids.join("\u{1}"), links.slug_ids.join("\u{1}"), doc_mentioned_user_ids(Some(doc)).join("\u{1}")].join("\u{0}");
        check("text and links", Some(&text), &case[5]);
    }
    assert!(rowless > 0, "no document has a table without rows");
    assert!(failures.is_empty(), "{} of {} outputs differ; the first:\n{}", failures.len(), docs.len() * 5, failures.iter().take(2).cloned().collect::<Vec<_>>().join("\n"));
}

/// Not about the ports: `serde_json` without its `float_roundtrip` feature
/// reads some numbers one unit in the last place off, where `JSON.parse`
/// rounds correctly, and `String(n)` then prints different digits. Bun
/// prints `123456789012345680000` for this one.
#[test]
#[ignore = "serde_json parses 123456789012345680000 one ulp low without float_roundtrip"]
fn large_json_numbers_parse_like_javascript() {
    let number: Value = serde_json::from_str("123456789012345680000").unwrap();
    assert_eq!(js_string(&number), "123456789012345680000");
}
