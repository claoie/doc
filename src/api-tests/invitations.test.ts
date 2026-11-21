import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Client, type TestServer } from "./harness";
import {
  ARGON2_HASH,
  ISO,
  NOT_ADMIN,
  PNG,
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
  imageFile,
  inviteParts,
  mailsTo,
  rows,
  sha256,
  userShape,
  waitForMailsTo,
} from "./harness/admin";

/* Invitations: sending, listing, rotating and revoking them, and joining with one. */

let t: TestServer;
let owner: Client;
let ownerUser: any;
let admin: Client;
let adminUser: any;
let member: Client;
let everyoneId: string;
let serial = 0;

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const INVALID = { error: { code: "invalid_invitation", message: "This invitation is invalid, expired or has been revoked" } };
const URL_RE = /^http:\/\/doc\.test\/invites\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\?token=[A-Za-z0-9_-]{43}$/;

const address = (label = "guest") => `${label}-${++serial}@example.com`;

/** Invites one address and returns the invitation with the parts of its link. */
const invite = async (email = address(), body: Record<string, unknown> = {}, by: Client = owner) => {
  const res = await by.post("/invitations", { emails: [email], ...body });
  if (res.status !== 200 || res.body.data.length !== 1) throw new Error(`invite failed: ${res.status} ${res.text}`);
  const created = res.body.data[0] as { id: string; email: string; url: string };
  return { ...created, ...inviteParts(created.url) };
};

const info = (id: string, token: string, client: Client = t.client()) => client.get(`/invitations/${id}?token=${encodeURIComponent(token)}`);
const accept = (body: Record<string, unknown>, client: Client = t.client()) => client.post("/invitations/accept", body);
const pending = async () => (await owner.get("/invitations")).body.data as any[];
const groupNamed = async (name: string) => (await owner.post("/groups", { name })).body.data.group.id as string;

beforeAll(async () => {
  t = await startServer();
  ({ owner, user: ownerUser } = await t.setupOwner());
  ({ client: admin, user: adminUser } = await t.addMember(owner, "admin@example.com", "admin"));
  ({ client: member } = await t.addMember(owner, "member@example.com"));
  everyoneId = (await owner.get("/groups")).body.data[0].id;
});

afterAll(async () => {
  await t.close();
});

