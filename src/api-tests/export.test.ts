import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Client, type TestServer } from "./harness";
import { readZip, type ZipEntry } from "./harness/zip";
import { apiError } from "./harness/errors";

/**
 * `GET /pages/:id/export` and `GET /spaces/:id/export`
 * (src/server/routes/export.ts, lib/export.ts, lib/zip.ts): single documents,
 * zip archives, links and files inside them, bases as tables. How each kind of
 * node and mark is written is in export-nodes.test.ts.
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
}

const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const docOf = (...content: unknown[]) => ({ type: "doc", content });
const link = (label: string, href: string) => text(label, [{ type: "link", attrs: { href } }]);

const newPage = async (title: string | null, extra: Record<string, unknown> = {}, client = owner): Promise<PageRef> => {
  const res = await client.post("/pages", { spaceId, title, ...extra });
  expect(res.status).toBe(200);
  return res.body.data.page;
};

const setContent = async (pageId: string, content: unknown) => {
  const res = await owner.post(`/pages/${pageId}/content`, { content });
  expect(res.status).toBe(200);
};

const upload = async (pageId: string, name: string, body: BodyInit, type = "application/octet-stream") => {
  const res = await owner.raw("POST", `/files?${new URLSearchParams({ pageId, name })}`, { body, headers: { "Content-Type": type } });
  expect(res.status).toBe(200);
  return (await res.json()).data as { id: string; name: string; url: string };
};

const download = async (pathname: string, client = owner) => {
  const res = await client.raw("GET", pathname);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: new TextDecoder().decode(bytes) };
};

const zipOf = async (pathname: string, client = owner) => {
  const res = await download(pathname, client);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  return { entries: readZip(res.bytes), headers: res.headers };
};

const names = (entries: ZipEntry[]) => entries.map((entry) => entry.name);
const entry = (entries: ZipEntry[], name: string) => {
  const found = entries.find((e) => e.name === name);
  if (!found) throw new Error(`no entry ${name} among ${JSON.stringify(names(entries))}`);
  return found;
};

const STYLE =
  "<style>body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;line-height:1.6}img,video{max-width:100%}pre{background:#f6f8fa;padding:1rem;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px}</style>";

/** The HTML document an export wraps a page in; `title` is already escaped. */
const htmlPage = (title: string, body: string) =>
  `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n${STYLE}\n</head>\n<body>\n<h1>${title}</h1>\n${body}\n</body>\n</html>\n`;

beforeAll(async () => {
  t = await startServer();
  const setup = await t.setupOwner();
  owner = setup.owner;
  ownerId = setup.user.id;
  spaceId = setup.spaceId;
  const add = async (email: string, role: string | null) => {
    const member = await t.addMember(owner, email);
    if (role) expect((await owner.post(`/spaces/${spaceId}/members/add`, { role, userIds: [member.user.id] })).status).toBe(200);
    return member.client;
  };
  reader = await add("export-reader@example.com", "reader");
  writer = await add("export-writer@example.com", "writer");
  outsider = await add("export-outsider@example.com", null);
});

afterAll(async () => {
  await t.close();
});

describe("GET /pages/:id/export: a single document", () => {
  test("Markdown is the default: the title as a heading, then the document", async () => {
    const page = await newPage("Notes", { content: docOf(paragraph(text("Hello "), text("world", [{ type: "bold" }])), paragraph(text("Second paragraph."))) });
    const res = await download(`/pages/${page.id}/export`);
    expect(res.status).toBe(200);
    expect(res.text).toBe("# Notes\n\nHello **world**\n\nSecond paragraph.\n");
    expect(Object.fromEntries([...res.headers].filter(([name]) => !["date", "content-length", "transfer-encoding"].includes(name)))).toEqual({
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": "attachment; filename=\"Notes.md\"; filename*=UTF-8''Notes.md",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "no-store",
    });
    const explicit = await download(`/pages/${page.id}/export?format=markdown`);
    expect(explicit.text).toBe(res.text);
    expect(explicit.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  });

  test("format=html is a complete HTML document", async () => {
    const page = await newPage("Notes in HTML", { content: docOf(paragraph(text("Hello "), text("world", [{ type: "bold" }])), paragraph(text("1 < 2 & 3 > 2"))) });
    const res = await download(`/pages/${page.id}/export?format=html`);
    expect(res.status).toBe(200);
    expect(res.text).toBe(htmlPage("Notes in HTML", "<p>Hello <strong>world</strong></p><p>1 &lt; 2 &amp; 3 &gt; 2</p>"));
    expect(Object.fromEntries([...res.headers].filter(([name]) => !["date", "content-length", "transfer-encoding"].includes(name)))).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-disposition": "attachment; filename=\"Notes in HTML.html\"; filename*=UTF-8''Notes%20in%20HTML.html",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "no-store",
    });
  });

  test("the title is escaped in HTML and made safe as a file name", async () => {
    const page = await newPage('Solo <page> & "quotes"', { content: docOf(paragraph(text("x"))) });
    const html = await download(`/pages/${page.id}/export?format=html`);
    expect(html.text).toBe(htmlPage("Solo &lt;page&gt; &amp; &quot;quotes&quot;", "<p>x</p>"));
    expect(html.headers.get("content-disposition")).toBe(
      "attachment; filename=\"Solo _page_ & _quotes_.html\"; filename*=UTF-8''Solo%20_page_%20%26%20_quotes_.html",
    );
    // Markdown takes the title as it is.
    const markdown = await download(`/pages/${page.id}/export`);
    expect(markdown.text).toBe('# Solo <page> & "quotes"\n\nx\n');
  });

  test("a page without a title is `Untitled`, and an empty document is an empty body", async () => {
    const page = await newPage(null);
    const markdown = await download(`/pages/${page.id}/export`);
    expect(markdown.text).toBe("# Untitled\n\n\n");
    expect(markdown.headers.get("content-disposition")).toBe("attachment; filename=\"Untitled.md\"; filename*=UTF-8''Untitled.md");
    const html = await download(`/pages/${page.id}/export?format=html`);
    expect(html.text).toBe(htmlPage("Untitled", "<p></p>"));
    expect(html.headers.get("content-disposition")).toBe("attachment; filename=\"Untitled.html\"; filename*=UTF-8''Untitled.html");
  });

  test("a page whose document was never stored exports as an empty one", async () => {
    const page = await newPage("No document");
    await t.sql`UPDATE pages SET content = NULL WHERE id = ${page.id}`;
    expect((await download(`/pages/${page.id}/export`)).text).toBe("# No document\n\n\n");
    expect((await download(`/pages/${page.id}/export?format=html`)).text).toBe(htmlPage("No document", ""));
  });

  test.each([
    ["Plain title", "Plain title"],
    ["Ünïcödé 文字 🎉", "Ünïcödé 文字 🎉"],
    // Characters some file systems refuse become `_`.
    ['Q: what? <yes> "no" | maybe*', "Q_ what_ _yes_ _no_ _ maybe_"],
    ["?", "_"],
    // Path separators and control characters are removed.
    ["a/b\\c", "abc"],
    ["../../etc/passwd", "etcpasswd"],
    ["tab\there", "tabhere"],
    // Dots and spaces at either end are removed.
    ["Trailing dots...", "Trailing dots"],
    ["Version 1.0.", "Version 1.0"],
    [".hidden", "hidden"],
    ["... leading", "leading"],
    ["été", "été"],
    // 100 characters at most, without a space left at the cut.
    ["x".repeat(150), "x".repeat(100)],
    ["x".repeat(99) + " yz", "x".repeat(99)],
    ["文".repeat(120), "文".repeat(100)],
  ])("a page titled %p downloads as %p", async (title, base) => {
    const page = await newPage(title);
    const res = await download(`/pages/${page.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toEndWith(`filename*=UTF-8''${encodeURIComponent(`${base}.md`)}`);
    // The heading keeps the title as it is.
    expect(res.text).toBe(`# ${title}\n\n\n`);
  });

  test("a title of nothing but dots downloads as `file`", async () => {
    const page = await newPage("...");
    const res = await download(`/pages/${page.id}/export`);
    // Accident: the fallback of file names (`file`) shows before the fallback of exports (`Untitled`) can.
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=\"file.md\"; filename*=UTF-8''file.md");
    expect(res.text).toBe("# ...\n\n\n");
  });

  test("a title cut in the middle of an astral character fails the export", async () => {
    const page = await newPage("x".repeat(99) + "😀");
    const res = await owner.get(`/pages/${page.id}/export`);
    // Accident: the 100 are UTF-16 units; half a surrogate pair cannot be written into the header.
    expect(res.status).toBe(500);
    expect(res.body).toEqual(apiError("internal_error", "Something went wrong"));
    // One character earlier it fits.
    const fits = await newPage("x".repeat(98) + "😀");
    expect((await download(`/pages/${fits.id}/export`)).headers.get("content-disposition")).toEndWith(`${"x".repeat(98)}%F0%9F%98%80.md`);
  });

  test("`children` on a page without children still answers one document; `files` always makes an archive", async () => {
    const page = await newPage("Alone", { content: docOf(paragraph(text("x"))) });
    const withChildren = await download(`/pages/${page.id}/export?children=1`);
    expect(withChildren.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(withChildren.text).toBe("# Alone\n\nx\n");
    const withFiles = await zipOf(`/pages/${page.id}/export?files=1`);
    expect(names(withFiles.entries)).toEqual(["Alone.md"]);
    expect(withFiles.entries[0]!.text).toBe("# Alone\n\nx\n");
    expect(withFiles.headers.get("content-disposition")).toBe("attachment; filename=\"Alone.zip\"; filename*=UTF-8''Alone.zip");
  });

  test("the page may be given by slugId or by an id in upper case", async () => {
    const page = await newPage("By reference", { content: docOf(paragraph(text("x"))) });
    expect((await download(`/pages/${page.slugId}/export`)).text).toBe("# By reference\n\nx\n");
    expect((await download(`/pages/${page.id.toUpperCase()}/export?format=html`)).status).toBe(200);
  });
});

