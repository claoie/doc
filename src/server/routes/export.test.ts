import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { savePageContent } from "server/lib/pages";
import { readZipDirectory, readZipEntry } from "server/lib/zip";
import { startTestServer, type Client, type TestContext } from "server/test-helpers";

let t: TestContext;
let owner: Client;
let ownerId: string;
let spaceId: string;

const create = async (title: string, parentId?: string) =>
  (await owner.post("/pages", { spaceId, title, parentId })).body.data.page;

const unzipList = async (bytes: Uint8Array) => {
  const file = path.join(tmpdir(), `export-${crypto.randomUUID()}.zip`);
  await Bun.write(file, bytes);
  const list = Bun.spawnSync(["unzip", "-l", file]).stdout.toString();
  const check = Bun.spawnSync(["unzip", "-t", file]);
  await Bun.file(file).delete();
  return { list, ok: check.exitCode === 0 };
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

describe("export", () => {
  test("a single page exports as an HTML document", async () => {
    const page = await create("Solo <page>");
    const res = await owner.raw("GET", `/pages/${page.id}/export?format=html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    expect(res.headers.get("content-disposition")).toContain("Solo _page_.html");
    const html = await res.text();
    expect(html).toContain("<h1>Solo &lt;page&gt;</h1>");
  });

  test("a page with children and files exports as a zip with relative links", async () => {
    const root = await create("Guide");
    const childA = await create("Setup", root.id);
    await create("Setup", root.id);
    const upload = await owner.uploadFile(new File(["diagram bytes"], "diagram one.png", { type: "image/png" }), childA.id);
    const file = upload.body.data;
    await savePageContent(root.id, {
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "go to " },
              { type: "text", text: "setup", marks: [{ type: "link", attrs: { href: `/s/general/p/setup-${childA.slugId}` } }] },
            ],
          },
        ],
      },
      docVersion: 1,
      editorId: ownerId,
      contributorIds: [],
    });
    await savePageContent(childA.id, {
      content: { type: "doc", content: [{ type: "image", attrs: { src: file.url, attachmentId: file.id } }] },
      docVersion: 1,
      editorId: ownerId,
      contributorIds: [],
    });

    const res = await owner.raw("GET", `/pages/${root.id}/export?format=html&children=1&files=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const zip = new Uint8Array(await res.arrayBuffer());
    const entries = readZipDirectory(zip);
    const names = entries.map((e) => e.name);
    expect(names).toEqual(["Guide.html", "Guide/Setup.html", "Guide/Setup (1).html", `files/${file.id}/diagram one.png`]);

    const read = (name: string) => new TextDecoder().decode(readZipEntry(zip, entries.find((e) => e.name === name)!));
    expect(read("Guide.html")).toContain('href="Guide/Setup.html"');
    expect(read("Guide/Setup.html")).toContain(`src="../files/${file.id}/diagram%20one.png"`);
    expect(read(`files/${file.id}/diagram one.png`)).toBe("diagram bytes");

    const { list, ok } = await unzipList(zip);
    expect(ok).toBe(true);
    expect(list).toContain("Guide/Setup (1).html");
  });

  test("space export requires a space admin and zips every page", async () => {
    const { client: member, user } = await t.addMember(owner, "export-reader@example.com");
    await owner.post(`/spaces/${spaceId}/members/add`, { role: "reader", userIds: [user.id] });
    expect((await member.raw("GET", `/spaces/${spaceId}/export?format=html`)).status).toBe(403);
    const res = await owner.raw("GET", `/spaces/${spaceId}/export?format=html`);
    expect(res.status).toBe(200);
    const entries = readZipDirectory(new Uint8Array(await res.arrayBuffer()));
    expect(entries.map((e) => e.name)).toContain("Guide/Setup.html");
    expect(entries.map((e) => e.name)).toContain("Solo _page_.html");
  });

  test("markdown export uses the markdown serializer", async () => {
    const page = await create("Notes");
    await savePageContent(page.id, {
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello", marks: [{ type: "bold" }] }] }] },
      docVersion: 1,
      editorId: ownerId,
      contributorIds: [],
    });
    const res = await owner.raw("GET", `/pages/${page.id}/export?format=markdown`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/markdown");
    const text = await res.text();
    expect(text).toStartWith("# Notes\n\n");
    expect(text).toContain("**hello**");
  });
});
