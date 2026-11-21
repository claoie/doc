import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { doc, startServer, type Client, type TestServer } from "./harness";
import {
  NO_SUCH_ID,
  SLUG_ID_RE,
  anyId,
  anyTime,
  createPage,
  createSpace,
  data,
  docOf,
  expectError,
  expectForbidden,
  expectInvalid,
  expectNotFound,
  paragraph,
  person,
  text,
  titles,
  treeItem,
  userRef,
  type Person,
} from "./harness/spaces-pages";
import { joinPage, openSocket, takeEvents, treeEvent } from "./harness/spaces-pages-ws";

let t: TestServer;
let owner: Client;
let ownerUser: any;
let spaceAdmin: Person;
let writer: Person;
let reader: Person;
let outsider: Person;

let counter = 0;
/** A space of its own for a test: owner and `spaceAdmin` admins, `writer` and `reader` in those roles. */
const newSpace = async (name: string) => {
  const space = await createSpace(owner, name, `tree-${++counter}`);
  data(await owner.post(`/spaces/${space.id}/members/add`, { role: "admin", userIds: [spaceAdmin.id] }));
  data(await owner.post(`/spaces/${space.id}/members/add`, { role: "writer", userIds: [writer.id] }));
  data(await owner.post(`/spaces/${space.id}/members/add`, { role: "reader", userIds: [reader.id] }));
  return space;
};

/** `[title, position]` of the children of a parent (or of the root pages). */
const order = async (spaceId: string, parentId?: string) =>
  (data(await owner.get(`/spaces/${spaceId}/pages${parentId ? `?parentId=${parentId}` : ""}`)) as any[]).map((p) => [p.title, p.position]);

const children = async (spaceId: string, parentId?: string) =>
  titles(await owner.get(`/spaces/${spaceId}/pages${parentId ? `?parentId=${parentId}` : ""}`));

const page = async (id: string) => data(await owner.get(`/pages/${id}`)).page;

const onDisk = (...parts: string[]) => existsSync(path.join(t.storageDir, ...parts));

beforeAll(async () => {
  t = await startServer();
  ({ owner, user: ownerUser } = await t.setupOwner());
  spaceAdmin = await person(t, owner, "space-admin@example.com");
  writer = await person(t, owner, "writer@example.com");
  reader = await person(t, owner, "reader@example.com");
  outsider = await person(t, owner, "outsider@example.com");
});

afterAll(async () => {
  await t.close();
});

describe("positions", () => {
  test("appending counts up: a0 … a9, aA … aZ, aa … az, then b00", async () => {
    const space = await newSpace("Appending");
    const positions: string[] = [];
    for (let i = 0; i < 64; i++) positions.push((await createPage(owner, { spaceId: space.id, title: `P${i}` })).position);
    const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    expect(positions).toEqual([...[...digits].map((d) => `a${d}`), "b00", "b01"]);
    // The listing sorts bytewise, which is creation order here.
    expect((await order(space.id)).map(([title]) => title)).toEqual(positions.map((_, i) => `P${i}`));

    // Moving pages to the front counts down: Zz … Z0, then Yzz.
    const ids = (data(await owner.get(`/spaces/${space.id}/pages`)) as any[]).map((p) => p.id);
    const moved: string[] = [];
    for (let i = 0; i < 64; i++) {
      moved.push(data(await owner.post(`/pages/${ids[63 - i]}/move`, { parentId: null, afterId: null })).page.position);
    }
    expect(moved).toEqual([...[...digits].reverse().map((d) => `Z${d}`), "Yzz", "Yzy"]);
    expect((await order(space.id)).map(([title]) => title)).toEqual(positions.map((_, i) => `P${i}`));
  });

  test("inserting between neighbours takes the midpoint, growing the key when there is no room", async () => {
    const space = await newSpace("Between");
    const a = await createPage(owner, { spaceId: space.id, title: "A" });
    const b = await createPage(owner, { spaceId: space.id, title: "B" });
    expect([a.position, b.position]).toEqual(["a0", "a1"]);
    // Always right after A: each key halves the gap to A.
    const afterA: string[] = [];
    for (let i = 0; i < 9; i++) afterA.push((await createPage(owner, { spaceId: space.id, title: `after A ${i}`, afterId: a.id })).position);
    expect(afterA).toEqual(["a0V", "a0G", "a08", "a04", "a02", "a01", "a00V", "a00G", "a008"]);
    // Always right before B: after the page added last.
    let last = (await order(space.id)).at(-2)!;
    expect(last).toEqual(["after A 0", "a0V"]);
    const beforeB: string[] = [];
    let afterId = (data(await owner.get(`/spaces/${space.id}/pages`)) as any[]).at(-2).id;
    for (let i = 0; i < 7; i++) {
      const created = await createPage(owner, { spaceId: space.id, title: `before B ${i}`, afterId });
      beforeB.push(created.position);
      afterId = created.id;
    }
    expect(beforeB).toEqual(["a0l", "a0t", "a0x", "a0z", "a0zV", "a0zl", "a0zt"]);
    last = (await order(space.id)).at(-1)!;
    expect(last).toEqual(["B", "a1"]);
    const listed = (await order(space.id)).map(([, position]) => position);
    expect(listed).toEqual(["a0", "a008", "a00G", "a00V", "a01", "a02", "a04", "a08", "a0G", "a0V", "a0l", "a0t", "a0x", "a0z", "a0zV", "a0zl", "a0zt", "a1"]);
  });

  test("each parent has its own sequence, and trashed siblings do not count", async () => {
    const space = await newSpace("Per parent");
    const parent = await createPage(owner, { spaceId: space.id, title: "Parent" });
    const other = await createPage(owner, { spaceId: space.id, title: "Other" });
    expect([parent.position, other.position]).toEqual(["a0", "a1"]);
    const one = await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "One" });
    const two = await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "Two" });
    const three = await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "Three" });
    expect([one.position, two.position, three.position]).toEqual(["a0", "a1", "a2"]);
    expect((await createPage(owner, { spaceId: space.id, parentId: other.id, title: "Elsewhere" })).position).toBe("a0");
    // With Two and Three in the trash, the next page takes the place after One.
    data(await owner.post(`/pages/${two.id}/delete`));
    data(await owner.post(`/pages/${three.id}/delete`));
    const four = await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "Four" });
    expect(four.position).toBe("a1");
    // Restored pages keep their keys, so two siblings can share one; the id breaks the tie.
    data(await owner.post(`/pages/${two.id}/restore`));
    const tied = [two, four].sort((x, y) => (x.id < y.id ? -1 : 1)).map((p) => [p.title, "a1"]);
    expect(await order(space.id, parent.id)).toEqual([["One", "a0"], ...tied]);
  });

  test("positions that leave no key between them are a conflict", async () => {
    const space = await newSpace("Conflict");
    const a = await createPage(owner, { spaceId: space.id, title: "A" });
    const b = await createPage(owner, { spaceId: space.id, title: "B" });
    // Keys the server never produces, arranged directly: nothing sorts between "a" and "a0".
    await t.sql`UPDATE pages SET position = 'a' WHERE id = ${a.id}`;
    await t.sql`UPDATE pages SET position = 'a0' WHERE id = ${b.id}`;
    expectError(await owner.post("/pages", { spaceId: space.id, afterId: a.id }), 409, "position_conflict", "Could not place the page between its neighbours");
    await t.sql`UPDATE pages SET position = 'a-' WHERE id = ${b.id}`;
    expectError(await owner.post("/pages", { spaceId: space.id }), 409, "position_conflict", "Could not place the page between its neighbours");
    // Keys outside the usual format are still ordered, as plain base-62 fractions.
    await t.sql`UPDATE pages SET position = 'm' WHERE id = ${a.id}`;
    await t.sql`UPDATE pages SET position = 'n5' WHERE id = ${b.id}`;
    expect((await createPage(owner, { spaceId: space.id, title: "Between", afterId: a.id })).position).toBe("n");
    expect((await createPage(owner, { spaceId: space.id, title: "Last" })).position).toBe("u");
  });
});

