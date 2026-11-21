//! Port of `src/server/routes/groups.ts`.

use serde_json::{json, Value};

use crate::common::ids::is_uuid;
use crate::db::{array, db, Row, Sql};
use crate::http::{bad_request, conflict, empty, forbidden_with, get, http_error, not_found, post, read_json, Ctx, Reply, Result, Route};
use crate::permissions::require_workspace_admin;
use crate::realtime::hub::membership_changed;
use crate::users::{to_user, UserRow};
use crate::validate::{input, max, Input};
use crate::{handler, sql};

fn group_query() -> Sql {
    sql!(
        "
  SELECT g.id, g.name, g.description, g.is_default,
    (SELECT count(*)::int FROM group_members gm WHERE gm.group_id = g.id) AS member_count
  FROM groups g"
    )
}

/// `toGroup(row)`.
pub fn to_group(row: &Row) -> Value {
    json!({
        "id": row.str("id"),
        "name": row.str("name"),
        "description": row.opt_str("description"),
        "isDefault": row.bool("is_default"),
        "memberCount": row.i64("member_count"),
    })
}

/// `toGroup` for a group a query built with `json_build_object` (snake-case keys).
pub fn to_group_json(group: &Value) -> Value {
    json!({
        "id": group["id"],
        "name": group["name"],
        "description": group["description"],
        "isDefault": group["is_default"],
        "memberCount": group["member_count"].as_i64().unwrap_or(0),
    })
}

async fn find_group(id: &str) -> Result<Row> {
    if !is_uuid(id) {
        return Err(not_found("Group"));
    }
    db().first(sql!("{} WHERE g.id = {}", group_query(), id)).await?.ok_or_else(|| not_found("Group"))
}

async fn group_member_ids(group_id: &str) -> Result<Vec<String>> {
    Ok(db().query(sql!("SELECT user_id FROM group_members WHERE group_id = {}", group_id)).await?.iter().map(|r| r.str("user_id")).collect())
}

async fn list(_ctx: &mut Ctx) -> Result<Reply> {
    let rows = db().query(sql!("{} ORDER BY g.is_default DESC, lower(g.name)", group_query())).await?;
    Ok(Value::Array(rows.iter().map(to_group).collect()).into())
}

async fn create(ctx: &mut Ctx) -> Result<Reply> {
    require_workspace_admin(ctx.user())?;
    let body = input(read_json(ctx).await?);
    let name = body.string("name", max(100))?;
    let description = body.nullable_string("description", max(500))?.into_option();
    let inserted = db()
        .first(sql!("INSERT INTO groups (name, description, created_by) VALUES ({}, {}, {}) RETURNING id", &name, description, &ctx.user().id))
        .await;
    match inserted {
        Ok(row) => {
            let id = row.map(|r| r.str("id")).unwrap_or_default();
            Ok(json!({ "group": to_group(&find_group(&id).await?) }).into())
        }
        Err(error) if error.is_unique_violation() => Err(conflict("name_taken", "A group with this name already exists")),
        Err(error) => Err(error.into()),
    }
}

async fn update(ctx: &mut Ctx) -> Result<Reply> {
    require_workspace_admin(ctx.user())?;
    let group = find_group(ctx.param("id")).await?;
    let body = input(read_json(ctx).await?);
    let name = body.optional_string("name", max(100))?;
    let description = body.nullable_string("description", max(500))?;
    if group.bool("is_default") && name.as_ref().is_some_and(|n| *n != group.str("name")) {
        return Err(forbidden_with("The default group cannot be renamed"));
    }
    let group_id = group.str("id");
    let updated = db()
        .execute(sql!(
            "UPDATE groups SET
               name = COALESCE({}, name),
               description = CASE WHEN {} THEN {} ELSE description END,
               updated_at = now()
             WHERE id = {}",
            name,
            description.is_given(),
            description.into_option(),
            &group_id
        ))
        .await;
    match updated {
        Ok(()) => Ok(json!({ "group": to_group(&find_group(&group_id).await?) }).into()),
        Err(error) if error.is_unique_violation() => Err(conflict("name_taken", "A group with this name already exists")),
        Err(error) => Err(error.into()),
    }
}

async fn delete(ctx: &mut Ctx) -> Result<Reply> {
    require_workspace_admin(ctx.user())?;
    let group = find_group(ctx.param("id")).await?;
    if group.bool("is_default") {
        return Err(forbidden_with("The default group cannot be deleted"));
    }
    let group_id = group.str("id");
    let members = group_member_ids(&group_id).await?;
    db().execute(sql!("DELETE FROM groups WHERE id = {}", &group_id)).await?;
    membership_changed(members);
    empty()
}

async fn members(ctx: &mut Ctx) -> Result<Reply> {
    let group = find_group(ctx.param("id")).await?;
    let query = Input::query(ctx);
    let limit = query.integer("limit", 1, 500)?.unwrap_or(50);
    let offset = query.integer("offset", 0, 1_000_000)?.unwrap_or(0);
    let rows = db()
        .query(sql!(
            "SELECT u.* FROM group_members gm JOIN users u ON u.id = gm.user_id
             WHERE gm.group_id = {} ORDER BY lower(u.name), u.id LIMIT {} OFFSET {}",
            group.str("id"),
            limit,
            offset
        ))
        .await?;
    let viewer = &ctx.user().id;
    let items: Vec<Value> = rows.iter().map(|row| Value::Object(to_user(&UserRow::from_row(row), Some(viewer)))).collect();
    Ok(json!({ "items": items, "total": group.i64("member_count") }).into())
}

async fn add_members(ctx: &mut Ctx) -> Result<Reply> {
    require_workspace_admin(ctx.user())?;
    let group = find_group(ctx.param("id")).await?;
    let user_ids = input(read_json(ctx).await?).uuids("userIds", 100)?.filter(|ids| !ids.is_empty());
    let Some(user_ids) = user_ids else { return Err(bad_request("userIds is required")) };
    db().execute(sql!(
        "INSERT INTO group_members (group_id, user_id)
         SELECT {}, id FROM users WHERE id = ANY({}::uuid[])
         ON CONFLICT DO NOTHING",
        group.str("id"),
        array(&user_ids)
    ))
    .await?;
    membership_changed(user_ids);
    empty()
}

async fn remove_member(ctx: &mut Ctx) -> Result<Reply> {
    require_workspace_admin(ctx.user())?;
    let group = find_group(ctx.param("id")).await?;
    let user_id = input(read_json(ctx).await?).uuid("userId")?;
    if group.bool("is_default") {
        return Err(http_error(403, "forbidden", "Members cannot be removed from the default group"));
    }
    db().execute(sql!("DELETE FROM group_members WHERE group_id = {} AND user_id = {}", group.str("id"), &user_id)).await?;
    membership_changed(vec![user_id]);
    empty()
}

pub fn routes() -> Vec<Route> {
    vec![
        get("/groups", handler!(list)),
        post("/groups", handler!(create)),
        post("/groups/:id/update", handler!(update)),
        post("/groups/:id/delete", handler!(delete)),
        get("/groups/:id/members", handler!(members)),
        post("/groups/:id/members/add", handler!(add_members)),
        post("/groups/:id/members/remove", handler!(remove_member)),
    ]
}
