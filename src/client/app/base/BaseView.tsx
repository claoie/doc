import { useState, type ReactNode } from "react";
import type { Choice, Property } from "common/bases";
import { Spinner, errorMessage, useConfirm, useToast } from "../components/ui";
import { CalendarView } from "./CalendarView";
import { nextColor } from "./cells";
import { KanbanView } from "./KanbanView";
import { PropertyEditor } from "./PropertyEditor";
import { RowModal } from "./RowModal";
import { TableView } from "./TableView";
import { Toolbar } from "./Toolbar";
import { useBase } from "./useBase";
import { shortId } from "common/ids";
import { Icon } from "../components/Icon";
import { Link } from "../router";

export const BaseView = ({
  pageId,
  editable,
  embedded,
  title,
  onRemove,
}: {
  pageId: string;
  editable: boolean;
  embedded?: boolean;
  title?: ReactNode;
  onRemove?: () => void;
}) => {
  const c = useBase(pageId, editable);
  const toast = useToast();
  const confirm = useConfirm();
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [editingProp, setEditingProp] = useState<Property | null | undefined>(undefined);
  const [exporting, setExporting] = useState(false);

  if (c.error) {
    return (
      <div className="base-error">
        <span>Failed to load this base.</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={c.reload}>
          Try again
        </button>
      </div>
    );
  }
  if (!c.base) {
    return (
      <div className="base-loading">
        <Spinner />
      </div>
    );
  }
  if (!c.view) {
    return (
      <div className="base-error">
        <span>This base has no views.</span>
        {c.canEdit && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void c.createView("Table", "table")}>
            Add view
          </button>
        )}
      </div>
    );
  }

  const addChoice = async (prop: Property, name: string): Promise<Choice | null> => {
    const choices = prop.options.choices ?? [];
    const choice: Choice = { id: shortId("opt"), name, color: nextColor(choices), ...(prop.type === "status" ? { category: "todo" as const } : {}) };
    const next = [...choices, choice];
    const saved = await c.saveProperty(prop, { name: prop.name, type: prop.type, options: { ...prop.options, choices: next, choiceOrder: [...(prop.options.choiceOrder ?? []), choice.id] } });
    return saved ? choice : null;
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await fetch(`/api/bases/${c.base!.id}/export.csv`, { credentials: "same-origin" });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      const plain = /filename="([^"]+)"/i.exec(disposition);
      const name = star ? decodeURIComponent(star[1]!) : (plain?.[1] ?? `${c.base!.title || "Untitled base"}.csv`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setExporting(false);
    }
  };

  const newRow = async () => {
    const row = await c.createRow();
    if (row && c.view?.type !== "table") setOpenRow(row.id);
  };

  return (
    <div className={embedded ? "base-view embedded" : "base-view"}>
      {title}
      {embedded && (
        <div className="base-embed-head">
          <Link to={`/p/${c.base.slugId}`} className="base-embed-title">
            {c.base.icon ? <span>{c.base.icon}</span> : <Icon name="table" size={16} />}
            {c.base.title || "Untitled base"}
          </Link>
        </div>
      )}
      <Toolbar c={c} onNew={newRow} exporting={exporting} onExport={exportCsv} onRemove={onRemove} />
      {c.hasDraft && (
        <div className="banner banner-info small">
          You are viewing this base with temporary filters and sorting. Only you can see these changes.
          <button type="button" className="link-button" onClick={c.resetDraft}>
            Reset
          </button>
        </div>
      )}
      {c.view.type === "kanban" ? (
        <KanbanView key={c.view.id} c={c} onOpenRow={(row) => setOpenRow(row.id)} />
      ) : c.view.type === "calendar" ? (
        <CalendarView key={c.view.id} c={c} onOpenRow={(row) => setOpenRow(row.id)} />
      ) : (
        <TableView key={c.view.id} c={c} embedded={embedded} onOpenRow={(row) => setOpenRow(row.id)} onEditProperty={setEditingProp} onAddChoice={addChoice} />
      )}
      {openRow && <RowModal c={c} rowId={openRow} onNavigate={setOpenRow} onClose={() => setOpenRow(null)} onAddChoice={addChoice} />}
      {editingProp !== undefined && (
        <PropertyEditor
          property={editingProp}
          properties={c.base.properties}
          onClose={() => setEditingProp(undefined)}
          onSave={async (body) => !!(await c.saveProperty(editingProp, body))}
          onDelete={
            editingProp
              ? async () => {
                  const ok = await confirm({ title: `Delete "${editingProp.name}"?`, message: "All of its values will be deleted. This cannot be undone.", confirmLabel: "Delete", danger: true });
                  if (!ok) return;
                  setEditingProp(undefined);
                  void c.deleteProperty(editingProp);
                }
              : undefined
          }
        />
      )}
    </div>
  );
};