describe("POST /pages/:id/move", () => {
  test("moves a page among its siblings: first, after one of them, last", async () => {
    const space = await newSpace("Reorder");
    const [a, b, c, d] = [
      await createPage(owner, { spaceId: space.id, title: "A" }),
      await createPage(owner, { spaceId: space.id, title: "B" }),
      await createPage(owner, { spaceId: space.id, title: "C" }),
      await createPage(owner, { spaceId: space.id, title: "D" }),
    ];
    const res = await writer.client.post(`/pages/${d.id}/move`, { parentId: null, afterId: null });
    expect(res.status).toBe(200);
    // The answer is the whole page; a move changes neither its editor nor its update time.
    expect(res.body).toEqual({ data: { page: { ...d, position: "Zz" } } });
    expect(await order(space.id)).toEqual([["D", "Zz"], ["A", "a0"], ["B", "a1"], ["C", "a2"]]);
    expect(data(await owner.post(`/pages/${a.id}/move`, { parentId: null, afterId: b.id.toUpperCase() })).page.position).toBe("a1V");
    expect(await children(space.id)).toEqual(["D", "B", "A", "C"]);
    expect(data(await owner.post(`/pages/${d.slugId}/move`, { parentId: null, afterId: c.id })).page.position).toBe("a3");
    expect(await children(space.id)).toEqual(["B", "A", "C", "D"]);
    // Moving a page to where it already is gives it a new key between the same neighbours.
    expect(data(await owner.post(`/pages/${a.id}/move`, { parentId: null, afterId: b.id })).page.position).toBe("a1V");
    expect(data(await owner.post(`/pages/${c.id}/move`, { afterId: a.id })).page.position).toBe("a2");
    expect(await order(space.id)).toEqual([["B", "a1"], ["A", "a1V"], ["C", "a2"], ["D", "a3"]]);
  });

  test("moves a page, with its subtree, under another parent or back to the root", async () => {
    const space = await newSpace("Reparent");
    const x = await createPage(owner, { spaceId: space.id, title: "X" });
    const y = await createPage(owner, { spaceId: space.id, title: "Y" });
    const y1 = await createPage(owner, { spaceId: space.id, parentId: y.id, title: "Y1" });
    const y2 = await createPage(owner, { spaceId: space.id, parentId: y.id, title: "Y2" });
    const deep = await createPage(owner, { spaceId: space.id, parentId: y1.id, title: "Deep" });

    const moved = data(await owner.post(`/pages/${y1.id}/move`, { parentId: x.id.toUpperCase(), afterId: null })).page;
    expect(moved).toEqual({ ...y1, parentId: x.id, position: "a0", hasChildren: true });
    expect(await children(space.id, x.id)).toEqual(["Y1"]);
    expect(await children(space.id, y.id)).toEqual(["Y2"]);
    expect(data(await owner.get(`/pages/${deep.id}`)).breadcrumbs.map((b: any) => b.title)).toEqual(["X", "Y1", "Deep"]);

    // Without afterId the page goes first; without parentId it goes to the root.
    expect(data(await owner.post(`/pages/${y2.id}/move`, { parentId: x.id })).page).toMatchObject({ parentId: x.id, position: "Zz" });
    expect(await children(space.id, x.id)).toEqual(["Y2", "Y1"]);
    expect(data(await owner.post(`/pages/${y2.id}/move`, { afterId: x.id })).page).toMatchObject({ parentId: null, position: "a0V" });
    expect(await children(space.id)).toEqual(["X", "Y2", "Y"]);
    expect(data(await owner.post(`/pages/${y1.id}/move`, {})).page).toMatchObject({ parentId: null, position: "Zz" });
    expect(data(await owner.post(`/pages/${y1.id}/move`, { parentId: "", afterId: "" })).page).toMatchObject({ parentId: null, position: "Zz" });
    expect(await children(space.id)).toEqual(["Y1", "X", "Y2", "Y"]);
    expect(await page(x.id)).toMatchObject({ hasChildren: false });
  });

  test("a page cannot go under itself or its descendants, nor after itself", async () => {
    const space = await newSpace("Cycles");
    const x = await createPage(owner, { spaceId: space.id, title: "X" });
    const y = await createPage(owner, { spaceId: space.id, parentId: x.id, title: "Y" });
    const z = await createPage(owner, { spaceId: space.id, parentId: y.id, title: "Z" });
    const cycle = "A page cannot be moved under itself or its descendants";
    expectInvalid(await owner.post(`/pages/${x.id}/move`, { parentId: x.id, afterId: null }), cycle);
    expectInvalid(await owner.post(`/pages/${x.id}/move`, { parentId: y.id, afterId: null }), cycle);
    expectInvalid(await owner.post(`/pages/${x.id}/move`, { parentId: z.id.toUpperCase(), afterId: null }), cycle);
    expectInvalid(await owner.post(`/pages/${y.id}/move`, { parentId: z.id, afterId: null }), cycle);
    // The cycle is reported before a bad afterId.
    expectInvalid(await owner.post(`/pages/${x.id}/move`, { parentId: x.id, afterId: x.id }), cycle);
    expectInvalid(await owner.post(`/pages/${x.id}/move`, { parentId: null, afterId: x.id }), "afterId cannot be the page itself");
    expectInvalid(await owner.post(`/pages/${y.id}/move`, { parentId: x.id, afterId: y.id.toUpperCase() }), "afterId cannot be the page itself");
    // Under a descendant's sibling is fine.
    const w = await createPage(owner, { spaceId: space.id, title: "W" });
    expect(data(await owner.post(`/pages/${z.id}/move`, { parentId: w.id })).page.parentId).toBe(w.id);
    expect(data(await owner.post(`/pages/${x.id}/move`, { parentId: z.id })).page.parentId).toBe(z.id);
    expect(data(await owner.get(`/pages/${y.id}`)).breadcrumbs.map((b: any) => b.title)).toEqual(["W", "Z", "X", "Y"]);
  });

  test("the parent and the sibling must exist where the page is going", async () => {
    const space = await newSpace("Move targets");
    const other = await newSpace("Move elsewhere");
    const a = await createPage(owner, { spaceId: space.id, title: "A" });
    const b = await createPage(owner, { spaceId: space.id, title: "B" });
    const b1 = await createPage(owner, { spaceId: space.id, parentId: b.id, title: "B1" });
    const foreign = await createPage(owner, { spaceId: other.id, title: "Foreign" });
    const trashed = await createPage(owner, { spaceId: space.id, title: "Trashed" });
    data(await owner.post(`/pages/${trashed.id}/delete`));
    const move = (body: unknown) => owner.post(`/pages/${a.id}/move`, body);
    for (const parentId of ["x", 5, b.slugId]) expectInvalid(await move({ parentId, afterId: null }), "parentId must be a valid id");
    for (const afterId of ["x", 5, b.slugId]) expectInvalid(await move({ parentId: null, afterId }), "afterId must be a valid id");
    expectNotFound(await move({ parentId: NO_SUCH_ID }), "Parent page");
    expectNotFound(await move({ parentId: foreign.id }), "Parent page");
    expectNotFound(await move({ parentId: trashed.id }), "Parent page");
    expectNotFound(await move({ parentId: null, afterId: NO_SUCH_ID }), "Sibling page");
    // B1 is a child of B, not a root page; B is not a child of itself.
    expectNotFound(await move({ parentId: null, afterId: b1.id }), "Sibling page");
    expectNotFound(await move({ parentId: b.id, afterId: b.id }), "Sibling page");
    expectNotFound(await move({ parentId: null, afterId: foreign.id }), "Sibling page");
    expectNotFound(await move({ parentId: null, afterId: trashed.id }), "Sibling page");
    // Nothing moved.
    expect(await order(space.id)).toEqual([["A", "a0"], ["B", "a1"]]);
    expect(data(await move({ parentId: b.id, afterId: b1.id })).page).toMatchObject({ parentId: b.id, position: "a1" });
  });

  test("needs a writer, and a page that is not in the trash", async () => {
    const space = await newSpace("Move guard");
    const a = await createPage(owner, { spaceId: space.id, title: "A" });
    const b = await createPage(owner, { spaceId: space.id, title: "B" });
    expectForbidden(await reader.client.post(`/pages/${b.id}/move`, { parentId: null, afterId: null }));
    expectNotFound(await outsider.client.post(`/pages/${b.id}/move`, { parentId: null, afterId: null }), "Page");
    expectNotFound(await owner.post(`/pages/${NO_SUCH_ID}/move`, { parentId: null, afterId: null }), "Page");
    expect(data(await spaceAdmin.client.post(`/pages/${b.id}/move`, { parentId: a.id })).page.parentId).toBe(a.id);
    data(await owner.post(`/pages/${b.id}/delete`));
    expectNotFound(await owner.post(`/pages/${b.id}/move`, { parentId: null, afterId: null }), "Page");
    expect((await page(b.id)).parentId).toBe(a.id);
  });

  test("announces the tree of the space, once per move", async () => {
    const space = await newSpace("Move events");
    const a = await createPage(owner, { spaceId: space.id, title: "A" });
    const socket = await openSocket(reader.client);
    const stranger = await openSocket(outsider.client);
    data(await owner.post(`/pages/${a.id}/move`, { parentId: null, afterId: null }));
    expect(await takeEvents(socket)).toEqual([treeEvent(space.id)]);
    expectInvalid(await owner.post(`/pages/${a.id}/move`, { parentId: a.id }), "A page cannot be moved under itself or its descendants");
    expect(await takeEvents(socket)).toEqual([]);
    expect(await takeEvents(stranger)).toEqual([]);
    await socket.close();
    await stranger.close();
  });
});

