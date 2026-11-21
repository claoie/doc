import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Client, type TestServer } from "./harness";
import { apiError } from "./harness/errors";

/**
 * Managing shares as a member (src/server/routes/shares.ts, lib/shares.ts):
 * `GET|POST /pages/:id/share`, `POST /pages/:id/share/delete` and
 * `GET /spaces/:id/shares`. What the public sees is in public-shares.test.ts.
 */

let t: TestServer;
let owner: Client;
let ownerId: string;
let spaceId: string;
let reader: Client;
let writer: Client;
let outsider: Client;

interface PageRef {
  id: string;
  slugId: string;
  title: string | null;
  position: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KEY = /^[0-9a-z]{10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DISABLED = apiError("sharing_disabled", "Sharing is disabled for this space or workspace");
const PAGE_NOT_FOUND = apiError("not_found", "Page not found");
const FORBIDDEN = apiError("forbidden", "You do not have permission to do this");
const UNAUTHORIZED = apiError("unauthorized", "Sign in required");

const newPage = async (title: string | null, parentId?: string, space = spaceId): Promise<PageRef> => {
  const res = await owner.post("/pages", { spaceId: space, title, parentId });
  expect(res.status).toBe(200);
  return res.body.data.page;
};

const newSpace = async (name: string, slug: string) => {
  const res = await owner.post("/spaces", { name, slug });
  expect(res.status).toBe(200);
  return res.body.data.space.id as string;
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

beforeAll(async () => {
  t = await startServer();
  const setup = await t.setupOwner();
  owner = setup.owner;
  ownerId = setup.user.id;
  spaceId = setup.spaceId;
  const add = async (email: string, role: string | null) => {
    const member = await t.addMember(owner, email);
    if (role) expect((await owner.post(`/spaces/${spaceId}/members/add`, { role, userIds: [member.user.id] })).status).toBe(200);
    return member;
  };
  reader = (await add("share-reader@example.com", "reader")).client;
  writer = (await add("share-writer@example.com", "writer")).client;
  outsider = (await add("share-outsider@example.com", null)).client;
});

afterAll(async () => {
  await t.close();
});

describe("POST /pages/:id/share: creating a share", () => {
  test("a share is created with both flags off, a random key and the public URL of the page", async () => {
    const page = await newPage("Launch plan");
    const res = await owner.post(`/pages/${page.id}/share`, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        share: {
          id: expect.stringMatching(UUID),
          key: expect.stringMatching(KEY),
          pageId: page.id,
          includeChildren: false,
          searchIndexing: false,
          url: expect.any(String),
          createdAt: expect.stringMatching(ISO),
        },
      },
    });
    const share = res.body.data.share;
    expect(share.url).toBe(`http://doc.test/share/${share.key}/p/launch-plan-${page.slugId}`);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const [row] = await t.sql`SELECT id, key, page_id, include_children, search_indexing, created_by, created_at, updated_at FROM shares WHERE page_id = ${page.id}`;
    expect(row).toEqual({
      id: share.id,
      key: share.key,
      page_id: page.id,
      include_children: false,
      search_indexing: false,
      created_by: ownerId,
      created_at: new Date(share.createdAt),
      updated_at: new Date(share.createdAt),
    });
  });

  test("the flags can be given at creation", async () => {
    const page = await newPage("With flags");
    const res = await owner.post(`/pages/${page.id}/share`, { includeChildren: true, searchIndexing: true });
    expect(res.body.data.share).toMatchObject({ includeChildren: true, searchIndexing: true });
    const other = await newPage("With one flag");
    const one = await owner.post(`/pages/${other.id}/share`, { searchIndexing: true });
    expect(one.body.data.share).toMatchObject({ includeChildren: false, searchIndexing: true });
  });

  test("keys are 10 characters of 0-9 and a-z, different for every share", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 12; i++) {
      const page = await newPage(`Key ${i}`);
      const key = (await owner.post(`/pages/${page.id}/share`, {})).body.data.share.key as string;
      expect(key).toMatch(KEY);
      keys.push(key);
    }
    expect(new Set(keys).size).toBe(12);
  });

  test("an empty request body is the same as {}", async () => {
    const page = await newPage("No body");
    const res = await owner.raw("POST", `/pages/${page.id}/share`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.share).toMatchObject({ pageId: page.id, includeChildren: false, searchIndexing: false });
  });

  test("the page may be given by slugId or by an id in upper case", async () => {
    const page = await newPage("By reference");
    const bySlug = await owner.post(`/pages/${page.slugId}/share`, {});
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.data.share.pageId).toBe(page.id);
    const byUpper = await owner.post(`/pages/${page.id.toUpperCase()}/share`, { includeChildren: true });
    expect(byUpper.status).toBe(200);
    expect(byUpper.body.data.share.key).toBe(bySlug.body.data.share.key);
    const state = await owner.get(`/pages/${page.slugId}/share`);
    expect(state.body.data.share.key).toBe(bySlug.body.data.share.key);
  });
});

