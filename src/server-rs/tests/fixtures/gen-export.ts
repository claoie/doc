// Writes export.json and export-fuzz.json: documents, and what the TypeScript
// serializers make of them (common/editor/html.ts, the serializer half of
// common/editor/markdown.ts, and docText/docLinks/docMentionedUserIds of
// common/text.ts), for tests/export.rs to hold the Rust ports to.
//
//   bun src/server-rs/tests/fixtures/gen-export.ts
//
// export.json holds hand-written documents with their full output.
// export-fuzz.json holds seeded random documents with a digest of each output
// (see `digest`), which keeps thousands of them in a small file. Running the
// script again writes the same bytes.
import { schema } from "common/editor/doc-schema";
import { docToHtml, escapeHtml, markTag, nodeToHtml, safeColor, safeUrl, type HtmlOptions } from "common/editor/html";
import { docToMarkdown, markdownToDoc } from "common/editor/markdown";
import type { Mark, Node } from "common/editor/model";
import { docLinks, docMentionedUserIds, docText } from "common/text";
import { attempt, digest, exportLike, mulberry32, outputs, probe, writeFixture, type Tree } from "./lib";

// ---------------------------------------------------------------------------
// Building documents

/** A node as the editor makes it: every attribute of the schema, with its default. */
const el = (type: string, attrs?: Record<string, unknown>, ...content: unknown[]): Tree =>
  schema.node(type, attrs, content as Node[]) as unknown as Tree;

/** A node with exactly what is given. */
const raw = (type: string, attrs?: Record<string, unknown> | null, content?: unknown[]): Tree => ({
  type,
  ...(attrs ? { attrs } : {}),
  ...(content ? { content } : {}),
});

const t = (text: string, ...marks: unknown[]): Tree => (marks.length ? { type: "text", text, marks } : { type: "text", text });
const m = (type: string, attrs?: Record<string, unknown>): Tree => schema.mark(type, attrs) as unknown as Tree;
const p = (...content: unknown[]) => el("paragraph", undefined, ...content);
const doc = (...content: unknown[]): Tree => ({ type: "doc", content });
const li = (...content: unknown[]) => el("listItem", undefined, ...content);
const cell = (...content: unknown[]) => el("tableCell", undefined, ...content);
const th = (...content: unknown[]) => el("tableHeader", undefined, ...content);
const row = (...content: unknown[]) => el("tableRow", undefined, ...content);
const table = (...content: unknown[]) => el("table", undefined, ...content);
const br = () => el("hardBreak");

const bold = m("bold");
const italic = m("italic");
const underline = m("underline");
const strike = m("strike");
const code = m("code");
const sub = m("subscript");
const sup = m("superscript");
const link = (href: unknown, extra: Record<string, unknown> = {}) => m("link", { href, ...extra });

const UUID = "0b8e6f2c-1d3a-4c5b-9e7f-112233445566";
const FILE = `/api/files/${UUID}`;
const USER = "7d1f0a52-93c4-4e1b-8a6d-5f2e3c4b1a90";
const PAGE = "c2a4e6f8-0b1d-4f3a-9c5e-7a9b1d3f5e70";

