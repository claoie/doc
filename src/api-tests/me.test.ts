import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { startServer, type Client, type TestServer } from "./harness";
import {
  GIF,
  ISO,
  JPEG,
  PNG,
  UNAUTHORIZED,
  UUID,
  WEBP,
  expectApiHeaders,
  expectBody,
  expectError,
  expectInvalid,
  imageFile,
  imagePath,
  imageStored,
  rows,
  userShape,
} from "./harness/admin";

/* The current user: GET /me, POST /me/update, and the avatar. */

let t: TestServer;
let owner: Client;
let ownerUser: any;
let spaceId: string;
let serial = 0;

/** A new member with their own client, so tests do not share a profile. */
const newMember = async (role: "member" | "admin" = "member") => {
  const email = `me-${++serial}@example.com`;
  const { client, user } = await t.addMember(owner, email, role);
  return { client, user, email };
};

beforeAll(async () => {
  t = await startServer();
  ({ owner, user: ownerUser, spaceId } = await t.setupOwner());
});

afterAll(async () => {
  await t.close();
});

describe("GET /me", () => {
  test("answers the user with their preferences, and the workspace", async () => {
    const res = await owner.get("/me");
    expectBody(res, 200, {
      data: {
        user: {
          id: ownerUser.id,
          email: "owner@example.com",
          name: "Owner",
          avatarUrl: null,
          role: "owner",
          locale: null,
          timezone: null,
          preferences: {},
          createdAt: ownerUser.createdAt,
          lastLoginAt: expect.stringMatching(ISO),
        },
        workspace: { name: "Acme", description: null, logoUrl: null, emailDomains: [], settings: {}, defaultSpaceId: spaceId, createdAt: expect.stringMatching(ISO) },
      },
    });
    expectApiHeaders(res.headers);
    expect(res.body.data.user.id).toMatch(UUID);
    expect(res.body.data.user.createdAt).toMatch(ISO);
  });

  test("is the same for a member, with their role", async () => {
    const { client, user, email } = await newMember();
    const res = await client.get("/me");
    expect(res.body.data.user).toEqual(userShape({ id: user.id, email, name: email.split("@")[0], role: "member" }));
    expect(res.body.data.workspace).toEqual((await owner.get("/me")).body.data.workspace);
    const admin = await newMember("admin");
    expect((await admin.client.get("/me")).body.data.user.role).toBe("admin");
  });

  test("needs a session", async () => {
    expectBody(await t.client().get("/me"), 401, UNAUTHORIZED);
  });
});

