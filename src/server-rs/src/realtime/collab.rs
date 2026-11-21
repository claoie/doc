//! Port of `src/server/realtime/collab.ts`: the open pages and their editors.
//!
//! The original runs on one thread and leans on it: whatever happens between
//! two awaits happens at once. Here a session's state sits behind a mutex
//! that is never held across an await, so the same stretches stay atomic, and
//! saves take a second, asynchronous lock, which is what `while (this.saving)
//! await this.saving` amounts to.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tokio::sync::OnceCell;

use super::hub::{registry, SocketRef};
use crate::common::editor::collab::{Authority, Rejection};
use crate::common::editor::doc_schema::empty_doc;
use crate::common::editor::model::children;
use crate::common::editor::sanitize::sanitize_step;
use crate::common::editor::steps::is_step;
use crate::common::editor::tokens::{content_size, nodes_to_items};
use crate::common::ids::is_uuid;
use crate::http::{AppError, Result};
use crate::jsutil::{is_integer, js_json, js_number, number_json, utf16_len};
use crate::logger;
use crate::pages::{can_edit_page, can_read_page, load_page_for_collab, save_page_content, stored_doc_version, SaveContentInput};

const SAVE_DEBOUNCE: Duration = Duration::from_millis(2_000);
const SAVE_MAX_DELAY: Duration = Duration::from_millis(10_000);
const MAX_STEPS_PER_MESSAGE: usize = 2_000;
const PRESENCE_COLORS: [&str; 8] = ["#e5484d", "#f76b15", "#ffb224", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];
/// How long a page's session outlives its last editor. An editor that
/// reconnects within it catches up from the session's step history. A session
/// loaded again has none, so an editor that had fallen behind would get the
/// whole document and drop what it hadn't sent yet.
const IDLE_KEEP: Duration = Duration::from_millis(60_000);

struct Client {
    client_id: String,
    user_id: String,
    name: String,
    color: &'static str,
    read_only: bool,
    selection: Option<(Value, Value)>,
}

struct State {
    /// In the order they joined, as a `Map` keeps them.
    clients: Vec<(SocketRef, Client)>,
    editors: Vec<String>,
    last_editor: Option<String>,
    dirty: bool,
    first_dirty_at: Option<Instant>,
    authority: Authority,
    /// Counts replacements of `authority` (a reload), to tell "the same authority" apart.
    authority_epoch: u64,
    /// The stored version the next save replaces.
    saved_version: f64,
    /// The pending save timer is the one started with this number; bumping it cancels the timer.
    save_timer: u64,
    presence_timer: bool,
    /// Set while the session is kept with nobody in it (see `IDLE_KEEP`).
    idle_timer: Option<u64>,
    idle_timers: u64,
}

pub struct PageSession {
    page_id: String,
    state: Mutex<State>,
    saving: tokio::sync::Mutex<()>,
    /// Saves waiting for the one that is running.
    waiting: std::sync::atomic::AtomicUsize,
    /// Saves that have got their turn so far.
    turns: std::sync::atomic::AtomicU64,
    turn_taken: tokio::sync::Notify,
}

fn stored_doc(content: Value) -> Value {
    if children(&content).is_empty() {
        empty_doc()
    } else {
        content
    }
}

fn send(ws: &SocketRef, message: Value) {
    ws.send(&message);
}

