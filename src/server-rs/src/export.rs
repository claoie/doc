//! Port of `src/server/lib/export.ts`.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};

use hyper::Response;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::bases::{base_text, BaseText};
use crate::common::editor::html::{doc_to_html, HtmlOptions};
use crate::common::editor::markdown::try_doc_to_markdown;
use crate::common::editor::model::{children, marks, node_type};
use crate::common::text::{page_path, page_slug_id_from_href};
use crate::config::config;
use crate::content::{parse_file_url_str, rewrite_links};
use crate::db::{array, db};
use crate::files::try_content_disposition;
use crate::http::{full_body, response, AppError, Body, Result};
use crate::jsutil::{decode_uri_component, encode_uri_component, escape_html, has_lone_surrogate, is_regex_space, js_slice, js_string, js_trim, js_truthy};
use crate::logger;
use crate::sql;
use crate::storage::{self, safe_file_name, stream_body, ByteStream};
use crate::zip::ZipWriter;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Markdown,
    Html,
}

impl ExportFormat {
    pub fn parse(value: Option<&str>) -> ExportFormat {
        if value == Some("html") {
            ExportFormat::Html
        } else {
            ExportFormat::Markdown
        }
    }

    fn extension(self) -> &'static str {
        match self {
            ExportFormat::Markdown => "md",
            ExportFormat::Html => "html",
        }
    }
}

struct ExportPage {
    id: String,
    slug_id: String,
    parent_id: Option<String>,
    title: Option<String>,
    is_base: bool,
    /// Directory segments inside the archive.
    dir: Vec<String>,
    /// Base name (no extension), unique within its directory.
    base: String,
}

const CONTENT_BATCH: usize = 50;

fn export_name(title: Option<&str>) -> String {
    let title = title.filter(|title| !title.is_empty()).unwrap_or("Untitled");
    let replaced: String = title.chars().map(|c| if matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c }).collect();
    let safe = safe_file_name(replaced.trim_end_matches(|c: char| c == '.' || is_regex_space(c)));
    let cut = js_slice(&safe, 0, Some(100));
    let name = js_trim(&cut);
    if name.is_empty() {
        "Untitled".to_string()
    } else {
        name.to_string()
    }
}

fn encode_path(parts: &[String]) -> String {
    parts.iter().map(|part| encode_uri_component(part)).collect::<Vec<_>>().join("/")
}

/// Assigns directory paths so each page with children gets a folder of the same name.
fn layout(mut rows: Vec<ExportPage>, root_ids: &HashSet<String>) -> Vec<ExportPage> {
    let mut by_parent: HashMap<Option<String>, Vec<usize>> = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        let key = if root_ids.contains(&row.id) { None } else { row.parent_id.clone() };
        by_parent.entry(key).or_default().push(index);
    }
    fn visit(parent: Option<String>, dir: Vec<String>, by_parent: &HashMap<Option<String>, Vec<usize>>, rows: &mut [ExportPage], order: &mut Vec<usize>) {
        let mut used: HashSet<String> = HashSet::new();
        for &index in by_parent.get(&parent).map(Vec::as_slice).unwrap_or(&[]) {
            let name = export_name(rows[index].title.as_deref());
            let mut base = name.clone();
            let mut n = 1;
            while used.contains(&base.to_lowercase()) || base.to_lowercase() == "files" {
                base = format!("{name} ({n})");
                n += 1;
            }
            used.insert(base.to_lowercase());
            rows[index].dir = dir.clone();
            rows[index].base = base.clone();
            order.push(index);
            let id = rows[index].id.clone();
            if by_parent.contains_key(&Some(id.clone())) {
                let mut below = dir.clone();
                below.push(base);
                visit(Some(id), below, by_parent, rows, order);
            }
        }
    }
    let mut order: Vec<usize> = Vec::new();
    visit(None, Vec::new(), &by_parent, &mut rows, &mut order);
    let mut slots: Vec<Option<ExportPage>> = rows.into_iter().map(Some).collect();
    order.into_iter().filter_map(|index| slots[index].take()).collect()
}

