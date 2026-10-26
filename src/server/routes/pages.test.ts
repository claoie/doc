import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "server/db";
import { savePageContent } from "server/lib/pages";
import { startTestServer, type Client, type TestContext } from "server/test-helpers";

let t: TestContext;
let owner: Client;
let ownerId: string;
let spaceId: string;

const titles = async (client: Client, parentId?: string) => {
  const res = await client.get(`/spaces/${spaceId}/pages${parentId ? `?parentId=${parentId}` : ""}`);
  return res.body.data.map((p: { title: string }) => p.title);
};

const create = async (client: Client, body: Record<string, unknown>) => {
  const res = await client.post("/pages", { spaceId, ...body });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body.data.page;
};

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

describe("page tree", () => {
  test("creates pages in order, after a sibling, and by slugId", async () => {
    const a = await create(owner, { title: "A" });
    const c = await create(owner, { title: "C" });
    await create(owner, { title: "B", afterId: a.id });
    expect(await titles(owner)).toEqual(["A", "B", "C"]);
    expect(a.slugId).toMatch(/^[0-9A-Za-z]{10}$/);
    const bySlug = await owner.get(`/pages/${c.slugId}`);
    expect(bySlug.body.data.page.id).toBe(c.id);
    expect(bySlug.body.data.canEdit).toBe(true);
    expect(bySlug.body.data.space.slug).toBe("general");
    expect(bySlug.body.data.page.content).toEqual(expect.objectContaining({ type: "doc" }));
  });

  test("nests pages, reports children and breadcrumbs", async () => {
    const parent = await create(owner, { title: "Parent" });
    const child = await create(owner, { title: "Child", parentId: parent.id });
    const grandchild = await create(owner, { title: "Grandchild", parentId: child.id });
    expect(await titles(owner, parent.id)).toEqual(["Child"]);
    const roots = await owner.get(`/spaces/${spaceId}/pages`);
    expect(roots.body.data.find((p: { id: string }) => p.id === parent.id).hasChildren).toBe(true);
    const details = await owner.get(`/pages/${grandchild.id}`);
    expect(details.body.data.breadcrumbs.map((b: { title: string }) => b.title)).toEqual(["Parent", "Child", "Grandchild"]);
  });

  test("moves pages and rejects cycles", async () => {
    const x = await create(owner, { title: "X" });
    const y = await create(owner, { title: "Y", parentId: x.id });
    const z = await create(owner, { title: "Z", parentId: y.id });
    expect((await owner.post(`/pages/${x.id}/move`, { parentId: z.id, afterId: null })).status).toBe(400);
    expect((await owner.post(`/pages/${x.id}/move`, { parentId: x.id, afterId: null })).status).toBe(400);

    const moved = await owner.post(`/pages/${z.id}/move`, { parentId: x.id, afterId: null });
    expect(moved.status).toBe(200);
    expect(await titles(owner, x.id)).toEqual(["Z", "Y"]);
    await owner.post(`/pages/${z.id}/move`, { parentId: x.id, afterId: y.id });
    expect(await titles(owner, x.id)).toEqual(["Y", "Z"]);
    await owner.post(`/pages/${z.id}/move`, { parentId: null, afterId: null });
    expect((await titles(owner))[0]).toBe("Z");
  });

  test("updates title and icon", async () => {
    const page = await create(owner, { title: "Old" });
    const res = await owner.post(`/pages/${page.id}/update`, { title: "New", icon: "📄" });
    expect(res.body.data.page).toMatchObject({ title: "New", icon: "📄" });
  });
});