impl PageSession {
    fn new(page_id: &str, authority: Authority) -> Arc<PageSession> {
        let saved_version = authority.version;
        Arc::new(PageSession {
            page_id: page_id.to_string(),
            waiting: Default::default(),
            turns: Default::default(),
            turn_taken: tokio::sync::Notify::new(),
            state: Mutex::new(State {
                clients: Vec::new(),
                editors: Vec::new(),
                last_editor: None,
                dirty: false,
                first_dirty_at: None,
                authority,
                authority_epoch: 0,
                saved_version,
                save_timer: 0,
                presence_timer: false,
                idle_timer: None,
                idle_timers: 0,
            }),
            saving: tokio::sync::Mutex::new(()),
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn schedule_save(self: &Arc<Self>) {
        let (wait, timer) = {
            let mut st = self.state();
            let now = Instant::now();
            let first = *st.first_dirty_at.get_or_insert(now);
            st.save_timer += 1;
            let latest = (first + SAVE_MAX_DELAY).saturating_duration_since(now);
            (SAVE_DEBOUNCE.min(latest), st.save_timer)
        };
        let session = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            if session.state().save_timer == timer {
                session.save().await;
            }
        });
    }

    async fn save(self: &Arc<Self>) {
        {
            let mut st = self.state();
            st.save_timer += 1;
        }
        self.waiting.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _saving = self.saving.lock().await;
        let (input, contributors) = {
            let mut st = self.state();
            let dirty = st.dirty;
            st.dirty = false;
            // This save has had its turn; see `after_waiting_saves`.
            self.waiting.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            self.turns.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.turn_taken.notify_waiters();
            if !dirty {
                return;
            }
            st.first_dirty_at = None;
            let contributors = std::mem::take(&mut st.editors);
            let input = SaveContentInput {
                content: st.authority.doc.clone(),
                doc_version: st.authority.version,
                editor_id: st.last_editor.clone(),
                contributor_ids: contributors.clone(),
                base_version: Some(st.saved_version),
            };
            (input, contributors)
        };
        let outcome = match save_page_content(&self.page_id, &input).await {
            Ok(true) => {
                self.state().saved_version = input.doc_version;
                Ok(())
            }
            Ok(false) => self.reload().await,
            Err(error) => Err(error),
        };
        if let Err(error) = outcome {
            // Keep the changes in memory and try again on the next edit or close.
            let mut st = self.state();
            st.dirty = true;
            for id in contributors {
                if !st.editors.contains(&id) {
                    st.editors.push(id);
                }
            }
            drop(st);
            logger::error_with("saving page content failed", &error, json!({ "pageId": self.page_id }));
        }
    }

    /// In JavaScript, a save that waited for the running one starts (and so
    /// takes the changes made meanwhile as its own) before whoever awaited the
    /// running one goes on. This waits for such a save to have had its turn.
    async fn after_waiting_saves(&self) {
        use std::sync::atomic::Ordering::SeqCst;
        let seen = self.turns.load(SeqCst);
        loop {
            let turn = self.turn_taken.notified();
            tokio::pin!(turn);
            turn.as_mut().enable();
            if self.waiting.load(SeqCst) == 0 || self.turns.load(SeqCst) != seen {
                return;
            }
            turn.await;
        }
    }

    /// Whether the stored page is still the version this session's next save replaces.
    async fn is_current(&self) -> Result<bool> {
        drop(self.saving.lock().await);
        let stored = stored_doc_version(&self.page_id).await?;
        Ok(stored == Some(self.state().saved_version))
    }

    /// Something else saved this page since this session loaded it. Realtime
    /// has one leader, so that means the lease failed. The two histories can't
    /// be merged: every client restarts from what is stored, and is told so,
    /// rather than one side silently overwriting the other.
    async fn reload(&self) -> Result<()> {
        logger::warn("page changed outside its session; reloading it", json!({ "pageId": self.page_id }));
        let Some(row) = load_page_for_collab(&self.page_id).await? else { return Ok(()) };
        let mut st = self.state();
        st.authority = Authority::new(stored_doc(row.content), row.doc_version);
        st.authority_epoch += 1;
        st.saved_version = row.doc_version;
        st.dirty = false;
        st.first_dirty_at = None;
        st.editors.clear();
        st.save_timer += 1;
        for (ws, client) in &st.clients {
            send(ws, json!({ "t": "error", "pageId": self.page_id, "message": "This page changed elsewhere; your latest edits could not be saved." }));
            send(ws, json!({ "t": "joined", "pageId": self.page_id, "version": number_json(row.doc_version), "doc": st.authority.doc, "readOnly": client.read_only }));
        }
        Ok(())
    }

    fn broadcast(st: &State, message: &Value) {
        let data = js_json(message);
        for (ws, _) in &st.clients {
            ws.send_text(data.clone());
        }
    }

    fn send_presence(self: &Arc<Self>) {
        {
            let mut st = self.state();
            if st.presence_timer {
                return;
            }
            st.presence_timer = true;
        }
        let session = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let mut st = session.state();
            st.presence_timer = false;
            let users: Vec<Value> = st
                .clients
                .iter()
                .map(|(_, c)| {
                    let selection = c.selection.as_ref().map_or(Value::Null, |(anchor, head)| json!({ "anchor": anchor, "head": head }));
                    json!({ "clientId": c.client_id, "userId": c.user_id, "name": c.name, "color": c.color, "selection": selection })
                })
                .collect();
            PageSession::broadcast(&st, &json!({ "t": "presence", "pageId": session.page_id, "users": users }));
        });
    }
}

