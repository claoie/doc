import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Client, type TestServer } from "./harness";
import { NO_SUCH_ID, createPage, createSpace, data, docOf, expectError, expectInvalid, paragraph, text } from "./harness/spaces-pages";

let t: TestServer;
let owner: Client;
let ownerUser: any;
let spaceId: string;

const create = (content: unknown, extra: Record<string, unknown> = {}) => owner.post("/pages", { spaceId, content, ...extra });

/** Sends a body built as a string, for documents too large to build as objects cheaply. */
const createRaw = async (contentJson: string) => {
  const res = await owner.raw("POST", "/pages", { body: `{"spaceId":"${spaceId}","content":${contentJson}}`, headers: { "Content-Type": "application/json" } });
  return { status: res.status, body: await res.json() };
};

const textContent = async (pageId: string) => (await t.sql`SELECT text_content FROM pages WHERE id = ${pageId}`)[0].text_content as string;

const purge = async (pageId: string) => data(await owner.post(`/pages/${pageId}/delete-permanently`));

beforeAll(async () => {
  t = await startServer();
  ({ owner, user: ownerUser, spaceId } = await t.setupOwner());
});

afterAll(async () => {
  await t.close();
});

describe("document validation at POST /pages", () => {
  test("every node must be an object", async () => {
    for (const content of ["a string", 5, true, [], [{ type: "doc" }]]) expectInvalid(await create(content), "content has an invalid node");
    for (const child of [null, "text", 7, [], [paragraph()]]) {
      expectInvalid(await create(docOf(paragraph(), child)), "content has an invalid node");
      expectInvalid(await create(docOf({ type: "blockquote", content: [paragraph(child)] })), "content has an invalid node");
    }
  });

  test("every node needs a type the editor knows", async () => {
    for (const node of [{}, { type: "nope" }, { type: 5 }, { type: null }, { type: "Doc" }, { type: "DOC" }, { type: "" }, { type: " paragraph" }, { text: "no type" }]) {
      expectInvalid(await create(node), "content has an unknown node type");
      expectInvalid(await create(docOf(paragraph(text("fine")), node)), "content has an unknown node type");
    }
  });

  test("attrs, when present, must be an object", async () => {
    for (const attrs of [null, "x", 5, [], [1], true, false, 0, ""]) {
      expectInvalid(await create({ type: "doc", attrs, content: [paragraph()] }), "content has invalid attributes");
      expectInvalid(await create(docOf({ type: "heading", attrs, content: [] })), "content has invalid attributes");
    }
    expect((await create(docOf({ type: "heading", attrs: {}, content: [] }))).status).toBe(200);
  });

  test("text, when present, must be a string", async () => {
    for (const value of [5, null, true, ["a"], { a: 1 }]) {
      expectInvalid(await create(docOf(paragraph({ type: "text", text: value }))), "content has invalid text");
      // On any node, not only on text nodes.
      expectInvalid(await create(docOf({ type: "paragraph", text: value })), "content has invalid text");
    }
  });

  test("marks, when present, must be a list of marks the editor knows", async () => {
    for (const marks of ["bold", {}, null, 5, true]) {
      expectInvalid(await create(docOf(paragraph({ type: "text", text: "x", marks }))), "content has invalid marks");
    }
    for (const mark of [null, "bold", 5, [], {}, { type: "nope" }, { type: 5 }, { type: "Bold" }, { attrs: { href: "x" } }]) {
      expectInvalid(await create(docOf(paragraph({ type: "text", text: "x", marks: [{ type: "bold" }, mark] }))), "content has an unknown mark");
    }
    expect((await create(docOf(paragraph({ type: "text", text: "x", marks: [] })))).status).toBe(200);
  });

  test("content, when present, must be a list", async () => {
    for (const content of ["x", {}, null, 5, true, { 0: paragraph() }]) {
      expectInvalid(await create({ type: "doc", content }), "content has invalid content");
      expectInvalid(await create(docOf({ type: "paragraph", content })), "content has invalid content");
    }
  });

  test("the root must be a doc node", async () => {
    for (const root of [paragraph(text("x")), { type: "text", text: "x" }, { type: "blockquote", content: [paragraph()] }, { type: "footnotes" }]) {
      expectInvalid(await create(root), "content must be a doc node");
    }
  });

  test("the first problem met, top down and in document order, is the one reported", async () => {
    // Within one node: type, attrs, text, marks, content.
    expectInvalid(await create(docOf({ type: "nope", attrs: 1, text: 2, marks: 3, content: 4 })), "content has an unknown node type");
    expectInvalid(await create(docOf({ type: "paragraph", attrs: 1, text: 2, marks: 3, content: 4 })), "content has invalid attributes");
    expectInvalid(await create(docOf({ type: "paragraph", text: 2, marks: 3, content: 4 })), "content has invalid text");
    expectInvalid(await create(docOf({ type: "paragraph", marks: 3, content: 4 })), "content has invalid marks");
    expectInvalid(await create(docOf({ type: "paragraph", marks: [{ type: "x" }], content: 4 })), "content has an unknown mark");
    expectInvalid(await create(docOf({ type: "paragraph", content: 4 })), "content has invalid content");
    // A parent's own fields before its children; an earlier sibling's subtree before a later sibling.
    expectInvalid(await create(docOf({ type: "paragraph", marks: 3, content: [{ type: "nope" }] })), "content has invalid marks");
    expectInvalid(await create(docOf(paragraph({ type: "text", text: 1 }), { type: "nope" })), "content has invalid text");
    // The root's type is checked last of all.
    expectInvalid(await create({ type: "paragraph", content: [{ type: "nope" }] }), "content has an unknown node type");
  });

  test("nodes may be nested 100 levels under the root, no deeper", async () => {
    const nested = (levels: number, innermost: unknown) => {
      let node = innermost;
      for (let i = 0; i < levels; i++) node = { type: "blockquote", content: [node] };
      return docOf(node);
    };
    // 99 blockquotes and a paragraph: the paragraph is at depth 100.
    const deepest = nested(99, { type: "paragraph" });
    const ok = await create(deepest);
    expect(ok.status).toBe(200);
    expect(ok.body.data.page.content).toEqual(deepest);
    expectInvalid(await create(nested(100, { type: "paragraph" })), "content is nested too deeply");
    expectInvalid(await create(nested(99, paragraph(text("one level more")))), "content is nested too deeply");
    // Depth is checked before the node itself.
    expectInvalid(await create(nested(100, "not a node")), "content is nested too deeply");
  });

  test("a document may hold 200 000 nodes, no more", async () => {
    const withTexts = (n: number) => `{"type":"doc","content":[{"type":"paragraph","content":[${Array(n).fill('{"type":"text"}').join(",")}]}]}`;
    // The doc, the paragraph and 199 998 text nodes.
    const full = await createRaw(withTexts(199_998));
    expect(full.status).toBe(200);
    expect(full.body.data.page.content.content[0].content).toHaveLength(199_998);
    await purge(full.body.data.page.id);
    expect(await createRaw(withTexts(199_999))).toEqual({ status: 400, body: { error: { code: "invalid_input", message: "content is too large" } } });
  }, 30_000);

  test("a document may span 2 000 000 positions, counted like the editor: UTF-16 units of text, one per leaf, two per other node", async () => {
    const withText = (value: string) => `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${value}"}]}]}`;
    const tooLarge = { status: 400, body: { error: { code: "invalid_input", message: "content is too large" } } };
    // The paragraph takes two positions.
    const full = await createRaw(withText("x".repeat(1_999_998)));
    expect(full.status).toBe(200);
    await purge(full.body.data.page.id);
    expect(await createRaw(withText("x".repeat(1_999_999)))).toEqual(tooLarge);
    // An emoji is two units.
    const emoji = await createRaw(withText("😀".repeat(999_999)));
    expect(emoji.status).toBe(200);
    await purge(emoji.body.data.page.id);
    expect(await createRaw(withText("😀".repeat(1_000_000)))).toEqual(tooLarge);
    // Leaves count one: 1 999 995 units of text, a hard break and an image inside the paragraph, and a rule after it.
    const leaves = (n: number) =>
      `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${"x".repeat(n)}"},{"type":"hardBreak"}]},{"type":"horizontalRule"},{"type":"paragraph"}]}`;
    const mixed = await createRaw(leaves(1_999_994));
    expect(mixed.status).toBe(200);
    await purge(mixed.body.data.page.id);
    expect(await createRaw(leaves(1_999_995))).toEqual(tooLarge);
  }, 30_000);

  test("a document that is well-formed but breaks the editor's schema is accepted as it is", async () => {
    const odd = [
      { type: "doc" },
      { type: "doc", content: [] },
      docOf(text("text directly in the doc")),
      docOf({ type: "listItem", content: [text("an item without a list")] }),
      docOf({ type: "table", content: [paragraph(text("not a row"))] }),
      docOf({ type: "doc", content: [{ type: "doc" }] }),
      docOf({ type: "codeBlock", content: [text("marked code", [{ type: "bold" }])] }),
      docOf({ type: "horizontalRule", content: [paragraph(text("inside a leaf"))] }),
      docOf({ type: "heading", attrs: { level: 99, unknown: { nested: [1, 2.5, "x", null, true] } }, content: [text("")] }),
      docOf(paragraph({ type: "text" }, { type: "text", text: "" }, { type: "hardBreak", text: "text on a leaf", marks: [{ type: "bold" }, { type: "bold" }] })),
      docOf(paragraph(text("x", [{ type: "link" }, { type: "link", attrs: "not an object" }, { type: "comment", attrs: null }]))),
      { type: "doc", content: [paragraph()], extra: "kept", version: 3 },
      docOf({ type: "footnotes" }, { type: "footnotes" }),
    ];
    for (const content of odd) {
      const res = await create(content);
      expect(res.status).toBe(200);
      expect(res.body.data.page.content).toEqual(content);
      expect(data(await owner.get(`/pages/${res.body.data.page.id}`)).page.content).toEqual(content);
    }
  });

  test("names of JavaScript object members pass as node and mark types", async () => {
    // Accident: the known types are looked up with `in`, which also finds what every object inherits.
    const content = docOf(
      { type: "toString" },
      { type: "constructor", content: [text("x", [{ type: "valueOf" }, { type: "hasOwnProperty" }])] },
      { type: "__proto__", attrs: { a: 1 } },
      { type: "isPrototypeOf" },
    );
    const res = await create(content);
    expect(res.status).toBe(200);
    expect(res.body.data.page.content).toEqual(content);
    expect(await textContent(res.body.data.page.id)).toBe("x");
    expectInvalid(await create({ type: "toString" }), "content must be a doc node");
  });

  test("numbers, booleans, nested values and unknown attributes come back as sent", async () => {
    const content = docOf({
      type: "paragraph",
      attrs: { int: 42, negative: -7, float: 1.5, exp: 1e21, small: 1e-7, big: 9007199254740991, yes: true, no: false, nothing: null, list: [1, [2, { three: 3 }]], empty: {}, "": "empty key", "ключ": "значение", "🔑": "🗝️" },
      content: [text("Ünïcödé — 日本語 — עברית — \u200d\u200b — 👩‍👩‍👧‍👦 — \\ \" / \b\f\n\r\t — \u2028\u2029")],
    });
    const res = await create(content);
    expect(res.status).toBe(200);
    expect(res.body.data.page.content).toEqual(content);
  });
});

