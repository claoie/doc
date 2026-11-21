import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect, databaseUrl, doc, sql, startServer, until, type TestServer } from "./harness";
import { ISO, errorEntry } from "./harness/logs";
import { createPage, hold, insertText, join, leads, leaseRows, sameSessionOn, sendSteps, storedPage, untilBlocked } from "./harness/realtime";

/**
 * The server as a process: what it logs when it starts, how it migrates the
 * database, how it reads its configuration, how it stops, and its request log.
 * Every test starts the servers it needs; they all share the one database.
 */

const MIGRATIONS = ["001_initial", "002_bases", "003_cell_time_zone", "004_realtime_leader", "005_sso"];
const servers: TestServer[] = [];

const start = async (options: Parameters<typeof startServer>[0] = {}) => {
  const server = await startServer(options);
  servers.push(server);
  return server;
};

const emptyDatabase = () => sql().unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");

const exitOf = (server: TestServer, timeoutMs = 20_000) =>
  Promise.race([server.exited, Bun.sleep(timeoutMs).then(() => "still running" as const)]);

// Every server holds database connections: none outlives the test that started it.
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("starting", () => {
  test("on an empty database it applies every migration in order, takes the realtime lease and listens", async () => {
    const t = await start();
    expect(t.logEntries()).toEqual([
      ...MIGRATIONS.map((name) => ({ t: expect.stringMatching(ISO), level: "info", msg: "migration applied", name })),
      { t: expect.stringMatching(ISO), level: "info", msg: "leading realtime" },
      { t: expect.stringMatching(ISO), level: "info", msg: "server started", port: t.port, staticDir: t.staticDir },
    ]);
    // Every line it wrote is one JSON object.
    expect(t.logs).toHaveLength(MIGRATIONS.length + 2);
    const applied = await t.sql`SELECT name, applied_at FROM schema_migrations ORDER BY applied_at, name`;
    expect(applied.map((row: { name: string }) => row.name)).toEqual(MIGRATIONS);
    expect(await leaseRows(t.sql)).toHaveLength(1);
    expect((await t.client().get("/setup")).body).toEqual({ data: { needsSetup: true } });
  });

  test("on a database that is migrated already it applies nothing, and the data is as it was left", async () => {
    const first = await start();
    const { owner, spaceId } = await first.setupOwner();
    const page = await createPage(owner, spaceId, doc("kept"));
    expect(await first.stop()).toBe(0);

    const again = await start({ keepDatabase: true });
    expect(again.logEntries().map((e) => e.msg)).toEqual(["leading realtime", "server started"]);
    // Sessions live in the database: the cookie of the first process still signs in.
    const sameOwner = sameSessionOn(again, owner);
    const read = await sameOwner.get(`/pages/${page.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data.page.content).toEqual(doc("kept"));
    expect((await again.sql`SELECT count(*)::int AS n FROM schema_migrations`)[0].n).toBe(MIGRATIONS.length);
  });

  test("without a built web app next to it, it says so and serves the API only", async () => {
    const t = await start({ withoutStatic: true });
    expect(t.logEntries().at(-1)).toEqual({ t: expect.stringMatching(ISO), level: "info", msg: "server started", port: t.port, staticDir: null });
    expect((await t.client().get("/health")).status).toBe(200);
  });

  test("two copies started at once on a database that is not migrated both come up, and one of them leads", async () => {
    await emptyDatabase();
    // The list of applied migrations is there, empty: the copies race for the migrations only (for the list itself, see the next test).
    await sql().unsafe("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const [a, b] = await Promise.all([start({ keepDatabase: true }), start({ keepDatabase: true })]);
    for (const server of [a, b]) {
      expect((await server.client().get("/health")).status).toBe(200);
      expect(server.logEntries().filter((e) => e.level === "error")).toEqual([]);
      expect(server.logEntries().at(-1)).toMatchObject({ msg: "server started", port: server.port });
    }
    const applied = await a.sql`SELECT name FROM schema_migrations ORDER BY name`;
    expect(applied.map((row: { name: string }) => row.name)).toEqual(MIGRATIONS);
    // Each migration ran once, whichever copy got to it first; both say so.
    const logged = new Set([...a.logEntries(), ...b.logEntries()].filter((e) => e.msg === "migration applied").map((e) => e.name));
    expect([...logged].sort()).toEqual(MIGRATIONS);
    const leading = [a, b].filter((server) => server.logEntries().some((e) => e.msg === "leading realtime"));
    expect(leading).toHaveLength(1);
    expect(await leaseRows(a.sql)).toHaveLength(1);
    // The workspace can be set up on either.
    const { owner } = await b.setupOwner();
    expect((await sameSessionOn(a, owner).get("/me")).status).toBe(200);
  }, 30_000);

  test("two copies started at once on a completely empty database: the database is migrated once, and a copy that lost the race starts when tried again", async () => {
    // Bug in the Bun server (reported, not pinned as wanted): creating the list of applied migrations is not
    // covered by the migration lock, so one of the two copies may exit with "startup failed". Both coming up
    // is what should happen and is accepted here; what is pinned is that the losing copy fails cleanly.
    await emptyDatabase();
    const copies = await Promise.all([start({ keepDatabase: true, expectExit: true }), start({ keepDatabase: true, expectExit: true })]);
    const outcome = (server: TestServer) =>
      until(
        async () => {
          const exited = await exitOf(server, 0);
          if (exited !== "still running") return { server, up: false, code: exited };
          const res = await fetch(`${server.base}/api/health`).catch(() => null);
          await res?.body?.cancel();
          return res?.ok ? { server, up: true, code: null } : null;
        },
        20_000,
        "the copy to come up or give up",
      );
    const outcomes = await Promise.all(copies.map(outcome));
    expect(outcomes.filter((o) => o.up).length).toBeGreaterThanOrEqual(1);
    for (const lost of outcomes.filter((o) => !o.up)) {
      expect(lost.code).toBe(1);
      expect(lost.server.logEntries().at(-1)).toMatchObject({ level: "error", msg: "startup failed" });
      const retried = await start({ keepDatabase: true });
      expect((await retried.client().get("/health")).status).toBe(200);
    }
    const applied = await copies[0]!.sql`SELECT name FROM schema_migrations ORDER BY name`;
    expect(applied.map((row: { name: string }) => row.name)).toEqual(MIGRATIONS);
    expect(await leaseRows(copies[0]!.sql)).toHaveLength(1);
  }, 60_000);
});

describe("DATABASE_URL", () => {
  test("a postgresql:// URL and an address instead of a host name are understood", async () => {
    const base = await start();
    const { owner } = await base.setupOwner();
    await base.stop();
    const url = new URL(databaseUrl);
    for (const variant of [databaseUrl.replace(/^postgres:/, "postgresql:"), databaseUrl.replace(`@${url.hostname}`, "@127.0.0.1")]) {
      const t = await start({ keepDatabase: true, env: { DATABASE_URL: variant } });
      expect([variant, (await sameSessionOn(t, owner).get("/me")).status]).toEqual([variant, 200]);
      await t.stop();
    }
  });

  /**
   * A socket directory of the suite's own: connections to `.s.PGSQL.<port>` in
   * it are passed on, byte for byte, to the address of the test database.
   */
  const socketDirectory = async (port: number) => {
    const dir = mkdtempSync(path.join(tmpdir(), "doc-api-pg-"));
    const target = new URL(databaseUrl);
    const targetDir = target.searchParams.get("host");
    let connections = 0;
    const server = net.createServer((client) => {
      connections++;
      const upstream = targetDir?.startsWith("/")
        ? net.connect(`${targetDir.replace(/\/+$/, "")}/.s.PGSQL.${target.port || "5432"}`)
        : net.connect(Number(target.port || "5432"), target.hostname);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve) => server.listen(path.join(dir, `.s.PGSQL.${port}`), resolve));
    return {
      dir,
      connections: () => connections,
      stop: () => {
        server.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };

  test("the form ?host=/socket/dir connects through the socket .s.PGSQL.<port> in that directory", async () => {
    const base = await start();
    const { owner } = await base.setupOwner();
    await base.stop();
    const url = new URL(databaseUrl);
    const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
    // Without a port in the URL the socket is the one of port 5432; the host name in the URL is not used.
    const standard = await socketDirectory(5432);
    // With a port, that port's socket; a slash at the end of the directory does not matter.
    const other = await socketDirectory(6543);
    try {
      const forms: [string, { connections: () => number }][] = [
        [`postgres://${auth}localhost${url.pathname}?host=${standard.dir}`, standard],
        [`postgres://${auth}nowhere.invalid:6543${url.pathname}?host=${other.dir}/`, other],
      ];
      for (const [DATABASE_URL, directory] of forms) {
        const t = await start({ keepDatabase: true, env: { DATABASE_URL } });
        expect([DATABASE_URL, (await sameSessionOn(t, owner).get("/me")).status]).toEqual([DATABASE_URL, 200]);
        expect(directory.connections()).toBeGreaterThan(0);
        expect(t.logEntries().map((e) => e.msg)).toEqual(["leading realtime", "server started"]);
        await t.stop();
      }
    } finally {
      standard.stop();
      other.stop();
    }
  });

  test("a server that cannot reach its database logs why and exits with 1", async () => {
    const url = new URL(databaseUrl);
    const unreachable: [string, string][] = [
      ["nothing listens there", `postgres://doc:doc@127.0.0.1:1/${url.pathname.slice(1)}`],
      ["the password is wrong", databaseUrl.replace(`:${url.password}@`, ":not-the-password@")],
      ["the database does not exist", databaseUrl.replace(url.pathname, "/doc_test_no_such_database")],
    ];
    for (const [label, DATABASE_URL] of unreachable) {
      const t = await start({ keepDatabase: true, expectExit: true, env: { DATABASE_URL } });
      expect([label, await exitOf(t)]).toEqual([label, 1]);
      expect(t.logEntries().map(errorEntry)).toEqual([{ t: expect.stringMatching(ISO), level: "error", msg: "startup failed" }]);
      expect(await fetch(`${t.base}/api/health`).then(() => "answered", () => "refused")).toBe("refused");
    }
  }, 60_000);
});

