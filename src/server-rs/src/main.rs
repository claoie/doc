//! Port of `src/server/start.ts`: the process.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use doc_server::app::{handle, App};
use doc_server::auth::purge_expired_sessions;
use doc_server::config::config;
use doc_server::db;
use doc_server::http::AppError;
use doc_server::logger;
use doc_server::mail::flush_mail;
use doc_server::realtime::leader::start_leading;
use doc_server::realtime::ws::{shutdown_realtime, start_session_checks};
use doc_server::sso::sso_problems;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::signal::unix::{signal, SignalKind};

const HOUR: Duration = Duration::from_secs(60 * 60);

/// The built web app sits next to the server, as in the image:
/// `<dir>/server/doc-server` and `<dir>/client`. Run from the repository
/// (`cargo run`), it is the Vite build in `build/client`.
fn resolve_static_dir() -> Option<PathBuf> {
    let beside = std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.parent()?.join("client")));
    let from_repository = std::env::current_dir().ok().map(|dir| dir.join("build").join("client"));
    [beside, from_repository].into_iter().flatten().find(|dir| dir.join("index.html").is_file())
}

async fn run_housekeeping() {
    let run = async {
        let purged = doc_server::pages::purge_trash().await?;
        if purged > 0 {
            logger::info_with("trash purged", json!({ "pages": purged }));
        }
        purge_expired_sessions().await
    };
    let result: Result<(), AppError> = run.await;
    if let Err(error) = result {
        logger::error("housekeeping failed", &error);
    }
}

/// Listens like `Bun.serve`: on every address of the machine, IPv6 and IPv4,
/// through one socket (an IPv4 client's address reads as IPv4, see `app.rs`).
fn listen_on_both(port: u16) -> std::io::Result<TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let socket = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_only_v6(false)?;
    socket.set_reuse_address(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, port)).into())?;
    socket.listen(1024)?;
    TcpListener::from_std(socket.into())
}

/// Whether the server on this machine answers `GET /api/health`.
async fn healthy() -> bool {
    let port = std::env::var("PORT").ok().and_then(|port| port.parse::<u16>().ok()).unwrap_or(3000);
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(5)).no_proxy().build() else { return false };
    matches!(client.get(format!("http://127.0.0.1:{port}/api/health")).send().await, Ok(response) if response.status().is_success())
}

async fn run() -> Result<(), AppError> {
    let problems = sso_problems();
    if !problems.is_empty() {
        logger::error_fields("invalid configuration, not starting", json!({ "problems": problems }));
        std::process::exit(1);
    }
    let settings = config();
    db::connect(&settings.database_url, settings.database_pool_max)?;
    db::migrate().await?;
    start_leading().await;
    start_session_checks();
    let static_dir = resolve_static_dir();
    let app = Arc::new(App::new(static_dir.clone()));
    let listener = match listen_on_both(settings.port) {
        Ok(listener) => listener,
        // No IPv6 on this machine.
        Err(_) => TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], settings.port))).await?,
    };
    logger::info_with("server started", json!({ "port": listener.local_addr()?.port(), "staticDir": static_dir }));

    tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(60)).await;
        run_housekeeping().await;
        let mut hourly = tokio::time::interval(HOUR);
        hourly.tick().await;
        loop {
            hourly.tick().await;
            run_housekeeping().await;
        }
    });

    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    // Dropped senders tell the connections to finish; closed receivers tell this loop they have.
    let (stop, stopping) = tokio::sync::watch::channel(false);
    let (alive, mut finished) = tokio::sync::mpsc::channel::<()>(1);
    let mut http = hyper::server::conn::http1::Builder::new();
    http.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(60)).keep_alive(true);

    let signal_name = loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { continue };
                let _ = stream.set_nodelay(true);
                let app = app.clone();
                let service = service_fn(move |request| {
                    let app = app.clone();
                    async move {
                        // A request that has started is handled to its end even when its client
                        // goes away, as in Bun: hyper drops this future then, and a handler cut
                        // off between a write and what must follow it (the re-check of open
                        // sockets, the bookkeeping of a save) would leave the two apart.
                        let handled = tokio::spawn(async move { handle(&app, request, peer).await });
                        Ok::<_, std::convert::Infallible>(match handled.await {
                            Ok(response) => response,
                            Err(_) => doc_server::http::fail(500, "internal_error", "Something went wrong"),
                        })
                    }
                });
                let connection = http.serve_connection(TokioIo::new(stream), service).with_upgrades();
                let mut stopping = stopping.clone();
                let alive = alive.clone();
                tokio::spawn(async move {
                    tokio::pin!(connection);
                    tokio::select! {
                        _ = connection.as_mut() => {}
                        _ = stopping.changed() => {
                            // The request in flight is answered, then the connection closes.
                            connection.as_mut().graceful_shutdown();
                            let _ = connection.await;
                        }
                    }
                    drop(alive);
                });
            }
            _ = terminate.recv() => break "SIGTERM",
            _ = interrupt.recv() => break "SIGINT",
        }
    };

    logger::info_with("shutting down", json!({ "signal": signal_name }));
    drop(listener);
    shutdown_realtime().await;
    // Requests in flight finish; idle connections are closed.
    let _ = stop.send(true);
    drop(alive);
    let _ = tokio::time::timeout(Duration::from_secs(10), finished.recv()).await;
    flush_mail().await;
    db::disconnect().await;
    Ok(())
}

#[tokio::main]
async fn main() {
    // `doc-server health`: the image's health check. The image has no shell
    // tools to ask with, so the server asks itself.
    if std::env::args().nth(1).as_deref() == Some("health") {
        std::process::exit(if healthy().await { 0 } else { 1 });
    }
    match run().await {
        Ok(()) => std::process::exit(0),
        Err(error) => {
            logger::error("startup failed", &error);
            std::process::exit(1);
        }
    }
}
