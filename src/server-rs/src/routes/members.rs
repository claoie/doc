//! Port of `src/server/routes/members.ts`.

use serde_json::{json, Value};

use crate::auth::{revoke_user_sessions, AuthUser};
use crate::db::{begin, db};
use crate::files::remove_image;
use crate::http::{bad_request, empty, forbidden_with, get, not_found, post, read_json, AppError, Ctx, Reply, Result, Route};
use crate::permissions::require_workspace_admin;
use crate::realtime::hub::{disconnect_user, membership_changed};
use crate::search::escape_like;
use crate::sso::require_locally_managed;
use crate::users::{find_user_by_id, sso_managed_field, to_member, to_user, UserRow};
use crate::validate::{input, min_max, Input};
use crate::{handler, sql};

const ROLES: &[&str] = &["owner", "admin", "member"];

/// Loads the target of an admin action, enforcing that admins never act on owners or themselves.
async fn target_user(actor: &AuthUser, user_id: &str, allow_self: bool) -> Result<UserRow> {
    require_workspace_admin(actor)?;
    let Some(target) = find_user_by_id(user_id).await? else { return Err(not_found("User")) };
    if !allow_self && target.id == actor.id {
        return Err(forbidden_with("You cannot do this to your own account"));
    }
    if target.role == "owner" && actor.role != "owner" {
        return Err(forbidden_with("Only owners can manage owners"));
    }
    Ok(target)
}

async fn list(ctx: &mut Ctx) -> Result<Reply> {
    let query = Input::query(ctx);
    let q = query.optional_string("query", min_max(0, 100))?.unwrap_or_default().to_lowercase();
    let limit = query.integer("limit", 1, 500)?.unwrap_or(50);
    let offset = query.integer("offset", 0, 1_000_000)?.unwrap_or(0);
    let like = format!("%{}%", escape_like(&q));
    let rows = db()
        .query(sql!(
            "SELECT u.*, count(*) OVER () AS total FROM users u
             WHERE {} = '' OR lower(u.name) LIKE {} OR lower(u.email) LIKE {}
             ORDER BY u.deactivated_at IS NOT NULL, lower(u.name), u.id
             LIMIT {} OFFSET {}",
            &q,
            &like,
            &like,
            limit,
            offset
        ))
        .await?;
    let total = match rows.first() {
        Some(row) => row.i64("total"),
        None => db()
            .first(sql!(
                "SELECT count(*) AS n FROM users u WHERE {} = '' OR lower(u.name) LIKE {} OR lower(u.email) LIKE {}",
                &q,
                &like,
                &like
            ))
            .await?
            .map_or(0, |row| row.i64("n")),
    };
    // With single sign-on on, members linked to it are marked, so admins see why they can't change their role here.
    let viewer = &ctx.user().id;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let user = UserRow::from_row(row);
            let mut member = to_member(&user, viewer);
            sso_managed_field(&user, &mut member);
            Value::Object(member)
        })
        .collect();
    Ok(json!({ "items": items, "total": total }).into())
}

async fn role(ctx: &mut Ctx) -> Result<Reply> {
    let body = input(read_json(ctx).await?);
    let Some(role) = body.one_of("role", ROLES)? else { return Err(bad_request("role is required")) };
    let actor = ctx.user().clone();
    let target = target_user(&actor, &body.uuid("userId")?, true).await?;
    require_locally_managed(&target)?;
    if (role == "owner" || target.role == "owner") && actor.role != "owner" {
        return Err(forbidden_with("Only owners can grant or remove the owner role"));
    }
    let updated = begin(async |tx| -> Result<UserRow> {
        tx.execute(sql!("SELECT pg_advisory_xact_lock(1618033988)")).await?;
        if target.role == "owner" && role != "owner" {
            let owners = tx
                .first(sql!("SELECT count(*)::int AS owners FROM users WHERE role = 'owner' AND deactivated_at IS NULL"))
                .await?
                .map_or(0, |row| row.i64("owners"));
            if owners <= 1 {
                return Err(forbidden_with("The last owner cannot be demoted"));
            }
        }
        let row = tx
            .first(sql!("UPDATE users SET role = {}, updated_at = now() WHERE id = {} RETURNING *", &role, &target.id))
            .await?
            .ok_or_else(|| AppError::other("the member disappeared while their role changed"))?;
        Ok(UserRow::from_row(&row))
    })
    .await?;
    Ok(json!({ "user": Value::Object(to_user(&updated, Some(&actor.id))) }).into())
}

async fn deactivate(ctx: &mut Ctx) -> Result<Reply> {
    let user_id = input(read_json(ctx).await?).uuid("userId")?;
    let target = target_user(ctx.user(), &user_id, false).await?;
    db().execute(sql!("UPDATE users SET deactivated_at = COALESCE(deactivated_at, now()), updated_at = now() WHERE id = {}", &target.id)).await?;
    revoke_user_sessions(&target.id, None).await?;
    disconnect_user(&target.id);
    empty()
}

async fn activate(ctx: &mut Ctx) -> Result<Reply> {
    let user_id = input(read_json(ctx).await?).uuid("userId")?;
    let target = target_user(ctx.user(), &user_id, false).await?;
    db().execute(sql!("UPDATE users SET deactivated_at = NULL, updated_at = now() WHERE id = {}", &target.id)).await?;
    empty()
}

async fn delete(ctx: &mut Ctx) -> Result<Reply> {
    let user_id = input(read_json(ctx).await?).uuid("userId")?;
    let target = target_user(ctx.user(), &user_id, false).await?;
    if target.role == "owner" {
        let owners = db().first(sql!("SELECT count(*)::int AS owners FROM users WHERE role = 'owner'")).await?.map_or(0, |row| row.i64("owners"));
        if owners <= 1 {
            return Err(forbidden_with("The last owner cannot be deleted"));
        }
    }
    disconnect_user(&target.id);
    db().execute(sql!("DELETE FROM users WHERE id = {}", &target.id)).await?;
    remove_image(target.avatar.as_deref()).await?;
    membership_changed(vec![target.id.clone()]);
    empty()
}

pub fn routes() -> Vec<Route> {
    vec![
        get("/members", handler!(list)),
        post("/members/role", handler!(role)),
        post("/members/deactivate", handler!(deactivate)),
        post("/members/activate", handler!(activate)),
        post("/members/delete", handler!(delete)),
    ]
}
