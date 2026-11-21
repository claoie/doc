//! Port of `src/server/lib/http.ts`: errors, the response envelope, the
//! router and the request-body readers.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;

use bytes::{Bytes, BytesMut};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{HeaderName, HeaderValue};
use hyper::{HeaderMap, Response, StatusCode};
use serde_json::{json, Map, Value};

use crate::auth::{AuthSession, AuthUser};
use crate::db::DbError;
use crate::jsutil::{decode_uri_component, js_json, string_to_number};

// ---------------------------------------------------------------------------
// Errors

/// An error the API answers in its envelope: `{ error: { code, message } }`.
#[derive(Debug, Clone)]
pub struct HttpError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl HttpError {
    pub fn new(status: u16, code: &str, message: impl Into<String>) -> HttpError {
        HttpError { status, code: code.to_string(), message: message.into() }
    }
}

/// Anything a handler can fail with. Only `Http` reaches the client as
/// itself; the rest is logged and answered with 500 `internal_error`.
#[derive(Debug)]
pub enum AppError {
    Http(HttpError),
    Db(DbError),
    Other(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Http(e) => write!(f, "{}", e.message),
            AppError::Db(e) => write!(f, "{e}"),
            AppError::Other(message) => write!(f, "{message}"),
        }
    }
}

impl From<HttpError> for AppError {
    fn from(error: HttpError) -> Self {
        AppError::Http(error)
    }
}

impl From<DbError> for AppError {
    fn from(error: DbError) -> Self {
        AppError::Db(error)
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        AppError::Other(error.to_string())
    }
}

impl AppError {
    pub fn other(message: impl fmt::Display) -> AppError {
        AppError::Other(message.to_string())
    }

    /// Whether this is a database unique violation (SQLSTATE 23505).
    pub fn is_unique_violation(&self) -> bool {
        matches!(self, AppError::Db(e) if e.is_unique_violation())
    }

    pub fn is_deadlock(&self) -> bool {
        matches!(self, AppError::Db(e) if e.is_deadlock())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

pub fn bad_request(message: impl Into<String>) -> AppError {
    HttpError::new(400, "invalid_input", message).into()
}

pub fn unauthorized() -> AppError {
    HttpError::new(401, "unauthorized", "Sign in required").into()
}

pub fn forbidden() -> AppError {
    forbidden_with("You do not have permission to do this")
}

pub fn forbidden_with(message: impl Into<String>) -> AppError {
    HttpError::new(403, "forbidden", message).into()
}

/// `notFound(what)`: `"<what> not found"`.
pub fn not_found(what: &str) -> AppError {
    HttpError::new(404, "not_found", format!("{what} not found")).into()
}

pub fn conflict(code: &str, message: impl Into<String>) -> AppError {
    HttpError::new(409, code, message).into()
}

pub fn http_error(status: u16, code: &str, message: impl Into<String>) -> AppError {
    HttpError::new(status, code, message).into()
}

// ---------------------------------------------------------------------------
// Responses

pub type Body = UnsyncBoxBody<Bytes, std::io::Error>;

pub fn full_body(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into()).map_err(|never| match never {}).boxed_unsync()
}

pub fn empty_body() -> Body {
    full_body(Bytes::new())
}

/// A response under construction; headers are set by name, as `new Response(body, { headers })` does.
pub fn response(status: u16, headers: &[(&str, &str)], body: Body) -> Response<Body> {
    let mut res = Response::new(body);
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    for (name, value) in headers {
        set_header(&mut res, name, value);
    }
    res
}

/// Sets a header, replacing any earlier value. Values that cannot be sent
/// (control characters) are dropped rather than failing the response.
pub fn set_header(res: &mut Response<Body>, name: &str, value: &str) {
    if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(name.as_bytes()), header_value(value)) {
        res.headers_mut().insert(name, value);
    }
}

pub fn append_header(res: &mut Response<Body>, name: &str, value: &str) {
    if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(name.as_bytes()), header_value(value)) {
        res.headers_mut().append(name, value);
    }
}

/// Header values may hold any bytes but controls; text beyond ASCII goes out as UTF-8.
fn header_value(value: &str) -> std::result::Result<HeaderValue, hyper::header::InvalidHeaderValue> {
    HeaderValue::from_bytes(value.as_bytes())
}

const JSON_TYPE: &str = "application/json;charset=utf-8";

