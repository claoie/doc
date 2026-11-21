//! Port of the serializer half of `src/common/editor/markdown.ts`: everything
//! up to and including `docToMarkdown`.
//!
//! The parser (`markdownToDoc`, `looksLikeMarkdown` and what they use) runs
//! only in the browser, for paste and import, and is not ported.
//!
//! The output is byte for byte what the TypeScript writes; `html.rs` explains
//! how attributes of an unexpected JSON type are coerced and which shapes of
//! a tree are read as "field missing". What is particular to this file:
//!
//! - The regular expressions are written out by hand. JavaScript's `\s` is
//!   `jsutil::is_js_whitespace` (it has U+00A0 and U+FEFF and lacks U+0085),
//!   `\d` is an ASCII digit, and `\$(?=\S)` needs a lookahead the `regex`
//!   crate does not have.
//! - Lengths that end up in the output (`" ".repeat(marker.length)`) are of
//!   ASCII strings, so bytes and UTF-16 units agree.
//! - `encodeURIComponent` leaves `(` and `)` alone, so although link targets
//!   are passed through a replacement of `[()\s]`, only white space is
//!   percent-encoded. That is kept.
//! - `type in MARK_SYNTAX` is true for the names every JavaScript object
//!   inherits (`constructor`, `toString`, `__proto__`, …), and the server
//!   stores a mark of such a type (its own check is an `in` as well). Such a
//!   mark writes nothing but takes part in the bookkeeping: it sorts before
//!   every real mark and can make the marks after it close and reopen.
//! - A table without rows makes the original throw a `TypeError`
//!   (`head!.join` of `undefined`), which the Bun export answers with a 500.
//!   `try_doc_to_markdown` reports it as an error; `doc_to_markdown` writes
//!   such a table as HTML, the way tables that do not fit Markdown are
//!   written, and never fails.

use std::cell::Cell;
use std::fmt;

use serde_json::Value;

use super::html::{heading_level, joined_text, node_to_html, Attrs, HtmlOptions};
use super::model::{self, children, marks, node_type};
use crate::jsutil::{decode_uri_component, encode_uri_component, is_js_whitespace, js_json, js_number, js_number_opt, js_string, js_trim, number_to_string, present};

/// The callbacks of the HTML serializer, which complex tables fall back to.
///
/// `page_href` receives the `anchorId` attribute as it is stored (a string, a
/// number, anything), or `None` when it is null or missing; `file_url` is
/// asked for media sources and for link targets under `/api/files/`.
pub type MarkdownOptions<'a> = HtmlOptions<'a>;

/// Where the TypeScript serializer throws instead of answering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkdownError {
    /// The document has a table without a single row. A row without cells is
    /// fine, and so is a table that is written as HTML because of a merged or
    /// multi-block cell.
    TableWithoutRows,
}

impl fmt::Display for MarkdownError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MarkdownError::TableWithoutRows => f.write_str("a table without rows cannot be written as Markdown"),
        }
    }
}

impl std::error::Error for MarkdownError {}

