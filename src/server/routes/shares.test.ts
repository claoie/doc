import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { savePageContent } from "server/lib/pages";
import { startTestServer, type Client, type TestContext } from "server/test-helpers";

let t: TestContext;
let owner: Client;
let ownerId: string;
let spaceId: string;

const create = async (title: string, parentId?: string) =>
  (await owner.post("/pages", { spaceId, title, parentId })).body.data.page;

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

describe("shares", () => {
  test("a share without children exposes only the shared page", async () => {
    const root = await create("Shared root");
    const child = await create("Private child", root.id);
    const share = await owner.post(`/pages/${root.id}/share`, {});
    expect(share.status).toBe(200);
    const key: string = share.body.data.share.key;
    expect(key).toMatch(/^[0-9a-z]{10}$/);
    expect(share.body.data.share.url).toContain(`/share/${key}/p/shared-root-${root.slugId}`);

    const anon = t.client();
    const view = await anon.get(`/public/shares/${key}`);
    expect(view.status).toBe(200);
    expect(view.body.data.page.title).toBe("Shared root");
    expect(view.body.data.page).not.toHaveProperty("creator");
    expect(view.body.data.tree).toBeUndefined();
    expect((await anon.get(`/public/shares/${key}/pages/${child.id}`)).status).toBe(404);
    expect((await anon.get(`/public/shares/${key}/pages/${root.slugId}`)).status).toBe(200);
  });

  test("includeChildren exposes descendants, strips comments and authorizes files", async () => {
    const root = await create("Handbook");
    const child = await create("Chapter", root.id);
    const upload = await owner.uploadFile(new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], "photo.jpg", { type: "image/jpeg" }), child.id);
    const file = upload.body.data;
    await savePageContent(child.id, {
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "secret note", marks: [{ type: "comment", attrs: { commentId: "x" } }] }] },
          { type: "image", attrs: { src: file.url, attachmentId: file.id } },
        ],
      },
      docVersion: 1,
      editorId: ownerId,
      contributorIds: [],
    });
    const key: string = (await owner.post(`/pages/${root.id}/share`, { includeChildren: true })).body.data.share.key;

    const anon = t.client();
    const view = await anon.get(`/public/shares/${key}`);
    expect(view.body.data.tree.map((p: { title: string }) => p.title)).toEqual(["Chapter"]);
    const page = await anon.get(`/public/shares/${key}/pages/${child.slugId}`);
    expect(page.status).toBe(200);
    expect(page.body.data.breadcrumbs.map((b: { title: string }) => b.title)).toEqual(["Handbook", "Chapter"]);
    const [paragraph, image] = page.body.data.page.content.content;
    expect(paragraph.content[0].marks).toBeUndefined();
    expect(image.attrs.src).toBe(`${file.url}?share=${key}`);

    const image200 = await anon.raw("GET", image.attrs.src.slice("/api".length));
    expect(image200.status).toBe(200);
    expect(image200.headers.get("content-disposition")).toStartWith("inline;");
    const ranged = await anon.raw("GET", image.attrs.src.slice("/api".length), { headers: { Range: "bytes=1-3" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 1-3/7");
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(new Uint8Array([0xd8, 0xff, 0xe0]));
    expect((await anon.raw("GET", file.url.slice("/api".length))).status).toBe(401);
    expect((await anon.raw("GET", `${file.url.slice("/api".length)}?share=wrongkey00`)).status).toBe(404);

    const state = await owner.get(`/pages/${child.id}/share`);
    expect(state.body.data.share).toBeNull();
    expect(state.body.data.inheritedFrom.page.id).toBe(root.id);
    expect(state.body.data.inheritedFrom.share.key).toBe(key);

    const search = await anon.get(`/public/shares/${key}/search?q=secret`);
    expect(search.body.data.map((r: { title: string }) => r.title)).toEqual(["Chapter"]);

    await owner.post(`/pages/${child.id}/delete`);
    expect((await anon.get(`/public/shares/${key}/pages/${child.id}`)).status).toBe(404);
    await owner.post(`/pages/${child.id}/restore`);
    expect((await anon.get(`/public/shares/${key}/pages/${child.id}`)).status).toBe(200);
  });

  test("disabling sharing in the space removes shares and blocks new ones", async () => {
    const page = await create("Soon private");
    const key: string = (await owner.post(`/pages/${page.id}/share`, {})).body.data.share.key;
    await owner.post(`/spaces/${spaceId}/update`, { settings: { sharingDisabled: true } });
    expect((await t.client().get(`/public/shares/${key}`)).status).toBe(404);
    const again = await owner.post(`/pages/${page.id}/share`, {});
    expect(again.status).toBe(403);
    expect(again.body.error!.code).toBe("sharing_disabled");
    await owner.post(`/spaces/${spaceId}/update`, { settings: { sharingDisabled: false } });
  });

  test("trashing a page removes its share", async () => {
    const page = await create("Trashed share");
    const key: string = (await owner.post(`/pages/${page.id}/share`, {})).body.data.share.key;
    await owner.post(`/pages/${page.id}/delete`);
    expect((await t.client().get(`/public/shares/${key}`)).status).toBe(404);
    expect((await owner.get(`/spaces/${spaceId}/shares`)).body.data.some((s: { key: string }) => s.key === key)).toBe(false);
  });
});
