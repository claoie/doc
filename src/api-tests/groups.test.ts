import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, startServer, until, type Client, type Socket, type TestServer } from "./harness";
import { NOT_ADMIN, UNAUTHORIZED, UUID, expectApiHeaders, expectBody, expectError, expectInvalid, rows, userShape } from "./harness/admin";

/* Groups: the default group `Everyone` and the ones admins make. */

let t: TestServer;
let owner: Client;
let ownerUser: any;
let admin: Client;
let adminUser: any;
let member: Client;
let memberUser: any;
let everyoneId: string;
let serial = 0;

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const TAKEN = { error: { code: "name_taken", message: "A group with this name already exists" } };

/** A new group with a name of its own. */
const newGroup = async (name = `Group ${++serial}`, description?: string | null) => {
  const res = await owner.post("/groups", { name, ...(description === undefined ? {} : { description }) });
  if (res.status !== 200) throw new Error(`creating the group failed: ${res.text}`);
  return res.body.data.group as { id: string; name: string; description: string | null; isDefault: boolean; memberCount: number };
};

/** Everyone is in the default group, so its size is the number of users. */
const userCount = async (): Promise<number> => (await rows(t.sql`SELECT count(*)::int AS n FROM users`))[0].n;

const group = async (id: string, client: Client = owner) => (await client.get("/groups")).body.data.find((g: any) => g.id === id);

beforeAll(async () => {
  t = await startServer();
  ({ owner, user: ownerUser } = await t.setupOwner());
  ({ client: admin, user: adminUser } = await t.addMember(owner, "admin@example.com", "admin"));
  ({ client: member, user: memberUser } = await t.addMember(owner, "member@example.com"));
  everyoneId = (await owner.get("/groups")).body.data[0].id;
});

afterAll(async () => {
  await t.close();
});

describe("GET /groups", () => {
  test("lists the default group first, then the others by name whatever their case, with their member counts", async () => {
    const beta = await newGroup("list beta");
    const alpha = await newGroup("List Alpha", "First by name");
    const gamma = await newGroup("LIST gamma");
    await owner.post(`/groups/${beta.id}/members/add`, { userIds: [memberUser.id, adminUser.id] });
    const res = await member.get("/groups");
    expectBody(res, 200, {
      data: [
        { id: everyoneId, name: "Everyone", description: "Every member of the workspace", isDefault: true, memberCount: await userCount() },
        { id: alpha.id, name: "List Alpha", description: "First by name", isDefault: false, memberCount: 0 },
        { id: beta.id, name: "list beta", description: null, isDefault: false, memberCount: 2 },
        { id: gamma.id, name: "LIST gamma", description: null, isDefault: false, memberCount: 0 },
      ],
    });
    expectApiHeaders(res.headers);
    expect(everyoneId).toMatch(UUID);
    expectBody(await owner.get("/groups"), 200, res.body);
    for (const g of [alpha, beta, gamma]) await owner.post(`/groups/${g.id}/delete`);
  });

  test("needs a session", async () => {
    expectBody(await t.client().get("/groups"), 401, UNAUTHORIZED);
  });
});