/// `escapeText`: three replacements, each over the result of the one before.
fn escape_text(text: &str) -> String {
    // .replace(/[\\`*_[\]<>~|]/g, (c) => "\\" + c)
    let mut escaped = String::with_capacity(text.len() + 8);
    for ch in text.chars() {
        if matches!(ch, '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '~' | '|') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    // .replace(/==/g, "\\==")
    let escaped = escaped.replace("==", "\\==");
    // .replace(/\$(?=\S)/g, "\\$"): a dollar sign with something other than
    // white space after it. The backslashes added above count as "something".
    let mut out = String::with_capacity(escaped.len() + 8);
    let mut chars = escaped.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '$' && chars.peek().is_some_and(|next| !is_js_whitespace(*next)) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// `escapeLineStart`: `/^(\s*)(#{1,6}\s|[-+]\s|\d+[.)]\s|>)/`, with a
/// backslash put between the white space and the token.
fn escape_line_start(line: &str) -> String {
    let rest = line.trim_start_matches(is_js_whitespace);
    if !starts_with_block_token(rest) {
        return line.to_string();
    }
    let indent = &line[..line.len() - rest.len()];
    format!("{indent}\\{rest}")
}

fn starts_with_block_token(rest: &str) -> bool {
    let space_at = |index: usize| rest[index..].chars().next().is_some_and(is_js_whitespace);
    match rest.chars().next() {
        Some('>') => true,
        Some('-' | '+') => space_at(1),
        // `#{1,6}\s`: seven or more never match, whatever follows.
        Some('#') => {
            let hashes = rest.bytes().take_while(|b| *b == b'#').count();
            hashes <= 6 && space_at(hashes)
        }
        // `\d+[.)]\s`
        Some(c) if c.is_ascii_digit() => {
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            matches!(rest.as_bytes().get(digits), Some(b'.' | b')')) && space_at(digits + 1)
        }
        _ => false,
    }
}

/// `MARK_SYNTAX[type]`, for every `type in MARK_SYNTAX`: the seven marks
/// Markdown has syntax for, and the property names the object inherits from
/// `Object.prototype`, whose "syntax" reads as two empty strings.
fn mark_syntax(mark_type: &str) -> Option<(&'static str, &'static str)> {
    Some(match mark_type {
        "bold" => ("**", "**"),
        "italic" => ("*", "*"),
        "strike" => ("~~", "~~"),
        "highlight" => ("==", "=="),
        "underline" => ("<u>", "</u>"),
        "subscript" => ("<sub>", "</sub>"),
        "superscript" => ("<sup>", "</sup>"),
        "toString" | "toLocaleString" | "valueOf" | "hasOwnProperty" | "propertyIsEnumerable" | "isPrototypeOf"
        | "__defineGetter__" | "__defineSetter__" | "__lookupGetter__" | "__lookupSetter__" | "__proto__" | "constructor" => ("", ""),
        _ => return None,
    })
}

/// `MARK_ORDER.indexOf(type)`: -1 for a type that is not in the list.
fn mark_order(mark_type: &str) -> i32 {
    match mark_type {
        "link" => 0,
        "bold" => 1,
        "italic" => 2,
        "strike" => 3,
        "highlight" => 4,
        "underline" => 5,
        "subscript" => 6,
        "superscript" => 7,
        _ => -1,
    }
}

/// A mark the inline serializer keeps track of.
#[derive(Clone)]
struct InlineMark<'d> {
    mark_type: &'d str,
    /// `JSON.stringify(mark.attrs ?? {})`, which is what two marks are compared by.
    attrs_json: String,
    /// `mark.attrs?.href`.
    href: Option<&'d Value>,
}

/// `sameMarkLoose`.
fn same_mark_loose(a: &InlineMark, b: &InlineMark) -> bool {
    a.mark_type == b.mark_type && a.attrs_json == b.attrs_json
}

/// `relevant(marks)`: the marks Markdown can express, in `MARK_ORDER`. Both
/// sorts are stable, so marks of the same rank keep their order.
fn relevant(marks: &[Value]) -> Vec<InlineMark<'_>> {
    let mut out: Vec<InlineMark> = marks
        .iter()
        .filter_map(|mark| {
            let mark_type = node_type(mark);
            (mark_syntax(mark_type).is_some() || mark_type == "link").then(|| InlineMark {
                mark_type,
                attrs_json: present(mark.get("attrs")).map_or_else(|| "{}".to_string(), js_json),
                href: Attrs::of(mark).get("href"),
            })
        })
        .collect();
    out.sort_by_key(|mark| mark_order(mark.mark_type));
    out
}

fn open_mark(mark: &InlineMark) -> &'static str {
    if mark.mark_type == "link" {
        return "[";
    }
    mark_syntax(mark.mark_type).map_or("", |(open, _)| open)
}

