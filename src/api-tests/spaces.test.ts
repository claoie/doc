import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { startServer, until, type Client, type TestServer } from "./harness";
import {
  NO_SUCH_ID,
  anyId,
  anyTime,
  createPage,
  createSpace,
  data,
  expectError,
  expectForbidden,
  expectInvalid,
  expectNotFound,
  expectUnauthorized,
  memberRow,
  person,
  type Person,
} from "./harness/spaces-pages";
import { openSocket, takeEvents, treeEvent } from "./harness/spaces-pages-ws";

let t: TestServer;
let owner: Client;
let ownerUser: any;
let generalId: string;
/** A workspace admin who is a member of no space. */
let admin: Person;
/** Workspace members without any space of their own. */
let writer: Person;
let reader: Person;
let outsider: Person;

let counter = 0;
/** A space created by the owner, with `writer` and `reader` in those roles. */
const teamSpace = async (name = "Team") => {
  const space = await createSpace(owner, name, `team-${++counter}`);
  data(await owner.post(`/spaces/${space.id}/members/add`, { role: "writer", userIds: [writer.id] }));
  data(await owner.post(`/spaces/${space.id}/members/add`, { role: "reader", userIds: [reader.id] }));
  return space;
};

/** A user as other people see them in a member list: no preferences. */
const listedUser = (user: any) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  avatarUrl: null,
  role: user.role,
  locale: null,
  timezone: null,
  preferences: {},
  createdAt: user.createdAt,
  lastLoginAt: anyTime(),
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);
const GIF = new TextEncoder().encode("GIF89a-pixels");
const WEBP = new TextEncoder().encode("RIFF\u0001\u0002\u0003\u0004WEBPVP8 ");

const uploadIcon = (client: Client, spaceId: string, bytes: Uint8Array | string, name = "icon.bin") =>
  client.upload(`/spaces/${spaceId}/icon`, { file: new File([bytes as BlobPart], name) });

beforeAll(async () => {
  t = await startServer();
  ({ owner, user: ownerUser, spaceId: generalId } = await t.setupOwner());
  admin = await person(t, owner, "admin@example.com", { role: "admin" });
  writer = await person(t, owner, "writer@example.com");
  reader = await person(t, owner, "reader@example.com");
  outsider = await person(t, owner, "outsider@example.com");
});

afterAll(async () => {
  await t.close();
});

describe("without a session", () => {
  test("every space endpoint answers 401", async () => {
    const anonymous = t.client();
    for (const path of ["/spaces", "/spaces/all", `/spaces/${generalId}`, "/spaces/general", `/spaces/${generalId}/members`]) {
      expectUnauthorized(await anonymous.get(path));
    }
    for (const path of [
      "/spaces",
      `/spaces/${generalId}/update`,
      `/spaces/${generalId}/delete`,
      `/spaces/${generalId}/icon`,
      `/spaces/${generalId}/icon/remove`,
      `/spaces/${generalId}/members/add`,
      `/spaces/${generalId}/members/role`,
      `/spaces/${generalId}/members/remove`,
    ]) {
      expectUnauthorized(await anonymous.post(path, {}));
    }
  });
});

describe("GET /spaces", () => {
  test("the first space is General, with the owner as its only member and admin", async () => {
    const res = await owner.get("/spaces");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        {
          id: generalId,
          name: "General",
          slug: "general",
          description: null,
          iconUrl: null,
          settings: {},
          role: "admin",
          memberCount: 1,
          createdAt: anyTime(),
        },
      ],
    });
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a member with no space gets an empty list", async () => {
    const res = await outsider.client.get("/spaces");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  test("lists the spaces the user is a member of, by name without regard to case, then by id", async () => {
    const lister = await person(t, owner, "lister@example.com");
    const beta = await createSpace(lister.client, "beta", "list-beta");
    const upper = await createSpace(lister.client, "ALPHA", "list-alpha-1");
    const lower = await createSpace(lister.client, "alpha", "list-alpha-2");
    const gamma = await createSpace(lister.client, "Gamma", "list-gamma");
    const twins = [upper, lower].sort((a, b) => (a.id < b.id ? -1 : 1));
    const res = await lister.client.get("/spaces");
    expect(data(res).map((s: any) => s.id)).toEqual([twins[0].id, twins[1].id, beta.id, gamma.id]);
    expect(data(res)[2]).toEqual({ ...beta, role: "admin", memberCount: 1 });
  });

  test("role is the user's own role and memberCount counts member rows, users and groups alike", async () => {
    const space = await teamSpace("Counted");
    const groups = data(await owner.get("/groups"));
    const everyone = groups.find((g: any) => g.isDefault);
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "reader", groupIds: [everyone.id] }));
    const forWriter = data(await writer.client.get("/spaces")).find((s: any) => s.id === space.id);
    // The owner, the writer, the reader and the group Everyone: four rows, however many people the group holds.
    expect(forWriter).toEqual({ ...space, role: "writer", memberCount: 4 });
    const forReader = data(await reader.client.get("/spaces")).find((s: any) => s.id === space.id);
    expect(forReader).toEqual({ ...space, role: "reader", memberCount: 4 });
    // Through the group alone the outsider is a reader.
    const forOutsider = data(await outsider.client.get("/spaces")).find((s: any) => s.id === space.id);
    expect(forOutsider).toEqual({ ...space, role: "reader", memberCount: 4 });
    data(await owner.post(`/spaces/${space.id}/delete`));
  });

  test("a workspace admin who is not a member does not see the space here", async () => {
    const space = await teamSpace("Hidden from admins");
    expect(data(await admin.client.get("/spaces")).map((s: any) => s.id)).not.toContain(space.id);
  });
});

describe("GET /spaces/all", () => {
  test("members are refused", async () => {
    expectForbidden(await writer.client.get("/spaces/all"), "Only workspace admins can do this");
    expectForbidden(await outsider.client.get("/spaces/all"), "Only workspace admins can do this");
  });

  test("admins and owners get every space, with a null role where they are not a member", async () => {
    const space = await createSpace(writer.client, "Writer's own", `own-${++counter}`);
    const forAdmin = data(await admin.client.get("/spaces/all"));
    expect(forAdmin.find((s: any) => s.id === space.id)).toEqual({ ...space, role: null, memberCount: 1 });
    expect(forAdmin.find((s: any) => s.id === generalId)).toEqual({
      id: generalId,
      name: "General",
      slug: "general",
      description: null,
      iconUrl: null,
      settings: {},
      role: null,
      memberCount: 1,
      createdAt: anyTime(),
    });
    const forOwner = data(await owner.get("/spaces/all"));
    expect(forOwner.find((s: any) => s.id === space.id).role).toBeNull();
    expect(forOwner.find((s: any) => s.id === generalId).role).toBe("admin");
    // Same order as GET /spaces: by lower-cased name, then id.
    const names = forOwner.map((s: any) => s.name.toLowerCase());
    expect(names).toEqual([...names].sort());
    expect(forAdmin.map((s: any) => s.id)).toEqual(forOwner.map((s: any) => s.id));
  });

  test("a space whose slug is `all` is reachable by id only", async () => {
    const space = await createSpace(writer.client, "All", "all");
    // The fixed route wins over `/spaces/:space`.
    expectForbidden(await writer.client.get("/spaces/all"), "Only workspace admins can do this");
    expect(Array.isArray(data(await owner.get("/spaces/all")))).toBe(true);
    expect(data(await writer.client.get(`/spaces/${space.id}`)).space.slug).toBe("all");
  });
});

