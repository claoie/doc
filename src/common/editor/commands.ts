import { hasMark, sameMark, type Attrs, type Mark, type Node } from "./model";
import { $, blockRange, type Pos } from "./resolved";
import type { Schema } from "./schema";
import { Transaction, isEmpty, selFrom, selTo, type EditorState } from "./state";
import { StepError } from "./steps";
import { contentSize, descendants, nodeAt, nodeSize, nodesToItems, type SliceItem } from "./tokens";

export type Dispatch = (tr: Transaction) => void;
export type Command = (state: EditorState, dispatch?: Dispatch) => boolean;

const run = (state: EditorState, dispatch: Dispatch | undefined, build: (tr: Transaction) => boolean | void) => {
  const tr = new Transaction(state);
  try {
    if (build(tr) === false) return false;
  } catch (e) {
    if (e instanceof StepError || e instanceof RangeError) return false;
    throw e;
  }
  if (!tr.docChanged && !tr.selectionSet && !tr.storedMarksSet) return false;
  dispatch?.(tr.scroll());
  return true;
};

const cursor = (tr: Transaction, pos: number) => tr.setSelection({ anchor: pos, head: pos });

/** First position inside a textblock at or after `pos` (searching forward), or null. */
export const textblockStartAfter = (doc: Node, pos: number, schema: Schema): number | null => {
  let found: number | null = null;
  descendants(doc, schema, (node, p) => {
    if (found !== null) return false;
    if (p + nodeSize(node, schema) <= pos) return false;
    if (schema.isTextblock(node.type) && p >= pos - 1) {
      found = p + 1;
      return false;
    }
    return true;
  });
  return found;
};

/** Last position inside a textblock at or before `pos`, or null. */
export const textblockEndBefore = (doc: Node, pos: number, schema: Schema): number | null => {
  let found: number | null = null;
  descendants(doc, schema, (node, p) => {
    if (p >= pos) return false;
    if (schema.isTextblock(node.type)) {
      const end = p + nodeSize(node, schema) - 1;
      if (end <= pos) found = end;
      return false;
    }
    return true;
  });
  return found;
};

export const marksAt = (state: EditorState): Mark[] => {
  if (state.storedMarks) return state.storedMarks;
  const { schema, doc, selection } = state;
  const $pos = $(doc, selFrom(selection), schema);
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  const source = before && before.type === "text" ? before : after && after.type === "text" ? after : null;
  const marks = source?.marks ?? [];
  // Non-inclusive marks (links, inline code) do not extend when typing at their end.
  return marks.filter((m) => {
    const inclusive = schema.marks[m.type]?.inclusive !== false;
    if (inclusive) return true;
    return !!(after && after.type === "text" && hasMark(after.marks, m) && before && before.type === "text");
  });
};

export const insertText =
  (text: string, from?: number, to?: number): Command =>
  (state, dispatch) =>
    run(state, dispatch, (tr) => {
      const a = from ?? selFrom(state.selection);
      const b = to ?? selTo(state.selection);
      const $pos = $(state.doc, a, state.schema);
      const parent = $pos.parent;
      if (!state.schema.isTextblock(parent.type)) return false;
      const marks = state.schema.nodes[parent.type]?.code ? [] : marksAt(state);
      if (a !== b) deleteRangeInto(tr, a, b);
      const at = tr.mapping.map(a, -1);
      tr.insertText(text, at, at, marks.filter((m) => state.schema.allowsMark(parent.type, m.type)));
      cursor(tr, at + text.length);
    });

/**
 * Deletes [from, to). When the range crosses blocks, the content of the last
 * touched textblock joins the first one.
 */
const deleteRangeInto = (tr: Transaction, from: number, to: number) => {
  const schema = tr.schema;
  const $from = $(tr.doc, from, schema);
  const $to = $(tr.doc, to, schema);
  if ($from.parent === $to.parent || (from === to)) {
    tr.delete(from, to);
    return;
  }
  // Try the plain splice first; it works whenever the structure on both sides matches.
  if (tr.maybeStep({ stepType: "replace", from, to, slice: [] })) return;
  // Otherwise remove whole blocks in between and move the trailing text up.
  const fromBlockDepth = $from.findDepth((n) => schema.isTextblock(n.type));
  const toBlockDepth = $to.findDepth((n) => schema.isTextblock(n.type));
  if (fromBlockDepth < 0 || toBlockDepth < 0) {
    tr.maybeStep({ stepType: "replace", from, to, slice: [] });
    return;
  }
  const tail = ($to.parent.content ?? []).length
    ? sliceInline($to.parent, $to.parentOffset, contentSize($to.parent, schema), schema)
    : [];
  const shared = $from.sharedDepth($to);
  // Delete from `from` to the end of the shared container's child that holds `to`.
  const endOfToBranch = $to.after(shared + 1);
  const startOfFromBranchEnd = $from.end(fromBlockDepth);
  tr.delete(from, startOfFromBranchEnd);
  const mappedEnd = tr.mapping.map(endOfToBranch);
  const mappedFromBlockEnd = tr.mapping.map(startOfFromBranchEnd);
  const afterFromBranch = $(tr.doc, mappedFromBlockEnd, schema).after(shared + 1);
  if (mappedEnd > afterFromBranch) tr.delete(afterFromBranch, mappedEnd);
  if (tail.length) tr.replace(tr.mapping.map(from, -1), tr.mapping.map(from, -1), tail);
};

