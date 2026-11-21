//! Port of `src/server/lib/mail.ts`: the outgoing mail queue.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use chrono::Utc;
use serde_json::json;
use tokio::sync::Notify;

use crate::jsutil::to_text;
use crate::common::ids::uuid;
use crate::config::{config, MailDriver};
use crate::jsutil::js_trim;
use crate::logger;
use crate::smtp::{send_smtp, Envelope, SmtpOptions};

#[derive(Debug, Clone)]
pub struct Mail {
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: String,
}

const MAX_QUEUE: usize = 1000;
const MAX_ATTEMPTS: u32 = 3;

/// `value.replace(/[\r\n\u0000]+/g, " ").trim()`.
fn strip_header(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_run = false;
    for ch in value.chars() {
        if ch == '\r' || ch == '\n' || ch == '\0' {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(ch);
            in_run = false;
        }
    }
    js_trim(&out).to_string()
}

fn b64(value: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(value.as_bytes())
}

fn encode_word(value: &str) -> String {
    if value.chars().all(|c| ('\u{20}'..='\u{7e}').contains(&c)) {
        value.to_string()
    } else {
        format!("=?UTF-8?B?{}?=", b64(value))
    }
}

fn base64_lines(value: &str) -> String {
    let encoded = b64(value);
    encoded.as_bytes().chunks(76).map(|chunk| std::str::from_utf8(chunk).unwrap_or("")).collect::<Vec<_>>().join("\r\n")
}

/// `new Date().toUTCString()`: `Tue, 05 Mar 2024 10:00:00 GMT`.
pub fn utc_string(time: chrono::DateTime<Utc>) -> String {
    time.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

pub fn build_message(mail: &Mail, from_address: &str, from_name: &str) -> String {
    let boundary = format!("b-{}", uuid());
    let domain = from_address.split('@').nth(1).unwrap_or("localhost");
    let from_name = strip_header(from_name).replace('"', "");
    let from = if from_name.is_empty() { String::new() } else { format!("\"{}\" ", encode_word(&from_name)) };
    [
        format!("From: {from}<{}>", strip_header(from_address)),
        format!("To: <{}>", strip_header(&mail.to)),
        format!("Subject: {}", encode_word(&strip_header(&to_text(&mail.subject)))),
        format!("Date: {}", utc_string(Utc::now())),
        format!("Message-ID: <{}@{domain}>", uuid()),
        "MIME-Version: 1.0".to_string(),
        format!("Content-Type: multipart/alternative; boundary=\"{boundary}\""),
        String::new(),
        format!("--{boundary}"),
        "Content-Type: text/plain; charset=UTF-8".to_string(),
        "Content-Transfer-Encoding: base64".to_string(),
        String::new(),
        base64_lines(&to_text(&mail.text)),
        format!("--{boundary}"),
        "Content-Type: text/html; charset=UTF-8".to_string(),
        "Content-Transfer-Encoding: base64".to_string(),
        String::new(),
        base64_lines(&to_text(&mail.html)),
        format!("--{boundary}--"),
        String::new(),
    ]
    .join("\r\n")
}

async fn transport(mail: &Mail) -> Result<(), String> {
    let settings = &config().mail;
    if settings.driver == MailDriver::Log {
        logger::info_with("mail (log driver)", json!({ "to": mail.to, "subject": mail.subject }));
        return Ok(());
    }
    let to = strip_header(&mail.to);
    let options = SmtpOptions {
        host: settings.host.clone(),
        port: settings.port,
        secure: settings.secure,
        ignore_tls: settings.ignore_tls,
        username: settings.username.clone(),
        password: settings.password.clone(),
        timeout: Duration::from_millis(30_000),
    };
    let message = build_message(&Mail { to: to.clone(), ..mail.clone() }, &settings.from_address, &settings.from_name);
    send_smtp(&options, &Envelope { from: strip_header(&settings.from_address), to, data: message }).await
}

struct Item {
    mail: Mail,
    attempts: u32,
}

static QUEUE: Mutex<VecDeque<Item>> = Mutex::new(VecDeque::new());
static DRAINING: AtomicBool = AtomicBool::new(false);
static RETRIES: AtomicUsize = AtomicUsize::new(0);
static IDLE: Notify = Notify::const_new();

fn queue() -> std::sync::MutexGuard<'static, VecDeque<Item>> {
    QUEUE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn drain() {
    loop {
        let item = {
            let mut queue = queue();
            match queue.pop_front() {
                Some(item) => item,
                None => {
                    // Checked under the lock, so an `enqueue` racing this either sees the
                    // flag still set and leaves its item to this loop, or starts a new one.
                    DRAINING.store(false, Ordering::SeqCst);
                    break;
                }
            }
        };
        let mut item = item;
        if let Err(error) = transport(&item.mail).await {
            item.attempts += 1;
            logger::error_with("mail delivery failed", &error, json!({ "subject": item.mail.subject, "attempt": item.attempts }));
            if item.attempts < MAX_ATTEMPTS {
                RETRIES.fetch_add(1, Ordering::SeqCst);
                let delay = Duration::from_millis(15_000 * u64::from(item.attempts));
                tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    RETRIES.fetch_sub(1, Ordering::SeqCst);
                    enqueue(item);
                });
            }
        }
    }
    IDLE.notify_waiters();
}

fn enqueue(item: Item) {
    let start = {
        let mut queue = queue();
        if queue.len() >= MAX_QUEUE {
            logger::warn("mail queue full, dropping message", json!({ "subject": item.mail.subject }));
            return;
        }
        queue.push_back(item);
        !DRAINING.swap(true, Ordering::SeqCst)
    };
    if start {
        tokio::spawn(drain());
    }
}

/// Queues an email; delivery happens in the background and never fails the caller.
pub fn send_mail(mail: Mail) {
    enqueue(Item { mail, attempts: 0 });
}

/// Resolves once the queue is empty (pending retries are not awaited).
pub async fn flush_mail() {
    loop {
        let idle = IDLE.notified();
        if !DRAINING.load(Ordering::SeqCst) {
            return;
        }
        idle.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_messages() {
        let mail = Mail { to: "a@b.c\r\nBcc: x@y.z".into(), subject: "Héllo\nthere".into(), text: "t".repeat(100), html: "<p>h</p>".into() };
        let message = build_message(&mail, "docs@example.com", "Do\"cs ✓");
        let lines: Vec<&str> = message.split("\r\n").collect();
        assert_eq!(lines[0], format!("From: \"=?UTF-8?B?{}?=\" <docs@example.com>", b64("Docs ✓")));
        assert_eq!(lines[1], "To: <a@b.c Bcc: x@y.z>");
        assert_eq!(lines[2], format!("Subject: =?UTF-8?B?{}?=", b64("Héllo there")));
        assert!(lines[3].starts_with("Date: ") && lines[3].ends_with(" GMT"));
        assert!(lines[4].starts_with("Message-ID: <") && lines[4].ends_with("@example.com>"));
        assert_eq!(lines[12].len(), 76);
        assert_eq!(lines.last(), Some(&""));
        assert_eq!(strip_header(" a\r\n\0b "), "a b");
        assert_eq!(utc_string(chrono::DateTime::from_timestamp(1_709_632_800, 0).unwrap()), "Tue, 05 Mar 2024 10:00:00 GMT");
    }
}
