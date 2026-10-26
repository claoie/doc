import { sameAttrs, sameMark, sameMarks, type Attrs, type Mark, type Node } from "./model";
import type { Schema } from "./schema";
import {
  build,
  childOffsets,
  flatten,
  fromItems,
  nodeAt,
  resolve,
  sliceSize,
  toItems,
  type SliceItem,
  type Token,
} from "./tokens";

/**
 * Steps are the unit of change. Every edit — local or remote — is a list of
 * steps, each invertible (for undo) and mappable through concurrent steps
 * (for collaboration). They are plain JSON so they travel over the wire.
 */
export type Step =
  | { stepType: "replace"; from: number; to: number; slice: SliceItem[] }
  | {
      // Replaces [from, to) but keeps [gapFrom, gapTo) in place, inserted at
      // position `insert` of the slice. Used to wrap, unwrap and retype
      // blocks without touching their content, so concurrent typing inside
      // them survives.
      stepType: "replaceAround";
      from: number;
      to: number;
      gapFrom: number;
      gapTo: number;
      slice: SliceItem[];
      insert: number;
    }
  | { stepType: "addMark"; from: number; to: number; mark: Mark }
  | { stepType: "removeMark"; from: number; to: number; mark: Mark }
  | { stepType: "attr"; pos: number; attrs: Attrs };

export class StepError extends Error {}

/** One replaced range: `[start, start + oldSize)` became `newSize` positions. */
type Range = [start: number, oldSize: number, newSize: number];

export interface Recover {
  index: number;
  offset: number;
}

export interface MapResult {
  pos: number;
  /** The position was strictly inside a replaced range. */
  deleted: boolean;
  /** Where inside the replaced range it was, so a mirrored map can restore it. */
  recover?: Recover;
}

export class StepMap {
  static readonly empty = new StepMap([]);
  constructor(readonly ranges: readonly Range[]) {}

  mapResult(pos: number, assoc = 1): MapResult {
    let diff = 0;
    for (let index = 0; index < this.ranges.length; index++) {
      const [start, oldSize, newSize] = this.ranges[index]!;
      if (start > pos) break;
      const end = start + oldSize;
      if (pos <= end) {
        const side = !oldSize ? assoc : pos === start ? -1 : pos === end ? 1 : assoc;
        const deleted = pos !== start && pos !== end;
        const result: MapResult = { pos: start + diff + (side < 0 ? 0 : newSize), deleted };
        if (deleted) result.recover = { index, offset: pos - start };
        return result;
      }
      diff += newSize - oldSize;
    }
    return { pos: pos + diff, deleted: false };
  }

  map(pos: number, assoc = 1) {
    return this.mapResult(pos, assoc).pos;
  }

  /** The position a recovered offset lands on in this map's output. */
  recover({ index, offset }: Recover) {
    let diff = 0;
    for (let i = 0; i < index; i++) diff += this.ranges[i]![2] - this.ranges[i]![1];
    return this.ranges[index]![0] + diff + offset;
  }
}

/**
 * A sequence of step maps. Maps can be marked as mirrors of each other (an
 * undo and its redo during rebasing), so a position inside content that was
 * removed and re-added maps back to the same spot instead of collapsing.
 */
export class Mapping {
  readonly maps: StepMap[];
  private mirrors: number[] = [];

  constructor(maps: StepMap[] = [], mirrors: number[] = []) {
    this.maps = maps;
    this.mirrors = mirrors;
  }

  append(map: StepMap, mirror?: number) {
    this.maps.push(map);
    if (mirror !== undefined) this.setMirror(this.maps.length - 1, mirror);
  }

  appendMapping(mapping: Mapping) {
    const base = this.maps.length;
    for (let i = 0; i < mapping.maps.length; i++) {
      const mirror = mapping.getMirror(i);
      this.append(mapping.maps[i]!, mirror !== undefined && mirror < i ? base + mirror : undefined);
    }
  }

  setMirror(a: number, b: number) {
    this.mirrors.push(a, b);
  }

