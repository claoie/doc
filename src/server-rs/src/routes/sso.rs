//! Port of `src/server/routes/sso.ts`.

use hyper::Response;
use serde_json::json;

use crate::auth::{sign_in, ProviderSession};
use crate::auth_client::{AuthClient, AuthError, StartLoginOptions};
use crate::http::{empty_body, http_error, not_found, ok_status, public_get, public_post, read_text, response, AppError, Body, Ctx, Reply, Result, Route};
use crate::logger;
use crate::ratelimit::rate_limit;
use crate::sso::{apply_event, auth_client, login_failure, resolve_user, sso_mode, SsoError};
use crate::handler;

/// Events are one signed token each; anything near this size is not one.
const EVENT_LIMIT: usize = 64 * 1024;

/// Deletes the provider client's login cookie (`__Host-login`) when a callback fails before it hands out its own.
const CLEAR_LOGIN_COOKIE: &str = "__Host-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";

/// With single sign-on off, these routes answer as unknown ones do.
fn require_client() -> Result<std::sync::Arc<AuthClient>> {
    auth_client().ok_or_else(|| not_found("Endpoint"))
}

fn redirect(location: &str) -> Response<Body> {
    response(302, &[("Location", location), ("Cache-Control", "no-store")], empty_body())
}

/// Back to the sign-in page with a short reason it can show.
fn refuse(ctx: &mut Ctx, reason: SsoError) -> Result<Reply> {
    ctx.cookies.push(CLEAR_LOGIN_COOKIE.to_string());
    Ok(redirect(&format!("/login?sso_error={reason}")).into())
}

fn limited(ctx: &Ctx, scope: &str) -> bool {
    rate_limit(scope, &ctx.ip, 60).is_err()
}

async fn auth_config(_ctx: &mut Ctx) -> Result<Reply> {
    Ok(json!({ "sso": sso_mode() }).into())
}

async fn start_login(ctx: &mut Ctx) -> Result<Reply> {
    let auth = require_client()?;
    if limited(ctx, "sso-login") {
        return refuse(ctx, "rate_limited");
    }
    let options = StartLoginOptions { return_to: ctx.query_param("returnTo").map(str::to_string), ..Default::default() };
    match auth.start_login(options).await {
        Ok(started) => {
            ctx.cookies.push(started.login_cookie);
            Ok(redirect(&started.redirect_url).into())
        }
        Err(error) => {
            if !matches!(error, AuthError::Unavailable(_)) {
                logger::error("starting single sign-on failed", &error.message());
            }
            refuse(ctx, "unavailable")
        }
    }
}

/// Finds the person the provider signed in and starts their session here.
async fn sign_in_from_provider(ctx: &mut Ctx, login: &crate::auth_client::Login) -> Result<Option<SsoError>> {
    let user = match resolve_user(&login.claims, &login.id_claims).await? {
        Ok(user) => user,
        Err(reason) => return Ok(Some(reason)),
    };
    // Activation is doc's own: the provider let this person in, but an admin here deactivated them.
    if user.deactivated_at.is_some() {
        return Ok(Some("deactivated"));
    }
    sign_in(ctx, &user.id, Some(ProviderSession { sid: login.claims.sid.clone(), refresh_token: login.refresh_token.clone() })).await?;
    Ok(None)
}

async fn callback(ctx: &mut Ctx) -> Result<Reply> {
    let auth = require_client()?;
    if limited(ctx, "sso-callback") {
        return refuse(ctx, "rate_limited");
    }
    let cookie = ctx.header("cookie");
    let login = match auth.finish_login(cookie.as_deref(), &ctx.query).await {
        Ok(login) => login,
        Err(error) => return refuse(ctx, login_failure(&error)),
    };
    match sign_in_from_provider(ctx, &login).await {
        Ok(None) => {}
        Ok(Some(reason)) => return refuse(ctx, reason),
        Err(error) => {
            // Whatever went wrong here is not the provider's refusal: it is logged as a failure.
            let reason = login_failure(&AuthError::Other(error.to_string()));
            return refuse(ctx, reason);
        }
    }
    ctx.cookies.push(login.clear_cookie.clone());
    Ok(redirect(&login.return_to).into())
}

async fn events(ctx: &mut Ctx) -> Result<Reply> {
    let auth = require_client()?;
    rate_limit("sso-events", &ctx.ip, 600)?;
    let body = read_text(ctx, EVENT_LIMIT).await?;
    let event = match auth.read_event(&body).await {
        Ok(event) => event,
        Err(AuthError::InvalidToken(_)) => return Err(http_error(400, "invalid_token", "The event did not verify")),
        // The provider retries: its keys could not be fetched to check this one.
        Err(AuthError::Unavailable(_)) => return Err(http_error(503, "unavailable", "The identity provider is unreachable")),
        Err(error) => return Err(AppError::other(error.message())),
    };
    apply_event(&event).await?;
    Ok(ok_status(json!({}), 202).into())
}

pub fn routes() -> Vec<Route> {
    vec![
        public_get("/auth/config", handler!(auth_config)),
        public_get("/auth/login", handler!(start_login)),
        public_get("/auth/callback", handler!(callback)),
        public_post("/auth/events", handler!(events)),
    ]
}
