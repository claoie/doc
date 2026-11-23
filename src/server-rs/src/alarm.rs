//! Port of `src/server/lib/alarm.ts`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};

use crate::config::config;
use crate::jsutil::{js_json, take_chars};
use crate::logger::{iso, warn};

const WINDOW_MS: i64 = 60_000;

/// Alarms a minute across all messages. An outage logs many different errors at
/// once, and Discord accepts about thirty posts a minute to one webhook.
pub const MAX_ALARMS_PER_WINDOW: usize = 10;

const TITLE_MAX: usize = 256;
const DESCRIPTION_MAX: usize = 4000;
const COLOR: u32 = 0xed4245;

struct Limits {
    last_by_message: HashMap<String, i64>,
    recent: Vec<i64>,
}

static LIMITS: Mutex<Option<Limits>> = Mutex::new(None);

/// Whether an alarm for `message` may be sent at `now` (milliseconds), counting
/// it if so: one a minute for each message, and `MAX_ALARMS_PER_WINDOW` a minute in all.
pub fn admit_alarm(message: &str, now: i64) -> bool {
    let mut guard = LIMITS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let limits = guard.get_or_insert_with(|| Limits { last_by_message: HashMap::new(), recent: Vec::new() });
    limits.recent.retain(|at| now - at < WINDOW_MS);
    limits.last_by_message.retain(|_, at| now - *at < WINDOW_MS);
    if limits.last_by_message.contains_key(message) || limits.recent.len() >= MAX_ALARMS_PER_WINDOW {
        return false;
    }
    limits.last_by_message.insert(message.to_string(), now);
    limits.recent.push(now);
    true
}

pub fn reset_alarms() {
    *LIMITS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() > max {
        format!("{}…", take_chars(text, max - 1))
    } else {
        text.to_string()
    }
}

/// The webhook message for an error log line: its message as the title, its other fields one per line.
pub fn alarm_body(message: &str, fields: &Map<String, Value>, at: DateTime<Utc>) -> Value {
    let lines: Vec<String> = fields
        .iter()
        .map(|(key, value)| match value {
            Value::String(text) => format!("{key}: {text}"),
            other => format!("{key}: {}", js_json(other)),
        })
        .collect();
    json!({
        "allowed_mentions": { "parse": [] },
        "embeds": [{
            "title": cut(&format!("doc: {message}"), TITLE_MAX),
            "description": format!("```\n{}\n```", cut(&lines.join("\n"), DESCRIPTION_MAX)),
            "color": COLOR,
            "timestamp": iso(at),
        }],
    })
}

/// Posts an error log line to `DISCORD_ALARM_WEBHOOK` when it is set and the
/// limits admit it, without waiting; a failure is logged as a warning.
pub fn send_alarm(message: &str, fields: Map<String, Value>) {
    let Some(webhook) = config().alarm_webhook.clone() else { return };
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    let at = Utc::now();
    if !admit_alarm(message, at.timestamp_millis()) {
        return;
    }
    let body = js_json(&alarm_body(message, &fields, at));
    let message = message.to_string();
    runtime.spawn(async move {
        if let Err(error) = post(&webhook, body).await {
            warn("sending an alarm failed", json!({ "alarm": message, "error": error }));
        }
    });
}

async fn post(webhook: &str, body: String) -> Result<(), String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|error| error.to_string())?;
    let response = client
        .post(webhook)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("the webhook answered {}", status.as_u16()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_one_alarm_a_minute_per_message_and_ten_in_all() {
        reset_alarms();
        assert!(admit_alarm("a", 0));
        assert!(!admit_alarm("a", 59_999));
        assert!(admit_alarm("a", 60_000));
        for i in 0..9 {
            assert!(admit_alarm(&format!("m{i}"), 60_001));
        }
        assert!(!admit_alarm("another", 60_002));
        assert!(admit_alarm("another", 120_001));
        reset_alarms();
    }

    #[test]
    fn lists_the_fields_and_cuts_long_text() {
        let mut fields = Map::new();
        fields.insert("pageId".into(), json!("p1"));
        fields.insert("attempt".into(), json!(2));
        fields.insert("error".into(), json!("boom"));
        let at = DateTime::parse_from_rfc3339("2026-11-23T20:00:00Z").unwrap().with_timezone(&Utc);
        let body = alarm_body("saving page content failed", &fields, at);
        assert_eq!(
            body,
            json!({
                "allowed_mentions": { "parse": [] },
                "embeds": [{
                    "title": "doc: saving page content failed",
                    "description": "```\npageId: p1\nattempt: 2\nerror: boom\n```",
                    "color": 0xed4245,
                    "timestamp": "2026-11-23T20:00:00.000Z",
                }],
            })
        );
        let long = "é".repeat(300);
        let title = alarm_body(&long, &Map::new(), at)["embeds"][0]["title"].as_str().unwrap().to_string();
        assert_eq!(title.chars().count(), 256);
        assert!(title.ends_with("é…"));
    }
}
