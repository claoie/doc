//! Port of `src/server/realtime/leader.ts`.
//!
//! A page being edited needs one authority (see collab.rs), but a rolling
//! deploy runs two copies of the server side by side. So one copy at a time
//! leads realtime: it holds a lease in the database, and only it accepts
//! sockets and content replacements. The rest of the API works on every copy.
//!
//! The lease is a row rather than an advisory lock: a lock goes with its
//! connection, and the holder would only learn that at its next query, after
//! a successor may have started. A leader stops counting on its lease
//! LEASE_MS after it last asked to renew, which is never later than the row
//! expires, so a successor can't start while this copy still believes it leads.

use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use crate::common::ids::uuid;
use crate::db::{db, DbError};
use crate::logger;
use crate::sql;

const LEASE: Duration = Duration::from_millis(10_000);
const RENEW: Duration = Duration::from_millis(3_000);
const POLL: Duration = Duration::from_millis(1_000);

#[derive(Default)]
struct State {
    lead_until: Option<Instant>,
    running: bool,
    leading: bool,
    /// Bumped whenever the pending lapse check is replaced or cancelled.
    lapse: u64,
    /// Bumped by `stop_leading`, so a loop from an earlier start stops.
    generation: u64,
    on_lost: Option<fn()>,
}

fn state() -> MutexGuard<'static, State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(Mutex::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn holder() -> &'static str {
    static HOLDER: OnceLock<String> = OnceLock::new();
    HOLDER.get_or_init(uuid)
}

/// The latest claim. A release waits for it, or the claim could land after and put the row back.
fn claiming() -> &'static tokio::sync::Mutex<()> {
    static CLAIMING: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    CLAIMING.get_or_init(Default::default)
}

pub fn is_leader() -> bool {
    state().lead_until.is_some_and(|until| Instant::now() < until)
}

/// Registers what to do when this copy stops leading while it runs: its lease ran out or was taken.
pub fn on_lead_lost(listener: fn()) {
    state().on_lost = Some(listener);
}

/// Notices when leading starts or stops: after each claim, and when the lease runs out.
fn check() {
    let lost = {
        let mut s = state();
        s.lapse += 1;
        let leads = s.lead_until.is_some_and(|until| Instant::now() < until);
        let mut lost = None;
        if leads != s.leading {
            s.leading = leads;
            logger::info(if leads { "leading realtime" } else { "no longer leading realtime" });
            if !leads {
                lost = s.on_lost;
            }
        }
        if s.leading {
            // Fires when the lease would run out, since a renewal can hang past it.
            if let Some(until) = s.lead_until {
                let lapse = s.lapse;
                tokio::spawn(async move {
                    tokio::time::sleep_until((until + Duration::from_millis(1)).into()).await;
                    if state().lapse == lapse {
                        check();
                    }
                });
            }
        }
        lost
    };
    if let Some(listener) = lost {
        listener();
    }
}

async fn claim() -> Result<(), DbError> {
    let asked = Instant::now();
    let rows = db()
        .query(sql!(
            "INSERT INTO realtime_leader (holder, expires_at)
             VALUES ({}, now() + {}::float8 * interval '1 second')
             ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
             WHERE realtime_leader.holder = excluded.holder OR realtime_leader.expires_at < now()
             RETURNING holder",
            holder(),
            LEASE.as_secs_f64()
        ))
        .await?;
    let mut s = state();
    s.lead_until = if !rows.is_empty() && s.running { Some(asked + LEASE) } else { None };
    Ok(())
}

async fn tick() {
    {
        let _claiming = claiming().lock().await;
        if let Err(error) = claim().await {
            logger::error("claiming the realtime lease failed", &error);
        }
    }
    check();
}

/// Tries for the lease now, then keeps renewing it or waiting for it.
pub async fn start_leading() {
    let generation = {
        let mut s = state();
        s.running = true;
        s.generation += 1;
        s.generation
    };
    tick().await;
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(if is_leader() { RENEW } else { POLL }).await;
            {
                let s = state();
                if !s.running || s.generation != generation {
                    return;
                }
            }
            tick().await;
        }
    });
}

/// Stops acting as leader. The lease stays held, so no successor starts
/// until `release_lease`, once this copy has saved what it holds.
pub fn stop_leading() {
    let mut s = state();
    s.running = false;
    s.lead_until = None;
    s.leading = false;
    s.lapse += 1;
    s.generation += 1;
}

pub async fn release_lease() -> Result<(), DbError> {
    let _claiming = claiming().lock().await;
    db().execute(sql!("DELETE FROM realtime_leader WHERE holder = {}", holder())).await
}
