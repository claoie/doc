//! Port of `src/server/lib/sso.ts`.
//!
//! Optional single sign-on through an OpenID Connect provider whose tokens and
//! events follow the contract `auth_client.rs` implements. It is off unless
//! AUTH_ISSUER is set, and nothing here contacts the provider before someone
//! signs in with it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use chrono::{Duration, Utc};
use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde_json::{json, Value};
use url::Url;

use crate::auth_client::{AccessClaims, AuthClient, AuthClientOptions, AuthError, AuthEvent, IdClaims};
use crate::config::{config, SsoConfig};
use crate::db::{begin, db};
use crate::http::{http_error, AppError, Result};
use crate::jsutil::{is_js_whitespace, js_slice, js_trim};
use crate::logger;
use crate::realtime::hub::{disconnect_sessions, disconnect_user};
use crate::spaces::{init_workspace, lock_setup};
use crate::sql;
use crate::users::UserRow;
use crate::validate::normalize_email;

/// How often a session started through the provider re-checks the user's access with it.
pub const RECHECK_MS: i64 = 10 * 60 * 1000;
/// How long past a due re-check a session is still served while the provider is unreachable.
const STALE_MS: i64 = 60 * 60 * 1000;

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn as_email(value: Option<&Value>) -> Option<String> {
    normalize_email(value?.as_str()?).ok()
}

pub struct LinkUsers {
    /// Provider username → local email, in the order listed.
    pub links: Vec<(String, String)>,
    pub problems: Vec<String>,
}

impl LinkUsers {
    pub fn email_for(&self, username: &str) -> Option<&str> {
        self.links.iter().find(|(name, _)| name == username).map(|(_, email)| email.as_str())
    }
}

/// Parses AUTH_LINK_USERS, `<local email>=<provider username>,…`, into provider username → local email.
pub fn parse_link_users(value: Option<&str>) -> LinkUsers {
    let mut links: Vec<(String, String)> = Vec::new();
    let mut problems = Vec::new();
    for part in value.unwrap_or("").split(',') {
        let entry = js_trim(part);
        if entry.is_empty() {
            continue;
        }
        let eq = entry.rfind('=');
        let email = normalize_email(&entry[..eq.unwrap_or(0)]).ok();
        let username = js_trim(eq.map_or(entry, |at| &entry[at + 1..]));
        match (eq, email) {
            (Some(_), Some(email)) if !username.is_empty() && !username.chars().any(is_js_whitespace) => {
                if links.iter().any(|(name, _)| name == username) {
                    problems.push(format!("AUTH_LINK_USERS: {username} is listed more than once"));
                } else if links.iter().any(|(_, other)| *other == email) {
                    problems.push(format!("AUTH_LINK_USERS: {email} is listed more than once"));
                } else {
                    links.push((username.to_string(), email));
                }
            }
            _ => problems.push(format!("AUTH_LINK_USERS: \"{entry}\" is not <email>=<username>")),
        }
    }
    LinkUsers { links, problems }
}

fn url_problem(name: &str, value: Option<&str>, rule: fn(&Url) -> bool, requirement: &str) -> Vec<String> {
    let Some(value) = value else { return Vec::new() };
    if let Ok(url) = Url::parse(value) {
        let plain = url.query().is_none_or(str::is_empty) && url.fragment().is_none_or(str::is_empty);
        if rule(&url) && plain {
            return Vec::new();
        }
    }
    vec![format!("{name} must be {requirement}")]
}

fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

fn is_http(url: &Url) -> bool {
    url.scheme() == "http" || url.scheme() == "https"
}

/// Everything wrong with the single sign-on settings; the server refuses to start unless this is empty.
pub fn sso_problems() -> Vec<String> {
    let Some(sso) = &config().sso else { return Vec::new() };
    let mut problems = Vec::new();
    if sso.client_id.is_none() {
        problems.push("AUTH_CLIENT_ID is required when AUTH_ISSUER is set".to_string());
    }
    if sso.client_secret.is_none() {
        problems.push("AUTH_CLIENT_SECRET is required when AUTH_ISSUER is set".to_string());
    }
    problems.extend(url_problem(
        "AUTH_ISSUER",
        Some(&sso.issuer),
        |url| url.scheme() == "https" || (url.scheme() == "http" && is_loopback(url)),
        "an https URL (http only for localhost), without a query or fragment",
    ));
    problems.extend(url_problem("AUTH_BACKCHANNEL_URL", sso.back_channel_url.as_deref(), is_http, "an http or https URL, without a query or fragment"));
    problems.extend(url_problem(
        "AUTH_REDIRECT_URI",
        Some(&sso.redirect_uri),
        is_http,
        "an absolute http or https URL (it defaults to APP_URL/api/auth/callback)",
    ));
    problems.extend(parse_link_users(sso.link_users.as_deref()).problems);
    if problems.is_empty() {
        if let Err(message) = client_for(sso) {
            problems.push(format!("single sign-on: {message}"));
        }
    }
    problems
}

