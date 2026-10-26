import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "server/db";
import { flushMail } from "server/lib/mail";
import { purgeTrash } from "server/lib/pages";
import { doc, startTestServer, type Client, type TestContext } from "server/test-helpers";

let t: TestContext;
let owner: Client;
let ownerId: string;
let spaceId: string;

const create = async (client: Client, title: string) => (await client.post("/pages", { spaceId, title })).body.data.page;

beforeAll(async () => {
  t = await startTestServer();
  const setup = await t.setupOwner();
  owner = setup.owner;
  ownerId = setup.user.id;
  spaceId = setup.spaceId;
});

afterAll(async () => {
  await t.close();
});

describe("comments", () => {
  test("threads, notifications and author-only edits", async () => {
    const { client: writer, user: writerUser } = await t.addMember(owner, "commenter@example.com");
    await owner.post(`/spaces/${spaceId}/members/add`, { role: "writer", userIds: [writerUser.id] });
    const page = await create(owner, "Discussed");
    t.outbox.length = 0;

    const top = await writer.post("/comments", { pageId: page.id, body: doc("First!"), quote: "Discussed", anchored: true });
    expect(top.status).toBe(200);
    expect(top.body.data.comment).toMatchObject({ parentId: null, quote: "Discussed", anchored: true });
    expect(top.body.data.comment.author.id).toBe(writerUser.id);

    const reply = await owner.post("/comments", { pageId: page.id, parentId: top.body.data.comment.id, body: doc("Reply") });
    const nested = await writer.post("/comments", { pageId: page.id, parentId: reply.body.data.comment.id, body: doc("Nested") });
    expect(nested.body.data.comment.parentId).toBe(top.body.data.comment.id);
    expect((await writer.post("/comments", { pageId: page.id, body: doc("") })).status).toBe(400);

    await Bun.sleep(50);
    const ownerNotes = (await owner.get("/notifications")).body.data.map((n: { kind: string }) => n.kind);
    expect(ownerNotes).toEqual(["comment.reply", "comment.created"]);
    const writerNotes = (await writer.get("/notifications")).body.data.map((n: { kind: string }) => n.kind);
    expect(writerNotes).toEqual(["comment.reply"]);
    await flushMail();
    expect(t.outbox.some((m) => m.subject.includes("commented on Discussed"))).toBe(true);

    expect((await owner.post(`/comments/${top.body.data.comment.id}/update`, { body: doc("hijack") })).status).toBe(403);
    const edited = await writer.post(`/comments/${top.body.data.comment.id}/update`, { body: doc("Edited") });
    expect(edited.body.data.comment.editedAt).not.toBeNull();
    const resolved = await owner.post(`/comments/${top.body.data.comment.id}/resolve`, { resolved: true });
    expect(resolved.body.data.comment.resolvedBy.id).toBe(ownerId);
    expect((await owner.post(`/comments/${reply.body.data.comment.id}/resolve`, { resolved: true })).status).toBe(400);

    expect((await owner.get(`/pages/${page.id}/comments`)).body.data).toHaveLength(3);
    expect((await owner.post(`/comments/${top.body.data.comment.id}/delete`)).status).toBe(200);
    expect((await owner.get(`/pages/${page.id}/comments`)).body.data).toHaveLength(0);
  });

  test("users who opt out of comment emails still get in-app notifications", async () => {
    await owner.post("/me/update", { preferences: { notifyComments: false } });
    const { client: writer, user } = await t.addMember(owner, "quiet@example.com");
    await owner.post(`/spaces/${spaceId}/members/add`, { role: "writer", userIds: [user.id] });
    const page = await create(owner, "Quiet page");
    t.outbox.length = 0;
    await writer.post("/comments", { pageId: page.id, body: doc("hello") });
    await Bun.sleep(50);
    await flushMail();
    expect(t.outbox.filter((m) => m.to === "owner@example.com")).toHaveLength(0);
    expect((await owner.get("/notifications?unread=1")).body.data[0].kind).toBe("comment.created");
  });
});

