//! The OpenID Connect client: a port of `src/server/lib/auth-client.ts`.
//!
//! It speaks discovery, the authorization-code flow with PKCE, EdDSA JWT
//! verification against the provider's JWKS, refresh, revocation, signed
//! event tokens and the logout URL. `lib/sso.ts` and `routes/sso.ts` are its
//! only callers, and they branch on the class of every failure, so each
//! `throw` of the TypeScript lands here in the same [`AuthError`] variant with
//! the same message, and the checks run in the same order.
//!
//! What is left out, because the server never calls it: `introspect` (app
//! passwords and API keys) with its cache, and `forget`, which only drops
//! entries of that cache. `readEvent` calls `forget` at its end in the
//! TypeScript; with no cache there is nothing for it to do here.
//! `verifyAccessToken` is private: the server only reaches it through
//! [`AuthClient::finish_login`] and [`AuthClient::refresh`].
//!
//! # Shared state
//!
//! The TypeScript keeps the discovery document and the key set behind
//! promises that every concurrent caller awaits. A promise keeps running when
//! the request that started it goes away, so the equivalent here is a spawned
//! task whose outcome is published on a `watch` channel: one fetch serves all
//! callers, all of them see the same failure, and a caller that is dropped
//! midway (a browser that disconnects) neither stalls the fetch for the
//! others nor leaves the state stuck.
//!
//! # Where this knowingly differs from the TypeScript
//!
//! - JSON is read with [`parse_json`], which is `serde_json`: unlike
//!   `JSON.parse` it refuses lone surrogate escapes (`"\ud800"`), numbers
//!   beyond the range of a double (`1e999`, which JavaScript reads as
//!   `Infinity`) and nesting deeper than 128 levels. A token, cookie or
//!   provider answer containing one of these is malformed here.
//! - `error.slice(0, 64)` on the callback's `error` parameter can cut a
//!   surrogate pair in half in JavaScript; a Rust string cannot hold half a
//!   pair, so the pair is kept whole (65 units).
//! - Bun's `fetch` also reads `file:`, `data:`, `blob:` and `s3:` URLs and
//!   decompresses answers; this client only speaks plain `http:` and `https:`
//!   (anything else is "auth is unreachable") and neither offers nor undoes
//!   compression. It sends no `User-Agent` or `Accept-Encoding` header, where
//!   Bun sends `Bun/<version>` and `gzip, deflate, br, zstd`.
//! - Where the TypeScript fails with an engine-made `TypeError` (see
//!   [`NOT_A_STRING`], [`NOT_ITERABLE`] and [`INVALID_URL`]), the message here
//!   is the one Bun 1.4.4 gives when it runs the source file.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use percent_encoding::percent_decode_str;
use rand::RngCore;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::watch;
use url::Url;

use crate::jsutil::{
    encode_uri_component, js_json, js_slice, js_string, js_trim, js_truthy, number_json, number_to_string, number_value,
    parse_json, utf16_len,
};

const LEEWAY_S: f64 = 30.0;
const LOGIN_COOKIE: &str = "__Host-login";
const LOGIN_TTL_S: f64 = 300.0;
const TIMEOUT_MS: u64 = 5_000;
const JWKS_TTL_MS: f64 = 3_600_000.0;
const JWKS_MIN_INTERVAL_MS: f64 = 30_000.0;
const COOKIE_ATTRIBUTES: &str = "Path=/; Secure; HttpOnly; SameSite=Lax";

/// The message of the `TypeError` that `new URL(value)` throws in Bun.
const INVALID_URL: &str = "Invalid URL";

/// The message of the `TypeError` thrown by `viaBackChannel` when the
/// discovery document's `revocation_endpoint` is not a string and a
/// back-channel URL is set: `endpoint.startsWith` is then not a function.
/// The engine quotes the source, so this is the text Bun gives for the
/// TypeScript file as it is written.
const NOT_A_STRING: &str =
    "endpoint.startsWith is not a function. (In 'endpoint.startsWith(`${issuerBase}/`)', 'endpoint.startsWith' is undefined)";

/// The message of the `TypeError` thrown by `readEvent` for an event whose
/// type is the name of a property every JavaScript object inherits
/// ([`INHERITED_NAMES`]): `EVENT_FIELDS[type]` is then that property instead
/// of `undefined`, and the `for … of` over it fails.
const NOT_ITERABLE: &str = "{} is not iterable";

/// The own property names of `Object.prototype`.
const INHERITED_NAMES: [&str; 12] = [
    "toString",
    "toLocaleString",
    "valueOf",
    "hasOwnProperty",
    "propertyIsEnumerable",
    "isPrototypeOf",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
    "constructor",
];

type Json = Map<String, Value>;

/// The settings of `createAuthClient`, without `fetch` and `now`.
#[derive(Debug, Clone, Default)]
pub struct AuthClientOptions {
    /// The issuer URL, exactly as tokens carry it in `iss`.
    pub issuer: String,
    /// A private-network URL for the same service, used for every server-to-server call.
    pub back_channel_url: Option<String>,
    pub client_id: String,
    /// `None` for a public client.
    pub client_secret: Option<String>,
    pub redirect_uri: String,
    /// The `aud` of this app's access tokens and events. Defaults to `client_id`.
    pub audience: Option<String>,
}

