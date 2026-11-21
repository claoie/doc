//! Port of `src/server/realtime/hub.ts`: the open sockets, indexed by user,
//! space and page, and the events sent to them.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{Map, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::jsutil::js_json;

/// How much may wait to be written to one socket (Bun's `backpressureLimit`).
pub const MAX_BACKLOG_BYTES: usize = 16 * 1024 * 1024;

/// What the writer half of a socket is asked to do.
#[derive(Debug)]
pub enum Outgoing {
    Text(String),
    Close(u16, &'static str),
    /// The peer closed: answer its close frame and stop writing.
    End,
}

/// Rate limiting: start of the current one-second window and messages in it.
#[derive(Default)]
pub struct Window {
    pub start_ms: u64,
    pub messages: u32,
}

pub struct Socket {
    pub connection_id: String,
    /// The session the socket was opened with; the leader closes the socket once it ends.
    pub session_id: String,
    pub user_id: String,
    pub user_name: String,
    /// Spaces whose tree events this socket receives.
    spaces: Mutex<HashSet<String>>,
    /// Pages this socket has joined.
    pages: Mutex<HashSet<String>>,
    pub window: Mutex<Window>,
    sender: UnboundedSender<Outgoing>,
    /// Bytes handed to the writer that it has not written yet.
    backlog: Arc<std::sync::atomic::AtomicUsize>,
    open: AtomicBool,
    closing: tokio::sync::Notify,
}

pub type SocketRef = Arc<Socket>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Socket {
    pub fn new(
        connection_id: String,
        session_id: String,
        user_id: String,
        user_name: String,
        spaces: Vec<String>,
        sender: UnboundedSender<Outgoing>,
        backlog: Arc<std::sync::atomic::AtomicUsize>,
    ) -> SocketRef {
        Arc::new(Socket {
            connection_id,
            session_id,
            user_id,
            user_name,
            spaces: Mutex::new(spaces.into_iter().collect()),
            pages: Mutex::new(HashSet::new()),
            window: Mutex::new(Window::default()),
            sender,
            backlog,
            open: AtomicBool::new(true),
            closing: tokio::sync::Notify::new(),
        })
    }

    /// `ws.send(text)`. Nothing is sent once the socket is closing.
    ///
    /// A peer that stops reading must not make the server keep everything it
    /// would have been sent. Bun stops queueing at 16 MiB and drops what comes
    /// after; a client with a hole in what it received is out of step for
    /// good, so here the socket is closed instead and the client starts over.
    pub fn send_text(&self, text: String) {
        if !self.is_open() {
            return;
        }
        let waiting = self.backlog.fetch_add(text.len(), Ordering::SeqCst) + text.len();
        if waiting > MAX_BACKLOG_BYTES {
            self.backlog.fetch_sub(text.len(), Ordering::SeqCst);
            self.close(1008, "too far behind");
            return;
        }
        let _ = self.sender.send(Outgoing::Text(text));
    }

    /// `ws.send(JSON.stringify(message))`.
    pub fn send(&self, message: &Value) {
        self.send_text(js_json(message));
    }

    /// `ws.close(code, reason)`.
    pub fn close(&self, code: u16, reason: &'static str) {
        if self.open.swap(false, Ordering::SeqCst) {
            let _ = self.sender.send(Outgoing::Close(code, reason));
            self.closing.notify_waiters();
        }
    }

    /// Resolves once the socket is no longer open.
    pub async fn closed(&self) {
        loop {
            let closing = self.closing.notified();
            if !self.is_open() {
                return;
            }
            closing.await;
        }
    }

    /// `ws.readyState === WebSocket.OPEN`.
    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Marks the socket closed without sending anything (the peer went away).
    pub fn mark_closed(&self) {
        self.open.store(false, Ordering::SeqCst);
        self.closing.notify_waiters();
    }

    /// Lets the writer finish the closing handshake the peer started.
    pub fn end(&self) {
        let _ = self.sender.send(Outgoing::End);
    }

    pub fn pages(&self) -> Vec<String> {
        lock(&self.pages).iter().cloned().collect()
    }
}

#[derive(Default)]
struct Registry {
    by_user: HashMap<String, Vec<SocketRef>>,
    by_space: HashMap<String, Vec<SocketRef>>,
    by_page: HashMap<String, Vec<SocketRef>>,
}

static REGISTRY: Mutex<Option<Registry>> = Mutex::new(None);

fn with_registry<T>(f: impl FnOnce(&mut Registry) -> T) -> T {
    let mut guard = lock(&REGISTRY);
    f(guard.get_or_insert_with(Registry::default))
}

fn add(map: &mut HashMap<String, Vec<SocketRef>>, key: &str, ws: &SocketRef) {
    let set = map.entry(key.to_string()).or_default();
    if !set.iter().any(|other| Arc::ptr_eq(other, ws)) {
        set.push(ws.clone());
    }
}

fn remove(map: &mut HashMap<String, Vec<SocketRef>>, key: &str, ws: &SocketRef) {
    if let Some(set) = map.get_mut(key) {
        set.retain(|other| !Arc::ptr_eq(other, ws));
        if set.is_empty() {
            map.remove(key);
        }
    }
}

pub mod registry {
    use super::*;

