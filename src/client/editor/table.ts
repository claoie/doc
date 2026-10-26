import type { Node } from "common/editor/model";
import { setColumnWidth, tableContext, toGrid } from "common/editor/table";
import { $ } from "common/editor/resolved";
import { isEmpty, Transaction } from "common/editor/state";
import { nodeSize } from "common/editor/tokens";
import type { Editor } from "./editor";
import type { NodeViewFactory } from "./desc";
import { h } from "./render";
import type { EditorContext } from "./nodeviews";

const MIN_COL = 48;

const renderColgroup = (colgroup: HTMLElement, table: Node) => {
  const grid = toGrid(table);
  const widths: number[] = Array(grid.width).fill(0);
  for (const cell of grid.cells) {
    const cw = cell.node.attrs?.colwidth;
    if (!Array.isArray(cw)) continue;
    cw.forEach((w, i) => {
      if (Number(w) > 0 && !widths[cell.col + i]) widths[cell.col + i] = Number(w);
    });
  }
  colgroup.textContent = "";
  let total = 0;
  let fixed = true;
  for (const w of widths) {
    const col = h("col");
    if (w) {
      col.style.width = `${w}px`;
      total += w;
    } else {
      col.style.minWidth = `${MIN_COL}px`;
      fixed = false;
    }
    colgroup.append(col);
  }
  return fixed ? total : 0;
};

export const tableView = (ctx: EditorContext): NodeViewFactory => (node) => {
  const colgroup = h("colgroup");
  const tbody = h("tbody");
  const tableEl = h("table", {}, colgroup, tbody);
  const dom = h("div", { class: "table-wrap" }, tableEl);
  const paint = (n: Node) => {
    const width = renderColgroup(colgroup, n);
    tableEl.style.width = width ? `${width}px` : "";
  };
  paint(node);
  void ctx;
  return {
    dom,
    contentDOM: tbody,
    update(next) {
      if (next.type !== "table") return false;
      node = next;
      paint(next);
      return true;
    },
    ignoreMutation: (m) => colgroup.contains(m.target) || (m.target === tableEl && m.type === "attributes"),
  };
};

export const cellView = (ctx: EditorContext): NodeViewFactory => (node, getPos) => {
  const header = node.type === "tableHeader";
  const dom = h(header ? "th" : "td");
  const content = h("div", { class: "cell-content" });
  const resizer = h("div", { class: "col-resizer", contenteditable: "false" });
  dom.append(content, resizer);
  const paint = (n: Node) => {
    const a = n.attrs ?? {};
    const colspan = Number(a.colspan) || 1;
    const rowspan = Number(a.rowspan) || 1;
    if (colspan > 1) dom.setAttribute("colspan", String(colspan));
    else dom.removeAttribute("colspan");
    if (rowspan > 1) dom.setAttribute("rowspan", String(rowspan));
    else dom.removeAttribute("rowspan");
    dom.style.backgroundColor = (a.backgroundColor as string) || "";
    dom.style.textAlign = "";
  };
  paint(node);
  resizer.addEventListener("pointerdown", (e) => {
    const editor = ctx.editor();
    if (!editor?.editable) return;
    e.preventDefault();
    e.stopPropagation();
    const tableEl = dom.closest("table");
    if (!tableEl) return;
    const startX = e.clientX;
    const startWidth = dom.getBoundingClientRect().width / (Number(node.attrs?.colspan) || 1);
    const move = (ev: PointerEvent) => {
      const w = Math.max(MIN_COL, startWidth + ev.clientX - startX);
      dom.style.width = `${w}px`;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      dom.style.width = "";
      const width = Math.max(MIN_COL, startWidth + ev.clientX - startX);
      const ed = ctx.editor();
      if (!ed) return;
      const cellPos = getPos();
      const state = ed.state;
      const $cell = $(state.doc, cellPos + 1, state.schema);
      const depth = $cell.findDepth((n) => n.type === "table");
      if (depth < 1) return;
      const tableNode = $cell.node(depth);
      const tablePos = $cell.before(depth);
      const grid = toGrid(tableNode);
      const cell = grid.cells.find((c) => c.node === node);
      if (!cell) return;
      ed.dispatch(setColumnWidth(state, tablePos, tableNode, cell.col + cell.colspan - 1, width));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  return {
    dom,
    contentDOM: content,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      paint(next);
      return true;
    },
    stopEvent: (e) => resizer.contains(e.target as globalThis.Node),
    ignoreMutation: (m) => resizer.contains(m.target) || (m.target === dom && m.type === "attributes"),
  };
};

/** Whether the DOM caret sits on the top (dir -1) or bottom (dir 1) line of `block`. */
const caretOnEdgeLine = (block: Element, dir: 1 | -1) => {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return false;
  const range = sel.getRangeAt(0);
  let rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (!rect.height) {
    const el = sel.focusNode instanceof Element ? sel.focusNode : sel.focusNode?.parentElement;
    if (!el) return false;
    rect = el.getBoundingClientRect();
  }
  const box = block.getBoundingClientRect();
  return dir === 1 ? box.bottom - rect.bottom < rect.height / 2 : rect.top - box.top < rect.height / 2;
};

/**
 * ArrowDown in the last row / ArrowUp in the first row moves to the block
 * after / before the table. Browsers otherwise move the caret into the
 * neighbouring cell of the same row.
 */
export const leaveTableVertically = (editor: Editor, dir: 1 | -1): boolean => {
  const { state } = editor;
  if (!isEmpty(state.selection)) return false;
  const ctx = tableContext(state);
  if (!ctx) return false;
  const { cell, grid } = ctx;
  if (dir === 1 ? cell.row + cell.rowspan < grid.height : cell.row > 0) return false;
  const focus = window.getSelection()?.focusNode;
  const focusEl = focus instanceof Element ? focus : focus?.parentElement;
  const content = focusEl?.closest("td, th")?.querySelector(":scope > .cell-content");
  const edgeBlock = dir === 1 ? content?.lastElementChild : content?.firstElementChild;
  if (!edgeBlock || !caretOnEdgeLine(edgeBlock, dir)) return false;
  const tableEnd = ctx.tablePos + nodeSize(ctx.table, state.schema);
  const $edge = $(state.doc, dir === 1 ? tableEnd : ctx.tablePos, state.schema);
  const sibling = dir === 1 ? $edge.nodeAfter : $edge.nodeBefore;
  if (!sibling || !state.schema.isTextblock(sibling.type)) return false;
  const pos = dir === 1 ? tableEnd + 1 : ctx.tablePos - 1;
  const tr = new Transaction(state);
  tr.setSelection({ anchor: pos, head: pos });
  editor.dispatch(tr.scroll());
  return true;
};