/// One variant per error class of the TypeScript.
#[derive(Debug, Clone, PartialEq)]
pub enum AuthError {
    /// The provider refused a code or refresh token: end the session.
    InvalidGrant(String),
    /// The provider could not be reached, timed out, or failed on its side.
    Unavailable(String),
    /// A token or event failed verification.
    InvalidToken(String),
    /// The callback can't complete this sign-in; start a new one. `code` is
    /// one of `no_login_cookie`, `login_expired`, `state_mismatch`,
    /// `authorization_error`, `missing_code`; `error` is the provider's
    /// `error` parameter for `authorization_error`.
    Login { code: &'static str, error: Option<String> },
    /// A plain `Error` in the TypeScript: misconfiguration, a refusing provider, an engine-made `TypeError`.
    Other(String),
}

impl AuthError {
    /// The JavaScript `error.message`.
    pub fn message(&self) -> String {
        match self {
            AuthError::InvalidGrant(message)
            | AuthError::Unavailable(message)
            | AuthError::InvalidToken(message)
            | AuthError::Other(message) => message.clone(),
            // `super(error ? `${code}: ${error}` : code)`: an empty `error` is falsy.
            AuthError::Login { code, error } => match error.as_deref() {
                Some(error) if !error.is_empty() => format!("{code}: {error}"),
                _ => (*code).to_string(),
            },
        }
    }
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for AuthError {}

fn unavailable(message: impl Into<String>) -> AuthError {
    AuthError::Unavailable(message.into())
}

fn invalid_token(message: impl Into<String>) -> AuthError {
    AuthError::InvalidToken(message.into())
}

fn other(message: impl Into<String>) -> AuthError {
    AuthError::Other(message.into())
}

fn login_error(code: &'static str) -> AuthError {
    AuthError::Login { code, error: None }
}

/// The claims of a verified access token. `all` is the whole payload.
#[derive(Debug, Clone, PartialEq)]
pub struct AccessClaims {
    pub sub: String,
    pub sid: String,
    pub username: String,
    pub name: String,
    pub role: String,
    pub all: Json,
}

/// The claims of a verified ID token. `email` and `email_verified` are the
/// raw JSON values, because the callers test `=== true` and `typeof … ===
/// "string"` on them. `all` is the whole payload.
#[derive(Debug, Clone, PartialEq)]
pub struct IdClaims {
    pub email: Option<Value>,
    pub email_verified: Option<Value>,
    pub all: Json,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Login {
    pub claims: AccessClaims,
    pub id_claims: IdClaims,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub return_to: String,
    /// A `Set-Cookie` value that deletes the login cookie.
    pub clear_cookie: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Refreshed {
    pub claims: AccessClaims,
    pub access_token: String,
    /// Present when the provider rotated the refresh token.
    pub refresh_token: Option<String>,
}

/// Known types: session.ended, access.changed, user.disabled,
/// invite.accepted, user.deleted, credential.revoked. Others come with
/// `type_` and `jti` only, so the app can acknowledge and ignore them.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AuthEvent {
    pub type_: String,
    pub jti: String,
    pub sub: Option<String>,
    pub sid: Option<String>,
    /// On access.changed: the new role. `Some(None)` is an explicit JSON null (access removed).
    pub role: Option<Option<String>>,
    pub id: Option<String>,
    pub invite: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct StartLoginOptions {
    /// A local path to land on after sign-in. Anything else is replaced with "/".
    pub return_to: Option<String>,
    /// Seconds; a JavaScript number, so a double.
    pub max_age: Option<f64>,
    /// `none` or `login`.
    pub prompt: Option<String>,
    pub login_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StartedLogin {
    pub redirect_url: String,
    pub login_cookie: String,
}

/// The fields of the discovery document this client reads. The three
/// required endpoints are known to be strings; the optional ones are kept as
/// the provider wrote them, because the TypeScript only tests their
/// truthiness before using them.
#[derive(Debug)]
struct Discovery {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    revocation_endpoint: Option<Value>,
    end_session_endpoint: Option<Value>,
}

/// What a shared fetch publishes: `None` while it runs.
type Outcome<T> = Option<Result<T, AuthError>>;

/// A fetch in flight (or, for discovery, done), with the id that tells it from a later one.
struct Slot<T> {
    id: u64,
    outcome: watch::Receiver<Outcome<T>>,
}

struct State {
    /// `discovery` of the TypeScript: the pending or fulfilled promise.
    discovery: Option<Slot<Arc<Discovery>>>,
    /// The provider's public keys by `kid`, as the 32 bytes of each JWK's `x`.
    keys: HashMap<String, [u8; 32]>,
    keys_fetched_at: f64,
    last_keys_attempt: f64,
    keys_loading: Option<Slot<()>>,
    next_id: u64,
}

struct Inner {
    issuer: String,
    issuer_base: String,
    back_base: Option<String>,
    client_id: String,
    client_secret: Option<String>,
    redirect_uri: String,
    audience: String,
    http: reqwest::Client,
    now: Box<dyn Fn() -> f64 + Send + Sync>,
    state: Mutex<State>,
}

/// The client. Cheap to clone; all clones share the discovery document and the
/// keys. Its methods start the shared fetches with `tokio::spawn`, so they must
/// be called on a Tokio runtime.
#[derive(Clone)]
pub struct AuthClient {
    inner: Arc<Inner>,
}

/// Empties a slot whose task ended without publishing an outcome (it
/// panicked, or its runtime shut down), so the next caller starts afresh
/// instead of waiting on a channel nobody will write to.
struct Abandoned {
    inner: Arc<Inner>,
    id: u64,
    armed: bool,
}

impl Drop for Abandoned {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut state = self.inner.state();
        if state.discovery.as_ref().is_some_and(|slot| slot.id == self.id) {
            state.discovery = None;
        }
        if state.keys_loading.as_ref().is_some_and(|slot| slot.id == self.id) {
            state.keys_loading = None;
        }
    }
}

/// Awaits a shared fetch, as `await promise` does.
async fn settled<T: Clone>(mut outcome: watch::Receiver<Outcome<T>>) -> Result<T, AuthError> {
    match outcome.wait_for(Option::is_some).await {
        Ok(value) => (*value).clone().expect("checked by wait_for"),
        // The task is gone without an answer; see `Abandoned`.
        Err(_) => Err(unavailable("auth is unreachable")),
    }
}

/// A form post: the parameters, in order.
type Form<'a> = &'a [(&'a str, &'a str)];

impl AuthClient {
    /// `createAuthClient(options)`: `Err` carries the message `checkOptions` throws.
    pub fn new(options: AuthClientOptions) -> Result<AuthClient, String> {
        // `Date.now`: whole milliseconds since the epoch.
        Self::with_clock(options, || SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64))
    }

    /// The same with the `now` option: `clock` returns milliseconds since the epoch. For tests.
    pub fn with_clock(options: AuthClientOptions, clock: impl Fn() -> f64 + Send + Sync + 'static) -> Result<AuthClient, String> {
        check_options(&options)?;
        // `redirect: "manual"` and `AbortSignal.timeout(TIMEOUT_MS)`: the
        // timeout covers the whole call, the reading of the body included.
        let http = crate::http::https_client()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_millis(TIMEOUT_MS))
            .build()
            .map_err(|error| format!("the HTTP client could not be set up: {error}"))?;
        let audience = options.audience.unwrap_or_else(|| options.client_id.clone());
        Ok(AuthClient {
            inner: Arc::new(Inner {
                issuer_base: options.issuer.trim_end_matches('/').to_string(),
                back_base: options.back_channel_url.map(|url| url.trim_end_matches('/').to_string()),
                issuer: options.issuer,
                client_id: options.client_id,
                client_secret: options.client_secret,
                redirect_uri: options.redirect_uri,
                audience,
                http,
                now: Box::new(clock),
                state: Mutex::new(State {
                    discovery: None,
                    keys: HashMap::new(),
                    keys_fetched_at: f64::NEG_INFINITY,
                    last_keys_attempt: f64::NEG_INFINITY,
                    keys_loading: None,
                    next_id: 0,
                }),
            }),
        })
    }

