import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, startServer, type Client, type Socket, type TestServer } from "./harness";
import { ERRORS, createPage, docOf, insertText, join, liveDoc, p, pushSteps, sendSteps, text, untilStored, type Step } from "./harness/realtime";

/**
 * What each kind of step does to a document, as seen over the socket: the
 * exact document after it, and the steps that are refused. Positions count
 * one for entering or leaving a node that has content, one per leaf node and
 * one per UTF-16 code unit of text; position 0 is the start of the document.
 */

let t: TestServer;
let owner: Client;
let spaceId: string;
const sockets: Socket[] = [];

type Node = Record<string, any>;

beforeAll(async () => {
  t = await startServer();
  ({ owner, spaceId } = await t.setupOwner());
});

afterAll(async () => {
  for (const socket of sockets) socket.ws.close();
  await t.close();
});

const open = async () => {
  const socket = await connect(owner);
  sockets.push(socket);
  return socket;
};

const about = (pageId: string) => (m: Record<string, any>) => m.pageId === pageId && m.t !== "presence";

/**
 * Applies `steps` to a new page holding `start` and returns the document the
 * server then holds: the one a client joining afresh is sent, which is also
 * the one that is stored once the editor has left.
 */
const apply = async (start: Node, steps: Step[], confirmedAs: Step[] = steps): Promise<Node> => {
  const { id } = await createPage(owner, spaceId, start);
  const socket = await open();
  await join(socket, id, 0);
  pushSteps(socket, id, 0, steps);
  const answer = await socket.next(about(id));
  expect(answer).toEqual({ t: "steps", pageId: id, version: steps.length, steps: confirmedAs, clientIds: steps.map(() => "a") });
  const live = await liveDoc(socket, id);
  expect(live.version).toBe(steps.length);
  await socket.close();
  for (let tries = 0; ; tries++) {
    const [row] = await t.sql`SELECT content, doc_version::int AS version FROM pages WHERE id = ${id}`;
    if (row.version === steps.length) {
      expect(row.content).toEqual(live.doc);
      break;
    }
    if (tries > 1000) throw new Error("the page was not saved after its editor left");
    await Bun.sleep(4);
  }
  return live.doc;
};

/** Expects `steps` to be refused on a page holding `start`, which stays as it was. */
const refused = async (label: string, start: Node, steps: Step[], message: string = ERRORS.invalidStep) => {
  const { id } = await createPage(owner, spaceId, start);
  const socket = await open();
  const watcher = await open();
  await join(socket, id, 0);
  await join(watcher, id, 0);
  pushSteps(socket, id, 0, steps);
  expect([label, await socket.next(about(id))]).toEqual([label, { t: "error", pageId: id, message }]);
  expect([label, await socket.next(about(id))]).toEqual([label, { t: "joined", pageId: id, version: 0, doc: start, readOnly: false }]);
  expect(watcher.inbox.filter(about(id))).toEqual([]);
  await socket.close();
  await watcher.close();
};

const PARA = { id: null, textAlign: null, indent: 0 };
const hello = () => docOf(p("hello"));
const two = () => docOf(p("hello"), p("world"));
const node = (type: string, attrs?: Node, content?: Node[]): Node => ({ type, ...(attrs ? { attrs } : {}), ...(content ? { content } : {}) });
const bold = { type: "bold" };
const italic = { type: "italic" };