describe("members and groups", () => {
  test("admins cannot manage owners and the last owner cannot be demoted", async () => {
    const { client: admin, user: adminUser } = await t.addMember(owner, "admin@example.com", "admin");
    const me = (await owner.get("/me")).body.data.user;
    expect((await admin.post("/members/role", { userId: me.id, role: "member" })).status).toBe(403);
    expect((await admin.post("/members/deactivate", { userId: me.id })).status).toBe(403);
    expect((await admin.post("/members/role", { userId: adminUser.id, role: "owner" })).status).toBe(403);
    expect((await owner.post("/members/role", { userId: me.id, role: "admin" })).status).toBe(403);
    const promoted = await owner.post("/members/role", { userId: adminUser.id, role: "owner" });
    expect(promoted.body.data.user.role).toBe("owner");
    const list = await owner.get("/members?query=admin");
    expect(list.body.data.total).toBe(1);
    expect(list.body.data.items[0].email).toBe("admin@example.com");
  });

  test("the default group cannot be renamed, deleted or left", async () => {
    const groups = (await owner.get("/groups")).body.data;
    const everyone = groups.find((g: { isDefault: boolean }) => g.isDefault);
    expect((await owner.post(`/groups/${everyone.id}/update`, { name: "All" })).status).toBe(403);
    expect((await owner.post(`/groups/${everyone.id}/delete`)).status).toBe(403);
    expect((await owner.post(`/groups/${everyone.id}/members/remove`, { userId: ownerId })).status).toBe(403);
    const members = await owner.get(`/groups/${everyone.id}/members?limit=500`);
    expect(members.body.data.total).toBeGreaterThan(1);
  });

  test("space admins are protected from removal when last", async () => {
    const members = (await owner.get(`/spaces/${spaceId}/members`)).body.data;
    const self = members.find((m: { user?: { id: string } }) => m.user?.id === ownerId);
    expect(self.role).toBe("admin");
    expect((await owner.post(`/spaces/${spaceId}/members/remove`, { memberId: self.id })).status).toBe(403);
    expect((await owner.post(`/spaces/${spaceId}/members/role`, { memberId: self.id, role: "reader" })).status).toBe(403);
  });

  test("spaces: create with a unique slug", async () => {
    const created = await owner.post("/spaces", { name: "Engineering", slug: "eng" });
    expect(created.body.data.space).toMatchObject({ slug: "eng", role: "admin", memberCount: 1 });
    expect((await owner.post("/spaces", { name: "Again", slug: "e" })).status).toBe(400);
    expect((await owner.post("/spaces", { name: "Again", slug: "no spaces" })).status).toBe(400);
    expect((await owner.post("/spaces", { name: "Again", slug: "ENG" })).status).toBe(409);
    expect((await owner.get("/spaces/eng")).body.data.space.id).toBe(created.body.data.space.id);
  });
});

describe("labels and favorites", () => {
  test("labels are normalized and listed", async () => {
    const page = await create(owner, "Labelled");
    const res = await owner.post(`/pages/${page.id}/labels`, { names: ["  Big Idea ", "big idea", "Draft"] });
    expect(res.body.data.map((l: { name: string }) => l.name)).toEqual(["big-idea", "draft"]);
    const all = await owner.get("/labels?query=big");
    expect(all.body.data).toEqual([expect.objectContaining({ name: "big-idea", pageCount: 1 })]);
    const pages = await owner.get(`/labels/${all.body.data[0].id}/pages`);
    expect(pages.body.data.map((p: { id: string }) => p.id)).toEqual([page.id]);
  });

  test("favorites and watching", async () => {
    const page = await create(owner, "Favorite");
    await owner.post("/favorites", { pageId: page.id });
    await owner.post("/favorites", { spaceId });
    const favorites = await owner.get("/favorites");
    expect(favorites.body.data.pages.map((p: { id: string }) => p.id)).toEqual([page.id]);
    expect(favorites.body.data.spaces.map((s: { id: string }) => s.id)).toEqual([spaceId]);
    expect((await owner.get(`/pages/${page.id}/watch`)).body.data.watching).toBe(true);
    await owner.post(`/pages/${page.id}/watch`, { watching: false });
    expect((await owner.get(`/pages/${page.id}/watch`)).body.data.watching).toBe(false);
  });
});

describe("realtime", () => {
  test("authenticated sockets answer ping with pong; anonymous upgrades are refused", async () => {
    const anonymous = await fetch(`${t.base}/api/ws`, { headers: { Upgrade: "websocket" } });
    expect(anonymous.status).toBe(401);
    const ws = new WebSocket(`${t.base.replace("http", "ws")}/api/ws`, { headers: { cookie: `session=${owner.cookie}` } } as never);
    const message = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ t: "ping" }));
      ws.onmessage = (event) => resolve(String(event.data));
      ws.onerror = () => reject(new Error("socket error"));
    });
    expect(JSON.parse(message)).toEqual({ t: "pong" });
    const tree = new Promise<string>((resolve) => {
      ws.onmessage = (event) => resolve(String(event.data));
    });
    await create(owner, "Live");
    expect(JSON.parse(await tree)).toEqual({ t: "event", kind: "tree", spaceId });
    ws.close();
  });
});

describe("trash purge", () => {
  test("removes pages trashed longer than the retention period, with their files", async () => {
    const page = await create(owner, "Old trash");
    const upload = await owner.uploadFile(new File(["x"], "x.txt"), page.id);
    await owner.post(`/pages/${page.id}/delete`);
    await sql`UPDATE pages SET deleted_at = now() - interval '31 days' WHERE id = ${page.id}`;
    expect(await purgeTrash()).toBe(1);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM files WHERE id = ${upload.body.data.id}`;
    expect(n).toBe(0);
  });
});
