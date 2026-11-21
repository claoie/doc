//! Port of `src/server/routes/auth.ts`.

use serde_json::{json, Value};

use crate::auth::{cleared_session_cookie, hash_token, revoke_user_sessions, sign_in, sign_out};
use crate::common::ids::token;
use crate::config::config;
use crate::db::{begin, db};
use crate::emails::{render_mail, Action};
use crate::http::{bad_request, empty, forbidden_with, get, http_error, post, public_get, public_post, read_json, AppError, Ctx, Reply, Result, Route};
use crate::jsutil::encode_uri_component;
use crate::mail::send_mail;
use crate::ratelimit::{rate_limit, DEFAULT_LIMIT};
use crate::realtime::hub::disconnect_user;
use crate::spaces::{get_workspace, init_workspace, lock_setup};
use crate::sso::{provider_logout, require_local_login};
use crate::users::{find_user_by_id, hash_password, to_user, verify_password, UserRow};
use crate::validate::{input, max, normalize_email, StringRule, EMAIL_RULE, NAME_RULE, PASSWORD_RULE};
use crate::{handler, sql};

const RESET_PURPOSE: &str = "password-reset";
const RESET_MINUTES: i64 = 30;

fn invalid_credentials() -> AppError {
    http_error(401, "invalid_credentials", "Invalid email or password")
}

const PASSWORDS_OFF: &str = "Passwords are turned off in this workspace: sign in with single sign-on";

/// A password as typed: up to 200 characters, not trimmed.
const TYPED_PASSWORD: StringRule = StringRule { min: None, max: 200, trim: false };

fn user_reply(user: &UserRow) -> Result<Reply> {
    Ok(json!({ "user": Value::Object(to_user(user, Some(&user.id))) }).into())
}

async fn setup_status(_ctx: &mut Ctx) -> Result<Reply> {
    let row = db().first(sql!("SELECT EXISTS (SELECT 1 FROM users) AS has_users")).await?;
    Ok(json!({ "needsSetup": !row.is_some_and(|r| r.bool("has_users")) }).into())
}

async fn setup(ctx: &mut Ctx) -> Result<Reply> {
    require_local_login("This workspace uses single sign-on: the first person to sign in with it sets it up")?;
    rate_limit("setup", &ctx.ip, DEFAULT_LIMIT)?;
    let body = input(read_json(ctx).await?);
    let workspace_name = body.string("workspaceName", max(100))?;
    let name = body.string("name", NAME_RULE)?;
    let email = normalize_email(&body.string("email", EMAIL_RULE)?)?;
    let password_hash = hash_password(&body.string("password", PASSWORD_RULE)?).await?;
    let user = begin(async |tx| -> Result<UserRow> {
        lock_setup(tx).await?;
        let existing = tx.first(sql!("SELECT EXISTS (SELECT 1 FROM users) AS has_users")).await?;
        if existing.is_some_and(|r| r.bool("has_users")) {
            return Err(forbidden_with("Setup has already been completed"));
        }
        let owner = tx
            .first(sql!(
                "INSERT INTO users (email, name, password_hash, role) VALUES ({}, {}, {}, 'owner')
                 RETURNING *",
                &email,
                &name,
                &password_hash
            ))
            .await?
            .ok_or_else(|| AppError::other("creating the owner returned no row"))?;
        let owner = UserRow::from_row(&owner);
        init_workspace(tx, &workspace_name, &owner.id).await?;
        Ok(owner)
    })
    .await?;
    sign_in(ctx, &user.id, None).await?;
    user_reply(&user)
}

async fn login(ctx: &mut Ctx) -> Result<Reply> {
    require_local_login(PASSWORDS_OFF)?;
    rate_limit("login", &ctx.ip, DEFAULT_LIMIT)?;
    let body = input(read_json(ctx).await?);
    let email = body.string("email", EMAIL_RULE)?.to_lowercase();
    let password = body.string("password", TYPED_PASSWORD)?;
    // While single sign-on is on, an account linked to the provider signs in
    // only through it, even with AUTH_LOCAL_LOGIN, so a person the provider
    // disabled can't come back with a password: it is looked up as an unknown one.
    let row = db()
        .first(sql!("SELECT * FROM users WHERE lower(email) = {} AND ({} OR auth_sub IS NULL)", &email, config().sso.is_none()))
        .await?;
    let user = row.map(|row| UserRow::from_row(&row));
    let valid = verify_password(&password, user.as_ref().and_then(|u| u.password_hash.as_deref())).await;
    let Some(user) = user.filter(|u| valid && u.deactivated_at.is_none()) else { return Err(invalid_credentials()) };
    sign_in(ctx, &user.id, None).await?;
    user_reply(&user)
}

async fn logout(ctx: &mut Ctx) -> Result<Reply> {
    let session = ctx.session().clone();
    sign_out(ctx).await?;
    if session.auth_sid.as_deref().is_some_and(|sid| !sid.is_empty()) {
        return Ok(provider_logout(session.auth_refresh_token).await.into());
    }
    empty()
}

