import { copyText } from "../../editor/clipboard";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Choice, Property, Row } from "common/bases";
import { keyBetween } from "common/positions";
import { Icon } from "../components/Icon";
import { Menu, cx, useConfirm, useToast, type MenuItem } from "../components/ui";
import { CellPopover, CellView, editMode, InlineEditor, TYPE_ICONS } from "./cells";
import { cellToText, columnWidth, MAX_WIDTH, MIN_WIDTH, moveInList, orderedProperties, readCell, SORTABLE, visibleColumns } from "./format";
import type { BaseController } from "./useBase";

interface Props {
  c: BaseController;
  embedded?: boolean;
  onOpenRow: (row: Row) => void;
  onEditProperty: (prop: Property | null) => void;
  onAddChoice: (prop: Property, name: string) => Promise<Choice | null>;
}

interface Focus {
  row: number;
  col: number;
}

export const TableView = ({ c, embedded, onOpenRow, onEditProperty, onAddChoice }: Props) => {
  const toast = useToast();
  const confirm = useConfirm();
  const base = c.base!;
  const columns = useMemo(() => visibleColumns(base.properties, c.config), [base.properties, c.config]);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [focus, setFocus] = useState<Focus | null>(null);
  const [editing, setEditing] = useState<{ row: string; col: string; seed?: string; anchor?: HTMLElement } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<string | null>(null);
  const [headerMenu, setHeaderMenu] = useState<{ prop: Property; anchor: HTMLElement } | null>(null);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<{ id: string; edge: "before" | "after" } | null>(null);
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [dropRow, setDropRow] = useState<{ id: string; edge: "before" | "after" } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const rows = c.rows;
  const canDragRows = c.canEdit && !c.config.sorts?.length && !c.config.filter?.children.length;

  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(rows.map((r) => r.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const width = (p: Property) => widths[p.id] ?? columnWidth(p, c.config);
  const template = `48px ${columns.map((p) => `${width(p)}px`).join(" ")} ${c.canEdit ? "44px" : ""} minmax(0, 1fr)`;

  const commit = (row: Row, prop: Property, value: unknown) => void c.updateCells(row, { [prop.id]: value });

  const startEdit = (rowIndex: number, colIndex: number, seed?: string) => {
    const row = rows[rowIndex];
    const prop = columns[colIndex];
    if (!row || !prop || !c.canEdit) return;
    const mode = editMode(prop);
    if (mode === "toggle") return commit(row, prop, row.cells[prop.id] !== true);
    if (mode === "none") return onOpenRow(row);
    const anchor = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${row.id}:${prop.id}"]`) ?? undefined;
    setEditing({ row: row.id, col: prop.id, seed, anchor });
  };

  const move = (dRow: number, dCol: number) => {
    setFocus((f) => {
      if (!f) return rows.length ? { row: 0, col: 0 } : null;
      let row = f.row + dRow;
      let col = f.col + dCol;
      if (col >= columns.length) {
        col = 0;
        row++;
      } else if (col < 0) {
        col = columns.length - 1;
        row--;
      }
      row = Math.max(0, Math.min(rows.length - 1, row));
      return { row, col };
    });
  };

  useEffect(() => {
    if (!focus) return;
    const row = rows[focus.row];
    const prop = columns[focus.col];
    if (!row || !prop) return;
    gridRef.current?.querySelector(`[data-cell="${row.id}:${prop.id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focus, rows, columns]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || !focus || e.target !== gridRef.current) return;
    const row = rows[focus.row];
    const prop = columns[focus.col];
    const mod = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        return move(-1, 0);
      case "ArrowDown":
        e.preventDefault();
        return move(1, 0);
      case "ArrowLeft":
        e.preventDefault();
        return move(0, -1);
      case "ArrowRight":
        e.preventDefault();
        return move(0, 1);
      case "Tab":
        e.preventDefault();
        return move(0, e.shiftKey ? -1 : 1);
      case "Escape":
        return setFocus(null);
      case "Enter":
        e.preventDefault();
        if (!row) return;
        if (e.shiftKey || !c.canEdit) return onOpenRow(row);
        return startEdit(focus.row, focus.col);
      case " ":
        if (!prop || !row) return;
        e.preventDefault();
        if (editMode(prop) === "toggle") return startEdit(focus.row, focus.col);
        if (editMode(prop) === "inline") return startEdit(focus.row, focus.col, " ");
        return;
      case "Delete":
      case "Backspace":
        if (row && prop && c.canEdit && editMode(prop) !== "none") {
          e.preventDefault();
          commit(row, prop, null);
        }
        return;
    }
    if (mod && e.key.toLowerCase() === "c" && row && prop) {
      e.preventDefault();
      void copyText(cellToText(prop, row, c.references)).then((ok) => toast(ok ? "Copied" : "Could not copy", ok ? "info" : "error"));
      return;
    }
    if (!mod && !e.altKey && e.key.length === 1 && prop && editMode(prop) === "inline" && c.canEdit) {
      e.preventDefault();
      startEdit(focus.row, focus.col, e.key);
    }
  };

  const toggleSelect = (row: Row, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && lastClicked) {
        const a = rows.findIndex((r) => r.id === lastClicked);
        const b = rows.findIndex((r) => r.id === row.id);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(rows[i]!.id);
          return next;
        }
      }
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
    setLastClicked(row.id);
  };

  const sortBy = (prop: Property, direction: "asc" | "desc" | null) => {
    const rest = (c.config.sorts ?? []).filter((s) => s.propertyId !== prop.id);
    const next = direction ? [{ propertyId: prop.id, direction }, ...rest] : rest;
    c.patchConfig({ sorts: next.length ? next : null });
  };

  const headerItems = (prop: Property): MenuItem[] => {
    const current = c.config.sorts?.find((s) => s.propertyId === prop.id)?.direction;
    const sortable = SORTABLE(prop);
    return [
      ...(c.canEdit ? [{ label: "Edit property", icon: "edit" as const, onSelect: () => onEditProperty(prop) }, { separator: true, label: "" }] : []),
      current === "asc"
        ? { label: "Remove sort", icon: "x" as const, onSelect: () => sortBy(prop, null) }
        : { label: "Sort ascending", icon: "arrowUp" as const, disabled: !sortable, onSelect: () => sortBy(prop, "asc") },
      current === "desc"
        ? { label: "Remove sort", icon: "x" as const, onSelect: () => sortBy(prop, null) }
        : { label: "Sort descending", icon: "arrowDown" as const, disabled: !sortable, onSelect: () => sortBy(prop, "desc") },
      ...(!prop.isPrimary
        ? [
            { label: "Hide in view", icon: "eyeOff" as const, onSelect: () => c.patchConfig({ hiddenPropertyIds: [...(c.config.hiddenPropertyIds ?? []), prop.id] }) },
            ...(c.canEdit
              ? [
                  { separator: true, label: "" },
                  {
                    label: "Delete property",
                    icon: "trash" as const,
                    danger: true,
                    onSelect: async () => {
                      const ok = await confirm({ title: `Delete "${prop.name}"?`, message: "All of its values will be deleted. This cannot be undone.", confirmLabel: "Delete", danger: true });
                      if (ok) void c.deleteProperty(prop);
                    },
                  },
                ]
              : []),
          ]
        : []),
    ];
  };

  const startResize = (prop: Property, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = width(prop);
    let current = start;
    const onMove = (ev: PointerEvent) => {
      current = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, start + ev.clientX - startX));
      setWidths((w) => ({ ...w, [prop.id]: current }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (current !== start) c.patchConfig({ propertyWidths: { ...(c.config.propertyWidths ?? {}), [prop.id]: current } });
      setWidths((w) => {
        const next = { ...w };
        delete next[prop.id];
        return next;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const dropColumn = (target: Property) => {
    if (!dragCol || !dropCol || dragCol === target.id || target.isPrimary) return;
    const order = orderedProperties(base.properties, c.config)
      .filter((p) => !p.isPrimary)
      .map((p) => p.id);
    c.patchConfig({ propertyOrder: moveInList(order, dragCol, target.id, dropCol.edge) });
  };

  const dropRowOn = (target: Row) => {
    if (!dragRow || !dropRow || dragRow === target.id) return;
    const moving = rows.find((r) => r.id === dragRow);
    if (!moving) return;
    const others = rows.filter((r) => r.id !== dragRow);
    const index = others.findIndex((r) => r.id === target.id) + (dropRow.edge === "after" ? 1 : 0);
    const before = others[index - 1]?.position ?? null;
    const after = others[index]?.position ?? null;
    try {
      void c.moveRow(moving, keyBetween(before, after));
    } catch {
      toast("Could not move the row", "error");
    }
  };

  const addRow = async () => {
    const row = await c.createRow();
    if (!row) return;
    const primary = columns.findIndex((p) => p.isPrimary);
    setTimeout(() => {
      const index = c.rows.findIndex((r) => r.id === row.id);
      const rowIndex = index >= 0 ? index : rows.length;
      setFocus({ row: rowIndex, col: Math.max(0, primary) });
      setEditing({ row: row.id, col: columns[Math.max(0, primary)]!.id });
    }, 0);
  };

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const editingRow = editing ? rows.find((r) => r.id === editing.row) : undefined;
  const editingProp = editing ? columns.find((p) => p.id === editing.col) : undefined;

  return (
    <div className={cx("base-table", embedded && "embedded")}>
      {selected.size > 0 && (
        <div className="selection-bar">
          <span>{selected.size} selected</span>
          {c.canEdit && (
            <button
              type="button"
              className="btn btn-ghost btn-sm danger"
              onClick={async () => {
                const ok = await confirm({ title: `Delete ${selected.size} ${selected.size === 1 ? "row" : "rows"}?`, confirmLabel: "Delete", danger: true });
                if (!ok) return;
                void c.deleteRows([...selected]);
                setSelected(new Set());
              }}
            >
              <Icon name="trash" size={14} /> Delete
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}
      <div
        className="grid-scroll"
        ref={gridRef}
        role="grid"
        tabIndex={0}
        aria-rowcount={rows.length + 1}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => {
          if (e.target === gridRef.current) setFocus(null);
        }}
      >
        <div className="grid-row grid-header" role="row" style={{ gridTemplateColumns: template }}>
          <div className="grid-cell grid-num">
            <input
              type="checkbox"
              aria-label="Select all rows"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = selected.size > 0 && !allSelected;
              }}
              onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
            />
          </div>
          {columns.map((prop) => {
            const sort = c.config.sorts?.find((s) => s.propertyId === prop.id);
            return (
              <div
                key={prop.id}
                role="columnheader"
                className={cx("grid-cell grid-head", dropCol?.id === prop.id && `drop-${dropCol.edge}`)}
                draggable={c.canEdit && !prop.isPrimary}
                onDragStart={(e) => {
                  setDragCol(prop.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", prop.name);
                }}
                onDragOver={(e) => {
                  if (!dragCol || prop.isPrimary) return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  setDropCol({ id: prop.id, edge: e.clientX < r.left + r.width / 2 ? "before" : "after" });
                }}
                onDragLeave={() => setDropCol((d) => (d?.id === prop.id ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  dropColumn(prop);
                  setDragCol(null);
                  setDropCol(null);
                }}
                onDragEnd={() => {
                  setDragCol(null);
                  setDropCol(null);
                }}
              >
                <button type="button" className="grid-head-button" onClick={(e) => setHeaderMenu({ prop, anchor: e.currentTarget })}>
                  <Icon name={TYPE_ICONS[prop.type]} size={14} />
                  <span className="ellipsis">{prop.name}</span>
                  {sort && <Icon name={sort.direction === "asc" ? "arrowUp" : "arrowDown"} size={13} />}
                </button>
                <span className="col-resize" onPointerDown={(e) => startResize(prop, e)} onDoubleClick={(e) => e.stopPropagation()} />
              </div>
            );
          })}
          {c.canEdit && (
            <div className="grid-cell grid-add-col">
              <button type="button" className="icon-button" aria-label="Add property" onClick={() => onEditProperty(null)}>
                <Icon name="plus" size={16} />
              </button>
            </div>
          )}
          <div className="grid-cell grid-fill" />
        </div>
        {rows.map((row, rowIndex) => (
          <div
            key={row.id}
            role="row"
            className={cx("grid-row", selected.has(row.id) && "selected", dropRow?.id === row.id && `drop-${dropRow.edge}`, dragRow === row.id && "dragging")}
            style={{ gridTemplateColumns: template }}
            onDragOver={(e) => {
              if (!dragRow) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setDropRow({ id: row.id, edge: e.clientY < r.top + r.height / 2 ? "before" : "after" });
            }}
            onDrop={(e) => {
              e.preventDefault();
              dropRowOn(row);
              setDragRow(null);
              setDropRow(null);
            }}
          >
            <div className="grid-cell grid-num">
              {canDragRows && (
                <span
                  className="row-grip"
                  draggable
                  title="Drag to move"
                  onDragStart={(e) => {
                    setDragRow(row.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", row.id);
                  }}
                  onDragEnd={() => {
                    setDragRow(null);
                    setDropRow(null);
                  }}
                >
                  <Icon name="drag" size={14} />
                </span>
              )}
              <span className="row-index">{rowIndex + 1}</span>
              <input
                type="checkbox"
                aria-label={`Select row ${rowIndex + 1}`}
                checked={selected.has(row.id)}
                onClick={(e) => toggleSelect(row, e.shiftKey)}
                onChange={() => undefined}
              />
            </div>
            {columns.map((prop, colIndex) => {
              const focused = focus?.row === rowIndex && focus.col === colIndex;
              const isEditing = editing?.row === row.id && editing.col === prop.id && editMode(prop) === "inline";
              return (
                <div
                  key={prop.id}
                  role="gridcell"
                  data-cell={`${row.id}:${prop.id}`}
                  className={cx("grid-cell", focused && "focused", isEditing && "editing", prop.isPrimary && "primary")}
                  onMouseDown={() => setFocus({ row: rowIndex, col: colIndex })}
                  onDoubleClick={() => startEdit(rowIndex, colIndex)}
                  onClick={(e) => {
                    if (editMode(prop) === "toggle" && c.canEdit && (e.target as HTMLElement).closest(".cell-check")) commit(row, prop, readCell(prop, row) !== true);
                  }}
                >
                  {isEditing ? (
                    <InlineEditor
                      prop={prop}
                      initial={row.cells[prop.id]}
                      seed={editing?.seed}
                      onCancel={() => {
                        setEditing(null);
                        gridRef.current?.focus();
                      }}
                      onCommit={(value, dir) => {
                        commit(row, prop, value);
                        setEditing(null);
                        gridRef.current?.focus();
                        if (dir === "next") move(0, 1);
                        else if (dir === "prev") move(0, -1);
                        else if (dir === "down") move(1, 0);
                      }}
                    />
                  ) : (
                    <CellView prop={prop} row={row} refs={c.references} />
                  )}
                  {prop.isPrimary && !isEditing && (
                    <button type="button" className="row-open" onClick={() => onOpenRow(row)} aria-label="Open row">
                      <Icon name="open" size={13} /> Open
                    </button>
                  )}
                </div>
              );
            })}
            {c.canEdit && <div className="grid-cell grid-add-col" />}
            <div className="grid-cell grid-fill" />
          </div>
        ))}
      </div>
      <div className="grid-footer">
        {c.canEdit && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={addRow}>
            <Icon name="plus" size={14} /> New row
          </button>
        )}
        <span className="spacer" />
        {c.rowsError ? (
          <span className="danger">Failed to load rows.</span>
        ) : c.loadingRows ? (
          <span className="muted">Loading…</span>
        ) : rows.length === 0 ? (
          <span className="muted">{c.config.filter?.children.length ? "No rows match the current filter." : "No rows yet."}</span>
        ) : (
          <span className="muted">
            {rows.length}
            {c.hasMore ? "+" : ""} {rows.length === 1 && !c.hasMore ? "row" : "rows"}
          </span>
        )}
        {c.hasMore && !c.loadingRows && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void c.loadMore()}>
            Load more
          </button>
        )}
      </div>
      {headerMenu && <Menu anchor={headerMenu.anchor} items={headerItems(headerMenu.prop)} onClose={() => setHeaderMenu(null)} />}
      {editing && editingRow && editingProp && editMode(editingProp) === "popover" && editing.anchor && (
        <CellPopover
          anchor={editing.anchor}
          prop={editingProp}
          row={editingRow}
          pageId={base.id}
          onChange={(value) => commit(editingRow, editingProp, value)}
          onClose={() => {
            setEditing(null);
            gridRef.current?.focus();
          }}
          onAddChoice={onAddChoice}
          onReferences={c.addReferences}
        />
      )}
    </div>
  );
};