describe("GET /pages/:id/export: the query", () => {
  let page: PageRef;

  beforeAll(async () => {
    page = await newPage("Query", { content: docOf(paragraph(text("x"))) });
  });

  test.each([["pdf"], ["HTML"], ["Markdown"], ["md"], [""], ["html "], ["markdown,html"]])("format=%p is refused", async (format) => {
    const res = await owner.get(`/pages/${page.id}/export?format=${encodeURIComponent(format)}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(apiError("invalid_input", "format must be one of markdown, html"));
  });

  test.each([
    ["files", "maybe"],
    ["files", "yes"],
    ["files", "2"],
    ["files", "TRUE"],
    ["children", "on"],
    ["children", "-1"],
    ["children", " 1"],
  ])("%s=%p is not a boolean", async (name, value) => {
    const res = await owner.get(`/pages/${page.id}/export?${name}=${encodeURIComponent(value)}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(apiError("invalid_input", `${name} must be a boolean`));
  });

  test("the booleans are 1/true and 0/false, and empty is false", async () => {
    for (const value of ["1", "true"]) {
      expect((await download(`/pages/${page.id}/export?files=${value}`)).headers.get("content-type")).toBe("application/zip");
    }
    for (const value of ["0", "false", ""]) {
      const res = await download(`/pages/${page.id}/export?files=${value}&children=${value}`);
      expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    }
  });

  test("format is checked before files, files before children; unknown parameters are ignored", async () => {
    const all = await owner.get(`/pages/${page.id}/export?children=x&files=x&format=x`);
    expect(all.body).toEqual(apiError("invalid_input", "format must be one of markdown, html"));
    const two = await owner.get(`/pages/${page.id}/export?children=x&files=x`);
    expect(two.body).toEqual(apiError("invalid_input", "files must be a boolean"));
    const extra = await download(`/pages/${page.id}/export?download=1&name=evil`);
    expect(extra.text).toBe("# Query\n\nx\n");
  });
});

describe("GET /pages/:id/export: who may export", () => {
  let page: PageRef;

  beforeAll(async () => {
    page = await newPage("Readable", { content: docOf(paragraph(text("x"))) });
  });

  test("a reader of the space can", async () => {
    for (const client of [reader, writer, owner]) {
      const res = await download(`/pages/${page.id}/export`, client);
      expect([res.status, res.text]).toEqual([200, "# Readable\n\nx\n"]);
    }
    const zipped = await zipOf(`/pages/${page.id}/export?files=1&children=1`, reader);
    expect(names(zipped.entries)).toEqual(["Readable.md"]);
  });

  test("without a session, or from outside the space, nothing is exported", async () => {
    const anonymous = await t.client().get(`/pages/${page.id}/export`);
    expect([anonymous.status, anonymous.body]).toEqual([401, apiError("unauthorized", "Sign in required")]);
    const outside = await outsider.get(`/pages/${page.id}/export`);
    expect([outside.status, outside.body]).toEqual([404, apiError("not_found", "Page not found")]);
    // The page is looked up before the query is read.
    const outsideInvalid = await outsider.get(`/pages/${page.id}/export?format=pdf`);
    expect(outsideInvalid.status).toBe(404);
    const unknown = await owner.get(`/pages/${crypto.randomUUID()}/export`);
    expect([unknown.status, unknown.body]).toEqual([404, apiError("not_found", "Page not found")]);
    const notAPage = await owner.get("/pages/not-a-page!/export");
    expect(notAPage.status).toBe(404);
  });

  test("a page in the trash can still be exported, without the pages trashed with it", async () => {
    const root = await newPage("Trashed root", { content: docOf(paragraph(text("still here"))) });
    await newPage("Trashed child", { parentId: root.id });
    expect((await owner.post(`/pages/${root.id}/delete`)).status).toBe(200);
    const single = await download(`/pages/${root.id}/export`, reader);
    expect([single.status, single.text]).toEqual([200, "# Trashed root\n\nstill here\n"]);
    // Descendants in the trash are never part of an export, so this is one document again.
    const withChildren = await download(`/pages/${root.id}/export?children=1`);
    expect(withChildren.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  });
});

describe("links and references in an exported document", () => {
  let target: PageRef;
  let trashed: PageRef;
  let hidden: PageRef;

  beforeAll(async () => {
    target = await newPage("Target Pagé");
    trashed = await newPage("Trashed target");
    await owner.post(`/pages/${trashed.id}/delete`);
    const created = await owner.post("/spaces", { name: "Hidden", slug: "hidden-space" });
    hidden = (await owner.post("/pages", { spaceId: created.body.data.space.id, title: "Hidden target" })).body.data.page;
  });

  const exported = async (content: unknown, format = "markdown", client = owner) => {
    const page = await newPage("Linking", { content });
    const res = await download(`/pages/${page.id}/export?format=${format}`, client);
    expect(res.status).toBe(200);
    const prefix = format === "markdown" ? "# Linking\n\n" : "";
    return format === "markdown" ? res.text.slice(prefix.length) : res.text.slice(res.text.indexOf("</h1>\n") + 6, res.text.indexOf("\n</body>"));
  };

  test("a link to a page outside the export becomes the page's address in the app", async () => {
    const url = `http://doc.test/s/general/p/target-page-${target.slugId}`;
    const markdown = await exported(
      docOf(
        paragraph(link("by path", `/s/general/p/target-page-${target.slugId}`)),
        paragraph(link("short", `/p/${target.slugId}`)),
        paragraph(link("stale title and space", `/s/elsewhere/p/an-old-title-${target.slugId}`)),
        paragraph(link("absolute", `https://wiki.example.com/s/general/p/x-${target.slugId}`)),
        paragraph(link("trailing slash and query", `/p/${target.slugId}/?tab=1`)),
        paragraph(link("anchor", `/s/general/p/target-page-${target.slugId}#section-2`)),
        paragraph(link("encoded anchor", `/p/${target.slugId}#my%20heading%2Fhere`)),
        paragraph(link("query and anchor", `/p/${target.slugId}?x=1#frag`)),
      ),
    );
    expect(markdown).toBe(
      [
        `[by path](${url})`,
        `[short](${url})`,
        `[stale title and space](${url})`,
        `[absolute](${url})`,
        `[trailing slash and query](${url})`,
        `[anchor](${url}#section-2)`,
        `[encoded anchor](${url}#my%20heading%2Fhere)`,
        `[query and anchor](${url}#frag)`,
      ].join("\n\n") + "\n",
    );
    const html = await exported(docOf(paragraph(link("by path", `/p/${target.slugId}#a b`))), "html");
    expect(html).toBe(`<p><a href="${url}#a%20b">by path</a></p>`);
  });

  test("a link to a page that cannot be read, is in the trash or does not exist becomes the app's root", async () => {
    const markdown = await exported(
      docOf(
        paragraph(link("unknown", "/p/0000000000")),
        paragraph(link("unknown with anchor", "/s/general/p/gone-0000000000#part")),
        paragraph(link("trashed", `/p/${trashed.slugId}`)),
      ),
    );
    expect(markdown).toBe("[unknown](http://doc.test/)\n\n[unknown with anchor](http://doc.test/#part)\n\n[trashed](http://doc.test/)\n");
    // What a reader of only this space gets for a page of a space they are not in; the owner gets its address.
    const content = docOf(paragraph(link("hidden", `/p/${hidden.slugId}`)));
    expect(await exported(content, "markdown", writer)).toBe("[hidden](http://doc.test/)\n");
    expect(await exported(content)).toBe(`[hidden](http://doc.test/s/hidden-space/p/hidden-target-${hidden.slugId})\n`);
  });

  test("links that are not page links are left as they are", async () => {
    const hrefs = [
      "https://example.com/s/general/p/x-abc/extra",
      "https://example.com/",
      "/s/general",
      "/p/",
      "/p/has-a-dash-",
      "/settings/p/abc",
      "mailto:someone@example.com",
      "#local-anchor",
      "/s/general/p/bad%zzescape-abc",
      `/p/${"a".repeat(33)}`,
    ];
    const markdown = await exported(docOf(...hrefs.map((href, i) => paragraph(link(`l${i}`, href)))));
    expect(markdown).toBe(hrefs.map((href, i) => `[l${i}](${href})`).join("\n\n") + "\n");
  });

  test("a mention of a page is a link to it; a mention of a person is their name", async () => {
    const url = `http://doc.test/s/general/p/target-page-${target.slugId}`;
    const mention = (attrs: Record<string, unknown>) => ({ type: "mention", attrs });
    const content = docOf(
      paragraph(
        text("See "),
        mention({ id: "m1", label: "Target Pagé", entityType: "page", entityId: target.id, slugId: target.slugId }),
        text(", "),
        mention({ id: "m2", label: "a heading", entityType: "page", entityId: target.id, slugId: target.slugId, anchorId: "h 1" }),
        text(", "),
        mention({ id: "m3", label: "gone", entityType: "page", slugId: "0000000000" }),
        text(", "),
        mention({ id: "m4", label: "no slug", entityType: "page", entityId: target.id }),
        text(" and "),
        mention({ id: "m5", label: "Owner", entityType: "user", entityId: ownerId }),
      ),
    );
    expect(await exported(content)).toBe(`See [Target Pagé](${url}), [a heading](${url}#h%201), [gone](http://doc.test/), no slug and @Owner\n`);
    expect(await exported(content, "html")).toBe(
      "<p>See " +
        `<a href="${url}" data-type="mention" class="mention" data-id="m1" data-label="Target Pagé" data-entity-type="page" data-entity-id="${target.id}" data-slug-id="${target.slugId}">Target Pagé</a>, ` +
        `<a href="${url}#h%201" data-type="mention" class="mention" data-id="m2" data-label="a heading" data-entity-type="page" data-entity-id="${target.id}" data-slug-id="${target.slugId}" data-anchor-id="h 1">a heading</a>, ` +
        '<a href="http://doc.test/" data-type="mention" class="mention" data-id="m3" data-label="gone" data-entity-type="page" data-slug-id="0000000000">gone</a>, ' +
        `<span data-type="mention" class="mention" data-id="m4" data-label="no slug" data-entity-type="page" data-entity-id="${target.id}">no slug</span> and ` +
        `<span data-type="mention" class="mention" data-id="m5" data-label="Owner" data-entity-type="user" data-entity-id="${ownerId}">@Owner</span></p>`,
    );
  });

  test("a link to the exported page itself is the document's own file name", async () => {
    const page = await newPage("Self linking");
    await setContent(page.id, docOf(paragraph(link("top", `/p/${page.slugId}`), text(" "), link("part", `/p/${page.slugId}#part`))));
    expect((await download(`/pages/${page.id}/export`)).text).toBe("# Self linking\n\n[top](Self%20linking.md) [part](Self%20linking.md#part)\n");
    expect((await download(`/pages/${page.id}/export?format=html`)).text).toContain('<a href="Self%20linking.html">top</a> <a href="Self%20linking.html#part">part</a>');
  });

  test("without files=1, file URLs become absolute URLs of the app; other sources are kept", async () => {
    const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const content = docOf(
      { type: "image", attrs: { src: `/api/files/${id}/a b.png`, alt: "pic" } },
      { type: "attachment", attrs: { url: `/api/files/${id}/report.pdf?v=2#page=3`, name: "report.pdf" } },
      { type: "image", attrs: { src: "https://example.com/remote.png" } },
      { type: "image", attrs: { src: "/api/images/3f2504e0-4f89-41d3-9a0c-0305e82c3301.png" } },
      paragraph(link("download", `/api/files/${id}/linked.zip`)),
    );
    expect(await exported(content)).toBe(
      [
        `![pic](http://doc.test/api/files/${id}/a%20b.png)`,
        `[report.pdf](http://doc.test/api/files/${id}/report.pdf?v=2#page=3)`,
        "![](https://example.com/remote.png)",
        "![](/api/images/3f2504e0-4f89-41d3-9a0c-0305e82c3301.png)",
        `[download](http://doc.test/api/files/${id}/linked.zip)`,
      ].join("\n\n") + "\n",
    );
    expect(await exported(content, "html")).toBe(
      `<img src="http://doc.test/api/files/${id}/a b.png" alt="pic">` +
        `<div data-type="attachment" data-attachment-url="http://doc.test/api/files/${id}/report.pdf?v=2#page=3" data-attachment-name="report.pdf"><a href="http://doc.test/api/files/${id}/report.pdf?v=2#page=3" class="attachment" target="_blank">report.pdf</a></div>` +
        '<img src="https://example.com/remote.png">' +
        '<img src="/api/images/3f2504e0-4f89-41d3-9a0c-0305e82c3301.png">' +
        `<p><a href="http://doc.test/api/files/${id}/linked.zip">download</a></p>`,
    );
  });

  test("a page link whose anchor has a malformed escape fails the export", async () => {
    const page = await newPage("Bad anchor", { content: docOf(paragraph(link("oops", `/p/${target.slugId}#100%`))) });
    const res = await owner.get(`/pages/${page.id}/export`);
    // Accident: the anchor is percent-decoded without a guard.
    expect(res.status).toBe(500);
    expect(res.body).toEqual(apiError("internal_error", "Something went wrong"));
  });
});

describe("GET /pages/:id/export?children=1: an archive of a page and the pages below it", () => {
  let guide: PageRef;
  let setup: PageRef;
  let setupTwin: PageRef;
  let deep: PageRef;
  let usage: PageRef;

  beforeAll(async () => {
    guide = await newPage("Guide");
    setup = await newPage("Setup", { parentId: guide.id });
    setupTwin = await newPage("Setup", { parentId: guide.id });
    usage = await newPage("Usage: basics?", { parentId: guide.id });
    deep = await newPage("Deep page", { parentId: setup.id });
    await newPage("Trashed child", { parentId: guide.id }).then((p) => owner.post(`/pages/${p.id}/delete`));
    await setContent(
      guide.id,
      docOf(
        paragraph(text("Start with "), link("setup", `/s/general/p/setup-${setup.slugId}`), text(", then "), link("the deep page", `/p/${deep.slugId}#step-2`), text(".")),
        paragraph({ type: "mention", attrs: { label: "Usage", entityType: "page", slugId: usage.slugId, anchorId: "top" } }),
      ),
    );
    await setContent(setup.id, docOf(paragraph(link("up", `/p/${guide.slugId}`), text(" / "), link("twin", `/p/${setupTwin.slugId}`), text(" / "), link("down", `/p/${deep.slugId}`))));
    await setContent(deep.id, docOf(paragraph(link("root", `/p/${guide.slugId}#intro`), text(" / "), link("parent", `/p/${setup.slugId}`), text(" / "), link("cousin", `/p/${usage.slugId}`))));
  });

  test("pages with children get a folder of their name; entries come parents first, siblings by position", async () => {
    const { entries, headers } = await zipOf(`/pages/${guide.id}/export?children=1`);
    expect(names(entries)).toEqual(["Guide.md", "Guide/Setup.md", "Guide/Setup/Deep page.md", "Guide/Setup (1).md", "Guide/Usage_ basics_.md"]);
    expect(Object.fromEntries([...headers].filter(([name]) => !["date", "content-length", "transfer-encoding"].includes(name)))).toEqual({
      "content-type": "application/zip",
      "content-disposition": "attachment; filename=\"Guide.zip\"; filename*=UTF-8''Guide.zip",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
  });

  test("links between exported pages are relative paths inside the archive, with their anchors", async () => {
    const { entries } = await zipOf(`/pages/${guide.id}/export?children=1`);
    expect(entry(entries, "Guide.md").text).toBe(
      "# Guide\n\nStart with [setup](Guide/Setup.md), then [the deep page](Guide/Setup/Deep%20page.md#step-2).\n\n[Usage](Guide/Usage_%20basics_.md#top)\n",
    );
    // Accident: parentheses in a link target are meant to be percent-encoded for Markdown but are written as they are.
    expect(entry(entries, "Guide/Setup.md").text).toBe("# Setup\n\n[up](../Guide.md) / [twin](../Guide/Setup%20(1).md) / [down](../Guide/Setup/Deep%20page.md)\n");
    expect(entry(entries, "Guide/Setup/Deep page.md").text).toBe(
      "# Deep page\n\n[root](../../Guide.md#intro) / [parent](../../Guide/Setup.md) / [cousin](../../Guide/Usage_%20basics_.md)\n",
    );
    expect(entry(entries, "Guide/Setup (1).md").text).toBe("# Setup\n\n\n");
  });

  test("in HTML the files and the links end in .html", async () => {
    const { entries, headers } = await zipOf(`/pages/${guide.id}/export?children=1&format=html`);
    expect(names(entries)).toEqual(["Guide.html", "Guide/Setup.html", "Guide/Setup/Deep page.html", "Guide/Setup (1).html", "Guide/Usage_ basics_.html"]);
    expect(headers.get("content-disposition")).toBe("attachment; filename=\"Guide.zip\"; filename*=UTF-8''Guide.zip");
    expect(entry(entries, "Guide/Setup.html").text).toBe(
      htmlPage("Setup", '<p><a href="../Guide.html">up</a> / <a href="../Guide/Setup%20(1).html">twin</a> / <a href="../Guide/Setup/Deep%20page.html">down</a></p>'),
    );
    expect(entry(entries, "Guide.html").text).toContain(
      `<a href="Guide/Usage_%20basics_.html#top" data-type="mention" class="mention" data-label="Usage" data-entity-type="page" data-slug-id="${usage.slugId}" data-anchor-id="top">Usage</a>`,
    );
  });

  test("exporting a page from the middle makes it the root of its archive; links upwards leave the archive", async () => {
    const { entries, headers } = await zipOf(`/pages/${setup.id}/export?children=1`);
    expect(names(entries)).toEqual(["Setup.md", "Setup/Deep page.md"]);
    expect(headers.get("content-disposition")).toBe("attachment; filename=\"Setup.zip\"; filename*=UTF-8''Setup.zip");
    expect(entry(entries, "Setup.md").text).toBe(
      `# Setup\n\n[up](http://doc.test/s/general/p/guide-${guide.slugId}) / [twin](http://doc.test/s/general/p/setup-${setupTwin.slugId}) / [down](Setup/Deep%20page.md)\n`,
    );
    expect(entry(entries, "Setup/Deep page.md").text).toBe(
      `# Deep page\n\n[root](http://doc.test/s/general/p/guide-${guide.slugId}#intro) / [parent](../Setup.md) / [cousin](http://doc.test/s/general/p/usage-basics-${usage.slugId})\n`,
    );
  });

  test("without children=1 only the page itself is exported, and its links to pages below leave the document", async () => {
    const res = await download(`/pages/${guide.id}/export`);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.text).toBe(
      `# Guide\n\nStart with [setup](http://doc.test/s/general/p/setup-${setup.slugId}), then [the deep page](http://doc.test/s/general/p/deep-page-${deep.slugId}#step-2).\n\n` +
        `[Usage](http://doc.test/s/general/p/usage-basics-${usage.slugId}#top)\n`,
    );
  });

  test("names that collide in a folder are numbered, ignoring case; `files` is reserved", async () => {
    const root = await newPage("Collisions");
    const titles = ["Same", "same", "SAME", "Same (1)", null, null, "Files", "files", "FILES", "con/flict", "conflict", "é", "é"];
    const made: PageRef[] = [];
    for (const title of titles) made.push(await newPage(title, { parentId: root.id }));
    // A renamed page's children go into the renamed folder.
    await newPage("Inside files", { parentId: made[6]!.id });
    await newPage("Inside same", { parentId: made[1]!.id });
    const { entries } = await zipOf(`/pages/${root.id}/export?children=1`);
    expect(names(entries)).toEqual([
      "Collisions.md",
      "Collisions/Same.md",
      "Collisions/same (1).md",
      "Collisions/same (1)/Inside same.md",
      "Collisions/SAME (2).md",
      "Collisions/Same (1) (1).md",
      "Collisions/Untitled.md",
      "Collisions/Untitled (1).md",
      "Collisions/Files (1).md",
      "Collisions/Files (1)/Inside files.md",
      "Collisions/files (2).md",
      "Collisions/FILES (3).md",
      "Collisions/conflict.md",
      "Collisions/conflict (1).md",
      "Collisions/é.md",
      "Collisions/é (1).md",
    ]);
    // The heading is always the page's own title.
    expect(entry(entries, "Collisions/same (1).md").text).toBe("# same\n\n\n");
    expect(entry(entries, "Collisions/Untitled (1).md").text).toBe("# Untitled\n\n\n");
  });

  test("a root page called Files is renamed too, and names in other folders do not collide", async () => {
    const root = await newPage("files");
    const a = await newPage("A", { parentId: root.id });
    const b = await newPage("B", { parentId: root.id });
    await newPage("Same", { parentId: a.id });
    await newPage("Same", { parentId: b.id });
    const { entries, headers } = await zipOf(`/pages/${root.id}/export?children=1`);
    expect(names(entries)).toEqual(["files (1).md", "files (1)/A.md", "files (1)/A/Same.md", "files (1)/B.md", "files (1)/B/Same.md"]);
    // The archive itself keeps the title.
    expect(headers.get("content-disposition")).toBe("attachment; filename=\"files.zip\"; filename*=UTF-8''files.zip");
  });

  test("entry names in any script are written as UTF-8 and flagged so", async () => {
    const root = await newPage("Übersicht 文書 🎉");
    await newPage("Página niño", { parentId: root.id });
    const { entries, headers } = await zipOf(`/pages/${root.id}/export?children=1&format=html`);
    expect(names(entries)).toEqual(["Übersicht 文書 🎉.html", "Übersicht 文書 🎉/Página niño.html"]);
    for (const e of entries) expect(e.flags & 0x0800).toBe(0x0800);
    expect(headers.get("content-disposition")).toBe(
      "attachment; filename=\"_bersicht __ __.zip\"; filename*=UTF-8''%C3%9Cbersicht%20%E6%96%87%E6%9B%B8%20%F0%9F%8E%89.zip",
    );
  });

  test("the order of siblings is their position, not their age", async () => {
    const root = await newPage("Ordered");
    const first = await newPage("Made first", { parentId: root.id });
    const second = await newPage("Made second", { parentId: root.id });
    const third = await newPage("Made third, moved to the front", { parentId: root.id });
    expect((await owner.post(`/pages/${third.id}/move`, { parentId: root.id, afterId: null })).status).toBe(200);
    expect((await owner.post(`/pages/${first.id}/move`, { parentId: root.id, afterId: second.id })).status).toBe(200);
    const { entries } = await zipOf(`/pages/${root.id}/export?children=1`);
    expect(names(entries)).toEqual(["Ordered.md", "Ordered/Made third, moved to the front.md", "Ordered/Made second.md", "Ordered/Made first.md"]);
  });

  test("an archive of many pages has them all, and a long page is stored compressed", async () => {
    const root = await newPage("Many", { content: docOf(...Array.from({ length: 400 }, (_, i) => paragraph(text(`Paragraph ${i} lorem ipsum dolor sit amet.`)))) });
    for (let i = 0; i < 55; i++) await newPage(`Child ${String(i).padStart(2, "0")}`, { parentId: root.id, content: docOf(paragraph(text(`body ${i}`))) });
    const started = Date.now();
    const { entries } = await zipOf(`/pages/${root.id}/export?children=1`);
    expect(entries.length).toBe(56);
    expect(names(entries).slice(0, 3)).toEqual(["Many.md", "Many/Child 00.md", "Many/Child 01.md"]);
    expect(entries[55]!.name).toBe("Many/Child 54.md");
    expect(entries[51]!.text).toBe("# Child 50\n\nbody 50\n");
    const big = entries[0]!;
    expect(big.size).toBeGreaterThan(10_000);
    expect(big.compressedSize).toBeLessThan(big.size / 2);
    // Entries carry the time of the export (the servers run in UTC).
    for (const e of [entries[0]!, entries[55]!]) {
      expect(Math.abs(e.modified.getTime() - started)).toBeLessThan(120_000);
    }
  }, 30_000);
});

describe("exporting with files=1", () => {
  let root: PageRef;
  let child: PageRef;
  let grandchild: PageRef;
  let rootFile: { id: string; name: string; url: string };
  let childFile: { id: string; name: string; url: string };
  let deepFile: { id: string; name: string; url: string };
  let unused: { id: string; name: string; url: string };
  let foreign: { id: string; name: string; url: string };
  const binary = new Uint8Array(3000).map((_, i) => (i * 7) % 256);

  beforeAll(async () => {
    root = await newPage("Files root");
    child = await newPage("Child", { parentId: root.id });
    grandchild = await newPage("Grandchild", { parentId: child.id });
    const elsewhere = await newPage("Not exported");
    rootFile = await upload(root.id, "root diagram (1).png", binary, "image/png");
    childFile = await upload(child.id, "child.txt", "child file", "text/plain");
    deepFile = await upload(grandchild.id, "ünï 文.pdf", "%PDF deep", "application/pdf");
    unused = await upload(root.id, "unused.bin", "nobody links here");
    foreign = await upload(elsewhere.id, "foreign.txt", "from another page", "text/plain");
    await setContent(
      root.id,
      docOf(
        { type: "image", attrs: { src: rootFile.url, alt: "diagram", attachmentId: rootFile.id } },
        paragraph(link("the child's file", childFile.url), text(" and "), link("a foreign file", foreign.url)),
      ),
    );
    await setContent(child.id, docOf({ type: "attachment", attrs: { url: `${childFile.url}?v=2#top`, name: "child.txt" } }, { type: "image", attrs: { src: rootFile.url } }));
    await setContent(grandchild.id, docOf({ type: "pdf", attrs: { src: deepFile.url, name: "ünï 文.pdf" } }, { type: "video", attrs: { src: foreign.url } }));
  });

  test("referenced files of the exported pages are added under files/<id>/<name>, and the documents point at them", async () => {
    const { entries } = await zipOf(`/pages/${root.id}/export?children=1&files=1`);
    expect(names(entries).slice(0, 3)).toEqual(["Files root.md", "Files root/Child.md", "Files root/Child/Grandchild.md"]);
    // After the pages come the files, in no particular order; unused and foreign files are not among them.
    expect(names(entries).slice(3).sort()).toEqual(
      [`files/${rootFile.id}/root diagram (1).png`, `files/${childFile.id}/child.txt`, `files/${deepFile.id}/ünï 文.pdf`].sort(),
    );
    expect(entry(entries, `files/${rootFile.id}/root diagram (1).png`).data).toEqual(binary);
    expect(entry(entries, `files/${childFile.id}/child.txt`).text).toBe("child file");
    expect(entry(entries, `files/${deepFile.id}/ünï 文.pdf`).text).toBe("%PDF deep");

    expect(entry(entries, "Files root.md").text).toBe(
      `# Files root\n\n![diagram](files/${rootFile.id}/root%20diagram%20(1).png)\n\n` +
        `[the child's file](files/${childFile.id}/child.txt) and [a foreign file](http://doc.test/api/files/${foreign.id}/foreign.txt)\n`,
    );
    // One folder down the paths climb once, two folders down twice; a query or fragment on the URL is dropped.
    expect(entry(entries, "Files root/Child.md").text).toBe(
      `# Child\n\n[child.txt](../files/${childFile.id}/child.txt)\n\n![](../files/${rootFile.id}/root%20diagram%20(1).png)\n`,
    );
    expect(entry(entries, "Files root/Child/Grandchild.md").text).toBe(
      `# Grandchild\n\n[ünï 文.pdf](../../files/${deepFile.id}/%C3%BCn%C3%AF%20%E6%96%87.pdf)\n\n[foreign.txt](http://doc.test/api/files/${foreign.id}/foreign.txt)\n`,
    );
    expect(unused.id).not.toBe(rootFile.id);
  });

  test("in HTML the same paths are used", async () => {
    const { entries } = await zipOf(`/pages/${root.id}/export?children=1&files=1&format=html`);
    expect(entry(entries, "Files root/Child.html").text).toBe(
      htmlPage(
        "Child",
        `<div data-type="attachment" data-attachment-url="../files/${childFile.id}/child.txt" data-attachment-name="child.txt"><a href="../files/${childFile.id}/child.txt" class="attachment" target="_blank">child.txt</a></div>` +
          `<img src="../files/${rootFile.id}/root%20diagram%20(1).png">`,
      ),
    );
    expect(names(entries).slice(3).sort()).toEqual(
      [`files/${rootFile.id}/root diagram (1).png`, `files/${childFile.id}/child.txt`, `files/${deepFile.id}/ünï 文.pdf`].sort(),
    );
  });

  test("without children only the page's own files can be included; a file of a page below is linked absolutely", async () => {
    const { entries } = await zipOf(`/pages/${root.id}/export?files=1`);
    expect(names(entries)).toEqual(["Files root.md", `files/${rootFile.id}/root diagram (1).png`]);
    expect(entries[0]!.text).toBe(
      `# Files root\n\n![diagram](files/${rootFile.id}/root%20diagram%20(1).png)\n\n` +
        `[the child's file](http://doc.test/api/files/${childFile.id}/child.txt) and [a foreign file](http://doc.test/api/files/${foreign.id}/foreign.txt)\n`,
    );
  });

  test("an archive from the middle includes a file of an exported page even when only another exported page shows it", async () => {
    const { entries } = await zipOf(`/pages/${child.id}/export?children=1&files=1`);
    expect(names(entries).slice(0, 2)).toEqual(["Child.md", "Child/Grandchild.md"]);
    expect(names(entries).slice(2).sort()).toEqual([`files/${childFile.id}/child.txt`, `files/${deepFile.id}/ünï 文.pdf`].sort());
    // The root page's file is outside this export.
    expect(entries[0]!.text).toBe(`# Child\n\n[child.txt](files/${childFile.id}/child.txt)\n\n![](http://doc.test/api/files/${rootFile.id}/root%20diagram%20(1).png)\n`);
  });

  test("a replaced file is exported with its current bytes; a file whose object is gone is left out", async () => {
    const page = await newPage("Replaced and lost");
    const replaced = await upload(page.id, "replaced.txt", "old", "text/plain");
    const lost = await upload(page.id, "lost.txt", "lost", "text/plain");
    const res = await owner.raw("POST", `/files?pageId=${page.id}&replaceId=${replaced.id}`, { body: "new bytes", headers: { "Content-Type": "text/plain" } });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    const { rmSync } = await import("node:fs");
    rmSync(`${t.storageDir}/files/${lost.id}`, { recursive: true });
    await setContent(page.id, docOf(paragraph(link("replaced", replaced.url), text(" "), link("lost", lost.url))));
    const { entries } = await zipOf(`/pages/${page.id}/export?files=1`);
    expect(names(entries)).toEqual(["Replaced and lost.md", `files/${replaced.id}/replaced.txt`]);
    expect(entries[1]!.text).toBe("new bytes");
    // The document still points at where the lost file would have been.
    expect(entries[0]!.text).toBe(`# Replaced and lost\n\n[replaced](files/${replaced.id}/replaced.txt) [lost](files/${lost.id}/lost.txt)\n`);
  });

  test("a file is referenced by its id: the name in the URL does not matter, and upper case is fine", async () => {
    const page = await newPage("By id");
    const file = await upload(page.id, "real name.txt", "content", "text/plain");
    await setContent(page.id, docOf({ type: "image", attrs: { src: `/api/files/${file.id.toUpperCase()}/another-name.png` } }, { type: "image", attrs: { src: `/api/files/${file.id}` } }));
    const { entries } = await zipOf(`/pages/${page.id}/export?files=1`);
    expect(names(entries)).toEqual(["By id.md", `files/${file.id}/real name.txt`]);
    expect(entries[0]!.text).toBe(`# By id\n\n![](files/${file.id}/real%20name.txt)\n\n![](files/${file.id}/real%20name.txt)\n`);
  });
});

describe("GET /spaces/:id/export", () => {
  let space: string;
  let alpha: PageRef;
  let beta: PageRef;
  let betaChild: PageRef;
  let spaceReader: Client;
  let spaceWriter: Client;
  let spaceAdmin: Client;

  beforeAll(async () => {
    const created = await owner.post("/spaces", { name: "Team: Docs?", slug: "team-docs" });
    space = created.body.data.space.id;
    const make = async (title: string, extra: Record<string, unknown> = {}) => (await owner.post("/pages", { spaceId: space, title, ...extra })).body.data.page as PageRef;
    beta = await make("Beta");
    alpha = await make("Alpha");
    // Alpha was made second and is moved to the front.
    expect((await owner.post(`/pages/${alpha.id}/move`, { parentId: null, afterId: null })).status).toBe(200);
    betaChild = await make("Beta child", { parentId: beta.id });
    const gone = await make("Gone");
    await owner.post(`/pages/${gone.id}/delete`);
    const file = await owner.raw("POST", `/files?pageId=${betaChild.id}&name=attached.txt`, { body: "attached", headers: { "Content-Type": "text/plain" } });
    const attached = (await file.json()).data;
    expect((await owner.post(`/pages/${alpha.id}/content`, { content: docOf(paragraph(link("child", `/p/${betaChild.slugId}`), text(" "), link("file", attached.url), text(" "), link("gone", `/p/${gone.slugId}`))) })).status).toBe(200);
    const add = async (email: string, role: string) => {
      const member = await t.addMember(owner, email);
      expect((await owner.post(`/spaces/${space}/members/add`, { role, userIds: [member.user.id] })).status).toBe(200);
      return member.client;
    };
    spaceReader = await add("space-export-reader@example.com", "reader");
    spaceWriter = await add("space-export-writer@example.com", "writer");
    spaceAdmin = await add("space-export-admin@example.com", "admin");
  });

  test("a space admin gets an archive of every page not in the trash, named after the space", async () => {
    for (const client of [owner, spaceAdmin]) {
      const { entries, headers } = await zipOf(`/spaces/${space}/export`, client);
      expect(names(entries)).toEqual(["Alpha.md", "Beta.md", "Beta/Beta child.md"]);
      expect(Object.fromEntries([...headers].filter(([name]) => !["date", "content-length", "transfer-encoding"].includes(name)))).toEqual({
        "content-type": "application/zip",
        "content-disposition": "attachment; filename=\"Team_ Docs_.zip\"; filename*=UTF-8''Team_%20Docs_.zip",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      expect(entry(entries, "Alpha.md").text).toMatch(/^# Alpha\n\n\[child\]\(Beta\/Beta%20child\.md\) \[file\]\(http:\/\/doc\.test\/api\/files\/[0-9a-f-]{36}\/attached\.txt\) \[gone\]\(http:\/\/doc\.test\/\)\n$/);
    }
  });

  test("format and files work as for pages; children is always on", async () => {
    const html = await zipOf(`/spaces/${space}/export?format=html&children=0`);
    expect(names(html.entries)).toEqual(["Alpha.html", "Beta.html", "Beta/Beta child.html"]);
    const withFiles = await zipOf(`/spaces/${space}/export?files=1`);
    expect(names(withFiles.entries).slice(0, 3)).toEqual(["Alpha.md", "Beta.md", "Beta/Beta child.md"]);
    expect(withFiles.entries.length).toBe(4);
    expect(withFiles.entries[3]!.name).toMatch(/^files\/[0-9a-f-]{36}\/attached\.txt$/);
    expect(withFiles.entries[3]!.text).toBe("attached");
    expect(entry(withFiles.entries, "Alpha.md").text).toBe(`# Alpha\n\n[child](Beta/Beta%20child.md) [file](${withFiles.entries[3]!.name}) [gone](http://doc.test/)\n`);
    const invalid = await owner.get(`/spaces/${space}/export?format=docx`);
    expect([invalid.status, invalid.body]).toEqual([400, apiError("invalid_input", "format must be one of markdown, html")]);
    const invalidFiles = await owner.get(`/spaces/${space}/export?files=maybe`);
    expect([invalidFiles.status, invalidFiles.body]).toEqual([400, apiError("invalid_input", "files must be a boolean")]);
    // `children` is not read at all.
    expect((await download(`/spaces/${space}/export?children=maybe`)).status).toBe(200);
  });

  test("the space is given by id, in any letter case", async () => {
    const upper = await zipOf(`/spaces/${space.toUpperCase()}/export`);
    expect(names(upper.entries)).toEqual(["Alpha.md", "Beta.md", "Beta/Beta child.md"]);
    const notFound = apiError("not_found", "Space not found");
    for (const ref of ["team-docs", "nope", crypto.randomUUID()]) {
      const res = await owner.get(`/spaces/${ref}/export`);
      expect([ref, res.status, res.body]).toEqual([ref, 404, notFound]);
    }
  });

  test("readers and writers of the space may not export it; others cannot tell it exists", async () => {
    const forbidden = apiError("forbidden", "You do not have permission to do this");
    for (const client of [spaceReader, spaceWriter]) {
      const res = await client.get(`/spaces/${space}/export`);
      expect([res.status, res.body]).toEqual([403, forbidden]);
    }
    const notFound = apiError("not_found", "Space not found");
    const outside = await outsider.get(`/spaces/${space}/export`);
    expect([outside.status, outside.body]).toEqual([404, notFound]);
    const anonymous = await t.client().get(`/spaces/${space}/export`);
    expect([anonymous.status, anonymous.body]).toEqual([401, apiError("unauthorized", "Sign in required")]);
    // A workspace admin who is not a member of the space is outside it.
    const workspaceAdmin = await t.addMember(owner, "space-export-wsadmin@example.com", "admin");
    const asWorkspaceAdmin = await workspaceAdmin.client.get(`/spaces/${space}/export`);
    expect([asWorkspaceAdmin.status, asWorkspaceAdmin.body]).toEqual([404, notFound]);
    // They can still export single pages they can read.
    expect((await download(`/pages/${alpha.id}/export`, spaceReader)).status).toBe(200);
  });

  test("an empty space exports as an empty archive", async () => {
    const created = await owner.post("/spaces", { name: "Empty", slug: "empty-space" });
    const { entries, headers } = await zipOf(`/spaces/${created.body.data.space.id}/export`);
    expect(entries).toEqual([]);
    expect(headers.get("content-disposition")).toBe("attachment; filename=\"Empty.zip\"; filename*=UTF-8''Empty.zip");
  });
});

describe("bases in an export", () => {
  interface Property {
    id: string;
    name: string;
  }

  const newBase = async (title: string | null, extra: Record<string, unknown> = {}) => {
    const created = await owner.post("/bases", { spaceId, title, ...extra });
    expect(created.status).toBe(200);
    const base = (await owner.get(`/bases/${created.body.data.page.id}`)).body.data;
    return base as { id: string; slugId: string; properties: Property[] };
  };

  const addProperty = async (baseId: string, name: string, type: string, options?: Record<string, unknown>) => {
    const res = await owner.post(`/bases/${baseId}/properties`, { name, type, options });
    expect(res.status).toBe(200);
    return res.body.data as Property;
  };

  test("a base is exported as a table of its rows, in Markdown and in HTML", async () => {
    const base = await newBase("Tasks");
    const [title, first] = base.properties as [Property, Property, Property];
    expect((await owner.post(`/bases/${base.id}/rows`, { cells: { [title.id]: "Write docs", [first.id]: "soon" } })).status).toBe(200);
    expect((await owner.post(`/bases/${base.id}/rows`, { cells: { [title.id]: "Ship <it> & \"rest\"" } })).status).toBe(200);
    const markdown = await download(`/pages/${base.id}/export`);
    expect(markdown.headers.get("content-disposition")).toBe("attachment; filename=\"Tasks.md\"; filename*=UTF-8''Tasks.md");
    // The first row is the empty one every new base starts with.
    expect(markdown.text).toBe(
      "# Tasks\n\n| Title | Text 1 | Text 2 |\n| --- | --- | --- |\n|  |  |  |\n| Write docs | soon |  |\n| Ship <it> & \"rest\" |  |  |\n",
    );
    const html = await download(`/pages/${base.id}/export?format=html`);
    expect(html.text).toBe(
      htmlPage(
        "Tasks",
        "<table>\n<thead><tr><th>Title</th><th>Text 1</th><th>Text 2</th></tr></thead>\n<tbody>\n" +
          "<tr><td></td><td></td><td></td></tr>\n<tr><td>Write docs</td><td>soon</td><td></td></tr>\n<tr><td>Ship &lt;it&gt; &amp; &quot;rest&quot;</td><td></td><td></td></tr>\n" +
          "</tbody>\n</table>",
      ),
    );
  });

  test("an untitled base is `Untitled base` in the document and `Untitled` as a file", async () => {
    const base = await newBase(null);
    await t.sql`DELETE FROM base_rows WHERE page_id = ${base.id}`;
    const markdown = await download(`/pages/${base.id}/export`);
    expect(markdown.text).toBe("# Untitled base\n\n| Title | Text 1 | Text 2 |\n| --- | --- | --- |\n");
    expect(markdown.headers.get("content-disposition")).toBe("attachment; filename=\"Untitled.md\"; filename*=UTF-8''Untitled.md");
    const html = await download(`/pages/${base.id}/export?format=html`);
    expect(html.text).toBe(htmlPage("Untitled base", "<table>\n<thead><tr><th>Title</th><th>Text 1</th><th>Text 2</th></tr></thead>\n<tbody>\n\n</tbody>\n</table>"));
  });

  test("cells are escaped for a Markdown table: pipes, backslashes and line breaks", async () => {
    const base = await newBase("Escapes");
    const [title, first, second] = base.properties as [Property, Property, Property];
    await t.sql`DELETE FROM base_rows WHERE page_id = ${base.id}`;
    expect((await owner.post(`/bases/${base.id}/properties/${first.id}/update`, { name: "A | B" })).status).toBe(200);
    expect((await owner.post(`/bases/${base.id}/rows`, { cells: { [title.id]: "a | b || c", [first.id]: "back\\slash \\| both", [second.id]: "line one\nline two\r\nline three" } })).status).toBe(200);
    expect((await download(`/pages/${base.id}/export`)).text).toBe(
      "# Escapes\n\n| Title | A \\| B | Text 2 |\n| --- | --- | --- |\n| a \\| b \\|\\| c | back\\\\slash \\\\\\| both | line one line two line three |\n",
    );
    expect((await download(`/pages/${base.id}/export?format=html`)).text).toContain(
      "<thead><tr><th>Title</th><th>A | B</th><th>Text 2</th></tr></thead>\n<tbody>\n<tr><td>a | b || c</td><td>back\\slash \\| both</td><td>line one\nline two\r\nline three</td></tr>\n</tbody>",
    );
  });

  test("every type of property is written as text", async () => {
    const base = await newBase("Every type");
    const [title, first, second] = base.properties as [Property, Property, Property];
    await t.sql`DELETE FROM base_rows WHERE page_id = ${base.id}`;
    const member = await t.addMember(owner, "export-person@example.com");
    const related = await newPage("Related page");
    const untitledPage = await newPage(null);
    const choices = [
      { id: "c1", name: "To do", color: "gray" },
      { id: "c2", name: "Done", color: "green" },
    ];
    const props = {
      long: await addProperty(base.id, "Long", "longText"),
      amount: await addProperty(base.id, "Amount", "number"),
      stage: await addProperty(base.id, "Stage", "select", { choices }),
      state: await addProperty(base.id, "State", "status", { choices: [{ id: "s1", name: "Open", category: "todo" }, { id: "s2", name: "Closed", category: "complete" }] }),
      tags: await addProperty(base.id, "Tags", "multiSelect", { choices: [{ id: "t1", name: "Alpha" }, { id: "t2", name: "Beta" }, { id: "t3", name: "Gamma" }] }),
      due: await addProperty(base.id, "Due", "date"),
      people: await addProperty(base.id, "People", "person", { allowMultiple: true }),
      files: await addProperty(base.id, "Files", "file"),
      page: await addProperty(base.id, "Page", "page"),
      done: await addProperty(base.id, "Done", "checkbox"),
      url: await addProperty(base.id, "Link", "url"),
      email: await addProperty(base.id, "Mail", "email"),
      created: await addProperty(base.id, "Created", "createdAt"),
      edited: await addProperty(base.id, "Edited", "lastEditedAt"),
      editor: await addProperty(base.id, "Editor", "lastEditedBy"),
      double: await addProperty(base.id, "Double", "formula", { source: 'prop("Amount") * 2' }),
      label: await addProperty(base.id, "Label", "formula", { source: 'IF(prop("Amount") > 5, "big", "small")' }),
    };
    const full = await owner.post(`/bases/${base.id}/rows`, {
      cells: {
        [title.id]: "Full row",
        [first.id]: "text",
        [second.id]: "ünï 文 😀",
        [props.long.id]: "long text",
        [props.amount.id]: 12.5,
        [props.stage.id]: "c2",
        [props.state.id]: "s1",
        [props.tags.id]: ["t3", "t1"],
        [props.due.id]: "2026-03-04",
        [props.people.id]: [member.user.id, ownerId],
        [props.files.id]: [
          { id: "f1", fileName: "spec.pdf", url: "/api/files/x/spec.pdf" },
          { id: "f2", fileName: "photo.png" },
        ],
        [props.page.id]: related.id,
        [props.done.id]: true,
        [props.url.id]: "https://example.com/path?q=1",
        [props.email.id]: "someone@example.com",
      },
    });
    expect(full.status).toBe(200);
    const sparse = await owner.post(`/bases/${base.id}/rows`, { cells: { [props.amount.id]: 0.1 + 0.2, [props.page.id]: untitledPage.id, [props.people.id]: [crypto.randomUUID()] } });
    expect(sparse.status).toBe(200);
    const empty = await writer.post(`/bases/${base.id}/rows`, { cells: {} });
    expect(empty.status).toBe(200);
    const rows = [full.body.data, sparse.body.data, empty.body.data] as { createdAt: string; updatedAt: string }[];

    const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
    const headers = ["Title", "Text 1", "Text 2", "Long", "Amount", "Stage", "State", "Tags", "Due", "People", "Files", "Page", "Done", "Link", "Mail", "Created", "Edited", "Editor", "Double", "Label"];
    const expected = [
      ["Full row", "text", "ünï 文 😀", "long text", "12.5", "Done", "Open", "Gamma, Alpha", "2026-03-04", "export-person, Owner", "spec.pdf, photo.png", "Related page", "true", "https://example.com/path?q=1", "someone@example.com", rows[0]!.createdAt, rows[0]!.updatedAt, "Owner", "25", "big"],
      // 0.1 + 0.2 reads 0.3; a page without a title is `Untitled`; an unknown person has no name.
      ["", "", "", "", "0.3", "", "", "", "", "", "", "Untitled", "false", "", "", rows[1]!.createdAt, rows[1]!.updatedAt, "Owner", "0.6", "small"],
      ["", "", "", "", "", "", "", "", "", "", "", "", "false", "", "", rows[2]!.createdAt, rows[2]!.updatedAt, "export-writer", "0", "small"],
    ];
    const markdown = await download(`/pages/${base.id}/export`);
    expect(markdown.text).toBe(["# Every type", "", line(headers), line(headers.map(() => "---")), ...expected.map(line)].join("\n") + "\n");
    expect(rows[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // A reader who cannot read the related page's space still sees its title here (same space); names come from the exporting user's view.
    const html = await download(`/pages/${base.id}/export?format=html`, reader);
    expect(html.text).toContain(`<tr>${expected[0]!.map((cell) => `<td>${cell}</td>`).join("")}</tr>`);
  });

  test("a base among exported pages is a table in the archive, and may have pages below it", async () => {
    const root = await newPage("Project");
    const base = await newBase("Board", { parentId: root.id });
    await newPage("Notes under the base", { parentId: base.id, content: docOf(paragraph(link("the base", `/p/${base.slugId}`))) });
    const { entries } = await zipOf(`/pages/${root.id}/export?children=1`);
    expect(names(entries)).toEqual(["Project.md", "Project/Board.md", "Project/Board/Notes under the base.md"]);
    expect(entry(entries, "Project/Board.md").text).toBe("# Board\n\n| Title | Text 1 | Text 2 |\n| --- | --- | --- |\n|  |  |  |\n");
    expect(entry(entries, "Project/Board/Notes under the base.md").text).toBe("# Notes under the base\n\n[the base](../../Project/Board.md)\n");
    const html = await zipOf(`/pages/${root.id}/export?children=1&format=html`);
    expect(entry(html.entries, "Project/Board.html").text).toBe(
      htmlPage("Board", "<table>\n<thead><tr><th>Title</th><th>Text 1</th><th>Text 2</th></tr></thead>\n<tbody>\n<tr><td></td><td></td><td></td></tr>\n</tbody>\n</table>"),
    );
  });
});

describe("limits and configuration of exports", () => {
  test("a base is exported with at most 10,000 rows", async () => {
    const created = await owner.post("/bases", { spaceId, title: "Huge base" });
    const base = created.body.data.page as PageRef;
    await t.sql`DELETE FROM base_rows WHERE page_id = ${base.id}`;
    await t.sql`
      INSERT INTO base_rows (page_id, cells, position)
      SELECT ${base.id}, '{}'::jsonb, 'n' || lpad(i::text, 6, '0') FROM generate_series(1, 10001) AS i`;
    const res = await download(`/pages/${base.id}/export`);
    expect(res.status).toBe(200);
    const lines = res.text.split("\n");
    // Heading, blank line, header, separator, 10,000 rows, and the final line break.
    expect(lines.length).toBe(4 + 10_000 + 1);
    expect(lines[3]).toBe("| --- | --- | --- |");
    expect(lines[10_003]).toBe("|  |  |  |");
    expect(lines[10_004]).toBe("");
  }, 30_000);

  test("absolute URLs in exports and share URLs follow APP_URL, without its trailing slashes", async () => {
    const elsewhere = await startServer({ keepDatabase: true, env: { APP_URL: "https://wiki.example.com/docs///" } });
    try {
      const client = elsewhere.client();
      client.cookie = owner.cookie;
      const target = await newPage("Linked from afar");
      const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
      const page = await newPage("Configured", {
        content: docOf(paragraph(link("page", `/p/${target.slugId}`), text(" "), link("unknown", "/p/0000000000")), { type: "image", attrs: { src: `/api/files/${id}/a.png` } }),
      });
      const res = await download(`/pages/${page.id}/export`, client);
      expect(res.text).toBe(
        `# Configured\n\n[page](https://wiki.example.com/docs/s/general/p/linked-from-afar-${target.slugId}) [unknown](https://wiki.example.com/docs/)\n\n` +
          `![](https://wiki.example.com/docs/api/files/${id}/a.png)\n`,
      );
      const shared = await owner.post(`/pages/${page.id}/share`, {});
      const key = shared.body.data.share.key as string;
      expect(shared.body.data.share.url).toBe(`http://doc.test/share/${key}/p/configured-${page.slugId}`);
      const seen = await client.get(`/pages/${page.id}/share`);
      expect(seen.body.data.share.url).toBe(`https://wiki.example.com/docs/share/${key}/p/configured-${page.slugId}`);
      const publicly = await elsewhere.client().get(`/public/shares/${key}`);
      expect(publicly.body.data.share.url).toBe(`https://wiki.example.com/docs/share/${key}/p/configured-${page.slugId}`);
    } finally {
      await elsewhere.close();
    }
  });
});
