import type { Attrs, Node } from "./model";
import { $ } from "./resolved";
import type { Schema } from "./schema";
import { Transaction, selFrom, type EditorState } from "./state";
import { nodeSize, nodesToItems } from "./tokens";
import type { Command } from "./commands";

/**
 * Tables are edited through a grid model: the table is unpacked into cells
 * with row/column spans, the operation rewrites the grid, and the table is
 * rebuilt and replaced in one step.
 */

interface Cell {
  node: Node;
  row: number;
  col: number;
  rowspan: number;
  colspan: number;
}

export interface Grid {
  width: number;
  height: number;
  cells: Cell[];
  /** `at[row][col]` is the cell covering that slot. */
  at: (Cell | undefined)[][];
}

export const toGrid = (table: Node): Grid => {
  const cells: Cell[] = [];
  const at: (Cell | undefined)[][] = [];
  const rows = table.content ?? [];
  rows.forEach((row, r) => {
    at[r] ??= [];
    let c = 0;
    for (const node of row.content ?? []) {
      while (at[r]![c]) c++;
      const rowspan = Math.max(1, Number(node.attrs?.rowspan) || 1);
      const colspan = Math.max(1, Number(node.attrs?.colspan) || 1);
      const cell: Cell = { node, row: r, col: c, rowspan, colspan };
      cells.push(cell);
      for (let dr = 0; dr < rowspan; dr++) {
        at[r + dr] ??= [];
        for (let dc = 0; dc < colspan; dc++) at[r + dr]![c + dc] = cell;
      }
      c += colspan;
    }
  });
  const height = Math.max(rows.length, at.length);
  const width = Math.max(0, ...at.map((r) => r.length));
  return { width, height, cells, at };
};

const emptyCell = (schema: Schema, type = "tableCell", attrs?: Attrs): Node =>
  schema.node(type, { ...attrs, colspan: 1, rowspan: 1 }, [schema.node("paragraph")]);

const withSpan = (node: Node, rowspan: number, colspan: number, colwidth?: number[] | null): Node => {
  const attrs: Attrs = { ...node.attrs, rowspan, colspan };
  if (colwidth !== undefined) attrs.colwidth = colwidth && colwidth.some((w) => w > 0) ? colwidth : null;
  return { ...node, attrs };
};

export const fromGrid = (grid: Grid, table: Node, schema: Schema): Node => {
  const rows: Node[] = [];
  for (let r = 0; r < grid.height; r++) {
    const cells = grid.cells
      .filter((c) => c.row === r)
      .sort((a, b) => a.col - b.col)
      .map((c) => withSpan(c.node, c.rowspan, c.colspan));
    rows.push(schema.node("tableRow", undefined, cells));
  }
  // Fill holes so every row covers the full width.
  const rebuilt: Node = { ...table, content: rows };
  const check = toGrid(rebuilt);
  for (let r = 0; r < check.height; r++) {
    for (let c = 0; c < grid.width; c++) {
      if (!check.at[r]?.[c]) {
        const row = rows[r]!;
        const before = (row.content ?? []).filter((cell) => {
          const g = check.cells.find((x) => x.node === cell);
          return g && g.col < c;
        }).length;
        const content = (row.content ?? []).slice();
        content.splice(before, 0, emptyCell(schema));
        rows[r] = { ...row, content };
        return fromGrid(toGrid({ ...table, content: rows }), table, schema);
      }
    }
  }
  return { ...table, content: rows.filter((r) => (r.content ?? []).length) };
};

export interface TableContext {
  table: Node;
  tablePos: number;
  grid: Grid;
  cell: Cell;
}

export const tableContext = (state: EditorState, pos = selFrom(state.selection)): TableContext | null => {
  const { doc, schema } = state;
  const $pos = $(doc, pos, schema);
  const cellDepth = $pos.findDepth((n) => n.type === "tableCell" || n.type === "tableHeader");
  if (cellDepth < 2) return null;
  const tableDepth = cellDepth - 2;
  const table = $pos.node(tableDepth);
  if (table.type !== "table") return null;
  const grid = toGrid(table);
  const cellNode = $pos.node(cellDepth);
  const cell = grid.cells.find((c) => c.node === cellNode);
  if (!cell) return null;
  return { table, tablePos: $pos.before(tableDepth), grid, cell };
};