const docs: Record<string, unknown> = {
  "empty": doc(),
  "no-content": { type: "doc" },
  "empty-paragraph": doc(p()),
  "plain": doc(p(t("Hello, world."))),

  "headings": doc(
    ...[1, 2, 3, 4, 5, 6].map((level) => el("heading", { level, id: `h-${level}` }, t(`Heading ${level}`))),
    el("heading", { level: 0 }, t("level zero")),
    el("heading", { level: 7 }, t("level seven")),
    raw("heading", null, [t("no attributes")]),
    el("heading", { level: 2, textAlign: "center", indent: 2 }, t("centered"), br(), t("second line")),
    el("heading", { level: 3 }, t("with "), t("bold", bold), t(" and "), t("a link", link("https://example.com/"))),
    el("heading", { level: 2 }),
  ),

  "paragraph-attrs": doc(
    el("paragraph", { id: "p1", textAlign: "center", indent: 1 }, t("centered, indented")),
    el("paragraph", { textAlign: "right" }, t("right")),
    el("paragraph", { textAlign: "justify", indent: 3 }, t("justified")),
    el("paragraph", { textAlign: "left" }, t("left is the default and is not written")),
    el("paragraph", { indent: 0 }, t("no indent")),
    raw("paragraph", null, [t("no attributes")]),
    raw("paragraph"),
    raw("paragraph", {}, []),
  ),

  "marks-each": doc(
    p(t("bold", bold)),
    p(t("italic", italic)),
    p(t("underline", underline)),
    p(t("strike", strike)),
    p(t("code", code)),
    p(t("subscript", sub)),
    p(t("superscript", sup)),
    p(t("link", link("https://example.com/page?a=1&b=2"))),
    p(t("highlight", m("highlight", { color: "#ffff00", colorName: "Yellow" }))),
    p(t("highlight without a color", m("highlight"))),
    p(t("highlight with a bad color", m("highlight", { color: "expression(alert(1))", colorName: "Evil" }))),
    p(t("colored", m("textStyle", { color: "rgb(255, 0, 0)" }))),
    p(t("text style without a color", m("textStyle"))),
    p(t("commented", m("comment", { commentId: "c-1" }))),
    p(t("resolved comment", m("comment", { commentId: "c-2", resolved: true }))),
    p(t("unknown mark", { type: "glow" })),
    p(t("unknown mark with attributes", { type: "glow", attrs: { radius: 2 } })),
  ),

  "marks-nested": doc(
    p(t("plain "), t("bold ", bold), t("bold-italic", bold, italic), t(" italic", italic), t(" plain")),
    p(t("a", italic, bold), t("b", bold, italic), t("c", bold)),
    p(t("x", strike, m("highlight"), underline, sub), t("y", sup, underline)),
    p(t("link start ", link("https://x.example")), t("bold in link", link("https://x.example"), bold), t(" link end", link("https://x.example")), t(" after")),
    p(t("one", link("https://a.example")), t("two", link("https://b.example"))),
    p(t("one", link("https://a.example")), t("two", link("https://a.example", { target: "_self" }))),
    p(t("one", link("https://a.example")), t("two", link("https://a.example"))),
    p(t("every mark", link("https://x.example"), bold, italic, underline, strike, m("highlight", { color: "red" }), m("textStyle", { color: "blue" }), sub, sup, m("comment", { commentId: "c" }))),
    p(t("reversed", sup, sub, underline, m("highlight"), strike, italic, bold, link("https://x.example"))),
    p(t("colored", m("textStyle", { color: "#ff0000" }), bold), t(" commented", m("comment", { commentId: "c1" }), italic), t(" plain")),
    p(t("bold", bold), t("bold again", bold), t(" then "), t("italic", italic)),
    p(t("highlight a", m("highlight", { color: "red" })), t("highlight b", m("highlight", { color: "blue" }))),
  ),

  "marks-code": doc(
    p(t("code", code), t(" and "), t("bold code", bold, code)),
    p(t("`tick`", code), t(" "), t("a`b", code), t(" "), t("`", code), t(" "), t("``", code), t(" "), t("a``b```c", code)),
    p(t(" spaced ", code), t("|"), t(" spaced bold ", code, bold), t("|"), t("  ", code)),
    p(t("specials * _ [ ] < > ~ | \\ $x == y", code)),
    p(t("code in link", code, link("https://example.com/"))),
    p(t("", code), t("after empty code")),
  ),

  "marks-whitespace": doc(
    p(t("a"), t(" b ", bold), t("c")),
    p(t("a "), t("b ", bold), t(" c", italic), t(" d")),
    p(t("  ", bold), t("x")),
    p(t("x"), t("\u00a0y\u00a0", italic), t("z")),
    p(t("a", bold), t(" b ", bold, italic), t("c", bold)),
    p(t("a", bold), t(" b ", italic), t("c", bold)),
    p(t(" lead", link("https://x.example")), t("trail ", link("https://x.example")), t("end")),
    p(t("\tTabbed\t", strike), t("\n", bold), t("after")),
    p(t("x"), t(" ", bold, italic), t(" ", italic), t("y")),
    p(t("x"), t("\u2028line separator\u2029", bold), t("\ufeffbom\ufeff", italic), t("\u3000wide\u3000", strike), t("y")),
    p(t("x"), t("\u0085next line is not white space\u0085", bold), t("\u200bnor is zero width\u200b", italic), t("y")),
    p(t(" only marks that do not count ", m("textStyle", { color: "red" }), m("comment", { commentId: "c" }))),
    p(t(" a ", bold), br(), t(" b ", bold)),
  ),

  "hard-breaks": doc(
    p(t("line one"), br(), t("line two")),
    p(t("bold", bold), { type: "hardBreak", marks: [bold] }, t("still bold", bold)),
    p(t("bold", bold), br(), t("still bold", bold), br(), t("plain")),
    p(t("a"), br(), t("# not a heading")),
    p(t("a"), br(), t("- not a list"), br(), t("1. not ordered"), br(), t("> not a quote")),
    p(br()),
    p(br(), br(), t("after two breaks")),
    p(t("trailing break"), br()),
    el("heading", { level: 2 }, t("heading"), br(), t("with a break"), br()),
    p(t("in a link", link("https://x.example")), br(), t("same link", link("https://x.example"))),
  ),

  "escapes": doc(
    p(t("\\ ` * _ [ ] < > ~ |")),
    p(t("a == b === c ==== d = e")),
    p(t("$5 and $x$ and $ 5 and 5$ and $$ and $\u00a0nbsp and $\ttab")),
    p(t("price: $")),
    p(t("# heading?")),
    p(t("## two")),
    p(t("###### six")),
    p(t("####### seven")),
    p(t("#hashtag")),
    p(t("#")),
    p(t("- dash")),
    p(t("-dash")),
    p(t("+ plus")),
    p(t("* star")),
    p(t("1. one")),
    p(t("12) twelve")),
    p(t("1.5 is a number")),
    p(t("١. arabic digit")),
    p(t("> quote")),
    p(t(">quote")),
    p(t("  > indented quote")),
    p(t("\u00a0# after a no-break space")),
    p(t("text\n# after newline\n- item\n1. x\n> q\n  + y\n\nlast")),
    p(t("<div>html</div> & entities &amp; \"quotes\" 'single'")),
    p(t("~~not strike~~ **not bold** [not](link) ![not](image) a_b_c `code` |pipe| ==mark==")),
    p(t("#"), t(" split across nodes")),
    p(t("1"), t(". split number")),
    p(t("-", bold), t(" bold dash")),
    p(t("$"), t("x split dollar")),
    p(t("="), t("= split equals")),
  ),

  "lists": doc(
    el("bulletList", undefined, li(p(t("one"))), li(p(t("two"))), li(p(t("three")))),
    el(
      "bulletList",
      undefined,
      li(
        p(t("parent")),
        el("bulletList", undefined, li(p(t("child"))), li(p(t("child two")), el("orderedList", { start: 1 }, li(p(t("deep one"))), li(p(t("deep two")))))),
      ),
      li(p(t("sibling"))),
    ),
    el("bulletList", undefined, li(p(t("first")), p(t("second paragraph"))), li(p(t("next item")))),
    el("orderedList", { start: 1 }, li(p(t("a"))), li(p(t("b")))),
    el("orderedList", { start: 5 }, li(p(t("five"))), li(p(t("six")))),
    el("orderedList", { start: 0 }, li(p(t("zero is falsy"))), li(p(t("so this is two")))),
    el("orderedList", { start: 3, type: "a" }, li(p(t("typed")))),
    raw("orderedList", null, [li(p(t("no attributes")))]),
    el(
      "orderedList",
      { start: 8 },
      li(p(t("eight")), p(t("more"))),
      li(p(t("nine")), el("bulletList", undefined, li(p(t("nested"))))),
      li(p(t("ten")), p(t("wider marker"))),
      li(p(t("eleven\nwith a newline"))),
    ),
    el(
      "taskList",
      undefined,
      el("taskItem", { checked: false }, p(t("todo"))),
      el("taskItem", { checked: true }, p(t("done")), el("taskList", undefined, el("taskItem", { checked: true }, p(t("sub task"))))),
      raw("taskItem", null, [p(t("no attributes"))]),
    ),
    el("orderedList", { start: 1 }, el("taskItem", { checked: true }, p(t("task in an ordered list")), p(t("second")))),
    el("taskList", undefined, li(p(t("plain item in a task list")))),
    el("bulletList", undefined, li(p(t("with code")), el("codeBlock", { language: "sh" }, t("ls -la\n\necho done"))), li(p(t("with quote")), el("blockquote", undefined, p(t("quoted"))))),
    el("bulletList"),
    el("bulletList", undefined, li(), li(p()), li(p(t("after empty items")))),
    el("bulletList", undefined, li(el("bulletList", undefined, li(p(t("list as the first child")))))),
    el("bulletList", undefined, li(p(t("# not a heading"))), li(p(t("- not nested"))), li(p(t("1. not ordered")))),
  ),

  "blockquotes": doc(
    el("blockquote", undefined, p(t("quoted"))),
    el("blockquote", undefined, p(t("first")), p(t("second"))),
    el("blockquote", undefined, p(t("outer")), el("blockquote", undefined, p(t("inner")), p(t("inner two")))),
    el("blockquote", undefined, el("bulletList", undefined, li(p(t("item"))), li(p(t("item two")))), el("codeBlock", { language: null }, t("code\n\nwith a blank line"))),
    el("blockquote"),
    el("blockquote", undefined, p()),
    el("blockquote", undefined, p(t("line one"), br(), t("line two"))),
  ),

  "code-blocks": doc(
    el("codeBlock", { language: "ts" }, t("const a = 1;\nconst b = `x`;")),
    el("codeBlock", { language: null }, t("no language")),
    el("codeBlock", { language: "md" }, t("```js\nfenced inside\n```")),
    el("codeBlock", { language: "html" }, t("<b>bold</b> & \"quoted\"")),
    el("codeBlock"),
    el("codeBlock", { language: "py" }, t("split "), t("across "), t("nodes")),
    el("codeBlock", { language: "txt" }, t("a\n\n\n\nb")),
    el("codeBlock", { language: "c++ extra" }, t("int main() {}")),
    el("codeBlock", { language: "" }, t("# not escaped\n- nor this\n$x$ *y*")),
    raw("codeBlock", null, [t("no attributes")]),
    el("codeBlock", { language: "js" }, t("marks are ignored", bold), br(), raw("mention", { label: "no text" })),
  ),

  "rules": doc(p(t("above")), el("horizontalRule"), p(t("between")), el("pageBreak"), p(t("below")), el("horizontalRule"), el("horizontalRule")),

  "media": doc(
    el("image", { src: `${FILE}/photo one.png`, alt: "A photo", width: 640, height: 480, align: "left", attachmentId: UUID, size: 12345, aspectRatio: 1.3333 }),
    el("image", { src: "https://example.com/pic (1).png", alt: "External [pic]" }),
    el("image", { src: "data:image/png;base64,iVBORw0KGgo=" }),
    el("image", { src: "javascript:alert(1)", alt: "unsafe" }),
    el("image", { src: "data:text/html,<script>alert(1)</script>" }),
    raw("image"),
    raw("image", { src: "relative/path.png", title: "A title" }),
    el("video", { src: `${FILE}/my%20clip.mp4`, alt: "A clip", width: 800, height: 450, align: "center", attachmentId: UUID, size: 999, aspectRatio: 1.7778 }),
    el("video", { src: `${FILE}/my%20clip.mp4` }),
    el("video", { src: "https://example.com/v/%E0%A4%A.mp4" }),
    el("video", { src: "https://example.com/v/" }),
    raw("video"),
    el("audio", { src: `${FILE}/sound.mp3`, attachmentId: UUID, size: 4321 }),
    raw("audio", { src: "sound%5Bfinal%5D.mp3", name: "ignored for html" }),
    raw("audio"),
    el("attachment", { url: `${FILE}/report (final).pdf`, name: "report (final).pdf", mime: "application/pdf", size: 2048, attachmentId: UUID }),
    el("attachment", { url: "https://example.com/file.zip" }),
    el("attachment", { url: `${FILE}/a.txt`, name: "*starred* [name]" }),
    raw("attachment"),
    el("pdf", { src: `${FILE}/paper.pdf`, name: "paper.pdf", attachmentId: UUID, size: 100000 }),
    el("pdf", { src: `${FILE}/paper.pdf`, width: "100%", height: 900 }),
    raw("pdf", { src: "x/y/z.pdf" }),
    raw("pdf"),
    el("drawio", { src: `${FILE}/diagram.drawio.svg`, title: "Flow", alt: "A flow chart", width: 500, height: 300, size: 777, aspectRatio: 1.6667, align: "right", attachmentId: UUID }),
    el("drawio", { src: `${FILE}/diagram.drawio.svg`, title: "Title only" }),
    el("excalidraw", { src: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", alt: "Sketch", width: "50%" }),
    raw("excalidraw"),
    raw("drawio", { src: "vbscript:x", width: 0 }),
  ),

  "tables": doc(
    table(row(th(p(t("Name"))), th(p(t("Value")))), row(cell(p(t("a"))), cell(p(t("1")))), row(cell(p(t("b"))), cell(p(t("2"))))),
    table(row(cell(p(t("bold", bold), t(" and "), t("link", link("https://x.example")))), cell(p(t("line one"), br(), t("line two")))), row(cell(p(t("a | b"))), cell(p(t("text\nwith a newline"))))),
    table(row(cell(p(t("one"))), cell(p(t("two"))), cell(p(t("three")))), row(cell(p(t("short")))), row()),
    table(row(cell(p()), cell()), row(cell(p(t("x"))), raw("tableCell"))),
    table(row(th(p(t("only a header"))))),
    table(row()),
    table(row(), row(cell(p(t("second row is wider"))))),
    table(row(el("tableCell", { colspan: 2 }, p(t("wide"))), cell(p(t("c")))), row(cell(p(t("a"))), cell(p(t("b"))), cell(p(t("c"))))),
    table(row(el("tableCell", { rowspan: 2 }, p(t("tall"))), cell(p(t("b")))), row(cell(p(t("c"))))),
    table(row(cell(p(t("first")), p(t("second")))), row(cell(el("bulletList", undefined, li(p(t("item"))))))),
    table(row(cell(el("image", { src: `${FILE}/in cell.png` })))),
    table(
      row(el("tableHeader", { colwidth: [120], backgroundColor: "#eeeeee", backgroundColorName: "Gray" }, p(t("styled header"))), el("tableHeader", { colwidth: [80, 90] }, p(t("two widths")))),
      row(el("tableCell", { backgroundColor: "rgba(255, 0, 0, 0.5)", backgroundColorName: "RED" }, p(t("red"))), el("tableCell", { backgroundColor: "url(evil)" }, p(t("bad color")))),
    ),
    el("blockquote", undefined, table(row(cell(p(t("quoted table"))), cell(p(t("x")))), row(cell(p(t("y"))), cell(p(t("z")))))),
    table(row(cell(p(t("$a$ and "), el("mathInline", { text: "x|y" }), t(" "), el("mention", { label: "Sam|Lee", entityType: "user" }))))),
    table(row(cell(el("heading", { level: 2 }, t("a heading is not a paragraph"))))),
  ),

  "callouts": doc(
    ...["info", "warning", "danger", "success", "note", "default"].map((type) => el("callout", { type }, p(t(`A ${type} callout`)))),
    el("callout", { type: "info", icon: "💡" }, p(t("with an icon")), p(t("and two paragraphs"))),
    raw("callout", null, [p(t("no attributes"))]),
    el("callout", { type: "warning" }, el("callout", { type: "danger" }, p(t("nested"))), el("bulletList", undefined, li(p(t("item"))))),
    el("callout"),
  ),

  "details": doc(
    el("details", { open: false }, el("detailsSummary", undefined, t("Summary "), t("bold", bold)), el("detailsContent", undefined, p(t("Hidden")), el("bulletList", undefined, li(p(t("item")))))),
    el("details", { open: true }, el("detailsSummary", undefined, t("Open")), el("detailsContent", undefined, p(t("Shown")))),
    el("details", undefined, el("detailsContent", undefined, p(t("no summary")))),
    el("details", undefined, el("detailsSummary", undefined, t("no content"))),
    el("details", undefined, el("detailsContent", undefined, p(t("content first"))), el("detailsSummary", undefined, t("summary second"))),
    el("details", undefined, el("detailsSummary", undefined, t("first summary")), el("detailsSummary", undefined, t("second summary")), el("detailsContent"), el("detailsContent", undefined, p(t("second content")))),
    el("details"),
    el("detailsContent", undefined, p(t("content on its own"))),
    el("detailsSummary", undefined, t("summary on its own")),
    el("details", undefined, el("detailsSummary", undefined, t("# not a heading"), br(), t("second line")), el("detailsContent", undefined, el("details", undefined, el("detailsSummary", undefined, t("nested")), el("detailsContent", undefined, p(t("deep")))))),
  ),

  "columns": doc(
    el("columns", { layout: "two_equal" }, el("column", { width: 50 }, p(t("left"))), el("column", { width: 50 }, p(t("right")))),
    el("columns", { layout: "three_equal", widthMode: "wide" }, el("column", undefined, p(t("one"))), el("column", { width: "30%" }, p(t("two"))), el("column", { width: 0 }, p(t("three")), p(t("three b")))),
    raw("columns", null, [raw("column", null, [p(t("no attributes"))])]),
    el("column", { width: 1.5 }, p(t("a column on its own"))),
    el("columns"),
  ),

  "transclusion": doc(
    el("transclusionSource", { id: "sync-1" }, p(t("synced paragraph")), el("bulletList", undefined, li(p(t("synced item"))))),
    el("transclusionReference", { sourcePageId: PAGE, transclusionId: "sync-1" }),
    raw("transclusionSource"),
    raw("transclusionReference"),
    p(t("after")),
  ),

  "footnotes": doc(
    p(
      t("A claim"),
      el("footnoteReference", { "data-id": "fn-a", referenceNumber: 1 }),
      t(" and another"),
      el("footnoteReference", { "data-id": "fn-b", referenceNumber: 2, href: "#fn:2" }),
      t(" and one by id"),
      el("footnoteReference", { "data-id": "fn-c" }),
      t(" and a bare one"),
      raw("footnoteReference"),
      t(" and a marked one"),
      { ...el("footnoteReference", { "data-id": "fn-d", referenceNumber: 4 }), marks: [bold] },
    ),
    el(
      "footnotes",
      undefined,
      el("footnote", { id: "fn:1", "data-id": "fn-a" }, p(t("First note."))),
      el("footnote", { id: "fn:2", "data-id": "fn-b" }, p(t("Second note.")), p(t("It has two paragraphs."))),
      el("footnote", { id: "fn:3", "data-id": "fn-c" }, p(t("Third, with "), t("bold", bold), t(".\nAnd a newline."))),
      raw("footnote"),
    ),
  ),

  "math": doc(
    p(t("Inline "), el("mathInline", { text: "a^2 + b^2 = c^2" }), t(" done")),
    p(el("mathInline", { text: "x < y | z $ w" }), el("mathInline"), raw("mathInline")),
    p(t("bold", bold), el("mathInline", { text: "x" }), t("bold again", bold)),
    el("mathBlock", { text: "\\int_0^1 x\\,dx" }),
    el("mathBlock", { text: "a &= b \\\\\nc &= d" }),
    el("mathBlock", { text: "<tag> & \"quotes\"" }),
    el("mathBlock"),
    raw("mathBlock"),
  ),

  "mentions": doc(
    p(t("Hello "), el("mention", { id: "m1", label: "Sam Lee", entityType: "user", entityId: USER, creatorId: USER }), t("!")),
    p(el("mention", { id: "m2", label: "Other page", entityType: "page", entityId: PAGE, slugId: "AbC123", creatorId: USER })),
    p(el("mention", { id: "m3", label: "Section", entityType: "page", entityId: PAGE, slugId: "AbC123", anchorId: "heading-2" })),
    p(el("mention", { id: "m4", label: "No slug", entityType: "page", entityId: PAGE })),
    p(el("mention", { id: "m5", label: "Slug only", entityType: "page", slugId: "xYz789" })),
    p(el("mention", { id: "fallback-id", entityType: "user" })),
    p(el("mention")),
    p(raw("mention")),
    p(el("mention", { label: "*Starred* [page]", entityType: "page", slugId: "Star1", anchorId: "a b#c" })),
    p(el("mention", { label: "<Angle> & \"Quote\"", entityType: "user", entityId: "u2" })),
    p(t("in bold ", bold), { ...el("mention", { label: "Sam", entityType: "user", entityId: USER }), marks: [bold] }, t(" still bold", bold)),
    p(el("mention", { label: "Group", entityType: "group", entityId: "g1", slugId: "Grp1" })),
    p(el("mention", { label: "Numeric anchor", entityType: "page", slugId: "Num1", anchorId: 5 })),
    p(el("mention", { label: "Empty anchor", entityType: "page", slugId: "Emp1", anchorId: "" })),
    p(el("mention", { label: "Zero anchor", entityType: "page", slugId: "Zer0", anchorId: 0 })),
    p(el("mention", { label: "Object anchor", entityType: "page", slugId: "Obj1", anchorId: { id: "x" } })),
    p(el("mention", { label: "Numeric slug", entityType: "page", slugId: 42 })),
    p(el("mention", { label: "Empty slug", entityType: "page", slugId: "" })),
    p(el("mention", { label: "User with a slug", entityType: "user", slugId: "Usr1" })),
  ),

  "status": doc(
    p(t("State: "), el("status", { text: "In progress", color: "blue" }), t(" ")),
    p(el("status"), raw("status"), el("status", { text: "*done* <ok>", color: "green" })),
    p(t("bold", bold), el("status", { text: "mid" }), t("bold", bold)),
  ),

  "embeds": doc(
    el("embed", { src: "https://www.figma.com/file/abc?node-id=1", provider: "figma" }),
    el("embed", { src: "javascript:alert(1)", provider: "evil" }),
    el("embed", { src: `${FILE}/not rewritten.html`, provider: "iframe", align: "left", width: 400, height: 300 }),
    raw("embed"),
    el("youtube", { src: "https://www.youtube.com/embed/dQw4w9WgXcQ", start: 10 }),
    el("youtube", { src: "https://www.youtube.com/embed/x_(y)", width: 320, height: 240 }),
    el("youtube"),
    raw("youtube"),
    el("subpages"),
    el("base", { pageId: PAGE }),
    el("base"),
    raw("base"),
  ),

  "unknown-types": doc(
    raw("widget"),
    raw("widget", { a: 1 }, [p(t("inside a widget"))]),
    raw("widget", null, []),
    p(t("inline: "), raw("gadget"), raw("gadget", null, [t("gadget text")]), { type: "gadget", text: "text on a gadget" }, t(" end")),
    raw("constructor", null, [p(t("a node called constructor"))]),
    raw("__proto__", null, [p(t("a node called __proto__"))]),
    raw("toString"),
    p(raw("hasOwnProperty", null, [t("inline inherited name")]), raw("valueOf")),
    t("text at block level"),
    doc(p(t("a document inside a document"))),
    li(p(t("a list item at the top"))),
    row(cell(p(t("a row at the top")))),
    cell(p(t("a cell at the top"))),
    p(p(t("a paragraph inside a paragraph")), t(" and text")),
    br(),
    el("mention", { label: "mention at block level", entityType: "user", entityId: "u9" }),
    { type: "text", text: "text with content", content: [t("ignored")] },
    { type: "paragraph", text: "text on a paragraph", content: [t("content")] },
    raw("", null, [p(t("empty type"))]),
    { content: [p(t("no type"))] },
  ),

  "proto-marks": doc(
    p(t("a", bold), t("b", bold, { type: "constructor" }), t("c", bold)),
    p(t("a", { type: "__proto__" }, bold), t("b", bold, { type: "__proto__" })),
    p(t(" spaced ", { type: "toString" }), t("x")),
    p(t("a", { type: "hasOwnProperty" }, { type: "valueOf" }, link("https://x.example")), t("b", link("https://x.example"), { type: "valueOf" })),
    p(t("a", { type: "constructor", attrs: { x: 1 } }), t("b", { type: "constructor", attrs: { x: 2 } }), t("c", { type: "constructor" })),
    p(...["toLocaleString", "propertyIsEnumerable", "isPrototypeOf", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"].map((type) => t(` ${type} `, { type }, italic))),
  ),

  "mark-attrs-odd": doc(
    p(t("string attrs", { type: "link", attrs: "https://example.com/" })),
    p(t("number attrs", { type: "link", attrs: 5 })),
    p(t("null attrs", { type: "link", attrs: null })),
    p(t("array attrs", { type: "link", attrs: ["https://example.com/"] })),
    p(t("true attrs", { type: "link", attrs: true })),
    p(t("no attrs", { type: "link" })),
    p(t("number href", { type: "link", attrs: { href: 5 } })),
    p(t("null href", { type: "link", attrs: { href: null } })),
    p(t("array href", { type: "link", attrs: { href: ["/api/files/x", "y z"] } })),
    p(t("object href", { type: "link", attrs: { href: { a: 1 } } })),
    p(t("false href", { type: "link", attrs: { href: false } })),
    p(t("bold a", { type: "bold", attrs: { x: 1 } }), t("bold b", { type: "bold", attrs: { x: 2 } }), t("bold c", { type: "bold" }), t("bold d", { type: "bold", attrs: {} }), t("bold e", { type: "bold", attrs: null })),
    p(t("bold a", { type: "bold", attrs: "s" }), t("bold b", { type: "bold", attrs: "s" }), t("bold c", { type: "bold", attrs: 1 }), t("bold d", { type: "bold", attrs: 1.0 }), t("bold e", { type: "bold", attrs: [] })),
    p(t("x", { type: "highlight", attrs: { color: 5, colorName: 5 } }), t("y", { type: "highlight", attrs: { color: ["red"], colorName: ["RED", "Blue"] } }), t("z", { type: "highlight", attrs: { color: true, colorName: true } })),
    p(t("x", { type: "textStyle", attrs: { color: " blue " } }), t("y", { type: "textStyle", attrs: { color: 0 } }), t("z", { type: "textStyle", attrs: { color: null } })),
    p(t("x", { type: "comment", attrs: { commentId: 12, resolved: "no" } }), t("y", { type: "comment", attrs: { commentId: null, resolved: 0 } }), t("z", { type: "comment", attrs: { commentId: ["a", "b"], resolved: [] } })),
    p(t("x", { type: "link", attrs: { href: "https://x.example", target: 0, rel: false, class: ["a", "b"], internal: "yes" } }), t("y", { type: "link", attrs: { href: "https://x.example", target: "", rel: "", class: "", internal: 0 } })),
  ),

  "links": doc(
    p(t("spaces and parentheses", link("https://example.com/a b(c)"))),
    p(t("white space", link("https://example.com/a\nb\tc\u00a0d\u2028e\ufefff"))),
    p(t("internal", link("/s/general/p/my-title-XyZ123", { internal: true, target: null, rel: null }))),
    p(t("short", link("/p/Q1w2E3#heading"))),
    p(t("absolute", link("https://doc.example.com/s/space/p/%ED%95%9C-SLUG4?x=1"))),
    p(t("file", link(`${FILE}/doc one.pdf`))),
    p(t("not quite a file", link("/api/filesystem/x"))),
    p(t("script", link("javascript:alert(1)"))),
    p(t("mail", link("mailto:someone@example.com?subject=Hello there"))),
    p(t("empty", link(""))),
    p(t("anchor", link("#section-2"))),
    p(t("classes", link("https://example.com/", { class: "external fancy", target: "_self", rel: "noopener" }))),
    p(t("[brackets] in *text*", link("https://example.com/?q=[x]"))),
    p({ ...el("mention", { label: "linked mention", entityType: "user", entityId: "u3" }), marks: [link("/p/OnMention1")] }),
    { ...p(t("a link mark on a paragraph")), marks: [link("/p/OnBlock2")] },
    p(t("again", link("/s/general/p/other-title-XyZ123")), t(" and malformed", link("/p/%zz")), t(" and long", link(`/p/${"x".repeat(33)}`))),
  ),

  "doc-text": doc(
    el("heading", { level: 1 }, t("Title")),
    p(t("Hello "), el("mention", { entityType: "user", entityId: "u1", label: "Sam" }), t("!")),
    p(),
    el("bulletList", undefined, li(p(t("item "), el("mathInline", { text: "x^2" })))),
    el("mathBlock", { text: "E = mc^2" }),
    el("codeBlock", undefined, t("const a = 1;\nconst b = 2;")),
    p(
      el("mention", { entityType: "page", entityId: "p-uuid", slugId: "abc", label: "Other page" }),
      t(" and "),
      t("link", link("/s/general/p/my-title-XyZ123")),
      t(" and "),
      t("short", link("https://doc.example.com/p/Q1w2E3#heading")),
      t(" and "),
      t("external", link("https://example.com/blog")),
    ),
    p(t("again "), el("mention", { entityType: "user", entityId: "u1", label: "Sam" })),
    p(el("mention", { entityType: "user", entityId: "u2", label: "Lee" })),
  ),

  "doc-text-more": doc(
    p(t("line"), br(), t("break")),
    p(t("   ")),
    p(t("\u00a0\ufeff")),
    p(el("status", { text: "Status text" }), t(" "), el("footnoteReference", { referenceNumber: 1 }), raw("gadget", null, [t("nested "), raw("gizmo", null, [t("deeper")])])),
    el("codeBlock", undefined),
    el("codeBlock", undefined, t("  \n ")),
    el("attachment", { url: `${FILE}/a.pdf`, name: "attachment name.pdf" }),
    el("attachment", { url: `${FILE}/a.pdf` }),
    el("pdf", { src: `${FILE}/b.pdf`, name: "pdf name.pdf" }),
    el("image", { src: `${FILE}/c.png`, alt: "images have no text" }),
    table(row(cell(p(t("cell one"))), cell(p(t("cell two"))))),
    el("details", undefined, el("detailsSummary", undefined, t("summary text")), el("detailsContent", undefined, p(t("content text")))),
    p(p(t("a paragraph in a paragraph")), t(" with text beside it")),
    raw("widget", null, [t("inline children make a line")]),
    raw("widget", null, [t("mixed children: "), p(t("only the block is read"))]),
    el("mathBlock", { text: "" }),
    el("mathBlock", { text: 0 }),
    el("mathBlock", { text: 42 }),
    el("attachment", { name: ["a", "b"] }),
    p(el("mention", { label: null }), el("mention", { label: 7 }), el("mathInline", { text: false }), el("status", { text: [1, [2]] })),
    p(t("user mentions: "), el("mention", { entityType: "user", entityId: "" }), el("mention", { entityType: "user", entityId: 5 }), el("mention", { entityType: "user" }), el("mention", { entityType: "user", entityId: "u1" }), el("mention", { entityType: "user", entityId: "u1" })),
    p(t("page mentions: "), el("mention", { entityType: "page", entityId: "", slugId: "Fallback1" }), el("mention", { entityType: "page", entityId: 5, slugId: "Fallback2" }), el("mention", { entityType: "page", entityId: "p1", slugId: "Unused" }), el("mention", { entityType: "page", slugId: "" }), el("mention", { entityType: "page", slugId: 5 }), el("mention", { entityType: "page", entityId: "p1" }), el("mention", { entityType: "PAGE", entityId: "p2" })),
  ),

  "whitespace-around": doc(p(t("\u00a0\ufeff ")), p(), p(t(" leading and trailing ")), p(), p(), p(), p(t("after three empty paragraphs")), p(t(" \u3000")), p()),

  "export-like": doc(
    p(t("go to "), t("setup", link("Guide/Setup.html"))),
    el("image", { src: `${FILE}/diagram one.png`, attachmentId: UUID }),
    p(t("hello", bold)),
    p(t("file link", link(`${FILE}/notes (v2).txt`))),
    p(el("mention", { label: "Setup", entityType: "page", slugId: "Setup1", anchorId: "install steps" })),
  ),

  "unicode": doc(
    el("heading", { level: 1 }, t("Ünïcödé 日本語 한글 עברית العربية")),
    p(t("emoji 😀 👨‍👩‍👧 🇰🇷 and combining e\u0301 n\u0303")),
    p(t("😀", bold), t(" 𝒜 ", italic), t("𠀀", m("highlight", { color: "red", colorName: "ROT ÄÖÜ İ ΣΑΣ ǅ" }))),
    table(row(el("tableCell", { backgroundColorName: "ΌΣΟΣ ΑΣ Σ" }, p(t("sigma"))), el("tableCell", { backgroundColorName: "İSTANBUL ẞ Ⅻ" }, p(t("dotted i"))))),
    el("codeBlock", { language: "한글" }, t("변수 = 1")),
    p(t("link", link("https://example.com/경로/파일 이름.txt"))),
    el("image", { src: "https://example.com/图片 (1).png", alt: "图片" }),
    el("video", { src: "https://example.com/%E1%84%92%E1%85%A1%E1%86%AB.mp4" }),
  ),

  "numbers": doc(
    el("paragraph", { indent: 1e21 }, t("large indent")),
    el("paragraph", { indent: 1e-7 }, t("tiny indent")),
    el("paragraph", { indent: 0.1 + 0.2 }, t("sum")),
    el("paragraph", { indent: -0 }, t("negative zero")),
    el("paragraph", { indent: 123456789012345678 }, t("eighteen digits")),
    el("paragraph", { indent: 5e-324 }, t("smallest")),
    el("paragraph", { indent: 1.7976931348623157e308 }, t("largest")),
    el("orderedList", { start: 1e21 }, li(p(t("huge"))), li(p(t("huge + 1")))),
    el("orderedList", { start: 9007199254740992 }, li(p(t("2^53"))), li(p(t("2^53 + 1")))),
    el("orderedList", { start: -3 }, li(p(t("negative"))), li(p(t("x"))), li(p(t("y"))), li(p(t("zero"))), li(p(t("one")))),
    el("orderedList", { start: 0.5 }, li(p(t("half")), p(t("indented under a wide marker")))),
    el("orderedList", { start: 99 }, li(p(t("ninety-nine")), p(t("three"))), li(p(t("one hundred")), p(t("four")))),
    el("heading", { level: 2.5 }, t("two and a half")),
    el("heading", { level: 5.999 }, t("almost six")),
    el("heading", { level: -1 }, t("negative")),
    el("heading", { level: 1e21 }, t("huge")),
    table(row(el("tableCell", { colspan: 1.5, rowspan: 1e21, colwidth: [1.5, 1e21, 1e-7, -0] }, p(t("spans"))))),
    el("column", { width: 0.30000000000000004 }, p(t("flex"))),
    el("image", { src: "x.png", width: 1e21, height: 1e-7, size: 12345678901234567890, aspectRatio: 0.1 + 0.2 }),
  ),

  "odd-attrs-blocks": doc(
    el("heading", { level: "2" }, t("string level")),
    el("heading", { level: true }, t("true level")),
    el("heading", { level: [3] }, t("array level")),
    el("heading", { level: "abc" }, t("word level")),
    el("heading", { level: null, id: 7 }, t("null level, numeric id")),
    el("heading", { level: "0x4", id: "" }, t("hex level, empty id")),
    el("heading", { level: " 5 ", id: false }, t("padded level, false id")),
    el("heading", { level: {}, id: ["a", "b"] }, t("object level, array id")),
    el("paragraph", { id: 0, textAlign: ["center"], indent: "2" }, t("array align, string indent")),
    el("paragraph", { id: true, textAlign: "CENTER", indent: true }, t("upper-case align, true indent")),
    el("paragraph", { id: {}, textAlign: 5, indent: [3] }, t("object id, numeric align, array indent")),
    el("paragraph", { textAlign: "right ", indent: -1 }, t("padded align, negative indent")),
    el("paragraph", { textAlign: null, indent: "abc" }, t("null align, word indent")),
    el("paragraph", { indent: "Infinity" }, t("infinite indent")),
    el("orderedList", { start: "3", type: 1 }, li(p(t("string start")))),
    el("orderedList", { start: "abc", type: false }, li(p(t("word start")))),
    el("orderedList", { start: null, type: "" }, li(p(t("null start")))),
    el("orderedList", { start: true }, li(p(t("true start")))),
    el("orderedList", { start: [7] }, li(p(t("array start"))), li(p(t("next")))),
    el("orderedList", { start: "Infinity" }, li(p(t("infinite start")))),
    el("orderedList", { start: "" }, li(p(t("empty start")))),
    el("bulletList", { start: 5 }, li(p(t("bullets ignore start")))),
    el("taskList", undefined, el("taskItem", { checked: "false" }, p(t("string false is truthy"))), el("taskItem", { checked: 0 }, p(t("zero"))), el("taskItem", { checked: [] }, p(t("empty array is truthy"))), el("taskItem", { checked: "" }, p(t("empty string"))), el("taskItem", { checked: null }, p(t("null")))),
    el("codeBlock", { language: 0 }, t("zero language")),
    el("codeBlock", { language: false }, t("false language")),
    el("codeBlock", { language: ["js", "ts"] }, t("array language")),
    el("codeBlock", { language: {} }, t("object language")),
    el("codeBlock", { language: 3.5 }, t("number language")),
    el("codeBlock", { language: "<script>" }, t("markup language")),
    el("callout", { type: 5, icon: 0 }, p(t("numeric type"))),
    el("callout", { type: null, icon: false }, p(t("null type"))),
    el("callout", { type: ["a", "b"], icon: {} }, p(t("array type"))),
    el("callout", { type: "", icon: "" }, p(t("empty type"))),
    el("details", { open: "no" }, el("detailsSummary", undefined, t("string open")), el("detailsContent", undefined, p(t("x")))),
    el("details", { open: 0 }, el("detailsSummary", undefined, t("zero open")), el("detailsContent", undefined, p(t("x")))),
    el("columns", { layout: 5, widthMode: "WIDE" }, el("column", { width: "50" }, p(t("string width"))), el("column", { width: true }, p(t("true width"))), el("column", { width: [2] }, p(t("array width"))), el("column", { width: "abc" }, p(t("word width")))),
    el("columns", { layout: null, widthMode: ["wide"] }, el("column", { width: -1 }, p(t("negative width")))),
    el("transclusionSource", { id: 5 }, p(t("numeric id"))),
    el("transclusionReference", { sourcePageId: 1, transclusionId: false }),
    el("mathBlock", { text: 5 }),
    el("mathBlock", { text: null }),
    el("mathBlock", { text: ["a", "b"] }),
    el("mathBlock", { text: {} }),
    el("base", { pageId: 12 }),
    el("base", { pageId: ["a"] }),
    el("footnotes", undefined, el("footnote", { id: 1, "data-id": 2 }, p(t("numeric ids"))), el("footnote", { id: false, "data-id": "" }, p(t("false and empty")))),
  ),

  "odd-attrs-media": doc(
    el("image", { src: 5, alt: 5, width: 0, height: "", align: false, attachmentId: 0, size: "", aspectRatio: [] }),
    el("image", { src: null, alt: null, width: "0", height: false, align: null, attachmentId: [1, 2], size: {}, aspectRatio: true }),
    el("image", { src: ["https://example.com/a.png"], alt: ["a", "b"], width: [100], height: { h: 1 } }),
    el("image", { src: { url: "x" }, alt: {}, title: "title is not used for the element" }),
    el("image", { src: " https://example.com/padded.png ", alt: "" }),
    el("image", { src: "", alt: 0, title: 0 }),
    el("image", { src: true }),
    el("video", { src: 5, alt: 0, width: true, height: null }),
    el("video", { src: ["a/b", "c/d.mp4"], alt: null, name: 12 }),
    el("video", { src: null, name: null }),
    el("video", { src: "dir/", name: false }),
    el("audio", { src: {}, attachmentId: true, size: 0 }),
    el("audio", { src: "a%2Fb/c%20d.mp3", alt: undefined }),
    el("attachment", { url: 5, name: 0, mime: 0, size: 0, attachmentId: 0 }),
    el("attachment", { url: null, name: false, mime: false, size: false }),
    el("attachment", { url: ["https://example.com/x y"], name: ["a", "b"], mime: [], size: [1] }),
    el("attachment", { url: "https://example.com/z", name: "" }),
    el("attachment", { url: "https://example.com/z", name: {} }),
    el("pdf", { src: 5, name: 5, width: null, height: null }),
    el("pdf", { src: "p.pdf", name: null, width: 0, height: "" }),
    el("pdf", { src: "p.pdf", alt: "alt wins", name: "name", width: false, height: [1, 2] }),
    el("pdf", { src: "p.pdf", width: "<b>", height: {} }),
    el("drawio", { src: 5, title: 5, alt: null, width: "0" }),
    el("drawio", { src: "d.svg", title: null, alt: null, width: [] }),
    el("drawio", { src: "d.svg", title: "", alt: undefined, width: "" }),
    el("excalidraw", { src: "e.svg", title: 0, alt: "", width: "\"quoted\"" }),
    el("excalidraw", { src: "e.svg", title: false, width: 0 }),
    el("embed", { src: 5, provider: 5, align: 5, width: "wide", height: null }),
    el("embed", { src: ["https://example.com/"], provider: null, width: 0, height: false }),
    el("youtube", { src: 5, width: null, height: null }),
    el("youtube", { src: "https://youtu.be/x", width: 0, height: "" }),
    el("youtube", { src: "https://youtu.be/x", width: false, height: ["1", 2] }),
  ),

  "odd-attrs-inline": doc(
    p(el("mention", { id: 5, label: 0, entityType: "user" }), el("mention", { id: 5, label: null, entityType: "user" }), el("mention", { id: 0, label: "", entityType: "user" }), el("mention", { id: false, label: false })),
    p(el("mention", { label: ["a", "b"], entityType: ["user"] }), el("mention", { label: {}, entityType: 5, entityId: 5, slugId: 5, creatorId: 5, anchorId: 5 })),
    p(el("mention", { label: "page", entityType: "page", slugId: ["Abc"], anchorId: ["x", "y"] }), el("mention", { label: "page", entityType: "page", slugId: true, anchorId: true }), el("mention", { label: "page", entityType: "page", slugId: {}, anchorId: false })),
    p(el("mention", { label: "page", entityType: "page", slugId: "0", anchorId: null }), el("mention", { label: "page", entityType: "page", slugId: 0, anchorId: "x" }), el("mention", { label: "page", entityType: "page", slugId: [], anchorId: [] })),
    p(el("mathInline", { text: 5 }), el("mathInline", { text: null }), el("mathInline", { text: ["a", "b"] }), el("mathInline", { text: true }), el("mathInline", { text: {} })),
    p(el("status", { text: 5, color: 5 }), el("status", { text: null, color: null }), el("status", { text: ["*a*"], color: ["red"] }), el("status", { text: false, color: false }), el("status", { text: "", color: "" })),
    p(el("footnoteReference", { "data-id": 5, referenceNumber: 0 }), el("footnoteReference", { "data-id": 0, referenceNumber: null }), el("footnoteReference", { "data-id": false, referenceNumber: "" }), el("footnoteReference", { "data-id": ["a"], referenceNumber: ["1", "2"] }), el("footnoteReference", { "data-id": "<x>", referenceNumber: "\"1\"" })),
  ),

  "odd-attrs-tables": doc(
    table(row(el("tableCell", { colspan: "1", rowspan: true }, p(t("string and true are one"))), el("tableCell", { colspan: [1], rowspan: " 1 " }, p(t("array and padded are one"))))),
    table(row(el("tableCell", { colspan: null, rowspan: null }, p(t("null is the default"))), raw("tableCell", {}, [p(t("missing too"))]))),
    table(row(el("tableCell", { colspan: "2" }, p(t("string two"))))),
    table(row(el("tableCell", { colspan: "" }, p(t("empty string is zero"))))),
    table(row(el("tableCell", { rowspan: "abc" }, p(t("not a number"))))),
    table(row(el("tableCell", { colspan: 0 }, p(t("zero"))))),
    table(row(el("tableCell", { colspan: false }, p(t("false is zero"))))),
    table(row(el("tableCell", { colwidth: "100" }, p(t("string colwidth")))), row(el("tableCell", { colwidth: [] }, p(t("empty colwidth")))), row(el("tableCell", { colwidth: [100, null, "x", [1, 2], {}, true] }, p(t("mixed colwidth")))), row(el("tableCell", { colwidth: { 0: 100 } }, p(t("object colwidth"))))),
    table(row(el("tableHeader", { backgroundColor: 5, backgroundColorName: 5 }, p(t("numeric color"))), el("tableHeader", { backgroundColor: ["red"], backgroundColorName: ["Dark", "Red"] }, p(t("array color"))), el("tableHeader", { backgroundColor: " #ABCDEF ", backgroundColorName: 0 }, p(t("padded color"))), el("tableHeader", { backgroundColor: "", backgroundColorName: "" }, p(t("empty color"))))),
  ),

  "structure-odd": doc(
    table(row(t("text directly in a row")), row(cell(t("text directly in a cell")))),
    table(cell(p(t("a cell directly in a table")))),
    table(p(t("a paragraph directly in a table"))),
    el("bulletList", undefined, p(t("a paragraph directly in a list")), li(p(t("a real item")))),
    el("bulletList", undefined, t("text directly in a list")),
    el("orderedList", { start: 2 }, li(t("text directly in an item")), li(el("bulletList", undefined, li(p(t("nested first")))), el("bulletList", undefined, li(p(t("nested second")))))),
    el("blockquote", undefined, t("text directly in a quote")),
    el("footnotes", undefined, p(t("a paragraph directly in footnotes"))),
    el("details", undefined, p(t("a paragraph directly in details"))),
    el("columns", undefined, p(t("a paragraph directly in columns"))),
    { ...el("image", { src: "x.png" }), content: [p(t("content of an image"))] },
    { ...el("horizontalRule"), content: [p(t("content of a rule"))] },
    { ...el("mathBlock", { text: "x" }), content: [p(t("content of a math block"))] },
    { ...p(t("marks on a paragraph")), marks: [bold] },
    p({ ...br(), content: [t("content of a break")] }, { ...el("mathInline", { text: "y" }), content: [t("content of inline math")] }),
  ),

  "table-without-rows": doc(p(t("before")), el("table"), p(t("between")), raw("table"), raw("table", null, []), p(t("after"))),

  "deep": doc(
    Array.from({ length: 30 }).reduce<Tree>((inner, _, i) => (i % 2 ? el("blockquote", undefined, inner) : el("bulletList", undefined, li(p(t(`level ${i}`)), inner))), p(t("deepest"))),
  ),
};

// ---------------------------------------------------------------------------
// Markdown that the parser turns into documents: realistic attributes, and the
// cases of common/editor/markdown.test.ts.

const markdownSources: Record<string, string> = {
  "test: parses common blocks": `# Title\n\nSome **bold** and *italic* with \`code\` and [a link](https://x.y).\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [ ] todo\n- [x] done\n\n> quote\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n:::warning\nCareful\n:::\n\n$$\nx^2\n$$\n`,
  "test: round trips": `# Title\n\nSome **bold** text, ~~struck~~, ==marked==.\n\n- one\n- two\n\n1. a\n2. b\n\n\`\`\`js\nx()\n\`\`\`\n\n| h1 | h2 |\n| --- | --- |\n| c1 | c2 |\n`,
  "test: keeps korean text and inline math": "안녕하세요 $a+b$ 세계",
  "footnotes": "A claim[^1] and another[^note].\n\n[^1]: The first note.\n[^note]: The second note.\n",
  "details": "<details>\n<summary>More</summary>\n\nHidden **text**.\n\n- item\n\n</details>\n",
  "nested lists": "1. one\n   - a\n   - b\n     1. deep\n2. two\n\n   continued\n\n- [x] done\n  - [ ] sub\n",
  "links and images": "![alt text](https://example.com/a.png) and [file](</api/files/x/a b.pdf>) and <https://auto.example>.\n",
  "quotes": "> quoted **bold**\n>\n> > nested\n>\n> - item\n",
  "inline html": "H<sub>2</sub>O and x<sup>2</sup> and <u>under</u> and line\\\nbreak.\n",
  "code": "````md\n```js\ninner\n```\n````\n\n    indented\n\n`a` ``b`c`` \n",
  "table with marks": "| *a* | `b|c` |\n|:--|--:|\n| [l](https://x.y) | ~~s~~ |\n| only one |\n",
  "callouts": ":::info\nNote\n\n:::danger\nNested\n:::\n\n:::\n\n:::details\nHidden\n:::\n",
  "math": "Inline $x$ and $$y$$ and price $5.\n\n$$\n\\frac{a}{b}\n$$\n",
  "escapes": "\\# not a heading\n\n\\* not a list\n\n1\\. not ordered\n\n\\> not a quote\n\na \\*b\\* \\[c\\] \\<d\\> \\~e\\~ \\|f\\| \\`g\\` \\\\h \\$i \\==j\n",
  "page break": "before\n\n<div data-type=\"pageBreak\"></div>\n\nafter\n",
};

// ---------------------------------------------------------------------------
// The exported helpers on their own.

const markCases: unknown[] = [
  bold, italic, underline, strike, code, sub, sup,
  link("https://example.com/a?b=1&c=\"2\""),
  link("javascript:alert(1)"),
  link(" /relative path ", { target: null, rel: null, class: "x y", internal: true }),
  link(5, { target: 5, rel: 0, class: false, internal: "yes" }),
  { type: "link" },
  { type: "link", attrs: "str" },
  { type: "link", attrs: { href: ["https://example.com/"] } },
  m("highlight", { color: "#ff0", colorName: "Yellow" }),
  m("highlight", { color: " RED ", colorName: "RED ÄÖ" }),
  m("highlight", { color: "url(x)", colorName: 0 }),
  m("highlight", { color: 5, colorName: 5 }),
  m("highlight", { color: ["blue"], colorName: ["A", "B"] }),
  { type: "highlight" },
  m("textStyle", { color: "hsl(120, 50%, 50%)" }),
  m("textStyle", { color: "var(--x)" }),
  m("textStyle", { color: null }),
  { type: "textStyle", attrs: null },
  m("comment", { commentId: "c1", resolved: false }),
  m("comment", { commentId: 5, resolved: 1 }),
  m("comment", { commentId: null, resolved: "false" }),
  { type: "comment" },
  { type: "glow" },
  { type: "constructor" },
  { type: "" },
  {},
];

/** A value that may be absent: `{ v }`, or `{}` for undefined. */
const maybe = (value: unknown) => (value === undefined ? {} : { v: value });

const colorValues: unknown[] = [
  undefined, null, "", "red", "RED", "Red", "re", "abcdefghijklmnopqrst", "abcdefghijklmnopqrstu", "re\u017f", "\u212aed", "réd",
  "#fff", "#FFFFFF", "#ffff", "#12345678", "#123456789", "#ff", "#ggg", "# fff", "#", "＃fff",
  "rgb(1,2,3)", "rgb(1, 2, 3)", "RGB(1 2 3)", "rgba(1, 2, 3, 0.5)", "hsl(120, 50%, 50%)", "hsla(120 50% 50% / .5)", "HsLa(1,2,3)",
  "rgb()", "rgb( )", "rgb(\u00a01)", "rgb(\u3000)", "rgb(\u0085)", "rgb(1,2,3", "rgb(1,2,3))", "rgb(1;2)", "rgb(a)", "rgb(١)", "rgb(-1.5%)", "rgb (1)", "rgbb(1)", "rgbaa(1)", "hsv(1,2,3)", "rg(1)", "rgb(1)x",
  " red ", "\n#fff\t", "\ufeffblue\u00a0", "red;", "red blue", "expression(alert(1))", "url(x)", "var(--a)", "currentColor", "transparent",
  0, 5, 123, true, false, [], ["red"], ["red", "blue"], [["#fff"]], {}, { color: "red" }, "true", "null", "undefined", "NaN",
];

/** URLs `cleanUrl` and its Rust port disagree on; see tests/export.rs. */
const foldedUrls = ["\u017fcript:x", "java\u017fcript:alert(1)", "\u212aava:x", "data:image/\u017fvg+xml;base64,AAAA"];

const urlValues: unknown[] = [
  undefined, null, "", " ", "https://example.com/", " https://example.com/a b ", "HTTP://EXAMPLE.COM", "http://x", "mailto:a@b.c", "TEL:+1", "ftp://x", "javascript:alert(1)",
  "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", " java\nscript:x", "\u0001javascript:x", "vbscript:x", "data:text/html,x", "data:image/png;base64,AAAA", "DATA:IMAGE/JPEG;x",
  "data:image/svg+xml;utf8,<svg/>", "data:image/bmp;x", "data:image/png,x", "/relative", "relative/path", "./x", "../x", "#frag", "?q=1", "//host/path", "1:2", "a b:c", "http\u017f://x",
  "x:y", "+x:y", "a+b.c-d:e", ":x", "http:", "https", 5, 0, true, [], ["https://example.com/"], {}, ...foldedUrls,
];

const escapeValues = ["", "plain", "Solo <page>", "a & b", "\"quoted\" 'single'", "<&>\"", "&amp;", "tab\tnewline\n", "😀 <b>"];

// ---------------------------------------------------------------------------
// Where JavaScript throws and the Rust port answers.
//
// `String(v)` and `Number(v)` of an object with an own `toString` key throw a
// TypeError. The Rust helpers treat such an object like any other, so the
// fixture also holds the "twin" of each document, with the key renamed: the
// Rust output for the document must be the TypeScript output for its twin.

const poison = { toString: 1 };
const coercionDocs: Record<string, unknown> = {
  "language": doc(el("codeBlock", { language: poison }, t("x"))),
  "label": doc(p(el("mention", { label: poison, entityType: "user", entityId: "u1" }))),
  "text align": doc(el("paragraph", { textAlign: [poison] }, t("x"))),
  "level": doc(el("heading", { level: poison }, t("x"))),
  "colwidth": doc(table(row(el("tableCell", { colwidth: [1, poison] }, p(t("x")))))),
  "href": doc(p(t("x", link(poison)))),
  "mark attrs": doc(p(t("x", { type: "bold", attrs: poison }), t("y", { type: "bold", attrs: { toString: 2 } }))),
  "start": doc(el("orderedList", { start: [[poison]] }, li(p(t("x"))))),
  "math": doc(el("mathBlock", { text: { toString: null } }), el("attachment", { name: { toString: "s" } })),
  "untouched": doc(el("paragraph", { other: poison }, t("x")), el("image", { src: poison, title: poison })),
};

const renameKey = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(renameKey);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key === "toString" ? "toStrinG" : key, renameKey(v)]));
  }
  return value;
};