    /// `startLogin(req, options)`: where to send the browser, and the cookie
    /// that carries what was asked of the sign-in to the callback.
    pub async fn start_login(&self, options: StartLoginOptions) -> Result<StartedLogin, AuthError> {
        let inner = &self.inner;
        let discovery = inner.discover().await?;
        let state = random();
        let nonce = random();
        let verifier = random();
        let mut url = Url::parse(&discovery.authorization_endpoint).map_err(|_| other(INVALID_URL))?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut params: Vec<(&str, String)> = vec![
            ("response_type", "code".into()),
            ("client_id", inner.client_id.clone()),
            ("redirect_uri", inner.redirect_uri.clone()),
            ("scope", "openid profile email".into()),
            ("state", state.clone()),
            ("nonce", nonce.clone()),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256".into()),
        ];
        if let Some(prompt) = &options.prompt {
            if prompt != "none" && prompt != "login" {
                return Err(other("prompt must be none or login"));
            }
            params.push(("prompt", prompt.clone()));
        }
        if let Some(max_age) = options.max_age {
            if !is_safe_integer(max_age) || max_age < 0.0 {
                return Err(other("maxAge must be a whole number of seconds"));
            }
            params.push(("max_age", number_to_string(max_age)));
        }
        if let Some(hint) = &options.login_hint {
            params.push(("login_hint", hint.clone()));
        }
        set_search_params(&mut url, &params);
        let return_to = options.return_to.as_deref().filter(|path| is_local_path(path)).unwrap_or("/");
        // What was asked of the sign-in travels with the cookie: the browser
        // carries the request and can drop max_age or prompt from it, so the
        // ID token's auth_time is checked against them at the callback.
        let mut login = Json::new();
        login.insert("state".into(), Value::String(state));
        login.insert("nonce".into(), Value::String(nonce));
        login.insert("verifier".into(), Value::String(verifier));
        login.insert("returnTo".into(), Value::String(return_to.to_string()));
        login.insert("iat".into(), number_json((inner.now() / 1000.0).floor()));
        // `JSON.stringify` leaves out a property that is undefined.
        if let Some(max_age) = options.max_age {
            login.insert("maxAge".into(), number_json(max_age));
        }
        login.insert("fresh".into(), Value::Bool(options.prompt.as_deref() == Some("login")));
        let value = URL_SAFE_NO_PAD.encode(js_json(&Value::Object(login)));
        Ok(StartedLogin {
            redirect_url: url.into(),
            login_cookie: format!("{LOGIN_COOKIE}={value}; {COOKIE_ATTRIBUTES}; Max-Age={LOGIN_TTL_S}"),
        })
    }

    /// `finishLogin(req)`. `cookie_header` is the request's `Cookie` header;
    /// `query` is `new URL(req.url).searchParams`, decoded, in order.
    pub async fn finish_login(&self, cookie_header: Option<&str>, query: &[(String, String)]) -> Result<Login, AuthError> {
        let inner = &self.inner;
        // Read leniently: a browser, or an attacker, can send anything. A
        // value that is base64url but not a JSON object is a malformed
        // segment (`parseSegment` throws); every other shape is no cookie.
        let saved = match read_cookie(cookie_header, LOGIN_COOKIE) {
            Some(raw) if is_base64url(raw) => parse_segment(raw)?,
            _ => Json::new(),
        };
        let (Some(Value::String(state)), Some(Value::String(nonce)), Some(Value::String(verifier)), Some(Value::Number(iat))) =
            (saved.get("state"), saved.get("nonce"), saved.get("verifier"), saved.get("iat"))
        else {
            return Err(login_error("no_login_cookie"));
        };
        let iat = number_value(iat);
        let t = inner.now() / 1000.0;
        if t - iat > LOGIN_TTL_S || iat > t + LEEWAY_S {
            return Err(login_error("login_expired"));
        }
        let get = |name: &str| query.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
        if let Some(error) = get("error") {
            return Err(AuthError::Login { code: "authorization_error", error: Some(js_slice(error, 0, Some(64))) });
        }
        if !same_digest(get("state").unwrap_or(""), state) {
            return Err(login_error("state_mismatch"));
        }
        let Some(code) = get("code").filter(|code| !code.is_empty()) else {
            return Err(login_error("missing_code"));
        };
        let answer = inner
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", &inner.redirect_uri),
                ("code_verifier", verifier),
            ])
            .await?;
        let (Some(Value::String(access_token)), Some(Value::String(id_token))) = (answer.get("access_token"), answer.get("id_token"))
        else {
            return Err(unavailable("the token endpoint answered without an access token or ID token"));
        };
        let claims = inner.verify_access_token(access_token).await?;
        let id_claims = inner.verify_jwt(id_token, "jwt", &inner.client_id, true).await?;
        let several_audiences = matches!(id_claims.get("aud"), Some(Value::Array(items)) if items.len() > 1);
        if several_audiences && id_claims.get("azp").and_then(Value::as_str) != Some(inner.client_id.as_str()) {
            return Err(invalid_token("wrong authorized party"));
        }
        if !matches!(id_claims.get("nonce"), Some(Value::String(found)) if same_digest(found, nonce)) {
            return Err(invalid_token("nonce mismatch"));
        }
        if id_claims.get("sub").and_then(Value::as_str) != Some(claims.sub.as_str()) {
            return Err(invalid_token("the ID token names another subject"));
        }
        // OIDC Core §3.1.3.7: with max_age or prompt=login, the sign-in must be
        // as recent as asked, whatever the authorization request ended up as.
        let max_age = match saved.get("maxAge") {
            Some(Value::Number(n)) => Some(number_value(n)),
            _ => None,
        };
        let fresh = saved.get("fresh") == Some(&Value::Bool(true));
        if max_age.is_some() || fresh {
            let Some(Value::Number(auth_time)) = id_claims.get("auth_time") else {
                return Err(invalid_token("no auth_time"));
            };
            let auth_time = number_value(auth_time);
            if max_age.is_some_and(|max_age| t - auth_time > max_age + LEEWAY_S) {
                return Err(invalid_token("the sign-in is older than max_age"));
            }
            if fresh && auth_time < iat - LEEWAY_S {
                return Err(invalid_token("the sign-in is older than the login request"));
            }
        }
        let return_to = saved.get("returnTo").and_then(Value::as_str).filter(|path| is_local_path(path)).unwrap_or("/");
        Ok(Login {
            claims,
            id_claims: IdClaims {
                email: id_claims.get("email").cloned(),
                email_verified: id_claims.get("email_verified").cloned(),
                all: id_claims,
            },
            access_token: access_token.clone(),
            refresh_token: answer.get("refresh_token").and_then(Value::as_str).map(str::to_string),
            return_to: return_to.to_string(),
            clear_cookie: format!("{LOGIN_COOKIE}=; {COOKIE_ATTRIBUTES}; Max-Age=0"),
        })
    }

