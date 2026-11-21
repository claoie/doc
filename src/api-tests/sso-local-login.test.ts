import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Client, type TestServer } from "./harness";
import { sessionRow, sha256Hex, signIn, startFakeProvider, type Person, type SignInOptions } from "./harness/oidc";

/*
 * What single sign-on changes in the rest of the API, mode by mode, on one
 * database: a workspace that starts with passwords only, then runs with single
 * sign-on as the only way in, then with passwords alongside it
 * (AUTH_LOCAL_LOGIN), then with single sign-on turned off again. Each mode is
 * a new server process on the same database, so the groups below run in order
 * and build on each other.
 */

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PASSWORDS_OFF = { error: { code: "local_login_disabled", message: "Passwords are turned off in this workspace: sign in with single sign-on" } };
const SETUP_OFF = {
  error: { code: "local_login_disabled", message: "This workspace uses single sign-on: the first person to sign in with it sets it up" },
};
const INVITATIONS_OFF = {
  error: {
    code: "local_login_disabled",
    message: "This workspace uses single sign-on: people get access through the identity provider and appear here when they first sign in",
  },
};
const INVALID_CREDENTIALS = { error: { code: "invalid_credentials", message: "Invalid email or password" } };
const UNAUTHORIZED = { error: { code: "unauthorized", message: "Sign in required" } };

/** A user as the API answers one, without the single sign-on fields. */
const userShape = (fields: Record<string, unknown>) => ({
  id: expect.stringMatching(UUID),
  email: expect.any(String),
  name: expect.any(String),
  avatarUrl: null,
  role: "member",
  locale: null,
  timezone: null,
  preferences: {},
  createdAt: expect.stringMatching(ISO),
  lastLoginAt: expect.stringMatching(ISO),
  ...fields,
});

const idp = startFakeProvider({ issuer: "https://auth.example.test" });

let t: TestServer;
const ids: Record<string, string> = {};
/** Kept from one mode to the next. */
const kept: {
  ownerPassword?: Client;
  olgaPassword?: Client;
  quinnReset?: string;
  toRevoke?: { id: string; token: string };
  toAccept?: { id: string; token: string };
  ownerSso?: Client;
  kimSso?: Client;
} = {};

const owner: Person = { sub: "usr_owner", username: "owner", name: "Owner", role: "owner", email: "owner@example.com" };
const kim: Person = { sub: "usr_kim", username: "kim", name: "Kim" };