describe("POST /spaces", () => {
  test("any member creates a space and becomes its admin", async () => {
    const res = await outsider.client.post("/spaces", { name: "  Research  ", slug: "  Research-1  ", description: "  What we study  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        space: {
          id: anyId(),
          name: "Research",
          slug: "research-1",
          description: "What we study",
          iconUrl: null,
          settings: {},
          role: "admin",
          memberCount: 1,
          createdAt: anyTime(),
        },
      },
    });
    const space = res.body.data.space;
    expect(data(await outsider.client.get(`/spaces/${space.id}/members`))).toEqual([
      { id: anyId(), role: "admin", user: listedUser(outsider.user) },
    ]);
    const [row] = await t.sql`SELECT created_by, (SELECT added_by FROM space_members WHERE space_id = s.id) AS added_by FROM spaces s WHERE id = ${space.id}`;
    expect(row).toEqual({ created_by: outsider.id, added_by: outsider.id });
    data(await outsider.client.post(`/spaces/${space.id}/delete`));
  });

  test("description: absent, null and blank all store null; unknown fields are ignored", async () => {
    for (const [i, extra] of [{}, { description: null }, { description: "   " }, { description: "", icon: "x", settings: { sharingDisabled: true }, id: NO_SUCH_ID }].entries()) {
      const res = await owner.post("/spaces", { name: "Plain", slug: `plain-${i}`, ...extra });
      expect(data(res).space).toMatchObject({ description: null, settings: {}, iconUrl: null });
      expect(data(res).space.id).not.toBe(NO_SUCH_ID);
    }
  });

  test("names of every script are kept as sent, up to 100 characters counted in code points", async () => {
    const names = ["Équipe déjà vu", "équipe", "开发团队", "チーム", "فريق التطوير", "🚀 Launch 👩‍👩‍👧", "😀".repeat(100), "x".repeat(100), "字".repeat(100)];
    for (const [i, name] of names.entries()) {
      const res = await owner.post("/spaces", { name, slug: `names-${i}` });
      expect(data(res).space.name).toBe(name);
      expect(data(await owner.get(`/spaces/names-${i}`)).space.name).toBe(name);
    }
    expectInvalid(await owner.post("/spaces", { name: "😀".repeat(101), slug: "names-x" }), "name must be at most 100 characters");
    expectInvalid(await owner.post("/spaces", { name: "x".repeat(101), slug: "names-x" }), "name must be at most 100 characters");
    // Trimmed before it is measured.
    expect(data(await owner.post("/spaces", { name: ` ${"y".repeat(100)} `, slug: "names-y" })).space.name).toBe("y".repeat(100));
    const description = "é😀".repeat(250);
    expect(data(await owner.post("/spaces", { name: "Described", slug: "names-d", description })).space.description).toBe(description);
    expectInvalid(await owner.post("/spaces", { name: "Described", slug: "names-e", description: `${description}!` }), "description must be at most 500 characters");
  });

  test("rejects a missing, mistyped or blank name", async () => {
    const slug = "never-created";
    expectInvalid(await owner.post("/spaces", { slug }), "name must be a string");
    expectInvalid(await owner.post("/spaces", { name: null, slug }), "name must be a string");
    expectInvalid(await owner.post("/spaces", { name: 7, slug }), "name must be a string");
    expectInvalid(await owner.post("/spaces", { name: ["a"], slug }), "name must be a string");
    expectInvalid(await owner.post("/spaces", { name: "", slug }), "name is required");
    expectInvalid(await owner.post("/spaces", { name: " \t\n", slug }), "name is required");
    expectInvalid(await owner.post("/spaces", { name: "Ok", slug, description: 5 }), "description must be a string");
    expectInvalid(await owner.post("/spaces", { name: "Ok", slug, description: {} }), "description must be a string");
    expectNotFound(await owner.get(`/spaces/${slug}`), "Space");
  });

  test("slugs are 2–50 characters of a-z, 0-9 and -, lower-cased", async () => {
    const name = "Slugs";
    expectInvalid(await owner.post("/spaces", { name }), "slug must be a string");
    expectInvalid(await owner.post("/spaces", { name, slug: null }), "slug must be a string");
    expectInvalid(await owner.post("/spaces", { name, slug: 12 }), "slug must be a string");
    expectInvalid(await owner.post("/spaces", { name, slug: "" }), "slug is too short");
    expectInvalid(await owner.post("/spaces", { name, slug: "a" }), "slug is too short");
    expectInvalid(await owner.post("/spaces", { name, slug: " a " }), "slug is too short");
    expectInvalid(await owner.post("/spaces", { name, slug: "a".repeat(51) }), "slug must be at most 50 characters");
    for (const slug of ["a b", "a_b", "a.b", "a/b", "é1", "团队", "ab!", "😀😀", "a\u0000b"]) {
      expectInvalid(await owner.post("/spaces", { name, slug }), "slug must be 2–50 characters of a-z, 0-9 and -");
    }
    for (const [slug, stored] of [["ab", "ab"], ["A-B", "a-b"], ["--", "--"], ["-0-", "-0-"], ["0123456789", "0123456789"], ["z".repeat(50), "z".repeat(50)], ["MiXeD-9", "mixed-9"]]) {
      expect(data(await owner.post("/spaces", { name, slug })).space.slug).toBe(stored!);
    }
  });

  test("a slug in use is refused whatever its case", async () => {
    await createSpace(owner, "Taken", "taken-slug");
    expectError(await owner.post("/spaces", { name: "Other", slug: "taken-slug" }), 409, "slug_taken", "That slug is already in use");
    expectError(await writer.client.post("/spaces", { name: "Other", slug: "TAKEN-SLUG" }), 409, "slug_taken", "That slug is already in use");
    expectError(await owner.post("/spaces", { name: "Other", slug: "general" }), 409, "slug_taken", "That slug is already in use");
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM spaces WHERE lower(slug) = 'taken-slug'`;
    expect(n).toBe(1);
  });

  test("the body must be a JSON object sent as application/json", async () => {
    const post = (body: string, type: string) => owner.raw("POST", "/spaces", { body, headers: { "Content-Type": type } });
    const malformed = await post("{not json", "application/json");
    expect([malformed.status, await malformed.json()]).toEqual([400, { error: { code: "invalid_input", message: "Malformed JSON" } }]);
    const list = await post('[{"name":"A","slug":"aa"}]', "application/json");
    expect([list.status, await list.json()]).toEqual([400, { error: { code: "invalid_input", message: "Expected a JSON object" } }]);
    const form = await post("name=A&slug=aa", "application/x-www-form-urlencoded");
    expect([form.status, await form.json()]).toEqual([415, { error: { code: "unsupported_media_type", message: "Expected application/json" } }]);
    const charset = await post('{"name":"Charset","slug":"with-charset"}', "Application/JSON; charset=utf-8");
    expect(charset.status).toBe(200);
    // An empty body is read as an empty object.
    const empty = await owner.raw("POST", "/spaces");
    expect([empty.status, await empty.json()]).toEqual([400, { error: { code: "invalid_input", message: "name must be a string" } }]);
    const big = await post(JSON.stringify({ name: "Big", slug: "big-body", description: "x".repeat(1024 * 1024) }), "application/json");
    expect([big.status, await big.json()]).toEqual([413, { error: { code: "payload_too_large", message: "Request body is too large" } }]);
  });

  test("the creator's open socket hears about the new space's pages at once", async () => {
    const socket = await openSocket(writer.client);
    const space = await createSpace(writer.client, "Live", `live-${++counter}`);
    // The subscription is refreshed after the answer: keep creating pages until one is announced.
    await until(async () => {
      await createPage(writer.client, { spaceId: space.id });
      return (await takeEvents(socket)).length > 0;
    });
    await createPage(writer.client, { spaceId: space.id });
    expect(await takeEvents(socket)).toEqual([treeEvent(space.id)]);
    await socket.close();
  });
});

describe("GET /spaces/:space", () => {
  test("finds a space by id or slug, in any case, for each kind of member", async () => {
    const space = await teamSpace("Lookup");
    const expected = { ...space, memberCount: 3 };
    for (const ref of [space.id, space.id.toUpperCase(), space.slug, space.slug.toUpperCase()]) {
      const res = await owner.get(`/spaces/${ref}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { space: { ...expected, role: "admin" } } });
    }
    expect(data(await writer.client.get(`/spaces/${space.slug}`)).space).toEqual({ ...expected, role: "writer" });
    expect(data(await reader.client.get(`/spaces/${space.id}`)).space).toEqual({ ...expected, role: "reader" });
  });

  test("workspace admins see spaces they are not a member of, with a null role; other people get 404", async () => {
    const space = await teamSpace("Private");
    expect(data(await admin.client.get(`/spaces/${space.id}`)).space).toEqual({ ...space, role: null, memberCount: 3 });
    expect(data(await admin.client.get(`/spaces/${space.slug}`)).space.role).toBeNull();
    expectNotFound(await outsider.client.get(`/spaces/${space.id}`), "Space");
    expectNotFound(await outsider.client.get(`/spaces/${space.slug}`), "Space");
  });

  test("unknown ids and slugs are 404", async () => {
    expectNotFound(await owner.get(`/spaces/${NO_SUCH_ID}`), "Space");
    expectNotFound(await owner.get("/spaces/no-such-space"), "Space");
    expectNotFound(await owner.get("/spaces/%20"), "Space");
    expectNotFound(await owner.get(`/spaces/${encodeURIComponent("it's 100% a_slug")}`), "Space");
  });
});