    /// `refresh(refreshToken)`: asks the provider about the user again.
    pub async fn refresh(&self, refresh_token: &str) -> Result<Refreshed, AuthError> {
        let inner = &self.inner;
        let answer = inner.token_request(&[("grant_type", "refresh_token"), ("refresh_token", refresh_token)]).await?;
        let Some(Value::String(access_token)) = answer.get("access_token") else {
            return Err(unavailable("the token endpoint answered without an access token"));
        };
        let claims = inner.verify_access_token(access_token).await?;
        Ok(Refreshed {
            claims,
            access_token: access_token.clone(),
            refresh_token: answer.get("refresh_token").and_then(Value::as_str).map(str::to_string),
        })
    }

    /// `revoke(refreshToken)`.
    pub async fn revoke(&self, refresh_token: &str) -> Result<(), AuthError> {
        let inner = &self.inner;
        let discovery = inner.discover().await?;
        // `!revocation_endpoint`: missing, or any falsy value.
        let Some(endpoint) = discovery.revocation_endpoint.as_ref().filter(|value| js_truthy(value)) else {
            return Err(other("the provider has no revocation endpoint"));
        };
        let endpoint = match endpoint {
            Value::String(endpoint) => endpoint.clone(),
            // `endpoint.startsWith` is not a function.
            _ if inner.back_base.is_some() => return Err(other(NOT_A_STRING)),
            // Without a back channel the value goes to `fetch` as it is, which
            // reads an array as its elements joined by commas and refuses
            // every other kind of value.
            Value::Array(_) => js_string(endpoint),
            _ => return Err(unavailable("auth is unreachable")),
        };
        let res = inner.post(&endpoint, &[("token", refresh_token), ("token_type_hint", "refresh_token")]).await?;
        if !res.status().is_success() {
            return Err(other(format!("revocation refused the request ({})", res.status().as_u16())));
        }
        Ok(())
    }

    /// `readEvent(body)`: verifies a security event token and returns its one event.
    pub async fn read_event(&self, body: &str) -> Result<AuthEvent, AuthError> {
        let inner = &self.inner;
        let set = inner.verify_jwt(js_trim(body), "secevent+jwt", &inner.audience, false).await?;
        let jti = match set.get("jti") {
            Some(Value::String(jti)) if !jti.is_empty() => jti.clone(),
            _ => return Err(invalid_token("no jti")),
        };
        let event = match set.get("events") {
            Some(Value::Object(events)) if events.len() == 1 => events.iter().next(),
            _ => None,
        };
        let Some((type_, payload)) = event else {
            return Err(invalid_token("a SET carries exactly one event"));
        };
        let Value::Object(payload) = payload else {
            return Err(invalid_token("malformed event payload"));
        };
        let mut event = AuthEvent { type_: type_.clone(), jti, ..AuthEvent::default() };
        let required: &[&str] = match type_.as_str() {
            "session.ended" => &["sid"],
            "access.changed" | "user.disabled" | "user.deleted" => &["sub"],
            "invite.accepted" => &["invite", "sub"],
            "credential.revoked" => &["sub", "id"],
            // `EVENT_FIELDS` is an object literal, so these names find what it inherits.
            name if INHERITED_NAMES.contains(&name) => return Err(other(NOT_ITERABLE)),
            _ => return Ok(event),
        };
        for field in required {
            let Some(Value::String(value)) = payload.get(*field) else {
                return Err(invalid_token(format!("{type_} without {field}")));
            };
            let slot = match *field {
                "sid" => &mut event.sid,
                "sub" => &mut event.sub,
                "invite" => &mut event.invite,
                _ => &mut event.id,
            };
            *slot = Some(value.clone());
        }
        if type_ == "access.changed" {
            // A missing role is `undefined`, which is neither null nor a string.
            event.role = match payload.get("role") {
                Some(Value::Null) => Some(None),
                Some(Value::String(role)) => Some(Some(role.clone())),
                _ => return Err(invalid_token("access.changed without role")),
            };
        }
        Ok(event)
    }

    /// `logoutUrl(postLogoutRedirect)`: where the browser ends the provider's own session.
    pub async fn logout_url(&self, post_logout_redirect: Option<&str>) -> Result<String, AuthError> {
        let inner = &self.inner;
        let discovery = inner.discover().await?;
        let Some(endpoint) = discovery.end_session_endpoint.as_ref().filter(|value| js_truthy(value)) else {
            return Err(other("the provider has no end_session_endpoint"));
        };
        // `new URL(value)` reads any value as `String(value)`.
        let mut url = Url::parse(&js_string(endpoint)).map_err(|_| other(INVALID_URL))?;
        let mut params = vec![("client_id", inner.client_id.clone())];
        if let Some(redirect) = post_logout_redirect {
            params.push(("post_logout_redirect_uri", redirect.to_string()));
        }
        set_search_params(&mut url, &params);
        Ok(url.into())
    }
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn now(&self) -> f64 {
        (self.now)()
    }

    /// Only endpoints under the issuer are rewritten to the back-channel base.
    fn via_back_channel(&self, endpoint: &str) -> String {
        if let Some(back_base) = &self.back_base {
            let under_issuer = endpoint
                .strip_prefix(self.issuer_base.as_str())
                .filter(|rest| rest.is_empty() || rest.starts_with('/'));
            if let Some(rest) = under_issuer {
                return format!("{back_base}{rest}");
            }
        }
        endpoint.to_string()
    }

