//! Port of `src/server/realtime/ws.ts`: the WebSocket endpoint `/api/ws`.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::stream::FuturesUnordered;
use futures_util::{SinkExt, StreamExt};
use hyper::body::Incoming;
use hyper::upgrade::Upgraded;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use tokio_tungstenite::tungstenite::error::{CapacityError, Error as WsError};
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use url::Url;

use super::collab::{disconnect, flush_all, join_page, leave_page, receive_steps, refresh_open_sessions, update_presence, Recheck};
use super::hub::{registry, Members, Outgoing, Socket, SocketRef, SIGNED_OUT};
use super::leader::{is_leader, on_lead_lost, release_lease, stop_leading};
use crate::auth::{live_sessions, AuthSession, AuthUser};
use crate::common::ids::uuid;
use crate::config::config;
use crate::http::{empty_body, fail, header, response, Body, Result};
use crate::logger;
use crate::permissions::list_readable_space_ids;

const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
/// Messages a socket may send per second before it is disconnected.
const MAX_MESSAGES_PER_SECOND: u32 = 60;
/// "Try again later": clients reconnect, which reaches the leader within a try or two.
const NOT_LEADER: u16 = 1013;
/// How often the leader checks that every open socket's session is still signed in.
const SESSION_CHECK: Duration = Duration::from_millis(60_000);
/// A socket that has sent nothing (not even a pong) for this long is dropped.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const PING_EVERY: Duration = Duration::from_secs(45);

/// Whether a request's `Origin`, when it has one, is the app's or the request's own host.
pub fn allowed_origin(headers: &hyper::HeaderMap) -> bool {
    let Some(origin) = header(headers, "origin").filter(|o| !o.is_empty()) else { return true };
    let Ok(url) = Url::parse(&origin) else { return false };
    let app_origin = Url::parse(&config().app_url).map(|u| u.origin().ascii_serialization()).unwrap_or_default();
    if url.origin().ascii_serialization() == app_origin {
        return true;
    }
    let host = match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        _ => String::new(),
    };
    Some(host) == header(headers, "host")
}

fn has_token(headers: &hyper::HeaderMap, name: &str, token: &str) -> bool {
    header(headers, name).is_some_and(|value| value.split(',').any(|part| part.trim().eq_ignore_ascii_case(token)))
}

/// Upgrades an authenticated request to a realtime socket subscribed to the user's spaces.
pub async fn upgrade(mut request: Request<Incoming>, user: AuthUser, session: AuthSession) -> Result<Response<Body>> {
    if !allowed_origin(request.headers()) {
        return Ok(fail(403, "forbidden_origin", "Origin not allowed"));
    }
    let spaces = list_readable_space_ids(&user.id).await?;
    let key = header(request.headers(), "sec-websocket-key");
    let is_upgrade = request.method() == hyper::Method::GET
        && has_token(request.headers(), "connection", "upgrade")
        && has_token(request.headers(), "upgrade", "websocket");
    let Some(key) = key.filter(|_| is_upgrade) else { return Ok(fail(400, "upgrade_failed", "Expected a WebSocket upgrade")) };
    let pending = hyper::upgrade::on(&mut request);
    tokio::spawn(async move {
        match pending.await {
            Ok(upgraded) => serve(upgraded, user, session, spaces).await,
            Err(error) => logger::error("upgrading to a socket failed", &error),
        }
    });
    Ok(response(
        101,
        &[("Upgrade", "websocket"), ("Connection", "Upgrade"), ("Sec-WebSocket-Accept", &derive_accept_key(key.as_bytes()))],
        empty_body(),
    ))
}

type Stream = WebSocketStream<TokioIo<Upgraded>>;

async fn write_loop(
    mut sink: futures_util::stream::SplitSink<Stream, Message>,
    mut outgoing: UnboundedReceiver<Outgoing>,
    backlog: std::sync::Arc<std::sync::atomic::AtomicUsize>,
) {
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    loop {
        tokio::select! {
            next = outgoing.recv() => match next {
                Some(Outgoing::Text(text)) => {
                    let size = text.len();
                    let sent = sink.send(Message::text(text)).await;
                    backlog.fetch_sub(size, std::sync::atomic::Ordering::SeqCst);
                    if sent.is_err() {
                        return;
                    }
                }
                Some(Outgoing::Close(code, reason)) => {
                    let frame = CloseFrame { code: CloseCode::from(code), reason: reason.into() };
                    let _ = sink.send(Message::Close(Some(frame))).await;
                    let _ = sink.flush().await;
                    return;
                }
                Some(Outgoing::End) | None => {
                    let _ = sink.close().await;
                    return;
                }
            },
            _ = ping.tick() => {
                if sink.send(Message::Ping(Default::default())).await.is_err() {
                    return;
                }
            }
        }
    }
}

fn parse(raw: &str) -> Option<Map<String, Value>> {
    match crate::http::parse_body_json(raw.as_bytes()) {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    }
}

