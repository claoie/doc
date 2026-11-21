import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { startServer, type ApiResponse, type Client, type TestServer } from "./harness";
import {
  GIF,
  ISO,
  JPEG,
  NOT_ADMIN,
  PNG,
  UNAUTHORIZED,
  WEBP,
  expectApiHeaders,
  expectBody,
  expectError,
  expectInvalid,
  imageFile,
  imagePath,
  imageStored,
  rows,
} from "./harness/admin";

/* The workspace: its public face, its settings and its logo. */

let t: TestServer;
let owner: Client;
let ownerUser: any;
let admin: Client;
let member: Client;
let spaceId: string;
let publicBeforeSetup: ApiResponse;

beforeAll(async () => {
  t = await startServer();
  publicBeforeSetup = await t.client().get("/workspace/public");
  ({ owner, user: ownerUser, spaceId } = await t.setupOwner());
  ({ client: admin } = await t.addMember(owner, "admin@example.com", "admin"));
  ({ client: member } = await t.addMember(owner, "member@example.com"));
});

afterAll(async () => {
  await t.close();
});

const workspace = async (client: Client = owner) => (await client.get("/me")).body.data.workspace;
const update = (body: unknown, client: Client = owner) => client.post("/workspace/update", body);

describe("GET /workspace/public", () => {
  test("before setup there is no name and no logo", () => {
    expectBody(publicBeforeSetup, 200, { data: { name: "", logoUrl: null } });
    expectApiHeaders(publicBeforeSetup.headers);
  });

  test("answers the name and the logo to anyone, and nothing else", async () => {
    const res = await t.client().get("/workspace/public");
    expectBody(res, 200, { data: { name: "Acme", logoUrl: null } });
    expectApiHeaders(res.headers);
    expectBody(await member.get("/workspace/public"), 200, { data: { name: "Acme", logoUrl: null } });
  });
});