/// A page's session while it loads and once it has: what the original keeps as a promise.
struct Slot {
    cell: OnceCell<std::result::Result<Option<Arc<PageSession>>, String>>,
}

fn sessions() -> MutexGuard<'static, HashMap<String, Arc<Slot>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Slot>>>> = OnceLock::new();
    SESSIONS.get_or_init(Default::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn open_session(page_id: &str) -> Arc<Slot> {
    sessions().entry(page_id.to_string()).or_insert_with(|| Arc::new(Slot { cell: OnceCell::new() })).clone()
}

/// Waits for a slot's session; a failed load is forgotten so the next try loads again.
async fn loaded(page_id: &str, slot: &Arc<Slot>) -> Result<Option<Arc<PageSession>>> {
    let outcome = slot
        .cell
        .get_or_init(|| async {
            match load_page_for_collab(page_id).await {
                Ok(Some(row)) => Ok(Some(PageSession::new(page_id, Authority::new(stored_doc(row.content), row.doc_version)))),
                Ok(None) => Ok(None),
                Err(error) => Err(error.to_string()),
            }
        })
        .await;
    match outcome {
        Ok(session) => Ok(session.clone()),
        Err(message) => {
            forget_session(page_id, slot);
            Err(AppError::Other(message.clone()))
        }
    }
}

/// The session of a page that is open, if any.
async fn existing_session(page_id: &str) -> Result<Option<(Arc<Slot>, Arc<PageSession>)>> {
    let Some(slot) = sessions().get(page_id).cloned() else { return Ok(None) };
    Ok(loaded(page_id, &slot).await?.map(|session| (slot, session)))
}

/// Forgets a page's session, unless another has replaced it in the meantime.
fn forget_session(page_id: &str, slot: &Arc<Slot>) {
    let mut sessions = sessions();
    if sessions.get(page_id).is_some_and(|current| Arc::ptr_eq(current, slot)) {
        sessions.remove(page_id);
    }
}

fn is_current_slot(page_id: &str, slot: &Arc<Slot>) -> bool {
    sessions().get(page_id).is_some_and(|current| Arc::ptr_eq(current, slot))
}

/// Stops a kept session's release: an editor or an import is taking it over.
fn take_over(session: &PageSession) {
    session.state().idle_timer = None;
}

/// The page's session, for an editor joining it or an import. It is taken over
/// before it is returned, so its release timer can't let it go while an import
/// saves, and no other join's check can drop it. One kept with nobody in it may
/// be stale: if this copy lost the lease and got it back, another copy may have
/// saved the page in between. Then the page is loaded again.
async fn current_session(page_id: &str) -> Result<(Arc<Slot>, Option<Arc<PageSession>>)> {
    loop {
        let slot = open_session(page_id);
        let session = loaded(page_id, &slot).await?;
        if let Some(session) = &session {
            if session.state().idle_timer.is_some() && !session.is_current().await? {
                // Unless someone took it over while this checked: an import's save can
                // make the stored version look newer for a moment.
                let abandoned = {
                    let st = session.state();
                    st.idle_timer.is_some() && st.clients.is_empty()
                };
                if abandoned {
                    forget_session(page_id, &slot);
                }
                take_over(session);
                continue;
            }
        }
        // The session may have been let go while this waited.
        if !is_current_slot(page_id, &slot) {
            continue;
        }
        match &session {
            Some(session) => take_over(session),
            // A page that is gone isn't remembered as gone.
            None => forget_session(page_id, &slot),
        }
        return Ok((slot, session));
    }
}

/// Lets go of a session nobody has open, after `IDLE_KEEP` if it has
/// accepted steps: without any, its history has nothing to catch up from.
fn release_session(page_id: &str, slot: &Arc<Slot>, session: &Arc<PageSession>) {
    let timer = {
        let mut st = session.state();
        st.idle_timer = None;
        if st.last_editor.is_none() {
            if st.clients.is_empty() && !st.dirty {
                drop(st);
                forget_session(page_id, slot);
            }
            return;
        }
        st.idle_timers += 1;
        st.idle_timer = Some(st.idle_timers);
        st.idle_timers
    };
    let (page_id, slot, session) = (page_id.to_string(), slot.clone(), session.clone());
    tokio::spawn(async move {
        tokio::time::sleep(IDLE_KEEP).await;
        let mut st = session.state();
        if st.idle_timer != Some(timer) {
            return;
        }
        st.idle_timer = None;
        if st.clients.is_empty() && !st.dirty {
            drop(st);
            forget_session(&page_id, &slot);
        }
    });
}

fn color_for(user_id: &str) -> &'static str {
    let mut hash: i32 = 0;
    for unit in user_id.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(i32::from(unit));
    }
    PRESENCE_COLORS[(i64::from(hash).unsigned_abs() % PRESENCE_COLORS.len() as u64) as usize]
}