describe("URL attributes are made safe", () => {
  const hrefs: [unknown, unknown][] = [
    ["https://example.com/a?b=1#c", "https://example.com/a?b=1#c"],
    ["HTTP://EXAMPLE.COM", "HTTP://EXAMPLE.COM"],
    ["https:example.com", "https:example.com"],
    ["mailto:someone@example.com", "mailto:someone@example.com"],
    ["MailTo:someone@example.com", "MailTo:someone@example.com"],
    ["tel:+15551234", "tel:+15551234"],
    ["/s/general/p/page-abc", "/s/general/p/page-abc"],
    ["#heading", "#heading"],
    ["?q=1", "?q=1"],
    ["relative/path", "relative/path"],
    ["./here", "./here"],
    ["//other.example/path", "//other.example/path"],
    ["/path?next=javascript:alert(1)", "/path?next=javascript:alert(1)"],
    ["1a:not-a-scheme", "1a:not-a-scheme"],
    ["mailto", "mailto"],
    ["", ""],
    // Surrounding whitespace is dropped from what is kept.
    ["  https://example.com/trim  ", "https://example.com/trim"],
    ["\t/relative\n", "/relative"],
    ["   ", ""],
    // Anything with another scheme is emptied, however it is spelled.
    ["javascript:alert(1)", ""],
    [" JavaScript:alert(1)", ""],
    ["java\tscript:alert(1)", ""],
    ["java\nscript:alert(1)", ""],
    ["java\u0000script:alert(1)", ""],
    ["j a v a s c r i p t:alert(1)", ""],
    ["vbscript:msgbox(1)", ""],
    ["data:text/html,<script>alert(1)</script>", ""],
    ["data:image/png;base64,AAAA", ""],
    ["file:///etc/passwd", ""],
    ["ftp://example.com/file", ""],
    ["blob:https://example.com/1", ""],
    ["httpsx://example.com", ""],
    ["x-custom+scheme.v1:thing", ""],
    ["C:\\Windows\\system32", ""],
    // A colon after a word reads as a scheme, even in what was meant as text.
    ["note: see below", ""],
    // Values that are not strings are emptied; null is left alone.
    [5, ""],
    [true, ""],
    [{ a: 1 }, ""],
    [["https://example.com"], ""],
    [null, null],
  ];

  test("on link marks: http, https, mailto, tel and relative URLs are kept, everything else is emptied", async () => {
    const content = docOf(paragraph(...hrefs.map(([href], i) => text(`link ${i}`, [{ type: "link", attrs: { href, target: "_blank" } }]))));
    const res = await create(content);
    expect(res.status).toBe(200);
    const stored = res.body.data.page.content.content[0].content;
    expect(stored.map((node: any) => node.marks[0].attrs.href)).toEqual(hrefs.map(([, clean]) => clean));
    // Nothing else about the marks changes.
    expect(stored.map((node: any) => [node.text, node.marks.length, node.marks[0].type, node.marks[0].attrs.target])).toEqual(hrefs.map((_, i) => [`link ${i}`, 1, "link", "_blank"]));
  });

  test("on nodes: `src`, `url` and `href` attributes are treated the same way", async () => {
    for (const key of ["src", "url", "href"]) {
      const content = docOf(...hrefs.map(([value]) => ({ type: "pdf", attrs: { [key]: value, name: null } })));
      const res = await create(content);
      expect(res.status).toBe(200);
      expect(res.body.data.page.content.content.map((node: any) => node.attrs[key])).toEqual(hrefs.map(([, clean]) => clean));
    }
  });

  test("data: images are allowed on image, drawio and excalidraw nodes only", async () => {
    const kept = [
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/jpeg;base64,/9j/4AAQ",
      "data:image/jpg;base64,/9j/4AAQ",
      "data:image/gif;base64,R0lGODlh",
      "data:image/webp;base64,UklGRg==",
      "data:image/avif;base64,AAAA",
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>",
      "DATA:IMAGE/PNG;base64,AAAA",
      " data:image/png;base64,AAAA",
    ];
    const dropped = ["data:image/bmp;base64,Qk0=", "data:image/png,no-semicolon", "data:image/svg;base64,AAAA", "data:text/html;base64,AAAA", "data:application/pdf;base64,AAAA", "data:,plain", "javascript:alert(1)"];
    for (const type of ["image", "drawio", "excalidraw"]) {
      const res = await create(docOf(...[...kept, ...dropped].map((src) => ({ type, attrs: { src } }))));
      expect(res.body.data.page.content.content.map((node: any) => node.attrs.src)).toEqual([...kept.map((src) => src.trim()), ...dropped.map(() => "")]);
    }
    for (const type of ["video", "audio", "pdf", "embed", "youtube", "paragraph", "attachment"]) {
      const res = await create(docOf(...kept.map((src) => ({ type, attrs: { src, url: src } }))));
      expect(res.body.data.page.content.content.map((node: any) => [node.attrs.src, node.attrs.url])).toEqual(kept.map(() => ["", ""]));
    }
    // An image's other URL attributes get no such allowance on marks.
    const marked = await create(docOf(paragraph(text("x", [{ type: "link", attrs: { href: kept[0] } }]))));
    expect(marked.body.data.page.content.content[0].content[0].marks[0].attrs.href).toBe("");
  });

  test("the cleaning reaches every node and every mark, and touches nothing else", async () => {
    const bad = "javascript:alert(document.cookie)";
    const content = docOf(
      { type: "paragraph", attrs: { href: bad, id: "p1" }, content: [text("a", [{ type: "bold", attrs: { src: bad, url: bad, keep: bad } }, { type: "link", attrs: { href: "https://ok.example/" } }])] },
      {
        type: "table",
        content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "image", attrs: { src: bad, alt: bad, poster: bad, srcset: bad, link: bad, "xlink:href": bad, HREF: bad } }] }] }],
      },
      { type: "footnotes", content: [{ type: "footnote", content: [paragraph({ type: "footnoteReference", attrs: { href: bad, "data-id": "fn" } })] }] },
      { type: "attachment", attrs: { url: bad, name: bad } },
      { type: "embed", attrs: { src: "https://ok.example/embed", provider: bad } },
    );
    const res = await create(content);
    expect(res.status).toBe(200);
    expect(res.body.data.page.content).toEqual(
      docOf(
        { type: "paragraph", attrs: { href: "", id: "p1" }, content: [text("a", [{ type: "bold", attrs: { src: "", url: "", keep: bad } }, { type: "link", attrs: { href: "https://ok.example/" } }])] },
        {
          type: "table",
          // Only the three attribute names, spelled exactly so, are URLs to the server.
          content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "image", attrs: { src: "", alt: bad, poster: bad, srcset: bad, link: bad, "xlink:href": bad, HREF: bad } }] }] }],
        },
        { type: "footnotes", content: [{ type: "footnote", content: [paragraph({ type: "footnoteReference", attrs: { href: "", "data-id": "fn" } })] }] },
        { type: "attachment", attrs: { url: "", name: bad } },
        { type: "embed", attrs: { src: "https://ok.example/embed", provider: bad } },
      ),
    );
    expect(await textContent(res.body.data.page.id)).toBe(`a\n${bad}`);
  });
});

