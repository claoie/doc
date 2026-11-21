import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Client, type TestServer } from "./harness";
import {
  NO_SUCH_ID,
  anyId,
  createPage,
  createSpace,
  data,
  expectForbidden,
  expectInvalid,
  expectNotFound,
  expectUnauthorized,
  person,
  spaceRef,
  treeItem,
  type Person,
} from "./harness/spaces-pages";

let t: TestServer;
let owner: Client;
let team: any;
let writer: Person;
let reader: Person;
let outsider: Person;

const names = (res: any) => (data(res) as any[]).map((l) => l.name);
const addLabels = (client: Client, pageId: string, list: unknown) => client.post(`/pages/${pageId}/labels`, { names: list });
const newPage = (title: string, spaceId = team.id) => createPage(owner, { spaceId, title });

beforeAll(async () => {
  t = await startServer();
  ({ owner } = await t.setupOwner());
  team = await createSpace(owner, "Team", "team");
  writer = await person(t, owner, "writer@example.com", { space: team.id, spaceRole: "writer" });
  reader = await person(t, owner, "reader@example.com", { space: team.id, spaceRole: "reader" });
  outsider = await person(t, owner, "outsider@example.com");
});

afterAll(async () => {
  await t.close();
});

describe("without a session", () => {
  test("every label endpoint answers 401", async () => {
    const page = await newPage("Anonymous");
    const anonymous = t.client();
    for (const path of [`/pages/${page.id}/labels`, "/labels", `/labels/${NO_SUCH_ID}/pages`]) expectUnauthorized(await anonymous.get(path));
    for (const path of [`/pages/${page.id}/labels`, `/pages/${page.id}/labels/remove`]) expectUnauthorized(await anonymous.post(path, {}));
  });
});

