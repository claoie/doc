import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Client, type TestServer } from "./harness";
import { addProperty, addRow, createBase, emptyBase, expectError, getRow, ok, updateRow } from "./harness/base-fixtures";

let t: TestServer;
let owner: Client;
let ownerId: string;
let spaceId: string;
let reader: Client;
let readerId: string;

beforeAll(async () => {
  t = await startServer();
  let user: { id: string };
  ({ owner, user, spaceId } = await t.setupOwner());
  ownerId = user.id;
  const member = await t.addMember(owner, "reader@example.com");
  ok(await owner.post(`/spaces/${spaceId}/members/add`, { role: "reader", userIds: [member.user.id] }));
  reader = member.client;
  readerId = member.user.id;
});

afterAll(async () => {
  await t.close();
});

const BOM = "\uFEFF";

/** Downloads the export; `text` is the body decoded without dropping the byte order mark. */
const exportCsv = async (client: Client, ref: string) => {
  const res = await client.raw("GET", `/bases/${ref}/export.csv`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) };
};

/** The lines of the export after the header, without their line ends. */
const dataLines = async (baseId: string) => {
  const { text } = await exportCsv(owner, baseId);
  expect(text.endsWith("\r\n")).toBe(true);
  return text.slice(0, -2).split("\r\n").slice(1);
};

/** A base whose only column is the title, holding `values` as rows. */
const titles = async (values: string[]) => {
  const base = await createBase(owner, spaceId, { title: "Cells" });
  await emptyBase(owner, base.id);
  for (const p of base.properties.slice(1)) ok(await owner.post(`/bases/${base.id}/properties/${p.id}/delete`, {}));
  for (const value of values) await addRow(owner, base.id, { [base.properties[0]!.id]: value });
  return base;
};

