import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Client, type TestServer } from "./harness";
import { apiError } from "./harness/errors";

/**
 * What anyone holding a share key can read, without a session
 * (src/server/routes/shares.ts, lib/shares.ts, lib/content.ts `publicDoc`):
 * `GET /public/shares/:key`, `/public/shares/:key/pages/:page` and
 * `/public/shares/:key/search`.
 */

let t: TestServer;
let owner: Client;
let ownerId: string;
let spaceId: string;

interface PageRef {
  id: string;
  slugId: string;
  title: string | null;
  position: string;
  createdAt: string;
  updatedAt: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHARE_NOT_FOUND = apiError("not_found", "Share not found");
const PAGE_NOT_FOUND = apiError("not_found", "Page not found");

const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const docOf = (...content: unknown[]) => ({ type: "doc", content });

const newPage = async (title: string | null, extra: Record<string, unknown> = {}): Promise<PageRef> => {
  const res = await owner.post("/pages", { spaceId, title, ...extra });
  expect(res.status).toBe(200);
  return res.body.data.page;
};

const share = async (pageId: string, body: Record<string, unknown> = {}) => {
  const res = await owner.post(`/pages/${pageId}/share`, body);
  expect(res.status).toBe(200);
  return res.body.data.share as { id: string; key: string; pageId: string; includeChildren: boolean; searchIndexing: boolean; url: string; createdAt: string };
};

const treeItem = (page: PageRef, extra: Record<string, unknown> = {}) => ({
  id: page.id,
  slugId: page.slugId,
  title: page.title,
  icon: null,
  parentId: null,
  spaceId,
  position: page.position,
  hasChildren: false,
  isBase: false,
  ...extra,
});

/** A new anonymous visitor (no cookies, its own address). */
const visitor = () => t.client();

beforeAll(async () => {
  t = await startServer();
  const setup = await t.setupOwner();
  owner = setup.owner;
  ownerId = setup.user.id;
  spaceId = setup.spaceId;
});

afterAll(async () => {
  await t.close();
});

describe("GET /public/shares/:key", () => {
  test("answers the share and the page, without anything about who wrote it", async () => {
    const page = await newPage("Public page", { icon: "📣", content: docOf(paragraph(text("Hello, world"))) });
    expect((await owner.post(`/pages/${page.id}/update`, { cover: "https://example.com/cover.png" })).status).toBe(200);
    const shared = await share(page.id);
    const res = await visitor().get(`/public/shares/${shared.key}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        share: shared,
        page: {
          ...treeItem(page, { icon: "📣" }),
          cover: "https://example.com/cover.png",
          content: docOf(paragraph(text("Hello, world"))),
          createdAt: page.createdAt,
          updatedAt: expect.stringMatching(ISO),
        },
      },
    });
    // No `tree` without children, and none of a member's view of the page.
    expect(Object.keys(res.body.data).sort()).toEqual(["page", "share"]);
    for (const key of ["creator", "lastEditor", "contributors", "docVersion", "deletedAt"]) expect(res.body.data.page).not.toHaveProperty(key);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    // A session changes nothing.
    expect((await owner.get(`/public/shares/${shared.key}`)).body).toEqual(res.body);
  });

  test("a page without a title, icon, cover or text is answered with nulls and its empty document", async () => {
    const page = await newPage(null);
    const shared = await share(page.id);
    const res = await visitor().get(`/public/shares/${shared.key}`);
    expect(res.body.data.page).toEqual({
      ...treeItem(page),
      cover: null,
      content: { type: "doc", content: [{ type: "paragraph", attrs: { id: null, textAlign: null, indent: 0 } }] },
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    });
    expect(shared.url).toBe(`http://doc.test/share/${shared.key}/p/untitled-${page.slugId}`);
  });

  test("a page whose document was never stored has null content", async () => {
    const page = await newPage("No content");
    await t.sql`UPDATE pages SET content = NULL WHERE id = ${page.id}`;
    const shared = await share(page.id);
    expect((await visitor().get(`/public/shares/${shared.key}`)).body.data.page.content).toBeNull();
  });

  test.each([
    ["an unknown key", "0000000000"],
    ["a key in upper case", "ABCDEFGHIJ"],
    ["a key with a symbol", "abc-efghij"],
    ["a key of 33 characters", "a".repeat(33)],
    ["a key with a space", "abcde%20ghij"],
    ["a key in another script", "%D0%BA%D0%BB%D1%8E%D1%87"],
    ["a page id", "00000000-0000-0000-0000-000000000000"],
  ])("%s is 404", async (_label, key) => {
    const res = await visitor().get(`/public/shares/${key}`);
    expect([res.status, res.body]).toEqual([404, SHARE_NOT_FOUND]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("keys are matched exactly, in lower case", async () => {
    const page = await newPage("Exact key");
    const shared = await share(page.id);
    for (const key of [shared.key.toUpperCase(), shared.key.slice(0, 9), `${shared.key}0`, ` ${shared.key}`]) {
      const res = await visitor().get(`/public/shares/${encodeURIComponent(key)}`);
      expect([key, res.status, res.body]).toEqual([key, 404, SHARE_NOT_FOUND]);
    }
    // A key of another length that exists (arranged) is found too: the format is 1 to 32 of 0-9a-z.
    await t.sql`UPDATE shares SET key = 'k' WHERE id = ${shared.id}`;
    expect((await visitor().get("/public/shares/k")).status).toBe(200);
    await t.sql`UPDATE shares SET key = ${"z".repeat(32)} WHERE id = ${shared.id}`;
    expect((await visitor().get(`/public/shares/${"z".repeat(32)}`)).status).toBe(200);
  });

  test("the share ends when it is deleted or its page is trashed", async () => {
    const deleted = await newPage("Share deleted");
    const deletedKey = (await share(deleted.id)).key;
    expect((await visitor().get(`/public/shares/${deletedKey}`)).status).toBe(200);
    await owner.post(`/pages/${deleted.id}/share/delete`);
    expect((await visitor().get(`/public/shares/${deletedKey}`)).body).toEqual(SHARE_NOT_FOUND);

    const trashed = await newPage("Page trashed");
    const trashedKey = (await share(trashed.id)).key;
    await owner.post(`/pages/${trashed.id}/delete`);
    expect((await visitor().get(`/public/shares/${trashedKey}`)).body).toEqual(SHARE_NOT_FOUND);
    await owner.post(`/pages/${trashed.id}/restore`);
    expect((await visitor().get(`/public/shares/${trashedKey}`)).body).toEqual(SHARE_NOT_FOUND);
  });

  test("a share row left on a trashed page (arranged) is not served", async () => {
    const page = await newPage("Trashed with a share row");
    await owner.post(`/pages/${page.id}/delete`);
    await t.sql`INSERT INTO shares (key, page_id, include_children) VALUES ('leftover00', ${page.id}, true)`;
    const res = await visitor().get("/public/shares/leftover00");
    expect([res.status, res.body]).toEqual([404, SHARE_NOT_FOUND]);
    const asPage = await visitor().get(`/public/shares/leftover00/pages/${page.id}`);
    expect([asPage.status, asPage.body]).toEqual([404, PAGE_NOT_FOUND]);
    const search = await visitor().get("/public/shares/leftover00/search?q=trashed");
    expect([search.status, search.body]).toEqual([404, SHARE_NOT_FOUND]);
  });

  test("changes to the page show at once, including a rename in the share's URL", async () => {
    const page = await newPage("First title", { content: docOf(paragraph(text("v1"))) });
    const shared = await share(page.id);
    await owner.post(`/pages/${page.id}/update`, { title: "Second title", icon: "🆕" });
    const res = await visitor().get(`/public/shares/${shared.key}`);
    expect(res.body.data.page).toMatchObject({ title: "Second title", icon: "🆕" });
    expect(res.body.data.share.url).toBe(`http://doc.test/share/${shared.key}/p/second-title-${page.slugId}`);
    expect(Date.parse(res.body.data.page.updatedAt)).toBeGreaterThan(Date.parse(page.updatedAt));
  });
});

describe("the public document", () => {
  const fileId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  const publicContent = async (content: unknown) => {
    const page = await newPage("Document", { content });
    const shared = await share(page.id);
    const res = await visitor().get(`/public/shares/${shared.key}`);
    expect(res.status).toBe(200);
    return { key: shared.key, content: res.body.data.page.content, page };
  };

  test("comment marks are removed, other marks and attributes stay", async () => {
    const comment = (id: string, resolved = false) => ({ type: "comment", attrs: { commentId: id, resolved } });
    const { content, page } = await publicContent(
      docOf(
        paragraph(
          text("plain "),
          text("commented", [comment("c1")]),
          text(" bold and commented", [{ type: "bold" }, comment("c2", true)]),
          text(" twice", [comment("c1"), comment("c3"), { type: "italic" }, { type: "link", attrs: { href: "https://example.com/" } }]),
        ),
        { type: "heading", attrs: { level: 2, id: "h1" }, content: [text("Heading", [comment("c4")])] },
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [paragraph(text("nested", [comment("c5"), { type: "code" }]))] }],
        },
      ),
    );
    expect(content).toEqual(
      docOf(
        paragraph(
          text("plain "),
          text("commented"),
          text(" bold and commented", [{ type: "bold" }]),
          text(" twice", [{ type: "italic" }, { type: "link", attrs: { href: "https://example.com/" } }]),
        ),
        { type: "heading", attrs: { level: 2, id: "h1" }, content: [text("Heading")] },
        { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("nested", [{ type: "code" }]))] }] },
      ),
    );
    // A node that had only comment marks has no `marks` key at all.
    expect(content.content[0].content[1]).not.toHaveProperty("marks");
    // Members still get the marks.
    const asMember = (await owner.get(`/pages/${page.id}`)).body.data.page.content;
    expect(asMember.content[0].content[1].marks).toEqual([comment("c1")]);
  });

  test("file URLs in src and url attributes get the share key", async () => {
    const { key, content } = await publicContent(
      docOf(
        { type: "image", attrs: { src: `/api/files/${fileId}/photo.png`, alt: "a photo", attachmentId: fileId } },
        { type: "video", attrs: { src: `/api/files/${fileId}/clip%20one.mp4` } },
        { type: "audio", attrs: { src: `/api/files/${fileId}/sound.mp3` } },
        { type: "pdf", attrs: { src: `/api/files/${fileId}/paper.pdf`, name: "paper.pdf" } },
        { type: "drawio", attrs: { src: `/api/files/${fileId}/diagram.drawio.svg` } },
        { type: "excalidraw", attrs: { src: `/api/files/${fileId}/sketch.excalidraw.svg` } },
        { type: "attachment", attrs: { url: `/api/files/${fileId}/report.docx`, name: "report.docx", attachmentId: fileId } },
        { type: "embed", attrs: { src: `/api/files/${fileId}/embedded.html` } },
      ),
    );
    expect(content).toEqual(
      docOf(
        { type: "image", attrs: { src: `/api/files/${fileId}/photo.png?share=${key}`, alt: "a photo", attachmentId: fileId } },
        { type: "video", attrs: { src: `/api/files/${fileId}/clip%20one.mp4?share=${key}` } },
        { type: "audio", attrs: { src: `/api/files/${fileId}/sound.mp3?share=${key}` } },
        { type: "pdf", attrs: { src: `/api/files/${fileId}/paper.pdf?share=${key}`, name: "paper.pdf" } },
        { type: "drawio", attrs: { src: `/api/files/${fileId}/diagram.drawio.svg?share=${key}` } },
        { type: "excalidraw", attrs: { src: `/api/files/${fileId}/sketch.excalidraw.svg?share=${key}` } },
        { type: "attachment", attrs: { url: `/api/files/${fileId}/report.docx?share=${key}`, name: "report.docx", attachmentId: fileId } },
        { type: "embed", attrs: { src: `/api/files/${fileId}/embedded.html?share=${key}` } },
      ),
    );
  });

  test("an existing query string and fragment are kept around the key", async () => {
    const image = (src: string) => ({ type: "image", attrs: { src } });
    const { key, content } = await publicContent(
      docOf(
        image(`/api/files/${fileId}/a.png?v=2`),
        image(`/api/files/${fileId}/a.pdf#page=3`),
        image(`/api/files/${fileId}/a.png?v=2&w=100#top`),
        image(`/api/files/${fileId}/a.png?`),
        image(`/api/files/${fileId}/a.png#`),
        image(`/api/files/${fileId}/a.png?share=old`),
        image(`/api/files/${fileId}`),
        image(`/api/files/${fileId}/`),
        image(`/api/files/${fileId}?x=1`),
        image(`/api/files/${fileId}#frag`),
        image(`/api/files/${fileId}/deep/er/path.png`),
        image(`/api/files/${fileId.toUpperCase()}/Upper.PNG`),
      ),
    );
    expect(content.content.map((node: { attrs: { src: string } }) => node.attrs.src)).toEqual([
      `/api/files/${fileId}/a.png?v=2&share=${key}`,
      `/api/files/${fileId}/a.pdf?share=${key}#page=3`,
      `/api/files/${fileId}/a.png?v=2&w=100&share=${key}#top`,
      `/api/files/${fileId}/a.png?&share=${key}`,
      `/api/files/${fileId}/a.png?share=${key}#`,
      `/api/files/${fileId}/a.png?share=old&share=${key}`,
      `/api/files/${fileId}?share=${key}`,
      `/api/files/${fileId}/?share=${key}`,
      `/api/files/${fileId}?x=1&share=${key}`,
      `/api/files/${fileId}?share=${key}#frag`,
      `/api/files/${fileId}/deep/er/path.png?share=${key}`,
      // The id is written in lower case, the rest is kept.
      `/api/files/${fileId}/Upper.PNG?share=${key}`,
    ]);
  });

  test("anything that is not a file URL of this server, and every other attribute, is left alone", async () => {
    const doc = docOf(
      { type: "image", attrs: { src: "https://example.com/api/files/x.png" } },
      { type: "image", attrs: { src: `http://doc.test/api/files/${fileId}/absolute.png` } },
      { type: "image", attrs: { src: `api/files/${fileId}/relative.png` } },
      { type: "image", attrs: { src: "/api/files/not-a-file-id/x.png" } },
      { type: "image", attrs: { src: `/api/files/${fileId}x/x.png` } },
      { type: "image", attrs: { src: `/api/filesystem/${fileId}/x.png` } },
      { type: "image", attrs: { src: "/api/images/3f2504e0-4f89-41d3-9a0c-0305e82c3301.png" } },
      { type: "image", attrs: { src: "data:image/png;base64,iVBORw0KGgo=" } },
      { type: "image", attrs: { src: "" } },
      { type: "image", attrs: { src: null, alt: `/api/files/${fileId}/in-alt.png` } },
      { type: "youtube", attrs: { src: "https://www.youtube.com/embed/abc" } },
      // attachmentId and other attributes that hold a file's id or URL are not URLs to rewrite.
      { type: "attachment", attrs: { url: "https://example.com/report.docx", attachmentId: fileId, name: `/api/files/${fileId}/name.docx` } },
      { type: "mention", attrs: { id: `/api/files/${fileId}/x`, label: "label", entityType: "page", entityId: fileId, slugId: "abc" } },
      // A link to a file is a mark, not a node attribute.
      paragraph(text("download", [{ type: "link", attrs: { href: `/api/files/${fileId}/linked.zip` } }])),
    );
    const { content } = await publicContent(doc);
    expect(content).toEqual(doc);
  });

  test("the rewritten URL opens the file for a visitor", async () => {
    const page = await newPage("With a real file");
    const uploaded = await owner.uploadFile(new File(["file bytes"], "real file.txt", { type: "text/plain" }), page.id);
    const file = uploaded.body.data;
    const content = docOf({ type: "attachment", attrs: { url: file.url, name: file.name, attachmentId: file.id } });
    expect((await owner.post(`/pages/${page.id}/content`, { content })).status).toBe(200);
    const shared = await share(page.id);
    const seen = (await visitor().get(`/public/shares/${shared.key}`)).body.data.page.content.content[0].attrs;
    expect(seen).toEqual({ url: `/api/files/${file.id}/real%20file.txt?share=${shared.key}`, name: "real file.txt", attachmentId: file.id });
    const anonymous = visitor();
    const res = await anonymous.fetch(seen.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("file bytes");
    expect((await anonymous.fetch(file.url)).status).toBe(401);
  });
});

