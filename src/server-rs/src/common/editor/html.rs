//! Port of `src/common/editor/html.ts`.
//!
//! Serializes documents to HTML strings without a DOM, for export, clipboard
//! `text/html` and public pages. The element shapes match what the editor
//! renders and what the HTML parser reads back.
//!
//! The output is byte for byte what the TypeScript writes, including for
//! attributes of an unexpected JSON type. That works because every place the
//! original coerces (`String(a.x)`, `Number(a.x)`, `a.x ? … : …`, `a.x ?? y`,
//! a template literal) goes through the matching `jsutil` helper here, with a
//! missing key (`undefined`, `None`) kept apart from a JSON `null` wherever
//! JavaScript tells them apart. A few results look odd and are kept on
//! purpose: an `orderedList` without a `start` attribute prints
//! `start="NaN"` (`Number(undefined) !== 1`), and a heading whose level is
//! `2.5` is an `<h2.5>` element.
//!
//! Structure is read through the `model` helpers: a `type`, `content`,
//! `marks`, `attrs` or `text` of the wrong JSON type reads as absent. For
//! every tree the server stores (`validateDoc` in `server/lib/content.ts`
//! rejects the others) that is exactly what JavaScript sees. For the rejected
//! shapes JavaScript mostly throws a `TypeError` (`content: 5`, a `null`
//! child, a text node whose `text` is a number); this port renders the node
//! as if the field were missing instead of failing.
//!
//! One coercion is not reproduced, here or anywhere else `jsutil` is used:
//! `String(v)` and `Number(v)` throw a `TypeError` in JavaScript when `v` is
//! an object with an own `toString` key (JSON cannot hold a function, so the
//! key is never callable), also when such an object sits inside an array.
//! `jsutil::js_string` answers `[object Object]` and `js_number` NaN for
//! them, so this port renders the document where the Bun server would fail
//! the request.

use serde_json::{Map, Value};

use super::model::{children, marks, node_type, text};
use super::sanitize::clean_url;
use crate::jsutil::{is_js_whitespace, js_number_opt, js_string, js_trim, js_truthy_opt, number_to_string, present};

pub use crate::jsutil::escape_html;

/// `node.attrs ?? {}` (or `mark.attrs ?? {}`): attribute lookups that answer
/// `None` where JavaScript answers `undefined`.
///
/// Attributes that are not a JSON object (possible on a mark, whose attributes
/// the server does not validate) have none of the keys this code asks for in
/// JavaScript either: no attribute is named like a `String`, `Array` or
/// `Number` method.
#[derive(Clone, Copy)]
pub(crate) struct Attrs<'a>(Option<&'a Map<String, Value>>);

impl<'a> Attrs<'a> {
    pub(crate) fn of(node: &'a Value) -> Self {
        Attrs(node.get("attrs").and_then(Value::as_object))
    }

    /// `a[key]`: `None` is `undefined`, a JSON null stays `Some(Null)`.
    pub(crate) fn get(self, key: &str) -> Option<&'a Value> {
        self.0.and_then(|attrs| attrs.get(key))
    }

    /// `a[key] ?? …`: `None` for both `undefined` and `null`.
    pub(crate) fn present(self, key: &str) -> Option<&'a Value> {
        present(self.get(key))
    }

    /// `!!a[key]`.
    pub(crate) fn truthy(self, key: &str) -> bool {
        js_truthy_opt(self.get(key))
    }

    /// `Number(a[key])`: NaN for a missing key, 0 for null.
    pub(crate) fn number(self, key: &str) -> f64 {
        js_number_opt(self.get(key))
    }

    /// `str(a[key])`: `String(value)`, or `None` for null and undefined.
    pub(crate) fn string(self, key: &str) -> Option<String> {
        self.present(key).map(js_string)
    }

    /// `String(a[key] ?? fallback)`.
    pub(crate) fn string_or(self, key: &str, fallback: &str) -> String {
        self.string(key).unwrap_or_else(|| fallback.to_string())
    }

    /// `a[key] === expected` for a string.
    pub(crate) fn is(self, key: &str, expected: &str) -> bool {
        self.get(key).and_then(Value::as_str) == Some(expected)
    }
}

