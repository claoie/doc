//! The S3 half of `src/server/lib/storage.ts`: objects in an S3-compatible
//! bucket, with requests signed by AWS Signature Version 4.
//!
//! Like Bun's client, an upload of 5 MiB or more goes up as a multipart
//! upload in parts of 5 MiB, a smaller one as a single PUT, and a copy reads
//! the source and writes it again. The payload is not signed
//! (`UNSIGNED-PAYLOAD`), so nothing is buffered beyond one part.

use std::io;

use bytes::{Bytes, BytesMut};
use chrono::Utc;
use futures_util::{Stream, StreamExt, TryStreamExt};
use hmac::{Hmac, Mac};
use http_body_util::BodyStream;
use hyper::body::Incoming;
use reqwest::Method;
use sha2::{Digest, Sha256};

use crate::config::S3Config;
use crate::files::mime_for;
use crate::storage::{ByteStream, PutError, Source, StoredObject};

const PART_SIZE: usize = 5 * 1024 * 1024;
const UNSIGNED: &str = "UNSIGNED-PAYLOAD";

pub struct S3Driver {
    http: reqwest::Client,
    region: String,
    access_key_id: String,
    secret_access_key: String,
    /// `scheme://host[:port]` of the bucket (virtual-hosted) or of the endpoint (path-style).
    origin: String,
    /// The `Host` header, which is signed.
    host: String,
    /// `/bucket` for path-style addressing, empty otherwise.
    prefix: String,
}

fn other(message: impl std::fmt::Display) -> io::Error {
    io::Error::other(message.to_string())
}