/// `.replace(/[()\s]/g, (c) => encodeURIComponent(c))`. `encodeURIComponent`
/// does not touch parentheses, so this encodes white space only.
fn encode_link_target(target: &str) -> String {
    let mut out = String::with_capacity(target.len());
    let mut buffer = [0u8; 4];
    for ch in target.chars() {
        if ch == '(' || ch == ')' || is_js_whitespace(ch) {
            out.push_str(&encode_uri_component(ch.encode_utf8(&mut buffer)));
        } else {
            out.push(ch);
        }
    }
    out
}

/// `indentLines`: `first` before the first line, `rest` before every other
/// line that is not empty.
fn indent_lines(text: &str, first: &str, rest: &str) -> String {
    let mut out = String::with_capacity(text.len() + first.len());
    for (i, line) in text.split('\n').enumerate() {
        if i == 0 {
            out.push_str(first);
        } else {
            out.push('\n');
            if !line.is_empty() {
                out.push_str(rest);
            }
        }
        out.push_str(line);
    }
    out
}

/// `Number(cell.attrs?.[key] ?? 1) === 1`.
fn spans_one(cell: &Value, key: &str) -> bool {
    Attrs::of(cell).present(key).is_none_or(|v| js_number(v) == 1.0)
}

/// `isSimpleTable`: no merged cells, and at most one paragraph in each cell.
fn is_simple_table(table: &Value) -> bool {
    children(table).iter().all(|row| {
        children(row).iter().all(|cell| {
            let blocks = children(cell);
            spans_one(cell, "colspan") && spans_one(cell, "rowspan") && blocks.len() <= 1 && blocks.iter().all(|b| node_type(b) == "paragraph")
        })
    })
}

fn is_list(node_type: &str) -> bool {
    matches!(node_type, "bulletList" | "orderedList" | "taskList")
}

/// `Number(a.start) || 1`.
fn list_start(start: Option<&Value>) -> f64 {
    let n = js_number_opt(start);
    if n.is_nan() || n == 0.0 {
        1.0
    } else {
        n
    }
}

/// `decodeURIComponentSafe`: the text as it is when it does not decode.
fn decode_uri_component_safe(s: String) -> String {
    decode_uri_component(&s).unwrap_or(s)
}

/// `.replace(/\n{3,}/g, "\n\n")`.
fn collapse_blank_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut newlines = 0;
    for ch in text.chars() {
        if ch == '\n' {
            newlines += 1;
            if newlines > 2 {
                continue;
            }
        } else {
            newlines = 0;
        }
        out.push(ch);
    }
    out
}

struct Serializer<'o, 'f> {
    opts: &'o MarkdownOptions<'f>,
    /// Set when a table without rows was written, where JavaScript throws.
    rowless_table: Cell<bool>,
}

impl Serializer<'_, '_> {
    /// `fileUrl`: a media source, through the callback, with white space encoded.
    fn file_url(&self, src: &str) -> String {
        match self.opts.file_url {
            Some(file_url) => encode_link_target(&file_url(src)),
            None => encode_link_target(src),
        }
    }

    /// `linkHref`: only targets under `/api/files/` go through the callback.
    fn link_href(&self, href: Option<&Value>) -> String {
        let s = present(href).map(js_string).unwrap_or_default();
        match self.opts.file_url {
            Some(file_url) if s.starts_with("/api/files/") => encode_link_target(&file_url(&s)),
            _ => encode_link_target(&s),
        }
    }

    fn close_mark(&self, mark: &InlineMark) -> String {
        if mark.mark_type == "link" {
            return format!("]({})", self.link_href(mark.href));
        }
        mark_syntax(mark.mark_type).map_or("", |(_, close)| close).to_string()
    }