/** Inline content of a textblock between two offsets, as slice items. */
const sliceInline = (block: Node, start: number, end: number, schema: Schema): SliceItem[] => {
  const items: SliceItem[] = [];
  let offset = 0;
  for (const child of block.content ?? []) {
    const size = nodeSize(child, schema);
    const s = Math.max(start, offset);
    const e = Math.min(end, offset + size);
    if (e > s) {
      if (child.type === "text") {
        const t = child.text!.slice(s - offset, e - offset);
        items.push(child.marks?.length ? { t, m: child.marks } : { t });
      } else {
        items.push({ n: child });
      }
    }
    offset += size;
  }
  return items;
};

export const deleteSelection: Command = (state, dispatch) => {
  if (isEmpty(state.selection)) return false;
  return run(state, dispatch, (tr) => {
    const from = selFrom(state.selection);
    const to = selTo(state.selection);
    if (state.selection.node) {
      tr.delete(from, to);
      const $pos = $(tr.doc, Math.min(from, contentSize(tr.doc, tr.schema)), tr.schema);
      if (!tr.schema.isTextblock($pos.parent.type)) {
        // Deleting the only block leaves the parent empty; refill it with a paragraph.
        if (!tr.schema.validContent($pos.parent.type, $pos.parent.content ?? [])) {
          tr.replace(from, from, nodesToItems([tr.schema.node("paragraph")], tr.schema));
          cursor(tr, from + 1);
          return;
        }
        const next = textblockStartAfter(tr.doc, from, tr.schema);
        cursor(tr, next ?? from);
        return;
      }
      cursor(tr, from);
      return;
    }
    deleteRangeInto(tr, from, to);
    cursor(tr, tr.mapping.map(from, -1));
  });
};

const graphemeBefore = (text: string): number => {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
    return segments[segments.length - 1]?.segment.length ?? 1;
  }
  return 1;
};

const graphemeAfter = (text: string): number => {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const first = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)[Symbol.iterator]().next();
    return first.value?.segment.length ?? 1;
  }
  return 1;
};

export const deleteBackward: Command = (state, dispatch) => {
  if (!isEmpty(state.selection) || state.selection.node) return deleteSelection(state, dispatch);
  const { schema, doc } = state;
  const pos = state.selection.head;
  const $pos = $(doc, pos, schema);
  if (!schema.isTextblock($pos.parent.type)) return false;
  if (!$pos.atStart) {
    const before = $pos.nodeBefore;
    const size = before?.type === "text" ? graphemeBefore(before.text!) : 1;
    return run(state, dispatch, (tr) => {
      tr.delete(pos - size, pos);
      cursor(tr, pos - size);
    });
  }
  return joinBackward(state, dispatch);
};

export const deleteForward: Command = (state, dispatch) => {
  if (!isEmpty(state.selection) || state.selection.node) return deleteSelection(state, dispatch);
  const { schema, doc } = state;
  const pos = state.selection.head;
  const $pos = $(doc, pos, schema);
  if (!schema.isTextblock($pos.parent.type)) return false;
  if (!$pos.atEnd) {
    const after = $pos.nodeAfter;
    const size = after?.type === "text" ? graphemeAfter(after.text!) : 1;
    return run(state, dispatch, (tr) => {
      tr.delete(pos, pos + size);
    });
  }
  return joinForward(state, dispatch);
};

const isolatingBetween = (schema: Schema, $a: Pos, $b: Pos) => {
  const shared = $a.sharedDepth($b);
  for (let d = $a.depth; d > shared; d--) if (schema.nodes[$a.node(d).type]?.isolating) return true;
  for (let d = $b.depth; d > shared; d--) if (schema.nodes[$b.node(d).type]?.isolating) return true;
  return false;
};

/** Backspace at the start of a textblock. */
export const joinBackward: Command = (state, dispatch) => {
  const { schema, doc } = state;
  const pos = state.selection.head;
  const $pos = $(doc, pos, schema);
  // In a list item, the first backspace lifts the item out of the list.
  const itemDepth = $pos.findDepth((n) => isListItem(schema, n.type));
  if (itemDepth > 0 && $pos.index(itemDepth) === 0 && $pos.depth === itemDepth + 1) {
    if (liftListItem(state, dispatch)) return true;
  }
  // A non-paragraph textblock (heading, code) at the start turns into a paragraph first.
  if ($pos.parent.type !== "paragraph" && $pos.parent.type !== "detailsSummary" && schema.nodes.paragraph) {
    const blockPos = $pos.before();
    const parentOfBlock = $pos.node($pos.depth - 1);
    if (parentOfBlock && schema.validContent(parentOfBlock.type, (parentOfBlock.content ?? []).map((c, i) => i === $pos.index($pos.depth - 1) ? { ...c, type: "paragraph" } : c))) {
      if ($pos.parent.type !== "paragraph" && !schema.nodes[$pos.parent.type]?.isolating) {
        return setBlockTypeAt(state, dispatch, blockPos, "paragraph");
      }
    }
  }
  // Wrapped in a blockquote/callout as the first child: lift out.
  const wrapperDepth = $pos.depth - 1;
  if (wrapperDepth > 0 && $pos.index(wrapperDepth) === 0) {
    const wrapper = $pos.node(wrapperDepth);
    if (isWrapper(schema, wrapper.type)) return lift(state, dispatch);
  }
  const prevEnd = textblockEndBefore(doc, $pos.before(), schema);
  const prevIndex = $pos.index($pos.depth - 1) - 1;
  const prevSibling = $pos.node($pos.depth - 1).content?.[prevIndex];
  // A leaf block right before (image, divider): select it.
  if (prevSibling && schema.isLeaf(prevSibling.type)) {
    const start = $pos.before() - 1;
    return run(state, dispatch, (tr) => {
      if (contentSize($pos.parent, schema) === 0) {
        tr.delete($pos.before(), $pos.after());
      }
      tr.setSelection({ anchor: start, head: start + 1, node: true });
    });
  }
  if (prevEnd === null) return false;
  const $prev = $(doc, prevEnd, schema);
  if (isolatingBetween(schema, $prev, $pos)) return false;
  return run(state, dispatch, (tr) => {
    if (tr.maybeStep({ stepType: "replace", from: prevEnd, to: pos, slice: [] })) {
      cursor(tr, prevEnd);
      return;
    }
    // Structures differ (e.g. paragraph after a list): move this block's text
    // to the end of the previous textblock and delete this block.
    const text = sliceInline($pos.parent, 0, contentSize($pos.parent, schema), schema);
    const blockFrom = $pos.before();
    const blockTo = $pos.after();
    tr.delete(blockFrom, blockTo);
    removeEmptyAncestors(tr, blockFrom);
    if (text.length) tr.replace(prevEnd, prevEnd, text);
    cursor(tr, prevEnd);
  });
};