    /// `call(url, init)`: a GET, or a form POST when `form` is given.
    /// Whatever keeps an answer from arriving (a URL `fetch` refuses, the
    /// network, the timeout) is "auth is unreachable"; a 5xx answer is
    /// unavailable too. Redirects are not followed.
    async fn call(&self, url: &str, form: Option<(String, Option<String>)>) -> Result<reqwest::Response, AuthError> {
        let unreachable = || unavailable("auth is unreachable");
        let mut url = Url::parse(url).map_err(|_| unreachable())?;
        let (body, mut authorization) = match form {
            Some((body, authorization)) => (Some(body), authorization),
            None => (None, None),
        };
        // Credentials in the URL: `fetch` sends them as Basic authentication
        // unless the request has an Authorization header of its own. Left to
        // itself, reqwest would send both.
        if !url.username().is_empty() || url.password().is_some() {
            if authorization.is_none() {
                let user = percent_decode_str(url.username()).decode_utf8_lossy().into_owned();
                let password = percent_decode_str(url.password().unwrap_or("")).decode_utf8_lossy().into_owned();
                authorization = Some(format!("Basic {}", STANDARD.encode(format!("{user}:{password}"))));
            }
            let _ = url.set_username("");
            let _ = url.set_password(None);
        }
        let mut request = match body {
            Some(body) => self.http.post(url).header("Content-Type", "application/x-www-form-urlencoded").body(body),
            None => self.http.get(url),
        };
        request = request.header("Accept", "application/json");
        if let Some(authorization) = authorization {
            request = request.header("Authorization", authorization);
        }
        let res = request.send().await.map_err(|_| unreachable())?;
        if res.status().as_u16() >= 500 {
            return Err(unavailable(format!("auth answered {}", res.status().as_u16())));
        }
        Ok(res)
    }

    /// `readJson(res)`: the body as a JSON object. `res.json()` decodes the
    /// bytes as UTF-8 the way browsers do: invalid sequences become U+FFFD
    /// and a leading byte order mark is dropped.
    async fn read_json(&self, res: reqwest::Response) -> Result<Json, AuthError> {
        let status = res.status().as_u16();
        if let Ok(bytes) = res.bytes().await {
            let text = String::from_utf8_lossy(&bytes);
            let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
            if let Ok(Value::Object(body)) = parse_json(text.as_bytes()) {
                return Ok(body);
            }
        }
        Err(unavailable(format!("auth answered {status} with a malformed body")))
    }

    /// `discover()`: the discovery document, fetched once and shared by
    /// concurrent callers. A failed fetch is forgotten before its callers
    /// see the failure, so the next call tries again.
    async fn discover(self: &Arc<Self>) -> Result<Arc<Discovery>, AuthError> {
        let outcome = {
            let mut state = self.state();
            match &state.discovery {
                Some(slot) => slot.outcome.clone(),
                None => {
                    let (publish, outcome) = watch::channel(None);
                    let id = state.next_id;
                    state.next_id += 1;
                    state.discovery = Some(Slot { id, outcome: outcome.clone() });
                    let inner = Arc::clone(self);
                    tokio::spawn(async move {
                        let mut abandoned = Abandoned { inner: Arc::clone(&inner), id, armed: true };
                        let result = inner.fetch_discovery().await;
                        if result.is_err() {
                            let mut state = inner.state();
                            if state.discovery.as_ref().is_some_and(|slot| slot.id == id) {
                                state.discovery = None;
                            }
                        }
                        abandoned.armed = false;
                        let _ = publish.send(Some(result));
                    });
                    outcome
                }
            }
        };
        settled(outcome).await
    }

    async fn fetch_discovery(&self) -> Result<Arc<Discovery>, AuthError> {
        let url = self.via_back_channel(&format!("{}/.well-known/openid-configuration", self.issuer_base));
        let res = self.call(&url, None).await?;
        if !res.status().is_success() {
            return Err(unavailable(format!("discovery answered {}", res.status().as_u16())));
        }
        let mut doc = self.read_json(res).await?;
        // OIDC Discovery §4.3: a document naming another issuer is refused.
        if doc.get("issuer").and_then(Value::as_str) != Some(self.issuer.as_str()) {
            return Err(other("the discovery document names a different issuer"));
        }
        let mut endpoint = |field: &str| match doc.remove(field) {
            Some(Value::String(endpoint)) => Ok(endpoint),
            _ => Err(other(format!("the discovery document has no {field}"))),
        };
        let authorization_endpoint = endpoint("authorization_endpoint")?;
        let token_endpoint = endpoint("token_endpoint")?;
        let jwks_uri = endpoint("jwks_uri")?;
        Ok(Arc::new(Discovery {
            authorization_endpoint,
            token_endpoint,
            jwks_uri,
            revocation_endpoint: doc.remove("revocation_endpoint"),
            end_session_endpoint: doc.remove("end_session_endpoint"),
        }))
    }

    /// `post(endpoint, params)` with `authenticate`: a form post carrying the
    /// client's credentials. RFC 6749 §2.3.1: each part is form-encoded
    /// before Basic encoding. A public client names itself in the body.
    async fn post(&self, endpoint: &str, params: Form<'_>) -> Result<reqwest::Response, AuthError> {
        // The serializer is not `Sync`, so it is done with before anything is awaited.
        let request = {
            let mut body = url::form_urlencoded::Serializer::new(String::new());
            body.extend_pairs(params);
            let authorization = match &self.client_secret {
                None => {
                    body.append_pair("client_id", &self.client_id);
                    None
                }
                Some(secret) => {
                    let pair = format!("{}:{}", form_encode(&self.client_id), form_encode(secret));
                    Some(format!("Basic {}", STANDARD.encode(pair)))
                }
            };
            (body.finish(), authorization)
        };
        self.call(&self.via_back_channel(endpoint), Some(request)).await
    }

