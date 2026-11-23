import { SQL } from "bun";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, type ClientOptions } from "./client";
import { startFakeSmtp, type FakeSmtp, type ReceivedMail } from "./smtp";

/**
 * Which backend the suite runs against: `bun` (src/server, the default) or
 * `rust` (src/server-rs). Chosen with `API_TEST_SERVER`.
 */
export type Target = "bun" | "rust";

export const target: Target = process.env.API_TEST_SERVER === "rust" ? "rust" : "bun";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

/** The built Rust server (`cargo build --release -p doc-server`). */
export const rustBinary = process.env.API_TEST_RUST_BIN ?? path.join(repoRoot, "target", "release", "doc-server");

/**
 * Whether both servers can be started: the Bun one always can (it is bundled
 * from source); the Rust one once it is built.
 */
export const bothServers = existsSync(rustBinary);


export const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres:///doc_test?host=/tmp";

/**
 * Bun.SQL does not understand libpq's `?host=/socket/dir` form, so it is
 * translated into an explicit socket path (as `src/server/db` does).
 */
const connectionOptions = (url: string): SQL.Options => {
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
      max: 3,
    };
  }
  return { url, max: 3 };
};

let db: SQL | null = null;

/** The suite's own connection to the test database, for arranging and inspecting state. */
export const sql = (): SQL => (db ??= new SQL(connectionOptions(databaseUrl)));

/** Files of the built web app the servers serve outside `/api`. */
export const STATIC_FILES: Record<string, string> = {
  "index.html": '<!doctype html><html><head><title>Doc</title></head><body><div id="root"></div><script type="module" src="/assets/app-4f3a2b1c.js"></script></body></html>\n',
  "excalidraw.html": "<!doctype html><html><body>drawing editor</body></html>\n",
  "favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>\n',
  "robots.txt": "User-agent: *\nDisallow:\n",
  "assets/app-4f3a2b1c.js": 'console.log("app");\n',
  "assets/app-9e8d7c6b.css": "body { margin: 0 }\n",
  "assets/font-1a2b3c4d.woff2": "not really a font",
  "nested/dir/page.html": "<!doctype html><html><body>nested</body></html>\n",
  "nested/data.json": '{"hello":"world"}\n',
  "with space.txt": "spaced\n",
};

interface Layout {
  /** Command line that starts the server. */
  cmd: string[];
  /** Directory the server serves static files from (a sibling `client` of the server's own directory). */
  staticDir: string;
  /** The same server in a directory with no `client` next to it. */
  cmdWithoutStatic: string[];
}

const layouts = new Map<Target, Promise<Layout>>();
const layoutDirs: string[] = [];

/**
 * Lays the server out as a deployment does: `<dir>/server/<executable>` with
 * the built web app in `<dir>/client`. For Bun the executable is the bundle
 * `bun run build-server` makes; for Rust it is the `doc-server` binary.
 */
const prepare = (which: Target): Promise<Layout> => {
  const known = layouts.get(which);
  if (known) return known;
  const prepared = (async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doc-api-tests-"));
    layoutDirs.push(dir);
    const bare = path.join(dir, "bare", "server");
    mkdirSync(path.join(dir, "server"), { recursive: true });
    mkdirSync(bare, { recursive: true });
    const staticDir = path.join(dir, "client");
    for (const [name, content] of Object.entries(STATIC_FILES)) {
      const file = path.join(staticDir, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    if (which === "rust") {
      const built = rustBinary;
      if (!existsSync(built)) {
        throw new Error(`The Rust server is not built: ${built} does not exist. Run \`cargo build --release\` first.`);
      }
      for (const where of [path.join(dir, "server"), bare]) {
        copyFileSync(built, path.join(where, "doc-server"));
        chmodSync(path.join(where, "doc-server"), 0o755);
      }
      return { cmd: [path.join(dir, "server", "doc-server")], staticDir, cmdWithoutStatic: [path.join(bare, "doc-server")] };
    }
    const result = await Bun.build({
      entrypoints: [path.join(repoRoot, "src", "server", "start.ts")],
      target: "bun",
      outdir: path.join(dir, "server"),
      naming: "bundle.js",
    });
    if (!result.success) throw new Error(`Bundling the Bun server failed:\n${result.logs.join("\n")}`);
    copyFileSync(path.join(dir, "server", "bundle.js"), path.join(bare, "bundle.js"));
    return {
      cmd: [process.execPath, path.join(dir, "server", "bundle.js")],
      staticDir,
      cmdWithoutStatic: [process.execPath, path.join(bare, "bundle.js")],
    };
  })();
  layouts.set(which, prepared);
  return prepared;
};

const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port!;
};