/// Sends whatever brings a client at `version` up to date.
fn catch_up(ws: &SocketRef, page_id: &str, st: &State, version: f64, read_only: bool) {
    let authority = &st.authority;
    if version == authority.version {
        send(ws, json!({ "t": "joined", "pageId": page_id, "version": number_json(version), "readOnly": read_only }));
    } else if let Some(missed) = authority.steps_since(version) {
        send(ws, json!({ "t": "joined", "pageId": page_id, "version": number_json(version), "readOnly": read_only }));
        send(ws, json!({ "t": "steps", "pageId": page_id, "version": number_json(missed.version), "steps": missed.steps, "clientIds": missed.client_ids }));
    } else {
        send(ws, json!({ "t": "joined", "pageId": page_id, "version": number_json(authority.version), "doc": authority.doc, "readOnly": read_only }));
    }
}

/// Sessions are keyed by the canonical (lower-case) page id.
fn page_key(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|id| is_uuid(id)).map(str::to_lowercase)
}

fn position_of(st: &State, ws: &SocketRef) -> Option<usize> {
    st.clients.iter().position(|(other, _)| Arc::ptr_eq(other, ws))
}

pub async fn join_page(ws: &SocketRef, raw_page_id: Option<&Value>, version: Option<&Value>, client_id: Option<&Value>) -> Result<()> {
    let Some(page_id) = page_key(raw_page_id) else { return Ok(()) };
    let user_id = ws.user_id.clone();
    if !can_read_page(&user_id, &page_id).await? {
        send(ws, json!({ "t": "error", "pageId": page_id, "message": "You do not have access to this page" }));
        return Ok(());
    }
    let read_only = !can_edit_page(&user_id, &page_id).await?;
    let (slot, session) = current_session(&page_id).await?;
    let Some(session) = session else {
        send(ws, json!({ "t": "error", "pageId": page_id, "message": "Page not found" }));
        return Ok(());
    };
    // The socket may have closed while this waited. Its disconnect has run
    // already, so a client added now would never be removed.
    if !ws.is_open() {
        let empty = {
            let st = session.state();
            st.clients.is_empty() && !st.dirty
        };
        if empty {
            release_session(&page_id, &slot, &session);
        }
        return Ok(());
    }
    {
        let mut st = session.state();
        // An editor leaving since may have set its release timer again.
        st.idle_timer = None;
        let existing = position_of(&st, ws);
        let given = client_id.and_then(Value::as_str).filter(|id| utf16_len(id) <= 64).map(str::to_string);
        let client = Client {
            client_id: given.or_else(|| existing.map(|i| st.clients[i].1.client_id.clone())).unwrap_or_default(),
            user_id: user_id.clone(),
            name: ws.user_name.clone(),
            color: color_for(&user_id),
            read_only,
            selection: existing.and_then(|i| st.clients[i].1.selection.clone()),
        };
        match existing {
            Some(i) => st.clients[i].1 = client,
            None => st.clients.push((ws.clone(), client)),
        }
        registry::join_page(ws, &page_id);
        let v = version.filter(|v| v.is_number() && is_integer(v)).map_or(-1.0, js_number);
        catch_up(ws, &page_id, &st, v, read_only);
    }
    session.send_presence();
    Ok(())
}

