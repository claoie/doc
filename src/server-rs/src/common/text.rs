//! Port of `src/common/text.ts`: the plain text of a document, the pages and
//! users it refers to, and the URL segment of a page title.
//!
//! Documents are read the way `editor/html.rs` describes: attributes of any
//! JSON type are coerced as JavaScript coerces them, and a `content`, `marks`
//! or `attrs` of the wrong type reads as absent.
//!
//! `title_slug` is where a Rust string cannot follow JavaScript all the way:
//! `.slice(0, 60)` counts UTF-16 units and may cut a character outside the
//! Basic Multilingual Plane in half, which leaves a lone surrogate at the end
//! of the JavaScript string. See `title_slug` and `try_page_path`.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use super::editor::doc_schema::schema;
use super::editor::html::Attrs;
use super::editor::model::{children, marks, node_type};
use crate::jsutil::{decode_uri_component, encode_uri_component, js_string, js_trim, js_truthy, present};

/// `isInline`: text, or a node type the schema marks as inline. A type the
/// schema does not know is not inline (that includes the names JavaScript
/// finds on `Object.prototype`, whose "spec" has no `inline`).
fn is_inline(node: &Value) -> bool {
    schema().is_inline(node_type(node))
}

/// `inlineText`. Every result is joined into a line, and the join is what
/// turns a `text` that is not a string into one in JavaScript.
fn inline_text(node: &Value, out: &mut String) {
    let a = Attrs::of(node);
    match node_type(node) {
        "text" => match present(node.get("text")) {
            Some(Value::String(s)) => out.push_str(s),
            Some(other) => out.push_str(&js_string(other)),
            None => {}
        },
        "hardBreak" => out.push('\n'),
        "mention" => out.push_str(&a.string_or("label", "")),
        "mathInline" | "status" => out.push_str(&a.string_or("text", "")),
        _ => {
            for child in children(node) {
                inline_text(child, out);
            }
        }
    }
}

fn collect_lines(node: &Value, lines: &mut Vec<String>) {
    let a = Attrs::of(node);
    let kind = node_type(node);
    let kids = children(node);
    // `if (a.text) lines.push(String(a.text))`: anything truthy is a line.
    let attr_line = |key: &str, lines: &mut Vec<String>| {
        if a.truthy(key) {
            lines.push(a.string_or(key, ""));
        }
    };
    if kind == "mathBlock" {
        return attr_line("text", lines);
    }
    if kind == "attachment" || kind == "pdf" {
        return attr_line("name", lines);
    }
    if kind == "codeBlock" || (!kids.is_empty() && kids.iter().all(is_inline)) {
        let mut line = String::new();
        for child in kids {
            inline_text(child, &mut line);
        }
        if !js_trim(&line).is_empty() {
            lines.push(line);
        }
        return;
    }
    for child in kids {
        collect_lines(child, lines);
    }
}

/// Plain text of a document, one line per text block, for search and previews.
///
/// `None` is `undefined`; like the original's `!doc`, any falsy value (a JSON
/// null, `false`, `0`, `""`) is an empty document.
pub fn doc_text(doc: Option<&Value>) -> String {
    let Some(doc) = doc.filter(|d| js_truthy(d)) else { return String::new() };
    let mut lines = Vec::new();
    collect_lines(doc, &mut lines);
    lines.join("\n")
}

fn walk<'a>(node: &'a Value, visit: &mut impl FnMut(&'a Value)) {
    visit(node);
    for child in children(node) {
        walk(child, visit);
    }
}

/// `PAGE_PATH_RE`. The `regex` crate's `.` stops only at `\n`, so the query
/// and fragment are spelled as "no JavaScript line terminator"; `^` and `$`
/// anchor to the whole string in both.
fn page_path_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(?:https?://[^/?#]+)?(?:/s/[^/?#]+/p/([^/?#]+)|/p/([^/?#]+))/?(?:[?#][^\n\r\u{2028}\u{2029}]*)?$")
            .expect("page path pattern")
    })
}

