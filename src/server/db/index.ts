import { SQL } from "bun";
import { log } from "server/lib/logger";
import initial from "./migrations/001_initial.sql" with { type: "text" };
import bases from "./migrations/002_bases.sql" with { type: "text" };
import cellTimeZone from "./migrations/003_cell_time_zone.sql" with { type: "text" };

/** Embedded at build time so the bundled server carries its migrations. */
export const migrations: { name: string; sql: string }[] = [
  { name: "001_initial", sql: initial },
  { name: "002_bases", sql: bases },
  { name: "003_cell_time_zone", sql: cellTimeZone },
];

export let sql: SQL;

/**
 * Bun.SQL does not understand libpq's `?host=/socket/dir` form (it would send
 * `host` as a server setting), so that is translated into an explicit socket
 * path. An explicit `url` is always passed because Bun otherwise falls back
 * to the raw `DATABASE_URL` environment variable.
 */
export const connectionOptions = (url: string, max: number): SQL.Options => {
  const parsed = new URL(url);
  const host = parsed.searchParams.get("host");
  if (host?.startsWith("/")) {
    const port = parsed.port || "5432";
    parsed.searchParams.delete("host");
    const username = parsed.username || encodeURIComponent(process.env.USER ?? "postgres");
    const auth = parsed.password ? `${username}:${parsed.password}` : username;
    const query = parsed.searchParams.size ? `?${parsed.searchParams}` : "";
    return {
      url: `${parsed.protocol}//${auth}@localhost:${port}${parsed.pathname}${query}`,
      path: `${host.replace(/\/+$/, "")}/.s.PGSQL.${port}`,
      max,
    };
  }
  return { url, max };
};

export const connect = (url: string, max: number): SQL => {
  sql = new SQL(connectionOptions(url, max));
  return sql;
};

export const disconnect = async () => {
  await sql?.close({ timeout: 5 });
};

export const migrate = async () => {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const applied = new Set((await sql`SELECT name FROM schema_migrations`).map((row: { name: string }) => row.name));
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(726354)`;
      const [done] = await tx`SELECT 1 FROM schema_migrations WHERE name = ${migration.name}`;
      if (done) return;
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO schema_migrations (name) VALUES (${migration.name})`;
    });
    log.info("migration applied", { name: migration.name });
  }
};