describe("replace", () => {
  test("types text inside, before and after a paragraph's text", async () => {
    expect(await apply(hello(), [insertText(3, "XY")])).toEqual(docOf(p("heXYllo")));
    expect(await apply(hello(), [insertText(1, "<"), insertText(7, ">")])).toEqual(docOf(p("<hello>")));
    expect(await apply(docOf(p()), [insertText(1, "a")])).toEqual(docOf(p("a")));
    // A step that inserts nothing changes nothing, and still counts as a version.
    expect(await apply(hello(), [insertText(3, "")])).toEqual(hello());
    expect(await apply(hello(), [{ stepType: "replace", from: 3, to: 3, slice: [] }])).toEqual(hello());
  });

  test("keeps a paragraph's attributes while typing into it", async () => {
    const attrs = { id: "p-1", textAlign: "center", indent: 2 };
    expect(await apply(docOf(node("paragraph", attrs, [text("hello")])), [insertText(6, "!")])).toEqual(docOf(node("paragraph", attrs, [text("hello!")])));
  });

  test("deletes and replaces text", async () => {
    expect(await apply(hello(), [{ stepType: "replace", from: 2, to: 5, slice: [] }])).toEqual(docOf(p("ho")));
    expect(await apply(hello(), [{ stepType: "replace", from: 2, to: 6, slice: [{ t: "EY" }] }])).toEqual(docOf(p("hEY")));
    expect(await apply(hello(), [{ stepType: "replace", from: 1, to: 6, slice: [] }])).toEqual(docOf(p()));
    expect(await apply(hello(), [{ stepType: "replace", from: 1, to: 6, slice: [{ t: "bye" }] }])).toEqual(docOf(p("bye")));
  });

  test("counts positions in UTF-16 code units", async () => {
    // "😀" is two units: "b" is at position 4.
    expect(await apply(docOf(p("a😀b")), [insertText(4, "X")])).toEqual(docOf(p("a😀Xb")));
    expect(await apply(docOf(p("a😀b")), [insertText(4, "é"), insertText(1, "👍🏽"), { stepType: "replace", from: 6, to: 8, slice: [] }])).toEqual(
      docOf(p("👍🏽aéb")),
    );
    // A combining mark is a unit of its own; CJK and right-to-left letters are one unit each.
    expect(await apply(docOf(p("éx")), [insertText(3, "|")])).toEqual(docOf(p("é|x")));
    expect(await apply(docOf(p("日本語")), [insertText(3, "の")])).toEqual(docOf(p("日本の語")));
    expect(await apply(docOf(p("שלום")), [{ stepType: "replace", from: 2, to: 4, slice: [{ t: "مرحبا" }] }])).toEqual(docOf(p("שمرحباם")));
  });

  test("splits a paragraph", async () => {
    expect(await apply(hello(), [{ stepType: "replace", from: 3, to: 3, slice: [{ c: 1 }, { o: "paragraph" }] }])).toEqual(docOf(p("he"), p("llo")));
    expect(await apply(hello(), [{ stepType: "replace", from: 6, to: 6, slice: [{ c: 1 }, { o: "paragraph" }] }])).toEqual(docOf(p("hello"), p()));
    expect(await apply(hello(), [{ stepType: "replace", from: 1, to: 1, slice: [{ c: 1 }, { o: "paragraph" }] }])).toEqual(docOf(p(), p("hello")));
    // The first half keeps the paragraph's attributes; the second has those of the slice.
    const first = { id: "a", textAlign: "right", indent: 1 };
    const second = { id: "b", textAlign: null, indent: 0 };
    expect(
      await apply(docOf(node("paragraph", first, [text("hello")])), [{ stepType: "replace", from: 3, to: 3, slice: [{ c: 1 }, { o: "paragraph", a: second }] }]),
    ).toEqual(docOf(node("paragraph", first, [text("he")]), node("paragraph", second, [text("llo")])));
  });

  test("joins two paragraphs", async () => {
    expect(await apply(two(), [{ stepType: "replace", from: 6, to: 8, slice: [] }])).toEqual(docOf(p("helloworld")));
    // Replacing across the boundary joins them too; the first paragraph's attributes stay.
    const start = docOf(node("paragraph", { ...PARA, id: "a" }, [text("hello")]), node("paragraph", { ...PARA, id: "b" }, [text("world")]));
    expect(await apply(start, [{ stepType: "replace", from: 3, to: 10, slice: [{ t: "-" }] }])).toEqual(
      docOf(node("paragraph", { ...PARA, id: "a" }, [text("he-rld")])),
    );
  });

  test("deletes and inserts whole blocks", async () => {
    expect(await apply(two(), [{ stepType: "replace", from: 7, to: 14, slice: [] }])).toEqual(hello());
    expect(await apply(two(), [{ stepType: "replace", from: 0, to: 7, slice: [] }])).toEqual(docOf(p("world")));
    const heading = { id: null, level: 2, textAlign: null, indent: 0 };
    expect(await apply(hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "heading", a: heading }, { t: "Title" }, { c: 1 }] }])).toEqual(
      docOf(p("hello"), node("heading", heading, [text("Title")])),
    );
    expect(await apply(hello(), [{ stepType: "replace", from: 0, to: 0, slice: [{ o: "heading", a: heading }, { c: 1 }] }])).toEqual(
      docOf(node("heading", heading, []), p("hello")),
    );
    // The whole content at once.
    expect(
      await apply(two(), [{ stepType: "replace", from: 0, to: 14, slice: [{ o: "paragraph" }, { t: "new" }, { c: 1 }, { n: { type: "horizontalRule" } }] }]),
    ).toEqual(docOf(p("new"), { type: "horizontalRule" }));
  });

  test("inserts every inline leaf node", async () => {
    const leaves = [
      { type: "hardBreak" },
      { type: "mathInline", attrs: { text: "x^2" } },
      { type: "mention", attrs: { id: "m1", label: "Ann", entityType: "user", entityId: "7b1f1a4e-58f1-4c1c-9d59-b1e4f6f0a001", slugId: null, creatorId: null, anchorId: null } },
      { type: "status", attrs: { text: "Done", color: "green" } },
      { type: "footnoteReference", attrs: { class: "footnote-ref", "data-id": "fn1", referenceNumber: 1, href: "#fn1" } },
    ];
    const result = await apply(hello(), [{ stepType: "replace", from: 3, to: 3, slice: leaves.map((n) => ({ n })) }, insertText(8, "|")]);
    // Each leaf is one position: "|" lands right after the five of them.
    expect(result).toEqual(docOf(p("he", ...leaves, "|llo")));
  });

  test("inserts every block leaf node", async () => {
    const leaves = [
      { type: "horizontalRule" },
      { type: "pageBreak" },
      { type: "image", attrs: { src: "/api/files/5e0b9d0c-2c55-4d0a-9d43-6f9a3f1f2a01/pic.png", width: 320, height: null, align: "center", alt: "A picture", attachmentId: "5e0b9d0c-2c55-4d0a-9d43-6f9a3f1f2a01", size: 1234, aspectRatio: 1.5 } },
      { type: "video", attrs: { src: "https://example.com/v.mp4", alt: null, attachmentId: null, width: null, height: null, size: null, align: "left", aspectRatio: null } },
      { type: "audio", attrs: { src: "https://example.com/a.mp3", attachmentId: null, size: null } },
      { type: "attachment", attrs: { url: "/api/files/5e0b9d0c-2c55-4d0a-9d43-6f9a3f1f2a02/report.pdf", name: "report.pdf", mime: "application/pdf", size: 99, attachmentId: "5e0b9d0c-2c55-4d0a-9d43-6f9a3f1f2a02" } },
      { type: "pdf", attrs: { src: "/api/files/5e0b9d0c-2c55-4d0a-9d43-6f9a3f1f2a03/doc.pdf", name: "doc.pdf", attachmentId: null, size: null, width: 800, height: 600 } },
      { type: "drawio", attrs: { src: "data:image/svg+xml;base64,PHN2Zy8+", title: "Diagram", alt: null, width: null, height: null, size: null, aspectRatio: null, align: "center", attachmentId: null } },
      { type: "excalidraw", attrs: { src: "data:image/png;base64,AAAA", title: null, alt: null, width: null, height: null, size: null, aspectRatio: null, align: "center", attachmentId: null } },
      { type: "mathBlock", attrs: { text: "E = mc^2" } },
      { type: "embed", attrs: { src: "https://example.com/embed", provider: "iframe", align: "center", width: 800, height: 600 } },
      { type: "youtube", attrs: { src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", start: 0, width: 640, height: 480 } },
      { type: "subpages" },
      { type: "base", attrs: { pageId: "5e0b9d0c-2c55-4d0a-9d43-6f9a3f1f2a04" } },
      { type: "transclusionReference", attrs: { sourcePageId: "5e0b9d0c-2c55-4d0a-9d43-6f9a3f1f2a05", transclusionId: "block-1" } },
    ];
    // Each leaf is one position: 15 of them after the paragraph's 7 put the end of the document at 22.
    const result = await apply(hello(), [
      { stepType: "replace", from: 7, to: 7, slice: leaves.map((n) => ({ n })) },
      { stepType: "replace", from: 22, to: 22, slice: [{ o: "paragraph" }, { t: "end" }, { c: 1 }] },
    ]);
    expect(result).toEqual(docOf(p("hello"), ...leaves, p("end")));
  });

  test("inserts every kind of container block", async () => {
    const o = (type: string, a?: Node) => (a ? { o: type, a } : { o: type });
    const c = { c: 1 };
    const para = (value: string) => [o("paragraph"), { t: value }, c];
    const cell = { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null, backgroundColorName: null };
    const slice = [
      o("blockquote"), ...para("quoted"), c,
      o("bulletList"), o("listItem"), ...para("bullet"), o("bulletList"), o("listItem"), ...para("nested"), c, c, c, c,
      o("orderedList", { start: 3, type: "a" }), o("listItem"), ...para("third"), c, c,
      o("taskList"), o("taskItem", { checked: true }), ...para("done"), c, o("taskItem", { checked: false }), ...para("to do"), c, c,
      o("codeBlock", { language: "ts" }), { t: "const a = 1;\n\treturn a;" }, c,
      o("callout", { type: "warning", icon: "⚠️" }), ...para("careful"), c,
      o("details", { open: true }), o("detailsSummary"), { t: "Summary" }, c, o("detailsContent"), ...para("inside"), c, c,
      o("details", { open: false }), o("detailsSummary"), c, o("detailsContent"), c, c,
      o("columns", { layout: "two_equal", widthMode: "normal" }), o("column", { width: null }), ...para("left"), c, o("column", { width: 40 }), ...para("right"), c, c,
      o("table"), o("tableRow"), o("tableHeader", cell), ...para("head"), c, o("tableHeader", cell), ...para("er"), c, c,
      o("tableRow"), o("tableCell", { ...cell, colspan: 2, colwidth: [100, 200] }), ...para("cell"), { n: { type: "mathBlock", attrs: { text: "1+1" } } }, c, c, c,
      o("table"), o("tableRow"), c, c,
      o("transclusionSource", { id: "block-1" }), ...para("synced"), c,
      o("footnotes", { class: "footnotes" }), o("footnote", { id: "fn1", "data-id": "fn1" }), ...para("a note"), c, c,
    ];
    const pp = (value: string) => p(value);
    expect(await apply(hello(), [{ stepType: "replace", from: 7, to: 7, slice }])).toEqual(
      docOf(
        p("hello"),
        node("blockquote", undefined, [pp("quoted")]),
        node("bulletList", undefined, [node("listItem", undefined, [pp("bullet"), node("bulletList", undefined, [node("listItem", undefined, [pp("nested")])])])]),
        node("orderedList", { start: 3, type: "a" }, [node("listItem", undefined, [pp("third")])]),
        node("taskList", undefined, [node("taskItem", { checked: true }, [pp("done")]), node("taskItem", { checked: false }, [pp("to do")])]),
        node("codeBlock", { language: "ts" }, [text("const a = 1;\n\treturn a;")]),
        node("callout", { type: "warning", icon: "⚠️" }, [pp("careful")]),
        node("details", { open: true }, [node("detailsSummary", undefined, [text("Summary")]), node("detailsContent", undefined, [pp("inside")])]),
        node("details", { open: false }, [node("detailsSummary", undefined, []), node("detailsContent", undefined, [])]),
        node("columns", { layout: "two_equal", widthMode: "normal" }, [node("column", { width: null }, [pp("left")]), node("column", { width: 40 }, [pp("right")])]),
        node("table", undefined, [
          node("tableRow", undefined, [node("tableHeader", cell, [pp("head")]), node("tableHeader", cell, [pp("er")])]),
          node("tableRow", undefined, [node("tableCell", { ...cell, colspan: 2, colwidth: [100, 200] }, [pp("cell"), { type: "mathBlock", attrs: { text: "1+1" } }])]),
        ]),
        // A row may be empty.
        node("table", undefined, [node("tableRow", undefined, [])]),
        node("transclusionSource", { id: "block-1" }, [pp("synced")]),
        node("footnotes", { class: "footnotes" }, [node("footnote", { id: "fn1", "data-id": "fn1" }, [pp("a note")])]),
      ),
    );
  });

  test("edits deep inside nested blocks", async () => {
    const list = (...items: Node[]) => node("bulletList", undefined, items);
    const item = (...content: Node[]) => node("listItem", undefined, content);
    // <ul>0 <li>1 <p>2 a3 b4 </p>5 </li>6 </ul>7
    const start = docOf(list(item(p("ab"))));
    expect(await apply(start, [insertText(4, "-")])).toEqual(docOf(list(item(p("a-b")))));
    // Splitting the item: close the paragraph and the item, open new ones.
    expect(await apply(start, [{ stepType: "replace", from: 4, to: 4, slice: [{ c: 1 }, { c: 1 }, { o: "listItem" }, { o: "paragraph" }] }])).toEqual(
      docOf(list(item(p("a")), item(p("b")))),
    );
    // And joining two items again.
    expect(await apply(docOf(list(item(p("a")), item(p("b")))), [{ stepType: "replace", from: 4, to: 8, slice: [] }])).toEqual(start);

    const cell = { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null, backgroundColorName: null };
    const table = (value: string) => docOf(node("table", undefined, [node("tableRow", undefined, [node("tableCell", cell, [p(value)])])]));
    // <table>0 <tr>1 <td>2 <p>3 x4
    expect(await apply(table("x"), [insertText(5, "y")])).toEqual(table("xy"));
  });

  test("text in a slice carries its marks, and merges with equally marked neighbours", async () => {
    expect(await apply(hello(), [{ stepType: "replace", from: 3, to: 3, slice: [{ t: "B", m: [bold] }] }])).toEqual(docOf(p("he", text("B", bold), "llo")));
    expect(await apply(docOf(p("he", text("llo", bold))), [{ stepType: "replace", from: 3, to: 3, slice: [{ t: "B", m: [bold] }] }])).toEqual(
      docOf(p("he", text("Bllo", bold))),
    );
    // Unmarked text typed into bold text splits it; deleting it merges the halves again.
    expect(await apply(docOf(p(text("hello", bold))), [insertText(3, "X")])).toEqual(docOf(p(text("he", bold), "X", text("llo", bold))));
    expect(await apply(docOf(p(text("he", bold), "X", text("llo", bold))), [{ stepType: "replace", from: 3, to: 4, slice: [] }])).toEqual(
      docOf(p(text("hello", bold))),
    );
    // A whole block that is put in keeps the marks of its text.
    expect(await apply(hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "paragraph" }, { t: "bold", m: [bold] }, { t: " and plain" }, { c: 1 }] }])).toEqual(
      docOf(p("hello"), p(text("bold", bold), " and plain")),
    );
    const link = { type: "link", attrs: { href: "https://example.com", target: "_blank", rel: "noopener noreferrer nofollow", class: null, internal: false } };
    expect(await apply(hello(), [{ stepType: "replace", from: 6, to: 6, slice: [{ t: " link", m: [link, bold] }, { n: { type: "hardBreak", marks: [bold] } }] }])).toEqual(
      docOf(p("hello", text(" link", link, bold), { type: "hardBreak", marks: [bold] })),
    );
  });

  test("code blocks take text, tabs and line breaks, but no marks and no other nodes", async () => {
    const code = (value: string) => docOf(node("codeBlock", { language: null }, value ? [text(value)] : []));
    expect(await apply(code("let x"), [insertText(6, " = 1;\n\tx++;")])).toEqual(code("let x = 1;\n\tx++;"));
    await refused("bold text", code("let x"), [{ stepType: "replace", from: 1, to: 1, slice: [{ t: "b", m: [bold] }] }]);
    await refused("a hard break", code("let x"), [{ stepType: "replace", from: 1, to: 1, slice: [{ n: { type: "hardBreak" } }] }]);
    await refused("a paragraph", code("let x"), [{ stepType: "replace", from: 1, to: 1, slice: [{ o: "paragraph" }, { c: 1 }] }]);
  });

  test("is refused when a position is outside the document or the range is reversed", async () => {
    // "hello" in a paragraph is 7 positions.
    await refused("from past the end", hello(), [insertText(8, "x")]);
    await refused("to past the end", hello(), [{ stepType: "replace", from: 1, to: 8, slice: [] }]);
    await refused("far past the end", hello(), [{ stepType: "replace", from: 1_000_000, to: 1_000_000, slice: [{ t: "x" }] }]);
    await refused("reversed", hello(), [{ stepType: "replace", from: 4, to: 2, slice: [] }]);
    // The last position itself is inside the document.
    expect(await apply(hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "paragraph" }, { c: 1 }] }])).toEqual(docOf(p("hello"), p()));
  });

  test("is refused when it would leave the tree unbalanced", async () => {
    await refused("a lone closing token", hello(), [{ stepType: "replace", from: 3, to: 3, slice: [{ c: 1 }] }]);
    await refused("a lone opening token", hello(), [{ stepType: "replace", from: 3, to: 3, slice: [{ o: "paragraph" }] }]);
    await refused("deleting only a closing token", two(), [{ stepType: "replace", from: 6, to: 7, slice: [] }]);
    await refused("deleting only an opening token", two(), [{ stepType: "replace", from: 7, to: 8, slice: [] }]);
    await refused("deleting from inside a paragraph to between blocks", two(), [{ stepType: "replace", from: 3, to: 7, slice: [] }]);
    await refused("more closing than opening tokens at the top", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ c: 1 }, { o: "paragraph" }, { c: 1 }] }]);
  });

  test("is refused when the result does not fit the schema", async () => {
    await refused("text straight in the document", hello(), [insertText(0, "x")]);
    await refused("text after the last block", hello(), [insertText(7, "x")]);
    await refused("a paragraph inside a paragraph", hello(), [{ stepType: "replace", from: 3, to: 3, slice: [{ o: "paragraph" }, { c: 1 }] }]);
    await refused("a block leaf inside a paragraph", hello(), [{ stepType: "replace", from: 3, to: 3, slice: [{ n: { type: "horizontalRule" } }] }]);
    await refused("an inline leaf between blocks", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ n: { type: "hardBreak" } }] }]);
    await refused("deleting the only block", hello(), [{ stepType: "replace", from: 0, to: 7, slice: [] }]);
    await refused("a list item outside a list", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "listItem" }, { o: "paragraph" }, { c: 1 }, { c: 1 }] }]);
    await refused("an empty list", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "bulletList" }, { c: 1 }] }]);
    await refused("a list item that does not start with a paragraph", hello(), [
      { stepType: "replace", from: 7, to: 7, slice: [{ o: "bulletList" }, { o: "listItem" }, { o: "heading" }, { c: 1 }, { c: 1 }, { c: 1 }] },
    ]);
    await refused("an empty blockquote", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "blockquote" }, { c: 1 }] }]);
    await refused("a table without rows", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "table" }, { c: 1 }] }]);
    await refused("a table cell without content", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "table" }, { o: "tableRow" }, { o: "tableCell" }, { c: 1 }, { c: 1 }, { c: 1 }] }]);
    await refused("details without their two parts", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "details" }, { o: "detailsSummary" }, { c: 1 }, { c: 1 }] }]);
    await refused("a table inside a table cell", hello(), [
      { stepType: "replace", from: 7, to: 7, slice: [{ o: "table" }, { o: "tableRow" }, { o: "tableCell" }, { o: "table" }, { o: "tableRow" }, { c: 1 }, { c: 1 }, { c: 1 }, { c: 1 }, { c: 1 }] },
    ]);
    await refused("footnotes before the last block", hello(), [{ stepType: "replace", from: 0, to: 0, slice: [{ o: "footnotes" }, { c: 1 }] }]);
    await refused("footnotes twice", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "footnotes" }, { c: 1 }, { o: "footnotes" }, { c: 1 }] }]);
    await refused("a document inside the document", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "doc" }, { o: "paragraph" }, { c: 1 }, { c: 1 }] }]);
    const quote = docOf(node("blockquote", undefined, [p("a")]));
    await refused("text in a block that holds blocks", quote, [insertText(1, "x")]);
    // Empty footnotes at the very end are part of the schema.
    expect(await apply(hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "footnotes" }, { c: 1 }] }])).toEqual(docOf(p("hello"), node("footnotes", undefined, [])));
  }, 15_000);

  test("is refused for node and mark types the schema does not have", async () => {
    await refused("an unknown block", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "frobnicate" }, { c: 1 }] }]);
    await refused("an unknown leaf block", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ n: { type: "frobnicate" } }] }]);
    await refused("an unknown inline leaf", hello(), [{ stepType: "replace", from: 3, to: 3, slice: [{ n: { type: "frobnicate" } }] }]);
    await refused("a node type that is not a string", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: 5 }, { c: 1 }] }]);
    await refused("an empty text node", hello(), [{ stepType: "replace", from: 6, to: 6, slice: [{ n: { type: "text", text: "" } }] }]);
    await refused("an unknown mark in an inserted paragraph", hello(), [
      { stepType: "replace", from: 7, to: 7, slice: [{ o: "paragraph" }, { t: "x", m: [{ type: "blink" }] }, { c: 1 }] },
    ]);
    await refused("a mark on a block", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "paragraph", m: [bold] }, { c: 1 }] }]);
    await refused("a marked block leaf", hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ n: { type: "horizontalRule", marks: [bold] } }] }]);
  });

  test("takes some slices a careful editor would not send", async () => {
    // Accident: text typed straight into a paragraph may carry a mark type the schema does not have
    // (it is only checked for the children of inserted blocks).
    expect(await apply(hello(), [{ stepType: "replace", from: 3, to: 3, slice: [{ t: "x", m: [{ type: "blink" }] }] }])).toEqual(
      docOf(p("he", text("x", { type: "blink" }), "llo")),
    );
    // Accident: an item that is neither text, a node nor an opening token closes a node, whatever it holds.
    expect(await apply(hello(), [{ stepType: "replace", from: 3, to: 3, slice: [{}, { o: "paragraph" }] }])).toEqual(docOf(p("he"), p("llo")));
    expect(await apply(hello(), [{ stepType: "replace", from: 3, to: 3, slice: [{ c: 0, x: "y" }, { o: "paragraph" }] }])).toEqual(docOf(p("he"), p("llo")));
    // Accident: a text node sent as a leaf is put in as it is and joined with the text after it only.
    expect(await apply(hello(), [{ stepType: "replace", from: 3, to: 3, slice: [{ n: { type: "text", text: "abc" } }] }])).toEqual(docOf(p("he", "abcllo")));
    // Accident: an empty one is refused at the end of a paragraph, but before text it is swallowed and leaves the text in two nodes.
    expect(await apply(hello(), [{ stepType: "replace", from: 3, to: 3, slice: [{ n: { type: "text", text: "" } }] }])).toEqual(docOf(p("he", "llo")));
    // Accident: a leaf written as an opening and a closing token is taken, and keeps an empty content list.
    expect(await apply(hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "horizontalRule" }, { c: 1 }] }])).toEqual(
      docOf(p("hello"), { type: "horizontalRule", content: [] }),
    );
    // Attributes are not checked against the schema, and no defaults are filled in.
    expect(await apply(hello(), [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "heading", a: { level: 9, colour: "red" } }, { c: 1 }, { o: "heading" }, { c: 1 }] }])).toEqual(
      docOf(p("hello"), node("heading", { level: 9, colour: "red" }, []), node("heading", undefined, [])),
    );
  });
});

