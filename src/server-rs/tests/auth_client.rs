//! Holds the Rust OpenID Connect client to the TypeScript one.
//!
//! Two kinds of tests, both against a stand-in provider: a small HTTP server
//! on localhost that answers from a table or a closure and records every
//! request it receives.
//!
//! - The replays run the scenarios of `fixtures/auth-client.json`, which
//!   `fixtures/gen-auth-client.ts` wrote by running the real `createAuthClient`
//!   with the same keys, clock and provider answers. Every result (the value,
//!   or the error's class and message) and every request must be the same.
//! - The rest covers what an injected `fetch` cannot show: real timeouts,
//!   redirects, credentials in URLs, a client without a back channel, callers
//!   that go away midway, and the sign-in scenarios of
//!   `src/server/routes/sso.test.ts` that concern this client, end to end.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use doc_server::auth_client::{AuthClient, AuthClientOptions, AuthError, AuthEvent, Login, Refreshed, StartLoginOptions};
use doc_server::jsutil::parse_json;
use ed25519_dalek::{Signer, SigningKey};
use futures_util::future::join_all;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

// ---------------------------------------------------------------------------
// The stand-in provider

#[derive(Clone, Copy, Default, PartialEq)]
enum Mode {
    #[default]
    Answer,
    /// Close the connection without answering.
    Fail,
    /// Keep the connection open and never answer.
    Silent,
    /// Send the headers and half the body, then nothing.
    StallBody,
    /// Answer after this many milliseconds.
    Slow(u64),
}

#[derive(Clone, Default)]
struct Canned {
    status: u16,
    body: Vec<u8>,
    location: Option<String>,
    mode: Mode,
}

fn answer(status: u16, body: Value) -> Canned {
    Canned { status, body: body.to_string().into_bytes(), ..Canned::default() }
}

fn not_found() -> Canned {
    answer(404, json!({ "error": "not_found" }))
}

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    /// The request target: path and query.
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Seen {
    /// The header's value; there must be at most one.
    fn header(&self, name: &str) -> Option<&str> {
        let mut values = self.headers.iter().filter(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str());
        let first = values.next();
        assert!(values.next().is_none(), "{name} sent more than once");
        first
    }

    fn form(&self, name: &str) -> Option<String> {
        url::form_urlencoded::parse(self.body.as_bytes()).find(|(key, _)| key == name).map(|(_, value)| value.into_owned())
    }
}

type Handler = Arc<dyn Fn(&Seen) -> Canned + Send + Sync>;

struct Provider {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    handler: Arc<Mutex<Handler>>,
}

async fn read_request(socket: &mut TcpStream) -> Option<Seen> {
    let mut buffer = Vec::new();
    let head_end = loop {
        if let Some(at) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        let mut chunk = [0u8; 4096];
        match socket.read(&mut chunk).await {
            Ok(n) if n > 0 => buffer.extend_from_slice(&chunk[..n]),
            _ => return None,
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let (method, path) = (request_line.next()?.to_string(), request_line.next()?.to_string());
    let headers: Vec<(String, String)> =
        lines.filter_map(|line| line.split_once(':')).map(|(key, value)| (key.trim().to_string(), value.trim().to_string())).collect();
    let length = headers.iter().find(|(key, _)| key.eq_ignore_ascii_case("content-length")).map_or(0, |(_, v)| v.parse().unwrap());
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        let mut chunk = [0u8; 4096];
        match socket.read(&mut chunk).await {
            Ok(n) if n > 0 => body.extend_from_slice(&chunk[..n]),
            _ => return None,
        }
    }
    Some(Seen { method, path, headers, body: String::from_utf8_lossy(&body).into_owned() })
}

async fn serve(mut socket: TcpStream, seen: Arc<Mutex<Vec<Seen>>>, handler: Arc<Mutex<Handler>>) {
    let Some(request) = read_request(&mut socket).await else { return };
    seen.lock().unwrap().push(request.clone());
    let handler = handler.lock().unwrap().clone();
    let canned = handler(&request);
    match canned.mode {
        Mode::Fail => return,
        Mode::Silent => return tokio::time::sleep(Duration::from_secs(60)).await,
        Mode::Slow(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
        Mode::Answer | Mode::StallBody => {}
    }
    // One request per connection, so the client never retries on a reused one.
    let mut head = format!("HTTP/1.1 {} Answer\r\nConnection: close\r\n", canned.status);
    if let Some(location) = &canned.location {
        head.push_str(&format!("Location: {location}\r\n"));
    }
    if canned.status != 204 && canned.status != 304 {
        head.push_str(&format!("Content-Length: {}\r\n", canned.body.len()));
    }
    head.push_str("\r\n");
    let _ = socket.write_all(head.as_bytes()).await;
    if canned.mode == Mode::StallBody {
        let _ = socket.write_all(&canned.body[..canned.body.len() / 2]).await;
        let _ = socket.flush().await;
        return tokio::time::sleep(Duration::from_secs(60)).await;
    }
    if canned.status != 204 && canned.status != 304 {
        let _ = socket.write_all(&canned.body).await;
    }
    let _ = socket.shutdown().await;
}

impl Provider {
    async fn start() -> Provider {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Mutex<Handler>> = Arc::new(Mutex::new(Arc::new(|_: &Seen| not_found())));
        let (seen_by_server, handler_of_server) = (seen.clone(), handler.clone());
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                tokio::spawn(serve(socket, seen_by_server.clone(), handler_of_server.clone()));
            }
        });
        Provider { base, seen, handler }
    }

    fn handle(&self, handler: impl Fn(&Seen) -> Canned + Send + Sync + 'static) {
        *self.handler.lock().unwrap() = Arc::new(handler);
    }

    /// The requests received since the last call.
    fn take(&self) -> Vec<Seen> {
        std::mem::take(&mut *self.seen.lock().unwrap())
    }

    fn count(&self, path: &str) -> usize {
        self.seen.lock().unwrap().iter().filter(|seen| seen.path == path).count()
    }
}