  getMirror(n: number): number | undefined {
    for (let i = 0; i < this.mirrors.length; i += 2) {
      if (this.mirrors[i] === n) return this.mirrors[i + 1];
      if (this.mirrors[i + 1] === n) return this.mirrors[i];
    }
    return undefined;
  }

  mapResult(pos: number, assoc = 1): MapResult {
    let deleted = false;
    for (let i = 0; i < this.maps.length; i++) {
      const result = this.maps[i]!.mapResult(pos, assoc);
      if (result.recover) {
        const mirror = this.getMirror(i);
        if (mirror !== undefined && mirror > i) {
          i = mirror;
          pos = this.maps[mirror]!.recover(result.recover);
          continue;
        }
      }
      deleted ||= result.deleted;
      pos = result.pos;
    }
    return { pos, deleted };
  }

  map(pos: number, assoc = 1) {
    return this.mapResult(pos, assoc).pos;
  }

  /** Maps from index `from` onward; mirrors are re-indexed. */
  slice(from = 0) {
    const mirrors: number[] = [];
    for (let i = 0; i < this.mirrors.length; i += 2) {
      const a = this.mirrors[i]! - from;
      const b = this.mirrors[i + 1]! - from;
      if (a >= 0 && b >= 0) mirrors.push(a, b);
    }
    return new Mapping(this.maps.slice(from), mirrors);
  }
}

export const stepMap = (step: Step): StepMap => {
  switch (step.stepType) {
    case "replace":
      return new StepMap([[step.from, step.to - step.from, sliceSize(step.slice)]]);
    case "replaceAround":
      return new StepMap([
        [step.from, step.gapFrom - step.from, step.insert],
        [step.gapTo, step.to - step.gapTo, sliceSize(step.slice) - step.insert],
      ]);
    default:
      return StepMap.empty;
  }
};

export interface StepResult {
  doc: Node;
  inverse: Step;
  map: StepMap;
}

const markRank = (schema: Schema) => {
  const names = Object.keys(schema.marks);
  return (type: string) => {
    const i = names.indexOf(type);
    return i < 0 ? names.length : i;
  };
};

export const addToMarkSet = (marks: readonly Mark[] | undefined, mark: Mark, schema: Schema) => {
  const stackable = schema.marks[mark.type]?.stackable;
  const kept = (marks ?? []).filter((m) =>
    stackable ? !sameMark(m, mark) : m.type !== mark.type,
  );
  const rank = markRank(schema);
  const next = [...kept, mark];
  next.sort((a, b) => rank(a.type) - rank(b.type));
  return next;
};

export const removeFromMarkSet = (marks: readonly Mark[] | undefined, mark: Mark) =>
  (marks ?? []).filter((m) => !sameMark(m, mark));

/** Replaces `node`'s child chain along `path` with `replacement` at the bottom. */
const replaceAlong = (nodes: Node[], indices: number[], depth: number, replacement: Node): Node => {
  let current = replacement;
  for (let d = depth - 1; d >= 0; d--) {
    const parent = nodes[d]!;
    const content = (parent.content ?? []).slice();
    content[indices[d]!] = current;
    current = { ...parent, content };
  }
  return current;
};

const mergeSeams = (children: Node[], seams: number[]): Node[] => {
  const result = children.slice();
  for (const seam of seams.sort((a, b) => b - a)) {
    const left = result[seam - 1];
    const right = result[seam];
    if (!left || !right || left.type !== "text" || right.type !== "text") continue;
    if (!sameMarks(left.marks, right.marks)) continue;
    result.splice(seam - 1, 2, { ...left, text: (left.text ?? "") + (right.text ?? "") });
  }
  return result;
};

/**
 * Splices the token stream in [from, to) with `make(removed)`, operating on
 * the smallest balanced subtree. Returns the new doc and removed tokens.
 */
