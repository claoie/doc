import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { doc, startServer, type Client, type TestServer } from "./harness";
import {
  NO_SUCH_ID,
  createPage,
  createSpace,
  data,
  expectForbidden,
  expectInvalid,
  expectNotFound,
  expectUnauthorized,
  memberRow,
  person,
  spaceRef,
  treeItem,
  type Person,
} from "./harness/spaces-pages";

let t: TestServer;
let owner: Client;
let team: any;
let reader: Person;
let outsider: Person;

let counter = 0;
/** A member of the workspace who reads `team`, with no favorites or watches yet. */
const freshReader = () => person(t, owner, `fresh-${++counter}@example.com`, { space: team.id, spaceRole: "reader" });

const favorites = async (client: Client) => data(await client.get("/favorites"));
const either = "Provide either pageId or spaceId";

beforeAll(async () => {
  t = await startServer();
  ({ owner } = await t.setupOwner());
  team = await createSpace(owner, "Team", "team");
  reader = await person(t, owner, "reader@example.com", { space: team.id, spaceRole: "reader" });
  outsider = await person(t, owner, "outsider@example.com");
});

afterAll(async () => {
  await t.close();
});

describe("without a session", () => {
  test("every favorite and watch endpoint answers 401", async () => {
    const page = await createPage(owner, { spaceId: team.id });
    const anonymous = t.client();
    for (const path of ["/favorites", `/pages/${page.id}/watch`, `/spaces/${team.id}/watch`]) expectUnauthorized(await anonymous.get(path));
    for (const path of ["/favorites", "/favorites/remove", `/pages/${page.id}/watch`, `/spaces/${team.id}/watch`]) {
      expectUnauthorized(await anonymous.post(path, { pageId: page.id, watching: true }));
    }
  });
});