async fn handle(ws: &SocketRef, message: &Map<String, Value>) -> Result<()> {
    match message.get("t").and_then(Value::as_str) {
        Some("ping") => {
            ws.send(&json!({ "t": "pong" }));
            Ok(())
        }
        Some("join") => join_page(ws, message.get("pageId"), message.get("version"), message.get("clientId")).await,
        Some("leave") => leave_page(ws, message.get("pageId")).await,
        Some("steps") => receive_steps(ws, message).await,
        Some("presence") => update_presence(ws, message).await,
        _ => Ok(()),
    }
}

fn now_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

async fn on_message(ws: SocketRef, raw: String) {
    let (ws, raw) = (&ws, raw.as_str());
    if !is_leader() {
        ws.close(NOT_LEADER, "not the realtime leader");
        return;
    }
    {
        let mut window = ws.window.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = now_ms();
        // The first message opens the first window, whenever it arrives.
        if window.messages == 0 && window.start_ms == 0 || now - window.start_ms >= 1000 {
            window.start_ms = now;
            window.messages = 0;
        }
        window.messages += 1;
        if window.messages > MAX_MESSAGES_PER_SECOND {
            drop(window);
            ws.close(1008, "too many messages");
            return;
        }
    }
    let Some(message) = parse(raw) else { return };
    if let Err(error) = handle(ws, &message).await {
        logger::error("realtime message failed", &error);
    }
}

async fn serve(upgraded: Upgraded, user: AuthUser, session: AuthSession, spaces: Vec<String>) {
    let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE_BYTES)).max_frame_size(Some(MAX_MESSAGE_BYTES));
    let stream = WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config)).await;
    let (sink, mut incoming) = stream.split();
    let (sender, outgoing) = unbounded_channel();
    let backlog = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let ws = Socket::new(uuid(), session.id, user.id, user.name, spaces, sender, backlog.clone());
    let writer = tokio::spawn(write_loop(sink, outgoing, backlog));

    // Turned away here, not refused at the upgrade: clients back off further
    // after each connection that fails, and not after one that opened, so
    // they keep trying every second or so until they reach the leader.
    if is_leader() {
        registry::add_socket(&ws);
    } else {
        ws.close(NOT_LEADER, "not the realtime leader");
    }

    // As in the Bun server, a message is handled as soon as it arrives: the
    // handlers of one socket start in order and then take turns wherever they
    // wait, and a socket that closes is taken off its pages at once, even
    // while one of its messages is still being handled.
    let mut running = FuturesUnordered::new();
    let mut idle = Box::pin(tokio::time::sleep(IDLE_TIMEOUT));
    while ws.is_open() {
        tokio::select! {
            biased;
            _ = ws.closed() => break,
            next = incoming.next() => {
                idle.as_mut().reset(tokio::time::Instant::now() + IDLE_TIMEOUT);
                match next {
                    Some(Ok(Message::Text(text))) => running.push(on_message(ws.clone(), text.as_str().to_string())),
                    Some(Ok(Message::Binary(bytes))) => running.push(on_message(ws.clone(), String::from_utf8_lossy(&bytes).into_owned())),
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(WsError::Capacity(CapacityError::MessageTooLong { .. }))) => {
                        ws.close(1009, "message too big");
                        break;
                    }
                    Some(Err(_)) => break,
                }
            }
            Some(()) = running.next(), if !running.is_empty() => {}
            _ = &mut idle => break,
        }
    }
    let closed_here = !ws.is_open();
    ws.mark_closed();
    if !closed_here {
        ws.end();
    }
    // Leaving the pages and whatever messages are still being handled go on
    // by themselves: the connection does not wait for them, as it does not in Bun.
    let leaving = ws.clone();
    tokio::spawn(async move {
        let leave = async {
            if let Err(error) = disconnect(&leaving).await {
                logger::error("leaving pages on disconnect failed", &error);
            }
            registry::remove_socket(&leaving);
        };
        let drain = async { while running.next().await.is_some() {} };
        tokio::join!(leave, drain);
    });
    if closed_here {
        // Give the close frame a moment to be acknowledged before the connection goes.
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(Ok(message)) = incoming.next().await {
                if message.is_close() {
                    break;
                }
            }
        })
        .await;
    }
    drop(ws);
    finish_or_stop(writer, WRITER_GRACE).await;
}

/// How long a socket's writer may take, once the socket has ended, to send
/// what is still queued for it. A peer that has stopped reading would keep the
/// writer waiting for as long as it holds the connection open, and with it
/// the connection and everything queued for it (up to `MAX_BACKLOG_BYTES`).
const WRITER_GRACE: Duration = Duration::from_secs(5);

/// Waits up to `grace` for a task to end, and stops it if it has not: dropping
/// a task's handle would leave the task running. Either way the task, and what
/// it holds, is gone when this returns.
async fn finish_or_stop(mut task: tokio::task::JoinHandle<()>, grace: Duration) {
    if tokio::time::timeout(grace, &mut task).await.is_err() {
        task.abort();
        // Returns once the task has been dropped.
        let _ = task.await;
    }
}

