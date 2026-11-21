//! Port of `src/server/routes/invitations.ts`.

use serde_json::{json, Value};

use crate::auth::{hash_token, same_hash, sign_in};
use crate::common::ids::{is_uuid, token};
use crate::config::config;
use crate::db::{array, begin, db, Row};
use crate::emails::{render_mail, Action};
use crate::http::{bad_request, conflict, empty, get, http_error, not_found, post, public_get, public_post, read_json, AppError, Ctx, Reply, Result, Route};
use crate::jsutil::{encode_uri_component, utf16_len};
use crate::mail::send_mail;
use crate::permissions::require_workspace_admin;
use crate::ratelimit::{rate_limit, DEFAULT_LIMIT};
use crate::spaces::{email_domains, get_workspace};
use crate::sso::require_local_login;
use crate::users::{hash_password, to_user, user_ref, UserRow};
use crate::validate::{input, max, normalize_email, Input, NAME_RULE, PASSWORD_RULE};
use crate::{handler, sql};

fn invite_url(id: &str, value: &str) -> String {
    format!("{}/invites/{id}?token={}", config().app_url, encode_uri_component(value))
}

async fn invitation_mail(email: &str, url: &str, inviter_name: &str) -> Result<()> {
    let workspace = get_workspace().await?;
    let name = workspace["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("a workspace");
    send_mail(render_mail(
        email,
        &format!("{inviter_name} invited you to {name}"),
        &[format!("{inviter_name} invited you to join {name}.")],
        Some(Action { label: "Accept invitation", url }),
    ));
    Ok(())
}

/// Invitations create password accounts; with single sign-on only, people get access through the identity provider instead.
const INVITATIONS_OFF: &str =
    "This workspace uses single sign-on: people get access through the identity provider and appear here when they first sign in";

fn invalid_invitation() -> AppError {
    http_error(400, "invalid_invitation", "This invitation is invalid, expired or has been revoked")
}

/// Invitation links stop working this long after they were sent; resending renews them.
const INVITATION_TTL_DAYS: i64 = 14;

/// Looks up an invitation and checks its token in constant time.
async fn verify_invitation(id: Option<&Value>, value: Option<&Value>) -> Result<Row> {
    let (Some(id), Some(value)) = (id.and_then(Value::as_str).filter(|id| is_uuid(id)), value.and_then(Value::as_str).filter(|v| utf16_len(v) <= 200))
    else {
        return Err(invalid_invitation());
    };
    let invitation = db()
        .first(sql!(
            "SELECT id, email, role, group_ids::text[] AS group_ids, token_hash, invited_by FROM invitations
             WHERE id = {} AND created_at > now() - make_interval(days => {})",
            id,
            INVITATION_TTL_DAYS
        ))
        .await?;
    match invitation {
        Some(invitation) if same_hash(&invitation.str("token_hash"), &hash_token(value)) => Ok(invitation),
        _ => Err(invalid_invitation()),
    }
}

async fn rotate(id: &str) -> Result<(String, String)> {
    let value = token();
    let row = db()
        .first(sql!("UPDATE invitations SET token_hash = {}, created_at = now() WHERE id = {} RETURNING id, email", hash_token(&value), id))
        .await?;
    let Some(row) = row else { return Err(not_found("Invitation")) };
    Ok((invite_url(&row.str("id"), &value), row.str("email")))
}

async fn list(ctx: &mut Ctx) -> Result<Reply> {
    require_workspace_admin(ctx.user())?;
    let rows = db()
        .query(sql!(
            "SELECT i.id, i.email, i.role, i.group_ids::text[] AS group_ids, i.created_at,
               u.id AS inviter_id, u.name AS inviter_name, u.avatar AS inviter_avatar
             FROM invitations i LEFT JOIN users u ON u.id = i.invited_by ORDER BY i.created_at DESC"
        ))
        .await?;
    Ok(Value::Array(
        rows.iter()
            .map(|r| {
                let invited_by = match r.opt_str("inviter_id") {
                    Some(id) => user_ref(&id, &r.str("inviter_name"), r.opt_str("inviter_avatar").as_deref()),
                    None => Value::Null,
                };
                json!({
                    "id": r.str("id"),
                    "email": r.str("email"),
                    "role": r.str("role"),
                    "groupIds": r.strings("group_ids"),
                    "invitedBy": invited_by,
                    "createdAt": r.iso("created_at"),
                })
            })
            .collect(),
    )
    .into())
}

async fn create(ctx: &mut Ctx) -> Result<Reply> {
    require_workspace_admin(ctx.user())?;
    require_local_login(INVITATIONS_OFF)?;
    let body = input(read_json(ctx).await?);
    let mut emails: Vec<String> = Vec::new();
    for given in body.strings("emails", 50, max(254))?.unwrap_or_default() {
        let email = normalize_email(&given)?;
        if !emails.contains(&email) {
            emails.push(email);
        }
    }
    if emails.is_empty() {
        return Err(bad_request("emails is required"));
    }
    let role = body.one_of("role", &["admin", "member"])?.unwrap_or_else(|| "member".to_string());
    let group_ids = body.uuids("groupIds", 50)?.unwrap_or_default();
    let domains = email_domains(&get_workspace().await?);
    if !domains.is_empty() && emails.iter().any(|e| !domains.iter().any(|d| Some(d.as_str()) == e.split('@').nth(1))) {
        return Err(bad_request(format!("Only {} addresses can be invited", domains.join(", "))));
    }
    let valid_groups: Vec<String> = db()
        .query(sql!("SELECT id FROM groups WHERE id = ANY({}::uuid[]) AND NOT is_default", array(&group_ids)))
        .await?
        .iter()
        .map(|row| row.str("id"))
        .collect();
    let members: Vec<String> = db()
        .query(sql!("SELECT lower(email) AS email FROM users WHERE lower(email) = ANY({}::text[])", array(&emails)))
        .await?
        .iter()
        .map(|row| row.str("email"))
        .collect();
    let user = ctx.user().clone();
    let mut created = Vec::new();
    for email in emails.iter().filter(|e| !members.contains(e)) {
        let value = token();
        let row = db()
            .first(sql!(
                "INSERT INTO invitations (email, role, group_ids, token_hash, invited_by)
                 VALUES ({}, {}, {}::uuid[], {}, {})
                 ON CONFLICT (lower(email)) DO UPDATE SET
                   role = excluded.role, group_ids = excluded.group_ids, token_hash = excluded.token_hash,
                   invited_by = excluded.invited_by, created_at = now()
                 RETURNING id",
                email,
                &role,
                array(&valid_groups),
                hash_token(&value),
                &user.id
            ))
            .await?;
        let id = row.map(|r| r.str("id")).unwrap_or_default();
        let url = invite_url(&id, &value);
        invitation_mail(email, &url, &user.name).await?;
        created.push(json!({ "id": id, "email": email, "url": url }));
    }
    Ok(Value::Array(created).into())
}

async fn resend(ctx: &mut Ctx) -> Result<Reply> {
    require_workspace_admin(ctx.user())?;
    require_local_login(INVITATIONS_OFF)?;
    let id = input(read_json(ctx).await?).uuid("id")?;
    let (url, email) = rotate(&id).await?;
    invitation_mail(&email, &url, &ctx.user().name).await?;
    Ok(json!({ "url": url }).into())
}

async fn link(ctx: &mut Ctx) -> Result<Reply> {
    require_workspace_admin(ctx.user())?;
    require_local_login(INVITATIONS_OFF)?;
    let id = input(read_json(ctx).await?).uuid("id")?;
    let (url, _) = rotate(&id).await?;
    Ok(json!({ "url": url }).into())
}

async fn revoke(ctx: &mut Ctx) -> Result<Reply> {
    require_workspace_admin(ctx.user())?;
    let id = input(read_json(ctx).await?).uuid("id")?;
    db().execute(sql!("DELETE FROM invitations WHERE id = {}", &id)).await?;
    empty()
}

async fn info(ctx: &mut Ctx) -> Result<Reply> {
    require_local_login(INVITATIONS_OFF)?;
    rate_limit("invitation-info", &ctx.ip, 30)?;
    let id = Value::String(ctx.param("id").to_string());
    let query = Input::query(ctx);
    let invitation = verify_invitation(Some(&id), query.raw("token")).await?;
    let workspace = get_workspace().await?;
    Ok(json!({ "email": invitation.str("email"), "workspaceName": workspace["name"] }).into())
}

async fn accept(ctx: &mut Ctx) -> Result<Reply> {
    require_local_login(INVITATIONS_OFF)?;
    rate_limit("invitation-accept", &ctx.ip, DEFAULT_LIMIT)?;
    let body = input(read_json(ctx).await?);
    let invitation = verify_invitation(body.raw("id"), body.raw("token")).await?;
    let name = body.string("name", NAME_RULE)?;
    let password_hash = hash_password(&body.string("password", PASSWORD_RULE)?).await?;
    let invitation_id = invitation.str("id");
    let email = invitation.str("email");
    let invited_by = invitation.opt_str("invited_by");
    let user = begin(async |tx| -> Result<UserRow> {
        let claimed = tx.first(sql!("DELETE FROM invitations WHERE id = {} RETURNING id", &invitation_id)).await?;
        if claimed.is_none() {
            return Err(invalid_invitation());
        }
        if tx.first(sql!("SELECT 1 AS taken FROM users WHERE lower(email) = {}", email.to_lowercase())).await?.is_some() {
            return Err(conflict("email_taken", "An account with this email already exists"));
        }
        let created = tx
            .first(sql!(
                "INSERT INTO users (email, name, password_hash, role, invited_by)
                 VALUES ({}, {}, {}, {}, {})
                 RETURNING *",
                &email,
                &name,
                &password_hash,
                invitation.str("role"),
                invited_by.clone()
            ))
            .await?
            .ok_or_else(|| AppError::other("creating the user returned no row"))?;
        let created = UserRow::from_row(&created);
        tx.execute(sql!(
            "INSERT INTO group_members (group_id, user_id)
             SELECT id, {} FROM groups
             WHERE is_default OR id = ANY({}::uuid[])
             ON CONFLICT DO NOTHING",
            &created.id,
            array(&invitation.strings("group_ids"))
        ))
        .await?;
        Ok(created)
    })
    .await?;
    sign_in(ctx, &user.id, None).await?;
    if let Some(inviter_id) = invited_by {
        let inviter = db().first(sql!("SELECT email, name FROM users WHERE id = {} AND deactivated_at IS NULL", &inviter_id)).await?;
        if let Some(inviter) = inviter {
            send_mail(render_mail(
                &inviter.str("email"),
                &format!("{} accepted your invitation", user.name),
                &[format!("{} ({}) accepted your invitation and joined the workspace.", user.name, user.email)],
                Some(Action { label: "Open workspace", url: &config().app_url }),
            ));
        }
    }
    Ok(json!({ "user": Value::Object(to_user(&user, Some(&user.id))) }).into())
}

pub fn routes() -> Vec<Route> {
    vec![
        get("/invitations", handler!(list)),
        post("/invitations", handler!(create)),
        post("/invitations/resend", handler!(resend)),
        post("/invitations/link", handler!(link)),
        post("/invitations/revoke", handler!(revoke)),
        public_get("/invitations/:id", handler!(info)),
        public_post("/invitations/accept", handler!(accept)),
    ]
}