// ---------------------------------------------------------------------------
// Trees the server never stores (`validateDoc` rejects them). JavaScript throws
// for most; where it answers, the Rust port gives the same answer, except for
// the cases flagged `differs`.

const wrap = (node: unknown) => doc(p(t("before")), node, p(t("after")));
const unvalidated: { name: string; doc: unknown; differs?: boolean }[] = [
  { name: "content null", doc: wrap({ type: "blockquote", content: null }) },
  { name: "content string", doc: wrap({ type: "blockquote", content: "abc" }) },
  { name: "content number", doc: wrap({ type: "blockquote", content: 5 }) },
  { name: "content object", doc: wrap({ type: "blockquote", content: {} }) },
  { name: "content false on an unknown type", doc: wrap({ type: "widget", content: false }) },
  { name: "content zero on an unknown type", doc: wrap({ type: "widget", content: 0 }) },
  { name: "content empty string on an unknown type", doc: wrap({ type: "widget", content: "" }) },
  { name: "content true on an unknown type", doc: wrap({ type: "widget", content: true }) },
  { name: "content null on an unknown type", doc: wrap({ type: "widget", content: null }) },
  { name: "marks null", doc: doc(p({ type: "text", text: "x", marks: null })) },
  { name: "marks number", doc: doc(p({ type: "text", text: "x", marks: 5 })) },
  { name: "marks object", doc: doc(p({ type: "text", text: "x", marks: {} })) },
  { name: "marks string", doc: doc(p({ type: "text", text: "x", marks: "ab" })), differs: true },
  { name: "mark null", doc: doc(p({ type: "text", text: "x", marks: [null] })) },
  { name: "mark number", doc: doc(p({ type: "text", text: "x", marks: [5] })) },
  { name: "mark string", doc: doc(p({ type: "text", text: "x", marks: ["bold"] })) },
  { name: "mark type number", doc: doc(p({ type: "text", text: "x", marks: [{ type: 5 }] })) },
  { name: "mark type null", doc: doc(p({ type: "text", text: "x", marks: [{ type: null }] })) },
  { name: "mark type array", doc: doc(p({ type: "text", text: "x", marks: [{ type: ["bold"] }] })), differs: true },
  { name: "text number", doc: doc(p({ type: "text", text: 5 })) },
  { name: "text null", doc: doc(p({ type: "text", text: null })) },
  { name: "text array", doc: doc(p({ type: "text", text: ["a", ["b", null]] })) },
  { name: "text object", doc: doc(p({ type: "text", text: {} })) },
  { name: "text missing", doc: doc(p({ type: "text" }, t("x"))) },
  { name: "code text number", doc: doc({ type: "codeBlock", content: [{ type: "text", text: 5 }, { type: "text", text: null }, { type: "text", text: true }, { type: "text", text: [1, [2]] }, { type: "text", text: {} }] }) },
  { name: "type missing", doc: wrap({ content: [p(t("x"))] }) },
  { name: "type number", doc: wrap({ type: 5, content: [p(t("x"))] }) },
  { name: "type null", doc: wrap({ type: null }) },
  { name: "type array naming an inline node", doc: doc(raw("widget", null, [t("a"), { type: ["hardBreak"] }])), differs: true },
  { name: "attrs null", doc: wrap({ type: "heading", attrs: null, content: [t("x")] }) },
  { name: "attrs string", doc: wrap({ type: "heading", attrs: "level", content: [t("x")] }) },
  { name: "attrs number", doc: wrap({ type: "heading", attrs: 3, content: [t("x")] }) },
  { name: "attrs array", doc: wrap({ type: "heading", attrs: [3], content: [t("x")] }) },
  { name: "child null", doc: doc(p(t("x")), null) },
  { name: "child number", doc: doc(p(t("x")), 5, p(t("y"))) },
  { name: "child string", doc: doc(p(t("x")), "paragraph", p(t("y"))) },
  { name: "child array", doc: doc(p(t("x")), [p(t("y"))], p(t("z"))) },
  { name: "inline child number", doc: doc(p(t("x"), 5, true, "s", t("y"))) },
  { name: "list item number", doc: doc(el("bulletList", undefined, 5, li(p(t("x"))))) },
  { name: "doc null", doc: null },
  { name: "doc number", doc: 5 },
  { name: "doc zero", doc: 0 },
  { name: "doc string", doc: "doc" },
  { name: "doc empty string", doc: "" },
  { name: "doc false", doc: false },
  { name: "doc array", doc: [p(t("x"))] },
  { name: "doc content string", doc: { type: "doc", content: "abc" } },
  { name: "doc content empty string", doc: { type: "doc", content: "" } },
];