describe("POST /pages/:id/labels", () => {
  test("adds labels and answers the page's labels, by name", async () => {
    const page = await newPage("Labelled");
    expect(data(await owner.get(`/pages/${page.id}/labels`))).toEqual([]);
    const res = await writer.client.post(`/pages/${page.slugId}/labels`, { names: ["zebra", "apple", "mango"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        { id: anyId(), name: "apple" },
        { id: anyId(), name: "mango" },
        { id: anyId(), name: "zebra" },
      ],
    });
    // Adding more answers them all; adding one again changes nothing.
    const more = data(await addLabels(owner, page.id, ["banana", "apple"]));
    expect(more.map((l: any) => l.name)).toEqual(["apple", "banana", "mango", "zebra"]);
    expect(more.filter((l: any) => l.name !== "banana")).toEqual(res.body.data);
    const listed = await reader.client.get(`/pages/${page.id.toUpperCase()}/labels`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ data: more });
  });

  test("names are trimmed, lower-cased, joined by dashes, cut at 50 characters and lose trailing dashes", async () => {
    const cases: [string, string][] = [
      ["  Road Map  ", "road-map"],
      ["Q1   2026\tplans\n", "q1-2026-plans"],
      ["ALREADY-Dashed", "already-dashed"],
      ["non breaking　ideographic em", "non-breaking-ideographic-em"],
      ["﻿byte order mark﻿", "byte-order-mark"],
      ["line separator", "line-separator"],
      ["İstanbul", "i̇stanbul"],
      ["ΟΔΟΣ", "οδος"],
      ["STRASSE ẞ", "strasse-ß"],
      ["Été À Zürich", "été-à-zürich"],
      ["日本語 ラベル", "日本語-ラベル"],
      ["🚀 Launch", "🚀-launch"],
      ["Trailing---", "trailing"],
      ["trailing dash -", "trailing-dash"],
      ["-Leading", "-leading"],
      ["a--b", "a--b"],
      ["50%_Off\\Now", "50%_off\\now"],
      ["<B>&\"'", "<b>&\"'"],
      ["😀".repeat(60), "😀".repeat(50)],
      [`${"x".repeat(49)} y`, "x".repeat(49)],
      [`${"y".repeat(48)} zz`, `${"y".repeat(48)}-z`],
      ["w".repeat(100), "w".repeat(50)],
    ];
    const page = await newPage("Normalised");
    for (const [sent, stored] of cases) {
      const before = names(await owner.get(`/pages/${page.id}/labels`));
      const after = names(await addLabels(owner, page.id, [sent]));
      expect(after.filter((n: string) => !before.includes(n))).toEqual([stored]);
    }
    expect(names(await owner.get(`/pages/${page.id}/labels`)).sort()).toEqual(cases.map(([, stored]) => stored).sort());
  });

  test("names that come to the same label are one label; names that come to nothing are dropped", async () => {
    const page = await newPage("Merged");
    expect(names(await addLabels(owner, page.id, ["Dup", "dup", "  DUP  ", "d u p", "D  U\tP", "-", "---", "- -"]))).toEqual(["d-u-p", "dup"]);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM labels WHERE name IN ('dup', 'd-u-p', '')`;
    expect(n).toBe(2);
    expectInvalid(await addLabels(owner, page.id, ["-", " -- "]), "names is required");
  });

  test("a label is shared by the pages that carry it", async () => {
    const a = await newPage("Shares a label A");
    const b = await newPage("Shares a label B");
    const first = data(await addLabels(owner, a.id, ["Shared Label"]));
    const second = data(await addLabels(writer.client, b.id, ["shared-label", "only-b"]));
    expect(second.find((l: any) => l.name === "shared-label")).toEqual(first[0]);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM labels WHERE name = 'shared-label'`;
    expect(n).toBe(1);
  });

  test("names must be a list of 1 to 25 strings of 1 to 100 characters", async () => {
    const page = await newPage("Rules");
    expectInvalid(await owner.post(`/pages/${page.id}/labels`, {}), "names is required");
    expectInvalid(await addLabels(owner, page.id, []), "names is required");
    for (const list of ["one", null, {}, 5, true]) expectInvalid(await addLabels(owner, page.id, list), "names must be a list of at most 25 items");
    expectInvalid(await addLabels(owner, page.id, Array.from({ length: 26 }, (_, i) => `l${i}`)), "names must be a list of at most 25 items");
    for (const item of [5, null, ["x"], {}, true]) expectInvalid(await addLabels(owner, page.id, ["ok", item]), "names must be a string");
    for (const item of ["", "   ", "\n"]) expectInvalid(await addLabels(owner, page.id, ["ok", item]), "names is required");
    expectInvalid(await addLabels(owner, page.id, ["ok", "x".repeat(101)]), "names must be at most 100 characters");
    expectInvalid(await addLabels(owner, page.id, ["😀".repeat(101)]), "names must be at most 100 characters");
    // A refused request adds nothing, not even the names that were fine.
    expect(data(await owner.get(`/pages/${page.id}/labels`))).toEqual([]);
    expect(names(await addLabels(owner, page.id, Array.from({ length: 25 }, (_, i) => `rule ${String(i).padStart(2, "0")}`)))).toEqual(
      Array.from({ length: 25 }, (_, i) => `rule-${String(i).padStart(2, "0")}`),
    );
    expect(names(await addLabels(owner, page.id, [` ${"😀".repeat(100)} `]))).toContain("😀".repeat(50));
  });

  test("needs a writer and a page that is not in the trash; readers may look", async () => {
    const page = await newPage("Guarded");
    data(await addLabels(owner, page.id, ["kept"]));
    expectForbidden(await addLabels(reader.client, page.id, ["nope"]));
    expectForbidden(await addLabels(reader.client, page.id, "bad"));
    expectNotFound(await addLabels(outsider.client, page.id, ["nope"]), "Page");
    expectNotFound(await outsider.client.get(`/pages/${page.id}/labels`), "Page");
    expectNotFound(await addLabels(owner, NO_SUCH_ID, ["nope"]), "Page");
    expectNotFound(await owner.get(`/pages/${NO_SUCH_ID}/labels`), "Page");
    expectNotFound(await owner.get("/pages/not-a-page/labels"), "Page");
    data(await owner.post(`/pages/${page.id}/delete`));
    expectNotFound(await addLabels(owner, page.id, ["nope"]), "Page");
    expect(names(await reader.client.get(`/pages/${page.id}/labels`))).toEqual(["kept"]);
  });
});

