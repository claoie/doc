import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, startServer, type Client, type TestServer } from "./harness";
import {
  ISO,
  NOT_ADMIN,
  PNG,
  UNAUTHORIZED,
  expectApiHeaders,
  expectBody,
  expectError,
  expectInvalid,
  imageFile,
  imageStored,
  inviteParts,
  rows,
  signIn,
  userShape,
} from "./harness/admin";

/* Workspace members: the list, roles, deactivation and deletion. */

let t: TestServer;
let owner: Client;
let ownerUser: any;
let serial = 0;

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const SELF = { error: { code: "forbidden", message: "You cannot do this to your own account" } };
const OWNERS_ONLY = { error: { code: "forbidden", message: "Only owners can manage owners" } };
const NO_USER = { error: { code: "not_found", message: "User not found" } };

/** Invites and signs up someone with this name. */
const join = async (name: string, email: string, role: "member" | "admin" = "member") => {
  const invited = await owner.post("/invitations", { emails: [email], role });
  if (invited.status !== 200) throw new Error(`invite failed: ${invited.text}`);
  const client = t.client();
  const accepted = await client.post("/invitations/accept", { ...inviteParts(invited.body.data[0].url), name, password: "member-password" });
  if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.text}`);
  return { client, user: accepted.body.data.user as any, email };
};

/** A new person with an address of their own; `owner` makes them a second owner. */
const person = async (role: "member" | "admin" | "owner" = "member") => {
  const n = ++serial;
  const created = await join(`person ${n}`, `person-${n}@example.com`, role === "owner" ? "admin" : role);
  if (role === "owner") {
    const res = await owner.post("/members/role", { userId: created.user.id, role: "owner" });
    if (res.status !== 200) throw new Error(`promotion failed: ${res.text}`);
  }
  return created;
};

const roleOf = async (id: string) => (await rows(t.sql`SELECT role FROM users WHERE id = ${id}`))[0]?.role;
const listed = async (id: string) => (await owner.get("/members?limit=500")).body.data.items.find((m: any) => m.id === id);

beforeAll(async () => {
  t = await startServer();
  ({ owner, user: ownerUser } = await t.setupOwner());
});

afterAll(async () => {
  await t.close();
});

describe("GET /members (runs first: the workspace holds exactly the people made here)", () => {
  let people: Record<string, any>;
  let ann: Client;

  beforeAll(async () => {
    people = {};
    const make = async (key: string, name: string, role: "member" | "admin" = "member") => {
      const created = await join(name, `${key}@list.example`, role);
      people[key] = created.user;
      return created.client;
    };
    ann = await make("ann", "ann");
    await make("bob-admin", "Bob", "admin");
    await make("bob-member", "bob");
    await make("percent", "100% Real");
    await make("underscore", "under_score");
    await make("backslash", "back\\slash");
    await make("zoe", "Zoë Ünïcode");
    await make("zed", "zed");
    await make("aaron", "aaron");
    // Deactivated in this order, which is not the order they are listed in.
    await owner.post("/members/deactivate", { userId: people.zed.id });
    await owner.post("/members/deactivate", { userId: people.aaron.id });
  });

  const ids = async (query = "", client: Client = owner) => {
    const res = await client.get(`/members${query}`);
    return { status: res.status, ids: res.body.data?.items.map((m: any) => m.id), total: res.body.data?.total };
  };
  const bobs = () => [people["bob-admin"], people["bob-member"]].sort((a, b) => (a.id < b.id ? -1 : 1));
  const inOrder = () => [people.percent, people.ann, people.backslash, ...bobs(), ownerUser, people.underscore, people.zoe, people.aaron, people.zed];

  test("lists everyone: active people by name whatever its case, then id; deactivated people after them", async () => {
    const res = await owner.get("/members");
    const expected = inOrder().map((p) =>
      userShape({
        id: p.id,
        email: p.email,
        name: p.name,
        role: p.role,
        createdAt: p.createdAt,
        deactivatedAt: p === people.zed || p === people.aaron ? expect.stringMatching(ISO) : null,
      }),
    );
    expectBody(res, 200, { data: { items: expected, total: 10 } });
    expectApiHeaders(res.headers);
    expect(Object.keys(res.body.data.items[0]).sort()).toEqual(["avatarUrl", "createdAt", "deactivatedAt", "email", "id", "lastLoginAt", "locale", "name", "preferences", "role", "timezone"]);
    expect(res.body.data.items.map((m: any) => m.role)).toEqual(["member", "member", "member", ...bobs().map((b) => b.role), "owner", "member", "member", "member", "member"]);
  });

  test("any member sees the same list, with their own preferences and nobody else's", async () => {
    await ann.post("/me/update", { preferences: { theme: "dark" } });
    await owner.post("/me/update", { preferences: { fullPageWidth: true } });
    const mine = (await ann.get("/members")).body.data;
    expect(mine.items.map((m: any) => m.id)).toEqual(inOrder().map((p) => p.id));
    expect(mine.total).toBe(10);
    for (const item of mine.items) expect(item.preferences).toEqual(item.id === people.ann.id ? { theme: "dark" } : {});
    await owner.post("/me/update", { preferences: { fullPageWidth: null } });
    await ann.post("/me/update", { preferences: { theme: null } });
  });

  test("query matches part of a name or of an email, whatever the case, and is trimmed", async () => {
    expect(await ids("?query=bob")).toEqual({ status: 200, ids: bobs().map((b) => b.id), total: 2 });
    expect(await ids("?query=BOB")).toEqual({ status: 200, ids: bobs().map((b) => b.id), total: 2 });
    expect(await ids("?query=%20%20Bob%20")).toEqual({ status: 200, ids: bobs().map((b) => b.id), total: 2 });
    expect(await ids("?query=bob-admin")).toEqual({ status: 200, ids: [people["bob-admin"].id], total: 1 });
    expect(await ids("?query=LIST.EXAMPLE")).toEqual({ status: 200, ids: inOrder().filter((p) => p !== ownerUser).map((p) => p.id), total: 9 });
    expect(await ids("?query=owner%40example")).toEqual({ status: 200, ids: [ownerUser.id], total: 1 });
    // `er` is in the emails of percent and bob-member, and in the names Owner and under_score.
    expect(await ids("?query=er")).toEqual({ status: 200, ids: [people.percent, people["bob-member"], ownerUser, people.underscore].map((p) => p.id), total: 4 });
    expect(await ids("?query=ZO%C3%8B")).toEqual({ status: 200, ids: [people.zoe.id], total: 1 });
    expect(await ids("?query=o%C3%AB%20%C3%BCn")).toEqual({ status: 200, ids: [people.zoe.id], total: 1 });
    expect(await ids("?query=zed")).toEqual({ status: 200, ids: [people.zed.id], total: 1 });
    expect(await ids("?query=nobody-has-this")).toEqual({ status: 200, ids: [], total: 0 });
  });

  test("%, _ and \\ in the query are ordinary characters", async () => {
    expect(await ids("?query=%25")).toEqual({ status: 200, ids: [people.percent.id], total: 1 });
    expect(await ids("?query=0%25%20r")).toEqual({ status: 200, ids: [people.percent.id], total: 1 });
    expect(await ids("?query=_")).toEqual({ status: 200, ids: [people.underscore.id], total: 1 });
    expect(await ids("?query=r_s")).toEqual({ status: 200, ids: [people.underscore.id], total: 1 });
    expect(await ids("?query=%5C")).toEqual({ status: 200, ids: [people.backslash.id], total: 1 });
    expect(await ids("?query=k%5Cs")).toEqual({ status: 200, ids: [people.backslash.id], total: 1 });
    expect(await ids("?query=a%25n")).toEqual({ status: 200, ids: [], total: 0 });
    expect(await ids("?query=a_n")).toEqual({ status: 200, ids: [], total: 0 });
    expect(await ids("?query=%25%25")).toEqual({ status: 200, ids: [], total: 0 });
  });

  test("an empty query lists everyone; one of 100 characters is fine, 101 is refused", async () => {
    expect((await ids("?query=")).total).toBe(10);
    expect((await ids("?query=%20%20")).total).toBe(10);
    expect(await ids(`?query=${"q".repeat(100)}`)).toEqual({ status: 200, ids: [], total: 0 });
    expectInvalid(await owner.get(`/members?query=${"q".repeat(101)}`), "query must be at most 100 characters");
    expect(await ids(`?query=${encodeURIComponent("🎉".repeat(100))}`)).toEqual({ status: 200, ids: [], total: 0 });
    expectInvalid(await owner.get(`/members?query=${encodeURIComponent("🎉".repeat(101))}`), "query must be at most 100 characters");
  });

  test("limit and offset page through the list; the total is of the whole match, also past its end", async () => {
    const all = inOrder().map((p) => p.id);
    expect(await ids("?limit=3")).toEqual({ status: 200, ids: all.slice(0, 3), total: 10 });
    expect(await ids("?limit=3&offset=3")).toEqual({ status: 200, ids: all.slice(3, 6), total: 10 });
    expect(await ids("?limit=3&offset=9")).toEqual({ status: 200, ids: all.slice(9), total: 10 });
    expect(await ids("?offset=10")).toEqual({ status: 200, ids: [], total: 10 });
    expect(await ids("?offset=1000000")).toEqual({ status: 200, ids: [], total: 10 });
    expect(await ids("?limit=1")).toEqual({ status: 200, ids: all.slice(0, 1), total: 10 });
    expect(await ids("?limit=500&offset=0")).toEqual({ status: 200, ids: all, total: 10 });
    expect(await ids("?limit=&offset=")).toEqual({ status: 200, ids: all, total: 10 });
    expect(await ids("?query=bob&limit=1&offset=1")).toEqual({ status: 200, ids: [bobs()[1].id], total: 2 });
    expect(await ids("?query=bob&offset=2")).toEqual({ status: 200, ids: [], total: 2 });
    expect(await ids("?query=nobody-has-this&offset=7")).toEqual({ status: 200, ids: [], total: 0 });
  });

  test("limit must be 1 to 500 and offset 0 to 1000000", async () => {
    for (const limit of ["0", "501", "-5", "2.5", "ten", "1e3"]) {
      expectInvalid(await owner.get(`/members?limit=${limit}`), "limit must be an integer between 1 and 500");
    }
    for (const offset of ["-1", "1000001", "1.5", "x"]) {
      expectInvalid(await owner.get(`/members?offset=${offset}`), "offset must be an integer between 0 and 1000000");
    }
    // The query is checked first, then limit, then offset.
    expectInvalid(await owner.get(`/members?offset=x&limit=0&query=${"q".repeat(101)}`), "query must be at most 100 characters");
    expectInvalid(await owner.get("/members?offset=x&limit=0"), "limit must be an integer between 1 and 500");
  });

  test("needs a session", async () => {
    expectBody(await t.client().get("/members"), 401, UNAUTHORIZED);
  });
});

describe("POST /members/role", () => {
  test("an owner gives any role to anyone, and the answer is the member", async () => {
    const { client, user, email } = await person();
    await client.post("/me/update", { preferences: { theme: "dark" } });
    for (const role of ["admin", "owner", "member", "member", "owner", "admin"]) {
      const res = await owner.post("/members/role", { userId: user.id, role });
      expectBody(res, 200, { data: { user: userShape({ id: user.id, email, name: user.name, role, createdAt: user.createdAt }) } });
      expectApiHeaders(res.headers);
      expect(await roleOf(user.id)).toBe(role);
      // The session they already have carries the new role at once.
      expect((await client.get("/me")).body.data.user.role).toBe(role);
    }
    expect((await owner.post("/members/role", { userId: user.id.toUpperCase(), role: "member", extra: 1 })).body.data.user.role).toBe("member");
  });

  test("an admin promotes members and demotes admins, themselves included, but never grants owner", async () => {
    const admin = await person("admin");
    const other = await person("admin");
    const member = await person();
    expect((await admin.client.post("/members/role", { userId: member.user.id, role: "admin" })).body.data.user.role).toBe("admin");
    expect((await admin.client.post("/members/role", { userId: member.user.id, role: "member" })).body.data.user.role).toBe("member");
    expect((await admin.client.post("/members/role", { userId: other.user.id, role: "member" })).body.data.user.role).toBe("member");
    for (const userId of [member.user.id, other.user.id, admin.user.id]) {
      expectError(await admin.client.post("/members/role", { userId, role: "owner" }), 403, "forbidden", "Only owners can grant or remove the owner role");
    }
    expect(await roleOf(admin.user.id)).toBe("admin");
    // Their own answer carries their preferences; demoting themselves ends their admin rights.
    await admin.client.post("/me/update", { preferences: { theme: "dark" } });
    const self = await admin.client.post("/members/role", { userId: admin.user.id, role: "admin" });
    expect(self.body.data.user.preferences).toEqual({ theme: "dark" });
    expect((await admin.client.post("/members/role", { userId: admin.user.id, role: "member" })).body.data.user.role).toBe("member");
    expectBody(await admin.client.post("/members/role", { userId: member.user.id, role: "admin" }), 403, NOT_ADMIN);
  });

  test("an admin cannot touch an owner's role, not even to confirm it", async () => {
    const admin = await person("admin");
    const second = await person("owner");
    for (const userId of [ownerUser.id, second.user.id]) {
      for (const role of ["member", "admin", "owner"]) {
        expectBody(await admin.client.post("/members/role", { userId, role }), 403, OWNERS_ONLY);
      }
    }
    expect(await roleOf(second.user.id)).toBe("owner");
    await owner.post("/members/role", { userId: second.user.id, role: "member" });
  });

  test("members change nobody's role, their own included", async () => {
    const member = await person();
    const other = await person();
    for (const userId of [other.user.id, member.user.id, ownerUser.id, UNKNOWN]) {
      expectBody(await member.client.post("/members/role", { userId, role: "admin" }), 403, NOT_ADMIN);
    }
    expect(await roleOf(member.user.id)).toBe("member");
  });

  test("the last owner cannot be demoted; with a second owner either can be, by either", async () => {
    for (const role of ["admin", "member"]) {
      expectError(await owner.post("/members/role", { userId: ownerUser.id, role }), 403, "forbidden", "The last owner cannot be demoted");
    }
    expect((await owner.post("/members/role", { userId: ownerUser.id, role: "owner" })).body.data.user.role).toBe("owner");

    const second = await person("owner");
    // The second owner demotes the first, who gets the role back from them, and then steps down themselves.
    expect((await second.client.post("/members/role", { userId: ownerUser.id, role: "admin" })).body.data.user.role).toBe("admin");
    expectBody(await owner.post("/members/role", { userId: second.user.id, role: "member" }), 403, OWNERS_ONLY);
    expectError(await second.client.post("/members/role", { userId: second.user.id, role: "member" }), 403, "forbidden", "The last owner cannot be demoted");
    expect((await second.client.post("/members/role", { userId: ownerUser.id, role: "owner" })).body.data.user.role).toBe("owner");
    expect((await second.client.post("/members/role", { userId: second.user.id, role: "member" })).body.data.user.role).toBe("member");
    expect(await roleOf(ownerUser.id)).toBe("owner");
  });

  test("a deactivated owner does not count: the one active owner cannot be demoted, and neither can the deactivated one", async () => {
    const second = await person("owner");
    await owner.post("/members/deactivate", { userId: second.user.id });
    expectError(await owner.post("/members/role", { userId: ownerUser.id, role: "admin" }), 403, "forbidden", "The last owner cannot be demoted");
    // Accident: demoting the deactivated owner would leave the active one in place, yet the same count refuses it.
    expectError(await owner.post("/members/role", { userId: second.user.id, role: "member" }), 403, "forbidden", "The last owner cannot be demoted");
    expect(await roleOf(second.user.id)).toBe("owner");
    await owner.post("/members/activate", { userId: second.user.id });
    expect((await owner.post("/members/role", { userId: second.user.id, role: "member" })).body.data.user.role).toBe("member");
  });

  test("the role and the id are checked before who is asking; then whether the user exists", async () => {
    const member = await person();
    const target = await person();
    const roles = "role must be one of owner, admin, member";
    for (const client of [owner, member.client]) {
      expectInvalid(await client.post("/members/role", {}), "role is required");
      expectInvalid(await client.post("/members/role", { userId: target.user.id }), "role is required");
      for (const role of [null, "", "Owner", "ADMIN", "superuser", "reader", 1, true, ["admin"]]) {
        expectInvalid(await client.post("/members/role", { userId: target.user.id, role }), roles);
      }
      for (const userId of [undefined, null, "", "nope", 5, [target.user.id], `${target.user.id}x`]) {
        expectInvalid(await client.post("/members/role", { userId, role: "admin" }), "userId must be a valid id");
      }
    }
    expectBody(await owner.post("/members/role", { userId: UNKNOWN, role: "admin" }), 404, NO_USER);
    expectBody(await t.client().post("/members/role", { userId: target.user.id, role: "admin" }), 401, UNAUTHORIZED);
    expect(await roleOf(target.user.id)).toBe("member");
  });
});

describe("POST /members/deactivate", () => {
  test("deactivates a member: their sessions end, their sockets close, they cannot sign in and are listed as deactivated", async () => {
    const { client, user, email } = await person();
    const second = await signIn(t, email, "member-password");
    const socket = await connect(client);
    const res = await owner.post("/members/deactivate", { userId: user.id });
    expectBody(res, 200, { data: {} });
    expectApiHeaders(res.headers);
    expect(await socket.closed).toEqual({ code: 4001, reason: "signed out" });
    expectBody(await client.get("/me"), 401, UNAUTHORIZED);
    expectBody(await second.get("/me"), 401, UNAUTHORIZED);
    expect(await rows(t.sql`SELECT 1 AS n FROM sessions WHERE user_id = ${user.id}`)).toEqual([]);
    expectError(await t.client().post("/auth/login", { email, password: "member-password" }), 401, "invalid_credentials", "Invalid email or password");
    const entry = await listed(user.id);
    expect(entry).toEqual(userShape({ id: user.id, email, name: user.name, deactivatedAt: expect.stringMatching(ISO) }));

    // Again changes nothing, the time included.
    expectBody(await owner.post("/members/deactivate", { userId: user.id.toUpperCase() }), 200, { data: {} });
    expect((await listed(user.id)).deactivatedAt).toBe(entry.deactivatedAt);
    // Everything else about them stays: their group memberships, for one.
    expect(await rows(t.sql`SELECT count(*)::int AS n FROM group_members WHERE user_id = ${user.id}`)).toEqual([{ n: 1 }]);
  });

  test("admins deactivate members and other admins, owners anyone but themselves", async () => {
    const admin = await person("admin");
    const otherAdmin = await person("admin");
    const member = await person();
    const secondOwner = await person("owner");
    expectBody(await admin.client.post("/members/deactivate", { userId: member.user.id }), 200, { data: {} });
    expectBody(await admin.client.post("/members/deactivate", { userId: otherAdmin.user.id }), 200, { data: {} });
    expectBody(await admin.client.post("/members/deactivate", { userId: secondOwner.user.id }), 403, OWNERS_ONLY);
    expectBody(await admin.client.post("/members/deactivate", { userId: ownerUser.id }), 403, OWNERS_ONLY);
    expect((await listed(secondOwner.user.id)).deactivatedAt).toBeNull();
    expectBody(await owner.post("/members/deactivate", { userId: secondOwner.user.id }), 200, { data: {} });
    expect((await listed(secondOwner.user.id)).deactivatedAt).toMatch(ISO);
    expect((await listed(otherAdmin.user.id)).deactivatedAt).toMatch(ISO);
    await owner.post("/members/role", { userId: secondOwner.user.id, role: "owner" });
    await owner.post("/members/activate", { userId: secondOwner.user.id });
    await owner.post("/members/role", { userId: secondOwner.user.id, role: "member" });
  });

  test("nobody deactivates themselves; members deactivate nobody; the id is checked first, then the asker, then the user", async () => {
    const admin = await person("admin");
    const member = await person();
    expectBody(await owner.post("/members/deactivate", { userId: ownerUser.id }), 403, SELF);
    expectBody(await admin.client.post("/members/deactivate", { userId: admin.user.id }), 403, SELF);
    for (const userId of [admin.user.id, member.user.id, ownerUser.id, UNKNOWN]) {
      expectBody(await member.client.post("/members/deactivate", { userId }), 403, NOT_ADMIN);
    }
    for (const body of [{}, { userId: null }, { userId: "nope" }, { userId: 5 }, { id: admin.user.id }]) {
      expectInvalid(await owner.post("/members/deactivate", body), "userId must be a valid id");
      expectInvalid(await member.client.post("/members/deactivate", body), "userId must be a valid id");
    }
    expectBody(await owner.post("/members/deactivate", { userId: UNKNOWN }), 404, NO_USER);
    expectBody(await t.client().post("/members/deactivate", { userId: member.user.id }), 401, UNAUTHORIZED);
    expect((await admin.client.get("/me")).status).toBe(200);
    expect((await owner.get("/me")).status).toBe(200);
  });
});

describe("POST /members/activate", () => {
  test("lets a deactivated member sign in again; their old sessions stay gone", async () => {
    const { client, user, email } = await person();
    await owner.post("/members/deactivate", { userId: user.id });
    const res = await owner.post("/members/activate", { userId: user.id });
    expectBody(res, 200, { data: {} });
    expectApiHeaders(res.headers);
    expect((await listed(user.id)).deactivatedAt).toBeNull();
    expectBody(await client.get("/me"), 401, UNAUTHORIZED);
    expect((await t.client().post("/auth/login", { email, password: "member-password" })).status).toBe(200);
    // Activating someone who is active changes nothing.
    expectBody(await owner.post("/members/activate", { userId: user.id.toUpperCase() }), 200, { data: {} });
    expect((await listed(user.id)).deactivatedAt).toBeNull();
  });

  test("follows the same rules as deactivating", async () => {
    const admin = await person("admin");
    const member = await person();
    const secondOwner = await person("owner");
    await owner.post("/members/deactivate", { userId: member.user.id });
    await owner.post("/members/deactivate", { userId: secondOwner.user.id });
    expectBody(await admin.client.post("/members/activate", { userId: secondOwner.user.id }), 403, OWNERS_ONLY);
    expectBody(await admin.client.post("/members/activate", { userId: admin.user.id }), 403, SELF);
    expectBody(await owner.post("/members/activate", { userId: ownerUser.id }), 403, SELF);
    expectBody(await owner.post("/members/activate", { userId: UNKNOWN }), 404, NO_USER);
    expectInvalid(await owner.post("/members/activate", {}), "userId must be a valid id");
    expectInvalid(await owner.post("/members/activate", { userId: "nope" }), "userId must be a valid id");
    const plain = await person();
    expectBody(await plain.client.post("/members/activate", { userId: member.user.id }), 403, NOT_ADMIN);
    expectInvalid(await plain.client.post("/members/activate", { userId: "nope" }), "userId must be a valid id");
    expectBody(await t.client().post("/members/activate", { userId: member.user.id }), 401, UNAUTHORIZED);
    expect((await listed(member.user.id)).deactivatedAt).toMatch(ISO);
    expectBody(await admin.client.post("/members/activate", { userId: member.user.id }), 200, { data: {} });
    expectBody(await owner.post("/members/activate", { userId: secondOwner.user.id }), 200, { data: {} });
    await owner.post("/members/role", { userId: secondOwner.user.id, role: "member" });
  });
});

describe("POST /members/delete", () => {
  test("deletes a member: they are signed out, their sockets close, their avatar goes and their address is free again", async () => {
    const { client, user, email } = await person();
    const avatar: string = (await client.upload("/me/avatar", { file: imageFile(PNG) })).body.data.user.avatarUrl;
    const invitedByThem = await person();
    await t.sql`UPDATE users SET invited_by = ${user.id} WHERE id = ${invitedByThem.user.id}`;
    const socket = await connect(client);
    const before = (await owner.get("/members")).body.data.total;

    const res = await owner.post("/members/delete", { userId: user.id });
    expectBody(res, 200, { data: {} });
    expectApiHeaders(res.headers);
    expect(await socket.closed).toEqual({ code: 4001, reason: "signed out" });
    expectBody(await client.get("/me"), 401, UNAUTHORIZED);
    expectError(await t.client().post("/auth/login", { email, password: "member-password" }), 401, "invalid_credentials", "Invalid email or password");
    expect(await listed(user.id)).toBeUndefined();
    expect((await owner.get("/members")).body.data.total).toBe(before - 1);

    expect(await rows(t.sql`SELECT 1 AS n FROM users WHERE id = ${user.id}`)).toEqual([]);
    expect(await rows(t.sql`SELECT 1 AS n FROM sessions WHERE user_id = ${user.id}`)).toEqual([]);
    expect(await rows(t.sql`SELECT 1 AS n FROM group_members WHERE user_id = ${user.id}`)).toEqual([]);
    expect(imageStored(t, avatar)).toBe(false);
    expect(await rows(t.sql`SELECT 1 AS n FROM files WHERE storage_key = ${`images/${avatar.split("/").pop()}`}`)).toEqual([]);
    expectError(await t.client().get(avatar.slice("/api".length)), 404, "not_found", "Image not found");
    // People they invited stay.
    expect(await rows(t.sql`SELECT invited_by FROM users WHERE id = ${invitedByThem.user.id}`)).toEqual([{ invited_by: null }]);
    expect((await invitedByThem.client.get("/me")).status).toBe(200);

    expectBody(await owner.post("/members/delete", { userId: user.id }), 404, NO_USER);
    // The address can be invited and used again, as a new person.
    const again = await join("again", email);
    expect(again.user.id).not.toBe(user.id);
  });

  test("a deactivated member, and a member without an avatar, are deleted the same way", async () => {
    const { user } = await person();
    await owner.post("/members/deactivate", { userId: user.id });
    expectBody(await owner.post("/members/delete", { userId: user.id.toUpperCase() }), 200, { data: {} });
    expect(await listed(user.id)).toBeUndefined();
  });

  test("admins delete members and other admins, never owners; owners delete other owners", async () => {
    const admin = await person("admin");
    const otherAdmin = await person("admin");
    const member = await person();
    const secondOwner = await person("owner");
    expectBody(await admin.client.post("/members/delete", { userId: secondOwner.user.id }), 403, OWNERS_ONLY);
    expectBody(await admin.client.post("/members/delete", { userId: ownerUser.id }), 403, OWNERS_ONLY);
    expectBody(await admin.client.post("/members/delete", { userId: member.user.id }), 200, { data: {} });
    expectBody(await admin.client.post("/members/delete", { userId: otherAdmin.user.id }), 200, { data: {} });
    expect(await listed(secondOwner.user.id)).toBeDefined();
    expectBody(await owner.post("/members/delete", { userId: secondOwner.user.id }), 200, { data: {} });
    expect(await listed(secondOwner.user.id)).toBeUndefined();
    expect(await roleOf(ownerUser.id)).toBe("owner");
  });

  test("nobody deletes themselves; members delete nobody; the id is checked first, then the asker, then the user", async () => {
    const admin = await person("admin");
    const member = await person();
    expectBody(await owner.post("/members/delete", { userId: ownerUser.id }), 403, SELF);
    expectBody(await admin.client.post("/members/delete", { userId: admin.user.id }), 403, SELF);
    for (const userId of [admin.user.id, member.user.id, ownerUser.id, UNKNOWN]) {
      expectBody(await member.client.post("/members/delete", { userId }), 403, NOT_ADMIN);
    }
    for (const body of [{}, { userId: null }, { userId: "nope" }, { userId: 5 }]) {
      expectInvalid(await owner.post("/members/delete", body), "userId must be a valid id");
      expectInvalid(await member.client.post("/members/delete", body), "userId must be a valid id");
    }
    expectBody(await owner.post("/members/delete", { userId: UNKNOWN }), 404, NO_USER);
    expectBody(await t.client().post("/members/delete", { userId: member.user.id }), 401, UNAUTHORIZED);
    expect(await listed(admin.user.id)).toBeDefined();
    expect(await listed(member.user.id)).toBeDefined();
  });

  test("what the deleted member made stays, without them: invitations they sent and pages they wrote", async () => {
    const admin = await person("admin");
    const spaceId = (await owner.get("/me")).body.data.workspace.defaultSpaceId;
    await owner.post(`/spaces/${spaceId}/members/add`, { role: "writer", userIds: [admin.user.id] });
    const page = (await admin.client.post("/pages", { spaceId, title: "Left behind" })).body.data.page;
    const invited = await admin.client.post("/invitations", { emails: ["left-behind@example.com"] });
    expectBody(await owner.post("/members/delete", { userId: admin.user.id }), 200, { data: {} });
    const invitation = (await owner.get("/invitations")).body.data.find((i: any) => i.id === invited.body.data[0].id);
    expect(invitation.invitedBy).toBeNull();
    const kept = await owner.get(`/pages/${page.id}`);
    expect(kept.status).toBe(200);
    expect(kept.body.data.page.creator).toBeNull();
  });
});
