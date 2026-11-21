//! Port of `src/server/app.ts`: every request starts here.

use std::net::SocketAddr;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::time::Instant;

use futures_util::FutureExt;
use hyper::body::Incoming;
use hyper::{Request, Response};
use serde_json::json;
use url::Url;

use crate::auth::authenticate;
use crate::config::config;
use crate::http::{append_header, declared_length, fail, header, http_error, ok, unauthorized, AppError, Body, Ctx, Reply, Result, Route, Router, Unread};
use crate::jsutil::{js_slice, js_trim};
use crate::logger::{self, log_request, RequestLog};
use crate::realtime::ws::upgrade;
use crate::routes;
use crate::static_files::serve_static;

pub struct App {
    router: Router,
    /// Directory of the built client, or `None` to serve no static files.
    static_dir: Option<PathBuf>,
    /// Larger request bodies are refused outright.
    max_body: f64,
}

fn all_routes() -> Vec<Route> {
    let mut all = Vec::new();
    all.extend(routes::health::routes());
    all.extend(routes::auth::routes());
    all.extend(routes::sso::routes());
    all.extend(routes::bases::routes());
    all.extend(routes::me::routes());
    all.extend(routes::workspace::routes());
    all.extend(routes::members::routes());
    all.extend(routes::invitations::routes());
    all.extend(routes::groups::routes());
    all.extend(routes::spaces::routes());
    all.extend(routes::pages::routes());
    all.extend(routes::labels::routes());
    all.extend(routes::favorites::routes());
    all.extend(routes::watch::routes());
    all.extend(routes::comments::routes());
    all.extend(routes::files::routes());
    all.extend(routes::search::routes());
    all.extend(routes::shares::routes());
    all.extend(routes::notifications::routes());
    all.extend(routes::export::routes());
    all
}

impl App {
    pub fn new(static_dir: Option<PathBuf>) -> App {
        App { router: Router::new(all_routes()), static_dir, max_body: (config().file_size_limit + 2 * 1024 * 1024) as f64 }
    }
}

fn client_ip(headers: &hyper::HeaderMap, peer: &SocketAddr) -> String {
    if config().trust_proxy {
        if let Some(forwarded) = header(headers, "x-forwarded-for") {
            let last = js_trim(forwarded.rsplit(',').next().unwrap_or(""));
            if !last.is_empty() {
                return js_slice(last, 0, Some(64));
            }
        }
    }
    match peer.ip() {
        // An IPv4 client on a dual-stack socket is reported by its IPv4 address.
        std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or_else(|| v6.to_string(), |v4| v4.to_string()),
        ip => ip.to_string(),
    }
}

/// `url.host`: the host, with its port unless it is the scheme's default.
fn url_host(url: &Url) -> String {
    match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        _ => String::new(),
    }
}

/// Cross-site requests may not mutate state: a present Origin must match the app or the request host.
fn same_origin(headers: &hyper::HeaderMap) -> bool {
    let origin = header(headers, "origin").unwrap_or_default();
    if origin.is_empty() {
        return true;
    }
    if origin == "null" {
        return false;
    }
    let Ok(url) = Url::parse(&origin) else { return false };
    let app_origin = Url::parse(&config().app_url).map(|u| u.origin().ascii_serialization()).unwrap_or_default();
    url.origin().ascii_serialization() == app_origin || Some(url_host(&url)) == header(headers, "host")
}

struct Target {
    path: String,
    query: Vec<(String, String)>,
}

/// The request's URL as `new URL(req.url)` reads it: the path normalized, the query decoded.
fn target(request: &Request<Incoming>) -> Target {
    let raw = request.uri().path_and_query().map_or("/", |pq| pq.as_str());
    let host = header(request.headers(), "host").filter(|h| !h.is_empty()).unwrap_or_else(|| "localhost".into());
    let parsed = Url::parse(&format!("http://{host}{raw}")).or_else(|_| Url::parse(&format!("http://localhost{raw}")));
    match parsed {
        Ok(url) => Target {
            path: url.path().to_string(),
            query: url.query_pairs().map(|(key, value)| (key.into_owned(), value.into_owned())).collect(),
        },
        Err(_) => Target { path: request.uri().path().to_string(), query: Vec::new() },
    }
}

