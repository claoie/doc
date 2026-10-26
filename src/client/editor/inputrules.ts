import type { Node } from "common/editor/model";
import { $ } from "common/editor/resolved";
import { Transaction, type EditorState } from "common/editor/state";
import { nodesToItems } from "common/editor/tokens";

/**
 * Markdown-style shortcuts that fire as text is typed. Each rule looks at the
 * text before the cursor in the current textblock; a match returns a
 * transaction that replaces it.
 */
export interface InputRule {
  match: RegExp;
  /** Only at the start of a top-level-ish paragraph (block rules). */
  blockStart?: boolean;
  handler: (state: EditorState, match: RegExpMatchArray, from: number, to: number) => Transaction | null;
}

const retypeBlock = (type: string, attrs?: Record<string, unknown>) =>
  (state: EditorState, _m: RegExpMatchArray, from: number, to: number) => {
    const tr = new Transaction(state);
    tr.delete(from, to);
    const $pos = $(tr.doc, from, state.schema);
    const blockPos = $pos.before();
    const block = $pos.parent;
    const merged = state.schema.attrs(type, attrs);
    const size = 2 + (block.content ?? []).reduce((s, c) => s + (c.type === "text" ? c.text!.length : 1), 0);
    tr.step({
      stepType: "replaceAround",
      from: blockPos,
      to: blockPos + size,
      gapFrom: blockPos + 1,
      gapTo: blockPos + size - 1,
      slice: [merged ? { o: type, a: merged } : { o: type }, { c: 1 }],
      insert: 1,
    });
    tr.setSelection({ anchor: blockPos + 1, head: blockPos + 1 });
    return tr;
  };

const wrapBlock = (outer: string, outerAttrs?: Record<string, unknown>, item?: string, itemAttrs?: Record<string, unknown>) =>
  (state: EditorState, _m: RegExpMatchArray, from: number, to: number) => {
    const tr = new Transaction(state);
    tr.delete(from, to);
    const $pos = $(tr.doc, from, state.schema);
    const blockPos = $pos.before();
    const end = $pos.after();
    const o = state.schema.attrs(outer, outerAttrs);
    const slice = item
      ? [o ? { o: outer, a: o } : { o: outer }, (() => { const ia = state.schema.attrs(item, itemAttrs); return ia ? { o: item, a: ia } : { o: item }; })(), { c: 1 as const }, { c: 1 as const }]
      : [o ? { o: outer, a: o } : { o: outer }, { c: 1 as const }];
    tr.step({
      stepType: "replaceAround",
      from: blockPos,
      to: end,
      gapFrom: blockPos,
      gapTo: end,
      slice,
      insert: item ? 2 : 1,
    });
    const cursor = blockPos + (item ? 3 : 2);
    tr.setSelection({ anchor: cursor, head: cursor });
    return tr;
  };

const replaceBlockWith = (make: (state: EditorState, m: RegExpMatchArray) => Node[]) =>
  (state: EditorState, m: RegExpMatchArray, from: number, _to: number) => {
    const tr = new Transaction(state);
    const $pos = $(state.doc, from, state.schema);
    const blockPos = $pos.before();
    const nodes = make(state, m);
    tr.replace(blockPos, $pos.after(), nodesToItems(nodes, state.schema));
    const first = nodes[0]!;
    const inner = state.schema.isLeaf(first.type) ? blockPos + 2 : blockPos + 1;
    tr.setSelection({ anchor: inner, head: inner });
    return tr;
  };

const markRule = (re: RegExp, type: string, attrs?: Record<string, unknown>): InputRule => ({
  match: re,
  handler: (state, m, from, to) => {
    const inner = m[2]!;
    if (!inner.trim()) return null;
    const $pos = $(state.doc, from, state.schema);
    if (!state.schema.allowsMark($pos.parent.type, type)) return null;
    const lead = m[1] ?? "";
    const start = from + lead.length;
    const tr = new Transaction(state);
    tr.replace(start, to, [{ t: inner }]);
    tr.addMark(start, start + inner.length, state.schema.mark(type, attrs));
    tr.setSelection({ anchor: start + inner.length, head: start + inner.length });
    tr.setStoredMarks(null);
    // Typing continues without the mark.
    tr.setStoredMarks((state.storedMarks ?? []).filter((mk) => mk.type !== type));
    return tr;
  },
});

const textRule = (re: RegExp, replacement: string): InputRule => ({
  match: re,
  handler: (state, m, from, to) => {
    const $pos = $(state.doc, from, state.schema);
    if (state.schema.nodes[$pos.parent.type]?.code) return null;
    const lead = m[1] ?? "";
    const tr = new Transaction(state);
    const start = from + lead.length;
    tr.insertText(replacement, start, to, $pos.nodeBefore?.marks ?? null);
    tr.setSelection({ anchor: start + replacement.length, head: start + replacement.length });
    return tr;
  },
});