/// The slugId of an internal page URL (`/s/:space/p/:title-:slugId` or
/// `/p/:slugId`), if it is one. Anything but a string is `None`.
pub fn page_slug_id_from_href(href: Option<&Value>) -> Option<String> {
    page_slug_id(href?.as_str()?)
}

fn page_slug_id(href: &str) -> Option<String> {
    let captures = page_path_re().captures(js_trim(href))?;
    let segment = captures.get(1).or_else(|| captures.get(2)).map_or("", |m| m.as_str());
    // A malformed escape makes `decodeURIComponent` throw: not a page link.
    let segment = decode_uri_component(segment)?;
    // segment.slice(segment.lastIndexOf("-") + 1)
    let slug_id = segment.rsplit('-').next().unwrap_or("");
    // /^[0-9A-Za-z]{1,32}$/
    let valid = (1..=32).contains(&slug_id.len()) && slug_id.bytes().all(|b| b.is_ascii_alphanumeric());
    valid.then(|| slug_id.to_string())
}

/// `/[^\p{L}\p{N}]+/gu`.
fn not_word_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[^\p{L}\p{N}]+").expect("word pattern"))
}

/// The slug, and whether cutting it at 60 UTF-16 units split a surrogate pair.
fn slug(title: Option<&str>) -> (String, bool) {
    let title = title.filter(|t| !t.is_empty()).unwrap_or("untitled");
    // .toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").normalize("NFC")
    let folded: String = title.to_lowercase().nfkd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).nfc().collect();
    // .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "")
    let dashed = not_word_re().replace_all(&folded, "-");
    let trimmed = dashed.trim_matches('-');
    // .slice(0, 60)
    let mut out = String::new();
    let mut units = 0;
    let mut split = false;
    for ch in trimmed.chars() {
        if units + ch.len_utf16() > 60 {
            split = units < 60;
            break;
        }
        units += ch.len_utf16();
        out.push(ch);
    }
    if out.is_empty() {
        out.push_str("untitled");
    }
    (out, split)
}

/// URL segment for a page title: lower-case words joined by `-`, at most 60
/// UTF-16 units.
///
/// When the 60th unit is the first half of a surrogate pair, the JavaScript
/// string ends in that lone half. A Rust string cannot, so the character is
/// left out and the slug is 59 units long.
///
/// Which characters are letters, and how they decompose, comes from three
/// sets of Unicode tables here (the standard library lower-cases,
/// `unicode-normalization` normalizes, `regex` knows `\p{L}` and `\p{N}`)
/// and from one in Bun. They agree on every code point of Unicode 16.0; a
/// character added later may be a letter for one and a separator for the
/// other until all carry the same version (`tests/text.rs` has the list).
pub fn title_slug(title: Option<&str>) -> String {
    slug(title).0
}

/// `encodeURIComponent(titleSlug(title))`, or `None` where that throws a
/// `URIError`: the slug was cut inside a surrogate pair.
pub fn try_encoded_title_slug(title: Option<&str>) -> Option<String> {
    let (slug, split) = slug(title);
    (!split).then(|| encode_uri_component(&slug))
}

fn path(space_slug: &str, slug: &str, slug_id: &str) -> String {
    format!("/s/{}/p/{}-{}", encode_uri_component(space_slug), encode_uri_component(slug), slug_id)
}

/// In-app path of a page: `/s/:spaceSlug/p/:titleSlug-:slugId`.
///
/// For a title whose slug is cut inside a surrogate pair (see `title_slug`),
/// `encodeURIComponent` throws a `URIError` in JavaScript; this answers with
/// the shortened slug. `try_page_path` tells the two apart.
pub fn page_path(space_slug: &str, title: Option<&str>, slug_id: &str) -> String {
    path(space_slug, &slug(title).0, slug_id)
}

/// `page_path`, or `None` where the original throws a `URIError`.
pub fn try_page_path(space_slug: &str, title: Option<&str>, slug_id: &str) -> Option<String> {
    let (slug, split) = slug(title);
    (!split).then(|| path(space_slug, &slug, slug_id))
}

/// Pages a document references, in the order they are first seen.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocLinks {
    pub page_ids: Vec<String>,
    pub slug_ids: Vec<String>,
}

