import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Client, type TestServer } from "./harness";
import { finishLogin, logged, signIn, startFakeProvider, startLogin, type Person, type SignInOptions } from "./harness/oidc";

/*
 * Who a sign-in through the provider turns out to be: the account linked to
 * its subject, the one AUTH_LINK_USERS names, the one with its email, or a new
 * one; and what the provider's claims change on that account.
 */

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLEARED_LOGIN_COOKIE = "__Host-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";

const idp = startFakeProvider({ issuer: "https://auth.example.test" });

let t: TestServer;

const userBySub = async (sub: string): Promise<Record<string, any> | undefined> => (await t.sql`SELECT * FROM users WHERE auth_sub = ${sub}`)[0];
const userByEmail = async (email: string): Promise<Record<string, any> | undefined> => (await t.sql`SELECT * FROM users WHERE email = ${email}`)[0];
const me = async (client: Client) => (await client.get("/me")).body.data.user;
const enter = (person: Person, options: SignInOptions = {}) => signIn(t.base, idp, person, options);

/** A sign-in that was turned away: the reason, no session, the login cookie deleted. */
const expectTurnedAway = (attempt: Awaited<ReturnType<typeof enter>>, reason: string) => {
  expect(attempt.status).toBe(302);
  expect(attempt.location).toBe(`/login?sso_error=${reason}`);
  expect(attempt.setCookies).toEqual([CLEARED_LOGIN_COOKIE]);
  expect(attempt.client.cookie).toBeNull();
};

afterEach(() => {
  idp.heal();
});

afterAll(async () => {
  await idp.stop();
});