async fn leave(ws: &SocketRef, page_id: &str) -> Result<()> {
    registry::leave_page(ws, page_id);
    let Some((slot, session)) = existing_session(page_id).await? else { return Ok(()) };
    let now_empty = {
        let mut st = session.state();
        let Some(index) = position_of(&st, ws) else { return Ok(()) };
        st.clients.remove(index);
        st.clients.is_empty()
    };
    session.send_presence();
    if now_empty {
        session.save().await;
        // Someone may have re-joined while saving.
        let still_empty = {
            let st = session.state();
            st.clients.is_empty() && !st.dirty
        };
        if still_empty {
            release_session(page_id, &slot, &session);
        }
    }
    Ok(())
}

pub async fn leave_page(ws: &SocketRef, raw_page_id: Option<&Value>) -> Result<()> {
    match page_key(raw_page_id) {
        Some(page_id) => leave(ws, &page_id).await,
        None => Ok(()),
    }
}

pub async fn receive_steps(ws: &SocketRef, message: &Map<String, Value>) -> Result<()> {
    let page_id = page_key(message.get("pageId"));
    let client_id = message.get("clientId").and_then(Value::as_str).filter(|id| utf16_len(id) <= 64);
    let (Some(page_id), Some(client_id)) = (page_id, client_id) else { return Ok(()) };
    let session = existing_session(&page_id).await?.map(|(_, session)| session);
    let joined = session.as_ref().and_then(|session| {
        let st = session.state();
        position_of(&st, ws).map(|i| st.clients[i].1.read_only)
    });
    let (Some(session), Some(read_only)) = (session, joined) else {
        send(ws, json!({ "t": "error", "pageId": page_id, "message": "Join the page before editing" }));
        return Ok(());
    };
    if read_only {
        send(ws, json!({ "t": "error", "pageId": page_id, "message": "This page is read-only for you" }));
        return Ok(());
    }
    let mut st = session.state();
    let Some(index) = position_of(&st, ws) else { return Ok(()) };
    st.clients[index].1.client_id = client_id.to_string();
    let version = message.get("version").filter(|v| v.is_number()).map(js_number);
    let steps = message.get("steps").and_then(Value::as_array).filter(|steps| steps.len() <= MAX_STEPS_PER_MESSAGE && steps.iter().all(is_step));
    let (Some(version), Some(steps)) = (version, steps) else {
        send(ws, json!({ "t": "rejected", "pageId": page_id }));
        return Ok(());
    };
    if version != st.authority.version {
        send(ws, json!({ "t": "rejected", "pageId": page_id }));
        catch_up(ws, &page_id, &st, version, read_only);
        return Ok(());
    }
    // A step so malformed that cleaning or applying it throws is answered with nothing, only logged.
    let cleaned = steps.iter().map(sanitize_step).collect::<std::result::Result<Vec<Value>, _>>().map_err(AppError::other)?;
    let accepted = st.authority.receive(version, cleaned, client_id).map_err(AppError::other)?;
    let Some(accepted) = accepted else {
        // The steps do not apply to the current document: reset this client.
        let text = if st.authority.rejection == Some(Rejection::TooLarge) {
            "This page is too large to add more to it."
        } else {
            "A change could not be applied; the page was reloaded."
        };
        send(ws, json!({ "t": "error", "pageId": page_id, "message": text }));
        send(ws, json!({ "t": "joined", "pageId": page_id, "version": number_json(st.authority.version), "doc": st.authority.doc, "readOnly": read_only }));
        return Ok(());
    };
    let client_ids: Vec<&str> = accepted.iter().map(|_| client_id).collect();
    PageSession::broadcast(&st, &json!({ "t": "steps", "pageId": page_id, "version": number_json(st.authority.version), "steps": accepted, "clientIds": client_ids }));
    st.dirty = true;
    let user_id = st.clients[index].1.user_id.clone();
    if !st.editors.contains(&user_id) {
        st.editors.push(user_id.clone());
    }
    st.last_editor = Some(user_id);
    drop(st);
    session.schedule_save();
    Ok(())
}

