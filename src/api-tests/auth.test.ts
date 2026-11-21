import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, startServer, type Client, type TestServer } from "./harness";
import {
  ARGON2_HASH,
  CLEARED_COOKIE,
  ISO,
  NOT_FOUND,
  RATE_LIMITED,
  SESSION_COOKIE,
  TOKEN,
  UNAUTHORIZED,
  UUID,
  expectApiHeaders,
  expectBody,
  expectError,
  expectInvalid,
  expectMail,
  flushMail,
  mailHtml,
  mailsTo,
  resetToken,
  rows,
  sha256,
  signIn,
  userShape,
  waitForMailsTo,
} from "./harness/admin";

/*
 * First-run setup, password sign-in, sessions, and forgotten, reset and
 * changed passwords. Single sign-on is off throughout (another suite turns it on).
 */

const DAY = 24 * 60 * 60 * 1000;
const INVALID_CREDENTIALS = { error: { code: "invalid_credentials", message: "Invalid email or password" } };
const INVALID_RESET = { error: { code: "invalid_input", message: "This reset link is invalid or has expired" } };
const WRONG_PASSWORD = { error: { code: "invalid_password", message: "Current password is incorrect" } };

describe("first-run setup on an empty database", () => {
  let s: TestServer;
  const valid = { workspaceName: "Acme", name: "Owner", email: "owner@example.com", password: "owner-password" };

  // Exactly at the limits, in code points: 100 for the workspace, 50 for the name, 70 for the password.
  const workspaceName = `🏢 ${"工".repeat(97)}é`;
  const name = `Zoë 🎉 ${"名".repeat(44)}`;
  const password = ` ${"🔑".repeat(34)}${"ö".repeat(34)} `;

  beforeAll(async () => {
    s = await startServer();
  });

  afterAll(async () => {
    await s.close();
  });

  test("before setup the status says so, nobody can sign in and the workspace has no name", async () => {
    expectBody(await s.client().get("/setup"), 200, { data: { needsSetup: true } });
    expectBody(await s.client().get("/me"), 401, UNAUTHORIZED);
    expectBody(await s.client().get("/auth/config"), 200, { data: { sso: { enabled: false, localLogin: true } } });
    expectBody(await s.client().get("/workspace/public"), 200, { data: { name: "", logoUrl: null } });
    expectBody(await s.client().post("/auth/login", { email: "owner@example.com", password: "owner-password" }), 401, INVALID_CREDENTIALS);
    expectBody(await s.client().post("/auth/forgot-password", { email: "owner@example.com" }), 200, { data: {} });
  });

  const invalid: [string, Record<string, unknown>, string][] = [
    ["an empty body", {}, "workspaceName must be a string"],
    ["no workspace name", { ...valid, workspaceName: undefined }, "workspaceName must be a string"],
    ["a workspace name that is null", { ...valid, workspaceName: null }, "workspaceName must be a string"],
    ["a workspace name that is a number", { ...valid, workspaceName: 7 }, "workspaceName must be a string"],
    ["a workspace name that is an array", { ...valid, workspaceName: ["Acme"] }, "workspaceName must be a string"],
    ["an empty workspace name", { ...valid, workspaceName: "" }, "workspaceName is required"],
    ["a blank workspace name", { ...valid, workspaceName: " \t\n " }, "workspaceName is required"],
    ["a workspace name of 101 characters", { ...valid, workspaceName: "w".repeat(101) }, "workspaceName must be at most 100 characters"],
    ["a workspace name of 101 emoji", { ...valid, workspaceName: "🏢".repeat(101) }, "workspaceName must be at most 100 characters"],
    ["no name", { ...valid, name: undefined }, "name must be a string"],
    ["a name that is null", { ...valid, name: null }, "name must be a string"],
    ["a name that is a boolean", { ...valid, name: true }, "name must be a string"],
    ["a blank name", { ...valid, name: "   " }, "name is required"],
    ["a name of 51 characters", { ...valid, name: "n".repeat(51) }, "name must be at most 50 characters"],
    ["a name of 51 emoji", { ...valid, name: "🎉".repeat(51) }, "name must be at most 50 characters"],
    ["no email", { ...valid, email: undefined }, "email must be a string"],
    ["an email that is null", { ...valid, email: null }, "email must be a string"],
    ["an email that is an object", { ...valid, email: { address: "owner@example.com" } }, "email must be a string"],
    ["an empty email", { ...valid, email: "" }, "email is too short"],
    ["an email of two characters", { ...valid, email: " a@ " }, "email is too short"],
    ["an email of 255 characters", { ...valid, email: `${"a".repeat(243)}@example.com` }, "email must be at most 254 characters"],
    ["an email without @", { ...valid, email: "owner.example.com" }, "Invalid email address"],
    ["an email without a dot in its domain", { ...valid, email: "owner@example" }, "Invalid email address"],
    ["an email with a space", { ...valid, email: "the owner@example.com" }, "Invalid email address"],
    ["an email with a display name", { ...valid, email: "Owner <owner@example.com>" }, "Invalid email address"],
    ["no password", { ...valid, password: undefined }, "password must be a string"],
    ["a password that is null", { ...valid, password: null }, "password must be a string"],
    ["a password that is a number", { ...valid, password: 12345678 }, "password must be a string"],
    ["an empty password", { ...valid, password: "" }, "password is too short"],
    ["a password of 7 characters", { ...valid, password: "1234567" }, "password is too short"],
    ["a password of 7 emoji", { ...valid, password: "🔑".repeat(7) }, "password is too short"],
    ["a password of 71 characters", { ...valid, password: "p".repeat(71) }, "password must be at most 70 characters"],
    ["a password of 71 emoji", { ...valid, password: "🔑".repeat(71) }, "password must be at most 70 characters"],
  ];

  test.each(invalid)("setup refuses %s", async (_what, body, message) => {
    const res = await s.client().post("/setup", body);
    expectInvalid(res, message);
    expectApiHeaders(res.headers);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("fields are checked in the order workspace name, name, email, password", async () => {
    expectInvalid(await s.client().post("/setup", { workspaceName: "", name: "", email: "", password: "" }), "workspaceName is required");
    expectInvalid(await s.client().post("/setup", { workspaceName: "A", name: "", email: "", password: "" }), "name is required");
    expectInvalid(await s.client().post("/setup", { workspaceName: "A", name: "B", email: "", password: "" }), "email is too short");
    expectInvalid(await s.client().post("/setup", { workspaceName: "A", name: "B", email: "abc", password: "" }), "Invalid email address");
    expectInvalid(await s.client().post("/setup", { workspaceName: "A", name: "B", email: "a@b.co", password: "" }), "password is too short");
  });

  test("nothing was created by the refused attempts", async () => {
    expectBody(await s.client().get("/setup"), 200, { data: { needsSetup: true } });
    expect(await s.sql`SELECT 1 FROM users`).toHaveLength(0);
    expect(await s.sql`SELECT 1 FROM workspace`).toHaveLength(0);
  });

  test("setup creates the owner and signs them in; names are trimmed, the email is lower-cased, the password is kept as typed", async () => {
    expect([...workspaceName].length).toBe(100);
    expect([...name].length).toBe(50);
    expect([...password].length).toBe(70);
    const owner = s.client({ ip: "203.0.113.5" });
    const res = await owner.request(
      "POST",
      "/setup",
      { workspaceName: `  ${workspaceName}\n`, name: `\t${name}  `, email: "  Owner.Name+Tag@Example.COM ", password, extra: "ignored" },
      { "User-Agent": "Setup/1.0" },
    );
    expectBody(res, 200, {
      // The user is answered as created: the sign-in that follows is not in `lastLoginAt` yet.
      data: { user: userShape({ email: "owner.name+tag@example.com", name, role: "owner", lastLoginAt: null }) },
    });
    expectApiHeaders(res.headers);
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(SESSION_COOKIE)]);
    const user = res.body.data.user;

    const me = await owner.get("/me");
    expectBody(me, 200, {
      data: {
        user: userShape({ id: user.id, email: "owner.name+tag@example.com", name, role: "owner", createdAt: user.createdAt }),
        workspace: {
          name: workspaceName,
          description: null,
          logoUrl: null,
          emailDomains: [],
          settings: {},
          defaultSpaceId: expect.stringMatching(UUID),
          createdAt: expect.stringMatching(ISO),
        },
      },
    });

    // The default group with the owner in it, and the General space with the owner as its admin.
    expectBody(await owner.get("/groups"), 200, {
      data: [{ id: expect.stringMatching(UUID), name: "Everyone", description: "Every member of the workspace", isDefault: true, memberCount: 1 }],
    });
    const groupId = (await owner.get("/groups")).body.data[0].id;
    expectBody(await owner.get(`/groups/${groupId}/members`), 200, { data: { items: [me.body.data.user], total: 1 } });
    expectBody(await owner.get("/spaces"), 200, {
      data: [
        {
          id: me.body.data.workspace.defaultSpaceId,
          name: "General",
          slug: "general",
          description: null,
          iconUrl: null,
          settings: {},
          role: "admin",
          memberCount: 1,
          createdAt: expect.stringMatching(ISO),
        },
      ],
    });
    const spaceMembers = await owner.get(`/spaces/${me.body.data.workspace.defaultSpaceId}/members`);
    expect(spaceMembers.body.data).toEqual([expect.objectContaining({ role: "admin", user: expect.objectContaining({ id: user.id, name }) })]);

    const [row] = await s.sql`SELECT email, name, password_hash, role, invited_by, deactivated_at, auth_sub, email_from_provider FROM users`;
    expect(row).toEqual({
      email: "owner.name+tag@example.com",
      name,
      password_hash: expect.stringMatching(ARGON2_HASH),
      role: "owner",
      invited_by: null,
      deactivated_at: null,
      auth_sub: null,
      email_from_provider: false,
    });
    expect(await Bun.password.verify(password, row.password_hash)).toBe(true);
    const [session] = await s.sql`SELECT user_id, token_hash, user_agent, ip FROM sessions`;
    expect(session).toEqual({ user_id: user.id, token_hash: sha256(owner.cookie!), user_agent: "Setup/1.0", ip: "203.0.113.5" });

    expectBody(await s.client().get("/setup"), 200, { data: { needsSetup: false } });
    expectBody(await s.client().get("/workspace/public"), 200, { data: { name: workspaceName, logoUrl: null } });
  });

  test("the owner signs in with the password exactly as typed at setup, spaces included", async () => {
    const login = (email: string, pass: string) => s.client().post("/auth/login", { email, password: pass });
    expect((await login("owner.name+tag@example.com", password)).status).toBe(200);
    expect((await login("OWNER.NAME+TAG@EXAMPLE.COM", password)).status).toBe(200);
    expectBody(await login("owner.name+tag@example.com", password.trim()), 401, INVALID_CREDENTIALS);
    expectBody(await login("owner.name+tag@example.com", password.slice(1)), 401, INVALID_CREDENTIALS);
    expectBody(await login("owner.name@example.com", password), 401, INVALID_CREDENTIALS);
  });

  test("setup cannot run twice", async () => {
    const res = await s.client().post("/setup", { workspaceName: "Other", name: "Intruder", email: "intruder@example.com", password: "intruder-password" });
    expectError(res, 403, "forbidden", "Setup has already been completed");
    expect(res.headers.getSetCookie()).toEqual([]);
    // The same email is refused the same way, and the body is still validated first.
    expectError(await s.client().post("/setup", { ...valid, email: "owner.name+tag@example.com" }), 403, "forbidden", "Setup has already been completed");
    expectInvalid(await s.client().post("/setup", { ...valid, password: "short" }), "password is too short");
    expect(await rows(s.sql`SELECT email FROM users`)).toEqual([{ email: "owner.name+tag@example.com" }]);
    expect((await s.sql`SELECT name FROM workspace`)[0].name).toBe(workspaceName);
  });
});