describe("POST /groups", () => {
  test("creates an empty group; the name is trimmed and a blank description is none", async () => {
    const res = await admin.post("/groups", { name: "  Designers \n", description: "  People who draw  ", isDefault: true, memberCount: 9, extra: 1 });
    expectBody(res, 200, { data: { group: { id: expect.stringMatching(UUID), name: "Designers", description: "People who draw", isDefault: false, memberCount: 0 } } });
    expectApiHeaders(res.headers);
    const id = res.body.data.group.id;
    expect(await rows(t.sql`SELECT name, description, is_default, created_by FROM groups WHERE id = ${id}`)).toEqual([
      { name: "Designers", description: "People who draw", is_default: false, created_by: adminUser.id },
    ]);
    expect(await group(id, member)).toEqual(res.body.data.group);
    for (const description of [undefined, null, "", "   "]) {
      const created = await newGroup(undefined, description);
      expect(created.description).toBeNull();
    }
  });

  test("names and descriptions take any script, up to 100 and 500 code points", async () => {
    for (const name of ["Ünïcode", "開発チーム", "👩‍💻 Devs 🎉", "فريق", 'A & "B" <c>', "g", "🎉".repeat(100)]) {
      const res = await owner.post("/groups", { name, description: "🎉".repeat(500) });
      expect({ name, status: res.status, answered: res.body.data?.group.name }).toEqual({ name, status: 200, answered: name });
      expect(res.body.data.group.description).toBe("🎉".repeat(500));
    }
  });

  test.each([
    ["no name", {}, "name must be a string"],
    ["a name that is null", { name: null }, "name must be a string"],
    ["a name that is a number", { name: 5 }, "name must be a string"],
    ["an empty name", { name: "" }, "name is required"],
    ["a blank name", { name: "   " }, "name is required"],
    ["a name of 101 characters", { name: "g".repeat(101) }, "name must be at most 100 characters"],
    ["a name of 101 emoji", { name: "🎉".repeat(101) }, "name must be at most 100 characters"],
    ["a description that is a number", { name: "Fine", description: 5 }, "description must be a string"],
    ["a description that is a list", { name: "Fine", description: ["x"] }, "description must be a string"],
    ["a description of 501 characters", { name: "Fine", description: "d".repeat(501) }, "description must be at most 500 characters"],
  ] as [string, Record<string, unknown>, string][])("refuses %s", async (_what, body, message) => {
    expectInvalid(await owner.post("/groups", body), message);
  });

  test("a name that exists is refused, whatever its case, the default group's included", async () => {
    const existing = await newGroup("Taken Name");
    for (const name of ["Taken Name", "taken name", "TAKEN NAME", "  Taken Name  ", "Everyone", "everyone", "EVERYONE"]) {
      const res = await owner.post("/groups", { name });
      expectBody(res, 409, TAKEN);
      expectApiHeaders(res.headers);
    }
    expect((await owner.get("/groups")).body.data.filter((g: any) => g.name.toLowerCase() === "taken name")).toEqual([existing]);
  });

  test("members cannot create groups, whatever they send", async () => {
    expectBody(await member.post("/groups", { name: "Mine" }), 403, NOT_ADMIN);
    expectBody(await member.post("/groups", {}), 403, NOT_ADMIN);
    expectBody(await t.client().post("/groups", { name: "Mine" }), 401, UNAUTHORIZED);
  });
});

describe("POST /groups/:id/update", () => {
  test("changes the name and the description; absent fields stay, a blank description is cleared", async () => {
    const g = await newGroup("Before", "Old words");
    await owner.post(`/groups/${g.id}/members/add`, { userIds: [memberUser.id] });
    const renamed = await admin.post(`/groups/${g.id}/update`, { name: "  After  " });
    expectBody(renamed, 200, { data: { group: { id: g.id, name: "After", description: "Old words", isDefault: false, memberCount: 1 } } });
    expectApiHeaders(renamed.headers);
    expect((await owner.post(`/groups/${g.id}/update`, { description: " New words " })).body.data.group).toEqual({ ...g, name: "After", description: "New words", memberCount: 1 });
    expect((await owner.post(`/groups/${g.id}/update`, {})).body.data.group).toEqual({ ...g, name: "After", description: "New words", memberCount: 1 });
    for (const cleared of [null, "", "  "]) {
      await owner.post(`/groups/${g.id}/update`, { description: "Again" });
      expect((await owner.post(`/groups/${g.id}/update`, { description: cleared })).body.data.group.description).toBeNull();
    }
    expect((await owner.post(`/groups/${g.id.toUpperCase()}/update`, { name: "Upper id" })).body.data.group.name).toBe("Upper id");
    expect(await group(g.id, member)).toEqual({ ...g, name: "Upper id", description: null, memberCount: 1 });
  });

  test("a group may change the case of its own name, but not take another group's", async () => {
    const one = await newGroup("Rename One");
    const two = await newGroup("Rename Two");
    expect((await owner.post(`/groups/${one.id}/update`, { name: "RENAME ONE" })).body.data.group.name).toBe("RENAME ONE");
    expect((await owner.post(`/groups/${one.id}/update`, { name: "RENAME ONE" })).status).toBe(200);
    for (const name of ["Rename Two", "rename two", "Everyone", "everyone"]) {
      expectBody(await owner.post(`/groups/${one.id}/update`, { name, description: "not applied" }), 409, TAKEN);
    }
    expect(await group(one.id)).toEqual({ ...one, name: "RENAME ONE" });
    expect(await group(two.id)).toEqual(two);
  });

  test("the default group cannot be renamed, but its description can change", async () => {
    for (const name of ["All", "everyone", "EVERYONE", "Everyone!"]) {
      expectError(await owner.post(`/groups/${everyoneId}/update`, { name, description: "not applied" }), 403, "forbidden", "The default group cannot be renamed");
    }
    expect((await group(everyoneId)).description).toBe("Every member of the workspace");
    // Its own name, exactly, is no rename.
    const res = await owner.post(`/groups/${everyoneId}/update`, { name: " Everyone ", description: "All of us" });
    expectBody(res, 200, { data: { group: { id: everyoneId, name: "Everyone", description: "All of us", isDefault: true, memberCount: await userCount() } } });
    await owner.post(`/groups/${everyoneId}/update`, { description: "Every member of the workspace" });
  });

  test("invalid fields are refused", async () => {
    const g = await newGroup();
    expectInvalid(await owner.post(`/groups/${g.id}/update`, { name: null }), "name must be a string");
    expectInvalid(await owner.post(`/groups/${g.id}/update`, { name: 5 }), "name must be a string");
    expectInvalid(await owner.post(`/groups/${g.id}/update`, { name: "  " }), "name is required");
    expectInvalid(await owner.post(`/groups/${g.id}/update`, { name: "g".repeat(101) }), "name must be at most 100 characters");
    expectInvalid(await owner.post(`/groups/${g.id}/update`, { description: 5 }), "description must be a string");
    expectInvalid(await owner.post(`/groups/${g.id}/update`, { description: "d".repeat(501) }), "description must be at most 500 characters");
    expect((await owner.post(`/groups/${g.id}/update`, { name: "g".repeat(100), description: "d".repeat(500) })).status).toBe(200);
  });

  test("an unknown group is a 404 before the body is read; a member is refused before that", async () => {
    for (const id of [UNKNOWN, "nope", "123", `${everyoneId}x`]) {
      expectError(await owner.post(`/groups/${id}/update`, { name: 5 }), 404, "not_found", "Group not found");
      expectBody(await member.post(`/groups/${id}/update`, { name: "X" }), 403, NOT_ADMIN);
    }
    expectBody(await member.post(`/groups/${everyoneId}/update`, { description: "X" }), 403, NOT_ADMIN);
    expectBody(await t.client().post(`/groups/${everyoneId}/update`, {}), 401, UNAUTHORIZED);
  });
});

