import { sameAttrs, sameMarks, type Mark, type Node } from "common/editor/model";
import type { Schema } from "common/editor/schema";
import { applyTransaction, Transaction, type EditorState, type Selection } from "common/editor/state";
import { nodeSize } from "common/editor/tokens";
import { Desc, type MarkRenderer, type NodeRenderer, type NodeViewFactory } from "./desc";

export interface ViewProps {
  state: EditorState;
  nodes: Record<string, NodeRenderer>;
  marks: Record<string, MarkRenderer>;
  nodeViews?: Record<string, NodeViewFactory>;
  /** Called with every transaction; the owner applies it and calls `updateState`. */
  dispatch?: (tr: Transaction) => void;
  editable?: boolean;
  /** Return true to stop the editor's own handling. */
  handleKeyDown?: (view: EditorView, event: KeyboardEvent) => boolean;
  handleBeforeInput?: (view: EditorView, event: InputEvent) => boolean;
  handlePaste?: (view: EditorView, event: ClipboardEvent) => boolean;
  handleDrop?: (view: EditorView, event: DragEvent) => boolean;
  handleClick?: (view: EditorView, pos: number, event: MouseEvent) => boolean;
  onFocusChange?: (view: EditorView, focused: boolean) => void;
  /** Attributes to set on rendered nodes (placeholders, highlights). */
  nodeAttrs?: (state: EditorState) => Map<number, Record<string, string>>;
}

const FILLER = "data-filler";

export class EditorView {
  readonly dom: HTMLElement;
  state: EditorState;
  props: ViewProps;
  readonly schema: Schema;
  private root: Desc;
  private textDescs = new WeakMap<globalThis.Node, Desc>();
  private domDescs = new WeakMap<globalThis.Node, Desc>();
  private contentDescs = new WeakMap<globalThis.Node, Desc>();
  private observer: MutationObserver;
  composing = false;
  private composingDesc: Desc | null = null;
  private afterComposition: (() => void)[] = [];
  private selectionReading = false;
  private appliedAttrs: { el: HTMLElement; names: string[] }[] = [];
  focused = false;
  destroyed = false;