describe("favorites", () => {
  test("nothing is a favorite to begin with", async () => {
    const res = await outsider.client.get("/favorites");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { pages: [], spaces: [] } });
  });

  test("pages and spaces are listed in the order they were added, each user their own", async () => {
    const me = await freshReader();
    const other = await createSpace(owner, "Second space", `fav-${++counter}`);
    data(await owner.post(`/spaces/${other.id}/members/add`, { role: "writer", userIds: [me.id] }));
    const parent = await createPage(owner, { spaceId: team.id, title: "Parent", icon: "⭐" });
    const child = await createPage(owner, { spaceId: team.id, parentId: parent.id, title: "Child" });
    const elsewhere = await createPage(owner, { spaceId: other.id, title: "Elsewhere" });
    for (const body of [{ pageId: elsewhere.id }, { spaceId: other.id }, { pageId: parent.id.toUpperCase() }, { spaceId: team.id.toUpperCase() }, { pageId: child.id }]) {
      const res = await me.client.post("/favorites", body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: {} });
    }
    const res = await me.client.get("/favorites");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        pages: [
          { ...treeItem(elsewhere), space: spaceRef(other) },
          { ...treeItem(parent, { hasChildren: true }), space: spaceRef(team) },
          { ...treeItem(child), space: spaceRef(team) },
        ],
        spaces: [
          { ...other, role: "writer", memberCount: 2 },
          { ...data(await me.client.get(`/spaces/${team.id}`)).space, role: "reader" },
        ],
      },
    });
    expect(await favorites(owner)).toEqual({ pages: [], spaces: [] });
    // Adding one again neither fails nor moves it.
    expect(data(await me.client.post("/favorites", { pageId: elsewhere.id }))).toEqual({});
    expect(data(await me.client.post("/favorites", { spaceId: other.id }))).toEqual({});
    const again = await favorites(me.client);
    expect(again.pages.map((p: any) => p.title)).toEqual(["Elsewhere", "Parent", "Child"]);
    expect(again.spaces.map((s: any) => s.name)).toEqual(["Second space", "Team"]);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM favorites WHERE user_id = ${me.id}`;
    expect(n).toBe(5);
  });

  test("exactly one of pageId and spaceId is needed, and it must be something the user can read", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Target" });
    const add = (body: unknown) => reader.client.post("/favorites", body);
    for (const body of [{}, { pageId: null }, { spaceId: "" }, { pageId: "", spaceId: null }, { pageId: page.id, spaceId: team.id }, { other: page.id }]) {
      expectInvalid(await add(body), either);
    }
    for (const pageId of ["nope", 5, page.slugId, [page.id]]) expectInvalid(await add({ pageId }), "pageId must be a valid id");
    for (const spaceId of ["team", 5, {}]) expectInvalid(await add({ spaceId }), "spaceId must be a valid id");
    // A bad id is reported even when the other target is fine.
    expectInvalid(await add({ pageId: page.id, spaceId: "nope" }), "spaceId must be a valid id");
    expectNotFound(await add({ pageId: NO_SUCH_ID }), "Page");
    expectNotFound(await add({ spaceId: NO_SUCH_ID }), "Space");
    expectNotFound(await outsider.client.post("/favorites", { pageId: page.id }), "Page");
    expectNotFound(await outsider.client.post("/favorites", { spaceId: team.id }), "Space");
    // An empty value on one side leaves the other to decide.
    expect(data(await add({ pageId: page.id, spaceId: null }))).toEqual({});
    expect(data(await add({ pageId: "", spaceId: team.id }))).toEqual({});
    const mine = await favorites(reader.client);
    expect([mine.pages.map((p: any) => p.id), mine.spaces.map((s: any) => s.id)]).toEqual([[page.id], [team.id]]);
    expect(await favorites(outsider.client)).toEqual({ pages: [], spaces: [] });
  });

  test("removing takes a page or a space off the list, and is fine when it was not on it", async () => {
    const me = await freshReader();
    const a = await createPage(owner, { spaceId: team.id, title: "A" });
    const b = await createPage(owner, { spaceId: team.id, title: "B" });
    for (const body of [{ pageId: a.id }, { pageId: b.id }, { spaceId: team.id }]) data(await me.client.post("/favorites", body));
    const res = await me.client.post("/favorites/remove", { pageId: a.id.toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: {} });
    expect((await favorites(me.client)).pages.map((p: any) => p.title)).toEqual(["B"]);
    expect(data(await me.client.post("/favorites/remove", { pageId: a.id }))).toEqual({});
    expect(data(await me.client.post("/favorites/remove", { pageId: NO_SUCH_ID }))).toEqual({});
    expect(data(await me.client.post("/favorites/remove", { spaceId: NO_SUCH_ID }))).toEqual({});
    // With both, the page is the one removed.
    expect(data(await me.client.post("/favorites/remove", { pageId: b.id, spaceId: team.id }))).toEqual({});
    const left = await favorites(me.client);
    expect([left.pages, left.spaces.map((s: any) => s.id)]).toEqual([[], [team.id]]);
    expect(data(await me.client.post("/favorites/remove", { spaceId: team.id.toUpperCase() }))).toEqual({});
    expect(await favorites(me.client)).toEqual({ pages: [], spaces: [] });
    for (const body of [{}, { pageId: null }, { pageId: "", spaceId: "" }]) expectInvalid(await me.client.post("/favorites/remove", body), either);
    expectInvalid(await me.client.post("/favorites/remove", { pageId: "nope" }), "pageId must be a valid id");
    expectInvalid(await me.client.post("/favorites/remove", { pageId: a.id, spaceId: "nope" }), "spaceId must be a valid id");
    // Added again, a favorite goes to the end.
    data(await me.client.post("/favorites", { pageId: b.id }));
    data(await me.client.post("/favorites", { pageId: a.id }));
    expect((await favorites(me.client)).pages.map((p: any) => p.title)).toEqual(["B", "A"]);
  });

  test("a page in the trash drops off the list until it is restored, and can be made a favorite meanwhile", async () => {
    const me = await freshReader();
    const kept = await createPage(owner, { spaceId: team.id, title: "Kept" });
    const trashed = await createPage(owner, { spaceId: team.id, title: "Trashed" });
    const late = await createPage(owner, { spaceId: team.id, title: "Favorite while trashed" });
    data(await me.client.post("/favorites", { pageId: trashed.id }));
    data(await me.client.post("/favorites", { pageId: kept.id }));
    data(await owner.post(`/pages/${trashed.id}/delete`));
    data(await owner.post(`/pages/${late.id}/delete`));
    expect(data(await me.client.post("/favorites", { pageId: late.id }))).toEqual({});
    expect((await favorites(me.client)).pages.map((p: any) => p.title)).toEqual(["Kept"]);
    data(await owner.post(`/pages/${trashed.id}/restore`));
    data(await owner.post(`/pages/${late.id}/restore`));
    expect((await favorites(me.client)).pages.map((p: any) => p.title)).toEqual(["Trashed", "Kept", "Favorite while trashed"]);
  });

  test("favorites in a space the user loses are hidden, can still be removed, and return with the access", async () => {
    const space = await createSpace(owner, "Come and go", `fav-${++counter}`);
    const me = await person(t, owner, `come-and-go-${counter}@example.com`, { space: space.id, spaceRole: "reader" });
    const a = await createPage(owner, { spaceId: space.id, title: "A" });
    const b = await createPage(owner, { spaceId: space.id, title: "B" });
    for (const body of [{ pageId: a.id }, { pageId: b.id }, { spaceId: space.id }]) data(await me.client.post("/favorites", body));
    data(await owner.post(`/spaces/${space.id}/members/remove`, { memberId: await memberRow(owner, space.id, me.id) }));
    expect(await favorites(me.client)).toEqual({ pages: [], spaces: [] });
    expectNotFound(await me.client.post("/favorites", { pageId: a.id }), "Page");
    // Removing does not ask for access.
    expect(data(await me.client.post("/favorites/remove", { pageId: b.id }))).toEqual({});
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "writer", userIds: [me.id] }));
    const back = await favorites(me.client);
    expect(back.pages.map((p: any) => p.title)).toEqual(["A"]);
    expect(back.spaces).toEqual([{ ...space, role: "writer", memberCount: 2 }]);
    // Moved to a space the user cannot read, a page is hidden again.
    const hidden = await createSpace(owner, "Hidden", `fav-${++counter}`);
    data(await owner.post(`/pages/${a.id}/move-to-space`, { spaceId: hidden.id }));
    expect((await favorites(me.client)).pages).toEqual([]);
    // Deleted for good, the favorite goes with the page.
    data(await owner.post(`/pages/${a.id}/delete-permanently`));
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM favorites WHERE user_id = ${me.id}`;
    expect(n).toBe(1);
  });

  test("the space reference of a favorite page carries the space's icon", async () => {
    const space = await createSpace(owner, "With an icon", `fav-${++counter}`);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
    const iconUrl: string = data(await owner.upload(`/spaces/${space.id}/icon`, { file: new File([png], "i.png") })).space.iconUrl;
    const page = await createPage(owner, { spaceId: space.id, title: "Iconic" });
    data(await owner.post("/favorites", { pageId: page.id }));
    expect((await favorites(owner)).pages.find((p: any) => p.id === page.id).space).toEqual({ id: space.id, name: "With an icon", slug: space.slug, iconUrl });
    expect(iconUrl).toMatch(/^\/api\/images\/[0-9a-f-]{36}\.png$/);
    data(await owner.post("/favorites/remove", { pageId: page.id }));
  });
});