describe("POST /invitations", () => {
  test("creates an invitation, mails its link and answers it", async () => {
    const res = await owner.post("/invitations", { emails: ["first@example.com"] });
    expectBody(res, 200, { data: [{ id: expect.stringMatching(UUID), email: "first@example.com", url: expect.stringMatching(URL_RE) }] });
    expectApiHeaders(res.headers);
    const { id, url } = res.body.data[0];
    const { id: linkId, token } = inviteParts(url);
    expect(linkId).toBe(id);
    expect(token).toMatch(TOKEN);

    expect(await rows(t.sql`SELECT email, role, group_ids::text[] AS group_ids, token_hash, invited_by FROM invitations WHERE id = ${id}`)).toEqual([
      { email: "first@example.com", role: "member", group_ids: [], token_hash: sha256(token), invited_by: ownerUser.id },
    ]);
    const [mail] = await waitForMailsTo(t, "first@example.com");
    expectMail(mail, {
      to: "first@example.com",
      subject: "Owner invited you to Acme",
      paragraphs: ["Owner invited you to join Acme."],
      action: { label: "Accept invitation", url },
    });
    expect(mail!.text).toBe(`Owner invited you to join Acme.\n\nAccept invitation: ${url}`);
    expect(mail!.html).toBe(
      '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#222;line-height:1.5"><div style="max-width:560px;margin:0 auto;padding:24px">' +
        '<p style="margin:0 0 16px">Owner invited you to join Acme.</p>' +
        `<p style="margin:24px 0"><a href="${url}" style="background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Accept invitation</a></p>` +
        `<p style="color:#666;font-size:12px">${url}</p></div></body></html>`,
    );
    // Nobody is a member yet.
    expect((await owner.get("/members?query=first@example.com")).body.data.total).toBe(0);
  });

  test("addresses are trimmed, lower-cased and invited once each, in the order given", async () => {
    const res = await admin.post("/invitations", { emails: ["  Mixed.Case@Example.COM ", "second-of-list@example.com", "mixed.case@example.com", "MIXED.CASE@EXAMPLE.COM"], role: "member" });
    expect(res.status).toBe(200);
    expect(res.body.data.map((i: any) => i.email)).toEqual(["mixed.case@example.com", "second-of-list@example.com"]);
    expect(await rows(t.sql`SELECT invited_by FROM invitations WHERE lower(email) = 'mixed.case@example.com'`)).toEqual([{ invited_by: adminUser.id }]);
    const [mail] = await waitForMailsTo(t, "mixed.case@example.com");
    expect(mail!.subject).toBe("admin invited you to Acme");
    await flushMail(t, owner);
    expect(mailsTo(t, "mixed.case@example.com")).toHaveLength(1);
  });

  test("the forms of address that pass and the ones that do not", async () => {
    const valid: [string, string][] = [
      ["Simple@Example.com", "simple@example.com"],
      [" first.last+tag@sub.example.co.uk ", "first.last+tag@sub.example.co.uk"],
      ["üñí@exämple.com", "üñí@exämple.com"],
      ["ÉCOLE@EXAMPLE.FR", "école@example.fr"],
      ["日本@例え.jp", "日本@例え.jp"],
      ["a@b.c", "a@b.c"],
      ["o'brien@example.com", "o'brien@example.com"],
      ["a!#$%&*=?^_`{|}~-@example.com", "a!#$%&*=?^_`{|}~-@example.com"],
      ["user@1.2", "user@1.2"],
      [".dot.@example.com", ".dot.@example.com"],
      ["a..b@example..com", "a..b@example..com"],
      ["user@-example-.com", "user@-example-.com"],
      [`${"l".repeat(242)}@example.com`, `${"l".repeat(242)}@example.com`],
    ];
    const res = await owner.post("/invitations", { emails: valid.map(([given]) => given) });
    expect(res.status).toBe(200);
    expect(res.body.data.map((i: any) => i.email)).toEqual(valid.map(([, stored]) => stored));
    await t.sql`DELETE FROM invitations WHERE id = ANY(${t.sql.array(res.body.data.map((i: any) => i.id), "uuid")})`;

    const invalid = [
      "plain",
      "a@",
      "@example.com",
      "user@example",
      "user@example.",
      "user @example.com",
      "us er@example.com",
      "user@exa mple.com",
      "user\t@example.com",
      "a@b@c.com",
      "user<x>@example.com",
      "user(x)@example.com",
      "user[x]@example.com",
      "user\\x@example.com",
      "user,x@example.com",
      "user;x@example.com",
      "user:x@example.com",
      'user"x@example.com',
      "User Name <user@example.com>",
      "user@example.com,other@example.com",
      // 142 code points, but more than 254 UTF-16 units.
      `${"🎉".repeat(130)}@example.com`,
    ];
    for (const email of invalid) {
      const refused = await owner.post("/invitations", { emails: ["fine@example.com", email] });
      expect({ email, status: refused.status, body: refused.body as unknown }).toEqual({ email, status: 400, body: { error: { code: "invalid_input", message: "Invalid email address" } } });
    }
    // One bad address refuses the lot.
    expect((await pending()).some((i) => i.email === "fine@example.com")).toBe(false);
  });

  test("the list of addresses is required and holds 1 to 50 strings", async () => {
    expectInvalid(await owner.post("/invitations", {}), "emails is required");
    expectInvalid(await owner.post("/invitations", { emails: [] }), "emails is required");
    for (const emails of [null, "a@example.com", 5, { 0: "a@example.com" }, Array.from({ length: 51 }, (_, i) => `many-${i}@example.com`)]) {
      expectInvalid(await owner.post("/invitations", { emails }), "emails must be a list of at most 50 items");
    }
    expectInvalid(await owner.post("/invitations", { emails: ["a@example.com", 5] }), "emails must be a string");
    expectInvalid(await owner.post("/invitations", { emails: [null] }), "emails must be a string");
    expectInvalid(await owner.post("/invitations", { emails: ["a@example.com", ""] }), "emails is required");
    expectInvalid(await owner.post("/invitations", { emails: ["   "] }), "emails is required");
    expectInvalid(await owner.post("/invitations", { emails: [`${"l".repeat(243)}@example.com`] }), "emails must be at most 254 characters");
    const fifty = await owner.post("/invitations", { emails: Array.from({ length: 50 }, (_, i) => `fifty-${i}@example.com`) });
    expect(fifty.status).toBe(200);
    expect(fifty.body.data).toHaveLength(50);
    await t.sql`DELETE FROM invitations WHERE email LIKE 'fifty-%'`;
  });

  test("the role is member unless it says admin; owner cannot be invited", async () => {
    const plain = await invite();
    const asMember = await invite(address(), { role: "member" });
    const asAdmin = await invite(address(), { role: "admin" });
    const roles = Object.fromEntries((await pending()).map((i) => [i.id, i.role]));
    expect([roles[plain.id], roles[asMember.id], roles[asAdmin.id]]).toEqual(["member", "member", "admin"]);
    for (const role of ["owner", "Admin", "", null, 1, ["admin"]]) {
      expectInvalid(await owner.post("/invitations", { emails: [address()], role }), "role must be one of admin, member");
    }
  });

  test("groups are remembered; the default group and unknown ones are left out", async () => {
    const one = await groupNamed("Invite One");
    const two = await groupNamed("Invite Two");
    const created = await invite(address(), { groupIds: [two.toUpperCase(), one, everyoneId, UNKNOWN, two] });
    const listed = (await pending()).find((i) => i.id === created.id);
    expect([...listed.groupIds].sort()).toEqual([one, two].sort());
    const none = await invite(address(), { groupIds: [everyoneId, UNKNOWN] });
    expect((await pending()).find((i) => i.id === none.id).groupIds).toEqual([]);
    const empty = await invite(address(), { groupIds: [] });
    expect((await pending()).find((i) => i.id === empty.id).groupIds).toEqual([]);

    for (const groupIds of [null, one, 5, Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)]) {
      expectInvalid(await owner.post("/invitations", { emails: [address()], groupIds }), "groupIds must be a list of at most 50 ids");
    }
    for (const groupIds of [["nope"], [one, 5], [null]]) {
      expectInvalid(await owner.post("/invitations", { emails: [address()], groupIds }), "groupIds must contain valid ids");
    }
  });

  test("people who are members already are passed over, deactivated ones too", async () => {
    const { user } = await t.addMember(owner, "already-off@example.com");
    await owner.post("/members/deactivate", { userId: user.id });
    await waitForMailsTo(t, "already-off@example.com", 1);
    const fresh = address();
    const res = await owner.post("/invitations", { emails: ["OWNER@example.com", "member@example.com", " Already-Off@Example.com", fresh] });
    expectBody(res, 200, { data: [{ id: expect.stringMatching(UUID), email: fresh, url: expect.stringMatching(URL_RE) }] });
    expectBody(await owner.post("/invitations", { emails: ["owner@example.com", "member@example.com"] }), 200, { data: [] });
    expect((await pending()).some((i) => ["owner@example.com", "member@example.com", "already-off@example.com"].includes(i.email))).toBe(false);
    await flushMail(t, owner);
    expect(mailsTo(t, "owner@example.com").filter((m) => m.subject.includes("invited you"))).toHaveLength(0);
    expect(mailsTo(t, "already-off@example.com")).toHaveLength(1);
  });

  test("inviting an address again replaces its invitation: same id, new link, new role, groups and inviter", async () => {
    const g = await groupNamed("Reinvite");
    const email = address("again");
    const first = await invite(email, { role: "admin", groupIds: [g] });
    await t.sql`UPDATE invitations SET created_at = now() - interval '10 days' WHERE id = ${first.id}`;
    const second = await invite(email.toUpperCase(), {}, admin);
    expect(second.id).toBe(first.id);
    expect(second.token).not.toBe(first.token);
    expectBody(await info(first.id, first.token), 400, INVALID);
    expectBody(await info(second.id, second.token), 200, { data: { email, workspaceName: "Acme" } });
    const all = (await pending()).filter((i) => i.email === email);
    expect(all).toEqual([{ id: first.id, email, role: "member", groupIds: [], invitedBy: { id: adminUser.id, name: "admin", avatarUrl: null }, createdAt: expect.stringMatching(ISO) }]);
    expect(Date.now() - Date.parse(all[0].createdAt)).toBeLessThan(60_000);
    expect((await waitForMailsTo(t, email, 2)).map((m) => m.subject)).toEqual(["Owner invited you to Acme", "admin invited you to Acme"]);
  });

  test("the inviter's and the workspace's names are escaped in the HTML part only", async () => {
    const hostile = t.client();
    const invited = await invite(address("hostile"), { role: "admin" });
    await accept({ id: invited.id, token: invited.token, name: 'Tom & "Jerry" <b>', password: "member-password" }, hostile);
    await owner.post("/workspace/update", { name: "R&D <Lab>" });
    const email = address("escaped");
    const created = await invite(email, {}, hostile);
    await owner.post("/workspace/update", { name: "Acme" });
    const [mail] = await waitForMailsTo(t, email);
    expectMail(mail, {
      to: email,
      subject: 'Tom & "Jerry" <b> invited you to R&D <Lab>',
      paragraphs: ['Tom & "Jerry" <b> invited you to join R&D <Lab>.'],
      action: { label: "Accept invitation", url: created.url },
    });
    expect(mail!.html).toContain('<p style="margin:0 0 16px">Tom &amp; &quot;Jerry&quot; &lt;b&gt; invited you to join R&amp;D &lt;Lab&gt;.</p>');
  });

  test("a name in another script reaches the subject intact, and line breaks in a name cannot add headers", async () => {
    const unicode = t.client();
    const first = await invite(address("unicode"), { role: "admin" });
    await accept({ id: first.id, token: first.token, name: "Zoë 山田 🎉", password: "member-password" }, unicode);
    const email = address("subject");
    await invite(email, {}, unicode);
    expect((await waitForMailsTo(t, email))[0]!.subject).toBe("Zoë 山田 🎉 invited you to Acme");

    const sneaky = t.client();
    const second = await invite(address("sneaky"), { role: "admin" });
    await accept({ id: second.id, token: second.token, name: "Eve\r\nBcc: spy@evil.example", password: "member-password" }, sneaky);
    const target = address("target");
    await invite(target, {}, sneaky);
    const [mail] = await waitForMailsTo(t, target);
    expect(mail!.subject).toBe("Eve Bcc: spy@evil.example invited you to Acme");
    expect(mail!.headers.bcc).toBeUndefined();
    expect(mail!.text.startsWith("Eve\r\nBcc: spy@evil.example invited you to join Acme.")).toBe(true);
    await flushMail(t, owner);
    expect(mailsTo(t, "spy@evil.example")).toHaveLength(0);
  });

  test("a workspace without a name is `a workspace` in the mail", async () => {
    // The API never leaves the name empty, so it is emptied in the database.
    await t.sql`UPDATE workspace SET name = ''`;
    const email = address("noname");
    const created = await invite(email);
    const answered = await info(created.id, created.token);
    await t.sql`UPDATE workspace SET name = 'Acme'`;
    const [mail] = await waitForMailsTo(t, email);
    expect(mail!.subject).toBe("Owner invited you to a workspace");
    expect(mail!.text).toBe(`Owner invited you to join a workspace.\n\nAccept invitation: ${created.url}`);
    expectBody(answered, 200, { data: { email, workspaceName: "" } });
  });

  test("members cannot invite, whatever they send; the body is checked in the order emails, role, groups", async () => {
    expectBody(await member.post("/invitations", { emails: [address()] }), 403, NOT_ADMIN);
    expectBody(await member.post("/invitations", {}), 403, NOT_ADMIN);
    expectBody(await t.client().post("/invitations", { emails: [address()] }), 401, UNAUTHORIZED);
    expectInvalid(await owner.post("/invitations", { emails: "x", role: "x", groupIds: "x" }), "emails must be a list of at most 50 items");
    expectInvalid(await owner.post("/invitations", { emails: ["nope"], role: "x", groupIds: "x" }), "Invalid email address");
    expectInvalid(await owner.post("/invitations", { emails: ["a@example.com"], role: "x", groupIds: "x" }), "role must be one of admin, member");
    expectInvalid(await owner.post("/invitations", { emails: ["a@example.com"], role: "admin", groupIds: "x" }), "groupIds must be a list of at most 50 ids");
  });
});

