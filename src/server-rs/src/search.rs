//! Port of `src/server/lib/search.ts`.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};
use unicode_normalization::UnicodeNormalization;

use crate::db::{db, Sql};
use crate::http::Result;
use crate::jsutil::{escape_html, js_trim, take_chars, utf16_len};
use crate::pages::{to_tree_item, tree_columns};
use crate::spaces::space_ref_json;
use crate::sql;
use crate::validate::JS_SPACE;

const MAX_WORDS: usize = 8;
const WINDOW: usize = 200;
const MAX_QUERY: usize = 200;

/// Search words: letters and digits only (so they are inert in tsquery syntax), lower-cased.
pub fn search_words(query: &str) -> Vec<String> {
    static SPLIT: OnceLock<Regex> = OnceLock::new();
    let split = SPLIT.get_or_init(|| Regex::new(r"[^\p{L}\p{N}]+").expect("word pattern"));
    let normalized = query.nfkc().collect::<String>().to_lowercase();
    let mut words: Vec<String> = Vec::new();
    for word in split.split(&normalized) {
        if word.is_empty() {
            continue;
        }
        let word = take_chars(word, 50).to_string();
        if !words.contains(&word) {
            words.push(word);
        }
    }
    words.truncate(MAX_WORDS);
    words
}

/// Prefix query over every word: `w1:* & w2:*`, or `None` when there are no words.
pub fn prefix_ts_query(words: &[String]) -> Option<String> {
    if words.is_empty() {
        return None;
    }
    Some(words.iter().map(|w| format!("{w}:*")).collect::<Vec<_>>().join(" & "))
}

/// Escapes the characters `LIKE` gives meaning to, so a value matches literally.
pub fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch == '\\' || ch == '%' || ch == '_' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// UTF-16 units as a string; half of a surrogate pair cut by a window stays half.
fn units_to_string(units: &[u16]) -> String {
    crate::jsutil::from_utf16_units(units)
}

/// The search terms of one query, compiled once for every excerpt it marks.
pub struct Highlighter {
    pattern: Option<fancy_regex::Regex>,
}

impl Highlighter {
    pub fn new(words: &[String], raw_query: &str) -> Highlighter {
        let mut terms: Vec<String> = Vec::new();
        for term in std::iter::once(js_trim(raw_query).to_lowercase()).chain(words.iter().cloned()) {
            if !term.is_empty() && !terms.contains(&term) {
                terms.push(term);
            }
        }
        terms.sort_by_key(|term| std::cmp::Reverse(utf16_len(term)));
        if terms.is_empty() {
            return Highlighter { pattern: None };
        }
        let alternatives = terms.iter().map(|term| regex::escape(term)).collect::<Vec<_>>().join("|");
        // A match at the start of a word is extended to the whole word, mirroring prefix search.
        let pattern = format!(r"(?i)(?<![\p{{L}}\p{{N}}])(?:{alternatives})[\p{{L}}\p{{N}}]*|(?:{alternatives})");
        Highlighter { pattern: fancy_regex::Regex::new(&pattern).ok() }
    }

    /// A ~200 character excerpt of `text` around the first match, HTML-escaped,
    /// with every occurrence of a search word wrapped in `<mark>`.
    pub fn highlight(&self, text: Option<&str>) -> String {
        static SPACES: OnceLock<Regex> = OnceLock::new();
        let spaces = SPACES.get_or_init(|| Regex::new(&format!("[{JS_SPACE}]+")).expect("space pattern"));
        let collapsed = spaces.replace_all(text.unwrap_or(""), " ");
        let source = js_trim(&collapsed);
        if source.is_empty() {
            return String::new();
        }
        let units: Vec<u16> = crate::jsutil::utf16_units(source);
        let Some(pattern) = &self.pattern else {
            return escape_html(&units_to_string(&units[..units.len().min(WINDOW)]));
        };
        let first = pattern.find(source).ok().flatten().map(|m| utf16_len(&source[..m.start()]));
        let mut start = 0usize;
        if let Some(index) = first {
            if index * 3 > WINDOW {
                start = index - WINDOW / 3;
                if let Some(space) = units[start..].iter().position(|unit| *unit == 0x20).map(|at| at + start) {
                    if space < index {
                        start = space + 1;
                    }
                }
            }
        }
        let mut end = units.len().min(start + WINDOW);
        if end < units.len() {
            if let Some(space) = units[..=end].iter().rposition(|unit| *unit == 0x20) {
                if space > start + WINDOW / 2 {
                    end = space;
                }
            }
        }
        let excerpt = units_to_string(&units[start..end]);
        let mut html = String::new();
        let mut last = 0usize;
        for found in pattern.find_iter(&excerpt) {
            let Ok(found) = found else { break };
            html.push_str(&escape_html(&excerpt[last..found.start()]));
            html.push_str("<mark>");
            html.push_str(&escape_html(found.as_str()));
            html.push_str("</mark>");
            last = found.end();
        }
        html.push_str(&escape_html(&excerpt[last..]));
        format!("{}{}{}", if start > 0 { "…" } else { "" }, html, if end < units.len() { "…" } else { "" })
    }
}