describe("a document with every kind of node and mark", () => {
  test("comes back exactly as sent, and is indexed for search, links and synced blocks", async () => {
    const target = await createPage(owner, { spaceId, title: "Mentioned page" });
    const linked = await createPage(owner, { spaceId, title: "Linked page" });
    const fileId = "11111111-2222-4333-8444-555555555555";
    const cell = (type: string, value: string, attrs: Record<string, unknown> = {}) => ({
      type,
      attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null, backgroundColorName: null, ...attrs },
      content: [paragraph(text(value))],
    });
    const synced = [paragraph(text("synced text")), { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("synced item"))] }] }];
    const content = {
      type: "doc",
      content: [
        { type: "heading", attrs: { id: "h-1", level: 1, textAlign: "center", indent: 0 }, content: [text("Everything")] },
        {
          type: "paragraph",
          attrs: { id: "p-1", textAlign: null, indent: 1 },
          content: [
            text("plain "),
            text("bold ", [{ type: "bold" }]),
            text("italic ", [{ type: "italic" }]),
            text("underline ", [{ type: "underline" }]),
            text("strike ", [{ type: "strike" }]),
            text("code ", [{ type: "code" }]),
            text("highlight ", [{ type: "highlight", attrs: { color: "#fff3bf", colorName: "yellow" } }]),
            text("coloured ", [{ type: "textStyle", attrs: { color: "#e03131" } }]),
            text("sub ", [{ type: "subscript" }]),
            text("super ", [{ type: "superscript" }]),
            text("commented ", [{ type: "comment", attrs: { commentId: NO_SUCH_ID, resolved: false } }, { type: "comment", attrs: { commentId: "second", resolved: true } }]),
            text("external ", [{ type: "link", attrs: { href: "https://example.com/a?b=1#c", target: "_blank", rel: "noopener noreferrer nofollow", class: null, internal: false } }]),
            text("internal ", [{ type: "bold" }, { type: "italic" }, { type: "link", attrs: { href: `/s/general/p/linked-page-${linked.slugId}`, target: null, rel: null, class: "internal", internal: true } }]),
            { type: "hardBreak" },
            { type: "mention", attrs: { id: "m-1", label: "Mentioned page", entityType: "page", entityId: target.id, slugId: target.slugId, creatorId: ownerUser.id, anchorId: null } },
            text(" "),
            { type: "mention", attrs: { id: "m-2", label: "Owner", entityType: "user", entityId: ownerUser.id, slugId: null, creatorId: ownerUser.id, anchorId: null } },
            text(" "),
            { type: "mathInline", attrs: { text: "x^2" } },
            text(" "),
            { type: "status", attrs: { text: "DONE", color: "green" } },
            { type: "footnoteReference", attrs: { class: "footnote-ref", "data-id": "fn-1", referenceNumber: 1, href: "#fn-1" } },
          ],
        },
        { type: "blockquote", content: [paragraph(text("quoted"))] },
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [paragraph(text("bullet")), { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("nested bullet"))] }] }] }],
        },
        { type: "orderedList", attrs: { start: 3, type: "a" }, content: [{ type: "listItem", content: [paragraph(text("third"))] }] },
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: true }, content: [paragraph(text("done task"))] },
            { type: "taskItem", attrs: { checked: false }, content: [paragraph(text("open task"))] },
          ],
        },
        { type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = 1;\n  const b = 2;")] },
        { type: "horizontalRule" },
        { type: "pageBreak" },
        { type: "image", attrs: { src: `/api/files/${fileId}/pic.png`, width: 640, height: 480, align: "center", alt: "A picture", attachmentId: fileId, size: 1234, aspectRatio: 1.3333 } },
        { type: "video", attrs: { src: "https://example.com/v.mp4", alt: null, attachmentId: null, width: null, height: null, size: null, align: "left", aspectRatio: null } },
        { type: "audio", attrs: { src: "https://example.com/a.mp3", attachmentId: null, size: 99 } },
        { type: "attachment", attrs: { url: `/api/files/${fileId}/report.pdf`, name: "report.pdf", mime: "application/pdf", size: 2048, attachmentId: fileId } },
        { type: "pdf", attrs: { src: `/api/files/${fileId}/paper.pdf`, name: "paper.pdf", attachmentId: fileId, size: 4096, width: 800, height: 600 } },
        { type: "drawio", attrs: { src: "data:image/svg+xml;base64,PHN2Zy8+", title: "Diagram", alt: null, width: 300, height: 200, size: 10, aspectRatio: 1.5, align: "center", attachmentId: null } },
        { type: "excalidraw", attrs: { src: "data:image/png;base64,iVBORw0KGgo=", title: "Sketch", alt: "sketch", width: null, height: null, size: null, aspectRatio: null, align: "right", attachmentId: null } },
        {
          type: "table",
          content: [
            { type: "tableRow", content: [cell("tableHeader", "Head A", { colwidth: [120] }), cell("tableHeader", "Head B", { backgroundColor: "#eee", backgroundColorName: "gray" })] },
            { type: "tableRow", content: [cell("tableCell", "Cell A", { colspan: 2 })] },
          ],
        },
        { type: "callout", attrs: { type: "warning", icon: "⚠️" }, content: [paragraph(text("careful"))] },
        {
          type: "details",
          attrs: { open: true },
          content: [
            { type: "detailsSummary", content: [text("Summary")] },
            { type: "detailsContent", content: [paragraph(text("hidden"))] },
          ],
        },
        {
          type: "columns",
          attrs: { layout: "two_equal", widthMode: "normal" },
          content: [
            { type: "column", attrs: { width: 50 }, content: [paragraph(text("left"))] },
            { type: "column", attrs: { width: null }, content: [paragraph(text("right"))] },
          ],
        },
        { type: "transclusionSource", attrs: { id: "sync-1" }, content: synced },
        { type: "transclusionReference", attrs: { sourcePageId: target.id, transclusionId: "elsewhere" } },
        { type: "mathBlock", attrs: { text: "E = mc^2" } },
        { type: "embed", attrs: { src: "https://example.com/embed/1", provider: "iframe", align: "center", width: 800, height: 600 } },
        { type: "youtube", attrs: { src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", start: 42, width: 640, height: 480 } },
        { type: "subpages" },
        { type: "base", attrs: { pageId: null } },
        { type: "paragraph", attrs: { id: null, textAlign: "right", indent: 0 } },
        { type: "footnotes", attrs: { class: "footnotes" }, content: [{ type: "footnote", attrs: { id: "fn-1", "data-id": "fn-1" }, content: [paragraph(text("a footnote"))] }] },
      ],
    };
    const res = await create(content, { title: "All of it" });
    expect(res.status).toBe(200);
    const page = res.body.data.page;
    expect(page.content).toEqual(content);
    expect(data(await owner.get(`/pages/${page.slugId}`)).page.content).toEqual(content);
    const types = new Set<string>();
    const marks = new Set<string>();
    const walk = (node: any) => {
      types.add(node.type);
      for (const mark of node.marks ?? []) marks.add(mark.type);
      for (const child of node.content ?? []) walk(child);
    };
    walk(page.content);
    // Every node and mark of the editor's schema is in there.
    expect([...types].sort()).toEqual([
      "attachment", "audio", "base", "blockquote", "bulletList", "callout", "codeBlock", "column", "columns", "details", "detailsContent",
      "detailsSummary", "doc", "drawio", "embed", "excalidraw", "footnote", "footnoteReference", "footnotes", "hardBreak", "heading",
      "horizontalRule", "image", "listItem", "mathBlock", "mathInline", "mention", "orderedList", "pageBreak", "paragraph", "pdf", "status",
      "subpages", "table", "tableCell", "tableHeader", "tableRow", "taskItem", "taskList", "text", "transclusionReference",
      "transclusionSource", "video", "youtube",
    ]);
    expect([...marks].sort()).toEqual(["bold", "code", "comment", "highlight", "italic", "link", "strike", "subscript", "superscript", "textStyle", "underline"]);

    expect(await textContent(page.id)).toBe(
      [
        "Everything",
        "plain bold italic underline strike code highlight coloured sub super commented external internal \nMentioned page Owner x^2 DONE",
        "quoted",
        "bullet",
        "nested bullet",
        "third",
        "done task",
        "open task",
        "const a = 1;\n  const b = 2;",
        "report.pdf",
        "paper.pdf",
        "Head A",
        "Head B",
        "Cell A",
        "careful",
        "Summary",
        "hidden",
        "left",
        "right",
        "synced text",
        "synced item",
        "E = mc^2",
        "a footnote",
      ].join("\n"),
    );
    expect(data(await owner.get(`/pages/${page.id}/links`)).map((p: any) => p.id)).toEqual([linked.id, target.id]);
    const blocks = await t.sql`SELECT block_id, content FROM synced_blocks WHERE page_id = ${page.id}`;
    expect(blocks).toEqual([{ block_id: "sync-1", content: synced }]);
    expect(data(await owner.post("/synced-blocks/lookup", { refs: [{ pageId: page.id, blockId: "sync-1" }] }))).toEqual([{ pageId: page.id, blockId: "sync-1", content: synced }]);
    // Search finds it by words from any block.
    for (const q of ["everything", "nested bullet", "footnote", "paper.pdf", "mc"]) {
      expect(data(await owner.get(`/search?q=${encodeURIComponent(q)}`)).map((r: any) => r.id)).toEqual([page.id]);
    }
  });
});

