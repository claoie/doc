import type { Mark, Node } from "./model";
import { $ } from "./resolved";
import type { Schema } from "./schema";
import { Transaction, isEmpty, selFrom, selTo, type EditorState } from "./state";
import { build, contentSize, flatten, toItems, type SliceItem, type Token } from "./tokens";
import { deleteSelection, type Command } from "./commands";

/**
 * A piece of a document: whole nodes, where the first and last may have been
 * cut open (`openStart`/`openEnd` levels), so pasting can merge their
 * content into the surrounding blocks.
 */
export interface Fragment {
  nodes: Node[];
  openStart: number;
  openEnd: number;
}

export const cut = (doc: Node, from: number, to: number, schema: Schema): Fragment => {
  const all = flatten(doc.content ?? [], doc.type, schema);
  const tokens = all.slice(from, to);
  let depth = 0;
  let minDepth = 0;
  for (const t of tokens) {
    if (t.kind === "open") depth++;
    else if (t.kind === "close") {
      depth--;
      minDepth = Math.min(minDepth, depth);
    }
  }
  const openStart = -minDepth;
  const openEnd = depth - minDepth;
  const $from = $(doc, from, schema);
  const prefix: Token[] = [];
  for (let d = $from.depth - openStart + 1; d <= $from.depth; d++) {
    const node = $from.node(d);
    const t: Token = { kind: "open", type: node.type };
    if (node.attrs) t.attrs = node.attrs;
    prefix.push(t);
  }
  const suffix: Token[] = Array.from({ length: openEnd }, () => ({ kind: "close" as const }));
  const nodes = build([...prefix, ...tokens, ...suffix]) ?? [];
  let fragment: Fragment = { nodes, openStart, openEnd };
  // Unwrap ancestors that were cut on both sides.
  while (
    fragment.nodes.length === 1 &&
    fragment.openStart > 1 &&
    fragment.openEnd > 1 &&
    !schema.isTextblock(fragment.nodes[0]!.type)
  ) {
    fragment = {
      nodes: fragment.nodes[0]!.content ?? [],
      openStart: fragment.openStart - 1,
      openEnd: fragment.openEnd - 1,
    };
  }
  return fragment;
};

const inlineTokens = (block: Node, parentType: string, schema: Schema): Token[] => {
  const code = !!schema.nodes[parentType]?.code;
  const tokens = flatten(block.content ?? [], parentType, schema);
  return tokens
    .filter((t) => !code || t.kind === "char")
    .map((t) => {
      if (t.kind === "char" && t.marks) {
        const marks = t.marks.filter((m: Mark) => schema.allowsMark(parentType, m.type));
        const { marks: _m, ...rest } = t;
        return marks.length ? { ...rest, marks } : rest;
      }
      return t;
    });
};

const plainText = (nodes: Node[]): string =>
  nodes
    .map((n) => (n.type === "text" ? n.text ?? "" : n.type === "hardBreak" ? "\n" : n.content ? plainText(n.content) : ""))
    .join("");

/** Inserts a fragment at the selection, merging open edges into the surrounding text. */
export const insertFragment =
  (fragment: Fragment): Command =>
  (state, dispatch) => {
    const tr = new Transaction(state);
    if (!isEmpty(state.selection)) {
      const from = selFrom(state.selection);
      const to = selTo(state.selection);
      if (state.selection.node) tr.delete(from, to);
      else deleteRange(tr, from, to);
    }
    if (!insertAt(tr, tr.mapping.map(selFrom(state.selection), -1), fragment)) return false;
    dispatch?.(tr.scroll());
    return true;
  };

const deleteRange = (tr: Transaction, from: number, to: number) => {
  const state: EditorState = { schema: tr.schema, doc: tr.doc, selection: { anchor: from, head: to }, storedMarks: null };
  let result: Transaction | null = null;
  deleteSelection(state, (t) => {
    result = t;
  });
  if (result) for (const step of (result as Transaction).steps) tr.step(step);
};