describe("POST /pages/:id/share: updating a share", () => {
  test("posting again keeps the share and changes only the flags that are given", async () => {
    const page = await newPage("Flags");
    const created = (await owner.post(`/pages/${page.id}/share`, {})).body.data.share;
    const flags = async (body: unknown) => {
      const res = await owner.post(`/pages/${page.id}/share`, body);
      expect(res.status).toBe(200);
      const share = res.body.data.share;
      // Id, key, URL and creation time never change.
      expect({ ...share, includeChildren: false, searchIndexing: false }).toEqual(created);
      return [share.includeChildren, share.searchIndexing];
    };
    expect(await flags({ includeChildren: true })).toEqual([true, false]);
    expect(await flags({ searchIndexing: true })).toEqual([true, true]);
    expect(await flags({})).toEqual([true, true]);
    expect(await flags({ includeChildren: false })).toEqual([false, true]);
    expect(await flags({ searchIndexing: false })).toEqual([false, false]);
    expect(await flags({ includeChildren: true, searchIndexing: true })).toEqual([true, true]);
    expect(await flags({ includeChildren: false, searchIndexing: false })).toEqual([false, false]);

    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM shares WHERE page_id = ${page.id}`;
    expect(n).toBe(1);
    const [row] = await t.sql`SELECT created_at, updated_at, created_by FROM shares WHERE page_id = ${page.id}`;
    expect(row.updated_at.getTime()).toBeGreaterThan(row.created_at.getTime());
  });

  test("an update by someone else keeps who created the share", async () => {
    const page = await newPage("Shared by the owner");
    const created = (await owner.post(`/pages/${page.id}/share`, {})).body.data.share;
    const res = await writer.post(`/pages/${page.id}/share`, { includeChildren: true });
    expect(res.status).toBe(200);
    expect(res.body.data.share).toEqual({ ...created, includeChildren: true });
    const [row] = await t.sql`SELECT created_by FROM shares WHERE page_id = ${page.id}`;
    expect(row.created_by).toBe(ownerId);
  });

  test("the flags accept the query-string spellings of a boolean", async () => {
    const page = await newPage("Spellings");
    const flags = async (body: unknown) => {
      const share = (await owner.post(`/pages/${page.id}/share`, body)).body.data.share;
      return [share.includeChildren, share.searchIndexing];
    };
    expect(await flags({ includeChildren: "1", searchIndexing: "true" })).toEqual([true, true]);
    expect(await flags({ includeChildren: "0", searchIndexing: "false" })).toEqual([false, false]);
    expect(await flags({ includeChildren: "true", searchIndexing: "1" })).toEqual([true, true]);
    // An empty string is false, not "absent".
    expect(await flags({ includeChildren: "", searchIndexing: "" })).toEqual([false, false]);
  });

  test.each([
    ["includeChildren", null],
    ["includeChildren", 1],
    ["includeChildren", 0],
    ["includeChildren", "yes"],
    ["includeChildren", "TRUE"],
    ["includeChildren", " true"],
    ["includeChildren", []],
    ["includeChildren", {}],
    ["searchIndexing", null],
    ["searchIndexing", 1],
    ["searchIndexing", "on"],
    ["searchIndexing", [true]],
  ])("%s: %p is not a boolean", async (field, value) => {
    const page = await newPage("Invalid flag");
    const before = (await owner.post(`/pages/${page.id}/share`, { includeChildren: true })).body.data.share;
    const res = await owner.post(`/pages/${page.id}/share`, { [field]: value });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(apiError("invalid_input", `${field} must be a boolean`));
    expect((await owner.get(`/pages/${page.id}/share`)).body.data.share).toEqual(before);
  });

  test("includeChildren is checked before searchIndexing, and nothing is created when either is wrong", async () => {
    const page = await newPage("Both wrong");
    const res = await owner.post(`/pages/${page.id}/share`, { searchIndexing: 2, includeChildren: 2 });
    expect(res.body).toEqual(apiError("invalid_input", "includeChildren must be a boolean"));
    expect((await owner.get(`/pages/${page.id}/share`)).body.data.share).toBeNull();
  });

  test("unknown fields are ignored: the key, page and URL cannot be chosen", async () => {
    const page = await newPage("Extra fields");
    const res = await owner.post(`/pages/${page.id}/share`, { key: "aaaaaaaaaa", pageId: crypto.randomUUID(), url: "http://evil.example", id: crypto.randomUUID(), includeChildren: true });
    expect(res.status).toBe(200);
    const share = res.body.data.share;
    expect(share.key).not.toBe("aaaaaaaaaa");
    expect(share.pageId).toBe(page.id);
    expect(share.url).toBe(`http://doc.test/share/${share.key}/p/extra-fields-${page.slugId}`);
  });

  test("the body must be a JSON object sent as JSON", async () => {
    const page = await newPage("Bodies");
    const send = async (body: string, type: string) => {
      const res = await owner.raw("POST", `/pages/${page.id}/share`, { body, headers: { "Content-Type": type } });
      return [res.status, await res.json()];
    };
    expect(await send("[]", "application/json")).toEqual([400, apiError("invalid_input", "Expected a JSON object")]);
    expect(await send("null", "application/json")).toEqual([400, apiError("invalid_input", "Expected a JSON object")]);
    expect(await send('"x"', "application/json")).toEqual([400, apiError("invalid_input", "Expected a JSON object")]);
    expect(await send("{nope", "application/json")).toEqual([400, apiError("invalid_input", "Malformed JSON")]);
    expect(await send("{}", "text/plain")).toEqual([415, apiError("unsupported_media_type", "Expected application/json")]);
    expect(await send("includeChildren=true", "application/x-www-form-urlencoded")).toEqual([
      415,
      apiError("unsupported_media_type", "Expected application/json"),
    ]);
    expect((await owner.get(`/pages/${page.id}/share`)).body.data.share).toBeNull();
    // A charset parameter and upper case are fine.
    expect((await send('{"includeChildren":true}', "Application/JSON; charset=utf-8"))[0]).toBe(200);
  });
});

