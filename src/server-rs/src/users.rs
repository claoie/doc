//! Port of `src/server/lib/users.ts`.

use std::sync::OnceLock;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use chrono::DateTime;
use serde_json::{json, Map, Value};

use crate::config::config;
use crate::db::{array, db, micros_to_iso, Conn, Row};
use crate::http::{AppError, Result};
use crate::sql;

/// A row of `users`.
#[derive(Debug, Clone)]
pub struct UserRow {
    pub id: String,
    pub email: String,
    pub name: String,
    pub avatar: Option<String>,
    /// `owner`, `admin` or `member`.
    pub role: String,
    pub locale: Option<String>,
    pub timezone: Option<String>,
    pub preferences: Value,
    /// Timestamps as ISO strings, as the API returns them.
    pub created_at: Option<String>,
    pub last_login_at: Option<String>,
    pub deactivated_at: Option<String>,
    /// The identity provider's subject, once the user has signed in with single sign-on.
    pub auth_sub: Option<String>,
    /// The email is the one the identity provider verified at the last sign-in, so the provider manages it.
    pub email_from_provider: bool,
    /// On rows read whole; `None` for people single sign-on created. Never sent to a browser.
    pub password_hash: Option<String>,
}

impl UserRow {
    /// Reads a user from a row that has the `users` columns (`SELECT *`, `u.*`).
    pub fn from_row(row: &Row) -> UserRow {
        let opt = |name: &str| if row.has(name) { row.opt_str(name) } else { None };
        UserRow {
            id: row.str("id"),
            email: row.str("email"),
            name: row.str("name"),
            avatar: opt("avatar"),
            role: row.str("role"),
            locale: opt("locale"),
            timezone: opt("timezone"),
            preferences: if row.has("preferences") { row.json("preferences") } else { Value::Null },
            created_at: if row.has("created_at") { row.opt_iso("created_at") } else { None },
            last_login_at: if row.has("last_login_at") { row.opt_iso("last_login_at") } else { None },
            deactivated_at: if row.has("deactivated_at") { row.opt_iso("deactivated_at") } else { None },
            auth_sub: opt("auth_sub"),
            email_from_provider: row.has("email_from_provider") && row.bool("email_from_provider"),
            password_hash: opt("password_hash"),
        }
    }

    /// Reads a user from the JSON object a query built with `json_build_object`
    /// (snake-case keys; timestamps as Postgres prints them inside JSON).
    pub fn from_json(value: &Value) -> UserRow {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        UserRow {
            id: text("id").unwrap_or_default(),
            email: text("email").unwrap_or_default(),
            name: text("name").unwrap_or_default(),
            avatar: text("avatar"),
            role: text("role").unwrap_or_default(),
            locale: text("locale"),
            timezone: text("timezone"),
            preferences: value.get("preferences").cloned().unwrap_or(Value::Null),
            created_at: text("created_at").and_then(|t| iso_from_text(&t)),
            last_login_at: text("last_login_at").and_then(|t| iso_from_text(&t)),
            deactivated_at: text("deactivated_at").and_then(|t| iso_from_text(&t)),
            auth_sub: text("auth_sub"),
            email_from_provider: value.get("email_from_provider").and_then(Value::as_bool).unwrap_or(false),
            password_hash: None,
        }
    }
}

/// `iso(value)` for a timestamp Postgres wrote into JSON (`2026-01-02T03:04:05.123456+00:00`):
/// `new Date(value).toISOString()`.
pub fn iso_from_text(value: &str) -> Option<String> {
    let time = DateTime::parse_from_rfc3339(value).ok()?;
    Some(micros_to_iso(time.timestamp_micros()))
}

/// `imageUrl(name)`.
pub fn image_url(name: Option<&str>) -> Value {
    match name {
        Some(name) if !name.is_empty() => Value::String(format!("/api/images/{name}")),
        _ => Value::Null,
    }
}

fn opt(value: &Option<String>) -> Value {
    value.clone().map_or(Value::Null, Value::String)
}

/// `toUser(row, viewerId)`: preferences are only shown to the user themselves
/// (`viewer_id` of `None` is "no viewer given", which shows them).
pub fn to_user(row: &UserRow, viewer_id: Option<&str>) -> Map<String, Value> {
    let own = viewer_id.is_none_or(|viewer| viewer == row.id);
    let preferences = if own && !row.preferences.is_null() { row.preferences.clone() } else { json!({}) };
    let mut user = Map::new();
    user.insert("id".into(), Value::String(row.id.clone()));
    user.insert("email".into(), Value::String(row.email.clone()));
    user.insert("name".into(), Value::String(row.name.clone()));
    user.insert("avatarUrl".into(), image_url(row.avatar.as_deref()));
    user.insert("role".into(), Value::String(row.role.clone()));
    user.insert("locale".into(), opt(&row.locale));
    user.insert("timezone".into(), opt(&row.timezone));
    user.insert("preferences".into(), preferences);
    user.insert("createdAt".into(), opt(&row.created_at));
    user.insert("lastLoginAt".into(), opt(&row.last_login_at));
    user
}

