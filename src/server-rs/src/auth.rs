//! Port of `src/server/lib/auth.ts`: sessions and their cookie.

use chrono::{Duration, Utc};
use hyper::HeaderMap;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::common::ids::token;
use crate::config::config;
use crate::db::{array, db, Row};
use crate::http::{header, unauthorized, Ctx, Result};
use crate::jsutil::{js_slice, js_trim};
use crate::sql;
use crate::sso::{end_session, recheck_session, DueRecheck, RECHECK_MS};
use crate::users::UserRow;

pub type AuthUser = UserRow;

#[derive(Debug, Clone)]
pub struct AuthSession {
    pub id: String,
    /// The identity provider's session and refresh token, on a session started through single sign-on.
    pub auth_sid: Option<String>,
    pub auth_refresh_token: Option<String>,
}

/// The identity provider's side of a session started through single sign-on.
pub struct ProviderSession {
    pub sid: String,
    pub refresh_token: Option<String>,
}

const COOKIE: &str = "session";
const SESSION_DAYS: i64 = 30;
const SESSION_MS: i64 = SESSION_DAYS * 24 * 60 * 60 * 1000;
const SLIDE_AFTER_MS: i64 = 60 * 1000;

/// SHA-256 of a token, in hexadecimal: what the database stores instead of the token.
pub fn hash_token(value: &str) -> String {
    Sha256::digest(value.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Compares two hashes in constant time.
pub fn same_hash(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

fn cookie_attributes(max_age_seconds: i64) -> String {
    format!("Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_seconds}{}", if config().secure_cookies { "; Secure" } else { "" })
}

pub fn session_cookie(value: &str) -> String {
    format!("{COOKIE}={value}; {}", cookie_attributes(SESSION_MS / 1000))
}

pub fn cleared_session_cookie() -> String {
    format!("{COOKIE}=; {}", cookie_attributes(0))
}

/// The value of a cookie in the request's `Cookie` header.
pub fn read_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let header = header(headers, "cookie")?;
    for part in header.split(';') {
        let Some((key, value)) = part.split_once('=') else { continue };
        if js_trim(key) == name {
            return Some(js_trim(value).to_string());
        }
    }
    None
}

/// Starts a session for the user and queues its cookie on the response.
pub async fn sign_in(ctx: &mut Ctx, user_id: &str, provider: Option<ProviderSession>) -> Result<()> {
    let value = token();
    let user_agent = Some(js_slice(&ctx.header("user-agent").unwrap_or_default(), 0, Some(500))).filter(|ua| !ua.is_empty());
    let ip = Some(ctx.ip.clone()).filter(|ip| !ip.is_empty());
    let now = Utc::now();
    let (sid, refresh_token) = match &provider {
        Some(p) => (Some(p.sid.clone()), p.refresh_token.clone()),
        None => (None, None),
    };
    let recheck_at = provider.as_ref().map(|_| now + Duration::milliseconds(RECHECK_MS));
    let row = db()
        .first(sql!(
            "INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at, auth_sid, auth_refresh_token, auth_recheck_at)
             VALUES ({}, {}, {}, {}, {}, {}, {}, {})
             RETURNING id",
            user_id,
            hash_token(&value),
            user_agent,
            ip,
            now + Duration::milliseconds(SESSION_MS),
            sid.clone(),
            refresh_token.clone(),
            recheck_at
        ))
        .await?;
    db().execute(sql!("UPDATE users SET last_login_at = now() WHERE id = {}", user_id)).await?;
    ctx.cookies.push(session_cookie(&value));
    ctx.session = Some(AuthSession { id: row.map(|r| r.str("id")).unwrap_or_default(), auth_sid: sid, auth_refresh_token: refresh_token });
    Ok(())
}

pub async fn sign_out(ctx: &mut Ctx) -> Result<()> {
    if let Some(session) = &ctx.session {
        db().execute(sql!("DELETE FROM sessions WHERE id = {}", &session.id)).await?;
    }
    ctx.cookies.push(cleared_session_cookie());
    Ok(())
}

pub struct SessionLookup {
    pub user: AuthUser,
    pub session: AuthSession,
    /// Set when the session was extended and its cookie should be re-sent.
    pub refreshed_cookie: Option<String>,
}

/// The user of a session row joined with its user, after asking the identity
/// provider again when a single sign-on session's re-check is due; `None` when
/// that ended the session.
async fn session_user(row: &Row) -> Result<Option<AuthUser>> {
    let user = UserRow::from_row(row);
    let session_id = row.str("session_id");
    let recheck_at = row.opt_millis("session_auth_recheck_at");
    // Only sessions started through the provider have a re-check. A password
    // session ends while single sign-on is the only way in, and also once its
    // account is linked to the provider, which then governs it: nothing would
    // ever re-check it, so it could outlive the provider disabling the person.
    // A provider's session ends once single sign-on is turned off, since
    // nothing can re-check it either.
    let linked = user.auth_sub.is_some();
    let sso_on = config().sso.is_some();
    let ended = match recheck_at {
        Some(_) => !sso_on,
        None => !config().local_login || (sso_on && linked),
    };
    if ended {
        end_session(&session_id).await?;
        return Ok(None);
    }
    let Some(recheck_at) = recheck_at.filter(|at| *at <= Utc::now().timestamp_millis()) else { return Ok(Some(user)) };
    let due = DueRecheck { session_id, refresh_token: row.opt_str("session_auth_refresh_token"), recheck_at };
    recheck_session(due, user).await
}

/// Resolves the session cookie of a request to an active user.
pub async fn authenticate(headers: &HeaderMap) -> Result<Option<SessionLookup>> {
    let Some(value) = read_cookie(headers, COOKIE).filter(|v| !v.is_empty() && crate::jsutil::utf16_len(v) <= 100) else {
        return Ok(None);
    };
    let row = db()
        .first(sql!(
            "SELECT s.id AS session_id, s.last_seen_at AS session_last_seen_at, s.auth_sid AS session_auth_sid,
               s.auth_refresh_token AS session_auth_refresh_token, s.auth_recheck_at AS session_auth_recheck_at, u.*
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = {} AND s.expires_at > now() AND u.deactivated_at IS NULL",
            hash_token(&value)
        ))
        .await?;
    let Some(row) = row else { return Ok(None) };
    let Some(user) = session_user(&row).await? else { return Ok(None) };
    let session_id = row.str("session_id");
    let mut refreshed_cookie = None;
    let last_seen = row.opt_millis("session_last_seen_at").unwrap_or(0);
    if Utc::now().timestamp_millis() - last_seen > SLIDE_AFTER_MS {
        db().execute(sql!(
            "UPDATE sessions SET last_seen_at = now(), expires_at = {} WHERE id = {}",
            Utc::now() + Duration::milliseconds(SESSION_MS),
            &session_id
        ))
        .await?;
        refreshed_cookie = Some(session_cookie(&value));
    }
    let session = AuthSession {
        id: session_id,
        auth_sid: row.opt_str("session_auth_sid"),
        auth_refresh_token: row.opt_str("session_auth_refresh_token"),
    };
    Ok(Some(SessionLookup { user, session, refreshed_cookie }))
}

/// Of these sessions, the ones still signed in: not ended or expired, their
/// user active, and for single sign-on, still allowed by the provider when a
/// re-check is due.
pub async fn live_sessions(session_ids: &[String]) -> Result<Vec<String>> {
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = db()
        .query(sql!(
            "SELECT s.id AS session_id, s.auth_refresh_token AS session_auth_refresh_token, s.auth_recheck_at AS session_auth_recheck_at, u.*
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.id = ANY({}::uuid[]) AND s.expires_at > now() AND u.deactivated_at IS NULL",
            array(session_ids)
        ))
        .await?;
    let checks = rows.iter().map(|row| async move { (row.str("session_id"), session_user(row).await) });
    let mut live = Vec::new();
    for (session_id, user) in futures_util::future::join_all(checks).await {
        if user?.is_some() {
            live.push(session_id);
        }
    }
    Ok(live)
}

pub fn require_user(ctx: &Ctx) -> Result<&AuthUser> {
    ctx.user.as_ref().ok_or_else(unauthorized)
}

pub async fn revoke_user_sessions(user_id: &str, except_session_id: Option<&str>) -> Result<()> {
    match except_session_id {
        Some(except) => db().execute(sql!("DELETE FROM sessions WHERE user_id = {} AND id <> {}", user_id, except)).await?,
        None => db().execute(sql!("DELETE FROM sessions WHERE user_id = {}", user_id)).await?,
    }
    Ok(())
}

pub async fn purge_expired_sessions() -> Result<()> {
    db().execute(sql!("DELETE FROM sessions WHERE expires_at < now()")).await?;
    db().execute(sql!("DELETE FROM user_tokens WHERE expires_at < now()")).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_and_compares_tokens() {
        assert_eq!(hash_token("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(same_hash("abc", "abc"));
        assert!(!same_hash("abc", "abd"));
        assert!(!same_hash("abc", "abcd"));
    }

    #[test]
    fn reads_cookies() {
        let mut headers = HeaderMap::new();
        headers.insert("cookie", "a=1;  session = tok=en ; b".parse().unwrap());
        assert_eq!(read_cookie(&headers, "session").as_deref(), Some("tok=en"));
        assert_eq!(read_cookie(&headers, "a").as_deref(), Some("1"));
        assert_eq!(read_cookie(&headers, "b"), None);
        assert_eq!(read_cookie(&HeaderMap::new(), "session"), None);
    }
}