export interface StartOptions {
  /** Extra environment for the server; `undefined` removes a default. */
  env?: Record<string, string | undefined>;
  /** Start on the database as it is instead of an empty one (a second copy of the server). Default false. */
  keepDatabase?: boolean;
  /** Run without a built web app next to the server. Default false. */
  withoutStatic?: boolean;
  /** Deliver mail to this SMTP server instead of a new one. */
  smtp?: FakeSmtp;
  /** Don't wait for the server to answer; for servers expected to refuse to start. */
  expectExit?: boolean;
  /**
   * Which server to start, for the tests that run the two side by side.
   * Every other test leaves it to `API_TEST_SERVER`.
   */
  target?: Target;
}

export interface TestServer {
  target: Target;
  /** `http://localhost:<port>` */
  base: string;
  port: number;
  /** The suite's connection to the server's database. */
  sql: SQL;
  smtp: FakeSmtp;
  /** Mail the server delivered, in order. */
  outbox: ReceivedMail[];
  /** Where the server keeps uploaded files (`STORAGE_PATH`). */
  storageDir: string;
  /** The directory static files are served from. */
  staticDir: string;
  /** Lines the server wrote to stdout and stderr, as they arrive. */
  logs: string[];
  /** Log lines parsed as JSON objects (lines that are not JSON are skipped). */
  logEntries(): Record<string, any>[];
  /** A new client with its own cookie jar and address. */
  client(options?: ClientOptions): Client;
  /** Completes first-run setup and returns the owner's signed-in client. */
  setupOwner(): Promise<{ owner: Client; user: any; spaceId: string }>;
  /** Invites and signs up a member (password `member-password`); returns their client and user. */
  addMember(owner: Client, email: string, role?: "admin" | "member"): Promise<{ client: Client; user: any }>;
  /** Resolves with the exit code once the process has exited. */
  exited: Promise<number>;
  /** Sends `signal` (default SIGTERM) and waits for the process to exit. */
  stop(signal?: NodeJS.Signals): Promise<number>;
  /** Stops the server and removes what the harness created for it. */
  close(): Promise<void>;
}

const running = new Set<TestServer>();

process.on("exit", () => {
  for (const server of running) void server.stop("SIGKILL");
  for (const dir of layoutDirs) rmSync(dir, { recursive: true, force: true });
});

const collect = async (stream: ReadableStream<Uint8Array> | null | undefined, into: string[], label = "server") => {
  if (!stream) return;
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    const whole = lines.filter(Boolean);
    into.push(...whole);
    // `API_TEST_ECHO_LOGS=1` shows what the server under test logs, for debugging a failure.
    if (process.env.API_TEST_ECHO_LOGS) for (const line of whole) console.error(`[${label}] ${line}`);
  }
  if (pending) into.push(pending);
};

/**
 * Starts the server under test as its own process on an empty database (the
 * `public` schema is recreated; the server migrates it on start) and waits for
 * it to answer. Mail goes to a fake SMTP server; uploads to a temporary
 * directory; `APP_URL` is `http://doc.test`; client addresses come from
 * `X-Forwarded-For`.
 */
