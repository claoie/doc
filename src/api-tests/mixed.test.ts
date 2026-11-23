import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bothServers, doc, startServer, type Client, type TestServer } from "./harness";
import { describeHandover } from "./harness/handover";
import { sameSessionOn } from "./harness/realtime";

/**
 * A Bun and a Rust server on one database, as while one replaces the other.
 * Needs the Rust server built (`cargo build --release -p doc-server`); without
 * it the file is skipped, whichever server the suite runs against.
 */

if (!bothServers) {
  test.skip("a Bun and a Rust server side by side (the Rust server is not built)", () => {});
} else {
  describeHandover("a Bun copy hands realtime to a Rust copy, which hands it to a Bun copy", ["bun", "rust", "bun"]);
  describeHandover("a Rust copy hands realtime to a Bun copy, which hands it to a Rust copy", ["rust", "bun", "rust"]);

  describe("a Bun and a Rust server on one database, each reading what the other wrote", () => {
    let bun: TestServer;
    let rust: TestServer;
    let owner: Client;
    let onRust: Client;
    let spaceId: string;
    let member: Client;

    beforeAll(async () => {
      bun = await startServer({ target: "bun" });
      ({ owner, spaceId } = await bun.setupOwner());
      // The same database and the same files, as two copies of one deployment share them.
      rust = await startServer({ target: "rust", keepDatabase: true, env: { STORAGE_PATH: bun.storageDir } });
      onRust = sameSessionOn(rust, owner);
      ({ client: member } = await rust.addMember(onRust, "member@example.com"));
    });

    afterAll(async () => {
      await Promise.all([bun?.close(), rust?.close()]);
    });

    /** The same request, signed in the same way, to both servers: the answers must be equal, and not an error. */
    const same = async (pathname: string, body?: unknown, method: "GET" | "POST" = body === undefined ? "GET" : "POST") => {
      const [fromBun, fromRust] = await Promise.all([owner.request(method, pathname, body), onRust.request(method, pathname, body)]);
      expect({ pathname, status: fromRust.status, body: fromRust.body }).toEqual({ pathname, status: fromBun.status, body: fromBun.body });
      expect({ pathname, status: fromBun.status }).toEqual({ pathname, status: 200 });
      return fromBun.body.data;
    };

    test("a password set through one server signs in on the other", async () => {
      // The owner set theirs on Bun, the member on Rust.
      expect((await rust.client().post("/auth/login", { email: "owner@example.com", password: "owner-password" })).status).toBe(200);
      expect((await bun.client().post("/auth/login", { email: "member@example.com", password: "member-password" })).status).toBe(200);
      // A password changed on Rust is the one Bun checks.
      const changed = await member.post("/auth/change-password", { currentPassword: "member-password", newPassword: "changed-on-rust" });
      expect(changed.status).toBe(200);
      expect((await bun.client().post("/auth/login", { email: "member@example.com", password: "member-password" })).status).toBe(401);
      expect((await bun.client().post("/auth/login", { email: "member@example.com", password: "changed-on-rust" })).status).toBe(200);
    });

    test("a session started on one server is the same session on the other", async () => {
      const onBun = sameSessionOn(bun, member);
      expect((await onBun.get("/me")).body).toEqual((await member.get("/me")).body);
      expect((await onBun.post("/auth/logout")).status).toBe(200);
      expect((await member.get("/me")).status).toBe(401);
    });

    test("what each wrote, both read the same", async () => {
      // Written through Bun: a page with a little of everything, a file, a comment, a label, a base.
      const content: { type: string; content: unknown[] } = doc("Mixed 日本語 😀 content");
      content.content.push(
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "A heading" }] },
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a list item", marks: [{ type: "bold" }] }] }] }],
        },
      );
      const page = (await owner.post("/pages", { spaceId, title: "Written on Bun 🎉", content })).body.data.page;
      const child = (await onRust.post("/pages", { spaceId, parentId: page.id, title: "Child written on Rust", content: doc("from Rust") })).body.data.page;
      const bytes = new Uint8Array(4096).map((_, i) => i % 251);
      const file = (await owner.uploadFile(new File([bytes], "data file.bin", { type: "application/octet-stream" }), page.id)).body.data;
      const avatar = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(64)]);
      const me = (await onRust.upload("/me/avatar", { file: new File([avatar], "me.png", { type: "image/png" }) })).body.data.user;
      expect((await owner.post("/comments", { pageId: page.id, body: doc("A comment through Bun") })).status).toBe(200);
      expect((await onRust.post("/comments", { pageId: page.id, body: doc("A comment through Rust") })).status).toBe(200);
      expect((await onRust.post(`/pages/${page.id}/labels`, { names: ["Mixed Label"] })).status).toBe(200);
      expect((await owner.post("/favorites", { pageId: page.id })).status).toBe(200);
      const base = (await owner.post("/bases", { spaceId, title: "Scores", template: "kanban" })).body.data.page;
      const score = (await onRust.post(`/bases/${base.id}/properties`, { name: "Score", type: "number" })).body.data;
      const doubled = (await owner.post(`/bases/${base.id}/properties`, { name: "Doubled", type: "formula", options: { source: 'prop("Score") * 2' } })).body.data;
      for (const [i, value] of [3, 1.5, -2].entries()) {
        const target = i % 2 ? owner : onRust;
        expect((await target.post(`/bases/${base.id}/rows`, { cells: { [score.id]: value } })).status).toBe(200);
      }
      const share = (await onRust.post(`/pages/${page.id}/share`, { includeChildren: true })).body.data.share;

      // Read back through both: every answer the same.
      await same("/me");
      await same("/members");
      await same("/groups");
      await same("/spaces");
      await same(`/spaces/${spaceId}`);
      await same(`/spaces/${spaceId}/members`);
      await same(`/spaces/${spaceId}/pages`);
      await same(`/spaces/${spaceId}/pages?parentId=${page.id}`);
      await same(`/spaces/${spaceId}/shares`);
      await same(`/spaces/${spaceId}/trash`);
      await same(`/pages/${page.slugId}`);
      await same(`/pages/${child.id}`);
      await same("/pages/recent");
      await same(`/pages/${page.id}/comments`);
      await same(`/pages/${page.id}/labels`);
      await same("/labels");
      await same(`/pages/${page.id}/files`);
      await same(`/pages/${page.id}/versions`);
      await same(`/pages/${page.id}/backlinks`);
      await same(`/pages/${page.id}/links`);
      await same(`/pages/${page.id}/share`);
      await same("/favorites");
      await same("/notifications");
      await same("/search?q=mixed");
      await same("/search?q=日本語");
      await same("/search/suggest?q=wri");
      await same(`/bases/${base.id}`);
      const rows = await same(`/bases/${base.id}/rows/query`, { sorts: [{ propertyId: score.id, direction: "asc" }] });
      // The row the base started with has no score: its formula gives 0, and it sorts last.
      expect(rows.items.map((r: any) => r.cells[doubled.id])).toEqual([-4, 3, 6, 0]);
      await same(`/bases/${base.id}/rows/query`, { filter: { op: "and", children: [{ propertyId: doubled.id, op: "gt", value: 0 }] } });

      // The public share, to someone signed in nowhere.
      const [publicBun, publicRust] = await Promise.all([bun.client().get(`/public/shares/${share.key}`), rust.client().get(`/public/shares/${share.key}`)]);
      expect(publicRust.body).toEqual(publicBun.body);
      expect(publicBun.status).toBe(200);

      // Files and images, whichever server stored them.
      for (const url of [file.url, me.avatarUrl]) {
        const [a, b] = await Promise.all([owner.fetch(url), onRust.fetch(url)]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(new Uint8Array(await b.arrayBuffer())).toEqual(new Uint8Array(await a.arrayBuffer()));
        for (const name of ["content-type", "content-disposition", "etag", "last-modified", "cache-control"]) {
          expect({ name, value: b.headers.get(name) }).toEqual({ name, value: a.headers.get(name) });
        }
      }

      // A page exported as Markdown, byte for byte.
      const [exportBun, exportRust] = await Promise.all([owner.raw("GET", `/pages/${page.id}/export`), onRust.raw("GET", `/pages/${page.id}/export`)]);
      expect(await exportRust.text()).toBe(await exportBun.text());
      expect(exportRust.headers.get("content-disposition")).toBe(exportBun.headers.get("content-disposition"));
    });
  });
}