// ---------------------------------------------------------------------------
// Keys and tokens

const ISSUER: &str = "https://auth.example.test";

fn fixture() -> &'static Value {
    static FIXTURE: OnceLock<Value> = OnceLock::new();
    FIXTURE.get_or_init(|| parse_json(include_bytes!("fixtures/auth-client.json")).expect("auth-client.json"))
}

/// A key of the fixture: `k1`, `k2` or `stranger`.
fn key(name: &str) -> SigningKey {
    let seed: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&fixture()["seeds"][name].as_str().unwrap()[i * 2..i * 2 + 2], 16).unwrap()).collect();
    SigningKey::from_bytes(&seed.try_into().unwrap())
}

fn jwk(kid: &str, key: &SigningKey) -> Value {
    json!({ "kty": "OKP", "crv": "Ed25519", "x": URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()), "kid": kid, "alg": "EdDSA", "use": "sig" })
}

fn jwt(header: Value, payload: Value, key: &SigningKey) -> String {
    let signed = format!("{}.{}", URL_SAFE_NO_PAD.encode(header.to_string()), URL_SAFE_NO_PAD.encode(payload.to_string()));
    format!("{signed}.{}", URL_SAFE_NO_PAD.encode(key.sign(signed.as_bytes()).to_bytes()))
}

fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

#[derive(Clone)]
struct Person {
    sub: &'static str,
    username: &'static str,
    name: &'static str,
    role: &'static str,
    /// `None` leaves the email claims out of the ID token.
    email: Option<&'static str>,
    email_verified: bool,
}

fn person(sub: &'static str, username: &'static str) -> Person {
    Person { sub, username, name: username, role: "member", email: Some("someone@example.com"), email_verified: true }
}

fn access_token(issuer: &str, p: &Person) -> String {
    jwt(
        json!({ "alg": "EdDSA", "typ": "at+jwt", "kid": "k1" }),
        json!({ "iss": issuer, "sub": p.sub, "aud": "doc", "iat": now_s(), "exp": now_s() + 600, "sid": format!("ses_{}", p.username),
            "username": p.username, "name": p.name, "role": p.role }),
        &key("k1"),
    )
}

fn id_token(issuer: &str, p: &Person, nonce: &str) -> String {
    let mut claims = json!({ "iss": issuer, "sub": p.sub, "aud": "doc", "iat": now_s(), "exp": now_s() + 600, "nonce": nonce, "auth_time": now_s() });
    if let Some(email) = p.email {
        claims["email"] = json!(email);
        claims["email_verified"] = json!(p.email_verified);
    }
    jwt(json!({ "alg": "EdDSA", "typ": "JWT", "kid": "k1" }), claims, &key("k1"))
}

fn event_token(events: Value, key: &SigningKey) -> String {
    jwt(
        json!({ "alg": "EdDSA", "typ": "secevent+jwt", "kid": "k1" }),
        json!({ "iss": ISSUER, "aud": "doc", "iat": now_s(), "jti": "evt_1", "events": events }),
        key,
    )
}

// ---------------------------------------------------------------------------
// Replaying the fixture

fn error_json(error: &AuthError) -> Value {
    let class = match error {
        AuthError::InvalidGrant(_) => "InvalidGrant",
        AuthError::Unavailable(_) => "Unavailable",
        AuthError::InvalidToken(_) => "InvalidToken",
        AuthError::Login { .. } => "LoginError",
        AuthError::Other(_) => "Other",
    };
    let mut out = json!({ "class": class, "message": error.message() });
    if let AuthError::Login { code, error } = error {
        out["code"] = json!(code);
        out["error"] = json!(error);
    }
    assert_eq!(error.to_string(), error.message());
    out
}

fn claims_json(claims: &doc_server::auth_client::AccessClaims) -> Value {
    for (typed, name) in [(&claims.sub, "sub"), (&claims.sid, "sid"), (&claims.username, "username"), (&claims.name, "name"), (&claims.role, "role")] {
        assert_eq!(claims.all[name], json!(typed));
    }
    Value::Object(claims.all.clone())
}

fn login_json(login: Login) -> Value {
    assert_eq!(login.id_claims.email.as_ref(), login.id_claims.all.get("email"));
    assert_eq!(login.id_claims.email_verified.as_ref(), login.id_claims.all.get("email_verified"));
    let mut out = json!({ "claims": claims_json(&login.claims), "idClaims": login.id_claims.all, "accessToken": login.access_token,
        "returnTo": login.return_to, "clearCookie": login.clear_cookie });
    if let Some(token) = login.refresh_token {
        out["refreshToken"] = json!(token);
    }
    out
}

fn refreshed_json(refreshed: Refreshed) -> Value {
    let mut out = json!({ "claims": claims_json(&refreshed.claims), "accessToken": refreshed.access_token });
    if let Some(token) = refreshed.refresh_token {
        out["refreshToken"] = json!(token);
    }
    out
}

fn event_json(event: AuthEvent) -> Value {
    let mut out = json!({ "type": event.type_, "jti": event.jti });
    for (name, value) in [("sub", event.sub), ("sid", event.sid), ("id", event.id), ("invite", event.invite)] {
        if let Some(value) = value {
            out[name] = json!(value);
        }
    }
    if let Some(role) = event.role {
        out["role"] = json!(role);
    }
    out
}