async fn route(app: &App, request: Request<Incoming>, target: Target, ip: String, user_id: &mut Option<String>) -> Result<Response<Body>> {
    let auth = authenticate(request.headers()).await?;
    *user_id = auth.as_ref().map(|a| a.user.id.clone());
    if target.path == "/api/ws" {
        let Some(auth) = auth else { return Ok(fail(401, "unauthorized", "Sign in required")) };
        return upgrade(request, auth.user, auth.session).await;
    }
    let (parts, body) = request.into_parts();
    let mut unread = Unread(Some(body));
    let method = parts.method.as_str().to_string();
    // The identity provider posts its events from its own server, each one signed.
    let provider_event = target.path == "/api/auth/events" && config().sso.is_some();
    if method != "GET" && method != "HEAD" && !provider_event && !same_origin(&parts.headers) {
        return Err(http_error(403, "forbidden_origin", "Cross-origin request rejected"));
    }
    let sub_path = &target.path["/api".len()..];
    let Some(found) = app.router.find(&method, if sub_path.is_empty() { "/" } else { sub_path }) else {
        return Err(http_error(404, "not_found", "Endpoint not found"));
    };
    if !found.route.is_public && auth.is_none() {
        return Err(unauthorized());
    }
    let (user, session, refreshed) = match auth {
        Some(auth) => (Some(auth.user), Some(auth.session), auth.refreshed_cookie),
        None => (None, None, None),
    };
    let mut ctx = Ctx {
        method,
        path: target.path,
        query: target.query,
        headers: parts.headers,
        params: found.params,
        ip,
        user,
        session,
        cookies: refreshed.into_iter().collect(),
        body: unread.0.take(),
    };
    let reply = (found.route.handler)(&mut ctx).await?;
    let mut response = match reply {
        Reply::Data(data) => ok(data),
        Reply::Response(response) => response,
    };
    for cookie in &ctx.cookies {
        append_header(&mut response, "Set-Cookie", cookie);
    }
    Ok(response)
}

async fn handle_api(app: &App, request: Request<Incoming>, target: Target, peer: SocketAddr) -> Response<Body> {
    let started = Instant::now();
    let ip = client_ip(request.headers(), &peer);
    let method = request.method().as_str().to_string();
    let path = target.path.clone();
    let is_socket = path == "/api/ws";
    let mut user_id = None;
    // A panic in a handler is a bug, and is answered like any other unexpected error.
    let outcome = AssertUnwindSafe(route(app, request, target, ip, &mut user_id)).catch_unwind().await;
    let (response, failed) = match outcome {
        Ok(Ok(response)) => (response, false),
        Ok(Err(AppError::Http(error))) => (fail(error.status, &error.code, &error.message), true),
        Ok(Err(error)) => {
            logger::error_with("request failed", &error, json!({ "method": method, "path": path }));
            (fail(500, "internal_error", "Something went wrong"), true)
        }
        Err(panic) => {
            let message = panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            logger::error_with("request failed", &message, json!({ "method": method, "path": path }));
            (fail(500, "internal_error", "Something went wrong"), true)
        }
    };
    // The socket endpoint answers before the request is counted as answered, so
    // it is logged as the upgrade it was asked for unless it failed outright.
    let status = if is_socket && !failed { 101 } else { response.status().as_u16() };
    log_request(&RequestLog { method: &method, path: &path, status, ms: started.elapsed().as_millis() as u64, user_id: user_id.as_deref() });
    response
}

pub async fn handle(app: &App, request: Request<Incoming>, peer: SocketAddr) -> Response<Body> {
    if declared_length(request.headers()) > app.max_body {
        return crate::http::text_response(413, "");
    }
    let target = target(&request);
    if target.path == "/api" || target.path.starts_with("/api/") {
        return handle_api(app, request, target, peer).await;
    }
    serve_static(request.method().as_str(), request.headers(), &target.path, app.static_dir.as_deref()).await
}