describe("the text derived from a document", () => {
  const derived = async (...content: unknown[]) => textContent((await createPage(owner, { spaceId, content: docOf(...content) })).id);

  test("has one line per block of text; blocks without text add nothing", async () => {
    expect(await derived(paragraph(text("one")), paragraph(), paragraph(text("   ")), { type: "horizontalRule" }, paragraph(text("two")))).toBe("one\ntwo");
    expect(await derived()).toBe("");
    expect(await derived(paragraph())).toBe("");
    // Leading and trailing blanks of a line are kept.
    expect(await derived(paragraph(text("  padded  ")), { type: "heading", content: [text("\ttabbed")] })).toBe("  padded  \n\ttabbed");
  });

  test("inline nodes read as text: a hard break is a newline, a mention its label, math and status their text", async () => {
    expect(
      await derived(
        paragraph(text("a"), { type: "hardBreak" }, text("b")),
        paragraph({ type: "hardBreak" }),
        paragraph({ type: "mention", attrs: { label: "Someone" } }, { type: "mention", attrs: { label: null } }, { type: "mention", attrs: {} }, { type: "mention" }, { type: "mention", attrs: { label: 42 } }),
        paragraph({ type: "mathInline", attrs: { text: "a+b" } }, { type: "mathInline" }, { type: "status", attrs: { text: "WIP" } }, { type: "status", attrs: { text: null } }),
        paragraph({ type: "footnoteReference", attrs: { referenceNumber: 1 } }, text("after a reference")),
      ),
    ).toBe("a\nb\nSomeone42\na+bWIP\nafter a reference");
  });

  test("code is one line with its newlines; math blocks, attachments and PDFs give their text or name", async () => {
    expect(
      await derived(
        { type: "codeBlock", content: [text("line 1\nline 2"), text("\nline 3")] },
        { type: "codeBlock" },
        { type: "codeBlock", content: [text("  \n  ")] },
        { type: "mathBlock", attrs: { text: "\\sum x" } },
        { type: "mathBlock", attrs: { text: "" } },
        { type: "mathBlock" },
        { type: "mathBlock", attrs: { text: 7 } },
        { type: "attachment", attrs: { name: "a.zip", url: "/x" } },
        { type: "attachment", attrs: { name: null } },
        { type: "pdf", attrs: { name: "b.pdf" } },
        { type: "pdf" },
        { type: "image", attrs: { alt: "not indexed", src: "/x.png" } },
      ),
    ).toBe("line 1\nline 2\nline 3\n\\sum x\n7\na.zip\nb.pdf");
  });

  test("containers are read through, in document order", async () => {
    expect(
      await derived(
        { type: "blockquote", content: [paragraph(text("q1")), { type: "blockquote", content: [paragraph(text("q2"))] }] },
        { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph(text("c1")), paragraph(text("c2"))] }, { type: "tableHeader", content: [paragraph(text("c3"))] }] }] },
        { type: "details", content: [{ type: "detailsSummary", content: [text("sum"), { type: "hardBreak" }, text("mary")] }, { type: "detailsContent", content: [] }] },
        // A block that mixes text and blocks is read block by block: the bare text is skipped.
        { type: "listItem", content: [text("skipped"), paragraph(text("kept"))] },
      ),
    ).toBe("q1\nq2\nc1\nc2\nc3\nsum\nmary\nkept");
  });
});

