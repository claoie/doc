//! Port of `src/server/lib/static.ts`: serving the built web app.

use std::path::{Path, PathBuf};

use hyper::{HeaderMap, Response};

use crate::common::MERMAID_BASE;
use crate::files::{parse_range, Range};
use crate::http::{header, response, set_header, text_response, Body};
use crate::jsutil::decode_uri_component;
use crate::storage::{Source, StoredObject};

const HTML_HEADERS: &[(&str, &str)] = &[
    ("Content-Type", "text/html; charset=utf-8"),
    ("Cache-Control", "no-cache"),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "same-origin"),
];

/// Policy for the app shell. Scripts only come from the app and the pinned
/// diagram renderer; `javascript:` URLs and inline scripts never run. Embeds
/// and images may come from any https origin.
fn app_csp() -> String {
    [
        "default-src 'self'".to_string(),
        format!("script-src 'self' {MERMAID_BASE}"),
        "style-src 'self' 'unsafe-inline'".to_string(),
        "img-src 'self' data: blob: https: http:".to_string(),
        "media-src 'self' blob: https: http:".to_string(),
        "font-src 'self' data:".to_string(),
        "connect-src 'self'".to_string(),
        "frame-src 'self' https:".to_string(),
        "worker-src 'self' blob:".to_string(),
        "object-src 'none'".to_string(),
        "base-uri 'self'".to_string(),
        "form-action 'self'".to_string(),
        "frame-ancestors 'self'".to_string(),
    ]
    .join("; ")
}

/// Other pages (the drawing editor frame) always run sandboxed, even when opened directly.
const FRAME_CSP: &str = "sandbox allow-scripts allow-popups allow-downloads; frame-ancestors 'self'";

/// The content type Bun gives a file by its extension.
fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html;charset=utf-8",
        "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx" => "text/javascript;charset=utf-8",
        "css" => "text/css;charset=utf-8",
        "json" | "map" => "application/json;charset=utf-8",
        "txt" => "text/plain;charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/x-ms-bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        "md" => "text/markdown",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        "webmanifest" => "application/manifest+json",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/x-wav",
        "ogg" => "audio/ogg",
        "zip" => "application/zip",
        "csv" => "text/csv",
        "yaml" | "yml" => "text/yaml",
        "toml" => "application/toml",
        _ => "application/octet-stream",
    }
}

/// `path.posix.normalize("/" + decoded)`, as the segments below the root.
fn normalize(decoded: &str) -> Vec<&str> {
    let mut segments: Vec<&str> = Vec::new();
    for segment in decoded.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    segments
}

async fn file_size(path: &Path) -> Option<u64> {
    match tokio::fs::metadata(path).await {
        Ok(info) if info.is_file() => Some(info.len()),
        _ => None,
    }
}

/// A response for a file, as `new Response(Bun.file(path), { headers })` gives:
/// its content type by extension unless the headers set one, its length, and
/// a single byte range when asked for one.
async fn file_response(request: &HeaderMap, path: PathBuf, size: u64, headers: &[(&str, &str)]) -> Response<Body> {
    let object = StoredObject { size, source: Source::File(path.clone()) };
    let range = match header(request, "range").map(|value| parse_range(&value, size)) {
        Some(Range::Bytes(start, end)) => Some((start, end)),
        _ => None,
    };
    let Ok(body) = object.body(range).await else { return text_response(404, "Not Found") };
    let mut res = response(if range.is_some() { 206 } else { 200 }, &[("Content-Type", content_type(&path))], body);
    for (name, value) in headers {
        set_header(&mut res, name, value);
    }
    match range {
        Some((start, end)) => {
            set_header(&mut res, "Content-Range", &format!("bytes {start}-{end}/{size}"));
            set_header(&mut res, "Content-Length", &(end - start + 1).to_string());
        }
        None => set_header(&mut res, "Content-Length", &size.to_string()),
    }
    res
}

/// Serves the built client: hashed `/assets/*` with long caching, other paths fall back to `index.html`.
pub async fn serve_static(method: &str, request: &HeaderMap, pathname: &str, root: Option<&Path>) -> Response<Body> {
    if method != "GET" && method != "HEAD" {
        return text_response(405, "Method Not Allowed");
    }
    let Some(root) = root else { return text_response(404, "Not Found") };
    let Some(decoded) = decode_uri_component(pathname) else { return text_response(400, "Bad Request") };
    let segments = normalize(&decoded);
    let mut target = root.to_path_buf();
    target.extend(&segments);
    let app_csp = app_csp();
    let index = root.join("index.html");
    if !segments.is_empty() && !decoded.contains('\0') {
        if let Some(size) = file_size(&target).await {
            let cache = if decoded.starts_with("/assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
            let mut headers: Vec<(&str, &str)> = vec![("X-Content-Type-Options", "nosniff"), ("Cache-Control", cache)];
            if target.extension().and_then(|e| e.to_str()) == Some("html") {
                headers.extend_from_slice(HTML_HEADERS);
                headers.push(("Content-Security-Policy", if target == index { &app_csp } else { FRAME_CSP }));
            }
            return file_response(request, target, size, &headers).await;
        }
    }
    if decoded.starts_with("/assets/") {
        return text_response(404, "Not Found");
    }
    let Some(size) = file_size(&index).await else { return text_response(404, "Not Found") };
    let mut headers: Vec<(&str, &str)> = HTML_HEADERS.to_vec();
    headers.push(("Content-Security-Policy", &app_csp));
    file_response(request, index, size, &headers).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_paths_below_the_root() {
        assert_eq!(normalize("/a/./b//c/"), ["a", "b", "c"]);
        assert_eq!(normalize("/../../etc/passwd"), ["etc", "passwd"]);
        assert_eq!(normalize("/a/../../b"), ["b"]);
        assert!(normalize("/").is_empty() && normalize("/..").is_empty());
    }
}