const enter = (person: Person, options: SignInOptions = {}) => signIn(t.base, idp, person, options);
const me = async (client: Client) => (await client.get("/me")).body.data.user;
const passwordLogin = async (email: string, password: string) => {
  const client = t.client();
  return { client, res: await client.post("/auth/login", { email, password }) };
};
const invitation = (url: string) => {
  const link = new URL(url);
  return { id: link.pathname.split("/").pop()!, token: link.searchParams.get("token")! };
};
const resetToken = (text: string) => decodeURIComponent(/reset-password\?token=([^\s"<]+)/.exec(text)![1]!);

/** The same browser (cookies and address), talking to the server that now runs. */
const moved = (client: Client) => {
  const next = t.client({ ip: client.ip });
  for (const [name, value] of client.cookies) next.cookies.set(name, value);
  return next;
};

/** Stops the server of the mode before and starts one with these settings on the same database; the kept browsers follow. */
const restart = async (env: Record<string, string | undefined>) => {
  await t.close();
  t = await startServer({ env, keepDatabase: true });
  for (const name of ["ownerPassword", "olgaPassword", "ownerSso", "kimSso"] as const) {
    if (kept[name]) kept[name] = moved(kept[name]);
  }
};

afterAll(async () => {
  await t.close();
  await idp.stop();
});

describe("1. passwords only, before single sign-on", () => {
  beforeAll(async () => {
    t = await startServer();
    const setup = await t.setupOwner();
    kept.ownerPassword = setup.owner;
    ids.owner = setup.user.id;
    for (const email of ["quinn@example.com", "olga@example.com", "dave@example.com"]) {
      const member = await t.addMember(setup.owner, email);
      ids[email] = member.user.id;
      if (email === "olga@example.com") kept.olgaPassword = member.client;
    }
    const invited = await setup.owner.post("/invitations", { emails: ["revoked@example.com", "invited@example.com"] });
    kept.toRevoke = invitation(invited.body.data[0].url);
    kept.toAccept = invitation(invited.body.data[1].url);
    // A reset link sent to quinn while the account was only doc's.
    await t.smtp.settle();
    t.smtp.clear();
    await t.client().post("/auth/forgot-password", { email: "quinn@example.com" });
    kept.quinnReset = resetToken((await t.smtp.waitFor(1))[0]!.text);
  });

  test("the answers carry no single sign-on fields", async () => {
    expect((await t.client().get("/auth/config")).body).toEqual({ data: { sso: { enabled: false, localLogin: true } } });
    const res = await kept.ownerPassword!.get("/me");
    expect(res.body.data.user).toEqual(userShape({ email: "owner@example.com", name: "Owner", role: "owner" }));
    const members = (await kept.ownerPassword!.get("/members")).body.data.items;
    expect(members).toHaveLength(4);
    for (const member of members) expect(Object.keys(member).sort()).toEqual(Object.keys(userShape({ deactivatedAt: null })).sort());
    expect((await kept.ownerPassword!.post("/auth/logout")).body).toEqual({ data: {} });
    kept.ownerPassword = (await passwordLogin("owner@example.com", "owner-password")).client;
  });
});

describe("2. single sign-on as the only way in", () => {
  let member: Client;

  beforeAll(async () => {
    await restart(idp.env);
  });

  test("the browser learns that passwords are off", async () => {
    expect((await t.client().get("/auth/config")).body).toEqual({ data: { sso: { enabled: true, localLogin: false } } });
  });

  test("password sessions that already exist end at their next request, whatever it asks for", async () => {
    const ownerSession = (await sessionRow(t.sql, kept.ownerPassword!))!;
    const res = await kept.ownerPassword!.get("/me");
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED as never);
    // Ended, not merely refused.
    expect(await t.sql`SELECT 1 FROM sessions WHERE id = ${ownerSession.id}`).toHaveLength(0);
    // A public endpoint asked with the cookie ends the session too.
    expect(await sessionRow(t.sql, kept.olgaPassword!)).toBeDefined();
    expect((await kept.olgaPassword!.get("/auth/config")).status).toBe(200);
    expect(await sessionRow(t.sql, kept.olgaPassword!)).toBeUndefined();
  });

  test("existing accounts sign in through the provider: the owner's is linked by its email", async () => {
    const signedIn = await enter(owner);
    expect(signedIn.location).toBe("/");
    kept.ownerSso = signedIn.client;
    expect(await me(signedIn.client)).toEqual(
      userShape({ id: ids.owner, email: "owner@example.com", name: "Owner", role: "owner", ssoManaged: true, ssoManagedEmail: true, hasPassword: true }),
    );
    member = (await enter({ sub: "usr_mel", username: "mel" })).client;
  });

  test("setup, password sign-in and password resets are refused before anything of the request is looked at", async () => {
    const anonymous = t.client();
    const setup = await anonymous.post("/setup", { workspaceName: "X", name: "X", email: "x@example.com", password: "whatever-pw" });
    expect(setup.status).toBe(403);
    expect(setup.body).toEqual(SETUP_OFF as never);
    expect((await anonymous.post("/setup", {})).body).toEqual(SETUP_OFF as never);
    const refusals = [
      await anonymous.post("/auth/login", { email: "olga@example.com", password: "member-password" }),
      await anonymous.post("/auth/login", {}),
      await anonymous.post("/auth/forgot-password", { email: "olga@example.com" }),
      await anonymous.post("/auth/forgot-password", { email: 42 }),
      await anonymous.post("/auth/reset-password", { token: kept.quinnReset, password: "quinn-new-password" }),
      await anonymous.post("/auth/reset-password", {}),
      await kept.ownerSso!.post("/auth/change-password", { currentPassword: "owner-password", newPassword: "owner-password-2" }),
      await member.post("/auth/change-password", {}),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual(PASSWORDS_OFF as never);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    // Nothing was sent, and the reset link was not used up.
    await t.smtp.settle();
    expect(t.outbox).toEqual([]);
    expect(await t.sql`SELECT 1 FROM user_tokens WHERE token_hash = ${sha256Hex(kept.quinnReset!)}`).toHaveLength(1);
    // The setup question itself is still answered.
    expect((await anonymous.get("/setup")).body).toEqual({ data: { needsSetup: false } });
  });

  test("the refusal comes before the limit on attempts", async () => {
    const anonymous = t.client();
    for (let i = 0; i < 12; i++) expect((await anonymous.post("/auth/login", { email: "olga@example.com", password: "x" })).status).toBe(403);
  });

  test("changing a password still needs a session first", async () => {
    const res = await t.client().post("/auth/change-password", { currentPassword: "a", newPassword: "whatever-pw" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED as never);
  });

  test("invitations are refused: sending, resending, new links, looking one up and accepting", async () => {
    const anonymous = t.client();
    const refusals = [
      await kept.ownerSso!.post("/invitations", { emails: ["new@example.com"] }),
      await kept.ownerSso!.post("/invitations", {}),
      await kept.ownerSso!.post("/invitations/resend", { id: kept.toAccept!.id }),
      await kept.ownerSso!.post("/invitations/resend", {}),
      await kept.ownerSso!.post("/invitations/link", { id: kept.toAccept!.id }),
      await anonymous.get(`/invitations/${kept.toAccept!.id}?token=${kept.toAccept!.token}`),
      await anonymous.get("/invitations/not-an-id"),
      await anonymous.post("/invitations/accept", { ...kept.toAccept, name: "Invited", password: "invited-password" }),
      await anonymous.post("/invitations/accept", {}),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual(INVITATIONS_OFF as never);
    }
    await t.smtp.settle();
    expect(t.outbox).toEqual([]);
    expect(await t.sql`SELECT 1 FROM users WHERE email = 'invited@example.com'`).toHaveLength(0);
  });

  test("who may invite is checked before the refusal", async () => {
    for (const path of ["/invitations", "/invitations/resend", "/invitations/link"]) {
      const res = await member.post(path, { emails: ["new@example.com"], id: kept.toAccept!.id });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: "forbidden", message: "Only workspace admins can do this" } } as never);
    }
    expect((await t.client().post("/invitations", { emails: ["new@example.com"] })).status).toBe(401);
  });

  test("invitations sent before can still be listed and revoked", async () => {
    const listed = await kept.ownerSso!.get("/invitations");
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((i: { email: string }) => i.email).sort()).toEqual(["invited@example.com", "revoked@example.com"]);
    expect((await kept.ownerSso!.post("/invitations/revoke", { id: kept.toRevoke!.id })).body).toEqual({ data: {} });
    expect((await kept.ownerSso!.get("/invitations")).body.data.map((i: { email: string }) => i.email)).toEqual(["invited@example.com"]);
  });
});