/// One call of the fixture, with its result in the fixture's shape.
async fn run(client: &AuthClient, call: &Value) -> Value {
    let arg = call["args"].get(0);
    let text = || arg.and_then(Value::as_str).unwrap();
    let outcome = match call["method"].as_str().unwrap() {
        "startLogin" => {
            let get = |name: &str| arg.and_then(|options| options.get(name));
            let options = StartLoginOptions {
                return_to: get("returnTo").map(|v| v.as_str().unwrap().to_string()),
                max_age: get("maxAge").map(|v| v.as_f64().unwrap()),
                prompt: get("prompt").map(|v| v.as_str().unwrap().to_string()),
                login_hint: get("loginHint").map(|v| v.as_str().unwrap().to_string()),
            };
            client.start_login(options).await.map(|s| json!({ "redirectUrl": s.redirect_url, "loginCookie": s.login_cookie }))
        }
        "finishLogin" => {
            let url = Url::parse(arg.unwrap()["url"].as_str().unwrap()).unwrap();
            let query: Vec<(String, String)> = url.query_pairs().into_owned().collect();
            client.finish_login(arg.unwrap()["cookie"].as_str(), &query).await.map(login_json)
        }
        "refresh" => client.refresh(text()).await.map(refreshed_json),
        "revoke" => client.revoke(text()).await.map(|()| Value::Null),
        "readEvent" => client.read_event(text()).await.map(event_json),
        "logoutUrl" => client.logout_url(arg.and_then(Value::as_str)).await.map(Value::String),
        other => panic!("unknown method {other}"),
    };
    match outcome {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "error": error_json(&error) }),
    }
}

/// A started login with its random values replaced by their names, after
/// checking that they are 32 random bytes each and that the challenge is the
/// verifier's digest. What is left must be the same text in both languages.
fn without_randomness(started: &Value) -> Value {
    let (url, cookie) = (started["redirectUrl"].as_str().unwrap(), started["loginCookie"].as_str().unwrap());
    let (value, attributes) = cookie.strip_prefix("__Host-login=").unwrap().split_once(';').unwrap();
    let saved_text = String::from_utf8(URL_SAFE_NO_PAD.decode(value).unwrap()).unwrap();
    let saved: Value = serde_json::from_str(&saved_text).unwrap();
    let (mut url, mut saved_text) = (url.to_string(), saved_text.clone());
    for name in ["state", "nonce", "verifier"] {
        let random = saved[name].as_str().unwrap();
        assert_eq!(URL_SAFE_NO_PAD.decode(random).unwrap().len(), 32, "{name}");
        saved_text = saved_text.replace(random, &format!("<{name}>"));
        if name == "verifier" {
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(random.as_bytes()));
            assert!(url.contains(&format!("code_challenge={challenge}&")), "the challenge is the verifier's digest");
            assert!(!url.contains(random), "the verifier stays in the cookie");
            url = url.replace(&challenge, "<challenge>");
        } else {
            assert!(url.contains(&format!("{name}={random}&")), "{name} is in the URL");
            url = url.replace(random, &format!("<{name}>"));
        }
    }
    json!({ "url": url, "cookie": saved_text, "attributes": attributes })
}

async fn replay(scenario: &Value) {
    let name = scenario["name"].as_str().unwrap();
    let provider = Provider::start().await;
    let base = provider.base.clone();
    let here = move |text: &str| text.replace("http://backchannel.test", &base).replace("http://other.test", &base);
    let options = &scenario["options"];
    let option = |name: &str| options.get(name).map(|v| v.as_str().unwrap().to_string());
    let clock = Arc::new(AtomicU64::new(0));
    let now = clock.clone();
    let client = AuthClient::with_clock(
        AuthClientOptions {
            issuer: option("issuer").unwrap(),
            back_channel_url: option("backChannelUrl").map(|url| here(&url)),
            client_id: option("clientId").unwrap(),
            client_secret: option("clientSecret"),
            redirect_uri: option("redirectUri").unwrap(),
            audience: option("audience"),
        },
        move || now.load(Ordering::SeqCst) as f64,
    )
    .unwrap();

    let table: Arc<Mutex<HashMap<String, Canned>>> = Arc::default();
    let answers = table.clone();
    provider.handle(move |seen| answers.lock().unwrap().get(&format!("{} {}", seen.method, seen.path)).cloned().unwrap_or_else(not_found));
    let path_of = |url: &str| here(url).strip_prefix(&provider.base).unwrap_or_else(|| panic!("{name}: {url} is not the provider's")).to_string();
    let set_routes = |routes: &Value| {
        for (route, canned) in routes.as_object().unwrap() {
            let (method, url) = route.split_once(' ').unwrap();
            let body = match (canned.get("hex"), canned.get("body")) {
                (Some(hex), _) => {
                    let hex = hex.as_str().unwrap();
                    (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap()).collect()
                }
                (None, Some(body)) => here(body.as_str().unwrap()).into_bytes(),
                (None, None) => Vec::new(),
            };
            let canned = Canned {
                status: canned.get("status").map_or(200, |s| s.as_u64().unwrap() as u16),
                body,
                mode: if canned.get("fail").is_some() { Mode::Fail } else { Mode::Answer },
                ..Canned::default()
            };
            table.lock().unwrap().insert(format!("{method} {}", path_of(url)), canned);
        }
    };
    set_routes(&scenario["routes"]);

    for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
        let at = format!("{name}, step {}", index + 1);
        clock.store(step["now"].as_u64().unwrap(), Ordering::SeqCst);
        set_routes(&step["routes"]);
        provider.take();
        let calls = step["calls"].as_array().unwrap();
        let results = join_all(calls.iter().map(|call| run(&client, call))).await;
        for ((call, result), expected) in calls.iter().zip(&results).zip(step["results"].as_array().unwrap()) {
            if call["method"] == "startLogin" && expected.get("ok").is_some() && result.get("ok").is_some() {
                assert_eq!(without_randomness(&result["ok"]), without_randomness(&expected["ok"]), "{at}: {call}");
            } else {
                assert_eq!(result, expected, "{at}: {call}");
            }
        }
        let mut expected: Vec<String> = step["requests"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| json!([r["method"], path_of(r["url"].as_str().unwrap()), r["accept"], r["contentType"], r["authorization"], r["body"]]).to_string())
            .collect();
        let mut seen: Vec<String> = provider
            .take()
            .iter()
            .map(|s| json!([s.method, s.path, s.header("accept"), s.header("content-type"), s.header("authorization"), s.body]).to_string())
            .collect();
        // Calls made at once reach the provider in no particular order.
        if calls.len() > 1 {
            expected.sort();
            seen.sort();
        }
        assert_eq!(seen, expected, "{at}: the requests the provider received");
    }
}