describe("GET /bases/:id/export.csv", () => {
  test("answers with the base as a CSV attachment: a byte order mark, a header line, CRLF line ends", async () => {
    const base = await createBase(owner, spaceId, { title: "Tasks" });
    const [title, text1] = base.properties;
    await addRow(owner, base.id, { [title!.id]: "First", [text1!.id]: "one" });
    const res = await exportCsv(reader, base.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="Tasks.csv"; filename*=UTF-8''Tasks.csv`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect([...res.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.text).toBe(`${BOM}Title,Text 1,Text 2\r\n,,\r\nFirst,one,\r\n`);
    expect((await exportCsv(owner, base.slugId)).text).toBe(res.text);
    expect((await exportCsv(owner, base.id.toUpperCase())).text).toBe(res.text);
  });

  test("a base without rows exports its header only", async () => {
    const base = await createBase(owner, spaceId);
    await emptyBase(owner, base.id);
    expect((await exportCsv(owner, base.id)).text).toBe(`${BOM}Title,Text 1,Text 2\r\n`);
  });

  test("the columns follow the order of the properties and the rows the order of their positions", async () => {
    const base = await createBase(owner, spaceId);
    await emptyBase(owner, base.id);
    const [title, text1, text2] = base.properties;
    const amount = await addProperty(owner, base.id, "Amount", "number");
    await addRow(owner, base.id, { [title!.id]: "b", [text1!.id]: "1", [text2!.id]: "2", [amount.id]: 3 });
    const a = await addRow(owner, base.id, { [title!.id]: "a" }, { position: "Zz" });
    await addRow(owner, base.id, { [title!.id]: "c", [amount.id]: -4 });
    ok(await owner.post(`/bases/${base.id}/properties/${amount.id}/update`, { position: "Zz", name: "Sum" }));
    ok(await owner.post(`/bases/${base.id}/properties/${text1!.id}/delete`, {}));
    expect((await exportCsv(owner, base.id)).text).toBe(`${BOM}Sum,Title,Text 2\r\n,a,\r\n3,b,2\r\n-4,c,\r\n`);
    await updateRow(owner, base.id, a.id, {}, { position: "z" });
    expect(await dataLines(base.id)).toEqual(["3,b,2", "-4,c,", ",a,"]);
  });

  describe("the file name", () => {
    const disposition = async (title: string | null) => {
      const base = await createBase(owner, spaceId, { title });
      return (await exportCsv(owner, base.id)).headers.get("content-disposition");
    };

    test("is the title with .csv; an untitled base is \"Untitled base\"", async () => {
      expect(await disposition(null)).toBe(`attachment; filename="Untitled base.csv"; filename*=UTF-8''Untitled%20base.csv`);
      expect(await disposition("Plan 2026")).toBe(`attachment; filename="Plan 2026.csv"; filename*=UTF-8''Plan%202026.csv`);
      expect(await disposition("it's (a) ~test!*")).toBe(`attachment; filename="it's (a) ~test!_.csv"; filename*=UTF-8''it's%20(a)%20~test!_.csv`);
    });

    test("characters a file name cannot have become underscores", async () => {
      expect(await disposition('a/b\\c:d*e?f"g<h>i|j')).toBe(`attachment; filename="a_b_c_d_e_f_g_h_i_j.csv"; filename*=UTF-8''a_b_c_d_e_f_g_h_i_j.csv`);
      expect(await disposition("tab\there\u0001x")).toBe(`attachment; filename="tab_here_x.csv"; filename*=UTF-8''tab_here_x.csv`);
      expect(await disposition("50%; done & more = #1")).toBe(`attachment; filename="50%; done & more = #1.csv"; filename*=UTF-8''50%25%3B%20done%20%26%20more%20%3D%20%231.csv`);
    });

    test("the plain form replaces what is not printable ASCII, one underscore per UTF-16 unit; the encoded form keeps the title", async () => {
      expect(await disposition("Résumé 日本語 😀")).toBe(
        `attachment; filename="R_sum_ ___ __.csv"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%E6%97%A5%E6%9C%AC%E8%AA%9E%20%F0%9F%98%80.csv`,
      );
    });

    test("is cut to 150 UTF-16 units before the extension", async () => {
      expect(await disposition("x".repeat(200))).toBe(`attachment; filename="${"x".repeat(150)}.csv"; filename*=UTF-8''${"x".repeat(150)}.csv`);
      expect(await disposition(`${"x".repeat(148)}😀y`)).toBe(`attachment; filename="${"x".repeat(148)}__.csv"; filename*=UTF-8''${"x".repeat(148)}%F0%9F%98%80.csv`);
    });

    test("a title whose 150th unit is the first half of an emoji fails the export", async () => {
      const base = await createBase(owner, spaceId, { title: `${"x".repeat(149)}😀` });
      const res = await owner.get(`/bases/${base.id}/export.csv`);
      // Accident: the cut leaves half a character, which cannot be encoded for the header.
      expectError(res, 500, "internal_error", "Something went wrong");
    });
  });

  test("fields with a quote, a comma, a carriage return or a line feed are quoted, with quotes doubled", async () => {
    const base = await titles(['say "hi"', "a,b", "line1\nline2", "cr\rhere", "both\r\nends", '"', '""', ",", "plain text; with: other | punctuation'", " padded ", "tab\tinside"]);
    expect(await exportCsv(owner, base.id).then((r) => r.text)).toBe(
      `${BOM}Title\r\n` +
        '"say ""hi"""\r\n' +
        '"a,b"\r\n' +
        '"line1\nline2"\r\n' +
        '"cr\rhere"\r\n' +
        '"both\r\nends"\r\n' +
        '""""\r\n' +
        '""""""\r\n' +
        '","\r\n' +
        "plain text; with: other | punctuation'\r\n" +
        " padded \r\n" +
        "tab\tinside\r\n",
    );
  });

  test("fields a spreadsheet would run as a formula get a leading apostrophe; plain negative numbers do not", async () => {
    const values = ["=1+1", '=HYPERLINK("http://x")', "+5", "+a", "-5", "-5.5", "-0", "-5e3", "-.5", "-5.", "-", "--5", "-a", "@SUM(A1)", "\tx", "\rx", "=a,b", " =1+1", "5-", "a=b", "'=1"];
    const base = await titles(values);
    expect(await dataLines(base.id)).toEqual([
      "'=1+1",
      `"'=HYPERLINK(""http://x"")"`,
      "'+5",
      "'+a",
      "-5",
      "-5.5",
      "-0",
      "'-5e3",
      "'-.5",
      "'-5.",
      "'-",
      "'--5",
      "'-a",
      "'@SUM(A1)",
      "'\tx",
      `"'\rx"`,
      `"'=a,b"`,
      " =1+1",
      "5-",
      "a=b",
      "'=1",
    ]);
  });

  test("the header line is quoted and guarded like any other", async () => {
    const base = await createBase(owner, spaceId);
    await emptyBase(owner, base.id);
    const [title, text1, text2] = base.properties;
    ok(await owner.post(`/bases/${base.id}/properties/${title!.id}/update`, { name: "=cmd" }));
    ok(await owner.post(`/bases/${base.id}/properties/${text1!.id}/update`, { name: 'A, "B"' }));
    ok(await owner.post(`/bases/${base.id}/properties/${text2!.id}/update`, { name: "日本語 😀" }));
    await addProperty(owner, base.id, "-1", "number");
    expect((await exportCsv(owner, base.id)).text).toBe(`${BOM}'=cmd,"A, ""B""",日本語 😀,-1\r\n`);
  });

  test("numbers are written without float noise; a negative number in exponent form gets the apostrophe", async () => {
    const base = await createBase(owner, spaceId);
    await emptyBase(owner, base.id);
    for (const p of base.properties.slice(1)) ok(await owner.post(`/bases/${base.id}/properties/${p.id}/delete`, {}));
    const n = await addProperty(owner, base.id, "N", "number");
    for (const value of [0, 3, -2.5, 0.1 + 0.2, 1 / 3, 1234567.891, 1e21, 123456789012345680000, 1e-7, 0.000001, -0.5]) await addRow(owner, base.id, { [n.id]: value });
    await addRow(owner, base.id, { [n.id]: -1e21 });
    expect(await dataLines(base.id)).toEqual([
      ",0",
      ",3",
      ",-2.5",
      ",0.3",
      ",0.333333333333333",
      ",1234567.891",
      ",1e+21",
      ",123456789012345680000",
      ",1e-7",
      ",0.000001",
      ",-0.5",
      // Accident: "-1e+21" does not look like a plain number to the guard.
      ",'-1e+21",
    ]);
  });

  test("every type of property has a text form", async () => {
    const base = await createBase(owner, spaceId, { title: "All types" });
    await emptyBase(owner, base.id);
    const title = base.properties[0]!.id;
    for (const p of base.properties.slice(1)) ok(await owner.post(`/bases/${base.id}/properties/${p.id}/delete`, {}));
    const choices = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta, the second" }, { id: "c", name: "" }];
    const add = async (name: string, type: string, options?: unknown) => (await addProperty(owner, base.id, name, type, options)).id;
    const long = await add("Long", "longText");
    const number = await add("Number", "number");
    const select = await add("Select", "select", { choices });
    const status = await add("Status", "status", { choices });
    const multi = await add("Multi", "multiSelect", { choices });
    const date = await add("Date", "date");
    const person = await add("Person", "person");
    const people = await add("People", "person", { allowMultiple: true });
    const file = await add("File", "file");
    const page = await add("Page", "page");
    const checkbox = await add("Checkbox", "checkbox");
    const url = await add("Url", "url");
    const email = await add("Email", "email");
    await add("Created", "createdAt");
    await add("Edited", "lastEditedAt");
    await add("Editor", "lastEditedBy");
    const fNumber = await add("F number", "formula", { source: 'prop("Number") / 3' });
    await add("F text", "formula", { source: 'prop("Title") & "!"' });
    await add("F flag", "formula", { source: 'prop("Checkbox")' });
    await add("F date", "formula", { source: 'DATEADD(prop("Date"), 1, "day")' });
    await add("F empty", "formula", { source: 'prop("Select")' });
    const target = ok(await owner.post("/pages", { spaceId, title: "Target, the page" })).page;
    const untitled = ok(await owner.post("/pages", { spaceId })).page;
    const secretSpace = ok(await owner.post("/spaces", { name: "Secret", slug: "secret" })).space.id;
    const secret = ok(await owner.post("/pages", { spaceId: secretSpace, title: "Secret" })).page;
    const full = await addRow(owner, base.id, {
      [title]: "Full",
      [long]: "two\nlines",
      [number]: 1,
      [select]: "a",
      [status]: "b",
      [multi]: ["b", "a", "c"],
      [date]: "2026-03-05",
      [person]: readerId,
      [people]: [ownerId, "00000000-0000-4000-8000-000000000000", readerId, "not-a-user"],
      [file]: [{ id: "f1", fileName: "a.txt" }, { id: "f2", fileName: "" }, { id: "f3", fileName: "b, c.png" }],
      [page]: target.id,
      [checkbox]: true,
      [url]: "https://example.com/?a=1,2",
      [email]: "a@b.co",
    });
    const sparse = await addRow(owner, base.id, { [title]: "Sparse", [number]: 0, [select]: "c", [date]: "March 5, 2026", [people]: ["nobody"], [page]: untitled.id, [checkbox]: false });
    const hidden = await addRow(owner, base.id, { [title]: "Hidden", [page]: secret.id, [person]: "not-a-user", [date]: "2026-03-05T10:20:30Z" });
    const empty = await addRow(owner, base.id, {});
    const text = (await exportCsv(owner, base.id)).text;
    const header = "Title,Long,Number,Select,Status,Multi,Date,Person,People,File,Page,Checkbox,Url,Email,Created,Edited,Editor,F number,F text,F flag,F date,F empty";
    expect(text).toBe(
      `${BOM}${header}\r\n` +
        `Full,"two\nlines",1,Alpha,"Beta, the second","Beta, the second, Alpha",2026-03-05,reader,"Owner, reader","a.txt, b, c.png","Target, the page",true,"https://example.com/?a=1,2",a@b.co,${full.createdAt},${full.updatedAt},Owner,0.333333333333,Full!,true,2026-03-06,\r\n` +
        `Sparse,,0,,,,"March 5, 2026",,,,Untitled,false,,,${sparse.createdAt},${sparse.updatedAt},Owner,0,Sparse!,false,2026-03-06T00:00:00.000Z,\r\n` +
        `Hidden,,,,,,2026-03-05T10:20:30Z,,,,Secret,false,,,${hidden.createdAt},${hidden.updatedAt},Owner,0,Hidden!,false,2026-03-06T10:20:30.000Z,\r\n` +
        `,,,,,,,,,,,false,,,${empty.createdAt},${empty.updatedAt},Owner,0,!,false,#ERROR,\r\n`,
    );
    // The same export for someone who cannot read the secret page: its title is left out. Names are for everyone.
    const forReader = (await exportCsv(reader, base.id)).text;
    expect(forReader).toBe(text.replace(",Secret,false", ",,false"));
    // Formula errors read #ERROR; the last editor is whoever edited last; a removed choice reads as nothing.
    ok(await owner.post(`/bases/${base.id}/properties/${number}/delete`, {}));
    ok(await owner.post(`/bases/${base.id}/properties/${select}/update`, { options: { choices: choices.slice(1) } }));
    const errorRow = await getRow(owner, base.id, full.id);
    expect(errorRow.cells[fNumber]).toEqual({ error: "MISSING_PROP", message: "A property this formula uses was deleted" });
    const after = await dataLines(base.id);
    expect(after[0]).toBe(
      `Full,"two\nlines",,"Beta, the second","Beta, the second, Alpha",2026-03-05,reader,"Owner, reader","a.txt, b, c.png","Target, the page",true,"https://example.com/?a=1,2",a@b.co,${full.createdAt},${full.updatedAt},Owner,#ERROR,Full!,true,2026-03-06,`,
    );
  });

  test("users are named from the last editor or else the creator; a deleted user leaves the field empty", async () => {
    const base = await createBase(owner, spaceId);
    await emptyBase(owner, base.id);
    for (const p of base.properties.slice(1)) ok(await owner.post(`/bases/${base.id}/properties/${p.id}/delete`, {}));
    const title = base.properties[0]!.id;
    await addProperty(owner, base.id, "Editor", "lastEditedBy");
    const who = await addProperty(owner, base.id, "Who", "person");
    const leaver = await t.addMember(owner, "leaver@example.com");
    ok(await owner.post(`/spaces/${spaceId}/members/add`, { role: "writer", userIds: [leaver.user.id] }));
    const mine = await addRow(owner, base.id, { [title]: "mine" });
    const theirs = await addRow(leaver.client, base.id, { [title]: "theirs", [who.id]: leaver.user.id });
    await updateRow(leaver.client, base.id, mine.id, { [title]: "mine, edited" });
    expect(await dataLines(base.id)).toEqual(['"mine, edited",leaver,', "theirs,leaver,leaver"]);
    // The creator stands in when the row has no last editor.
    await t.sql`UPDATE base_rows SET last_editor_id = NULL WHERE id = ${mine.id}`;
    expect(await dataLines(base.id)).toEqual(['"mine, edited",Owner,', "theirs,leaver,leaver"]);
    ok(await owner.post("/members/delete", { userId: leaver.user.id }));
    expect(await dataLines(base.id)).toEqual(['"mine, edited",Owner,', "theirs,,"]);
    void theirs;
  });

  test(
    "a base of more than 500 rows is exported whole and in order",
    async () => {
      const base = await createBase(owner, spaceId, { title: "Big" });
      await emptyBase(owner, base.id);
      for (const p of base.properties.slice(1)) ok(await owner.post(`/bases/${base.id}/properties/${p.id}/delete`, {}));
      const title = base.properties[0]!.id;
      const who = await addProperty(owner, base.id, "Who", "person");
      const total = 1003;
      const position = (i: number) => String(i).padStart(5, "0");
      // Created out of order and several at a time; the positions decide the order.
      const indexes = Array.from({ length: total }, (_, i) => (i * 7) % total);
      let next = 0;
      await Promise.all(
        Array.from({ length: 16 }, async () => {
          while (next < indexes.length) {
            const i = indexes[next++]!;
            // People are looked up batch by batch: the first, the 501st and the last row name someone.
            const cells = { [title]: `row ${i}`, ...(i === 0 || i === 500 || i === total - 1 ? { [who.id]: i === 500 ? readerId : ownerId } : {}) };
            await addRow(owner, base.id, cells, { position: position(i) });
          }
        }),
      );
      const lines = await dataLines(base.id);
      const expected = Array.from({ length: total }, (_, i) => `row ${i},${i === 500 ? "reader" : i === 0 || i === total - 1 ? "Owner" : ""}`);
      expect(lines).toEqual(expected);
    },
    30_000,
  );

  test("cells that hold JSON of another type than their property still export as some text", async () => {
    const base = await createBase(owner, spaceId, { title: "Odd cells" });
    await emptyBase(owner, base.id);
    for (const p of base.properties.slice(1)) ok(await owner.post(`/bases/${base.id}/properties/${p.id}/delete`, {}));
    const title = base.properties[0]!.id;
    const choices = { choices: [{ id: "a", name: "Alpha" }] };
    const ids: Record<string, string> = {};
    for (const [name, type, options] of [
      ["T", "text"],
      ["N", "number"],
      ["S", "select", choices],
      ["M", "multiSelect", choices],
      ["P", "person"],
      ["F", "file"],
      ["G", "page"],
      ["C", "checkbox"],
      ["U", "url"],
    ] as [string, string, unknown?][]) {
      ids[name] = (await addProperty(owner, base.id, name, type, options)).id;
    }
    const first = await addRow(owner, base.id, { [title]: "odd1" });
    const second = await addRow(owner, base.id, { [title]: "odd2" });
    // Only a direct write can leave these behind.
    const cells = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([name, value]) => [ids[name]!, value]));
    const odd1 = cells({ T: 12, N: "abc", S: "zzz", M: "a", P: ["unknown", ownerId], F: "not a list", G: 5, C: "yes", U: { k: 1 } });
    const odd2 = cells({ T: ["a", "b"], N: true, M: ["a", 5, "zzz"], F: [{ fileName: 5 }, null, { fileName: "ok.txt" }], C: 1, U: null });
    await t.sql`UPDATE base_rows SET cells = cells || ${odd1}::jsonb WHERE id = ${first.id}`;
    await t.sql`UPDATE base_rows SET cells = cells || ${odd2}::jsonb WHERE id = ${second.id}`;
    expect(await dataLines(base.id)).toEqual([
      // Text-like cells print the JSON of what is not a string; choices and people print the names they can find;
      // a checkbox is only true for `true`.
      'odd1,12,abc,,Alpha,Owner,,,false,"{""k"":1}"',
      'odd2,"[""a"",""b""]",true,,Alpha,,"5, ok.txt",,false,',
    ]);
  });

  test("errors are JSON answers, not CSV", async () => {
    const page = ok(await owner.post("/pages", { spaceId, title: "Not a base" })).page;
    const res = await owner.get(`/bases/${page.id}/export.csv`);
    expectError(res, 404, "not_found", "Base not found");
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expectError(await t.client().get(`/bases/${page.id}/export.csv`), 401, "unauthorized", "Sign in required");
    // The route is a GET only.
    expectError(await owner.post(`/bases/${page.id}/export.csv`, {}), 404, "not_found", "Endpoint not found");
  });
});