/// The value of an element attribute before it is written: what the
/// TypeScript `Tag` type calls `string | number | boolean | null | undefined`.
#[derive(Debug, Clone, PartialEq)]
pub enum AttrValue {
    /// `null` or `undefined`: the attribute is left out.
    Null,
    /// `true` writes a bare attribute, `false` leaves it out.
    Bool(bool),
    /// Printed with `String(n)`; NaN and the infinities are written too.
    Number(f64),
    /// Written escaped; the empty string leaves the attribute out.
    Text(String),
}

impl From<Option<String>> for AttrValue {
    fn from(value: Option<String>) -> Self {
        value.map_or(AttrValue::Null, AttrValue::Text)
    }
}

impl From<String> for AttrValue {
    fn from(value: String) -> Self {
        AttrValue::Text(value)
    }
}

impl From<&str> for AttrValue {
    fn from(value: &str) -> Self {
        AttrValue::Text(value.to_string())
    }
}

type TagAttrs = [(&'static str, AttrValue)];

/// An element name and its attributes, in the order they are written.
#[derive(Debug, Clone, PartialEq)]
pub struct Tag {
    pub name: &'static str,
    pub attrs: Vec<(&'static str, AttrValue)>,
}

impl Tag {
    fn new(name: &'static str, attrs: Vec<(&'static str, AttrValue)>) -> Self {
        Tag { name, attrs }
    }

    /// The opening tag: `<name attr="value" …>`.
    pub fn open(&self) -> String {
        let mut out = String::new();
        open_tag(&mut out, self.name, &self.attrs);
        out
    }

    /// The closing tag: `</name>`.
    pub fn close(&self) -> String {
        format!("</{}>", self.name)
    }
}

/// `attrString`: null, undefined, `false` and `""` are dropped, `true` is a
/// bare attribute and everything else is `name="escaped value"`. A number is
/// never dropped, so `0` and NaN are written.
fn attr_string(out: &mut String, attrs: &TagAttrs) {
    for (name, value) in attrs {
        let text = match value {
            AttrValue::Null | AttrValue::Bool(false) => continue,
            AttrValue::Bool(true) => {
                out.push(' ');
                out.push_str(name);
                continue;
            }
            AttrValue::Text(text) if text.is_empty() => continue,
            AttrValue::Text(text) => escape_html(text),
            AttrValue::Number(n) => number_to_string(*n),
        };
        out.push(' ');
        out.push_str(name);
        out.push_str("=\"");
        out.push_str(&text);
        out.push('"');
    }
}

fn open_tag(out: &mut String, name: &str, attrs: &TagAttrs) {
    out.push('<');
    out.push_str(name);
    attr_string(out, attrs);
    out.push('>');
}

fn close_tag(out: &mut String, name: &str) {
    out.push_str("</");
    out.push_str(name);
    out.push('>');
}

/// `safeUrl`: a URL that may go into `href` or `src`, or `""`.
pub fn safe_url(url: Option<&Value>) -> String {
    clean_url(url, true)
}

/// A CSS color from document data, or `None` when it is anything else.
///
/// The original tests `String(value ?? "").trim()` against three patterns,
/// written out by hand here because the `regex` crate reads them differently:
/// with `i` and no `u` flag JavaScript matches ASCII letters only (the `regex`
/// crate would also accept U+017F for `s` and U+212A for `k`), and `\d` and
/// `\s` mean ASCII digits and ECMAScript white space.
pub fn safe_color(value: Option<&Value>) -> Option<String> {
    let string = present(value).map(js_string).unwrap_or_default();
    let v = js_trim(&string);
    let count = v.chars().count();
    // /^#[0-9a-f]{3,8}$/i
    let hex = v.strip_prefix('#').is_some_and(|digits| (4..=9).contains(&count) && digits.chars().all(|c| c.is_ascii_hexdigit()));
    // /^[a-z]{3,20}$/i
    let name = (3..=20).contains(&count) && v.chars().all(|c| c.is_ascii_alphabetic());
    (hex || name || is_color_function(v)).then(|| v.to_string())
}

/// `/^(rgb|hsl)a?\(\s*[\d.%\s,/-]+\)$/i`: the part between the parentheses is
/// not empty and holds only digits, white space and `. % , / -`.
fn is_color_function(v: &str) -> bool {
    let Some(prefix) = v.get(..3) else { return false };
    if !prefix.eq_ignore_ascii_case("rgb") && !prefix.eq_ignore_ascii_case("hsl") {
        return false;
    }
    let rest = &v[3..];
    let rest = rest.strip_prefix(['a', 'A']).unwrap_or(rest);
    let Some(body) = rest.strip_prefix('(').and_then(|r| r.strip_suffix(')')) else { return false };
    !body.is_empty() && body.chars().all(|c| c.is_ascii_digit() || is_js_whitespace(c) || matches!(c, '.' | '%' | ',' | '/' | '-'))
}

/// `Math.min(6, Math.max(1, Number(level) || 1))`. The result may have a
/// fraction: the HTML element name prints it, the Markdown `#` count drops it.
pub(crate) fn heading_level(level: Option<&Value>) -> f64 {
    let n = js_number_opt(level);
    let n = if n.is_nan() || n == 0.0 { 1.0 } else { n };
    n.clamp(1.0, 6.0)
}

/// `(nodes).map((c) => c.text ?? "").join("")`: the text of a code block. The
/// join is what turns a `text` that is not a string into one in JavaScript.
pub(crate) fn joined_text(nodes: &[Value]) -> String {
    let mut out = String::new();
    for node in nodes {
        match present(node.get("text")) {
            Some(Value::String(s)) => out.push_str(s),
            Some(other) => out.push_str(&js_string(other)),
            None => {}
        }
    }
    out
}

fn color_style(property: &str, color: Option<&Value>, suffix: &str) -> AttrValue {
    safe_color(color).map(|c| format!("{property}: {c}{suffix}")).into()
}

/// `a.name ? String(a.name).toLowerCase() : null`.
fn lower_name(a: Attrs, key: &str) -> AttrValue {
    if !a.truthy(key) {
        return AttrValue::Null;
    }
    a.string(key).map(|s| s.to_lowercase()).into()
}

/// `blockAttrs`: the attributes paragraphs and headings share. A heading
/// writes its id as `id`, so it asks for no `data-id`.
fn block_attrs(a: Attrs, data_id: bool) -> Vec<(&'static str, AttrValue)> {
    // `["center", "right", "justify"].includes(String(a.textAlign))`: the
    // coercion means `["center"]` aligns too.
    let align = a.get("textAlign").map(js_string).filter(|s| matches!(s.as_str(), "center" | "right" | "justify"));
    let indent = a.number("indent");
    vec![
        ("data-id", if data_id { a.string("id").into() } else { AttrValue::Null }),
        ("style", align.map(|s| format!("text-align: {s}")).into()),
        ("data-indent", if indent > 0.0 { AttrValue::Number(indent) } else { AttrValue::Null }),
    ]
}

/// `markTag`: the element a mark is written as.
pub fn mark_tag(mark: &Value) -> Tag {
    let a = Attrs::of(mark);
    match node_type(mark) {
        "bold" => Tag::new("strong", vec![]),
        "italic" => Tag::new("em", vec![]),
        "underline" => Tag::new("u", vec![]),
        "strike" => Tag::new("s", vec![]),
        "code" => Tag::new("code", vec![]),
        "subscript" => Tag::new("sub", vec![]),
        "superscript" => Tag::new("sup", vec![]),
        "link" => Tag::new(
            "a",
            vec![
                ("href", safe_url(a.get("href")).into()),
                ("target", a.string("target").into()),
                ("rel", a.string("rel").into()),
                ("class", a.string("class").into()),
                ("data-internal", if a.truthy("internal") { "true".into() } else { AttrValue::Null }),
            ],
        ),
        "highlight" => Tag::new(
            "mark",
            vec![
                ("data-color", a.string("color").into()),
                ("style", color_style("background-color", a.get("color"), "; color: inherit")),
                ("data-highlight-color-name", lower_name(a, "colorName")),
            ],
        ),
        "textStyle" => Tag::new("span", vec![("style", color_style("color", a.get("color"), ""))]),
        "comment" => {
            let resolved = a.truthy("resolved");
            let class = if resolved { "comment-mark resolved" } else { "comment-mark" };
            Tag::new(
                "span",
                vec![
                    ("class", class.into()),
                    ("data-comment-id", a.string("commentId").into()),
                    ("data-resolved", if resolved { "true".into() } else { AttrValue::Null }),
                ],
            )
        }
        _ => Tag::new("span", vec![]),
    }
}

/// `fileUrl`: the callback type of `HtmlOptions::file_url`.
pub type FileUrl<'a> = &'a dyn Fn(&str) -> String;

/// `pageHref`: the callback type of `HtmlOptions::page_href`.
pub type PageHref<'a> = &'a dyn Fn(&str, Option<&Value>) -> String;

/// What the caller may plug into the serializers.
#[derive(Clone, Copy, Default)]
pub struct HtmlOptions<'a> {
    /// Rewrites file URLs (e.g. to relative paths in an export).
    pub file_url: Option<FileUrl<'a>>,
    /// Resolves a page mention or internal link to an href: (slugId, anchorId).
    ///
    /// The anchor is what the TypeScript callback receives, with `None` for
    /// null and undefined: the HTML serializer passes `String(anchorId)`, the
    /// Markdown serializer the attribute as it is stored, of whatever type.
    pub page_href: Option<PageHref<'a>>,
}

/// `media`: a safe URL, passed through `file_url` when there is one. The
/// callback also sees the `""` an unsafe or missing URL became.
fn media(opts: &HtmlOptions, src: Option<&Value>) -> String {
    let s = safe_url(src);
    match opts.file_url {
        Some(file_url) => file_url(&s),
        None => s,
    }
}

fn inner(out: &mut String, node: &Value, opts: &HtmlOptions) {
    for child in children(node) {
        render(out, child, opts);
    }
}

/// `wrap(tag)`: the element around the node's children.
fn wrap(out: &mut String, name: &str, attrs: &TagAttrs, node: &Value, opts: &HtmlOptions) {
    open_tag(out, name, attrs);
    inner(out, node, opts);
    close_tag(out, name);
}

/// `wrap(tag, body)`: the element around HTML that is already written.
fn wrap_body(out: &mut String, name: &str, attrs: &TagAttrs, body: &str) {
    open_tag(out, name, attrs);
    out.push_str(body);
    close_tag(out, name);
}

fn render(out: &mut String, node: &Value, opts: &HtmlOptions) {
    let a = Attrs::of(node);
    let kind = node_type(node);
    match kind {
        "doc" => inner(out, node, opts),
        "text" => {
            // The first mark is the outermost element.
            let tags: Vec<Tag> = marks(node).iter().map(mark_tag).collect();
            for tag in &tags {
                open_tag(out, tag.name, &tag.attrs);
            }
            out.push_str(&escape_html(text(node)));
            for tag in tags.iter().rev() {
                close_tag(out, tag.name);
            }
        }
        "paragraph" => wrap(out, "p", &block_attrs(a, true), node, opts),
        "heading" => {
            let name = format!("h{}", number_to_string(heading_level(a.get("level"))));
            let mut attrs = vec![("id", a.string("id").into())];
            attrs.extend(block_attrs(a, false));
            wrap(out, &name, &attrs, node, opts);
        }
        "blockquote" => wrap(out, "blockquote", &[], node, opts),
        "bulletList" => wrap(out, "ul", &[], node, opts),
        "orderedList" => {
            // `Number(a.start) !== 1`: a missing start is NaN and is written.
            let start = a.number("start");
            let start = if start != 1.0 { AttrValue::Number(start) } else { AttrValue::Null };
            wrap(out, "ol", &[("start", start), ("type", a.string("type").into())], node, opts);
        }
        "listItem" => wrap(out, "li", &[], node, opts),
        "taskList" => wrap(out, "ul", &[("data-type", "taskList".into())], node, opts),
        "taskItem" => {
            let checked = if a.truthy("checked") { "true" } else { "false" };
            wrap(out, "li", &[("data-type", "taskItem".into()), ("data-checked", checked.into())], node, opts);
        }
        "codeBlock" => {
            let class = if a.truthy("language") { a.string("language").map(|l| format!("language-{l}")) } else { None };
            out.push_str("<pre>");
            open_tag(out, "code", &[("class", class.into())]);
            out.push_str(&escape_html(&joined_text(children(node))));
            out.push_str("</code></pre>");
        }
        "horizontalRule" => out.push_str("<hr>"),
        "pageBreak" => out.push_str("<div data-type=\"pageBreak\" class=\"page-break\"></div>"),
        "hardBreak" => out.push_str("<br>"),
        "image" => open_tag(
            out,
            "img",
            &[
                ("src", media(opts, a.get("src")).into()),
                ("alt", a.string("alt").into()),
                ("width", a.string("width").into()),
                ("height", a.string("height").into()),
                ("data-align", a.string("align").into()),
                ("data-attachment-id", a.string("attachmentId").into()),
                ("data-size", a.string("size").into()),
                ("data-aspect-ratio", a.string("aspectRatio").into()),
            ],
        ),
        "video" => wrap_body(
            out,
            "video",
            &[
                ("controls", AttrValue::Bool(true)),
                ("src", media(opts, a.get("src")).into()),
                ("aria-label", a.string("alt").into()),
                ("width", a.string("width").into()),
                ("height", a.string("height").into()),
                ("data-align", a.string("align").into()),
                ("data-attachment-id", a.string("attachmentId").into()),
                ("data-size", a.string("size").into()),
                ("data-aspect-ratio", a.string("aspectRatio").into()),
            ],
            "",
        ),
        "audio" => wrap_body(
            out,
            "audio",
            &[
                ("controls", AttrValue::Bool(true)),
                ("preload", "metadata".into()),
                ("src", media(opts, a.get("src")).into()),
                ("data-attachment-id", a.string("attachmentId").into()),
                ("data-size", a.string("size").into()),
            ],
            "",
        ),
        "attachment" => {
            let url = media(opts, a.get("url"));
            let name = a.string("name").unwrap_or_else(|| url.clone());
            let body = format!("<a href=\"{}\" class=\"attachment\" target=\"_blank\">{}</a>", escape_html(&url), escape_html(&name));
            wrap_body(
                out,
                "div",
                &[
                    ("data-type", "attachment".into()),
                    ("data-attachment-url", url.into()),
                    ("data-attachment-name", a.string("name").into()),
                    ("data-attachment-mime", a.string("mime").into()),
                    ("data-attachment-size", a.string("size").into()),
                    ("data-attachment-id", a.string("attachmentId").into()),
                ],
                &body,
            );
        }
        "pdf" => {
            let src = media(opts, a.get("src"));
            let body = format!(
                "<iframe src=\"{}\" width=\"{}\" height=\"{}\"></iframe>",
                escape_html(&src),
                escape_html(&a.string_or("width", "800")),
                escape_html(&a.string_or("height", "600")),
            );
            wrap_body(
                out,
                "div",
                &[
                    ("data-type", "pdf".into()),
                    ("data-name", a.string("name").into()),
                    ("data-attachment-id", a.string("attachmentId").into()),
                    ("data-size", a.string("size").into()),
                ],
                &body,
            );
        }
        "drawio" | "excalidraw" => {
            let src = media(opts, a.get("src"));
            // `String(a.alt ?? a.title ?? node.type)`
            let alt = a.string("alt").or_else(|| a.string("title")).unwrap_or_else(|| kind.to_string());
            let width = if a.truthy("width") { format!(" width=\"{}\"", escape_html(&a.string_or("width", ""))) } else { String::new() };
            let body = format!("<img src=\"{}\" alt=\"{}\"{}>", escape_html(&src), escape_html(&alt), width);
            wrap_body(
                out,
                "div",
                &[
                    ("data-type", kind.into()),
                    ("data-src", src.into()),
                    ("data-title", a.string("title").into()),
                    ("data-alt", a.string("alt").into()),
                    ("data-width", a.string("width").into()),
                    ("data-height", a.string("height").into()),
                    ("data-size", a.string("size").into()),
                    ("data-aspect-ratio", a.string("aspectRatio").into()),
                    ("data-align", a.string("align").into()),
                    ("data-attachment-id", a.string("attachmentId").into()),
                ],
                &body,
            );
        }
        "table" => {
            out.push_str("<div class=\"tableWrapper\"><table><tbody>");
            inner(out, node, opts);
            out.push_str("</tbody></table></div>");
        }
        "tableRow" => wrap(out, "tr", &[], node, opts),
        "tableCell" | "tableHeader" => {
            // `Array.isArray(a.colwidth) ? a.colwidth.join(",") : null`, and
            // `join(",")` of an array is `String` of it.
            let colwidth = a.get("colwidth").filter(|v| v.is_array()).map(js_string);
            let span = |key: &str| {
                let n = a.number(key);
                if n > 1.0 {
                    AttrValue::Number(n)
                } else {
                    AttrValue::Null
                }
            };
            wrap(
                out,
                if kind == "tableHeader" { "th" } else { "td" },
                &[
                    ("colspan", span("colspan")),
                    ("rowspan", span("rowspan")),
                    ("colwidth", colwidth.into()),
                    ("style", color_style("background-color", a.get("backgroundColor"), "")),
                    ("data-background-color", a.string("backgroundColor").into()),
                    ("data-background-color-name", lower_name(a, "backgroundColorName")),
                ],
                node,
                opts,
            );
        }
        "callout" => wrap(
            out,
            "div",
            &[
                ("data-type", "callout".into()),
                ("data-callout-type", a.string("type").into()),
                ("data-callout-icon", a.string("icon").into()),
            ],
            node,
            opts,
        ),
        "details" => wrap(out, "details", &[("open", AttrValue::Bool(a.truthy("open")))], node, opts),
        "detailsSummary" => wrap(out, "summary", &[("data-type", "detailsSummary".into())], node, opts),
        "detailsContent" => wrap(out, "div", &[("data-type", "detailsContent".into())], node, opts),
        "columns" => wrap(
            out,
            "div",
            &[
                ("data-type", "columns".into()),
                ("data-layout", a.string("layout").into()),
                ("data-width-mode", if a.is("widthMode", "wide") { "wide".into() } else { AttrValue::Null }),
            ],
            node,
            opts,
        ),
        "column" => {
            let width = a.number("width");
            let style = (width > 0.0).then(|| format!("flex: {}", number_to_string(width)));
            wrap(
                out,
                "div",
                &[("data-type", "column".into()), ("data-width", a.string("width").into()), ("style", style.into())],
                node,
                opts,
            );
        }
        "transclusionSource" => {
            wrap(out, "div", &[("data-type", "transclusionSource".into()), ("data-id", a.string("id").into())], node, opts);
        }
        "transclusionReference" => wrap_body(
            out,
            "div",
            &[
                ("data-type", "transclusionReference".into()),
                ("data-source-page-id", a.string("sourcePageId").into()),
                ("data-transclusion-id", a.string("transclusionId").into()),
            ],
            "",
        ),
        "footnotes" => wrap(out, "ol", &[("class", "footnotes".into())], node, opts),
        "footnote" => wrap(out, "li", &[("id", a.string("id").into()), ("data-id", a.string("data-id").into())], node, opts),
        "footnoteReference" => {
            let n = escape_html(&a.string_or("referenceNumber", ""));
            let id = escape_html(&a.string_or("data-id", ""));
            out.push_str(&format!(
                "<sup id=\"fnref:{n}\"><a class=\"footnote-ref\" data-id=\"{id}\" data-reference-number=\"{n}\" href=\"#fn:{n}\">{n}</a></sup>"
            ));
        }
        "mathInline" => {
            out.push_str("<span data-type=\"mathInline\" data-katex=\"true\">");
            out.push_str(&escape_html(&a.string_or("text", "")));
            out.push_str("</span>");
        }
        "mathBlock" => {
            out.push_str("<div data-type=\"mathBlock\" data-katex=\"true\">");
            out.push_str(&escape_html(&a.string_or("text", "")));
            out.push_str("</div>");
        }
        "mention" => {
            // `String(a.label ?? a.id ?? "")`
            let label = a.string("label").or_else(|| a.string("id")).unwrap_or_default();
            let attrs = [
                ("data-type", "mention".into()),
                ("class", "mention".into()),
                ("data-id", a.string("id").into()),
                ("data-label", a.string("label").into()),
                ("data-entity-type", a.string("entityType").into()),
                ("data-entity-id", a.string("entityId").into()),
                ("data-slug-id", a.string("slugId").into()),
                ("data-creator-id", a.string("creatorId").into()),
                ("data-anchor-id", a.string("anchorId").into()),
            ];
            let text = if a.is("entityType", "user") { format!("@{label}") } else { label };
            match opts.page_href {
                Some(page_href) if a.is("entityType", "page") && a.truthy("slugId") => {
                    // The callback gets `str(a.anchorId)`: a string or nothing.
                    let anchor = a.string("anchorId").map(Value::String);
                    let href = page_href(&a.string_or("slugId", ""), anchor.as_ref());
                    out.push_str("<a href=\"");
                    out.push_str(&escape_html(&href));
                    out.push('"');
                    attr_string(out, &attrs);
                    out.push('>');
                    out.push_str(&escape_html(&text));
                    out.push_str("</a>");
                }
                _ => wrap_body(out, "span", &attrs, &escape_html(&text)),
            }
        }
        "status" => wrap_body(
            out,
            "span",
            &[("data-type", "status".into()), ("data-color", a.string("color").into())],
            &escape_html(&a.string_or("text", "")),
        ),
        "embed" => {
            // Embeds point at other sites: `file_url` is not asked.
            let src = safe_url(a.get("src"));
            let body = format!("<a href=\"{0}\" target=\"_blank\">{0}</a>", escape_html(&src));
            wrap_body(
                out,
                "div",
                &[
                    ("data-type", "embed".into()),
                    ("data-src", src.into()),
                    ("data-provider", a.string("provider").into()),
                    ("data-align", a.string("align").into()),
                    ("data-width", a.string("width").into()),
                    ("data-height", a.string("height").into()),
                ],
                &body,
            );
        }
        "youtube" => {
            let body = format!(
                "<iframe src=\"{}\" width=\"{}\" height=\"{}\" allowfullscreen></iframe>",
                escape_html(&safe_url(a.get("src"))),
                escape_html(&a.string_or("width", "640")),
                escape_html(&a.string_or("height", "480")),
            );
            wrap_body(out, "div", &[("data-youtube-video", AttrValue::Bool(true))], &body);
        }
        "subpages" => out.push_str("<div data-type=\"subpages\"></div>"),
        "base" => {
            out.push_str("<div data-type=\"base-embed\" data-page-id=\"");
            out.push_str(&escape_html(&a.string_or("pageId", "")));
            out.push_str("\"></div>");
        }
        // `node.content ? … : ""`: an empty array is truthy and still gets its `<div>`.
        _ => {
            if js_truthy_opt(node.get("content")) {
                out.push_str("<div>");
                inner(out, node, opts);
                out.push_str("</div>");
            }
        }
    }
}

/// `nodeToHtml`: one node and everything below it.
pub fn node_to_html(node: &Value, opts: &HtmlOptions) -> String {
    let mut out = String::new();
    render(&mut out, node, opts);
    out
}

/// `docToHtml`: a whole document.
pub fn doc_to_html(doc: &Value, opts: &HtmlOptions) -> String {
    node_to_html(doc, opts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn html(node: Value) -> String {
        node_to_html(&node, &HtmlOptions::default())
    }

    #[test]
    fn writes_attributes_like_attr_string() {
        let tag = Tag::new(
            "x",
            vec![
                ("a", AttrValue::Null),
                ("b", AttrValue::Bool(false)),
                ("c", AttrValue::Bool(true)),
                ("d", "".into()),
                ("e", "<\"&>".into()),
                ("f", AttrValue::Number(0.0)),
                ("g", AttrValue::Number(f64::NAN)),
                ("h", AttrValue::Number(2.5)),
            ],
        );
        assert_eq!(tag.open(), "<x c e=\"&lt;&quot;&amp;&gt;\" f=\"0\" g=\"NaN\" h=\"2.5\">");
        assert_eq!(tag.close(), "</x>");
    }

    #[test]
    fn keeps_the_odd_results_of_coercion() {
        assert_eq!(html(json!({ "type": "orderedList" })), "<ol start=\"NaN\"></ol>");
        assert_eq!(html(json!({ "type": "orderedList", "attrs": { "start": null } })), "<ol start=\"0\"></ol>");
        assert_eq!(html(json!({ "type": "orderedList", "attrs": { "start": "1" } })), "<ol></ol>");
        assert_eq!(html(json!({ "type": "heading", "attrs": { "level": 2.5 } })), "<h2.5></h2.5>");
        assert_eq!(html(json!({ "type": "heading", "attrs": { "level": "9", "id": 7 } })), "<h6 id=\"7\"></h6>");
        assert_eq!(html(json!({ "type": "paragraph", "attrs": { "textAlign": ["center"], "indent": "2" } })), "<p style=\"text-align: center\" data-indent=\"2\"></p>");
        assert_eq!(html(json!({ "type": "tableCell", "attrs": { "colwidth": [100, null, [2, 3]], "colspan": "2" } })), "<td colspan=\"2\" colwidth=\"100,,2,3\"></td>");
        assert_eq!(html(json!({ "type": "nonsense" })), "");
        assert_eq!(html(json!({ "type": "nonsense", "content": [] })), "<div></div>");
    }

    #[test]
    fn accepts_only_css_colors() {
        let color = |v: Value| safe_color(Some(&v));
        assert_eq!(color(json!(" #FfF ")).as_deref(), Some("#FfF"));
        assert_eq!(color(json!("#ff")), None);
        assert_eq!(color(json!("#123456789")), None);
        assert_eq!(color(json!("RED")).as_deref(), Some("RED"));
        assert_eq!(color(json!("re\u{17f}")), None);
        assert_eq!(color(json!("\u{212a}ed")), None);
        assert_eq!(color(json!("rgb(1, 2, 3)")).as_deref(), Some("rgb(1, 2, 3)"));
        assert_eq!(color(json!("HSLA(1 2% 3% / .5)")).as_deref(), Some("HSLA(1 2% 3% / .5)"));
        assert_eq!(color(json!("rgb(\u{a0}1)")).as_deref(), Some("rgb(\u{a0}1)"));
        assert_eq!(color(json!("rgb()")), None);
        assert_eq!(color(json!("rgb(١)")), None);
        assert_eq!(color(json!("rgb(1);x")), None);
        assert_eq!(color(json!(["red"])).as_deref(), Some("red"));
        assert_eq!(color(json!(null)), None);
        assert_eq!(color(json!(true)).as_deref(), Some("true"));
        assert_eq!(safe_color(None), None);
    }

    #[test]
    fn page_mentions_link_through_the_callback() {
        let page_href = |slug: &str, anchor: Option<&Value>| format!("/x/{slug}#{}", anchor.and_then(Value::as_str).unwrap_or("-"));
        let opts = HtmlOptions { file_url: None, page_href: Some(&page_href) };
        let mention = json!({ "type": "mention", "attrs": { "entityType": "page", "slugId": "abc", "label": "A<b", "anchorId": 5 } });
        assert_eq!(
            node_to_html(&mention, &opts),
            "<a href=\"/x/abc#5\" data-type=\"mention\" class=\"mention\" data-label=\"A&lt;b\" data-entity-type=\"page\" data-slug-id=\"abc\" data-anchor-id=\"5\">A&lt;b</a>"
        );
        assert!(html(mention).starts_with("<span data-type=\"mention\""));
    }
}