describe("replaceAround", () => {
  const around = (from: number, to: number, gapFrom: number, gapTo: number, slice: Node[], insert: number): Step => ({ stepType: "replaceAround", from, to, gapFrom, gapTo, slice, insert });

  test("wraps a paragraph in a blockquote, a list or a callout", async () => {
    expect(await apply(hello(), [around(0, 7, 0, 7, [{ o: "blockquote" }, { c: 1 }], 1)])).toEqual(docOf(node("blockquote", undefined, [p("hello")])));
    expect(await apply(hello(), [around(0, 7, 0, 7, [{ o: "bulletList" }, { o: "listItem" }, { c: 1 }, { c: 1 }], 2)])).toEqual(
      docOf(node("bulletList", undefined, [node("listItem", undefined, [p("hello")])])),
    );
    expect(await apply(hello(), [around(0, 7, 0, 7, [{ o: "orderedList", a: { start: 1, type: null } }, { o: "listItem" }, { c: 1 }, { c: 1 }], 2)])).toEqual(
      docOf(node("orderedList", { start: 1, type: null }, [node("listItem", undefined, [p("hello")])])),
    );
    expect(await apply(hello(), [around(0, 7, 0, 7, [{ o: "taskList" }, { o: "taskItem", a: { checked: false } }, { c: 1 }, { c: 1 }], 2)])).toEqual(
      docOf(node("taskList", undefined, [node("taskItem", { checked: false }, [p("hello")])])),
    );
    // Both paragraphs in one callout; their attributes travel with them.
    const start = docOf(node("paragraph", { ...PARA, id: "a" }, [text("hello")]), p("world"));
    expect(await apply(start, [around(0, 14, 0, 14, [{ o: "callout", a: { type: "info", icon: null } }, { c: 1 }], 1)])).toEqual(
      docOf(node("callout", { type: "info", icon: null }, [node("paragraph", { ...PARA, id: "a" }, [text("hello")]), p("world")])),
    );
    // Only the second paragraph.
    expect(await apply(two(), [around(7, 14, 7, 14, [{ o: "blockquote" }, { c: 1 }], 1)])).toEqual(docOf(p("hello"), node("blockquote", undefined, [p("world")])));
  });

  test("unwraps what a block holds", async () => {
    // <blockquote>0 <p>1 hello </p>8 </blockquote>9
    expect(await apply(docOf(node("blockquote", undefined, [p("hello")])), [around(0, 9, 1, 8, [], 0)])).toEqual(hello());
    const list = docOf(node("bulletList", undefined, [node("listItem", undefined, [p("a")]), node("listItem", undefined, [p("b")])]));
    // The second item leaves the list: the list is closed before its paragraph.
    expect(await apply(list, [around(6, 12, 7, 10, [{ c: 1 }], 1)])).toEqual(docOf(node("bulletList", undefined, [node("listItem", undefined, [p("a")])]), p("b")));
  });

  test("changes a block's type and keeps its content", async () => {
    const heading = { id: null, level: 2, textAlign: null, indent: 0 };
    const marked = docOf(p("he", text("ll", bold), "o"));
    expect(await apply(marked, [around(0, 7, 1, 6, [{ o: "heading", a: heading }, { c: 1 }], 1)])).toEqual(
      docOf(node("heading", heading, [text("he"), text("ll", bold), text("o")])),
    );
    expect(await apply(docOf(node("heading", heading, [text("hello")])), [around(0, 7, 1, 6, [{ o: "paragraph", a: PARA }, { c: 1 }], 1)])).toEqual(
      docOf(node("paragraph", PARA, [text("hello")])),
    );
    expect(await apply(hello(), [around(0, 7, 1, 6, [{ o: "codeBlock", a: { language: "js" } }, { c: 1 }], 1)])).toEqual(
      docOf(node("codeBlock", { language: "js" }, [text("hello")])),
    );
    // Marked text cannot become code.
    await refused("bold text into a code block", marked, [around(0, 7, 1, 6, [{ o: "codeBlock", a: { language: null } }, { c: 1 }], 1)]);
  });

  test("with an empty gap it is a plain replacement", async () => {
    expect(await apply(hello(), [around(3, 3, 3, 3, [{ t: "X" }], 0)])).toEqual(docOf(p("heXllo")));
    expect(await apply(hello(), [around(2, 5, 3, 3, [{ t: "X" }], 1)])).toEqual(docOf(p("hXo")));
  });

  test("is refused when the gap is not inside the range, or the insert position not inside the slice", async () => {
    const wrap = [{ o: "blockquote" }, { c: 1 }];
    await refused("gap starts before the range", two(), [around(7, 14, 0, 14, wrap, 1)]);
    await refused("gap ends after the range", two(), [around(0, 7, 0, 14, wrap, 1)]);
    await refused("gap reversed", hello(), [around(0, 7, 6, 1, wrap, 1)]);
    await refused("insert past the slice", hello(), [around(0, 7, 0, 7, wrap, 3)]);
    await refused("range reversed", hello(), [around(7, 0, 7, 7, wrap, 1)]);
    await refused("range past the end", hello(), [around(0, 8, 0, 7, wrap, 1)]);
    // At the end of the slice is still inside it: the paragraph then follows the quote, which is left empty.
    await refused("an empty blockquote before the paragraph", hello(), [around(0, 7, 0, 7, wrap, 2)]);
  });

  test("is refused when the result is unbalanced or does not fit the schema", async () => {
    await refused("an opening token only", hello(), [around(0, 7, 0, 7, [{ o: "blockquote" }], 1)]);
    await refused("a list item without a list", hello(), [around(0, 7, 0, 7, [{ o: "listItem" }, { c: 1 }], 1)]);
    await refused("a paragraph around a paragraph", hello(), [around(0, 7, 0, 7, [{ o: "paragraph" }, { c: 1 }], 1)]);
    await refused("an unknown wrapper", hello(), [around(0, 7, 0, 7, [{ o: "frobnicate" }, { c: 1 }], 1)]);
    await refused("unwrapping text into the document", hello(), [around(0, 7, 1, 6, [], 0)]);
    await refused("a gap that cuts through a node", two(), [around(0, 14, 3, 14, [{ o: "blockquote" }, { c: 1 }], 1)]);
  });
});