pub async fn update_presence(ws: &SocketRef, message: &Map<String, Value>) -> Result<()> {
    let Some(page_id) = page_key(message.get("pageId")) else { return Ok(()) };
    let Some((_, session)) = existing_session(&page_id).await? else { return Ok(()) };
    {
        let mut st = session.state();
        let Some(index) = position_of(&st, ws) else { return Ok(()) };
        let selection = message.get("selection");
        let part = |key: &str| selection.and_then(|s| s.get(key)).filter(|v| v.is_number()).cloned();
        st.clients[index].1.selection = match (part("anchor"), part("head")) {
            (Some(anchor), Some(head)) => Some((anchor, head)),
            _ => None,
        };
    }
    session.send_presence();
    Ok(())
}

pub async fn disconnect(ws: &SocketRef) -> Result<()> {
    for page_id in ws.pages() {
        leave(ws, &page_id).await?;
    }
    Ok(())
}

/// Why a document could not replace a page's content.
#[derive(Debug)]
pub enum ReplaceError {
    TooLarge,
    Invalid,
    Other(AppError),
}

impl From<AppError> for ReplaceError {
    fn from(error: AppError) -> Self {
        ReplaceError::Other(error)
    }
}

async fn replace_in(session: &Arc<PageSession>, page_id: &str, content: &Value, user_id: &str, saved: &mut bool) -> std::result::Result<(), ReplaceError> {
    let epoch = {
        let mut st = session.state();
        let size = content_size(&st.authority.doc);
        let step = json!({ "stepType": "replace", "from": 0, "to": size, "slice": nodes_to_items(children(content)) });
        let version = st.authority.version;
        let accepted = st.authority.receive(version, vec![step], "server").map_err(|e| ReplaceError::Other(AppError::other(e)))?;
        let Some(accepted) = accepted else {
            return Err(if st.authority.rejection == Some(Rejection::TooLarge) { ReplaceError::TooLarge } else { ReplaceError::Invalid });
        };
        PageSession::broadcast(&st, &json!({ "t": "steps", "pageId": page_id, "version": number_json(st.authority.version), "steps": accepted, "clientIds": ["server"] }));
        st.dirty = true;
        if !st.editors.iter().any(|id| id == user_id) {
            st.editors.push(user_id.to_string());
        }
        st.last_editor = Some(user_id.to_string());
        st.authority_epoch
    };
    session.save().await;
    session.after_waiting_saves().await;
    {
        let st = session.state();
        *saved = !st.dirty && st.authority_epoch == epoch;
    }
    // A failed save stays in memory for the next save attempt; report it.
    if !*saved {
        return Err(ReplaceError::Other(AppError::other("Saving the page failed")));
    }
    Ok(())
}