describe("watching a page", () => {
  test("is off until switched on, and each user's own", async () => {
    const me = await freshReader();
    const page = await createPage(owner, { spaceId: team.id, title: "Watched" });
    const state = async (client: Client, ref = page.id) => {
      const res = await client.get(`/pages/${ref}/watch`);
      expect(res.status).toBe(200);
      return res.body;
    };
    expect(await state(me.client)).toEqual({ data: { watching: false } });
    const on = await me.client.post(`/pages/${page.id}/watch`, { watching: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ data: {} });
    expect(await state(me.client, page.slugId)).toEqual({ data: { watching: true } });
    expect(await state(reader.client)).toEqual({ data: { watching: false } });
    // Switching on twice keeps one watch; off twice is fine too.
    data(await me.client.post(`/pages/${page.slugId}/watch`, { watching: true }));
    const count = async () => (await t.sql`SELECT count(*)::int AS n FROM watchers WHERE user_id = ${me.id} AND page_id = ${page.id}`)[0].n;
    expect(await count()).toBe(1);
    expect(data(await me.client.post(`/pages/${page.id.toUpperCase()}/watch`, { watching: false }))).toEqual({});
    expect(await state(me.client)).toEqual({ data: { watching: false } });
    expect(data(await me.client.post(`/pages/${page.id}/watch`, { watching: false }))).toEqual({});
    expect(await count()).toBe(0);
  });

  test("watching must be a boolean, in any of its accepted spellings", async () => {
    const me = await freshReader();
    const page = await createPage(owner, { spaceId: team.id, title: "Spellings" });
    const set = (watching: unknown) => me.client.post(`/pages/${page.id}/watch`, { watching });
    const watching = async () => data(await me.client.get(`/pages/${page.id}/watch`)).watching;
    expectInvalid(await me.client.post(`/pages/${page.id}/watch`, {}), "watching is required");
    for (const value of [null, 1, 0, "yes", "TRUE", "on", [], {}]) expectInvalid(await set(value), "watching must be a boolean");
    for (const [value, expected] of [["true", true], ["false", false], ["1", true], ["0", false], [true, true], ["", false]] as const) {
      expect(data(await set(value))).toEqual({});
      expect(await watching()).toBe(expected);
    }
  });

  test("the creator of a page, its duplicator and whoever comments on it watch it", async () => {
    const space = await createSpace(owner, "Auto watch", `watch-${++counter}`);
    const creator = await person(t, owner, `creator-${counter}@example.com`, { space: space.id, spaceRole: "writer" });
    const commenter = await person(t, owner, `commenter-${counter}@example.com`, { space: space.id, spaceRole: "writer" });
    const page = await createPage(creator.client, { spaceId: space.id, title: "Created" });
    const watching = async (who: Person | Client, pageId: string) => data(await ("client" in who ? who.client : who).get(`/pages/${pageId}/watch`)).watching;
    expect([await watching(creator, page.id), await watching(commenter, page.id), await watching(owner, page.id)]).toEqual([true, false, false]);
    data(await commenter.client.post("/comments", { pageId: page.id, body: doc("I am watching now") }));
    expect(await watching(commenter, page.id)).toBe(true);
    const copy = data(await commenter.client.post(`/pages/${page.id}/duplicate`)).page;
    expect([await watching(commenter, copy.id), await watching(creator, copy.id)]).toEqual([true, false]);
    // Unwatching sticks: commenting again watches again.
    data(await commenter.client.post(`/pages/${page.id}/watch`, { watching: false }));
    expect(await watching(commenter, page.id)).toBe(false);
    data(await commenter.client.post("/comments", { pageId: page.id, body: doc("and again") }));
    expect(await watching(commenter, page.id)).toBe(true);
    // A base is watched by its creator as well.
    const base = data(await creator.client.post("/bases", { spaceId: space.id, title: "Base" })).page;
    expect(await watching(creator, base.id)).toBe(true);
  });

  test("any reader may watch, also a page in the trash; without access the page is not found", async () => {
    const space = await createSpace(owner, "Watch access", `watch-${++counter}`);
    const me = await person(t, owner, `watch-access-${counter}@example.com`, { space: space.id, spaceRole: "reader" });
    const page = await createPage(owner, { spaceId: space.id, title: "Access" });
    expectNotFound(await outsider.client.get(`/pages/${page.id}/watch`), "Page");
    expectNotFound(await outsider.client.post(`/pages/${page.id}/watch`, { watching: true }), "Page");
    // The page is checked before the body.
    expectNotFound(await outsider.client.post(`/pages/${page.id}/watch`, {}), "Page");
    expectNotFound(await owner.get(`/pages/${NO_SUCH_ID}/watch`), "Page");
    expectNotFound(await owner.post("/pages/not-a-page/watch", { watching: true }), "Page");
    data(await owner.post(`/pages/${page.id}/delete`));
    expect(data(await me.client.post(`/pages/${page.id}/watch`, { watching: true }))).toEqual({});
    expect(data(await me.client.get(`/pages/${page.id}/watch`))).toEqual({ watching: true });
    data(await owner.post(`/spaces/${space.id}/members/remove`, { memberId: await memberRow(owner, space.id, me.id) }));
    expectNotFound(await me.client.get(`/pages/${page.id}/watch`), "Page");
    expectNotFound(await me.client.post(`/pages/${page.id}/watch`, { watching: false }), "Page");
    // The watch is kept, and shows again with the access.
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "reader", userIds: [me.id] }));
    expect(data(await me.client.get(`/pages/${page.id}/watch`))).toEqual({ watching: true });
  });
});