describe("POST /workspace/update", () => {
  test("an empty body changes nothing and answers the workspace", async () => {
    const res = await update({});
    expectBody(res, 200, {
      data: { workspace: { name: "Acme", description: null, logoUrl: null, emailDomains: [], settings: {}, defaultSpaceId: spaceId, createdAt: expect.stringMatching(ISO) } },
    });
    expectApiHeaders(res.headers);
    expectBody(await update({ unknown: 1, defaultSpaceId: null, logoUrl: "/x", createdAt: "2000-01-01T00:00:00.000Z" }), 200, res.body);
  });

  test("owners and admins may; members may not, whatever they send", async () => {
    expect((await update({}, admin)).status).toBe(200);
    for (const body of [{}, { name: "Mine" }, { name: "" }, { settings: 5 }]) {
      const res = await update(body, member);
      expectBody(res, 403, NOT_ADMIN);
      expectApiHeaders(res.headers);
    }
    expectBody(await member.raw("POST", "/workspace/update", { body: "not json", headers: { "Content-Type": "text/plain" } }).then(async (r) => ({ status: r.status, body: await r.json() })), 403, NOT_ADMIN);
    expectBody(await update({ name: "X" }, t.client()), 401, UNAUTHORIZED);
    expect((await workspace()).name).toBe("Acme");
  });

  describe("name", () => {
    test("is trimmed, takes any script and up to 100 code points", async () => {
      for (const name of ["Ünïcode Wörks", "株式会社 ドキュメント", "🏢 HQ 🎉", "مساحة العمل", 'R&D <"Lab">', "x", "🏢".repeat(100)]) {
        const res = await update({ name: `  ${name}\n` });
        expect({ name, status: res.status, answered: res.body.data?.workspace.name }).toEqual({ name, status: 200, answered: name });
        expectBody(await t.client().get("/workspace/public"), 200, { data: { name, logoUrl: null } });
      }
      expect((await update({ name: "Acme" }, admin)).body.data.workspace.name).toBe("Acme");
    });

    test.each([
      ["null", null, "name must be a string"],
      ["a number", 1, "name must be a string"],
      ["a list", ["Acme"], "name must be a string"],
      ["empty", "", "name is required"],
      ["blank", "  \t ", "name is required"],
      ["101 characters", "w".repeat(101), "name must be at most 100 characters"],
      ["101 emoji", "🏢".repeat(101), "name must be at most 100 characters"],
    ] as [string, unknown, string][])("a name that is %s is refused", async (_what, name, message) => {
      expectInvalid(await update({ name }), message);
      expect((await workspace()).name).toBe("Acme");
    });
  });

  describe("description", () => {
    test("is trimmed and kept; null, empty or blank clears it; absent leaves it", async () => {
      for (const description of ["What we write down", "Ünïcode 日本語 🎉 مرحبا", "two\nlines", "d".repeat(500), "🎉".repeat(500)]) {
        expect((await update({ description: ` ${description}  ` })).body.data.workspace.description).toBe(description);
      }
      expect((await update({ name: "Acme" })).body.data.workspace.description).toBe("🎉".repeat(500));
      for (const cleared of [null, "", "   \n"]) {
        await update({ description: "Something" });
        expect((await update({ description: cleared })).body.data.workspace.description).toBeNull();
      }
    });

    test("must be a string of at most 500 characters", async () => {
      expectInvalid(await update({ description: 5 }), "description must be a string");
      expectInvalid(await update({ description: ["x"] }), "description must be a string");
      expectInvalid(await update({ description: false }), "description must be a string");
      expectInvalid(await update({ description: "d".repeat(501) }), "description must be at most 500 characters");
      expectInvalid(await update({ description: "🎉".repeat(501) }), "description must be at most 500 characters");
      expect((await workspace()).description).toBeNull();
    });
  });

  describe("emailDomains", () => {
    afterAll(async () => {
      await update({ emailDomains: [] });
    });

    test("are lower-cased, lose a leading @ and their duplicates, and keep their order", async () => {
      const res = await update({ emailDomains: ["Example.COM", "@acme.io", "  sub.example.co.uk ", "example.com", "@EXAMPLE.com", "xn--bcher-kva.example", "1st.example", "a-b.example"] });
      expect(res.status).toBe(200);
      expect(res.body.data.workspace.emailDomains).toEqual(["example.com", "acme.io", "sub.example.co.uk", "xn--bcher-kva.example", "1st.example", "a-b.example"]);
      expect((await rows(t.sql`SELECT email_domains FROM workspace`))[0].email_domains).toEqual(["example.com", "acme.io", "sub.example.co.uk", "xn--bcher-kva.example", "1st.example", "a-b.example"]);
      expect((await workspace(member)).emailDomains).toEqual(res.body.data.workspace.emailDomains);
    });

    test("absent leaves them, a new list replaces them and an empty list clears them", async () => {
      await update({ emailDomains: ["one.example", "two.example"] });
      expect((await update({ name: "Acme" })).body.data.workspace.emailDomains).toEqual(["one.example", "two.example"]);
      expect((await update({ emailDomains: ["three.example"] })).body.data.workspace.emailDomains).toEqual(["three.example"]);
      expect((await update({ emailDomains: [] })).body.data.workspace.emailDomains).toEqual([]);
    });

    test("the longest names pass: 63-character labels, 253 characters in all, 50 domains", async () => {
      const label = "a".repeat(63);
      const longest = `${label}.${label}.${label}.${"b".repeat(61)}`;
      expect(longest.length).toBe(253);
      expect((await update({ emailDomains: [longest] })).body.data.workspace.emailDomains).toEqual([longest]);
      const fifty = Array.from({ length: 50 }, (_, i) => `d${i}.example`);
      expect((await update({ emailDomains: fifty })).body.data.workspace.emailDomains).toEqual(fifty);
      await update({ emailDomains: ["kept.example"] });
    });

    test("what is no domain name is refused", async () => {
      const invalid = [
        "example",
        "localhost",
        "example.c",
        "example.c0m",
        "example.123",
        "-example.com",
        "example-.com",
        "exa mple.com",
        "exa_mple.com",
        "example..com",
        ".example.com",
        "example.com.",
        "user@example.com",
        "@@example.com",
        "@",
        "*.example.com",
        "例え.jp",
        "exämple.com",
        "http://example.com",
        "example.com/path",
        `${"a".repeat(64)}.com`,
        `example.${"a".repeat(64)}`,
      ];
      for (const domain of invalid) {
        const res = await update({ emailDomains: ["fine.example", domain] });
        expect({ domain, status: res.status, body: res.body as unknown }).toEqual({ domain, status: 400, body: { error: { code: "invalid_input", message: "emailDomains must contain valid domain names" } } });
      }
      expect((await workspace()).emailDomains).toEqual(["kept.example"]);
    });

    test("the list and its items are checked for type and size first", async () => {
      const list = "emailDomains must be a list of at most 50 items";
      for (const emailDomains of [null, "example.com", 5, { 0: "example.com" }, Array.from({ length: 51 }, (_, i) => `d${i}.example`)]) {
        expectInvalid(await update({ emailDomains }), list);
      }
      expectInvalid(await update({ emailDomains: ["example.com", 5] }), "emailDomains must be a string");
      expectInvalid(await update({ emailDomains: [null] }), "emailDomains must be a string");
      expectInvalid(await update({ emailDomains: [["example.com"]] }), "emailDomains must be a string");
      expectInvalid(await update({ emailDomains: ["example.com", ""] }), "emailDomains is required");
      expectInvalid(await update({ emailDomains: ["   "] }), "emailDomains is required");
      expectInvalid(await update({ emailDomains: [`${"a".repeat(250)}.com`] }), "emailDomains must be at most 253 characters");
      expect((await workspace()).emailDomains).toEqual(["kept.example"]);
    });
  });

  describe("settings", () => {
    test("each key takes its values; keys are merged into what is there and unknown ones dropped", async () => {
      const steps: [Record<string, unknown>, Record<string, unknown>][] = [
        [{ sharingDisabled: true }, { sharingDisabled: true }],
        [{ trashRetentionDays: 1 }, { sharingDisabled: true, trashRetentionDays: 1 }],
        [{ defaultPageEditMode: "read" }, { sharingDisabled: true, trashRetentionDays: 1, defaultPageEditMode: "read" }],
        [{ trashRetentionDays: 3650, defaultPageEditMode: "edit" }, { sharingDisabled: true, trashRetentionDays: 3650, defaultPageEditMode: "edit" }],
        [{ sharingDisabled: false, unknown: "x", nested: { a: 1 } }, { sharingDisabled: false, trashRetentionDays: 3650, defaultPageEditMode: "edit" }],
        [{}, { sharingDisabled: false, trashRetentionDays: 3650, defaultPageEditMode: "edit" }],
      ];
      for (const [settings, expected] of steps) {
        const res = await update({ settings });
        expect(res.status).toBe(200);
        expect(res.body.data.workspace.settings).toEqual(expected);
      }
      // Absent leaves them, and members read them with the workspace.
      expect((await update({ name: "Acme" })).body.data.workspace.settings).toEqual(steps[steps.length - 1]![1]);
      expect((await workspace(member)).settings).toEqual(steps[steps.length - 1]![1]);
      expect((await rows(t.sql`SELECT settings FROM workspace`))[0].settings).toEqual(steps[steps.length - 1]![1]);
    });

    test("a number written as 30.0 or 1e2 is an integer", async () => {
      const post = (text: string) => owner.raw("POST", "/workspace/update", { body: text, headers: { "Content-Type": "application/json" } }).then((r) => r.json());
      expect((await post('{"settings":{"trashRetentionDays":30.0}}')).data.workspace.settings.trashRetentionDays).toBe(30);
      expect((await post('{"settings":{"trashRetentionDays":1e2}}')).data.workspace.settings.trashRetentionDays).toBe(100);
    });

    test("invalid values are refused, null included: a key cannot be removed", async () => {
      const before = (await workspace()).settings;
      for (const value of [null, "true", 1, 0, "", []]) {
        expectInvalid(await update({ settings: { sharingDisabled: value } }), "settings.sharingDisabled must be a boolean");
      }
      for (const value of [null, 0, -1, 3651, 1.5, "30", true, [30], 1e21]) {
        expectInvalid(await update({ settings: { trashRetentionDays: value } }), "settings.trashRetentionDays must be an integer between 1 and 3650");
      }
      for (const value of [null, "Read", "EDIT", "view", "", 1, true]) {
        expectInvalid(await update({ settings: { defaultPageEditMode: value } }), "settings.defaultPageEditMode must be read or edit");
      }
      for (const settings of [null, [], "x", 1, true]) {
        expectInvalid(await update({ settings }), "settings must be an object");
      }
      expect((await workspace()).settings).toEqual(before);
    });

    test("keys are checked in the order sharingDisabled, trashRetentionDays, defaultPageEditMode", async () => {
      expectInvalid(await update({ settings: { defaultPageEditMode: "x", trashRetentionDays: 0, sharingDisabled: 1 } }), "settings.sharingDisabled must be a boolean");
      expectInvalid(await update({ settings: { defaultPageEditMode: "x", trashRetentionDays: 0 } }), "settings.trashRetentionDays must be an integer between 1 and 3650");
    });
  });

  test("fields are checked in the order name, description, emailDomains, settings, and one refusal changes nothing", async () => {
    const before = await workspace();
    expectInvalid(await update({ name: "", description: 1, emailDomains: 1, settings: 1 }), "name is required");
    expectInvalid(await update({ name: "New", description: 1, emailDomains: 1, settings: 1 }), "description must be a string");
    expectInvalid(await update({ name: "New", description: "New", emailDomains: 1, settings: 1 }), "emailDomains must be a list of at most 50 items");
    expectInvalid(await update({ name: "New", description: "New", emailDomains: ["nope"], settings: 1 }), "emailDomains must contain valid domain names");
    expectInvalid(await update({ name: "New", description: "New", emailDomains: ["new.example"], settings: 1 }), "settings must be an object");
    expectInvalid(await update({ name: "New", description: "New", emailDomains: ["new.example"], settings: { sharingDisabled: "x" } }), "settings.sharingDisabled must be a boolean");
    expect(await workspace()).toEqual(before);
  });

  test("every field at once", async () => {
    const before = await workspace();
    const res = await update({ name: " All ", description: " Everything ", emailDomains: ["@All.example"], settings: { trashRetentionDays: 7 } }, admin);
    expectBody(res, 200, {
      data: {
        workspace: {
          name: "All",
          description: "Everything",
          logoUrl: null,
          emailDomains: ["all.example"],
          settings: { ...before.settings, trashRetentionDays: 7 },
          defaultSpaceId: spaceId,
          createdAt: before.createdAt,
        },
      },
    });
    expect(await workspace(member)).toEqual(res.body.data.workspace);
    await update({ name: "Acme", description: null, emailDomains: [] });
  });
});