describe("POST /pages/:id/labels/remove", () => {
  test("takes the label off the page; the label itself goes with its last use", async () => {
    const a = await newPage("Remove A");
    const b = await newPage("Remove B");
    const [both, onlyA] = data(await addLabels(owner, a.id, ["on-both", "only-on-a"]));
    data(await addLabels(owner, b.id, ["on-both"]));
    const res = await writer.client.post(`/pages/${a.slugId}/labels/remove`, { labelId: both.id.toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: {} });
    expect(data(await owner.get(`/pages/${a.id}/labels`))).toEqual([onlyA]);
    // Still on B, so the label lives on with its id.
    expect(data(await owner.get(`/pages/${b.id}/labels`))).toEqual([both]);
    expect(data(await addLabels(owner, a.id, ["on-both"])).find((l: any) => l.name === "on-both")).toEqual(both);
    // Removing the last use deletes the label: adding the name again makes a new one.
    expect(data(await owner.post(`/pages/${a.id}/labels/remove`, { labelId: onlyA.id }))).toEqual({});
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM labels WHERE id = ${onlyA.id}`;
    expect(n).toBe(0);
    const again = data(await addLabels(owner, a.id, ["only-on-a"])).find((l: any) => l.name === "only-on-a");
    expect(again.id).not.toBe(onlyA.id);
  });

  test("removing a label the page does not carry, or an unknown one, changes nothing", async () => {
    const a = await newPage("Carries it");
    const b = await newPage("Does not");
    const [label] = data(await addLabels(owner, a.id, ["elsewhere"]));
    expect(data(await owner.post(`/pages/${b.id}/labels/remove`, { labelId: label.id }))).toEqual({});
    expect(data(await owner.post(`/pages/${b.id}/labels/remove`, { labelId: NO_SUCH_ID }))).toEqual({});
    expect(data(await owner.get(`/pages/${a.id}/labels`))).toEqual([label]);
    for (const labelId of [undefined, null, "", "elsewhere", 5]) {
      expectInvalid(await owner.post(`/pages/${a.id}/labels/remove`, { labelId }), "labelId must be a valid id");
    }
  });

  test("a label outlives the permanent deletion of its pages, unseen, and is found again by name", async () => {
    const page = await newPage("Deleted for good");
    const [label] = data(await addLabels(owner, page.id, ["left-behind"]));
    data(await owner.post(`/pages/${page.id}/delete-permanently`));
    expect(names(await owner.get("/labels?query=left-behind"))).toEqual([]);
    const next = await newPage("Reuses it");
    expect(data(await addLabels(owner, next.id, ["Left Behind"]))).toEqual([label]);
  });

  test("needs a writer and a page that is not in the trash", async () => {
    const page = await newPage("Remove guard");
    const [label] = data(await addLabels(owner, page.id, ["guarded"]));
    expectForbidden(await reader.client.post(`/pages/${page.id}/labels/remove`, { labelId: label.id }));
    expectNotFound(await outsider.client.post(`/pages/${page.id}/labels/remove`, { labelId: label.id }), "Page");
    expectNotFound(await owner.post(`/pages/${NO_SUCH_ID}/labels/remove`, { labelId: label.id }), "Page");
    data(await owner.post(`/pages/${page.id}/delete`));
    expectNotFound(await owner.post(`/pages/${page.id}/labels/remove`, { labelId: label.id }), "Page");
    expect(data(await owner.get(`/pages/${page.id}/labels`))).toEqual([label]);
  });
});

describe("GET /labels and GET /labels/:id/pages", () => {
  let space: any;
  let hidden: any;
  let viewer: Person;
  let pages: Record<string, any>;
  let labels: Record<string, any>;

  beforeAll(async () => {
    space = await createSpace(owner, "Label space", "label-space");
    hidden = await createSpace(owner, "Label hidden", "label-hidden");
    viewer = await person(t, owner, "label-viewer@example.com", { space: space.id, spaceRole: "reader" });
    pages = {
      one: await newPage("One", space.id),
      two: await newPage("Two", space.id),
      three: await createPage(owner, { spaceId: space.id, title: "Three", icon: "3️⃣" }),
      trashed: await newPage("Trashed", space.id),
      secret: await newPage("Secret", hidden.id),
    };
    labels = {};
    const add = async (page: any, list: string[]) => {
      for (const label of data(await addLabels(owner, page.id, list))) labels[label.name] = label;
    };
    await add(pages.one, ["glv-common", "glv-pair", "glv-single", "glv-100%", "glv-a_b", "glv-axb", "glv-back\\slash"]);
    await add(pages.two, ["glv-common", "glv-pair", "glv-trash-and-live"]);
    await add(pages.three, ["glv-common"]);
    await add(pages.trashed, ["glv-common", "glv-trash-only", "glv-trash-and-live"]);
    await add(pages.secret, ["glv-common", "glv-secret-only"]);
    data(await owner.post(`/pages/${pages.trashed.id}/delete`));
    for (const [i, key] of ["one", "two", "three", "secret"].entries()) {
      await t.sql`UPDATE pages SET updated_at = ${`2025-04-0${i + 1}T12:00:00Z`}::timestamptz WHERE id = ${pages[key].id}`;
    }
  });

  const listed = async (client: Client, query = "") => (data(await client.get(`/labels${query}`)) as any[]).filter((l) => l.name.startsWith("glv-"));

  test("lists labels with the number of pages the user can read, most used first, then by name", async () => {
    const res = await viewer.client.get("/labels");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        { id: labels["glv-common"].id, name: "glv-common", pageCount: 3 },
        { id: labels["glv-pair"].id, name: "glv-pair", pageCount: 2 },
        { id: labels["glv-100%"].id, name: "glv-100%", pageCount: 1 },
        { id: labels["glv-a_b"].id, name: "glv-a_b", pageCount: 1 },
        { id: labels["glv-axb"].id, name: "glv-axb", pageCount: 1 },
        { id: labels["glv-back\\slash"].id, name: "glv-back\\slash", pageCount: 1 },
        { id: labels["glv-single"].id, name: "glv-single", pageCount: 1 },
        { id: labels["glv-trash-and-live"].id, name: "glv-trash-and-live", pageCount: 1 },
      ],
    });
    // The owner also reads the hidden space; labels only on trashed pages are not listed for anyone.
    const forOwner = await listed(owner);
    expect(forOwner.slice(0, 2).map((l) => [l.name, l.pageCount])).toEqual([["glv-common", 4], ["glv-pair", 2]]);
    expect(forOwner.map((l) => l.name)).toContain("glv-secret-only");
    expect(forOwner.map((l) => l.name)).not.toContain("glv-trash-only");
    expect(await listed(outsider.client)).toEqual([]);
  });

  test("query filters by the normalised text anywhere in the name, with %, _ and \\ taken literally", async () => {
    const q = async (query: string) => (await listed(viewer.client, `?query=${encodeURIComponent(query)}`)).map((l) => l.name);
    expect(await q("glv-pair")).toEqual(["glv-pair"]);
    expect(await q("PAIR")).toEqual(["glv-pair"]);
    expect(await q("  Trash And  ")).toEqual(["glv-trash-and-live"]);
    expect(await q("v-s")).toEqual(["glv-single"]);
    expect(await q("glv-a")).toEqual(["glv-a_b", "glv-axb"]);
    expect(await q("%")).toEqual(["glv-100%"]);
    expect(await q("_")).toEqual(["glv-a_b"]);
    expect(await q("a_b")).toEqual(["glv-a_b"]);
    expect(await q("\\")).toEqual(["glv-back\\slash"]);
    expect(await q("glv-nothing")).toEqual([]);
    // An empty query, or one that normalises to nothing, lists everything.
    expect(await q("")).toHaveLength(8);
    expect(await q("   ")).toHaveLength(8);
    expect(await q("---")).toHaveLength(8);
    expect(await q("x".repeat(100))).toEqual([]);
    expectInvalid(await viewer.client.get(`/labels?query=${"x".repeat(101)}`), "query must be at most 100 characters");
  });

  test("the pages of a label: those the user can read, latest update first", async () => {
    const res = await viewer.client.get(`/labels/${labels["glv-common"].id}/pages`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        { ...treeItem(pages.three), space: spaceRef(space) },
        { ...treeItem(pages.two), space: spaceRef(space) },
        { ...treeItem(pages.one), space: spaceRef(space) },
      ],
    });
    const forOwner = data(await owner.get(`/labels/${labels["glv-common"].id.toUpperCase()}/pages`));
    expect(forOwner.map((p: any) => p.title)).toEqual(["Secret", "Three", "Two", "One"]);
    expect(forOwner[0].space).toEqual(spaceRef(hidden));
    expect(data(await viewer.client.get(`/labels/${labels["glv-secret-only"].id}/pages`))).toEqual([]);
    expect(data(await owner.get(`/labels/${labels["glv-trash-only"].id}/pages`))).toEqual([]);
    expect(data(await outsider.client.get(`/labels/${labels["glv-common"].id}/pages`))).toEqual([]);
    // An id that names no label is an empty list; something that is not an id is 404.
    expect(data(await owner.get(`/labels/${NO_SUCH_ID}/pages`))).toEqual([]);
    expectNotFound(await owner.get("/labels/glv-common/pages"), "Label");
    expectNotFound(await owner.get("/labels/123/pages"), "Label");
  });

  test("restoring a page brings its labels back into the counts", async () => {
    data(await owner.post(`/pages/${pages.trashed.id}/restore`));
    const forViewer = await listed(viewer.client);
    expect(forViewer.find((l) => l.name === "glv-common").pageCount).toBe(4);
    expect(forViewer.find((l) => l.name === "glv-trash-and-live").pageCount).toBe(2);
    expect(forViewer.find((l) => l.name === "glv-trash-only")).toEqual({ id: labels["glv-trash-only"].id, name: "glv-trash-only", pageCount: 1 });
    data(await owner.post(`/pages/${pages.trashed.id}/delete`));
  });

  test("at most 200 labels are listed", async () => {
    const page = await newPage("Many labels", space.id);
    for (let batch = 0; batch < 9; batch++) {
      data(await addLabels(owner, page.id, Array.from({ length: 25 }, (_, i) => `bulk-${String(batch * 25 + i).padStart(3, "0")}`)));
    }
    expect(data(await owner.get(`/pages/${page.id}/labels`))).toHaveLength(225);
    const all = data(await viewer.client.get("/labels"));
    expect(all).toHaveLength(200);
    // The most used come first, so the cut falls among the labels used once, in name order.
    expect(all.slice(0, 2).map((l: any) => l.name)).toEqual(["glv-common", "glv-pair"]);
    expect(all.at(-1).name).toBe("bulk-197");
    expect(data(await viewer.client.get("/labels?query=bulk-2"))).toHaveLength(25);
  });
});
