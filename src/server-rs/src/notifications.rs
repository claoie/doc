//! Port of `src/server/lib/notifications.ts`.

use serde_json::{json, Value};

use crate::common::text::page_path;
use crate::config::config;
use crate::db::{array, db};
use crate::emails::{render_mail, Action};
use crate::http::Result;
use crate::logger;
use crate::mail::send_mail;
use crate::realtime::hub::emit_to_user;
use crate::sql;

/// The preference that switches a kind's emails off.
fn preference(kind: &str) -> &'static str {
    match kind {
        "comment.created" | "comment.reply" => "notifyComments",
        "comment.mention" => "notifyCommentMentions",
        "page.mention" => "notifyPageMentions",
        _ => "notifyPageUpdates",
    }
}

fn subject(kind: &str, actor: &str, title: &str) -> String {
    match kind {
        "comment.created" => format!("{actor} commented on {title}"),
        "comment.reply" => format!("{actor} replied to a comment on {title}"),
        "comment.mention" => format!("{actor} mentioned you in a comment on {title}"),
        "page.mention" => format!("{actor} mentioned you on {title}"),
        _ => format!("{actor} updated {title}"),
    }
}

pub struct NotifyInput<'a> {
    /// `comment.created`, `comment.reply`, `comment.mention`, `page.mention` or `page.updated`.
    pub kind: &'a str,
    pub recipient_ids: Vec<String>,
    pub actor_id: Option<&'a str>,
    pub page_id: &'a str,
    pub comment_id: Option<&'a str>,
    /// Plain-text excerpt included in the email body.
    pub excerpt: Option<&'a str>,
}

/// Creates notifications for recipients who are active and can read the page
/// (the actor is never notified), pushes realtime events and queues emails
/// according to each recipient's preferences. Returns who was notified.
pub async fn notify(input: NotifyInput<'_>) -> Result<Vec<String>> {
    let mut ids: Vec<String> = Vec::new();
    for id in &input.recipient_ids {
        if Some(id.as_str()) != input.actor_id && !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = db()
        .query(sql!(
            "WITH target AS (SELECT space_id FROM pages WHERE id = {} AND deleted_at IS NULL),
             inserted AS (
               INSERT INTO notifications (user_id, kind, actor_id, page_id, comment_id, data)
               SELECT u.id, {}::text, {}::uuid, {}::uuid, {}::uuid, '{{}}'::jsonb
               FROM users u, target t
               WHERE u.id = ANY({}::uuid[]) AND u.deactivated_at IS NULL
                 AND EXISTS (
                   SELECT 1 FROM space_members sm
                   WHERE sm.space_id = t.space_id
                     AND (sm.user_id = u.id OR sm.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = u.id))
                 )
               RETURNING id, user_id
             )
             SELECT i.id, i.user_id, u.email, u.preferences FROM inserted i JOIN users u ON u.id = i.user_id",
            input.page_id,
            input.kind,
            input.actor_id,
            input.page_id,
            input.comment_id,
            array(&ids)
        ))
        .await?;
    for row in &rows {
        emit_to_user(&row.str("user_id"), &json!({ "kind": "notification" }));
    }

    let recipients: Vec<_> = rows.iter().filter(|row| row.json("preferences").get(preference(input.kind)) != Some(&Value::Bool(false))).collect();
    if !recipients.is_empty() {
        let mailed = async {
            let context = db()
                .first(sql!(
                    "SELECT p.title, p.slug_id, s.slug AS space_slug, (SELECT name FROM users WHERE id = {}) AS actor_name
                     FROM pages p JOIN spaces s ON s.id = p.space_id WHERE p.id = {}",
                    input.actor_id,
                    input.page_id
                ))
                .await?;
            let Some(context) = context else { return Ok(()) };
            let page_title = context.opt_str("title");
            let title = page_title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| "Untitled".into());
            let actor = context.opt_str("actor_name").filter(|n| !n.is_empty()).unwrap_or_else(|| "Someone".into());
            let url = format!("{}{}", config().app_url, page_path(&context.str("space_slug"), page_title.as_deref(), &context.str("slug_id")));
            let line = subject(input.kind, &actor, &title);
            let mut paragraphs = vec![format!("{line}.")];
            if let Some(excerpt) = input.excerpt.filter(|e| !e.is_empty()) {
                paragraphs.push(excerpt.to_string());
            }
            for recipient in &recipients {
                send_mail(render_mail(&recipient.str("email"), &line, &paragraphs, Some(Action { label: "Open page", url: &url })));
            }
            let mailed_ids: Vec<String> = recipients.iter().map(|r| r.str("id")).collect();
            db().execute(sql!("UPDATE notifications SET emailed_at = now() WHERE id = ANY({}::uuid[])", array(&mailed_ids))).await?;
            Ok::<(), crate::http::AppError>(())
        };
        if let Err(error) = mailed.await {
            logger::error("notification email failed", &error);
        }
    }
    Ok(rows.iter().map(|row| row.str("user_id")).collect())
}

/// Adds page watchers, ignoring ones that already exist.
pub async fn watch_page(page_id: &str, user_ids: &[String]) -> Result<()> {
    let mut ids: Vec<String> = Vec::new();
    for id in user_ids {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    if ids.is_empty() {
        return Ok(());
    }
    db().execute(sql!(
        "INSERT INTO watchers (user_id, page_id)
         SELECT id, {} FROM users WHERE id = ANY({}::uuid[])
         ON CONFLICT (user_id, page_id) WHERE page_id IS NOT NULL DO NOTHING",
        page_id,
        array(&ids)
    ))
    .await?;
    Ok(())
}