describe("POST /groups/:id/delete", () => {
  test("deletes the group with its memberships; the users stay", async () => {
    const g = await newGroup();
    await owner.post(`/groups/${g.id}/members/add`, { userIds: [memberUser.id, adminUser.id] });
    const res = await admin.post(`/groups/${g.id}/delete`);
    expectBody(res, 200, { data: {} });
    expectApiHeaders(res.headers);
    expect(await group(g.id)).toBeUndefined();
    expect(await rows(t.sql`SELECT 1 AS n FROM group_members WHERE group_id = ${g.id}`)).toEqual([]);
    expectError(await owner.get(`/groups/${g.id}/members`), 404, "not_found", "Group not found");
    expectError(await owner.post(`/groups/${g.id}/delete`), 404, "not_found", "Group not found");
    expect((await member.get("/me")).status).toBe(200);
    // Its name is free again.
    expect((await owner.post("/groups", { name: g.name })).status).toBe(200);
  });

  test("the default group cannot be deleted", async () => {
    expectError(await owner.post(`/groups/${everyoneId}/delete`), 403, "forbidden", "The default group cannot be deleted");
    expect((await group(everyoneId)).memberCount).toBe(await userCount());
  });

  test("an unknown group is a 404; members are refused first", async () => {
    const g = await newGroup();
    for (const id of [UNKNOWN, "nope"]) {
      expectError(await owner.post(`/groups/${id}/delete`), 404, "not_found", "Group not found");
      expectBody(await member.post(`/groups/${id}/delete`), 403, NOT_ADMIN);
    }
    expectBody(await member.post(`/groups/${g.id}/delete`), 403, NOT_ADMIN);
    expectBody(await t.client().post(`/groups/${g.id}/delete`), 401, UNAUTHORIZED);
    expect(await group(g.id)).toEqual(g);
  });
});

