//! Port of `src/server/lib/files.ts`: content types, images, and serving stored objects.

use std::sync::OnceLock;

use chrono::{TimeZone, Utc};
use hyper::{HeaderMap, Response};
use regex::Regex;

use crate::common::ids::uuid;
use crate::db::db;
use crate::http::{bad_request, empty_body, header, http_error, response, set_header, AppError, Body, FormFile, Result};
use crate::jsutil::{encode_uri_component, js_trim, string_to_number};
use crate::mail::utc_string;
use crate::sql;
use crate::storage::{self, StoredObject};

fn mime_by_extension(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" | "excalidraw" => "application/json",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "drawio" => "application/vnd.jgraph.mxfile",
        _ => return None,
    })
}

fn mime_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$").expect("mime pattern"))
}

/// The content type to store for an upload: the declared one when it is
/// specific and well-formed, otherwise by the file name's extension.
pub fn mime_for(name: &str, declared: Option<&str>) -> String {
    let declared = js_trim(declared.unwrap_or("").split(';').next().unwrap_or("")).to_lowercase();
    if !declared.is_empty() && declared != "application/octet-stream" && mime_re().is_match(&declared) {
        return declared;
    }
    let lower = name.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    mime_by_extension(ext).unwrap_or("application/octet-stream").to_string()
}

const INLINE_IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon"];

/// Only types the browser renders passively are shown inline; everything else downloads.
pub fn is_inline_safe(mime: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^(audio|video)/[a-z0-9.+-]+$").expect("media pattern"));
    INLINE_IMAGE_TYPES.contains(&mime) || mime == "application/pdf" || re.is_match(mime)
}

/// `Content-Disposition` with an ASCII fallback name and the real one in `filename*`.
pub fn content_disposition(kind: &str, name: &str) -> String {
    // The replacement works on UTF-16 units, so a character outside the BMP becomes two underscores.
    let ascii: String = crate::jsutil::utf16_units(name)
        .into_iter()
        .map(|unit| match unit {
            0x22 | 0x5c => '_',
            0x20..=0x7e => unit as u8 as char,
            _ => '_',
        })
        .collect();
    format!("{kind}; filename=\"{ascii}\"; filename*=UTF-8''{}", encode_uri_component(&crate::jsutil::to_text(name)))
}

/// `contentDisposition` for a name that may have been cut inside a surrogate
/// pair, where `encodeURIComponent` throws in the Bun server.
pub fn try_content_disposition(kind: &str, name: &str) -> Result<String> {
    if crate::jsutil::has_lone_surrogate(name) {
        return Err(AppError::other("URI malformed"));
    }
    Ok(content_disposition(kind, name))
}

struct ImageType {
    mime: &'static str,
    ext: &'static str,
}

fn image_type(head: &[u8]) -> Option<ImageType> {
    let at = |i: usize| head.get(i).copied();
    if at(0) == Some(0x89) && at(1) == Some(0x50) && at(2) == Some(0x4e) && at(3) == Some(0x47) {
        return Some(ImageType { mime: "image/png", ext: "png" });
    }
    if at(0) == Some(0xff) && at(1) == Some(0xd8) && at(2) == Some(0xff) {
        return Some(ImageType { mime: "image/jpeg", ext: "jpg" });
    }
    if head.get(..4) == Some(b"GIF8") {
        return Some(ImageType { mime: "image/gif", ext: "gif" });
    }
    if head.get(..4) == Some(b"RIFF") && head.get(8..12) == Some(b"WEBP") {
        return Some(ImageType { mime: "image/webp", ext: "webp" });
    }
    None
}

const IMAGE_LIMIT: usize = 10 * 1024 * 1024;

