import { useEffect, useMemo, useState } from "react";
import type { Row } from "common/bases";
import { Icon } from "../components/Icon";
import { Popover, cx } from "../components/ui";
import { cellToText, dayKey, parseDate, readCell } from "./format";
import type { BaseController } from "./useBase";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const CalendarView = ({ c, onOpenRow }: { c: BaseController; onOpenRow: (row: Row) => void }) => {
  const base = c.base!;
  const prop =
    base.properties.find((p) => p.id === c.config.datePropertyId && (p.type === "date" || p.type === "createdAt" || p.type === "lastEditedAt")) ??
    base.properties.find((p) => p.type === "date");
  const primary = base.properties.find((p) => p.isPrimary);
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [drag, setDrag] = useState<string | null>(null);
  const [unscheduled, setUnscheduled] = useState<HTMLElement | null>(null);
  const { loadAll } = c;

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const days = useMemo(() => {
    const offset = (month.getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => new Date(month.getFullYear(), month.getMonth(), 1 - offset + i));
  }, [month]);

  const byDay = useMemo(() => {
    const map = new Map<string, Row[]>();
    const none: Row[] = [];
    for (const row of c.rows) {
      const parsed = prop ? parseDate(readCell(prop, row)) : null;
      if (!parsed) {
        none.push(row);
        continue;
      }
      const key = dayKey(parsed.date);
      map.set(key, [...(map.get(key) ?? []), row]);
    }
    return { map, none };
  }, [c.rows, prop]);

  if (!prop) return <div className="empty-hint">Add a date property to use the calendar view.</div>;

  const editable = c.canEdit && prop.type === "date";
  const title = (row: Row) => (primary && cellToText(primary, row, c.references)) || "Untitled";
  const setDay = (row: Row, day: Date) => {
    const current = parseDate(row.cells[prop.id]);
    let value = dayKey(day);
    if (current && !current.dateOnly) {
      const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), current.date.getHours(), current.date.getMinutes());
      value = d.toISOString();
    }
    void c.updateCells(row, { [prop.id]: value });
  };
  const today = dayKey(new Date());

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button type="button" className="icon-button" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <strong>
          {MONTHS[month.getMonth()]} {month.getFullYear()}
        </strong>
        <button type="button" className="icon-button" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
          <Icon name="chevronRight" size={16} />
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
          Today
        </button>
        <span className="spacer" />
        {byDay.none.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={(e) => setUnscheduled(e.currentTarget)}>
            No date ({byDay.none.length})
          </button>
        )}
      </div>
      <div className="calendar-grid">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="calendar-dow">
            {d}
          </div>
        ))}
        {days.map((day) => {
          const key = dayKey(day);
          const rows = byDay.map.get(key) ?? [];
          return (
            <div
              key={key}
              className={cx("calendar-day", day.getMonth() !== month.getMonth() && "other", key === today && "today")}
              onDragOver={(e) => drag && editable && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const row = c.rows.find((r) => r.id === drag);
                if (row) setDay(row, day);
                setDrag(null);
              }}
            >
              <div className="calendar-day-head">
                <span>{day.getDate()}</span>
                {editable && (
                  <button
                    type="button"
                    className="icon-button calendar-add"
                    aria-label={`New row on ${key}`}
                    onClick={async () => {
                      const row = await c.createRow({ [prop.id]: key });
                      if (row) onOpenRow(row);
                    }}
                  >
                    <Icon name="plus" size={13} />
                  </button>
                )}
              </div>
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="calendar-item"
                  draggable={editable}
                  onDragStart={(e) => {
                    setDrag(row.id);
                    e.dataTransfer.setData("text/plain", row.id);
                  }}
                  onDragEnd={() => setDrag(null)}
                  onClick={() => onOpenRow(row)}
                >
                  {title(row)}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      {unscheduled && (
        <Popover anchor={unscheduled} onClose={() => setUnscheduled(null)} align="right" width={260}>
          <div className="search-list-items">
            {byDay.none.map((row) => (
              <button
                key={row.id}
                type="button"
                className="search-list-item"
                onClick={() => {
                  setUnscheduled(null);
                  onOpenRow(row);
                }}
              >
                {title(row)}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
};