    /// `tokenRequest(params)`. The body is read before the status is looked
    /// at, so a refusal without a JSON object is a malformed answer.
    async fn token_request(self: &Arc<Self>, params: Form<'_>) -> Result<Json, AuthError> {
        let discovery = self.discover().await?;
        let res = self.post(&discovery.token_endpoint, params).await?;
        let status = res.status();
        let answer = self.read_json(res).await?;
        if status.is_success() {
            return Ok(answer);
        }
        if answer.get("error").and_then(Value::as_str) == Some("invalid_grant") {
            return Err(AuthError::InvalidGrant("the provider refused the grant".into()));
        }
        if status.as_u16() == 429 {
            return Err(unavailable("the token endpoint is rate limiting this client"));
        }
        Err(other(format!("the token endpoint refused the request ({})", error_code(&answer, status.as_u16()))))
    }

    /// `loadKeys()`: starts a fetch of the key set, or joins the one in
    /// flight. `None` is the `Promise.resolve()` of the TypeScript: the last
    /// attempt, successful or not, is less than 30 s old. Without this floor,
    /// tokens with made-up kids could make every request fetch.
    fn load_keys(self: &Arc<Self>) -> Option<watch::Receiver<Outcome<()>>> {
        let mut state = self.state();
        if let Some(slot) = &state.keys_loading {
            return Some(slot.outcome.clone());
        }
        if self.now() - state.last_keys_attempt < JWKS_MIN_INTERVAL_MS {
            return None;
        }
        state.last_keys_attempt = self.now();
        let (publish, outcome) = watch::channel(None);
        let id = state.next_id;
        state.next_id += 1;
        state.keys_loading = Some(Slot { id, outcome: outcome.clone() });
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            let mut abandoned = Abandoned { inner: Arc::clone(&inner), id, armed: true };
            let result = inner.fetch_keys().await;
            let result = {
                let mut state = inner.state();
                // `finally { keysLoading = undefined }`, before the callers go on.
                state.keys_loading = None;
                result.map(|keys| {
                    state.keys = keys;
                    state.keys_fetched_at = inner.now();
                })
            };
            abandoned.armed = false;
            let _ = publish.send(Some(result));
        });
        Some(outcome)
    }

    async fn fetch_keys(self: &Arc<Self>) -> Result<HashMap<String, [u8; 32]>, AuthError> {
        let discovery = self.discover().await?;
        let res = self.call(&self.via_back_channel(&discovery.jwks_uri), None).await?;
        if !res.status().is_success() {
            return Err(unavailable(format!("the key set answered {}", res.status().as_u16())));
        }
        let doc = self.read_json(res).await?;
        let mut keys = HashMap::new();
        if let Some(Value::Array(jwks)) = doc.get("keys") {
            for (kid, key) in jwks.iter().filter_map(import_key) {
                keys.insert(kid, key);
            }
        }
        Ok(keys)
    }

    /// `keyFor(kid)`. The keys are refreshed when they are an hour old or
    /// the kid is unknown. While the provider is unreachable the keys already
    /// held keep verifying; any other failure of the fetch (a discovery
    /// document that is refused) is the caller's.
    async fn key_for(self: &Arc<Self>, kid: &str) -> Result<[u8; 32], AuthError> {
        let refresh = {
            let state = self.state();
            self.now() - state.keys_fetched_at >= JWKS_TTL_MS || !state.keys.contains_key(kid)
        };
        if refresh {
            if let Some(loading) = self.load_keys() {
                match settled(loading).await {
                    Ok(()) | Err(AuthError::Unavailable(_)) => {}
                    Err(error) => return Err(error),
                }
            }
            if self.state().keys_fetched_at == f64::NEG_INFINITY {
                return Err(unavailable("auth's signing keys are unavailable"));
            }
        }
        self.state().keys.get(kid).copied().ok_or_else(|| invalid_token("signed with an unknown key"))
    }

    /// `verifyJwt(token, typ, aud, checkExp)`: the payload of a token this
    /// provider signed for `aud`.
    async fn verify_jwt(self: &Arc<Self>, token: &str, typ: &str, aud: &str, check_exp: bool) -> Result<Json, AuthError> {
        let parts: Vec<&str> = token.split('.').collect();
        let &[h, p, s] = parts.as_slice() else {
            return Err(invalid_token("not a JWT"));
        };
        if !parts.iter().all(|part| is_base64url(part)) {
            return Err(invalid_token("not a JWT"));
        }
        let header = parse_segment(h)?;
        let payload = parse_segment(p)?;
        // The algorithm is pinned: the header can only confirm it, never choose it.
        if header.get("alg").and_then(Value::as_str) != Some("EdDSA") {
            return Err(invalid_token("unexpected alg"));
        }
        if !matches!(header.get("typ"), Some(Value::String(found)) if found.to_lowercase() == typ) {
            return Err(invalid_token("unexpected typ"));
        }
        // `header.crit !== undefined`: present with any value, null included.
        if header.contains_key("crit") {
            return Err(invalid_token("unsupported critical header"));
        }
        let Some(Value::String(kid)) = header.get("kid") else {
            return Err(invalid_token("no kid"));
        };
        let key = self.key_for(kid).await?;
        let signature = decode_base64url(s);
        if signature.len() != 64 || !verify_ed25519(&key, format!("{h}.{p}").as_bytes(), &signature) {
            return Err(invalid_token("bad signature"));
        }
        if payload.get("iss").and_then(Value::as_str) != Some(self.issuer.as_str()) {
            return Err(invalid_token("wrong issuer"));
        }
        let aud_ok = match payload.get("aud") {
            Some(Value::String(found)) => found == aud,
            Some(Value::Array(found)) => found.iter().any(|item| item.as_str() == Some(aud)),
            _ => false,
        };
        if !aud_ok {
            return Err(invalid_token("wrong audience"));
        }
        let t = self.now() / 1000.0;
        if !matches!(payload.get("iat"), Some(Value::Number(iat)) if number_value(iat) <= t + LEEWAY_S) {
            return Err(invalid_token("issued in the future"));
        }
        if check_exp && !matches!(payload.get("exp"), Some(Value::Number(exp)) if t <= number_value(exp) + LEEWAY_S) {
            return Err(invalid_token("expired"));
        }
        Ok(payload)
    }

    async fn verify_access_token(self: &Arc<Self>, jwt: &str) -> Result<AccessClaims, AuthError> {
        let claims = self.verify_jwt(jwt, "at+jwt", &self.audience, true).await?;
        let claim = |name: &str| match claims.get(name) {
            Some(Value::String(value)) => Ok(value.clone()),
            _ => Err(invalid_token(format!("no {name} claim"))),
        };
        Ok(AccessClaims {
            sub: claim("sub")?,
            sid: claim("sid")?,
            username: claim("username")?,
            name: claim("name")?,
            role: claim("role")?,
            all: claims,
        })
    }
}