// ---------------------------------------------------------------------------
// Seeded random documents.

const random = mulberry32(0x0d0c5eed);
const int = (below: number) => Math.floor(random() * below);
const chance = (probability: number) => random() < probability;
const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;

const WORDS = ["alpha", "beta", "Gamma", "δ", "日本語", "한글", "😀", "naïve", "x1", "42", "I", "a", "ΑΣ", "e\u0301"];
const SPECIALS = ["*", "_", "`", "\\", "[", "]", "<", ">", "~", "|", "==", "=", "$", "#", "##", "-", "+", "1.", "2)", "(", ")", "!", "&", "\"", "'", "%20", "```", "$$", "^", "\\\n", "://", "@"];
const SPACES = [" ", " ", " ", " ", "  ", "\t", "\n", "\n\n", "\u00a0", "\u2028", "\ufeff", "\u3000", "\r\n", "\u0085", "\u200b"];

const randomText = (): string => {
  if (chance(0.06)) return pick(SPACES) + (chance(0.5) ? pick(SPACES) : "");
  let out = chance(0.2) ? pick(SPACES) : "";
  for (let i = 1 + int(4); i > 0; i--) {
    const roll = random();
    out += roll < 0.5 ? pick(WORDS) : roll < 0.75 ? pick(SPECIALS) : pick(SPACES);
  }
  return chance(0.2) ? out + pick(SPACES) : out;
};