const GROUPS: [&str; 9] =
    ["discovery:", "logout URL:", "start login:", "token endpoint:", "tokens:", "keys:", "finish login:", "revoke:", "events:"];

async fn replay_group(prefix: &str) {
    let scenarios: Vec<&Value> =
        fixture()["scenarios"].as_array().unwrap().iter().filter(|s| s["name"].as_str().unwrap().starts_with(prefix)).collect();
    assert!(!scenarios.is_empty());
    for scenario in scenarios {
        replay(scenario).await;
    }
}

#[tokio::test]
async fn replays_discovery() {
    replay_group("discovery:").await;
}

#[tokio::test]
async fn replays_the_logout_url() {
    replay_group("logout URL:").await;
}

#[tokio::test]
async fn replays_starting_a_login() {
    replay_group("start login:").await;
}

#[tokio::test]
async fn replays_the_token_endpoint() {
    replay_group("token endpoint:").await;
}

#[tokio::test]
async fn replays_token_verification() {
    replay_group("tokens:").await;
}

#[tokio::test]
async fn replays_the_key_set() {
    replay_group("keys:").await;
}

#[tokio::test]
async fn replays_finishing_a_login() {
    replay_group("finish login:").await;
}

#[tokio::test]
async fn replays_revocation() {
    replay_group("revoke:").await;
}

#[tokio::test]
async fn replays_events() {
    replay_group("events:").await;
}

#[test]
fn every_scenario_is_replayed() {
    let scenarios = fixture()["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 90);
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        assert_eq!(GROUPS.iter().filter(|prefix| name.starts_with(**prefix)).count(), 1, "{name}");
    }
    // The names `readEvent` trips over are the ones this engine's objects inherit.
    assert_eq!(fixture()["inheritedNames"].as_array().unwrap().len(), 12);
}

#[test]
fn options_are_checked_as_in_typescript() {
    let cases = fixture()["options"].as_array().unwrap();
    assert!(cases.len() >= 50);
    for case in cases {
        let option = |name: &str| case["options"].get(name).map(|v| v.as_str().unwrap().to_string());
        let options = AuthClientOptions {
            issuer: option("issuer").unwrap(),
            back_channel_url: option("backChannelUrl"),
            client_id: option("clientId").unwrap(),
            client_secret: option("clientSecret"),
            redirect_uri: option("redirectUri").unwrap(),
            audience: option("audience"),
        };
        let error = AuthClient::with_clock(options.clone(), || 0.0).err();
        assert_eq!(json!(error), case["error"], "{}", case["options"]);
        assert_eq!(AuthClient::new(options).err(), error);
    }
}

// ---------------------------------------------------------------------------
// Beyond the fixture

fn options(back_channel: &str) -> AuthClientOptions {
    AuthClientOptions {
        issuer: ISSUER.into(),
        back_channel_url: Some(back_channel.into()),
        client_id: "doc".into(),
        client_secret: Some("s3cret".into()),
        redirect_uri: "http://doc.test/api/auth/callback".into(),
        audience: None,
    }
}

fn discovery(issuer: &str) -> Value {
    json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}/oauth/authorize"),
        "token_endpoint": format!("{issuer}/oauth/token"),
        "revocation_endpoint": format!("{issuer}/oauth/revoke"),
        "jwks_uri": format!("{issuer}/.well-known/jwks.json"),
        "end_session_endpoint": format!("{issuer}/logout"),
    })
}

type TokenEndpoint = Arc<Mutex<Box<dyn Fn(&Seen) -> Canned + Send + Sync>>>;

/// The stand-in of `routes/sso.test.ts`: discovery, keys, token, revocation.
struct World {
    provider: Provider,
    client: AuthClient,
    issuer: String,
    token: TokenEndpoint,
    keys_down: Arc<AtomicBool>,
}

impl World {
    /// Without a back channel the issuer is the provider's own address.
    async fn start(with_back_channel: bool) -> World {
        let provider = Provider::start().await;
        let issuer = if with_back_channel { ISSUER.to_string() } else { provider.base.clone() };
        let token: TokenEndpoint = Arc::new(Mutex::new(Box::new(|_: &Seen| answer(500, json!({})))));
        let keys_down = Arc::new(AtomicBool::new(false));
        let (token_now, down, issuer_of_doc) = (token.clone(), keys_down.clone(), issuer.clone());
        provider.handle(move |seen| match seen.path.as_str() {
            "/.well-known/openid-configuration" => answer(200, discovery(&issuer_of_doc)),
            "/.well-known/jwks.json" if down.load(Ordering::SeqCst) => answer(503, json!({})),
            "/.well-known/jwks.json" => answer(200, json!({ "keys": [jwk("k1", &key("k1"))] })),
            "/oauth/token" => (token_now.lock().unwrap())(seen),
            "/oauth/revoke" => Canned { status: 200, ..Canned::default() },
            _ => not_found(),
        });
        let client = World::client(&provider, &issuer, with_back_channel);
        World { provider, client, issuer, token, keys_down }
    }