describe("GET /groups/:id/members", () => {
  let g: { id: string };
  let people: any[];

  beforeAll(async () => {
    // Five members whose names sort as ann, Bob, bob, cy, Dee; the two bobs by their ids.
    g = await newGroup();
    people = [];
    for (const name of ["cy", "Bob", "ann", "bob", "Dee"]) {
      const invited = await owner.post("/invitations", { emails: [`listed-${people.length}@example.com`] });
      const link = new URL(invited.body.data[0].url);
      const accepted = await t.client().post("/invitations/accept", { id: link.pathname.split("/").pop(), token: link.searchParams.get("token"), name, password: "member-password" });
      people.push(accepted.body.data.user);
    }
    await owner.post(`/groups/${g.id}/members/add`, { userIds: people.map((p) => p.id) });
  });

  const sorted = () => {
    const byName = (name: string) => people.filter((p) => p.name === name);
    const bobs = [...byName("Bob"), ...byName("bob")].sort((a, b) => (a.id < b.id ? -1 : 1));
    return [...byName("ann"), ...bobs, ...byName("cy"), ...byName("Dee")];
  };

  test("lists the members by name, then id, as users without their preferences, with the total", async () => {
    const res = await member.get(`/groups/${g.id}/members`);
    expectBody(res, 200, { data: { items: sorted().map((p) => userShape({ id: p.id, email: p.email, name: p.name })), total: 5 } });
    expectApiHeaders(res.headers);
    expect(Object.keys(res.body.data.items[0]).sort()).toEqual(["avatarUrl", "createdAt", "email", "id", "lastLoginAt", "locale", "name", "preferences", "role", "timezone"]);
  });

  test("limit and offset page through them; the total is always the whole group", async () => {
    const ids = sorted().map((p) => p.id);
    const page = async (query: string) => {
      const res = await owner.get(`/groups/${g.id}/members${query}`);
      return { status: res.status, ids: res.body.data.items.map((p: any) => p.id), total: res.body.data.total };
    };
    expect(await page("?limit=2")).toEqual({ status: 200, ids: ids.slice(0, 2), total: 5 });
    expect(await page("?limit=2&offset=2")).toEqual({ status: 200, ids: ids.slice(2, 4), total: 5 });
    expect(await page("?limit=2&offset=4")).toEqual({ status: 200, ids: ids.slice(4), total: 5 });
    expect(await page("?offset=5")).toEqual({ status: 200, ids: [], total: 5 });
    expect(await page("?offset=1000000")).toEqual({ status: 200, ids: [], total: 5 });
    expect(await page("?limit=1&offset=0")).toEqual({ status: 200, ids: ids.slice(0, 1), total: 5 });
    expect(await page("?limit=500")).toEqual({ status: 200, ids, total: 5 });
    // Empty values mean the defaults (50 and 0), and of a repeated parameter the last counts.
    expect(await page("?limit=&offset=")).toEqual({ status: 200, ids, total: 5 });
    expect(await page("?limit=4&limit=1")).toEqual({ status: 200, ids: ids.slice(0, 1), total: 5 });
    // Numbers are read as JavaScript reads them.
    expect(await page("?limit=%202%20&offset=1e0")).toEqual({ status: 200, ids: ids.slice(1, 3), total: 5 });
  });

  test("the default page is 50 members", async () => {
    const res = await owner.get(`/groups/${everyoneId}/members`);
    expect(res.body.data.total).toBe((await group(everyoneId)).memberCount);
    expect(res.body.data.items.length).toBe(Math.min(50, res.body.data.total));
  });

  test("limit must be 1 to 500 and offset 0 to 1000000", async () => {
    for (const limit of ["0", "501", "-1", "1.5", "abc", "1e3", "Infinity", "0x1G"]) {
      expectInvalid(await owner.get(`/groups/${g.id}/members?limit=${limit}`), "limit must be an integer between 1 and 500");
    }
    for (const offset of ["-1", "1000001", "0.5", "abc", "NaN"]) {
      expectInvalid(await owner.get(`/groups/${g.id}/members?offset=${offset}`), "offset must be an integer between 0 and 1000000");
    }
    expectInvalid(await owner.get(`/groups/${g.id}/members?limit=0&offset=-1`), "limit must be an integer between 1 and 500");
  });

  test("the viewer's own entry carries their preferences, nobody else's does", async () => {
    await member.post("/me/update", { preferences: { theme: "dark" } });
    const mine = (await member.get(`/groups/${everyoneId}/members?limit=500`)).body.data.items.find((p: any) => p.id === memberUser.id);
    const seen = (await owner.get(`/groups/${everyoneId}/members?limit=500`)).body.data.items.find((p: any) => p.id === memberUser.id);
    expect(mine.preferences).toEqual({ theme: "dark" });
    expect(seen.preferences).toEqual({});
    await member.post("/me/update", { preferences: { theme: null } });
  });

  test("an unknown group is a 404 before the query is looked at", async () => {
    for (const id of [UNKNOWN, "nope", "everyone"]) {
      expectError(await member.get(`/groups/${id}/members?limit=0`), 404, "not_found", "Group not found");
    }
    expectBody(await t.client().get(`/groups/${g.id}/members`), 401, UNAUTHORIZED);
  });
});