describe("3. single sign-on with passwords kept (AUTH_LOCAL_LOGIN)", () => {
  let olga: Client;

  beforeAll(async () => {
    await restart({ ...idp.env, AUTH_LOCAL_LOGIN: "true" });
  });

  test("the browser learns that both ways are open", async () => {
    expect((await t.client().get("/auth/config")).body).toEqual({ data: { sso: { enabled: true, localLogin: true } } });
  });

  test("a session the provider started is still served after the restart", async () => {
    expect((await kept.ownerSso!.get("/me")).status).toBe(200);
  });

  test("an account that is not linked signs in with its password, and is marked as not managed", async () => {
    const { client, res } = await passwordLogin("olga@example.com", "member-password");
    expect(res.status).toBe(200);
    olga = client;
    const session = (await sessionRow(t.sql, client))!;
    expect(session).toMatchObject({ auth_sid: null, auth_refresh_token: null, auth_recheck_at: null });
    expect(await me(client)).toEqual(userShape({ id: ids["olga@example.com"], email: "olga@example.com", name: "olga", ssoManaged: false, ssoManagedEmail: false, hasPassword: true }));
    // Served request after request: nothing re-checks a password session.
    expect((await client.get("/me")).status).toBe(200);
  });

  test("an account linked to the provider is answered as an unknown address at password sign-in", async () => {
    const unknown = await passwordLogin("nobody@example.com", "owner-password");
    const linked = await passwordLogin("owner@example.com", "owner-password");
    const wrong = await passwordLogin("olga@example.com", "not-her-password");
    for (const { res, client } of [unknown, linked, wrong]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS as never);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(client.cookie).toBeNull();
    }
    expect((await passwordLogin("OWNER@example.com", "owner-password")).res.status).toBe(401);
  });

  test("forgot-password sends a linked account nothing, and an unlinked one its link", async () => {
    t.smtp.clear();
    const anonymous = t.client();
    for (const email of ["owner@example.com", "olga@example.com"]) {
      const res = await anonymous.post("/auth/forgot-password", { email });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: {} });
    }
    await t.smtp.waitFor(1);
    await t.smtp.settle();
    expect(t.outbox.map((mail) => mail.to)).toEqual(["olga@example.com"]);
    expect(await t.sql`SELECT 1 FROM user_tokens WHERE user_id = ${ids.owner!}`).toHaveLength(0);
  });

  test("a password session ends once its account is linked, and a reset link sent before that stops working", async () => {
    const before = await passwordLogin("quinn@example.com", "member-password");
    expect(before.res.status).toBe(200);
    expect((await before.client.get("/me")).status).toBe(200);
    // Quinn signs in through the provider elsewhere, which links the account by its email.
    const sso = await enter({ sub: "usr_quinn", username: "quinn", name: "Quinn" });
    expect(await me(sso.client)).toMatchObject({ id: ids["quinn@example.com"], ssoManaged: true, ssoManagedEmail: true, hasPassword: true });
    // The provider governs the account now: the password session no longer serves.
    const session = (await sessionRow(t.sql, before.client))!;
    expect((await before.client.get("/me")).status).toBe(401);
    expect(await t.sql`SELECT 1 FROM sessions WHERE id = ${session.id}`).toHaveLength(0);
    expect((await sso.client.get("/me")).status).toBe(200);

    const anonymous = t.client();
    const refused = await anonymous.post("/auth/reset-password", { token: kept.quinnReset, password: "quinn-new-password" });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: { code: "invalid_input", message: "This reset link is invalid or has expired" } } as never);
    expect(anonymous.cookie).toBeNull();
    // Not used up: it works again once single sign-on is off (below).
    expect(await t.sql`SELECT 1 FROM user_tokens WHERE token_hash = ${sha256Hex(kept.quinnReset!)}`).toHaveLength(1);
    expect((await passwordLogin("quinn@example.com", "member-password")).res.status).toBe(401);
  });

  test("invitations work, and make password accounts that are not linked", async () => {
    const info = await t.client().get(`/invitations/${kept.toAccept!.id}?token=${kept.toAccept!.token}`);
    expect(info.body).toEqual({ data: { email: "invited@example.com", workspaceName: "Acme" } });
    const invited = t.client();
    const accepted = await invited.post("/invitations/accept", { ...kept.toAccept, name: "Invited", password: "invited-password" });
    expect(accepted.status).toBe(200);
    expect(await me(invited)).toEqual(userShape({ email: "invited@example.com", name: "Invited", ssoManaged: false, ssoManagedEmail: false, hasPassword: true }));
    // An admin signed in through the provider can invite.
    const sent = await kept.ownerSso!.post("/invitations", { emails: ["later@example.com"] });
    expect(sent.status).toBe(200);
    expect(sent.body.data).toEqual([{ id: expect.stringMatching(UUID), email: "later@example.com", url: expect.stringContaining("http://doc.test/invites/") }]);
  });

  test("changing a password: with the current one for whoever has one, never for someone single sign-on created", async () => {
    expect((await olga.post("/auth/change-password", { currentPassword: "member-password", newPassword: "olga-password-2" })).body).toEqual({ data: {} });
    // A linked account's password is of no use while single sign-on is on, but is still its own to change.
    const quinn = (await enter({ sub: "usr_quinn", username: "quinn", name: "Quinn" })).client;
    expect((await quinn.post("/auth/change-password", { currentPassword: "member-password", newPassword: "quinn-password-2" })).body).toEqual({ data: {} });
    kept.kimSso = (await enter(kim)).client;
    const none = await kept.kimSso.post("/auth/change-password", { currentPassword: "anything", newPassword: "kim-password-1" });
    expect(none.status).toBe(400);
    expect(none.body).toEqual({ error: { code: "invalid_password", message: "Current password is incorrect" } } as never);
    expect((await t.sql`SELECT password_hash FROM users WHERE auth_sub = 'usr_kim'`)[0].password_hash).toBeNull();
  });

  test("signing out of a password session answers as without single sign-on, and asks nothing of the provider", async () => {
    const { client } = await passwordLogin("olga@example.com", "olga-password-2");
    const seen = idp.requests.length;
    const res = await client.post("/auth/logout");
    expect(res.body).toEqual({ data: {} });
    // A sign-out through the provider follows: its revocation is the first request the provider sees after.
    const sso = await enter({ sub: "usr_quinn", username: "quinn", name: "Quinn" });
    const revocations = idp.count("revocation");
    await sso.client.post("/auth/logout");
    await idp.waitFor("revocation", revocations + 1);
    expect(idp.requests.slice(seen).map((r) => r.endpoint)).toEqual(["token", "revocation"]);
  });

  describe("the profile of someone single sign-on created, with a verified email", () => {
    test("is marked as managed by the provider, with no password here", async () => {
      expect(await me(kept.kimSso!)).toEqual(userShape({ email: "kim@example.com", name: "Kim", ssoManaged: true, ssoManagedEmail: true, hasPassword: false }));
    });

    test("cannot change its name or its email here", async () => {
      const name = await kept.kimSso!.post("/me/update", { name: "Someone else" });
      expect(name.status).toBe(403);
      expect(name.body).toEqual({ error: { code: "sso_managed", message: "Your name comes from your identity provider" } } as never);
      const email = await kept.kimSso!.post("/me/update", { email: "kim.other@example.com", currentPassword: "x" });
      expect(email.status).toBe(403);
      expect(email.body).toEqual({ error: { code: "sso_managed", message: "Your email comes from your identity provider" } } as never);
      // Both at once: the name is refused first. A name differing only in case is a change too.
      expect((await kept.kimSso!.post("/me/update", { name: "kim", email: "kim.other@example.com" })).body.error!.message).toBe("Your name comes from your identity provider");
      expect(await me(kept.kimSso!)).toMatchObject({ name: "Kim", email: "kim@example.com" });
    });

    test("can save the same name and email, and everything else", async () => {
      const saved = await kept.kimSso!.post("/me/update", {
        name: " Kim ",
        email: " KIM@example.com ",
        timezone: "Europe/Berlin",
        locale: "de-DE",
        preferences: { theme: "dark", fullPageWidth: true },
      });
      expect(saved.status).toBe(200);
      expect(saved.body).toEqual({
        data: {
          user: userShape({
            email: "kim@example.com",
            name: "Kim",
            timezone: "Europe/Berlin",
            locale: "de-DE",
            preferences: { theme: "dark", fullPageWidth: true },
            ssoManaged: true,
            ssoManagedEmail: true,
            hasPassword: false,
          }),
        },
      });
    });

    test("the avatar routes answer with the marks too", async () => {
      const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], "me.png", { type: "image/png" });
      const uploaded = await kept.kimSso!.upload("/me/avatar", { file: png });
      expect(uploaded.status).toBe(200);
      expect(uploaded.body.data.user).toMatchObject({ avatarUrl: expect.stringMatching(/^\/api\/images\//), ssoManaged: true, ssoManagedEmail: true, hasPassword: false });
      const removed = await kept.kimSso!.post("/me/avatar/remove");
      expect(removed.body.data.user).toMatchObject({ avatarUrl: null, ssoManaged: true, ssoManagedEmail: true, hasPassword: false });
      expect(Object.keys(removed.body.data.user).sort()).toEqual(Object.keys(userShape({ ssoManaged: true, ssoManagedEmail: true, hasPassword: false })).sort());
    });
  });

  describe("the profile of someone single sign-on created, with an email the provider has not verified", () => {
    let uma: Client;

    beforeAll(async () => {
      uma = (await enter({ sub: "usr_uma", username: "uma", name: "Uma", emailVerified: false })).client;
    });

    test("manages its own email, and changes it without a password, having none", async () => {
      expect(await me(uma)).toEqual(userShape({ email: "uma@example.com", name: "Uma", ssoManaged: true, ssoManagedEmail: false, hasPassword: false }));
      const changed = await uma.post("/me/update", { email: "Uma.New@Example.com" });
      expect(changed.status).toBe(200);
      expect(changed.body.data.user).toMatchObject({ email: "uma.new@example.com", ssoManagedEmail: false, hasPassword: false });
    });

    test("is still held to the other rules of an email change", async () => {
      const taken = await uma.post("/me/update", { email: "kim@example.com" });
      expect(taken.status).toBe(409);
      expect(taken.body).toEqual({ error: { code: "email_taken", message: "That email is already in use" } } as never);
      expect((await kept.ownerSso!.post("/workspace/update", { emailDomains: ["corp.example"] })).status).toBe(200);
      try {
        const outside = await uma.post("/me/update", { email: "uma@elsewhere.example" });
        expect(outside.status).toBe(400);
        expect(outside.body).toEqual({ error: { code: "invalid_input", message: "Only corp.example addresses are allowed in this workspace" } } as never);
        expect((await uma.post("/me/update", { email: "uma@corp.example" })).status).toBe(200);
      } finally {
        await kept.ownerSso!.post("/workspace/update", { emailDomains: [] });
      }
    });

    test("cannot change its name: that still comes from the provider", async () => {
      const res = await uma.post("/me/update", { name: "Uma T" });
      expect(res.status).toBe(403);
      expect(res.body.error).toEqual({ code: "sso_managed", message: "Your name comes from your identity provider" });
    });

    test("has its email managed by the provider from the sign-in that verifies one", async () => {
      const verified = await enter({ sub: "usr_uma", username: "uma", name: "Uma", email: "uma@example.org" });
      expect(await me(verified.client)).toMatchObject({ email: "uma@example.org", ssoManagedEmail: true });
      expect((await verified.client.post("/me/update", { email: "uma@corp.example" })).status).toBe(403);
    });
  });

  describe("the profile of a linked account that has a password", () => {
    let dave: Client;

    beforeAll(async () => {
      dave = (await enter({ sub: "usr_dave", username: "dave", name: "Dave", email: "dave@example.com", emailVerified: false })).client;
    });

    test("confirms a change of an email it manages with that password", async () => {
      expect(await me(dave)).toEqual(userShape({ id: ids["dave@example.com"], email: "dave@example.com", name: "Dave", ssoManaged: true, ssoManagedEmail: false, hasPassword: true }));
      for (const body of [{ email: "dave.new@example.com" }, { email: "dave.new@example.com", currentPassword: "not-it" }]) {
        const res = await dave.post("/me/update", body);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: { code: "invalid_password", message: "Current password is incorrect" } } as never);
      }
      const changed = await dave.post("/me/update", { email: "dave.new@example.com", currentPassword: "member-password" });
      expect(changed.status).toBe(200);
      expect(changed.body.data.user).toMatchObject({ email: "dave.new@example.com", ssoManagedEmail: false, hasPassword: true });
    });
  });

  describe("the profile of an account that is not linked", () => {
    test("changes its name freely, and its email with its password", async () => {
      const { client } = await passwordLogin("olga@example.com", "olga-password-2");
      const renamed = await client.post("/me/update", { name: "Olga P" });
      expect(renamed.status).toBe(200);
      expect(renamed.body.data.user).toEqual(userShape({ id: ids["olga@example.com"], email: "olga@example.com", name: "Olga P", ssoManaged: false, ssoManagedEmail: false, hasPassword: true }));
      expect((await client.post("/me/update", { email: "olga.p@example.com" })).status).toBe(400);
      expect((await client.post("/me/update", { email: "olga.p@example.com", currentPassword: "olga-password-2" })).status).toBe(200);
      expect((await client.post("/me/update", { email: "olga@example.com", currentPassword: "olga-password-2" })).status).toBe(200);
    });
  });

  describe("the member list and member roles", () => {
    test("every member is marked as linked or not, and as having a managed email or not; never with hasPassword", async () => {
      const res = await kept.ownerSso!.get("/members?limit=200");
      const items: Record<string, any>[] = res.body.data.items;
      const byEmail = Object.fromEntries(items.map((item) => [item.email, item]));
      expect(byEmail["kim@example.com"]).toEqual(
        userShape({ email: "kim@example.com", name: "Kim", timezone: "Europe/Berlin", locale: "de-DE", deactivatedAt: null, ssoManaged: true, ssoManagedEmail: true }),
      );
      expect(byEmail["dave.new@example.com"]).toMatchObject({ ssoManaged: true, ssoManagedEmail: false });
      expect(byEmail["olga@example.com"]).toEqual(
        userShape({ id: ids["olga@example.com"], email: "olga@example.com", name: "Olga P", deactivatedAt: null, ssoManaged: false, ssoManagedEmail: false }),
      );
      for (const item of items) {
        expect(typeof item.ssoManaged).toBe("boolean");
        expect(typeof item.ssoManagedEmail).toBe("boolean");
        expect("hasPassword" in item).toBe(false);
      }
      // A member sees the same marks.
      const asMember = (await kept.kimSso!.get("/members?query=olga")).body.data.items;
      expect(asMember).toEqual([expect.objectContaining({ email: "olga@example.com", ssoManaged: false, ssoManagedEmail: false })]);
    });

    test("the role of a linked member cannot be changed here, their own included", async () => {
      const [kimRow] = await t.sql`SELECT id FROM users WHERE auth_sub = 'usr_kim'`;
      for (const userId of [kimRow.id, ids.owner]) {
        const res = await kept.ownerSso!.post("/members/role", { userId, role: "admin" });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: { code: "sso_managed", message: "This member's role is managed by the identity provider" } } as never);
      }
      expect((await t.sql`SELECT role FROM users WHERE auth_sub = 'usr_kim'`)[0].role).toBe("member");
      expect((await t.sql`SELECT role FROM users WHERE id = ${ids.owner!}`)[0].role).toBe("owner");
    });

    test("the role of a member who is not linked is changed as before", async () => {
      const res = await kept.ownerSso!.post("/members/role", { userId: ids["olga@example.com"], role: "admin" });
      expect(res.status).toBe(200);
      // The answer is a plain user: no single sign-on fields.
      expect(res.body).toEqual({ data: { user: userShape({ id: ids["olga@example.com"], email: "olga@example.com", name: "Olga P", role: "admin" }) } });
    });

    test("the other checks of a role change come first", async () => {
      const [kimRow] = await t.sql`SELECT id FROM users WHERE auth_sub = 'usr_kim'`;
      const invalid = await kept.ownerSso!.post("/members/role", { userId: kimRow.id, role: "king" });
      expect(invalid.status).toBe(400);
      const asMember = await kept.kimSso!.post("/members/role", { userId: ids["quinn@example.com"], role: "admin" });
      expect(asMember.body).toEqual({ error: { code: "forbidden", message: "Only workspace admins can do this" } } as never);
      // Olga is an admin now, and not linked: an admin never manages an owner, linked or not.
      const { client: olgaAdmin } = await passwordLogin("olga@example.com", "olga-password-2");
      const onOwner = await olgaAdmin.post("/members/role", { userId: ids.owner, role: "member" });
      expect(onOwner.body).toEqual({ error: { code: "forbidden", message: "Only owners can manage owners" } } as never);
      // And is refused for a linked member like anyone.
      expect((await olgaAdmin.post("/members/role", { userId: kimRow.id, role: "admin" })).body.error!.code).toBe("sso_managed");
      expect((await kept.ownerSso!.post("/members/role", { userId: ids["olga@example.com"], role: "member" })).status).toBe(200);
    });
  });
});

