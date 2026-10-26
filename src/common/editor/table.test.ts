import { describe, expect, test } from "bun:test";
import { schema } from "./doc-schema";
import { applyTransaction, createState, type EditorState } from "./state";
import { addColumn, addRow, createTable, deleteColumn, deleteRow, mergeCells, splitCell, toGrid, cellContentPos, goToCell } from "./table";
import type { Command } from "./commands";
import type { Node } from "./model";

const run = (state: EditorState, cmd: Command) => {
  let next = state;
  expect(cmd(state, (tr) => (next = applyTransaction(state, tr)))).toBe(true);
  return next;
};

const start = () => {
  const table = createTable(schema, 2, 2);
  const doc: Node = { type: "doc", content: [table, schema.node("paragraph")] };
  const pos = cellContentPos(table, 0, 0, 0, schema)!;
  return createState(schema, doc, { anchor: pos, head: pos });
};

const table = (s: EditorState) => s.doc.content![0]!;

describe("table commands", () => {
  test("add and delete rows and columns", () => {
    let s = start();
    s = run(s, addRow(true));
    expect(toGrid(table(s)).height).toBe(3);
    s = run(s, addColumn(true));
    expect(toGrid(table(s)).width).toBe(3);
    expect(schema.check(s.doc)).toBeNull();
    s = run(s, deleteColumn);
    s = run(s, deleteRow);
    expect(toGrid(table(s))).toMatchObject({ width: 2, height: 2 });
  });

  test("merge and split", () => {
    let s = start();
    const t = table(s);
    const a = cellContentPos(t, 0, 0, 0, schema)!;
    const b = cellContentPos(t, 0, 1, 1, schema)!;
    s = { ...s, selection: { anchor: a, head: b } };
    s = run(s, mergeCells);
    const grid = toGrid(table(s));
    expect(grid.cells.length).toBe(1);
    expect(grid.cells[0]!.rowspan).toBe(2);
    expect(schema.check(s.doc)).toBeNull();
    s = run(s, splitCell);
    expect(toGrid(table(s)).cells.length).toBe(4);
  });

  test("tab moves to next cell and adds a row at the end", () => {
    let s = start();
    for (let i = 0; i < 4; i++) s = run(s, goToCell(1));
    expect(toGrid(table(s)).height).toBe(3);
  });
});