describe("POST /pages/:id/move-to-space", () => {
  test("moves the page and everything under it to the end of the other space's root", async () => {
    const from = await newSpace("From");
    const to = await newSpace("To");
    await createPage(owner, { spaceId: to.id, title: "Already there" });
    await createPage(owner, { spaceId: to.id, title: "Also there" });
    const parent = await createPage(owner, { spaceId: from.id, title: "Parent" });
    const moving = await createPage(owner, { spaceId: from.id, parentId: parent.id, title: "Moving", icon: "🚚", content: doc("cargo") });
    const kid = await createPage(owner, { spaceId: from.id, parentId: moving.id, title: "Kid" });
    const kid2 = await createPage(owner, { spaceId: from.id, parentId: moving.id, title: "Kid 2" });
    const grandkid = await createPage(owner, { spaceId: from.id, parentId: kid.id, title: "Grandkid" });
    const trashedKid = await createPage(owner, { spaceId: from.id, parentId: moving.id, title: "Trashed kid" });
    data(await owner.post(`/pages/${trashedKid.id}/delete`));
    const sibling = await createPage(owner, { spaceId: from.id, parentId: parent.id, title: "Stays" });

    const res = await writer.client.post(`/pages/${moving.id}/move-to-space`, { spaceId: to.id.toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { page: { ...moving, spaceId: to.id, parentId: null, position: "a2", hasChildren: true } } });
    expect(await order(to.id)).toEqual([["Already there", "a0"], ["Also there", "a1"], ["Moving", "a2"]]);
    // Descendants keep their parents and positions.
    expect(data(await owner.get(`/spaces/${to.id}/pages?parentId=${moving.id}`))).toEqual([
      { ...treeItem(kid), spaceId: to.id, hasChildren: true },
      { ...treeItem(kid2), spaceId: to.id },
    ]);
    expect(await page(grandkid.id)).toMatchObject({ spaceId: to.id, parentId: kid.id, position: grandkid.position });
    // Trashed descendants go along, and stay in the trash.
    expect(data(await owner.get(`/spaces/${to.id}/trash`)).map((p: any) => [p.id, p.spaceId, p.parentId])).toEqual([[trashedKid.id, to.id, moving.id]]);
    expect(data(await owner.get(`/spaces/${from.id}/trash`))).toEqual([]);
    expect(await children(from.id, parent.id)).toEqual(["Stays"]);
    expect(await page(sibling.id)).toMatchObject({ spaceId: from.id });
    expect(data(await owner.get(`/pages/${grandkid.id}`))).toMatchObject({ space: { id: to.id }, breadcrumbs: [{ title: "Moving" }, { title: "Kid" }, { title: "Grandkid" }] });
  });

  test("the files of the moved pages follow them", async () => {
    const from = await createSpace(owner, "Files from", `tree-${++counter}`);
    const to = await createSpace(owner, "Files to", `tree-${++counter}`);
    const fromOnly = await person(t, owner, `from-only-${counter}@example.com`, { space: from.id, spaceRole: "reader" });
    const toOnly = await person(t, owner, `to-only-${counter}@example.com`, { space: to.id, spaceRole: "reader" });
    const moving = await createPage(owner, { spaceId: from.id, title: "Moving" });
    const kid = await createPage(owner, { spaceId: from.id, parentId: moving.id, title: "Kid" });
    const staying = await createPage(owner, { spaceId: from.id, title: "Staying" });
    const upload = async (pageId: string, name: string) => data(await owner.uploadFile(new File([`bytes of ${name}`], name, { type: "text/plain" }), pageId));
    const [rootFile, kidFile, stayingFile] = [await upload(moving.id, "root.txt"), await upload(kid.id, "kid.txt"), await upload(staying.id, "staying.txt")];
    const status = async (who: Person, file: any) => (await who.client.raw("GET", file.url.slice("/api".length))).status;
    expect([await status(fromOnly, rootFile), await status(fromOnly, kidFile), await status(toOnly, kidFile)]).toEqual([200, 200, 404]);
    data(await owner.post(`/pages/${moving.id}/move-to-space`, { spaceId: to.id }));
    expect([await status(fromOnly, rootFile), await status(fromOnly, kidFile), await status(fromOnly, stayingFile)]).toEqual([404, 404, 200]);
    expect([await status(toOnly, rootFile), await status(toOnly, kidFile), await status(toOnly, stayingFile)]).toEqual([200, 200, 404]);
    const rows = await t.sql`SELECT name, space_id FROM files WHERE id IN (${rootFile.id}, ${kidFile.id}, ${stayingFile.id}) ORDER BY name`;
    expect(rows.map((r: any) => [r.name, r.space_id])).toEqual([["kid.txt", to.id], ["root.txt", to.id], ["staying.txt", from.id]]);
    expect(data(await toOnly.client.get(`/pages/${kid.id}/files`)).map((f: any) => f.name)).toEqual(["kid.txt"]);
  });

  test("shares survive the move unless the target space has sharing turned off", async () => {
    const from = await newSpace("Shares from");
    const open = await newSpace("Shares open");
    const closed = await newSpace("Shares closed");
    data(await owner.post(`/spaces/${closed.id}/update`, { settings: { sharingDisabled: true } }));
    const make = async (title: string) => {
      const root = await createPage(owner, { spaceId: from.id, title });
      const kid = await createPage(owner, { spaceId: from.id, parentId: root.id, title: `${title} kid` });
      const rootShare = data(await owner.post(`/pages/${root.id}/share`, { includeChildren: true })).share;
      const kidShare = data(await owner.post(`/pages/${kid.id}/share`, {})).share;
      return { root, kid, rootShare, kidShare };
    };
    const kept = await make("Kept");
    const dropped = await make("Dropped");
    const stays = await make("Stays");
    data(await owner.post(`/pages/${kept.root.id}/move-to-space`, { spaceId: open.id }));
    data(await owner.post(`/pages/${dropped.root.id}/move-to-space`, { spaceId: closed.id }));
    expect(data(await owner.get(`/pages/${kept.root.id}/share`)).share).toEqual(kept.rootShare);
    expect(data(await owner.get(`/pages/${kept.kid.id}/share`)).share).toEqual(kept.kidShare);
    expect(data(await owner.get(`/spaces/${open.id}/shares`)).map((s: any) => s.id).sort()).toEqual([kept.rootShare.id, kept.kidShare.id].sort());
    expect(data(await owner.get(`/pages/${dropped.root.id}/share`))).toEqual({ share: null, inheritedFrom: null });
    expect(data(await owner.get(`/pages/${dropped.kid.id}/share`))).toEqual({ share: null, inheritedFrom: null });
    expect(data(await owner.get(`/spaces/${from.id}/shares`)).map((s: any) => s.id).sort()).toEqual([stays.rootShare.id, stays.kidShare.id].sort());
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM shares WHERE id IN (${dropped.rootShare.id}, ${dropped.kidShare.id})`;
    expect(n).toBe(0);
  });

  test("moving to the space the page is already in changes nothing and announces nothing", async () => {
    const space = await newSpace("Same space");
    const parent = await createPage(owner, { spaceId: space.id, title: "Parent" });
    const child = await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "Child" });
    const socket = await openSocket(owner);
    const res = await owner.post(`/pages/${child.id}/move-to-space`, { spaceId: space.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { page: child } });
    expect(await takeEvents(socket)).toEqual([]);
    await socket.close();
  });

  test("needs a writer in both spaces", async () => {
    const from = await newSpace("Guard from");
    const to = await newSpace("Guard to");
    const mine = await createSpace(writer.client, "Writer's own", `tree-${++counter}`);
    const readOnly = await createSpace(owner, "Read only", `tree-${++counter}`);
    data(await owner.post(`/spaces/${readOnly.id}/members/add`, { role: "reader", userIds: [writer.id] }));
    const hidden = await createSpace(owner, "Hidden", `tree-${++counter}`);
    const p = await createPage(owner, { spaceId: from.id, title: "Guarded" });
    const move = (client: Client, spaceId: unknown) => client.post(`/pages/${p.id}/move-to-space`, { spaceId });
    for (const spaceId of [undefined, null, "", from.slug, 5]) expectInvalid(await move(owner, spaceId), "spaceId must be a valid id");
    expectNotFound(await move(owner, NO_SUCH_ID), "Space");
    // The owner is not a member of the writer's own space.
    expectNotFound(await move(owner, mine.id), "Space");
    expectForbidden(await move(reader.client, to.id));
    expectNotFound(await move(outsider.client, to.id), "Page");
    expectNotFound(await move(writer.client, hidden.id), "Space");
    expectForbidden(await move(writer.client, readOnly.id));
    // The page is checked before the body.
    expectForbidden(await move(reader.client, "nope"));
    expect((await page(p.id)).spaceId).toBe(from.id);
    expect(data(await move(writer.client, mine.id)).page.spaceId).toBe(mine.id);
    // The owner cannot see it any more.
    expectNotFound(await owner.get(`/pages/${p.id}`), "Page");
    const trashed = await createPage(owner, { spaceId: from.id, title: "Trashed" });
    data(await owner.post(`/pages/${trashed.id}/delete`));
    expectNotFound(await move(owner, to.id), "Page");
    expectNotFound(await owner.post(`/pages/${trashed.id}/move-to-space`, { spaceId: to.id }), "Page");
  });

  test("announces the tree of both spaces to their members", async () => {
    const from = await createSpace(owner, "Events from", `tree-${++counter}`);
    const to = await createSpace(owner, "Events to", `tree-${++counter}`);
    data(await owner.post(`/spaces/${from.id}/members/add`, { role: "reader", userIds: [reader.id] }));
    data(await owner.post(`/spaces/${to.id}/members/add`, { role: "reader", userIds: [writer.id] }));
    const p = await createPage(owner, { spaceId: from.id, title: "Traveller" });
    const [both, fromOnly, toOnly, neither] = await Promise.all([owner, reader.client, writer.client, outsider.client].map((c) => openSocket(c)));
    data(await owner.post(`/pages/${p.id}/move-to-space`, { spaceId: to.id }));
    expect(await takeEvents(both!)).toEqual([treeEvent(from.id), treeEvent(to.id)]);
    expect(await takeEvents(fromOnly!)).toEqual([treeEvent(from.id)]);
    expect(await takeEvents(toOnly!)).toEqual([treeEvent(to.id)]);
    expect(await takeEvents(neither!)).toEqual([]);
    await Promise.all([both, fromOnly, toOnly, neither].map((s) => s!.close()));
  });

  test("an editor who cannot read the target space is turned out of the page", async () => {
    const from = await createSpace(owner, "Editors from", `tree-${++counter}`);
    const to = await createSpace(owner, "Editors to", `tree-${++counter}`);
    data(await owner.post(`/spaces/${from.id}/members/add`, { role: "writer", userIds: [writer.id] }));
    const p = await createPage(owner, { spaceId: from.id, title: "Open in an editor" });
    const socket = await openSocket(writer.client);
    expect(await joinPage(socket, p.id)).toEqual({ t: "joined", pageId: p.id, version: 0, readOnly: false });
    data(await owner.post(`/pages/${p.id}/move-to-space`, { spaceId: to.id }));
    expect(await socket.nextOf("error")).toEqual({ t: "error", pageId: p.id, message: "You no longer have access to this page" });
    await socket.close();
  });
});

describe("POST /pages/:id/delete and GET /spaces/:id/trash", () => {
  test("moves the page and its descendants to the trash together", async () => {
    const space = await newSpace("Trash");
    const root = await createPage(owner, { spaceId: space.id, title: "Root", icon: "🗑️" });
    const child = await createPage(owner, { spaceId: space.id, parentId: root.id, title: "Child" });
    const leaf = await createPage(owner, { spaceId: space.id, parentId: child.id, title: "Leaf" });
    const bystander = await createPage(owner, { spaceId: space.id, title: "Bystander" });
    const res = await writer.client.post(`/pages/${root.id}/delete`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: {} });
    expect(await children(space.id)).toEqual(["Bystander"]);
    expect(await children(space.id, root.id)).toEqual([]);
    const trashed = await Promise.all([root, child, leaf].map((p) => page(p.id)));
    // One moment for the whole subtree; nothing else about the pages changes.
    expect(trashed[0]).toEqual({ ...root, deletedAt: anyTime() });
    expect(trashed[1]).toEqual({ ...child, deletedAt: trashed[0].deletedAt });
    expect(trashed[2]).toEqual({ ...leaf, deletedAt: trashed[0].deletedAt });
    expect((await page(bystander.id)).deletedAt).toBeNull();
    const rows = await t.sql`SELECT deleted_by, count(DISTINCT deleted_at)::int AS moments FROM pages WHERE id IN (${root.id}, ${child.id}, ${leaf.id}) GROUP BY deleted_by`;
    expect(rows).toEqual([{ deleted_by: writer.id, moments: 1 }]);

    // Only the root of what was trashed is listed.
    const trash = await reader.client.get(`/spaces/${space.id}/trash`);
    expect(trash.status).toBe(200);
    expect(trash.body).toEqual({
      data: [
        {
          id: root.id,
          slugId: root.slugId,
          title: "Root",
          icon: "🗑️",
          parentId: null,
          spaceId: space.id,
          position: root.position,
          hasChildren: false,
          isBase: false,
          deletedAt: trashed[0].deletedAt,
          deletedBy: userRef(writer.user),
        },
      ],
    });
  });

  test("the trash lists the root of each trashed subtree, latest first", async () => {
    const space = await newSpace("Trash list");
    const parent = await createPage(owner, { spaceId: space.id, title: "Parent" });
    const early = await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "Trashed early" });
    const earlyKid = await createPage(owner, { spaceId: space.id, parentId: early.id, title: "Early kid" });
    const late = await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "Trashed with parent" });
    const lone = await createPage(owner, { spaceId: space.id, title: "Lone" });
    const live = await createPage(owner, { spaceId: space.id, title: "Live parent" });
    const liveKid = await createPage(owner, { spaceId: space.id, parentId: live.id, title: "Kid of a live parent" });
    expect(data(await owner.get(`/spaces/${space.id}/trash`))).toEqual([]);
    data(await owner.post(`/pages/${early.id}/delete`));
    data(await writer.client.post(`/pages/${lone.id}/delete`));
    data(await spaceAdmin.client.post(`/pages/${parent.id}/delete`));
    data(await owner.post(`/pages/${liveKid.id}/delete`));
    const trash = data(await owner.get(`/spaces/${space.id.toUpperCase()}/trash`));
    expect(trash.map((p: any) => [p.title, p.deletedBy.name])).toEqual([
      ["Kid of a live parent", "Owner"],
      ["Parent", "space-admin"],
      ["Lone", "writer"],
      // Trashed before its parent, so listed on its own; its kid went with it.
      ["Trashed early", "Owner"],
    ]);
    expect(trash.map((p: any) => p.deletedAt)).toEqual([...trash.map((p: any) => p.deletedAt)].sort().reverse());
    expect(trash.map((p: any) => p.id)).not.toContain(late.id);
    expect(trash.map((p: any) => p.id)).not.toContain(earlyKid.id);
    // Trashing the parent did not touch what was already in the trash.
    expect((await page(early.id)).deletedAt).toBe(trash[3].deletedAt);
    expect((await page(earlyKid.id)).deletedAt).toBe(trash[3].deletedAt);
    expect((await page(late.id)).deletedAt).toBe(trash[1].deletedAt);
    const [row] = await t.sql`SELECT deleted_by FROM pages WHERE id = ${early.id}`;
    expect(row.deleted_by).toBe(ownerUser.id);
    // Pages trashed at the same moment are listed by id.
    await t.sql`UPDATE pages SET deleted_at = '2025-01-01T00:00:00Z' WHERE id IN (${lone.id}, ${liveKid.id})`;
    const tied = [lone, liveKid].map((p) => p.id).sort();
    expect(data(await owner.get(`/spaces/${space.id}/trash`)).slice(2).map((p: any) => p.id)).toEqual(tied);
  });

  test("trashing removes the shares of the page and of what is under it", async () => {
    const space = await newSpace("Trash shares");
    const root = await createPage(owner, { spaceId: space.id, title: "Shared root" });
    const kid = await createPage(owner, { spaceId: space.id, parentId: root.id, title: "Shared kid" });
    const other = await createPage(owner, { spaceId: space.id, title: "Shared elsewhere" });
    for (const p of [root, kid, other]) data(await owner.post(`/pages/${p.id}/share`, {}));
    const key = data(await owner.get(`/pages/${kid.id}/share`)).share.key;
    expect((await t.client().get(`/public/shares/${key}`)).status).toBe(200);
    data(await owner.post(`/pages/${root.id}/delete`));
    expect(data(await owner.get(`/spaces/${space.id}/shares`)).map((s: any) => s.pageId)).toEqual([other.id]);
    expectNotFound(await t.client().get(`/public/shares/${key}`), "Share");
    // Restoring does not bring them back.
    data(await owner.post(`/pages/${root.id}/restore`));
    expect(data(await owner.get(`/pages/${kid.id}/share`))).toEqual({ share: null, inheritedFrom: null });
    expect(data(await owner.get(`/pages/${root.id}/share`))).toEqual({ share: null, inheritedFrom: null });
  });

  test("needs a writer; a page already in the trash is not found", async () => {
    const space = await newSpace("Trash guard");
    const p = await createPage(owner, { spaceId: space.id, title: "Guarded" });
    expectForbidden(await reader.client.post(`/pages/${p.id}/delete`));
    expectNotFound(await outsider.client.post(`/pages/${p.id}/delete`), "Page");
    expectNotFound(await owner.post(`/pages/${NO_SUCH_ID}/delete`), "Page");
    expectNotFound(await owner.post("/pages/nope!/delete"), "Page");
    expect((await page(p.id)).deletedAt).toBeNull();
    expect(data(await writer.client.post(`/pages/${p.slugId}/delete`))).toEqual({});
    const deletedAt = (await page(p.id)).deletedAt;
    expectNotFound(await writer.client.post(`/pages/${p.id}/delete`), "Page");
    expectNotFound(await spaceAdmin.client.post(`/pages/${p.id}/delete`), "Page");
    expect((await page(p.id)).deletedAt).toBe(deletedAt);
    // The trash can be read by any member, and only by members.
    expect(data(await reader.client.get(`/spaces/${space.id}/trash`))).toHaveLength(1);
    expectNotFound(await outsider.client.get(`/spaces/${space.id}/trash`), "Space");
    expectNotFound(await owner.get(`/spaces/${space.slug}/trash`), "Space");
    expectNotFound(await owner.get(`/spaces/${NO_SUCH_ID}/trash`), "Space");
  });

  test("deletedBy is null once that user is deleted", async () => {
    const space = await createSpace(owner, "Trash by a leaver", `tree-${++counter}`);
    const leaver = await person(t, owner, "trash-leaver@example.com", { space: space.id, spaceRole: "writer" });
    const p = await createPage(owner, { spaceId: space.id, title: "Left behind" });
    data(await leaver.client.post(`/pages/${p.id}/delete`));
    expect(data(await owner.get(`/spaces/${space.id}/trash`))[0].deletedBy).toEqual(userRef(leaver.user));
    data(await owner.post("/members/delete", { userId: leaver.id }));
    expect(data(await owner.get(`/spaces/${space.id}/trash`))).toEqual([{ ...treeItem(p), deletedAt: anyTime(), deletedBy: null }]);
  });

  test("announces the tree, and editors of the page become read-only", async () => {
    const space = await newSpace("Trash events");
    const p = await createPage(owner, { spaceId: space.id, title: "Being edited" });
    const kid = await createPage(owner, { spaceId: space.id, parentId: p.id, title: "Kid being edited" });
    const socket = await openSocket(writer.client);
    expect(await joinPage(socket, kid.id)).toEqual({ t: "joined", pageId: kid.id, version: 0, readOnly: false });
    data(await owner.post(`/pages/${p.id}/delete`));
    expect(await socket.nextOf("event")).toEqual(treeEvent(space.id));
    expect(await socket.nextOf("joined")).toEqual({ t: "joined", pageId: kid.id, version: 0, readOnly: true });
    data(await owner.post(`/pages/${p.id}/restore`));
    expect(await socket.nextOf("event")).toEqual(treeEvent(space.id));
    expect(await socket.nextOf("joined")).toEqual({ t: "joined", pageId: kid.id, version: 0, readOnly: false });
    await socket.close();
  });

  test("at most the 1000 latest roots are listed", async () => {
    const space = await createSpace(owner, "Full trash", `tree-${++counter}`);
    // Arranged directly: a thousand and one pages, each trashed at its own moment.
    await t.sql`
      INSERT INTO pages (slug_id, space_id, position, title, deleted_at)
      SELECT 'trash' || lpad(n::text, 5, '0'), ${space.id}, 'a0', 'T' || n, '2025-01-01T00:00:00Z'::timestamptz + make_interval(mins => n)
      FROM generate_series(1, 1001) AS n`;
    const trash = data(await owner.get(`/spaces/${space.id}/trash`));
    expect(trash).toHaveLength(1000);
    expect([trash[0].title, trash[999].title, trash[0].deletedBy]).toEqual(["T1001", "T2", null]);
  });
});

describe("POST /pages/:id/restore", () => {
  test("restores the page with the descendants that were trashed with it", async () => {
    const space = await newSpace("Restore");
    const root = await createPage(owner, { spaceId: space.id, title: "Root" });
    const before = await createPage(owner, { spaceId: space.id, parentId: root.id, title: "Trashed before" });
    const beforeKid = await createPage(owner, { spaceId: space.id, parentId: before.id, title: "Kid of trashed before" });
    const child = await createPage(owner, { spaceId: space.id, parentId: root.id, title: "Child" });
    const leaf = await createPage(owner, { spaceId: space.id, parentId: child.id, title: "Leaf" });
    data(await owner.post(`/pages/${before.id}/delete`));
    data(await owner.post(`/pages/${root.id}/delete`));
    const res = await writer.client.post(`/pages/${root.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { page: { ...root, hasChildren: true } } });
    expect(await children(space.id)).toEqual(["Root"]);
    expect(await children(space.id, root.id)).toEqual(["Child"]);
    expect(await children(space.id, child.id)).toEqual(["Leaf"]);
    expect(await page(leaf.id)).toEqual(leaf);
    // What was trashed on its own before stays in the trash.
    expect(data(await owner.get(`/spaces/${space.id}/trash`)).map((p: any) => p.title)).toEqual(["Trashed before"]);
    expect((await page(beforeKid.id)).deletedAt).not.toBeNull();
    const rows = await t.sql`SELECT deleted_at, deleted_by FROM pages WHERE id IN (${root.id}, ${child.id}, ${leaf.id})`;
    expect(rows).toEqual(Array(3).fill({ deleted_at: null, deleted_by: null }));
    data(await owner.post(`/pages/${before.id}/restore`));
    expect(await children(space.id, root.id)).toEqual(["Trashed before", "Child"]);
    expect(await children(space.id, before.id)).toEqual(["Kid of trashed before"]);
    expect(data(await owner.get(`/spaces/${space.id}/trash`))).toEqual([]);
  });

  test("a page whose parent is still in the trash becomes the last root page", async () => {
    const space = await newSpace("Orphans");
    await createPage(owner, { spaceId: space.id, title: "First root" });
    const parent = await createPage(owner, { spaceId: space.id, title: "Gone parent" });
    const child = await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "Orphan" });
    const grandchild = await createPage(owner, { spaceId: space.id, parentId: child.id, title: "Orphan's kid" });
    const sibling = await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "Sibling" });
    await createPage(owner, { spaceId: space.id, title: "Last root" });
    data(await owner.post(`/pages/${parent.id}/delete`));
    const restored = data(await owner.post(`/pages/${child.id}/restore`)).page;
    expect(restored).toEqual({ ...child, parentId: null, position: "a3", hasChildren: true });
    expect(await order(space.id)).toEqual([["First root", "a0"], ["Last root", "a2"], ["Orphan", "a3"]]);
    expect(await page(grandchild.id)).toEqual(grandchild);
    // The parent and the sibling stay trashed; restoring the parent later does not take the orphan back.
    expect(data(await owner.get(`/spaces/${space.id}/trash`)).map((p: any) => p.title)).toEqual(["Gone parent"]);
    expect((await page(sibling.id)).deletedAt).not.toBeNull();
    data(await owner.post(`/pages/${parent.id}/restore`));
    expect(await children(space.id, parent.id)).toEqual(["Sibling"]);
    expect(await children(space.id)).toEqual(["First root", "Gone parent", "Last root", "Orphan"]);
  });

  test("a page trashed on its own under a live parent returns to its place", async () => {
    const space = await newSpace("Back in place");
    const parent = await createPage(owner, { spaceId: space.id, title: "Parent" });
    const a = await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "A" });
    const b = await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "B" });
    await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "C" });
    data(await owner.post(`/pages/${b.id}/delete`));
    expect(data(await owner.post(`/pages/${b.id}/restore`)).page).toEqual(b);
    expect(await children(space.id, parent.id)).toEqual(["A", "B", "C"]);
    expect(a.position).toBe("a0");
  });

  test("restoring a page that is not in the trash changes nothing", async () => {
    const space = await newSpace("Not trashed");
    const p = await createPage(owner, { spaceId: space.id, title: "Alive" });
    const socket = await openSocket(owner);
    const res = await owner.post(`/pages/${p.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { page: p } });
    // It still announces the tree.
    expect(await takeEvents(socket)).toEqual([treeEvent(space.id)]);
    await socket.close();
  });

  test("needs a writer", async () => {
    const space = await newSpace("Restore guard");
    const p = await createPage(owner, { spaceId: space.id, title: "Guarded" });
    data(await owner.post(`/pages/${p.id}/delete`));
    expectForbidden(await reader.client.post(`/pages/${p.id}/restore`));
    expectNotFound(await outsider.client.post(`/pages/${p.id}/restore`), "Page");
    expectNotFound(await owner.post(`/pages/${NO_SUCH_ID}/restore`), "Page");
    expect((await page(p.id)).deletedAt).not.toBeNull();
    expect(data(await writer.client.post(`/pages/${p.slugId}/restore`)).page).toEqual(p);
  });
});

describe("POST /pages/:id/delete-permanently", () => {
  test("removes the page, everything under it and their files for good", async () => {
    const space = await newSpace("Purge");
    const root = await createPage(owner, { spaceId: space.id, title: "Doomed" });
    const child = await createPage(owner, { spaceId: space.id, parentId: root.id, title: "Doomed child" });
    const trashedChild = await createPage(owner, { spaceId: space.id, parentId: root.id, title: "Doomed, already trashed" });
    const bystander = await createPage(owner, { spaceId: space.id, title: "Bystander", content: docOf(paragraph({ type: "mention", attrs: { entityType: "page", entityId: root.id } })) });
    const upload = async (pageId: string, name: string) => data(await owner.uploadFile(new File([name], name, { type: "text/plain" }), pageId));
    const [rootFile, childFile, trashedFile, keptFile] = [
      await upload(root.id, "root.txt"),
      await upload(child.id, "child.txt"),
      await upload(trashedChild.id, "trashed.txt"),
      await upload(bystander.id, "kept.txt"),
    ];
    data(await owner.post(`/pages/${trashedChild.id}/delete`));
    data(await owner.post("/comments", { pageId: child.id, body: doc("soon gone") }));
    data(await owner.post(`/pages/${child.id}/labels`, { names: ["doomed"] }));
    data(await owner.post("/favorites", { pageId: child.id }));
    await t.sql`INSERT INTO page_versions (page_id, title) VALUES (${child.id}, 'old')`;
    expect(data(await owner.get(`/pages/${root.id}/backlinks`))).toHaveLength(1);

    const res = await spaceAdmin.client.post(`/pages/${root.id}/delete-permanently`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: {} });
    for (const p of [root, child, trashedChild]) expectNotFound(await owner.get(`/pages/${p.id}`), "Page");
    expect(await children(space.id)).toEqual(["Bystander"]);
    expect(data(await owner.get(`/spaces/${space.id}/trash`))).toEqual([]);
    for (const file of [rootFile, childFile, trashedFile]) {
      expect((await owner.raw("GET", file.url.slice("/api".length))).status).toBe(404);
      expect([onDisk("files", file.id, file.name), onDisk("files", file.id)]).toEqual([false, false]);
    }
    expect(onDisk("files", keptFile.id, "kept.txt")).toBe(true);
    const [counts] = await t.sql`
      SELECT (SELECT count(*)::int FROM pages WHERE id IN (${root.id}, ${child.id}, ${trashedChild.id})) AS pages,
        (SELECT count(*)::int FROM files WHERE id IN (${rootFile.id}, ${childFile.id}, ${trashedFile.id})) AS files,
        (SELECT count(*)::int FROM files WHERE id = ${keptFile.id}) AS kept_files,
        (SELECT count(*)::int FROM comments WHERE page_id = ${child.id}) AS comments,
        (SELECT count(*)::int FROM page_labels WHERE page_id = ${child.id}) AS labels,
        (SELECT count(*)::int FROM favorites WHERE page_id = ${child.id}) AS favorites,
        (SELECT count(*)::int FROM page_versions WHERE page_id = ${child.id}) AS versions,
        (SELECT count(*)::int FROM watchers WHERE page_id IN (${root.id}, ${child.id})) AS watchers,
        (SELECT count(*)::int FROM page_links WHERE target_id = ${root.id}) AS links`;
    expect(counts).toEqual({ pages: 0, files: 0, kept_files: 1, comments: 0, labels: 0, favorites: 0, versions: 0, watchers: 0, links: 0 });
    expect(data(await owner.get(`/pages/${bystander.id}/links`))).toEqual([]);
    expectNotFound(await spaceAdmin.client.post(`/pages/${root.id}/delete-permanently`), "Page");
  });

  test("works on a page in the trash and on one that is not, for space admins only", async () => {
    const space = await newSpace("Purge guard");
    const live = await createPage(owner, { spaceId: space.id, title: "Never trashed" });
    const trashed = await createPage(owner, { spaceId: space.id, title: "Trashed first" });
    data(await owner.post(`/pages/${trashed.id}/delete`));
    for (const p of [live, trashed]) {
      expectForbidden(await writer.client.post(`/pages/${p.id}/delete-permanently`));
      expectForbidden(await reader.client.post(`/pages/${p.id}/delete-permanently`));
      expectNotFound(await outsider.client.post(`/pages/${p.id}/delete-permanently`), "Page");
    }
    expectNotFound(await owner.post(`/pages/${NO_SUCH_ID}/delete-permanently`), "Page");
    expect(data(await owner.post(`/pages/${live.slugId}/delete-permanently`))).toEqual({});
    expect(data(await spaceAdmin.client.post(`/pages/${trashed.id.toUpperCase()}/delete-permanently`))).toEqual({});
    expect(await children(space.id)).toEqual([]);
    expect(data(await owner.get(`/spaces/${space.id}/trash`))).toEqual([]);
  });

  test("announces the tree, and turns editors out of the deleted pages", async () => {
    const space = await newSpace("Purge events");
    const root = await createPage(owner, { spaceId: space.id, title: "Open root" });
    const kid = await createPage(owner, { spaceId: space.id, parentId: root.id, title: "Open kid" });
    const socket = await openSocket(writer.client);
    expect((await joinPage(socket, kid.id)).t).toBe("joined");
    data(await owner.post(`/pages/${root.id}/delete-permanently`));
    expect(await socket.nextOf("event")).toEqual(treeEvent(space.id));
    expect(await socket.nextOf("error")).toEqual({ t: "error", pageId: kid.id, message: "You no longer have access to this page" });
    await socket.close();
  });
});

describe("POST /pages/:id/duplicate", () => {
  test("copies the page and its subtree right after the original", async () => {
    const space = await newSpace("Copies");
    await createPage(owner, { spaceId: space.id, title: "Before" });
    const original = await createPage(owner, { spaceId: space.id, title: "Original", icon: "📦", content: doc("Hello", "World") });
    await createPage(owner, { spaceId: space.id, title: "After" });
    data(await owner.post(`/pages/${original.id}/update`, { cover: "/covers/1.png" }));
    const kid = await createPage(owner, { spaceId: space.id, parentId: original.id, title: "Kid", icon: "🧒", content: doc("kid text") });
    const kid2 = await createPage(owner, { spaceId: space.id, parentId: original.id });
    const grandkid = await createPage(owner, { spaceId: space.id, parentId: kid.id, title: "Grandkid" });
    const gone = await createPage(owner, { spaceId: space.id, parentId: original.id, title: "Trashed kid" });
    data(await owner.post(`/pages/${gone.id}/delete`));

    const res = await writer.client.post(`/pages/${original.id}/duplicate`, {});
    expect(res.status).toBe(200);
    const copy = res.body.data.page;
    expect(res.body).toEqual({
      data: {
        page: {
          id: anyId(),
          slugId: expect.stringMatching(SLUG_ID_RE),
          title: "Copy of Original",
          icon: "📦",
          parentId: null,
          spaceId: space.id,
          position: "a1V",
          hasChildren: true,
          isBase: false,
          cover: "/covers/1.png",
          content: doc("Hello", "World"),
          docVersion: 0,
          creator: userRef(writer.user),
          lastEditor: userRef(writer.user),
          contributors: [userRef(writer.user)],
          createdAt: anyTime(),
          updatedAt: anyTime(),
          deletedAt: null,
        },
      },
    });
    expect(copy.id).not.toBe(original.id);
    expect(copy.slugId).not.toBe(original.slugId);
    expect(await order(space.id)).toEqual([["Before", "a0"], ["Original", "a1"], ["Copy of Original", "a1V"], ["After", "a2"]]);

    // Children keep their titles and positions, with ids of their own; the trashed one is not copied.
    const copiedKids = data(await owner.get(`/spaces/${space.id}/pages?parentId=${copy.id}`));
    expect(copiedKids).toEqual([
      { id: anyId(), slugId: expect.stringMatching(SLUG_ID_RE), title: "Kid", icon: "🧒", parentId: copy.id, spaceId: space.id, position: kid.position, hasChildren: true, isBase: false },
      { id: anyId(), slugId: expect.stringMatching(SLUG_ID_RE), title: null, icon: null, parentId: copy.id, spaceId: space.id, position: kid2.position, hasChildren: false, isBase: false },
    ]);
    const copiedGrandkids = data(await owner.get(`/spaces/${space.id}/pages?parentId=${copiedKids[0].id}`));
    expect(copiedGrandkids.map((p: any) => [p.title, p.position])).toEqual([["Grandkid", grandkid.position]]);
    const all = [copy, ...copiedKids, ...copiedGrandkids];
    const originals = [original, kid, kid2, grandkid, gone];
    expect(new Set([...all, ...originals].map((p) => p.id)).size).toBe(9);
    expect(new Set([...all, ...originals].map((p) => p.slugId)).size).toBe(9);
    const copiedKid = await page(copiedKids[0].id);
    expect(copiedKid).toMatchObject({ content: doc("kid text"), creator: userRef(writer.user), lastEditor: userRef(writer.user), contributors: [userRef(writer.user)], docVersion: 0, cover: null });
    const [row] = await t.sql`SELECT text_content FROM pages WHERE id = ${copiedKid.id}`;
    expect(row.text_content).toBe("kid text");
    // The original is untouched.
    expect(await page(original.id)).toEqual({ ...original, cover: "/covers/1.png", hasChildren: true, updatedAt: anyTime() });
    expect(await children(space.id, original.id)).toEqual(["Kid", null]);
    // The copier watches every copied page.
    for (const p of all) {
      expect(data(await writer.client.get(`/pages/${p.id}/watch`))).toEqual({ watching: true });
      expect(data(await owner.get(`/pages/${p.id}/watch`))).toEqual({ watching: false });
    }
  });

  test("a child is copied next to itself; an untitled page becomes Copy of Untitled", async () => {
    const space = await newSpace("Copy a child");
    const parent = await createPage(owner, { spaceId: space.id, title: "Parent" });
    const a = await createPage(owner, { spaceId: space.id, parentId: parent.id });
    await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "B" });
    const copy = data(await owner.post(`/pages/${a.slugId}/duplicate`)).page;
    expect(copy).toMatchObject({ title: "Copy of Untitled", parentId: parent.id, position: "a0V" });
    expect(await children(space.id, parent.id)).toEqual([null, "Copy of Untitled", "B"]);
    // Copying the last sibling appends.
    const last = await createPage(owner, { spaceId: space.id, parentId: parent.id, title: "Last" });
    expect(data(await owner.post(`/pages/${last.id}/duplicate`, { spaceId: null })).page).toMatchObject({ title: "Copy of Last", position: "a3" });
    expect(data(await owner.post(`/pages/${last.id}/duplicate`, { spaceId: "" })).page).toMatchObject({ title: "Copy of Last", position: "a2V" });
    expect(data(await owner.post(`/pages/${last.id}/duplicate`, { spaceId: space.id.toUpperCase() })).page).toMatchObject({ parentId: parent.id, position: "a2G" });
  });

  test("the title of the copy is cut at 500 UTF-16 units", async () => {
    const space = await newSpace("Copy titles");
    const long = await createPage(owner, { spaceId: space.id, title: "t".repeat(500) });
    expect(data(await owner.post(`/pages/${long.id}/duplicate`)).page.title).toBe(`Copy of ${"t".repeat(492)}`);
    const emoji = await createPage(owner, { spaceId: space.id, title: "😀".repeat(300) });
    expect(data(await owner.post(`/pages/${emoji.id}/duplicate`)).page.title).toBe(`Copy of ${"😀".repeat(246)}`);
    const split = await createPage(owner, { spaceId: space.id, title: `a${"😀".repeat(300)}` });
    // Accident: the cut falls inside an emoji, and the half that is left makes the insert fail.
    expectError(await owner.post(`/pages/${split.id}/duplicate`), 500, "internal_error", "Something went wrong");
    expect(await children(space.id)).toHaveLength(5);
  });

  test("into another space the copy becomes the last root page", async () => {
    const from = await newSpace("Copy from");
    const to = await newSpace("Copy to");
    await createPage(owner, { spaceId: to.id, title: "Already there" });
    const parent = await createPage(owner, { spaceId: from.id, title: "Parent" });
    const original = await createPage(owner, { spaceId: from.id, parentId: parent.id, title: "Original" });
    await createPage(owner, { spaceId: from.id, parentId: original.id, title: "Kid" });
    const socket = await openSocket(owner);
    const copy = data(await writer.client.post(`/pages/${original.id}/duplicate`, { spaceId: to.id })).page;
    expect(copy).toMatchObject({ title: "Copy of Original", spaceId: to.id, parentId: null, position: "a1", hasChildren: true });
    // Only the space that received the copy is told.
    expect(await takeEvents(socket)).toEqual([treeEvent(to.id)]);
    await socket.close();
    expect(await children(to.id)).toEqual(["Already there", "Copy of Original"]);
    expect(await children(to.id, copy.id)).toEqual(["Kid"]);
    expect(await children(from.id, parent.id)).toEqual(["Original"]);
  });

  test("needs a writer on the page and in the target space", async () => {
    const space = await newSpace("Copy guard");
    const hidden = await createSpace(owner, "Copy hidden", `tree-${++counter}`);
    const readOnly = await createSpace(owner, "Copy read-only", `tree-${++counter}`);
    data(await owner.post(`/spaces/${readOnly.id}/members/add`, { role: "reader", userIds: [writer.id] }));
    const p = await createPage(owner, { spaceId: space.id, title: "Guarded" });
    expectForbidden(await reader.client.post(`/pages/${p.id}/duplicate`));
    expectNotFound(await outsider.client.post(`/pages/${p.id}/duplicate`), "Page");
    expectNotFound(await owner.post(`/pages/${NO_SUCH_ID}/duplicate`), "Page");
    expectInvalid(await owner.post(`/pages/${p.id}/duplicate`, { spaceId: "nope" }), "spaceId must be a valid id");
    expectInvalid(await owner.post(`/pages/${p.id}/duplicate`, { spaceId: 1 }), "spaceId must be a valid id");
    expectNotFound(await owner.post(`/pages/${p.id}/duplicate`, { spaceId: NO_SUCH_ID }), "Space");
    expectNotFound(await writer.client.post(`/pages/${p.id}/duplicate`, { spaceId: hidden.id }), "Space");
    expectForbidden(await writer.client.post(`/pages/${p.id}/duplicate`, { spaceId: readOnly.id }));
    expect(await children(space.id)).toEqual(["Guarded"]);
    data(await owner.post(`/pages/${p.id}/delete`));
    expectNotFound(await owner.post(`/pages/${p.id}/duplicate`), "Page");
  });

  test("comment marks are stripped; comments, labels, shares and favorites are not copied", async () => {
    const space = await newSpace("Copy marks");
    const commented = { type: "comment", attrs: { commentId: NO_SUCH_ID, resolved: false } };
    const content = docOf(
      paragraph(text("both", [{ type: "bold" }, commented]), text(" only a comment", [commented]), text(" two comments", [commented, { type: "comment", attrs: { commentId: "c2" } }, { type: "italic" }]), text(" none")),
      { type: "blockquote", content: [paragraph(text("nested", [commented, { type: "link", attrs: { href: "https://example.com/" } }]))] },
    );
    const original = await createPage(owner, { spaceId: space.id, title: "Commented", content });
    data(await owner.post("/comments", { pageId: original.id, body: doc("a comment") }));
    data(await owner.post(`/pages/${original.id}/labels`, { names: ["labelled"] }));
    data(await owner.post(`/pages/${original.id}/share`, {}));
    data(await owner.post("/favorites", { pageId: original.id }));
    const copy = data(await owner.post(`/pages/${original.id}/duplicate`)).page;
    expect(copy.content).toEqual(
      docOf(
        paragraph(text("both", [{ type: "bold" }]), text(" only a comment"), text(" two comments", [{ type: "italic" }]), text(" none")),
        { type: "blockquote", content: [paragraph(text("nested", [{ type: "link", attrs: { href: "https://example.com/" } }]))] },
      ),
    );
    expect((await page(original.id)).content).toEqual(content);
    expect(data(await owner.get(`/pages/${copy.id}/comments`))).toEqual([]);
    expect(data(await owner.get(`/pages/${copy.id}/labels`))).toEqual([]);
    expect(data(await owner.get(`/pages/${copy.id}/share`))).toEqual({ share: null, inheritedFrom: null });
    expect(data(await owner.get("/favorites")).pages.map((p: any) => p.id)).toEqual([original.id]);
    expect(data(await owner.get(`/pages/${copy.id}/versions`))).toEqual([]);
  });

  test("uploaded files are copied and the copies point at their own", async () => {
    const space = await newSpace("Copy files");
    const outside = await createPage(owner, { spaceId: space.id, title: "Outside the subtree" });
    const original = await createPage(owner, { spaceId: space.id, title: "With files" });
    const holder = await createPage(owner, { spaceId: space.id, parentId: original.id, title: "Holds a picture" });
    const notes = data(await owner.uploadFile(new File(["hello file"], "notes é.txt", { type: "text/plain" }), original.id));
    const picture = data(await owner.uploadFile(new File([new Uint8Array([1, 2, 3, 4])], "pic.png", { type: "image/png" }), holder.id));
    const unused = data(await owner.uploadFile(new File(["never referenced"], "unused.bin"), holder.id));
    const foreign = data(await owner.uploadFile(new File(["someone else's"], "foreign.txt", { type: "text/plain" }), outside.id));
    // A page of the subtree whose content names the files of the other two.
    const content = docOf(
      { type: "attachment", attrs: { url: notes.url, name: "notes é.txt", attachmentId: notes.id } },
      { type: "image", attrs: { src: `${picture.url}?v=2#top`, attachmentId: picture.id.toUpperCase(), alt: "a picture" } },
      { type: "video", attrs: { src: `/api/files/${picture.id.toUpperCase()}`, attachmentId: null } },
      { type: "attachment", attrs: { url: foreign.url, name: "foreign.txt", attachmentId: foreign.id } },
      { type: "image", attrs: { src: "https://example.com/api/files/not-ours.png" } },
      { type: "pdf", attrs: { src: `/api/files/${NO_SUCH_ID}/gone.pdf`, attachmentId: NO_SUCH_ID } },
      paragraph(text("a link", [{ type: "link", attrs: { href: notes.url } }])),
    );
    const user = await createPage(owner, { spaceId: space.id, parentId: original.id, title: "Uses the files", content });

    const copy = data(await writer.client.post(`/pages/${original.id}/duplicate`)).page;
    const [copiedHolder, copiedUser] = data(await owner.get(`/spaces/${space.id}/pages?parentId=${copy.id}`));
    const rootFiles = data(await owner.get(`/pages/${copy.id}/files`));
    const holderFiles = data(await owner.get(`/pages/${copiedHolder.id}/files`));
    expect(rootFiles).toEqual([
      { id: anyId(), name: "notes é.txt", mime: "text/plain", size: 10, url: expect.stringMatching(/^\/api\/files\/[0-9a-f-]{36}\/notes%20%C3%A9\.txt$/), uploader: userRef(writer.user), createdAt: anyTime() },
    ]);
    expect(holderFiles.map((f: any) => [f.name, f.mime, f.size, f.uploader.id]).sort()).toEqual([
      ["pic.png", "image/png", 4, writer.id],
      ["unused.bin", "application/octet-stream", 16, writer.id],
    ]);
    expect(data(await owner.get(`/pages/${copiedUser.id}/files`))).toEqual([]);
    const newNotes = rootFiles[0];
    const newPicture = holderFiles.find((f: any) => f.name === "pic.png");
    const newUnused = holderFiles.find((f: any) => f.name === "unused.bin");
    expect(new Set([notes.id, picture.id, unused.id, newNotes.id, newPicture.id, newUnused.id]).size).toBe(6);
    expect((await page(copiedUser.id)).content).toEqual(
      docOf(
        { type: "attachment", attrs: { url: newNotes.url, name: "notes é.txt", attachmentId: newNotes.id } },
        // The rest of the URL is kept; ids are matched without regard to case.
        { type: "image", attrs: { src: `${newPicture.url}?v=2#top`, attachmentId: newPicture.id, alt: "a picture" } },
        { type: "video", attrs: { src: `/api/files/${newPicture.id}`, attachmentId: null } },
        // Files of pages outside the copied subtree, other hosts and unknown files are left as they are.
        { type: "attachment", attrs: { url: foreign.url, name: "foreign.txt", attachmentId: foreign.id } },
        { type: "image", attrs: { src: "https://example.com/api/files/not-ours.png" } },
        { type: "pdf", attrs: { src: `/api/files/${NO_SUCH_ID}/gone.pdf`, attachmentId: NO_SUCH_ID } },
        // Only `src` and `url` attributes of nodes are re-pointed: a link to a file still names the original.
        paragraph(text("a link", [{ type: "link", attrs: { href: notes.url } }])),
      ),
    );
    expect((await page(user.id)).content).toEqual(content);
    // The bytes were copied under the new ids, and both sets are served.
    expect(await Bun.file(path.join(t.storageDir, "files", newNotes.id, "notes é.txt")).text()).toBe("hello file");
    expect(await Bun.file(path.join(t.storageDir, "files", newPicture.id, "pic.png")).bytes()).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await Bun.file(path.join(t.storageDir, "files", newUnused.id, "unused.bin")).text()).toBe("never referenced");
    expect(await (await reader.client.raw("GET", newNotes.url.slice("/api".length))).text()).toBe("hello file");
    expect(await (await reader.client.raw("GET", notes.url.slice("/api".length))).text()).toBe("hello file");
    const rows = await t.sql`SELECT purpose, page_id, space_id, uploader_id, storage_key FROM files WHERE id = ${newNotes.id}`;
    expect(rows).toEqual([{ purpose: "page", page_id: copy.id, space_id: space.id, uploader_id: writer.id, storage_key: `files/${newNotes.id}/notes é.txt` }]);
    // Into another space, the copied files belong to that space.
    const other = await newSpace("Copy files elsewhere");
    const far = data(await owner.post(`/pages/${original.id}/duplicate`, { spaceId: other.id })).page;
    const farFile = data(await owner.get(`/pages/${far.id}/files`))[0];
    const [farRow] = await t.sql`SELECT space_id, uploader_id FROM files WHERE id = ${farFile.id}`;
    expect(farRow).toEqual({ space_id: other.id, uploader_id: ownerUser.id });
    // Deleting a copy leaves the original's files in place.
    data(await owner.post(`/pages/${copy.id}/delete-permanently`));
    expect([onDisk("files", newNotes.id), onDisk("files", newPicture.id), onDisk("files", notes.id, "notes é.txt"), onDisk("files", picture.id, "pic.png")]).toEqual([false, false, true, true]);
  });

  test("page links and synced blocks are indexed for the copies; links inside the subtree still point at the originals", async () => {
    const space = await newSpace("Copy links");
    const target = await createPage(owner, { spaceId: space.id, title: "Target" });
    // The kid exists first, so the page it will go under can mention it.
    const kid = await createPage(owner, {
      spaceId: space.id,
      title: "Kid linker",
      content: docOf(paragraph({ type: "mention", attrs: { entityType: "page", entityId: target.id, label: "Target" } }), {
        type: "transclusionSource",
        attrs: { id: "kid-block" },
        content: [paragraph(text("synced in the kid", [{ type: "comment", attrs: { commentId: "c" } }]))],
      }),
    });
    const content = docOf(
      paragraph(
        { type: "mention", attrs: { entityType: "page", entityId: target.id, label: "Target" } },
        { type: "mention", attrs: { entityType: "page", entityId: kid.id, label: "Kid" } },
      ),
      { type: "transclusionSource", attrs: { id: "root-block" }, content: [paragraph(text("synced in the root"))] },
      { type: "transclusionReference", attrs: { sourcePageId: kid.id, transclusionId: "kid-block" } },
    );
    const original = await createPage(owner, { spaceId: space.id, title: "Linker", content });
    data(await owner.post(`/pages/${kid.id}/move`, { parentId: original.id }));
    const copy = data(await owner.post(`/pages/${original.id}/duplicate`)).page;
    const copiedKid = data(await owner.get(`/spaces/${space.id}/pages?parentId=${copy.id}`))[0];
    // Mentions and references are copied as they are: they still name the original pages.
    expect(copy.content).toEqual(content);
    expect(data(await owner.get(`/pages/${copy.id}/links`)).map((p: any) => p.id)).toEqual([kid.id, target.id]);
    expect(data(await owner.get(`/pages/${copiedKid.id}/links`)).map((p: any) => p.id)).toEqual([target.id]);
    expect(data(await owner.get(`/pages/${kid.id}/backlinks`)).map((p: any) => p.title)).toEqual(["Copy of Linker", "Linker"]);
    expect(data(await owner.get(`/pages/${copiedKid.id}/backlinks`))).toEqual([]);
    expect(data(await owner.get(`/pages/${target.id}/backlinks`)).map((p: any) => p.title)).toEqual(["Copy of Linker", "Kid linker", "Kid linker", "Linker"]);
    expect(
      data(
        await owner.post("/synced-blocks/lookup", {
          refs: [
            { pageId: copy.id, blockId: "root-block" },
            { pageId: copiedKid.id, blockId: "kid-block" },
            { pageId: copy.id, blockId: "kid-block" },
          ],
        }),
      ),
    ).toEqual([
      { pageId: copy.id, blockId: "root-block", content: [paragraph(text("synced in the root"))] },
      // Without the comment mark.
      { pageId: copiedKid.id, blockId: "kid-block", content: [paragraph(text("synced in the kid"))] },
      { pageId: copy.id, blockId: "kid-block", content: null },
    ]);
  });

  test("bases in the subtree are copied with their properties, rows and views, and embeds point at the copies", async () => {
    const space = await newSpace("Copy bases");
    const base = data(await owner.post("/bases", { spaceId: space.id, title: "Tracker", icon: "📊" })).page;
    const elsewhere = data(await owner.post("/bases", { spaceId: space.id, title: "Other tracker" })).page;
    const files = data(await owner.post(`/bases/${base.id}/properties`, { name: "Docs", type: "file" }));
    const upload = data(await owner.uploadFile(new File(["spec"], "spec.txt", { type: "text/plain" }), base.id));
    const before = data(await owner.get(`/bases/${base.id}`));
    const title = before.properties.find((p: any) => p.isPrimary);
    data(await owner.post(`/bases/${base.id}/rows`, { cells: { [title.id]: "Row one", [files.id]: [{ id: upload.id, fileName: "spec.txt", url: upload.url }] } }));
    const rowsBefore = data(await owner.post(`/bases/${base.id}/rows/query`, {})).items;
    expect(rowsBefore).toHaveLength(2);
    const content = docOf(paragraph(text("Embedded:")), { type: "base", attrs: { pageId: base.id } }, { type: "base", attrs: { pageId: elsewhere.id } }, {
      type: "columns",
      content: [{ type: "column", content: [{ type: "base", attrs: { pageId: base.id, view: "x" } }] }],
    });
    const root = await createPage(owner, { spaceId: space.id, title: "Project", content });
    // The base goes under the page that embeds it.
    const moved = data(await owner.post(`/pages/${base.id}/move`, { parentId: root.id })).page;

    const copy = data(await writer.client.post(`/pages/${root.id}/duplicate`)).page;
    const copiedBase = data(await owner.get(`/spaces/${space.id}/pages?parentId=${copy.id}`))[0];
    expect(copiedBase).toEqual({ id: anyId(), slugId: expect.stringMatching(SLUG_ID_RE), title: "Tracker", icon: "📊", parentId: copy.id, spaceId: space.id, position: moved.position, hasChildren: false, isBase: true });
    expect(copiedBase.id).not.toBe(base.id);
    expect(copy.content).toEqual(
      docOf(paragraph(text("Embedded:")), { type: "base", attrs: { pageId: copiedBase.id } }, { type: "base", attrs: { pageId: elsewhere.id } }, {
        type: "columns",
        content: [{ type: "column", content: [{ type: "base", attrs: { pageId: copiedBase.id, view: "x" } }] }],
      }),
    );
    const after = data(await owner.get(`/bases/${copiedBase.id}`));
    expect(after.properties).toEqual(before.properties);
    expect(after.views).toEqual(before.views.map((v: any) => ({ ...v, id: anyId() })));
    expect(after.views[0].id).not.toBe(before.views[0].id);
    const rowsAfter = data(await owner.post(`/bases/${copiedBase.id}/rows/query`, {})).items;
    const copiedFile = data(await owner.get(`/pages/${copiedBase.id}/files`))[0];
    expect(copiedFile.id).not.toBe(upload.id);
    expect(rowsAfter).toEqual([
      { ...rowsBefore[0], id: anyId(), lastEditorId: writer.id, updatedAt: anyTime() },
      {
        ...rowsBefore[1],
        id: anyId(),
        // File cells name the copied file, by id and by URL.
        cells: { [title.id]: "Row one", [files.id]: [{ id: copiedFile.id, fileName: "spec.txt", url: copiedFile.url }] },
        lastEditorId: writer.id,
        updatedAt: anyTime(),
      },
    ]);
    expect(rowsAfter.map((r: any) => r.creatorId)).toEqual([ownerUser.id, ownerUser.id]);
    expect(rowsAfter.map((r: any) => r.id).sort()).not.toEqual(rowsBefore.map((r: any) => r.id).sort());
    // The original base is as it was.
    expect(data(await owner.post(`/bases/${base.id}/rows/query`, {})).items).toEqual(rowsBefore);
    // A base on its own can be duplicated too.
    const alone = data(await owner.post(`/pages/${elsewhere.id}/duplicate`)).page;
    expect(alone).toMatchObject({ title: "Copy of Other tracker", isBase: true });
    expect(data(await owner.get(`/bases/${alone.id}`)).properties.map((p: any) => p.name)).toEqual(["Title", "Text 1", "Text 2"]);
  });

  test("at most 2000 pages are copied at once", async () => {
    const space = await createSpace(owner, "Copy many", `tree-${++counter}`);
    const root = await createPage(owner, { spaceId: space.id, title: "Big tree" });
    // Arranged directly: 1999 children make a subtree of exactly 2000 pages.
    await t.sql`
      INSERT INTO pages (slug_id, space_id, parent_id, position, title, content)
      SELECT 'many' || lpad(n::text, 6, '0'), ${space.id}, ${root.id}, 'a' || lpad(n::text, 4, '0'), 'Child ' || n, NULL
      FROM generate_series(1, 1999) AS n`;
    const copy = data(await owner.post(`/pages/${root.id}/duplicate`)).page;
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM pages WHERE parent_id = ${copy.id}`;
    expect(n).toBe(1999);
    // A page without content is copied without content.
    const [kid] = await t.sql`SELECT content, text_content FROM pages WHERE parent_id = ${copy.id} LIMIT 1`;
    expect(kid).toEqual({ content: null, text_content: "" });
    await createPage(owner, { spaceId: space.id, parentId: root.id, title: "One too many" });
    expectError(await owner.post(`/pages/${root.id}/duplicate`), 413, "too_large", "Cannot duplicate more than 2000 pages at once");
    const [{ total }] = await t.sql`SELECT count(*)::int AS total FROM pages WHERE space_id = ${space.id}`;
    expect(total).toBe(2001 + 2000);
  }, 20_000);
});