describe("the links indexed from a document", () => {
  let space: any;
  let targets: any[];

  beforeAll(async () => {
    space = await createSpace(owner, "Link forms", "link-forms");
    targets = [];
    for (let i = 0; i < 9; i++) targets.push(await createPage(owner, { spaceId: space.id, title: `T${i}` }));
  });

  const linksOf = async (...inline: unknown[]) => {
    const page = await createPage(owner, { spaceId: space.id, title: "Source", content: docOf(paragraph(...inline)) });
    return (data(await owner.get(`/pages/${page.id}/links`)) as any[]).map((p) => p.title);
  };
  const link = (href: unknown) => text("x", [{ type: "link", attrs: { href } }]);
  const mention = (attrs: Record<string, unknown>) => ({ type: "mention", attrs });

  test("page mentions link by entityId, or by slugId when there is no entityId", async () => {
    const [t0, t1, t2, t3, t4] = targets;
    expect(
      await linksOf(
        mention({ entityType: "page", entityId: t0.id }),
        mention({ entityType: "page", entityId: t1.id.toUpperCase() }),
        mention({ entityType: "page", slugId: t2.slugId }),
        mention({ entityType: "page", entityId: "", slugId: t3.slugId }),
        mention({ entityType: "page", entityId: null, slugId: t4.slugId }),
      ),
    ).toEqual(["T0", "T1", "T2", "T3", "T4"]);
    // An entityId wins over the slugId, even when it names nothing.
    expect(await linksOf(mention({ entityType: "page", entityId: NO_SUCH_ID, slugId: t0.slugId }))).toEqual([]);
    expect(await linksOf(mention({ entityType: "page", entityId: "not-an-id", slugId: t0.slugId }))).toEqual([]);
    // Other mentions, and mentions without a type, link nothing.
    expect(await linksOf(mention({ entityType: "user", entityId: t0.id }), mention({ entityId: t1.id, slugId: t1.slugId }), mention({ entityType: "Page", entityId: t2.id }))).toEqual([]);
    expect(await linksOf(mention({ entityType: "page", slugId: "nosuchslug" }), mention({ entityType: "page", slugId: 5 }), mention({ entityType: "page" }))).toEqual([]);
  });

  test("links to pages of the app link by the slugId that ends the path", async () => {
    const [t0, t1, t2, t3, t4, t5, t6, t7, t8] = targets;
    expect(
      await linksOf(
        link(`/s/link-forms/p/t0-${t0.slugId}`),
        link(`/p/${t1.slugId}`),
        link(`https://doc.test/s/link-forms/p/some-long-title-${t2.slugId}#heading`),
        link(`http://another.host:8080/p/${t3.slugId}?x=1`),
        link(`/s/any-space-at-all/p/${t4.slugId}/`),
        link(`  /s/x/p/%ED%95%9C%EA%B8%80-${t5.slugId}  `),
        link(`/s/x/p/a-b-c-${t6.slugId}?q=1#h`),
        link(`/p/title-${t7.slugId}`),
        link(`/p/%2D${t8.slugId}`),
      ),
    ).toEqual(["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]);
  });

  test("other URLs link nothing", async () => {
    const [t0] = targets;
    expect(
      await linksOf(
        link(`https://example.com/blog/${t0.slugId}`),
        link(`/pages/${t0.slugId}`),
        link(`/s/link-forms/${t0.slugId}`),
        link(`/s/link-forms/p/title-${t0.slugId}/edit`),
        link(`/s/link-forms/p/${t0.slugId}-`),
        link(`/s/link-forms/p/t0_${t0.slugId}`),
        link(`/share/abc/p/t0-${t0.slugId}`),
        link(`/p/%E0%A4%A-${t0.slugId}`),
        link(`p/${t0.slugId}`),
        link(`mailto:${t0.slugId}@example.com`),
        link(`#${t0.slugId}`),
        link(null),
        link(5),
        text("x", [{ type: "bold", attrs: { href: `/p/${t0.slugId}` } }]),
        { type: "image", attrs: { src: `/p/${t0.slugId}` } },
      ),
    ).toEqual([]);
  });

  test("a page never links to itself, and each target is linked once", async () => {
    const [t0, t1] = targets;
    const first = await createPage(owner, { spaceId: space.id, title: "Self-aware" });
    // Its own id is known only once it exists: a second page mentions both, twice over.
    const source = await createPage(owner, {
      spaceId: space.id,
      title: "Repeats itself",
      content: docOf(
        paragraph(mention({ entityType: "page", entityId: t0.id }), mention({ entityType: "page", entityId: t0.id }), link(`/p/${t0.slugId}`), mention({ entityType: "page", slugId: t0.slugId })),
        { type: "blockquote", content: [paragraph(link(`/p/${t1.slugId}`), link(`/s/a/p/b-${t1.slugId}`), mention({ entityType: "page", entityId: first.id }))] },
      ),
    });
    expect(data(await owner.get(`/pages/${source.id}/links`)).map((p: any) => p.title)).toEqual(["Self-aware", "T0", "T1"]);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM page_links WHERE source_id = ${source.id}`;
    expect(n).toBe(3);
    // A duplicate of a page that links to the original is how a link to "itself" arises: the copy links to the original, not to itself.
    const selfLinking = await createPage(owner, { spaceId: space.id, title: "Loop", content: docOf(paragraph(mention({ entityType: "page", entityId: source.id }))) });
    const copy = data(await owner.post(`/pages/${source.id}/duplicate`)).page;
    expect(data(await owner.get(`/pages/${copy.id}/links`)).map((p: any) => p.title)).toEqual(["Self-aware", "T0", "T1"]);
    expect(data(await owner.get(`/pages/${source.id}/backlinks`)).map((p: any) => p.id)).toEqual([selfLinking.id]);
  });

  test("links may point into spaces the author cannot read; only readers of both ends see them", async () => {
    const hidden = await createSpace(owner, "Link hidden", "link-hidden");
    const secret = await createPage(owner, { spaceId: hidden.id, title: "Secret target" });
    const { client: author, user } = await t.addMember(owner, "link-author@example.com");
    data(await owner.post(`/spaces/${space.id}/members/add`, { role: "writer", userIds: [user.id] }));
    const source = await createPage(author, { spaceId: space.id, title: "Guesses an id", content: docOf(paragraph(mention({ entityType: "page", entityId: secret.id }))) });
    expect(data(await author.get(`/pages/${source.id}/links`))).toEqual([]);
    expect(data(await owner.get(`/pages/${source.id}/links`)).map((p: any) => p.title)).toEqual(["Secret target"]);
    expect(data(await owner.get(`/pages/${secret.id}/backlinks`)).map((p: any) => p.title)).toEqual(["Guesses an id"]);
  });
});

describe("the synced blocks indexed from a document", () => {
  test("every transclusionSource with a usable id is stored, wherever it sits", async () => {
    const source = (id: unknown, ...content: unknown[]) => ({ type: "transclusionSource", attrs: { id }, ...(content.length ? { content } : {}) });
    const page = await createPage(owner, {
      spaceId,
      title: "Synced sources",
      content: docOf(
        source("top", paragraph(text("top level"))),
        { type: "blockquote", content: [source("nested", paragraph(text("inside a quote")), source("inner", paragraph(text("inside another block"))))] },
        source("empty"),
        source("twice", paragraph(text("first"))),
        source("twice", paragraph(text("second"))),
        source("i".repeat(100), paragraph(text("longest id"))),
        source("i".repeat(101), paragraph(text("id too long"))),
        source("", paragraph(text("empty id"))),
        source(null, paragraph(text("null id"))),
        source(7, paragraph(text("numeric id"))),
        { type: "transclusionSource", content: [paragraph(text("no attrs"))] },
        { type: "transclusionReference", attrs: { sourcePageId: NO_SUCH_ID, transclusionId: "ref" } },
      ),
    });
    const rows = await t.sql`SELECT block_id, content FROM synced_blocks WHERE page_id = ${page.id} ORDER BY block_id`;
    expect(rows).toEqual([
      { block_id: "empty", content: [] },
      { block_id: "i".repeat(100), content: [paragraph(text("longest id"))] },
      { block_id: "inner", content: [paragraph(text("inside another block"))] },
      { block_id: "nested", content: [paragraph(text("inside a quote")), source("inner", paragraph(text("inside another block")))] },
      { block_id: "top", content: [paragraph(text("top level"))] },
      // When an id is used twice, the later block wins.
      { block_id: "twice", content: [paragraph(text("second"))] },
    ]);
    expect(data(await owner.post("/synced-blocks/lookup", { refs: [{ pageId: page.id, blockId: "empty" }, { pageId: page.id, blockId: "7" }] }))).toEqual([
      { pageId: page.id, blockId: "empty", content: [] },
      { pageId: page.id, blockId: "7", content: null },
    ]);
  });
});

describe("characters the database refuses", () => {
  test("a NUL character anywhere in a stored document is a server error", async () => {
    // Accident: PostgreSQL's jsonb refuses \u0000, and the failure surfaces as a 500.
    for (const content of [
      docOf(paragraph(text("a\u0000b"))),
      docOf({ type: "paragraph", attrs: { id: "\u0000" } }),
      docOf({ type: "paragraph", attrs: { "\u0000": 1 } }),
      docOf(paragraph(text("x", [{ type: "link", attrs: { href: "/ok", title: "\u0000" } }]))),
    ]) {
      expectError(await create(content), 500, "internal_error", "Something went wrong");
    }
  });

  test("an unpaired surrogate in a document is a server error too", async () => {
    // Accident: in a title the lone surrogate becomes U+FFFD (see pages.test.ts); inside the document PostgreSQL's jsonb refuses it.
    const res = await createRaw('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"half \\ud83d smile"}]}]}');
    expect(res).toEqual({ status: 500, body: { error: { code: "internal_error", message: "Something went wrong" } } });
  });
});