/// A `Set` of strings that remembers insertion order.
#[derive(Default)]
struct OrderedSet {
    seen: HashSet<String>,
    order: Vec<String>,
}

impl OrderedSet {
    fn add(&mut self, value: &str) {
        if self.seen.insert(value.to_string()) {
            self.order.push(value.to_string());
        }
    }
}

/// Pages a document references through page mentions and internal links.
pub fn doc_links(doc: Option<&Value>) -> DocLinks {
    let mut page_ids = OrderedSet::default();
    let mut slug_ids = OrderedSet::default();
    let Some(doc) = doc.filter(|d| js_truthy(d)) else { return DocLinks::default() };
    walk(doc, &mut |node| {
        let a = Attrs::of(node);
        if node_type(node) == "mention" && a.is("entityType", "page") {
            let id = |key: &str| a.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
            if let Some(entity_id) = id("entityId") {
                page_ids.add(entity_id);
            } else if let Some(slug_id) = id("slugId") {
                slug_ids.add(slug_id);
            }
        }
        for mark in marks(node) {
            if node_type(mark) != "link" {
                continue;
            }
            if let Some(slug_id) = page_slug_id_from_href(Attrs::of(mark).get("href")) {
                slug_ids.add(&slug_id);
            }
        }
    });
    DocLinks { page_ids: page_ids.order, slug_ids: slug_ids.order }
}

/// Ids of users mentioned in a document. An empty id counts, as it does in
/// the original (`typeof entityId === "string"`).
pub fn doc_mentioned_user_ids(doc: Option<&Value>) -> Vec<String> {
    let mut ids = OrderedSet::default();
    let Some(doc) = doc.filter(|d| js_truthy(d)) else { return Vec::new() };
    walk(doc, &mut |node| {
        let a = Attrs::of(node);
        if node_type(node) == "mention" && a.is("entityType", "user") {
            if let Some(entity_id) = a.get("entityId").and_then(Value::as_str) {
                ids.add(entity_id);
            }
        }
    });
    ids.order
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn slugs_titles() {
        assert_eq!(title_slug(Some("Hello, World!")), "hello-world");
        assert_eq!(title_slug(Some("  Crème brûlée  ")), "creme-brulee");
        assert_eq!(title_slug(Some("한글 제목")), "한글-제목");
        assert_eq!(title_slug(Some("")), "untitled");
        assert_eq!(title_slug(None), "untitled");
        assert_eq!(title_slug(Some("!!!")), "untitled");
        // The cut comes after the dashes are trimmed, so a slug may end in one.
        assert_eq!(title_slug(Some(&"ab ".repeat(40))), "ab-".repeat(20));
        // 59 letters and then a character of two UTF-16 units: JavaScript keeps half of it.
        let long = format!("{}\u{20000}b", "a".repeat(59));
        assert_eq!(title_slug(Some(&long)), "a".repeat(59));
        assert_eq!(page_path("s", Some(&long), "X"), format!("/s/s/p/{}-X", "a".repeat(59)));
        assert_eq!(try_page_path("s", Some(&long), "X"), None);
        let fits = format!("{}\u{20000}b", "a".repeat(58));
        assert_eq!(title_slug(Some(&fits)), format!("{}\u{20000}", "a".repeat(58)));
        assert_eq!(try_page_path("a b", Some("T"), "X").as_deref(), Some("/s/a%20b/p/t-X"));
    }

    #[test]
    fn reads_page_hrefs() {
        let slug = |href: &str| page_slug_id_from_href(Some(&json!(href)));
        assert_eq!(slug("/p/abc\n").as_deref(), Some("abc"));
        assert_eq!(slug("/p/abc?x\ny"), None);
        assert_eq!(slug("/p/abc?x\u{2028}y"), None);
        assert_eq!(slug("/p/a\nb-c").as_deref(), Some("c"));
        assert_eq!(slug("/p/%zz"), None);
        assert_eq!(slug("/p/a-"), None);
        assert_eq!(page_slug_id_from_href(Some(&json!(5))), None);
        assert_eq!(page_slug_id_from_href(None), None);
    }
}