fn json_response(status: u16, value: &Value) -> Response<Body> {
    response(
        status,
        &[("Content-Type", JSON_TYPE), ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff")],
        full_body(js_json(value)),
    )
}

/// `ok(data, status)`: the success envelope `{ data }`.
pub fn ok_status(data: Value, status: u16) -> Response<Body> {
    let data = if data.is_null() { Value::Object(Map::new()) } else { data };
    json_response(status, &json!({ "data": data }))
}

pub fn ok(data: Value) -> Response<Body> {
    ok_status(data, 200)
}

/// `fail(status, code, message)`: the error envelope.
pub fn fail(status: u16, code: &str, message: &str) -> Response<Body> {
    json_response(status, &json!({ "error": { "code": code, "message": message } }))
}

/// A plain-text answer, as `new Response("…", { status })` gives.
pub fn text_response(status: u16, text: &'static str) -> Response<Body> {
    response(status, &[("Content-Type", "text/plain;charset=utf-8")], full_body(text))
}

/// What a handler returns: data for the envelope, or a response of its own.
pub enum Reply {
    Data(Value),
    Response(Response<Body>),
}

impl From<Value> for Reply {
    fn from(value: Value) -> Self {
        Reply::Data(value)
    }
}

impl From<Response<Body>> for Reply {
    fn from(response: Response<Body>) -> Self {
        Reply::Response(response)
    }
}

/// `return {}` in a handler.
pub fn empty() -> Result<Reply> {
    Ok(Reply::Data(Value::Object(Map::new())))
}

// ---------------------------------------------------------------------------
// Requests

/// A request as handlers see it.
pub struct Ctx {
    pub method: String,
    /// `url.pathname`, normalized as the URL parser does.
    pub path: String,
    /// `url.searchParams`, decoded, in order.
    pub query: Vec<(String, String)>,
    pub headers: HeaderMap,
    pub params: HashMap<String, String>,
    pub ip: String,
    pub user: Option<AuthUser>,
    pub session: Option<AuthSession>,
    /// `Set-Cookie` values appended to the response.
    pub cookies: Vec<String>,
    pub body: Option<Incoming>,
}

impl Ctx {
    /// `req.headers.get(name)`: several values are joined with `", "`.
    pub fn header(&self, name: &str) -> Option<String> {
        header(&self.headers, name)
    }

    /// `url.searchParams.get(name)`: the first value.
    pub fn query_param(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    /// `ctx.params[name]!`.
    pub fn param(&self, name: &str) -> &str {
        self.params.get(name).map_or("", String::as_str)
    }

    /// The signed-in user of a route that requires one.
    pub fn user(&self) -> &AuthUser {
        self.user.as_ref().expect("route requires a session")
    }

    pub fn session(&self) -> &AuthSession {
        self.session.as_ref().expect("route requires a session")
    }
}

pub fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut values = headers.get_all(name).iter().map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
    let first = values.next()?;
    Some(values.fold(first, |mut joined, next| {
        joined.push_str(", ");
        joined.push_str(&next);
        joined
    }))
}

// ---------------------------------------------------------------------------
// Routing

pub type HandlerFuture<'a> = Pin<Box<dyn Future<Output = Result<Reply>> + Send + 'a>>;
pub type Handler = for<'a> fn(&'a mut Ctx) -> HandlerFuture<'a>;

pub struct Route {
    pub method: &'static str,
    pub segments: Vec<&'static str>,
    pub is_public: bool,
    pub handler: Handler,
}

fn define(method: &'static str, path: &'static str, is_public: bool, handler: Handler) -> Route {
    Route { method, segments: path.split('/').filter(|s| !s.is_empty()).collect(), is_public, handler }
}

pub fn get(path: &'static str, handler: Handler) -> Route {
    define("GET", path, false, handler)
}

pub fn post(path: &'static str, handler: Handler) -> Route {
    define("POST", path, false, handler)
}

pub fn public_get(path: &'static str, handler: Handler) -> Route {
    define("GET", path, true, handler)
}

pub fn public_post(path: &'static str, handler: Handler) -> Route {
    define("POST", path, true, handler)
}

/// Wraps an `async fn(&mut Ctx) -> Result<Reply>` as a [`Handler`].
#[macro_export]
macro_rules! handler {
    ($f:path) => {{
        fn wrapped(ctx: &mut $crate::http::Ctx) -> $crate::http::HandlerFuture<'_> {
            Box::pin($f(ctx))
        }
        wrapped as $crate::http::Handler
    }};
}

fn specificity(route: &Route) -> String {
    route.segments.iter().map(|s| if s.starts_with(':') { '1' } else { '0' }).collect()
}