export const startServer = async (options: StartOptions = {}): Promise<TestServer> => {
  const which = options.target ?? target;
  const prepared = await prepare(which);
  const connection = sql();
  if (!options.keepDatabase) {
    await connection.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  }
  const smtp = options.smtp ?? (await startFakeSmtp());
  const storageDir = mkdtempSync(path.join(tmpdir(), "doc-api-storage-"));
  const port = freePort();
  const base = `http://localhost:${port}`;
  const env: Record<string, string> = {};
  const defaults: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    TZ: "UTC",
    NODE_ENV: "test",
    PORT: String(port),
    APP_URL: "http://doc.test",
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: "5",
    TRUST_PROXY: "true",
    STORAGE_DRIVER: "local",
    STORAGE_PATH: storageDir,
    MAIL_DRIVER: "smtp",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtp.port),
    MAIL_FROM_ADDRESS: "docs@doc.test",
    MAIL_FROM_NAME: "Doc Tests",
    LOG_REQUESTS: "0",
    ...options.env,
  };
  for (const [name, value] of Object.entries(defaults)) if (value !== undefined) env[name] = value;

  const logs: string[] = [];
  const proc = Bun.spawn(options.withoutStatic ? prepared.cmdWithoutStatic : prepared.cmd, {
    cwd: path.dirname(prepared.staticDir),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const drained = Promise.all([collect(proc.stdout, logs, `server ${port}`), collect(proc.stderr, logs, `server ${port}`)]);
  const exited = proc.exited.then(async (code) => {
    await drained;
    return code;
  });

  let stopping: Promise<number> | null = null;
  const server: TestServer = {
    target: which,
    base,
    port,
    sql: connection,
    smtp,
    outbox: smtp.outbox,
    storageDir,
    staticDir: prepared.staticDir,
    logs,
    logEntries: () =>
      logs.flatMap((line) => {
        try {
          const value = JSON.parse(line);
          return value && typeof value === "object" ? [value] : [];
        } catch {
          return [];
        }
      }),
    client: (clientOptions) => new Client(base, clientOptions),
    async setupOwner() {
      const owner = new Client(base);
      const res = await owner.post("/setup", {
        workspaceName: "Acme",
        name: "Owner",
        email: "owner@example.com",
        password: "owner-password",
      });
      if (res.status !== 200) throw new Error(`setup failed: ${res.status} ${res.text}`);
      const me = await owner.get("/me");
      return { owner, user: res.body.data.user, spaceId: me.body.data.workspace.defaultSpaceId };
    },
    async addMember(owner, email, role = "member") {
      const invited = await owner.post("/invitations", { emails: [email], role });
      if (invited.status !== 200) throw new Error(`invite failed: ${invited.status} ${invited.text}`);
      const link = new URL(invited.body.data[0].url);
      const client = new Client(base);
      const accepted = await client.post("/invitations/accept", {
        id: link.pathname.split("/").pop(),
        token: link.searchParams.get("token"),
        name: email.split("@")[0],
        password: "member-password",
      });
      if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status} ${accepted.text}`);
      return { client, user: accepted.body.data.user };
    },
    exited,
    stop(signal = "SIGTERM") {
      if (!stopping || signal === "SIGKILL") {
        proc.kill(signal);
        stopping = Promise.race([
          exited,
          Bun.sleep(15_000).then(() => {
            proc.kill("SIGKILL");
            return exited;
          }),
        ]);
      }
      return stopping;
    },
    async close() {
      await server.stop();
      running.delete(server);
      if (!options.smtp) await smtp.stop();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
  running.add(server);
  if (options.expectExit) return server;

  const deadline = Date.now() + 20_000;
  let exitCode: number | null = null;
  void exited.then((code) => (exitCode = code));
  for (;;) {
    const res = await fetch(`${base}/api/health`).catch(() => null);
    if (res?.ok) {
      await res.body?.cancel();
      return server;
    }
    await res?.body?.cancel();
    if (exitCode !== null) {
      running.delete(server);
      throw new Error(`the ${which} server exited with ${exitCode} before answering:\n${logs.join("\n")}`);
    }
    if (Date.now() > deadline) {
      await server.stop("SIGKILL");
      running.delete(server);
      throw new Error(`the ${target} server did not answer within 20 s:\n${logs.join("\n")}`);
    }
    await Bun.sleep(25);
  }
};

/** A document of plain paragraphs. */
export const doc = (...paragraphs: string[]) => ({
  type: "doc",
  content: paragraphs.map((text) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] })),
});

/** Polls `check` until it returns something truthy, or throws after `timeoutMs`. */
export const until = async <T>(check: () => T | Promise<T>, timeoutMs = 5000, what = "condition"): Promise<NonNullable<T>> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await Bun.sleep(25);
  }
};