describe("POST /invitations with allowed email domains (sets the workspace setting; cleared at the end)", () => {
  beforeAll(async () => {
    await owner.post("/workspace/update", { emailDomains: ["allowed.example", "also.example"] });
  });

  afterAll(async () => {
    await owner.post("/workspace/update", { emailDomains: [] });
  });

  test("only addresses in those domains can be invited; one outside refuses the lot", async () => {
    const message = "Only allowed.example, also.example addresses can be invited";
    for (const emails of [["x@outside.example"], ["in@allowed.example", "x@outside.example"], ["x@sub.allowed.example"], ["x@allowed.example.evil.example"], ["x@notallowed.example"]]) {
      expectInvalid(await admin.post("/invitations", { emails }), message);
    }
    expect((await pending()).some((i) => i.email === "in@allowed.example")).toBe(false);
    const res = await owner.post("/invitations", { emails: ["One@ALLOWED.example", "two@also.example"] });
    expect(res.status).toBe(200);
    expect(res.body.data.map((i: any) => i.email)).toEqual(["one@allowed.example", "two@also.example"]);
    // The domain is checked before members are passed over, and after the body's own checks.
    expectInvalid(await owner.post("/invitations", { emails: ["owner@example.com"] }), message);
    expectInvalid(await owner.post("/invitations", { emails: ["x@outside.example"], role: "owner" }), "role must be one of admin, member");
  });

  test("an invitation sent before the restriction can still be resent and accepted", async () => {
    await owner.post("/workspace/update", { emailDomains: [] });
    const early = await invite("early@outside.example");
    await owner.post("/workspace/update", { emailDomains: ["allowed.example", "also.example"] });
    const resent = await owner.post("/invitations/resend", { id: early.id });
    expect(resent.status).toBe(200);
    const res = await accept({ ...inviteParts(resent.body.data.url), name: "Early", password: "member-password" });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe("early@outside.example");
  });
});