describe("the share URL", () => {
  const urlFor = async (title: string | null) => {
    const page = await newPage(title);
    const res = await owner.post(`/pages/${page.id}/share`, {});
    expect(res.status).toBe(200);
    const { key, url } = res.body.data.share as { key: string; url: string };
    const prefix = `http://doc.test/share/${key}/p/`;
    const suffix = `-${page.slugId}`;
    expect(url.startsWith(prefix)).toBe(true);
    expect(url.endsWith(suffix)).toBe(true);
    return url.slice(prefix.length, url.length - suffix.length);
  };

  test.each([
    ["Hello World", "hello-world"],
    ["  Hello,   World!  ", "hello-world"],
    ["UPPER lower 123", "upper-lower-123"],
    ["under_score-dash.dot/slash", "under-score-dash-dot-slash"],
    ["---already--dashed---", "already-dashed"],
    ["a&b=c?d#e%f", "a-b-c-d-e-f"],
    // Accents are dropped, the letters stay.
    ["Crème Brûlée", "creme-brulee"],
    ["Ünïcödé Ñandú", "unicode-nandu"],
    ["é å", "e-a"],
    // Compatibility forms are folded; ß has none.
    ["ﬁne Ⅻ ½ İstanbul ß", "fine-xii-1-2-istanbul-%C3%9F"],
    ["ǅ ǆ Σίσυφος", "dz-dz-%CF%83%CE%B9%CF%83%CF%85%CF%86%CE%BF%CF%82"],
    ["Ｆｕｌｌ　Ｗｉｄｔｈ", "full-width"],
    // Other scripts are kept and percent-encoded.
    ["日本語 ページ", "%E6%97%A5%E6%9C%AC%E8%AA%9E-%E3%83%9A%E3%83%BC%E3%82%B8"],
    ["한국어 제목", "%ED%95%9C%EA%B5%AD%EC%96%B4-%EC%A0%9C%EB%AA%A9"],
    ["مرحبا بالعالم ٣", "%D9%85%D8%B1%D8%AD%D8%A8%D8%A7-%D8%A8%D8%A7%D9%84%D8%B9%D8%A7%D9%84%D9%85-%D9%A3"],
    ["עברית", "%D7%A2%D7%91%D7%A8%D7%99%D7%AA"],
    // Emoji and symbols are separators.
    ["🎉 Party 🎉", "party"],
    ["Q3 → Q4 ✔ done", "q3-q4-done"],
  ])("the title %p gives the slug %p", async (title, slug) => {
    expect(await urlFor(title)).toBe(slug);
  });

  test("a page with no usable title is `untitled`", async () => {
    expect(await urlFor(null)).toBe("untitled");
    expect(await urlFor("")).toBe("untitled");
    expect(await urlFor("   ")).toBe("untitled");
    expect(await urlFor("!!!")).toBe("untitled");
    expect(await urlFor("🎉🎉")).toBe("untitled");
    expect(await urlFor("—")).toBe("untitled");
  });

  test("the slug is cut at 60 characters", async () => {
    expect(await urlFor("x".repeat(60))).toBe("x".repeat(60));
    expect(await urlFor("x".repeat(61))).toBe("x".repeat(60));
    expect(await urlFor("x".repeat(500))).toBe("x".repeat(60));
    expect(await urlFor("word ".repeat(30))).toBe("word-word-word-word-word-word-word-word-word-word-word-word-");
    // A separator left at the cut is not trimmed again.
    expect(await urlFor("a".repeat(59) + " b c")).toBe("a".repeat(59) + "-");
    // The 60 are UTF-16 units: an astral letter that ends within them is kept whole.
    expect(await urlFor("a".repeat(58) + "𐌰𐌰")).toBe("a".repeat(58) + "%F0%90%8C%B0");
    expect(await urlFor("日".repeat(80))).toBe("%E6%97%A5".repeat(60));
  });

  test("the URL follows the page's title", async () => {
    const page = await newPage("Before");
    const share = (await owner.post(`/pages/${page.id}/share`, {})).body.data.share;
    expect(share.url).toBe(`http://doc.test/share/${share.key}/p/before-${page.slugId}`);
    expect((await owner.post(`/pages/${page.id}/update`, { title: "After the rename" })).status).toBe(200);
    const state = await owner.get(`/pages/${page.id}/share`);
    expect(state.body.data.share).toEqual({ ...share, url: `http://doc.test/share/${share.key}/p/after-the-rename-${page.slugId}` });
  });

  test("a title whose slug is cut in the middle of an astral letter breaks the share", async () => {
    // Kept in a space of its own: the share list of the space breaks with it.
    const space = await newSpace("Broken slugs", "broken-slugs");
    const page = await newPage("a".repeat(59) + "𐌰𐌰", undefined, space);
    const internal = apiError("internal_error", "Something went wrong");
    // Accident: half of a surrogate pair is left at the cut and cannot be percent-encoded.
    const created = await owner.post(`/pages/${page.id}/share`, {});
    expect([created.status, created.body]).toEqual([500, internal]);
    // The share was made all the same, and every answer that describes it fails too.
    const [row] = await t.sql`SELECT key FROM shares WHERE page_id = ${page.id}`;
    expect(row.key).toMatch(KEY);
    const state = await owner.get(`/pages/${page.id}/share`);
    expect([state.status, state.body]).toEqual([500, internal]);
    const listed = await owner.get(`/spaces/${space}/shares`);
    expect([listed.status, listed.body]).toEqual([500, internal]);
    const seen = await t.client().get(`/public/shares/${row.key}`);
    expect([seen.status, seen.body]).toEqual([500, internal]);
    // Deleting it works.
    expect((await owner.post(`/pages/${page.id}/share/delete`)).status).toBe(200);
    expect((await owner.get(`/spaces/${space}/shares`)).body).toEqual({ data: [] });
  });
});

