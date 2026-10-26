import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "bun";
import { createApp } from "server/app";
import { connect, disconnect, migrate, sql } from "server/db";
import { flushMail, setMailTransport, type Mail } from "server/lib/mail";
import { resetRateLimits } from "server/lib/ratelimit";
import { resetStorage } from "server/lib/storage";
import type { SocketData } from "server/realtime/hub";

export interface TestResponse<T = any> {
  status: number;
  body: { data: T; error?: { code: string; message: string } };
  headers: Headers;
}

/** HTTP client with a cookie jar holding the session cookie. */
export class Client {
  cookie: string | null = null;

  constructor(readonly base: string) {}

  private remember(res: Response) {
    for (const header of res.headers.getSetCookie()) {
      const match = /^session=([^;]*)/.exec(header);
      if (!match) continue;
      this.cookie = /Max-Age=0/i.test(header) || !match[1] ? null : match[1];
    }
  }

  async raw(method: string, pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", `session=${this.cookie}`);
    const res = await fetch(`${this.base}/api${pathname}`, { ...init, method, headers, redirect: "manual" });
    this.remember(res);
    return res;
  }

  async request<T = any>(method: string, pathname: string, body?: unknown): Promise<TestResponse<T>> {
    const res = await this.raw(method, pathname, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }

  get<T = any>(pathname: string) {
    return this.request<T>("GET", pathname);
  }

  post<T = any>(pathname: string, body: unknown = {}) {
    return this.request<T>("POST", pathname, body);
  }

  /** Uploads a page file the way the app does: the raw bytes as the request body. */
  async uploadFile<T = any>(file: File, pageId: string, replaceId?: string): Promise<TestResponse<T>> {
    const query = new URLSearchParams({ pageId, name: file.name, ...(replaceId ? { replaceId } : {}) });
    const res = await this.raw("POST", `/files?${query}`, { body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }

  async upload<T = any>(pathname: string, fields: Record<string, string | Blob>): Promise<TestResponse<T>> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const res = await this.raw("POST", pathname, { body: form });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }
}

export interface TestContext {
  server: Server<SocketData>;
  base: string;
  outbox: Mail[];
  client(): Client;
  /** Completes setup and returns the owner's signed-in client. */
  setupOwner(): Promise<{ owner: Client; user: any; spaceId: string }>;
  /** Invites and signs up a member; returns their client and user. */
  addMember(owner: Client, email: string, role?: "admin" | "member"): Promise<{ client: Client; user: any }>;
  close(): Promise<void>;
}

/** Recreates the `public` schema, runs migrations and starts the app on a random port. */
export const startTestServer = async (): Promise<TestContext> => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres:///doc_test?host=/tmp";
  const storageDir = mkdtempSync(path.join(tmpdir(), "doc-test-"));
  process.env.LOG_REQUESTS = "0";
  process.env.STORAGE_PATH = storageDir;
  process.env.STORAGE_DRIVER = "local";
  process.env.APP_URL = "http://doc.test";
  resetStorage();
  resetRateLimits();
  await disconnect();
  connect(url, 5);
  await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await migrate();

  const outbox: Mail[] = [];
  setMailTransport(async (mail) => {
    outbox.push(mail);
  });

  const app = createApp({ staticDir: null });
  const server = Bun.serve<SocketData>({ port: 0, fetch: app.fetch, websocket: app.websocket });
  const base = `http://localhost:${server.port}`;

  const ctx: TestContext = {
    server,
    base,
    outbox,
    client: () => new Client(base),
    async setupOwner() {
      const owner = new Client(base);
      const res = await owner.post("/setup", {
        workspaceName: "Acme",
        name: "Owner",
        email: "owner@example.com",
        password: "owner-password",
      });
      if (res.status !== 200) throw new Error(`setup failed: ${JSON.stringify(res.body)}`);
      const me = await owner.get("/me");
      return { owner, user: res.body.data.user, spaceId: me.body.data.workspace.defaultSpaceId };
    },
    async addMember(owner, email, role = "member") {
      const invited = await owner.post("/invitations", { emails: [email], role });
      if (invited.status !== 200) throw new Error(`invite failed: ${JSON.stringify(invited.body)}`);
      const link = new URL(invited.body.data[0].url);
      const client = new Client(base);
      const accepted = await client.post("/invitations/accept", {
        id: link.pathname.split("/").pop(),
        token: link.searchParams.get("token"),
        name: email.split("@")[0],
        password: "member-password",
      });
      if (accepted.status !== 200) throw new Error(`accept failed: ${JSON.stringify(accepted.body)}`);
      resetRateLimits();
      return { client, user: accepted.body.data.user };
    },
    async close() {
      await flushMail();
      setMailTransport(null);
      server.stop(true);
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
  return ctx;
};

export const doc = (...paragraphs: string[]) => ({
  type: "doc",
  content: paragraphs.map((text) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] })),
});