describe("on an empty database, with single sign-on the only way in", () => {
  const alice: Person = { sub: "usr_alice", username: "alice", name: "Alice", role: "owner" };
  let aliceClient: Client;

  beforeAll(async () => {
    t = await startServer({ env: idp.env });
  });

  afterAll(async () => {
    await t.close();
  });

  test("a sign-in that is refused for want of an email sets nothing up", async () => {
    expectTurnedAway(await enter({ sub: "usr_early", username: "early", email: null, role: "owner" }), "no_email");
    expect((await t.client().get("/setup")).body).toEqual({ data: { needsSetup: true } });
    expect(await t.sql`SELECT 1 FROM users`).toHaveLength(0);
    expect(await t.sql`SELECT 1 FROM groups`).toHaveLength(0);
  });

  test("the first person to sign in sets up the workspace, with the provider's role", async () => {
    const signedIn = await enter(alice, { returnTo: "/s/general" });
    expect(signedIn.location).toBe("/s/general");
    aliceClient = signedIn.client;
    const res = await aliceClient.get("/me");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        user: {
          id: expect.stringMatching(UUID),
          email: "alice@example.com",
          name: "Alice",
          avatarUrl: null,
          role: "owner",
          locale: null,
          timezone: null,
          preferences: {},
          createdAt: expect.stringMatching(ISO),
          lastLoginAt: expect.stringMatching(ISO),
          ssoManaged: true,
          ssoManagedEmail: true,
          hasPassword: false,
        },
        workspace: {
          name: "My workspace",
          description: null,
          logoUrl: null,
          emailDomains: [],
          settings: {},
          defaultSpaceId: expect.stringMatching(UUID),
          createdAt: expect.stringMatching(ISO),
        },
      },
    });
    expect((await t.client().get("/setup")).body).toEqual({ data: { needsSetup: false } });
    // As POST /setup would: the default group with them in it, and a General space they administer.
    const spaces = (await aliceClient.get("/spaces")).body.data;
    expect(spaces).toEqual([expect.objectContaining({ name: "General", slug: "general", role: "admin", memberCount: 1 })]);
    expect(res.body.data.workspace.defaultSpaceId).toBe(spaces[0].id);
    expect((await aliceClient.get("/groups")).body.data).toEqual([
      expect.objectContaining({ name: "Everyone", description: "Every member of the workspace", isDefault: true, memberCount: 1 }),
    ]);
    // An account with no password, linked to the provider's subject.
    const row = (await userBySub("usr_alice"))!;
    expect(row).toMatchObject({ id: res.body.data.user.id, password_hash: null, invited_by: null, email_from_provider: true, deactivated_at: null });
  });

  test("the next new person becomes a member of the default group, and of no space", async () => {
    const { client, location } = await enter({ sub: "usr_bob", username: "bob", name: "Bob" });
    expect(location).toBe("/");
    expect(await me(client)).toMatchObject({ name: "Bob", email: "bob@example.com", role: "member", ssoManaged: true, ssoManagedEmail: true, hasPassword: false });
    expect((await client.get("/groups")).body.data).toEqual([expect.objectContaining({ name: "Everyone", memberCount: 2 })]);
    expect((await client.get("/spaces")).body.data).toEqual([]);
    expect((await aliceClient.get("/me")).body.data.workspace.name).toBe("My workspace");
    expect(await t.sql`SELECT 1 FROM spaces`).toHaveLength(1);
  });

  test.each([
    ["owner", "owner"],
    ["admin", "admin"],
    ["member", "member"],
    ["editor", "member"],
    ["Owner", "member"],
    ["ADMIN", "member"],
    [" admin", "member"],
    ["", "member"],
  ])("a new person whose role at the provider is %j joins as %s", async (role, expected) => {
    const n = `role${Math.random().toString(36).slice(2, 8)}`;
    const { client, location } = await enter({ sub: `usr_${n}`, username: n, role });
    expect(location).toBe("/");
    expect((await me(client)).role).toBe(expected);
  });

  test.each([
    ["the provider's name", { name: "Zoë 张伟", username: "zoe" }, "Zoë 张伟"],
    ["the name without the spaces around it", { name: "  Padded Name\t", username: "padded" }, "Padded Name"],
    ["the username when the name is empty", { name: "", username: "nameless" }, "nameless"],
    ["the username when the name is only spaces", { name: "   ", username: "spaces" }, "spaces"],
    ["the first 50 characters of a longer name", { name: "N".repeat(60), username: "long" }, "N".repeat(50)],
    ["the first 50 characters of a long username when there is no name", { name: "", username: "u".repeat(60) }, "u".repeat(50)],
    // Accident: the cut counts UTF-16 code units, not characters as the 50-character rule for names does elsewhere: 30 emoji become 25.
    ["25 of 30 emoji", { name: "😀".repeat(30), username: "emoji" }, "😀".repeat(25)],
    // Accident: a cut through the middle of an emoji leaves half of it, stored as U+FFFD.
    ["a replacement character where the cut split an emoji", { name: `a${"😀".repeat(30)}`, username: "split" }, `a${"😀".repeat(24)}�`],
    // Accident: with neither a name nor a username the account's name is empty, which no other route allows.
    ["nothing when both are empty", { name: " ", username: "" }, ""],
  ])("a new account is named with %s", async (_what, claims, expected) => {
    const sub = `usr_name_${Math.random().toString(36).slice(2, 8)}`;
    const { client, location } = await enter({ sub, ...claims, email: `${sub}@example.com` });
    expect(location).toBe("/");
    expect((await me(client)).name).toBe(expected);
  });

  test.each([
    ["no email claim", { email: undefined, email_verified: undefined }],
    ["a null email", { email: null }],
    ["an email that is not a string", { email: 42 }],
    ["an empty email", { email: "" }],
    ["an email that is not an address", { email: "nobody.example.com" }],
    ["an email of more than 254 characters", { email: `${"a".repeat(250)}@example.com` }],
  ])("a new person whose ID token has %s is refused, and no account is made", async (_what, claims) => {
    const attempt = await enter({ sub: "usr_noemail", username: "nomail" }, { idToken: { claims } });
    expectTurnedAway(attempt, "no_email");
    expect(await userBySub("usr_noemail")).toBeUndefined();
  });

  test("a new person with an email the provider has not verified gets an account, and manages that email", async () => {
    const { client, location } = await enter({ sub: "usr_unv", username: "unv", email: " Unverified@Example.COM ", emailVerified: false });
    expect(location).toBe("/");
    // Stored trimmed and in lower case.
    expect(await me(client)).toMatchObject({ email: "unverified@example.com", ssoManaged: true, ssoManagedEmail: false, hasPassword: false });
    expect((await userBySub("usr_unv"))!.email_from_provider).toBe(false);
  });

  test("an email_verified that is not the boolean true counts as unverified", async () => {
    for (const email_verified of ["true", 1, undefined]) {
      const signedIn = await enter({ sub: "usr_unv", username: "unv", email: "other.unverified@example.com" }, { idToken: { claims: { email_verified } } });
      expect(await me(signedIn.client)).toMatchObject({ email: "unverified@example.com", ssoManagedEmail: false });
    }
  });

  test("a new person whose email belongs to an account linked to someone else is refused", async () => {
    for (const emailVerified of [true, false]) {
      const attempt = await enter({ sub: "usr_mallory", username: "mallory", email: "Alice@Example.com", emailVerified, role: "owner" });
      expectTurnedAway(attempt, "account_exists");
    }
    expect(await userBySub("usr_mallory")).toBeUndefined();
    expect((await userBySub("usr_alice"))!.email).toBe("alice@example.com");
  });

  test("the workspace's allowed email domains do not apply to sign-ins through the provider", async () => {
    expect((await aliceClient.post("/workspace/update", { emailDomains: ["corp.example"] })).status).toBe(200);
    try {
      const { client, location } = await enter({ sub: "usr_outside", username: "outside", email: "outside@elsewhere.example" });
      expect(location).toBe("/");
      expect((await me(client)).email).toBe("outside@elsewhere.example");
    } finally {
      await aliceClient.post("/workspace/update", { emailDomains: [] });
    }
  });

  describe("signing in again", () => {
    const carol: Person = { sub: "usr_carol", username: "carol", name: "Carol", role: "member" };
    let id: string;

    beforeAll(async () => {
      id = (await me((await enter(carol)).client)).id;
    });

    test("finds the account by the provider's subject, whatever else changed, and takes the provider's name, role and verified email", async () => {
      const { client } = await enter({ sub: "usr_carol", username: "caroline", name: "Caroline", role: "admin", email: "Caroline@Example.com", sid: "ses_other" });
      expect(await me(client)).toMatchObject({ id, name: "Caroline", role: "admin", email: "caroline@example.com", ssoManagedEmail: true });
      const back = await enter({ ...carol, role: "owner" });
      expect(await me(back.client)).toMatchObject({ id, name: "Carol", role: "owner", email: "carol@example.com" });
      expect(await t.sql`SELECT 1 FROM users WHERE email IN ('carol@example.com', 'caroline@example.com')`).toHaveLength(1);
    });

    test("with nothing changed leaves the account's row as it is", async () => {
      await enter({ ...carol, role: "owner" });
      const before = (await userBySub("usr_carol"))!;
      await enter({ ...carol, role: "owner", email: "CAROL@example.com" });
      const after = (await userBySub("usr_carol"))!;
      expect(after.updated_at).toEqual(before.updated_at);
      expect(new Date(after.last_login_at).getTime()).toBeGreaterThanOrEqual(new Date(before.last_login_at).getTime());
    });

    test("an unknown role makes the person a member, and an empty name falls back to the username, then to the name they had", async () => {
      const demoted = await enter({ ...carol, role: "superuser", name: "  " });
      expect(await me(demoted.client)).toMatchObject({ id, role: "member", name: "carol" });
      await enter({ ...carol, name: "Carol" });
      const kept = await enter({ ...carol, name: "", username: " " });
      expect(await me(kept.client)).toMatchObject({ id, name: "Carol" });
    });

    test("with an email the provider has not verified leaves the account's email alone, which the person then manages", async () => {
      const { client } = await enter({ ...carol, email: "carol.new@example.com", emailVerified: false });
      expect(await me(client)).toMatchObject({ id, email: "carol@example.com", ssoManagedEmail: false });
      expect((await userBySub("usr_carol"))!.email_from_provider).toBe(false);
      // Verified again at the next sign-in: the provider manages it from then on.
      const verified = await enter({ ...carol, email: "carol.new@example.com" });
      expect(await me(verified.client)).toMatchObject({ id, email: "carol.new@example.com", ssoManagedEmail: true });
      await enter(carol);
    });

    test("without an email in the ID token still works for a linked account, which then manages its own email", async () => {
      for (const claims of [{ email: undefined, email_verified: undefined }, { email: "not-an-address", email_verified: true }]) {
        await enter(carol);
        const { client, location } = await enter(carol, { idToken: { claims } });
        expect(location).toBe("/");
        expect(await me(client)).toMatchObject({ id, email: "carol@example.com", ssoManagedEmail: false });
      }
      await enter(carol);
    });

    test("with a verified email another account has keeps the account's own email, which the person then manages", async () => {
      const { client, location } = await enter({ ...carol, email: "alice@example.com", name: "Carol C", role: "admin" });
      expect(location).toBe("/");
      // The name and role are still taken.
      expect(await me(client)).toMatchObject({ id, email: "carol@example.com", name: "Carol C", role: "admin", ssoManagedEmail: false });
      expect((await userBySub("usr_carol"))!.email_from_provider).toBe(false);
      expect((await userBySub("usr_alice"))!.email).toBe("alice@example.com");
    });
  });

  test("two sign-ins of one new person at the same moment make one account", async () => {
    const twin: Person = { sub: "usr_twin", username: "twin" };
    const browsers = [t.client(), t.client()];
    const callbacks: string[] = [];
    for (const browser of browsers) callbacks.push(idp.authorize((await startLogin(browser)).authorize!, twin).callback);
    const seen = idp.count("token");
    // Both codes are redeemed before either answer leaves the provider, so both look the person up before either made them.
    const release = idp.hold("token");
    const finishing = browsers.map((browser, i) => finishLogin(browser, callbacks[i]!));
    await idp.waitFor("token", seen + 2);
    release();
    const finished = await Promise.all(finishing);
    expect(finished.map((f) => f.location)).toEqual(["/", "/"]);
    const users = await t.sql`SELECT id FROM users WHERE auth_sub = 'usr_twin'`;
    expect(users).toHaveLength(1);
    expect(await t.sql`SELECT 1 FROM sessions WHERE user_id = ${users[0].id}`).toHaveLength(2);
    expect((await me(browsers[0]!)).id).toBe((await me(browsers[1]!)).id);
  });

  test("two new people with one email at the same moment: one gets the account, the other is refused", async () => {
    const people: Person[] = [
      { sub: "usr_same_1", username: "same1", email: "shared@example.com" },
      { sub: "usr_same_2", username: "same2", email: "shared@example.com" },
    ];
    const browsers = [t.client(), t.client()];
    const callbacks: string[] = [];
    for (const [i, browser] of browsers.entries()) callbacks.push(idp.authorize((await startLogin(browser)).authorize!, people[i]!).callback);
    const seen = idp.count("token");
    const release = idp.hold("token");
    const finishing = browsers.map((browser, i) => finishLogin(browser, callbacks[i]!));
    await idp.waitFor("token", seen + 2);
    release();
    const finished = await Promise.all(finishing);
    expect(finished.map((f) => f.location).sort()).toEqual(["/", "/login?sso_error=account_exists"]);
    expect(await t.sql`SELECT 1 FROM users WHERE email = 'shared@example.com'`).toHaveLength(1);
  });
});