/** Delete at the end of a textblock. */
export const joinForward: Command = (state, dispatch) => {
  const { schema, doc } = state;
  const pos = state.selection.head;
  const $pos = $(doc, pos, schema);
  const nextStart = textblockStartAfter(doc, $pos.after(), schema);
  const nextIndex = $pos.index($pos.depth - 1) + 1;
  const nextSibling = $pos.node($pos.depth - 1).content?.[nextIndex];
  if (nextSibling && schema.isLeaf(nextSibling.type)) {
    const start = $pos.after();
    return run(state, dispatch, (tr) => {
      tr.setSelection({ anchor: start, head: start + 1, node: true });
    });
  }
  if (nextStart === null) return false;
  const $next = $(doc, nextStart, schema);
  if (isolatingBetween(schema, $pos, $next)) return false;
  return run(state, dispatch, (tr) => {
    if (tr.maybeStep({ stepType: "replace", from: pos, to: nextStart, slice: [] })) return;
    const text = sliceInline($next.parent, 0, contentSize($next.parent, schema), schema);
    const blockFrom = $next.before();
    tr.delete(blockFrom, $next.after());
    removeEmptyAncestors(tr, blockFrom);
    if (text.length) tr.replace(pos, pos, text);
    cursor(tr, pos);
  });
};

/** After deleting a block, removes wrappers left without valid content. */
const removeEmptyAncestors = (tr: Transaction, pos: number) => {
  const schema = tr.schema;
  for (let i = 0; i < 6; i++) {
    const $pos = $(tr.doc, Math.min(pos, contentSize(tr.doc, schema)), schema);
    const parent = $pos.parent;
    if ($pos.depth === 0 || schema.validContent(parent.type, parent.content ?? [])) return;
    tr.maybeStep({ stepType: "replace", from: $pos.before(), to: $pos.after(), slice: [] });
    pos = tr.mapping.map(pos);
  }
};

export const isListItem = (schema: Schema, type: string) => type === "listItem" || type === "taskItem";
export const isList = (schema: Schema, type: string) =>
  type === "bulletList" || type === "orderedList" || type === "taskList";
const isWrapper = (schema: Schema, type: string) =>
  type === "blockquote" || type === "callout";

/** Enter. */
export const splitBlock: Command = (state, dispatch) => {
  const { schema } = state;
  const from = selFrom(state.selection);
  const $from = $(state.doc, from, schema);
  const parent = $from.parent;
  if (!schema.isTextblock(parent.type)) {
    if (state.selection.node) {
      // Enter on a selected block inserts a paragraph after it.
      const after = selTo(state.selection);
      return run(state, dispatch, (tr) => {
        tr.replace(after, after, nodesToItems([schema.node("paragraph")], schema));
        cursor(tr, after + 1);
      });
    }
    return false;
  }
  if (schema.nodes[parent.type]?.code) return insertText("\n")(state, dispatch);
  // Empty list item: leave the list.
  const itemDepth = $from.findDepth((n) => isListItem(schema, n.type));
  if (itemDepth > 0 && contentSize(parent, schema) === 0 && $from.depth === itemDepth + 1) {
    const item = $from.node(itemDepth);
    if ((item.content ?? []).length === 1) return liftListItem(state, dispatch);
  }
  if (itemDepth > 0 && $from.depth === itemDepth + 1 && $from.index(itemDepth) === 0) {
    return splitListItem(state, dispatch);
  }
  if (parent.type === "detailsSummary") {
    // Enter in a summary moves into the details content.
    const contentStart = $from.after() + 1;
    return run(state, dispatch, (tr) => {
      cursor(tr, contentStart + 1);
    });
  }
  return run(state, dispatch, (tr) => {
    if (!isEmpty(state.selection)) deleteRangeInto(tr, from, selTo(state.selection));
    const at = tr.mapping.map(from, -1);
    const $at = $(tr.doc, at, schema);
    const atEnd = $at.atEnd;
    const keepType = !atEnd || parent.type === "paragraph";
    const nextType = keepType ? parent.type : "paragraph";
    const attrs = keepType ? parent.attrs : schema.attrs("paragraph");
    const open: SliceItem = attrs ? { o: nextType, a: resetSplitAttrs(nextType, attrs) } : { o: nextType };
    tr.replace(at, at, [{ c: 1 }, open]);
    cursor(tr, at + 2);
  });
};

