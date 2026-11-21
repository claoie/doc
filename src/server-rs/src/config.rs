//! Port of `src/server/config.ts`: settings read from the environment.

use std::sync::OnceLock;

use regex::Regex;

use crate::jsutil::string_to_number;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn int_env(name: &str, fallback: u64) -> u64 {
    // `Number(undefined)` is NaN, so an unset variable falls back too.
    let value = env(name).map_or(f64::NAN, |v| string_to_number(&v));
    if value.is_finite() && value > 0.0 {
        value.floor() as u64
    } else {
        fallback
    }
}

fn bool_env(name: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)^(1|true|yes|on)$").expect("boolean pattern"));
    re.is_match(&env(name).unwrap_or_default())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageDriver {
    Local,
    S3,
}

#[derive(Debug, Clone)]
pub struct S3Config {
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub endpoint: Option<String>,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub force_path_style: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MailDriver {
    Log,
    Smtp,
}

#[derive(Debug, Clone)]
pub struct MailConfig {
    pub driver: MailDriver,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub secure: bool,
    pub ignore_tls: bool,
    pub from_address: String,
    pub from_name: String,
}

/// Single sign-on through an OpenID Connect provider. Checked at start by `sso::sso_problems`.
#[derive(Debug, Clone)]
pub struct SsoConfig {
    pub issuer: String,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub redirect_uri: String,
    pub back_channel_url: Option<String>,
    pub audience: Option<String>,
    pub local_login: bool,
    pub link_users: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    /// Public URL of the app, without a trailing slash.
    pub app_url: String,
    pub secure_cookies: bool,
    pub database_url: String,
    pub database_pool_max: usize,
    pub trust_proxy: bool,
    pub file_size_limit: u64,
    pub storage_driver: StorageDriver,
    pub storage_path: String,
    pub s3: S3Config,
    pub mail: MailConfig,
    pub log_requests: bool,
    /// `None` when `AUTH_ISSUER` is unset.
    pub sso: Option<SsoConfig>,
    /// Password sign-in, setup, invitations and resets: always without SSO, and with it only when `AUTH_LOCAL_LOGIN` is on.
    pub local_login: bool,
}

impl Config {
    pub fn from_env() -> Config {
        let port = int_env("PORT", 3000).min(65535) as u16;
        let app_url = env("APP_URL").unwrap_or_else(|| format!("http://localhost:{port}"));
        let app_url = app_url.trim_end_matches('/').to_string();
        let secure = bool_env("SMTP_SECURE");
        let sso = env("AUTH_ISSUER").map(|issuer| SsoConfig {
            issuer,
            client_id: env("AUTH_CLIENT_ID"),
            client_secret: env("AUTH_CLIENT_SECRET"),
            redirect_uri: env("AUTH_REDIRECT_URI").unwrap_or_else(|| format!("{app_url}/api/auth/callback")),
            back_channel_url: env("AUTH_BACKCHANNEL_URL"),
            audience: env("AUTH_AUDIENCE"),
            local_login: bool_env("AUTH_LOCAL_LOGIN"),
            link_users: env("AUTH_LINK_USERS"),
        });
        Config {
            port,
            secure_cookies: app_url.starts_with("https://"),
            app_url,
            database_url: env("DATABASE_URL").unwrap_or_else(|| "postgres://localhost:5432/doc".into()),
            database_pool_max: int_env("DATABASE_POOL_MAX", 5) as usize,
            trust_proxy: bool_env("TRUST_PROXY"),
            file_size_limit: int_env("FILE_SIZE_LIMIT", 50 * 1024 * 1024),
            storage_driver: if env("STORAGE_DRIVER").as_deref() == Some("s3") { StorageDriver::S3 } else { StorageDriver::Local },
            storage_path: env("STORAGE_PATH").unwrap_or_else(|| "./data/storage".into()),
            s3: S3Config {
                bucket: env("S3_BUCKET"),
                region: env("S3_REGION"),
                endpoint: env("S3_ENDPOINT"),
                access_key_id: env("S3_ACCESS_KEY_ID"),
                secret_access_key: env("S3_SECRET_ACCESS_KEY"),
                force_path_style: bool_env("S3_FORCE_PATH_STYLE"),
            },
            mail: MailConfig {
                driver: if env("MAIL_DRIVER").as_deref() == Some("smtp") { MailDriver::Smtp } else { MailDriver::Log },
                host: env("SMTP_HOST").unwrap_or_else(|| "localhost".into()),
                port: int_env("SMTP_PORT", if secure { 465 } else { 587 }).min(65535) as u16,
                username: env("SMTP_USERNAME"),
                password: env("SMTP_PASSWORD"),
                secure,
                ignore_tls: bool_env("SMTP_IGNORETLS"),
                from_address: env("MAIL_FROM_ADDRESS").unwrap_or_else(|| "noreply@localhost".into()),
                from_name: env("MAIL_FROM_NAME").unwrap_or_else(|| "Doc".into()),
            },
            log_requests: env("LOG_REQUESTS").as_deref() != Some("0"),
            local_login: sso.as_ref().is_none_or(|s| s.local_login),
            sso,
        }
    }
}

/// The settings, read from the environment the first time they are needed.
pub fn config() -> &'static Config {
    static CONFIG: OnceLock<Config> = OnceLock::new();
    CONFIG.get_or_init(Config::from_env)
}