describe("GET /pages/:id/share", () => {
  test("a page that is not shared has no share and inherits none", async () => {
    const page = await newPage("Private");
    const res = await owner.get(`/pages/${page.id}/share`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { share: null, inheritedFrom: null } });
  });

  test("a shared page shows its share; its own share is not inherited", async () => {
    const page = await newPage("Own share");
    const share = (await owner.post(`/pages/${page.id}/share`, { includeChildren: true })).body.data.share;
    const res = await owner.get(`/pages/${page.id}/share`);
    expect(res.body).toEqual({ data: { share, inheritedFrom: null } });
  });

  test("a page below a share with children inherits it, with the sharing page", async () => {
    const root = await newPage("Handbook");
    const child = await newPage("Chapter", root.id);
    const grandchild = await newPage("Section", child.id);
    const share = (await owner.post(`/pages/${root.id}/share`, { includeChildren: true })).body.data.share;
    for (const page of [child, grandchild]) {
      const res = await owner.get(`/pages/${page.id}/share`);
      expect(res.body).toEqual({
        data: { share: null, inheritedFrom: { share, page: treeItem(root, { hasChildren: true }) } },
      });
    }
  });

  test("a share without children is not inherited", async () => {
    const root = await newPage("Only this page");
    const child = await newPage("Not shared", root.id);
    await owner.post(`/pages/${root.id}/share`, { includeChildren: false });
    expect((await owner.get(`/pages/${child.id}/share`)).body).toEqual({ data: { share: null, inheritedFrom: null } });
    // Turning children on makes it inherited, turning it off again ends that.
    const share = (await owner.post(`/pages/${root.id}/share`, { includeChildren: true })).body.data.share;
    expect((await owner.get(`/pages/${child.id}/share`)).body.data.inheritedFrom.share).toEqual(share);
    await owner.post(`/pages/${root.id}/share`, { includeChildren: false });
    expect((await owner.get(`/pages/${child.id}/share`)).body.data.inheritedFrom).toBeNull();
  });

  test("the nearest ancestor that shares its children is the one inherited from", async () => {
    const top = await newPage("Top");
    const middle = await newPage("Middle", top.id);
    const lower = await newPage("Lower", middle.id);
    const leaf = await newPage("Leaf", lower.id);
    const topShare = (await owner.post(`/pages/${top.id}/share`, { includeChildren: true })).body.data.share;
    const middleShare = (await owner.post(`/pages/${middle.id}/share`, { includeChildren: true })).body.data.share;
    const lowerShare = (await owner.post(`/pages/${lower.id}/share`, { includeChildren: false })).body.data.share;

    // The leaf skips `lower` (no children) and stops at `middle`.
    const leafState = (await owner.get(`/pages/${leaf.id}/share`)).body.data;
    expect(leafState).toEqual({
      share: null,
      inheritedFrom: { share: middleShare, page: treeItem(middle, { parentId: top.id, hasChildren: true }) },
    });
    // A page with its own share still reports what it inherits.
    const lowerState = (await owner.get(`/pages/${lower.id}/share`)).body.data;
    expect(lowerState.share).toEqual(lowerShare);
    expect(lowerState.inheritedFrom.share).toEqual(middleShare);
    const middleState = (await owner.get(`/pages/${middle.id}/share`)).body.data;
    expect(middleState.share).toEqual(middleShare);
    expect(middleState.inheritedFrom).toEqual({ share: topShare, page: treeItem(top, { hasChildren: true }) });
    expect((await owner.get(`/pages/${top.id}/share`)).body.data).toEqual({ share: topShare, inheritedFrom: null });

    // Without the middle share the leaf inherits from the top.
    expect((await owner.post(`/pages/${middle.id}/share/delete`)).status).toBe(200);
    expect((await owner.get(`/pages/${leaf.id}/share`)).body.data.inheritedFrom.share).toEqual(topShare);
  });

  test("moving a page changes what it inherits", async () => {
    const shared = await newPage("Shared parent");
    const plain = await newPage("Plain parent");
    const page = await newPage("Moves around", plain.id);
    const share = (await owner.post(`/pages/${shared.id}/share`, { includeChildren: true })).body.data.share;
    expect((await owner.get(`/pages/${page.id}/share`)).body.data.inheritedFrom).toBeNull();
    expect((await owner.post(`/pages/${page.id}/move`, { parentId: shared.id, afterId: null })).status).toBe(200);
    expect((await owner.get(`/pages/${page.id}/share`)).body.data.inheritedFrom.share).toEqual(share);
    expect((await owner.post(`/pages/${page.id}/move`, { parentId: null, afterId: null })).status).toBe(200);
    expect((await owner.get(`/pages/${page.id}/share`)).body.data.inheritedFrom).toBeNull();
  });
});