pub struct Router {
    routes: Vec<Route>,
}

pub struct Match<'r> {
    pub route: &'r Route,
    pub params: HashMap<String, String>,
}

impl Router {
    /// Routes are tried from the most static to the most parametric; routes
    /// of equal specificity keep the order they were registered in.
    pub fn new(mut routes: Vec<Route>) -> Router {
        routes.sort_by_key(specificity);
        Router { routes }
    }

    pub fn find(&self, method: &str, pathname: &str) -> Option<Match<'_>> {
        let lookup = if method == "HEAD" { "GET" } else { method };
        let parts: Vec<&str> = pathname.split('/').filter(|s| !s.is_empty()).collect();
        'routes: for route in &self.routes {
            if route.method != lookup || route.segments.len() != parts.len() {
                continue;
            }
            let mut params = HashMap::new();
            for (segment, part) in route.segments.iter().zip(&parts) {
                if let Some(name) = segment.strip_prefix(':') {
                    match decode_uri_component(part) {
                        Some(value) => params.insert(name.to_string(), value),
                        None => continue 'routes,
                    };
                } else if segment != part {
                    continue 'routes;
                }
            }
            return Some(Match { route, params });
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Bodies

pub const JSON_LIMIT: usize = 1024 * 1024;

/// JSON nested deeper than this is refused as malformed. Documents may be
/// 100 nodes deep, which is about 200 levels of JSON; nothing legitimate
/// comes near this, and the bound keeps parsing off the edge of the stack.
const MAX_JSON_DEPTH: usize = 512;

fn too_large(message: &str) -> AppError {
    http_error(413, "payload_too_large", message)
}

/// `Number(req.headers.get("content-length") ?? "0")`.
pub fn declared_length(headers: &HeaderMap) -> f64 {
    header(headers, "content-length").map_or(0.0, |v| string_to_number(&v))
}

async fn read_limited(ctx: &mut Ctx, limit: usize) -> Result<Bytes> {
    if declared_length(&ctx.headers) > limit as f64 {
        return Err(too_large("Request body is too large"));
    }
    let Some(mut body) = ctx.body.take() else { return Ok(Bytes::new()) };
    let mut out = BytesMut::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| AppError::other(format!("reading the request body failed: {e}")))?;
        if let Ok(data) = frame.into_data() {
            if out.len() + data.len() > limit {
                return Err(too_large("Request body is too large"));
            }
            out.extend_from_slice(&data);
        }
    }
    Ok(out.freeze())
}

/// Reads the body as UTF-8 text, whatever its content type.
pub async fn read_text(ctx: &mut Ctx, limit: usize) -> Result<String> {
    Ok(String::from_utf8_lossy(&read_limited(ctx, limit).await?).into_owned())
}

