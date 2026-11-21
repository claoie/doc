//! Port of `src/server/routes/spaces.ts`.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::common::ids::is_uuid;
use crate::db::{array, begin, db, Row};
use crate::files::{remove_image, save_image};
use crate::http::{bad_request, conflict, empty, forbidden_with, form_file, get, http_error, not_found, post, read_form, read_json, Ctx, Reply, Result, Route};
use crate::permissions::{is_workspace_admin, require_space_manager, require_workspace_admin};
use crate::realtime::hub::membership_changed;
use crate::routes::groups::to_group_json;
use crate::spaces::{find_space, space_query, to_space};
use crate::storage;
use crate::users::{to_user, UserRow};
use crate::validate::{input, max, min_max, StringRule};
use crate::{handler, sql};

const ROLES: &[&str] = &["admin", "writer", "reader"];
const SLUG_RULE: StringRule = min_max(2, 50);

fn parse_slug(value: &str) -> Result<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^[a-z0-9-]{2,50}$").expect("slug pattern"));
    let slug = value.to_lowercase();
    if !re.is_match(&slug) {
        return Err(bad_request("slug must be 2–50 characters of a-z, 0-9 and -"));
    }
    Ok(slug)
}

async fn space_by_id(user_id: &str, id: &str) -> Result<Row> {
    if !is_uuid(id) {
        return Err(not_found("Space"));
    }
    find_space(user_id, id).await?.ok_or_else(|| not_found("Space"))
}

/// User ids affected by a space membership row (the user, or every member of the group).
async fn affected_users(space_member_ids: &[String]) -> Result<Vec<String>> {
    let rows = db()
        .query(sql!(
            "SELECT sm.user_id FROM space_members sm WHERE sm.id = ANY({}::uuid[]) AND sm.user_id IS NOT NULL
             UNION
             SELECT gm.user_id FROM space_members sm JOIN group_members gm ON gm.group_id = sm.group_id
             WHERE sm.id = ANY({}::uuid[])",
            array(space_member_ids),
            array(space_member_ids)
        ))
        .await?;
    Ok(rows.iter().map(|r| r.str("user_id")).collect())
}

async fn space_reply(user_id: &str, space_id: &str) -> Result<Reply> {
    Ok(json!({ "space": to_space(&space_by_id(user_id, space_id).await?) }).into())
}

async fn list(ctx: &mut Ctx) -> Result<Reply> {
    let rows = db().query(sql!("SELECT * FROM ({}) s WHERE s.rank IS NOT NULL ORDER BY lower(s.name), s.id", space_query(&ctx.user().id))).await?;
    Ok(Value::Array(rows.iter().map(to_space).collect()).into())
}

async fn list_all(ctx: &mut Ctx) -> Result<Reply> {
    require_workspace_admin(ctx.user())?;
    let rows = db().query(sql!("{} ORDER BY lower(s.name), s.id", space_query(&ctx.user().id))).await?;
    Ok(Value::Array(rows.iter().map(to_space).collect()).into())
}

async fn create(ctx: &mut Ctx) -> Result<Reply> {
    let body = input(read_json(ctx).await?);
    let name = body.string("name", max(100))?;
    let slug = parse_slug(&body.string("slug", SLUG_RULE)?)?;
    let description = body.nullable_string("description", max(500))?.into_option();
    let user_id = ctx.user().id.clone();
    let created = begin(async |tx| -> Result<String> {
        let space = tx
            .first(sql!(
                "INSERT INTO spaces (name, slug, description, created_by) VALUES ({}, {}, {}, {})
                 RETURNING id",
                &name,
                &slug,
                description.clone(),
                &user_id
            ))
            .await?;
        let id = space.map(|s| s.str("id")).unwrap_or_default();
        tx.execute(sql!("INSERT INTO space_members (space_id, user_id, role, added_by) VALUES ({}, {}, 'admin', {})", &id, &user_id, &user_id)).await?;
        Ok(id)
    })
    .await;
    match created {
        Ok(id) => {
            membership_changed(vec![user_id.clone()]);
            space_reply(&user_id, &id).await
        }
        Err(error) if error.is_unique_violation() => Err(conflict("slug_taken", "That slug is already in use")),
        Err(error) => Err(error),
    }
}

async fn show(ctx: &mut Ctx) -> Result<Reply> {
    let space = find_space(&ctx.user().id, ctx.param("space")).await?;
    match space {
        Some(space) if !space.is_null("rank") || is_workspace_admin(ctx.user()) => Ok(json!({ "space": to_space(&space) }).into()),
        _ => Err(not_found("Space")),
    }
}

