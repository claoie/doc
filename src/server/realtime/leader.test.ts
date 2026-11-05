import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { sql } from "server/db";
import { Client, doc, startTestServer } from "server/test-helpers";

/** A separate server process: sessions and the lease belong to a process. */
interface Copy {
  base: string;
  proc: ReturnType<typeof Bun.spawn>;
  client: Client;
}

const root = path.resolve(import.meta.dir, "..", "..", "..");
const copies: Copy[] = [];
let cookie: string;
let page: { id: string; slugId: string };

const freePort = () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port!;
};

const startCopy = async (): Promise<Copy> => {
  const port = freePort();
  const base = `http://localhost:${port}`;
  const proc = Bun.spawn([process.execPath, "src/server/start.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres:///doc_test?host=/tmp" },
    stdout: "ignore",
    stderr: "ignore",
  });
  const client = new Client(base);
  client.cookie = cookie;
  const copy = { base, proc, client };
  copies.push(copy);
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base}/api/health`).catch(() => null);
    if (res?.ok) return copy;
    await Bun.sleep(100);
  }
  throw new Error("the copy did not start");
};

/** Any other copy accepts a socket, then closes it. */
const leads = async (copy: Copy) => {
  const ws = new WebSocket(`${copy.base.replace("http", "ws")}/api/ws`, { headers: { cookie: `session=${cookie}` } } as never);
  return await new Promise<boolean>((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({ t: "ping" }));
    ws.onmessage = () => {
      ws.close();
      resolve(true);
    };
    ws.onclose = () => resolve(false);
  });
};

const untilLeading = async (copy: Copy, ms: number) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await leads(copy)) return Date.now() - started;
    await Bun.sleep(50);
  }
  throw new Error("the copy did not take over");
};

const connect = async (copy: Copy) => {
  const ws = new WebSocket(`${copy.base.replace("http", "ws")}/api/ws`, { headers: { cookie: `session=${cookie}` } } as never);
  const inbox: Record<string, unknown>[] = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
  const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)));
  await new Promise((resolve) => (ws.onopen = resolve));
  const next = async (t: string) => {
    for (let i = 0; i < 300; i++) {
      const found = inbox.findIndex((m) => m.t === t);
      if (found >= 0) return inbox.splice(found, 1)[0]!;
      await Bun.sleep(10);
    }
    throw new Error(`timed out waiting for ${t}`);
  };
  return { ws, next, closed, send: (m: Record<string, unknown>) => ws.send(JSON.stringify(m)) };
};

const addText = (version: number, from: number, text: string) => ({
  t: "steps",
  pageId: page.id,
  version,
  clientId: "a",
  steps: [{ stepType: "replace", from, to: from, slice: [{ t: text }] }],
});

beforeAll(async () => {
  const t = await startTestServer();
  const { owner, spaceId } = await t.setupOwner();
  cookie = owner.cookie!;
  page = (await owner.post("/pages", { spaceId, title: "Handover", content: doc("hello") })).body.data.page;
  await t.close();
});

afterAll(async () => {
  for (const copy of copies) copy.proc.kill("SIGKILL");
  await Promise.all(copies.map((copy) => copy.proc.exited));
});

describe("two copies of the server", () => {
  let first: Copy;
  let second: Copy;
  let third: Copy;

  test("only the leader takes sockets and content; the rest of the API works on both", async () => {
    first = await startCopy();
    second = await startCopy();
    expect(await leads(first)).toBe(true);
    expect(await leads(second)).toBe(false);

    expect((await second.client.get(`/pages/${page.slugId}`)).status).toBe(200);
    const refused = await second.client.post(`/pages/${page.id}/content`, { content: doc("imported") });
    expect(refused.status).toBe(503);
    expect(refused.body.error?.code).toBe("not_leader");
    expect((await first.client.post(`/pages/${page.id}/content`, { content: doc("imported") })).status).toBe(200);
  }, 20_000);

  test("a leader told to stop saves its edits, then hands over", async () => {
    const version = (await first.client.get(`/pages/${page.slugId}`)).body.data.page.docVersion as number;
    const editor = await connect(first);
    editor.send({ t: "join", pageId: page.id, version, clientId: "a" });
    await editor.next("joined");
    editor.send(addText(version, 9, "!"));
    expect(await editor.next("steps")).toMatchObject({ version: version + 1 });

    // Well inside the save debounce, so only the shutdown can save this edit.
    first.proc.kill("SIGTERM");
    expect(await editor.closed).toBe(1001);
    await untilLeading(second, 3000);

    const again = await connect(second);
    again.send({ t: "join", pageId: page.id, version: version + 1, clientId: "a" });
    const joined = await again.next("joined");
    expect(joined).toMatchObject({ version: version + 1 });
    expect(joined.doc).toBeUndefined();
    const saved = await second.client.get(`/pages/${page.slugId}`);
    expect(saved.body.data.page.content.content[0].content[0].text).toBe("imported!");
    again.ws.close();
  }, 20_000);

  test("a leader that loses its lease turns its sockets away", async () => {
    const editor = await connect(second);
    await sql`UPDATE realtime_leader SET holder = 'someone else', expires_at = now() + interval '1 hour'`;
    for (let i = 0; i < 100 && (await leads(second)); i++) await Bun.sleep(100);
    expect(await leads(second)).toBe(false);
    editor.send({ t: "ping" });
    expect(await editor.closed).toBe(1013);

    await sql`DELETE FROM realtime_leader`;
    await untilLeading(second, 3000);
  }, 20_000);

  test("when a leader dies, a successor waits for its lease to run out", async () => {
    third = await startCopy();
    second.proc.kill("SIGKILL");
    await second.proc.exited;
    expect(await leads(third)).toBe(false);
    // The lease has at least its length minus one renewal left.
    expect(await untilLeading(third, 12_000)).toBeGreaterThan(5000);
  }, 30_000);

  test("a renewal still running at shutdown doesn't bring the lease back", async () => {
    const sleeping = async () => {
      const [row] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep'`;
      return row.n > 0;
    };
    // This runs before the renewal touches the row, so a release can overtake it.
    await sql.unsafe(`CREATE OR REPLACE FUNCTION slow_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$`);
    await sql.unsafe(`CREATE OR REPLACE TRIGGER slow_claim BEFORE INSERT ON realtime_leader FOR EACH ROW EXECUTE FUNCTION slow_claim()`);
    try {
      for (let i = 0; i < 300 && !(await sleeping()); i++) await Bun.sleep(20);
      expect(await sleeping()).toBe(true);
      third.proc.kill("SIGTERM");
      await third.proc.exited;
      for (let i = 0; i < 100 && (await sleeping()); i++) await Bun.sleep(20);
      expect((await sql`SELECT holder FROM realtime_leader`).length).toBe(0);
    } finally {
      await sql.unsafe(`DROP TRIGGER slow_claim ON realtime_leader`);
      await sql.unsafe(`DROP FUNCTION slow_claim`);
    }
  }, 20_000);
});