fn html_document(title: &str, body: &str) -> String {
    format!(
        "<!doctype html>
<html>
<head>
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
<title>{title}</title>
<style>body{{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;line-height:1.6}}img,video{{max-width:100%}}pre{{background:#f6f8fa;padding:1rem;overflow:auto}}table{{border-collapse:collapse}}td,th{{border:1px solid #ddd;padding:4px 8px}}</style>
</head>
<body>
<h1>{title}</h1>
{body}
</body>
</html>
",
        title = escape_html(title),
        body = body
    )
}

fn markdown_cell(s: &str) -> String {
    s.replace('\\', "\\\\").replace('|', "\\|").replace("\r\n", " ").replace('\n', " ")
}

/// A base's rows as a Markdown or HTML table.
fn base_table(format: ExportFormat, table: &BaseText) -> String {
    if format == ExportFormat::Html {
        let head: String = table.headers.iter().map(|h| format!("<th>{}</th>", escape_html(h))).collect();
        let body = table
            .rows
            .iter()
            .map(|row| format!("<tr>{}</tr>", row.iter().map(|cell| format!("<td>{}</td>", escape_html(cell))).collect::<String>()))
            .collect::<Vec<_>>()
            .join("\n");
        return format!("<table>\n<thead><tr>{head}</tr></thead>\n<tbody>\n{body}\n</tbody>\n</table>");
    }
    let line = |cells: Vec<String>| format!("| {} |", cells.join(" | "));
    let mut lines = vec![
        line(table.headers.iter().map(|h| markdown_cell(h)).collect()),
        line(table.headers.iter().map(|_| "---".to_string()).collect()),
    ];
    lines.extend(table.rows.iter().map(|row| line(row.iter().map(|cell| markdown_cell(cell)).collect())));
    format!("{}\n", lines.join("\n"))
}

struct RenderContext {
    format: ExportFormat,
    /// slugId → archive path segments of exported pages.
    exported: HashMap<String, Vec<String>>,
    /// slugId → absolute app URL of pages outside the export.
    external: HashMap<String, String>,
    /// Files written into the archive: id → archive path segments.
    files: HashMap<String, Vec<String>>,
}

/// Renders one page; file ids it links to are added to `referenced`.
fn render(
    ctx: &RenderContext,
    referenced: &mut HashSet<String>,
    title: Option<&str>,
    content: Option<&Value>,
    dir: &[String],
    table: Option<&BaseText>,
) -> Result<String> {
    let title = title.filter(|title| !title.is_empty());
    if let Some(table) = table {
        let name = title.unwrap_or("Untitled base");
        return Ok(match ctx.format {
            ExportFormat::Html => html_document(name, &base_table(ExportFormat::Html, table)),
            ExportFormat::Markdown => format!("# {name}\n\n{}", base_table(ExportFormat::Markdown, table)),
        });
    }
    let app_url = &config().app_url;
    let seen: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let malformed = Cell::new(false);
    let up = |path: &[String]| {
        if path.iter().any(|part| has_lone_surrogate(part)) {
            // `encodeURIComponent` throws here, which fails the export.
            malformed.set(true);
        }
        format!("{}{}", "../".repeat(dir.len()), encode_path(path))
    };
    let file_url = |src: &str| -> String {
        let Some(parsed) = parse_file_url_str(src) else { return src.to_string() };
        match ctx.files.get(&parsed.file_id) {
            Some(path) => {
                seen.borrow_mut().push(parsed.file_id);
                up(path)
            }
            None => format!("{app_url}{src}"),
        }
    };
    let page_href = |slug_id: &str, anchor: Option<&Value>| -> String {
        let anchor = match anchor.filter(|anchor| js_truthy(anchor)) {
            Some(anchor) => format!("#{}", encode_uri_component(&js_string(anchor))),
            None => String::new(),
        };
        match ctx.exported.get(slug_id) {
            Some(path) => format!("{}{anchor}", up(path)),
            None => format!("{}{anchor}", ctx.external.get(slug_id).cloned().unwrap_or_else(|| format!("{app_url}/"))),
        }
    };
    let empty = json!({ "type": "doc", "content": [] });
    let doc = rewrite_links(content.filter(|content| !content.is_null()).unwrap_or(&empty), &|href: &str| {
        if parse_file_url_str(href).is_some() {
            return Some(file_url(href));
        }
        let slug_id = page_slug_id_from_href(Some(&Value::String(href.to_string())))?;
        let anchor = href.split_once('#').map(|(_, anchor)| anchor).filter(|anchor| !anchor.is_empty());
        let anchor = match anchor {
            Some(anchor) => match decode_uri_component(anchor) {
                Some(decoded) => Some(Value::String(decoded)),
                None => {
                    // `decodeURIComponent` throws here, which fails the export.
                    malformed.set(true);
                    None
                }
            },
            None => None,
        };
        Some(page_href(&slug_id, anchor.as_ref()))
    });
    if malformed.get() {
        return Err(AppError::other("URI malformed"));
    }
    let name = title.unwrap_or("Untitled");
    let options = HtmlOptions { file_url: Some(&file_url), page_href: Some(&page_href) };
    let out = match ctx.format {
        ExportFormat::Html => html_document(name, &doc_to_html(&doc, &options)),
        ExportFormat::Markdown => {
            let markdown = try_doc_to_markdown(&doc, &options).map_err(|_| AppError::other("a table without rows cannot be written as Markdown"))?;
            format!("# {name}\n\n{markdown}")
        }
    };
    referenced.extend(seen.into_inner());
    Ok(out)
}

/// slugIds referenced by mentions or internal links in the given documents.
fn referenced_slug_ids<'a>(docs: impl Iterator<Item = &'a Value>) -> Vec<String> {
    fn visit(node: &Value, ids: &mut Vec<String>) {
        let mut add = |id: String| {
            if !ids.contains(&id) {
                ids.push(id);
            }
        };
        if node_type(node) == "mention" {
            let attrs = node.get("attrs");
            if attrs.and_then(|a| a.get("entityType")).and_then(Value::as_str) == Some("page") {
                if let Some(slug_id) = attrs.and_then(|a| a.get("slugId")).and_then(Value::as_str) {
                    add(slug_id.to_string());
                }
            }
        }
        for mark in marks(node) {
            if node_type(mark) == "link" {
                if let Some(slug_id) = page_slug_id_from_href(mark.get("attrs").and_then(|a| a.get("href"))) {
                    add(slug_id);
                }
            }
        }
        for child in children(node) {
            visit(child, ids);
        }
    }
    let mut ids = Vec::new();
    for doc in docs {
        if !doc.is_null() {
            visit(doc, &mut ids);
        }
    }
    ids
}

async fn external_urls(slug_ids: &[String], readable_by: &str) -> Result<Vec<(String, String)>> {
    if slug_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = db()
        .query(sql!(
            "SELECT p.slug_id, p.title, s.slug AS space_slug FROM pages p JOIN spaces s ON s.id = p.space_id
             WHERE p.slug_id = ANY({}::text[]) AND p.deleted_at IS NULL
               AND p.space_id IN (
                 SELECT sm.space_id FROM space_members sm
                 WHERE sm.user_id = {}
                   OR sm.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = {})
               )",
            array(slug_ids),
            readable_by,
            readable_by
        ))
        .await?;
    Ok(rows
        .iter()
        .map(|r| (r.str("slug_id"), format!("{}{}", config().app_url, page_path(&r.str("space_slug"), r.opt_str("title").as_deref(), &r.str("slug_id")))))
        .collect())
}