    /// `transition`: closes the open marks that do not continue into `next`,
    /// innermost first, and opens the new ones.
    fn transition<'d>(&self, out: &mut String, open: &mut Vec<InlineMark<'d>>, next: Vec<InlineMark<'d>>) {
        let mut keep = 0;
        while keep < open.len() && keep < next.len() && same_mark_loose(&open[keep], &next[keep]) {
            keep += 1;
        }
        for mark in open[keep..].iter().rev() {
            out.push_str(&self.close_mark(mark));
        }
        for mark in &next[keep..] {
            out.push_str(open_mark(mark));
        }
        *open = next;
    }

    /// `inlineToMarkdown`.
    fn inline(&self, nodes: &[Value]) -> String {
        let mut out = String::new();
        let mut open: Vec<InlineMark> = Vec::new();
        for node in nodes {
            if node_type(node) != "text" {
                // A hard break keeps the marks open (`transition(open)` changes nothing).
                if node_type(node) != "hardBreak" {
                    self.transition(&mut out, &mut open, Vec::new());
                }
                out.push_str(&self.inline_atom(node));
                continue;
            }
            let next = relevant(marks(node));
            let is_code = marks(node).iter().any(|mark| node_type(mark) == "code");
            let mut text = model::text(node);
            // Emphasis markers cannot sit next to whitespace; move it outside.
            // `/^\s+/` and `/\s+$/` are matched separately, so text that is
            // nothing but white space is written twice, around empty markers.
            let (lead, trail) = if next.is_empty() {
                ("", "")
            } else {
                let after_lead = text.trim_start_matches(is_js_whitespace);
                let before_trail = text.trim_end_matches(is_js_whitespace);
                (&text[..text.len() - after_lead.len()], &text[before_trail.len()..])
            };
            if !lead.is_empty() || !trail.is_empty() {
                let kept = open.iter().filter(|mark| next.iter().any(|n| same_mark_loose(mark, n))).cloned().collect();
                self.transition(&mut out, &mut open, kept);
                out.push_str(lead);
                // text.slice(lead.length, text.length - trail.length)
                text = if lead.len() == text.len() { "" } else { &text[lead.len()..text.len() - trail.len()] };
            }
            self.transition(&mut out, &mut open, next);
            if is_code {
                let ticks = if text.contains('`') { "``" } else { "`" };
                let pad = if text.starts_with('`') || text.ends_with('`') { " " } else { "" };
                out.push_str(ticks);
                out.push_str(pad);
                out.push_str(text);
                out.push_str(pad);
                out.push_str(ticks);
            } else {
                out.push_str(&escape_text(text));
            }
            if !trail.is_empty() {
                self.transition(&mut out, &mut open, Vec::new());
                out.push_str(trail);
            }
        }
        self.transition(&mut out, &mut open, Vec::new());
        out
    }

    /// `inlineAtom`: an inline node that is not text.
    fn inline_atom(&self, node: &Value) -> String {
        let a = Attrs::of(node);
        match node_type(node) {
            "hardBreak" => "\\\n".to_string(),
            "mathInline" => format!("${}$", a.string_or("text", "")),
            "mention" => {
                let label = a.string_or("label", "");
                if a.is("entityType", "user") {
                    return format!("@{label}");
                }
                match self.opts.page_href {
                    // The anchor goes to the callback as it is stored, not as a string.
                    Some(page_href) if a.truthy("slugId") => {
                        format!("[{}]({})", escape_text(&label), page_href(&a.string_or("slugId", ""), a.present("anchorId")))
                    }
                    _ => escape_text(&label),
                }
            }
            "status" => escape_text(&a.string_or("text", "")),
            "footnoteReference" => {
                format!("[^{}]", a.string("referenceNumber").or_else(|| a.string("data-id")).unwrap_or_default())
            }
            _ => String::new(),
        }
    }

    /// `blocksToMarkdown`.
    fn blocks(&self, nodes: &[Value], tight: bool) -> String {
        let blocks: Vec<String> = nodes.iter().map(|node| self.block(node)).collect();
        blocks.join(if tight { "\n" } else { "\n\n" })
    }

    /// `blockToMarkdown`.
    fn block(&self, node: &Value) -> String {
        let a = Attrs::of(node);
        let content = children(node);
        let kind = node_type(node);
        match kind {
            "paragraph" => self.inline(content).split('\n').map(escape_line_start).collect::<Vec<_>>().join("\n"),
            "heading" => {
                // `"#".repeat(level)` drops the fraction a level may have.
                let level = heading_level(a.get("level")) as usize;
                format!("{} {}", "#".repeat(level), self.inline(content).replace("\\\n", " "))
            }
            "blockquote" => self
                .blocks(content, false)
                .split('\n')
                .map(|line| if line.is_empty() { ">".to_string() } else { format!("> {line}") })
                .collect::<Vec<_>>()
                .join("\n"),
            "bulletList" | "taskList" | "orderedList" => {
                let ordered = kind == "orderedList";
                let start = list_start(a.get("start"));
                let tight = content.iter().all(|item| {
                    let blocks = children(item);
                    blocks.len() <= 1 || blocks[1..].iter().all(|block| is_list(node_type(block)))
                });
                let items: Vec<String> = content
                    .iter()
                    .enumerate()
                    .map(|(i, item)| {
                        // `${start + i}. `: the number prints as JavaScript prints it.
                        let number = format!("{}. ", number_to_string(start + i as f64));
                        let mut marker = if ordered { number.clone() } else { "- ".to_string() };
                        if node_type(item) == "taskItem" {
                            marker.push_str(if Attrs::of(item).truthy("checked") { "[x] " } else { "[ ] " });
                        }
                        let body = self.blocks(children(item), tight);
                        indent_lines(&body, &marker, &" ".repeat(if ordered { number.len() } else { 2 }))
                    })
                    .collect();
                items.join(if tight { "\n" } else { "\n\n" })
            }
            "codeBlock" => {
                let text = joined_text(content);
                let fence = if text.contains("```") { "````" } else { "```" };
                format!("{fence}{}\n{text}\n{fence}", a.string_or("language", ""))
            }
            "horizontalRule" => "---".to_string(),
            "pageBreak" => "<div data-type=\"pageBreak\"></div>".to_string(),
            "image" | "drawio" | "excalidraw" => {
                let alt = a.string("alt").or_else(|| a.string("title")).unwrap_or_default();
                format!("![{}]({})", escape_text(&alt), self.file_url(&a.string_or("src", "")))
            }
            "video" | "audio" | "pdf" => {
                let src = a.string_or("src", "");
                // `a.alt ?? a.name ?? src.split("/").pop()`: the last path
                // segment is always a string, so the type is never the name.
                let name = a.string("alt").or_else(|| a.string("name")).unwrap_or_else(|| src.rsplit('/').next().unwrap_or("").to_string());
                format!("[{}]({})", escape_text(&decode_uri_component_safe(name)), self.file_url(&src))
            }
            "attachment" => {
                format!("[{}]({})", escape_text(&a.string_or("name", "file")), self.file_url(&a.string_or("url", "")))
            }
            "embed" | "youtube" => {
                let src = a.string_or("src", "");
                format!("[{}]({})", escape_text(&src), src)
            }
            "mathBlock" => format!("$$\n{}\n$$", a.string_or("text", "")),
            "callout" => format!(":::{}\n{}\n:::", a.string_or("type", "info"), self.blocks(content, false)),
            "details" => {
                let part = |part_type: &str| content.iter().find(|child| node_type(child) == part_type).map_or(&[][..], children);
                format!(
                    "<details>\n<summary>{}</summary>\n\n{}\n\n</details>",
                    self.inline(part("detailsSummary")),
                    self.blocks(part("detailsContent"), false)
                )
            }
            "table" => self.table(node),
            "footnotes" => content
                .iter()
                .enumerate()
                .map(|(i, footnote)| indent_lines(&self.blocks(children(footnote), false), &format!("[^{}]: ", i + 1), "    "))
                .collect::<Vec<_>>()
                .join("\n"),
            "transclusionReference" | "subpages" | "base" => String::new(),
            // "columns", "column", "transclusionSource", "detailsContent" and
            // every other type: the blocks inside, or nothing.
            _ => self.blocks(content, false),
        }
    }

    fn table(&self, node: &Value) -> String {
        if !is_simple_table(node) {
            return node_to_html(node, self.opts);
        }
        let rows: Vec<Vec<String>> = children(node)
            .iter()
            .map(|row| {
                children(row)
                    .iter()
                    .map(|cell| {
                        // cell.content?.[0]?.content ?? []
                        let inline = children(cell).first().map_or(&[][..], children);
                        self.inline(inline).replace("\\\n", "<br>").replace('|', "\\|").replace('\n', " ")
                    })
                    .collect()
            })
            .collect();
        // `Math.max(...[])` is -Infinity and nothing is padded; the original
        // then fails on the missing header row.
        let Some(width) = rows.iter().map(Vec::len).max() else {
            self.rowless_table.set(true);
            return node_to_html(node, self.opts);
        };
        let line = |cells: &[String]| {
            let mut padded: Vec<&str> = cells.iter().map(String::as_str).collect();
            padded.resize(width, "");
            format!("| {} |", padded.join(" | "))
        };
        let mut lines = Vec::with_capacity(rows.len() + 1);
        lines.push(line(&rows[0]));
        lines.push(format!("| {} |", vec!["---"; width].join(" | ")));
        lines.extend(rows[1..].iter().map(|row| line(row)));
        lines.join("\n")
    }
}