describe("several setups at the same moment", () => {
  let s: TestServer;

  beforeAll(async () => {
    s = await startServer();
  });

  afterAll(async () => {
    await s.close();
  });

  test("exactly one of them wins; the workspace is set up once", async () => {
    const attempts = await Promise.all(
      ["a", "b", "c", "d"].map((who) =>
        s.client().post("/setup", { workspaceName: `Workspace ${who}`, name: `Owner ${who}`, email: `${who}@example.com`, password: "owner-password" }),
      ),
    );
    expect(attempts.map((res) => res.status).sort()).toEqual([200, 403, 403, 403]);
    for (const res of attempts.filter((r) => r.status === 403)) expectError(res, 403, "forbidden", "Setup has already been completed");
    const winner = attempts.find((res) => res.status === 200)!.body.data.user;
    expect(await rows(s.sql`SELECT id, role FROM users`)).toEqual([{ id: winner.id, role: "owner" }]);
    expect(await rows(s.sql`SELECT name FROM workspace`)).toEqual([{ name: `Workspace ${winner.email[0]}` }]);
    expect(await rows(s.sql`SELECT name FROM groups`)).toEqual([{ name: "Everyone" }]);
    expect(await rows(s.sql`SELECT slug FROM spaces`)).toEqual([{ slug: "general" }]);
    expect(await rows(s.sql`SELECT user_id FROM sessions`)).toEqual([{ user_id: winner.id }]);
  });
});