/** Cells in the rectangle spanned by the selection's anchor and head cells. */
export const selectedRect = (state: EditorState, ctx: TableContext) => {
  const other = tableContext(state, state.selection.anchor === selFrom(state.selection) ? state.selection.head : state.selection.anchor);
  const a = ctx.cell;
  const b = other && other.table === ctx.table ? other.cell : a;
  let top = Math.min(a.row, b.row);
  let left = Math.min(a.col, b.col);
  let bottom = Math.max(a.row + a.rowspan, b.row + b.rowspan);
  let right = Math.max(a.col + a.colspan, b.col + b.colspan);
  // Grow until no cell crosses the rectangle's edge.
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of ctx.grid.cells) {
      const inside = c.row < bottom && c.row + c.rowspan > top && c.col < right && c.col + c.colspan > left;
      if (!inside) continue;
      if (c.row < top) (top = c.row), (changed = true);
      if (c.col < left) (left = c.col), (changed = true);
      if (c.row + c.rowspan > bottom) (bottom = c.row + c.rowspan), (changed = true);
      if (c.col + c.colspan > right) (right = c.col + c.colspan), (changed = true);
    }
  }
  return { top, left, bottom, right };
};

const replaceTable = (state: EditorState, ctx: TableContext, next: Node | null, cursorCell?: { row: number; col: number }) => {
  const tr = new Transaction(state);
  const size = nodeSize(ctx.table, state.schema);
  if (!next) {
    tr.replace(ctx.tablePos, ctx.tablePos + size, nodesToItems([state.schema.node("paragraph")], state.schema));
    tr.setSelection({ anchor: ctx.tablePos + 1, head: ctx.tablePos + 1 });
    return tr;
  }
  tr.replace(ctx.tablePos, ctx.tablePos + size, nodesToItems([next], state.schema));
  const target = cursorCell ?? { row: ctx.cell.row, col: ctx.cell.col };
  const pos = cellContentPos(next, ctx.tablePos, target.row, target.col, state.schema);
  if (pos !== null) tr.setSelection({ anchor: pos, head: pos });
  return tr;
};

/** Position inside the first textblock of the cell covering (row, col). */
export const cellContentPos = (table: Node, tablePos: number, row: number, col: number, schema: Schema): number | null => {
  const grid = toGrid(table);
  const r = Math.max(0, Math.min(grid.height - 1, row));
  const c = Math.max(0, Math.min(grid.width - 1, col));
  const cell = grid.at[r]?.[c];
  if (!cell) return null;
  let pos = tablePos + 1;
  for (const rowNode of table.content ?? []) {
    let p = pos + 1;
    for (const cellNode of rowNode.content ?? []) {
      if (cellNode === cell.node) return p + 2;
      p += nodeSize(cellNode, schema);
    }
    pos += nodeSize(rowNode, schema);
  }
  return null;
};

const tableCommand =
  (fn: (state: EditorState, ctx: TableContext) => Transaction | null): Command =>
  (state, dispatch) => {
    const ctx = tableContext(state);
    if (!ctx) return false;
    const tr = fn(state, ctx);
    if (!tr) return false;
    dispatch?.(tr.scroll());
    return true;
  };

const cloneGrid = (grid: Grid): Grid => ({
  ...grid,
  cells: grid.cells.map((c) => ({ ...c })),
});

export const addRow = (after: boolean): Command =>
  tableCommand((state, ctx) => {
    const grid = cloneGrid(ctx.grid);
    const at = after ? ctx.cell.row + ctx.cell.rowspan : ctx.cell.row;
    const crossing = new Set<Cell>();
    for (const c of grid.cells) {
      if (c.row >= at) c.row++;
      else if (c.row + c.rowspan > at) crossing.add(c);
    }
    for (const c of crossing) c.rowspan++;
    for (let col = 0; col < grid.width; col++) {
      const spanning = [...crossing].find((c) => c.col <= col && c.col + c.colspan > col);
      if (spanning) continue;
      const headerColumn = col === 0 && ctx.grid.cells.filter((c) => c.col === 0).every((c) => c.node.type === "tableHeader");
      const type = headerColumn ? "tableHeader" : "tableCell";
      grid.cells.push({ node: emptyCell(state.schema, type), row: at, col, rowspan: 1, colspan: 1 });
    }
    grid.height++;
    return replaceTable(state, ctx, fromGrid(grid, ctx.table, state.schema), { row: at, col: ctx.cell.col });
  });