describe("stopping", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`on ${signal} it closes sockets with 1001, saves open documents, gives up the lease and exits with 0`, async () => {
      const t = await start();
      const { owner, spaceId } = await t.setupOwner();
      const page = await createPage(owner, spaceId, doc("hello"));
      const editor = await connect(owner);
      const idle = await connect(owner);
      await join(editor, page.id, 0);
      await sendSteps(editor, page.id, 0, [insertText(6, "!")]);
      expect(await leaseRows(t.sql)).toHaveLength(1);

      const code = await t.stop(signal);
      expect(code).toBe(0);
      expect(await editor.closed).toEqual({ code: 1001, reason: "server shutting down" });
      expect(await idle.closed).toEqual({ code: 1001, reason: "server shutting down" });
      // Well inside the two seconds a save normally waits: only the shutdown can have stored this.
      expect(await storedPage(t.sql, page.id)).toMatchObject({ doc_version: 1, content: doc("hello!") });
      expect(await leaseRows(t.sql)).toEqual([]);
      expect(t.logEntries().at(-1)).toEqual({ t: expect.stringMatching(ISO), level: "info", msg: "shutting down", signal });
      expect(t.logEntries().filter((e) => e.level !== "info")).toEqual([]);
      expect(await fetch(`${t.base}/api/health`).then(() => "answered", () => "refused")).toBe("refused");
    });
  }

  test("a step taken while an earlier save was still running is saved too before the process exits", async () => {
    const t = await start();
    const { owner, spaceId } = await t.setupOwner();
    const page = await createPage(owner, spaceId, doc("hello"));
    // Every save of this page takes a second.
    await t.sql.unsafe(`CREATE FUNCTION slow_page_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$`);
    await t.sql.unsafe(`CREATE TRIGGER slow_page_save BEFORE UPDATE OF content ON pages FOR EACH ROW WHEN (NEW.id = '${page.id}') EXECUTE FUNCTION slow_page_save()`);
    const editor = await connect(owner);
    await join(editor, page.id, 0);
    // A content replacement starts a save; while it runs the editor types, and then the signal comes.
    const replacing = owner.post(`/pages/${page.id}/content`, { content: doc("replaced") });
    await editor.nextOf("steps", { version: 1 });
    await sendSteps(editor, page.id, 1, [insertText(9, "!")]);
    expect((await storedPage(t.sql, page.id))!.doc_version).toBe(0);
    expect(await t.stop("SIGTERM")).toBe(0);
    expect(await storedPage(t.sql, page.id)).toMatchObject({ doc_version: 2, content: doc("replaced!") });
    expect((await replacing).status).toBe(200);
    expect(t.logEntries().filter((e) => e.level !== "info")).toEqual([]);
  });

  test("a request that is being answered when the signal comes is answered before the process exits", async () => {
    const t = await start();
    const { owner, spaceId } = await t.setupOwner();
    const page = await createPage(owner, spaceId, doc("hello"));
    // The page's row is held, so replacing its content waits in the middle of its save.
    const unlock = await hold(t.sql, `SELECT id FROM pages WHERE id = '${page.id}' FOR UPDATE`);
    try {
      const replacing = owner.post(`/pages/${page.id}/content`, { content: doc("replaced") });
      await untilBlocked(t.sql);
      const stopping = t.stop("SIGTERM");
      await until(() => t.logEntries().some((e) => e.msg === "shutting down"));
      // It no longer leads, and waits.
      expect(await leads(owner)).toBe(false);
      expect(await exitOf(t, 300)).toBe("still running");
      await unlock();
      const res = await replacing;
      expect(res.status).toBe(200);
      expect(res.body.data.page).toMatchObject({ docVersion: 1, content: doc("replaced") });
      expect(await stopping).toBe(0);
    } finally {
      await unlock();
    }
    expect(await storedPage(t.sql, page.id)).toMatchObject({ doc_version: 1, content: doc("replaced") });
    expect(await leaseRows(t.sql)).toEqual([]);
  });
});