async fn update(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let space = space_by_id(&user.id, ctx.param("id")).await?;
    let space_id = space.str("id");
    require_space_manager(&user, &space_id).await?;
    let body = input(read_json(ctx).await?);
    let name = body.optional_string("name", max(100))?;
    let slug = body.optional_string("slug", SLUG_RULE)?.map(|s| parse_slug(&s)).transpose()?;
    let description = body.nullable_string("description", max(500))?;
    let mut settings = Map::new();
    if let Some(value) = body.object("settings")?.and_then(|s| s.get("sharingDisabled")) {
        if !value.is_boolean() {
            return Err(bad_request("settings.sharingDisabled must be a boolean"));
        }
        settings.insert("sharingDisabled".into(), value.clone());
    }
    let sharing_disabled = settings.get("sharingDisabled") == Some(&Value::Bool(true));
    let updated = begin(async |tx| -> Result<()> {
        tx.execute(sql!(
            "UPDATE spaces SET
               name = COALESCE({}, name),
               slug = COALESCE({}, slug),
               description = CASE WHEN {} THEN {} ELSE description END,
               settings = settings || {}::jsonb,
               updated_at = now()
             WHERE id = {}",
            name.clone(),
            slug.clone(),
            description.is_given(),
            description.clone().into_option(),
            Value::Object(settings.clone()),
            &space_id
        ))
        .await?;
        if sharing_disabled {
            tx.execute(sql!("DELETE FROM shares WHERE page_id IN (SELECT id FROM pages WHERE space_id = {})", &space_id)).await?;
        }
        Ok(())
    })
    .await;
    match updated {
        Ok(()) => space_reply(&user.id, &space_id).await,
        Err(error) if error.is_unique_violation() => Err(conflict("slug_taken", "That slug is already in use")),
        Err(error) => Err(error),
    }
}

async fn delete(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let space_id = space_by_id(&user.id, ctx.param("id")).await?.str("id");
    require_space_manager(&user, &space_id).await?;
    let members: Vec<String> = db().query(sql!("SELECT id FROM space_members WHERE space_id = {}", &space_id)).await?.iter().map(|m| m.str("id")).collect();
    let affected = affected_users(&members).await?;
    let rows = db()
        .query(sql!(
            "WITH removed_files AS (
               DELETE FROM files WHERE space_id = {} OR page_id IN (SELECT id FROM pages WHERE space_id = {})
               RETURNING storage_key
             ),
             removed_space AS (DELETE FROM spaces WHERE id = {})
             SELECT storage_key FROM removed_files",
            &space_id,
            &space_id,
            &space_id
        ))
        .await?;
    storage::remove_many(&rows.iter().map(|r| r.str("storage_key")).collect::<Vec<_>>()).await?;
    membership_changed(affected);
    empty()
}

async fn icon(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let space = space_by_id(&user.id, ctx.param("id")).await?;
    let space_id = space.str("id");
    require_space_manager(&user, &space_id).await?;
    let form = read_form(ctx, 11 * 1024 * 1024).await?;
    let name = save_image(&form_file(&form, "file")?, "space-icon", &user.id, Some(&space_id)).await?;
    db().execute(sql!("UPDATE spaces SET icon = {}, updated_at = now() WHERE id = {}", &name, &space_id)).await?;
    remove_image(space.opt_str("icon").as_deref()).await?;
    space_reply(&user.id, &space_id).await
}

async fn remove_icon(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let space = space_by_id(&user.id, ctx.param("id")).await?;
    let space_id = space.str("id");
    require_space_manager(&user, &space_id).await?;
    db().execute(sql!("UPDATE spaces SET icon = NULL, updated_at = now() WHERE id = {}", &space_id)).await?;
    remove_image(space.opt_str("icon").as_deref()).await?;
    space_reply(&user.id, &space_id).await
}

async fn members(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let space = space_by_id(&user.id, ctx.param("id")).await?;
    if space.is_null("rank") && !is_workspace_admin(&user) {
        return Err(not_found("Space"));
    }
    let rows = db()
        .query(sql!(
            "SELECT sm.id, sm.role,
               CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object(
                 'id', u.id, 'email', u.email, 'name', u.name, 'avatar', u.avatar, 'role', u.role, 'locale', u.locale,
                 'timezone', u.timezone, 'preferences', '{{}}'::json, 'created_at', u.created_at,
                 'last_login_at', u.last_login_at, 'deactivated_at', u.deactivated_at) END AS \"user\",
               CASE WHEN g.id IS NULL THEN NULL ELSE json_build_object(
                 'id', g.id, 'name', g.name, 'description', g.description, 'is_default', g.is_default,
                 'member_count', (SELECT count(*) FROM group_members gm WHERE gm.group_id = g.id)) END AS \"group\"
             FROM space_members sm
             LEFT JOIN users u ON u.id = sm.user_id
             LEFT JOIN groups g ON g.id = sm.group_id
             WHERE sm.space_id = {}
             ORDER BY sm.group_id IS NULL, lower(coalesce(g.name, u.name)), sm.id",
            space.str("id")
        ))
        .await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut member = Map::new();
            member.insert("id".into(), r.value("id"));
            member.insert("role".into(), r.value("role"));
            if let Some(member_user) = r.opt_json("user").filter(|u| !u.is_null()) {
                member.insert("user".into(), Value::Object(to_user(&UserRow::from_json(&member_user), Some(&user.id))));
            }
            if let Some(group) = r.opt_json("group").filter(|g| !g.is_null()) {
                member.insert("group".into(), to_group_json(&group));
            }
            Value::Object(member)
        })
        .collect();
    Ok(Value::Array(list).into())
}