export const deleteRow: Command = tableCommand((state, ctx) => {
  if (ctx.grid.height <= 1) return replaceTable(state, ctx, null);
  const grid = cloneGrid(ctx.grid);
  const r = ctx.cell.row;
  grid.cells = grid.cells.filter((c) => {
    if (c.row === r) {
      if (c.rowspan > 1) {
        c.rowspan--;
        return true;
      }
      return false;
    }
    if (c.row < r && c.row + c.rowspan > r) c.rowspan--;
    return true;
  });
  for (const c of grid.cells) if (c.row > r) c.row--;
  grid.height--;
  return replaceTable(state, ctx, fromGrid(grid, ctx.table, state.schema), { row: Math.min(r, grid.height - 1), col: ctx.cell.col });
});

const colwidths = (node: Node): number[] | null => (Array.isArray(node.attrs?.colwidth) ? (node.attrs!.colwidth as number[]) : null);

export const addColumn = (after: boolean): Command =>
  tableCommand((state, ctx) => {
    const grid = cloneGrid(ctx.grid);
    const at = after ? ctx.cell.col + ctx.cell.colspan : ctx.cell.col;
    const crossing = new Set<Cell>();
    for (const c of grid.cells) {
      if (c.col >= at) c.col++;
      else if (c.col + c.colspan > at) crossing.add(c);
    }
    for (const c of crossing) {
      c.colspan++;
      const cw = colwidths(c.node);
      if (cw) c.node = withSpan(c.node, c.rowspan, c.colspan, [...cw.slice(0, at - c.col), 0, ...cw.slice(at - c.col)]);
    }
    for (let row = 0; row < grid.height; row++) {
      if ([...crossing].some((c) => c.row <= row && c.row + c.rowspan > row)) continue;
      const header = row === 0 && ctx.grid.at[0]?.every((c) => c?.node.type === "tableHeader");
      grid.cells.push({ node: emptyCell(state.schema, header ? "tableHeader" : "tableCell"), row, col: at, rowspan: 1, colspan: 1 });
    }
    grid.width++;
    return replaceTable(state, ctx, fromGrid(grid, ctx.table, state.schema), { row: ctx.cell.row, col: at });
  });

export const deleteColumn: Command = tableCommand((state, ctx) => {
  if (ctx.grid.width <= 1) return replaceTable(state, ctx, null);
  const grid = cloneGrid(ctx.grid);
  const col = ctx.cell.col;
  grid.cells = grid.cells.filter((c) => {
    const covers = c.col <= col && c.col + c.colspan > col;
    if (!covers) return true;
    if (c.colspan > 1) {
      const cw = colwidths(c.node);
      c.colspan--;
      if (cw) c.node = withSpan(c.node, c.rowspan, c.colspan, cw.filter((_, i) => i !== col - c.col));
      return true;
    }
    return false;
  });
  for (const c of grid.cells) if (c.col > col) c.col--;
  grid.width--;
  return replaceTable(state, ctx, fromGrid(grid, ctx.table, state.schema), { row: ctx.cell.row, col: Math.min(col, grid.width - 1) });
});

export const deleteTable: Command = tableCommand((state, ctx) => replaceTable(state, ctx, null));

const retypeCells = (state: EditorState, ctx: TableContext, pick: (c: Cell) => boolean) => {
  const targets = ctx.grid.cells.filter(pick);
  const toHeader = targets.some((c) => c.node.type !== "tableHeader");
  const grid = cloneGrid(ctx.grid);
  for (const c of grid.cells) {
    if (!pick(c)) continue;
    c.node = { ...c.node, type: toHeader ? "tableHeader" : "tableCell" };
  }
  return replaceTable(state, ctx, fromGrid(grid, ctx.table, state.schema));
};

export const toggleHeaderRow: Command = tableCommand((state, ctx) => retypeCells(state, ctx, (c) => c.row === 0));
export const toggleHeaderColumn: Command = tableCommand((state, ctx) => retypeCells(state, ctx, (c) => c.col === 0));
export const toggleHeaderCell: Command = tableCommand((state, ctx) => {
  const rect = selectedRect(state, ctx);
  return retypeCells(state, ctx, (c) => c.row >= rect.top && c.row < rect.bottom && c.col >= rect.left && c.col < rect.right);
});