/** Attrs that should not carry over to the second half of a split block. */
const resetSplitAttrs = (type: string, attrs: Attrs): Attrs => {
  if (type === "taskItem") return { ...attrs, checked: false };
  const { id: _id, ...rest } = attrs as Attrs & { id?: unknown };
  return rest;
};

export const splitListItem: Command = (state, dispatch) => {
  const { schema } = state;
  const from = selFrom(state.selection);
  const $from = $(state.doc, from, schema);
  const itemDepth = $from.findDepth((n) => isListItem(schema, n.type));
  if (itemDepth < 0) return false;
  const item = $from.node(itemDepth);
  return run(state, dispatch, (tr) => {
    if (!isEmpty(state.selection)) deleteRangeInto(tr, from, selTo(state.selection));
    const at = tr.mapping.map(from, -1);
    const itemAttrs = item.type === "taskItem" ? { ...item.attrs, checked: false } : item.attrs;
    const openItem: SliceItem = itemAttrs ? { o: item.type, a: itemAttrs } : { o: item.type };
    tr.replace(at, at, [{ c: 1 }, { c: 1 }, openItem, { o: "paragraph" }]);
    cursor(tr, at + 4);
  });
};

export const insertHardBreak: Command = (state, dispatch) => {
  const { schema } = state;
  const $from = $(state.doc, selFrom(state.selection), schema);
  if (!schema.isTextblock($from.parent.type)) return false;
  if (schema.nodes[$from.parent.type]?.code) return insertText("\n")(state, dispatch);
  return run(state, dispatch, (tr) => {
    const from = selFrom(state.selection);
    if (!isEmpty(state.selection)) deleteRangeInto(tr, from, selTo(state.selection));
    const at = tr.mapping.map(from, -1);
    tr.replace(at, at, [{ n: { type: "hardBreak" } }]);
    cursor(tr, at + 1);
  });
};

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

/** Ranges of inline content within the selection, per textblock. */
const inlineRanges = (state: EditorState) => {
  const { doc, schema, selection } = state;
  const from = selFrom(selection);
  const to = selTo(selection);
  const ranges: { from: number; to: number; parent: string }[] = [];
  descendants(doc, schema, (node, pos) => {
    const end = pos + nodeSize(node, schema);
    if (end < from || pos > to) return false;
    if (schema.isTextblock(node.type)) {
      const s = Math.max(from, pos + 1);
      const e = Math.min(to, end - 1);
      if (e > s) ranges.push({ from: s, to: e, parent: node.type });
      return false;
    }
    return true;
  });
  return ranges;
};

/** Whether every character in the selection carries the mark type. */
export const markActive = (state: EditorState, type: string): boolean => {
  if (isEmpty(state.selection)) return marksAt(state).some((m) => m.type === type);
  let all = true;
  let any = false;
  const { doc, schema } = state;
  for (const range of inlineRanges(state)) {
    descendants(doc, schema, (node, pos) => {
      const end = pos + nodeSize(node, schema);
      if (end <= range.from || pos >= range.to) return false;
      if (node.type === "text") {
        any = true;
        if (!node.marks?.some((m) => m.type === type)) all = false;
      }
      return true;
    });
  }
  return any && all;
};

export const activeMark = (state: EditorState, type: string): Mark | null => {
  if (isEmpty(state.selection)) return marksAt(state).find((m) => m.type === type) ?? null;
  const $from = $(state.doc, selFrom(state.selection), state.schema);
  const after = $from.nodeAfter;
  return after?.marks?.find((m) => m.type === type) ?? null;
};

export const setMark =
  (mark: Mark): Command =>
  (state, dispatch) => {
    const { schema } = state;
    if (isEmpty(state.selection)) {
      return run(state, dispatch, (tr) => {
        const marks = marksAt(state).filter((m) => (schema.marks[mark.type]?.stackable ? !sameMark(m, mark) : m.type !== mark.type));
        tr.setStoredMarks([...marks, mark]);
      });
    }
    return run(state, dispatch, (tr) => {
      for (const range of inlineRanges(state)) {
        if (!schema.allowsMark(range.parent, mark.type)) continue;
        // Remove differing marks of the same type first so undo restores them.
        if (!schema.marks[mark.type]?.stackable) removeMarkType(tr, range.from, range.to, mark.type, mark);
        tr.addMark(range.from, range.to, mark);
      }
      if (!tr.docChanged) return false;
    });
  };

const removeMarkType = (tr: Transaction, from: number, to: number, type: string, keep?: Mark) => {
  const found: { from: number; to: number; mark: Mark }[] = [];
  descendants(tr.doc, tr.schema, (node, pos) => {
    const end = pos + nodeSize(node, tr.schema);
    if (end <= from || pos >= to) return false;
    for (const mark of node.marks ?? []) {
      if (mark.type !== type || (keep && sameMark(mark, keep))) continue;
      found.push({ from: Math.max(from, pos), to: Math.min(to, end), mark });
    }
    return true;
  });
  for (const f of found) tr.removeMark(f.from, f.to, f.mark);
};

export const unsetMark =
  (type: string): Command =>
  (state, dispatch) => {
    if (isEmpty(state.selection)) {
      return run(state, dispatch, (tr) => {
        tr.setStoredMarks(marksAt(state).filter((m) => m.type !== type));
      });
    }
    return run(state, dispatch, (tr) => {
      for (const range of inlineRanges(state)) removeMarkType(tr, range.from, range.to, type);
      if (!tr.docChanged) return false;
    });
  };