// Short stand-ins for ids keep the random documents small.
const ID = "f1";
const URLS = [
  "https://example.com/a.png", "https://example.com/dir/my%20file (1).pdf", "/api/files/f1/photo one.png", "/api/files/f1/clip.mp4", "/api/files/not-a-uuid/x", "relative/path.svg",
  "data:image/png;base64,AAAA", "javascript:alert(1)", " https://example.com/padded ", "https://example.com/%E0%A4%A", "x/y/", "", "mailto:a@b.c",
];
const HREFS = [
  ...URLS, "https://example.com/", "https://example.com/a b(c)?d=e#f", "/s/space/p/title-AbC123", "/p/XyZ9#anchor", "https://doc.example.com/s/s/p/t-Q1w2E3/", "/s/space/p/%zz-bad", "#top",
  "https://example.com/a\nb\tc", "/api/files/f1/doc.pdf",
];
const NAMES = ["A name", "file%20name.pdf", "*starred*", "[bracketed](x)", "<tag>", "a|b", "", "%E0%A4%A", "naïve 😀", "$5 and $x"];
const COLORS = ["red", "#fff", "#12345678", "rgb(1, 2, 3)", "hsla(1 2% 3% / .5)", " blue ", "url(x)", "RED", "", null];

/** Values of every JSON type, for attributes that expect something else. */
const ODD: readonly unknown[] = [
  null, true, false, 0, 1, 2, 3, -1, 1.5, 7, 100, 1e21, 1e-7, "", "0", "1", "2", " 3 ", "0x10", "1e2", "abc", "true", "null", "center", "wide", "user", "page", "#fff", "red",
  " a b ", "<b>&\"'</b>", "a|b", "`", "$x$", "line\nbreak", "\u00a0nbsp\u00a0", "ünï©ödé", "😀", "%20", "%zz", "/api/files/f1/a b.png", "javascript:alert(1)", "https://example.com/a b(c)",
  "/s/space/p/title-AbC123", "Infinity", "-0", [], [1], [1, 2], ["a"], [null], [[1], "x", null, true], [100, null, 200], ["center"], ["user"], {}, { a: 1 }, { 1: "x", b: [1] },
];

