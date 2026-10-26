import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "server/db";
import { flushMail } from "server/lib/mail";
import { resetRateLimits } from "server/lib/ratelimit";
import { startTestServer, type Client, type TestContext } from "server/test-helpers";

let t: TestContext;
let owner: Client;

beforeAll(async () => {
  t = await startTestServer();
});

afterAll(async () => {
  await t.close();
});

describe("setup", () => {
  test("reports that setup is needed, then creates the workspace", async () => {
    const anon = t.client();
    expect((await anon.get("/setup")).body.data).toEqual({ needsSetup: true });
    expect((await anon.get("/me")).status).toBe(401);

    const setup = await t.setupOwner();
    owner = setup.owner;
    expect(setup.user.role).toBe("owner");
    expect(setup.user.email).toBe("owner@example.com");
    expect((await anon.get("/setup")).body.data).toEqual({ needsSetup: false });

    const me = await owner.get("/me");
    expect(me.status).toBe(200);
    expect(me.body.data.workspace.name).toBe("Acme");
    const spaces = await owner.get("/spaces");
    expect(spaces.body.data).toHaveLength(1);
    expect(spaces.body.data[0]).toMatchObject({ name: "General", slug: "general", role: "admin" });
    expect(me.body.data.workspace.defaultSpaceId).toBe(spaces.body.data[0].id);
    const groups = await owner.get("/groups");
    expect(groups.body.data).toEqual([expect.objectContaining({ name: "Everyone", isDefault: true, memberCount: 1 })]);
  });

  test("cannot run twice", async () => {
    const res = await t.client().post("/setup", {
      workspaceName: "Other",
      name: "Intruder",
      email: "intruder@example.com",
      password: "intruder-password",
    });
    expect(res.status).toBe(403);
  });
});

describe("sessions", () => {
  test("session cookie is HttpOnly and SameSite=Lax, and the database stores only a hash", async () => {
    const client = t.client();
    const res = await client.raw("POST", "/auth/login", {
      body: JSON.stringify({ email: "OWNER@example.com", password: "owner-password" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("session="))!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const [stored] = await sql`SELECT count(*)::int AS n FROM sessions WHERE token_hash = ${client.cookie}`;
    expect(stored.n).toBe(0);
  });

  test("login, logout and wrong passwords", async () => {
    const client = t.client();
    expect((await client.post("/auth/login", { email: "owner@example.com", password: "nope-nope" })).status).toBe(401);
    expect((await client.post("/auth/login", { email: "owner@example.com", password: "owner-password" })).status).toBe(200);
    expect((await client.get("/me")).status).toBe(200);
    const sessions = await client.get("/auth/sessions");
    expect(sessions.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect((await client.post("/auth/logout")).status).toBe(200);
    expect(client.cookie).toBeNull();
    expect((await client.get("/me")).status).toBe(401);
  });

  test("revoking a session signs it out", async () => {
    const other = t.client();
    await other.post("/auth/login", { email: "owner@example.com", password: "owner-password" });
    const sessions = await owner.get("/auth/sessions");
    const target = sessions.body.data.find((s: { current: boolean }) => !s.current);
    expect((await owner.post("/auth/sessions/revoke", { id: target.id })).status).toBe(200);
    const remaining = await owner.get("/auth/sessions");
    expect(remaining.body.data.some((s: { id: string }) => s.id === target.id)).toBe(false);
  });

  test("login is rate limited per IP", async () => {
    resetRateLimits();
    const client = t.client();
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await client.post("/auth/login", { email: "x@example.com", password: "whatever1" })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    resetRateLimits();
  });

  test("rejects cross-origin mutations", async () => {
    const res = await owner.raw("POST", "/auth/logout", {
      body: "{}",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect((await owner.get("/me")).status).toBe(200);
  });
});

describe("passwords", () => {
  test("forgot and reset password through the emailed token", async () => {
    const { client: member } = await t.addMember(owner, "reset@example.com");
    t.outbox.length = 0;
    expect((await t.client().post("/auth/forgot-password", { email: "reset@example.com" })).status).toBe(200);
    expect((await t.client().post("/auth/forgot-password", { email: "missing@example.com" })).status).toBe(200);
    await flushMail();
    expect(t.outbox).toHaveLength(1);
    const link = /https?:\/\/\S+reset-password\?token=([^\s"<]+)/.exec(t.outbox[0]!.text)!;
    const tokenValue = decodeURIComponent(link[1]!);

    const fresh = t.client();
    const reset = await fresh.post("/auth/reset-password", { token: tokenValue, password: "brand-new-password" });
    expect(reset.status).toBe(200);
    expect(reset.body.data.user.email).toBe("reset@example.com");
    expect((await member.get("/me")).status).toBe(401);
    expect((await fresh.post("/auth/reset-password", { token: tokenValue, password: "another-password" })).status).toBe(400);
    expect((await t.client().post("/auth/login", { email: "reset@example.com", password: "brand-new-password" })).status).toBe(200);
  });

  test("change password requires the current one and revokes other sessions", async () => {
    const { client } = await t.addMember(owner, "change@example.com");
    const second = t.client();
    await second.post("/auth/login", { email: "change@example.com", password: "member-password" });
    expect((await client.post("/auth/change-password", { currentPassword: "wrong-one", newPassword: "next-password" })).status).toBe(400);
    expect((await client.post("/auth/change-password", { currentPassword: "member-password", newPassword: "short" })).status).toBe(400);
    expect(
      (await client.post("/auth/change-password", { currentPassword: "member-password", newPassword: "next-password" })).status,
    ).toBe(200);
    expect((await client.get("/me")).status).toBe(200);
    expect((await second.get("/me")).status).toBe(401);
  });

  test("deactivated users cannot sign in and are signed out", async () => {
    const { client, user } = await t.addMember(owner, "gone@example.com");
    expect((await owner.post("/members/deactivate", { userId: user.id })).status).toBe(200);
    expect((await client.get("/me")).status).toBe(401);
    const login = await t.client().post("/auth/login", { email: "gone@example.com", password: "member-password" });
    expect(login.status).toBe(401);
    expect(login.body.error!.code).toBe("invalid_credentials");
    expect((await owner.post("/members/deactivate", { userId: (await owner.get("/me")).body.data.user.id })).status).toBe(403);
  });
});

describe("profile", () => {
  test("updates name and preferences, email change needs the password", async () => {
    const res = await owner.post("/me/update", { name: "Boss", preferences: { fullPageWidth: true, theme: "dark" } });
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe("Boss");
    expect(res.body.data.user.preferences).toEqual({ fullPageWidth: true, theme: "dark" });
    expect((await owner.post("/me/update", { email: "boss@example.com" })).status).toBe(400);
    const changed = await owner.post("/me/update", { email: "boss@example.com", currentPassword: "owner-password" });
    expect(changed.body.data.user.email).toBe("boss@example.com");
  });

  test("avatar upload validates image bytes", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
    const bad = await owner.upload("/me/avatar", { file: new File(["<svg/>"], "a.png", { type: "image/png" }) });
    expect(bad.status).toBe(400);
    const good = await owner.upload("/me/avatar", { file: new File([png], "a.png", { type: "image/png" }) });
    expect(good.status).toBe(200);
    const avatarUrl: string = good.body.data.user.avatarUrl;
    expect(avatarUrl).toMatch(/^\/api\/images\/[0-9a-f-]+\.png$/);
    const image = await t.client().raw("GET", avatarUrl.slice("/api".length));
    expect(image.status).toBe(200);
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
  });
});