export const toggleMark =
  (type: string, attrs?: Attrs): Command =>
  (state, dispatch) =>
    markActive(state, type)
      ? unsetMark(type)(state, dispatch)
      : setMark(state.schema.mark(type, attrs))(state, dispatch);

/** Extends a collapsed cursor inside a mark to the mark's full range. */
export const markRange = (state: EditorState, type: string): { from: number; to: number } | null => {
  const { doc, schema } = state;
  const pos = selFrom(state.selection);
  const $pos = $(doc, pos, schema);
  const parent = $pos.parent;
  if (!schema.isTextblock(parent.type)) return null;
  const start = $pos.start();
  const children = parent.content ?? [];
  let offset = start;
  const spans: { from: number; to: number; mark?: Mark }[] = [];
  for (const child of children) {
    const size = nodeSize(child, schema);
    spans.push({ from: offset, to: offset + size, mark: child.marks?.find((m) => m.type === type) });
    offset += size;
  }
  const hit = spans.findIndex((s) => s.mark && pos >= s.from && pos <= s.to && (pos < s.to || pos > s.from));
  if (hit < 0) return null;
  const mark = spans[hit]!.mark!;
  let a = hit;
  let b = hit;
  while (a > 0 && spans[a - 1]!.mark && sameMark(spans[a - 1]!.mark!, mark)) a--;
  while (b < spans.length - 1 && spans[b + 1]!.mark && sameMark(spans[b + 1]!.mark!, mark)) b++;
  return { from: spans[a]!.from, to: spans[b]!.to };
};

// ---------------------------------------------------------------------------
// Block types and wrapping
// ---------------------------------------------------------------------------

const setBlockTypeAt = (
  state: EditorState,
  dispatch: Dispatch | undefined,
  blockPos: number,
  type: string,
  attrs?: Attrs,
) =>
  run(state, dispatch, (tr) => {
    retype(tr, blockPos, type, attrs);
  });

const retype = (tr: Transaction, blockPos: number, type: string, attrs?: Attrs) => {
  const found = nodeAt(tr.doc, blockPos, tr.schema);
  if (!found) return;
  const size = nodeSize(found.node, tr.schema);
  const merged = tr.schema.attrs(type, attrs);
  const open: SliceItem = merged ? { o: type, a: merged } : { o: type };
  const toCode = !!tr.schema.nodes[type]?.code;
  if (toCode) {
    // Code blocks hold plain text: drop marks and turn hard breaks into newlines.
    const text = (found.node.content ?? [])
      .map((c) => (c.type === "text" ? c.text : c.type === "hardBreak" ? "\n" : ""))
      .join("");
    tr.replace(blockPos, blockPos + size, [open, ...(text ? [{ t: text }] : []), { c: 1 }]);
    return;
  }
  tr.step({
    stepType: "replaceAround",
    from: blockPos,
    to: blockPos + size,
    gapFrom: blockPos + 1,
    gapTo: blockPos + size - 1,
    slice: [open, { c: 1 }],
    insert: 1,
  });
};

/** Changes every textblock in the selection to `type`. */
export const setBlockType =
  (type: string, attrs?: Attrs): Command =>
  (state, dispatch) => {
    const { doc, schema, selection } = state;
    const from = selFrom(selection);
    const to = selTo(selection);
    const targets: number[] = [];
    descendants(doc, schema, (node, pos) => {
      const end = pos + nodeSize(node, schema);
      if (end < from || pos > to) return false;
      if (schema.isTextblock(node.type)) {
        if (node.type !== type || !sameAttrsLoose(node.attrs, attrs)) targets.push(pos);
        return false;
      }
      return true;
    });
    if (!targets.length) return false;
    return run(state, dispatch, (tr) => {
      for (const pos of targets) {
        const mapped = tr.mapping.map(pos);
        const found = nodeAt(tr.doc, mapped, tr.schema);
        if (!found) continue;
        const $p = $(tr.doc, mapped + 1, tr.schema);
        const container = $p.node($p.depth - 1);
        const index = $p.index($p.depth - 1);
        const replaced = (container.content ?? []).map((c, i) => (i === index ? { ...c, type } : c));
        if (!tr.schema.validContent(container.type, replaced)) continue;
        retype(tr, mapped, type, attrs);
      }
      if (!tr.docChanged) return false;
      // Retyping keeps block sizes, so positions stay valid.
      tr.setSelection(selection);
    });
  };

const sameAttrsLoose = (a?: Attrs, b?: Attrs) => {
  if (!b) return true;
  return Object.entries(b).every(([k, v]) => a?.[k] === v);
};

export const blockTypeActive = (state: EditorState, type: string, attrs?: Attrs) => {
  const $from = $(state.doc, selFrom(state.selection), state.schema);
  const node = $from.parent;
  return node.type === type && sameAttrsLoose(node.attrs, attrs);
};