const TYPICAL: Record<string, readonly unknown[]> = {
  id: ["h-1", "block-2", null],
  textAlign: ["center", "right", "justify", "left", null],
  indent: [0, 0, 1, 2],
  level: [1, 2, 3, 4, 5, 6],
  start: [1, 1, 2, 5, 10, 99],
  type: ["info", "warning", "danger", "a", "i", null],
  checked: [true, false],
  language: ["js", "rust", "c++", null],
  src: URLS,
  url: URLS,
  href: HREFS,
  alt: [...NAMES, null],
  title: [...NAMES, null],
  name: [...NAMES, null],
  width: [100, 640, "50%", null],
  height: [100, 480, "auto", null],
  align: ["center", "left", "right"],
  attachmentId: [ID, null],
  size: [1234, "12 KB", null],
  aspectRatio: [1.5, 1.7778, null],
  mime: ["application/pdf", "text/plain", null],
  colspan: [1, 1, 1, 1, 2, 3],
  rowspan: [1, 1, 1, 1, 2],
  colwidth: [null, [100], [100, 200]],
  backgroundColor: COLORS,
  backgroundColorName: ["Red", "BLUE", "Grün", null],
  icon: ["💡", null],
  open: [true, false],
  layout: ["two_equal", "three_equal", "two_left_sidebar"],
  widthMode: ["normal", "wide"],
  sourcePageId: ["p1", null],
  transclusionId: ["t1", null],
  "data-id": ["fn-a", "1", null],
  referenceNumber: [1, 2, "3", null],
  text: ["x^2", "a < b", "In progress", "$", "", "*done*"],
  label: [...NAMES, null],
  entityType: ["user", "user", "page", "page", "page", "group", null],
  entityId: ["u1", "p1", "u2", "", null],
  slugId: ["AbC123", "xYz", "", null],
  creatorId: ["u1", null],
  anchorId: ["heading-1", "a b", "", null],
  color: COLORS,
  provider: ["youtube", "figma", ""],
  pageId: ["p1", null],
  target: ["_blank", "_self", null],
  rel: ["noopener noreferrer nofollow", null],
  class: ["external", null],
  internal: [true, false],
  colorName: ["Yellow", "ÄÖÜ", null],
  commentId: ["c1", "c2", null],
  resolved: [true, false],
};