describe("addMark and removeMark", () => {
  const add = (from: number, to: number, mark: Node): Step => ({ stepType: "addMark", from, to, mark });
  const remove = (from: number, to: number, mark: Node): Step => ({ stepType: "removeMark", from, to, mark });
  const marks: Node[] = [
    { type: "link", attrs: { href: "https://example.com/a?b=c#d", target: "_blank", rel: "noopener noreferrer nofollow", class: null, internal: false } },
    { type: "bold" },
    { type: "italic" },
    { type: "underline" },
    { type: "strike" },
    { type: "code" },
    { type: "highlight", attrs: { color: "#fff3bf", colorName: "yellow" } },
    { type: "textStyle", attrs: { color: "#e03131" } },
    { type: "subscript" },
    { type: "superscript" },
    { type: "comment", attrs: { commentId: "5e0b9d0c-2c55-4d0a-9d43-6f9a3f1f2b01", resolved: false } },
  ];

  test("every mark type can be put on a range of text and taken off again", async () => {
    for (const mark of marks) {
      const start = docOf(p("hello world"));
      expect([mark.type, await apply(start, [add(1, 6, mark)])]).toEqual([mark.type, docOf(p(text("hello", mark), " world"))]);
      expect([mark.type, await apply(start, [add(1, 6, mark), remove(1, 6, mark)])]).toEqual([mark.type, start]);
    }
  }, 15_000);

  test("marks on the same text are kept in the schema's order, whatever order they were added in", async () => {
    const result = await apply(docOf(p("hello")), [...marks].reverse().map((mark) => add(1, 6, mark)));
    expect(result).toEqual(docOf(p(text("hello", ...marks))));
    const shuffled = [marks[5]!, marks[0]!, marks[10]!, marks[2]!, marks[1]!];
    expect(await apply(docOf(p("hello")), shuffled.map((mark) => add(1, 6, mark)))).toEqual(docOf(p(text("hello", marks[0]!, marks[1]!, marks[2]!, marks[5]!, marks[10]!))));
  });

  test("a range splits text where the marks differ, and equal neighbours merge", async () => {
    expect(await apply(hello(), [add(2, 4, bold)])).toEqual(docOf(p("h", text("el", bold), "lo")));
    expect(await apply(hello(), [add(2, 4, bold), add(3, 5, italic)])).toEqual(docOf(p("h", text("e", bold), text("l", bold, italic), text("l", italic), "o")));
    expect(await apply(hello(), [add(2, 4, bold), add(4, 6, bold)])).toEqual(docOf(p("h", text("ello", bold))));
    expect(await apply(hello(), [add(1, 6, bold), remove(2, 4, bold)])).toEqual(docOf(p(text("h", bold), "el", text("lo", bold))));
    // Adding a mark that is there already, or removing one that is not, changes nothing.
    expect(await apply(docOf(p(text("hello", bold))), [add(1, 6, bold), remove(1, 6, italic)])).toEqual(docOf(p(text("hello", bold))));
    // An empty range is taken and does nothing.
    expect(await apply(hello(), [add(3, 3, bold)])).toEqual(hello());
  });

  test("a mark type is on a piece of text once, except comments", async () => {
    const link = (href: string) => ({ type: "link", attrs: { href } });
    expect(await apply(hello(), [add(1, 6, link("https://one.example")), add(3, 6, link("https://two.example"))])).toEqual(
      docOf(p(text("he", link("https://one.example")), text("llo", link("https://two.example")))),
    );
    const highlight = (color: string) => ({ type: "highlight", attrs: { color, colorName: null } });
    expect(await apply(hello(), [add(1, 6, highlight("red")), add(1, 6, bold), add(1, 6, highlight("blue"))])).toEqual(docOf(p(text("hello", bold, highlight("blue")))));

    const comment = (commentId: string, resolved = false) => ({ type: "comment", attrs: { commentId, resolved } });
    expect(await apply(hello(), [add(1, 6, comment("c1")), add(3, 6, comment("c2")), add(1, 6, comment("c1"))])).toEqual(
      docOf(p(text("he", comment("c1")), text("llo", comment("c2"), comment("c1")))),
    );
    // Resolving a comment is a different mark: the unresolved one has to be removed by the client.
    expect(await apply(hello(), [add(1, 6, comment("c1")), add(1, 6, comment("c1", true))])).toEqual(docOf(p(text("hello", comment("c1"), comment("c1", true)))));
    expect(await apply(hello(), [add(1, 6, comment("c1")), add(1, 6, comment("c2")), remove(1, 6, comment("c1"))])).toEqual(docOf(p(text("hello", comment("c2")))));
  });

  test("removing a mark needs the same attributes", async () => {
    const link = (href: string) => ({ type: "link", attrs: { href } });
    const linked = docOf(p(text("hello", link("https://one.example"))));
    expect(await apply(linked, [remove(1, 6, link("https://two.example"))])).toEqual(linked);
    expect(await apply(linked, [remove(1, 6, { type: "link" })])).toEqual(linked);
    expect(await apply(linked, [remove(1, 6, link("https://one.example"))])).toEqual(hello());
    // Attributes that are absent and an empty attribute object are the same thing.
    expect(await apply(docOf(p(text("hello", bold))), [remove(1, 6, { type: "bold", attrs: {} })])).toEqual(hello());
    expect(await apply(docOf(p(text("hello", { type: "bold", attrs: {} }))), [remove(2, 6, bold)])).toEqual(docOf(p(text("h", { type: "bold", attrs: {} }), "ello")));
  });

  test("mark attributes are stored as they are sent", async () => {
    expect(await apply(hello(), [add(1, 6, { type: "bold", attrs: { weight: 900 } })])).toEqual(docOf(p(text("hello", { type: "bold", attrs: { weight: 900 } }))));
    expect(await apply(hello(), [add(1, 6, { type: "link" })])).toEqual(docOf(p(text("hello", { type: "link" }))));
    // Other keys of the mark travel along too.
    expect(await apply(hello(), [add(1, 6, { type: "italic", extra: true })])).toEqual(docOf(p(text("hello", { type: "italic", extra: true }))));
  });

  test("a range over several blocks marks the text and inline leaves of each", async () => {
    // <p>0 a1 b2 <br>3 c4 d5 </p>6 <p>7 e8 f9 </p>10
    const start = docOf(p("ab", { type: "hardBreak" }, "cd"), p("ef"));
    expect(await apply(start, [add(2, 9, italic)])).toEqual(
      docOf(p("a", text("b", italic), { type: "hardBreak", marks: [italic] }, text("cd", italic)), p(text("e", italic), "f")),
    );
    expect(await apply(start, [add(0, 11, italic), remove(3, 4, italic)])).toEqual(docOf(p(text("ab", italic), { type: "hardBreak" }, text("cd", italic)), p(text("ef", italic))));
    const mention = { type: "mention", attrs: { id: "m", label: "Ann", entityType: "user", entityId: "7b1f1a4e-58f1-4c1c-9d59-b1e4f6f0a001", slugId: null, creatorId: null, anchorId: null } };
    expect(await apply(docOf(p("a", mention)), [add(1, 3, bold)])).toEqual(docOf(p(text("a", bold), { ...mention, marks: [bold] })));
    // Unlike a replacement, the range may start and end at any depth: nothing is taken out of the tree.
    expect(await apply(two(), [add(3, 7, bold), add(13, 14, italic), add(0, 1, italic)])).toEqual(docOf(p("he", text("llo", bold)), p("world")));
  });

  test("text in code blocks and block leaves are left unmarked", async () => {
    const start = docOf(p("ab"), node("codeBlock", { language: null }, [text("cd")]), { type: "horizontalRule" }, p("ef"));
    // <p>0..4 <codeBlock>4 c5 d6 </codeBlock>7 <hr>8 <p>9 e10 f11 </p>12
    expect(await apply(start, [add(0, 13, bold)])).toEqual(
      docOf(p(text("ab", bold)), node("codeBlock", { language: null }, [text("cd")]), { type: "horizontalRule" }, p(text("ef", bold))),
    );
    // Nothing markable in the range: taken, and nothing changes.
    expect(await apply(start, [add(5, 7, bold), add(8, 9, bold)])).toEqual(start);
  });

  test("is refused for an unknown mark type, a reversed range or positions outside the document", async () => {
    await refused("unknown mark", hello(), [add(1, 6, { type: "blink" })]);
    await refused("unknown mark removed", hello(), [remove(1, 6, { type: "blink" })]);
    await refused("reversed", hello(), [add(4, 2, bold)]);
    await refused("past the end", hello(), [add(1, 8, bold)]);
    await refused("removal past the end", hello(), [remove(8, 9, bold)]);
  });
});

