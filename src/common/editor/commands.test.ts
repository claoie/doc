import { describe, expect, test } from "bun:test";
import { schema } from "./doc-schema";
import { applyTransaction, createState, type EditorState, type Selection } from "./state";
import {
  deleteBackward,
  insertBlocks,
  insertText,
  joinBackward,
  liftListItem,
  setBlockType,
  sinkListItem,
  splitBlock,
  toggleList,
  toggleMark,
  toggleWrap,
  type Command,
} from "./commands";
import type { Node } from "./model";

const text = (t: string): Node => ({ type: "text", text: t });
const p = (t = ""): Node => ({ type: "paragraph", content: t ? [text(t)] : [] });
const doc = (...content: Node[]): Node => ({ type: "doc", content });
const li = (...content: Node[]): Node => ({ type: "listItem", content });
const ul = (...items: Node[]): Node => ({ type: "bulletList", content: items });

/** Strips attrs so assertions focus on structure and text. */
const shape = (node: Node): unknown => {
  if (node.type === "text") return node.marks ? { t: node.text, m: node.marks.map((m) => m.type) } : node.text;
  return { [node.type]: (node.content ?? []).map(shape) };
};

const exec = (d: Node, sel: Selection, ...commands: Command[]) => {
  let state: EditorState = createState(schema, d, sel);
  for (const command of commands) {
    const ok = command(state, (tr) => {
      state = applyTransaction(state, tr);
    });
    if (!ok) throw new Error("command failed");
  }
  return state;
};

const at = (pos: number): Selection => ({ anchor: pos, head: pos });

describe("typing and splitting", () => {
  test("insert text and split paragraph", () => {
    const s = exec(doc(p("ab")), at(2), insertText("X"), splitBlock, insertText("Y"));
    expect(shape(s.doc)).toEqual(shape(doc(p("aX"), p("Yb"))));
    expect(s.selection.head).toBe(6);
  });

  test("enter at end of heading makes a paragraph", () => {
    const h: Node = { type: "heading", attrs: { level: 2 }, content: [text("Hi")] };
    const s = exec(doc(h), at(3), splitBlock);
    expect(s.doc.content![1]!.type).toBe("paragraph");
  });

  test("backspace joins paragraphs", () => {
    const s = exec(doc(p("ab"), p("cd")), at(5), deleteBackward);
    expect(shape(s.doc)).toEqual(shape(doc(p("abcd"))));
    expect(s.selection.head).toBe(3);
  });

  test("backspace deletes a whole emoji", () => {
    const s = exec(doc(p("a👍")), at(4), deleteBackward);
    expect(shape(s.doc)).toEqual(shape(doc(p("a"))));
  });
});

describe("marks", () => {
  test("toggle bold over selection", () => {
    const s = exec(doc(p("abcd")), { anchor: 2, head: 4 }, toggleMark("bold"));
    expect(shape(s.doc)).toEqual({
      doc: [{ paragraph: ["a", { t: "bc", m: ["bold"] }, "d"] }],
    });
    const off = exec(s.doc, { anchor: 2, head: 4 }, toggleMark("bold"));
    expect(shape(off.doc)).toEqual(shape(doc(p("abcd"))));
  });

  test("stored mark applies to typed text", () => {
    const s = exec(doc(p("ab")), at(3), toggleMark("italic"), insertText("c"));
    expect(shape(s.doc)).toEqual({ doc: [{ paragraph: ["ab", { t: "c", m: ["italic"] }] }] });
  });
});

describe("blocks", () => {
  test("set heading and back", () => {
    const s = exec(doc(p("ab")), at(2), setBlockType("heading", { level: 2 }));
    expect(s.doc.content![0]!.type).toBe("heading");
    expect(s.doc.content![0]!.attrs!.level).toBe(2);
    const back = exec(s.doc, at(1), joinBackward);
    expect(back.doc.content![0]!.type).toBe("paragraph");
  });

  test("wrap in blockquote and lift out", () => {
    const s = exec(doc(p("ab")), at(2), toggleWrap("blockquote"));
    expect(shape(s.doc)).toEqual({ doc: [{ blockquote: [{ paragraph: ["ab"] }] }] });
    const back = exec(s.doc, at(3), toggleWrap("blockquote"));
    expect(shape(back.doc)).toEqual(shape(doc(p("ab"))));
  });
});

describe("lists", () => {
  test("toggle bullet list on and off", () => {
    const s = exec(doc(p("ab")), at(2), toggleList("bulletList"));
    expect(shape(s.doc)).toEqual(shape(doc(ul(li(p("ab"))))));
    const off = exec(s.doc, at(4), toggleList("bulletList"));
    expect(shape(off.doc)).toEqual(shape(doc(p("ab"))));
  });

  test("enter creates a new item; enter on empty item leaves the list", () => {
    const s = exec(doc(ul(li(p("ab")))), at(5), splitBlock, insertText("c"));
    expect(shape(s.doc)).toEqual(shape(doc(ul(li(p("ab")), li(p("c"))))));
    const out = exec(doc(ul(li(p("ab")), li(p("")))), at(9), splitBlock);
    expect(shape(out.doc)).toEqual(shape(doc(ul(li(p("ab"))), p(""))));
  });

  test("sink and lift a list item", () => {
    const d = doc(ul(li(p("a")), li(p("b"))));
    const sunk = exec(d, at(9), sinkListItem);
    expect(shape(sunk.doc)).toEqual(shape(doc(ul(li(p("a"), ul(li(p("b"))))))));
    const lifted = exec(sunk.doc, { anchor: sunk.selection.head, head: sunk.selection.head }, liftListItem);
    expect(shape(lifted.doc)).toEqual(shape(d));
  });
});

describe("insert", () => {
  test("divider replaces an empty paragraph and leaves a paragraph after", () => {
    const s = exec(doc(p("a"), p("")), at(4), insertBlocks([{ type: "horizontalRule" }]));
    expect(s.doc.content!.map((n) => n.type)).toEqual(["paragraph", "horizontalRule", "paragraph"]);
  });
});

describe("list wrapping keeps the cursor", () => {
  test("cursor stays inside the text after toggling a task list", () => {
    const s = exec(doc(p("ab")), at(2), toggleList("taskList"), insertText("X"));
    expect(shape(s.doc)).toEqual({ doc: [{ taskList: [{ taskItem: [{ paragraph: ["aXb"] }] }] }] });
  });
});

describe("retyping keeps the cursor", () => {
  test("code block conversion keeps the cursor in place", () => {
    const s = exec(doc(p("abc")), at(2), setBlockType("codeBlock"), insertText("X"));
    expect(shape(s.doc)).toEqual({ doc: [{ codeBlock: ["aXbc"] }] });
  });
  test("switching bullet to task list keeps the cursor", () => {
    const s = exec(doc(ul(li(p("ab")))), at(4), toggleList("taskList"), insertText("X"));
    expect(shape(s.doc)).toEqual({ doc: [{ taskList: [{ taskItem: [{ paragraph: ["aXb"] }] }] }] });
  });
});
