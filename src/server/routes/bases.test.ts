import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Base, Property, Row } from "common/bases";
import { startTestServer, type Client, type TestContext } from "server/test-helpers";

let t: TestContext;
let owner: Client;
let spaceId: string;

beforeAll(async () => {
  t = await startTestServer();
  ({ owner, spaceId } = await t.setupOwner());
});

afterAll(async () => {
  await t.close();
});

const createBase = async (template: "table" | "kanban" = "table") => {
  const res = await owner.post("/bases", { spaceId, title: "Tasks", template });
  expect(res.status).toBe(200);
  const base = (await owner.get(`/bases/${res.body.data.page.id}`)).body.data as Base;
  return base;
};

const addProperty = async (base: Base, name: string, type: string, options?: unknown) => {
  const res = await owner.post(`/bases/${base.id}/properties`, { name, type, options });
  expect(res.status).toBe(200);
  return res.body.data as Property;
};

const addRow = async (base: Base, cells: Record<string, unknown>) => {
  const res = await owner.post(`/bases/${base.id}/rows`, { cells });
  expect(res.status).toBe(200);
  return res.body.data as Row;
};

const query = async (base: Base, body: Record<string, unknown> = {}) => {
  const res = await owner.post(`/bases/${base.id}/rows/query`, body);
  expect(res.status).toBe(200);
  return res.body.data as { items: Row[]; nextCursor: string | null };
};