describe("two first sign-ins on an empty database at the same moment", () => {
  beforeAll(async () => {
    t = await startServer({ env: idp.env });
  });

  afterAll(async () => {
    await t.close();
  });

  test("set the workspace up once, and both people get in with the provider's roles", async () => {
    const people: Person[] = [
      { sub: "usr_first_a", username: "firsta", role: "admin" },
      { sub: "usr_first_b", username: "firstb", role: "member" },
    ];
    const browsers = [t.client(), t.client()];
    const callbacks: string[] = [];
    for (const [i, browser] of browsers.entries()) callbacks.push(idp.authorize((await startLogin(browser)).authorize!, people[i]!).callback);
    const release = idp.hold("token");
    const finishing = browsers.map((browser, i) => finishLogin(browser, callbacks[i]!));
    await idp.waitFor("token", 2);
    release();
    expect((await Promise.all(finishing)).map((f) => f.location)).toEqual(["/", "/"]);

    expect([...(await t.sql`SELECT name FROM workspace`)]).toEqual([{ name: "My workspace" }]);
    expect([...(await t.sql`SELECT name, is_default FROM groups`)]).toEqual([{ name: "Everyone", is_default: true }]);
    expect([...(await t.sql`SELECT name, slug FROM spaces`)]).toEqual([{ name: "General", slug: "general" }]);
    expect(await t.sql`SELECT 1 FROM group_members`).toHaveLength(2);
    // Whoever came first administers General; the roles are the provider's either way.
    expect(await t.sql`SELECT 1 FROM space_members WHERE role = 'admin'`).toHaveLength(1);
    expect((await me(browsers[0]!)).role).toBe("admin");
    expect((await me(browsers[1]!)).role).toBe("member");
  });
});