describe("POST /pages/:id/share/delete", () => {
  test("removes the share; removing again or removing none is fine", async () => {
    const page = await newPage("Unshare me");
    const key = (await owner.post(`/pages/${page.id}/share`, {})).body.data.share.key as string;
    const res = await owner.post(`/pages/${page.id}/share/delete`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: {} });
    expect((await owner.get(`/pages/${page.id}/share`)).body).toEqual({ data: { share: null, inheritedFrom: null } });
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM shares WHERE key = ${key}`;
    expect(n).toBe(0);
    expect((await owner.post(`/pages/${page.id}/share/delete`)).body).toEqual({ data: {} });
    const never = await newPage("Never shared");
    expect((await owner.post(`/pages/${never.id}/share/delete`)).body).toEqual({ data: {} });
  });

  test("sharing again after a delete gives a new key and id", async () => {
    const page = await newPage("Shared twice");
    const first = (await owner.post(`/pages/${page.id}/share`, { includeChildren: true, searchIndexing: true })).body.data.share;
    await owner.post(`/pages/${page.id}/share/delete`);
    const second = (await owner.post(`/pages/${page.id}/share`, {})).body.data.share;
    expect(second.key).not.toBe(first.key);
    expect(second.id).not.toBe(first.id);
    // The flags start over.
    expect(second).toMatchObject({ includeChildren: false, searchIndexing: false });
  });

  test("does not touch the shares of other pages", async () => {
    const parent = await newPage("Keeps its share");
    const child = await newPage("Loses its share", parent.id);
    const parentShare = (await owner.post(`/pages/${parent.id}/share`, { includeChildren: true })).body.data.share;
    await owner.post(`/pages/${child.id}/share`, {});
    await owner.post(`/pages/${child.id}/share/delete`);
    expect((await owner.get(`/pages/${parent.id}/share`)).body.data.share).toEqual(parentShare);
    expect((await owner.get(`/pages/${child.id}/share`)).body.data).toEqual({
      share: null,
      inheritedFrom: { share: parentShare, page: treeItem(parent, { hasChildren: true }) },
    });
  });
});

describe("who may see and manage a share", () => {
  let page: PageRef;
  let share: Record<string, unknown>;

  beforeAll(async () => {
    page = await newPage("Permissions");
    share = (await owner.post(`/pages/${page.id}/share`, {})).body.data.share;
  });

  test("without a session nothing is answered", async () => {
    const anonymous = t.client();
    for (const res of [
      await anonymous.get(`/pages/${page.id}/share`),
      await anonymous.post(`/pages/${page.id}/share`, {}),
      await anonymous.post(`/pages/${page.id}/share/delete`),
      await anonymous.get(`/spaces/${spaceId}/shares`),
    ]) {
      expect([res.status, res.body]).toEqual([401, UNAUTHORIZED]);
    }
  });

  test("someone outside the space cannot tell the page or the space exists", async () => {
    expect([(await outsider.get(`/pages/${page.id}/share`)).status, (await outsider.get(`/pages/${page.id}/share`)).body]).toEqual([404, PAGE_NOT_FOUND]);
    const created = await outsider.post(`/pages/${page.id}/share`, {});
    expect([created.status, created.body]).toEqual([404, PAGE_NOT_FOUND]);
    const deleted = await outsider.post(`/pages/${page.id}/share/delete`);
    expect([deleted.status, deleted.body]).toEqual([404, PAGE_NOT_FOUND]);
    const listed = await outsider.get(`/spaces/${spaceId}/shares`);
    expect([listed.status, listed.body]).toEqual([404, apiError("not_found", "Space not found")]);
    expect((await owner.get(`/pages/${page.id}/share`)).body.data.share).toEqual(share);
  });

  test("a reader sees the share and the list but cannot change them", async () => {
    const state = await reader.get(`/pages/${page.id}/share`);
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ data: { share, inheritedFrom: null } });
    const listed = await reader.get(`/spaces/${spaceId}/shares`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.some((s: { key: string }) => s.key === share.key)).toBe(true);
    const created = await reader.post(`/pages/${page.id}/share`, { includeChildren: true });
    expect([created.status, created.body]).toEqual([403, FORBIDDEN]);
    const deleted = await reader.post(`/pages/${page.id}/share/delete`);
    expect([deleted.status, deleted.body]).toEqual([403, FORBIDDEN]);
    expect((await owner.get(`/pages/${page.id}/share`)).body.data.share).toEqual(share);
  });

  test("a writer can share, update and unshare", async () => {
    const own = await newPage("Writer's share");
    const created = await writer.post(`/pages/${own.id}/share`, {});
    expect(created.status).toBe(200);
    const writerId = (await writer.get("/me")).body.data.user.id;
    const [row] = await t.sql`SELECT created_by FROM shares WHERE page_id = ${own.id}`;
    expect(row.created_by).toBe(writerId);
    expect((await writer.post(`/pages/${own.id}/share`, { searchIndexing: true })).body.data.share.searchIndexing).toBe(true);
    expect((await writer.post(`/pages/${own.id}/share/delete`)).body).toEqual({ data: {} });
  });

  test("an unknown page is 404 for every share endpoint", async () => {
    for (const ref of [crypto.randomUUID(), "0000000000", "not a page!", "a".repeat(40)]) {
      const path = `/pages/${encodeURIComponent(ref)}/share`;
      expect([(await owner.get(path)).status, (await owner.get(path)).body]).toEqual([404, PAGE_NOT_FOUND]);
      expect((await owner.post(path, {})).body).toEqual(PAGE_NOT_FOUND);
      expect((await owner.post(`${path}/delete`)).body).toEqual(PAGE_NOT_FOUND);
    }
  });

  test("the page is looked up before the body is read", async () => {
    const res = await owner.raw("POST", `/pages/${crypto.randomUUID()}/share`, { body: "{nope", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(PAGE_NOT_FOUND);
    const asReader = await reader.raw("POST", `/pages/${page.id}/share`, { body: "{nope", headers: { "Content-Type": "application/json" } });
    expect(asReader.status).toBe(403);
    await asReader.arrayBuffer();
  });
});

describe("shares and the trash", () => {
  test("trashing a page removes its share and those of the pages below; restoring brings none back", async () => {
    const root = await newPage("Trashed root");
    const child = await newPage("Trashed child", root.id);
    const sibling = await newPage("Stays shared");
    const rootKey = (await owner.post(`/pages/${root.id}/share`, { includeChildren: true })).body.data.share.key as string;
    const childKey = (await owner.post(`/pages/${child.id}/share`, {})).body.data.share.key as string;
    const siblingShare = (await owner.post(`/pages/${sibling.id}/share`, {})).body.data.share;
    expect((await owner.post(`/pages/${root.id}/delete`)).status).toBe(200);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM shares WHERE key IN (${rootKey}, ${childKey})`;
    expect(n).toBe(0);

    // A reader may still ask about the trashed page: nothing is shared.
    expect((await reader.get(`/pages/${root.id}/share`)).body).toEqual({ data: { share: null, inheritedFrom: null } });
    expect((await owner.get(`/pages/${child.id}/share`)).body).toEqual({ data: { share: null, inheritedFrom: null } });
    const listed = (await owner.get(`/spaces/${spaceId}/shares`)).body.data.map((s: { key: string }) => s.key);
    expect(listed).not.toContain(rootKey);
    expect(listed).not.toContain(childKey);
    expect(listed).toContain(siblingShare.key);

    expect((await owner.post(`/pages/${root.id}/restore`)).status).toBe(200);
    expect((await owner.get(`/pages/${root.id}/share`)).body).toEqual({ data: { share: null, inheritedFrom: null } });
    expect((await owner.get(`/pages/${child.id}/share`)).body).toEqual({ data: { share: null, inheritedFrom: null } });
  });

  test("trashing a page below a share leaves the share above alone", async () => {
    const root = await newPage("Shares its children");
    const child = await newPage("Goes to the trash", root.id);
    const share = (await owner.post(`/pages/${root.id}/share`, { includeChildren: true })).body.data.share;
    expect((await owner.post(`/pages/${child.id}/delete`)).status).toBe(200);
    expect((await owner.get(`/pages/${root.id}/share`)).body.data.share).toEqual(share);
    // The trashed page still reports what it would inherit.
    expect((await owner.get(`/pages/${child.id}/share`)).body.data.inheritedFrom.share).toEqual(share);
  });

  test("a page in the trash cannot be shared, but a share on it can be deleted", async () => {
    const page = await newPage("In the trash");
    expect((await owner.post(`/pages/${page.id}/delete`)).status).toBe(200);
    const res = await owner.post(`/pages/${page.id}/share`, {});
    expect([res.status, res.body]).toEqual([404, PAGE_NOT_FOUND]);
    // A share cannot survive trashing through the API; one is arranged to show delete accepts the page.
    await t.sql`INSERT INTO shares (key, page_id) VALUES ('trashedkey', ${page.id})`;
    expect((await owner.get(`/pages/${page.id}/share`)).body.data.share).toMatchObject({ key: "trashedkey", pageId: page.id });
    // The space's list leaves trashed pages out.
    expect((await owner.get(`/spaces/${spaceId}/shares`)).body.data.map((s: { key: string }) => s.key)).not.toContain("trashedkey");
    const deleted = await owner.post(`/pages/${page.id}/share/delete`);
    expect([deleted.status, deleted.body]).toEqual([200, { data: {} }]);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM shares WHERE key = 'trashedkey'`;
    expect(n).toBe(0);
    // A reader still may not.
    const asReader = await reader.post(`/pages/${page.id}/share/delete`);
    expect([asReader.status, asReader.body]).toEqual([403, FORBIDDEN]);
  });

  test("deleting a page for good deletes its share", async () => {
    const page = await newPage("Deleted for good");
    const key = (await owner.post(`/pages/${page.id}/share`, {})).body.data.share.key as string;
    // Arranged: trashing would already have removed the share.
    await t.sql`UPDATE pages SET deleted_at = now() WHERE id = ${page.id}`;
    expect((await owner.post(`/pages/${page.id}/delete-permanently`)).status).toBe(200);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM shares WHERE key = ${key}`;
    expect(n).toBe(0);
  });

  test("a duplicate of a shared page is not shared", async () => {
    const page = await newPage("Original, shared");
    await owner.post(`/pages/${page.id}/share`, { includeChildren: true });
    const copy = (await owner.post(`/pages/${page.id}/duplicate`, {})).body.data.page;
    expect((await owner.get(`/pages/${copy.id}/share`)).body).toEqual({ data: { share: null, inheritedFrom: null } });
  });
});