/// `ssoManaged` and `ssoManagedEmail`, while single sign-on is on; nothing otherwise, so answers without it are unchanged.
pub fn sso_managed_field(row: &UserRow, into: &mut Map<String, Value>) {
    if config().sso.is_some() {
        into.insert("ssoManaged".into(), Value::Bool(row.auth_sub.is_some()));
        into.insert("ssoManagedEmail".into(), Value::Bool(row.auth_sub.is_some() && row.email_from_provider));
    }
}

/// For the current user only: `sso_managed_field`, and whether they have a
/// password here, while single sign-on is on. Never in the member list.
pub fn own_sso_fields(row: &UserRow, into: &mut Map<String, Value>) {
    if config().sso.is_some() {
        sso_managed_field(row, into);
        into.insert("hasPassword".into(), Value::Bool(row.password_hash.is_some()));
    }
}

/// `{ ...toUser(user, user.id), ...ownSsoFields(user) }`.
pub fn to_own_user(row: &UserRow) -> Value {
    let mut user = to_user(row, Some(&row.id));
    own_sso_fields(row, &mut user);
    Value::Object(user)
}

/// `toMember(row, viewerId)`.
pub fn to_member(row: &UserRow, viewer_id: &str) -> Map<String, Value> {
    let mut member = to_user(row, Some(viewer_id));
    member.insert("deactivatedAt".into(), opt(&row.deactivated_at));
    member
}

/// SQL expression building a `UserRef` JSON object (or null) from a users row alias.
pub fn user_ref_json(alias: &str) -> String {
    format!(
        "CASE WHEN {alias}.id IS NULL THEN NULL ELSE json_build_object('id', {alias}.id, 'name', {alias}.name, 'avatarUrl', CASE WHEN {alias}.avatar IS NULL THEN NULL ELSE '/api/images/' || {alias}.avatar END) END"
    )
}

/// `{ id, name, avatarUrl }`.
pub fn user_ref(id: &str, name: &str, avatar: Option<&str>) -> Value {
    json!({ "id": id, "name": name, "avatarUrl": image_url(avatar) })
}

pub async fn find_user_by_id(id: &str) -> Result<Option<UserRow>> {
    Ok(db().first(sql!("SELECT * FROM users WHERE id = {}", id)).await?.map(|row| UserRow::from_row(&row)))
}

/// User refs for a list of ids, in the given order, skipping unknown ids.
pub async fn user_refs(conn: Conn<'_>, ids: &[String]) -> Result<Vec<Value>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = conn.query(sql!("SELECT id, name, avatar FROM users WHERE id = ANY({}::uuid[])", array(ids))).await?;
    Ok(ids
        .iter()
        .filter_map(|id| rows.iter().find(|row| &row.str("id") == id))
        .map(|row| user_ref(&row.str("id"), &row.str("name"), row.opt_str("avatar").as_deref()))
        .collect())
}

/// argon2id with a 19 MiB memory cost keeps concurrent hashing inside a small container.
fn argon2() -> Argon2<'static> {
    let params = Params::new(19456, 2, 1, None).expect("argon2 parameters");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

fn hash_blocking(password: &str) -> std::result::Result<String, String> {
    // Bun salts with 32 random bytes.
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut OsRng, &mut bytes);
    let salt = SaltString::encode_b64(&bytes).map_err(|e| e.to_string())?;
    argon2().hash_password(password.as_bytes(), &salt).map(|hash| hash.to_string()).map_err(|e| e.to_string())
}

/// Hashes off the async threads: one hash takes tens of milliseconds.
pub async fn hash_password(password: &str) -> Result<String> {
    let password = password.to_string();
    tokio::task::spawn_blocking(move || hash_blocking(&password))
        .await
        .map_err(AppError::other)?
        .map_err(AppError::other)
}

fn verify_blocking(password: &str, hash: &str) -> bool {
    // The parameters come from the hash itself, so hashes written by the Bun server verify too.
    PasswordHash::new(hash).is_ok_and(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
}

fn dummy_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| hash_blocking("timing-equalizer").unwrap_or_default())
}

/// Checks a password. Without a hash it still spends the time of a check, so
/// an unknown address cannot be told from a wrong password by timing.
pub async fn verify_password(password: &str, hash: Option<&str>) -> bool {
    let password = password.to_string();
    let hash = hash.map(str::to_string);
    tokio::task::spawn_blocking(move || match hash {
        Some(hash) => verify_blocking(&password, &hash),
        None => {
            verify_blocking(&password, dummy_hash());
            false
        }
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_verify_both_ways() {
        let hash = hash_blocking("correct horse").unwrap();
        assert!(hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
        assert!(verify_blocking("correct horse", &hash));
        assert!(!verify_blocking("wrong", &hash));
        assert!(!verify_blocking("x", "not a hash"));
    }

    #[test]
    fn reads_timestamps_inside_json() {
        assert_eq!(iso_from_text("2026-01-02T03:04:05.123456+00:00").as_deref(), Some("2026-01-02T03:04:05.123Z"));
        assert_eq!(iso_from_text("2026-01-02T03:04:05+02:00").as_deref(), Some("2026-01-02T01:04:05.000Z"));
        assert_eq!(iso_from_text("nope"), None);
    }
}