/// The deepest nesting of arrays and objects in a JSON text.
fn json_depth(bytes: &[u8]) -> usize {
    let mut depth = 0usize;
    let mut deepest = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for &b in bytes {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'[' | b'{' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    deepest
}

/// `JSON.parse` of a request body.
pub fn parse_body_json(bytes: &[u8]) -> Option<Value> {
    if json_depth(bytes) > MAX_JSON_DEPTH {
        return None;
    }
    // A byte-order mark is not JSON; `TextDecoder` strips it before `JSON.parse` sees the text.
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    crate::jsutil::parse_json_text(&String::from_utf8_lossy(bytes), true).ok()
}

/// A builder for the server's own HTTPS requests (the identity provider, S3)
/// that also trusts the authorities in `NODE_EXTRA_CA_CERTS`, as Bun's `fetch`
/// does and as the mail connection does (`smtp.rs`).
pub fn https_client() -> reqwest::ClientBuilder {
    let mut builder = reqwest::Client::builder();
    if let Ok(path) = std::env::var("NODE_EXTRA_CA_CERTS") {
        if let Ok(pem) = std::fs::read(&path) {
            for certificate in reqwest::Certificate::from_pem_bundle(&pem).unwrap_or_default() {
                builder = builder.add_root_certificate(certificate);
            }
        }
    }
    builder
}

/// Reads what is left of a request body, so the connection stays usable
/// after an answer that did not need all of it (Bun does the same).
pub fn drain_unread(body: Incoming) {
    use http_body::Body as _;
    if body.is_end_stream() {
        return;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    let cap = crate::config::config().file_size_limit + 2 * 1024 * 1024;
    runtime.spawn(async move {
        let mut body = body;
        let mut seen = 0u64;
        let drain = async {
            while let Some(Ok(frame)) = body.frame().await {
                seen += frame.data_ref().map_or(0, |data| data.len() as u64);
                if seen > cap {
                    break;
                }
            }
        };
        let _ = tokio::time::timeout(std::time::Duration::from_secs(30), drain).await;
    });
}

impl Drop for Ctx {
    fn drop(&mut self) {
        if let Some(body) = self.body.take() {
            drain_unread(body);
        }
    }
}

/// A request body nobody has asked for yet; what is left of it when this is
/// dropped is read and thrown away.
pub struct Unread(pub Option<Incoming>);

impl Drop for Unread {
    fn drop(&mut self) {
        if let Some(body) = self.0.take() {
            drain_unread(body);
        }
    }
}

/// Parses a JSON object body. Requiring `application/json` means a cross-site
/// form cannot submit it without a CORS preflight.
pub async fn read_json_limit(ctx: &mut Ctx, limit: usize) -> Result<Map<String, Value>> {
    let content_type = ctx.header("content-type").unwrap_or_default();
    let bytes = read_limited(ctx, limit).await?;
    if bytes.is_empty() {
        return Ok(Map::new());
    }
    if !content_type.to_lowercase().starts_with("application/json") {
        return Err(http_error(415, "unsupported_media_type", "Expected application/json"));
    }
    match parse_body_json(&bytes) {
        None => Err(bad_request("Malformed JSON")),
        Some(Value::Object(map)) => Ok(map),
        Some(_) => Err(bad_request("Expected a JSON object")),
    }
}

pub async fn read_json(ctx: &mut Ctx) -> Result<Map<String, Value>> {
    read_json_limit(ctx, JSON_LIMIT).await
}

/// A file in a multipart form.
#[derive(Debug, Clone)]
pub struct FormFile {
    pub name: String,
    pub content_type: String,
    pub data: Bytes,
}

#[derive(Debug, Clone)]
pub enum FormValue {
    Text(String),
    File(FormFile),
}

/// The fields of a multipart form, in order.
pub struct Form {
    pub fields: Vec<(String, FormValue)>,
}

impl Form {
    /// `form.get(name)`: the first field of that name.
    pub fn get(&self, name: &str) -> Option<&FormValue> {
        self.fields.iter().find(|(field, _)| field == name).map(|(_, value)| value)
    }
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() || from > haystack.len() - needle.len() {
        return None;
    }
    haystack[from..].windows(needle.len()).position(|window| window == needle).map(|i| i + from)
}

/// A parameter of a header value: `name="value"` or `name=value`.
fn header_param(header: &str, name: &str) -> Option<String> {
    for part in header.split(';').skip(1) {
        let Some((key, value)) = part.split_once('=') else { continue };
        if key.trim().eq_ignore_ascii_case(name) {
            let value = value.trim();
            return Some(match value.strip_prefix('"') {
                Some(rest) => rest.strip_suffix('"').unwrap_or(rest).replace("\\\"", "\""),
                None => value.to_string(),
            });
        }
    }
    None
}

fn parse_multipart(content_type: &str, body: &Bytes) -> Option<Form> {
    let boundary = header_param(content_type, "boundary").filter(|b| !b.is_empty())?;
    let delimiter = format!("--{boundary}").into_bytes();
    let mut fields = Vec::new();
    let mut at = find(body, &delimiter, 0)? + delimiter.len();
    loop {
        if body.get(at..at + 2) == Some(b"--") {
            return Some(Form { fields });
        }
        // The rest of the delimiter line.
        at = find(body, b"\r\n", at)? + 2;
        let head_end = find(body, b"\r\n\r\n", at.saturating_sub(2))?;
        let head = String::from_utf8_lossy(&body[at.min(head_end)..head_end]).into_owned();
        let start = head_end + 4;
        let mut closing = Vec::with_capacity(delimiter.len() + 2);
        closing.extend_from_slice(b"\r\n");
        closing.extend_from_slice(&delimiter);
        let end = find(body, &closing, start)?;
        let mut disposition = None;
        let mut part_type = None;
        for line in head.split("\r\n") {
            let Some((name, value)) = line.split_once(':') else { continue };
            match name.trim().to_ascii_lowercase().as_str() {
                "content-disposition" => disposition = Some(value.trim().to_string()),
                "content-type" => part_type = Some(value.trim().to_string()),
                _ => {}
            }
        }
        let disposition = disposition?;
        let name = header_param(&disposition, "name")?;
        let data = body.slice(start..end);
        let value = match header_param(&disposition, "filename") {
            Some(filename) => FormValue::File(FormFile { name: filename, content_type: part_type.unwrap_or_default(), data }),
            None => FormValue::Text(String::from_utf8_lossy(&data).into_owned()),
        };
        fields.push((name, value));
        at = end + closing.len();
    }
}

/// Parses a multipart body, rejecting it up front when the declared size exceeds `limit`.
pub async fn read_form(ctx: &mut Ctx, limit: usize) -> Result<Form> {
    let content_type = ctx.header("content-type").unwrap_or_default();
    if !content_type.to_lowercase().starts_with("multipart/form-data") {
        return Err(http_error(415, "unsupported_media_type", "Expected multipart/form-data"));
    }
    if declared_length(&ctx.headers) > limit as f64 {
        return Err(too_large("File is too large"));
    }
    let malformed = || bad_request("Malformed multipart body");
    let Some(mut body) = ctx.body.take() else { return Err(malformed()) };
    let mut bytes = BytesMut::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| malformed())?;
        if let Ok(data) = frame.into_data() {
            // A body that declares no length is counted as it arrives, so it
            // cannot grow past the limit in memory either.
            if bytes.len() + data.len() > limit {
                ctx.body = Some(body);
                return Err(too_large("File is too large"));
            }
            bytes.extend_from_slice(&data);
        }
    }
    parse_multipart(&content_type, &bytes.freeze()).ok_or_else(malformed)
}