    /// A client of its own: no discovery document, no keys.
    fn client(provider: &Provider, issuer: &str, with_back_channel: bool) -> AuthClient {
        AuthClient::new(AuthClientOptions {
            issuer: issuer.to_string(),
            back_channel_url: with_back_channel.then(|| provider.base.clone()),
            ..options("")
        })
        .unwrap()
    }

    fn token(&self, handler: impl Fn(&Seen) -> Canned + Send + Sync + 'static) {
        *self.token.lock().unwrap() = Box::new(handler);
    }

    /// Answers refreshes as the provider would for this person now.
    fn refreshes_as(&self, p: Person) {
        let issuer = self.issuer.clone();
        self.token(move |seen| {
            if seen.form("grant_type").as_deref() == Some("refresh_token") && seen.form("refresh_token") == Some(format!("rt_{}", p.username)) {
                answer(200, json!({ "access_token": access_token(&issuer, &p), "token_type": "Bearer", "expires_in": 600 }))
            } else {
                answer(400, json!({ "error": "invalid_grant" }))
            }
        });
    }

    /// Signs in as `p`: the login redirect, then the callback, with a
    /// provider that checks the code and its PKCE verifier.
    async fn sign_in(&self, p: Person, return_to: &str) -> Result<Login, AuthError> {
        let started = self.client.start_login(StartLoginOptions { return_to: Some(return_to.into()), ..Default::default() }).await?;
        let authorize = Url::parse(&started.redirect_url).unwrap();
        let param = |name: &str| authorize.query_pairs().find(|(key, _)| key == name).unwrap().1.into_owned();
        let (challenge, nonce, issuer) = (param("code_challenge"), param("nonce"), self.issuer.clone());
        self.token(move |seen| {
            let verified = URL_SAFE_NO_PAD.encode(Sha256::digest(seen.form("code_verifier").unwrap_or_default().as_bytes())) == challenge;
            if seen.form("code").as_deref() != Some("c0de") || !verified {
                return answer(400, json!({ "error": "invalid_grant" }));
            }
            answer(
                200,
                json!({ "access_token": access_token(&issuer, &p), "id_token": id_token(&issuer, &p, &nonce),
                    "refresh_token": format!("rt_{}", p.username), "token_type": "Bearer", "expires_in": 600 }),
            )
        });
        let cookie = started.login_cookie.split(';').next().unwrap().to_string();
        self.client.finish_login(Some(&cookie), &[("code".into(), "c0de".into()), ("state".into(), param("state"))]).await
    }
}

fn alice() -> Person {
    Person { name: "Alice", role: "owner", email: Some("alice@example.com"), ..person("usr_alice", "alice") }
}

