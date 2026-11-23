//! Port of `src/server/lib/logger.ts`: one JSON object per line.

use std::io::Write;

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Map, Value};

use crate::alarm::send_alarm;
use crate::config::config;
use crate::jsutil::js_json;

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    iso(Utc::now())
}

/// `date.toISOString()`: milliseconds, `Z`.
pub fn iso(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn write(level: &str, message: &str, fields: Option<Value>, error: Option<&str>) {
    let mut extra = match fields {
        Some(Value::Object(fields)) => fields,
        _ => Map::new(),
    };
    if let Some(error) = error {
        extra.insert("error".into(), Value::String(error.into()));
    }
    let mut line = Map::new();
    line.insert("t".into(), Value::String(now_iso()));
    line.insert("level".into(), Value::String(level.into()));
    line.insert("msg".into(), Value::String(message.into()));
    line.extend(extra.clone());
    let text = js_json(&Value::Object(line));
    // A closed pipe must not take the server down.
    if level == "info" {
        let _ = writeln!(std::io::stdout().lock(), "{text}");
    } else {
        let _ = writeln!(std::io::stderr().lock(), "{text}");
    }
    if level == "error" {
        send_alarm(message, extra);
    }
}

pub fn info(message: &str) {
    write("info", message, None, None);
}

pub fn info_with(message: &str, fields: Value) {
    write("info", message, Some(fields), None);
}

pub fn warn(message: &str, fields: Value) {
    write("warn", message, Some(fields), None);
}

pub fn error(message: &str, error: &dyn std::fmt::Display) {
    write("error", message, None, Some(&error.to_string()));
}

pub fn error_with(message: &str, error: &dyn std::fmt::Display, fields: Value) {
    write("error", message, Some(fields), Some(&error.to_string()));
}

/// An error line without an error value (`log.error(message, undefined, fields)`).
pub fn error_fields(message: &str, fields: Value) {
    write("error", message, Some(fields), None);
}

pub struct RequestLog<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub status: u16,
    pub ms: u64,
    pub user_id: Option<&'a str>,
}

/// One line per request. Only the path is logged: query strings may carry tokens or share keys.
pub fn log_request(entry: &RequestLog) {
    // Health checks poll constantly and carry no debugging value.
    if !config().log_requests || entry.path == "/api/health" {
        return;
    }
    let mut line = Map::new();
    line.insert("t".into(), Value::String(now_iso()));
    line.insert("method".into(), Value::String(entry.method.into()));
    line.insert("path".into(), Value::String(entry.path.into()));
    line.insert("status".into(), Value::from(entry.status));
    line.insert("ms".into(), Value::from(entry.ms));
    line.insert("userId".into(), entry.user_id.map_or(Value::Null, |id| Value::String(id.into())));
    let _ = writeln!(std::io::stdout().lock(), "{}", js_json(&Value::Object(line)));
}