export const inputRules: InputRule[] = [
  { match: /^(#{1,6}) $/, blockStart: true, handler: (s, m, f, t) => retypeBlock("heading", { level: m[1]!.length })(s, m, f, t) },
  { match: /^[-*+] $/, blockStart: true, handler: wrapBlock("bulletList", undefined, "listItem") },
  {
    match: /^(\d+)\. $/,
    blockStart: true,
    handler: (s, m, f, t) => wrapBlock("orderedList", { start: Number(m[1]) }, "listItem")(s, m, f, t),
  },
  {
    match: /^\[( |x)\] $/,
    blockStart: true,
    handler: (s, m, f, t) => wrapBlock("taskList", undefined, "taskItem", { checked: m[1] === "x" })(s, m, f, t),
  },
  { match: /^> $/, blockStart: true, handler: wrapBlock("blockquote") },
  {
    match: /^(?:```|~~~)([\w+#-]*) $/,
    blockStart: true,
    handler: (s, m, f, t) => retypeBlock("codeBlock", { language: m[1] || null })(s, m, f, t),
  },
  {
    match: /^:::details $/,
    blockStart: true,
    handler: replaceBlockWith((state) => [
      state.schema.node("details", { open: true }, [
        state.schema.node("detailsSummary"),
        state.schema.node("detailsContent", undefined, [state.schema.node("paragraph")]),
      ]),
    ]),
  },
  {
    match: /^:::([a-z]+)? $/,
    blockStart: true,
    handler: replaceBlockWith((state, m) => {
      const types = ["default", "info", "note", "success", "warning", "danger"];
      const type = m[1] && types.includes(m[1]) ? m[1] : "info";
      return [state.schema.node("callout", { type }, [state.schema.node("paragraph")])];
    }),
  },
  {
    // "--" has already become an em dash by the third keystroke.
    match: /^(?:---|___|—-)$/,
    blockStart: true,
    handler: replaceBlockWith((state) => [state.schema.node("horizontalRule"), state.schema.node("paragraph")]),
  },
  {
    match: /(^|\s)\$\$\$([^$]+)\$\$\$$/,
    handler: (state, m, from) => {
      const tr = new Transaction(state);
      const $pos = $(state.doc, from, state.schema);
      if (state.schema.nodes[$pos.parent.type]?.code) return null;
      const blockPos = $pos.before();
      const start = from + (m[1] ?? "").length;
      tr.delete(start, start + m[0].length - (m[1] ?? "").length);
      const empty = (tr.doc.content ?? []).length >= 0 && $(tr.doc, start, state.schema).parent.content?.length === 0;
      const node = state.schema.node("mathBlock", { text: m[2] });
      const at = empty ? blockPos : $(tr.doc, start, state.schema).after();
      tr.replace(at, empty ? $(tr.doc, start, state.schema).after() : at, nodesToItems([node, state.schema.node("paragraph")], state.schema));
      tr.setSelection({ anchor: at + 2, head: at + 2 });
      return tr;
    },
  },
  {
    match: /(^|\s)\$\$([^$]+)\$\$$/,
    handler: (state, m, from, to) => {
      const $pos = $(state.doc, from, state.schema);
      if (state.schema.nodes[$pos.parent.type]?.code) return null;
      const start = from + (m[1] ?? "").length;
      const tr = new Transaction(state);
      tr.replace(start, to, [{ n: { type: "mathInline", attrs: { text: m[2] } } }]);
      tr.setSelection({ anchor: start + 1, head: start + 1 });
      return tr;
    },
  },
  markRule(/(^|[^*])\*\*([^*]+)\*\*$/, "bold"),
  markRule(/(^|[^_\w])__([^_]+)__$/, "bold"),
  markRule(/(^|[^*])\*([^*\s][^*]*)\*$/, "italic"),
  markRule(/(^|[^_\w])_([^_\s][^_]*)_$/, "italic"),
  markRule(/(^|[^~])~~([^~]+)~~$/, "strike"),
  markRule(/(^|[^`])`([^`]+)`$/, "code"),
  markRule(/(^|[^=])==([^=]+)==$/, "highlight"),
  markRule(/(^|[^^])\^([^^\s]+)\^$/, "superscript"),
  markRule(/(^|[^~])~([^~\s]+)~$/, "subscript"),
  textRule(/(^|[^-])--$/, "—"),
  textRule(/()\.\.\.$/, "…"),
  textRule(/()->$/, "→"),
  textRule(/()<-$/, "←"),
  textRule(/()=>$/, "⇒"),
  textRule(/()\(c\)$/i, "©"),
  textRule(/()\(r\)$/i, "®"),
  textRule(/()\(tm\)$/i, "™"),
  textRule(/()!=$/, "≠"),
  textRule(/()<=$/, "≤"),
  textRule(/()>=$/, "≥"),
  textRule(/()\+\/-$/, "±"),
  textRule(/(^|\s)1\/2$/, "½"),
  textRule(/(^|\s)1\/4$/, "¼"),
  textRule(/(^|\s)3\/4$/, "¾"),
];

/**
 * Runs input rules after `text` was typed at `cursor`. Returns the rule's
 * transaction, or null.
 */
export const runInputRules = (state: EditorState, cursor: number): Transaction | null => {
  const { schema, doc } = state;
  const $pos = $(doc, cursor, schema);
  const parent = $pos.parent;
  if (!schema.isTextblock(parent.type)) return null;
  if (schema.nodes[parent.type]?.code) return null;
  const start = $pos.start();
  // Text before the cursor; non-text inline nodes break the run.
  let textBefore = "";
  let offset = start;
  for (const child of parent.content ?? []) {
    const size = child.type === "text" ? child.text!.length : 1;
    if (offset >= cursor) break;
    const take = Math.min(size, cursor - offset);
    if (child.type === "text") {
      if (child.marks?.some((m) => m.type === "code")) textBefore += "\u0000".repeat(take);
      else textBefore += child.text!.slice(0, take);
    } else {
      textBefore += "￼";
    }
    offset += size;
  }
  const inPlainParagraph =
    parent.type === "paragraph" && $pos.depth >= 1;
  for (const rule of inputRules) {
    if (rule.blockStart && !inPlainParagraph) continue;
    const m = textBefore.match(rule.match);
    if (!m) continue;
    if (rule.blockStart && m.index !== 0) continue;
    const from = cursor - m[0].length;
    const tr = rule.handler(state, m, from, cursor);
    if (tr) return tr.setMeta("inputRule", true);
  }
  return null;
};
