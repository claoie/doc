import type { SQL } from "bun";
import type { Client } from "./client";
import { until, type TestServer } from "./server";
import { connect, type Message, type Socket } from "./ws";

/** Helpers for the realtime tests: pages, steps and what the server stored. */

export type Step = Record<string, any>;

export interface PageRef {
  id: string;
  slugId: string;
  spaceId: string;
  docVersion: number;
}

/** The message texts the realtime endpoint sends in `error` messages. */
export const ERRORS = {
  noAccess: "You do not have access to this page",
  accessLost: "You no longer have access to this page",
  notJoined: "Join the page before editing",
  readOnly: "This page is read-only for you",
  invalidStep: "A change could not be applied; the page was reloaded.",
  tooLarge: "This page is too large to add more to it.",
  changedElsewhere: "This page changed elsewhere; your latest edits could not be saved.",
} as const;

/** The paragraph attributes of the document a page without content starts with. */
export const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph", attrs: { id: null, textAlign: null, indent: 0 } }] };

export const text = (value: string, ...marks: Record<string, any>[]) =>
  marks.length ? { type: "text", text: value, marks } : { type: "text", text: value };

export const p = (...content: (string | Record<string, any>)[]) => ({
  type: "paragraph",
  content: content.map((c) => (typeof c === "string" ? text(c) : c)),
});

export const docOf = (...content: Record<string, any>[]) => ({ type: "doc", content });

/** A step that types `value` at `from`. */
export const insertText = (from: number, value: string): Step => ({ stepType: "replace", from, to: from, slice: [{ t: value }] });

export const createPage = async (client: Client, spaceId: string, content?: unknown, fields: Record<string, unknown> = {}): Promise<PageRef> => {
  const res = await client.post("/pages", { spaceId, title: "Collab", ...(content === undefined ? {} : { content }), ...fields });
  if (res.status !== 200) throw new Error(`creating a page failed: ${res.status} ${res.text}`);
  return res.body.data.page;
};

/** Sends `join` and returns the `joined` answer for that page. */
export const join = async (socket: Socket, pageId: string, version: unknown = 0, clientId?: unknown): Promise<Message> => {
  socket.send({ t: "join", pageId, ...(version === undefined ? {} : { version }), ...(clientId === undefined ? {} : { clientId }) });
  return socket.nextOf("joined", { pageId: pageId.toLowerCase() });
};

/**
 * Leaves a page and waits until the server has taken the socket off it. The
 * messages of one socket are handled in the order they were sent, so the
 * answer to a ping sent after `leave` comes when the leave is done.
 */
export const leave = async (socket: Socket, pageId: string): Promise<void> => {
  socket.send({ t: "leave", pageId });
  socket.send({ t: "ping" });
  await socket.nextOf("pong");
};

/** Drops every message received so far and not yet handed out, so later waits only see what comes from now on. */
export const forget = (socket: Socket) => {
  socket.inbox.length = 0;
};

/** Sends a batch of steps made against `version` without waiting for the answer. */
export const pushSteps = (socket: Socket, pageId: string, version: unknown, steps: unknown, clientId: unknown = "a") =>
  socket.send({ t: "steps", pageId, version, clientId, steps });

/** Sends a batch of steps and returns the `steps` message that confirms it. */
export const sendSteps = async (socket: Socket, pageId: string, version: number, steps: Step[], clientId = "a"): Promise<Message> => {
  pushSteps(socket, pageId, version, steps, clientId);
  return socket.nextOf("steps", { pageId: pageId.toLowerCase() });
};

/**
 * The document the server holds for a page right now, with its version: what
 * a client that joins without a usable version is sent.
 */
export const liveDoc = async (socket: Socket, pageId: string): Promise<{ version: number; doc: any }> => {
  socket.send({ t: "join", pageId, version: -1 });
  const joined = await socket.next((m) => m.t === "joined" && m.pageId === pageId && "doc" in m);
  return { version: joined.version, doc: joined.doc };
};

export interface StoredPage {
  content: any;
  text_content: string | null;
  doc_version: number;
  last_editor_id: string | null;
  contributor_ids: string[];
  updated_at: Date;
  created_at: Date;
  deleted_at: Date | null;
}

/** The page's row as stored, or null when it is gone. */
export const storedPage = async (sql: SQL, pageId: string): Promise<StoredPage | null> => {
  const [row] = await sql`
    SELECT content, text_content, doc_version::int AS doc_version, last_editor_id, contributor_ids::text[] AS contributor_ids,
      updated_at, created_at, deleted_at
    FROM pages WHERE id = ${pageId}`;
  return row ?? null;
};

/** Waits until the page is stored at `version` and returns its row. */
export const untilStored = (server: TestServer, pageId: string, version: number, timeoutMs = 5000): Promise<StoredPage> =>
  until(
    async () => {
      const row = await storedPage(server.sql, pageId);
      return row && row.doc_version === version ? row : null;
    },
    timeoutMs,
    `page ${pageId} to be stored at version ${version}`,
  );

/**
 * A page's session is let go of (or kept for reconnecting editors) a moment
 * after its last save is stored, once the notifications of that save are out.
 * Nothing outside the server shows that moment, so tests that depend on the
 * session having been let go wait this long after they see the save.
 */
export const SETTLE_MS = 250;