describe("attr", () => {
  const attr = (pos: number, attrs: Node): Step => ({ stepType: "attr", pos, attrs });

  test("replaces the attributes of the block that starts at the position", async () => {
    const heading = (level: number) => node("heading", { id: "h", level, textAlign: null, indent: 0 }, [text("Title")]);
    expect(await apply(docOf(heading(1), p("x")), [attr(0, { id: "h", level: 3, textAlign: null, indent: 0 })])).toEqual(docOf(heading(3), p("x")));
    // The second block starts after the heading's 7 positions.
    expect(await apply(docOf(heading(1), p("x")), [attr(7, { id: "p", textAlign: "right", indent: 0 })])).toEqual(
      docOf(heading(1), node("paragraph", { id: "p", textAlign: "right", indent: 0 }, [text("x")])),
    );
    // All of them are replaced: what the step leaves out is gone, and nothing is checked against the schema.
    expect(await apply(docOf(heading(1)), [attr(0, { level: 2 })])).toEqual(docOf(node("heading", { level: 2 }, [text("Title")])));
    expect(await apply(docOf(heading(1)), [attr(0, {})])).toEqual(docOf(node("heading", {}, [text("Title")])));
    expect(await apply(docOf(heading(1)), [attr(0, { level: "many", anything: ["goes"] })])).toEqual(docOf(node("heading", { level: "many", anything: ["goes"] }, [text("Title")])));
  });

  test("reaches nested blocks and leaves", async () => {
    const tasks = (checked: boolean) => docOf(node("taskList", undefined, [node("taskItem", { checked }, [p("x")])]));
    expect(await apply(tasks(false), [attr(1, { checked: true })])).toEqual(tasks(true));

    const image = (width: number) => ({ type: "image", attrs: { src: "/api/files/5e0b9d0c-2c55-4d0a-9d43-6f9a3f1f2a01/pic.png", width, align: "center" } });
    // <p>0 a1 </p>2 <image>3
    expect(await apply(docOf(p("a"), image(100)), [attr(3, image(250).attrs)])).toEqual(docOf(p("a"), image(250)));

    const status = (color: string) => ({ type: "status", attrs: { text: "Doing", color } });
    // <p>0 a1 b2 <status>3
    expect(await apply(docOf(p("ab", status("gray"), "cd")), [attr(3, { text: "Doing", color: "blue" })])).toEqual(docOf(p("ab", status("blue"), "cd")));
    // A leaf keeps its marks.
    expect(await apply(docOf(p("ab", { ...status("gray"), marks: [bold] })), [attr(3, { text: "Done", color: "green" })])).toEqual(
      docOf(p("ab", { type: "status", attrs: { text: "Done", color: "green" }, marks: [bold] })),
    );

    const cell = (attrs: Node) => docOf(node("table", undefined, [node("tableRow", undefined, [node("tableCell", attrs, [p("x")])])]));
    expect(await apply(cell({ colspan: 1, rowspan: 1, colwidth: null }), [attr(2, { colspan: 2, rowspan: 1, colwidth: [120, 80] })])).toEqual(
      cell({ colspan: 2, rowspan: 1, colwidth: [120, 80] }),
    );
  });

  test("is refused where no node starts, on text, and outside the document", async () => {
    await refused("inside text", hello(), [attr(3, { x: 1 })]);
    await refused("at the start of text", hello(), [attr(1, { x: 1 })]);
    await refused("at the end of a paragraph", hello(), [attr(6, { x: 1 })]);
    await refused("at the end of the document", hello(), [attr(7, { x: 1 })]);
    await refused("past the end of the document", hello(), [attr(8, { x: 1 })]);
    await refused("in an empty paragraph", docOf(p()), [attr(1, { x: 1 })]);
    // Text after a leaf is still text.
    await refused("text after a leaf", docOf(p({ type: "hardBreak" }, "a")), [attr(2, { x: 1 })]);
  });

  test("a batch stops at its first step that does not apply, and none of it is kept", async () => {
    await refused("the second of three", hello(), [insertText(1, "x"), attr(3, { x: 1 }), insertText(1, "y")]);
  });
});