/** Wraps the selected blocks in `type` (blockquote, callout, lists). */
export const wrapIn =
  (type: string, attrs?: Attrs, innerType?: string): Command =>
  (state, dispatch) => {
    const { doc, schema, selection } = state;
    const $from = $(doc, selFrom(selection), schema);
    const $to = $(doc, selTo(selection), schema);
    const range = blockRange($from, $to);
    if (!range) return false;
    return run(state, dispatch, (tr) => {
      const merged = schema.attrs(type, attrs);
      const outer: SliceItem = merged ? { o: type, a: merged } : { o: type };
      if (innerType) {
        // Each block becomes its own item (lists).
        const blocks = (range.parent.content ?? []).slice(range.startIndex, range.endIndex);
        const items: Node[] = blocks.map((b) => ({
          type: innerType,
          ...(schema.attrs(innerType) ? { attrs: schema.attrs(innerType) } : {}),
          content: [schema.isTextblock(b.type) && b.type !== "paragraph" ? { ...b, type: "paragraph", attrs: undefined } : b],
        }));
        tr.replace(range.from, range.to, nodesToItems([{ type, ...(merged ? { attrs: merged } : {}), content: items }], schema));
        // Each wrapped block gains a list open and an item open before it,
        // plus an item close/open pair per earlier block.
        const shift = (pos: number) => {
          let offset = range.from;
          for (let k = 0; k < blocks.length; k++) {
            const end = offset + nodeSize(blocks[k]!, schema);
            if (pos <= end) return pos + 2 + 2 * k;
            offset = end;
          }
          return pos + 2 * blocks.length;
        };
        tr.setSelection({ anchor: shift(selection.anchor), head: shift(selection.head) });
        return;
      } else {
        tr.step({
          stepType: "replaceAround",
          from: range.from,
          to: range.to,
          gapFrom: range.from,
          gapTo: range.to,
          slice: [outer, { c: 1 }],
          insert: 1,
        });
      }
      tr.setSelection({
        anchor: tr.mapping.map(selection.anchor),
        head: tr.mapping.map(selection.head),
      });
    });
  };

/** Moves the selected blocks out of their wrapper (blockquote, callout, list). */
export const lift: Command = (state, dispatch) => {
  const { doc, schema, selection } = state;
  const $from = $(doc, selFrom(selection), schema);
  const $to = $(doc, selTo(selection), schema);
  const range = blockRange($from, $to, (_n, d) => d > 0);
  if (!range) return false;
  const $wrap = $(doc, range.from, schema);
  const wrapperDepth = range.depth;
  const wrapperStart = $wrap.before(wrapperDepth);
  const wrapperEnd = $wrap.after(wrapperDepth);
  const wrapper = range.parent;
  const grand = $wrap.node(wrapperDepth - 1);
  const children = wrapper.content ?? [];
  const lifted = children.slice(range.startIndex, range.endIndex);
  const replacement = [...(grand.content ?? [])];
  const idx = $wrap.index(wrapperDepth - 1);
  const before = children.slice(0, range.startIndex);
  const after = children.slice(range.endIndex);
  replacement.splice(
    idx,
    1,
    ...(before.length ? [{ ...wrapper, content: before }] : []),
    ...lifted,
    ...(after.length ? [{ ...wrapper, content: after }] : []),
  );
  if (!schema.validContent(grand.type, replacement)) return false;
  return run(state, dispatch, (tr) => {
    const slice: SliceItem[] = [];
    const open: SliceItem = wrapper.attrs ? { o: wrapper.type, a: wrapper.attrs } : { o: wrapper.type };
    // Close the wrapper before the lifted blocks and reopen it after, keeping
    // the lifted blocks themselves as the gap so concurrent edits survive.
    const gapFrom = range.from;
    const gapTo = range.to;
    if (before.length) slice.push({ c: 1 });
    const insert = sliceSizeOf(slice);
    if (after.length) slice.push(open);
    tr.step({
      stepType: "replaceAround",
      from: before.length ? gapFrom : wrapperStart,
      to: after.length ? gapTo : wrapperEnd,
      gapFrom,
      gapTo,
      slice,
      insert,
    });
    tr.setSelection({
      anchor: tr.mapping.map(selection.anchor),
      head: tr.mapping.map(selection.head),
    });
  });
};

const sliceSizeOf = (items: SliceItem[]) => Transaction.sliceSize(items);

export const toggleWrap =
  (type: string, attrs?: Attrs): Command =>
  (state, dispatch) => {
    const $from = $(state.doc, selFrom(state.selection), state.schema);
    const depth = $from.findDepth((n) => n.type === type);
    if (depth > 0) return lift(state, dispatch);
    return wrapIn(type, attrs)(state, dispatch);
  };

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

const itemTypeFor = (listType: string) => (listType === "taskList" ? "taskItem" : "listItem");

export const toggleList =
  (listType: string): Command =>
  (state, dispatch) => {
    const { schema } = state;
    const $from = $(state.doc, selFrom(state.selection), schema);
    const listDepth = $from.findDepth((n) => isList(schema, n.type));
    if (listDepth > 0) {
      const list = $from.node(listDepth);
      if (list.type === listType) return liftListItem(state, dispatch);
      // Switch list kind in place (items convert between task and plain).
      return run(state, dispatch, (tr) => {
        const pos = $from.before(listDepth);
        const itemType = itemTypeFor(listType);
        const items = (list.content ?? []).map((item) => ({
          ...item,
          type: itemType,
          attrs: itemType === "taskItem" ? { checked: !!item.attrs?.checked } : undefined,
        }));
        const next: Node = { type: listType, ...(schema.attrs(listType) ? { attrs: schema.attrs(listType) } : {}), content: items };
        tr.replace(pos, pos + nodeSize(list, schema), nodesToItems([next], schema));
        // Switching list kinds keeps every position in place.
        tr.setSelection(state.selection);
      });
    }
    return wrapIn(listType, undefined, itemTypeFor(listType))(state, dispatch);
  };