describe("POST /groups/:id/members/add", () => {
  test("adds users; ones already in it, unknown ones and repeats are passed over", async () => {
    const g = await newGroup();
    const res = await admin.post(`/groups/${g.id}/members/add`, { userIds: [memberUser.id] });
    expectBody(res, 200, { data: {} });
    expectApiHeaders(res.headers);
    expect((await group(g.id)).memberCount).toBe(1);
    expectBody(await owner.post(`/groups/${g.id}/members/add`, { userIds: [memberUser.id, UNKNOWN, adminUser.id.toUpperCase(), adminUser.id, ownerUser.id, ownerUser.id] }), 200, { data: {} });
    expect((await group(g.id)).memberCount).toBe(3);
    expect((await owner.get(`/groups/${g.id}/members`)).body.data.items.map((p: any) => p.id).sort()).toEqual([memberUser.id, adminUser.id, ownerUser.id].sort());
    expectBody(await owner.post(`/groups/${g.id}/members/add`, { userIds: [UNKNOWN] }), 200, { data: {} });
    expect((await group(g.id)).memberCount).toBe(3);
  });

  test("a deactivated member can be added", async () => {
    const g = await newGroup();
    const { user } = await t.addMember(owner, "group-inactive@example.com");
    await owner.post("/members/deactivate", { userId: user.id });
    expectBody(await owner.post(`/groups/${g.id}/members/add`, { userIds: [user.id] }), 200, { data: {} });
    expect((await owner.get(`/groups/${g.id}/members`)).body.data.items.map((p: any) => p.id)).toEqual([user.id]);
  });

  test("the list is required, holds at most 100 ids, and only ids", async () => {
    const g = await newGroup();
    const many = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expectInvalid(await owner.post(`/groups/${g.id}/members/add`, {}), "userIds is required");
    expectInvalid(await owner.post(`/groups/${g.id}/members/add`, { userIds: [] }), "userIds is required");
    for (const userIds of [null, memberUser.id, 5, { 0: memberUser.id }, many(101)]) {
      expectInvalid(await owner.post(`/groups/${g.id}/members/add`, { userIds }), "userIds must be a list of at most 100 ids");
    }
    for (const userIds of [["nope"], [memberUser.id, 5], [null], [memberUser.id, ""], [`${memberUser.id} `]]) {
      expectInvalid(await owner.post(`/groups/${g.id}/members/add`, { userIds }), "userIds must contain valid ids");
    }
    expectBody(await owner.post(`/groups/${g.id}/members/add`, { userIds: [...many(99), memberUser.id] }), 200, { data: {} });
    expect((await group(g.id)).memberCount).toBe(1);
  });

  test("an unknown group is a 404 before the body is read; members are refused first", async () => {
    expectError(await owner.post(`/groups/${UNKNOWN}/members/add`, { userIds: "x" }), 404, "not_found", "Group not found");
    expectError(await owner.post("/groups/nope/members/add", { userIds: [memberUser.id] }), 404, "not_found", "Group not found");
    expectBody(await member.post(`/groups/${UNKNOWN}/members/add`, { userIds: [memberUser.id] }), 403, NOT_ADMIN);
    expectBody(await member.post(`/groups/${everyoneId}/members/add`, {}), 403, NOT_ADMIN);
    expectBody(await t.client().post(`/groups/${everyoneId}/members/add`, { userIds: [memberUser.id] }), 401, UNAUTHORIZED);
  });
});