describe("trash", () => {
  test("trashes and restores a subtree", async () => {
    const root = await create(owner, { title: "Trash root" });
    const child = await create(owner, { title: "Trash child", parentId: root.id });
    const leaf = await create(owner, { title: "Trash leaf", parentId: child.id });
    expect((await owner.post(`/pages/${root.id}/delete`)).status).toBe(200);
    expect(await titles(owner)).not.toContain("Trash root");
    const trash = await owner.get(`/spaces/${spaceId}/trash`);
    expect(trash.body.data.map((p: { title: string }) => p.title)).toEqual(["Trash root"]);
    expect(trash.body.data[0].deletedBy.id).toBe(ownerId);
    const leafDetails = await owner.get(`/pages/${leaf.id}`);
    expect(leafDetails.body.data.page.deletedAt).not.toBeNull();
    expect(leafDetails.body.data.canEdit).toBe(false);
    expect((await owner.post(`/pages/${leaf.id}/update`, { title: "nope" })).status).toBe(404);

    expect((await owner.post(`/pages/${root.id}/restore`)).status).toBe(200);
    expect(await titles(owner)).toContain("Trash root");
    expect(await titles(owner, child.id)).toEqual(["Trash leaf"]);
    expect((await owner.get(`/spaces/${spaceId}/trash`)).body.data).toEqual([]);
  });

  test("restoring a child whose parent is trashed makes it a root page", async () => {
    const parent = await create(owner, { title: "Gone parent" });
    const child = await create(owner, { title: "Orphan", parentId: parent.id });
    await owner.post(`/pages/${parent.id}/delete`);
    const restored = await owner.post(`/pages/${child.id}/restore`);
    expect(restored.body.data.page.parentId).toBeNull();
    expect((await titles(owner)).at(-1)).toBe("Orphan");
  });

  test("permanent deletion removes the subtree", async () => {
    const root = await create(owner, { title: "Doomed" });
    const child = await create(owner, { title: "Doomed child", parentId: root.id });
    await owner.post(`/pages/${root.id}/delete`);
    expect((await owner.post(`/pages/${root.id}/delete-permanently`)).status).toBe(200);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM pages WHERE id IN (${root.id}, ${child.id})`;
    expect(n).toBe(0);
  });
});

describe("duplicate", () => {
  test("copies the subtree, files and strips comment marks", async () => {
    const root = await create(owner, { title: "Original" });
    const upload = await owner.uploadFile(new File(["hello file"], "notes.txt", { type: "text/plain" }), root.id);
    expect(upload.status).toBe(200);
    const file = upload.body.data;
    expect(file.url).toBe(`/api/files/${file.id}/notes.txt`);
    const content = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "commented", marks: [{ type: "bold" }, { type: "comment", attrs: { commentId: "c1" } }] },
          ],
        },
        { type: "attachment", attrs: { url: file.url, name: "notes.txt", attachmentId: file.id } },
      ],
    };
    await savePageContent(root.id, { content, docVersion: 3, editorId: ownerId, contributorIds: [] });
    await create(owner, { title: "Kid", parentId: root.id });

    const res = await owner.post(`/pages/${root.id}/duplicate`, {});
    expect(res.status).toBe(200);
    const copy = res.body.data.page;
    expect(copy.title).toBe("Copy of Original");
    expect(copy.id).not.toBe(root.id);
    expect(copy.parentId).toBe(root.parentId);
    const rootTitles: string[] = await titles(owner);
    expect(rootTitles.indexOf("Copy of Original")).toBe(rootTitles.indexOf("Original") + 1);
    expect(await titles(owner, copy.id)).toEqual(["Kid"]);

    const paragraph = copy.content.content[0].content[0];
    expect(paragraph.marks).toEqual([{ type: "bold" }]);
    const attachment = copy.content.content[1].attrs;
    expect(attachment.attachmentId).not.toBe(file.id);
    expect(attachment.url).toBe(`/api/files/${attachment.attachmentId}/notes.txt`);
    const copiedFile = await owner.raw("GET", attachment.url.slice("/api".length));
    expect(copiedFile.status).toBe(200);
    expect(await copiedFile.text()).toBe("hello file");
    expect(copiedFile.headers.get("content-disposition")).toStartWith("attachment;");
  });
});

describe("content saving", () => {
  test("indexes text, links and synced blocks, snapshots versions and notifies mentions", async () => {
    const { client: member, user } = await t.addMember(owner, "writer@example.com");
    await owner.post(`/spaces/${spaceId}/members/add`, { role: "writer", userIds: [user.id] });
    const target = await create(owner, { title: "Target" });
    const source = await create(owner, { title: "Source" });
    const content = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "see " },
            { type: "mention", attrs: { entityType: "page", entityId: target.id, label: "Target" } },
            { type: "text", text: " and " },
            { type: "mention", attrs: { entityType: "user", entityId: user.id, label: "writer" } },
          ],
        },
        { type: "transclusionSource", attrs: { id: "block-1" }, content: [{ type: "paragraph", content: [{ type: "text", text: "synced" }] }] },
      ],
    };
    await savePageContent(source.id, { content, docVersion: 5, editorId: ownerId, contributorIds: [ownerId] });

    const page = (await owner.get(`/pages/${source.id}`)).body.data.page;
    expect(page.docVersion).toBe(5);
    const [row] = await sql`SELECT text_content FROM pages WHERE id = ${source.id}`;
    expect(row.text_content).toBe("see Target and writer\nsynced");
    const backlinks = await owner.get(`/pages/${target.id}/backlinks`);
    expect(backlinks.body.data.map((p: { id: string }) => p.id)).toEqual([source.id]);
    const outgoing = await owner.get(`/pages/${source.id}/links`);
    expect(outgoing.body.data.map((p: { id: string }) => p.id)).toEqual([target.id]);
    const synced = await member.post("/synced-blocks/lookup", {
      refs: [{ pageId: source.id, blockId: "block-1" }, { pageId: source.id, blockId: "missing" }],
    });
    expect(synced.body.data).toEqual([
      { pageId: source.id, blockId: "block-1", content: content.content[1]!.content },
      { pageId: source.id, blockId: "missing", content: null },
    ]);
    const versions = await owner.get(`/pages/${source.id}/versions`);
    expect(versions.body.data).toHaveLength(1);
    const version = await owner.get(`/versions/${versions.body.data[0].id}`);
    expect(version.body.data.content).toEqual(content);

    await savePageContent(source.id, { content, docVersion: 6, editorId: ownerId, contributorIds: [] });
    expect((await owner.get(`/pages/${source.id}/versions`)).body.data).toHaveLength(1);

    const notifications = await member.get("/notifications");
    expect(notifications.body.data.map((n: { kind: string }) => n.kind)).toEqual(["page.mention"]);
    expect(notifications.body.data[0].page.id).toBe(source.id);
    expect((await member.get("/notifications/unread-count")).body.data.count).toBe(1);
    await member.post("/notifications/read-all");
    expect((await member.get("/notifications/unread-count")).body.data.count).toBe(0);
  });
});

describe("permissions", () => {
  test("readers cannot edit, writers cannot delete permanently, non-members see nothing", async () => {
    const { client: reader, user: readerUser } = await t.addMember(owner, "reader@example.com");
    const { client: writer, user: writerUser } = await t.addMember(owner, "author@example.com");
    const { client: outsider } = await t.addMember(owner, "outsider@example.com");
    await owner.post(`/spaces/${spaceId}/members/add`, { role: "reader", userIds: [readerUser.id] });
    await owner.post(`/spaces/${spaceId}/members/add`, { role: "writer", userIds: [writerUser.id] });
    const page = await create(owner, { title: "Guarded" });

    expect((await reader.get(`/pages/${page.id}`)).status).toBe(200);
    expect((await reader.get(`/pages/${page.id}`)).body.data.canEdit).toBe(false);
    expect((await reader.post("/pages", { spaceId, title: "nope" })).status).toBe(403);
    expect((await reader.post(`/pages/${page.id}/update`, { title: "nope" })).status).toBe(403);
    expect((await reader.post(`/pages/${page.id}/delete`)).status).toBe(403);

    expect((await writer.post(`/pages/${page.id}/update`, { title: "Guarded!" })).status).toBe(200);
    expect((await writer.post(`/pages/${page.id}/delete`)).status).toBe(200);
    expect((await writer.post(`/pages/${page.id}/delete-permanently`)).status).toBe(403);
    expect((await writer.post(`/pages/${page.id}/restore`)).status).toBe(200);

    expect((await outsider.get(`/pages/${page.id}`)).status).toBe(404);
    expect((await outsider.get(`/pages/${page.slugId}`)).status).toBe(404);
    expect((await outsider.get(`/spaces/${spaceId}/pages`)).status).toBe(404);
    expect((await outsider.get(`/spaces/${spaceId}`)).status).toBe(404);
    expect((await outsider.post("/pages", { spaceId, title: "nope" })).status).toBe(404);
    expect((await outsider.get("/spaces")).body.data).toEqual([]);
    expect((await outsider.get(`/search?q=Guarded`)).body.data).toEqual([]);

    expect((await writer.post(`/spaces/${spaceId}/update`, { name: "Hijacked" })).status).toBe(403);
    expect((await reader.post("/members/role", { userId: writerUser.id, role: "admin" })).status).toBe(403);
  });

  test("group grants count towards the effective role", async () => {
    const { client, user } = await t.addMember(owner, "grouped@example.com");
    const group = await owner.post("/groups", { name: "Editors" });
    await owner.post(`/groups/${group.body.data.group.id}/members/add`, { userIds: [user.id] });
    expect((await client.get(`/spaces/${spaceId}/pages`)).status).toBe(404);
    await owner.post(`/spaces/${spaceId}/members/add`, { role: "reader", userIds: [user.id] });
    await owner.post(`/spaces/${spaceId}/members/add`, { role: "writer", groupIds: [group.body.data.group.id] });
    expect((await client.post("/pages", { spaceId, title: "Via group" })).status).toBe(200);
  });
});

describe("invitations", () => {
  test("accepting joins Everyone and the invited groups with the invited role", async () => {
    const group = await owner.post("/groups", { name: "Design" });
    const invited = await owner.post("/invitations", {
      emails: ["new@example.com", "owner@example.com"],
      role: "admin",
      groupIds: [group.body.data.group.id],
    });
    expect(invited.body.data.map((i: { email: string }) => i.email)).toEqual(["new@example.com"]);
    const link = new URL(invited.body.data[0].url);
    const id = link.pathname.split("/").pop()!;
    const tokenValue = link.searchParams.get("token")!;
    const anon = t.client();
    expect((await anon.get(`/invitations/${id}?token=wrong`)).status).toBe(400);
    expect((await anon.get(`/invitations/${id}?token=${encodeURIComponent(tokenValue)}`)).body.data.email).toBe("new@example.com");
    const accepted = await anon.post("/invitations/accept", { id, token: tokenValue, name: "Newbie", password: "newbie-password" });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.user.role).toBe("admin");
    const groups = await sql`
      SELECT g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = ${accepted.body.data.user.id} ORDER BY g.name`;
    expect(groups.map((g: { name: string }) => g.name)).toEqual(["Design", "Everyone"]);
    expect((await anon.post("/invitations/accept", { id, token: tokenValue, name: "Again", password: "newbie-password" })).status).toBe(400);
  });

  test("invitation links expire and resending renews them", async () => {
    const invited = await owner.post("/invitations", { emails: ["late@example.com"], role: "member", groupIds: [] });
    const link = new URL(invited.body.data[0].url);
    const id = link.pathname.split("/").pop()!;
    await sql`UPDATE invitations SET created_at = now() - interval '15 days' WHERE id = ${id}`;
    const anon = t.client();
    expect((await anon.get(`/invitations/${id}?token=${encodeURIComponent(link.searchParams.get("token")!)}`)).status).toBe(400);
    const renewed = new URL((await owner.post("/invitations/resend", { id })).body.data.url);
    expect((await anon.get(`/invitations/${id}?token=${encodeURIComponent(renewed.searchParams.get("token")!)}`)).status).toBe(200);
  });
});

describe("page content", () => {
  test("script URLs in saved content are stripped", async () => {
    const content = {
      type: "doc",
      content: [
        { type: "pdf", attrs: { src: "javascript:alert(1)" } },
        { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: " javascript:alert(1)" } }] }] },
      ],
    };
    const page = (await owner.post("/pages", { spaceId, title: "Unsafe", content })).body.data.page;
    expect(page.content.content[0].attrs.src).toBe("");
    expect(page.content.content[1].content[0].marks[0].attrs.href).toBe("");
    const replaced = await owner.post(`/pages/${page.id}/content`, { content });
    expect(replaced.status).toBe(200);
    const saved = await owner.get(`/pages/${page.slugId}`);
    expect(JSON.stringify(saved.body.data.page.content)).not.toContain("javascript:");
  });

  test("content over the editor's size limit is refused", async () => {
    const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(2_000_001) }] }] };
    const res = await owner.post("/pages", { spaceId, title: "Huge", content });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toBe("content is too large");
  });
});