describe("POST /me/update", () => {
  test("an empty body changes nothing and answers the user", async () => {
    const { client } = await newMember();
    const before = (await client.get("/me")).body.data.user;
    const res = await client.post("/me/update", {});
    expectBody(res, 200, { data: { user: before } });
    expectApiHeaders(res.headers);
    expectBody(await client.post("/me/update", { unknown: true, role: "owner", id: ownerUser.id, avatarUrl: "/x", createdAt: "2000-01-01" }), 200, { data: { user: before } });
  });

  describe("name", () => {
    test("is trimmed and takes any script; 50 code points are the most", async () => {
      const { client, user } = await newMember();
      const names = [
        "Zoë Ünïcödé",
        "é combining",
        "山田 太郎",
        "👩‍💻 dev 🎉",
        "مرحبا שלום",
        "x",
        "🎉".repeat(50),
        `${"名".repeat(49)}é`,
        'Tom & "Jerry" <b>',
        "line\nbreak",
      ];
      for (const name of names) {
        const res = await client.post("/me/update", { name: `  ${name}\t` });
        expect({ name, status: res.status, answered: res.body.data?.user.name }).toEqual({ name, status: 200, answered: name });
      }
      expect((await rows(t.sql`SELECT name FROM users WHERE id = ${user.id}`))[0].name).toBe("line\nbreak");
      expect((await client.get("/me")).body.data.user.name).toBe("line\nbreak");
    });

    test.each([
      ["null", null, "name must be a string"],
      ["a number", 7, "name must be a string"],
      ["a list", ["Ann"], "name must be a string"],
      ["empty", "", "name is required"],
      ["blank", " \n\t ", "name is required"],
      ["51 characters", "n".repeat(51), "name must be at most 50 characters"],
      ["51 emoji", "🎉".repeat(51), "name must be at most 50 characters"],
    ] as [string, unknown, string][])("a name that is %s is refused", async (_what, name, message) => {
      expectInvalid(await owner.post("/me/update", { name }), message);
      expect((await owner.get("/me")).body.data.user.name).toBe("Owner");
    });
  });

  describe("locale", () => {
    test("accepts language tags as written, and null or blank clears it", async () => {
      const { client } = await newMember();
      for (const locale of ["en", "EN", "fra", "en-US", "en-us", "zh-Hant-TW", "de-DE-1996", "sr-Latn-RS", "es-419", "ab-cdefgh12-xy"]) {
        const res = await client.post("/me/update", { locale });
        expect({ locale, status: res.status, answered: res.body.data?.user.locale }).toEqual({ locale, status: 200, answered: locale });
      }
      expect((await client.post("/me/update", { locale: "  pt-BR " })).body.data.user.locale).toBe("pt-BR");
      // Absent leaves it; null, empty and blank clear it.
      expect((await client.post("/me/update", { name: "Same" })).body.data.user.locale).toBe("pt-BR");
      for (const cleared of [null, "", "   "]) {
        await client.post("/me/update", { locale: "en" });
        expect((await client.post("/me/update", { locale: cleared })).body.data.user.locale).toBeNull();
      }
    });

    test("refuses what is no language tag", async () => {
      for (const locale of ["e", "english", "en_US", "en-", "-en", "en-u", "en-123456789", "en US", "e1", "日本", "en-US-", "en--US", "*"]) {
        const res = await owner.post("/me/update", { locale });
        expect({ locale, status: res.status, body: res.body as unknown }).toEqual({ locale, status: 400, body: { error: { code: "invalid_input", message: "Invalid locale" } } });
      }
      expectInvalid(await owner.post("/me/update", { locale: "en-" + "a".repeat(18) }), "locale must be at most 20 characters");
      expectInvalid(await owner.post("/me/update", { locale: 5 }), "locale must be a string");
      expectInvalid(await owner.post("/me/update", { locale: ["en"] }), "locale must be a string");
      expectInvalid(await owner.post("/me/update", { locale: false }), "locale must be a string");
      expect((await owner.get("/me")).body.data.user.locale).toBeNull();
    });
  });

  describe("timezone", () => {
    test("accepts IANA names in any case, UTC and numeric offsets, as written; null or blank clears it", async () => {
      const { client } = await newMember();
      const zones = [
        "Europe/Paris",
        "europe/paris",
        "EUROPE/PARIS",
        "America/Argentina/Buenos_Aires",
        "Asia/Kolkata",
        "Asia/Calcutta",
        "US/Pacific",
        "UTC",
        "utc",
        "GMT",
        "Etc/UTC",
        "Etc/GMT+5",
        "EST",
        "CET",
        "+05:30",
        "-08:00",
        "+0530",
        "+05",
        "+23:59",
        "+00:00",
        "-00:00",
      ];
      for (const timezone of zones) {
        const res = await client.post("/me/update", { timezone });
        expect({ timezone, status: res.status, answered: res.body.data?.user.timezone }).toEqual({ timezone, status: 200, answered: timezone });
      }
      expect((await client.post("/me/update", { timezone: "  Asia/Tokyo\n" })).body.data.user.timezone).toBe("Asia/Tokyo");
      expect((await client.post("/me/update", { locale: "en" })).body.data.user.timezone).toBe("Asia/Tokyo");
      for (const cleared of [null, "", "  "]) {
        await client.post("/me/update", { timezone: "UTC" });
        expect((await client.post("/me/update", { timezone: cleared })).body.data.user.timezone).toBeNull();
      }
    });

    test("refuses what is no time zone", async () => {
      for (const timezone of ["Mars/Olympus", "Europe/Pariss", "Paris", "Europe", "Europe/ Paris", "local", "Z", "0", "+5", "+24:00", "+05:30:00", "GMT+5", "UTC+5", "UTC+05:30", "−05:00", "Europe/Paris;DROP"]) {
        const res = await owner.post("/me/update", { timezone });
        expect({ timezone, status: res.status, body: res.body as unknown }).toEqual({ timezone, status: 400, body: { error: { code: "invalid_input", message: "Invalid timezone" } } });
      }
      expectInvalid(await owner.post("/me/update", { timezone: "A".repeat(65) }), "timezone must be at most 64 characters");
      expectInvalid(await owner.post("/me/update", { timezone: "A".repeat(64) }), "Invalid timezone");
      expectInvalid(await owner.post("/me/update", { timezone: 1 }), "timezone must be a string");
      expectInvalid(await owner.post("/me/update", { timezone: { name: "UTC" } }), "timezone must be a string");
      expect((await owner.get("/me")).body.data.user.timezone).toBeNull();
    });
  });

  describe("preferences", () => {
    test("every key takes its values, and keys are merged into what is there", async () => {
      const { client } = await newMember();
      const steps: [Record<string, unknown>, Record<string, unknown>][] = [
        [{ fullPageWidth: true }, { fullPageWidth: true }],
        [{ editorToolbar: false }, { fullPageWidth: true, editorToolbar: false }],
        [{ pageEditMode: "read" }, { fullPageWidth: true, editorToolbar: false, pageEditMode: "read" }],
        [{ pageEditMode: "edit", theme: "dark" }, { fullPageWidth: true, editorToolbar: false, pageEditMode: "edit", theme: "dark" }],
        [
          { notifyPageUpdates: false, notifyPageMentions: true, notifyCommentMentions: false, notifyComments: true },
          { fullPageWidth: true, editorToolbar: false, pageEditMode: "edit", theme: "dark", notifyPageUpdates: false, notifyPageMentions: true, notifyCommentMentions: false, notifyComments: true },
        ],
        [{ fullPageWidth: false, theme: "light" }, { fullPageWidth: false, editorToolbar: false, pageEditMode: "edit", theme: "light", notifyPageUpdates: false, notifyPageMentions: true, notifyCommentMentions: false, notifyComments: true }],
        [{}, { fullPageWidth: false, editorToolbar: false, pageEditMode: "edit", theme: "light", notifyPageUpdates: false, notifyPageMentions: true, notifyCommentMentions: false, notifyComments: true }],
      ];
      for (const [preferences, expected] of steps) {
        const res = await client.post("/me/update", { preferences });
        expect(res.status).toBe(200);
        expect(res.body.data.user.preferences).toEqual(expected);
      }
      expect((await client.get("/me")).body.data.user.preferences).toEqual(steps[steps.length - 1]![1]);
      // Without the field they stay as they are.
      expect((await client.post("/me/update", { name: "Still" })).body.data.user.preferences).toEqual(steps[steps.length - 1]![1]);
    });

    test("null removes a key; unknown keys are dropped", async () => {
      const { client, user } = await newMember();
      await client.post("/me/update", { preferences: { fullPageWidth: true, editorToolbar: true, pageEditMode: "read", theme: "system", notifyComments: false } });
      const res = await client.post("/me/update", { preferences: { fullPageWidth: null, pageEditMode: null, theme: null, notifyPageUpdates: null, unknown: "x", THEME: "dark", nested: { a: 1 } } });
      expect(res.body.data.user.preferences).toEqual({ editorToolbar: true, notifyComments: false });
      expect((await rows(t.sql`SELECT preferences FROM users WHERE id = ${user.id}`))[0].preferences).toEqual({ editorToolbar: true, notifyComments: false });
      const cleared = await client.post("/me/update", { preferences: { editorToolbar: null, notifyComments: null } });
      expect(cleared.body.data.user.preferences).toEqual({});
    });

    test("a theme is any lower-case word of up to 20 letters and hyphens", async () => {
      const { client } = await newMember();
      for (const theme of ["light", "dark", "system", "solarized-dark", "a", "-", "abcdefghijklmnopqrst"]) {
        const res = await client.post("/me/update", { preferences: { theme } });
        expect({ theme, status: res.status, answered: res.body.data?.user.preferences.theme }).toEqual({ theme, status: 200, answered: theme });
      }
      for (const theme of ["Dark", "DARK", "dark mode", "dark_mode", "dark1", "", "abcdefghijklmnopqrstu", "é", 1, true, ["dark"], { name: "dark" }]) {
        expectInvalid(await client.post("/me/update", { preferences: { theme } }), "preferences.theme is invalid");
      }
      expect((await client.get("/me")).body.data.user.preferences).toEqual({ theme: "abcdefghijklmnopqrst" });
    });

    test.each(["fullPageWidth", "editorToolbar", "notifyPageUpdates", "notifyPageMentions", "notifyCommentMentions", "notifyComments"])("%s must be a boolean", async (key) => {
      for (const value of ["true", "false", 1, 0, "", [], {}]) {
        expectInvalid(await owner.post("/me/update", { preferences: { [key]: value } }), `preferences.${key} must be a boolean`);
      }
    });

    test("pageEditMode must be read or edit", async () => {
      for (const value of ["Read", "EDIT", "view", "", 1, true, ["read"]]) {
        expectInvalid(await owner.post("/me/update", { preferences: { pageEditMode: value } }), "preferences.pageEditMode must be read or edit");
      }
    });

    test("preferences must be an object", async () => {
      for (const preferences of [null, [], [{ theme: "dark" }], "dark", 1, true]) {
        expectInvalid(await owner.post("/me/update", { preferences }), "preferences must be an object");
      }
      expect((await owner.get("/me")).body.data.user.preferences).toEqual({});
    });

    test("one invalid key refuses the whole update, the other fields included", async () => {
      const { client, user } = await newMember();
      const before = (await client.get("/me")).body.data.user;
      expectInvalid(await client.post("/me/update", { name: "Changed", locale: "fr", timezone: "UTC", preferences: { theme: "dark", fullPageWidth: "yes" } }), "preferences.fullPageWidth must be a boolean");
      expect((await client.get("/me")).body.data.user).toEqual(before);
      expect(user.id).toBe(before.id);
    });

    test("other people see none of them", async () => {
      const { client, user } = await newMember();
      await client.post("/me/update", { preferences: { theme: "dark", fullPageWidth: true } });
      const listed = (await owner.get("/members?limit=500")).body.data.items.find((m: any) => m.id === user.id);
      expect(listed.preferences).toEqual({});
      const own = (await client.get("/members?limit=500")).body.data.items.find((m: any) => m.id === user.id);
      expect(own.preferences).toEqual({ theme: "dark", fullPageWidth: true });
    });
  });

  test("fields are checked in a fixed order: types first, then locale, time zone, preferences, email", async () => {
    const all = { name: "", email: "", locale: 1, timezone: 1, preferences: 1 };
    expectInvalid(await owner.post("/me/update", all), "name is required");
    expectInvalid(await owner.post("/me/update", { ...all, name: "A" }), "email is too short");
    expectInvalid(await owner.post("/me/update", { ...all, name: "A", email: "nope" }), "locale must be a string");
    expectInvalid(await owner.post("/me/update", { ...all, name: "A", email: "nope", locale: "xx_" }), "timezone must be a string");
    expectInvalid(await owner.post("/me/update", { ...all, name: "A", email: "nope", locale: "xx_", timezone: "Nope" }), "preferences must be an object");
    expectInvalid(await owner.post("/me/update", { name: "A", email: "nope", locale: "xx_", timezone: "Nope", preferences: { theme: 1 } }), "Invalid locale");
    expectInvalid(await owner.post("/me/update", { name: "A", email: "nope", locale: "en", timezone: "Nope", preferences: { theme: 1 } }), "Invalid timezone");
    expectInvalid(await owner.post("/me/update", { name: "A", email: "nope", locale: "en", timezone: "UTC", preferences: { theme: 1 } }), "preferences.theme is invalid");
    expectInvalid(await owner.post("/me/update", { name: "A", email: "nope", locale: "en", timezone: "UTC", preferences: {} }), "Invalid email address");
    expect((await owner.get("/me")).body.data.user).toEqual(userShape({ id: ownerUser.id, email: "owner@example.com", name: "Owner", role: "owner" }));
  });

  test("every field at once", async () => {
    const { client, user } = await newMember();
    const res = await client.post("/me/update", {
      name: " Everything ",
      email: " All.At.Once@Example.COM ",
      currentPassword: "member-password",
      locale: "nl-NL",
      timezone: "Europe/Amsterdam",
      preferences: { theme: "dark", notifyComments: false },
    });
    expectBody(res, 200, {
      data: {
        user: userShape({
          id: user.id,
          email: "all.at.once@example.com",
          name: "Everything",
          locale: "nl-NL",
          timezone: "Europe/Amsterdam",
          preferences: { theme: "dark", notifyComments: false },
        }),
      },
    });
    expect((await client.get("/me")).body.data.user).toEqual(res.body.data.user);
  });

  describe("email", () => {
    const WRONG = { error: { code: "invalid_password", message: "Current password is incorrect" } };

    test("changes with the current password; it is lower-cased, the session stays and the new address signs in", async () => {
      const { client, email } = await newMember();
      const res = await client.post("/me/update", { email: "  New.Address+Tag@Example.COM ", currentPassword: "member-password" });
      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe("new.address+tag@example.com");
      expect(res.headers.getSetCookie()).toEqual([]);
      expect((await client.get("/me")).body.data.user.email).toBe("new.address+tag@example.com");
      expect((await t.client().post("/auth/login", { email: "new.address+tag@example.com", password: "member-password" })).status).toBe(200);
      expectError(await t.client().post("/auth/login", { email, password: "member-password" }), 401, "invalid_credentials", "Invalid email or password");
    });

    test("without the current password, or with a wrong one, it is refused", async () => {
      const { client, email } = await newMember();
      for (const extra of [{}, { currentPassword: "wrong-password" }, { currentPassword: " member-password" }, { currentPassword: "member-password " }, { password: "member-password" }]) {
        expectBody(await client.post("/me/update", { email: "elsewhere@example.com", name: "Changed", ...extra }), 400, WRONG);
      }
      expectInvalid(await client.post("/me/update", { email: "elsewhere@example.com", currentPassword: "" }), "currentPassword is required");
      expectInvalid(await client.post("/me/update", { email: "elsewhere@example.com", currentPassword: null }), "currentPassword must be a string");
      expectInvalid(await client.post("/me/update", { email: "elsewhere@example.com", currentPassword: 5 }), "currentPassword must be a string");
      expectInvalid(await client.post("/me/update", { email: "elsewhere@example.com", currentPassword: "p".repeat(201) }), "currentPassword must be at most 200 characters");
      const me = (await client.get("/me")).body.data.user;
      expect({ email: me.email, name: me.name }).toEqual({ email, name: email.split("@")[0] });
    });

    test("the address they already have needs no password, in any case; the password field is then not looked at", async () => {
      const { client, email } = await newMember();
      for (const body of [{ email }, { email: email.toUpperCase() }, { email: `  ${email}  ` }, { email, currentPassword: "wrong-password" }, { email, currentPassword: 5 }]) {
        const res = await client.post("/me/update", body);
        expect(res.status).toBe(200);
        expect(res.body.data.user.email).toBe(email);
      }
      // A current password without an email is ignored as well.
      expect((await client.post("/me/update", { currentPassword: "wrong-password", name: "Fine" })).status).toBe(200);
    });

    test("an account without a password cannot change its address", async () => {
      const { client, user } = await newMember();
      await t.sql`UPDATE users SET password_hash = NULL WHERE id = ${user.id}`;
      expectBody(await client.post("/me/update", { email: "elsewhere@example.com", currentPassword: "member-password" }), 400, WRONG);
      expectBody(await client.post("/me/update", { email: "elsewhere@example.com" }), 400, WRONG);
    });

    test.each([
      ["null", null, "email must be a string"],
      ["a number", 5, "email must be a string"],
      ["empty", "", "email is too short"],
      ["two characters", "a@", "email is too short"],
      ["255 characters", `${"a".repeat(243)}@example.com`, "email must be at most 254 characters"],
      ["without @", "owner.example.com", "Invalid email address"],
      ["without a dot in the domain", "owner@example", "Invalid email address"],
      ["with a space", "the owner@example.com", "Invalid email address"],
      ["with two @", "a@b@example.com", "Invalid email address"],
      ["with a display name", "Owner <owner@example.com>", "Invalid email address"],
    ] as [string, unknown, string][])("an address that is %s is refused", async (_what, email, message) => {
      expectInvalid(await owner.post("/me/update", { email, currentPassword: "owner-password" }), message);
    });

    test("an address of 254 characters is accepted", async () => {
      const { client } = await newMember();
      const email = `${"a".repeat(242)}@example.com`;
      expect(email.length).toBe(254);
      expect((await client.post("/me/update", { email, currentPassword: "member-password" })).body.data.user.email).toBe(email);
    });

    test("an address someone else has is refused, in any case, even when they are deactivated", async () => {
      const { client } = await newMember();
      const other = await newMember();
      const taken = { error: { code: "email_taken", message: "That email is already in use" } };
      expectBody(await client.post("/me/update", { email: other.email, currentPassword: "member-password" }), 409, taken);
      expectBody(await client.post("/me/update", { email: other.email.toUpperCase(), currentPassword: "member-password" }), 409, taken);
      expectBody(await client.post("/me/update", { email: "OWNER@example.com", currentPassword: "member-password" }), 409, taken);
      await owner.post("/members/deactivate", { userId: other.user.id });
      expectBody(await client.post("/me/update", { email: other.email, currentPassword: "member-password" }), 409, taken);
      // The password is checked first.
      expectBody(await client.post("/me/update", { email: other.email, currentPassword: "wrong-password" }), 400, WRONG);
      // An address that only has an invitation pending is free.
      await owner.post("/invitations", { emails: ["pending-for-me@example.com"] });
      expect((await client.post("/me/update", { email: "pending-for-me@example.com", currentPassword: "member-password" })).status).toBe(200);
    });
  });
});