describe("POST /groups/:id/members/remove", () => {
  test("removes a member; removing someone who is not in the group does nothing", async () => {
    const g = await newGroup();
    await owner.post(`/groups/${g.id}/members/add`, { userIds: [memberUser.id, adminUser.id] });
    const res = await admin.post(`/groups/${g.id}/members/remove`, { userId: memberUser.id.toUpperCase() });
    expectBody(res, 200, { data: {} });
    expectApiHeaders(res.headers);
    expect((await owner.get(`/groups/${g.id}/members`)).body.data).toEqual({ items: [expect.objectContaining({ id: adminUser.id })], total: 1 });
    expectBody(await owner.post(`/groups/${g.id}/members/remove`, { userId: memberUser.id }), 200, { data: {} });
    expectBody(await owner.post(`/groups/${g.id}/members/remove`, { userId: UNKNOWN }), 200, { data: {} });
    expect((await group(g.id)).memberCount).toBe(1);
    // They are still in the default group.
    expect((await owner.get(`/groups/${everyoneId}/members?limit=500`)).body.data.items.some((p: any) => p.id === memberUser.id)).toBe(true);
  });

  test("nobody can be removed from the default group", async () => {
    for (const userId of [memberUser.id, ownerUser.id, UNKNOWN]) {
      expectError(await owner.post(`/groups/${everyoneId}/members/remove`, { userId }), 403, "forbidden", "Members cannot be removed from the default group");
    }
    expect((await owner.get(`/groups/${everyoneId}/members?limit=500`)).body.data.items.some((p: any) => p.id === memberUser.id)).toBe(true);
  });

  test("the user id must be a UUID, which is checked before the default group's rule", async () => {
    const g = await newGroup();
    for (const body of [{}, { userId: null }, { userId: "nope" }, { userId: 5 }, { userId: [memberUser.id] }, { userIds: [memberUser.id] }]) {
      expectInvalid(await owner.post(`/groups/${g.id}/members/remove`, body), "userId must be a valid id");
      expectInvalid(await owner.post(`/groups/${everyoneId}/members/remove`, body), "userId must be a valid id");
    }
  });

  test("an unknown group is a 404 before the body is read; members are refused first", async () => {
    expectError(await owner.post(`/groups/${UNKNOWN}/members/remove`, {}), 404, "not_found", "Group not found");
    expectError(await owner.post("/groups/nope/members/remove", { userId: memberUser.id }), 404, "not_found", "Group not found");
    expectBody(await member.post(`/groups/${UNKNOWN}/members/remove`, { userId: memberUser.id }), 403, NOT_ADMIN);
    expectBody(await member.post(`/groups/${everyoneId}/members/remove`, { userId: memberUser.id }), 403, NOT_ADMIN);
    expectBody(await t.client().post(`/groups/${everyoneId}/members/remove`, { userId: memberUser.id }), 401, UNAUTHORIZED);
  });
});

describe("what a group gives access to follows its members at once", () => {
  let space: string;
  let socket: Socket;
  let outsider: Client;
  let outsiderUser: any;
  let pages = 0;

  beforeAll(async () => {
    ({ client: outsider, user: outsiderUser } = await t.addMember(owner, "outsider@example.com"));
    space = (await owner.post("/spaces", { name: "Group space", slug: "group-space" })).body.data.space.id;
    socket = await connect(outsider);
  });

  afterAll(async () => {
    await socket.close();
  });

  /** Whether the outsider's open socket hears about a page created in the space now. */
  const hears = async () => {
    await owner.post("/pages", { spaceId: space, title: `Page ${++pages}` });
    return !(await socket.quiet((m) => m.t === "event" && m.kind === "tree" && m.spaceId === space, 150));
  };
  const reads = async () => (await outsider.get(`/spaces/${space}/pages`)).status;

  test("adding to, removing from and deleting a group changes what an open socket receives and what the member can read", async () => {
    const g = await newGroup();
    expect((await owner.post(`/spaces/${space}/members/add`, { role: "reader", groupIds: [g.id] })).status).toBe(200);
    expect(await reads()).toBe(404);
    expect(await hears()).toBe(false);

    await owner.post(`/groups/${g.id}/members/add`, { userIds: [outsiderUser.id] });
    expect(await reads()).toBe(200);
    await until(hears, 5000, "space events after joining the group");

    await owner.post(`/groups/${g.id}/members/remove`, { userId: outsiderUser.id });
    expect(await reads()).toBe(404);
    await until(async () => !(await hears()), 5000, "no space events after leaving the group");

    await owner.post(`/groups/${g.id}/members/add`, { userIds: [outsiderUser.id] });
    await until(hears, 5000, "space events after joining again");
    await owner.post(`/groups/${g.id}/delete`);
    expect(await reads()).toBe(404);
    await until(async () => !(await hears()), 5000, "no space events after the group was deleted");
  });
});
