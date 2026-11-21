//! Port of `src/server/lib/storage.ts`: where uploaded files live.

use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::OnceLock;

use bytes::Bytes;
use futures_util::{Stream, TryStreamExt};
use http_body_util::{BodyExt, StreamBody};
use hyper::body::{Frame, Incoming};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;
use unicode_normalization::UnicodeNormalization;

use crate::config::{config, StorageDriver};
use crate::http::{AppError, Body};
use crate::jsutil::{char_len, is_js_whitespace, js_trim, utf16_len};
use crate::storage_s3::S3Driver;

pub type ByteStream = Pin<Box<dyn Stream<Item = io::Result<Bytes>> + Send>>;

/// Where a stored object's bytes come from.
#[derive(Clone)]
pub enum Source {
    File(PathBuf),
    S3(String),
}

#[derive(Clone)]
pub struct StoredObject {
    pub size: u64,
    pub source: Source,
}

impl StoredObject {
    /// The whole object, or the inclusive byte range `[start, end]`, as a stream.
    pub async fn stream(&self, range: Option<(u64, u64)>) -> io::Result<ByteStream> {
        match &self.source {
            Source::File(path) => {
                let mut file = tokio::fs::File::open(path).await?;
                let (start, end) = range.unwrap_or((0, self.size.saturating_sub(1)));
                let length = if self.size == 0 { 0 } else { end + 1 - start };
                if start > 0 {
                    file.seek(io::SeekFrom::Start(start)).await?;
                }
                Ok(Box::pin(ReaderStream::new(file.take(length))))
            }
            Source::S3(key) => s3().read(key, range).await,
        }
    }

    /// The object as a response body. A read failure after the headers have gone ends the body early.
    pub async fn body(&self, range: Option<(u64, u64)>) -> io::Result<Body> {
        Ok(stream_body(self.stream(range).await?))
    }
}

pub fn stream_body(stream: ByteStream) -> Body {
    BodyExt::boxed_unsync(StreamBody::new(stream.map_ok(Frame::data)))
}

/// Why a streamed upload was not stored.
#[derive(Debug)]
pub enum PutError {
    /// More than the limit arrived.
    TooLarge,
    Other(String),
}

impl From<PutError> for AppError {
    fn from(error: PutError) -> Self {
        match error {
            PutError::TooLarge => AppError::Other("upload too large".into()),
            PutError::Other(message) => AppError::Other(message),
        }
    }
}

fn check_key(key: &str) -> io::Result<()> {
    let prefixed = key.strip_prefix("files/").or_else(|| key.strip_prefix("images/"));
    let valid = prefixed.is_some_and(|rest| !rest.is_empty())
        && !key.contains('\\')
        && !key.contains('\0')
        && key.split('/').all(|part| !part.is_empty() && part != "." && part != "..");
    if valid {
        Ok(())
    } else {
        Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid storage key"))
    }
}

struct LocalDriver {
    root: PathBuf,
}

impl LocalDriver {
    fn resolve(&self, key: &str) -> io::Result<PathBuf> {
        check_key(key)?;
        Ok(self.root.join(key))
    }

    async fn put(&self, key: &str, data: &[u8]) -> io::Result<()> {
        let target = self.resolve(key)?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(target, data).await
    }

    async fn write_stream(target: &Path, body: &mut Incoming, limit: u64) -> Result<u64, PutError> {
        let other = |e: io::Error| PutError::Other(e.to_string());
        let mut file = tokio::fs::File::create(target).await.map_err(other)?;
        let mut size = 0u64;
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|e| PutError::Other(e.to_string()))?;
            let Ok(chunk) = frame.into_data() else { continue };
            size += chunk.len() as u64;
            if size > limit {
                return Err(PutError::TooLarge);
            }
            file.write_all(&chunk).await.map_err(other)?;
        }
        file.flush().await.map_err(other)?;
        Ok(size)
    }

    async fn put_stream(&self, key: &str, body: &mut Incoming, limit: u64) -> Result<u64, PutError> {
        let target = self.resolve(key).map_err(|e| PutError::Other(e.to_string()))?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| PutError::Other(e.to_string()))?;
        }
        match Self::write_stream(&target, body, limit).await {
            Ok(size) => Ok(size),
            Err(error) => {
                // Nothing is kept on failure.
                let _ = tokio::fs::remove_file(&target).await;
                if key.starts_with("files/") {
                    if let Some(parent) = target.parent() {
                        let _ = tokio::fs::remove_dir(parent).await;
                    }
                }
                Err(error)
            }
        }
    }

    async fn get(&self, key: &str) -> io::Result<Option<StoredObject>> {
        let target = self.resolve(key)?;
        match tokio::fs::metadata(&target).await {
            Ok(info) if info.is_file() => Ok(Some(StoredObject { size: info.len(), source: Source::File(target) })),
            _ => Ok(None),
        }
    }

    async fn remove(&self, key: &str) -> io::Result<()> {
        let target = self.resolve(key)?;
        match tokio::fs::remove_file(&target).await {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        if key.starts_with("files/") {
            if let Some(parent) = target.parent() {
                // Fails while other files remain, which is the point.
                let _ = tokio::fs::remove_dir(parent).await;
            }
        }
        Ok(())
    }

    async fn copy(&self, from: &str, to: &str) -> io::Result<()> {
        let source = self.resolve(from)?;
        let target = self.resolve(to)?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::copy(source, target).await.map(|_| ())
    }
}

