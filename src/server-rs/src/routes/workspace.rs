//! Port of `src/server/routes/workspace.ts`.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::db::{array, db};
use crate::files::{remove_image, save_image};
use crate::http::{bad_request, form_file, post, public_get, read_form, read_json, Ctx, Reply, Result, Route};
use crate::jsutil::{is_integer, js_number, utf16_len};
use crate::permissions::require_workspace_admin;
use crate::spaces::get_workspace;
use crate::users::image_url;
use crate::validate::{input, max};
use crate::{handler, sql};

fn is_domain(value: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$").expect("domain pattern"));
    (1..=253).contains(&utf16_len(value)) && re.is_match(value)
}

fn parse_settings(raw: &Map<String, Value>) -> Result<Map<String, Value>> {
    let mut out = Map::new();
    if let Some(value) = raw.get("sharingDisabled") {
        if !value.is_boolean() {
            return Err(bad_request("settings.sharingDisabled must be a boolean"));
        }
        out.insert("sharingDisabled".into(), value.clone());
    }
    if let Some(days) = raw.get("trashRetentionDays") {
        let n = js_number(days);
        if !days.is_number() || !is_integer(days) || !(1.0..=3650.0).contains(&n) {
            return Err(bad_request("settings.trashRetentionDays must be an integer between 1 and 3650"));
        }
        out.insert("trashRetentionDays".into(), days.clone());
    }
    if let Some(value) = raw.get("defaultPageEditMode") {
        if value != "read" && value != "edit" {
            return Err(bad_request("settings.defaultPageEditMode must be read or edit"));
        }
        out.insert("defaultPageEditMode".into(), value.clone());
    }
    Ok(out)
}

async fn public_info(_ctx: &mut Ctx) -> Result<Reply> {
    let row = db().first(sql!("SELECT name, logo FROM workspace WHERE id = 1")).await?;
    Ok(match row {
        Some(row) => json!({ "name": row.str("name"), "logoUrl": image_url(row.opt_str("logo").as_deref()) }),
        None => json!({ "name": "", "logoUrl": null }),
    }
    .into())
}

async fn update(ctx: &mut Ctx) -> Result<Reply> {
    require_workspace_admin(ctx.user())?;
    let body = input(read_json(ctx).await?);
    let name = body.optional_string("name", max(100))?;
    let description = body.nullable_string("description", max(500))?;
    let domains = body
        .strings("emailDomains", 50, max(253))?
        .map(|list| list.iter().map(|d| d.to_lowercase()).map(|d| d.strip_prefix('@').map(str::to_string).unwrap_or(d)).collect::<Vec<_>>());
    if domains.as_ref().is_some_and(|list| list.iter().any(|d| !is_domain(d))) {
        return Err(bad_request("emailDomains must contain valid domain names"));
    }
    let settings = body.object("settings")?.map(parse_settings).transpose()?;
    let unique_domains = domains.map(|list| {
        let mut unique: Vec<String> = Vec::new();
        for domain in list {
            if !unique.contains(&domain) {
                unique.push(domain);
            }
        }
        array(&unique)
    });
    db().execute(sql!(
        "UPDATE workspace SET
           name = COALESCE({}, name),
           description = CASE WHEN {} THEN {} ELSE description END,
           email_domains = COALESCE({}::text[], email_domains),
           settings = settings || {}::jsonb,
           updated_at = now()
         WHERE id = 1",
        name,
        description.is_given(),
        description.into_option(),
        unique_domains,
        Value::Object(settings.unwrap_or_default())
    ))
    .await?;
    Ok(json!({ "workspace": get_workspace().await? }).into())
}

async fn logo(ctx: &mut Ctx) -> Result<Reply> {
    require_workspace_admin(ctx.user())?;
    let form = read_form(ctx, 11 * 1024 * 1024).await?;
    let name = save_image(&form_file(&form, "file")?, "workspace-logo", &ctx.user().id, None).await?;
    let previous = db()
        .first(sql!(
            "UPDATE workspace w SET logo = {}, updated_at = now() FROM workspace old
             WHERE w.id = 1 AND old.id = 1 RETURNING old.logo",
            &name
        ))
        .await?;
    remove_image(previous.and_then(|r| r.opt_str("logo")).as_deref()).await?;
    Ok(json!({ "workspace": get_workspace().await? }).into())
}

async fn remove_logo(ctx: &mut Ctx) -> Result<Reply> {
    require_workspace_admin(ctx.user())?;
    let previous = db().first(sql!("SELECT logo FROM workspace WHERE id = 1")).await?;
    db().execute(sql!("UPDATE workspace SET logo = NULL, updated_at = now() WHERE id = 1")).await?;
    remove_image(previous.and_then(|r| r.opt_str("logo")).as_deref()).await?;
    Ok(json!({ "workspace": get_workspace().await? }).into())
}

pub fn routes() -> Vec<Route> {
    vec![
        public_get("/workspace/public", handler!(public_info)),
        post("/workspace/update", handler!(update)),
        post("/workspace/logo", handler!(logo)),
        post("/workspace/logo/remove", handler!(remove_logo)),
    ]
}