describe("GET /spaces/:id/shares", () => {
  test("lists the shares of the space's pages with their pages, newest first", async () => {
    const space = await newSpace("Listing", "listing");
    expect((await owner.get(`/spaces/${space}/shares`)).body).toEqual({ data: [] });
    const first = await newPage("First shared", undefined, space);
    const parent = await newPage("Second shared", undefined, space);
    const child = await newPage("Third shared", parent.id, space);
    const shares: Record<string, any> = {};
    for (const page of [first, parent, child]) {
      shares[page.id] = (await owner.post(`/pages/${page.id}/share`, { includeChildren: page.id === parent.id })).body.data.share;
    }
    // Updating a share does not move it in the list.
    shares[first.id] = (await owner.post(`/pages/${first.id}/share`, { searchIndexing: true })).body.data.share;

    const res = await owner.get(`/spaces/${space}/shares`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        { ...shares[child.id], page: treeItem(child, { spaceId: space, parentId: parent.id }) },
        { ...shares[parent.id], page: treeItem(parent, { spaceId: space, hasChildren: true }) },
        { ...shares[first.id], page: treeItem(first, { spaceId: space }) },
      ],
    });
    // Shares of other spaces are not in it.
    const elsewhere = (await owner.get(`/spaces/${spaceId}/shares`)).body.data.map((s: { key: string }) => s.key);
    for (const share of Object.values(shares)) expect(elsewhere).not.toContain(share.key);
  });

  test("the space is given by id, in any letter case; a slug or anything else is 404", async () => {
    const upper = await owner.get(`/spaces/${spaceId.toUpperCase()}/shares`);
    expect(upper.status).toBe(200);
    const notFound = apiError("not_found", "Space not found");
    for (const ref of ["general", "nope", crypto.randomUUID(), "123"]) {
      const res = await owner.get(`/spaces/${ref}/shares`);
      expect([ref, res.status, res.body]).toEqual([ref, 404, notFound]);
    }
  });

  test("a workspace admin who is not in the space cannot list its shares", async () => {
    const admin = await t.addMember(owner, "share-admin@example.com", "admin");
    const res = await admin.client.get(`/spaces/${spaceId}/shares`);
    expect([res.status, res.body]).toEqual([404, apiError("not_found", "Space not found")]);
  });
});

