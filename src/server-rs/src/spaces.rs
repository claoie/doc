//! Port of `src/server/lib/spaces.ts`.

use serde_json::{json, Map, Value};

use crate::common::ids::is_uuid;
use crate::db::{db, Conn, Row, Sql};
use crate::http::Result;
use crate::logger::now_iso;
use crate::permissions::{rank_to_role, role_rank};
use crate::sql;
use crate::users::image_url;

/// Spaces aliased `s` with the user's role rank and member count.
pub fn space_query(user_id: &str) -> Sql {
    sql!(
        "
  SELECT s.id, s.name, s.slug, s.description, s.icon, s.settings, s.created_at,
    {} AS rank,
    (SELECT count(*)::int FROM space_members sm WHERE sm.space_id = s.id) AS member_count
  FROM spaces s",
        role_rank("s.id", user_id)
    )
}

/// `toSpace(row)`.
pub fn to_space(row: &Row) -> Value {
    let settings = row.opt_json("settings").filter(|s| !s.is_null()).unwrap_or_else(|| json!({}));
    json!({
        "id": row.str("id"),
        "name": row.str("name"),
        "slug": row.str("slug"),
        "description": row.opt_str("description"),
        "iconUrl": image_url(row.opt_str("icon").as_deref()),
        "settings": settings,
        "role": rank_to_role(row.opt_i64("rank")),
        "memberCount": row.i64("member_count"),
        "createdAt": row.iso("created_at"),
    })
}

/// SQL expression building a `SpaceRef` JSON object from a spaces row alias.
pub fn space_ref_json(alias: &str) -> Sql {
    Sql::raw(format!(
        "json_build_object('id', {alias}.id, 'name', {alias}.name, 'slug', {alias}.slug, 'iconUrl', CASE WHEN {alias}.icon IS NULL THEN NULL ELSE '/api/images/' || {alias}.icon END)"
    ))
}

/// Finds a space by id or slug, with the user's role.
pub async fn find_space(user_id: &str, reference: &str) -> Result<Option<Row>> {
    let key = reference.to_lowercase();
    let condition = if is_uuid(&key) { sql!("s.id = {}", &key) } else { sql!("lower(s.slug) = {}", &key) };
    Ok(db().first(sql!("{} WHERE {}", space_query(user_id), condition)).await?)
}

/// `getWorkspace()`.
pub async fn get_workspace() -> Result<Value> {
    let row = db().first(sql!("SELECT * FROM workspace WHERE id = 1")).await?;
    let mut workspace = Map::new();
    match row {
        Some(row) => {
            workspace.insert("name".into(), Value::String(row.str("name")));
            workspace.insert("description".into(), row.value("description"));
            workspace.insert("logoUrl".into(), image_url(row.opt_str("logo").as_deref()));
            workspace.insert("emailDomains".into(), json!(row.strings("email_domains")));
            workspace.insert("settings".into(), row.opt_json("settings").filter(|s| !s.is_null()).unwrap_or_else(|| json!({})));
            workspace.insert("defaultSpaceId".into(), row.value("default_space_id"));
            workspace.insert("createdAt".into(), Value::String(row.opt_iso("created_at").unwrap_or_else(now_iso)));
        }
        None => {
            workspace.insert("name".into(), json!(""));
            workspace.insert("description".into(), Value::Null);
            workspace.insert("logoUrl".into(), Value::Null);
            workspace.insert("emailDomains".into(), json!([]));
            workspace.insert("settings".into(), json!({}));
            workspace.insert("defaultSpaceId".into(), Value::Null);
            workspace.insert("createdAt".into(), Value::String(now_iso()));
        }
    }
    Ok(Value::Object(workspace))
}

/// The workspace's allowed email domains.
pub fn email_domains(workspace: &Value) -> Vec<String> {
    workspace["emailDomains"].as_array().map(|d| d.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// Serializes first-run setup until the transaction ends, so a workspace is set up once even when two first sign-ins race.
pub async fn lock_setup(tx: Conn<'_>) -> Result<()> {
    tx.execute(sql!("SELECT pg_advisory_xact_lock(4815162342)")).await?;
    Ok(())
}

/// First-run setup for the workspace's first user, inside the transaction that
/// created them: names the workspace, creates the default group `Everyone` and
/// a `General` space with that user as its admin.
pub async fn init_workspace(tx: Conn<'_>, workspace_name: &str, user_id: &str) -> Result<()> {
    tx.execute(sql!(
        "INSERT INTO workspace (id, name) VALUES (1, {})
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = now()",
        workspace_name
    ))
    .await?;
    let group = tx
        .first(sql!(
            "INSERT INTO groups (name, description, is_default, created_by)
             VALUES ('Everyone', 'Every member of the workspace', true, {}) RETURNING id",
            user_id
        ))
        .await?
        .map(|r| r.str("id"))
        .unwrap_or_default();
    tx.execute(sql!("INSERT INTO group_members (group_id, user_id) VALUES ({}, {})", &group, user_id)).await?;
    let space = tx
        .first(sql!("INSERT INTO spaces (name, slug, created_by) VALUES ('General', 'general', {}) RETURNING id", user_id))
        .await?
        .map(|r| r.str("id"))
        .unwrap_or_default();
    tx.execute(sql!(
        "INSERT INTO space_members (space_id, user_id, role, added_by) VALUES ({}, {}, 'admin', {})",
        &space,
        user_id,
        user_id
    ))
    .await?;
    tx.execute(sql!("UPDATE workspace SET default_space_id = {} WHERE id = 1", &space)).await?;
    Ok(())
}
