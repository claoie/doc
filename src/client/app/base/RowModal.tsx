import { useEffect, useRef, useState } from "react";
import type { Choice, Property } from "common/bases";
import { Icon } from "../components/Icon";
import { IconButton, Menu, Modal, cx, timeAgo, useConfirm } from "../components/ui";
import { CellPopover, CellView, editMode, InlineEditor, TYPE_ICONS } from "./cells";
import { isEmptyValue, orderedProperties, readCell } from "./format";
import type { BaseController } from "./useBase";

export const RowModal = ({
  c,
  rowId,
  onNavigate,
  onClose,
  onAddChoice,
}: {
  c: BaseController;
  rowId: string;
  onNavigate: (rowId: string) => void;
  onClose: () => void;
  onAddChoice: (prop: Property, name: string) => Promise<Choice | null>;
}) => {
  const confirm = useConfirm();
  const base = c.base!;
  const row = c.rows.find((r) => r.id === rowId);
  const index = c.rows.findIndex((r) => r.id === rowId);
  const primary = base.properties.find((p) => p.isPrimary);
  const props = orderedProperties(base.properties, c.config).filter((p) => !p.isPrimary);
  const [title, setTitle] = useState("");
  const [focused, setFocused] = useState(false);
  const [editing, setEditing] = useState<{ prop: string; anchor: HTMLElement } | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  const remoteTitle = primary && row ? String(row.cells[primary.id] ?? "") : "";
  useEffect(() => {
    if (!focused) setTitle(remoteTitle);
  }, [remoteTitle, focused]);

  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  if (!row) {
    return (
      <Modal title="Row" onClose={onClose} width={720}>
        <div className="muted pad">This row is no longer available.</div>
      </Modal>
    );
  }

  const saveTitle = () => {
    if (primary && title !== remoteTitle) void c.updateCells(row, { [primary.id]: title || null });
  };

  const editingProp = editing ? props.find((p) => p.id === editing.prop) : undefined;

  return (
    <Modal
      onClose={onClose}
      width={720}
      title={
        <span className="row-modal-nav">
          <IconButton icon="chevronLeft" label="Previous row" disabled={index <= 0} onClick={() => onNavigate(c.rows[index - 1]!.id)} />
          <IconButton icon="chevronRight" label="Next row" disabled={index < 0 || index >= c.rows.length - 1} onClick={() => onNavigate(c.rows[index + 1]!.id)} />
          <span className="muted small">
            {index + 1} of {c.rows.length}
            {c.hasMore ? "+" : ""}
          </span>
          {c.canEdit && <IconButton icon="more" label="Row menu" onClick={(e) => setMenu(e.currentTarget)} />}
        </span>
      }
    >
      <div className="row-modal">
        <textarea
          ref={titleRef}
          className="row-title"
          rows={1}
          placeholder="Untitled"
          value={title}
          readOnly={!c.canEdit}
          onFocus={() => setFocused(true)}
          onChange={(e) => setTitle(e.target.value.replace(/\n/g, ""))}
          onBlur={() => {
            setFocused(false);
            saveTitle();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLTextAreaElement).blur();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setTitle(remoteTitle);
              setFocused(false);
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
        <div className="row-fields">
          {props.map((prop) => {
            const mode = c.canEdit ? editMode(prop) : "none";
            const inline = editing?.prop === prop.id && mode === "inline";
            const value = readCell(prop, row);
            return (
              <div key={prop.id} className="row-field">
                <div className="row-field-label">
                  <Icon name={TYPE_ICONS[prop.type]} size={14} />
                  <span className="ellipsis">{prop.name}</span>
                </div>
                <div
                  className={cx("row-field-value", mode !== "none" && "editable")}
                  role={mode !== "none" ? "button" : undefined}
                  tabIndex={mode !== "none" ? 0 : undefined}
                  onClick={(e) => {
                    if (inline || mode === "none") return;
                    if (mode === "toggle") return void c.updateCells(row, { [prop.id]: value !== true });
                    setEditing({ prop: prop.id, anchor: e.currentTarget });
                  }}
                  onKeyDown={(e) => {
                    if (inline || mode === "none" || (e.key !== "Enter" && e.key !== " ")) return;
                    e.preventDefault();
                    if (mode === "toggle") return void c.updateCells(row, { [prop.id]: value !== true });
                    setEditing({ prop: prop.id, anchor: e.currentTarget });
                  }}
                >
                  {inline ? (
                    <InlineEditor
                      prop={prop}
                      initial={row.cells[prop.id]}
                      onCancel={() => setEditing(null)}
                      onCommit={(v) => {
                        void c.updateCells(row, { [prop.id]: v });
                        setEditing(null);
                      }}
                    />
                  ) : isEmptyValue(value) && prop.type !== "checkbox" ? (
                    <span className="muted">Empty</span>
                  ) : (
                    <CellView prop={prop} row={row} refs={c.references} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="row-meta muted small">
          Created {timeAgo(row.createdAt)} · Last edited {timeAgo(row.updatedAt)}
        </div>
      </div>
      {editing && editingProp && editMode(editingProp) === "popover" && (
        <CellPopover
          anchor={editing.anchor}
          prop={editingProp}
          row={row}
          pageId={base.id}
          onChange={(v) => void c.updateCells(row, { [editingProp.id]: v })}
          onClose={() => setEditing(null)}
          onAddChoice={onAddChoice}
          onReferences={c.addReferences}
        />
      )}
      {menu && (
        <Menu
          anchor={menu}
          align="right"
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Delete row",
              icon: "trash",
              danger: true,
              onSelect: async () => {
                const ok = await confirm({ title: "Delete this row?", message: "This cannot be undone.", confirmLabel: "Delete", danger: true });
                if (!ok) return;
                void c.deleteRows([row.id]);
                onClose();
              },
            },
          ]}
        />
      )}
    </Modal>
  );
};