export const mergeCells: Command = tableCommand((state, ctx) => {
  const rect = selectedRect(state, ctx);
  if (rect.bottom - rect.top <= 1 && rect.right - rect.left <= 1) return null;
  const grid = cloneGrid(ctx.grid);
  const inside = grid.cells.filter((c) => c.row >= rect.top && c.row < rect.bottom && c.col >= rect.left && c.col < rect.right);
  const first = inside.find((c) => c.row === rect.top && c.col === rect.left)!;
  const content = inside
    .sort((a, b) => a.row - b.row || a.col - b.col)
    .flatMap((c) => (c.node.content ?? []).filter((b) => !(b.type === "paragraph" && !(b.content ?? []).length)));
  first.node = { ...first.node, content: content.length ? content : [state.schema.node("paragraph")] };
  first.rowspan = rect.bottom - rect.top;
  first.colspan = rect.right - rect.left;
  grid.cells = grid.cells.filter((c) => c === first || !inside.includes(c));
  return replaceTable(state, ctx, fromGrid(grid, ctx.table, state.schema), { row: rect.top, col: rect.left });
});

export const splitCell: Command = tableCommand((state, ctx) => {
  const cell = ctx.cell;
  if (cell.rowspan === 1 && cell.colspan === 1) return null;
  const grid = cloneGrid(ctx.grid);
  const target = grid.cells.find((c) => c.node === cell.node)!;
  for (let r = 0; r < cell.rowspan; r++) {
    for (let c = 0; c < cell.colspan; c++) {
      if (r === 0 && c === 0) continue;
      grid.cells.push({ node: emptyCell(state.schema, cell.node.type), row: cell.row + r, col: cell.col + c, rowspan: 1, colspan: 1 });
    }
  }
  target.rowspan = 1;
  target.colspan = 1;
  const cw = colwidths(target.node);
  target.node = withSpan(target.node, 1, 1, cw ? cw.slice(0, 1) : null);
  return replaceTable(state, ctx, fromGrid(grid, ctx.table, state.schema));
});

export const setCellAttrs = (attrs: Attrs): Command =>
  tableCommand((state, ctx) => {
    const rect = selectedRect(state, ctx);
    const grid = cloneGrid(ctx.grid);
    for (const c of grid.cells) {
      if (c.row >= rect.top && c.row < rect.bottom && c.col >= rect.left && c.col < rect.right) {
        c.node = { ...c.node, attrs: { ...c.node.attrs, ...attrs } };
      }
    }
    return replaceTable(state, ctx, fromGrid(grid, ctx.table, state.schema));
  });

/** Tab / Shift-Tab between cells; Tab in the last cell adds a row. */
export const goToCell = (direction: 1 | -1): Command => (state, dispatch) => {
  const ctx = tableContext(state);
  if (!ctx) return false;
  const order = ctx.grid.cells.slice().sort((a, b) => a.row - b.row || a.col - b.col);
  const index = order.indexOf(ctx.cell);
  const next = order[index + direction];
  if (!next) {
    if (direction === 1) return addRow(true)(state, dispatch);
    return false;
  }
  const pos = cellContentPos(ctx.table, ctx.tablePos, next.row, next.col, state.schema);
  if (pos === null) return false;
  const tr = new Transaction(state);
  tr.setSelection({ anchor: pos, head: pos });
  dispatch?.(tr);
  return true;
};

export const createTable = (schema: Schema, rows = 3, cols = 3, header = true): Node =>
  schema.node(
    "table",
    undefined,
    Array.from({ length: rows }, (_, r) =>
      schema.node("tableRow", undefined, Array.from({ length: cols }, () => emptyCell(schema, header && r === 0 ? "tableHeader" : "tableCell"))),
    ),
  );

/** Sets the width of grid column `col` on every cell that covers it. */
export const setColumnWidth = (state: EditorState, tablePos: number, table: Node, col: number, width: number): Transaction => {
  const grid = toGrid(table);
  const g = cloneGrid(grid);
  for (const c of g.cells) {
    if (c.col <= col && c.col + c.colspan > col) {
      const cw = colwidths(c.node) ?? Array(c.colspan).fill(0);
      cw[col - c.col] = Math.round(width);
      c.node = withSpan(c.node, c.rowspan, c.colspan, cw);
    }
  }
  const next = fromGrid(g, table, state.schema);
  const tr = new Transaction(state);
  tr.replace(tablePos, tablePos + nodeSize(table, state.schema), nodesToItems([next], state.schema));
  tr.setSelection(state.selection);
  return tr;
};
