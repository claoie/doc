import { useEffect, useMemo, useState } from "react";
import { NO_VALUE, type Row } from "common/bases";
import { keyBetween } from "common/positions";
import { Icon } from "../components/Icon";
import { Menu, cx, type MenuItem } from "../components/ui";
import { ChoiceBadge, CellView } from "./cells";
import { cellToText, choicesOf, groupProperty, isEmptyValue, kanbanColumns, moveInList, orderedProperties, readCell } from "./format";
import type { BaseController } from "./useBase";

export const KanbanView = ({ c, onOpenRow }: { c: BaseController; onOpenRow: (row: Row) => void }) => {
  const base = c.base!;
  const view = c.view!;
  const group = groupProperty(base.properties, view);
  const [dragCard, setDragCard] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ column: string; before: string | null } | null>(null);
  const [dragColumn, setDragColumn] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);
  const { loadAll } = c;

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const primary = base.properties.find((p) => p.isPrimary);
  const visible = new Set(c.config.visiblePropertyIds ?? []);
  const fields = orderedProperties(base.properties, c.config).filter((p) => !p.isPrimary && visible.has(p.id));
  const sorted = !!c.config.sorts?.length;

  const columns = useMemo(() => (group ? kanbanColumns(group, c.config) : []), [group, c.config]);
  const hidden = new Set(c.config.hiddenChoiceIds ?? []);
  const byColumn = useMemo(() => {
    const map = new Map<string, Row[]>(columns.map((id) => [id, []]));
    if (!group) return map;
    for (const row of c.rows) {
      const value = group ? readCell(group, row) : null;
      const key = typeof value === "string" && map.has(value) ? value : NO_VALUE;
      map.get(key)?.push(row);
    }
    return map;
  }, [c.rows, columns, group]);

  if (!group) {
    return <div className="empty-hint">Add a select or status property to use the board view.</div>;
  }

  const choice = (id: string) => choicesOf(group).find((ch) => ch.id === id);

  const drop = (column: string, beforeId: string | null) => {
    const row = c.rows.find((r) => r.id === dragCard);
    if (!row) return;
    const current = readCell(group, row);
    const target = column === NO_VALUE ? null : column;
    if ((current ?? null) !== target) void c.updateCells(row, { [group.id]: target });
    if (!c.canEdit || sorted) return;
    const list = (byColumn.get(column) ?? []).filter((r) => r.id !== row.id);
    const index = beforeId ? list.findIndex((r) => r.id === beforeId) : list.length;
    if ((current ?? null) === target && (byColumn.get(column) ?? []).findIndex((r) => r.id === row.id) === index) return;
    const prev = list[index - 1]?.position ?? null;
    const next = list[index]?.position ?? null;
    if (prev !== null && next !== null && prev >= next) return;
    try {
      void c.moveRow(row, keyBetween(prev, next));
    } catch {
      // Neighbours share a position; keep the current order.
    }
  };

  const columnMenu = (id: string, anchor: HTMLElement) =>
    setMenu({ anchor, items: [{ label: "Hide column", icon: "eyeOff", onSelect: () => c.patchConfig({ hiddenChoiceIds: [...hidden, id] }) }] });

  const hiddenColumns = columns.filter((id) => hidden.has(id));

  return (
    <div className="kanban">
      {c.loadingRows && !c.rows.length && <div className="muted pad">Loading rows…</div>}
      <div className="kanban-columns">
        {columns
          .filter((id) => !hidden.has(id))
          .map((id) => {
            const rows = byColumn.get(id) ?? [];
            const ch = choice(id);
            return (
              <div
                key={id}
                className={cx("kanban-column", dropTarget?.column === id && "drop", dragColumn === id && "dragging")}
                onDragOver={(e) => {
                  if (dragCard) {
                    e.preventDefault();
                    if (dropTarget?.column !== id || dropTarget.before !== null) {
                      const overCard = (e.target as HTMLElement).closest("[data-card]");
                      if (!overCard) setDropTarget({ column: id, before: null });
                    }
                  } else if (dragColumn && id !== NO_VALUE) {
                    e.preventDefault();
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragCard) drop(id, dropTarget?.column === id ? dropTarget.before : null);
                  else if (dragColumn && dragColumn !== id && id !== NO_VALUE) {
                    const order = columns.filter((x) => x !== NO_VALUE);
                    c.patchConfig({ choiceOrder: moveInList(order, dragColumn, id, "before") });
                  }
                  setDragCard(null);
                  setDragColumn(null);
                  setDropTarget(null);
                }}
              >
                <div
                  className="kanban-column-head"
                  draggable={c.canEdit && id !== NO_VALUE}
                  onDragStart={(e) => {
                    setDragColumn(id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", id);
                  }}
                  onDragEnd={() => setDragColumn(null)}
                >
                  {ch ? <ChoiceBadge choice={ch} plain={group.options.disableColors} /> : <span className="muted">No value</span>}
                  <span className="muted small">{rows.length}</span>
                  <span className="spacer" />
                  <button type="button" className="icon-button" aria-label="Column menu" onClick={(e) => columnMenu(id, e.currentTarget)}>
                    <Icon name="more" size={14} />
                  </button>
                </div>
                <div className="kanban-cards">
                  {rows.map((row) => (
                    <div
                      key={row.id}
                      data-card
                      role="button"
                      tabIndex={0}
                      className={cx("kanban-card", dragCard === row.id && "dragging", dropTarget?.before === row.id && "drop-before")}
                      draggable={c.canEdit}
                      onDragStart={(e) => {
                        setDragCard(row.id);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", row.id);
                      }}
                      onDragEnd={() => {
                        setDragCard(null);
                        setDropTarget(null);
                      }}
                      onDragOver={(e) => {
                        if (!dragCard) return;
                        e.preventDefault();
                        const r = e.currentTarget.getBoundingClientRect();
                        const after = e.clientY > r.top + r.height / 2;
                        const index = rows.findIndex((x) => x.id === row.id);
                        setDropTarget({ column: id, before: after ? (rows[index + 1]?.id ?? null) : row.id });
                      }}
                      onClick={() => onOpenRow(row)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onOpenRow(row);
                        }
                      }}
                    >
                      <div className="kanban-card-title">{(primary && cellToText(primary, row, c.references)) || <span className="muted">Untitled</span>}</div>
                      {fields.map((p) => {
                        const v = readCell(p, row);
                        if (isEmptyValue(v) || (p.type === "checkbox" && v !== true)) return null;
                        return (
                          <div key={p.id} className="kanban-card-field" title={p.name}>
                            <CellView prop={p} row={row} refs={c.references} />
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {c.canEdit && (
                    <button
                      type="button"
                      className="kanban-new"
                      onClick={async () => {
                        const row = await c.createRow(id === NO_VALUE ? {} : { [group.id]: id });
                        if (row) onOpenRow(row);
                      }}
                    >
                      <Icon name="plus" size={14} /> New
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        {hiddenColumns.length > 0 && (
          <div className="kanban-hidden">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={(e) =>
                setMenu({
                  anchor: e.currentTarget,
                  items: [
                    ...hiddenColumns.map((id) => ({
                      label: (
                        <span className="kanban-hidden-item">
                          {choice(id) ? <ChoiceBadge choice={choice(id)!} /> : "No value"} <span className="muted small">{byColumn.get(id)?.length ?? 0}</span>
                        </span>
                      ),
                      onSelect: () => c.patchConfig({ hiddenChoiceIds: [...hidden].filter((x) => x !== id) }),
                    })),
                    ...(hiddenColumns.length > 1 ? [{ separator: true, label: "" }, { label: "Show all columns", onSelect: () => c.patchConfig({ hiddenChoiceIds: null }) }] : []),
                  ],
                })
              }
            >
              Hidden columns ({hiddenColumns.length})
            </button>
          </div>
        )}
      </div>
      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
};