enum Driver {
    Local(LocalDriver),
    S3(S3Driver),
}

fn driver() -> &'static Driver {
    static DRIVER: OnceLock<Driver> = OnceLock::new();
    DRIVER.get_or_init(|| match config().storage_driver {
        StorageDriver::S3 => Driver::S3(S3Driver::new(&config().s3)),
        StorageDriver::Local => {
            let path = PathBuf::from(&config().storage_path);
            let root = if path.is_absolute() { path } else { std::env::current_dir().unwrap_or_default().join(path) };
            Driver::Local(LocalDriver { root })
        }
    })
}

fn s3() -> &'static S3Driver {
    match driver() {
        Driver::S3(s3) => s3,
        Driver::Local(_) => unreachable!("an S3 object without the S3 driver"),
    }
}

pub async fn put(key: &str, data: &[u8]) -> io::Result<()> {
    match driver() {
        Driver::Local(local) => local.put(key, data).await,
        Driver::S3(s3) => {
            check_key(key)?;
            s3.put(key, data).await
        }
    }
}

/// Writes a request body without holding it in memory; returns its size. Nothing is kept on failure.
pub async fn put_stream(key: &str, body: &mut Incoming, limit: u64) -> Result<u64, PutError> {
    match driver() {
        Driver::Local(local) => local.put_stream(key, body, limit).await,
        Driver::S3(s3) => {
            check_key(key).map_err(|e| PutError::Other(e.to_string()))?;
            s3.put_stream(key, body, limit).await
        }
    }
}

pub async fn get(key: &str) -> io::Result<Option<StoredObject>> {
    match driver() {
        Driver::Local(local) => local.get(key).await,
        Driver::S3(s3) => {
            check_key(key)?;
            s3.get(key).await
        }
    }
}

pub async fn remove(key: &str) -> io::Result<()> {
    match driver() {
        Driver::Local(local) => local.remove(key).await,
        Driver::S3(s3) => {
            check_key(key)?;
            // A failed delete leaves an orphan object, never a broken page.
            let _ = s3.remove(key).await;
            Ok(())
        }
    }
}

pub async fn copy(from: &str, to: &str) -> io::Result<()> {
    match driver() {
        Driver::Local(local) => local.copy(from, to).await,
        Driver::S3(s3) => {
            check_key(from)?;
            check_key(to)?;
            s3.copy(from, to).await
        }
    }
}

pub async fn remove_many(keys: &[String]) -> io::Result<()> {
    for key in keys {
        remove(key).await?;
    }
    Ok(())
}

/// File name safe for storage keys and headers: no path separators or control characters, ≤ 255 chars.
pub fn safe_file_name(name: &str) -> String {
    let normalized: String = name.nfc().collect();
    let stripped: String = normalized.chars().filter(|c| !(*c <= '\u{1f}' || *c == '\u{7f}' || *c == '/' || *c == '\\')).collect();
    let cleaned = js_trim(stripped.trim_start_matches(|c: char| c == '.' || is_js_whitespace(c)));
    if char_len(cleaned) <= 255 {
        return if cleaned.is_empty() { "file".to_string() } else { cleaned.to_string() };
    }
    // `cleaned.length - dot <= 16` counts UTF-16 units.
    let ext = match cleaned.rfind('.') {
        Some(dot) if dot > 0 && utf16_len(&cleaned[dot..]) <= 16 => &cleaned[dot..],
        _ => "",
    };
    let keep = 255 - char_len(ext);
    let head: String = cleaned.chars().take(keep).collect();
    format!("{head}{ext}")
}

pub fn file_storage_key(file_id: &str, name: &str) -> String {
    format!("files/{file_id}/{}", safe_file_name(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_keys() {
        assert!(check_key("files/abc/name.txt").is_ok());
        assert!(check_key("images/a.png").is_ok());
        for bad in ["files/", "other/x", "files/../x", "files/a//b", "files/a\\b", "files/./a", "files/a\0b", "files"] {
            assert!(check_key(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_file_name("../../etc/passwd"), "etcpasswd");
        assert_eq!(safe_file_name("  .hidden.txt "), "hidden.txt");
        assert_eq!(safe_file_name("a\u{0}b\u{1f}c\\d/e"), "abcde");
        assert_eq!(safe_file_name(""), "file");
        assert_eq!(safe_file_name(" . . "), "file");
        assert_eq!(safe_file_name("e\u{301}.txt"), "é.txt");
        let long = format!("{}.tar.gz", "😀".repeat(300));
        let safe = safe_file_name(&long);
        assert_eq!(char_len(&safe), 255);
        assert!(safe.ends_with(".gz"));
        assert_eq!(file_storage_key("id", "a/b.txt"), "files/id/ab.txt");
    }
}