fn serialize(doc: &Value, opts: &MarkdownOptions) -> (String, bool) {
    let serializer = Serializer { opts, rowless_table: Cell::new(false) };
    let body = serializer.blocks(children(doc), false);
    let markdown = format!("{}\n", js_trim(&collapse_blank_lines(&body)));
    (markdown, serializer.rowless_table.get())
}

/// `docToMarkdown`, for every document the original answers for. A table
/// without rows, where the original throws, is written as HTML:
/// `<div class="tableWrapper"><table><tbody></tbody></table></div>`.
pub fn doc_to_markdown(doc: &Value, opts: &MarkdownOptions) -> String {
    serialize(doc, opts).0
}

/// `docToMarkdown`, with an error where the original throws.
pub fn try_doc_to_markdown(doc: &Value, opts: &MarkdownOptions) -> Result<String, MarkdownError> {
    match serialize(doc, opts) {
        (_, true) => Err(MarkdownError::TableWithoutRows),
        (markdown, false) => Ok(markdown),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn md(content: Value) -> String {
        doc_to_markdown(&json!({ "type": "doc", "content": content }), &MarkdownOptions::default())
    }

    fn text(text: &str, marks: Value) -> Value {
        json!({ "type": "text", "text": text, "marks": marks })
    }

    #[test]
    fn escapes_text() {
        assert_eq!(escape_text(r"a\b`c*d_e[f]g<h>i~j|k"), r"a\\b\`c\*d\_e\[f\]g\<h\>i\~j\|k");
        assert_eq!(escape_text("a==b===c====d"), r"a\==b\===c\==\==d");
        assert_eq!(escape_text("$1 $ $\u{a0}x $* 5$"), "\\$1 $ $\u{a0}x \\$\\* 5$");
        assert_eq!(escape_text("$\u{85}"), "\\$\u{85}");
    }

    #[test]
    fn escapes_line_starts() {
        for (line, escaped) in [
            ("# a", "\\# a"),
            ("  ###### a", "  \\###### a"),
            ("####### a", "####### a"),
            ("#a", "#a"),
            ("#", "#"),
            ("- a", "\\- a"),
            ("+\ta", "\\+\ta"),
            ("-a", "-a"),
            ("* a", "* a"),
            ("12. a", "\\12. a"),
            ("12) a", "\\12) a"),
            ("12.a", "12.a"),
            ("12 a", "12 a"),
            ("١. a", "١. a"),
            (">a", "\\>a"),
            ("\u{a0}\u{feff}> a", "\u{a0}\u{feff}\\> a"),
            ("\u{85}> a", "\u{85}> a"),
            ("1.\u{2028}", "\\1.\u{2028}"),
            ("", ""),
        ] {
            assert_eq!(escape_line_start(line), escaped, "{line:?}");
        }
    }

    #[test]
    fn moves_white_space_out_of_marks() {
        let bold = json!([{ "type": "bold" }]);
        assert_eq!(md(json!([{ "type": "paragraph", "content": [text("a", json!([])), text(" b ", bold.clone()), text("c", json!([]))] }])), "a **b** c\n");
        // White space alone is written before and after the empty markers.
        assert_eq!(md(json!([{ "type": "paragraph", "content": [text("a", json!([])), text(" ", bold), text("c", json!([]))] }])), "a **** c\n");
    }

    #[test]
    fn inherited_names_count_as_marks() {
        let content = json!([{ "type": "paragraph", "content": [
            text("a", json!([{ "type": "bold" }])),
            text("b", json!([{ "type": "bold" }, { "type": "constructor" }])),
        ] }]);
        assert_eq!(md(content), "**a****b**\n");
    }

    #[test]
    fn marks_compare_by_their_json() {
        // JSON.stringify lists integer-like keys first, so these two are the same mark;
        // the third is not (`1` and `"1"` differ).
        let a: Value = serde_json::from_str(r#"{ "type": "bold", "attrs": { "b": 1, "2": 1.0 } }"#).unwrap();
        let b: Value = serde_json::from_str(r#"{ "type": "bold", "attrs": { "2": 1, "b": 1 } }"#).unwrap();
        let c: Value = serde_json::from_str(r#"{ "type": "bold", "attrs": { "2": 1, "b": "1" } }"#).unwrap();
        let content = json!([{ "type": "paragraph", "content": [text("a", json!([a])), text("b", json!([b])), text("c", json!([c]))] }]);
        assert_eq!(md(content), "**ab****c**\n");
    }

    #[test]
    fn link_targets_keep_parentheses() {
        let link = json!([{ "type": "link", "attrs": { "href": "http://a/b (c)\td\u{a0}e" } }]);
        assert_eq!(md(json!([{ "type": "paragraph", "content": [text("x", link)] }])), "[x](http://a/b%20(c)%09d%C2%A0e)\n");
    }

    #[test]
    fn numbers_print_like_javascript() {
        let item = |t: &str| json!({ "type": "listItem", "content": [{ "type": "paragraph", "content": [text(t, json!([]))] }, { "type": "paragraph", "content": [text("more", json!([]))] }] });
        let list = json!([{ "type": "orderedList", "attrs": { "start": 9.5 }, "content": [item("x"), item("y")] }]);
        assert_eq!(md(list), "9.5. x\n\n     more\n\n10.5. y\n\n      more\n");
        assert_eq!(md(json!([{ "type": "heading", "attrs": { "level": 2.9 }, "content": [text("x", json!([]))] }])), "## x\n");
    }

    #[test]
    fn tables_without_rows_are_an_error_or_html() {
        let doc = json!({ "type": "doc", "content": [{ "type": "table" }] });
        let opts = MarkdownOptions::default();
        assert_eq!(try_doc_to_markdown(&doc, &opts), Err(MarkdownError::TableWithoutRows));
        assert_eq!(doc_to_markdown(&doc, &opts), "<div class=\"tableWrapper\"><table><tbody></tbody></table></div>\n");
        let empty_row = json!({ "type": "doc", "content": [{ "type": "table", "content": [{ "type": "tableRow" }] }] });
        assert_eq!(try_doc_to_markdown(&empty_row, &opts).as_deref(), Ok("|  |\n|  |\n"));
        let ragged = json!({ "type": "doc", "content": [{ "type": "table", "content": [{ "type": "tableRow" }, { "type": "tableRow", "content": [{ "type": "tableCell" }] }] }] });
        assert_eq!(try_doc_to_markdown(&ragged, &opts).as_deref(), Ok("|  |\n| --- |\n|  |\n"));
    }

    #[test]
    fn collapses_blank_lines() {
        assert_eq!(collapse_blank_lines("a\n\n\n\nb\n\nc\nd\n\n\n"), "a\n\nb\n\nc\nd\n\n");
    }
}