    pub fn add_socket(ws: &SocketRef) {
        with_registry(|r| {
            add(&mut r.by_user, &ws.user_id, ws);
            for space_id in lock(&ws.spaces).iter() {
                add(&mut r.by_space, space_id, ws);
            }
            for page_id in lock(&ws.pages).iter() {
                add(&mut r.by_page, page_id, ws);
            }
        });
    }

    pub fn remove_socket(ws: &SocketRef) {
        with_registry(|r| {
            remove(&mut r.by_user, &ws.user_id, ws);
            for space_id in lock(&ws.spaces).iter() {
                remove(&mut r.by_space, space_id, ws);
            }
            for page_id in lock(&ws.pages).iter() {
                remove(&mut r.by_page, page_id, ws);
            }
        });
    }

    pub fn set_spaces(ws: &SocketRef, space_ids: Vec<String>) {
        with_registry(|r| {
            let mut spaces = lock(&ws.spaces);
            for space_id in spaces.iter() {
                remove(&mut r.by_space, space_id, ws);
            }
            *spaces = space_ids.into_iter().collect();
            // A socket that has closed meanwhile is no longer registered and must stay so.
            if r.by_user.get(&ws.user_id).is_some_and(|set| set.iter().any(|other| Arc::ptr_eq(other, ws))) {
                for space_id in spaces.iter() {
                    add(&mut r.by_space, space_id, ws);
                }
            }
        });
    }

    pub fn join_page(ws: &SocketRef, page_id: &str) {
        with_registry(|r| {
            lock(&ws.pages).insert(page_id.to_string());
            add(&mut r.by_page, page_id, ws);
        });
    }

    pub fn leave_page(ws: &SocketRef, page_id: &str) {
        with_registry(|r| {
            lock(&ws.pages).remove(page_id);
            remove(&mut r.by_page, page_id, ws);
        });
    }

    pub fn user_sockets(user_id: &str) -> Vec<SocketRef> {
        with_registry(|r| r.by_user.get(user_id).cloned().unwrap_or_default())
    }

    pub fn all_sockets() -> Vec<SocketRef> {
        with_registry(|r| r.by_user.values().flatten().cloned().collect())
    }
}

fn broadcast(sockets: Vec<SocketRef>, event: &Value) {
    if sockets.is_empty() {
        return;
    }
    // `{ t: "event", ...event }`
    let mut message = Map::new();
    message.insert("t".into(), Value::String("event".into()));
    if let Value::Object(fields) = event {
        for (key, value) in fields {
            message.insert(key.clone(), value.clone());
        }
    }
    let text = js_json(&Value::Object(message));
    for ws in sockets {
        ws.send_text(text.clone());
    }
}

pub fn emit_to_space(space_id: &str, event: &Value) {
    broadcast(with_registry(|r| r.by_space.get(space_id).cloned().unwrap_or_default()), event);
}

pub fn emit_to_user(user_id: &str, event: &Value) {
    broadcast(with_registry(|r| r.by_user.get(user_id).cloned().unwrap_or_default()), event);
}

pub fn emit_to_page(page_id: &str, event: &Value) {
    broadcast(with_registry(|r| r.by_page.get(page_id).cloned().unwrap_or_default()), event);
}

/// Whose space access may have changed.
#[derive(Debug, Clone)]
pub enum Members {
    All,
    Users(Vec<String>),
}

/// Called by routes whenever space access may have changed for these users:
/// socket subscriptions and open editors are re-checked in the background.
pub fn membership_changed(user_ids: Vec<String>) {
    if user_ids.is_empty() {
        return;
    }
    super::ws::on_membership_change(Members::Users(user_ids));
}

/// The close code of a socket whose session ended.
pub const SIGNED_OUT: u16 = 4001;

/// Closes every socket of a user (deactivation, deletion, password reset).
pub fn disconnect_user(user_id: &str) {
    for ws in registry::user_sockets(user_id) {
        ws.close(SIGNED_OUT, "signed out");
    }
}

/// Closes the sockets opened with these sessions.
pub fn disconnect_sessions(session_ids: &[String]) {
    if session_ids.is_empty() {
        return;
    }
    for ws in registry::all_sockets() {
        if session_ids.contains(&ws.session_id) {
            ws.close(SIGNED_OUT, "signed out");
        }
    }
}