/// Replaces a page's whole document from outside the editor (imports). Open
/// editors receive it as a regular step. `Ok(false)` when the page is gone.
pub async fn replace_page_content(page_id: &str, content: &Value, user_id: &str) -> std::result::Result<bool, ReplaceError> {
    let (slot, session) = current_session(page_id).await?;
    let Some(session) = session else { return Ok(false) };
    let mut saved = false;
    let outcome = replace_in(&session, page_id, content, user_id, &mut saved).await;
    // Taken over by `current_session`: hand it back whatever happened.
    let idle = {
        let st = session.state();
        st.clients.is_empty() && !st.dirty
    };
    if idle {
        // A saved import isn't kept: its one step can be the whole document.
        if saved {
            forget_session(page_id, &slot);
        } else {
            release_session(page_id, &slot, &session);
        }
    }
    outcome.map(|()| true)
}

fn all_sessions() -> Vec<(String, Arc<Slot>)> {
    sessions().iter().map(|(page_id, slot)| (page_id.clone(), slot.clone())).collect()
}

/// Saves every open document (shutdown).
pub async fn flush_all() -> Result<()> {
    let mut open = Vec::new();
    for (page_id, slot) in all_sessions() {
        if let Some(session) = loaded(&page_id, &slot).await? {
            open.push(session);
        }
    }
    futures_util::future::join_all(open.iter().map(|session| session.save())).await;
    Ok(())
}

/// Which open editors to re-check: `None` is "all".
#[derive(Default)]
pub struct Recheck {
    pub user_ids: Option<Vec<String>>,
    pub page_ids: Option<Vec<String>>,
}

/// Drops a client whose access was removed, or updates whether it may edit.
async fn recheck_client(session: &Arc<PageSession>, ws: &SocketRef, user_id: &str) -> Result<()> {
    let page_id = &session.page_id;
    if !can_read_page(user_id, page_id).await? {
        send(ws, json!({ "t": "error", "pageId": page_id, "message": "You no longer have access to this page" }));
        return leave(ws, page_id).await;
    }
    let read_only = !can_edit_page(user_id, page_id).await?;
    let mut st = session.state();
    let Some(index) = position_of(&st, ws) else { return Ok(()) };
    if read_only != st.clients[index].1.read_only {
        st.clients[index].1.read_only = read_only;
        send(ws, json!({ "t": "joined", "pageId": page_id, "version": number_json(st.authority.version), "readOnly": read_only }));
    }
    Ok(())
}

/// Re-checks access for open editors after membership, role, trash or move
/// changes, limited to the given users and/or pages.
pub async fn refresh_open_sessions(which: Recheck) -> Result<()> {
    for (page_id, slot) in all_sessions() {
        if which.page_ids.as_ref().is_some_and(|pages| !pages.contains(&page_id)) {
            continue;
        }
        let Some(session) = loaded(&page_id, &slot).await? else { continue };
        let clients: Vec<(SocketRef, String)> = session.state().clients.iter().map(|(ws, c)| (ws.clone(), c.user_id.clone())).collect();
        for (ws, user_id) in clients {
            if which.user_ids.as_ref().is_some_and(|users| !users.contains(&user_id)) {
                continue;
            }
            recheck_client(&session, &ws, &user_id).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors_follow_the_original_hash() {
        // `colorFor` of the original, evaluated in Bun for these ids.
        assert_eq!(color_for(""), "#e5484d");
        assert_eq!(color_for("a"), PRESENCE_COLORS[97 % 8]);
        assert_eq!(color_for("ab"), PRESENCE_COLORS[(97 * 31 + 98) % 8]);
        assert!(PRESENCE_COLORS.contains(&color_for("0123abcd-89ef-4567-89ab-0123456789ab")));
    }
}