describe("watching a space", () => {
  test("is off until switched on, per user, and separate from watching its pages", async () => {
    const me = await freshReader();
    const page = await createPage(owner, { spaceId: team.id, title: "In a watched space" });
    const res = await me.client.get(`/spaces/${team.id}/watch`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { watching: false } });
    const on = await me.client.post(`/spaces/${team.id.toUpperCase()}/watch`, { watching: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ data: {} });
    data(await me.client.post(`/spaces/${team.id}/watch`, { watching: "1" }));
    expect(data(await me.client.get(`/spaces/${team.id.toUpperCase()}/watch`))).toEqual({ watching: true });
    expect(data(await reader.client.get(`/spaces/${team.id}/watch`))).toEqual({ watching: false });
    expect(data(await me.client.get(`/pages/${page.id}/watch`))).toEqual({ watching: false });
    const rows = await t.sql`SELECT page_id, space_id FROM watchers WHERE user_id = ${me.id}`;
    expect(rows).toEqual([{ page_id: null, space_id: team.id }]);
    expect(data(await me.client.post(`/spaces/${team.id}/watch`, { watching: false }))).toEqual({});
    expect(data(await me.client.post(`/spaces/${team.id}/watch`, { watching: false }))).toEqual({});
    expect(data(await me.client.get(`/spaces/${team.id}/watch`))).toEqual({ watching: false });
  });

  test("needs membership of the space, named by id, and a boolean", async () => {
    for (const client of [outsider.client]) {
      expectNotFound(await client.get(`/spaces/${team.id}/watch`), "Space");
      expectNotFound(await client.post(`/spaces/${team.id}/watch`, { watching: true }), "Space");
      expectNotFound(await client.post(`/spaces/${team.id}/watch`, {}), "Space");
    }
    for (const ref of [team.slug, NO_SUCH_ID, "nope"]) {
      expectNotFound(await owner.get(`/spaces/${ref}/watch`), "Space");
      expectNotFound(await owner.post(`/spaces/${ref}/watch`, { watching: true }), "Space");
    }
    expectInvalid(await reader.client.post(`/spaces/${team.id}/watch`, {}), "watching is required");
    expectInvalid(await reader.client.post(`/spaces/${team.id}/watch`, { watching: "maybe" }), "watching must be a boolean");
    expectInvalid(await reader.client.post(`/spaces/${team.id}/watch`, { watching: null }), "watching must be a boolean");
    // Readers are allowed; there is no role above reader to ask for.
    expectForbidden(await reader.client.post("/pages", { spaceId: team.id }));
    expect(data(await reader.client.post(`/spaces/${team.id}/watch`, { watching: true }))).toEqual({});
    data(await reader.client.post(`/spaces/${team.id}/watch`, { watching: false }));
  });
});
