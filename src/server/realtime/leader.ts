import { sql } from "server/db";
import { log } from "server/lib/logger";

/**
 * A page being edited needs one authority (see collab.ts), but a rolling
 * deploy runs two copies of the server side by side. So one copy at a time
 * leads realtime: it holds a lease in the database, and only it accepts
 * sockets and content replacements. The rest of the API works on every copy.
 *
 * The lease is a row rather than an advisory lock: a lock goes with its
 * connection, and the holder would only learn that at its next query, after
 * a successor may have started. A leader stops counting on its lease
 * LEASE_MS after it last asked to renew, which is never later than the row
 * expires, so a successor can't start while this copy still believes it leads.
 */
const LEASE_MS = 10_000;
const RENEW_MS = 3_000;
const POLL_MS = 1_000;

const holder = crypto.randomUUID();
let leadUntil = 0;
let running = false;
let leading = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** The latest claim. A release waits for it, or the claim could land after and put the row back. */
let claiming: Promise<void> = Promise.resolve();

export const isLeader = () => performance.now() < leadUntil;

const claim = async () => {
  const asked = performance.now();
  const rows = await sql`
    INSERT INTO realtime_leader (holder, expires_at)
    VALUES (${holder}, now() + ${LEASE_MS / 1000}::float8 * interval '1 second')
    ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
    WHERE realtime_leader.holder = excluded.holder OR realtime_leader.expires_at < now()
    RETURNING holder`;
  leadUntil = rows.length && running ? asked + LEASE_MS : 0;
};

const tick = async () => {
  claiming = claim().catch((error) => log.error("claiming the realtime lease failed", error));
  await claiming;
  if (isLeader() !== leading) {
    leading = !leading;
    log.info(leading ? "leading realtime" : "no longer leading realtime");
  }
  if (!running) return;
  timer = setTimeout(() => void tick(), isLeader() ? RENEW_MS : POLL_MS);
  timer.unref();
};

/** Tries for the lease now, then keeps renewing it or waiting for it. */
export const startLeading = async () => {
  running = true;
  await tick();
};

/**
 * Stops acting as leader. The lease stays held, so no successor starts
 * until `releaseLease`, once this copy has saved what it holds.
 */
export const stopLeading = () => {
  running = false;
  leadUntil = 0;
  leading = false;
  if (timer) clearTimeout(timer);
  timer = null;
};

export const releaseLease = async () => {
  await claiming;
  await sql`DELETE FROM realtime_leader WHERE holder = ${holder}`;
};