describe("POST /me/update with allowed email domains (builds on one workspace setting; restored at the end)", () => {
  let member: Client;
  let admin: Client;

  beforeAll(async () => {
    ({ client: member } = await newMember());
    ({ client: admin } = await newMember("admin"));
    expectBody(await owner.post("/workspace/update", { emailDomains: ["allowed.example", "also.example"] }), 200, expect.anything());
  });

  afterAll(async () => {
    await owner.post("/workspace/update", { emailDomains: [] });
  });

  test("a member may only move to an allowed domain", async () => {
    const message = "Only allowed.example, also.example addresses are allowed in this workspace";
    expectInvalid(await member.post("/me/update", { email: "me@outside.example", currentPassword: "member-password" }), message);
    expectInvalid(await member.post("/me/update", { email: "me@sub.allowed.example", currentPassword: "member-password" }), message);
    expectInvalid(await member.post("/me/update", { email: "me@allowed.example.evil.example", currentPassword: "member-password" }), message);
    // The password comes first, the domain before whether the address is taken.
    expectError(await member.post("/me/update", { email: "me@outside.example", currentPassword: "wrong-password" }), 400, "invalid_password", "Current password is incorrect");
    expectInvalid(await member.post("/me/update", { email: "owner@example.com", currentPassword: "member-password" }), message);
    expect((await member.post("/me/update", { email: "Me@ALSO.example", currentPassword: "member-password" })).body.data.user.email).toBe("me@also.example");
    expect((await member.post("/me/update", { email: "me@allowed.example", currentPassword: "member-password" })).body.data.user.email).toBe("me@allowed.example");
  });

  test("their present address needs no allowed domain: nothing changes", async () => {
    const { client, email } = await newMemberOutside();
    expect((await client.post("/me/update", { email, name: "Kept" })).status).toBe(200);
  });

  test("admins and owners may use any domain", async () => {
    expect((await admin.post("/me/update", { email: "admin@outside.example", currentPassword: "member-password" })).body.data.user.email).toBe("admin@outside.example");
    const res = await owner.post("/me/update", { email: "owner@outside.example", currentPassword: "owner-password" });
    expect(res.body.data.user.email).toBe("owner@outside.example");
    expect((await owner.post("/me/update", { email: "owner@example.com", currentPassword: "owner-password" })).body.data.user.email).toBe("owner@example.com");
  });

  /** A member whose address is outside the allowed domains: invited before the restriction was set. */
  const newMemberOutside = async () => {
    await owner.post("/workspace/update", { emailDomains: [] });
    const created = await newMember();
    await owner.post("/workspace/update", { emailDomains: ["allowed.example", "also.example"] });
    return created;
  };
});