fn client_for(sso: &SsoConfig) -> std::result::Result<AuthClient, String> {
    AuthClient::new(AuthClientOptions {
        issuer: sso.issuer.clone(),
        back_channel_url: sso.back_channel_url.clone(),
        client_id: sso.client_id.clone().unwrap_or_default(),
        client_secret: sso.client_secret.clone(),
        redirect_uri: sso.redirect_uri.clone(),
        audience: sso.audience.clone(),
    })
}

/// The provider's client, or `None` when single sign-on is off.
pub fn auth_client() -> Option<Arc<AuthClient>> {
    static CLIENT: OnceLock<Option<Arc<AuthClient>>> = OnceLock::new();
    CLIENT.get_or_init(|| config().sso.as_ref().and_then(|sso| client_for(sso).ok()).map(Arc::new)).clone()
}

/// What the browser needs to know before sign-in.
pub fn sso_mode() -> Value {
    json!({ "enabled": config().sso.is_some(), "localLogin": config().local_login })
}

/// Refuses what creates or uses a password while single sign-on is the only way in.
pub fn require_local_login(message: &str) -> Result<()> {
    if config().local_login {
        Ok(())
    } else {
        Err(http_error(403, "local_login_disabled", message))
    }
}

/// Refuses a local change to the role of a member linked to the identity provider, which sets it.
pub fn require_locally_managed(user: &UserRow) -> Result<()> {
    if config().sso.is_some() && user.auth_sub.is_some() {
        return Err(http_error(403, "sso_managed", "This member's role is managed by the identity provider"));
    }
    Ok(())
}

/// The provider's role for this service, as a workspace role: anything doc doesn't know is `member`.
pub fn workspace_role(role: &str) -> &'static str {
    match role {
        "owner" => "owner",
        "admin" => "admin",
        _ => "member",
    }
}

fn display_name(claims: &AccessClaims) -> String {
    let name = js_trim(&claims.name);
    js_slice(if name.is_empty() { js_trim(&claims.username) } else { name }, 0, Some(50))
}

/// The ID token's email, when the provider vouches for it.
fn verified_email(id_claims: &IdClaims) -> Option<String> {
    if id_claims.email_verified == Some(Value::Bool(true)) {
        as_email(id_claims.email.as_ref())
    } else {
        None
    }
}

async fn find_by_sub(sub: &str) -> Result<Option<UserRow>> {
    Ok(db().first(sql!("SELECT * FROM users WHERE auth_sub = {}", sub)).await?.map(|row| UserRow::from_row(&row)))
}

/// Links the account with this email to `sub`, unless it is already linked.
/// A deactivated account is linked too, and stays deactivated: activation is
/// doc's own, and the callback refuses to sign it in.
async fn link_by_email(email: &str, sub: &str) -> Result<Option<UserRow>> {
    let linked = db()
        .first(sql!(
            "UPDATE users SET auth_sub = {}, updated_at = now()
             WHERE lower(email) = {} AND auth_sub IS NULL
             RETURNING *",
            sub,
            email
        ))
        .await;
    match linked {
        Ok(row) => Ok(row.map(|row| UserRow::from_row(&row))),
        // Another sign-in of the same person linked another account first.
        Err(error) if error.is_unique_violation() => find_by_sub(sub).await,
        Err(error) => Err(error.into()),
    }
}

/// Reasons the sign-in page shows after a refused sign-in (`/login?sso_error=…`).
pub type SsoError = &'static str;