/// `formFile(form, name)`: the file in that field.
pub fn form_file(form: &Form, name: &str) -> Result<FormFile> {
    match form.get(name) {
        Some(FormValue::File(file)) => Ok(file.clone()),
        _ => Err(bad_request(format!("Missing file field \"{name}\""))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noop(_ctx: &mut Ctx) -> HandlerFuture<'_> {
        Box::pin(async { empty() })
    }

    #[test]
    fn static_segments_win_over_parameters() {
        let router = Router::new(vec![
            get("/pages/:page", noop),
            get("/pages/recent", noop),
            post("/pages/:id/labels", noop),
            get("/spaces/:id/pages", noop),
            get("/spaces/all", noop),
            get("/spaces/:space", noop),
        ]);
        let hit = |method: &str, path: &str| router.find(method, path).map(|m| (m.route.segments.join("/"), m.params));
        assert_eq!(hit("GET", "/pages/recent").unwrap().0, "pages/recent");
        assert_eq!(hit("GET", "/pages/abc").unwrap().1["page"], "abc");
        assert_eq!(hit("HEAD", "/spaces/all").unwrap().0, "spaces/all");
        assert_eq!(hit("GET", "//spaces///x//pages/").unwrap().0, "spaces/:id/pages");
        assert_eq!(hit("GET", "/pages/a%20b").unwrap().1["page"], "a b");
        assert!(hit("GET", "/pages/%zz").is_none());
        assert!(hit("POST", "/pages/recent").is_none());
        assert!(hit("GET", "/").is_none());
    }

    #[test]
    fn parses_multipart_forms() {
        let body = Bytes::from_static(
            b"--XX\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nhello\r\n--XX\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a b.png\"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\n\r\n--XX--\r\n",
        );
        let form = parse_multipart("multipart/form-data; boundary=XX", &body).unwrap();
        assert!(matches!(form.get("note"), Some(FormValue::Text(t)) if t == "hello"));
        let file = form_file(&form, "file").unwrap();
        assert_eq!((file.name.as_str(), file.content_type.as_str(), &file.data[..]), ("a b.png", "image/png", &b"\x89PNG\r\n"[..]));
        assert!(form_file(&form, "note").is_err());
        assert!(parse_multipart("multipart/form-data", &body).is_none());
        assert!(parse_multipart("multipart/form-data; boundary=YY", &body).is_none());
        assert!(parse_multipart("multipart/form-data; boundary=XX", &Bytes::from_static(b"--XX\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nunterminated")).is_none());
    }

    #[test]
    fn bounds_json_depth() {
        assert_eq!(json_depth(br#"{"a":[{"b":"]]]}}}"}]}"#), 3);
        assert!(parse_body_json("[".repeat(600).as_bytes()).is_none());
        assert_eq!(parse_body_json(b"{\"a\":1.0}"), Some(json!({"a": 1})));
        assert!(parse_body_json(b"{\"a\":1} x").is_none());
    }
}