/// Stores an avatar/logo/icon after checking its magic bytes; returns the image file name.
/// `purpose` is `avatar`, `workspace-logo` or `space-icon`.
pub async fn save_image(file: &FormFile, purpose: &str, uploader_id: &str, space_id: Option<&str>) -> Result<String> {
    if file.data.len() > IMAGE_LIMIT {
        return Err(http_error(413, "payload_too_large", "Images must be at most 10 MB"));
    }
    let head = &file.data[..file.data.len().min(16)];
    let Some(kind) = image_type(head) else { return Err(bad_request("Images must be PNG, JPEG, WebP or GIF")) };
    let name = format!("{}.{}", uuid(), kind.ext);
    let key = format!("images/{name}");
    storage::put(&key, &file.data).await?;
    db().execute(sql!(
        "INSERT INTO files (purpose, space_id, uploader_id, name, mime, size, storage_key)
         VALUES ({}, {}, {}, {}, {}, {}, {})",
        purpose,
        space_id,
        uploader_id,
        &name,
        kind.mime,
        file.data.len(),
        &key
    ))
    .await?;
    Ok(name)
}

pub async fn remove_image(name: Option<&str>) -> Result<()> {
    let Some(name) = name.filter(|n| !n.is_empty()) else { return Ok(()) };
    let key = format!("images/{name}");
    db().execute(sql!("DELETE FROM files WHERE storage_key = {}", &key)).await?;
    storage::remove(&key).await?;
    Ok(())
}

pub fn is_image_name(name: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$").expect("image name pattern")
    });
    re.is_match(name)
}

#[derive(Debug, PartialEq)]
pub enum Range {
    /// The header is not a single byte range: answer the whole object.
    None,
    /// A byte range that cannot be satisfied.
    Invalid,
    Bytes(u64, u64),
}

/// A single `bytes=a-b` range against an object of `size` bytes.
pub fn parse_range(header: &str, size: u64) -> Range {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^bytes=([0-9]*)-([0-9]*)$").expect("range pattern"));
    let Some(found) = re.captures(js_trim(header)) else { return Range::None };
    let (a, b) = (&found[1], &found[2]);
    if a.is_empty() && b.is_empty() {
        return Range::Invalid;
    }
    // The arithmetic is done on doubles, as the original does on JavaScript numbers.
    let size = size as f64;
    let (start, end) = if a.is_empty() {
        ((size - string_to_number(b)).max(0.0), size - 1.0)
    } else {
        (string_to_number(a), if b.is_empty() { size - 1.0 } else { string_to_number(b).min(size - 1.0) })
    };
    if start > end || start >= size {
        return Range::Invalid;
    }
    Range::Bytes(start as u64, end as u64)
}

pub struct ServeOptions<'a> {
    pub mime: &'a str,
    pub name: &'a str,
    pub etag: &'a str,
    /// Milliseconds since the Unix epoch.
    pub last_modified: Option<i64>,
    pub cache_control: &'a str,
    /// Force a download regardless of type.
    pub download: bool,
}

