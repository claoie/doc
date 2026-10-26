import { describe, expect, test } from "bun:test";
import { Schema } from "./schema";
import { applyStep, Mapping, mapStep, type Step } from "./steps";
import { contentSize, nodesToItems, resolve } from "./tokens";
import type { Node } from "./model";

const schema = new Schema(
  {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    heading: { content: "inline*", group: "block", attrs: { level: 1 } },
    bulletList: { content: "listItem+", group: "block" },
    listItem: { content: "paragraph block*" },
    horizontalRule: { group: "block" },
    hardBreak: { inline: true, group: "inline" },
    text: { group: "inline" },
  },
  { bold: {}, link: { attrs: { href: "" } } },
);

const p = (...content: (string | Node)[]): Node => ({
  type: "paragraph",
  content: content.map((c) => (typeof c === "string" ? { type: "text", text: c } : c)),
});
const doc = (...content: Node[]): Node => ({ type: "doc", content });

const apply = (d: Node, step: Step) => applyStep(d, step, schema);

describe("positions", () => {
  test("sizes and resolve", () => {
    const d = doc(p("ab"), p("cd"));
    expect(contentSize(d, schema)).toBe(8);
    const $pos = resolve(d, 2, schema);
    expect($pos.depth).toBe(1);
    expect($pos.textOffset).toBe(1);
    expect(resolve(d, 4, schema).depth).toBe(0);
    expect(resolve(d, 4, schema).indices[0]).toBe(1);
  });
});

describe("replace", () => {
  test("inserts text", () => {
    const d = doc(p("ab"));
    const r = apply(d, { stepType: "replace", from: 2, to: 2, slice: [{ t: "X" }] });
    expect(r.doc).toEqual(doc(p("aXb")));
    expect(apply(r.doc, r.inverse).doc).toEqual(d);
  });

  test("splits and joins paragraphs", () => {
    const d = doc(p("abcd"));
    const split = apply(d, {
      stepType: "replace",
      from: 3,
      to: 3,
      slice: [{ c: 1 }, { o: "paragraph" }],
    });
    expect(split.doc).toEqual(doc(p("ab"), p("cd")));
    const joined = apply(split.doc, { stepType: "replace", from: 3, to: 5, slice: [] });
    expect(joined.doc).toEqual(d);
    expect(apply(split.doc, split.inverse).doc).toEqual(d);
  });

  test("reuses untouched siblings", () => {
    const first = p("one");
    const d = doc(first, p("two"));
    const r = apply(d, { stepType: "replace", from: 7, to: 7, slice: [{ t: "!" }] });
    expect(r.doc.content![0]).toBe(first);
  });

  test("rejects invalid content", () => {
    const d = doc(p("ab"));
    expect(() => apply(d, { stepType: "replace", from: 0, to: 4, slice: [] })).toThrow();
  });

  test("inserts whole nodes", () => {
    const d = doc(p("ab"));
    const slice = nodesToItems([{ type: "horizontalRule" }], schema);
    const r = apply(d, { stepType: "replace", from: 4, to: 4, slice });
    expect(r.doc).toEqual(doc(p("ab"), { type: "horizontalRule" }));
  });
});

describe("replaceAround", () => {
  test("retypes a paragraph into a heading keeping content", () => {
    const d = doc(p("ab"));
    const r = apply(d, {
      stepType: "replaceAround",
      from: 0,
      to: 4,
      gapFrom: 1,
      gapTo: 3,
      slice: [{ o: "heading", a: { level: 2 } }, { c: 1 }],
      insert: 1,
    });
    expect(r.doc).toEqual(doc({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "ab" }] }));
    expect(apply(r.doc, r.inverse).doc).toEqual(d);
  });

  test("wraps a paragraph in a list", () => {
    const d = doc(p("ab"));
    const r = apply(d, {
      stepType: "replaceAround",
      from: 0,
      to: 4,
      gapFrom: 0,
      gapTo: 4,
      slice: [{ o: "bulletList" }, { o: "listItem" }, { c: 1 }, { c: 1 }],
      insert: 2,
    });
    expect(r.doc).toEqual(
      doc({ type: "bulletList", content: [{ type: "listItem", content: [p("ab")] }] }),
    );
    expect(apply(r.doc, r.inverse).doc).toEqual(d);
  });
});

describe("marks", () => {
  test("adds and removes marks", () => {
    const d = doc(p("abcd"));
    const r = apply(d, { stepType: "addMark", from: 2, to: 4, mark: { type: "bold" } });
    expect(r.doc).toEqual(
      doc(p("a", { type: "text", text: "bc", marks: [{ type: "bold" }] }, "d")),
    );
    expect(apply(r.doc, r.inverse).doc).toEqual(d);
  });

  test("link marks are exclusive by type", () => {
    const d = doc(p("ab"));
    const a = apply(d, { stepType: "addMark", from: 1, to: 3, mark: { type: "link", attrs: { href: "x" } } });
    const b = apply(a.doc, { stepType: "addMark", from: 1, to: 3, mark: { type: "link", attrs: { href: "y" } } });
    expect(b.doc.content![0]!.content![0]!.marks).toEqual([{ type: "link", attrs: { href: "y" } }]);
  });
});

describe("attr", () => {
  test("sets attrs and inverts", () => {
    const d = doc({ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "a" }] });
    const r = apply(d, { stepType: "attr", pos: 0, attrs: { level: 3 } });
    expect(r.doc.content![0]!.attrs).toEqual({ level: 3 });
    expect(apply(r.doc, r.inverse).doc).toEqual(d);
  });
});

describe("mapping", () => {
  test("concurrent inserts converge", () => {
    const d = doc(p("abcd"));
    const a: Step = { stepType: "replace", from: 2, to: 2, slice: [{ t: "X" }] };
    const b: Step = { stepType: "replace", from: 4, to: 4, slice: [{ t: "Y" }] };
    const ra = apply(d, a);
    const bMapped = mapStep(b, new Mapping([ra.map]))!;
    const left = apply(ra.doc, bMapped).doc;
    const rb = apply(d, b);
    const aMapped = mapStep(a, new Mapping([rb.map]))!;
    const right = apply(rb.doc, aMapped).doc;
    expect(left).toEqual(right);
    expect(left).toEqual(doc(p("aXbcYd")));
  });

  test("drops edits inside deleted ranges", () => {
    const d = doc(p("abcdef"));
    const del: Step = { stepType: "replace", from: 2, to: 6, slice: [] };
    const mark: Step = { stepType: "addMark", from: 3, to: 5, mark: { type: "bold" } };
    const r = apply(d, del);
    expect(mapStep(mark, new Mapping([r.map]))).toBeNull();
  });
});

describe("slices keep marks", () => {
  test("inserting whole nodes with marked text keeps the marks", () => {
    const d = doc(p("ab"));
    const marked: Node = { type: "paragraph", content: [{ type: "text", text: "bold", marks: [{ type: "bold" }] }] };
    const r = apply(d, { stepType: "replace", from: 4, to: 4, slice: nodesToItems([marked], schema) });
    expect(r.doc.content![1]).toEqual(marked);
  });
});