/// `highlight(text, words, rawQuery)`.
pub fn highlight(text: Option<&str>, words: &[String], raw_query: &str) -> String {
    Highlighter::new(words, raw_query).highlight(text)
}

pub struct SearchOptions {
    pub query: String,
    /// SQL condition restricting which pages (aliased `p`) may match.
    pub scope: Sql,
    pub title_only: bool,
    pub limit: i64,
    pub offset: i64,
}

/// Full-text prefix search over titles and text, with a substring fallback so
/// text without word boundaries (e.g. CJK) still matches. Each result is a tree
/// item with `space`, `highlight` and `updatedAt`.
pub async fn search_pages(options: SearchOptions) -> Result<Vec<Map<String, Value>>> {
    let raw = take_chars(js_trim(&options.query), MAX_QUERY).to_string();
    let words = search_words(&raw);
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let tsquery = prefix_ts_query(&words);
    let lower = raw.to_lowercase();
    let like = format!("%{}%", escape_like(&lower));
    let first = words.first().cloned().unwrap_or_else(|| lower.clone());
    let vector = Sql::raw(if options.title_only { "to_tsvector('simple', coalesce(p.title, ''))" } else { "p.search" });
    let snippet = if options.title_only {
        Sql::raw("p.title")
    } else {
        sql!("substring(p.text_content FROM greatest(1, strpos(lower(p.text_content), {}) - 100) FOR 400)", &first)
    };
    let mut rows = db()
        .query(sql!(
            "SELECT {}, p.updated_at, {} AS space, {} AS snippet
             FROM pages p JOIN spaces s ON s.id = p.space_id
             LEFT JOIN LATERAL (SELECT CASE WHEN {}::text IS NULL THEN NULL ELSE to_tsquery('simple', {}) END AS q) query ON true
             WHERE p.deleted_at IS NULL AND {}
               AND ((query.q IS NOT NULL AND {} @@ query.q) OR lower(coalesce(p.title, '')) LIKE {})
             ORDER BY lower(coalesce(p.title, '')) = {} DESC,
               coalesce(ts_rank({}, query.q), 0) DESC, p.updated_at DESC, p.id
             LIMIT {} OFFSET {}",
            tree_columns(),
            space_ref_json("s"),
            snippet,
            tsquery.clone(),
            tsquery,
            &options.scope,
            &vector,
            &like,
            &lower,
            &vector,
            options.limit,
            options.offset
        ))
        .await?;
    if rows.is_empty() && !options.title_only && options.offset == 0 {
        rows = db()
            .query(sql!(
                "SELECT {}, p.updated_at, {} AS space,
                   substring(p.text_content FROM greatest(1, strpos(lower(p.text_content), {}) - 100) FOR 400) AS snippet
                 FROM pages p JOIN spaces s ON s.id = p.space_id
                 WHERE p.deleted_at IS NULL AND {} AND p.text_content ILIKE {}
                 ORDER BY p.updated_at DESC, p.id LIMIT {}",
                tree_columns(),
                space_ref_json("s"),
                &lower,
                &options.scope,
                &like,
                options.limit.min(20)
            ))
            .await?;
    }
    let marker = Highlighter::new(&words, &raw);
    Ok(rows
        .iter()
        .map(|row| {
            let from_text = marker.highlight(row.opt_str("snippet").as_deref());
            let title = row.opt_str("title").filter(|title| !title.is_empty());
            let shown = match title {
                Some(title) if !from_text.contains("<mark>") => {
                    let from_title = marker.highlight(Some(&title));
                    if from_title.is_empty() {
                        from_text
                    } else {
                        from_title
                    }
                }
                _ => from_text,
            };
            let mut item = to_tree_item(row);
            item.insert("space".into(), row.json("space"));
            item.insert("highlight".into(), Value::String(shown));
            item.insert("updatedAt".into(), Value::String(row.iso("updated_at")));
            item
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn splits_words() {
        assert_eq!(search_words("Hello, WORLD! hello"), words(&["hello", "world"]));
        assert_eq!(search_words("ｆｕｌｌ width"), words(&["full", "width"]));
        assert_eq!(search_words("a b c d e f g h i j").len(), 8);
        assert_eq!(search_words("  ..  "), Vec::<String>::new());
        assert_eq!(prefix_ts_query(&words(&["a", "b"])).as_deref(), Some("a:* & b:*"));
        assert_eq!(prefix_ts_query(&[]), None);
    }

    #[test]
    fn marks_matches() {
        assert_eq!(highlight(Some("Hello world"), &words(&["wor"]), "wor"), "Hello <mark>world</mark>");
        assert_eq!(highlight(Some("a <b> hello"), &words(&["hello"]), "hello"), "a &lt;b&gt; <mark>hello</mark>");
        assert_eq!(highlight(Some("  spaced \n out  "), &[], ""), "spaced out");
        assert_eq!(highlight(None, &words(&["x"]), "x"), "");
        assert_eq!(highlight(Some("unworldly"), &words(&["world"]), "world"), "un<mark>world</mark>ly");
    }
}