/// Serves a stored object with range, conditional and safe-content headers.
pub async fn serve_object(request: &HeaderMap, object: &StoredObject, options: &ServeOptions<'_>) -> Result<Response<Body>> {
    let inline = !options.download && is_inline_safe(options.mime);
    let mut res = response(
        200,
        &[
            ("Content-Type", options.mime),
            ("Content-Disposition", &content_disposition(if inline { "inline" } else { "attachment" }, options.name)),
            ("X-Content-Type-Options", "nosniff"),
            ("Cache-Control", options.cache_control),
            ("Accept-Ranges", "bytes"),
            ("ETag", options.etag),
        ],
        empty_body(),
    );
    if options.mime != "application/pdf" {
        set_header(&mut res, "Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
    }
    if let Some(time) = options.last_modified.and_then(|ms| Utc.timestamp_millis_opt(ms).single()) {
        set_header(&mut res, "Last-Modified", &utc_string(time));
    }
    if header(request, "if-none-match").as_deref() == Some(options.etag) {
        *res.status_mut() = hyper::StatusCode::NOT_MODIFIED;
        return Ok(res);
    }
    let range = match (header(request, "range"), header(request, "if-range")) {
        (Some(range), if_range) if !range.is_empty() && if_range.as_deref().is_none_or(|v| v.is_empty() || v == options.etag) => {
            parse_range(&range, object.size)
        }
        _ => Range::None,
    };
    let failed = |e: std::io::Error| AppError::other(format!("reading a stored object failed: {e}"));
    match range {
        Range::Invalid => {
            set_header(&mut res, "Content-Range", &format!("bytes */{}", object.size));
            *res.status_mut() = hyper::StatusCode::RANGE_NOT_SATISFIABLE;
        }
        Range::Bytes(start, end) => {
            set_header(&mut res, "Content-Range", &format!("bytes {start}-{end}/{}", object.size));
            set_header(&mut res, "Content-Length", &(end - start + 1).to_string());
            *res.status_mut() = hyper::StatusCode::PARTIAL_CONTENT;
            *res.body_mut() = object.body(Some((start, end))).await.map_err(failed)?;
        }
        Range::None => {
            set_header(&mut res, "Content-Length", &object.size.to_string());
            *res.body_mut() = object.body(None).await.map_err(failed)?;
        }
    }
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_content_types() {
        assert_eq!(mime_for("a.PNG", None), "image/png");
        assert_eq!(mime_for("a.png", Some("Text/Plain; charset=utf-8")), "text/plain");
        assert_eq!(mime_for("a.png", Some("application/octet-stream")), "image/png");
        assert_eq!(mime_for("a.png", Some("not a type")), "image/png");
        assert_eq!(mime_for("noext", Some("")), "application/octet-stream");
        assert_eq!(mime_for("a.b.drawio", None), "application/vnd.jgraph.mxfile");
        assert!(is_inline_safe("image/png") && is_inline_safe("video/mp4") && is_inline_safe("application/pdf"));
        assert!(!is_inline_safe("image/svg+xml") && !is_inline_safe("text/html") && !is_inline_safe("video/"));
    }

    #[test]
    fn writes_content_disposition() {
        assert_eq!(content_disposition("inline", "a b.png"), "inline; filename=\"a b.png\"; filename*=UTF-8''a%20b.png");
        assert_eq!(content_disposition("attachment", "é\"😀\\.txt"), "attachment; filename=\"_____.txt\"; filename*=UTF-8''%C3%A9%22%F0%9F%98%80%5C.txt");
    }

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range("bytes=0-4", 10), Range::Bytes(0, 4));
        assert_eq!(parse_range(" bytes=5- ", 10), Range::Bytes(5, 9));
        assert_eq!(parse_range("bytes=-3", 10), Range::Bytes(7, 9));
        assert_eq!(parse_range("bytes=-30", 10), Range::Bytes(0, 9));
        assert_eq!(parse_range("bytes=2-100", 10), Range::Bytes(2, 9));
        assert_eq!(parse_range("bytes=10-", 10), Range::Invalid);
        assert_eq!(parse_range("bytes=5-2", 10), Range::Invalid);
        assert_eq!(parse_range("bytes=-", 10), Range::Invalid);
        assert_eq!(parse_range("bytes=0-1,3-4", 10), Range::None);
        assert_eq!(parse_range("items=0-1", 10), Range::None);
        assert_eq!(parse_range("bytes=0-0", 0), Range::Invalid);
    }

    #[test]
    fn recognises_images() {
        assert_eq!(image_type(&[0x89, 0x50, 0x4e, 0x47, 0, 0]).map(|t| t.ext), Some("png"));
        assert_eq!(image_type(&[0xff, 0xd8, 0xff, 0xe0]).map(|t| t.ext), Some("jpg"));
        assert_eq!(image_type(b"GIF89a").map(|t| t.ext), Some("gif"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WEBPVP8 ").map(|t| t.ext), Some("webp"));
        assert!(image_type(b"<svg/>").is_none() && image_type(b"").is_none());
        assert!(is_image_name("0123abcd-89ef-4567-89ab-0123456789ab.png"));
        assert!(!is_image_name("0123ABCD-89ef-4567-89ab-0123456789ab.png") && !is_image_name("../x.png"));
    }
}