describe("sharing disabled for a space", () => {
  let space: string;
  let page: PageRef;
  let other: PageRef;

  beforeAll(async () => {
    space = await newSpace("No sharing here", "no-sharing-here");
    page = await newPage("Was shared", undefined, space);
    other = await newPage("Was shared too", undefined, space);
  });

  test("turning it on deletes the space's shares and refuses new ones; turning it off allows sharing again", async () => {
    const key = (await owner.post(`/pages/${page.id}/share`, { includeChildren: true })).body.data.share.key as string;
    await owner.post(`/pages/${other.id}/share`, {});
    const elsewhere = await newPage("Shared in another space");
    const elsewhereShare = (await owner.post(`/pages/${elsewhere.id}/share`, {})).body.data.share;

    const updated = await owner.post(`/spaces/${space}/update`, { settings: { sharingDisabled: true } });
    expect(updated.status).toBe(200);
    expect(updated.body.data.space.settings).toEqual({ sharingDisabled: true });
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM shares sh JOIN pages p ON p.id = sh.page_id WHERE p.space_id = ${space}`;
    expect(n).toBe(0);
    expect((await owner.get(`/pages/${page.id}/share`)).body).toEqual({ data: { share: null, inheritedFrom: null } });
    expect((await owner.get(`/spaces/${space}/shares`)).body).toEqual({ data: [] });
    // Other spaces keep theirs.
    expect((await owner.get(`/pages/${elsewhere.id}/share`)).body.data.share).toEqual(elsewhereShare);

    const refused = await owner.post(`/pages/${page.id}/share`, {});
    expect([refused.status, refused.body]).toEqual([403, DISABLED]);
    const refusedUpdate = await owner.post(`/pages/${page.id}/share`, { includeChildren: true });
    expect([refusedUpdate.status, refusedUpdate.body]).toEqual([403, DISABLED]);
    expect((await owner.get(`/pages/${page.id}/share`)).body.data.share).toBeNull();
    // Deleting a share that is not there still answers.
    expect((await owner.post(`/pages/${page.id}/share/delete`)).body).toEqual({ data: {} });

    expect((await owner.post(`/spaces/${space}/update`, { settings: { sharingDisabled: false } })).status).toBe(200);
    // The old shares are gone for good; a new one has a new key.
    expect((await owner.get(`/pages/${page.id}/share`)).body.data.share).toBeNull();
    const again = await owner.post(`/pages/${page.id}/share`, {});
    expect(again.status).toBe(200);
    expect(again.body.data.share.key).not.toBe(key);
    expect(again.body.data.share.includeChildren).toBe(false);
  });

  test("the body is validated before the setting is looked at", async () => {
    expect((await owner.post(`/spaces/${space}/update`, { settings: { sharingDisabled: true } })).status).toBe(200);
    try {
      const res = await owner.post(`/pages/${other.id}/share`, { includeChildren: "maybe" });
      expect([res.status, res.body]).toEqual([400, apiError("invalid_input", "includeChildren must be a boolean")]);
    } finally {
      expect((await owner.post(`/spaces/${space}/update`, { settings: { sharingDisabled: false } })).status).toBe(200);
    }
  });

  test("moving a shared page into a space that does not share drops its shares; into one that does keeps them", async () => {
    const closed = await newSpace("Closed", "closed-space");
    expect((await owner.post(`/spaces/${closed}/update`, { settings: { sharingDisabled: true } })).status).toBe(200);
    const open = await newSpace("Open", "open-space");
    const root = await newPage("Moves with its shares");
    const child = await newPage("Child with a share", root.id);
    const rootShare = (await owner.post(`/pages/${root.id}/share`, { includeChildren: true })).body.data.share;
    const childShare = (await owner.post(`/pages/${child.id}/share`, {})).body.data.share;

    expect((await owner.post(`/pages/${root.id}/move-to-space`, { spaceId: open })).status).toBe(200);
    expect((await owner.get(`/pages/${root.id}/share`)).body.data.share).toEqual(rootShare);
    expect((await owner.get(`/pages/${child.id}/share`)).body.data.share).toEqual(childShare);
    expect((await owner.get(`/spaces/${open}/shares`)).body.data.map((s: { key: string }) => s.key).sort()).toEqual([rootShare.key, childShare.key].sort());

    expect((await owner.post(`/pages/${root.id}/move-to-space`, { spaceId: closed })).status).toBe(200);
    expect((await owner.get(`/pages/${root.id}/share`)).body).toEqual({ data: { share: null, inheritedFrom: null } });
    expect((await owner.get(`/pages/${child.id}/share`)).body).toEqual({ data: { share: null, inheritedFrom: null } });
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM shares WHERE key IN (${rootShare.key}, ${childShare.key})`;
    expect(n).toBe(0);
  });
});