describe("POST /workspace/logo and /workspace/logo/remove", () => {
  const cases: [string, Uint8Array, string, string][] = [
    ["PNG", PNG, "png", "image/png"],
    ["JPEG", JPEG, "jpg", "image/jpeg"],
    ["GIF", GIF, "gif", "image/gif"],
    ["WebP", WEBP, "webp", "image/webp"],
  ];

  test.each(cases)("a %s becomes the logo, replacing the one before with its file and record", async (_kind, bytes, ext, mime) => {
    const previous: string | null = (await workspace()).logoUrl;
    const res = await owner.upload("/workspace/logo", { file: imageFile(bytes, "logo.bin") });
    expect(res.status).toBe(200);
    const url: string = res.body.data.workspace.logoUrl;
    expect(url).toMatch(new RegExp(`^/api/images/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.${ext}$`));
    expectBody(res, 200, { data: { workspace: { ...(await workspace()), logoUrl: url } } });
    expectApiHeaders(res.headers);

    const name = url.split("/").pop()!;
    expect([...readFileSync(imagePath(t, url))]).toEqual([...bytes]);
    expect(await rows(t.sql`SELECT purpose, page_id, space_id, uploader_id, name, mime, size::int AS size, storage_key FROM files WHERE purpose = 'workspace-logo'`)).toEqual([
      { purpose: "workspace-logo", page_id: null, space_id: null, uploader_id: ownerUser.id, name, mime, size: bytes.length, storage_key: `images/${name}` },
    ]);
    if (previous) {
      expect(imageStored(t, previous)).toBe(false);
      expectError(await t.client().get(previous.slice("/api".length)), 404, "not_found", "Image not found");
    }

    expectBody(await t.client().get("/workspace/public"), 200, { data: { name: "Acme", logoUrl: url } });
    expect((await workspace(member)).logoUrl).toBe(url);
    const image = await t.client().fetch(url);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe(mime);
    expect(image.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([...bytes]);
  });

  test("an admin may upload too; what is no image is refused and the logo stays", async () => {
    const uploaded = await admin.upload("/workspace/logo", { file: imageFile(PNG, "logo.png", "image/png") });
    expect(uploaded.status).toBe(200);
    const url = uploaded.body.data.workspace.logoUrl;
    for (const bytes of [new Uint8Array(0), new TextEncoder().encode("<svg/>"), new TextEncoder().encode("RIFF$\u0000\u0000\u0000WAVE")]) {
      expectInvalid(await owner.upload("/workspace/logo", { file: imageFile(bytes, "logo.png", "image/png") }), "Images must be PNG, JPEG, WebP or GIF");
    }
    expectInvalid(await owner.upload("/workspace/logo", { logo: imageFile(PNG) }), 'Missing file field "file"');
    expectError(await owner.post("/workspace/logo", {}), 415, "unsupported_media_type", "Expected multipart/form-data");
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    expectError(await owner.upload("/workspace/logo", { file: imageFile(big) }), 413, "payload_too_large", "Images must be at most 10 MB");
    expect((await workspace()).logoUrl).toBe(url);
    expect(imageStored(t, url)).toBe(true);
    expect(await rows(t.sql`SELECT count(*)::int AS n FROM files WHERE purpose = 'workspace-logo'`)).toEqual([{ n: 1 }]);
  });

  test("members can neither upload nor remove the logo", async () => {
    const url = (await workspace()).logoUrl;
    expectBody(await member.upload("/workspace/logo", { file: imageFile(PNG) }), 403, NOT_ADMIN);
    expectBody(await member.post("/workspace/logo", {}), 403, NOT_ADMIN);
    expectBody(await member.post("/workspace/logo/remove"), 403, NOT_ADMIN);
    expectBody(await t.client().post("/workspace/logo/remove"), 401, UNAUTHORIZED);
    expect((await workspace()).logoUrl).toBe(url);
    expect(imageStored(t, url)).toBe(true);
  });

  test("removing the logo removes its file and record, and is fine when there is none", async () => {
    const url = (await workspace()).logoUrl;
    const res = await admin.post("/workspace/logo/remove");
    expectBody(res, 200, { data: { workspace: { ...(await workspace()), logoUrl: null } } });
    expectApiHeaders(res.headers);
    expect(imageStored(t, url)).toBe(false);
    expect(await rows(t.sql`SELECT 1 AS n FROM files WHERE purpose = 'workspace-logo'`)).toEqual([]);
    expectError(await t.client().get(url.slice("/api".length)), 404, "not_found", "Image not found");
    expectBody(await t.client().get("/workspace/public"), 200, { data: { name: "Acme", logoUrl: null } });
    expectBody(await owner.post("/workspace/logo/remove"), 200, { data: { workspace: await workspace() } });
  });
});