describe("URLs in steps", () => {
  const pdf = (src: unknown): Step => ({ stepType: "replace", from: 7, to: 7, slice: [{ n: { type: "pdf", attrs: { src, name: "x.pdf" } } }] });
  const stored = async (step: Step) => (await apply(docOf(p("hello")), [step], expect.any(Array) as never)).content[1].attrs;

  test("http, https, mailto, tel and relative URLs are kept", async () => {
    for (const url of ["/api/files/1/a.pdf", "#heading", "https://example.com/a?b=c", "http://x.y/z", "mailto:a@b.c", "tel:+1", "page", "HTTPS://EXAMPLE.COM", "//example.com/x", "?q=1", "/a:b", "1a:b"]) {
      expect([url, await stored(pdf(url))]).toEqual([url, { src: url, name: "x.pdf" }]);
    }
  }, 10_000);

  test("anything with another scheme is emptied, however the scheme is disguised", async () => {
    for (const url of ["javascript:alert(1)", " JavaScript:alert(1)", "java\tscript:alert(1)", "java\u0000script:x", "j\na\rv\tascript:x", "vbscript:x", "data:text/html,<script>", "file:///etc/passwd", "ftp://example.com/x", "blob:https://example.com/1", "data:image/png;base64,AAAA", "a:b/c", "x-y.z+1:anything"]) {
      expect([url, await stored(pdf(url))]).toEqual([url, { src: "", name: "x.pdf" }]);
    }
  }, 10_000);

  test("surrounding white space is trimmed, and values that are not strings are emptied", async () => {
    expect(await stored(pdf("  https://example.com/x \n"))).toEqual({ src: "https://example.com/x", name: "x.pdf" });
    expect(await stored(pdf("   "))).toEqual({ src: "", name: "x.pdf" });
    expect(await stored(pdf(5))).toEqual({ src: "", name: "x.pdf" });
    expect(await stored(pdf({ href: "x" }))).toEqual({ src: "", name: "x.pdf" });
    expect(await stored(pdf(false))).toEqual({ src: "", name: "x.pdf" });
    // null is left alone.
    expect(await stored(pdf(null))).toEqual({ src: null, name: "x.pdf" });
  });

  test("images and diagrams may carry a data: image, nothing else may", async () => {
    const leaf = (type: string, src: string): Step => ({ stepType: "replace", from: 7, to: 7, slice: [{ n: { type, attrs: { src } } }] });
    for (const type of ["image", "drawio", "excalidraw"]) {
      for (const src of ["data:image/png;base64,AAAA", "data:image/jpeg;base64,AAAA", "data:image/jpg;base64,AAAA", "data:image/gif;base64,AAAA", "data:image/webp;base64,AAAA", "data:image/avif;base64,AAAA", "data:image/svg+xml;base64,AAAA", "DATA:IMAGE/PNG;base64,AAAA"]) {
        expect([type, src, await stored(leaf(type, src))]).toEqual([type, src, { src }]);
      }
      for (const src of ["data:image/bmp;base64,AAAA", "data:image/png,AAAA", "data:text/html;base64,AAAA", "data:application/pdf;base64,AAAA", "javascript:alert(1)"]) {
        expect([type, src, await stored(leaf(type, src))]).toEqual([type, src, { src: "" }]);
      }
    }
    for (const type of ["video", "audio", "pdf", "embed", "youtube"]) {
      expect([type, await stored(leaf(type, "data:image/png;base64,AAAA"))]).toEqual([type, { src: "" }]);
    }
  }, 20_000);

  test("src, url and href are cleaned on nodes, on marks, and at any depth of an inserted block", async () => {
    const bad = "javascript:alert(1)";
    const good = "https://example.com";
    const result = await apply(
      docOf(p("hello")),
      [
        {
          stepType: "replace",
          from: 7,
          to: 7,
          slice: [
            { n: { type: "attachment", attrs: { url: bad, name: bad } } },
            { o: "blockquote" },
            { o: "paragraph", a: { id: bad, href: bad } },
            { t: "a", m: [{ type: "link", attrs: { href: bad, target: "_blank" } }, { type: "bold" }] },
            { t: "b", m: [{ type: "link", attrs: { href: good } }] },
            { n: { type: "footnoteReference", attrs: { href: bad, "data-id": bad }, marks: [{ type: "link", attrs: { href: bad } }] } },
            { c: 1 },
            { n: { type: "image", attrs: { src: bad, alt: bad } } },
            { c: 1 },
          ],
        },
      ],
      expect.any(Array) as never,
    );
    expect(result).toEqual(
      docOf(
        p("hello"),
        { type: "attachment", attrs: { url: "", name: bad } },
        node("blockquote", undefined, [
          node("paragraph", { id: bad, href: "" }, [
            text("a", { type: "link", attrs: { href: "", target: "_blank" } }, { type: "bold" }),
            text("b", { type: "link", attrs: { href: good } }),
            { type: "footnoteReference", attrs: { href: "", "data-id": bad }, marks: [{ type: "link", attrs: { href: "" } }] },
          ]),
          { type: "image", attrs: { src: "", alt: bad } },
        ]),
      ),
    );
  });

  test("the wrapper of a replaceAround, a mark and an attribute step are cleaned too", async () => {
    const bad = "javascript:alert(1)";
    expect(
      await apply(
        docOf(p("hello")),
        [{ stepType: "replaceAround", from: 0, to: 7, gapFrom: 1, gapTo: 6, insert: 1, slice: [{ o: "heading", a: { level: 1, href: bad } }, { c: 1 }] }],
        [{ stepType: "replaceAround", from: 0, to: 7, gapFrom: 1, gapTo: 6, insert: 1, slice: [{ o: "heading", a: { level: 1, href: "" } }, { c: 1 }] }],
      ),
    ).toEqual(docOf(node("heading", { level: 1, href: "" }, [text("hello")])));

    expect(
      await apply(
        docOf(p(text("hello", { type: "link", attrs: { href: "" } }))),
        [{ stepType: "removeMark", from: 1, to: 6, mark: { type: "link", attrs: { href: bad } } }],
        [{ stepType: "removeMark", from: 1, to: 6, mark: { type: "link", attrs: { href: "" } } }],
      ),
    ).toEqual(docOf(p("hello")));

    const image = (src: string) => ({ type: "image", attrs: { src, width: 10 } });
    expect(
      await apply(docOf(p("a"), image("/a.png")), [{ stepType: "attr", pos: 3, attrs: { src: bad, width: 10 } }], [{ stepType: "attr", pos: 3, attrs: { src: "", width: 10 } }]),
    ).toEqual(docOf(p("a"), image("")));
    // An attribute step does not say which node it is for, so not even an image may get a data: URL through one.
    expect(
      await apply(
        docOf(p("a"), image("/a.png")),
        [{ stepType: "attr", pos: 3, attrs: { src: "data:image/png;base64,AAAA", width: 10 } }],
        [{ stepType: "attr", pos: 3, attrs: { src: "", width: 10 } }],
      ),
    ).toEqual(docOf(p("a"), image("")));
  });
});

