//! Port of `src/server/routes/me.ts`.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::config::config;
use crate::db::db;
use crate::files::{remove_image, save_image};
use crate::http::{bad_request, conflict, form_file, get, http_error, post, read_form, read_json, AppError, Ctx, Reply, Result, Route};
use crate::permissions::is_workspace_admin;
use crate::spaces::{email_domains, get_workspace};
use crate::users::{find_user_by_id, to_own_user, verify_password};
use crate::validate::{input, max, normalize_email, StringRule, EMAIL_RULE, NAME_RULE};
use crate::{handler, sql};

const BOOLEAN_PREFERENCES: &[&str] =
    &["fullPageWidth", "editorToolbar", "notifyPageUpdates", "notifyPageMentions", "notifyCommentMentions", "notifyComments"];

/// Keeps known preference keys with valid values; `null` clears a key.
fn parse_preferences(raw: &Map<String, Value>) -> Result<Map<String, Value>> {
    let mut out = Map::new();
    for key in BOOLEAN_PREFERENCES {
        let Some(value) = raw.get(*key) else { continue };
        if !value.is_null() && !value.is_boolean() {
            return Err(bad_request(format!("preferences.{key} must be a boolean")));
        }
        out.insert((*key).to_string(), value.clone());
    }
    if let Some(value) = raw.get("pageEditMode") {
        if !value.is_null() && value != "read" && value != "edit" {
            return Err(bad_request("preferences.pageEditMode must be read or edit"));
        }
        out.insert("pageEditMode".into(), value.clone());
    }
    if let Some(value) = raw.get("theme") {
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| Regex::new(r"^[a-z-]{1,20}$").expect("theme pattern"));
        if !value.is_null() && !value.as_str().is_some_and(|theme| re.is_match(theme)) {
            return Err(bad_request("preferences.theme is invalid"));
        }
        out.insert("theme".into(), value.clone());
    }
    Ok(out)
}

/// Whether `Intl.DateTimeFormat` would accept this time zone: an IANA name in
/// any letter case, or a fixed offset `±HH`, `±HH:MM` or `±HHMM`.
pub fn valid_timezone(value: &str) -> bool {
    static OFFSET: OnceLock<Regex> = OnceLock::new();
    let offset = OFFSET.get_or_init(|| Regex::new(r"^[+-]([01][0-9]|2[0-3])(:?[0-5][0-9])?$").expect("offset pattern"));
    if offset.is_match(value) {
        return true;
    }
    // In the time zone database, but not a zone anyone is in.
    if value.eq_ignore_ascii_case("factory") {
        return false;
    }
    chrono_tz::Tz::from_str_insensitive(value).is_ok()
}

fn locale_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$").expect("locale pattern"))
}

async fn own_user_reply(user_id: &str) -> Result<Reply> {
    let user = find_user_by_id(user_id).await?.ok_or_else(|| AppError::other("the signed-in user no longer exists"))?;
    Ok(json!({ "user": to_own_user(&user) }).into())
}

async fn me(ctx: &mut Ctx) -> Result<Reply> {
    Ok(json!({ "user": to_own_user(ctx.user()), "workspace": get_workspace().await? }).into())
}