describe("GET /public/shares/:key: the tree of a share with children", () => {
  test("lists every page below the shared one, level by level, by parent and position", async () => {
    const root = await newPage("Tree root");
    const b = await newPage("B", { parentId: root.id });
    const a = await newPage("A", { parentId: root.id });
    // A was made second and is moved to the front: order follows position, not age.
    const moved = await owner.post(`/pages/${a.id}/move`, { parentId: root.id, afterId: null });
    a.position = moved.body.data.page.position;
    const a1 = await newPage("A1", { parentId: a.id });
    const a2 = await newPage("A2", { parentId: a.id });
    const b1 = await newPage("B1", { parentId: b.id });
    const a1x = await newPage("A1x", { parentId: a1.id });
    const shared = await share(root.id, { includeChildren: true });

    const res = await visitor().get(`/public/shares/${shared.key}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(["page", "share", "tree"]);
    expect(res.body.data.page).toMatchObject(treeItem(root, { hasChildren: true }));
    // Within a level, pages are grouped by their parent (in id order), then ordered by position.
    const level2 = a.id < b.id ? [a1, a2, b1] : [b1, a1, a2];
    const parentOf: Record<string, string> = { [a1.id]: a.id, [a2.id]: a.id, [b1.id]: b.id };
    expect(res.body.data.tree).toEqual([
      treeItem(a, { parentId: root.id, hasChildren: true }),
      treeItem(b, { parentId: root.id, hasChildren: true }),
      ...level2.map((p) => treeItem(p, { parentId: parentOf[p.id], hasChildren: p.id === a1.id })),
      treeItem(a1x, { parentId: a1.id }),
    ]);
  });

  test("a share with children and none below has an empty tree; without children there is no tree", async () => {
    const lonely = await newPage("No children");
    const shared = await share(lonely.id, { includeChildren: true });
    expect((await visitor().get(`/public/shares/${shared.key}`)).body.data.tree).toEqual([]);
    await owner.post(`/pages/${lonely.id}/share`, { includeChildren: false });
    expect((await visitor().get(`/public/shares/${shared.key}`)).body.data).not.toHaveProperty("tree");

    const parent = await newPage("Has children, does not share them");
    await newPage("Hidden child", { parentId: parent.id });
    const closed = await share(parent.id);
    const res = await visitor().get(`/public/shares/${closed.key}`);
    expect(res.body.data).not.toHaveProperty("tree");
    // The page still says it has children.
    expect(res.body.data.page.hasChildren).toBe(true);
  });

  test("pages in the trash, and everything below them, are left out", async () => {
    const root = await newPage("Tree with trash");
    const kept = await newPage("Kept", { parentId: root.id });
    const trashed = await newPage("Trashed", { parentId: root.id });
    await newPage("Below trashed", { parentId: trashed.id });
    const onlyChild = await newPage("Only child, trashed", { parentId: kept.id });
    const shared = await share(root.id, { includeChildren: true });
    await owner.post(`/pages/${trashed.id}/delete`);
    await owner.post(`/pages/${onlyChild.id}/delete`);
    const res = await visitor().get(`/public/shares/${shared.key}`);
    // `kept` no longer has a child that counts.
    expect(res.body.data.tree).toEqual([treeItem(kept, { parentId: root.id, hasChildren: false })]);
    await owner.post(`/pages/${trashed.id}/restore`);
    expect((await visitor().get(`/public/shares/${shared.key}`)).body.data.tree.map((p: PageRef) => p.title)).toEqual(["Kept", "Trashed", "Below trashed"]);
  });

  test("a base below the shared page is marked as one", async () => {
    const root = await newPage("Tree with a base");
    const base = (await owner.post("/bases", { spaceId, title: "Tasks", parentId: root.id })).body.data.page;
    const shared = await share(root.id, { includeChildren: true });
    const res = await visitor().get(`/public/shares/${shared.key}`);
    expect(res.body.data.tree).toEqual([treeItem(base, { parentId: root.id, isBase: true })]);
  });

  test("the tree stops at 5000 pages", async () => {
    const created = await owner.post("/spaces", { name: "Huge", slug: "huge-tree" });
    const space = created.body.data.space.id as string;
    const root = (await owner.post("/pages", { spaceId: space, title: "Huge root" })).body.data.page as PageRef;
    await t.sql`
      INSERT INTO pages (slug_id, space_id, parent_id, position, title, text_content)
      SELECT 'cap' || lpad(i::text, 7, '0'), ${space}, ${root.id}, 'n' || lpad(i::text, 5, '0'), 'Cap ' || i, ''
      FROM generate_series(1, 5001) AS i`;
    const shared = await share(root.id, { includeChildren: true });
    const res = await visitor().get(`/public/shares/${shared.key}`);
    expect(res.status).toBe(200);
    const tree = res.body.data.tree as PageRef[];
    expect(tree.length).toBe(5000);
    expect(tree[0]!.title).toBe("Cap 1");
    expect(tree[4999]!.title).toBe("Cap 5000");
    // The page left out of the tree can still be opened.
    expect((await visitor().get(`/public/shares/${shared.key}/pages/cap0005001`)).status).toBe(200);
  }, 30_000);
});

describe("GET /public/shares/:key/pages/:page", () => {
  let root: PageRef;
  let child: PageRef;
  let grandchild: PageRef;
  let above: PageRef;
  let unrelated: PageRef;
  let key: string;

  beforeAll(async () => {
    above = await newPage("Above the share");
    root = await newPage("Shared root", { parentId: above.id, content: docOf(paragraph(text("root text"))) });
    child = await newPage("Chapter", { parentId: root.id, content: docOf(paragraph(text("chapter text", [{ type: "comment", attrs: { commentId: "c" } }]))) });
    grandchild = await newPage("Section", { parentId: child.id });
    unrelated = await newPage("Unrelated");
    key = (await share(root.id, { includeChildren: true })).key;
  });

  test("a page below the shared one is answered with its breadcrumbs from the shared page down", async () => {
    const res = await visitor().get(`/public/shares/${key}/pages/${grandchild.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        page: {
          ...treeItem(grandchild, { parentId: child.id }),
          cover: null,
          content: { type: "doc", content: [{ type: "paragraph", attrs: { id: null, textAlign: null, indent: 0 } }] },
          createdAt: grandchild.createdAt,
          updatedAt: grandchild.updatedAt,
        },
        breadcrumbs: [
          // The pages above the shared one are not revealed.
          treeItem(root, { parentId: above.id, hasChildren: true }),
          treeItem(child, { parentId: root.id, hasChildren: true }),
          treeItem(grandchild, { parentId: child.id }),
        ],
      },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("the page may be given by slugId, or by id in any letter case", async () => {
    const byId = await visitor().get(`/public/shares/${key}/pages/${child.id}`);
    const bySlug = await visitor().get(`/public/shares/${key}/pages/${child.slugId}`);
    const byUpper = await visitor().get(`/public/shares/${key}/pages/${child.id.toUpperCase()}`);
    expect(byId.status).toBe(200);
    expect(bySlug.body).toEqual(byId.body);
    expect(byUpper.body).toEqual(byId.body);
    expect(byId.body.data.breadcrumbs.map((p: PageRef) => p.title)).toEqual(["Shared root", "Chapter"]);
    // The document is the public one: no comment marks.
    expect(byId.body.data.page.content).toEqual(docOf(paragraph(text("chapter text"))));
  });

  test("the shared page itself is answered with itself as the only breadcrumb", async () => {
    const res = await visitor().get(`/public/shares/${key}/pages/${root.slugId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.page).toMatchObject({ id: root.id, title: "Shared root", content: docOf(paragraph(text("root text"))) });
    expect(res.body.data.breadcrumbs).toEqual([treeItem(root, { parentId: above.id, hasChildren: true })]);
    expect(Object.keys(res.body.data).sort()).toEqual(["breadcrumbs", "page"]);
  });

  test("pages outside the share are 404: above it, beside it, unknown, or not a page reference", async () => {
    for (const ref of [above.id, above.slugId, unrelated.id, unrelated.slugId, crypto.randomUUID(), "0000000000", "not-a-page", "a".repeat(33), "%20"]) {
      const res = await visitor().get(`/public/shares/${key}/pages/${ref}`);
      expect([ref, res.status, res.body]).toEqual([ref, 404, PAGE_NOT_FOUND]);
    }
  });

  test("a bad or unknown key is `Page not found` here", async () => {
    for (const bad of ["0000000000", "BADKEY", "a".repeat(33)]) {
      const res = await visitor().get(`/public/shares/${bad}/pages/${root.id}`);
      expect([bad, res.status, res.body]).toEqual([bad, 404, PAGE_NOT_FOUND]);
    }
  });

  test("a page of the share reached through another share's key is 404", async () => {
    const otherKey = (await share(unrelated.id, { includeChildren: true })).key;
    const res = await visitor().get(`/public/shares/${otherKey}/pages/${child.id}`);
    expect([res.status, res.body]).toEqual([404, PAGE_NOT_FOUND]);
    expect((await visitor().get(`/public/shares/${otherKey}/pages/${unrelated.id}`)).status).toBe(200);
  });

  test("a share without children opens only its own page", async () => {
    const parent = await newPage("Shares only itself");
    const hidden = await newPage("Hidden below", { parentId: parent.id });
    const closedKey = (await share(parent.id)).key;
    expect((await visitor().get(`/public/shares/${closedKey}/pages/${parent.id}`)).status).toBe(200);
    expect((await visitor().get(`/public/shares/${closedKey}/pages/${parent.slugId}`)).status).toBe(200);
    for (const ref of [hidden.id, hidden.slugId]) {
      const res = await visitor().get(`/public/shares/${closedKey}/pages/${ref}`);
      expect([res.status, res.body]).toEqual([404, PAGE_NOT_FOUND]);
    }
    // Turning children on opens it.
    await owner.post(`/pages/${parent.id}/share`, { includeChildren: true });
    expect((await visitor().get(`/public/shares/${closedKey}/pages/${hidden.id}`)).status).toBe(200);
  });

  test("a page in the trash is 404 until restored, and so is everything below it", async () => {
    const shared = await newPage("Root of trash test");
    const middle = await newPage("Middle", { parentId: shared.id });
    const leaf = await newPage("Leaf", { parentId: middle.id });
    const trashKey = (await share(shared.id, { includeChildren: true })).key;
    await owner.post(`/pages/${middle.id}/delete`);
    for (const page of [middle, leaf]) {
      const res = await visitor().get(`/public/shares/${trashKey}/pages/${page.id}`);
      expect([res.status, res.body]).toEqual([404, PAGE_NOT_FOUND]);
    }
    await owner.post(`/pages/${middle.id}/restore`);
    expect((await visitor().get(`/public/shares/${trashKey}/pages/${leaf.id}`)).body.data.breadcrumbs.map((p: PageRef) => p.title)).toEqual([
      "Root of trash test",
      "Middle",
      "Leaf",
    ]);
  });

  test("a page moved out of the share is closed, one moved in is opened", async () => {
    const shared = await newPage("Root of move test");
    const inside = await newPage("Starts inside", { parentId: shared.id });
    const outside = await newPage("Starts outside");
    const moveKey = (await share(shared.id, { includeChildren: true })).key;
    expect((await visitor().get(`/public/shares/${moveKey}/pages/${inside.id}`)).status).toBe(200);
    expect((await visitor().get(`/public/shares/${moveKey}/pages/${outside.id}`)).status).toBe(404);
    await owner.post(`/pages/${inside.id}/move`, { parentId: null, afterId: null });
    await owner.post(`/pages/${outside.id}/move`, { parentId: shared.id, afterId: null });
    expect((await visitor().get(`/public/shares/${moveKey}/pages/${inside.id}`)).status).toBe(404);
    expect((await visitor().get(`/public/shares/${moveKey}/pages/${outside.id}`)).status).toBe(200);
  });
});

describe("a shared base", () => {
  interface Property {
    id: string;
    name: string;
    type: string;
  }

  const newBase = async (title: string, extra: Record<string, unknown> = {}) => {
    const created = await owner.post("/bases", { spaceId, title, ...extra });
    expect(created.status).toBe(200);
    const base = (await owner.get(`/bases/${created.body.data.page.id}`)).body.data;
    return base as { id: string; properties: Property[]; views: { id: string; name: string; type: string; config: Record<string, unknown>; position: string }[] };
  };

  const addRow = async (baseId: string, cells: Record<string, unknown>) => {
    const res = await owner.post(`/bases/${baseId}/rows`, { cells });
    expect(res.status).toBe(200);
    return res.body.data as { id: string; cells: Record<string, unknown>; position: string };
  };

  test("is answered with its properties, its first view and the rows of that view", async () => {
    const base = await newBase("Scores");
    const title = base.properties.find((p) => p.name === "Title")!;
    const score = (await owner.post(`/bases/${base.id}/properties`, { name: "Score", type: "number" })).body.data as Property;
    const rows = [];
    for (const [name, value] of [["one", 1], ["three", 3], ["two", 2], ["none", null]] as const) {
      rows.push(await addRow(base.id, { [title.id]: name, ...(value === null ? {} : { [score.id]: value }) }));
    }
    const shared = await share(base.id);

    // Unfiltered: every row in the base's own order (the seeded empty row first).
    const all = await visitor().get(`/public/shares/${shared.key}`);
    expect(all.status).toBe(200);
    const properties = (await owner.get(`/bases/${base.id}`)).body.data.properties;
    expect(all.body.data.page).toMatchObject({ id: base.id, title: "Scores", isBase: true });
    expect(Object.keys(all.body.data.page.base).sort()).toEqual(["properties", "rows", "truncated", "view"]);
    expect(all.body.data.page.base.properties).toEqual(properties);
    expect(all.body.data.page.base.view).toEqual(base.views[0]);
    expect(all.body.data.page.base.truncated).toBe(false);
    expect(all.body.data.page.base.rows.map((r: { cells: Record<string, unknown> }) => r.cells[title.id] ?? null)).toEqual([null, "one", "three", "two", "none"]);
    expect(all.body.data.page.base.rows[1]).toEqual({
      id: rows[0]!.id,
      cells: { [title.id]: "one", [score.id]: 1 },
      position: rows[0]!.position,
      creatorId: ownerId,
      lastEditorId: ownerId,
      createdAt: expect.stringMatching(ISO),
      updatedAt: expect.stringMatching(ISO),
    });

    // The first view's filter and sorts decide what is shown.
    const config = {
      filter: { op: "and", children: [{ propertyId: score.id, op: "gte", value: 2 }] },
      sorts: [{ propertyId: score.id, direction: "desc" }],
    };
    const updated = await owner.post(`/bases/${base.id}/views/${base.views[0]!.id}/update`, { config });
    expect(updated.status).toBe(200);
    const filtered = await visitor().get(`/public/shares/${shared.key}`);
    expect(filtered.body.data.page.base.view).toEqual(updated.body.data);
    expect(filtered.body.data.page.base.view.config).toEqual(config);
    expect(filtered.body.data.page.base.rows.map((r: { cells: Record<string, unknown> }) => r.cells[title.id])).toEqual(["three", "two"]);

    // The same through the page endpoint.
    const asPage = await visitor().get(`/public/shares/${shared.key}/pages/${base.id}`);
    expect(asPage.body.data.page.base).toEqual(filtered.body.data.page.base);
  });

  test("a view that cannot be applied falls back to every row", async () => {
    const base = await newBase("Broken view");
    const title = base.properties.find((p) => p.name === "Title")!;
    await addRow(base.id, { [title.id]: "b" });
    await addRow(base.id, { [title.id]: "a" });
    const shared = await share(base.id);
    const titles = async () =>
      (await visitor().get(`/public/shares/${shared.key}`)).body.data.page.base.rows.map((r: { cells: Record<string, unknown> }) => r.cells[title.id] ?? null);

    // A filter on a property that does not exist.
    const unknown = { filter: { op: "and", children: [{ propertyId: "pmissing00", op: "eq", value: "a" }] }, sorts: [{ propertyId: title.id, direction: "asc" }] };
    expect((await owner.post(`/bases/${base.id}/views/${base.views[0]!.id}/update`, { config: unknown })).status).toBe(200);
    // Neither the filter nor the sort is applied.
    expect(await titles()).toEqual([null, "b", "a"]);
    // An operator the property's type does not have.
    const unsupported = { filter: { op: "and", children: [{ propertyId: title.id, op: "isWithin", value: "x" }] }, sorts: null };
    expect((await owner.post(`/bases/${base.id}/views/${base.views[0]!.id}/update`, { config: unsupported })).status).toBe(200);
    expect(await titles()).toEqual([null, "b", "a"]);
    // A sort on a property that does not exist.
    const badSort = { filter: null, sorts: [{ propertyId: "pmissing00", direction: "asc" }] };
    expect((await owner.post(`/bases/${base.id}/views/${base.views[0]!.id}/update`, { config: badSort })).status).toBe(200);
    expect(await titles()).toEqual([null, "b", "a"]);
    // A valid sort works again.
    const sorted = { sorts: [{ propertyId: title.id, direction: "asc" }] };
    expect((await owner.post(`/bases/${base.id}/views/${base.views[0]!.id}/update`, { config: sorted })).status).toBe(200);
    expect(await titles()).toEqual(["a", "b", null]);
  });

  test("the first view is the first by position: the board of a kanban base", async () => {
    const base = await newBase("Board", { template: "kanban" });
    const shared = await share(base.id);
    const res = await visitor().get(`/public/shares/${shared.key}`);
    expect(res.body.data.page.base.view).toMatchObject({ name: "Board", type: "kanban" });
    expect(res.body.data.page.base.view.config).toHaveProperty("groupByPropertyId");
    expect(res.body.data.page.base.properties.map((p: Property) => p.name)).toEqual(["Title", "Text 1", "Text 2", "Status"]);
  });

  test("a base without views (arranged) has a null view and every row", async () => {
    const base = await newBase("No views");
    await t.sql`DELETE FROM base_views WHERE page_id = ${base.id}`;
    const shared = await share(base.id);
    const res = await visitor().get(`/public/shares/${shared.key}`);
    expect(res.body.data.page.base.view).toBeNull();
    expect(res.body.data.page.base.rows.length).toBe(1);
  });

  test("at most 1000 rows are sent, and `truncated` says when there are more", async () => {
    const base = await newBase("Many rows");
    // One row is seeded; 999 more make exactly 1000.
    await t.sql`
      INSERT INTO base_rows (page_id, cells, position)
      SELECT ${base.id}, '{}'::jsonb, 'n' || lpad(i::text, 5, '0') FROM generate_series(1, 999) AS i`;
    const shared = await share(base.id);
    const full = (await visitor().get(`/public/shares/${shared.key}`)).body.data.page.base;
    expect([full.rows.length, full.truncated]).toEqual([1000, false]);
    await t.sql`INSERT INTO base_rows (page_id, cells, position) VALUES (${base.id}, '{}'::jsonb, 'n99999')`;
    const over = (await visitor().get(`/public/shares/${shared.key}`)).body.data.page.base;
    expect([over.rows.length, over.truncated]).toEqual([1000, true]);
    expect(over.rows[999].position).toBe("n00999");
    // Rows made outside the API have no creator.
    expect(over.rows[999]).toMatchObject({ cells: {}, creatorId: null, lastEditorId: null });
  });

  test("an ordinary page has no `base`", async () => {
    const page = await newPage("Not a base");
    const shared = await share(page.id);
    expect((await visitor().get(`/public/shares/${shared.key}`)).body.data.page).not.toHaveProperty("base");
  });
});

describe("GET /public/shares/:key/search", () => {
  let root: PageRef;
  let child: PageRef;
  let trashed: PageRef;
  let key: string;

  beforeAll(async () => {
    root = await newPage("Zebra handbook", { content: docOf(paragraph(text("The quagga chapter is first."))) });
    child = await newPage("Stripes", { parentId: root.id, content: docOf(paragraph(text("Every quagga had <b>fewer</b> stripes & spots."))) });
    trashed = await newPage("Extinct quagga", { parentId: root.id });
    await owner.post(`/pages/${trashed.id}/delete`);
    await newPage("Quagga elsewhere", { content: docOf(paragraph(text("quagga quagga"))) });
    key = (await share(root.id, { includeChildren: true })).key;
  });

  test("finds pages of the share by title and text, without saying which space they are in", async () => {
    const res = await visitor().get(`/public/shares/${key}/search?q=quagga`);
    expect(res.status).toBe(200);
    const results = res.body.data as Record<string, unknown>[];
    expect(results.map((r) => r.title).sort()).toEqual(["Stripes", "Zebra handbook"]);
    const hit = results.find((r) => r.id === child.id)!;
    expect(hit).toEqual({
      ...treeItem(child, { parentId: root.id }),
      // Matches are marked, everything else is escaped.
      highlight: "Every <mark>quagga</mark> had &lt;b&gt;fewer&lt;/b&gt; stripes &amp; spots.",
      updatedAt: child.updatedAt,
    });
    for (const result of results) expect(result).not.toHaveProperty("space");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const byTitle = await visitor().get(`/public/shares/${key}/search?q=${encodeURIComponent("zebra hand")}`);
    expect(byTitle.body.data.map((r: PageRef) => r.title)).toEqual(["Zebra handbook"]);
    // The text has no match, so the title is highlighted: the whole query, extended to the end of its last word.
    expect(byTitle.body.data[0].highlight).toBe("<mark>Zebra handbook</mark>");
  });

  test("never finds pages outside the share or in the trash", async () => {
    const res = await visitor().get(`/public/shares/${key}/search?q=elsewhere`);
    expect(res.body).toEqual({ data: [] });
    const extinct = await visitor().get(`/public/shares/${key}/search?q=extinct`);
    expect(extinct.body).toEqual({ data: [] });
    // Members find them.
    expect((await owner.get("/search?q=elsewhere")).body.data.map((r: PageRef) => r.title)).toEqual(["Quagga elsewhere"]);
  });

  test("a share without children searches only its own page", async () => {
    const closed = await newPage("Okapi notes", { content: docOf(paragraph(text("okapi facts"))) });
    await newPage("Okapi appendix", { parentId: closed.id, content: docOf(paragraph(text("okapi details"))) });
    const closedKey = (await share(closed.id)).key;
    const res = await visitor().get(`/public/shares/${closedKey}/search?q=okapi`);
    expect(res.body.data.map((r: PageRef) => r.title)).toEqual(["Okapi notes"]);
    await owner.post(`/pages/${closed.id}/share`, { includeChildren: true });
    const open = await visitor().get(`/public/shares/${closedKey}/search?q=okapi`);
    expect(open.body.data.map((r: PageRef) => r.title).sort()).toEqual(["Okapi appendix", "Okapi notes"]);
  });

  test("an absent, empty or blank query finds nothing", async () => {
    for (const query of ["", "?q=", "?q=%20%20", "?other=quagga"]) {
      const res = await visitor().get(`/public/shares/${key}/search${query}`);
      expect([query, res.status, res.body]).toEqual([query, 200, { data: [] }]);
    }
  });

  test("the query may be 200 characters long", async () => {
    const atLimit = await visitor().get(`/public/shares/${key}/search?q=${"q".repeat(200)}`);
    expect([atLimit.status, atLimit.body]).toEqual([200, { data: [] }]);
    const emoji = await visitor().get(`/public/shares/${key}/search?q=${encodeURIComponent("😀".repeat(200))}`);
    expect(emoji.status).toBe(200);
    const over = await visitor().get(`/public/shares/${key}/search?q=${"q".repeat(201)}`);
    expect([over.status, over.body]).toEqual([400, apiError("invalid_input", "q must be at most 200 characters")]);
  });

  test("at most 20 results are answered", async () => {
    const many = await newPage("Many results");
    for (let i = 0; i < 22; i++) await newPage(`Wombat ${i}`, { parentId: many.id });
    const manyKey = (await share(many.id, { includeChildren: true })).key;
    const res = await visitor().get(`/public/shares/${manyKey}/search?q=wombat`);
    expect(res.body.data.length).toBe(20);
    // limit and offset are not parameters here.
    const more = await visitor().get(`/public/shares/${manyKey}/search?q=wombat&limit=50&offset=20`);
    expect(more.body.data.length).toBe(20);
    expect(more.body.data.map((r: PageRef) => r.id)).toEqual(res.body.data.map((r: PageRef) => r.id));
  });

  test("a bad or unknown key is `Share not found`", async () => {
    for (const bad of ["0000000000", "BADKEY", "a".repeat(33)]) {
      const res = await visitor().get(`/public/shares/${bad}/search?q=quagga`);
      expect([bad, res.status, res.body]).toEqual([bad, 404, SHARE_NOT_FOUND]);
    }
    // The key is looked up before the query is validated.
    const res = await visitor().get(`/public/shares/0000000000/search?q=${"q".repeat(201)}`);
    expect(res.status).toBe(404);
  });

  test("an address may search 60 times a minute, whatever the key", async () => {
    const one = visitor();
    const statuses: number[] = [];
    for (let i = 0; i < 59; i++) statuses.push((await one.get(`/public/shares/${key}/search?q=quagga`)).status);
    // Requests with a bad key count as well.
    statuses.push((await one.get("/public/shares/0000000000/search?q=quagga")).status);
    expect(statuses).toEqual([...Array(59).fill(200), 404]);
    const limited = await one.get(`/public/shares/${key}/search?q=quagga`);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual(apiError("rate_limited", "Too many attempts. Try again in a minute."));
    const limitedBadKey = await one.get("/public/shares/0000000000/search");
    expect(limitedBadKey.status).toBe(429);
    // Other addresses are not affected, and neither are the other public endpoints for this one.
    expect((await visitor().get(`/public/shares/${key}/search?q=quagga`)).status).toBe(200);
    expect((await one.get(`/public/shares/${key}`)).status).toBe(200);
    expect((await one.get(`/public/shares/${key}/pages/${child.id}`)).status).toBe(200);
    // The limit is by address, not by session: a signed-in client at the same address is limited too.
    const sameAddress = t.client({ ip: one.ip });
    sameAddress.cookie = owner.cookie;
    expect((await sameAddress.get(`/public/shares/${key}/search?q=quagga`)).status).toBe(429);
  });
});

describe("public shares while sharing is disabled", () => {
  // Last in the file: the workspace setting is for every space.
  test("for the workspace: every public endpoint is 404, and all come back with the setting", async () => {
    const root = await newPage("Switched off", { content: docOf(paragraph(text("narwhal"))) });
    const child = await newPage("Below", { parentId: root.id });
    const key = (await share(root.id, { includeChildren: true })).key;
    expect((await owner.post("/workspace/update", { settings: { sharingDisabled: true } })).status).toBe(200);
    try {
      const top = await visitor().get(`/public/shares/${key}`);
      expect([top.status, top.body]).toEqual([404, SHARE_NOT_FOUND]);
      const page = await visitor().get(`/public/shares/${key}/pages/${child.id}`);
      expect([page.status, page.body]).toEqual([404, PAGE_NOT_FOUND]);
      const search = await visitor().get(`/public/shares/${key}/search?q=narwhal`);
      expect([search.status, search.body]).toEqual([404, SHARE_NOT_FOUND]);
      // Signed in or not.
      expect((await owner.get(`/public/shares/${key}`)).status).toBe(404);
    } finally {
      expect((await owner.post("/workspace/update", { settings: { sharingDisabled: false } })).status).toBe(200);
    }
    expect((await visitor().get(`/public/shares/${key}`)).status).toBe(200);
    expect((await visitor().get(`/public/shares/${key}/pages/${child.id}`)).status).toBe(200);
    expect((await visitor().get(`/public/shares/${key}/search?q=narwhal`)).body.data.map((r: PageRef) => r.title)).toEqual(["Switched off"]);
  });

  test("for the space: its shares are gone, also after sharing is allowed again", async () => {
    const created = await owner.post("/spaces", { name: "Stops sharing", slug: "stops-sharing" });
    const space = created.body.data.space.id as string;
    const page = (await owner.post("/pages", { spaceId: space, title: "Was public" })).body.data.page;
    const key = (await share(page.id)).key;
    expect((await visitor().get(`/public/shares/${key}`)).status).toBe(200);
    expect((await owner.post(`/spaces/${space}/update`, { settings: { sharingDisabled: true } })).status).toBe(200);
    expect((await visitor().get(`/public/shares/${key}`)).body).toEqual(SHARE_NOT_FOUND);
    expect((await owner.post(`/spaces/${space}/update`, { settings: { sharingDisabled: false } })).status).toBe(200);
    expect((await visitor().get(`/public/shares/${key}`)).body).toEqual(SHARE_NOT_FOUND);
  });

  test("a share row in a space that does not share (arranged) is not served", async () => {
    const created = await owner.post("/spaces", { name: "Never shares", slug: "never-shares" });
    const space = created.body.data.space.id as string;
    const page = (await owner.post("/pages", { spaceId: space, title: "Has a row" })).body.data.page;
    expect((await owner.post(`/spaces/${space}/update`, { settings: { sharingDisabled: true } })).status).toBe(200);
    await t.sql`INSERT INTO shares (key, page_id) VALUES ('arranged00', ${page.id})`;
    const res = await visitor().get("/public/shares/arranged00");
    expect([res.status, res.body]).toEqual([404, SHARE_NOT_FOUND]);
  });
});
