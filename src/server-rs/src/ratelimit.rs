//! Port of `src/server/lib/ratelimit.ts`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::http::{http_error, Result};

const WINDOW: Duration = Duration::from_millis(60_000);
const MAX_TRACKED: usize = 10_000;

struct Bucket {
    count: u32,
    reset_at: Instant,
}

static BUCKETS: Mutex<Option<HashMap<String, Bucket>>> = Mutex::new(None);

/// Fixed one-minute window per `scope` + client IP; fails with 429 once `limit` is exceeded.
pub fn rate_limit(scope: &str, ip: &str, limit: u32) -> Result<()> {
    let now = Instant::now();
    let mut guard = BUCKETS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let buckets = guard.get_or_insert_with(HashMap::new);
    if buckets.len() > MAX_TRACKED {
        buckets.retain(|_, bucket| bucket.reset_at > now);
    }
    let bucket = buckets.entry(format!("{scope}:{ip}")).or_insert(Bucket { count: 0, reset_at: now + WINDOW });
    if bucket.reset_at <= now {
        *bucket = Bucket { count: 0, reset_at: now + WINDOW };
    }
    bucket.count += 1;
    if bucket.count > limit {
        return Err(http_error(429, "rate_limited", "Too many attempts. Try again in a minute."));
    }
    Ok(())
}

/// The default limit of `rateLimit(scope, ip)`.
pub const DEFAULT_LIMIT: u32 = 10;