describe("configuration", () => {
  test("PORT is the port it listens on; a fraction is cut off", async () => {
    // A port that was free a moment ago: the one a stopped server listened on.
    const earlier = await start();
    const port = earlier.port;
    await earlier.stop();
    // The harness would wait on a port of its own choosing, so it is told not to wait at all.
    const t = await start({ keepDatabase: true, expectExit: true, env: { PORT: `${port}.9` } });
    const health = await until(() => fetch(`http://localhost:${port}/api/health`).catch(() => null), 10_000, "the server to listen");
    expect(health.status).toBe(200);
    await health.body?.cancel();
    expect(t.logEntries().at(-1)).toEqual({ t: expect.stringMatching(ISO), level: "info", msg: "server started", port, staticDir: t.staticDir });
  });

  test("APP_URL is used without its trailing slashes, for links, for the socket's origin check and for the cookie", async () => {
    const t = await start({ env: { APP_URL: "https://docs.example.com//" } });
    const setup = await t.client().raw("POST", "/setup", {
      body: JSON.stringify({ workspaceName: "Acme", name: "Owner", email: "owner@example.com", password: "owner-password" }),
      headers: { "Content-Type": "application/json", Origin: "https://docs.example.com" },
    });
    expect(setup.status).toBe(200);
    // An https app marks its cookie Secure.
    expect(setup.headers.getSetCookie()).toEqual([expect.stringMatching(/^session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/)]);
    const owner = t.client();
    owner.cookie = /^session=([^;]+)/.exec(setup.headers.getSetCookie()[0]!)![1]!;
    const invited = await owner.post("/invitations", { emails: ["invited@example.com"], role: "member" });
    expect(invited.body.data[0].url).toMatch(/^https:\/\/docs\.example\.com\/invites\/[0-9a-f-]{36}\?token=/);
    await t.smtp.waitFor(1);
    expect(t.outbox[0]!.text).toContain("https://docs.example.com/invites/");
    expect(t.outbox[0]!.text).not.toContain("example.com//");

    const allowed = await connect(owner, { headers: { origin: "https://docs.example.com" } });
    await allowed.close();
    await expect(connect(owner, { headers: { origin: "http://doc.test" } })).rejects.toThrow();
  });

  test("without APP_URL the app is taken to be at http://localhost on its port", async () => {
    const t = await start({ env: { APP_URL: undefined } });
    const { owner } = await t.setupOwner();
    const invited = await owner.post("/invitations", { emails: ["invited@example.com"], role: "member" });
    expect(invited.body.data[0].url).toMatch(new RegExp(`^http://localhost:${t.port}/invites/`));
    // Not an https app: no Secure cookie.
    const login = await t.client().raw("POST", "/auth/login", {
      body: JSON.stringify({ email: "owner@example.com", password: "owner-password" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(login.headers.getSetCookie()).toEqual([expect.stringMatching(/^session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/)]);
  });

  test("TRUST_PROXY is on for 1, true, yes and on in any case, and off otherwise", async () => {
    const base = await start({ env: { TRUST_PROXY: undefined } });
    await base.setupOwner();
    const addressSeenBy = async (server: TestServer) => {
      const client = server.client({ ip: "203.0.113.7" });
      const login = await client.post("/auth/login", { email: "owner@example.com", password: "owner-password" });
      expect(login.status).toBe(200);
      const [row] = await server.sql`SELECT ip FROM sessions ORDER BY created_at DESC LIMIT 1`;
      return row.ip as string;
    };
    // Not trusted: the address is the one the connection came from, this machine's.
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
    expect(local).toContain(await addressSeenBy(base));
    await base.stop();
    for (const value of ["1", "true", "TRUE", "Yes", "on"]) {
      const t = await start({ keepDatabase: true, env: { TRUST_PROXY: value } });
      expect([value, await addressSeenBy(t)]).toEqual([value, "203.0.113.7"]);
      await t.stop();
    }
    for (const value of ["0", "false", "no", "2", "truee", ""]) {
      const t = await start({ keepDatabase: true, env: { TRUST_PROXY: value } });
      expect([value, local.includes(await addressSeenBy(t))]).toEqual([value, true]);
      await t.stop();
    }
  }, 30_000);
});

describe("the request log", () => {
  test("has one JSON line per API request, with the path but not the query string", async () => {
    const t = await start({ env: { LOG_REQUESTS: undefined } });
    const { owner, user, spaceId } = await t.setupOwner();
    const requests = () => t.logEntries().filter((e) => "method" in e);
    const before = requests().length;

    expect((await owner.get("/pages/recent?limit=5&secret=in-the-query")).status).toBe(200);
    expect((await t.client().get("/me")).status).toBe(401);
    expect((await owner.get("/no-such-endpoint?x=1")).status).toBe(404);
    expect((await owner.post("/pages", { spaceId, title: 5 })).status).toBe(400);
    expect((await owner.raw("HEAD", "/me")).status).toBe(200);
    expect((await owner.raw("DELETE", "/me")).status).toBe(404);
    // Health checks and files of the web app are not logged.
    expect((await owner.get("/health")).status).toBe(200);
    expect((await owner.fetch("/")).status).toBe(200);
    expect((await owner.fetch("/assets/app-4f3a2b1c.js")).status).toBe(200);
    const socket = await connect(owner);
    await socket.close();
    expect((await t.client().raw("GET", "/ws")).status).toBe(401);
    expect((await owner.raw("GET", "/ws")).status).toBe(400);

    const line = (method: string, path: string, status: number, userId: string | null) => ({ t: expect.stringMatching(ISO), method, path, status, ms: expect.any(Number), userId });
    expect(requests().slice(before)).toEqual([
      line("GET", "/api/pages/recent", 200, user.id),
      line("GET", "/api/me", 401, null),
      line("GET", "/api/no-such-endpoint", 404, user.id),
      line("POST", "/api/pages", 400, user.id),
      line("HEAD", "/api/me", 200, user.id),
      line("DELETE", "/api/me", 404, user.id),
      line("GET", "/api/ws", 101, user.id),
      // Accident: an upgrade that was refused is logged as 101 too, whatever was answered.
      line("GET", "/api/ws", 101, null),
      line("GET", "/api/ws", 101, user.id),
    ]);
    for (const entry of requests()) {
      expect(Number.isInteger(entry.ms) && entry.ms >= 0).toBe(true);
      expect(Object.keys(entry).sort()).toEqual(["method", "ms", "path", "status", "t", "userId"]);
    }
    // The setup request before: who signed in with it is not known when it arrives.
    expect(requests()[0]).toEqual(line("POST", "/api/setup", 200, null));
    expect(t.logs.join("\n")).not.toContain("in-the-query");
  });

  test("is on for LOG_REQUESTS=1 and off for LOG_REQUESTS=0", async () => {
    const on = await start({ env: { LOG_REQUESTS: "1" } });
    expect((await on.client().get("/setup")).status).toBe(200);
    expect(on.logEntries().filter((e) => "method" in e)).toEqual([{ t: expect.stringMatching(ISO), method: "GET", path: "/api/setup", status: 200, ms: expect.any(Number), userId: null }]);
    await on.stop();

    const off = await start({ env: { LOG_REQUESTS: "0" } });
    expect((await off.client().get("/setup")).status).toBe(200);
    expect((await off.client().get("/no-such-endpoint")).status).toBe(404);
    expect(off.logEntries().filter((e) => "method" in e)).toEqual([]);
    expect(off.logEntries().map((e) => e.msg)).toEqual([...MIGRATIONS.map(() => "migration applied"), "leading realtime", "server started"]);
  });
});