const MEDIA = ["src", "alt", "title", "name", "width", "height", "align", "attachmentId", "size", "aspectRatio"];
const NODE_ATTRS: Record<string, readonly string[]> = {
  paragraph: ["id", "textAlign", "indent"],
  heading: ["id", "level", "textAlign", "indent"],
  bulletList: ["start"],
  orderedList: ["start", "type"],
  taskList: ["start"],
  listItem: ["checked"],
  taskItem: ["checked"],
  codeBlock: ["language"],
  image: MEDIA,
  video: MEDIA,
  audio: MEDIA,
  pdf: MEDIA,
  drawio: MEDIA,
  excalidraw: MEDIA,
  attachment: ["url", "name", "mime", "size", "attachmentId"],
  tableCell: ["colspan", "rowspan", "colwidth", "backgroundColor", "backgroundColorName"],
  tableHeader: ["colspan", "rowspan", "colwidth", "backgroundColor", "backgroundColorName"],
  callout: ["type", "icon"],
  details: ["open"],
  columns: ["layout", "widthMode"],
  column: ["width"],
  transclusionSource: ["id"],
  transclusionReference: ["sourcePageId", "transclusionId"],
  footnote: ["id", "data-id"],
  footnoteReference: ["data-id", "referenceNumber"],
  mathInline: ["text"],
  mathBlock: ["text"],
  mention: ["id", "label", "entityType", "entityId", "slugId", "creatorId", "anchorId"],
  status: ["text", "color"],
  embed: ["src", "provider", "align", "width", "height"],
  youtube: ["src", "width", "height"],
  base: ["pageId"],
};
const MARK_ATTRS: Record<string, readonly string[]> = {
  link: ["href", "target", "rel", "class", "internal"],
  highlight: ["color", "colorName"],
  textStyle: ["color"],
  comment: ["commentId", "resolved"],
};
const MARK_TYPES = [
  "bold", "bold", "italic", "italic", "underline", "strike", "code", "subscript", "superscript", "link", "link", "link", "highlight", "textStyle", "comment",
  "constructor", "__proto__", "toString", "glow",
];

/** `table[key]` for an own key only: "constructor" and "valueOf" are among the types looked up. */
const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** Attributes for the given names: usual values, values of the wrong type, and gaps. */
const randomAttrs = (names: readonly string[]): Record<string, unknown> | undefined => {
  if (chance(0.12)) return undefined;
  const attrs: Record<string, unknown> = {};
  for (const name of names) {
    const roll = random();
    if (roll < 0.12) continue;
    attrs[name] = roll < 0.6 ? pick(own(TYPICAL, name) ?? ODD) : pick(ODD);
  }
  if (chance(0.04)) attrs[pick(["extra", "level", "text", "2", "src"])] = pick(ODD);
  return attrs;
};

