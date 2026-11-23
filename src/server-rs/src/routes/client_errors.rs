//! Port of `src/server/routes/client-errors.ts`.

use serde_json::{Map, Value};

use crate::handler;
use crate::http::{empty, post, read_json, Ctx, Reply, Result, Route};
use crate::logger;
use crate::ratelimit::{rate_limit, DEFAULT_LIMIT};
use crate::validate::{input, max, StringRule};

/// An error the web app did not handle, logged at error level and so sent on to the alarm webhook.
async fn client_error(ctx: &mut Ctx) -> Result<Reply> {
    rate_limit("client-error", &ctx.ip, DEFAULT_LIMIT)?;
    let body = input(read_json(ctx).await?);
    let message = body.string("message", max(1000))?;
    let url = body.optional_string("url", max(1000))?;
    let stack = body.optional_string("stack", StringRule { min: None, max: 4000, trim: false })?;
    let mut fields = Map::new();
    fields.insert("message".into(), Value::String(message));
    if let Some(url) = url {
        fields.insert("url".into(), Value::String(url));
    }
    if let Some(stack) = stack {
        fields.insert("stack".into(), Value::String(stack));
    }
    fields.insert("userId".into(), Value::String(ctx.user().id.clone()));
    logger::error_fields("client error", Value::Object(fields));
    empty()
}

pub fn routes() -> Vec<Route> {
    vec![post("/client-error", handler!(client_error))]
}