async fn update(ctx: &mut Ctx) -> Result<Reply> {
    let body = input(read_json(ctx).await?);
    let user = ctx.user().clone();
    let name = body.optional_string("name", NAME_RULE)?;
    let email_input = body.optional_string("email", EMAIL_RULE)?;
    let locale = body.nullable_string("locale", max(20))?;
    let timezone = body.nullable_string("timezone", max(64))?;
    let preferences_input = body.object("preferences")?;
    if locale.as_option().is_some_and(|l| !l.is_empty() && !locale_re().is_match(l)) {
        return Err(bad_request("Invalid locale"));
    }
    if timezone.as_option().is_some_and(|tz| !tz.is_empty() && !valid_timezone(tz)) {
        return Err(bad_request("Invalid timezone"));
    }
    let preferences = preferences_input.map(parse_preferences).transpose()?;

    // A linked person's name comes from the identity provider, and so does
    // their email when the provider verified it at sign-in: both are copied
    // back then, so a change here would silently revert.
    let linked = config().sso.is_some() && user.auth_sub.is_some();
    if linked {
        if name.as_ref().is_some_and(|n| *n != user.name) {
            return Err(http_error(403, "sso_managed", "Your name comes from your identity provider"));
        }
        if user.email_from_provider {
            if let Some(given) = &email_input {
                if normalize_email(given)? != user.email.to_lowercase() {
                    return Err(http_error(403, "sso_managed", "Your email comes from your identity provider"));
                }
            }
        }
    }

    let mut email: Option<String> = None;
    if let Some(given) = &email_input {
        let normalized = normalize_email(given)?;
        if normalized != user.email.to_lowercase() {
            let row = db().first(sql!("SELECT password_hash FROM users WHERE id = {}", &user.id)).await?;
            let password_hash = row.and_then(|r| r.opt_str("password_hash")).filter(|h| !h.is_empty());
            // Someone single sign-on created has no password to confirm the change
            // with; while it is on, the session the provider started stands in.
            let passwordless = linked && password_hash.is_none();
            if !passwordless {
                let password = body.optional_string("currentPassword", StringRule { min: None, max: 200, trim: false })?;
                let confirmed = match password.filter(|p| !p.is_empty()) {
                    Some(password) => verify_password(&password, password_hash.as_deref()).await,
                    None => false,
                };
                if !confirmed {
                    return Err(http_error(400, "invalid_password", "Current password is incorrect"));
                }
            }
            let domains = email_domains(&get_workspace().await?);
            let domain = normalized.split('@').nth(1).unwrap_or("");
            if !domains.is_empty() && !is_workspace_admin(&user) && !domains.iter().any(|d| d == domain) {
                return Err(bad_request(format!("Only {} addresses are allowed in this workspace", domains.join(", "))));
            }
            let taken = db().first(sql!("SELECT 1 AS taken FROM users WHERE lower(email) = {} AND id <> {}", &normalized, &user.id)).await?;
            if taken.is_some() {
                return Err(conflict("email_taken", "That email is already in use"));
            }
        }
        email = Some(normalized);
    }

    db().execute(sql!(
        "UPDATE users SET
           name = COALESCE({}, name),
           email = COALESCE({}, email),
           locale = CASE WHEN {} THEN {} ELSE locale END,
           timezone = CASE WHEN {} THEN {} ELSE timezone END,
           preferences = CASE WHEN {} THEN jsonb_strip_nulls(preferences || {}::jsonb) ELSE preferences END,
           updated_at = now()
         WHERE id = {}",
        name,
        email,
        locale.is_given(),
        locale.into_option(),
        timezone.is_given(),
        timezone.into_option(),
        preferences.is_some(),
        Value::Object(preferences.unwrap_or_default()),
        &user.id
    ))
    .await?;
    own_user_reply(&user.id).await
}

async fn avatar(ctx: &mut Ctx) -> Result<Reply> {
    let form = read_form(ctx, 11 * 1024 * 1024).await?;
    let user_id = ctx.user().id.clone();
    let name = save_image(&form_file(&form, "file")?, "avatar", &user_id, None).await?;
    let previous = db()
        .first(sql!(
            "UPDATE users u SET avatar = {}, updated_at = now() FROM users old
             WHERE u.id = {} AND old.id = u.id RETURNING old.avatar",
            &name,
            &user_id
        ))
        .await?;
    remove_image(previous.and_then(|r| r.opt_str("avatar")).as_deref()).await?;
    own_user_reply(&user_id).await
}

async fn remove_avatar(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    db().execute(sql!("UPDATE users SET avatar = NULL, updated_at = now() WHERE id = {}", &user.id)).await?;
    remove_image(user.avatar.as_deref()).await?;
    own_user_reply(&user.id).await
}

pub fn routes() -> Vec<Route> {
    vec![
        get("/me", handler!(me)),
        post("/me/update", handler!(update)),
        post("/me/avatar", handler!(avatar)),
        post("/me/avatar/remove", handler!(remove_avatar)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_zones_match_intl() {
        // What `new Intl.DateTimeFormat("en", { timeZone })` accepts on Bun 1.4.4.
        let accepted = [
            "+05", "+23:59", "Etc/GMT+1", "-00:00", "+00:00", "+0000", "+2359", "EST5EDT", "Asia/Calcutta", "asia/kolkata", "ETC/utc",
            "Zulu", "Universal", "GMT0", "GMT+0", "GMT-0", "Greenwich", "UCT", "PST8PDT", "CET", "Japan", "America/Argentina/Buenos_Aires",
            "America/Buenos_Aires", "Europe/Kiev", "Antarctica/Troll", "America/Ciudad_Juarez", "W-SU", "ROC", "NZ-CHAT", "europe/PARIS",
            "Pacific/Kanton", "America/Nuuk", "Asia/Ho_Chi_Minh", "Asia/Saigon", "UTC", "utc", "GMT", "EST", "America/New_York",
            "america/new_york", "Europe/Kyiv", "US/Pacific", "-0800", "+0530", "+05:30", "Etc/GMT+5",
        ];
        let refused = [
            "+5", "+24:00", "+05:60", "+05:30:00", "UTC+1", "GMT+1", "Etc/GMT+14", "Etc/GMT+15", "+2400", "+053", "Factory", "PST",
            "localtime", "posixrules", "Etc/Unknown", "\u{2212}05:00", "+05:3", "+ 05:00", "Europe/Paris ", "Europe//Paris", "Invalid/Zone",
            "Z", "", " UTC",
        ];
        for zone in accepted {
            assert!(valid_timezone(zone), "{zone} should be accepted");
        }
        for zone in refused {
            assert!(!valid_timezone(zone), "{zone} should be refused");
        }
    }
}