describe("the size of a document", () => {
  const big = (chars: number) => docOf(p("x".repeat(chars)));

  test("a batch that would take it past 2 000 000 positions is refused, at the limit it is taken", async () => {
    // A paragraph is two positions, each character one.
    const { id } = await createPage(owner, spaceId, big(1_999_990));
    const a = await open();
    await join(a, id, 0);
    expect((await sendSteps(a, id, 0, [insertText(1, "12345678")])).version).toBe(1);
    pushSteps(a, id, 1, [insertText(1, "9")]);
    expect(await a.next(about(id))).toEqual({ t: "error", pageId: id, message: ERRORS.tooLarge });
    const reset = await a.next(about(id));
    expect({ ...reset, doc: null } as Record<string, unknown>).toEqual({ t: "joined", pageId: id, version: 1, doc: null, readOnly: false });
    expect(reset.doc.content[0].content[0].text).toHaveLength(1_999_998);
    // A batch is measured at its end: adding and removing within it is fine.
    expect((await sendSteps(a, id, 1, [insertText(1, "abc"), { stepType: "replace", from: 1, to: 4, slice: [] }])).version).toBe(3);
    expect((await sendSteps(a, id, 3, [{ stepType: "replace", from: 1, to: 9, slice: [{ t: "87654321" }] }])).version).toBe(4);
    a.send({ t: "leave", pageId: id });
    const row = await untilStored(t, id, 4);
    expect(row.content.content[0].content[0].text).toBe("87654321" + "x".repeat(1_999_990));
  }, 20_000);

  test("a document that is already larger can shrink or stay the same size, but not grow", async () => {
    const { id } = await createPage(owner, spaceId, big(10));
    await t.sql`UPDATE pages SET content = jsonb_set(content, '{content,0,content,0,text}', to_jsonb(repeat('x', 2000100))) WHERE id = ${id}`;
    const a = await open();
    await join(a, id, 0);
    expect((await sendSteps(a, id, 0, [{ stepType: "replace", from: 1, to: 11, slice: [] }])).version).toBe(1);
    expect((await sendSteps(a, id, 1, [{ stepType: "replace", from: 1, to: 4, slice: [{ t: "abc" }] }])).version).toBe(2);
    pushSteps(a, id, 2, [insertText(1, "!")]);
    expect(await a.next(about(id))).toEqual({ t: "error", pageId: id, message: ERRORS.tooLarge });
    const reset = await a.next(about(id));
    expect(reset.version).toBe(2);
    expect(reset.doc.content[0].content[0].text).toBe("abc" + "x".repeat(2_000_087));
  }, 20_000);
});