async fn add_members(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let space_id = space_by_id(&user.id, ctx.param("id")).await?.str("id");
    require_space_manager(&user, &space_id).await?;
    let body = input(read_json(ctx).await?);
    let Some(role) = body.one_of("role", ROLES)? else { return Err(bad_request("role is required")) };
    let user_ids = body.uuids("userIds", 25)?.unwrap_or_default();
    let group_ids = body.uuids("groupIds", 25)?.unwrap_or_default();
    if user_ids.is_empty() && group_ids.is_empty() {
        return Err(bad_request("userIds or groupIds is required"));
    }
    begin(async |tx| -> Result<()> {
        if !user_ids.is_empty() {
            tx.execute(sql!(
                "INSERT INTO space_members (space_id, user_id, role, added_by)
                 SELECT {}::uuid, id, {}::text, {}::uuid FROM users WHERE id = ANY({}::uuid[])
                 ON CONFLICT (space_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET role = excluded.role",
                &space_id,
                &role,
                &user.id,
                array(&user_ids)
            ))
            .await?;
        }
        if !group_ids.is_empty() {
            tx.execute(sql!(
                "INSERT INTO space_members (space_id, group_id, role, added_by)
                 SELECT {}::uuid, id, {}::text, {}::uuid FROM groups WHERE id = ANY({}::uuid[])
                 ON CONFLICT (space_id, group_id) WHERE group_id IS NOT NULL DO UPDATE SET role = excluded.role",
                &space_id,
                &role,
                &user.id,
                array(&group_ids)
            ))
            .await?;
        }
        Ok(())
    })
    .await?;
    let group_users = db().query(sql!("SELECT user_id FROM group_members WHERE group_id = ANY({}::uuid[])", array(&group_ids))).await?;
    let mut changed = user_ids;
    changed.extend(group_users.iter().map(|r| r.str("user_id")));
    membership_changed(changed);
    empty()
}

async fn member_role(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let space_id = space_by_id(&user.id, ctx.param("id")).await?.str("id");
    require_space_manager(&user, &space_id).await?;
    let body = input(read_json(ctx).await?);
    let member_id = body.uuid("memberId")?;
    let Some(role) = body.one_of("role", ROLES)? else { return Err(bad_request("role is required")) };
    begin(async |tx| -> Result<()> {
        let member = tx.first(sql!("SELECT id, role FROM space_members WHERE id = {} AND space_id = {} FOR UPDATE", &member_id, &space_id)).await?;
        let Some(member) = member else { return Err(not_found("Space member")) };
        if member.str("role") == "admin" && role != "admin" {
            let admins = tx
                .first(sql!("SELECT count(*)::int AS admins FROM space_members WHERE space_id = {} AND role = 'admin'", &space_id))
                .await?
                .map_or(0, |r| r.i64("admins"));
            if admins <= 1 {
                return Err(forbidden_with("The last space admin cannot be demoted"));
            }
        }
        tx.execute(sql!("UPDATE space_members SET role = {} WHERE id = {}", &role, &member_id)).await?;
        Ok(())
    })
    .await?;
    membership_changed(affected_users(&[member_id]).await?);
    empty()
}

async fn remove_member(ctx: &mut Ctx) -> Result<Reply> {
    let user = ctx.user().clone();
    let space_id = space_by_id(&user.id, ctx.param("id")).await?.str("id");
    require_space_manager(&user, &space_id).await?;
    let member_id = input(read_json(ctx).await?).uuid("memberId")?;
    let affected = affected_users(std::slice::from_ref(&member_id)).await?;
    begin(async |tx| -> Result<()> {
        let member = tx.first(sql!("SELECT id, role FROM space_members WHERE id = {} AND space_id = {} FOR UPDATE", &member_id, &space_id)).await?;
        let Some(member) = member else { return Err(not_found("Space member")) };
        if member.str("role") == "admin" {
            let admins = tx
                .first(sql!("SELECT count(*)::int AS admins FROM space_members WHERE space_id = {} AND role = 'admin'", &space_id))
                .await?
                .map_or(0, |r| r.i64("admins"));
            if admins <= 1 {
                return Err(http_error(403, "forbidden", "The last space admin cannot be removed"));
            }
        }
        tx.execute(sql!("DELETE FROM space_members WHERE id = {}", &member_id)).await?;
        Ok(())
    })
    .await?;
    membership_changed(affected);
    empty()
}

pub fn routes() -> Vec<Route> {
    vec![
        get("/spaces", handler!(list)),
        get("/spaces/all", handler!(list_all)),
        post("/spaces", handler!(create)),
        get("/spaces/:space", handler!(show)),
        post("/spaces/:id/update", handler!(update)),
        post("/spaces/:id/delete", handler!(delete)),
        post("/spaces/:id/icon", handler!(icon)),
        post("/spaces/:id/icon/remove", handler!(remove_icon)),
        get("/spaces/:id/members", handler!(members)),
        post("/spaces/:id/members/add", handler!(add_members)),
        post("/spaces/:id/members/role", handler!(member_role)),
        post("/spaces/:id/members/remove", handler!(remove_member)),
    ]
}