describe("sharing disabled for the workspace", () => {
  // Last in the file: the setting is for every space.
  test("new shares and updates are refused everywhere, existing shares stay and work again afterwards", async () => {
    const page = await newPage("Shared before the switch");
    const child = await newPage("Below it", page.id);
    const share = (await owner.post(`/pages/${page.id}/share`, { includeChildren: true })).body.data.share;
    const fresh = await newPage("Not shared before the switch");
    const otherSpace = await newSpace("Also affected", "also-affected");
    const inOtherSpace = await newPage("In another space", undefined, otherSpace);

    const updated = await owner.post("/workspace/update", { settings: { sharingDisabled: true } });
    expect(updated.status).toBe(200);
    expect(updated.body.data.workspace.settings.sharingDisabled).toBe(true);
    try {
      for (const target of [fresh, inOtherSpace, page]) {
        const res = await owner.post(`/pages/${target.id}/share`, { searchIndexing: true });
        expect([res.status, res.body]).toEqual([403, DISABLED]);
      }
      const asWriter = await writer.post(`/pages/${fresh.id}/share`, {});
      expect([asWriter.status, asWriter.body]).toEqual([403, DISABLED]);
      // The role is still checked first.
      const asReader = await reader.post(`/pages/${fresh.id}/share`, {});
      expect([asReader.status, asReader.body]).toEqual([403, FORBIDDEN]);

      // Nothing was deleted or changed: members still see the share, the inheritance and the list.
      expect((await owner.get(`/pages/${page.id}/share`)).body.data.share).toEqual(share);
      expect((await owner.get(`/pages/${child.id}/share`)).body.data.inheritedFrom.share).toEqual(share);
      expect((await owner.get(`/spaces/${spaceId}/shares`)).body.data.map((s: { key: string }) => s.key)).toContain(share.key);
      expect((await owner.get(`/pages/${fresh.id}/share`)).body.data.share).toBeNull();
      // The public cannot use it meanwhile.
      const seen = await t.client().get(`/public/shares/${share.key}`);
      expect([seen.status, seen.body]).toEqual([404, apiError("not_found", "Share not found")]);
      // Shares can still be deleted.
      const doomed = await newPage("Deleted during the switch");
      await t.sql`INSERT INTO shares (key, page_id) VALUES ('doomedkey0', ${doomed.id})`;
      expect((await owner.post(`/pages/${doomed.id}/share/delete`)).body).toEqual({ data: {} });
      expect((await owner.get(`/pages/${doomed.id}/share`)).body.data.share).toBeNull();
    } finally {
      expect((await owner.post("/workspace/update", { settings: { sharingDisabled: false } })).status).toBe(200);
    }
    expect((await t.client().get(`/public/shares/${share.key}`)).status).toBe(200);
    expect((await owner.post(`/pages/${page.id}/share`, { searchIndexing: true })).body.data.share).toEqual({ ...share, searchIndexing: true });
    expect((await owner.post(`/pages/${fresh.id}/share`, {})).status).toBe(200);
  });
});