describe("POST /me/avatar", () => {
  const cases: [string, Uint8Array, string, string][] = [
    ["PNG", PNG, "png", "image/png"],
    ["JPEG", JPEG, "jpg", "image/jpeg"],
    ["GIF89a", GIF, "gif", "image/gif"],
    ["GIF87a", new TextEncoder().encode("GIF87a\u0001\u0000\u0001\u0000"), "gif", "image/gif"],
    ["WebP", WEBP, "webp", "image/webp"],
  ];

  test.each(cases)("stores a %s by its first bytes, whatever its name and declared type", async (_kind, bytes, ext, mime) => {
    const { client, user } = await newMember();
    const res = await client.upload("/me/avatar", { file: imageFile(bytes, "photo.txt", "text/plain") });
    expect(res.status).toBe(200);
    const url: string = res.body.data.user.avatarUrl;
    expect(url).toMatch(new RegExp(`^/api/images/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.${ext}$`));
    expectBody(res, 200, { data: { user: userShape({ id: user.id, avatarUrl: url }) } });
    expectApiHeaders(res.headers);

    const name = url.split("/").pop()!;
    expect([...readFileSync(imagePath(t, url))]).toEqual([...bytes]);
    expect(await rows(t.sql`SELECT purpose, page_id, space_id, uploader_id, name, mime, size::int AS size, storage_key FROM files WHERE uploader_id = ${user.id}`)).toEqual([
      { purpose: "avatar", page_id: null, space_id: null, uploader_id: user.id, name, mime, size: bytes.length, storage_key: `images/${name}` },
    ]);

    // Anyone can fetch it, signed in or not.
    const image = await t.client().fetch(url);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe(mime);
    expect(image.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("etag")).toBe(`"${name}"`);
    expect(image.headers.get("content-disposition")).toBe(`inline; filename="${name}"; filename*=UTF-8''${name}`);
    expect(image.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
    expect(image.headers.get("accept-ranges")).toBe("bytes");
    expect(image.headers.get("content-length")).toBe(String(bytes.length));
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([...bytes]);
    expect((await client.get("/me")).body.data.user.avatarUrl).toBe(url);
  });

  test("refuses what does not start like an image, and keeps the avatar there was", async () => {
    const { client, user } = await newMember();
    const kept = (await client.upload("/me/avatar", { file: imageFile(PNG, "a.png", "image/png") })).body.data.user.avatarUrl;
    const text = (value: string) => new TextEncoder().encode(value);
    const rejected: [string, Uint8Array][] = [
      ["nothing", new Uint8Array(0)],
      ["an SVG", text('<svg xmlns="http://www.w3.org/2000/svg"/>')],
      ["HTML", text("<!doctype html><script>alert(1)</script>")],
      ["a BMP", text("BM6\u0000\u0000\u0000\u0000\u0000")],
      ["a PDF", text("%PDF-1.7")],
      ["a WAV, which is RIFF but not WebP", text("RIFF$\u0000\u0000\u0000WAVEfmt ")],
      ["RIFF cut short", text("RIFF$\u0000\u0000\u0000WEB")],
      ["three bytes of a PNG", PNG.subarray(0, 3)],
      ["two bytes of a JPEG", JPEG.subarray(0, 2)],
      ["GIF7", text("GIF7")],
      ["gif8 in lower case", text("gif89a")],
      ["a PNG after one other byte", new Uint8Array([0x00, ...PNG])],
    ];
    for (const [what, bytes] of rejected) {
      const res = await client.upload("/me/avatar", { file: imageFile(bytes, "a.png", "image/png") });
      expect({ what, status: res.status, body: res.body as unknown }).toEqual({ what, status: 400, body: { error: { code: "invalid_input", message: "Images must be PNG, JPEG, WebP or GIF" } } });
    }
    expect((await client.get("/me")).body.data.user.avatarUrl).toBe(kept);
    expect(imageStored(t, kept)).toBe(true);
    expect(await rows(t.sql`SELECT count(*)::int AS n FROM files WHERE uploader_id = ${user.id}`)).toEqual([{ n: 1 }]);
  });

  test("a new avatar replaces the old one, whose file and record are removed", async () => {
    const { client, user } = await newMember();
    const first = (await client.upload("/me/avatar", { file: imageFile(PNG) })).body.data.user.avatarUrl;
    const second = (await client.upload("/me/avatar", { file: imageFile(JPEG) })).body.data.user.avatarUrl;
    expect(second).not.toBe(first);
    expect(second).toMatch(/\.jpg$/);
    expect(imageStored(t, first)).toBe(false);
    expect(imageStored(t, second)).toBe(true);
    expect(await rows(t.sql`SELECT name FROM files WHERE uploader_id = ${user.id}`)).toEqual([{ name: second.split("/").pop() }]);
    expectError(await t.client().get(first.slice("/api".length)), 404, "not_found", "Image not found");
    expect((await t.client().fetch(second)).status).toBe(200);
  });

  test("everyone sees the avatar in the member list", async () => {
    const { client, user } = await newMember();
    const url = (await client.upload("/me/avatar", { file: imageFile(GIF) })).body.data.user.avatarUrl;
    const listed = (await owner.get("/members?limit=500")).body.data.items.find((m: any) => m.id === user.id);
    expect(listed.avatarUrl).toBe(url);
  });

  test("needs a session", async () => {
    expectBody(await t.client().upload("/me/avatar", { file: imageFile(PNG) }), 401, UNAUTHORIZED);
  });
});

describe("POST /me/avatar/remove", () => {
  test("removes the avatar with its file and record, and is fine when there is none", async () => {
    const { client, user } = await newMember();
    const url = (await client.upload("/me/avatar", { file: imageFile(WEBP) })).body.data.user.avatarUrl;
    const res = await client.post("/me/avatar/remove");
    expectBody(res, 200, { data: { user: userShape({ id: user.id, avatarUrl: null }) } });
    expectApiHeaders(res.headers);
    expect(imageStored(t, url)).toBe(false);
    expect(await rows(t.sql`SELECT 1 AS n FROM files WHERE uploader_id = ${user.id}`)).toEqual([]);
    expectError(await t.client().get(url.slice("/api".length)), 404, "not_found", "Image not found");
    expectBody(await client.post("/me/avatar/remove"), 200, { data: { user: userShape({ id: user.id, avatarUrl: null }) } });
  });

  test("needs a session", async () => {
    expectBody(await t.client().post("/me/avatar/remove"), 401, UNAUTHORIZED);
  });
});

describe("GET /images/:name for what these endpoints store", () => {
  test("only names of stored images are served: a UUID in lower case and one of the four extensions", async () => {
    const { client } = await newMember();
    const url: string = (await client.upload("/me/avatar", { file: imageFile(PNG) })).body.data.user.avatarUrl;
    const name = url.split("/").pop()!;
    const id = name.slice(0, 36);
    for (const other of [name.toUpperCase(), `${id}.PNG`, `${id}.jpg`, `${id}.svg`, `${id}.jpeg`, id, `${id}.png.png`, `x${name}`, `..%2F${name}`, "nope.png", "%00.png"]) {
      const res = await t.client().get(`/images/${other}`);
      expect({ other, status: res.status, body: res.body as unknown }).toEqual({ other, status: 404, body: { error: { code: "not_found", message: "Image not found" } } });
    }
    expect((await t.client().fetch(`/api/images/${name}`)).status).toBe(200);
  });
});