const LOOPBACK: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// `checkOptions(o)`: the message of the first problem.
fn check_options(o: &AuthClientOptions) -> Result<(), String> {
    // `url.search` and `url.hash` are empty for a bare "?" or "#".
    let has_query_or_fragment =
        |url: &Url| url.query().is_some_and(|q| !q.is_empty()) || url.fragment().is_some_and(|f| !f.is_empty());
    let issuer = parse_url(&o.issuer, "issuer")?;
    let loopback = issuer.host_str().is_some_and(|host| LOOPBACK.contains(&host));
    if !(issuer.scheme() == "https" || (issuer.scheme() == "http" && loopback)) {
        return Err("issuer must be an https URL (http only for localhost)".into());
    }
    if has_query_or_fragment(&issuer) {
        return Err("issuer must have no query or fragment".into());
    }
    if let Some(back_channel_url) = &o.back_channel_url {
        let back = parse_url(back_channel_url, "backChannelUrl")?;
        if back.scheme() != "https" && back.scheme() != "http" {
            return Err("backChannelUrl must be an http or https URL".into());
        }
        if has_query_or_fragment(&back) {
            return Err("backChannelUrl must have no query or fragment".into());
        }
    }
    if o.client_id.is_empty() {
        return Err("clientId is required".into());
    }
    parse_url(&o.redirect_uri, "redirectUri")?;
    if o.client_secret.as_deref() == Some("") {
        return Err("clientSecret must be a non-empty string when set".into());
    }
    if o.audience.as_deref() == Some("") {
        return Err("audience must be a non-empty string when set".into());
    }
    Ok(())
}

fn parse_url(value: &str, name: &str) -> Result<Url, String> {
    if value.is_empty() {
        return Err(format!("{name} is required"));
    }
    Url::parse(value).map_err(|_| format!("{name} must be an absolute URL"))
}

/// `importKey(jwk)`: the kid and the 32 bytes of an Ed25519 signing key, or
/// `None` for anything else. Like `createPublicKey`, this takes any 32 bytes:
/// a key that is not a point of the curve is kept, and no signature verifies
/// against it.
fn import_key(jwk: &Value) -> Option<(String, [u8; 32])> {
    let jwk = jwk.as_object()?;
    if jwk.get("kty").and_then(Value::as_str) != Some("OKP") || jwk.get("crv").and_then(Value::as_str) != Some("Ed25519") {
        return None;
    }
    let (Some(Value::String(x)), Some(Value::String(kid))) = (jwk.get("x"), jwk.get("kid")) else {
        return None;
    };
    // `jwk.use !== undefined && jwk.use !== "sig"`: a null counts as set.
    let absent_or = |name: &str, expected: &str| jwk.get(name).is_none_or(|value| value.as_str() == Some(expected));
    if !absent_or("use", "sig") || !absent_or("alg", "EdDSA") {
        return None;
    }
    let key: [u8; 32] = decode_base64url(x).try_into().ok()?;
    Some((kid.clone(), key))
}

/// `crypto.verify(null, message, key, signature)` for Ed25519, as BoringSSL
/// does it and as `VerifyingKey::verify` (not `verify_strict`) does: `s` must
/// be below the group order and the recomputed `R` must equal the
/// signature's bytes; keys of small order are not refused.
fn verify_ed25519(key: &[u8; 32], message: &[u8], signature: &[u8]) -> bool {
    let Ok(signature) = <[u8; 64]>::try_from(signature) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(key) else {
        return false;
    };
    key.verify(message, &Signature::from_bytes(&signature)).is_ok()
}

/// `/^[A-Za-z0-9_-]+$/`.
fn is_base64url(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `Buffer.from(text, "base64url")` as Bun decodes it: it never fails. Both
/// alphabets are read, decoding stops at the first `=`, every other
/// character is skipped, a dangling last character is ignored and so are the
/// bits of the last character that do not fill a byte. Bun looks only at the
/// low byte of each UTF-16 code unit (so `Ł`, U+0141, reads as `A`), and so
/// does this. The same decoder reads the `x` of a JWK.
fn decode_base64url(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 2);
    let mut bits = 0u32;
    let mut count = 0;
    for unit in text.encode_utf16() {
        let value = match (unit & 0xff) as u8 {
            c @ b'A'..=b'Z' => c - b'A',
            c @ b'a'..=b'z' => c - b'a' + 26,
            c @ b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(value);
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]);
            bits = 0;
            count = 0;
        }
    }
    match count {
        2 => out.push((bits >> 4) as u8),
        3 => out.extend_from_slice(&[(bits >> 10) as u8, (bits >> 2) as u8]),
        _ => {}
    }
    out
}

/// `parseSegment(segment)`: a base64url segment holding a JSON object.
/// `Buffer.toString("utf8")` replaces invalid sequences with U+FFFD and
/// keeps a byte order mark, which `JSON.parse` then refuses.
fn parse_segment(segment: &str) -> Result<Json, AuthError> {
    let bytes = decode_base64url(segment);
    match parse_json(String::from_utf8_lossy(&bytes).as_bytes()) {
        Ok(Value::Object(value)) => Ok(value),
        _ => Err(invalid_token("malformed segment")),
    }
}

/// `readCookie(header, name)`: the value of the first cookie with that name.
fn read_cookie<'a>(header: Option<&'a str>, name: &str) -> Option<&'a str> {
    header.unwrap_or("").split(';').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (!key.is_empty() && js_trim(key) == name).then(|| js_trim(value))
    })
}

/// `isLocalPath(path)`: a path on the app's own origin. URL parsers drop
/// tabs and newlines and read a backslash as a slash, so "/\t/evil.example"
/// would lead off-site: any control character, space or backslash is
/// refused, and the path must still resolve to the same origin.
fn is_local_path(path: &str) -> bool {
    if utf16_len(path) > 2048 || !path.starts_with('/') || path.starts_with("//") {
        return false;
    }
    if path.chars().any(|c| c <= '\u{20}' || c == '\u{7f}' || c == '\\') {
        return false;
    }
    // After the checks above the path cannot fail to resolve; were it to,
    // `new URL` would throw where this answers no.
    let base = Url::parse("https://app.invalid").expect("a constant URL");
    base.join(path).is_ok_and(|url| url.origin().ascii_serialization() == "https://app.invalid")
}

