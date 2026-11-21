//! Holds the string functions of `common::text` to the TypeScript ones,
//! through `fixtures/text.json`, and the Unicode tables behind the ports
//! (lower-casing, normalization, `\p{L}`/`\p{N}`, white space) to Bun's,
//! through `fixtures/unicode.json`. Both are written by `fixtures/gen-text.ts`.
//!
//! `unicode.json` holds one digest for every 4096 code points (the first 16
//! hex digits of the SHA-256 of what the port makes of each, one per line).

use doc_server::common::editor::html::{node_to_html, safe_color, HtmlOptions};
use doc_server::common::editor::markdown::doc_to_markdown;
use doc_server::common::text::{doc_links, doc_mentioned_user_ids, doc_text, page_path, page_slug_id_from_href, title_slug, try_page_path};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn cases(fixture: &'static str, section: &str) -> Vec<Value> {
    let fixture: Value = serde_json::from_str(fixture).expect("fixture");
    fixture[section].as_array().unwrap_or_else(|| panic!("section {section}")).clone()
}

fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn slugs_match() {
    let cases = cases(include_str!("fixtures/text.json"), "slugs");
    assert!(cases.len() > 1500);
    let mut split = 0;
    for case in &cases {
        // A missing title is undefined, a JSON null is null: both are `None`.
        let title = case.get("title").and_then(Value::as_str);
        assert_eq!(title_slug(title), case["slug"].as_str().unwrap(), "{case}");
        // Where JavaScript's slug ends in half a surrogate pair, `pagePath`
        // throws; `try_page_path` is `None` and `page_path` uses the shorter slug.
        if case["split"] == true {
            split += 1;
            assert!(case["path"].is_null(), "{case}");
            assert_eq!(try_page_path("my space/ü", title, "AbC123"), None, "{case}");
            assert_eq!(page_path("my space/ü", title, "AbC123"), format!("/s/my%20space%2F%C3%BC/p/{}-AbC123", doc_server::jsutil::encode_uri_component(&title_slug(title))));
        } else {
            let path = case["path"].as_str().unwrap();
            assert_eq!(page_path("my space/ü", title, "AbC123"), path, "{case}");
            assert_eq!(try_page_path("my space/ü", title, "AbC123").as_deref(), Some(path), "{case}");
        }
    }
    assert!(split >= 4, "{split}");
}

#[test]
fn hrefs_match() {
    let cases = cases(include_str!("fixtures/text.json"), "hrefs");
    assert!(cases.len() > 1500);
    let mut found = 0;
    for case in &cases {
        let slug_id = page_slug_id_from_href(case.get("v"));
        found += usize::from(slug_id.is_some());
        assert_eq!(slug_id.map(Value::String).unwrap_or(Value::Null), case["slugId"], "{case}");
    }
    assert!(found > 100, "{found}");
}

/// `common/text.test.ts`.
#[test]
fn ported_test_cases() {
    let p = |content: Value| json!({ "type": "paragraph", "content": content });
    let t = |text: &str| json!({ "type": "text", "text": text });
    let link = |text: &str, href: &str| json!({ "type": "text", "text": text, "marks": [{ "type": "link", "attrs": { "href": href } }] });
    let user = |id: &str, label: &str| json!({ "type": "mention", "attrs": { "entityType": "user", "entityId": id, "label": label } });
    let doc = json!({ "type": "doc", "content": [
        { "type": "heading", "attrs": { "level": 1 }, "content": [t("Title")] },
        p(json!([t("Hello "), user("u1", "Sam"), t("!")])),
        { "type": "paragraph", "content": [] },
        { "type": "bulletList", "content": [{ "type": "listItem", "content": [p(json!([t("item "), { "type": "mathInline", "attrs": { "text": "x^2" } }]))] }] },
        { "type": "mathBlock", "attrs": { "text": "E = mc^2" } },
        { "type": "codeBlock", "content": [t("const a = 1;\nconst b = 2;")] },
        p(json!([
            { "type": "mention", "attrs": { "entityType": "page", "entityId": "p-uuid", "slugId": "abc", "label": "Other page" } },
            t(" and "), link("link", "/s/general/p/my-title-XyZ123"),
            t(" and "), link("short", "https://doc.example.com/p/Q1w2E3#heading"),
            t(" and "), link("external", "https://example.com/blog"),
        ])),
        p(json!([t("again "), user("u1", "Sam")])),
        p(json!([user("u2", "Lee")])),
    ] });

    // docText: "joins blocks with newlines and includes inline atoms"
    assert_eq!(
        doc_text(Some(&doc)),
        ["Title", "Hello Sam!", "item x^2", "E = mc^2", "const a = 1;\nconst b = 2;", "Other page and link and short and external", "again Sam", "Lee"].join("\n")
    );
    // "handles empty input"
    assert_eq!(doc_text(Some(&Value::Null)), "");
    assert_eq!(doc_text(None), "");
    assert_eq!(doc_text(Some(&json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [] }] }))), "");

    // docLinks: "collects page mentions and internal links"
    let links = doc_links(Some(&doc));
    assert_eq!(links.page_ids, ["p-uuid"]);
    assert_eq!(links.slug_ids, ["XyZ123", "Q1w2E3"]);

    // "parses page hrefs"
    let slug_id = |href: &str| page_slug_id_from_href(Some(&json!(href)));
    assert_eq!(slug_id("/s/space/p/a-b-c-SLUG1").as_deref(), Some("SLUG1"));
    assert_eq!(slug_id("/s/space/p/SLUG2").as_deref(), Some("SLUG2"));
    assert_eq!(slug_id("/p/SLUG3?x=1").as_deref(), Some("SLUG3"));
    assert_eq!(slug_id("/s/space/p/%ED%95%9C-SLUG4").as_deref(), Some("SLUG4"));
    assert_eq!(slug_id("/settings"), None);
    assert_eq!(slug_id("/s/space/p/title-sl/ug"), None);
    assert_eq!(page_slug_id_from_href(None), None);

    // docMentionedUserIds: "dedupes mentioned users"
    assert_eq!(doc_mentioned_user_ids(Some(&doc)), ["u1", "u2"]);
}