describe("accounts that existed before single sign-on", () => {
  let owner: Client;
  const local: Record<string, string> = {};

  const LINK_USERS = [
    "dave.local@example.com=dave",
    " Mixed.Case@Example.com = mixed ",
    "ghost@example.com=ghost",
    "paula@example.com=paula",
    "olga@example.com=oscar",
    "race.a@example.com=racer",
    "",
  ].join(",");

  beforeAll(async () => {
    // Passwords stay on, so the accounts can be made the usual way: setup, then invitations.
    t = await startServer({ env: { ...idp.env, AUTH_LOCAL_LOGIN: "true", AUTH_LINK_USERS: LINK_USERS } });
    ({ owner } = await t.setupOwner());
    for (const email of [
      "dave.local@example.com",
      "mixed.case@example.com",
      "paula@example.com",
      "erin@example.com",
      "frank@example.com",
      "gina@example.com",
      "olga@example.com",
      "race.a@example.com",
      "race.b@example.com",
      "victim@example.com",
      "stuck@example.com",
    ]) {
      local[email] = (await t.addMember(owner, email)).user.id;
    }
    expect((await owner.post("/members/deactivate", { userId: local["gina@example.com"] })).status).toBe(200);
  });

  afterAll(async () => {
    await t.close();
  });

  test("AUTH_LINK_USERS links the account it names for the provider's username, whatever the ID token's email", async () => {
    const { client, location } = await enter({ sub: "usr_dave", username: "dave", name: "Dave", role: "admin", email: "dave@example.com", emailVerified: false });
    expect(location).toBe("/");
    expect(await me(client)).toMatchObject({
      id: local["dave.local@example.com"],
      email: "dave.local@example.com",
      name: "Dave",
      role: "admin",
      ssoManaged: true,
      ssoManagedEmail: false,
      hasPassword: true,
    });
    expect((await userBySub("usr_dave"))!.id).toBe(local["dave.local@example.com"]!);
    expect(await userByEmail("dave@example.com")).toBeUndefined();
  });

  test("an entry's email is matched in any case, and a verified email then replaces the account's", async () => {
    const { client } = await enter({ sub: "usr_mixed", username: "mixed", email: "mixed@example.com" });
    expect(await me(client)).toMatchObject({ id: local["mixed.case@example.com"], email: "mixed@example.com", ssoManagedEmail: true });
  });

  test("an entry links its account even when the ID token has no email", async () => {
    // The username is matched exactly: Paula is not paula, and gets an account of her own by her email.
    const other = await enter({ sub: "usr_paula_upper", username: "Paula", email: "paula.upper@example.com" });
    expect((await me(other.client)).id).not.toBe(local["paula@example.com"]);
    expect((await userByEmail("paula@example.com"))!.auth_sub).toBeNull();
    const { client, location } = await enter({ sub: "usr_paula", username: "paula", email: null });
    expect(location).toBe("/");
    expect(await me(client)).toMatchObject({ id: local["paula@example.com"], email: "paula@example.com", ssoManagedEmail: false });
  });

  test("an entry naming an account that does not exist is passed over: the person is matched by email, or is new", async () => {
    const { client, location } = await enter({ sub: "usr_ghost", username: "ghost", email: "ghost.real@example.com" });
    expect(location).toBe("/");
    expect(await me(client)).toMatchObject({ email: "ghost.real@example.com", hasPassword: false });
    expect(await userByEmail("ghost@example.com")).toBeUndefined();
  });

  test("an account an entry already linked is not given to another subject with that username", async () => {
    // Builds on the first test of this group: dave.local@example.com is linked to usr_dave.
    const second = await enter({ sub: "usr_dave_2", username: "dave", email: "dave.two@example.com" });
    expect(second.location).toBe("/");
    expect((await me(second.client)).id).not.toBe(local["dave.local@example.com"]);
    expectTurnedAway(await enter({ sub: "usr_dave_3", username: "dave", email: null }), "no_email");
    expect((await userBySub("usr_dave"))!.id).toBe(local["dave.local@example.com"]!);
  });

  test("a verified email links the one account with that address, in any case, and the provider manages it from then on", async () => {
    const { client, location } = await enter({ sub: "usr_erin", username: "erin", email: "Erin@Example.com" });
    expect(location).toBe("/");
    expect(await me(client)).toMatchObject({ id: local["erin@example.com"], email: "erin@example.com", ssoManaged: true, ssoManagedEmail: true, hasPassword: true });
    expect((await userBySub("usr_erin"))!.email_from_provider).toBe(true);
  });

  test("an unverified email links the one account with that address too, and the account keeps managing its email", async () => {
    const { client } = await enter({ sub: "usr_frank", username: "frank", email: "Frank@Example.com", emailVerified: false });
    expect(await me(client)).toMatchObject({ id: local["frank@example.com"], email: "frank@example.com", ssoManaged: true, ssoManagedEmail: false });
    expect((await userBySub("usr_frank"))!.email_from_provider).toBe(false);
  });

  test("the account linked to the subject is used even when AUTH_LINK_USERS now names another for the username", async () => {
    // Builds on the test above the last: erin is linked. Her username at the provider becomes one the list maps to olga's account.
    const { client } = await enter({ sub: "usr_erin", username: "oscar", email: "erin@example.com" });
    expect((await me(client)).id).toBe(local["erin@example.com"]);
    expect((await userByEmail("olga@example.com"))!.auth_sub).toBeNull();
  });

  test("an account already linked to someone else is not taken over by its email", async () => {
    const attempt = await enter({ sub: "usr_mallory", username: "mallory", email: "erin@example.com" });
    expectTurnedAway(attempt, "account_exists");
    expect((await userBySub("usr_erin"))!.id).toBe(local["erin@example.com"]!);
    expect(await userBySub("usr_mallory")).toBeUndefined();
  });

  test("a deactivated account is linked and takes the provider's claims, but gets no session until an admin reactivates it", async () => {
    const gina: Person = { sub: "usr_gina", username: "gina", name: "Gina G", role: "admin", email: "gina@example.com" };
    expectTurnedAway(await enter(gina), "deactivated");
    const row = (await userBySub("usr_gina"))!;
    expect(row).toMatchObject({ id: local["gina@example.com"], name: "Gina G", role: "admin", email_from_provider: true });
    expect(row.deactivated_at).not.toBeNull();
    expect(await t.sql`SELECT 1 FROM sessions WHERE user_id = ${row.id}`).toHaveLength(0);
    // Refused again now that it is linked.
    expectTurnedAway(await enter(gina), "deactivated");
    expect((await owner.post("/members/activate", { userId: row.id })).status).toBe(200);
    const again = await enter(gina);
    expect(again.location).toBe("/");
    expect((await me(again.client)).id).toBe(row.id);
  });

  test("two sign-ins of one person at the same moment link one account, though the list and the email point at two", async () => {
    // The list maps `racer` to race.a; the ID token's email is race.b's.
    const racer: Person = { sub: "usr_racer", username: "racer", email: "race.b@example.com" };
    const browsers = [t.client(), t.client()];
    const callbacks: string[] = [];
    for (const browser of browsers) callbacks.push(idp.authorize((await startLogin(browser)).authorize!, racer).callback);
    const seen = idp.count("token");
    const release = idp.hold("token");
    const finishing = browsers.map((browser, i) => finishLogin(browser, callbacks[i]!));
    await idp.waitFor("token", seen + 2);
    release();
    // The two can deadlock in the database: one gives race.a the email and waits for race.b's row, the
    // other links race.b and waits for race.a's. The one the database ends starts over, so both get in.
    expect((await Promise.all(finishing)).map((f) => f.location)).toEqual(["/", "/"]);
    expect((await userBySub("usr_racer"))!.id).toBe(local["race.a@example.com"]!);
    expect((await userByEmail("race.b@example.com"))!.auth_sub).toBeNull();
    for (const browser of browsers) expect((await me(browser)).id).toBe(local["race.a@example.com"]);
  });

  describe("a sign-in the database ends to break a deadlock", () => {
    /** Makes the first `times` updates of that account's row fail as the victim of a deadlock does. */
    const deadlocks = async (email: string, times: number) => {
      await t.sql.unsafe(`CREATE SEQUENCE deadlock_tries`);
      await t.sql.unsafe(`CREATE FUNCTION deadlock_victim() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('deadlock_tries') <= ${times} THEN
            RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01';
          END IF;
          RETURN NEW;
        END $$`);
      await t.sql.unsafe(`CREATE TRIGGER deadlock_victim BEFORE UPDATE ON users FOR EACH ROW WHEN (OLD.email = '${email}') EXECUTE FUNCTION deadlock_victim()`);
      return async () => {
        const [{ tries }] = await t.sql`SELECT last_value::int AS tries FROM deadlock_tries`;
        await t.sql.unsafe(`DROP TRIGGER deadlock_victim ON users`);
        await t.sql.unsafe(`DROP FUNCTION deadlock_victim`);
        await t.sql.unsafe(`DROP SEQUENCE deadlock_tries`);
        return tries as number;
      };
    };

    test("is done again from the start, and gets in", async () => {
      const done = await deadlocks("victim@example.com", 1);
      let tries = 0;
      try {
        const attempt = await enter({ sub: "usr_victim", username: "victim", email: "victim@example.com" });
        expect(attempt.location).toBe("/");
        expect((await me(attempt.client)).id).toBe(local["victim@example.com"]);
      } finally {
        tries = await done();
      }
      // The update that was ended, and the ones of the second try.
      expect(tries).toBeGreaterThanOrEqual(2);
      expect((await userBySub("usr_victim"))!.id).toBe(local["victim@example.com"]!);
    });

    test("is given up after three tries, and logged", async () => {
      const mark = t.logs.length;
      const done = await deadlocks("stuck@example.com", 1000);
      let tries = 0;
      try {
        expectTurnedAway(await enter({ sub: "usr_stuck", username: "stuck", email: "stuck@example.com" }), "login_failed");
      } finally {
        tries = await done();
      }
      expect(tries).toBe(3);
      expect(await userBySub("usr_stuck")).toBeUndefined();
      const entry = await logged(t, { msg: "single sign-on failed" }, mark);
      expect(entry).toMatchObject({ level: "error", msg: "single sign-on failed" });
      expect(String(entry.error)).toContain("deadlock detected");
    });
  });

  test("a refused sign-in is logged only when it is the provider's doing: no_email, account_exists and deactivated are not", async () => {
    const mark = t.logs.length;
    expectTurnedAway(await enter({ sub: "usr_quiet", username: "quiet", email: null }), "no_email");
    expectTurnedAway(await enter({ sub: "usr_quiet", username: "quiet", email: "erin@example.com" }), "account_exists");
    // A refusal that is logged, to know the log has caught up.
    await enter({ sub: "usr_quiet", username: "quiet" }, { accessToken: { claims: { aud: "other" } } });
    await logged(t, { msg: "single sign-on refused", reason: "wrong audience" }, mark);
    expect(t.logs.slice(mark).filter((line) => line.includes('"level":"warn"') || line.includes('"level":"error"'))).toHaveLength(1);
  });
});