#[tokio::test]
async fn signs_in_through_the_provider() {
    let world = World::start(true).await;
    // The login route sends the browser to the provider with a login cookie.
    let started = world.client.start_login(StartLoginOptions { return_to: Some("/s/general".into()), ..Default::default() }).await.unwrap();
    let location = Url::parse(&started.redirect_url).unwrap();
    assert_eq!(format!("{}{}", location.origin().ascii_serialization(), location.path()), format!("{ISSUER}/oauth/authorize"));
    let param = |name: &str| location.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned());
    assert_eq!(param("client_id").as_deref(), Some("doc"));
    assert_eq!(param("redirect_uri").as_deref(), Some("http://doc.test/api/auth/callback"));
    let (value, attributes) = started.login_cookie.strip_prefix("__Host-login=").unwrap().split_once(';').unwrap();
    assert!(!value.is_empty() && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    assert_eq!(attributes, " Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300");

    // The first sign-in: the provider's claims, its refresh token, the return path, and the cookie's deletion.
    let login = world.sign_in(alice(), "/s/general").await.unwrap();
    assert_eq!(login.return_to, "/s/general");
    assert_eq!(login.clear_cookie, "__Host-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
    assert_eq!((login.claims.sub.as_str(), login.claims.sid.as_str()), ("usr_alice", "ses_alice"));
    assert_eq!((login.claims.username.as_str(), login.claims.name.as_str(), login.claims.role.as_str()), ("alice", "Alice", "owner"));
    assert_eq!(login.refresh_token.as_deref(), Some("rt_alice"));
    assert_eq!(login.id_claims.email, Some(json!("alice@example.com")));
    assert_eq!(login.id_claims.email_verified, Some(json!(true)));
    // The exact token request: Basic client authentication and a form body.
    let seen = world.provider.take();
    let token = seen.iter().find(|s| s.path == "/oauth/token").unwrap();
    assert_eq!((token.method.as_str(), token.header("authorization")), ("POST", Some("Basic ZG9jOnMzY3JldA==")));
    assert_eq!((token.header("content-type"), token.header("accept")), (Some("application/x-www-form-urlencoded"), Some("application/json")));
    assert!(token.body.starts_with("grant_type=authorization_code&code=c0de&redirect_uri=http%3A%2F%2Fdoc.test%2Fapi%2Fauth%2Fcallback&code_verifier="));
    // Discovery and the keys were fetched once for both sign-in steps.
    assert_eq!(seen.iter().filter(|s| s.path.starts_with("/.well-known/")).count(), 2);

    // A return path that isn't local lands on the home page.
    assert_eq!(world.sign_in(alice(), "//evil.example/x").await.unwrap().return_to, "/");
    // A person without an email, and one whose email the provider didn't verify.
    let nomail = world.sign_in(Person { email: None, ..person("usr_noemail", "nomail") }, "/").await.unwrap();
    assert_eq!((nomail.id_claims.email, nomail.id_claims.email_verified), (None, None));
    let unverified = world.sign_in(Person { email_verified: false, ..person("usr_bob", "bob") }, "/").await.unwrap();
    assert_eq!(unverified.id_claims.email_verified, Some(json!(false)));

    // A callback the provider didn't start, or that it refused.
    let query = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
    let forged = world.client.finish_login(None, &query(&[("code", "c0de"), ("state", "x")])).await.unwrap_err();
    assert_eq!(forged, AuthError::Login { code: "no_login_cookie", error: None });
    let started = world.client.start_login(StartLoginOptions::default()).await.unwrap();
    let cookie = started.login_cookie.split(';').next().unwrap();
    let denied = world.client.finish_login(Some(cookie), &query(&[("error", "access_denied"), ("state", "x")])).await.unwrap_err();
    assert_eq!(denied, AuthError::Login { code: "authorization_error", error: Some("access_denied".into()) });
    assert_eq!(denied.message(), "authorization_error: access_denied");
    // A code the provider refuses, and a verifier that isn't the challenge's.
    let state = Url::parse(&started.redirect_url).unwrap().query_pairs().find(|(k, _)| k == "state").unwrap().1.into_owned();
    world.token(|_| answer(400, json!({ "error": "invalid_grant" })));
    let refused = world.client.finish_login(Some(cookie), &query(&[("code", "other"), ("state", &state)])).await.unwrap_err();
    assert_eq!(refused, AuthError::InvalidGrant("the provider refused the grant".into()));
}

#[tokio::test]
async fn rechecks_access_with_the_refresh_token() {
    let world = World::start(true).await;
    world.refreshes_as(Person { name: "Carol C", role: "admin", ..person("usr_carol", "carol") });
    let refreshed = world.client.refresh("rt_carol").await.unwrap();
    assert_eq!((refreshed.claims.name.as_str(), refreshed.claims.role.as_str()), ("Carol C", "admin"));
    assert_eq!(refreshed.refresh_token, None);
    let seen = world.provider.take();
    assert_eq!(seen.iter().map(|s| s.path.as_str()).collect::<Vec<_>>(), ["/.well-known/openid-configuration", "/oauth/token", "/.well-known/jwks.json"]);
    assert_eq!(seen[1].body, "grant_type=refresh_token&refresh_token=rt_carol");
    // The provider is unreachable, refuses the token, or names someone else (the caller compares subjects).
    world.token(|_| answer(503, json!({ "error": "temporarily_unavailable" })));
    assert_eq!(world.client.refresh("rt_carol").await.unwrap_err(), AuthError::Unavailable("auth answered 503".into()));
    world.token(|_| answer(400, json!({ "error": "invalid_grant" })));
    assert_eq!(world.client.refresh("rt_carol").await.unwrap_err(), AuthError::InvalidGrant("the provider refused the grant".into()));
    world.refreshes_as(Person { role: "owner", ..person("usr_mallory", "carol") });
    assert_eq!(world.client.refresh("rt_carol").await.unwrap().claims.sub, "usr_mallory");
    // Discovery and the keys were fetched once.
    assert_eq!(world.provider.take().iter().filter(|s| s.path.starts_with("/.well-known/")).count(), 0);
}

#[tokio::test]
async fn reads_the_providers_events() {
    let world = World::start(true).await;
    let k1 = key("k1");
    let read = |events: Value| {
        let token = event_token(events, &k1);
        let client = world.client.clone();
        async move { client.read_event(&token).await.unwrap() }
    };
    let ended = read(json!({ "session.ended": { "sid": "ses_hal_1" } })).await;
    assert_eq!((ended.type_.as_str(), ended.sid.as_deref(), ended.sub), ("session.ended", Some("ses_hal_1"), None));
    let changed = read(json!({ "access.changed": { "sub": "usr_ivy", "role": "admin" } })).await;
    assert_eq!((changed.sub.as_deref(), changed.role), (Some("usr_ivy"), Some(Some("admin".to_string()))));
    assert_eq!(read(json!({ "access.changed": { "sub": "usr_ivy", "role": null } })).await.role, Some(None));
    assert_eq!(read(json!({ "user.disabled": { "sub": "usr_jack" } })).await.sub.as_deref(), Some("usr_jack"));
    assert_eq!(read(json!({ "user.deleted": { "sub": "usr_kim" } })).await.role, None);
    let accepted = read(json!({ "invite.accepted": { "invite": "inv_1", "sub": "usr_zoe" } })).await;
    assert_eq!((accepted.invite.as_deref(), accepted.sub.as_deref(), accepted.jti.as_str()), (Some("inv_1"), Some("usr_zoe"), "evt_1"));
    assert_eq!(read(json!({ "something.new": {} })).await, AuthEvent { type_: "something.new".into(), jti: "evt_1".into(), ..Default::default() });

    // An event that doesn't verify is refused.
    let forged = event_token(json!({ "user.disabled": { "sub": "usr_alice" } }), &key("stranger"));
    assert_eq!(world.client.read_event(&forged).await.unwrap_err(), AuthError::InvalidToken("bad signature".into()));
    assert_eq!(world.client.read_event("not a token").await.unwrap_err(), AuthError::InvalidToken("not a JWT".into()));
    // One that can't be checked while the provider is unreachable is unavailable, so it is sent again.
    world.keys_down.store(true, Ordering::SeqCst);
    let fresh = World::client(&world.provider, ISSUER, true);
    let event = event_token(json!({ "user.disabled": { "sub": "usr_alice" } }), &k1);
    assert_eq!(fresh.read_event(&event).await.unwrap_err(), AuthError::Unavailable("auth's signing keys are unavailable".into()));
    world.keys_down.store(false, Ordering::SeqCst);
    // The failed attempt started the 30 s in which the keys are not asked for again.
    assert_eq!(fresh.read_event(&event).await.unwrap_err(), AuthError::Unavailable("auth's signing keys are unavailable".into()));
    assert_eq!(world.provider.count("/.well-known/jwks.json"), 2);
}

#[tokio::test]
async fn signs_out_at_the_provider() {
    let world = World::start(true).await;
    assert_eq!(
        world.client.logout_url(Some("http://doc.test/")).await.unwrap(),
        "https://auth.example.test/logout?client_id=doc&post_logout_redirect_uri=http%3A%2F%2Fdoc.test%2F"
    );
    assert_eq!(world.client.logout_url(None).await.unwrap(), "https://auth.example.test/logout?client_id=doc");
    world.provider.take();
    world.client.revoke("rt_alice").await.unwrap();
    let seen = world.provider.take();
    assert_eq!(seen.len(), 1);
    assert_eq!((seen[0].method.as_str(), seen[0].path.as_str()), ("POST", "/oauth/revoke"));
    assert_eq!(seen[0].body, "token=rt_alice&token_type_hint=refresh_token");
    assert_eq!(seen[0].header("authorization"), Some("Basic ZG9jOnMzY3JldA=="));
}

#[tokio::test]
async fn without_a_back_channel_the_issuer_is_called() {
    let world = World::start(false).await;
    let login = world.sign_in(alice(), "/x").await.unwrap();
    assert_eq!((login.claims.all["iss"].as_str(), login.return_to.as_str()), (Some(world.issuer.as_str()), "/x"));
    world.refreshes_as(alice());
    world.client.refresh("rt_alice").await.unwrap();
    world.client.revoke("rt_alice").await.unwrap();
    assert_eq!(world.client.logout_url(None).await.unwrap(), format!("{}/logout?client_id=doc", world.issuer));
    let paths: Vec<String> = world.provider.take().into_iter().map(|s| s.path).collect();
    assert_eq!(paths, ["/.well-known/openid-configuration", "/oauth/token", "/.well-known/jwks.json", "/oauth/token", "/oauth/revoke"]);
}

/// A provider that serves this discovery document and nothing else.
async fn provider_with(document: impl Fn(&str) -> Value) -> (Provider, AuthClient) {
    let provider = Provider::start().await;
    let body = document(&provider.base);
    provider.handle(move |seen| match seen.path.as_str() {
        "/.well-known/openid-configuration" => answer(200, body.clone()),
        "/oauth/revoke" | "/elsewhere" => Canned { status: 200, ..Canned::default() },
        _ => not_found(),
    });
    let client = AuthClient::new(AuthClientOptions { issuer: provider.base.clone(), back_channel_url: None, ..options("") }).unwrap();
    (provider, client)
}

#[tokio::test]
async fn a_revocation_endpoint_that_is_not_a_string_goes_to_fetch_as_it_is() {
    // Without a back channel the value reaches `fetch`, which reads an array
    // as its elements joined by commas and refuses anything else.
    let (provider, client) = provider_with(|base| {
        let mut doc = discovery(base);
        doc["revocation_endpoint"] = json!([format!("{base}/elsewhere")]);
        doc
    })
    .await;
    client.revoke("rt").await.unwrap();
    assert_eq!(provider.take().last().unwrap().path, "/elsewhere");
    for value in [json!(123), json!(true), json!({}), json!(["a", "b"])] {
        let (provider, client) = provider_with(move |base| {
            let mut doc = discovery(base);
            doc["revocation_endpoint"] = value.clone();
            doc
        })
        .await;
        assert_eq!(client.revoke("rt").await.unwrap_err(), AuthError::Unavailable("auth is unreachable".into()));
        assert_eq!(provider.take().len(), 1, "only discovery was asked");
    }
}

#[tokio::test]
async fn endpoints_that_fetch_refuses_are_unreachable() {
    for endpoint in ["nope", "/oauth/token", "ftp://127.0.0.1/token", "file:///etc/hostname", "http://127.0.0.1:99999/token", "http://127.0.0.1:1/token"] {
        let (_provider, client) = provider_with(move |base| {
            let mut doc = discovery(base);
            doc["token_endpoint"] = json!(endpoint);
            doc
        })
        .await;
        assert_eq!(client.refresh("rt").await.unwrap_err(), AuthError::Unavailable("auth is unreachable".into()), "{endpoint}");
    }
}

#[tokio::test]
async fn redirects_are_not_followed() {
    let provider = Provider::start().await;
    let base = provider.base.clone();
    provider.handle(move |seen| match seen.path.as_str() {
        "/.well-known/openid-configuration" => Canned { status: 302, location: Some("/moved".into()), ..Canned::default() },
        "/moved" => answer(200, discovery(&base)),
        _ => not_found(),
    });
    let client = AuthClient::new(AuthClientOptions { issuer: provider.base.clone(), back_channel_url: None, ..options("") }).unwrap();
    assert_eq!(client.logout_url(None).await.unwrap_err(), AuthError::Unavailable("discovery answered 302".into()));
    assert_eq!(provider.take().iter().map(|s| s.path.clone()).collect::<Vec<_>>(), ["/.well-known/openid-configuration"]);
}

#[tokio::test]
async fn a_call_times_out_after_five_seconds() {
    // No answer at all: unreachable.
    let silent = Provider::start().await;
    silent.handle(|_| Canned { mode: Mode::Silent, ..Canned::default() });
    let waiting = AuthClient::new(options(&silent.base)).unwrap();
    // Headers in time, then a body that never ends: the same deadline cuts the
    // reading short, which `readJson` reports as a malformed body.
    let stalled = Provider::start().await;
    stalled.handle(|_| Canned { mode: Mode::StallBody, ..answer(200, discovery(ISSUER)) });
    let reading = AuthClient::new(options(&stalled.base)).unwrap();
    // A slow answer within the deadline is fine.
    let slow = Provider::start().await;
    slow.handle(|_| Canned { mode: Mode::Slow(1500), ..answer(200, discovery(ISSUER)) });
    let patient = AuthClient::new(options(&slow.base)).unwrap();

    let started = Instant::now();
    let (unreachable, malformed, fine) = tokio::join!(waiting.logout_url(None), reading.logout_url(None), patient.logout_url(None));
    let elapsed = started.elapsed();
    assert_eq!(unreachable.unwrap_err(), AuthError::Unavailable("auth is unreachable".into()));
    assert_eq!(malformed.unwrap_err(), AuthError::Unavailable("auth answered 200 with a malformed body".into()));
    assert_eq!(fine.unwrap(), "https://auth.example.test/logout?client_id=doc");
    assert!(elapsed >= Duration::from_millis(4900) && elapsed < Duration::from_secs(9), "{elapsed:?}");
}

#[tokio::test]
async fn a_caller_that_goes_away_leaves_the_fetch_to_the_others() {
    let provider = Provider::start().await;
    provider.handle(|_| Canned { mode: Mode::Slow(300), ..answer(200, discovery(ISSUER)) });
    let client = AuthClient::new(options(&provider.base)).unwrap();
    // The first caller is dropped while discovery is in flight.
    assert!(tokio::time::timeout(Duration::from_millis(50), client.logout_url(None)).await.is_err());
    tokio::time::sleep(Duration::from_millis(100)).await;
    // The second joins the same fetch, which went on without the first.
    let started = Instant::now();
    assert_eq!(client.logout_url(None).await.unwrap(), "https://auth.example.test/logout?client_id=doc");
    assert!(started.elapsed() < Duration::from_millis(280), "{:?}", started.elapsed());
    assert_eq!(provider.count("/.well-known/openid-configuration"), 1);
}

#[tokio::test]
async fn credentials_in_a_url_are_sent_unless_the_request_has_its_own() {
    let world = World::start(true).await;
    let with_credentials = world.provider.base.replace("http://", "http://us%20er:p%40ss@");
    let client = AuthClient::new(options(&with_credentials)).unwrap();
    world.refreshes_as(alice());
    client.refresh("rt_alice").await.unwrap();
    let seen = world.provider.take();
    // As `fetch` does: Basic from the URL on the GETs, the client's own on the POST.
    assert_eq!(seen[0].header("authorization"), Some("Basic dXMgZXI6cEBzcw=="));
    assert_eq!((seen[1].path.as_str(), seen[1].header("authorization")), ("/oauth/token", Some("Basic ZG9jOnMzY3JldA==")));
    assert_eq!((seen[2].path.as_str(), seen[2].header("authorization")), ("/.well-known/jwks.json", Some("Basic dXMgZXI6cEBzcw==")));
}

/// JavaScript's `error.slice(0, 64)` can leave half of a surrogate pair; the
/// half rides in a carrier (see `jsutil`), so it is logged as Bun logs it.
#[tokio::test]
async fn an_error_parameter_cut_inside_a_pair_keeps_half_of_it() {
    let world = World::start(true).await;
    let started = world.client.start_login(StartLoginOptions::default()).await.unwrap();
    let cookie = started.login_cookie.split(';').next().unwrap();
    let error = format!("{}\u{1F600}z", "é".repeat(63));
    let refused = world.client.finish_login(Some(cookie), &[("error".into(), error)]).await.unwrap_err();
    let half = doc_server::jsutil::carrier(0xD83D);
    assert_eq!(refused, AuthError::Login { code: "authorization_error", error: Some(format!("{}{half}", "é".repeat(63))) });
}

#[test]
fn the_client_is_shared_between_threads() {
    fn shared<T: Send + Sync + Clone + 'static>() {}
    shared::<AuthClient>();
    fn error<T: std::error::Error + Send + Sync + Clone + 'static>() {}
    error::<AuthError>();
}

#[test]
fn messages_are_the_javascript_ones() {
    assert_eq!(AuthError::InvalidGrant("a".into()).message(), "a");
    assert_eq!(AuthError::Unavailable("b".into()).message(), "b");
    assert_eq!(AuthError::InvalidToken("c".into()).message(), "c");
    assert_eq!(AuthError::Other("d".into()).message(), "d");
    assert_eq!(AuthError::Login { code: "missing_code", error: None }.message(), "missing_code");
    // `error ? `${code}: ${error}` : code`: an empty error is falsy.
    assert_eq!(AuthError::Login { code: "authorization_error", error: Some(String::new()) }.message(), "authorization_error");
    assert_eq!(AuthError::Login { code: "authorization_error", error: Some("x".into()) }.to_string(), "authorization_error: x");
}