/// `timingSafeEqual` over the SHA-256 digests of both strings.
fn same_digest(a: &str, b: &str) -> bool {
    Sha256::digest(a.as_bytes()).as_slice().ct_eq(Sha256::digest(b.as_bytes()).as_slice()).into()
}

/// `randomBytes(32).toString("base64url")`.
fn random() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `encodeURIComponent(s).replace(/%20/g, "+")`.
fn form_encode(s: &str) -> String {
    encode_uri_component(s).replace("%20", "+")
}

/// `errorCode(answer, res)`: the provider's error code when it is safe to
/// show (`/^[\w.-]{1,64}$/`, where `\w` is ASCII only), else the status.
fn error_code(answer: &Json, status: u16) -> String {
    match answer.get("error") {
        Some(Value::String(code))
            if (1..=64).contains(&code.len())
                && code.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-')) =>
        {
            code.clone()
        }
        _ => status.to_string(),
    }
}

/// `Number.isSafeInteger(n)`.
fn is_safe_integer(n: f64) -> bool {
    n.is_finite() && n == n.trunc() && n.abs() <= 9_007_199_254_740_991.0
}

/// `url.searchParams.set(name, value)` for each parameter: the first
/// parameter of that name takes the value and later ones are removed, or the
/// parameter is appended. The whole query is then written again in
/// application/x-www-form-urlencoded form, as the URL standard has it.
fn set_search_params(url: &mut Url, params: &[(&str, String)]) {
    let mut list: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    for (name, value) in params {
        match list.iter().position(|(key, _)| key == name) {
            Some(first) => {
                list[first].1.clone_from(value);
                let mut index = 0;
                list.retain(|(key, _)| {
                    index += 1;
                    index - 1 <= first || key != name
                });
            }
            None => list.push(((*name).to_string(), value.clone())),
        }
    }
    url.query_pairs_mut().clear().extend_pairs(list);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(issuer: &str, back_channel_url: Option<&str>) -> AuthClient {
        AuthClient::with_clock(
            AuthClientOptions {
                issuer: issuer.into(),
                back_channel_url: back_channel_url.map(str::to_string),
                client_id: "doc".into(),
                redirect_uri: "https://doc.example.test/callback".into(),
                ..AuthClientOptions::default()
            },
            || 0.0,
        )
        .unwrap()
    }

    /// `fixtures/gen-auth-client.ts` records what `Buffer.from(input, "base64url")` gives in Bun.
    #[test]
    fn base64url_is_decoded_as_bun_decodes_it() {
        let fixture = parse_json(include_bytes!("../tests/fixtures/auth-client.json")).unwrap();
        let cases = fixture["base64url"].as_array().unwrap();
        assert!(cases.len() > 25);
        for case in cases {
            let hex: String = decode_base64url(case["input"].as_str().unwrap()).iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(hex, case["hex"].as_str().unwrap(), "{}", case["input"]);
        }
    }

    #[test]
    fn only_endpoints_under_the_issuer_use_the_back_channel() {
        let with = client("https://auth.example.test/", Some("http://auth.internal:4000/base//"));
        let via = |endpoint: &str| with.inner.via_back_channel(endpoint);
        assert_eq!(via("https://auth.example.test"), "http://auth.internal:4000/base");
        assert_eq!(via("https://auth.example.test/"), "http://auth.internal:4000/base/");
        assert_eq!(via("https://auth.example.test/oauth/token?x=1"), "http://auth.internal:4000/base/oauth/token?x=1");
        // A longer host that merely starts with the issuer is somewhere else.
        assert_eq!(via("https://auth.example.testing/oauth/token"), "https://auth.example.testing/oauth/token");
        assert_eq!(via("https://auth.example.test:8443/oauth/token"), "https://auth.example.test:8443/oauth/token");
        assert_eq!(via("https://other.example.test/oauth/token"), "https://other.example.test/oauth/token");
        assert_eq!(via("HTTPS://auth.example.test/oauth/token"), "HTTPS://auth.example.test/oauth/token");
        assert_eq!(via(""), "");
        let without = client("https://auth.example.test", None);
        assert_eq!(without.inner.via_back_channel("https://auth.example.test/oauth/token"), "https://auth.example.test/oauth/token");
    }

    /// The bytes, and the code points `Buffer.toString("utf8")` gives for them in Bun.
    #[test]
    fn invalid_utf8_is_replaced_as_bun_replaces_it() {
        let bytes = [
            0x61, 0xff, 0x62, 0xc3, 0x63, 0xe2, 0x82, 0x64, 0xf0, 0x9f, 0x98, 0x65, 0xed, 0xa0, 0x80, 0x66, 0xf8, 0x88, 0x80, 0x80, 0x80,
            0x67, 0xc0, 0xaf, 0x68, 0xe0, 0x80, 0xaf, 0x69, 0xf4, 0x90, 0x80, 0x80,
        ];
        let expected = "61 fffd 62 fffd 63 fffd 64 fffd 65 fffd fffd fffd 66 fffd fffd fffd fffd fffd 67 fffd fffd 68 fffd fffd fffd 69 fffd fffd fffd fffd";
        let found: Vec<String> = String::from_utf8_lossy(&bytes).chars().map(|c| format!("{:x}", c as u32)).collect();
        assert_eq!(found.join(" "), expected);
    }

    #[test]
    fn small_helpers() {
        assert_eq!(form_encode("a b+c/é*~'()!"), "a+b%2Bc%2F%C3%A9*~'()!");
        assert!(is_safe_integer(-0.0) && is_safe_integer(9_007_199_254_740_991.0));
        assert!(!is_safe_integer(9_007_199_254_740_992.0) && !is_safe_integer(0.5) && !is_safe_integer(f64::NAN));
        assert!(same_digest("a", "a") && !same_digest("a", "b") && !same_digest("", "a"));
        assert_eq!(read_cookie(Some("a=b; __Host-login = x=y ; __Host-login=z"), LOGIN_COOKIE), Some("x=y"));
        assert_eq!(read_cookie(Some("=x; __Host-login"), LOGIN_COOKIE), None);
        assert_eq!(read_cookie(None, LOGIN_COOKIE), None);
        assert_eq!(random().len(), 43);
        assert_ne!(random(), random());
    }
}