const splice = (
  doc: Node,
  from: number,
  to: number,
  schema: Schema,
  make: (segment: Token[], a: number, b: number) => Token[],
): { doc: Node; removed: Token[] } => {
  if (from > to) throw new StepError(`Invalid range ${from}..${to}`);
  const $from = resolve(doc, from, schema);
  const $to = resolve(doc, to, schema);
  let shared = 0;
  while (
    shared < $from.depth &&
    shared < $to.depth &&
    $from.nodes[shared + 1] === $to.nodes[shared + 1]
  ) {
    shared++;
  }
  for (let d = shared; d >= 0; d--) {
    const container = $from.nodes[d]!;
    const start = $from.starts[d]!;
    const children = container.content ?? [];
    const offsets = childOffsets(container, schema);
    const localFrom = from - start;
    const localTo = to - start;
    let i = 0;
    while (i < children.length && offsets[i + 1]! <= localFrom) i++;
    let j = i;
    while (j < children.length && offsets[j]! < localTo) j++;
    const segStart = offsets[i]!;
    const segment = flatten(children.slice(i, j), container.type, schema);
    const a = localFrom - segStart;
    const b = localTo - segStart;
    const replaced = make(segment, a, b);
    const built = build(replaced);
    if (!built) continue;
    const merged = mergeSeams(
      [...children.slice(0, i), ...built, ...children.slice(j)],
      [i, i + built.length],
    );
    if (!schema.validContent(container.type, merged)) {
      throw new StepError(`Invalid content for ${container.type}`);
    }
    for (const node of built) {
      if (schema.check(node)) throw new StepError(`Invalid ${node.type} after edit`);
      for (const mark of node.marks ?? []) {
        if (!schema.allowsMark(container.type, mark.type)) {
          throw new StepError(`Mark ${mark.type} not allowed in ${container.type}`);
        }
      }
    }
    const replacement = { ...container, content: merged };
    return {
      doc: d === 0 ? replacement : replaceAlong($from.nodes, $from.indices, d, replacement),
      removed: segment.slice(a, b),
    };
  }
  throw new StepError(`Unbalanced edit at ${from}..${to}`);
};

const applyReplace = (doc: Node, step: Extract<Step, { stepType: "replace" }>, schema: Schema) => {
  const inserted = fromItems(step.slice);
  const { doc: next, removed } = splice(doc, step.from, step.to, schema, (seg, a, b) => [
    ...seg.slice(0, a),
    ...inserted,
    ...seg.slice(b),
  ]);
  const inverse: Step = {
    stepType: "replace",
    from: step.from,
    to: step.from + inserted.length,
    slice: toItems(removed),
  };
  return { doc: next, inverse, map: stepMap(step) };
};

const applyReplaceAround = (
  doc: Node,
  step: Extract<Step, { stepType: "replaceAround" }>,
  schema: Schema,
) => {
  const { from, to, gapFrom, gapTo, insert } = step;
  if (gapFrom < from || gapTo > to || gapFrom > gapTo) throw new StepError("Invalid gap");
  const inserted = fromItems(step.slice);
  if (insert < 0 || insert > inserted.length) throw new StepError("Invalid insert offset");
  let gapSize = 0;
  const { doc: next, removed } = splice(doc, from, to, schema, (seg, a, b) => {
    const gap = seg.slice(a + gapFrom - from, a + gapTo - from);
    gapSize = gap.length;
    return [
      ...seg.slice(0, a),
      ...inserted.slice(0, insert),
      ...gap,
      ...inserted.slice(insert),
      ...seg.slice(b),
    ];
  });
  const before = removed.slice(0, gapFrom - from);
  const after = removed.slice(gapTo - from);
  const inverse: Step = {
    stepType: "replaceAround",
    from,
    to: from + inserted.length + gapSize,
    gapFrom: from + insert,
    gapTo: from + insert + gapSize,
    slice: toItems([...before, ...after]),
    insert: gapFrom - from,
  };
  return { doc: next, inverse, map: stepMap(step) };
};

