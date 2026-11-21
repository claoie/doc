//! Port of `src/server/lib/permissions.ts`.

use crate::auth::AuthUser;
use crate::db::{db, Sql};
use crate::http::{forbidden, forbidden_with, not_found, Result};
use crate::sql;

fn rank(role: &str) -> u8 {
    match role {
        "admin" => 3,
        "writer" => 2,
        "reader" => 1,
        _ => 0,
    }
}

/// `rankToRole(rank)`.
pub fn rank_to_role(rank: Option<i64>) -> Option<&'static str> {
    match rank {
        Some(3) => Some("admin"),
        Some(2) => Some("writer"),
        Some(1) => Some("reader"),
        _ => None,
    }
}

/// `hasRole(role, min)`.
pub fn has_role(role: Option<&str>, min: &str) -> bool {
    role.is_some_and(|role| rank(role) >= rank(min))
}

pub fn is_workspace_admin(user: &AuthUser) -> bool {
    user.role == "owner" || user.role == "admin"
}

pub fn require_workspace_admin(user: &AuthUser) -> Result<()> {
    if is_workspace_admin(user) {
        Ok(())
    } else {
        Err(forbidden_with("Only workspace admins can do this"))
    }
}

/// SQL fragment evaluating to the user's effective role rank (1–3, or null) in
/// the space referenced by `space_column`: the highest of direct and group grants.
pub fn role_rank(space_column: &str, user_id: &str) -> Sql {
    sql!(
        "(
  SELECT max(CASE sm.role WHEN 'admin' THEN 3 WHEN 'writer' THEN 2 ELSE 1 END)
  FROM space_members sm
  WHERE sm.space_id = {}
    AND (sm.user_id = {}
      OR sm.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = {}))
)",
        Sql::raw(space_column),
        user_id,
        user_id
    )
}

/// SQL fragment selecting the ids of every space the user is a member of.
pub fn readable_space_ids(user_id: &str) -> Sql {
    sql!(
        "(
  SELECT sm.space_id FROM space_members sm
  WHERE sm.user_id = {}
    OR sm.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = {})
)",
        user_id,
        user_id
    )
}

pub async fn space_role(user_id: &str, space_id: &str) -> Result<Option<&'static str>> {
    let row = db().first(sql!("SELECT {} AS rank FROM spaces s WHERE s.id = {}", role_rank("s.id", user_id), space_id)).await?;
    Ok(rank_to_role(row.and_then(|r| r.opt_i64("rank"))))
}

/// Fails with 404 when the user is not a member of the space (its existence is
/// not revealed) and 403 when their role is below `min`.
pub async fn require_space_role(user: &AuthUser, space_id: &str, min: &str) -> Result<&'static str> {
    let Some(role) = space_role(&user.id, space_id).await? else { return Err(not_found("Space")) };
    if !has_role(Some(role), min) {
        return Err(forbidden());
    }
    Ok(role)
}

/// Space management (settings, members, icon, deletion) is open to space
/// admins and to workspace admins, who manage every space.
pub async fn require_space_manager(user: &AuthUser, space_id: &str) -> Result<Option<&'static str>> {
    let row = db().first(sql!("SELECT id, {} AS rank FROM spaces s WHERE s.id = {}", role_rank("s.id", &user.id), space_id)).await?;
    let Some(row) = row else { return Err(not_found("Space")) };
    let role = rank_to_role(row.opt_i64("rank"));
    if has_role(role, "admin") || is_workspace_admin(user) {
        return Ok(role);
    }
    if role.is_none() {
        return Err(not_found("Space"));
    }
    Err(forbidden())
}

pub async fn list_readable_space_ids(user_id: &str) -> Result<Vec<String>> {
    let rows = db().query(sql!("SELECT DISTINCT space_id FROM {} AS r", readable_space_ids(user_id))).await?;
    Ok(rows.iter().map(|row| row.str("space_id")).collect())
}