pub struct ExportRequest {
    pub user_id: String,
    pub format: ExportFormat,
    pub include_files: bool,
    /// Export this page (and its subtree when `children`), or the whole space when `None`.
    pub page_id: Option<String>,
    pub space_id: String,
    pub children: bool,
    pub archive_name: String,
}

struct ExportFile {
    id: String,
    storage_key: String,
}

/// Contents of the given pages by id; pages they link to outside the export get their URLs resolved.
async fn load_contents(ctx: &mut RenderContext, ids: &[String], user_id: &str) -> Result<HashMap<String, Value>> {
    let rows = db().query(sql!("SELECT id, content FROM pages WHERE id = ANY({}::uuid[])", array(ids))).await?;
    let by_id: HashMap<String, Value> = rows.iter().map(|r| (r.str("id"), r.json("content"))).collect();
    let docs = rows.iter().filter_map(|r| by_id.get(&r.str("id")));
    let missing: Vec<String> = referenced_slug_ids(docs).into_iter().filter(|s| !ctx.exported.contains_key(s) && !ctx.external.contains_key(s)).collect();
    for (slug_id, url) in external_urls(&missing, user_id).await? {
        ctx.external.insert(slug_id, url);
    }
    Ok(by_id)
}

struct Archive {
    ctx: RenderContext,
    pages: Vec<ExportPage>,
    files: Vec<ExportFile>,
    user_id: String,
    ext: &'static str,
}

async fn write_archive(mut archive: Archive, zip: &mut ZipWriter) -> Result<()> {
    let mut referenced: HashSet<String> = HashSet::new();
    for batch in archive.pages.chunks(CONTENT_BATCH) {
        let ids: Vec<String> = batch.iter().map(|page| page.id.clone()).collect();
        let contents = load_contents(&mut archive.ctx, &ids, &archive.user_id).await?;
        for page in batch {
            let table = if page.is_base { Some(base_text(&page.id, &archive.user_id, 10_000).await?) } else { None };
            let data = render(&archive.ctx, &mut referenced, page.title.as_deref(), contents.get(&page.id), &page.dir, table.as_ref())?;
            let mut path = page.dir.clone();
            path.push(format!("{}.{}", page.base, archive.ext));
            zip.add_data(&path.join("/"), data.as_bytes()).await.map_err(AppError::other)?;
        }
    }
    for file in &archive.files {
        if !referenced.contains(&file.id) {
            continue;
        }
        let Some(object) = storage::get(&file.storage_key).await.map_err(AppError::other)? else { continue };
        let Some(path) = archive.ctx.files.get(&file.id) else { continue };
        zip.add_object(&path.join("/"), &object).await.map_err(AppError::other)?;
    }
    Ok(())
}