/// Creates a user on their first sign-in, setting up the workspace when they are its first.
async fn create_user(claims: &AccessClaims, email: &str) -> Result<std::result::Result<UserRow, SsoError>> {
    let created = begin(async |tx| -> Result<std::result::Result<UserRow, SsoError>> {
        lock_setup(tx).await?;
        // A sign-in of the same person that got here first.
        if let Some(row) = tx.first(sql!("SELECT * FROM users WHERE auth_sub = {}", &claims.sub)).await? {
            return Ok(Ok(UserRow::from_row(&row)));
        }
        // The account with this address is linked to someone else at the
        // provider, or appeared after the lookup in find_or_create_user.
        if tx.first(sql!("SELECT 1 AS taken FROM users WHERE lower(email) = {}", email)).await?.is_some() {
            return Ok(Err("account_exists"));
        }
        // The provider decides who joins, so the workspace's allowed email
        // domains, which govern doc's own invitations, don't apply here.
        let has_users = tx.first(sql!("SELECT EXISTS (SELECT 1 FROM users) AS has_users")).await?.is_some_and(|r| r.bool("has_users"));
        let row = tx
            .first(sql!(
                "INSERT INTO users (email, name, role, auth_sub)
                 VALUES ({}, {}, {}, {})
                 RETURNING *",
                email,
                display_name(claims),
                workspace_role(&claims.role),
                &claims.sub
            ))
            .await?
            .ok_or_else(|| AppError::other("creating the user returned no row"))?;
        let user = UserRow::from_row(&row);
        if has_users {
            tx.execute(sql!(
                "INSERT INTO group_members (group_id, user_id) SELECT id, {} FROM groups WHERE is_default ON CONFLICT DO NOTHING",
                &user.id
            ))
            .await?;
        } else {
            init_workspace(tx, "My workspace", &user.id).await?;
        }
        Ok(Ok(user))
    })
    .await;
    match created {
        Err(error) if error.is_unique_violation() => Ok(find_by_sub(&claims.sub).await?.ok_or("account_exists")),
        other => other,
    }
}

/// Finds the local user for a provider sign-in: the one linked to its subject,
/// or the account AUTH_LINK_USERS maps its username to, or the one unlinked
/// account with its email; otherwise a new user. Linking leaves an account's
/// activation as it is.
pub async fn find_or_create_user(claims: &AccessClaims, id_claims: &IdClaims) -> Result<std::result::Result<UserRow, SsoError>> {
    if let Some(linked) = find_by_sub(&claims.sub).await? {
        return Ok(Ok(linked));
    }
    let link_users = parse_link_users(config().sso.as_ref().and_then(|s| s.link_users.as_deref()));
    if let Some(mapped) = link_users.email_for(&claims.username) {
        if let Some(by_mapping) = link_by_email(mapped, &claims.sub).await? {
            return Ok(Ok(by_mapping));
        }
    }
    let Some(email) = as_email(id_claims.email.as_ref()) else { return Ok(Err("no_email")) };
    // Verified or not: the provider sets an address a person chose only after
    // they confirm it, so one it hasn't verified was entered by its
    // administrator (at account creation or import), and matching on it is as
    // trustworthy as AUTH_LINK_USERS. A provider that lets people claim
    // addresses they haven't confirmed must not be used this way (README).
    if let Some(by_email) = link_by_email(&email, &claims.sub).await? {
        return Ok(Ok(by_email));
    }
    create_user(claims, &email).await
}

const RESOLVE_TRIES: usize = 3;

/// The local user a sign-in is for, with the provider's claims applied; or
/// why there is none.
///
/// Two sign-ins of one person at the same moment can each hold a row the
/// other needs: when AUTH_LINK_USERS points at one account and the ID token's
/// email at another, one sign-in gives the first account that email (and
/// waits for the second account's row) while the other links the second
/// account to the subject (and waits for the first account's). The database
/// ends one of the two statements. Nothing of it was written, and by then the
/// other sign-in is through, so the one that was ended starts over and finds
/// the account.
pub async fn resolve_user(claims: &AccessClaims, id_claims: &IdClaims) -> Result<std::result::Result<UserRow, SsoError>> {
    let mut attempt = 1;
    loop {
        let resolved: Result<std::result::Result<UserRow, SsoError>> = async {
            match find_or_create_user(claims, id_claims).await? {
                Ok(found) => Ok(Ok(apply_claims(found, claims, Some(id_claims)).await?)),
                Err(reason) => Ok(Err(reason)),
            }
        }
        .await;
        match resolved {
            Err(error) if error.is_deadlock() && attempt < RESOLVE_TRIES => attempt += 1,
            outcome => return outcome,
        }
    }
}