describe("sign-in, sessions and passwords", () => {
  let t: TestServer;
  let owner: Client;
  let ownerUser: any;

  beforeAll(async () => {
    t = await startServer();
    ({ owner, user: ownerUser } = await t.setupOwner());
  });

  afterAll(async () => {
    await t.close();
  });

  const sessionRow = async (client: Client) => (await t.sql`SELECT * FROM sessions WHERE token_hash = ${sha256(client.cookie!)}`)[0];

  describe("GET /auth/config and the single sign-on endpoints, with single sign-on off", () => {
    test("the configuration says passwords only", async () => {
      const res = await t.client().get("/auth/config");
      expectBody(res, 200, { data: { sso: { enabled: false, localLogin: true } } });
      expectApiHeaders(res.headers);
      expectBody(await owner.get("/auth/config"), 200, { data: { sso: { enabled: false, localLogin: true } } });
    });

    test("the provider's endpoints answer like unknown ones", async () => {
      expectBody(await t.client().get("/auth/login"), 404, NOT_FOUND);
      expectBody(await t.client().get("/auth/login?returnTo=/s/general"), 404, NOT_FOUND);
      expectBody(await t.client().get("/auth/callback?code=abc&state=def"), 404, NOT_FOUND);
      expectBody(await t.client().post("/auth/events", {}), 404, NOT_FOUND);
      expectBody(await owner.get("/auth/login"), 404, NOT_FOUND);
      const head = await t.client().raw("HEAD", "/auth/login");
      expect(head.status).toBe(404);
      expect(head.headers.getSetCookie()).toEqual([]);
    });

    test("users carry no single sign-on fields", async () => {
      const me = await owner.get("/me");
      expect(Object.keys(me.body.data.user).sort()).toEqual(["avatarUrl", "createdAt", "email", "id", "lastLoginAt", "locale", "name", "preferences", "role", "timezone"]);
    });
  });

  describe("GET /setup and POST /setup once the workspace exists", () => {
    test("the status is public and says no setup is needed", async () => {
      expectBody(await t.client().get("/setup"), 200, { data: { needsSetup: false } });
      expectBody(await owner.get("/setup"), 200, { data: { needsSetup: false } });
    });

    test("setup is limited to 10 attempts a minute per address, counted before the body is read", async () => {
      const client = t.client({ ip: "198.51.100.10" });
      for (let i = 0; i < 10; i++) expectInvalid(await client.post("/setup", {}), "workspaceName must be a string");
      const res = await client.post("/setup", {});
      expectBody(res, 429, RATE_LIMITED);
      expectApiHeaders(res.headers);
      expect(res.headers.get("retry-after")).toBeNull();
      expectBody(await client.post("/setup", { workspaceName: "A", name: "B", email: "c@example.com", password: "long-enough" }), 429, RATE_LIMITED);
      // Another address is not held back, and neither is another endpoint from this address.
      expectInvalid(await t.client({ ip: "198.51.100.11" }).post("/setup", {}), "workspaceName must be a string");
      expectBody(await client.get("/setup"), 200, { data: { needsSetup: false } });
      expectInvalid(await client.post("/auth/login", {}), "email must be a string");
    });
  });

  describe("POST /auth/login", () => {
    test("answers the user, sets the session cookie and records the session", async () => {
      const client = t.client({ ip: "203.0.113.20" });
      const before = Date.now();
      const res = await client.request("POST", "/auth/login", { email: "owner@example.com", password: "owner-password" }, { "User-Agent": "Mozilla/5.0 (API suite)" });
      const after = Date.now();
      expectBody(res, 200, { data: { user: userShape({ id: ownerUser.id, email: "owner@example.com", name: "Owner", role: "owner", createdAt: ownerUser.createdAt }) } });
      expectApiHeaders(res.headers);
      expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(SESSION_COOKIE)]);
      expect(res.headers.getSetCookie()[0]).toBe(`session=${client.cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
      expect(client.cookie).toMatch(TOKEN);

      const row = await sessionRow(client);
      expect(row).toEqual({
        id: expect.stringMatching(UUID),
        user_id: ownerUser.id,
        token_hash: sha256(client.cookie!),
        user_agent: "Mozilla/5.0 (API suite)",
        ip: "203.0.113.20",
        created_at: expect.any(Date),
        last_seen_at: expect.any(Date),
        expires_at: expect.any(Date),
        auth_sid: null,
        auth_refresh_token: null,
        auth_recheck_at: null,
      });
      expect(row.last_seen_at).toEqual(row.created_at);
      expect(row.created_at.getTime()).toBeGreaterThanOrEqual(before - 2000);
      expect(row.created_at.getTime()).toBeLessThanOrEqual(after + 2000);
      // Thirty days from now.
      expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY - 2000);
      expect(row.expires_at.getTime()).toBeLessThanOrEqual(after + 30 * DAY + 2000);
      expect((await client.get("/me")).status).toBe(200);
    });

    test("the email is matched whatever its case and with spaces around it", async () => {
      for (const email of ["OWNER@EXAMPLE.COM", "Owner@Example.Com", "  owner@example.com\n", "\towner@EXAMPLE.com "]) {
        const res = await t.client().post("/auth/login", { email, password: "owner-password" });
        expect({ email, status: res.status, answered: res.body.data?.user.email }).toEqual({ email, status: 200, answered: "owner@example.com" });
      }
    });

    test("an email stored with capitals is matched too, and answered as stored", async () => {
      const { user } = await t.addMember(owner, "capitals@example.com");
      await t.sql`UPDATE users SET email = 'Capitals@Example.com' WHERE id = ${user.id}`;
      for (const email of ["capitals@example.com", "CAPITALS@EXAMPLE.COM", "Capitals@Example.com"]) {
        const res = await t.client().post("/auth/login", { email, password: "member-password" });
        expect(res.status).toBe(200);
        expect(res.body.data.user.email).toBe("Capitals@Example.com");
      }
    });

    test("a wrong password, an unknown address and a deactivated account are refused alike, without a cookie", async () => {
      const { user } = await t.addMember(owner, "deactivated@example.com");
      expectBody(await owner.post("/members/deactivate", { userId: user.id }), 200, { data: {} });
      const attempts = [
        { email: "owner@example.com", password: "wrong-password" },
        { email: "owner@example.com", password: "owner-passwor" },
        { email: "owner@example.com", password: "owner-password1" },
        { email: "owner@example.com", password: "OWNER-PASSWORD" },
        { email: "nobody@example.com", password: "owner-password" },
        { email: "owner@example.co", password: "owner-password" },
        { email: "not-an-email", password: "owner-password" },
        { email: "deactivated@example.com", password: "member-password" },
        { email: "deactivated@example.com", password: "wrong-password" },
      ];
      for (const body of attempts) {
        const res = await t.client().post("/auth/login", body);
        expect({ ...body, status: res.status, answer: res.body as unknown }).toEqual({ ...body, status: 401, answer: INVALID_CREDENTIALS });
        expectApiHeaders(res.headers);
        expect(res.headers.getSetCookie()).toEqual([]);
        expect(res.headers.get("www-authenticate")).toBeNull();
      }
      // Once activated again, the same password works.
      expectBody(await owner.post("/members/activate", { userId: user.id }), 200, { data: {} });
      expect((await t.client().post("/auth/login", { email: "deactivated@example.com", password: "member-password" })).status).toBe(200);
    });

    test("the password is not trimmed", async () => {
      for (const password of [" owner-password", "owner-password ", "owner-password\n", "\towner-password"]) {
        expectBody(await t.client().post("/auth/login", { email: "owner@example.com", password }), 401, INVALID_CREDENTIALS);
      }
    });

    const invalid: [string, Record<string, unknown>, string][] = [
      ["an empty body", {}, "email must be a string"],
      ["an email that is null", { email: null, password: "x" }, "email must be a string"],
      ["an email that is a number", { email: 5, password: "x" }, "email must be a string"],
      ["an email that is a list", { email: ["owner@example.com"], password: "x" }, "email must be a string"],
      ["an empty email", { email: "", password: "x" }, "email is too short"],
      ["a blank email", { email: "    ", password: "x" }, "email is too short"],
      ["an email of two characters", { email: "ab", password: "x" }, "email is too short"],
      ["an email of 255 characters", { email: "a".repeat(255), password: "x" }, "email must be at most 254 characters"],
      ["no password", { email: "owner@example.com" }, "password must be a string"],
      ["a password that is null", { email: "owner@example.com", password: null }, "password must be a string"],
      ["a password that is a number", { email: "owner@example.com", password: 12345678 }, "password must be a string"],
      ["an empty password", { email: "owner@example.com", password: "" }, "password is required"],
      ["a password of 201 characters", { email: "owner@example.com", password: "p".repeat(201) }, "password must be at most 200 characters"],
      ["a password of 201 emoji", { email: "owner@example.com", password: "🔑".repeat(201) }, "password must be at most 200 characters"],
    ];

    test.each(invalid)("refuses %s", async (_what, body, message) => {
      const res = await t.client().post("/auth/login", body);
      expectInvalid(res, message);
      expect(res.headers.getSetCookie()).toEqual([]);
    });

    test("anything within the limits is tried as credentials: three characters, 254 characters, a password of spaces or of 200 characters", async () => {
      const attempts = [
        { email: "abc", password: "x" },
        { email: "a".repeat(254), password: "x" },
        { email: "owner@example.com", password: " " },
        { email: "owner@example.com", password: "p".repeat(200) },
        { email: "owner@example.com", password: "🔑".repeat(200) },
      ];
      for (const body of attempts) expectBody(await t.client().post("/auth/login", body), 401, INVALID_CREDENTIALS);
    });

    test("the user is answered as they were before this sign-in", async () => {
      // Accident: `lastLoginAt` in the answer is the previous sign-in, not this one.
      const { user } = await t.addMember(owner, "stale@example.com");
      await t.sql`UPDATE users SET last_login_at = NULL WHERE id = ${user.id}`;
      const client = t.client();
      const res = await client.post("/auth/login", { email: "stale@example.com", password: "member-password" });
      expectBody(res, 200, { data: { user: userShape({ id: user.id, email: "stale@example.com", name: "stale", lastLoginAt: null }) } });
      const first = (await client.get("/me")).body.data.user.lastLoginAt;
      expect(first).toMatch(ISO);
      const again = await t.client().post("/auth/login", { email: "stale@example.com", password: "member-password" });
      expect(again.body.data.user.lastLoginAt).toBe(first);
      expect(Date.parse((await client.get("/me")).body.data.user.lastLoginAt)).toBeGreaterThan(Date.parse(first));
    });

    test("signing in again starts another session and leaves the earlier ones alone", async () => {
      const { client: first } = await t.addMember(owner, "twice@example.com");
      const second = await signIn(t, "twice@example.com", "member-password");
      const firstCookie = first.cookie;
      // Even from a client that is already signed in: it gets a new cookie, the old session lives on.
      const res = await first.post("/auth/login", { email: "twice@example.com", password: "member-password" });
      expect(res.status).toBe(200);
      expect(first.cookie).not.toBe(firstCookie);
      const old = t.client();
      old.cookie = firstCookie;
      expect((await old.get("/me")).status).toBe(200);
      expect((await second.get("/me")).status).toBe(200);
      expect((await first.get("/auth/sessions")).body.data).toHaveLength(3);
    });

    test("the user agent is recorded, cut at 500 characters, and left empty when there is none", async () => {
      const long = await signIn(t, "owner@example.com", "owner-password", { "User-Agent": `${"A".repeat(499)}BC` });
      expect((await sessionRow(long)).user_agent).toBe(`${"A".repeat(499)}B`);
      const exact = await signIn(t, "owner@example.com", "owner-password", { "User-Agent": "U".repeat(500) });
      expect((await sessionRow(exact)).user_agent).toBe("U".repeat(500));
      const none = await signIn(t, "owner@example.com", "owner-password", { "User-Agent": "" });
      expect((await sessionRow(none)).user_agent).toBeNull();
      const sessions = (await none.get("/auth/sessions")).body.data;
      expect(sessions.find((s: any) => s.current).userAgent).toBeNull();
      expect(sessions.map((s: any) => s.userAgent)).toContain(`${"A".repeat(499)}B`);
      for (const client of [long, exact, none]) await client.post("/auth/logout");
    });

    test("passwords are stored as argon2id hashes that Bun's own verifier accepts", async () => {
      const rows = await t.sql`SELECT password_hash FROM users`;
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) expect(row.password_hash).toMatch(ARGON2_HASH);
      const [ownerRow] = await t.sql`SELECT password_hash FROM users WHERE id = ${ownerUser.id}`;
      expect(await Bun.password.verify("owner-password", ownerRow.password_hash)).toBe(true);
      expect(await Bun.password.verify("owner-passwore", ownerRow.password_hash)).toBe(false);
      // Each hash has its own salt.
      expect(new Set(rows.map((row: any) => row.password_hash)).size).toBe(rows.length);
    });

    test("hashes written elsewhere are accepted: by the Bun server, and by the reference argon2 with other parameters", async () => {
      const { user } = await t.addMember(owner, "imported@example.com");
      const hashes: [string, string][] = [
        // Written by the Bun server (32-byte salt).
        ["owner-password", "$argon2id$v=19$m=19456,t=2,p=1$ClCH1ICJStT4M7HGUvCiFt9OYeiawcBgl44DmzvNi9c$1OG4jo9d7/S5E0Pk0Ux1y9X/jR7P13uM+LzoR8n3x7w"],
        // Written by the reference implementation (argon2-cffi): a 16-byte salt, and a UTF-8 password.
        ["pässwörd 🔑 密码", "$argon2id$v=19$m=19456,t=2,p=1$Ef1UalJfX7ag4+lPdcoB2Q$qXks+81ne/24XhgwySUidxsDijTQ+hgXjFB8JLy1uLU"],
        // The same with other costs and four lanes: the parameters come from the hash.
        ["correct horse battery staple", "$argon2id$v=19$m=65536,t=3,p=4$exrNRqxFN6Pq6a2XjmHwPQ$JI9i9dr076DsFZIwSlBhI3WknTxKJ5t/Y+PagxNep/k"],
      ];
      for (const [password, hash] of hashes) {
        await t.sql`UPDATE users SET password_hash = ${hash} WHERE id = ${user.id}`;
        expect((await t.client().post("/auth/login", { email: "imported@example.com", password })).status).toBe(200);
        expectBody(await t.client().post("/auth/login", { email: "imported@example.com", password: `${password}x` }), 401, INVALID_CREDENTIALS);
      }
    });

    test("an account without a password, or with something that is no hash, cannot sign in with any", async () => {
      const { user } = await t.addMember(owner, "nopassword@example.com");
      for (const hash of [null, "", "member-password", "$argon2id$v=19$m=19456,t=2,p=1$bm90IGEgaGFzaA", "$2b$10$abcdefghijklmnopqrstuv"]) {
        await t.sql`UPDATE users SET password_hash = ${hash} WHERE id = ${user.id}`;
        for (const password of ["member-password", "timing-equalizer", " "]) {
          expectBody(await t.client().post("/auth/login", { email: "nopassword@example.com", password }), 401, INVALID_CREDENTIALS);
        }
      }
    });

    test("sign-in is limited to 10 attempts a minute per address, right or wrong", async () => {
      const client = t.client({ ip: "198.51.100.20" });
      for (let i = 0; i < 10; i++) expectBody(await client.post("/auth/login", { email: "owner@example.com", password: "wrong-password" }), 401, INVALID_CREDENTIALS);
      const res = await client.post("/auth/login", { email: "owner@example.com", password: "owner-password" });
      expectBody(res, 429, RATE_LIMITED);
      expectApiHeaders(res.headers);
      expect(res.headers.getSetCookie()).toEqual([]);
      expectBody(await client.post("/auth/login", {}), 429, RATE_LIMITED);
      // Other addresses and other endpoints are not affected.
      expect((await t.client({ ip: "198.51.100.21" }).post("/auth/login", { email: "owner@example.com", password: "owner-password" })).status).toBe(200);
      expectBody(await client.post("/auth/forgot-password", { email: "nobody@example.com" }), 200, { data: {} });
    });

    test("attempts that fail validation count as well", async () => {
      const client = t.client({ ip: "198.51.100.22" });
      for (let i = 0; i < 10; i++) expectInvalid(await client.post("/auth/login", {}), "email must be a string");
      expectBody(await client.post("/auth/login", { email: "owner@example.com", password: "owner-password" }), 429, RATE_LIMITED);
    });

    test("successful sign-ins count too", async () => {
      const client = t.client({ ip: "198.51.100.23" });
      for (let i = 0; i < 10; i++) expect((await client.post("/auth/login", { email: "owner@example.com", password: "owner-password" })).status).toBe(200);
      expectBody(await client.post("/auth/login", { email: "owner@example.com", password: "owner-password" }), 429, RATE_LIMITED);
      // The session it already has still works.
      expect((await client.get("/me")).status).toBe(200);
      await t.sql`DELETE FROM sessions WHERE ip = '198.51.100.23'`;
    });
  });

  describe("POST /auth/logout", () => {
    test("ends the session and clears the cookie; other sessions of the user stay", async () => {
      const { client: first } = await t.addMember(owner, "leaver@example.com");
      const second = await signIn(t, "leaver@example.com", "member-password");
      const value = first.cookie!;
      const res = await first.post("/auth/logout");
      expectBody(res, 200, { data: {} });
      expectApiHeaders(res.headers);
      expect(res.headers.getSetCookie()).toEqual([CLEARED_COOKIE]);
      expect(first.cookie).toBeNull();
      expect(await t.sql`SELECT 1 FROM sessions WHERE token_hash = ${sha256(value)}`).toHaveLength(0);

      const replay = t.client();
      replay.cookie = value;
      expectBody(await replay.get("/me"), 401, UNAUTHORIZED);
      expectBody(await replay.post("/auth/logout"), 401, UNAUTHORIZED);
      expect((await second.get("/me")).status).toBe(200);
      expect((await second.get("/auth/sessions")).body.data).toHaveLength(1);
    });

    test("needs a session, and takes no body or any body", async () => {
      const anonymous = await t.client().post("/auth/logout");
      expectBody(anonymous, 401, UNAUTHORIZED);
      expect(anonymous.headers.getSetCookie()).toEqual([]);
      const bare = await signIn(t, "owner@example.com", "owner-password");
      const res = await bare.raw("POST", "/auth/logout");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"data":{}}');
      const odd = await signIn(t, "owner@example.com", "owner-password");
      expect((await odd.raw("POST", "/auth/logout", { body: "not json", headers: { "Content-Type": "text/plain" } })).status).toBe(200);
      expect(odd.cookie).toBeNull();
    });

    test("without single sign-on there is no provider to sign out of, even for a session that has a provider session id", async () => {
      const client = await signIn(t, "owner@example.com", "owner-password");
      await t.sql`UPDATE sessions SET auth_sid = 'provider-session', auth_refresh_token = 'refresh' WHERE token_hash = ${sha256(client.cookie!)}`;
      expect((await client.get("/me")).status).toBe(200);
      const res = await client.post("/auth/logout");
      expectBody(res, 200, { data: {} });
      expect(res.headers.getSetCookie()).toEqual([CLEARED_COOKIE]);
    });
  });

  describe("GET /auth/sessions", () => {
    test("lists the user's live sessions, the most recently used first, and marks the caller's", async () => {
      const { client: a, user } = await t.addMember(owner, "sessions@example.com");
      const b = t.client({ ip: "203.0.113.31" });
      await b.request("POST", "/auth/login", { email: "sessions@example.com", password: "member-password" }, { "User-Agent": "Browser B" });
      const c = t.client({ ip: "203.0.113.32" });
      await c.request("POST", "/auth/login", { email: "sessions@example.com", password: "member-password" }, { "User-Agent": "" });
      const expired = await signIn(t, "sessions@example.com", "member-password");

      const id = async (client: Client) => (await sessionRow(client)).id;
      const [idA, idB, idC, idExpired] = [await id(a), await id(b), await id(c), await id(expired)];
      await t.sql`UPDATE sessions SET last_seen_at = now() - interval '30 seconds' WHERE id = ${idA}`;
      await t.sql`UPDATE sessions SET last_seen_at = now() - interval '10 seconds' WHERE id = ${idB}`;
      await t.sql`UPDATE sessions SET last_seen_at = now() - interval '20 seconds' WHERE id = ${idC}`;
      await t.sql`UPDATE sessions SET last_seen_at = now(), expires_at = now() - interval '1 second' WHERE id = ${idExpired}`;

      const res = await a.get("/auth/sessions");
      expectBody(res, 200, {
        data: [
          { id: idB, userAgent: "Browser B", ip: "203.0.113.31", createdAt: expect.stringMatching(ISO), lastSeenAt: expect.stringMatching(ISO), current: false },
          { id: idC, userAgent: null, ip: "203.0.113.32", createdAt: expect.stringMatching(ISO), lastSeenAt: expect.stringMatching(ISO), current: false },
          { id: idA, userAgent: expect.stringMatching(/^Bun\//), ip: a.ip, createdAt: expect.stringMatching(ISO), lastSeenAt: expect.stringMatching(ISO), current: true },
        ],
      });
      expectApiHeaders(res.headers);
      const rowA = await sessionRow(a);
      expect(res.body.data[2].createdAt).toBe(rowA.created_at.toISOString());
      expect(res.body.data[2].lastSeenAt).toBe(rowA.last_seen_at.toISOString());
      expect(Date.parse(res.body.data[0].lastSeenAt)).toBeGreaterThan(Date.parse(res.body.data[1].lastSeenAt));

      // The same list for another of the sessions, with the mark on that one.
      const fromB = (await b.get("/auth/sessions")).body.data;
      expect(fromB.map((s: any) => [s.id, s.current])).toEqual([[idB, true], [idC, false], [idA, false]]);
      // Nobody else's sessions are in it.
      const others = (await owner.get("/auth/sessions")).body.data;
      expect(others.some((s: any) => [idA, idB, idC].includes(s.id))).toBe(false);
      expect((await t.sql`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${user.id}`)[0].n).toBe(4);
    });

    test("needs a session", async () => {
      expectBody(await t.client().get("/auth/sessions"), 401, UNAUTHORIZED);
    });
  });

  describe("POST /auth/sessions/revoke", () => {
    beforeAll(async () => {
      await t.addMember(owner, "revoker@example.com");
    });

    test("revoking another of your sessions signs that one out and keeps the cookie of this one", async () => {
      const here = await signIn(t, "revoker@example.com", "member-password");
      const there = await signIn(t, "revoker@example.com", "member-password");
      const target = { id: (await sessionRow(there)).id as string };
      const res = await here.post("/auth/sessions/revoke", { id: target.id });
      expectBody(res, 200, { data: {} });
      expect(res.headers.getSetCookie()).toEqual([]);
      expectBody(await there.get("/me"), 401, UNAUTHORIZED);
      expect((await here.get("/auth/sessions")).body.data.some((s: any) => s.id === target.id)).toBe(false);
      expect((await here.get("/me")).status).toBe(200);
    });

    test("revoking your own session clears the cookie", async () => {
      const client = await signIn(t, "revoker@example.com", "member-password");
      const value = client.cookie!;
      const current = (await client.get("/auth/sessions")).body.data.find((s: any) => s.current);
      const res = await client.post("/auth/sessions/revoke", { id: current.id });
      expectBody(res, 200, { data: {} });
      expect(res.headers.getSetCookie()).toEqual([CLEARED_COOKIE]);
      const replay = t.client();
      replay.cookie = value;
      expectBody(await replay.get("/me"), 401, UNAUTHORIZED);
    });

    test("the id may be written in capitals", async () => {
      const here = await signIn(t, "revoker@example.com", "member-password");
      const there = await signIn(t, "revoker@example.com", "member-password");
      const thereId: string = (await sessionRow(there)).id;
      expectBody(await here.post("/auth/sessions/revoke", { id: thereId.toUpperCase() }), 200, { data: {} });
      expectBody(await there.get("/me"), 401, UNAUTHORIZED);
      // The caller's own id in capitals clears the cookie as well.
      const hereId: string = (await sessionRow(here)).id;
      const res = await here.post("/auth/sessions/revoke", { id: hereId.toUpperCase() });
      expectBody(res, 200, { data: {} });
      expect(res.headers.getSetCookie()).toEqual([CLEARED_COOKIE]);
    });

    test("someone else's session id, or an unknown one, does nothing", async () => {
      const { client: intruder } = await t.addMember(owner, "intruder@example.com");
      const victim = await signIn(t, "revoker@example.com", "member-password");
      const victimSession = (await victim.get("/auth/sessions")).body.data.find((s: any) => s.current);
      const res = await intruder.post("/auth/sessions/revoke", { id: victimSession.id });
      expectBody(res, 200, { data: {} });
      expect(res.headers.getSetCookie()).toEqual([]);
      expect((await victim.get("/me")).status).toBe(200);
      expectBody(await intruder.post("/auth/sessions/revoke", { id: "00000000-0000-4000-8000-000000000000" }), 200, { data: {} });
      expect((await intruder.get("/me")).status).toBe(200);
      // Not even a workspace owner revokes someone else's session here.
      expectBody(await owner.post("/auth/sessions/revoke", { id: victimSession.id }), 200, { data: {} });
      expect((await victim.get("/me")).status).toBe(200);
    });

    test("the id must be a UUID", async () => {
      for (const body of [{}, { id: null }, { id: "" }, { id: "nope" }, { id: 5 }, { id: ["00000000-0000-4000-8000-000000000000"] }, { id: "00000000-0000-4000-8000-00000000000" }, { id: " 00000000-0000-4000-8000-000000000000" }, { id: "{00000000-0000-4000-8000-000000000000}" }, { id: "00000000000040008000000000000000" }]) {
        expectInvalid(await owner.post("/auth/sessions/revoke", body), "id must be a valid id");
      }
      expectBody(await t.client().post("/auth/sessions/revoke", { id: "nope" }), 401, UNAUTHORIZED);
    });
  });

  describe("POST /auth/forgot-password", () => {
    test("mails a reset link that is valid for 30 minutes, and answers an empty object", async () => {
      const { user } = await t.addMember(owner, "forgot@example.com");
      const res = await t.client().post("/auth/forgot-password", { email: "forgot@example.com" });
      expectBody(res, 200, { data: {} });
      expectApiHeaders(res.headers);
      expect(res.headers.getSetCookie()).toEqual([]);

      const mail = (await waitForMailsTo(t, "forgot@example.com", 2))[1]!;
      const token = resetToken(mail);
      expect(token).toMatch(TOKEN);
      expectMail(mail, {
        to: "forgot@example.com",
        subject: "Reset your Acme password",
        paragraphs: ["Hi forgot,", "Someone asked to reset your password. The link below is valid for 30 minutes. If it was not you, ignore this email."],
        action: { label: "Reset password", url: `http://doc.test/reset-password?token=${token}` },
      });
      // Written out once in full, so the helper above is checked too.
      expect(mail.text).toBe(
        `Hi forgot,\n\nSomeone asked to reset your password. The link below is valid for 30 minutes. If it was not you, ignore this email.\n\nReset password: http://doc.test/reset-password?token=${token}`,
      );
      expect(mail.html).toBe(
        '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#222;line-height:1.5"><div style="max-width:560px;margin:0 auto;padding:24px">' +
          '<p style="margin:0 0 16px">Hi forgot,</p>' +
          '<p style="margin:0 0 16px">Someone asked to reset your password. The link below is valid for 30 minutes. If it was not you, ignore this email.</p>' +
          `<p style="margin:24px 0"><a href="http://doc.test/reset-password?token=${token}" style="background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Reset password</a></p>` +
          `<p style="color:#666;font-size:12px">http://doc.test/reset-password?token=${token}</p></div></body></html>`,
      );

      // Only the token's hash is stored, for 30 minutes.
      const rows = await t.sql`SELECT purpose, token_hash, expires_at - created_at AS ttl, expires_at > now() AS live FROM user_tokens WHERE user_id = ${user.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0].purpose).toBe("password-reset");
      expect(rows[0].token_hash).toBe(sha256(token));
      expect(rows[0].live).toBe(true);
      expect((await t.sql`SELECT 1 AS ok FROM user_tokens WHERE user_id = ${user.id} AND expires_at - created_at = interval '30 minutes'`)).toHaveLength(1);
      // Asking does not end sessions or change the password.
      expect((await t.client().post("/auth/login", { email: "forgot@example.com", password: "member-password" })).status).toBe(200);
    });

    test("the address is matched whatever its case and spacing, and the mail goes to the address as stored", async () => {
      await t.addMember(owner, "forgot-case@example.com");
      expectBody(await t.client().post("/auth/forgot-password", { email: "  FORGOT-Case@EXAMPLE.com " }), 200, { data: {} });
      const mail = (await waitForMailsTo(t, "forgot-case@example.com", 2))[1]!;
      expect(mail.subject).toBe("Reset your Acme password");
      expect(mail.headers.to).toBe("<forgot-case@example.com>");
    });

    test("a new request replaces the earlier link", async () => {
      const { user } = await t.addMember(owner, "forgot-twice@example.com");
      await t.client().post("/auth/forgot-password", { email: "forgot-twice@example.com" });
      await t.client().post("/auth/forgot-password", { email: "forgot-twice@example.com" });
      const mails = await waitForMailsTo(t, "forgot-twice@example.com", 3);
      const [first, second] = [resetToken(mails[1]!), resetToken(mails[2]!)];
      expect(first).not.toBe(second);
      expect(await rows(t.sql`SELECT token_hash FROM user_tokens WHERE user_id = ${user.id}`)).toEqual([{ token_hash: sha256(second) }]);
      expectBody(await t.client().post("/auth/reset-password", { token: first, password: "brand-new-password" }), 400, INVALID_RESET);
      expect((await t.client().post("/auth/reset-password", { token: second, password: "brand-new-password" })).status).toBe(200);
    });

    test("names and workspace names are escaped in the HTML part and left alone in the subject and the text", async () => {
      const invited = await owner.post("/invitations", { emails: ["forgot-html@example.com"] });
      const link = new URL(invited.body.data[0].url);
      const name = 'Tom & "Jerry" <b>';
      await t.client().post("/invitations/accept", { id: link.pathname.split("/").pop(), token: link.searchParams.get("token"), name, password: "member-password" });
      await owner.post("/workspace/update", { name: 'R&D <"Lab">' });
      await t.client().post("/auth/forgot-password", { email: "forgot-html@example.com" });
      const mail = (await waitForMailsTo(t, "forgot-html@example.com", 2))[1]!;
      await owner.post("/workspace/update", { name: "Acme" });
      const url = `http://doc.test/reset-password?token=${resetToken(mail)}`;
      expect(mail.subject).toBe('Reset your R&D <"Lab"> password');
      expect(mail.text).toBe(`Hi Tom & "Jerry" <b>,\n\nSomeone asked to reset your password. The link below is valid for 30 minutes. If it was not you, ignore this email.\n\nReset password: ${url}`);
      expect(mail.html).toContain('<p style="margin:0 0 16px">Hi Tom &amp; &quot;Jerry&quot; &lt;b&gt;,</p>');
      expect(mail.html).toBe(
        mailHtml(["Hi Tom & \"Jerry\" <b>,", "Someone asked to reset your password. The link below is valid for 30 minutes. If it was not you, ignore this email."], { label: "Reset password", url }),
      );
    });

    test("a workspace without a name is called `workspace` in the subject", async () => {
      // The API never leaves the name empty, so it is emptied in the database.
      await t.addMember(owner, "forgot-noname@example.com");
      await t.sql`UPDATE workspace SET name = ''`;
      await t.client().post("/auth/forgot-password", { email: "forgot-noname@example.com" });
      const mail = (await waitForMailsTo(t, "forgot-noname@example.com", 2))[1]!;
      await t.sql`UPDATE workspace SET name = 'Acme'`;
      expect(mail.subject).toBe("Reset your workspace password");
    });

    test("an unknown address and a deactivated account get the same answer and no mail", async () => {
      const { user } = await t.addMember(owner, "forgot-off@example.com");
      await waitForMailsTo(t, "forgot-off@example.com", 1);
      await owner.post("/members/deactivate", { userId: user.id });
      expectBody(await t.client().post("/auth/forgot-password", { email: "forgot-off@example.com" }), 200, { data: {} });
      expectBody(await t.client().post("/auth/forgot-password", { email: "nobody@example.com" }), 200, { data: {} });
      expectBody(await t.client().post("/auth/forgot-password", { email: "not an address" }), 200, { data: {} });
      await flushMail(t, owner);
      expect(mailsTo(t, "forgot-off@example.com")).toHaveLength(1);
      expect(mailsTo(t, "nobody@example.com")).toHaveLength(0);
      expect(await t.sql`SELECT 1 FROM user_tokens WHERE user_id = ${user.id}`).toHaveLength(0);
    });

    const invalid: [string, Record<string, unknown>, string][] = [
      ["an empty body", {}, "email must be a string"],
      ["an email that is null", { email: null }, "email must be a string"],
      ["an email that is a number", { email: 1 }, "email must be a string"],
      ["an empty email", { email: "" }, "email is too short"],
      ["an email of two characters", { email: "a@" }, "email is too short"],
      ["an email of 255 characters", { email: "a".repeat(255) }, "email must be at most 254 characters"],
    ];

    test.each(invalid)("refuses %s", async (_what, body, message) => {
      expectInvalid(await t.client().post("/auth/forgot-password", body), message);
    });

    test("is limited to 10 requests a minute per address", async () => {
      const client = t.client({ ip: "198.51.100.30" });
      for (let i = 0; i < 10; i++) expectBody(await client.post("/auth/forgot-password", { email: "nobody@example.com" }), 200, { data: {} });
      const res = await client.post("/auth/forgot-password", { email: "nobody@example.com" });
      expectBody(res, 429, RATE_LIMITED);
      expectApiHeaders(res.headers);
      expectBody(await client.post("/auth/forgot-password", {}), 429, RATE_LIMITED);
      expectBody(await t.client({ ip: "198.51.100.31" }).post("/auth/forgot-password", { email: "nobody@example.com" }), 200, { data: {} });
      expectInvalid(await client.post("/auth/reset-password", {}), "token must be a string");
    });

    test("a request over the limit sends nothing", async () => {
      await t.addMember(owner, "forgot-limited@example.com");
      await waitForMailsTo(t, "forgot-limited@example.com", 1);
      const client = t.client({ ip: "198.51.100.32" });
      for (let i = 0; i < 10; i++) expectInvalid(await client.post("/auth/forgot-password", {}), "email must be a string");
      expectBody(await client.post("/auth/forgot-password", { email: "forgot-limited@example.com" }), 429, RATE_LIMITED);
      await flushMail(t, owner);
      expect(mailsTo(t, "forgot-limited@example.com")).toHaveLength(1);
    });
  });

  describe("POST /auth/reset-password", () => {
    /** A new member and the token of a reset link mailed to them. */
    const memberWithToken = async (email: string) => {
      const { client, user } = await t.addMember(owner, email);
      await t.client().post("/auth/forgot-password", { email });
      const mail = (await waitForMailsTo(t, email, 2))[1]!;
      return { client, user, token: resetToken(mail) };
    };

    test("sets the password, ends every session of the user, closes their sockets and signs in", async () => {
      const { client: before, user, token } = await memberWithToken("reset@example.com");
      const other = await signIn(t, "reset@example.com", "member-password");
      const socket = await connect(before);
      const ownerSocket = await connect(owner);

      const fresh = t.client({ ip: "203.0.113.40" });
      const res = await fresh.request("POST", "/auth/reset-password", { token, password: "brand-new-password" }, { "User-Agent": "Resetter" });
      expectBody(res, 200, { data: { user: userShape({ id: user.id, email: "reset@example.com", name: "reset" }) } });
      expectApiHeaders(res.headers);
      expect(res.headers.getSetCookie()).toEqual([`session=${fresh.cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`]);
      expect(fresh.cookie).toMatch(TOKEN);

      expect(await socket.closed).toEqual({ code: 4001, reason: "signed out" });
      expectBody(await before.get("/me"), 401, UNAUTHORIZED);
      expectBody(await other.get("/me"), 401, UNAUTHORIZED);
      // The only session left is the new one, recorded like a sign-in.
      expect(await rows(t.sql`SELECT token_hash, user_agent, ip FROM sessions WHERE user_id = ${user.id}`)).toEqual([
        { token_hash: sha256(fresh.cookie!), user_agent: "Resetter", ip: "203.0.113.40" },
      ]);
      expect((await fresh.get("/me")).body.data.user.lastLoginAt).toBe(res.body.data.user.lastLoginAt);

      expectBody(await t.client().post("/auth/login", { email: "reset@example.com", password: "member-password" }), 401, INVALID_CREDENTIALS);
      expect((await t.client().post("/auth/login", { email: "reset@example.com", password: "brand-new-password" })).status).toBe(200);
      const [row] = await t.sql`SELECT password_hash FROM users WHERE id = ${user.id}`;
      expect(row.password_hash).toMatch(ARGON2_HASH);
      expect(await Bun.password.verify("brand-new-password", row.password_hash)).toBe(true);
      expect(await t.sql`SELECT 1 FROM user_tokens WHERE user_id = ${user.id}`).toHaveLength(0);

      // Nobody else is signed out.
      ownerSocket.send({ t: "ping" });
      expect(await ownerSocket.nextOf("pong")).toEqual({ t: "pong" });
      await ownerSocket.close();
      expect((await owner.get("/me")).status).toBe(200);
    });

    test("a link works once", async () => {
      const { token } = await memberWithToken("reset-once@example.com");
      expect((await t.client().post("/auth/reset-password", { token, password: "brand-new-password" })).status).toBe(200);
      const again = await t.client().post("/auth/reset-password", { token, password: "another-password" });
      expectBody(again, 400, INVALID_RESET);
      expect(again.headers.getSetCookie()).toEqual([]);
      expect((await t.client().post("/auth/login", { email: "reset-once@example.com", password: "brand-new-password" })).status).toBe(200);
    });

    test("a link stops working 30 minutes after it was sent", async () => {
      const { user, token } = await memberWithToken("reset-late@example.com");
      await t.sql`UPDATE user_tokens SET expires_at = now() - interval '1 second' WHERE user_id = ${user.id}`;
      expectBody(await t.client().post("/auth/reset-password", { token, password: "brand-new-password" }), 400, INVALID_RESET);
      expect((await t.client().post("/auth/login", { email: "reset-late@example.com", password: "member-password" })).status).toBe(200);
      // A minute before the end it still works.
      await t.sql`UPDATE user_tokens SET expires_at = now() + interval '1 minute' WHERE user_id = ${user.id}`;
      expect((await t.client().post("/auth/reset-password", { token, password: "brand-new-password" })).status).toBe(200);
    });

    test("a link of a member who was deactivated since is refused, and kept", async () => {
      const { user, token } = await memberWithToken("reset-off@example.com");
      await owner.post("/members/deactivate", { userId: user.id });
      expectBody(await t.client().post("/auth/reset-password", { token, password: "brand-new-password" }), 400, INVALID_RESET);
      await owner.post("/members/activate", { userId: user.id });
      expect((await t.client().post("/auth/reset-password", { token, password: "brand-new-password" })).status).toBe(200);
    });

    test("what is not a token that was sent is refused: unknown, a session cookie, a hash, a token in another case", async () => {
      const { client, token } = await memberWithToken("reset-wrong@example.com");
      const swapped = token.replace(/[a-zA-Z]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
      for (const value of ["nope", "A".repeat(43), client.cookie!, sha256(token), swapped, `${token}x`, token.slice(1), "x".repeat(200)]) {
        expectBody(await t.client().post("/auth/reset-password", { token: value, password: "brand-new-password" }), 400, INVALID_RESET);
      }
      expect((await client.get("/me")).status).toBe(200);
      // Spaces around the token are dropped, as a pasted link might have them.
      expect((await t.client().post("/auth/reset-password", { token: `  ${token}\n`, password: "brand-new-password" })).status).toBe(200);
    });

    const invalid: [string, Record<string, unknown>, string][] = [
      ["an empty body", {}, "token must be a string"],
      ["a token that is null", { token: null, password: "long-enough" }, "token must be a string"],
      ["a token that is a number", { token: 1, password: "long-enough" }, "token must be a string"],
      ["an empty token", { token: "", password: "long-enough" }, "token is required"],
      ["a blank token", { token: "   ", password: "long-enough" }, "token is required"],
      ["a token of 201 characters", { token: "t".repeat(201), password: "long-enough" }, "token must be at most 200 characters"],
      ["no password", { token: "t" }, "password must be a string"],
      ["a password that is null", { token: "t", password: null }, "password must be a string"],
      ["a password of 7 characters", { token: "t", password: "1234567" }, "password is too short"],
      ["a password of 7 emoji", { token: "t", password: "🔑".repeat(7) }, "password is too short"],
      ["a password of 71 characters", { token: "t", password: "p".repeat(71) }, "password must be at most 70 characters"],
      ["a password of 71 CJK characters", { token: "t", password: "密".repeat(71) }, "password must be at most 70 characters"],
    ];

    test.each(invalid)("refuses %s", async (_what, body, message) => {
      expectInvalid(await t.client().post("/auth/reset-password", body), message);
    });

    test("the password is checked before the link, and an invalid one does not use the link up", async () => {
      const { token } = await memberWithToken("reset-order@example.com");
      expectInvalid(await t.client().post("/auth/reset-password", { token, password: "short" }), "password is too short");
      expect((await t.client().post("/auth/reset-password", { token, password: "brand-new-password" })).status).toBe(200);
    });

    test("the new password counts code points and is kept as typed: 8 emoji, 70 CJK characters, spaces", async () => {
      const cases = ["🔑".repeat(8), "密".repeat(70), "        ", "  padded  ", "pässwörd", "كلمة السر"];
      for (const [index, password] of cases.entries()) {
        const email = `reset-unicode-${index}@example.com`;
        const { token } = await memberWithToken(email);
        expect((await t.client().post("/auth/reset-password", { token, password })).status).toBe(200);
        expect((await t.client().post("/auth/login", { email, password })).status).toBe(200);
        if (password.trim() !== password && password.trim() !== "") {
          expectBody(await t.client().post("/auth/login", { email, password: password.trim() }), 401, INVALID_CREDENTIALS);
        }
      }
    });

    test("sends no mail", async () => {
      const { token } = await memberWithToken("reset-quiet@example.com");
      expect((await t.client().post("/auth/reset-password", { token, password: "brand-new-password" })).status).toBe(200);
      await flushMail(t, owner);
      expect(mailsTo(t, "reset-quiet@example.com")).toHaveLength(2);
    });

    test("is limited to 20 attempts a minute per address", async () => {
      const client = t.client({ ip: "198.51.100.40" });
      for (let i = 0; i < 20; i++) expectInvalid(await client.post("/auth/reset-password", {}), "token must be a string");
      const res = await client.post("/auth/reset-password", {});
      expectBody(res, 429, RATE_LIMITED);
      expectApiHeaders(res.headers);
      const { token } = await memberWithToken("reset-limited@example.com");
      expectBody(await client.post("/auth/reset-password", { token, password: "brand-new-password" }), 429, RATE_LIMITED);
      // The link was not used up by the refused attempt.
      expect((await t.client({ ip: "198.51.100.41" }).post("/auth/reset-password", { token, password: "brand-new-password" })).status).toBe(200);
    });
  });

  describe("POST /auth/change-password", () => {
    let unchanged: Client;

    beforeAll(async () => {
      ({ client: unchanged } = await t.addMember(owner, "changer-unchanged@example.com"));
    });

    test("changes the password, ends the user's other sessions, keeps this one and mails a notice", async () => {
      const { client, user } = await t.addMember(owner, "changer@example.com");
      const other = await signIn(t, "changer@example.com", "member-password");
      const third = await signIn(t, "changer@example.com", "member-password");
      const res = await client.post("/auth/change-password", { currentPassword: "member-password", newPassword: "next-password" });
      expectBody(res, 200, { data: {} });
      expectApiHeaders(res.headers);
      expect(res.headers.getSetCookie()).toEqual([]);

      expect((await client.get("/me")).status).toBe(200);
      expectBody(await other.get("/me"), 401, UNAUTHORIZED);
      expectBody(await third.get("/me"), 401, UNAUTHORIZED);
      expect((await client.get("/auth/sessions")).body.data.map((s: any) => s.current)).toEqual([true]);
      expectBody(await t.client().post("/auth/login", { email: "changer@example.com", password: "member-password" }), 401, INVALID_CREDENTIALS);
      expect((await t.client().post("/auth/login", { email: "changer@example.com", password: "next-password" })).status).toBe(200);
      const [row] = await t.sql`SELECT password_hash FROM users WHERE id = ${user.id}`;
      expect(row.password_hash).toMatch(ARGON2_HASH);
      expect(await Bun.password.verify("next-password", row.password_hash)).toBe(true);

      const mail = (await waitForMailsTo(t, "changer@example.com", 2))[1]!;
      expectMail(mail, {
        to: "changer@example.com",
        subject: "Your password was changed",
        paragraphs: ["Hi changer,", "Your password was just changed and your other sessions were signed out. If this was not you, reset your password right away."],
      });
      expect(mail.html).toBe(
        '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#222;line-height:1.5"><div style="max-width:560px;margin:0 auto;padding:24px">' +
          '<p style="margin:0 0 16px">Hi changer,</p>' +
          '<p style="margin:0 0 16px">Your password was just changed and your other sessions were signed out. If this was not you, reset your password right away.</p>' +
          "</div></body></html>",
      );
      // Other people's sessions are untouched.
      expect((await owner.get("/me")).status).toBe(200);
    });

    test("a wrong current password changes nothing and sends nothing", async () => {
      const { client } = await t.addMember(owner, "changer-wrong@example.com");
      const other = await signIn(t, "changer-wrong@example.com", "member-password");
      for (const currentPassword of ["wrong-password", "member-passwor", " member-password", "member-password ", "MEMBER-PASSWORD", "p".repeat(200)]) {
        const res = await client.post("/auth/change-password", { currentPassword, newPassword: "next-password" });
        expectBody(res, 400, WRONG_PASSWORD);
        expectApiHeaders(res.headers);
      }
      expect((await other.get("/me")).status).toBe(200);
      expect((await t.client().post("/auth/login", { email: "changer-wrong@example.com", password: "member-password" })).status).toBe(200);
      await flushMail(t, owner);
      expect(mailsTo(t, "changer-wrong@example.com")).toHaveLength(1);
    });

    const invalid: [string, Record<string, unknown>, string][] = [
      ["an empty body", {}, "currentPassword must be a string"],
      ["a current password that is null", { currentPassword: null, newPassword: "next-password" }, "currentPassword must be a string"],
      ["a current password that is a number", { currentPassword: 1, newPassword: "next-password" }, "currentPassword must be a string"],
      ["an empty current password", { currentPassword: "", newPassword: "next-password" }, "currentPassword is required"],
      ["a current password of 201 characters", { currentPassword: "p".repeat(201), newPassword: "next-password" }, "currentPassword must be at most 200 characters"],
      ["no new password", { currentPassword: "member-password" }, "newPassword must be a string"],
      ["a new password that is null", { currentPassword: "member-password", newPassword: null }, "newPassword must be a string"],
      ["a new password that is a list", { currentPassword: "member-password", newPassword: ["next-password"] }, "newPassword must be a string"],
      ["an empty new password", { currentPassword: "member-password", newPassword: "" }, "newPassword is too short"],
      ["a new password of 7 characters", { currentPassword: "member-password", newPassword: "1234567" }, "newPassword is too short"],
      ["a new password of 7 emoji", { currentPassword: "member-password", newPassword: "🔑".repeat(7) }, "newPassword is too short"],
      ["a new password of 71 characters", { currentPassword: "member-password", newPassword: "p".repeat(71) }, "newPassword must be at most 70 characters"],
      ["a new password of 71 emoji", { currentPassword: "member-password", newPassword: "🔑".repeat(71) }, "newPassword must be at most 70 characters"],
      // The new password is checked before the current one is compared.
      ["a short new password with a wrong current one", { currentPassword: "wrong-password", newPassword: "short" }, "newPassword is too short"],
    ];

    test.each(invalid)("refuses %s", async (_what, body, message) => {
      expectInvalid(await unchanged.post("/auth/change-password", body), message);
      expect((await unchanged.get("/me")).status).toBe(200);
    });

    test("the new password counts code points and is kept as typed; it may equal the current one", async () => {
      const { client } = await t.addMember(owner, "changer-unicode@example.com");
      let current = "member-password";
      for (const next of ["🔑".repeat(8), "密".repeat(70), `${"🔑".repeat(69)}é`, "        ", "  padded  ", "12345678", "12345678", "pässwörd ́ كلمة"]) {
        expectBody(await client.post("/auth/change-password", { currentPassword: current, newPassword: next }), 200, { data: {} });
        expect((await t.client().post("/auth/login", { email: "changer-unicode@example.com", password: next })).status).toBe(200);
        if (next.trim() !== next && next.trim() !== "") {
          expectBody(await t.client().post("/auth/login", { email: "changer-unicode@example.com", password: next.trim() }), 401, INVALID_CREDENTIALS);
          expectBody(await client.post("/auth/change-password", { currentPassword: next.trim(), newPassword: "whatever-else" }), 400, WRONG_PASSWORD);
        }
        current = next;
      }
    });

    test("an account without a password cannot change it", async () => {
      const { client, user } = await t.addMember(owner, "changer-none@example.com");
      await t.sql`UPDATE users SET password_hash = NULL WHERE id = ${user.id}`;
      expectBody(await client.post("/auth/change-password", { currentPassword: "member-password", newPassword: "next-password" }), 400, WRONG_PASSWORD);
      expect((await t.sql`SELECT password_hash FROM users WHERE id = ${user.id}`)[0].password_hash).toBeNull();
    });

    test("needs a session", async () => {
      expectBody(await t.client().post("/auth/change-password", { currentPassword: "member-password", newPassword: "next-password" }), 401, UNAUTHORIZED);
    });

    test("the notice escapes the name in its HTML part", async () => {
      const { client } = await t.addMember(owner, "changer-html@example.com");
      await client.post("/me/update", { name: '<i>"Al" & Co</i>' });
      await client.post("/auth/change-password", { currentPassword: "member-password", newPassword: "next-password" });
      const mail = (await waitForMailsTo(t, "changer-html@example.com", 2))[1]!;
      expect(mail.text).toBe('Hi <i>"Al" & Co</i>,\n\nYour password was just changed and your other sessions were signed out. If this was not you, reset your password right away.');
      expect(mail.html).toContain('<p style="margin:0 0 16px">Hi &lt;i&gt;&quot;Al&quot; &amp; Co&lt;/i&gt;,</p>');
    });
  });
});