/// Builds the export response: a single document, or a streamed zip archive.
pub async fn export_pages(request: ExportRequest) -> Result<Response<Body>> {
    let format = request.format;
    let ext = format.extension();
    let rows = match (&request.page_id, request.children) {
        (Some(page_id), true) => {
            db().query(sql!(
                "WITH RECURSIVE subtree AS (
                   SELECT id, 0 AS depth FROM pages WHERE id = {}
                   UNION ALL
                   SELECT p.id, s.depth + 1 FROM pages p JOIN subtree s ON p.parent_id = s.id
                   WHERE p.deleted_at IS NULL AND s.depth < 1000
                 )
                 SELECT p.id, p.slug_id, p.parent_id, p.title, p.is_base FROM subtree s JOIN pages p ON p.id = s.id
                 ORDER BY s.depth, p.position, p.id",
                page_id
            ))
            .await?
        }
        (Some(page_id), false) => db().query(sql!("SELECT id, slug_id, parent_id, title, is_base FROM pages WHERE id = {}", page_id)).await?,
        (None, _) => {
            db().query(sql!(
                "SELECT id, slug_id, parent_id, title, is_base FROM pages
                 WHERE space_id = {} AND deleted_at IS NULL ORDER BY position, id",
                &request.space_id
            ))
            .await?
        }
    };
    let rows: Vec<ExportPage> = rows
        .iter()
        .map(|r| ExportPage {
            id: r.str("id"),
            slug_id: r.str("slug_id"),
            parent_id: r.opt_str("parent_id"),
            title: r.opt_str("title"),
            is_base: r.bool("is_base"),
            dir: Vec::new(),
            base: String::new(),
        })
        .collect();
    let root_ids: HashSet<String> = match &request.page_id {
        Some(page_id) => HashSet::from([page_id.clone()]),
        None => rows.iter().filter(|r| r.parent_id.is_none()).map(|r| r.id.clone()).collect(),
    };
    let pages = layout(rows, &root_ids);
    let page_ids: Vec<String> = pages.iter().map(|p| p.id.clone()).collect();

    let file_rows = if request.include_files {
        db().query(sql!("SELECT id, name, size, storage_key FROM files WHERE page_id = ANY({}::uuid[])", array(&page_ids))).await?
    } else {
        Vec::new()
    };
    let mut ctx = RenderContext {
        format,
        exported: pages
            .iter()
            .map(|p| {
                let mut path = p.dir.clone();
                path.push(format!("{}.{ext}", p.base));
                (p.slug_id.clone(), path)
            })
            .collect(),
        external: HashMap::new(),
        files: file_rows.iter().map(|f| (f.str("id"), vec!["files".to_string(), f.str("id"), safe_file_name(&f.str("name"))])).collect(),
    };

    if request.page_id.is_some() && pages.len() == 1 && !request.include_files {
        let page = &pages[0];
        let contents = load_contents(&mut ctx, std::slice::from_ref(&page.id), &request.user_id).await?;
        let table = if page.is_base { Some(base_text(&page.id, &request.user_id, 10_000).await?) } else { None };
        let mut referenced = HashSet::new();
        let body = render(&ctx, &mut referenced, page.title.as_deref(), contents.get(&page.id), &[], table.as_ref())?;
        return Ok(response(
            200,
            &[
                ("Content-Type", if format == ExportFormat::Markdown { "text/markdown; charset=utf-8" } else { "text/html; charset=utf-8" }),
                ("Content-Disposition", &try_content_disposition("attachment", &format!("{}.{ext}", page.base))?),
                ("X-Content-Type-Options", "nosniff"),
                ("Content-Security-Policy", "sandbox"),
                ("Cache-Control", "no-store"),
            ],
            full_body(body),
        ));
    }

    let disposition = try_content_disposition("attachment", &format!("{}.zip", export_name(Some(&request.archive_name))))?;
    let files: Vec<ExportFile> = file_rows.iter().map(|f| ExportFile { id: f.str("id"), storage_key: f.str("storage_key") }).collect();
    let archive = Archive { ctx, pages, files, user_id: request.user_id.clone(), ext };
    let (tx, rx) = mpsc::channel(8);
    tokio::spawn(async move {
        let mut zip = ZipWriter::new(tx.clone());
        let written = match write_archive(archive, &mut zip).await {
            Ok(()) => zip.finish().await.map_err(AppError::other),
            Err(error) => Err(error),
        };
        if let Err(error) = written {
            logger::error("export failed", &error);
            let _ = tx.send(Err(std::io::Error::other(error.to_string()))).await;
        }
    });
    let stream: ByteStream = Box::pin(futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) }));
    Ok(response(
        200,
        &[
            ("Content-Type", "application/zip"),
            ("Content-Disposition", &disposition),
            ("X-Content-Type-Options", "nosniff"),
            ("Cache-Control", "no-store"),
        ],
        stream_body(stream),
    ))
}