/// Compares what the port makes of every code point below `end` with the
/// digests of a section, a block of 4096 at a time, leaving out the ranges in `skip`.
fn blocks(section: &str, end: u32, skip: &[(u32, u32)], line: impl Fn(&str) -> String) {
    let expected = cases(include_str!("fixtures/unicode.json"), section);
    assert_eq!(expected.len() as u32, end / 0x1000);
    let mut differing = Vec::new();
    for (block, want) in expected.iter().enumerate() {
        let start = block as u32 * 0x1000;
        let lines: Vec<String> = (start..start + 0x1000)
            .filter(|cp| !skip.iter().any(|(from, to)| (from..=to).contains(&cp)))
            .filter_map(char::from_u32)
            .map(|ch| line(ch.encode_utf8(&mut [0; 4])))
            .collect();
        if want.as_str() != Some(digest(&lines.join("\n")).as_str()) {
            differing.push(format!("U+{start:04X}"));
        }
    }
    assert!(differing.is_empty(), "{section}: blocks that differ from Bun start at {}", differing.join(", "));
}

fn slug_line(ch: &str) -> String {
    title_slug(Some(&format!("a{ch}b aΣ{ch} aΣ{ch}b")))
}

/// Lower-casing, NFKD, NFC and `\p{L}\p{N}` agree with Bun for every code
/// point but the ones the fixture lists as unsettled: 4714 code points that
/// Unicode 16.0 does not assign, which Bun (17.0), the `regex` crate (16.0)
/// and `unicode-normalization` see differently.
#[test]
fn slugs_of_settled_code_points_match() {
    let unsettled: Vec<(u32, u32)> =
        cases(include_str!("fixtures/unicode.json"), "unsettled").iter().map(|r| (r[0].as_u64().unwrap() as u32, r[1].as_u64().unwrap() as u32)).collect();
    assert_eq!(unsettled.iter().map(|(from, to)| to - from + 1).sum::<u32>(), 4714);
    blocks("settledSlugs", 0x110000, &unsettled, slug_line);
}

/// The same with no code point left out. It passes when the `regex` and
/// `unicode-normalization` crates carry the Unicode version Bun does.
#[test]
#[ignore = "the regex crate (Unicode 16) and unicode-normalization disagree with Bun (Unicode 17) on 4714 new code points"]
fn slugs_of_every_code_point_match() {
    blocks("slugs", 0x110000, &[], slug_line);
}

#[test]
fn lower_case_of_every_code_point_matches() {
    let opts = HtmlOptions::default();
    blocks("lower", 0x110000, &[], |ch| node_to_html(&json!({ "type": "tableCell", "attrs": { "backgroundColorName": ch } }), &opts));
}

#[test]
fn white_space_matches() {
    let opts = HtmlOptions::default();
    let text = |text: String, marks: Value| json!({ "type": "text", "text": text, "marks": marks });
    let paragraph = |content: Value| json!({ "type": "paragraph", "content": content });
    let or_null = |value: Option<String>| value.unwrap_or_else(|| "null".to_string());
    blocks("spaces", 0x10000, &[], |ch| {
        let doc = json!({ "type": "doc", "content": [
            paragraph(json!([text(format!("#{ch}x"), json!([]))])),
            paragraph(json!([text("y".into(), json!([])), text(format!("{ch}x{ch}"), json!([{ "type": "bold" }])), text("z".into(), json!([]))])),
            paragraph(json!([text("l".into(), json!([{ "type": "link", "attrs": { "href": format!("a{ch}b") } }]))])),
            paragraph(json!([text(format!("${ch}y"), json!([]))])),
            paragraph(json!([text(format!("{ch}> q{ch}"), json!([]))])),
        ] });
        [
            doc_to_markdown(&doc, &opts),
            or_null(safe_color(Some(&json!(format!("rgb(1{ch}2)"))))),
            or_null(safe_color(Some(&json!(format!("{ch}red{ch}"))))),
            or_null(page_slug_id_from_href(Some(&json!(format!("{ch}/p/abc{ch}"))))),
            or_null(page_slug_id_from_href(Some(&json!(format!("/p/abc?{ch}"))))),
        ]
        .join("\u{0}")
    });
}