  constructor(mount: HTMLElement, props: ViewProps) {
    this.props = props;
    this.state = props.state;
    this.schema = props.state.schema;
    this.dom = mount;
    this.dom.classList.add("editor");
    this.dom.setAttribute("contenteditable", props.editable === false ? "false" : "true");
    this.dom.setAttribute("spellcheck", "true");
    this.dom.setAttribute("translate", "no");
    this.root = new Desc(this.state.doc, this.dom, this.dom, null, null, null);
    this.contentDescs.set(this.dom, this.root);
    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.renderChildren(this.root, this.state.doc);
    this.applyNodeAttrs();
    this.startObserving();
    this.bindEvents();
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  dispatch(tr: Transaction) {
    if (this.props.dispatch) this.props.dispatch(tr);
    else this.updateState(applyTransaction(this.state, tr));
  }

  updateState(state: EditorState) {
    const prev = this.state;
    this.state = state;
    if (prev.doc !== state.doc) {
      this.stopObserving();
      this.renderChildren(this.root, state.doc);
      this.startObserving();
    }
    this.applyNodeAttrs();
    this.syncNodeSelection(prev.selection, state.selection);
    if (this.focused && !this.composing) this.writeSelection();
  }

  /**
   * Runs `fn` now, or once the current IME composition is committed. Remote
   * changes wait so they are rebased over the composed text, not under it.
   */
  whenNotComposing(fn: () => void) {
    if (this.isComposing) this.afterComposition.push(fn);
    else fn();
  }

  /** True from compositionstart until the composed text is in the model. */
  get isComposing() {
    return this.composing || this.compositionTimer !== null;
  }

  setEditable(editable: boolean) {
    if (this.props.editable === editable) return;
    this.props.editable = editable;
    this.dom.setAttribute("contenteditable", editable ? "true" : "false");
    // Node views read editability when they update; give them the chance.
    const refresh = (desc: Desc) => {
      desc.view?.update?.(desc.node);
      desc.children.forEach(refresh);
    };
    this.root.children.forEach(refresh);
  }

  get editable() {
    return this.props.editable !== false;
  }

  focus() {
    this.dom.focus({ preventScroll: true });
    this.writeSelection();
  }

  destroy() {
    this.destroyed = true;
    if (this.compositionTimer !== null) clearTimeout(this.compositionTimer);
    this.compositionTimer = null;
    this.afterComposition = [];
    this.observer.disconnect();
    this.root.destroy();
    this.unbind();
    this.dom.textContent = "";
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private createDesc(node: Node, parent: Desc): Desc {
    const register = (desc: Desc) => {
      this.domDescs.set(desc.dom, desc);
      if (desc.contentDOM) this.contentDescs.set(desc.contentDOM, desc);
      if (desc.textDOM) this.textDescs.set(desc.textDOM, desc);
      return desc;
    };
    if (node.type === "text") {
      const text = document.createTextNode(node.text ?? "");
      let outer: globalThis.Node = text;
      const marks = node.marks ?? [];
      for (let i = marks.length - 1; i >= 0; i--) {
        const spec = this.renderMark(marks[i]!);
        (spec.contentDOM ?? spec.dom).appendChild(outer);
        outer = spec.dom;
      }
      return register(new Desc(node, outer, null, text, parent, null));
    }
    const factory = this.props.nodeViews?.[node.type];
    if (factory) {
      let desc: Desc | null = null;
      const view = factory(node, () => (desc ? this.posOf(desc) : 0), {
        schema: this.schema,
        dispatchAttrs: (attrs) => {
          if (!desc) return;
          const tr = new Transaction(this.state);
          tr.setNodeAttrs(this.posOf(desc), { ...desc.node.attrs, ...attrs });
          this.dispatch(tr);
        },
      });
      view.dom.setAttribute("data-node", node.type);
      desc = new Desc(node, view.dom, view.contentDOM ?? null, null, parent, view);
      register(desc);
      if (desc.contentDOM) this.renderChildren(desc, node);
      return desc;
    }
    const renderer = this.props.nodes[node.type];
    let spec = renderer?.(node);
    if (!spec) {
      // Unknown node types still render so foreign content is not lost.
      const dom = document.createElement(this.schema.isInline(node.type) ? "span" : "div");
      dom.className = "unknown-node";
      spec = this.schema.isLeaf(node.type) ? { dom } : { dom, contentDOM: dom };
    }
    if (this.schema.isLeaf(node.type)) spec.dom.setAttribute("contenteditable", "false");
    spec.dom.setAttribute("data-node", node.type);
    let dom: globalThis.Node = spec.dom;
    for (const mark of node.marks ?? []) {
      const m = this.renderMark(mark);
      (m.contentDOM ?? m.dom).appendChild(dom);
      dom = m.dom;
    }
    const desc = register(new Desc(node, dom, spec.contentDOM ?? null, null, parent, null));
    if (desc.contentDOM) this.renderChildren(desc, node);
    return desc;
  }

  private renderMark(mark: Mark) {
    const renderer = this.props.marks[mark.type];
    if (renderer) return renderer(mark);
    const dom = document.createElement("span");
    return { dom };
  }

  private canUpdate(desc: Desc, node: Node): boolean {
    if (desc.node.type !== node.type) return false;
    if (node.type === "text") return sameMarks(desc.node.marks, node.marks);
    if (!sameMarks(desc.node.marks, node.marks)) return false;
    if (desc.view) return desc.view.update ? desc.view.update(node) : false;
    return sameAttrs(desc.node.attrs, node.attrs);
  }

  private updateDesc(desc: Desc, node: Node) {
    if (desc.node === node) return;
    if (desc.textDOM) {
      if (desc.textDOM.data !== node.text) desc.textDOM.data = node.text ?? "";
    } else if (desc.contentDOM) {
      this.renderChildren(desc, node);
    }
    desc.node = node;
  }

  private renderChildren(desc: Desc, node: Node) {
    const contentDOM = desc.contentDOM!;
    const old = desc.children;
    const used = new Set<Desc>();
    const next: Desc[] = [];
    let cursor = 0;
    for (const child of node.content ?? []) {
      let match: Desc | null = null;
      for (let k = cursor; k < Math.min(old.length, cursor + 8); k++) {
        if (old[k]!.node === child && !used.has(old[k]!)) {
          match = old[k]!;
          cursor = k + 1;
          break;
        }
      }
      if (!match && cursor < old.length && !used.has(old[cursor]!)) {
        const candidate = old[cursor]!;
        const protectedDesc = this.composing && this.composingDesc && isAncestor(candidate, this.composingDesc);
        if (protectedDesc || this.canUpdate(candidate, child)) {
          this.updateDesc(candidate, child);
          match = candidate;
          cursor++;
        }
      }
      if (match) {
        used.add(match);
        match.node = child;
        next.push(match);
      } else {
        next.push(this.createDesc(child, desc));
      }
    }
    for (const d of old) if (!used.has(d)) d.destroy();
    desc.children = next;
    desc.node = node;

    const wanted: globalThis.Node[] = next.map((d) => d.dom);
    const needsFiller =
      this.schema.isTextblock(node.type) &&
      (next.length === 0 || next[next.length - 1]!.node.type === "hardBreak");
    let filler = Array.from(contentDOM.childNodes).find(
      (n) => n instanceof HTMLElement && n.hasAttribute(FILLER),
    );
    if (needsFiller) {
      if (!filler) {
        filler = document.createElement("br");
        (filler as HTMLElement).setAttribute(FILLER, "");
      }
      wanted.push(filler);
    }
    let current = contentDOM.firstChild;
    for (const dom of wanted) {
      if (current === dom) {
        current = current.nextSibling;
      } else {
        contentDOM.insertBefore(dom, current);
      }
    }
    while (current) {
      const after = current.nextSibling;
      contentDOM.removeChild(current);
      current = after;
    }
  }

  /** Re-evaluates node attributes (placeholders) without a state change. */
  refreshAttrs() {
    this.applyNodeAttrs();
  }

  private applyNodeAttrs() {
    for (const { el, names } of this.appliedAttrs) for (const n of names) el.removeAttribute(n);
    this.appliedAttrs = [];
    const attrs = this.props.nodeAttrs?.(this.state);
    if (!attrs) return;
    for (const [pos, values] of attrs) {
      const desc = this.descAt(pos);
      const el = desc && (desc.view?.dom ?? desc.contentDOM ?? desc.dom);
      if (!(el instanceof HTMLElement)) continue;
      for (const [k, v] of Object.entries(values)) el.setAttribute(k, v);
      this.appliedAttrs.push({ el, names: Object.keys(values) });
    }
  }

  private selectedDesc: Desc | null = null;

  private syncNodeSelection(_prev: Selection, sel: Selection) {
    const desc = sel.node ? this.descAt(sel.anchor) : null;
    if (desc === this.selectedDesc) return;
    if (this.selectedDesc) {
      this.selectedDesc.view?.deselectNode?.();
      (this.selectedDesc.dom as HTMLElement).classList?.remove("node-selected");
    }
    this.selectedDesc = desc;
    if (desc) {
      desc.view?.selectNode?.();
      (desc.dom as HTMLElement).classList?.add("node-selected");
    }
  }

  // -------------------------------------------------------------------------
  // Positions
  // -------------------------------------------------------------------------

  /** Position just before the node of `desc`. */
  posOf(desc: Desc): number {
    if (!desc.parent) return -1;
    let pos = this.contentStart(desc.parent);
    for (const sibling of desc.parent.children) {
      if (sibling === desc) return pos;
      pos += sibling.size(this.schema);
    }
    return pos;
  }

  private contentStart(desc: Desc): number {
    return desc.parent ? this.posOf(desc) + 1 : 0;
  }

  /** The descriptor of the node starting at `pos`. */
  descAt(pos: number): Desc | null {
    let desc = this.root;
    let start = 0;
    for (;;) {
      let offset = start;
      let next: Desc | null = null;
      for (const child of desc.children) {
        const size = child.size(this.schema);
        if (offset === pos) return child;
        if (pos > offset && pos < offset + size && child.children.length) {
          next = child;
          start = offset + 1;
          break;
        }
        offset += size;
      }
      if (!next) return null;
      desc = next;
    }
  }

  /** The DOM node rendered for the node starting at `pos`. */
  nodeDOM(pos: number): HTMLElement | null {
    const desc = this.descAt(pos);
    const dom = desc?.view?.dom ?? desc?.dom;
    return dom instanceof HTMLElement ? dom : null;
  }

  posFromDOM(dom: globalThis.Node, offset: number): number | null {
    if (dom.nodeType === 3 && !this.textDescs.has(dom)) {
      // A point inside a leaf node's own rendering (an inline atom like a
      // status badge) resolves to just before or after that node.
      const leaf = this.nearestDesc(dom);
      if (leaf && !leaf.isText && !leaf.contentDOM && leaf.parent) {
        return this.posOf(leaf) + (offset > 0 ? leaf.size(this.schema) : 0);
      }
      // Text the browser inserted itself (IME, spellcheck) is not tracked yet;
      // measure it against the surrounding content.
      const block = this.nearestContentDesc(dom);
      if (block) return this.contentStart(block) + this.measureWithin(block.contentDOM!, dom, offset);
    }
    let node: globalThis.Node | null = dom;
    let off = offset;
    while (node) {
      const text = this.textDescs.get(node);
      if (text) return this.posOf(text) + Math.min(off, text.textDOM!.length);
      const content = this.contentDescs.get(node);
      if (content) {
        let pos = this.contentStart(content);
        const kids = node.childNodes;
        for (let i = 0; i < off && i < kids.length; i++) {
          const kid = kids[i]!;
          const d = this.domDescs.get(kid);
          if (d && d.parent === content) pos += d.size(this.schema);
          else if (!(kid instanceof HTMLElement && kid.hasAttribute(FILLER))) pos += this.untrackedLength(kid);
        }
        return pos;
      }
      const owner = this.domDescs.get(node);
      if (owner) {
        const size = owner.size(this.schema);
        if (owner.contentDOM && !owner.textDOM) {
          // A point inside a wrapper whose content lives deeper: before or after.
          const contentIndex = indexWithin(node, owner.contentDOM);
          return this.posOf(owner) + (off <= contentIndex ? 1 : size - 1);
        }
        return this.posOf(owner) + (off > 0 ? size : 0);
      }
      const parent: globalThis.Node | null = node.parentNode;
      if (!parent || node === this.dom) return null;
      const index = Array.prototype.indexOf.call(parent.childNodes, node);
      const isEnd = node.nodeType === 3 ? off > 0 : off > 0 && off >= node.childNodes.length;
      off = index + (isEnd ? 1 : 0);
      node = parent;
    }
    return null;
  }

  private nearestContentDesc(node: globalThis.Node): Desc | null {
    let n: globalThis.Node | null = node.parentNode;
    while (n && n !== this.dom.parentNode) {
      const d = this.contentDescs.get(n);
      if (d) return d;
      n = n.parentNode;
    }
    return null;
  }

  private untrackedLength(node: globalThis.Node): number {
    if (node.nodeType === 3) return (node as Text).length;
    if (node instanceof HTMLBRElement) return 0;
    let total = 0;
    for (const child of Array.from(node.childNodes)) {
      const d = this.textDescs.get(child) ?? this.domDescs.get(child);
      total += d ? d.size(this.schema) : this.untrackedLength(child);
    }
    return total;
  }

  /** Offset of (target, offset) from the start of `container`'s content. */
  private measureWithin(container: globalThis.Node, target: globalThis.Node, offset: number): number {
    let acc = 0;
    for (const child of Array.from(container.childNodes)) {
      if (child === target) return acc + offset;
      if (child.contains(target)) {
        const d = this.domDescs.get(child);
        if (d?.textDOM && d.textDOM === target) return acc + offset;
        return acc + this.measureWithin(child, target, offset);
      }
      const d = this.textDescs.get(child) ?? this.domDescs.get(child);
      if (child instanceof HTMLElement && child.hasAttribute(FILLER)) continue;
      acc += d ? d.size(this.schema) : this.untrackedLength(child);
    }
    return acc;
  }

  domFromPos(pos: number): { node: globalThis.Node; offset: number } {
    let desc = this.root;
    let start = 0;
    for (;;) {
      let offset = start;
      let index = 0;
      let inside: Desc | null = null;
      for (; index < desc.children.length; index++) {
        const child = desc.children[index]!;
        const size = child.size(this.schema);
        const end = offset + size;
        if (child.isText && pos >= offset && pos <= end && (pos < end || pos > offset)) {
          return { node: child.textDOM!, offset: pos - offset };
        }
        if (pos < end) {
          if (pos > offset && child.contentDOM) {
            inside = child;
            start = offset + 1;
          }
          break;
        }
        offset = end;
      }
      if (inside) {
        desc = inside;
        continue;
      }
      const contentDOM = desc.contentDOM!;
      const before = desc.children[index - 1];
      if (before?.isText) return { node: before.textDOM!, offset: before.textDOM!.length };
      const after = desc.children[index];
      if (after?.isText) return { node: after.textDOM!, offset: 0 };
      const domIndex = after ? indexWithin(after.dom, contentDOM) : fillerIndex(contentDOM);
      return { node: contentDOM, offset: domIndex };
    }
  }

  /** Screen rectangle of a position, for menus and remote cursors. */
  coordsAtPos(pos: number): DOMRect | null {
    const { node, offset } = this.domFromPos(pos);
    const range = document.createRange();
    try {
      range.setStart(node, offset);
      range.setEnd(node, offset);
    } catch {
      return null;
    }
    const rects = range.getClientRects();
    if (rects.length) return rects[rects.length - 1]!;
    const target = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!target) return null;
    const child = node.nodeType === 1 ? (node as Element).childNodes[offset] : null;
    const el = child instanceof Element ? child : target;
    const r = el.getBoundingClientRect();
    return new DOMRect(r.left, r.top, 0, r.height || 18);
  }

  posAtCoords(x: number, y: number): number | null {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: globalThis.Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      if (p && this.dom.contains(p.offsetNode)) return this.posFromDOM(p.offsetNode, p.offset);
    } else if (doc.caretRangeFromPoint) {
      const r = doc.caretRangeFromPoint(x, y);
      if (r && this.dom.contains(r.startContainer)) return this.posFromDOM(r.startContainer, r.startOffset);
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  readSelection(): Selection | null {
    const sel = document.getSelection();
    if (!sel || !sel.anchorNode || !sel.focusNode) return null;
    if (!this.dom.contains(sel.anchorNode) || !this.dom.contains(sel.focusNode)) return null;
    const anchor = this.posFromDOM(sel.anchorNode, sel.anchorOffset);
    const head = this.posFromDOM(sel.focusNode, sel.focusOffset);
    if (anchor === null || head === null) return null;
    return { anchor, head };
  }

  writeSelection() {
    if (this.destroyed) return;
    const sel = this.state.selection;
    const domSel = document.getSelection();
    if (!domSel) return;
    if (sel.node) {
      // Keep the caret out of the way; the node renders its own highlight.
      const dom = this.nodeDOM(sel.anchor);
      if (dom && dom.parentNode) {
        this.selectionReading = true;
        const range = document.createRange();
        range.selectNode(dom);
        domSel.removeAllRanges();
        domSel.addRange(range);
        this.selectionReading = false;
      }
      return;
    }
    const current = this.readSelection();
    if (current && current.anchor === sel.anchor && current.head === sel.head) return;
    const anchor = this.domFromPos(sel.anchor);
    const head = this.domFromPos(sel.head);
    this.selectionReading = true;
    try {
      domSel.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
    } catch {
      // A position can briefly point at DOM that is mid-update; ignore.
    }
    this.selectionReading = false;
  }

  private onSelectionChange = () => {
    if (this.selectionReading || this.composing || !this.focused) return;
    const sel = this.readSelection();
    if (!sel) return;
    const current = this.state.selection;
    if (current.node && sel.anchor === current.anchor) return;
    if (sel.anchor === current.anchor && sel.head === current.head && !current.node) return;
    const tr = new Transaction(this.state);
    tr.setSelection(sel);
    tr.setMeta("pointer", true);
    this.dispatch(tr);
  };

  // -------------------------------------------------------------------------
  // DOM observation (fallback for edits the browser made on its own)
  // -------------------------------------------------------------------------

  private startObserving() {
    this.observer.observe(this.dom, {
      childList: true,
      characterData: true,
      subtree: true,
      characterDataOldValue: true,
    });
  }

  private stopObserving() {
    this.flushMutations();
    this.observer.disconnect();
  }

  private flushMutations() {
    const records = this.observer.takeRecords();
    if (records.length) this.onMutations(records);
  }

  private onMutations(records: MutationRecord[]) {
    if (this.composing) return;
    const blocks = new Set<Desc>();
    const containers = new Set<Desc>();
    for (const record of records) {
      const desc = this.nearestDesc(record.target);
      if (desc?.view?.ignoreMutation?.(record)) continue;
      if (record.type === "childList") {
        const onlyFiller = [...record.addedNodes, ...record.removedNodes].every(
          (n) => n instanceof HTMLElement && n.hasAttribute(FILLER),
        );
        if (onlyFiller) continue;
        // WebKit can delete a whole block element (select all + delete on an
        // empty doc); the model still has it, so put it back.
        for (const n of record.removedNodes) {
          const removed = this.domDescs.get(n);
          if (removed?.parent && !this.schema.isTextblock(removed.parent.node.type)) containers.add(removed.parent);
        }
      }
      const block = this.textblockOf(desc);
      if (block) blocks.add(block);
    }
    if (containers.size) {
      this.stopObserving();
      for (const c of containers) this.renderChildren(c, c.node);
      this.startObserving();
      if (this.focused) this.writeSelection();
    }
    if (!blocks.size) return;
    this.reconcileBlocks([...blocks]);
  }

  private nearestDesc(node: globalThis.Node | null): Desc | null {
    while (node) {
      const d = this.textDescs.get(node) ?? this.domDescs.get(node) ?? this.contentDescs.get(node);
      if (d) return d;
      node = node.parentNode;
    }
    return null;
  }

  private textblockOf(desc: Desc | null): Desc | null {
    while (desc) {
      if (desc.parent && this.schema.isTextblock(desc.node.type)) return desc;
      desc = desc.parent;
    }
    return null;
  }

  /**
   * Reads the inline content of textblocks back from the DOM and turns any
   * difference into a replace step. Used after IME composition and for
   * browser-made edits like spellcheck corrections.
   */
  reconcileBlocks(blocks: Desc[]) {
    const tr = new Transaction(this.state);
    const sorted = blocks
      .filter((b) => b.parent && b.contentDOM && this.dom.contains(b.contentDOM))
      .map((b) => ({ b, pos: this.posOf(b) }))
      .sort((x, y) => y.pos - x.pos);
    for (const { b, pos } of sorted) {
      const fromDOM = this.readInline(b);
      const before = b.node.content ?? [];
      const diff = diffInline(before, fromDOM, this.schema);
      if (!diff) continue;
      const start = pos + 1;
      tr.maybeStep({
        stepType: "replace",
        from: start + diff.from,
        to: start + diff.toOld,
        slice: diff.slice,
      });
    }
    const sel = this.readSelection();
    if (!tr.docChanged) {
      // Put the DOM back in sync with the unchanged model.
      this.stopObserving();
      for (const { b } of sorted) {
        if (b.contentDOM) {
          const node = b.node;
          b.children.forEach((c) => c.destroy());
          b.children = [];
          b.contentDOM.textContent = "";
          this.renderChildren(b, node);
        }
      }
      this.startObserving();
      return;
    }
    if (sel) tr.setSelection(sel);
    tr.setMeta("domChange", true);
    this.dispatch(tr);
  }

  private readInline(block: Desc): Node[] {
    const result: Node[] = [];
    let lastMarks: Mark[] | undefined;
    const walk = (parent: globalThis.Node) => {
      for (const child of Array.from(parent.childNodes)) {
        const textDesc = this.textDescs.get(child);
        if (textDesc) {
          lastMarks = textDesc.node.marks;
          const text = (child as Text).data;
          if (text) result.push({ ...textDesc.node, text });
          continue;
        }
        const desc = this.domDescs.get(child);
        if (desc && desc.parent === block) {
          if (desc.isText) {
            lastMarks = desc.node.marks;
            const text = desc.dom.textContent ?? "";
            if (text) result.push({ ...desc.node, text });
          } else {
            result.push(desc.node);
          }
          continue;
        }
        if (child.nodeType === 3) {
          const text = (child as Text).data;
          if (text) result.push(lastMarks?.length ? { type: "text", text, marks: lastMarks } : { type: "text", text });
        } else if (child instanceof HTMLElement && child.hasAttribute(FILLER)) {
          continue;
        } else if (child instanceof HTMLBRElement) {
          continue;
        } else {
          walk(child);
        }
      }
    };
    walk(block.contentDOM!);
    return mergeTexts(result);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private listeners: [EventTarget, string, EventListener][] = [];

  private on<K extends string>(target: EventTarget, type: K, fn: (e: Event) => void) {
    target.addEventListener(type, fn);
    this.listeners.push([target, type, fn]);
  }

  private unbind() {
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    this.listeners = [];
  }

  private stopped(event: Event) {
    const desc = this.nearestDesc(event.target as globalThis.Node);
    let d: Desc | null = desc;
    while (d) {
      if (d.view?.stopEvent?.(event)) return true;
      d = d.parent;
    }
    return false;
  }

  private bindEvents() {
    this.on(document, "selectionchange", this.onSelectionChange);
    this.on(this.dom, "focus", () => {
      this.focused = true;
      this.props.onFocusChange?.(this, true);
    });
    this.on(this.dom, "blur", () => {
      this.focused = false;
      this.props.onFocusChange?.(this, false);
    });
    this.on(this.dom, "beforeinput", (e) => {
      if (!this.editable || this.stopped(e)) return;
      // selectionchange fires asynchronously; make sure the model has the
      // caret the user just placed before acting on input.
      if (!this.composing) this.onSelectionChange();
      this.props.handleBeforeInput?.(this, e as InputEvent);
    });
    this.on(this.dom, "keydown", (e) => {
      const event = e as KeyboardEvent;
      if (event.isComposing || event.keyCode === 229 || this.stopped(e)) return;
      this.onSelectionChange();
      if (this.props.handleKeyDown?.(this, event)) event.preventDefault();
    });
    this.on(this.dom, "compositionstart", () => {
      // A new composition can start before the previous one's deferred
      // reconcile ran (IMEs commit a syllable and start the next at once).
      if (this.compositionTimer !== null) {
        clearTimeout(this.compositionTimer);
        this.finishComposition();
      }
      this.onSelectionChange();
      this.composing = true;
      const sel = this.readSelection();
      this.composingDesc = sel ? this.textblockOf(this.descAround(sel.head)) : null;
    });
    this.on(this.dom, "compositionend", () => {
      // Some browsers fire compositionend before the final input event; let
      // that land before reading the DOM.
      this.compositionTimer = setTimeout(() => this.finishComposition(), 0);
    });
    this.on(this.dom, "paste", (e) => {
      if (!this.editable || this.stopped(e)) return;
      if (this.props.handlePaste?.(this, e as ClipboardEvent)) e.preventDefault();
    });
    this.on(this.dom, "drop", (e) => {
      if (!this.editable || this.stopped(e)) return;
      if (this.props.handleDrop?.(this, e as DragEvent)) e.preventDefault();
    });
    this.on(this.dom, "mousedown", (e) => {
      const event = e as MouseEvent;
      if (this.stopped(e)) return;
      const target = event.target as globalThis.Node;
      const desc = this.nearestDesc(target);
      // Clicking a leaf block (image, divider, embed) selects it as a node.
      if (desc && !desc.isText && !desc.contentDOM && desc.parent && this.editable) {
        const pos = this.posOf(desc);
        const tr = new Transaction(this.state);
        tr.setSelection({ anchor: pos, head: pos + desc.size(this.schema), node: true });
        this.dispatch(tr);
        if (!this.focused) this.dom.focus({ preventScroll: true });
        event.preventDefault();
      }
    });
    this.on(this.dom, "click", (e) => {
      const event = e as MouseEvent;
      if (this.stopped(e)) return;
      const pos = this.posAtCoords(event.clientX, event.clientY);
      if (pos !== null) this.props.handleClick?.(this, pos, event);
    });
  }

  private compositionTimer: ReturnType<typeof setTimeout> | null = null;

  private finishComposition() {
    this.compositionTimer = null;
    this.composing = false;
    const block = this.composingDesc;
    this.composingDesc = null;
    this.observer.takeRecords();
    if (block) this.reconcileBlocks([block]);
    const pending = this.afterComposition;
    this.afterComposition = [];
    for (const fn of pending) fn();
  }

  /** Descriptor of the text or node around a position. */
  private descAround(pos: number): Desc | null {
    const { node } = this.domFromPos(pos);
    return this.nearestDesc(node);
  }
}

const isAncestor = (ancestor: Desc, desc: Desc) => {
  let d: Desc | null = desc;
  while (d) {
    if (d === ancestor) return true;
    d = d.parent;
  }
  return false;
};

const indexWithin = (dom: globalThis.Node, parent: globalThis.Node): number => {
  let node: globalThis.Node | null = dom;
  while (node && node.parentNode !== parent) node = node.parentNode;
  return node ? Array.prototype.indexOf.call(parent.childNodes, node) : parent.childNodes.length;
};

const fillerIndex = (contentDOM: HTMLElement): number => {
  const kids = contentDOM.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i]!;
    if (k instanceof HTMLElement && k.hasAttribute(FILLER)) return i;
  }
  return kids.length;
};

const mergeTexts = (nodes: Node[]): Node[] => {
  const out: Node[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (last && last.type === "text" && node.type === "text" && sameMarks(last.marks, node.marks)) {
      out[out.length - 1] = { ...last, text: (last.text ?? "") + (node.text ?? "") };
    } else {
      out.push(node);
    }
  }
  return out;
};

interface InlineUnit {
  key: string;
  node: Node;
}

const units = (nodes: Node[]): InlineUnit[] => {
  const out: InlineUnit[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      const marks = JSON.stringify(node.marks ?? []);
      for (const ch of node.text ?? "") {
        for (let i = 0; i < ch.length; i++) out.push({ key: ch[i]! + marks, node: { ...node, text: ch[i]! } });
      }
    } else {
      out.push({ key: JSON.stringify(node), node });
    }
  }
  return out;
};

/** Smallest replace that turns `before` into `after` (inline content of one textblock). */
export const diffInline = (before: Node[], after: Node[], schema: Schema) => {
  void schema;
  const a = units(before);
  const b = units(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start]!.key === b[start]!.key) start++;
  if (start === a.length && start === b.length) return null;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1]!.key === b[endB - 1]!.key) {
    endA--;
    endB--;
  }
  const inserted = mergeTexts(b.slice(start, endB).map((u) => u.node));
  const slice = inserted.map((n) =>
    n.type === "text" ? (n.marks?.length ? { t: n.text!, m: n.marks } : { t: n.text! }) : { n },
  );
  return { from: start, toOld: endA, slice };
};

export const textNodeSize = (node: Node, schema: Schema) => nodeSize(node, schema);