describe("4. single sign-on turned off again", () => {
  beforeAll(async () => {
    await restart({});
  });

  test("the sign-on routes are gone and the browser learns that only passwords are used", async () => {
    expect((await t.client().get("/auth/config")).body).toEqual({ data: { sso: { enabled: false, localLogin: true } } });
    expect((await t.client().get("/auth/login")).status).toBe(404);
    expect((await t.client().get("/auth/callback?code=x&state=y")).status).toBe(404);
  });

  test("sessions the provider started end at their next request", async () => {
    const session = (await sessionRow(t.sql, kept.ownerSso!))!;
    expect(session.auth_recheck_at).not.toBeNull();
    const res = await kept.ownerSso!.get("/me");
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED as never);
    expect(await t.sql`SELECT 1 FROM sessions WHERE id = ${session.id}`).toHaveLength(0);
    expect((await kept.kimSso!.get("/auth/config")).status).toBe(200);
    expect(await sessionRow(t.sql, kept.kimSso!)).toBeUndefined();
  });

  test("the password sessions that ended when single sign-on came stay ended", async () => {
    expect((await kept.ownerPassword!.get("/me")).status).toBe(401);
    expect((await kept.olgaPassword!.get("/me")).status).toBe(401);
  });

  test("a linked account that has a password signs in with it again, and its answers carry no single sign-on fields", async () => {
    const { client, res } = await passwordLogin("owner@example.com", "owner-password");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { user: userShape({ id: ids.owner, email: "owner@example.com", name: "Owner", role: "owner" }) } });
    expect(await me(client)).toEqual(userShape({ id: ids.owner, email: "owner@example.com", name: "Owner", role: "owner" }));
    // The session is served request after request, though the account is still linked in the database.
    expect((await client.get("/me")).status).toBe(200);
    const members: Record<string, unknown>[] = (await client.get("/members?limit=200")).body.data.items;
    expect(members.length).toBeGreaterThan(5);
    for (const member of members) expect(Object.keys(member).sort()).toEqual(Object.keys(userShape({ deactivatedAt: null })).sort());
    kept.ownerPassword = client;
  });

  test("a linked person's name, email and role are the workspace's again", async () => {
    const [kimRow] = await t.sql`SELECT id FROM users WHERE auth_sub = 'usr_kim'`;
    const role = await kept.ownerPassword!.post("/members/role", { userId: kimRow.id, role: "admin" });
    expect(role.status).toBe(200);
    expect(role.body.data.user.role).toBe("admin");
    const renamed = await kept.ownerPassword!.post("/me/update", { name: "The Owner", email: "the.owner@example.com", currentPassword: "owner-password" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.user).toEqual(userShape({ id: ids.owner, email: "the.owner@example.com", name: "The Owner", role: "owner" }));
  });

  test("a reset link sent before the account was linked works again", async () => {
    const client = t.client();
    const res = await client.post("/auth/reset-password", { token: kept.quinnReset, password: "quinn-new-password" });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toEqual(userShape({ id: ids["quinn@example.com"], email: "quinn@example.com", name: "Quinn" }));
    expect((await client.get("/me")).status).toBe(200);
  });

  test("someone single sign-on created sets a password with forgot-password, and signs in with it", async () => {
    t.smtp.clear();
    expect((await t.client().post("/auth/forgot-password", { email: "kim@example.com" })).body).toEqual({ data: {} });
    const [mail] = await t.smtp.waitFor(1);
    expect(mail!.to).toBe("kim@example.com");
    const reset = await t.client().post("/auth/reset-password", { token: resetToken(mail!.text), password: "kim-password-1" });
    expect(reset.status).toBe(200);
    const { client, res } = await passwordLogin("kim@example.com", "kim-password-1");
    expect(res.status).toBe(200);
    expect((await client.post("/auth/logout")).body).toEqual({ data: {} });
  });
});

describe("5. single sign-on turned on again", () => {
  beforeAll(async () => {
    await restart({ ...idp.env, AUTH_LOCAL_LOGIN: "true" });
  });

  test("the links are as they were: a linked account's password session ends, and it signs in through the provider", async () => {
    // The owner's password session, started while single sign-on was off.
    expect((await kept.ownerPassword!.get("/me")).status).toBe(401);
    expect((await passwordLogin("the.owner@example.com", "owner-password")).res.status).toBe(401);
    const signedIn = await enter({ ...owner, email: "the.owner@example.com" });
    expect(signedIn.location).toBe("/");
    // The provider's name replaces the one set while it was off.
    expect(await me(signedIn.client)).toMatchObject({ id: ids.owner, name: "Owner", ssoManaged: true, hasPassword: true });
    // Kim has a password now, and is still linked.
    const kimAgain = await enter(kim);
    expect(await me(kimAgain.client)).toMatchObject({ role: "member", ssoManaged: true, hasPassword: true });
  });
});