async fn refresh_spaces(sockets: Vec<SocketRef>) -> Result<()> {
    let mut by_user: Vec<(String, Vec<SocketRef>)> = Vec::new();
    for ws in sockets {
        match by_user.iter_mut().find(|(user_id, _)| *user_id == ws.user_id) {
            Some((_, list)) => list.push(ws),
            None => by_user.push((ws.user_id.clone(), vec![ws])),
        }
    }
    for (user_id, user_sockets) in by_user {
        let spaces = list_readable_space_ids(&user_id).await?;
        for ws in user_sockets {
            registry::set_spaces(&ws, spaces.clone());
        }
    }
    Ok(())
}

/// Refreshes socket space subscriptions and open editors after membership changes.
pub fn on_membership_change(members: Members) {
    let sockets = match &members {
        Members::All => registry::all_sockets(),
        Members::Users(ids) => ids.iter().flat_map(|id| registry::user_sockets(id)).collect(),
    };
    tokio::spawn(async move {
        if let Err(error) = refresh_spaces(sockets).await {
            logger::error("refreshing socket subscriptions failed", &error);
        }
    });
    tokio::spawn(async move {
        let which = match members {
            Members::All => Recheck::default(),
            Members::Users(ids) => Recheck { user_ids: Some(ids), page_ids: None },
        };
        if let Err(error) = refresh_open_sessions(which).await {
            logger::error("re-checking editor access failed", &error);
        }
    });
}

/// Turned away at once, not at their next message: a quiet editor would miss
/// what others type on the new leader, and if this copy leads again, its
/// session may have gone stale under it.
fn lead_lost() {
    for ws in registry::all_sockets() {
        ws.close(NOT_LEADER, "not the realtime leader");
    }
}

/// A socket never looks at its session again after it opens, and what ends a
/// session (signing out, deactivation, an identity provider's event) may happen
/// on another copy of the server. So the leader checks every open socket's
/// session at once, and closes the sockets whose session is no longer signed
/// in, as `disconnect_user` does.
pub async fn check_socket_sessions() -> Result<()> {
    if !is_leader() {
        return Ok(());
    }
    let sockets = registry::all_sockets();
    if sockets.is_empty() {
        return Ok(());
    }
    let mut session_ids: Vec<String> = Vec::new();
    for ws in &sockets {
        if !session_ids.contains(&ws.session_id) {
            session_ids.push(ws.session_id.clone());
        }
    }
    let live = live_sessions(&session_ids).await?;
    for ws in sockets {
        if !live.contains(&ws.session_id) {
            ws.close(SIGNED_OUT, "signed out");
        }
    }
    Ok(())
}

static SESSION_CHECKS: Mutex<Option<tokio::task::JoinHandle<()>>> = Mutex::new(None);

/// Registers the realtime listeners and starts the periodic session check.
pub fn start_session_checks() {
    on_lead_lost(lead_lost);
    let mut checks = SESSION_CHECKS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if checks.is_none() {
        *checks = Some(tokio::spawn(async {
            let mut interval = tokio::time::interval(SESSION_CHECK);
            interval.tick().await;
            loop {
                interval.tick().await;
                if let Err(error) = check_socket_sessions().await {
                    logger::error("checking socket sessions failed", &error);
                }
            }
        }));
    }
}

/// Called on shutdown before the database closes. Sockets go first so nothing
/// is accepted after the last save: clients resend what wasn't confirmed. The
/// lease goes last so a successor only loads documents once they are saved.
pub async fn shutdown_realtime() {
    if let Some(checks) = SESSION_CHECKS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
        checks.abort();
    }
    stop_leading();
    for ws in registry::all_sockets() {
        ws.close(1001, "server shutting down");
    }
    if let Err(error) = flush_all().await {
        logger::error("flushing documents on shutdown failed", &error);
    }
    if let Err(error) = release_lease().await {
        logger::error("releasing the realtime lease failed", &error);
    }
    // Let the close frames leave before the process does.
    tokio::time::sleep(Duration::from_millis(50)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot::{self, error::TryRecvError};

    #[tokio::test]
    async fn a_writer_that_cannot_finish_is_stopped() {
        // A writer stuck on a peer that does not read, holding what it would send.
        let (held, released) = oneshot::channel::<()>();
        let stuck = tokio::spawn(async move {
            let _held = held;
            std::future::pending::<()>().await;
        });
        finish_or_stop(stuck, Duration::from_millis(20)).await;
        // What it held is dropped, as a writer's connection and queue would be.
        let mut released = released;
        assert_eq!(released.try_recv(), Err(TryRecvError::Closed));
    }

    #[tokio::test]
    async fn a_writer_that_finishes_in_time_is_left_to_finish() {
        let (done, finished) = oneshot::channel::<()>();
        let quick = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let _ = done.send(());
        });
        finish_or_stop(quick, Duration::from_secs(5)).await;
        let mut finished = finished;
        assert_eq!(finished.try_recv(), Ok(()));
    }
}