/** Moves the current list item out one level (or out of the list). */
export const liftListItem: Command = (state, dispatch) => {
  const { schema, doc } = state;
  const $from = $(doc, selFrom(state.selection), schema);
  const itemDepth = $from.findDepth((n) => isListItem(schema, n.type));
  if (itemDepth < 1) return false;
  const listDepth = itemDepth - 1;
  const list = $from.node(listDepth);
  const item = $from.node(itemDepth);
  const itemIndex = $from.index(listDepth);
  const listPos = $from.before(listDepth);
  const outer = $from.node(listDepth - 1);
  const nestedInItem = listDepth - 1 > 0 && isListItem(schema, outer.type);
  const items = list.content ?? [];
  const before = items.slice(0, itemIndex);
  const after = items.slice(itemIndex + 1);
  return run(state, dispatch, (tr) => {
    const listNode = (content: Node[]): Node => ({ ...list, content });
    const offsetInItem = selFrom(state.selection) - $from.start(itemDepth);
    if (nestedInItem) {
      // Sub-list item becomes a sibling item of its parent, taking the
      // following items as its own sub-list.
      const parentItemDepth = listDepth - 1;
      const parentItem = $from.node(parentItemDepth);
      const parentItemPos = $from.before(parentItemDepth);
      const parentContent = parentItem.content ?? [];
      const listIndexInParent = $from.index(parentItemDepth);
      const newParent: Node = {
        ...parentItem,
        content: [
          ...parentContent.slice(0, listIndexInParent),
          ...(before.length ? [listNode(before)] : []),
          ...parentContent.slice(listIndexInParent + 1),
        ],
      };
      const movedItem: Node = {
        ...item,
        type: parentItem.type,
        attrs: parentItem.type === "taskItem" ? { checked: !!item.attrs?.checked } : undefined,
        content: [...(item.content ?? []), ...(after.length ? [listNode(after)] : [])],
      };
      const size = nodeSize(parentItem, schema);
      tr.replace(parentItemPos, parentItemPos + size, nodesToItems([newParent, movedItem], schema));
      const movedStart = parentItemPos + nodeSize(newParent, schema) + 1;
      cursor(tr, movedStart + offsetInItem);
      return;
    }
    // Top-level: the item's blocks leave the list.
    const blocks = item.content ?? [];
    const replacement: Node[] = [
      ...(before.length ? [listNode(before)] : []),
      ...blocks,
      ...(after.length ? [listNode(after)] : []),
    ];
    if (!schema.validContent(outer.type, [...(outer.content ?? []).slice(0, $from.index(listDepth - 1)), ...replacement, ...(outer.content ?? []).slice($from.index(listDepth - 1) + 1)])) return false;
    tr.replace(listPos, listPos + nodeSize(list, schema), nodesToItems(replacement, schema));
    const blocksStart = listPos + (before.length ? nodeSize(listNode(before), schema) : 0);
    cursor(tr, blocksStart + offsetInItem);
  });
};

/** Tab in a list: nests the item under its previous sibling. */
export const sinkListItem: Command = (state, dispatch) => {
  const { schema, doc } = state;
  const $from = $(doc, selFrom(state.selection), schema);
  const itemDepth = $from.findDepth((n) => isListItem(schema, n.type));
  if (itemDepth < 1) return false;
  const listDepth = itemDepth - 1;
  const itemIndex = $from.index(listDepth);
  if (itemIndex === 0) return false;
  const list = $from.node(listDepth);
  const items = list.content ?? [];
  const prev = items[itemIndex - 1]!;
  const item = items[itemIndex]!;
  const prevContent = prev.content ?? [];
  const lastOfPrev = prevContent[prevContent.length - 1];
  return run(state, dispatch, (tr) => {
    const prevPos = $from.posAtIndex(itemIndex - 1, listDepth);
    const offsetInItem = selFrom(state.selection) - $from.start(itemDepth);
    let newPrev: Node;
    if (lastOfPrev && lastOfPrev.type === list.type) {
      newPrev = { ...prev, content: [...prevContent.slice(0, -1), { ...lastOfPrev, content: [...(lastOfPrev.content ?? []), item] }] };
    } else {
      newPrev = { ...prev, content: [...prevContent, { ...list, attrs: list.type === "orderedList" ? { ...list.attrs, start: 1 } : list.attrs, content: [item] }] };
    }
    const end = prevPos + nodeSize(prev, schema) + nodeSize(item, schema);
    tr.replace(prevPos, end, nodesToItems([newPrev], schema));
    const itemAfter = prevPos + nodeSize(newPrev, schema) - 2;
    const itemBefore = itemAfter - nodeSize(item, schema);
    cursor(tr, itemBefore + 1 + offsetInItem);
  });
};

// ---------------------------------------------------------------------------
// Inserting nodes
// ---------------------------------------------------------------------------

/**
 * Inserts block nodes at the selection. An empty paragraph at the cursor is
 * replaced; otherwise the blocks go after the current block.
 */