/// Percent-encoding as Signature Version 4 wants it: everything but unreserved characters.
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for &byte in text.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hmac(key: &[u8], message: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(message.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

struct Upload {
    id: String,
    etags: Vec<String>,
}

impl S3Driver {
    pub fn new(config: &S3Config) -> S3Driver {
        let bucket = config.bucket.clone().unwrap_or_default();
        let region = config.region.clone().unwrap_or_else(|| "us-east-1".to_string());
        let endpoint = config.endpoint.clone().unwrap_or_else(|| format!("https://s3.{region}.amazonaws.com"));
        let parsed = url::Url::parse(&endpoint).ok();
        let scheme = parsed.as_ref().map_or("https", |url| url.scheme()).to_string();
        let endpoint_host = parsed
            .as_ref()
            .and_then(|url| url.host_str().map(|host| match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            }))
            .unwrap_or_default();
        let (host, prefix) =
            if config.force_path_style { (endpoint_host, format!("/{}", encode(&bucket))) } else { (format!("{bucket}.{endpoint_host}"), String::new()) };
        let http = crate::http::https_client()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        S3Driver {
            http,
            region,
            access_key_id: config.access_key_id.clone().unwrap_or_default(),
            secret_access_key: config.secret_access_key.clone().unwrap_or_default(),
            origin: format!("{scheme}://{host}"),
            host,
            prefix,
        }
    }

    /// A signed request for an object. `query` holds decoded pairs.
    fn request(&self, method: Method, key: &str, query: &[(&str, &str)]) -> reqwest::RequestBuilder {
        let path = format!("{}/{}", self.prefix, key.split('/').map(encode).collect::<Vec<_>>().join("/"));
        let mut pairs: Vec<(String, String)> = query.iter().map(|(name, value)| (encode(name), encode(value))).collect();
        pairs.sort();
        let canonical_query = pairs.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("&");
        let now = Utc::now();
        let stamp = now.format("%Y%m%dT%H%M%SZ").to_string();
        let day = now.format("%Y%m%d").to_string();
        let signed_headers = "host;x-amz-content-sha256;x-amz-date";
        let canonical = format!(
            "{}\n{path}\n{canonical_query}\nhost:{}\nx-amz-content-sha256:{UNSIGNED}\nx-amz-date:{stamp}\n\n{signed_headers}\n{UNSIGNED}",
            method.as_str(),
            self.host
        );
        let scope = format!("{day}/{}/s3/aws4_request", self.region);
        let to_sign = format!("AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{}", hex(&Sha256::digest(canonical.as_bytes())));
        let mut signing_key = hmac(format!("AWS4{}", self.secret_access_key).as_bytes(), &day);
        for part in [self.region.as_str(), "s3", "aws4_request"] {
            signing_key = hmac(&signing_key, part);
        }
        let signature = hex(&hmac(&signing_key, &to_sign));
        let authorization =
            format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}", self.access_key_id);
        let url = if canonical_query.is_empty() { format!("{}{path}", self.origin) } else { format!("{}{path}?{canonical_query}", self.origin) };
        self.http
            .request(method, url)
            .header("x-amz-content-sha256", UNSIGNED)
            .header("x-amz-date", stamp)
            .header("authorization", authorization)
    }

    async fn sent(&self, request: reqwest::RequestBuilder, what: &str) -> io::Result<reqwest::Response> {
        let response = request.send().await.map_err(|error| other(format!("{what} failed: {error}")))?;
        if !response.status().is_success() {
            return Err(other(format!("{what} failed: the store answered {}", response.status().as_u16())));
        }
        Ok(response)
    }

    async fn put_object(&self, key: &str, data: Bytes) -> io::Result<()> {
        let request = self.request(Method::PUT, key, &[]).header("content-type", mime_for(key, None)).header("content-length", data.len()).body(data);
        self.sent(request, "writing an object").await.map(|_| ())
    }

    async fn start_upload(&self, key: &str) -> io::Result<Upload> {
        let request = self.request(Method::POST, key, &[("uploads", "")]).header("content-type", mime_for(key, None)).header("content-length", 0);
        let text = self.sent(request, "starting an upload").await?.text().await.map_err(other)?;
        let id = text
            .split_once("<UploadId>")
            .and_then(|(_, rest)| rest.split_once("</UploadId>"))
            .map(|(id, _)| id.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'"))
            .filter(|id| !id.is_empty())
            .ok_or_else(|| other("starting an upload failed: the store named no upload"))?;
        Ok(Upload { id, etags: Vec::new() })
    }

    async fn upload_part(&self, key: &str, upload: &mut Upload, data: Bytes) -> io::Result<()> {
        let number = (upload.etags.len() + 1).to_string();
        let request =
            self.request(Method::PUT, key, &[("partNumber", &number), ("uploadId", &upload.id)]).header("content-length", data.len()).body(data);
        let response = self.sent(request, "uploading a part").await?;
        let etag = response.headers().get("etag").and_then(|value| value.to_str().ok()).ok_or_else(|| other("uploading a part failed: no ETag"))?;
        upload.etags.push(etag.to_string());
        Ok(())
    }

    async fn complete_upload(&self, key: &str, upload: &Upload) -> io::Result<()> {
        let mut xml = String::from("<CompleteMultipartUpload xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">");
        for (index, etag) in upload.etags.iter().enumerate() {
            let etag = etag.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
            xml.push_str(&format!("<Part><PartNumber>{}</PartNumber><ETag>{etag}</ETag></Part>", index + 1));
        }
        xml.push_str("</CompleteMultipartUpload>");
        let request =
            self.request(Method::POST, key, &[("uploadId", &upload.id)]).header("content-type", "application/xml").header("content-length", xml.len()).body(xml);
        // A store may answer 200 and then report a failure in the body.
        let text = self.sent(request, "completing an upload").await?.text().await.map_err(other)?;
        if text.contains("<Error>") {
            return Err(other("completing an upload failed: the store reported an error"));
        }
        Ok(())
    }

    async fn abort_upload(&self, key: &str, upload: &Upload) {
        let _ = self.request(Method::DELETE, key, &[("uploadId", &upload.id)]).send().await;
    }

    /// Writes a stream as one object; nothing is kept when it fails or passes `limit`.
    async fn write_stream<S>(&self, key: &str, mut stream: S, limit: Option<u64>) -> Result<u64, PutError>
    where
        S: Stream<Item = io::Result<Bytes>> + Unpin,
    {
        let mut upload: Option<Upload> = None;
        let outcome = self.write_parts(key, &mut stream, limit, &mut upload).await;
        if outcome.is_err() {
            if let Some(upload) = &upload {
                self.abort_upload(key, upload).await;
            }
            let _ = self.remove(key).await;
        }
        outcome
    }

    async fn write_parts<S>(&self, key: &str, stream: &mut S, limit: Option<u64>, upload: &mut Option<Upload>) -> Result<u64, PutError>
    where
        S: Stream<Item = io::Result<Bytes>> + Unpin,
    {
        let failed = |error: io::Error| PutError::Other(error.to_string());
        let mut buffer = BytesMut::new();
        let mut size = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(failed)?;
            size += chunk.len() as u64;
            if limit.is_some_and(|limit| size > limit) {
                return Err(PutError::TooLarge);
            }
            buffer.extend_from_slice(&chunk);
            while buffer.len() >= PART_SIZE {
                let part = buffer.split_to(PART_SIZE).freeze();
                if upload.is_none() {
                    *upload = Some(self.start_upload(key).await.map_err(failed)?);
                }
                if let Some(upload) = upload.as_mut() {
                    self.upload_part(key, upload, part).await.map_err(failed)?;
                }
            }
        }
        match upload.as_mut() {
            Some(upload) => {
                if !buffer.is_empty() {
                    self.upload_part(key, upload, buffer.freeze()).await.map_err(failed)?;
                }
                self.complete_upload(key, upload).await.map_err(failed)?;
            }
            None => self.put_object(key, buffer.freeze()).await.map_err(failed)?,
        }
        Ok(size)
    }

    pub async fn put(&self, key: &str, data: &[u8]) -> io::Result<()> {
        self.put_object(key, Bytes::copy_from_slice(data)).await
    }

    pub async fn put_stream(&self, key: &str, body: &mut Incoming, limit: u64) -> Result<u64, PutError> {
        let frames = BodyStream::new(body).map_err(other).try_filter_map(|frame| async move { Ok(frame.into_data().ok()) });
        self.write_stream(key, Box::pin(frames), Some(limit)).await
    }

    /// The object's size, or `None` when the store has no such object or
    /// cannot be asked (`file.stat().catch(() => null)` in the Bun server).
    pub async fn get(&self, key: &str) -> io::Result<Option<StoredObject>> {
        let Ok(response) = self.request(Method::HEAD, key, &[]).send().await else { return Ok(None) };
        if !response.status().is_success() {
            return Ok(None);
        }
        let size = response.headers().get("content-length").and_then(|value| value.to_str().ok()).and_then(|value| value.parse::<u64>().ok());
        Ok(size.map(|size| StoredObject { size, source: Source::S3(key.to_string()) }))
    }

    /// The object's bytes, or the inclusive byte range `[start, end]` of them.
    pub async fn read(&self, key: &str, range: Option<(u64, u64)>) -> io::Result<ByteStream> {
        let mut request = self.request(Method::GET, key, &[]);
        if let Some((start, end)) = range {
            request = request.header("range", format!("bytes={start}-{end}"));
        }
        let response = self.sent(request, "reading an object").await?;
        Ok(Box::pin(response.bytes_stream().map_err(other)))
    }

    pub async fn remove(&self, key: &str) -> io::Result<()> {
        // Failures are ignored, as in the Bun server.
        let _ = self.request(Method::DELETE, key, &[]).send().await;
        Ok(())
    }

    pub async fn copy(&self, from: &str, to: &str) -> io::Result<()> {
        let source = self.read(from, None).await?;
        match self.write_stream(to, source, None).await {
            Ok(_) => Ok(()),
            Err(PutError::TooLarge) => Err(other("the copy grew past its limit")),
            Err(PutError::Other(message)) => Err(other(message)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_and_signs() {
        assert_eq!(encode("a b(1)+*!'é.txt"), "a%20b%281%29%2B%2A%21%27%C3%A9.txt");
        // The example of RFC 4231, test case 2.
        assert_eq!(hex(&hmac(b"Jefe", "what do ya want for nothing?")), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }
}