/// Copies the provider's view of the user onto the local row: the role, the
/// name and, at sign-in, a verified email. Activation is doc's own, so a
/// deactivated account stays deactivated.
pub async fn apply_claims(user: UserRow, claims: &AccessClaims, id_claims: Option<&IdClaims>) -> Result<UserRow> {
    let role = workspace_role(&claims.role);
    let name = Some(display_name(claims)).filter(|n| !n.is_empty()).unwrap_or_else(|| user.name.clone());
    // At sign-in, an email the provider verified becomes the account's, and the
    // provider manages it from then on; without one, the account manages its
    // own. A re-check carries no ID token, so it leaves both alone.
    let verified = id_claims.and_then(verified_email);
    let from_provider = if id_claims.is_some() { verified.is_some() } else { user.email_from_provider };
    let email = verified.filter(|v| *v != user.email.to_lowercase());
    if role == user.role && name == user.name && email.is_none() && from_provider == user.email_from_provider {
        return Ok(user);
    }
    let update = |next_email: Option<String>, next_from_provider: bool| {
        sql!(
            "UPDATE users SET role = {}, name = {}, email = COALESCE({}, email),
               email_from_provider = {}, updated_at = now()
             WHERE id = {} RETURNING *",
            role,
            &name,
            next_email,
            next_from_provider,
            &user.id
        )
    };
    match db().first(update(email.clone(), from_provider)).await {
        Ok(row) => Ok(row.map(|row| UserRow::from_row(&row)).unwrap_or(user)),
        // Another account here has that address: this one keeps, and manages, its own.
        Err(error) if email.is_some() && error.is_unique_violation() => {
            let row = db().first(update(None, false)).await?;
            Ok(row.map(|row| UserRow::from_row(&row)).unwrap_or(user))
        }
        Err(error) => Err(error.into()),
    }
}

/// The reason a callback that could not sign anyone in shows on the sign-in page.
pub fn login_failure(error: &AuthError) -> SsoError {
    match error {
        AuthError::Login { code: "authorization_error", error: Some(reason) } if reason == "access_denied" => "access_denied",
        AuthError::Unavailable(_) => "unavailable",
        AuthError::Login { .. } | AuthError::InvalidToken(_) | AuthError::InvalidGrant(_) => {
            logger::warn("single sign-on refused", json!({ "reason": error.message() }));
            "login_failed"
        }
        AuthError::Other(_) => {
            logger::error("single sign-on failed", &error.message());
            "login_failed"
        }
    }
}

/// Deletes a session and closes the sockets opened with it on this copy.
pub async fn end_session(session_id: &str) -> Result<()> {
    db().execute(sql!("DELETE FROM sessions WHERE id = {}", session_id)).await?;
    disconnect_sessions(&[session_id.to_string()]);
    Ok(())
}

pub struct DueRecheck {
    pub session_id: String,
    pub refresh_token: Option<String>,
    /// When the re-check came due, in milliseconds since the Unix epoch.
    pub recheck_at: i64,
}

type Recheck = Shared<BoxFuture<'static, std::result::Result<Option<UserRow>, String>>>;

/// After the provider couldn't answer a session's re-check, how long that
/// session is served without asking again. Without it, every request of the
/// session would wait out the client's timeout while the provider is
/// unreachable. Kept per copy of the server, in memory: at most one request
/// per session and copy pays the timeout each interval.
const RETRY_MS: i64 = 60 * 1000;
/// Bounds the map when sessions that last failed never come back.
const RETRY_MAX: usize = 10_000;

#[derive(Default)]
struct Rechecks {
    in_flight: HashMap<String, Recheck>,
    /// Session → (when it may ask again, insertion order).
    retry_after: HashMap<String, (i64, u64)>,
    order: u64,
}