const insertAt = (tr: Transaction, pos: number, fragment: Fragment): boolean => {
  const schema = tr.schema;
  const { nodes, openStart, openEnd } = fragment;
  if (!nodes.length) return false;
  const $pos = $(tr.doc, pos, schema);
  const parent = $pos.parent;
  const inTextblock = schema.isTextblock(parent.type);
  const allInline = nodes.every((n) => schema.isInline(n.type));

  if (inTextblock && schema.nodes[parent.type]?.code) {
    const text = plainText(nodes.length === 1 || allInline ? nodes : nodes.map((n) => ({ ...n, content: [...(n.content ?? []), { type: "text", text: "\n" }] })));
    const trimmed = allInline ? text : text.replace(/\n$/, "");
    if (!trimmed) return false;
    tr.insertText(trimmed, pos);
    tr.setSelection({ anchor: pos + trimmed.length, head: pos + trimmed.length });
    return true;
  }

  if (allInline || (nodes.length === 1 && openStart > 0 && openEnd > 0 && schema.isTextblock(nodes[0]!.type))) {
    if (!inTextblock) return false;
    const inline = allInline ? flatten(nodes, parent.type, schema) : inlineTokens(nodes[0]!, parent.type, schema);
    const items = toItems(filterMarks(inline, parent.type, schema));
    if (!items.length) return false;
    if (!tr.maybeStep({ stepType: "replace", from: pos, to: pos, slice: items })) return false;
    const size = Transaction.sliceSize(items);
    tr.setSelection({ anchor: pos + size, head: pos + size });
    return true;
  }

  if (!inTextblock) {
    const items = toItems(flatten(nodes, parent.type, schema));
    if (!tr.maybeStep({ stepType: "replace", from: pos, to: pos, slice: items })) return false;
    const size = Transaction.sliceSize(items);
    tr.setSelection({ anchor: pos + size, head: pos + size });
    return true;
  }

  // Block content into a textblock: split it and merge open edges.
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const mergeFirst = openStart > 0 && schema.isTextblock(first.type);
  const mergeLast = nodes.length > 1 && openEnd > 0 && schema.isTextblock(last.type);
  const blockEmpty = contentSize(parent, schema) === 0;

  if (blockEmpty && !mergeFirst) {
    const before = $pos.before();
    const after = $pos.after();
    const items = toItems(flatten(nodes, $pos.node($pos.depth - 1).type, schema));
    const needsTrail = !schema.isTextblock(last.type);
    const trail: SliceItem[] = needsTrail ? [{ o: "paragraph" }, { c: 1 }] : [];
    if (!tr.maybeStep({ stepType: "replace", from: before, to: after, slice: [...items, ...trail] })) {
      return insertAtTop(tr, pos, nodes);
    }
    const end = before + Transaction.sliceSize(items);
    const cursor = needsTrail ? end + 1 : end - 1;
    tr.setSelection({ anchor: cursor, head: cursor });
    return true;
  }

  const out: Token[] = [];
  const containerType = $pos.node($pos.depth - 1).type;
  if (mergeFirst) out.push(...inlineTokens(first, parent.type, schema));
  else out.push({ kind: "close" }, ...flatten([first], containerType, schema));
  for (const node of nodes.slice(1, -1)) out.push(...flatten([node], containerType, schema));
  if (nodes.length > 1) {
    if (mergeLast) {
      const open: Token = { kind: "open", type: last.type };
      if (last.attrs) open.attrs = last.attrs;
      out.push(open, ...inlineTokens(last, last.type, schema));
    } else {
      out.push(...flatten([last], containerType, schema));
      const reopen: Token = { kind: "open", type: parent.type };
      if (parent.attrs) reopen.attrs = parent.attrs;
      out.push(reopen);
    }
  } else {
    const reopen: Token = { kind: "open", type: parent.type };
    if (parent.attrs) reopen.attrs = parent.attrs;
    out.push(reopen);
  }
  const items = toItems(out);
  if (!tr.maybeStep({ stepType: "replace", from: pos, to: pos, slice: items })) {
    return insertAtTop(tr, pos, nodes);
  }
  const size = Transaction.sliceSize(items);
  tr.setSelection({ anchor: pos + size, head: pos + size });
  return true;
};

/** Fallback: put the blocks after the top-level block containing `pos`. */
const insertAtTop = (tr: Transaction, pos: number, nodes: Node[]): boolean => {
  const schema = tr.schema;
  const $pos = $(tr.doc, pos, schema);
  if ($pos.depth < 1) return false;
  const after = $pos.after(1);
  const items = toItems(flatten(nodes, "doc", schema));
  if (!tr.maybeStep({ stepType: "replace", from: after, to: after, slice: items })) {
    const text = plainText(nodes);
    if (!text || !schema.isTextblock($pos.parent.type)) return false;
    tr.insertText(text.replace(/\n+/g, " "), pos);
    return true;
  }
  const end = after + Transaction.sliceSize(items);
  tr.setSelection({ anchor: end, head: end });
  return true;
};

const filterMarks = (tokens: Token[], parentType: string, schema: Schema): Token[] =>
  tokens.map((t) => {
    if ((t.kind === "char") && t.marks) {
      const marks = t.marks.filter((m) => schema.allowsMark(parentType, m.type));
      const { marks: _m, ...rest } = t;
      return marks.length ? { ...rest, marks } : rest;
    }
    return t;
  });

/** Plain text inserted as paragraphs (one per line group). */
export const textToFragment = (text: string, schema: Schema): Fragment => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length === 1) return { nodes: lines[0] ? [schema.text(lines[0])] : [], openStart: 0, openEnd: 0 };
  const nodes = lines.map((line) => schema.node("paragraph", undefined, line ? [schema.text(line)] : []));
  return { nodes, openStart: 1, openEnd: 1 };
};
