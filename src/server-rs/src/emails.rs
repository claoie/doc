//! Port of `src/server/lib/emails.ts`.

use crate::jsutil::escape_html;
use crate::mail::Mail;

pub struct Action<'a> {
    pub label: &'a str,
    pub url: &'a str,
}

/// Renders a short transactional email as plain text and minimal inline-styled HTML.
pub fn render_mail(to: &str, subject: &str, paragraphs: &[String], action: Option<Action>) -> Mail {
    let mut text_parts: Vec<String> = paragraphs.to_vec();
    if let Some(action) = &action {
        text_parts.push(format!("{}: {}", action.label, action.url));
    }
    let text = text_parts.join("\n\n");
    let body: String = paragraphs.iter().map(|p| format!("<p style=\"margin:0 0 16px\">{}</p>", escape_html(p))).collect();
    let button = match &action {
        Some(action) => format!(
            "<p style=\"margin:24px 0\"><a href=\"{}\" style=\"background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none\">{}</a></p><p style=\"color:#666;font-size:12px\">{}</p>",
            escape_html(action.url),
            escape_html(action.label),
            escape_html(action.url)
        ),
        None => String::new(),
    };
    let html = format!(
        "<!doctype html><html><body style=\"font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#222;line-height:1.5\"><div style=\"max-width:560px;margin:0 auto;padding:24px\">{body}{button}</div></body></html>"
    );
    Mail { to: to.to_string(), subject: subject.to_string(), text, html }
}