fn rechecks() -> std::sync::MutexGuard<'static, Rechecks> {
    static STATE: OnceLock<Mutex<Rechecks>> = OnceLock::new();
    STATE.get_or_init(Mutex::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn back_off(session_id: &str) {
    let mut state = rechecks();
    state.order += 1;
    let order = state.order;
    state.retry_after.insert(session_id.to_string(), (now_ms() + RETRY_MS, order));
    if state.retry_after.len() > RETRY_MAX {
        if let Some(oldest) = state.retry_after.iter().min_by_key(|(_, (_, order))| *order).map(|(key, _)| key.clone()) {
            state.retry_after.remove(&oldest);
        }
    }
}

async fn recheck(auth: Arc<AuthClient>, due: DueRecheck, user: UserRow) -> Result<Option<UserRow>> {
    // Without a refresh token the provider can't be asked again, so the session lasts until its first re-check.
    let Some(refresh_token) = &due.refresh_token else {
        end_session(&due.session_id).await?;
        return Ok(None);
    };
    let refreshed = match auth.refresh(refresh_token).await {
        Ok(refreshed) => refreshed,
        Err(AuthError::InvalidGrant(_)) => {
            end_session(&due.session_id).await?;
            return Ok(None);
        }
        Err(error) => {
            if !matches!(error, AuthError::Unavailable(_)) {
                logger::error("re-checking a single sign-on session failed", &error.message());
            }
            // Bounded staleness: served while the provider is unreachable, for at most an hour.
            if now_ms() > due.recheck_at + STALE_MS {
                end_session(&due.session_id).await?;
                return Ok(None);
            }
            back_off(&due.session_id);
            return Ok(Some(user));
        }
    };
    rechecks().retry_after.remove(&due.session_id);
    if Some(&refreshed.claims.sub) != user.auth_sub.as_ref() {
        end_session(&due.session_id).await?;
        return Ok(None);
    }
    let updated = apply_claims(user, &refreshed.claims, None).await?;
    db().execute(sql!(
        "UPDATE sessions SET auth_recheck_at = {},
           auth_refresh_token = COALESCE({}, auth_refresh_token)
         WHERE id = {}",
        Utc::now() + Duration::milliseconds(RECHECK_MS),
        refreshed.refresh_token,
        &due.session_id
    ))
    .await?;
    Ok(Some(updated))
}

/// Asks the provider again about a session whose re-check is due, and applies
/// the answer. Returns the user as they now are, or `None` when the session has
/// ended. Concurrent requests of one session share one re-check.
pub async fn recheck_session(due: DueRecheck, user: UserRow) -> Result<Option<UserRow>> {
    // Turned off since the session started: nothing can re-check it.
    let Some(auth) = auth_client() else {
        end_session(&due.session_id).await?;
        return Ok(None);
    };
    enum Next {
        Serve,
        End,
        Wait(Recheck),
    }
    let session_id = due.session_id.clone();
    let stale_at = due.recheck_at + STALE_MS;
    // Decided under the lock, acted on after it is released.
    let next = {
        let mut state = rechecks();
        let waiting = state.retry_after.get(&session_id).is_some_and(|(wait_until, _)| now_ms() < *wait_until);
        if waiting && now_ms() <= stale_at {
            // The provider couldn't answer moments ago: serve without asking, still
            // within the hour past the original re-check.
            Next::Serve
        } else if waiting {
            state.retry_after.remove(&session_id);
            Next::End
        } else if let Some(pending) = state.in_flight.get(&session_id) {
            Next::Wait(pending.clone())
        } else {
            let key = session_id.clone();
            let owned_user = user.clone();
            let pending: Recheck = async move {
                let result = recheck(auth, due, owned_user).await.map_err(|e| e.to_string());
                rechecks().in_flight.remove(&key);
                result
            }
            .boxed()
            .shared();
            state.in_flight.insert(session_id.clone(), pending.clone());
            Next::Wait(pending)
        }
    };
    let pending = match next {
        Next::Serve => return Ok(Some(user)),
        Next::End => {
            end_session(&session_id).await?;
            return Ok(None);
        }
        Next::Wait(pending) => pending,
    };
    pending.await.map_err(AppError::Other)
}

/// Ends every session of the user linked to `sub` and closes their sockets on this copy.
async fn end_user_sessions(sub: &str) -> Result<()> {
    let Some(user) = db().first(sql!("SELECT id FROM users WHERE auth_sub = {}", sub)).await? else { return Ok(()) };
    let user_id = user.str("id");
    db().execute(sql!("DELETE FROM sessions WHERE user_id = {}", &user_id)).await?;
    disconnect_user(&user_id);
    Ok(())
}

/// Applies an event the provider pushed. Delivery is at least once, and each
/// case is idempotent, so no record of seen event ids is kept. Sockets on
/// another copy of the server notice within a minute (`check_socket_sessions`).
/// A removal, disabling or deletion ends the user's sessions but doesn't
/// deactivate them: the provider refuses their sign-in itself, and activation
/// is doc's own.
pub async fn apply_event(event: &AuthEvent) -> Result<()> {
    match event.type_.as_str() {
        "session.ended" => {
            let Some(sid) = event.sid.as_deref().filter(|s| !s.is_empty()) else { return Ok(()) };
            let ended = db().query(sql!("DELETE FROM sessions WHERE auth_sid = {} RETURNING id", sid)).await?;
            disconnect_sessions(&ended.iter().map(|row| row.str("id")).collect::<Vec<_>>());
        }
        "access.changed" => {
            let Some(sub) = event.sub.as_deref().filter(|s| !s.is_empty()) else { return Ok(()) };
            match &event.role {
                Some(Some(role)) => {
                    db().execute(sql!("UPDATE users SET role = {}, updated_at = now() WHERE auth_sub = {}", workspace_role(role), sub)).await?;
                }
                _ => end_user_sessions(sub).await?,
            }
        }
        "user.disabled" | "user.deleted" => {
            if let Some(sub) = event.sub.as_deref().filter(|s| !s.is_empty()) {
                end_user_sessions(sub).await?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Ends the provider's side of a session at sign-out: revokes its refresh token
/// in the background, and returns where the browser goes to end the provider's
/// own session.
pub async fn provider_logout(refresh_token: Option<String>) -> Value {
    let (Some(auth), Some(sso)) = (auth_client(), &config().sso) else { return json!({}) };
    if let Some(token) = refresh_token.filter(|t| !t.is_empty()) {
        let auth = auth.clone();
        tokio::spawn(async move {
            if let Err(error) = auth.revoke(&token).await {
                logger::warn("revoking a refresh token failed", json!({ "error": error.message() }));
            }
        });
    }
    let post_logout = Url::parse(&sso.redirect_uri).map(|url| format!("{}/", url.origin().ascii_serialization())).unwrap_or_default();
    match auth.logout_url(Some(&post_logout)).await {
        Ok(url) => json!({ "logoutUrl": url }),
        Err(error) => {
            logger::warn("the provider's sign-out address is unavailable", json!({ "error": error.message() }));
            json!({})
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_link_users() {
        let parsed = parse_link_users(Some(" Alice@Example.com=alice , bob@example.com=bob,, "));
        assert_eq!(parsed.links, vec![("alice".to_string(), "alice@example.com".to_string()), ("bob".to_string(), "bob@example.com".to_string())]);
        assert!(parsed.problems.is_empty());
        assert_eq!(parsed.email_for("bob"), Some("bob@example.com"));
        let bad = parse_link_users(Some("nope,a@b.c=,x=y,a@b.c=al ice,a@b.c=al,a@b.c=bo,c@d.e=al,=x"));
        assert_eq!(
            bad.problems,
            vec![
                "AUTH_LINK_USERS: \"nope\" is not <email>=<username>",
                "AUTH_LINK_USERS: \"a@b.c=\" is not <email>=<username>",
                "AUTH_LINK_USERS: \"x=y\" is not <email>=<username>",
                "AUTH_LINK_USERS: \"a@b.c=al ice\" is not <email>=<username>",
                "AUTH_LINK_USERS: a@b.c is listed more than once",
                "AUTH_LINK_USERS: al is listed more than once",
                "AUTH_LINK_USERS: \"=x\" is not <email>=<username>",
            ]
        );
        assert!(parse_link_users(None).links.is_empty());
    }

    #[test]
    fn checks_urls() {
        let issuer: fn(&Url) -> bool = |url| url.scheme() == "https" || (url.scheme() == "http" && is_loopback(url));
        assert!(url_problem("X", Some("https://auth.example.com"), issuer, "r").is_empty());
        assert!(url_problem("X", Some("http://localhost:4000"), issuer, "r").is_empty());
        assert!(url_problem("X", Some("http://[::1]:4000/"), issuer, "r").is_empty());
        assert_eq!(url_problem("X", Some("http://auth.example.com"), issuer, "r"), vec!["X must be r"]);
        assert_eq!(url_problem("X", Some("https://a.b/?q=1"), issuer, "r"), vec!["X must be r"]);
        assert_eq!(url_problem("X", Some("https://a.b/#f"), issuer, "r"), vec!["X must be r"]);
        assert_eq!(url_problem("X", Some("not a url"), issuer, "r"), vec!["X must be r"]);
        assert!(url_problem("X", None, issuer, "r").is_empty());
        assert!(url_problem("X", Some("https://a.b/?"), issuer, "r").is_empty());
    }
}