const randomMark = (): Tree => {
  const type = pick(MARK_TYPES);
  const mark: Tree = { type };
  if (chance(0.05)) mark.attrs = pick(["str", 5, null, [1], true, []]);
  else {
    const attrs = randomAttrs(own(MARK_ATTRS, type) ?? (chance(0.2) ? ["color"] : []));
    if (attrs && (Object.keys(attrs).length > 0 || chance(0.3))) mark.attrs = attrs;
  }
  return mark;
};

const shuffled = <T>(items: T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

const withAttrs = (type: string, content?: unknown[]): Tree => {
  const node: Tree = { type };
  const attrs = randomAttrs(own(NODE_ATTRS, type) ?? (chance(0.1) ? ["id", "text"] : []));
  if (attrs) node.attrs = attrs;
  if (content) node.content = content;
  return node;
};

const INLINE_ATOMS = ["hardBreak", "hardBreak", "mention", "mention", "mention", "mathInline", "status", "footnoteReference", "gadget", "image", "valueOf"];
const LEAF_BLOCKS = [
  "horizontalRule", "pageBreak", "image", "image", "video", "audio", "attachment", "pdf", "drawio", "excalidraw", "transclusionReference", "mathBlock", "embed", "youtube", "subpages", "base",
];
const CONTAINERS = ["blockquote", "callout", "transclusionSource", "column", "detailsContent", "widget", "constructor"];
const EVERY_TYPE = [...Object.keys(NODE_ATTRS), ...LEAF_BLOCKS, ...CONTAINERS, "doc", "text", "table", "tableRow", "footnotes", "detailsSummary", "hardBreak", "__proto__", ""];

let wild = false;

const randomInline = (depth: number): unknown[] => {
  const palette = Array.from({ length: int(4) }, randomMark);
  const nodes: unknown[] = [];
  for (let i = int(5); i > 0; i--) {
    const roll = random();
    if (wild && roll < 0.1) nodes.push(randomNode(pick(EVERY_TYPE), depth + 1));
    else if (roll < 0.7) {
      const marks = shuffled(palette.filter(() => chance(0.5)));
      if (chance(0.08)) marks.push(randomMark());
      const node: Tree = { type: "text", text: randomText() };
      if (marks.length || chance(0.05)) node.marks = marks;
      nodes.push(node);
    } else {
      const node = withAttrs(pick(INLINE_ATOMS));
      if (chance(0.15)) node.marks = palette.filter(() => chance(0.5));
      if (chance(0.05)) node.content = chance(0.5) ? [] : [{ type: "text", text: randomText() }];
      nodes.push(node);
    }
  }
  return nodes;
};

const randomBlocks = (depth: number, most: number): unknown[] => Array.from({ length: int(most + 1) }, () => randomBlock(depth));

const randomItem = (type: string, depth: number): Tree => {
  const content: unknown[] = chance(0.9) ? [withAttrs("paragraph", randomInline(depth))] : [];
  for (let i = int(3); i > 0 && depth < 3; i--) content.push(chance(0.5) ? randomNode(pick(["bulletList", "orderedList", "taskList"]), depth + 1) : randomBlock(depth + 1));
  return withAttrs(type, content);
};

const randomCell = (depth: number): Tree => {
  const type = chance(0.25) ? "tableHeader" : "tableCell";
  const roll = random();
  if (roll < 0.78) return withAttrs(type, [withAttrs("paragraph", randomInline(depth))]);
  if (roll < 0.86) return withAttrs(type, []);
  if (roll < 0.9) return withAttrs(type);
  return withAttrs(type, randomBlocks(depth + 1, 2));
};

function randomNode(type: string, depth: number): Tree {
  const deep = depth >= 3;
  switch (type) {
    case "text": {
      const node: Tree = { type: "text", text: randomText() };
      if (chance(0.5)) node.marks = Array.from({ length: int(3) }, randomMark);
      return node;
    }
    case "paragraph":
    case "heading":
    case "detailsSummary":
      return withAttrs(type, randomInline(depth));
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const item = type === "taskList" ? "taskItem" : "listItem";
      return withAttrs(type, Array.from({ length: deep ? 1 : int(4) }, () => randomItem(chance(0.93) ? item : pick(["listItem", "taskItem", "paragraph"]), depth + 1)));
    }
    case "listItem":
    case "taskItem":
      return randomItem(type, depth);
    case "codeBlock":
      return withAttrs(type, Array.from({ length: int(3) }, () => ({ type: "text", text: chance(0.2) ? "a\n\n\n```\nb" : randomText() })));
    case "table":
      // A table without rows makes the Markdown serializer throw; keep it rare.
      return withAttrs(type, Array.from({ length: chance(0.03) ? 0 : 1 + int(3) }, () => randomNode("tableRow", depth + 1)));
    case "tableRow":
      return withAttrs(type, Array.from({ length: int(4) }, () => randomCell(depth + 1)));
    case "tableCell":
    case "tableHeader":
      return randomCell(depth);
    case "details": {
      const summary = withAttrs("detailsSummary", randomInline(depth));
      const body = withAttrs("detailsContent", deep ? [] : randomBlocks(depth + 1, 2));
      const roll = random();
      return withAttrs(type, roll < 0.8 ? [summary, body] : roll < 0.85 ? [body, summary] : roll < 0.9 ? [summary] : roll < 0.95 ? [body] : []);
    }
    case "columns":
      return withAttrs(type, Array.from({ length: 1 + int(3) }, () => withAttrs("column", deep ? [] : randomBlocks(depth + 1, 2))));
    case "footnotes":
      return withAttrs(type, Array.from({ length: int(3) }, () => withAttrs("footnote", Array.from({ length: 1 + int(2) }, () => withAttrs("paragraph", randomInline(depth))))));
    case "footnote":
    case "doc":
    case "blockquote":
    case "callout":
    case "transclusionSource":
    case "column":
    case "detailsContent":
      return withAttrs(type, deep ? [] : randomBlocks(depth + 1, 3));
    case "widget":
    case "constructor":
    case "__proto__":
    case "": {
      const roll = random();
      return withAttrs(type, roll < 0.4 ? undefined : roll < 0.55 ? [] : roll < 0.8 || deep ? randomInline(depth) : randomBlocks(depth + 1, 2));
    }
    default: {
      const node = withAttrs(type);
      if (chance(0.03)) node.content = chance(0.5) ? [] : randomInline(depth);
      if (chance(0.02)) node.text = randomText();
      return node;
    }
  }
}

const BLOCK_WEIGHTS: [string, number][] = [
  ["paragraph", 30], ["heading", 8], ["bulletList", 5], ["orderedList", 5], ["taskList", 3], ["blockquote", 4], ["codeBlock", 5], ["table", 7], ["callout", 3], ["details", 3],
  ["columns", 2], ["transclusionSource", 1], ["footnotes", 2], ["widget", 2], ["constructor", 1], ["__proto__", 1],
];
const BLOCK_TOTAL = BLOCK_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0) + 18;

function randomBlock(depth: number): Tree {
  if (wild && chance(0.12)) return randomNode(pick(EVERY_TYPE), depth);
  let roll = random() * BLOCK_TOTAL;
  for (const [type, weight] of BLOCK_WEIGHTS) {
    roll -= weight;
    if (roll < 0) return randomNode(type, depth);
  }
  return randomNode(pick(LEAF_BLOCKS), depth);
}

const randomDoc = (): Tree => {
  wild = chance(0.15);
  if (chance(0.01)) return { type: "doc" };
  return { type: "doc", content: Array.from({ length: chance(0.02) ? 0 : 1 + int(3) }, () => randomBlock(0)) };
};

// ---------------------------------------------------------------------------
// Writing the fixtures.

const FUZZ_DOCS = 3000;

/** `[document, html, html with callbacks, markdown, markdown with callbacks, text and links]`, digests but for the first. */
const fuzz = Array.from({ length: FUZZ_DOCS }, () => {
  const tree = JSON.parse(JSON.stringify(randomDoc())) as Node;
  const links = docLinks(tree);
  const text = [docText(tree), links.pageIds.join("\u0001"), links.slugIds.join("\u0001"), docMentionedUserIds(tree).join("\u0001")].join("\u0000");
  // null where the serializer throws (a table without rows).
  const markdown = (opts?: HtmlOptions) => {
    const out = attempt(() => docToMarkdown(tree, opts));
    return typeof out === "string" ? digest(out) : null;
  };
  return [tree, digest(docToHtml(tree)), digest(docToHtml(tree, probe)), markdown(), markdown(probe), digest(text)];
});

const named = (trees: Record<string, unknown>) =>
  Object.entries(trees).map(([name, tree]) => {
    const parsed = JSON.parse(JSON.stringify(tree)) as unknown;
    return { name, doc: parsed, ...outputs(parsed) };
  });

await writeFixture("export.json", {
  docs: named(docs),
  markdown: Object.entries(markdownSources).map(([name, source]) => {
    const parsed = JSON.parse(JSON.stringify(markdownToDoc(source))) as Node;
    return { name, source, doc: parsed, md: docToMarkdown(parsed), html: nodeToHtml(parsed) };
  }),
  marks: markCases.map((mark) => {
    const parsed = JSON.parse(JSON.stringify(mark)) as Mark;
    const [name, attrs] = markTag(parsed);
    return { mark: parsed, name, attrs: Object.entries(attrs) };
  }),
  colors: colorValues.map((value) => ({ ...maybe(value), color: safeColor(value) })),
  urls: urlValues.map((value) => ({ ...maybe(value), url: safeUrl(value), ...(foldedUrls.includes(value as string) ? { folded: true } : {}) })),
  escapes: escapeValues.map((value) => ({ value, escaped: escapeHtml(value) })),
  coercion: Object.entries(coercionDocs).map(([name, tree]) => {
    const twin = renameKey(tree);
    return { name, doc: tree, ...outputs(tree), twin: outputs(JSON.parse(JSON.stringify(twin))) };
  }),
  unvalidated: unvalidated.map((entry) => ({ ...entry, ...outputs(JSON.parse(JSON.stringify(entry.doc))) })),
  exports: ["export-like", "mentions", "media", "links"].flatMap((name) =>
    [0, 1, 2].map((depth) => {
      const parsed = JSON.parse(JSON.stringify(docs[name])) as Node;
      return { name, depth, doc: parsed, html: docToHtml(parsed, exportLike(depth)), md: docToMarkdown(parsed, exportLike(depth)) };
    }),
  ),
});
await writeFixture("export-fuzz.json", { docs: fuzz });
