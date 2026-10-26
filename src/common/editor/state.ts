import type { Mark, Node } from "./model";
import type { Schema } from "./schema";
import { applyStep, Mapping, StepError, type Step } from "./steps";
import { contentSize, nodeAt, nodeSize, sliceSize, type SliceItem } from "./tokens";

/**
 * A text selection spans `anchor`..`head`. A node selection (`node: true`)
 * selects the single node starting at `anchor`, ending at `head`.
 */
export interface Selection {
  anchor: number;
  head: number;
  node?: boolean;
}

export const selFrom = (sel: Selection) => Math.min(sel.anchor, sel.head);
export const selTo = (sel: Selection) => Math.max(sel.anchor, sel.head);
export const isEmpty = (sel: Selection) => sel.anchor === sel.head;

export const mapSelection = (sel: Selection, mapping: Mapping): Selection => {
  if (sel.node) {
    const anchor = mapping.mapResult(sel.anchor, 1);
    const head = mapping.mapResult(sel.head, -1);
    if (!anchor.deleted && head.pos > anchor.pos) return { anchor: anchor.pos, head: head.pos, node: true };
    return { anchor: anchor.pos, head: anchor.pos };
  }
  return { anchor: mapping.map(sel.anchor, 1), head: mapping.map(sel.head, 1) };
};

export interface EditorState {
  schema: Schema;
  doc: Node;
  selection: Selection;
  /** Marks applied to the next typed text, when set explicitly. */
  storedMarks: Mark[] | null;
}

export const createState = (schema: Schema, doc: Node, selection?: Selection): EditorState => ({
  schema,
  doc,
  selection: selection ?? { anchor: 1, head: 1 },
  storedMarks: null,
});

export class Transaction {
  readonly schema: Schema;
  readonly before: Node;
  doc: Node;
  readonly steps: Step[] = [];
  readonly inverses: Step[] = [];
  readonly docs: Node[] = [];
  readonly mapping = new Mapping();
  selection: Selection;
  selectionSet = false;
  storedMarks: Mark[] | null;
  storedMarksSet = false;
  readonly meta = new Map<string, unknown>();
  scrollIntoView = false;

  constructor(state: EditorState) {
    this.schema = state.schema;
    this.before = state.doc;
    this.doc = state.doc;
    this.selection = state.selection;
    this.storedMarks = state.storedMarks;
  }

  get docChanged() {
    return this.steps.length > 0;
  }

  /** Applies a step; throws StepError when it does not fit. */
  step(step: Step, mirror?: number) {
    const result = applyStep(this.doc, step, this.schema);
    this.docs.push(this.doc);
    this.steps.push(step);
    this.inverses.push(result.inverse);
    this.mapping.append(result.map, mirror);
    this.doc = result.doc;
    return this;
  }

  /** Applies a step if it fits; returns whether it did. */
  maybeStep(step: Step, mirror?: number) {
    try {
      this.step(step, mirror);
      return true;
    } catch (e) {
      if (e instanceof StepError || e instanceof RangeError) return false;
      throw e;
    }
  }

  replace(from: number, to: number, slice: SliceItem[] = []) {
    if (from === to && !slice.length) return this;
    return this.step({ stepType: "replace", from, to, slice });
  }

  delete(from: number, to: number) {
    return this.replace(from, to, []);
  }

  insertText(text: string, from: number, to = from, marks?: Mark[] | null) {
    const slice: SliceItem[] = text ? [marks?.length ? { t: text, m: marks } : { t: text }] : [];
    return this.replace(from, to, slice);
  }

  addMark(from: number, to: number, mark: Mark) {
    return this.step({ stepType: "addMark", from, to, mark });
  }

  removeMark(from: number, to: number, mark: Mark) {
    return this.step({ stepType: "removeMark", from, to, mark });
  }

  setNodeAttrs(pos: number, attrs: Record<string, unknown>) {
    return this.step({ stepType: "attr", pos, attrs });
  }

  setSelection(selection: Selection) {
    const size = contentSize(this.doc, this.schema);
    const clamp = (n: number) => Math.max(0, Math.min(size, n));
    this.selection = { ...selection, anchor: clamp(selection.anchor), head: clamp(selection.head) };
    this.selectionSet = true;
    this.storedMarks = null;
    return this;
  }

  setStoredMarks(marks: Mark[] | null) {
    this.storedMarks = marks;
    this.storedMarksSet = true;
    return this;
  }

  setMeta(key: string, value: unknown) {
    this.meta.set(key, value);
    return this;
  }

  getMeta<T>(key: string): T | undefined {
    return this.meta.get(key) as T | undefined;
  }

  scroll() {
    this.scrollIntoView = true;
    return this;
  }

  /** Size of a slice, convenient for computing cursor targets. */
  static sliceSize = sliceSize;
}

export const applyTransaction = (state: EditorState, tr: Transaction): EditorState => {
  let selection = tr.selectionSet ? tr.selection : mapSelection(state.selection, tr.mapping);
  if (selection.node) {
    const found = nodeAt(tr.doc, selection.anchor, state.schema);
    if (!found || selection.head !== selection.anchor + nodeSize(found.node, state.schema)) {
      selection = { anchor: selection.anchor, head: selection.anchor };
    }
  }
  let storedMarks = state.storedMarks;
  if (tr.storedMarksSet) storedMarks = tr.storedMarks;
  else if (tr.docChanged || tr.selectionSet) storedMarks = null;
  return { ...state, doc: tr.doc, selection, storedMarks };
};