export const insertBlocks =
  (nodes: Node[], selectInside = true): Command =>
  (state, dispatch) => {
    const { schema } = state;
    return run(state, dispatch, (tr) => {
      const from = selFrom(state.selection);
      if (state.selection.node) {
        const at = selTo(state.selection);
        tr.replace(at, at, nodesToItems(nodes, schema));
        placeAfterInsert(tr, at, nodes, selectInside);
        return;
      }
      const $from = $(tr.doc, from, schema);
      const blockDepth = $from.findDepth((n) => schema.isTextblock(n.type));
      if (blockDepth < 1) {
        tr.replace(from, from, nodesToItems(nodes, schema));
        placeAfterInsert(tr, from, nodes, selectInside);
        return;
      }
      const block = $from.node(blockDepth);
      const blockPos = $from.before(blockDepth);
      const container = $from.node(blockDepth - 1);
      const index = $from.index(blockDepth - 1);
      const empty = contentSize(block, schema) === 0 && block.type === "paragraph";
      const trial = (container.content ?? []).slice();
      trial.splice(empty ? index : index + 1, empty ? 1 : 0, ...nodes);
      if (schema.validContent(container.type, trial)) {
        const at = empty ? blockPos : $from.after(blockDepth);
        tr.replace(at, empty ? $from.after(blockDepth) : at, nodesToItems(nodes, schema));
        placeAfterInsert(tr, at, nodes, selectInside);
        return;
      }
      // The container does not accept these blocks (e.g. a table cell rule); insert at the top level.
      const top = $from.after(1);
      tr.replace(top, top, nodesToItems(nodes, schema));
      placeAfterInsert(tr, top, nodes, selectInside);
    });
  };

const placeAfterInsert = (tr: Transaction, at: number, nodes: Node[], selectInside: boolean) => {
  const schema = tr.schema;
  const first = nodes[0];
  if (!first) return;
  const end = at + nodes.reduce((s, n) => s + nodeSize(n, schema), 0);
  if (selectInside) {
    const inner = textblockStartAfter(tr.doc, at, schema);
    if (inner !== null && inner < end) {
      cursor(tr, inner);
      return;
    }
  }
  if (nodes.length === 1 && schema.isLeaf(first.type)) {
    // Keep typing below a freshly inserted leaf block.
    const $end = $(tr.doc, end, schema);
    const nextBlock = $end.nodeAfter;
    if (!nextBlock || !schema.isTextblock(nextBlock.type)) {
      tr.replace(end, end, nodesToItems([schema.node("paragraph")], schema));
    }
    cursor(tr, end + 1);
    return;
  }
  const next = textblockStartAfter(tr.doc, end, schema);
  cursor(tr, next ?? end);
};

export const insertInline =
  (node: Node): Command =>
  (state, dispatch) => {
    const { schema } = state;
    const $from = $(state.doc, selFrom(state.selection), schema);
    if (!schema.isTextblock($from.parent.type)) return false;
    return run(state, dispatch, (tr) => {
      const from = selFrom(state.selection);
      if (!isEmpty(state.selection)) deleteRangeInto(tr, from, selTo(state.selection));
      const at = tr.mapping.map(from, -1);
      tr.replace(at, at, [{ n: node }]);
      cursor(tr, at + 1);
    });
  };

export const selectAll: Command = (state, dispatch) =>
  run(state, dispatch, (tr) => {
    const size = contentSize(state.doc, state.schema);
    const start = textblockStartAfter(state.doc, 0, state.schema) ?? 0;
    const end = textblockEndBefore(state.doc, size, state.schema) ?? size;
    tr.setSelection({ anchor: start, head: end });
  });

/** Mod-Enter in a code block: leave it, with a paragraph after. */
export const exitCode: Command = (state, dispatch) => {
  const { schema } = state;
  const $from = $(state.doc, selFrom(state.selection), schema);
  if (!schema.nodes[$from.parent.type]?.code) return false;
  return run(state, dispatch, (tr) => {
    const after = $from.after();
    tr.replace(after, after, nodesToItems([schema.node("paragraph")], schema));
    cursor(tr, after + 1);
  });
};

export const chain =
  (...commands: Command[]): Command =>
  (state, dispatch) => {
    for (const command of commands) if (command(state, dispatch)) return true;
    return false;
  };

/** Tab / Shift-Tab on paragraphs and headings outside lists and tables. */
export const indentBlocks =
  (delta: 1 | -1): Command =>
  (state, dispatch) => {
    const { doc, schema, selection } = state;
    const from = selFrom(selection);
    const to = selTo(selection);
    const targets: { pos: number; node: Node }[] = [];
    descendants(doc, schema, (node, pos) => {
      const end = pos + nodeSize(node, schema);
      if (end < from || pos > to) return false;
      if (node.type === "paragraph" || node.type === "heading") {
        targets.push({ pos, node });
        return false;
      }
      // Indentation does not apply inside lists, tables or code.
      return !["listItem", "taskItem", "tableCell", "tableHeader", "codeBlock"].includes(node.type);
    });
    const changes = targets
      .map((t) => ({ ...t, indent: Math.max(0, Math.min(8, (Number(t.node.attrs?.indent) || 0) + delta)) }))
      .filter((t) => t.indent !== (Number(t.node.attrs?.indent) || 0));
    if (!changes.length) return false;
    return run(state, dispatch, (tr) => {
      for (const c of changes) tr.setNodeAttrs(c.pos, { ...c.node.attrs, indent: c.indent });
    });
  };

/** Removes every mark from the selected text. */
export const clearFormatting: Command = (state, dispatch) => {
  if (isEmpty(state.selection)) return run(state, dispatch, (tr) => void tr.setStoredMarks([]));
  return run(state, dispatch, (tr) => {
    const from = selFrom(state.selection);
    const to = selTo(state.selection);
    const found: { from: number; to: number; mark: Mark }[] = [];
    descendants(state.doc, state.schema, (node, pos) => {
      const end = pos + nodeSize(node, state.schema);
      if (end <= from || pos >= to) return false;
      for (const mark of node.marks ?? []) {
        if (mark.type === "comment") continue;
        found.push({ from: Math.max(from, pos), to: Math.min(to, end), mark });
      }
      return true;
    });
    for (const f of found) tr.removeMark(f.from, f.to, f.mark);
    if (!tr.docChanged) return false;
  });
};