const applyMark = (
  doc: Node,
  step: Extract<Step, { stepType: "addMark" | "removeMark" }>,
  schema: Schema,
) => {
  const add = step.stepType === "addMark";
  if (!schema.marks[step.mark.type]) throw new StepError(`Unknown mark ${step.mark.type}`);
  const { doc: next } = splice(doc, step.from, step.to, schema, (seg, a, b) =>
    seg.map((token, i) => {
      if (i < a || i >= b) return token;
      if (token.kind === "char" || token.kind === "leaf") {
        if (!schema.allowsMark(token.parent, step.mark.type)) return token;
        const current = token.kind === "char" ? token.marks : token.node.marks;
        const marks = add
          ? addToMarkSet(current, step.mark, schema)
          : removeFromMarkSet(current, step.mark);
        if (token.kind === "char") {
          const { marks: _old, ...rest } = token;
          return marks.length ? { ...rest, marks } : rest;
        }
        const { marks: _old, ...node } = token.node;
        return { ...token, node: marks.length ? { ...node, marks } : node };
      }
      return token;
    }),
  );
  const inverse: Step = { ...step, stepType: add ? "removeMark" : "addMark" };
  return { doc: next, inverse, map: StepMap.empty };
};

const applyAttr = (doc: Node, step: Extract<Step, { stepType: "attr" }>, schema: Schema) => {
  const found = nodeAt(doc, step.pos, schema);
  if (!found || found.node.type === "text") throw new StepError(`No node at ${step.pos}`);
  const $pos = resolve(doc, step.pos, schema);
  const old = found.node.attrs ?? {};
  const replacement: Node = { ...found.node, attrs: step.attrs };
  const content = (found.parent.content ?? []).slice();
  content[found.index] = replacement;
  const parent = { ...found.parent, content };
  const next =
    $pos.depth === 0 ? parent : replaceAlong($pos.nodes, $pos.indices, $pos.depth, parent);
  const inverse: Step = { stepType: "attr", pos: step.pos, attrs: old };
  return { doc: next, inverse, map: StepMap.empty };
};

export const applyStep = (doc: Node, step: Step, schema: Schema): StepResult => {
  switch (step.stepType) {
    case "replace":
      return applyReplace(doc, step, schema);
    case "replaceAround":
      return applyReplaceAround(doc, step, schema);
    case "addMark":
    case "removeMark":
      return applyMark(doc, step, schema);
    case "attr":
      return applyAttr(doc, step, schema);
  }
};

/** Maps a step through concurrent changes; null when its target was deleted. */
export const mapStep = (step: Step, mapping: Mapping): Step | null => {
  switch (step.stepType) {
    case "replace": {
      const from = mapping.mapResult(step.from, 1);
      const to = mapping.mapResult(step.to, -1);
      if (from.deleted && to.deleted && step.from !== step.to) return null;
      return { ...step, from: from.pos, to: Math.max(from.pos, to.pos) };
    }
    case "replaceAround": {
      const from = mapping.mapResult(step.from, 1);
      const to = mapping.mapResult(step.to, -1);
      if (from.deleted && to.deleted) return null;
      const gapFrom = mapping.map(step.gapFrom, -1);
      const gapTo = mapping.map(step.gapTo, 1);
      if (gapFrom < from.pos || gapTo > to.pos || gapFrom > gapTo) return null;
      return { ...step, from: from.pos, to: to.pos, gapFrom, gapTo };
    }
    case "addMark":
    case "removeMark": {
      const from = mapping.mapResult(step.from, 1);
      const to = mapping.mapResult(step.to, -1);
      if ((from.deleted && to.deleted) || from.pos >= to.pos) return null;
      return { ...step, from: from.pos, to: to.pos };
    }
    case "attr": {
      const pos = mapping.mapResult(step.pos, 1);
      if (pos.deleted) return null;
      return { ...step, pos: pos.pos };
    }
  }
};

export const stepsEqual = (a: Step, b: Step) => JSON.stringify(a) === JSON.stringify(b);

export const attrsChanged = (node: Node, attrs: Attrs) => !sameAttrs(node.attrs, attrs);