describe("GET /invitations", () => {
  test("lists pending invitations, the newest first, with who sent them", async () => {
    const g = await groupNamed("Listed Group");
    const avatarUrl = (await admin.upload("/me/avatar", { file: imageFile(PNG) })).body.data.user.avatarUrl;
    const older = await invite(address("older"), { role: "admin", groupIds: [g] });
    const newer = await invite(address("newer"), {}, admin);
    await t.sql`UPDATE invitations SET created_at = now() + interval '2 minutes' WHERE id = ${older.id}`;
    await t.sql`UPDATE invitations SET created_at = now() + interval '3 minutes' WHERE id = ${newer.id}`;
    const res = await admin.get("/invitations");
    expect(res.status).toBe(200);
    expectApiHeaders(res.headers);
    expect(res.body.data.slice(0, 2)).toEqual([
      { id: newer.id, email: newer.email, role: "member", groupIds: [], invitedBy: { id: adminUser.id, name: "admin", avatarUrl }, createdAt: expect.stringMatching(ISO) },
      { id: older.id, email: older.email, role: "admin", groupIds: [g], invitedBy: { id: ownerUser.id, name: "Owner", avatarUrl: null }, createdAt: expect.stringMatching(ISO) },
    ]);
    const times = res.body.data.map((i: any) => Date.parse(i.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // No link or token is in the list.
    expect(JSON.stringify(res.body)).not.toContain(newer.token);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(["createdAt", "email", "groupIds", "id", "invitedBy", "role"]);
    await admin.post("/me/avatar/remove");
    await t.sql`UPDATE invitations SET created_at = now() WHERE id IN (${older.id}, ${newer.id})`;
  });

  test("members cannot list them", async () => {
    expectBody(await member.get("/invitations"), 403, NOT_ADMIN);
    expectBody(await t.client().get("/invitations"), 401, UNAUTHORIZED);
  });
});

describe("POST /invitations/resend and /invitations/link", () => {
  test("resend makes a new link, mails it in the name of whoever resends, and renews the 14 days", async () => {
    const created = await invite(address("resend"), { role: "admin" });
    await t.sql`UPDATE invitations SET created_at = now() - interval '20 days' WHERE id = ${created.id}`;
    expectBody(await info(created.id, created.token), 400, INVALID);
    const res = await admin.post("/invitations/resend", { id: created.id.toUpperCase() });
    expectBody(res, 200, { data: { url: expect.stringMatching(URL_RE) } });
    expectApiHeaders(res.headers);
    const fresh = inviteParts(res.body.data.url);
    expect(fresh.id).toBe(created.id);
    expect(fresh.token).not.toBe(created.token);
    expectBody(await info(created.id, created.token), 400, INVALID);
    expectBody(await info(fresh.id, fresh.token), 200, { data: { email: created.email, workspaceName: "Acme" } });

    const mails = await waitForMailsTo(t, created.email, 2);
    expectMail(mails[1], { to: created.email, subject: "admin invited you to Acme", paragraphs: ["admin invited you to join Acme."], action: { label: "Accept invitation", url: res.body.data.url } });
    // Who invited, the role and the groups stay as they were.
    const listed = (await pending()).find((i) => i.id === created.id);
    expect(listed).toEqual({ id: created.id, email: created.email, role: "admin", groupIds: [], invitedBy: { id: ownerUser.id, name: "Owner", avatarUrl: null }, createdAt: expect.stringMatching(ISO) });
    expect(Date.now() - Date.parse(listed.createdAt)).toBeLessThan(60_000);
    expect(await rows(t.sql`SELECT token_hash FROM invitations WHERE id = ${created.id}`)).toEqual([{ token_hash: sha256(fresh.token) }]);
  });

  test("link makes a new link without mailing it", async () => {
    const created = await invite(address("link"));
    await waitForMailsTo(t, created.email, 1);
    await t.sql`UPDATE invitations SET created_at = now() - interval '20 days' WHERE id = ${created.id}`;
    const res = await owner.post("/invitations/link", { id: created.id });
    expectBody(res, 200, { data: { url: expect.stringMatching(URL_RE) } });
    expectApiHeaders(res.headers);
    const fresh = inviteParts(res.body.data.url);
    expect(fresh.token).not.toBe(created.token);
    expectBody(await info(created.id, created.token), 400, INVALID);
    expectBody(await info(fresh.id, fresh.token), 200, { data: { email: created.email, workspaceName: "Acme" } });
    // Each call makes the one before it useless.
    const again = inviteParts((await admin.post("/invitations/link", { id: created.id })).body.data.url);
    expectBody(await info(fresh.id, fresh.token), 400, INVALID);
    expectBody(await info(again.id, again.token), 200, { data: { email: created.email, workspaceName: "Acme" } });
    await flushMail(t, owner);
    expect(mailsTo(t, created.email)).toHaveLength(1);
  });

  test.each(["resend", "link"])("%s: an unknown invitation is a 404, the id must be a UUID, and members are refused first", async (action) => {
    const created = await invite();
    expectError(await owner.post(`/invitations/${action}`, { id: UNKNOWN }), 404, "not_found", "Invitation not found");
    for (const body of [{}, { id: null }, { id: "nope" }, { id: 5 }, { id: [created.id] }]) {
      expectInvalid(await owner.post(`/invitations/${action}`, body), "id must be a valid id");
      expectBody(await member.post(`/invitations/${action}`, body), 403, NOT_ADMIN);
    }
    expectBody(await member.post(`/invitations/${action}`, { id: created.id }), 403, NOT_ADMIN);
    expectBody(await t.client().post(`/invitations/${action}`, { id: created.id }), 401, UNAUTHORIZED);
    expectBody(await info(created.id, created.token), 200, { data: { email: created.email, workspaceName: "Acme" } });
    // Once accepted there is nothing left to resend.
    await accept({ id: created.id, token: created.token, name: "Joined", password: "member-password" });
    expectError(await owner.post(`/invitations/${action}`, { id: created.id }), 404, "not_found", "Invitation not found");
  });
});

describe("POST /invitations/revoke", () => {
  test("removes the invitation, so its link stops working; an unknown id does nothing", async () => {
    const created = await invite();
    const res = await admin.post("/invitations/revoke", { id: created.id.toUpperCase() });
    expectBody(res, 200, { data: {} });
    expectApiHeaders(res.headers);
    expect((await pending()).some((i) => i.id === created.id)).toBe(false);
    expectBody(await info(created.id, created.token), 400, INVALID);
    expectBody(await accept({ id: created.id, token: created.token, name: "Late", password: "member-password" }), 400, INVALID);
    expectBody(await owner.post("/invitations/revoke", { id: created.id }), 200, { data: {} });
    expectBody(await owner.post("/invitations/revoke", { id: UNKNOWN }), 200, { data: {} });
    // The address can be invited again, as a new invitation.
    const again = await invite(created.email);
    expect(again.id).not.toBe(created.id);
  });

  test("the id must be a UUID; members are refused first", async () => {
    const created = await invite();
    for (const body of [{}, { id: null }, { id: "nope" }, { id: 5 }]) {
      expectInvalid(await owner.post("/invitations/revoke", body), "id must be a valid id");
      expectBody(await member.post("/invitations/revoke", body), 403, NOT_ADMIN);
    }
    expectBody(await member.post("/invitations/revoke", { id: created.id }), 403, NOT_ADMIN);
    expectBody(await t.client().post("/invitations/revoke", { id: created.id }), 401, UNAUTHORIZED);
    expect((await pending()).some((i) => i.id === created.id)).toBe(true);
  });
});

describe("GET /invitations/:id", () => {
  test("tells whoever holds the link the address and the workspace's name", async () => {
    const created = await invite(address("info"));
    const res = await info(created.id, created.token);
    expectBody(res, 200, { data: { email: created.email, workspaceName: "Acme" } });
    expectApiHeaders(res.headers);
    expect(res.headers.getSetCookie()).toEqual([]);
    expectBody(await info(created.id.toUpperCase(), created.token), 200, { data: { email: created.email, workspaceName: "Acme" } });
    expectBody(await info(created.id, created.token, member), 200, { data: { email: created.email, workspaceName: "Acme" } });
    // Looking does not use the link up; of a repeated token parameter the last counts.
    expectBody(await t.client().get(`/invitations/${created.id}?token=wrong&token=${created.token}`), 200, { data: { email: created.email, workspaceName: "Acme" } });
    expectBody(await t.client().get(`/invitations/${created.id}?token=${created.token}&token=wrong`), 400, INVALID);
  });

  test("anything but the right id with the right token is refused alike", async () => {
    const created = await invite();
    const other = await invite();
    const swapped = created.token.replace(/[a-zA-Z]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    const attempts: [string, string][] = [
      [created.id, other.token],
      [other.id, created.token],
      [created.id, swapped],
      [created.id, `${created.token}x`],
      [created.id, created.token.slice(1)],
      [created.id, ` ${created.token}`],
      [created.id, sha256(created.token)],
      [created.id, ""],
      [created.id, "x".repeat(200)],
      [created.id, "x".repeat(201)],
      [UNKNOWN, created.token],
      ["nope", created.token],
      [created.id.replace(/-/g, ""), created.token],
      [`${created.id}x`, created.token],
    ];
    for (const [id, token] of attempts) {
      const res = await info(id, token);
      expect({ id, token, status: res.status, body: res.body as unknown }).toEqual({ id, token, status: 400, body: INVALID });
    }
    expectBody(await t.client().get(`/invitations/${created.id}`), 400, INVALID);
    expectBody(await t.client().get(`/invitations/${created.id}?Token=${created.token}`), 400, INVALID);
    expectBody(await info(created.id, created.token), 200, { data: { email: created.email, workspaceName: "Acme" } });
  });

  test("a link stops working 14 days after it was sent", async () => {
    const created = await invite();
    await t.sql`UPDATE invitations SET created_at = now() - interval '13 days 23 hours' WHERE id = ${created.id}`;
    expectBody(await info(created.id, created.token), 200, { data: { email: created.email, workspaceName: "Acme" } });
    await t.sql`UPDATE invitations SET created_at = now() - interval '14 days 1 second' WHERE id = ${created.id}`;
    expectBody(await info(created.id, created.token), 400, INVALID);
    expectBody(await accept({ id: created.id, token: created.token, name: "Late", password: "member-password" }), 400, INVALID);
    // It is still listed, so an admin can renew it.
    expect((await pending()).some((i) => i.id === created.id)).toBe(true);
  });

  test("is limited to 30 lookups a minute per address", async () => {
    const created = await invite();
    const client = t.client({ ip: "198.51.100.60" });
    for (let i = 0; i < 30; i++) expectBody(await info(UNKNOWN, "x", client), 400, INVALID);
    const res = await info(created.id, created.token, client);
    expectBody(res, 429, RATE_LIMITED);
    expectApiHeaders(res.headers);
    expectBody(await info(created.id, created.token, t.client({ ip: "198.51.100.61" })), 200, { data: { email: created.email, workspaceName: "Acme" } });
    // Accepting is counted on its own.
    expectBody(await accept({}, client), 400, INVALID);
  });
});

describe("POST /invitations/accept", () => {
  test("creates the user with the invited role and groups, signs them in and tells the inviter", async () => {
    const one = await groupNamed("Accept One");
    const gone = await groupNamed("Accept Gone");
    const email = address("joiner");
    const created = await invite(email, { role: "admin", groupIds: [one, gone] }, admin);
    await owner.post(`/groups/${gone}/delete`);
    const before = mailsTo(t, "admin@example.com").length;

    const client = t.client({ ip: "203.0.113.50" });
    const res = await client.request("POST", "/invitations/accept", { id: created.id, token: created.token, name: "  Zoë 山田 🎉 ", password: "pässwörd 🔑", role: "owner", email: "other@example.com" }, { "User-Agent": "Joiner/1.0" });
    // Answered as created: the sign-in that follows is not in `lastLoginAt` yet.
    expectBody(res, 200, { data: { user: userShape({ email, name: "Zoë 山田 🎉", role: "admin", lastLoginAt: null }) } });
    expectApiHeaders(res.headers);
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(SESSION_COOKIE)]);
    const user = res.body.data.user;
    expect((await client.get("/me")).body.data.user).toEqual(userShape({ id: user.id, email, name: "Zoë 山田 🎉", role: "admin", createdAt: user.createdAt }));

    expect(await rows(t.sql`SELECT email, name, role, invited_by, password_hash FROM users WHERE id = ${user.id}`)).toEqual([
      { email, name: "Zoë 山田 🎉", role: "admin", invited_by: adminUser.id, password_hash: expect.stringMatching(ARGON2_HASH) },
    ]);
    expect(await Bun.password.verify("pässwörd 🔑", (await rows(t.sql`SELECT password_hash FROM users WHERE id = ${user.id}`))[0].password_hash)).toBe(true);
    expect(await rows(t.sql`SELECT user_agent, ip FROM sessions WHERE user_id = ${user.id}`)).toEqual([{ user_agent: "Joiner/1.0", ip: "203.0.113.50" }]);
    const groups = (await rows(t.sql`SELECT group_id FROM group_members WHERE user_id = ${user.id}`)).map((r) => r.group_id);
    expect(groups.sort()).toEqual([everyoneId, one].sort());
    expect((await pending()).some((i) => i.id === created.id)).toBe(false);
    expect((await t.client().post("/auth/login", { email, password: "pässwörd 🔑" })).status).toBe(200);

    const mail = (await waitForMailsTo(t, "admin@example.com", before + 1))[before];
    expectMail(mail, {
      to: "admin@example.com",
      subject: "Zoë 山田 🎉 accepted your invitation",
      paragraphs: [`Zoë 山田 🎉 (${email}) accepted your invitation and joined the workspace.`],
      action: { label: "Open workspace", url: "http://doc.test" },
    });
  });

  test("a member invitation makes a member, in the default group only", async () => {
    const created = await invite();
    const res = await accept({ id: created.id.toUpperCase(), token: created.token, name: "x", password: "12345678" });
    expectBody(res, 200, { data: { user: userShape({ email: created.email, name: "x", role: "member", lastLoginAt: null }) } });
    expect(await rows(t.sql`SELECT group_id FROM group_members WHERE user_id = ${res.body.data.user.id}`)).toEqual([{ group_id: everyoneId }]);
  });

  test("the link works once", async () => {
    const created = await invite();
    expect((await accept({ id: created.id, token: created.token, name: "Once", password: "member-password" })).status).toBe(200);
    const again = await accept({ id: created.id, token: created.token, name: "Twice", password: "member-password" });
    expectBody(again, 400, INVALID);
    expect(again.headers.getSetCookie()).toEqual([]);
    expectBody(await info(created.id, created.token), 400, INVALID);
    expect((await owner.get(`/members?query=${created.email}`)).body.data.items.map((m: any) => m.name)).toEqual(["Once"]);
  });

  test("two people using the same link at the same moment: one joins", async () => {
    const created = await invite();
    const attempts = await Promise.all(["A", "B"].map((name) => accept({ id: created.id, token: created.token, name, password: "member-password" })));
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 400]);
    expectBody(attempts.find((r) => r.status === 400)!, 400, INVALID);
    expect((await owner.get(`/members?query=${created.email}`)).body.data.total).toBe(1);
  });

  test("the link is checked first, then the name, then the password; a refusal does not use the link up", async () => {
    const created = await invite();
    const link = { id: created.id, token: created.token };
    for (const body of [{}, { id: created.id }, { token: created.token }, { id: 5, token: created.token }, { id: created.id, token: 5 }, { id: [created.id], token: created.token }, { id: created.id, token: null }, { id: UNKNOWN, token: created.token }, { id: created.id, token: "wrong" }, { id: created.id, token: `${created.token} ` }, { id: created.id, token: "x".repeat(201) }]) {
      expectBody(await accept({ name: "", password: "", ...body }), 400, INVALID);
    }
    const invalid: [Record<string, unknown>, string][] = [
      [{}, "name must be a string"],
      [{ name: null, password: "member-password" }, "name must be a string"],
      [{ name: 5, password: "member-password" }, "name must be a string"],
      [{ name: "", password: "" }, "name is required"],
      [{ name: "   ", password: "member-password" }, "name is required"],
      [{ name: "n".repeat(51), password: "member-password" }, "name must be at most 50 characters"],
      [{ name: "🎉".repeat(51), password: "member-password" }, "name must be at most 50 characters"],
      [{ name: "Fine" }, "password must be a string"],
      [{ name: "Fine", password: null }, "password must be a string"],
      [{ name: "Fine", password: "" }, "password is too short"],
      [{ name: "Fine", password: "1234567" }, "password is too short"],
      [{ name: "Fine", password: "🔑".repeat(7) }, "password is too short"],
      [{ name: "Fine", password: "p".repeat(71) }, "password must be at most 70 characters"],
      [{ name: "Fine", password: "密".repeat(71) }, "password must be at most 70 characters"],
    ];
    for (const [body, message] of invalid) {
      const res = await accept({ ...link, ...body });
      expectInvalid(res, message);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    // At the limits: 50 code points of name, 70 of password, kept as typed.
    const password = ` ${"🔑".repeat(68)} `;
    const res = await accept({ ...link, name: "🎉".repeat(50), password });
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe("🎉".repeat(50));
    expect((await t.client().post("/auth/login", { email: created.email, password })).status).toBe(200);
    expectError(await t.client().post("/auth/login", { email: created.email, password: password.trim() }), 401, "invalid_credentials", "Invalid email or password");
  });

  test("when the address was taken in the meantime, joining is refused and the invitation stays", async () => {
    const created = await invite(address("taken"));
    const { client: mover } = await t.addMember(owner, address("mover"));
    expect((await mover.post("/me/update", { email: created.email.toUpperCase(), currentPassword: "member-password" })).status).toBe(200);
    const res = await accept({ id: created.id, token: created.token, name: "Late", password: "member-password" });
    expectError(res, 409, "email_taken", "An account with this email already exists");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await pending()).some((i) => i.id === created.id)).toBe(true);
    expectBody(await info(created.id, created.token), 200, { data: { email: created.email, workspaceName: "Acme" } });
    expect((await owner.get(`/members?query=${created.email}`)).body.data.total).toBe(1);
  });

  test("the inviter is not mailed when they were deactivated or deleted since; the new member has no inviter then", async () => {
    const leaving = await t.addMember(owner, address("leaving"), "admin");
    const sleeping = await t.addMember(owner, address("sleeping"), "admin");
    const fromLeaving = await invite(address(), {}, leaving.client);
    const fromSleeping = await invite(address(), {}, sleeping.client);
    await owner.post("/members/delete", { userId: leaving.user.id });
    await owner.post("/members/deactivate", { userId: sleeping.user.id });
    expect((await pending()).find((i) => i.id === fromLeaving.id).invitedBy).toBeNull();
    expect((await pending()).find((i) => i.id === fromSleeping.id).invitedBy).toEqual({ id: sleeping.user.id, name: sleeping.user.name, avatarUrl: null });

    const first = await accept({ id: fromLeaving.id, token: fromLeaving.token, name: "First", password: "member-password" });
    const second = await accept({ id: fromSleeping.id, token: fromSleeping.token, name: "Second", password: "member-password" });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await rows(t.sql`SELECT invited_by FROM users WHERE id = ${first.body.data.user.id}`)).toEqual([{ invited_by: null }]);
    expect(await rows(t.sql`SELECT invited_by FROM users WHERE id = ${second.body.data.user.id}`)).toEqual([{ invited_by: sleeping.user.id }]);
    await flushMail(t, owner);
    for (const inviter of [leaving, sleeping]) {
      expect(mailsTo(t, inviter.user.email).filter((m) => m.subject.includes("accepted your invitation"))).toHaveLength(0);
    }
  });

  test("the mail to the inviter escapes the new member's name in its HTML part", async () => {
    const created = await invite(address("html"), {}, admin);
    const before = mailsTo(t, "admin@example.com").length;
    await accept({ id: created.id, token: created.token, name: '<i>"Al" & Co</i>', password: "member-password" });
    const mail = (await waitForMailsTo(t, "admin@example.com", before + 1))[before]!;
    expect(mail.subject).toBe('<i>"Al" & Co</i> accepted your invitation');
    expect(mail.text).toBe(`<i>"Al" & Co</i> (${created.email}) accepted your invitation and joined the workspace.\n\nOpen workspace: http://doc.test`);
    expect(mail.html).toBe(
      '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#222;line-height:1.5"><div style="max-width:560px;margin:0 auto;padding:24px">' +
        `<p style="margin:0 0 16px">&lt;i&gt;&quot;Al&quot; &amp; Co&lt;/i&gt; (${created.email}) accepted your invitation and joined the workspace.</p>` +
        '<p style="margin:24px 0"><a href="http://doc.test" style="background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open workspace</a></p>' +
        '<p style="color:#666;font-size:12px">http://doc.test</p></div></body></html>',
    );
  });

  test("is limited to 10 attempts a minute per address", async () => {
    const created = await invite();
    const client = t.client({ ip: "198.51.100.70" });
    for (let i = 0; i < 10; i++) expectBody(await accept({}, client), 400, INVALID);
    const res = await accept({ id: created.id, token: created.token, name: "Limited", password: "member-password" }, client);
    expectBody(res, 429, RATE_LIMITED);
    expectApiHeaders(res.headers);
    expect(res.headers.getSetCookie()).toEqual([]);
    // The link is untouched, and looking it up is counted on its own.
    expectBody(await info(created.id, created.token, client), 200, { data: { email: created.email, workspaceName: "Acme" } });
    expect((await accept({ id: created.id, token: created.token, name: "Limited", password: "member-password" }, t.client({ ip: "198.51.100.71" }))).status).toBe(200);
  });
});