async fn forgot_password(ctx: &mut Ctx) -> Result<Reply> {
    require_local_login(PASSWORDS_OFF)?;
    rate_limit("forgot-password", &ctx.ip, DEFAULT_LIMIT)?;
    let body = input(read_json(ctx).await?);
    let email = body.string("email", EMAIL_RULE)?.to_lowercase();
    // Nothing for an account linked to the provider while single sign-on is on, as at /auth/login.
    let user = db()
        .first(sql!(
            "SELECT id, email, name FROM users
             WHERE lower(email) = {} AND deactivated_at IS NULL AND ({} OR auth_sub IS NULL)",
            &email,
            config().sso.is_none()
        ))
        .await?;
    if let Some(user) = user {
        let value = token();
        let user_id = user.str("id");
        db().execute(sql!("DELETE FROM user_tokens WHERE user_id = {} AND purpose = {}", &user_id, RESET_PURPOSE)).await?;
        db().execute(sql!(
            "INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at)
             VALUES ({}, {}, {}, now() + make_interval(mins => {}))",
            &user_id,
            RESET_PURPOSE,
            hash_token(&value),
            RESET_MINUTES
        ))
        .await?;
        let workspace = get_workspace().await?;
        let workspace_name = workspace["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("workspace");
        send_mail(render_mail(
            &user.str("email"),
            &format!("Reset your {workspace_name} password"),
            &[
                format!("Hi {},", user.str("name")),
                format!("Someone asked to reset your password. The link below is valid for {RESET_MINUTES} minutes. If it was not you, ignore this email."),
            ],
            Some(Action { label: "Reset password", url: &format!("{}/reset-password?token={}", config().app_url, encode_uri_component(&value)) }),
        ));
    }
    empty()
}

async fn reset_password(ctx: &mut Ctx) -> Result<Reply> {
    require_local_login(PASSWORDS_OFF)?;
    rate_limit("reset-password", &ctx.ip, 20)?;
    let body = input(read_json(ctx).await?);
    let value = body.string("token", max(200))?;
    let password_hash = hash_password(&body.string("password", PASSWORD_RULE)?).await?;
    // While single sign-on is on, a link sent before the account was linked to the provider no longer works, as at /auth/login.
    let row = db()
        .first(sql!(
            "DELETE FROM user_tokens t USING users u
             WHERE t.token_hash = {} AND t.purpose = {} AND t.expires_at > now()
               AND u.id = t.user_id AND u.deactivated_at IS NULL AND ({} OR u.auth_sub IS NULL)
             RETURNING t.user_id",
            hash_token(&value),
            RESET_PURPOSE,
            config().sso.is_none()
        ))
        .await?;
    let Some(row) = row else { return Err(bad_request("This reset link is invalid or has expired")) };
    let user_id = row.str("user_id");
    db().execute(sql!("UPDATE users SET password_hash = {}, updated_at = now() WHERE id = {}", &password_hash, &user_id)).await?;
    db().execute(sql!("DELETE FROM user_tokens WHERE user_id = {} AND purpose = {}", &user_id, RESET_PURPOSE)).await?;
    revoke_user_sessions(&user_id, None).await?;
    disconnect_user(&user_id);
    sign_in(ctx, &user_id, None).await?;
    let user = find_user_by_id(&user_id).await?.ok_or_else(|| AppError::other("the user disappeared during a password reset"))?;
    user_reply(&user)
}

async fn change_password(ctx: &mut Ctx) -> Result<Reply> {
    require_local_login(PASSWORDS_OFF)?;
    let body = input(read_json(ctx).await?);
    let current = body.string("currentPassword", TYPED_PASSWORD)?;
    let next = body.string("newPassword", PASSWORD_RULE)?;
    let user = ctx.user().clone();
    let row = db().first(sql!("SELECT password_hash FROM users WHERE id = {}", &user.id)).await?;
    if !verify_password(&current, row.and_then(|r| r.opt_str("password_hash")).as_deref()).await {
        return Err(http_error(400, "invalid_password", "Current password is incorrect"));
    }
    db().execute(sql!("UPDATE users SET password_hash = {}, updated_at = now() WHERE id = {}", hash_password(&next).await?, &user.id)).await?;
    revoke_user_sessions(&user.id, Some(&ctx.session().id)).await?;
    send_mail(render_mail(
        &user.email,
        "Your password was changed",
        &[
            format!("Hi {},", user.name),
            "Your password was just changed and your other sessions were signed out. If this was not you, reset your password right away.".to_string(),
        ],
        None,
    ));
    empty()
}

async fn sessions(ctx: &mut Ctx) -> Result<Reply> {
    let rows = db()
        .query(sql!(
            "SELECT id, user_agent, ip, created_at, last_seen_at FROM sessions
             WHERE user_id = {} AND expires_at > now() ORDER BY last_seen_at DESC",
            &ctx.user().id
        ))
        .await?;
    let current = &ctx.session().id;
    Ok(Value::Array(
        rows.iter()
            .map(|r| {
                json!({
                    "id": r.str("id"),
                    "userAgent": r.opt_str("user_agent"),
                    "ip": r.opt_str("ip"),
                    "createdAt": r.iso("created_at"),
                    "lastSeenAt": r.iso("last_seen_at"),
                    "current": &r.str("id") == current,
                })
            })
            .collect(),
    )
    .into())
}

async fn revoke_session(ctx: &mut Ctx) -> Result<Reply> {
    let id = input(read_json(ctx).await?).uuid("id")?;
    db().execute(sql!("DELETE FROM sessions WHERE id = {} AND user_id = {}", &id, &ctx.user().id)).await?;
    if id == ctx.session().id {
        ctx.cookies.push(cleared_session_cookie());
    }
    empty()
}

pub fn routes() -> Vec<Route> {
    vec![
        public_get("/setup", handler!(setup_status)),
        public_post("/setup", handler!(setup)),
        public_post("/auth/login", handler!(login)),
        post("/auth/logout", handler!(logout)),
        public_post("/auth/forgot-password", handler!(forgot_password)),
        public_post("/auth/reset-password", handler!(reset_password)),
        post("/auth/change-password", handler!(change_password)),
        get("/auth/sessions", handler!(sessions)),
        post("/auth/sessions/revoke", handler!(revoke_session)),
    ]
}