describe("POST /spaces/:id/update", () => {
  test("changes only what is sent", async () => {
    const space = await teamSpace("Before");
    const described = await owner.post(`/spaces/${space.id}/update`, { description: "  First  " });
    expect(described.status).toBe(200);
    expect(described.body).toEqual({ data: { space: { ...space, description: "First", memberCount: 3 } } });
    const renamed = data(await owner.post(`/spaces/${space.id}/update`, { name: "  After  " })).space;
    expect(renamed).toEqual({ ...space, name: "After", description: "First", memberCount: 3 });
    const moved = data(await owner.post(`/spaces/${space.id}/update`, { slug: "After-Slug" })).space;
    expect(moved).toEqual({ ...renamed, slug: "after-slug" });
    expect(data(await owner.post(`/spaces/${space.id}/update`, {})).space).toEqual(moved);
    expect(data(await owner.post(`/spaces/${space.id}/update`, { memberCount: 9, role: "reader", iconUrl: "/x", id: NO_SUCH_ID })).space).toEqual(moved);
    expectNotFound(await owner.get(`/spaces/${space.slug}`), "Space");
    expect(data(await owner.get("/spaces/after-slug")).space).toEqual(moved);
    const [row] = await t.sql`SELECT updated_at > created_at AS touched FROM spaces WHERE id = ${space.id}`;
    expect(row.touched).toBe(true);
  });

  test("description: null and blank clear it, absent keeps it", async () => {
    const space = await teamSpace("Notes");
    const set = (description: unknown) => owner.post(`/spaces/${space.id}/update`, { description });
    expect(data(await set("Kept")).space.description).toBe("Kept");
    expect(data(await owner.post(`/spaces/${space.id}/update`, { name: "Notes 2" })).space.description).toBe("Kept");
    expect(data(await set(null)).space.description).toBeNull();
    expect(data(await set("Again")).space.description).toBe("Again");
    expect(data(await set("  ")).space.description).toBeNull();
    expect(data(await set("d".repeat(500))).space.description).toBe("d".repeat(500));
    expectInvalid(await set("d".repeat(501)), "description must be at most 500 characters");
    expectInvalid(await set(1), "description must be a string");
  });

  test("validates name and slug as creation does, but null is not a way to leave them alone", async () => {
    const space = await teamSpace("Strict");
    const update = (body: unknown) => owner.post(`/spaces/${space.id}/update`, body);
    expectInvalid(await update({ name: null }), "name must be a string");
    expectInvalid(await update({ name: "" }), "name is required");
    expectInvalid(await update({ name: "n".repeat(101) }), "name must be at most 100 characters");
    expectInvalid(await update({ slug: null }), "slug must be a string");
    expectInvalid(await update({ slug: "x" }), "slug is too short");
    expectInvalid(await update({ slug: "x".repeat(51) }), "slug must be at most 50 characters");
    expectInvalid(await update({ slug: "no spaces" }), "slug must be 2–50 characters of a-z, 0-9 and -");
    expect(data(await owner.get(`/spaces/${space.id}`)).space).toEqual({ ...space, memberCount: 3 });
  });

  test("a slug taken by another space is refused; its own slug is not", async () => {
    const space = await teamSpace("Mine");
    const other = await teamSpace("Theirs");
    expectError(await owner.post(`/spaces/${space.id}/update`, { slug: other.slug.toUpperCase(), name: "Changed" }), 409, "slug_taken", "That slug is already in use");
    // Nothing of a refused update is kept.
    expect(data(await owner.get(`/spaces/${space.id}`)).space.name).toBe("Mine");
    expect(data(await owner.post(`/spaces/${space.id}/update`, { slug: space.slug.toUpperCase() })).space.slug).toBe(space.slug);
  });

  test("settings must be an object and sharingDisabled a boolean; other keys are dropped", async () => {
    const space = await teamSpace("Settings");
    const update = (settings: unknown) => owner.post(`/spaces/${space.id}/update`, { settings });
    for (const settings of [null, [], "x", 1, true]) expectInvalid(await update(settings), "settings must be an object");
    for (const sharingDisabled of [null, "true", 1, 0, []]) {
      expectInvalid(await update({ sharingDisabled }), "settings.sharingDisabled must be a boolean");
    }
    expect(data(await update({})).space.settings).toEqual({});
    expect(data(await update({ theme: "dark", other: 1 })).space.settings).toEqual({});
    expect(data(await update({ sharingDisabled: false })).space.settings).toEqual({ sharingDisabled: false });
    expect(data(await update({ sharingDisabled: true, extra: "x" })).space.settings).toEqual({ sharingDisabled: true });
    // Absent settings, or settings without the key, leave the stored value alone.
    expect(data(await update({})).space.settings).toEqual({ sharingDisabled: true });
    expect(data(await owner.post(`/spaces/${space.id}/update`, { name: "Settings 2" })).space.settings).toEqual({ sharingDisabled: true });
    expect(data(await update({ sharingDisabled: false })).space.settings).toEqual({ sharingDisabled: false });
  });

  test("turning sharing off removes the shares of the space's pages, and only those", async () => {
    const space = await teamSpace("Shared");
    const other = await teamSpace("Still shared");
    const page = await createPage(owner, { spaceId: space.id, title: "Public" });
    const child = await createPage(owner, { spaceId: space.id, parentId: page.id, title: "Public child" });
    const trashed = await createPage(owner, { spaceId: space.id, title: "Trashed later" });
    const elsewhere = await createPage(owner, { spaceId: other.id, title: "Elsewhere" });
    for (const p of [page, child, trashed, elsewhere]) data(await owner.post(`/pages/${p.id}/share`, { includeChildren: true }));
    expect(data(await owner.get(`/spaces/${space.id}/shares`))).toHaveLength(3);

    // Setting it to false keeps them.
    data(await owner.post(`/spaces/${space.id}/update`, { settings: { sharingDisabled: false } }));
    expect(data(await owner.get(`/spaces/${space.id}/shares`))).toHaveLength(3);

    data(await owner.post(`/spaces/${space.id}/update`, { settings: { sharingDisabled: true } }));
    expect(data(await owner.get(`/spaces/${space.id}/shares`))).toEqual([]);
    expect(data(await owner.get(`/pages/${page.id}/share`))).toEqual({ share: null, inheritedFrom: null });
    expect(data(await owner.get(`/pages/${child.id}/share`))).toEqual({ share: null, inheritedFrom: null });
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM shares WHERE page_id IN (SELECT id FROM pages WHERE space_id = ${space.id})`;
    expect(n).toBe(0);
    expect(data(await owner.get(`/spaces/${other.id}/shares`))).toHaveLength(1);
    // Turning sharing on again does not bring them back.
    data(await owner.post(`/spaces/${space.id}/update`, { settings: { sharingDisabled: false } }));
    expect(data(await owner.get(`/pages/${page.id}/share`)).share).toBeNull();
  });

  test("only space admins and workspace admins may update", async () => {
    const space = await teamSpace("Guarded");
    expectForbidden(await writer.client.post(`/spaces/${space.id}/update`, { name: "Hijacked" }));
    expectForbidden(await reader.client.post(`/spaces/${space.id}/update`, { name: "Hijacked" }));
    expectNotFound(await outsider.client.post(`/spaces/${space.id}/update`, { name: "Hijacked" }), "Space");
    // Permission is checked before the body.
    expectForbidden(await writer.client.post(`/spaces/${space.id}/update`, { name: 5 }));
    expect(data(await owner.get(`/spaces/${space.id}`)).space.name).toBe("Guarded");
    // A workspace admin manages a space without being a member; the answer carries their null role.
    const byAdmin = await admin.client.post(`/spaces/${space.id}/update`, { name: "By the admin" });
    expect(data(byAdmin).space).toEqual({ ...space, name: "By the admin", role: null, memberCount: 3 });
    // A workspace admin who is a reader of the space still manages it.
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "reader", userIds: [admin.id] }));
    expect(data(await admin.client.post(`/spaces/${space.id}/update`, { name: "By a reading admin" })).space.role).toBe("reader");
    data(await owner.post(`/spaces/${space.id}/members/remove`, { memberId: await memberRow(owner, space.id, admin.id) }));
  });

  test("the space is named by id only: a slug or an unknown id is 404", async () => {
    const space = await teamSpace("By id");
    expectNotFound(await owner.post(`/spaces/${space.slug}/update`, { name: "X" }), "Space");
    expectNotFound(await owner.post(`/spaces/${NO_SUCH_ID}/update`, { name: "X" }), "Space");
    expectNotFound(await admin.client.post(`/spaces/${NO_SUCH_ID}/update`, { name: "X" }), "Space");
    expect(data(await owner.post(`/spaces/${space.id.toUpperCase()}/update`, { name: "Upper" })).space.name).toBe("Upper");
  });
});

describe("POST /spaces/:id/icon and /icon/remove", () => {
  test("stores a PNG, JPEG, GIF or WebP by its first bytes and replaces the previous icon", async () => {
    const space = await teamSpace("Icons");
    let previous: string | null = null;
    for (const [bytes, ext, mime] of [[PNG, "png", "image/png"], [JPEG, "jpg", "image/jpeg"], [GIF, "gif", "image/gif"], [WEBP, "webp", "image/webp"]] as const) {
      // The file's name and declared type do not matter.
      const res = await owner.upload(`/spaces/${space.id}/icon`, { file: new File([bytes], "anything.txt", { type: "text/plain" }) });
      expect(res.status).toBe(200);
      const iconUrl: string = res.body.data.space.iconUrl;
      expect(iconUrl).toMatch(new RegExp(`^/api/images/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.${ext}$`));
      expect(res.body).toEqual({ data: { space: { ...space, iconUrl, memberCount: 3 } } });
      const name = iconUrl.slice("/api/images/".length);
      expect(await Bun.file(path.join(t.storageDir, "images", name)).bytes()).toEqual(bytes);
      const [row] = await t.sql`SELECT purpose, space_id, page_id, uploader_id, name, mime, size::int AS size, storage_key FROM files WHERE name = ${name}`;
      expect(row).toEqual({ purpose: "space-icon", space_id: space.id, page_id: null, uploader_id: ownerUser.id, name, mime, size: bytes.length, storage_key: `images/${name}` });
      // Anyone can fetch it, signed in or not.
      const served = await t.client().fetch(iconUrl);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe(mime);
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
      if (previous) {
        expect(existsSync(path.join(t.storageDir, "images", previous))).toBe(false);
        expect((await t.client().fetch(`/api/images/${previous}`)).status).toBe(404);
        const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM files WHERE name = ${previous}`;
        expect(n).toBe(0);
      }
      previous = name;
    }
    expect(data(await writer.client.get(`/spaces/${space.id}`)).space.iconUrl).toBe(`/api/images/${previous}`);
    expect(data(await writer.client.get("/spaces")).find((s: any) => s.id === space.id).iconUrl).toBe(`/api/images/${previous}`);

    const removed = await owner.post(`/spaces/${space.id}/icon/remove`);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ data: { space: { ...space, iconUrl: null, memberCount: 3 } } });
    expect(existsSync(path.join(t.storageDir, "images", previous!))).toBe(false);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM files WHERE space_id = ${space.id}`;
    expect(n).toBe(0);
    // Removing when there is none is fine.
    expect(data(await owner.post(`/spaces/${space.id}/icon/remove`)).space.iconUrl).toBeNull();
  });

  test("refuses what is not an image, a missing file and other body types", async () => {
    const space = await teamSpace("Bad icons");
    for (const bytes of ["just text", "GIF", "<svg xmlns='http://www.w3.org/2000/svg'/>", "RIFF____WAVE", new Uint8Array([0x89, 0x50, 0x4e]), new Uint8Array([0xff, 0xd8]), ""]) {
      expectInvalid(await uploadIcon(owner, space.id, bytes, "icon.png"), "Images must be PNG, JPEG, WebP or GIF");
    }
    expectInvalid(await owner.upload(`/spaces/${space.id}/icon`, { other: new File([PNG], "icon.png") }), 'Missing file field "file"');
    expectInvalid(await owner.upload(`/spaces/${space.id}/icon`, { file: "not a file" }), 'Missing file field "file"');
    expectError(await owner.post(`/spaces/${space.id}/icon`, { file: "x" }), 415, "unsupported_media_type", "Expected multipart/form-data");
    const noType = await owner.raw("POST", `/spaces/${space.id}/icon`);
    expect([noType.status, await noType.json()]).toEqual([415, { error: { code: "unsupported_media_type", message: "Expected multipart/form-data" } }]);
    const broken = await owner.raw("POST", `/spaces/${space.id}/icon`, { body: "not multipart at all", headers: { "Content-Type": "multipart/form-data; boundary=xyz" } });
    expect([broken.status, await broken.json()]).toEqual([400, { error: { code: "invalid_input", message: "Malformed multipart body" } }]);
    expect(data(await owner.get(`/spaces/${space.id}`)).space.iconUrl).toBeNull();
    expect(readdirSync(t.storageDir).includes("images") ? readdirSync(path.join(t.storageDir, "images")).length : 0).toBe(
      (await t.sql`SELECT count(*)::int AS n FROM files WHERE purpose <> 'page'`)[0].n,
    );
  });

  test("images over 10 MB are refused, and bodies over 11 MB before they are read", async () => {
    const space = await teamSpace("Heavy icons");
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    expectError(await uploadIcon(owner, space.id, big), 413, "payload_too_large", "Images must be at most 10 MB");
    const exact = big.slice(0, 10 * 1024 * 1024);
    expect(data(await uploadIcon(owner, space.id, exact)).space.iconUrl).toMatch(/\.png$/);
    const huge = new Uint8Array(11 * 1024 * 1024 + 1);
    huge.set(PNG);
    expectError(await uploadIcon(owner, space.id, huge), 413, "payload_too_large", "File is too large");
    data(await owner.post(`/spaces/${space.id}/icon/remove`));
  });

  test("only space admins and workspace admins may set or remove the icon", async () => {
    const space = await teamSpace("Icon guard");
    for (const who of [writer, reader]) {
      expectForbidden(await uploadIcon(who.client, space.id, PNG));
      expectForbidden(await who.client.post(`/spaces/${space.id}/icon/remove`));
    }
    expectNotFound(await uploadIcon(outsider.client, space.id, PNG), "Space");
    expectNotFound(await outsider.client.post(`/spaces/${space.id}/icon/remove`), "Space");
    expectNotFound(await uploadIcon(owner, NO_SUCH_ID, PNG), "Space");
    expectNotFound(await uploadIcon(owner, space.slug, PNG), "Space");
    expectNotFound(await owner.post(`/spaces/${space.slug}/icon/remove`), "Space");
    const byAdmin = data(await uploadIcon(admin.client, space.id, PNG)).space;
    expect(byAdmin).toEqual({ ...space, iconUrl: expect.stringMatching(/^\/api\/images\/.+\.png$/), role: null, memberCount: 3 });
    expect(data(await admin.client.post(`/spaces/${space.id}/icon/remove`)).space).toEqual({ ...space, role: null, memberCount: 3 });
  });
});

describe("GET /spaces/:id/members", () => {
  test("lists groups first, then people, each by name without regard to case", async () => {
    const space = await createSpace(owner, "Roster", `roster-${++counter}`);
    const zed = data(await owner.post("/groups", { name: "zed group", description: "Last" })).group;
    const able = data(await owner.post("/groups", { name: "Able group" })).group;
    data(await owner.post(`/groups/${able.id}/members/add`, { userIds: [writer.id, reader.id] }));
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "reader", groupIds: [zed.id] }));
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "writer", groupIds: [able.id] }));
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "writer", userIds: [writer.id] }));
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "reader", userIds: [reader.id] }));
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "admin", userIds: [admin.id] }));
    const res = await reader.client.get(`/spaces/${space.id}/members`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        { id: anyId(), role: "writer", group: { id: able.id, name: "Able group", description: null, isDefault: false, memberCount: 2 } },
        { id: anyId(), role: "reader", group: { id: zed.id, name: "zed group", description: "Last", isDefault: false, memberCount: 0 } },
        { id: anyId(), role: "admin", user: listedUser(admin.user) },
        { id: anyId(), role: "admin", user: { ...listedUser(ownerUser), name: "Owner" } },
        { id: anyId(), role: "reader", user: listedUser(reader.user) },
        { id: anyId(), role: "writer", user: listedUser(writer.user) },
      ],
    });
    // Neither `user: null` nor `group: null` appears, and nobody's preferences do, not even one's own.
    data(await reader.client.post("/me/update", { preferences: { theme: "dark" } }));
    const own = data(await reader.client.get(`/spaces/${space.id}/members`)).find((m: any) => m.user?.id === reader.id);
    expect(Object.keys(own).sort()).toEqual(["id", "role", "user"]);
    expect(own.user.preferences).toEqual({});
    expect(data(await owner.get(`/spaces/${space.id.toUpperCase()}/members`))).toHaveLength(6);
  });

  test("deactivated members stay listed", async () => {
    const space = await createSpace(owner, "Leavers", `leavers-${++counter}`);
    const leaver = await person(t, owner, "leaver@example.com", { space: space.id, spaceRole: "writer" });
    data(await owner.post("/members/deactivate", { userId: leaver.id }));
    const rows = data(await owner.get(`/spaces/${space.id}/members`));
    expect(rows.map((r: any) => r.user.email)).toEqual(["leaver@example.com", "owner@example.com"]);
    expect(Object.keys(rows[0].user).sort()).toEqual(["avatarUrl", "createdAt", "email", "id", "lastLoginAt", "locale", "name", "preferences", "role", "timezone"]);
  });

  test("members of any role and workspace admins may list; others get 404", async () => {
    const space = await teamSpace("Listable");
    for (const who of [writer, reader, admin]) expect(data(await who.client.get(`/spaces/${space.id}/members`))).toHaveLength(3);
    expectNotFound(await outsider.client.get(`/spaces/${space.id}/members`), "Space");
    expectNotFound(await owner.get(`/spaces/${space.slug}/members`), "Space");
    expectNotFound(await owner.get(`/spaces/${NO_SUCH_ID}/members`), "Space");
  });
});

describe("POST /spaces/:id/members/add", () => {
  test("adds users and groups with a role, ignoring unknown ids and repeated ones", async () => {
    const space = await createSpace(owner, "Joinable", `join-${++counter}`);
    const group = data(await owner.post("/groups", { name: `Joiners ${++counter}` })).group;
    const res = await owner.post(`/spaces/${space.id}/members/add`, {
      role: "writer",
      userIds: [writer.id, writer.id.toUpperCase(), NO_SUCH_ID, group.id],
      groupIds: [group.id, NO_SUCH_ID, writer.id],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: {} });
    const rows = data(await owner.get(`/spaces/${space.id}/members`));
    expect(rows.map((r: any) => [r.role, r.group?.id ?? r.user.id])).toEqual([
      ["writer", group.id],
      ["admin", ownerUser.id],
      ["writer", writer.id],
    ]);
    const added = await t.sql`SELECT added_by FROM space_members WHERE space_id = ${space.id}`;
    expect(added.map((r: any) => r.added_by)).toEqual([ownerUser.id, ownerUser.id, ownerUser.id]);
    expect(data(await writer.client.get(`/spaces/${space.id}`)).space).toMatchObject({ role: "writer", memberCount: 3 });
  });

  test("adding again changes the role instead of adding a second row", async () => {
    const space = await createSpace(owner, "Upsert", `upsert-${++counter}`);
    const group = data(await owner.post("/groups", { name: `Upserted ${++counter}` })).group;
    const add = (role: string) => owner.post(`/spaces/${space.id}/members/add`, { role, userIds: [reader.id], groupIds: [group.id] });
    data(await add("reader"));
    const before = data(await owner.get(`/spaces/${space.id}/members`));
    for (const role of ["writer", "admin", "reader"]) {
      data(await add(role));
      const rows = data(await owner.get(`/spaces/${space.id}/members`));
      expect(rows.map((r: any) => r.id)).toEqual(before.map((r: any) => r.id));
      expect(rows.map((r: any) => r.role)).toEqual([role, "admin", role]);
    }
  });

  test("role, and at least one id, are required; at most 25 of each", async () => {
    const space = await createSpace(owner, "Add rules", `rules-${++counter}`);
    const add = (body: unknown) => owner.post(`/spaces/${space.id}/members/add`, body);
    expectInvalid(await add({ userIds: [writer.id] }), "role is required");
    for (const role of ["owner", "Admin", "", null, 3, ["admin"]]) {
      expectInvalid(await add({ role, userIds: [writer.id] }), "role must be one of admin, writer, reader");
    }
    expectInvalid(await add({ role: "reader" }), "userIds or groupIds is required");
    expectInvalid(await add({ role: "reader", userIds: [], groupIds: [] }), "userIds or groupIds is required");
    for (const userIds of [writer.id, null, {}, 5]) {
      expectInvalid(await add({ role: "reader", userIds }), "userIds must be a list of at most 25 ids");
    }
    for (const groupIds of [writer.id, null, {}]) {
      expectInvalid(await add({ role: "reader", groupIds }), "groupIds must be a list of at most 25 ids");
    }
    expectInvalid(await add({ role: "reader", userIds: [writer.id, "nope"] }), "userIds must contain valid ids");
    expectInvalid(await add({ role: "reader", userIds: [null] }), "userIds must contain valid ids");
    expectInvalid(await add({ role: "reader", userIds: [writer.id], groupIds: [5] }), "groupIds must contain valid ids");
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expectInvalid(await add({ role: "reader", userIds: filler(26) }), "userIds must be a list of at most 25 ids");
    expectInvalid(await add({ role: "reader", groupIds: filler(26) }), "groupIds must be a list of at most 25 ids");
    // The limit is on the list as sent, before repeated ids are merged.
    expectInvalid(await add({ role: "reader", userIds: Array(26).fill(writer.id) }), "userIds must be a list of at most 25 ids");
    expect(data(await add({ role: "reader", userIds: [...filler(24), writer.id], groupIds: filler(25) }))).toEqual({});
    expect(data(await owner.get(`/spaces/${space.id}/members`))).toHaveLength(2);
    // Only unknown ids: nothing is added, and that is not an error.
    expect(data(await add({ role: "admin", userIds: filler(3) }))).toEqual({});
    expect(data(await owner.get(`/spaces/${space.id}/members`))).toHaveLength(2);
  });

  test("only space admins and workspace admins may add members", async () => {
    const space = await teamSpace("Add guard");
    const body = { role: "admin", userIds: [outsider.id] };
    expectForbidden(await writer.client.post(`/spaces/${space.id}/members/add`, body));
    expectForbidden(await reader.client.post(`/spaces/${space.id}/members/add`, body));
    expectNotFound(await outsider.client.post(`/spaces/${space.id}/members/add`, body), "Space");
    expectNotFound(await owner.post(`/spaces/${NO_SUCH_ID}/members/add`, body), "Space");
    expectNotFound(await owner.post(`/spaces/${space.slug}/members/add`, body), "Space");
    expect(data(await owner.get(`/spaces/${space.id}/members`))).toHaveLength(3);
    // A workspace admin can add anyone, themselves included, without being a member.
    expect(data(await admin.client.post(`/spaces/${space.id}/members/add`, { role: "writer", userIds: [admin.id] }))).toEqual({});
    expect(data(await admin.client.get(`/spaces/${space.id}`)).space.role).toBe("writer");
  });

  test("a deactivated user can be added, and counts", async () => {
    const space = await createSpace(owner, "Dormant", `dormant-${++counter}`);
    const dormant = await person(t, owner, "dormant@example.com");
    data(await owner.post("/members/deactivate", { userId: dormant.id }));
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "reader", userIds: [dormant.id] }));
    expect(data(await owner.get(`/spaces/${space.id}`)).space.memberCount).toBe(2);
  });

  test("the role in a space is the highest of the direct grant and the grants of one's groups", async () => {
    const space = await createSpace(owner, "Layered", `layered-${++counter}`);
    const grouped = await person(t, owner, "grouped@example.com");
    const low = data(await owner.post("/groups", { name: `Low ${++counter}` })).group;
    const high = data(await owner.post("/groups", { name: `High ${++counter}` })).group;
    const role = async () => (await grouped.client.get(`/spaces/${space.id}`)).body.data?.space.role ?? null;
    data(await owner.post(`/groups/${low.id}/members/add`, { userIds: [grouped.id] }));
    data(await owner.post(`/groups/${high.id}/members/add`, { userIds: [grouped.id] }));
    expect(await role()).toBeNull();
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "reader", groupIds: [low.id] }));
    expect(await role()).toBe("reader");
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "writer", userIds: [grouped.id] }));
    expect(await role()).toBe("writer");
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "admin", groupIds: [high.id] }));
    expect(await role()).toBe("admin");
    // An admin through a group manages the space.
    expect(data(await grouped.client.post(`/spaces/${space.id}/update`, { description: "by a group admin" })).space.description).toBe("by a group admin");
    // A lower direct grant does not cap the group's.
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "reader", userIds: [grouped.id] }));
    expect(await role()).toBe("admin");
    data(await owner.post(`/groups/${high.id}/members/remove`, { userId: grouped.id }));
    expect(await role()).toBe("reader");
    expectForbidden(await grouped.client.post(`/spaces/${space.id}/update`, { description: "no longer" }));
    data(await owner.post(`/spaces/${space.id}/members/remove`, { memberId: await memberRow(owner, space.id, grouped.id) }));
    expect(await role()).toBe("reader");
    data(await owner.post(`/groups/${low.id}/delete`));
    expect(await role()).toBeNull();
  });

  test("an added member's open socket starts hearing the space, and stops once removed", async () => {
    const space = await createSpace(owner, "Subscribed", `sub-${++counter}`);
    const page = await createPage(owner, { spaceId: space.id, title: "Ping" });
    const socket = await openSocket(outsider.client);
    const rename = async () => {
      data(await owner.post(`/pages/${page.id}/update`, { title: "Ping" }));
      return takeEvents(socket);
    };
    expect(await rename()).toEqual([]);
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "reader", userIds: [outsider.id] }));
    // Subscriptions are refreshed after the answer, so the first events may be missed.
    await until(async () => (await rename()).length > 0);
    expect(await rename()).toEqual([treeEvent(space.id), { t: "event", kind: "page", pageId: page.id, spaceId: space.id, title: "Ping", icon: null }]);
    data(await owner.post(`/spaces/${space.id}/members/remove`, { memberId: await memberRow(owner, space.id, outsider.id) }));
    await until(async () => (await rename()).length === 0);
    expect(await rename()).toEqual([]);
    await socket.close();
  });
});

describe("POST /spaces/:id/members/role", () => {
  test("changes the role of a user or a group", async () => {
    const space = await teamSpace("Roles");
    const group = data(await owner.post("/groups", { name: `Role group ${++counter}` })).group;
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "reader", groupIds: [group.id] }));
    const memberId = await memberRow(owner, space.id, reader.id);
    const groupRow = await memberRow(owner, space.id, group.id);
    for (const role of ["writer", "admin", "reader", "reader"]) {
      const res = await owner.post(`/spaces/${space.id}/members/role`, { memberId: memberId.toUpperCase(), role });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: {} });
      expect(data(await reader.client.get(`/spaces/${space.id}`)).space.role).toBe(role);
      data(await owner.post(`/spaces/${space.id}/members/role`, { memberId: groupRow, role }));
      expect(data(await owner.get(`/spaces/${space.id}/members`))[0]).toMatchObject({ id: groupRow, role });
    }
  });

  test("validates the member id and the role", async () => {
    const space = await teamSpace("Role rules");
    const memberId = await memberRow(owner, space.id, reader.id);
    const change = (body: unknown) => owner.post(`/spaces/${space.id}/members/role`, body);
    expectInvalid(await change({ role: "writer" }), "memberId must be a valid id");
    expectInvalid(await change({ memberId: "x", role: "writer" }), "memberId must be a valid id");
    expectInvalid(await change({ memberId: null, role: "writer" }), "memberId must be a valid id");
    expectInvalid(await change({ memberId }), "role is required");
    expectInvalid(await change({ memberId, role: "owner" }), "role must be one of admin, writer, reader");
    expectInvalid(await change({ memberId, role: null }), "role must be one of admin, writer, reader");
    expectNotFound(await change({ memberId: NO_SUCH_ID, role: "writer" }), "Space member");
    // The user's id is not the member row's id.
    expectNotFound(await change({ memberId: reader.id, role: "writer" }), "Space member");
    // A member row of another space.
    const other = await teamSpace("Other roles");
    expectNotFound(await change({ memberId: await memberRow(owner, other.id, reader.id), role: "writer" }), "Space member");
    expect(data(await reader.client.get(`/spaces/${other.id}`)).space.role).toBe("reader");
  });

  test("the last admin cannot be demoted; with a second admin either can", async () => {
    const space = await teamSpace("Last admin");
    const ownerRow = await memberRow(owner, space.id, ownerUser.id);
    const writerRow = await memberRow(owner, space.id, writer.id);
    const change = (client: Client, memberId: string, role: string) => client.post(`/spaces/${space.id}/members/role`, { memberId, role });
    expectForbidden(await change(owner, ownerRow, "writer"), "The last space admin cannot be demoted");
    expectForbidden(await change(owner, ownerRow, "reader"), "The last space admin cannot be demoted");
    // Not even by a workspace admin.
    expectForbidden(await change(admin.client, ownerRow, "writer"), "The last space admin cannot be demoted");
    // Setting the last admin to admin again changes nothing and is allowed.
    expect(data(await change(owner, ownerRow, "admin"))).toEqual({});
    data(await change(owner, writerRow, "admin"));
    // The new admin demotes the first one, and then is the last.
    expect(data(await change(writer.client, ownerRow, "reader"))).toEqual({});
    expect(data(await owner.get(`/spaces/${space.id}`)).space.role).toBe("reader");
    expectForbidden(await change(writer.client, writerRow, "writer"), "The last space admin cannot be demoted");
    expectForbidden(await change(owner, writerRow, "writer"), "The last space admin cannot be demoted");
  });

  test("a group with the admin role counts as an admin, even an empty one", async () => {
    const space = await createSpace(owner, "Group admin", `gadmin-${++counter}`);
    const empty = data(await owner.post("/groups", { name: `Empty ${++counter}` })).group;
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "admin", groupIds: [empty.id] }));
    const ownerRow = await memberRow(owner, space.id, ownerUser.id);
    expect(data(await owner.post(`/spaces/${space.id}/members/role`, { memberId: ownerRow, role: "reader" }))).toEqual({});
    expectForbidden(await owner.post(`/spaces/${space.id}/members/role`, { memberId: await memberRow(owner, space.id, empty.id), role: "writer" }), "The last space admin cannot be demoted");
  });

  test("the last admin can be demoted through members/add", async () => {
    const space = await createSpace(owner, "Loophole", `loophole-${++counter}`);
    // Accident: adding an existing member again sets their role without the last-admin check of members/role.
    expect(data(await owner.post(`/spaces/${space.id}/members/add`, { role: "reader", userIds: [ownerUser.id] }))).toEqual({});
    expect(data(await owner.get(`/spaces/${space.id}`)).space.role).toBe("reader");
    expect(data(await owner.get(`/spaces/${space.id}/members`)).map((m: any) => m.role)).toEqual(["reader"]);
  });

  test("only space admins and workspace admins may change roles", async () => {
    const space = await teamSpace("Role guard");
    const memberId = await memberRow(owner, space.id, reader.id);
    expectForbidden(await writer.client.post(`/spaces/${space.id}/members/role`, { memberId, role: "admin" }));
    expectForbidden(await reader.client.post(`/spaces/${space.id}/members/role`, { memberId, role: "admin" }));
    expectNotFound(await outsider.client.post(`/spaces/${space.id}/members/role`, { memberId, role: "admin" }), "Space");
    expectNotFound(await owner.post(`/spaces/${NO_SUCH_ID}/members/role`, { memberId, role: "admin" }), "Space");
    expect(data(await admin.client.post(`/spaces/${space.id}/members/role`, { memberId, role: "writer" }))).toEqual({});
    expect(data(await reader.client.get(`/spaces/${space.id}`)).space.role).toBe("writer");
  });
});

describe("POST /spaces/:id/members/remove", () => {
  test("removes a user or a group; the removed lose the space", async () => {
    const space = await teamSpace("Leaving");
    const group = data(await owner.post("/groups", { name: `Leaving group ${++counter}` })).group;
    data(await owner.post(`/groups/${group.id}/members/add`, { userIds: [outsider.id] }));
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "writer", groupIds: [group.id] }));
    expect(data(await outsider.client.get(`/spaces/${space.id}`)).space.role).toBe("writer");
    const res = await owner.post(`/spaces/${space.id}/members/remove`, { memberId: await memberRow(owner, space.id, group.id) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: {} });
    expectNotFound(await outsider.client.get(`/spaces/${space.id}`), "Space");
    const memberId = await memberRow(owner, space.id, reader.id);
    expect(data(await owner.post(`/spaces/${space.id}/members/remove`, { memberId: memberId.toUpperCase() }))).toEqual({});
    expectNotFound(await reader.client.get(`/spaces/${space.id}`), "Space");
    expect(data(await owner.get(`/spaces/${space.id}`)).space.memberCount).toBe(2);
    // Removing twice: the row is gone.
    expectNotFound(await owner.post(`/spaces/${space.id}/members/remove`, { memberId }), "Space member");
  });

  test("validates the member id", async () => {
    const space = await teamSpace("Remove rules");
    const remove = (body: unknown) => owner.post(`/spaces/${space.id}/members/remove`, body);
    expectInvalid(await remove({}), "memberId must be a valid id");
    expectInvalid(await remove({ memberId: 1 }), "memberId must be a valid id");
    expectInvalid(await remove({ memberId: "abc" }), "memberId must be a valid id");
    expectNotFound(await remove({ memberId: NO_SUCH_ID }), "Space member");
    expectNotFound(await remove({ memberId: writer.id }), "Space member");
    const other = await teamSpace("Remove elsewhere");
    expectNotFound(await remove({ memberId: await memberRow(owner, other.id, writer.id) }), "Space member");
    expect(data(await owner.get(`/spaces/${other.id}`)).space.memberCount).toBe(3);
  });

  test("the last admin cannot be removed; an admin may leave once there is another", async () => {
    const space = await teamSpace("Last one out");
    const ownerRow = await memberRow(owner, space.id, ownerUser.id);
    const remove = (client: Client, memberId: string) => client.post(`/spaces/${space.id}/members/remove`, { memberId });
    expectForbidden(await remove(owner, ownerRow), "The last space admin cannot be removed");
    expectForbidden(await remove(admin.client, ownerRow), "The last space admin cannot be removed");
    data(await owner.post(`/spaces/${space.id}/members/role`, { memberId: await memberRow(owner, space.id, writer.id), role: "admin" }));
    expect(data(await remove(owner, ownerRow))).toEqual({});
    // The owner is a workspace admin and still sees the space, without a role.
    expect(data(await owner.get(`/spaces/${space.id}`)).space).toMatchObject({ role: null, memberCount: 2 });
    expectForbidden(await remove(writer.client, await memberRow(writer.client, space.id, writer.id)), "The last space admin cannot be removed");
    // A member who is not an admin can always be removed.
    expect(data(await remove(writer.client, await memberRow(writer.client, space.id, reader.id)))).toEqual({});
  });

  test("only space admins and workspace admins may remove members", async () => {
    const space = await teamSpace("Remove guard");
    const memberId = await memberRow(owner, space.id, reader.id);
    expectForbidden(await writer.client.post(`/spaces/${space.id}/members/remove`, { memberId }));
    expectForbidden(await reader.client.post(`/spaces/${space.id}/members/remove`, { memberId }));
    expectNotFound(await outsider.client.post(`/spaces/${space.id}/members/remove`, { memberId }), "Space");
    expectNotFound(await owner.post(`/spaces/${NO_SUCH_ID}/members/remove`, { memberId }), "Space");
    expect(data(await admin.client.post(`/spaces/${space.id}/members/remove`, { memberId }))).toEqual({});
  });
});

describe("membership and open editors", () => {
  test("someone editing a page is made read-only when demoted to reader, and turned out when removed", async () => {
    const space = await createSpace(owner, "Editors", `editors-${++counter}`);
    const editor = await person(t, owner, `editor-${counter}@example.com`, { space: space.id, spaceRole: "writer" });
    const page = await createPage(owner, { spaceId: space.id, title: "Open" });
    const socket = await openSocket(editor.client);
    socket.send({ t: "join", pageId: page.id, version: 0 });
    expect(await socket.nextOf("joined")).toEqual({ t: "joined", pageId: page.id, version: 0, readOnly: false });
    const memberId = await memberRow(owner, space.id, editor.id);
    data(await owner.post(`/spaces/${space.id}/members/role`, { memberId, role: "reader" }));
    expect(await socket.nextOf("joined")).toEqual({ t: "joined", pageId: page.id, version: 0, readOnly: true });
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "admin", userIds: [editor.id] }));
    expect(await socket.nextOf("joined")).toEqual({ t: "joined", pageId: page.id, version: 0, readOnly: false });
    data(await owner.post(`/spaces/${space.id}/members/remove`, { memberId }));
    expect(await socket.nextOf("error")).toEqual({ t: "error", pageId: page.id, message: "You no longer have access to this page" });
    await socket.close();
  });

  test("deleting the space turns its editors out", async () => {
    const space = await createSpace(owner, "Editors gone", `editors-${++counter}`);
    const page = await createPage(owner, { spaceId: space.id, title: "Open" });
    const socket = await openSocket(owner);
    socket.send({ t: "join", pageId: page.id, version: 0 });
    expect((await socket.nextOf("joined")).readOnly).toBe(false);
    data(await owner.post(`/spaces/${space.id}/delete`));
    expect(await socket.nextOf("error")).toEqual({ t: "error", pageId: page.id, message: "You no longer have access to this page" });
    await socket.close();
  });
});

describe("characters the database refuses", () => {
  test("a NUL character in a name or a description is a server error", async () => {
    // Accident: PostgreSQL refuses the character and the failure surfaces as a 500 instead of a 400.
    expectError(await owner.post("/spaces", { name: "a\u0000b", slug: "nul-name" }), 500, "internal_error", "Something went wrong");
    expectError(await owner.post("/spaces", { name: "ok", slug: "nul-description", description: "\u0000" }), 500, "internal_error", "Something went wrong");
    expectNotFound(await owner.get("/spaces/nul-name"), "Space");
  });
});

describe("POST /spaces/:id/delete", () => {
  test("only space admins and workspace admins may delete", async () => {
    const space = await teamSpace("Delete guard");
    expectForbidden(await writer.client.post(`/spaces/${space.id}/delete`));
    expectForbidden(await reader.client.post(`/spaces/${space.id}/delete`));
    expectNotFound(await outsider.client.post(`/spaces/${space.id}/delete`), "Space");
    expectNotFound(await owner.post(`/spaces/${space.slug}/delete`), "Space");
    expectNotFound(await owner.post(`/spaces/${NO_SUCH_ID}/delete`), "Space");
    expect(data(await owner.get(`/spaces/${space.id}`)).space.id).toBe(space.id);
    const res = await admin.client.post(`/spaces/${space.id.toUpperCase()}/delete`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: {} });
    expectNotFound(await owner.get(`/spaces/${space.id}`), "Space");
    expectNotFound(await admin.client.post(`/spaces/${space.id}/delete`), "Space");
  });

  test("takes the pages, their files, the icon, favorites and watches with it, and leaves other spaces alone", async () => {
    const space = await teamSpace("Doomed");
    const kept = await teamSpace("Kept");
    const page = await createPage(owner, { spaceId: space.id, title: "Doomed page" });
    const child = await createPage(writer.client, { spaceId: space.id, parentId: page.id, title: "Doomed child" });
    const trashed = await createPage(owner, { spaceId: space.id, title: "Doomed and trashed" });
    const keptPage = await createPage(owner, { spaceId: kept.id, title: "Kept page" });
    const file = data(await writer.client.uploadFile(new File(["doomed bytes"], "doomed.txt", { type: "text/plain" }), child.id));
    const trashedFile = data(await owner.uploadFile(new File(["trashed bytes"], "trashed.txt", { type: "text/plain" }), trashed.id));
    const keptFile = data(await owner.uploadFile(new File(["kept bytes"], "kept.txt", { type: "text/plain" }), keptPage.id));
    data(await owner.post(`/pages/${trashed.id}/delete`));
    const icon: string = data(await uploadIcon(owner, space.id, PNG)).space.iconUrl.slice("/api/images/".length);
    const keptIcon: string = data(await uploadIcon(owner, kept.id, GIF)).space.iconUrl.slice("/api/images/".length);
    for (const body of [{ pageId: page.id }, { spaceId: space.id }, { pageId: keptPage.id }, { spaceId: kept.id }]) {
      data(await reader.client.post("/favorites", body));
    }
    data(await reader.client.post(`/spaces/${space.id}/watch`, { watching: true }));
    data(await reader.client.post(`/pages/${page.id}/watch`, { watching: true }));
    data(await owner.post(`/pages/${page.id}/labels`, { names: ["doomed-label"] }));
    data(await owner.post("/comments", { pageId: page.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "bye" }] }] } }));
    data(await owner.post(`/pages/${page.id}/share`, {}));
    const onDisk = (...parts: string[]) => existsSync(path.join(t.storageDir, ...parts));
    expect([onDisk("files", file.id, "doomed.txt"), onDisk("files", trashedFile.id, "trashed.txt"), onDisk("images", icon)]).toEqual([true, true, true]);

    const socket = await openSocket(reader.client);
    const res = await writer.client.post(`/spaces/${space.id}/delete`);
    expectForbidden(res);
    data(await owner.post(`/spaces/${space.id}/members/role`, { memberId: await memberRow(owner, space.id, writer.id), role: "admin" }));
    await takeEvents(socket);
    expect(data(await writer.client.post(`/spaces/${space.id}/delete`))).toEqual({});
    // Nobody is told over the socket: members find out when they next ask.
    expect(await takeEvents(socket)).toEqual([]);
    await socket.close();

    for (const who of [owner, writer.client, reader.client, admin.client]) {
      expectNotFound(await who.get(`/spaces/${space.id}`), "Space");
      expectNotFound(await who.get(`/pages/${page.id}`), "Page");
      expectNotFound(await who.get(`/pages/${child.slugId}`), "Page");
    }
    expectNotFound(await owner.get(`/spaces/${space.id}/pages`), "Space");
    expectNotFound(await owner.get(`/spaces/${space.id}/members`), "Space");
    expect((await owner.raw("GET", `/files/${file.id}/doomed.txt`)).status).toBe(404);
    expect((await t.client().fetch(`/api/images/${icon}`)).status).toBe(404);
    expect([onDisk("files", file.id, "doomed.txt"), onDisk("files", file.id), onDisk("files", trashedFile.id), onDisk("images", icon)]).toEqual([false, false, false, false]);
    expect(data(await owner.get("/spaces")).map((s: any) => s.id)).not.toContain(space.id);
    expect(data(await owner.get("/spaces/all")).map((s: any) => s.id)).not.toContain(space.id);
    const [counts] = await t.sql`
      SELECT (SELECT count(*)::int FROM spaces WHERE id = ${space.id}) AS spaces,
        (SELECT count(*)::int FROM pages WHERE space_id = ${space.id}) AS pages,
        (SELECT count(*)::int FROM space_members WHERE space_id = ${space.id}) AS members,
        (SELECT count(*)::int FROM files WHERE id IN (${file.id}, ${trashedFile.id}) OR name = ${icon}) AS files,
        (SELECT count(*)::int FROM favorites WHERE user_id = ${reader.id}) AS favorites,
        (SELECT count(*)::int FROM watchers WHERE user_id = ${reader.id}) AS watchers,
        (SELECT count(*)::int FROM comments WHERE page_id = ${page.id}) AS comments,
        (SELECT count(*)::int FROM shares WHERE page_id = ${page.id}) AS shares,
        (SELECT count(*)::int FROM page_labels WHERE page_id = ${page.id}) AS page_labels`;
    expect(counts).toEqual({ spaces: 0, pages: 0, members: 0, files: 0, favorites: 2, watchers: 0, comments: 0, shares: 0, page_labels: 0 });

    // The other space is whole.
    const favorites = data(await reader.client.get("/favorites"));
    expect(favorites.pages.map((p: any) => p.id)).toEqual([keptPage.id]);
    expect(favorites.spaces.map((s: any) => s.id)).toEqual([kept.id]);
    expect(await (await owner.raw("GET", `/files/${keptFile.id}/kept.txt`)).text()).toBe("kept bytes");
    expect((await t.client().fetch(`/api/images/${keptIcon}`)).status).toBe(200);
    expect(data(await owner.get(`/spaces/${kept.id}`)).space.iconUrl).toBe(`/api/images/${keptIcon}`);
    // The slug is free again.
    expect(data(await owner.post("/spaces", { name: "Reborn", slug: space.slug })).space.slug).toBe(space.slug);
  });

  test("deleting the default space leaves the workspace without one", async () => {
    expect(data(await owner.get("/me")).workspace.defaultSpaceId).toBe(generalId);
    expect(data(await owner.post(`/spaces/${generalId}/delete`))).toEqual({});
    expect(data(await owner.get("/me")).workspace.defaultSpaceId).toBeNull();
    expectNotFound(await owner.get("/spaces/general"), "Space");
  });
});