/**
 * Leaves a page stored at version 1 with nobody on it: `b` drops off at
 * version 0, then `a` adds a "!" after the page's "hello" and leaves too, so
 * `b` is one step behind. Resolves with the page and the moment `a` left.
 */
export const editAfterBothLeave = async (server: TestServer, client: Client, spaceId: string): Promise<PageRef & { leftAt: number }> => {
  const target = await createPage(client, spaceId, { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] });
  const a = await connect(client);
  const b = await connect(client);
  await join(a, target.id, 0, "a");
  await join(b, target.id, 0, "b");
  await b.close();
  await sendSteps(a, target.id, 0, [insertText(6, "!")], "a");
  await a.close();
  const leftAt = Date.now();
  await untilStored(server, target.id, 1);
  await Bun.sleep(SETTLE_MS);
  return { ...target, leftAt };
};

/**
 * Runs `statement` in a transaction of the suite's own connection and keeps
 * its locks until the returned function is called.
 */
export const hold = async (sql: SQL, statement: string): Promise<() => Promise<void>> => {
  let release = () => {};
  let done: Promise<unknown> = Promise.resolve();
  await new Promise<void>((locked, failed) => {
    done = sql.begin(async (tx) => {
      await tx.unsafe(statement);
      locked();
      await new Promise<void>((resolve) => (release = resolve));
    });
    done.catch(failed);
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    release();
    await done;
  };
};

/** Waits until some query of another connection waits on a lock. */
export const untilBlocked = (sql: SQL) =>
  until(
    async () => {
      const [row] = await sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
      return row.n > 0;
    },
    5000,
    "a query to wait on the lock",
  );

/** The colour the server gives a user's caret: one of eight, picked by a hash of the user's id. */
export const PRESENCE_COLORS = ["#e5484d", "#f76b15", "#ffb224", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];

export const presenceColor = (userId: string) => {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (Math.imul(hash, 31) + userId.charCodeAt(i)) | 0;
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length]!;
};

/** The next `presence` message of a page whose users satisfy `pred`. */
export const nextPresence = (socket: Socket, pageId: string, pred: (users: any[]) => boolean = () => true, timeoutMs?: number) =>
  socket.next((m) => m.t === "presence" && m.pageId === pageId && pred(m.users), timeoutMs);

/** A client of another copy of the server that carries the same session. */
export const sameSessionOn = (server: TestServer, client: Client): Client => {
  const copy = server.client();
  copy.cookie = client.cookie;
  return copy;
};

/**
 * Whether this copy of the server leads realtime: a leader answers a ping, any
 * other copy closes the socket (with 1013) right after it opens.
 */
export const leads = async (client: Client): Promise<boolean> => {
  const socket = await connect(client).catch(() => null);
  if (!socket) return false;
  socket.send({ t: "ping" });
  const answered = await Promise.race([
    socket.nextOf("pong", {}, 2000).then(
      () => true,
      () => false,
    ),
    socket.closed.then(() => false),
  ]);
  socket.ws.close();
  return answered;
};

/** Waits until the copy `client` talks to leads realtime; resolves with how long that took. */
export const untilLeading = async (client: Client, timeoutMs: number): Promise<number> => {
  const started = Date.now();
  await until(() => leads(client), timeoutMs, "the copy to lead realtime");
  return Date.now() - started;
};

export interface LeaseRow {
  id: number;
  holder: string;
  expires_at: Date;
  /** How long the lease still runs, by the database's clock. */
  remaining_ms: number;
}

/** The lease row(s) of the copy that leads realtime. */
export const leaseRows = async (sql: SQL): Promise<LeaseRow[]> =>
  sql`SELECT id, holder, expires_at, (extract(epoch FROM expires_at - clock_timestamp()) * 1000)::int AS remaining_ms FROM realtime_leader`;

/**
 * Makes every claim or renewal of the realtime lease take `seconds` longer
 * (once per transaction, however the server writes the row), until the
 * returned function is called.
 */
export const slowClaims = async (sql: SQL, seconds: number): Promise<() => Promise<void>> => {
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION slow_claim() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('doc_test.slept', true) IS DISTINCT FROM txid_current()::text THEN
        PERFORM set_config('doc_test.slept', txid_current()::text, true);
        PERFORM pg_sleep(${seconds});
      END IF;
      RETURN NEW;
    END $$`);
  await sql.unsafe(`CREATE OR REPLACE TRIGGER slow_claim BEFORE INSERT OR UPDATE ON realtime_leader FOR EACH ROW EXECUTE FUNCTION slow_claim()`);
  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    await sql.unsafe(`DROP TRIGGER IF EXISTS slow_claim ON realtime_leader`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS slow_claim`);
  };
};

/** Whether a claim of the lease is being held up by `slowClaims` right now. */
export const claimSleeping = async (sql: SQL): Promise<boolean> => {
  const [row] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep'`;
  return row.n > 0;
};

/** Adds a member to a space with a role, and returns the membership's id. */
export const addToSpace = async (owner: Client, spaceId: string, userId: string, role: "reader" | "writer" | "admin"): Promise<string> => {
  const added = await owner.post(`/spaces/${spaceId}/members/add`, { role, userIds: [userId] });
  if (added.status !== 200) throw new Error(`adding to the space failed: ${added.status} ${added.text}`);
  const members = (await owner.get(`/spaces/${spaceId}/members`)).body.data as { id: string; user?: { id: string } }[];
  return members.find((m) => m.user?.id === userId)!.id;
};