describe("bases", () => {
  test("a new base is a page with seeded properties, a row and a view", async () => {
    const base = await createBase("kanban");
    expect(base.properties.map((p) => [p.name, p.type, p.isPrimary])).toEqual([
      ["Title", "text", true],
      ["Text 1", "text", false],
      ["Text 2", "text", false],
      ["Status", "status", false],
    ]);
    expect(base.views.map((v) => v.type)).toEqual(["kanban", "table"]);
    expect(base.views[0]!.config.groupByPropertyId).toBe(base.properties[3]!.id);
    expect((await query(base)).items).toHaveLength(1);
    const tree = await owner.get(`/spaces/${spaceId}/pages`);
    expect(tree.body.data.find((p: { id: string }) => p.id === base.id)?.isBase).toBe(true);
  });

  test("cells are validated and normalized", async () => {
    const base = await createBase();
    const num = await addProperty(base, "Amount", "number");
    const pick = await addProperty(base, "Tag", "multiSelect", {
      choices: [
        { id: "a", name: "A", color: "red" },
        { id: "b", name: "B", color: "blue" },
      ],
    });
    const row = await addRow(base, { [num.id]: "12.5", [pick.id]: ["a", "a", "b"] });
    expect(row.cells).toEqual({ [num.id]: 12.5, [pick.id]: ["a", "b"] });
    const bad = await owner.post(`/bases/${base.id}/rows`, { cells: { [pick.id]: ["zzz"] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.message).toBe('Invalid value for "Tag": unknown option');
    const cleared = await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { cells: { [num.id]: null } });
    expect(cleared.body.data.cells).toEqual({ [pick.id]: ["a", "b"] });
  });

  test("filters and sorts run on the server", async () => {
    const base = await createBase();
    const title = base.properties[0]!;
    const num = await addProperty(base, "Score", "number");
    const done = await addProperty(base, "Done", "checkbox");
    const due = await addProperty(base, "Due", "date");
    await addRow(base, { [title.id]: "apple", [num.id]: 3, [done.id]: true, [due.id]: "2026-01-10" });
    await addRow(base, { [title.id]: "banana", [num.id]: 1, [due.id]: "2026-02-10" });
    await addRow(base, { [title.id]: "cherry", [num.id]: 2 });
    const names = (rows: Row[]) => rows.map((r) => r.cells[title.id] ?? null);

    expect(names((await query(base, { sorts: [{ propertyId: num.id, direction: "desc" }] })).items)).toEqual(["apple", "cherry", "banana", null]);
    expect(names((await query(base, { filter: { op: "and", children: [{ propertyId: num.id, op: "gte", value: 2 }] } })).items)).toEqual(["apple", "cherry"]);
    expect(names((await query(base, { filter: { op: "and", children: [{ propertyId: done.id, op: "eq", value: false }] } })).items)).toEqual([null, "banana", "cherry"]);
    expect(names((await query(base, { filter: { op: "and", children: [{ propertyId: title.id, op: "contains", value: "AN" }] } })).items)).toEqual(["banana"]);
    expect(
      names((await query(base, { filter: { op: "and", children: [{ propertyId: due.id, op: "before", value: { mode: "exact", date: "2026-02-01" } }] } })).items),
    ).toEqual(["apple"]);
    expect(
      names(
        (
          await query(base, {
            filter: { op: "or", children: [{ propertyId: num.id, op: "eq", value: 1 }, { op: "and", children: [{ propertyId: title.id, op: "eq", value: "cherry" }] }] },
          })
        ).items,
      ),
    ).toEqual(["banana", "cherry"]);
    const invalid = await owner.post(`/bases/${base.id}/rows/query`, { filter: { op: "and", children: [{ propertyId: done.id, op: "contains", value: "x" }] } });
    expect(invalid.status).toBe(400);
  });

  test("pagination covers every row once", async () => {
    const base = await createBase();
    const title = base.properties[0]!;
    for (let i = 0; i < 7; i++) await addRow(base, { [title.id]: `r${i}` });
    for (const sorts of [undefined, [{ propertyId: title.id, direction: "asc" }]]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: Row[]; nextCursor: string | null } = await query(base, { limit: 3, cursor: cursor ?? undefined, sorts });
        seen.push(...page.items.map((r) => r.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(8);
      expect(new Set(seen).size).toBe(8);
    }
  });

  test("formulas are computed on write and recomputed when inputs change", async () => {
    const base = await createBase();
    const price = await addProperty(base, "Price", "number");
    const qty = await addProperty(base, "Qty", "number");
    const row = await addRow(base, { [price.id]: 2.5, [qty.id]: 4 });
    const total = await addProperty(base, "Total", "formula", { source: 'prop("Price") * prop("Qty")' });
    expect(total.options.resultType).toBe("number");
    expect(total.options.dependencies).toEqual([price.id, qty.id]);
    const label = await addProperty(base, "Label", "formula", { source: 'IF(prop("Total") > 5, "big", "small")' });

    let fetched = (await owner.get(`/bases/${base.id}/rows/${row.id}`)).body.data.row as Row;
    expect(fetched.cells[total.id]).toBe(10);
    expect(fetched.cells[label.id]).toBe("big");

    const updated = (await owner.post(`/bases/${base.id}/rows/${row.id}/update`, { cells: { [qty.id]: 1 } })).body.data as Row;
    expect(updated.cells[total.id]).toBe(2.5);
    expect(updated.cells[label.id]).toBe("small");

    // Renaming an input keeps the formula source readable.
    await owner.post(`/bases/${base.id}/properties/${price.id}/update`, { name: "Unit price" });
    const after = (await owner.get(`/bases/${base.id}`)).body.data as Base;
    expect(after.properties.find((p) => p.id === total.id)!.options.source).toBe('prop("Unit price") * prop("Qty")');

    // Deleting an input turns dependents into error values.
    await owner.post(`/bases/${base.id}/properties/${qty.id}/delete`);
    fetched = (await owner.get(`/bases/${base.id}/rows/${row.id}`)).body.data.row as Row;
    expect(fetched.cells[total.id]).toMatchObject({ error: "MISSING_PROP" });
    expect(fetched.cells[qty.id]).toBeUndefined();

    const bad = await owner.post(`/bases/${base.id}/properties`, { name: "Bad", type: "formula", options: { source: 'prop("Name") +' } });
    expect(bad.status).toBe(400);
  });

  test("changing a property type converts cells", async () => {
    const base = await createBase();
    const text = await addProperty(base, "Count", "text");
    const a = await addRow(base, { [text.id]: "1,234" });
    const b = await addRow(base, { [text.id]: "many" });
    const res = await owner.post(`/bases/${base.id}/properties/${text.id}/update`, { type: "number" });
    expect(res.status).toBe(200);
    const rows = (await query(base)).items;
    expect(rows.find((r) => r.id === a.id)!.cells[text.id]).toBe(1234);
    expect(rows.find((r) => r.id === b.id)!.cells[text.id]).toBeUndefined();
    const primary = await owner.post(`/bases/${base.id}/properties/${base.properties[0]!.id}/update`, { type: "number" });
    expect(primary.status).toBe(400);
  });

  test("property names are unique per base", async () => {
    const base = await createBase();
    const dup = await owner.post(`/bases/${base.id}/properties`, { name: " text 1 ", type: "number" });
    expect(dup.status).toBe(400);
    expect(dup.body.error?.message).toBe("A property with this name already exists");
  });

  test("views: create, patch config, keep at least one", async () => {
    const base = await createBase();
    const created = await owner.post(`/bases/${base.id}/views`, { name: "Board", type: "kanban" });
    const view = created.body.data;
    const patched = await owner.post(`/bases/${base.id}/views/${view.id}/update`, {
      config: { hiddenPropertyIds: [base.properties[1]!.id], sorts: [{ propertyId: base.properties[0]!.id, direction: "asc" }] },
    });
    expect(patched.body.data.config.hiddenPropertyIds).toEqual([base.properties[1]!.id]);
    const cleared = await owner.post(`/bases/${base.id}/views/${view.id}/update`, { config: { sorts: null } });
    expect(cleared.body.data.config).toEqual({ hiddenPropertyIds: [base.properties[1]!.id] });
    expect((await owner.post(`/bases/${base.id}/views/${view.id}/delete`)).status).toBe(200);
    const last = await owner.post(`/bases/${base.id}/views/${base.views[0]!.id}/delete`);
    expect(last.status).toBe(400);
  });

  test("deleting a property removes it from view filters", async () => {
    const base = await createBase();
    const num = await addProperty(base, "N", "number");
    await owner.post(`/bases/${base.id}/views/${base.views[0]!.id}/update`, {
      config: { filter: { op: "and", children: [{ propertyId: num.id, op: "gt", value: 1 }] }, sorts: [{ propertyId: num.id, direction: "asc" }] },
    });
    await owner.post(`/bases/${base.id}/properties/${num.id}/delete`);
    const view = ((await owner.get(`/bases/${base.id}`)).body.data as Base).views[0]!;
    expect(view.config.filter).toEqual({ op: "and", children: [] });
    expect(view.config.sorts).toEqual([]);
  });

  test("rows can be deleted in bulk and exported as CSV", async () => {
    const base = await createBase();
    const title = base.properties[0]!;
    const tag = await addProperty(base, "Tag", "select", { choices: [{ id: "x", name: "Red, hot", color: "red" }] });
    const a = await addRow(base, { [title.id]: 'say "hi"', [tag.id]: "x" });
    const csv = await owner.raw("GET", `/bases/${base.id}/export.csv`);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const bytes = new Uint8Array(await csv.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("Title,Text 1,Text 2,Tag\r\n")).toBe(true);
    expect(text).toContain('"say ""hi""",,,"Red, hot"\r\n');
    await addRow(base, { [title.id]: '=HYPERLINK("http://x")' });
    await addRow(base, { [title.id]: "-5" });
    const again = await (await owner.raw("GET", `/bases/${base.id}/export.csv`)).text();
    expect(again).toContain(`"'=HYPERLINK(""http://x"")",,,\r\n`);
    expect(again).toContain("-5,,,\r\n");
    const del = await owner.post(`/bases/${base.id}/rows/delete`, { rowIds: [a.id] });
    expect(del.body.data.rowIds).toEqual([a.id]);
    expect((await query(base)).items).toHaveLength(3);
  });

  test("readers can view but not edit", async () => {
    const base = await createBase();
    const { client: reader, user } = await t.addMember(owner, "base-reader@example.com");
    await owner.post(`/spaces/${spaceId}/members/add`, { role: "reader", userIds: [user.id] });
    const seen = await reader.get(`/bases/${base.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.canEdit).toBe(false);
    expect((await reader.post(`/bases/${base.id}/rows/query`, {})).status).toBe(200);
    expect((await reader.post(`/bases/${base.id}/rows`, { cells: {} })).status).toBe(403);
    const outsider = (await t.addMember(owner, "base-outsider@example.com")).client;
    expect((await outsider.get(`/bases/${base.id}`)).status).toBe(404);
  });

  test("a page can be converted into a base", async () => {
    const page = (await owner.post("/pages", { spaceId, title: "Later a base" })).body.data.page;
    const res = await owner.post(`/pages/${page.id}/convert-to-base`, { template: "kanban" });
    expect(res.status).toBe(200);
    expect(res.body.data.views).toHaveLength(2);
    expect((await owner.post(`/pages/${page.id}/convert-to-base`, {})).status).toBe(400);
    expect((await owner.get(`/bases/${page.slugId}`)).status).toBe(200);
  });

  test("duplicating a base copies its properties, rows and views", async () => {
    const base = await createBase();
    const title = base.properties[0]!;
    const files = await addProperty(base, "Files", "file");
    const up = (await owner.uploadFile(new File(["attached"], "a.txt", { type: "text/plain" }), base.id)).body.data;
    await addRow(base, { [title.id]: "copied row", [files.id]: [{ id: up.id, fileName: up.name, url: up.url }] });
    const res = await owner.post(`/pages/${base.id}/duplicate`, {});
    expect(res.status).toBe(200);
    const copy = (await owner.get(`/bases/${res.body.data.page.id}`)).body.data as Base;
    expect(copy.properties.map((p) => p.id)).toEqual([...base.properties.map((p) => p.id), files.id]);
    expect(copy.views).toHaveLength(1);
    const rows = (await query(copy)).items;
    expect(rows.map((r) => r.cells[title.id] ?? null)).toEqual([null, "copied row"]);
    const [copied] = rows[1]!.cells[files.id] as { id: string; url: string }[];
    expect(copied!.id).not.toBe(up.id);
    expect(copied!.url).toContain(copied!.id);
    // The copy survives the original being deleted.
    await owner.post(`/pages/${base.id}/delete-permanently`);
    const res2 = await owner.raw("GET", copied!.url.replace("/api", ""));
    expect(await res2.text()).toBe("attached");
  });

  test("a base exports as a Markdown table", async () => {
    const base = await createBase();
    const title = base.properties[0]!;
    await addRow(base, { [title.id]: "a | b" });
    const res = await owner.raw("GET", `/pages/${base.id}/export?format=markdown`);
    expect(await res.text()).toBe("# Tasks\n\n| Title | Text 1 | Text 2 |\n| --- | --- | --- |\n|  |  |  |\n| a \\| b |  |  |\n");
  });

  test("a published base shows its rows to anonymous visitors", async () => {
    const base = await createBase();
    const title = base.properties[0]!;
    await addRow(base, { [title.id]: "public row" });
    const share = await owner.post(`/pages/${base.id}/share`, {});
    const res = await t.client().get(`/public/shares/${share.body.data.share.key}`);
    expect(res.status).toBe(200);
    expect(res.body.data.page.base.properties.map((p: Property) => p.name)).toEqual(["Title", "Text 1", "Text 2"]);
    expect(res.body.data.page.base.rows.map((r: Row) => r.cells[title.id] ?? null)).toEqual([null, "public row"]);
  });

  test("a date-only cell is the viewer's local day in filters", async () => {
    const base = await createBase();
    const title = base.properties[0]!;
    const day = await addProperty(base, "Day", "date");
    // The viewer is at UTC-7 and it is 2026-10-25 17:30 there (00:30 UTC on the 26th).
    const now = Date.parse("2026-10-26T00:30:00Z");
    const { setSystemTime } = await import("bun:test");
    setSystemTime(new Date(now));
    try {
      await addRow(base, { [title.id]: "today", [day.id]: "2026-10-25" });
      await addRow(base, { [title.id]: "tomorrow", [day.id]: "2026-10-26" });
      const names = async (filter: unknown) =>
        ((await owner.post(`/bases/${base.id}/rows/query`, { filter, tzOffset: -420 })).body.data.items as Row[]).map((r) => r.cells[title.id] ?? null).filter(Boolean);
      expect(await names({ op: "and", children: [{ propertyId: day.id, op: "eq", value: { mode: "relative", preset: "today" } }] })).toEqual(["today"]);
      expect(await names({ op: "and", children: [{ propertyId: day.id, op: "before", value: { mode: "relative", preset: "today" } }] })).toEqual([]);
      expect(await names({ op: "and", children: [{ propertyId: day.id, op: "eq", value: { mode: "exact", date: "2026-10-26" } }] })).toEqual(["tomorrow"]);
    } finally {
      setSystemTime();
    }
  });

  test("choices sort by option order and people by name", async () => {
    const base = await createBase();
    const title = base.properties[0]!;
    const sel = await addProperty(base, "Stage", "select", {
      choices: [
        { id: "zz", name: "First", color: "red" },
        { id: "aa", name: "Second", color: "blue" },
        { id: "mm", name: "Third", color: "green" },
      ],
      choiceOrder: ["zz", "aa", "mm"],
    });
    await addRow(base, { [title.id]: "r3", [sel.id]: "mm" });
    await addRow(base, { [title.id]: "r1", [sel.id]: "zz" });
    await addRow(base, { [title.id]: "r2", [sel.id]: "aa" });
    const rows = (await query(base, { sorts: [{ propertyId: sel.id, direction: "asc" }] })).items;
    expect(rows.map((r) => r.cells[title.id] ?? null)).toEqual(["r1", "r2", "r3", null]);

    // Name the users against their id order so an id sort cannot pass.
    const [low, high] = [await t.addMember(owner, "sort-a@example.com"), await t.addMember(owner, "sort-b@example.com")].sort((x, y) =>
      x.user.id < y.user.id ? -1 : 1,
    ) as [Awaited<ReturnType<TestContext["addMember"]>>, Awaited<ReturnType<TestContext["addMember"]>>];
    expect((await low.client.post("/me/update", { name: "Zoe" })).status).toBe(200);
    expect((await high.client.post("/me/update", { name: "amy" })).status).toBe(200);
    const people = await createBase();
    const name = people.properties[0]!;
    const person = await addProperty(people, "Who", "person");
    await addRow(people, { [name.id]: "zoe", [person.id]: low.user.id });
    await addRow(people, { [name.id]: "amy", [person.id]: high.user.id });
    await addRow(people, { [name.id]: "nobody", [person.id]: "not-a-uuid" });
    const byPerson = (await query(people, { sorts: [{ propertyId: person.id, direction: "asc" }] })).items;
    expect(byPerson.map((r) => r.cells[name.id] ?? null)).toEqual(["amy", "zoe", null, "nobody"]);
  });

  test("converting a select to text keeps the option names", async () => {
    const base = await createBase();
    const sel = await addProperty(base, "Pick", "select", { choices: [{ id: "c1", name: "Beta", color: "blue" }] });
    const row = await addRow(base, { [sel.id]: "c1" });
    await owner.post(`/bases/${base.id}/properties/${sel.id}/update`, { type: "text" });
    const after = (await query(base)).items.find((r) => r.id === row.id)!;
    expect(after.cells[sel.id]).toBe("Beta");
  });
});
