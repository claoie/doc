import { useEffect, useRef, useState } from "react";
import {
  columnKind,
  DATE_RANGES,
  isFilterGroup,
  RELATIVE_DAYS,
  type DateFilterValue,
  type FilterCondition,
  type FilterGroup,
  type FilterOperator,
  type Property,
  type View,
} from "common/bases";
import { Icon } from "../components/Icon";
import { Menu, Popover, cx, useConfirm, type MenuItem } from "../components/ui";
import { ChoiceBadge, PersonPicker, TYPE_ICONS } from "./cells";
import { choicesOf, groupCandidates, groupProperty, orderedProperties, SORTABLE } from "./format";
import type { BaseController } from "./useBase";

const OP_LABELS: Record<FilterOperator, string> = {
  eq: "is",
  neq: "is not",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "contains",
  ncontains: "does not contain",
  startsWith: "starts with",
  endsWith: "ends with",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
  before: "is before",
  after: "is after",
  onOrBefore: "is on or before",
  onOrAfter: "is on or after",
  any: "is any of",
  none: "is none of",
  all: "is all of",
  isWithin: "is within",
};

const RELATIVE_LABELS: Record<(typeof RELATIVE_DAYS)[number], string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  yesterday: "Yesterday",
  oneWeekAgo: "One week ago",
  oneWeekFromNow: "One week from now",
  oneMonthAgo: "One month ago",
  oneMonthFromNow: "One month from now",
};

const RANGE_LABELS: Record<(typeof DATE_RANGES)[number], string> = {
  pastWeek: "Past week",
  pastMonth: "Past month",
  pastYear: "Past year",
  thisWeek: "This week",
  thisMonth: "This month",
  thisYear: "This year",
  nextWeek: "Next week",
  nextMonth: "Next month",
  nextYear: "Next year",
};

/** Operators offered in the UI for a property. */
export const operatorsFor = (prop: Property): FilterOperator[] => {
  if (prop.type === "select" || prop.type === "status" || prop.type === "lastEditedBy" || (prop.type === "person" && !prop.options.allowMultiple)) {
    return ["any", "none", "isEmpty", "isNotEmpty"];
  }
  if (prop.type === "multiSelect" || prop.type === "person") return ["any", "all", "none", "isEmpty", "isNotEmpty"];
  if (prop.type === "file") return ["contains", "ncontains", "isEmpty", "isNotEmpty"];
  switch (columnKind(prop)) {
    case "number":
      return ["eq", "neq", "gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"];
    case "flag":
      return ["eq", "neq"];
    case "time":
      return ["isWithin", "eq", "neq", "before", "after", "onOrBefore", "onOrAfter", "isEmpty", "isNotEmpty"];
  }
  return ["contains", "ncontains", "eq", "neq", "startsWith", "endsWith", "isEmpty", "isNotEmpty"];
};

type InputKind = "text" | "number" | "flag" | "date" | "choices" | "people" | "none";

const inputKind = (prop: Property, op: FilterOperator): InputKind => {
  if (op === "isEmpty" || op === "isNotEmpty") return "none";
  if (prop.type === "select" || prop.type === "status" || prop.type === "multiSelect") return "choices";
  if (prop.type === "person" || prop.type === "lastEditedBy") return "people";
  if (prop.type === "file") return "text";
  switch (columnKind(prop)) {
    case "number":
      return "number";
    case "flag":
      return "flag";
    case "time":
      return "date";
  }
  return "text";
};

const defaultValue = (kind: InputKind): unknown => {
  switch (kind) {
    case "flag":
      return true;
    case "date":
      return { mode: "relative", preset: "today" } satisfies DateFilterValue;
    case "choices":
    case "people":
      return [];
  }
  return "";
};

const countConditions = (group?: FilterGroup): number =>
  group ? group.children.reduce((n, c) => n + (isFilterGroup(c) ? countConditions(c) : 1), 0) : 0;

const DebouncedInput = ({ value, onChange, type }: { value: string; onChange: (v: string) => void; type: "text" | "number" }) => {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => setText(value), [value]);
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );
  return (
    <input
      className="input input-sm"
      type={type}
      value={text}
      placeholder="Value"
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => latest.current(v), 300);
      }}
      onBlur={() => {
        clearTimeout(timer.current);
        if (text !== value) latest.current(text);
      }}
    />
  );
};

const DateValue = ({ value, onChange }: { value: unknown; onChange: (v: DateFilterValue) => void }) => {
  const v: DateFilterValue = value && typeof value === "object" ? (value as DateFilterValue) : typeof value === "string" ? { mode: "exact", date: value } : { mode: "relative", preset: "today" };
  return (
    <div className="filter-date">
      <select
        className="input input-sm"
        value={v.mode}
        onChange={(e) => {
          const mode = e.target.value as DateFilterValue["mode"];
          onChange(mode === "exact" ? { mode, date: new Date().toISOString().slice(0, 10) } : mode === "relative" ? { mode, preset: "today" } : { mode, preset: "thisWeek" });
        }}
      >
        <option value="relative">Relative</option>
        <option value="exact">Exact date</option>
        <option value="range">Range</option>
      </select>
      {v.mode === "exact" && <input className="input input-sm" type="date" value={v.date} onChange={(e) => onChange({ mode: "exact", date: e.target.value })} />}
      {v.mode === "relative" && (
        <select className="input input-sm" value={v.preset} onChange={(e) => onChange({ mode: "relative", preset: e.target.value as (typeof RELATIVE_DAYS)[number] })}>
          {RELATIVE_DAYS.map((p) => (
            <option key={p} value={p}>
              {RELATIVE_LABELS[p]}
            </option>
          ))}
        </select>
      )}
      {v.mode === "range" && (
        <select className="input input-sm" value={v.preset} onChange={(e) => onChange({ mode: "range", preset: e.target.value as (typeof DATE_RANGES)[number] })}>
          {DATE_RANGES.map((p) => (
            <option key={p} value={p}>
              {RANGE_LABELS[p]}
            </option>
          ))}
        </select>
      )}
    </div>
  );
};

const PeopleValue = ({ value, onChange, c }: { value: unknown; onChange: (v: string[]) => void; c: BaseController }) => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const ids = Array.isArray(value) ? (value as string[]) : [];
  return (
    <>
      <button type="button" className="input input-sm filter-people" onClick={(e) => setAnchor(e.currentTarget)}>
        {ids.length ? ids.map((id) => c.references.users[id]?.name ?? "Unknown").join(", ") : "Select people"}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={260}>
          <PersonPicker value={ids} multiple onChange={(v) => onChange(Array.isArray(v) ? v : v ? [String(v)] : [])} onClose={() => setAnchor(null)} onUsers={(users) => c.addReferences({ users })} />
        </Popover>
      )}
    </>
  );
};

const ConditionRow = ({ condition, props, onChange, onRemove, c }: { condition: FilterCondition; props: Property[]; onChange: (c: FilterCondition) => void; onRemove: () => void; c: BaseController }) => {
  const prop = props.find((p) => p.id === condition.propertyId);
  const kind = prop ? inputKind(prop, condition.op) : "none";
  return (
    <div className="filter-row">
      <div className="filter-row-head">
        <select
          className="input input-sm"
          value={prop ? prop.id : ""}
          onChange={(e) => {
            const next = props.find((p) => p.id === e.target.value)!;
            const op = operatorsFor(next)[0]!;
            onChange({ propertyId: next.id, op, value: defaultValue(inputKind(next, op)) });
          }}
        >
          {!prop && <option value="">Deleted property</option>}
          {props.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {prop && (
          <select
            className="input input-sm"
            value={condition.op}
            onChange={(e) => {
              const op = e.target.value as FilterOperator;
              const nextKind = inputKind(prop, op);
              onChange({ ...condition, op, value: nextKind === kind ? condition.value : defaultValue(nextKind) });
            }}
          >
            {operatorsFor(prop).map((op) => (
              <option key={op} value={op}>
                {OP_LABELS[op]}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="icon-button" aria-label="Remove filter" onClick={onRemove}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {prop && kind === "text" && <DebouncedInput type="text" value={typeof condition.value === "string" ? condition.value : ""} onChange={(v) => onChange({ ...condition, value: v })} />}
      {prop && kind === "number" && (
        <DebouncedInput type="number" value={condition.value === undefined || condition.value === null ? "" : String(condition.value)} onChange={(v) => onChange({ ...condition, value: v === "" ? "" : Number(v) })} />
      )}
      {prop && kind === "flag" && (
        <select className="input input-sm" value={condition.value === false || condition.value === "false" ? "false" : "true"} onChange={(e) => onChange({ ...condition, value: e.target.value === "true" })}>
          <option value="true">Checked</option>
          <option value="false">Unchecked</option>
        </select>
      )}
      {prop && kind === "date" && <DateValue value={condition.value} onChange={(v) => onChange({ ...condition, value: v })} />}
      {prop && kind === "choices" && (
        <div className="cell-choices filter-choices">
          {choicesOf(prop).map((choice) => {
            const list = Array.isArray(condition.value) ? (condition.value as string[]) : [];
            const on = list.includes(choice.id);
            return (
              <button key={choice.id} type="button" className={cx("chip-toggle", on && "on")} onClick={() => onChange({ ...condition, value: on ? list.filter((x) => x !== choice.id) : [...list, choice.id] })}>
                <ChoiceBadge choice={choice} plain={prop.options.disableColors} />
              </button>
            );
          })}
        </div>
      )}
      {prop && kind === "people" && <PeopleValue value={condition.value} onChange={(v) => onChange({ ...condition, value: v })} c={c} />}
    </div>
  );
};

const FilterPanel = ({ c }: { c: BaseController }) => {
  const props = c.base!.properties;
  const group: FilterGroup = c.config.filter ?? { op: "and", children: [] };
  const save = (next: FilterGroup) => c.patchConfig({ filter: next.children.length ? next : null });
  const conditions = group.children;
  return (
    <div className="filter-panel">
      {conditions.length === 0 && <div className="muted pad-sm">No filters applied</div>}
      {conditions.length > 1 && (
        <div className="segmented small">
          {(["and", "or"] as const).map((op) => (
            <button key={op} type="button" className={cx(group.op === op && "active")} onClick={() => save({ ...group, op })}>
              {op === "and" ? "All" : "Any"}
            </button>
          ))}
        </div>
      )}
      {conditions.map((child, i) =>
        isFilterGroup(child) ? (
          <div key={i} className="filter-row filter-advanced">
            <span>Advanced group ({countConditions(child)} conditions)</span>
            <button type="button" className="icon-button" aria-label="Remove group" onClick={() => save({ ...group, children: conditions.filter((_, j) => j !== i) })}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ) : (
          <ConditionRow
            key={i}
            condition={child}
            props={props}
            c={c}
            onChange={(next) => save({ ...group, children: conditions.map((x, j) => (j === i ? next : x)) })}
            onRemove={() => save({ ...group, children: conditions.filter((_, j) => j !== i) })}
          />
        ),
      )}
      <div className="popover-foot">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!props.length}
          onClick={() => {
            const prop = props[0]!;
            const op = operatorsFor(prop)[0]!;
            save({ ...group, children: [...conditions, { propertyId: prop.id, op, value: defaultValue(inputKind(prop, op)) }] });
          }}
        >
          <Icon name="plus" size={14} /> Add filter
        </button>
        {conditions.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => c.patchConfig({ filter: null })}>
            Clear all
          </button>
        )}
      </div>
    </div>
  );
};

const SortPanel = ({ c }: { c: BaseController }) => {
  const props = c.base!.properties.filter(SORTABLE);
  const ids = new Set(props.map((p) => p.id));
  const sorts = (c.config.sorts ?? []).filter((s) => ids.has(s.propertyId));
  const save = (next: typeof sorts) => c.patchConfig({ sorts: next.length ? next : null });
  const unused = props.filter((p) => !sorts.some((s) => s.propertyId === p.id));
  return (
    <div className="filter-panel">
      {sorts.length === 0 && <div className="muted pad-sm">No sorts applied</div>}
      {sorts.map((s, i) => (
        <div key={s.propertyId} className="filter-row-head">
          <select className="input input-sm" value={s.propertyId} onChange={(e) => save(sorts.map((x, j) => (j === i ? { ...x, propertyId: e.target.value } : x)))}>
            {props
              .filter((p) => p.id === s.propertyId || !sorts.some((x) => x.propertyId === p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <div className="segmented small">
            {(["asc", "desc"] as const).map((d) => (
              <button key={d} type="button" className={cx(s.direction === d && "active")} onClick={() => save(sorts.map((x, j) => (j === i ? { ...x, direction: d } : x)))}>
                {d === "asc" ? "Ascending" : "Descending"}
              </button>
            ))}
          </div>
          <button type="button" className="icon-button" aria-label="Move up" disabled={i === 0} onClick={() => save(sorts.map((x, j) => (j === i - 1 ? sorts[i]! : j === i ? sorts[i - 1]! : x)))}>
            <Icon name="arrowUp" size={13} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Move down"
            disabled={i === sorts.length - 1}
            onClick={() => save(sorts.map((x, j) => (j === i + 1 ? sorts[i]! : j === i ? sorts[i + 1]! : x)))}
          >
            <Icon name="arrowDown" size={13} />
          </button>
          <button type="button" className="icon-button" aria-label="Remove sort" onClick={() => save(sorts.filter((_, j) => j !== i))}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      <div className="popover-foot">
        <button type="button" className="btn btn-ghost btn-sm" disabled={!unused.length || sorts.length >= 10} onClick={() => save([...sorts, { propertyId: unused[0]!.id, direction: "asc" }])}>
          <Icon name="plus" size={14} /> Add sort
        </button>
        {sorts.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => c.patchConfig({ sorts: null })}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
};

const PropertiesPanel = ({ c, kanban }: { c: BaseController; kanban: boolean }) => {
  const props = orderedProperties(c.base!.properties, c.config).filter((p) => !p.isPrimary);
  const hidden = new Set(c.config.hiddenPropertyIds ?? []);
  const visible = new Set(c.config.visiblePropertyIds ?? []);
  const shown = (p: Property) => (kanban ? visible.has(p.id) : !hidden.has(p.id));
  const setShown = (ids: string[], on: boolean) => {
    if (kanban) {
      const next = new Set(visible);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      c.patchConfig({ visiblePropertyIds: [...next] });
    } else {
      const next = new Set(hidden);
      ids.forEach((id) => (on ? next.delete(id) : next.add(id)));
      c.patchConfig({ hiddenPropertyIds: [...next] });
    }
  };
  const count = props.filter(shown).length;
  return (
    <div className="filter-panel">
      <div className="popover-foot">
        <span className="muted small">{kanban ? `${count} shown on cards` : `${count} of ${props.length} shown`}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShown(props.map((p) => p.id), true)}>
          Show all
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShown(props.map((p) => p.id), false)}>
          Hide all
        </button>
      </div>
      {props.map((p) => (
        <label key={p.id} className="check-row">
          <input type="checkbox" checked={shown(p)} onChange={(e) => setShown([p.id], e.target.checked)} />
          <Icon name={TYPE_ICONS[p.type]} size={14} />
          <span className="ellipsis">{p.name}</span>
        </label>
      ))}
    </div>
  );
};

const ViewTabs = ({ c }: { c: BaseController }) => {
  const confirm = useConfirm();
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const views = c.base!.views;
  const add = (type: View["type"]) => {
    const group = groupCandidates(c.base!.properties)[0];
    const date = c.base!.properties.find((p) => p.type === "date");
    const name = type === "table" ? "Table" : type === "kanban" ? "Board" : "Calendar";
    void c.createView(name, type, type === "kanban" && group ? { groupByPropertyId: group.id } : type === "calendar" && date ? { datePropertyId: date.id } : {});
  };
  return (
    <div className="view-tabs">
      {views.map((v) =>
        renaming === v.id ? (
          <input
            key={v.id}
            className="input input-sm view-rename"
            autoFocus
            defaultValue={v.name}
            maxLength={200}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== v.name) void c.renameView(v, name);
              setRenaming(null);
            }}
          />
        ) : (
          <button
            key={v.id}
            type="button"
            className={cx("view-tab", c.view?.id === v.id && "active")}
            onClick={(e) => {
              if (c.view?.id !== v.id) return c.setViewId(v.id);
              if (!c.canEdit) return;
              setMenu({
                anchor: e.currentTarget,
                items: [
                  { label: "Rename", icon: "edit", onSelect: () => setRenaming(v.id) },
                  {
                    label: "Delete view",
                    icon: "trash",
                    danger: true,
                    disabled: views.length <= 1,
                    onSelect: async () => {
                      const ok = await confirm({ title: `Delete the view "${v.name}"?`, message: "Rows are not affected.", confirmLabel: "Delete", danger: true });
                      if (ok) void c.deleteView(v);
                    },
                  },
                ],
              });
            }}
          >
            <Icon name={v.type === "kanban" ? "kanban" : v.type === "calendar" ? "calendar" : "table"} size={14} />
            {v.name}
          </button>
        ),
      )}
      {c.canEdit && (
        <button
          type="button"
          className="icon-button"
          aria-label="Add view"
          onClick={(e) =>
            setMenu({
              anchor: e.currentTarget,
              items: [
                { label: "Table", icon: "table", onSelect: () => add("table") },
                { label: "Board", icon: "kanban", onSelect: () => add("kanban") },
                { label: "Calendar", icon: "calendar", onSelect: () => add("calendar") },
              ],
            })
          }
        >
          <Icon name="plus" size={15} />
        </button>
      )}
      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
};

export const Toolbar = ({ c, onNew, exporting, onExport, onRemove }: { c: BaseController; onNew: () => void; exporting: boolean; onExport: () => void; onRemove?: () => void }) => {
  const [panel, setPanel] = useState<{ kind: "filter" | "sort" | "props"; anchor: HTMLElement } | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);
  const view = c.view!;
  const props = c.base!.properties;
  const filters = countConditions(c.config.filter);
  const sorts = (c.config.sorts ?? []).length;
  const toggle = (kind: "filter" | "sort" | "props", el: HTMLElement) => setPanel((p) => (p?.kind === kind ? null : { kind, anchor: el }));
  const group = view.type === "kanban" ? groupProperty(props, view) : undefined;
  const dateProp = view.type === "calendar" ? props.find((p) => p.id === c.config.datePropertyId && (p.type === "date" || p.type === "createdAt" || p.type === "lastEditedAt")) ?? props.find((p) => p.type === "date") : undefined;
  return (
    <div className="base-toolbar">
      <ViewTabs c={c} />
      <div className="base-toolbar-actions">
        {view.type === "kanban" && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={(e) =>
              setMenu({
                anchor: e.currentTarget,
                items: groupCandidates(props).length
                  ? groupCandidates(props).map((p) => ({ label: p.name, checked: p.id === group?.id, onSelect: () => c.patchConfig({ groupByPropertyId: p.id }) }))
                  : [{ label: "Add a select or status property to group by", disabled: true }],
              })
            }
          >
            Group: {group?.name ?? "None"}
          </button>
        )}
        {view.type === "calendar" && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={(e) => {
              const dates = props.filter((p) => p.type === "date" || p.type === "createdAt" || p.type === "lastEditedAt");
              setMenu({
                anchor: e.currentTarget,
                items: dates.length ? dates.map((p) => ({ label: p.name, checked: p.id === dateProp?.id, onSelect: () => c.patchConfig({ datePropertyId: p.id }) })) : [{ label: "Add a date property", disabled: true }],
              });
            }}
          >
            Date: {dateProp?.name ?? "None"}
          </button>
        )}
        <button type="button" className={cx("btn btn-ghost btn-sm", filters > 0 && "lit")} onClick={(e) => toggle("filter", e.currentTarget)}>
          <Icon name="filter" size={14} /> Filter{filters ? ` · ${filters}` : ""}
        </button>
        <button type="button" className={cx("btn btn-ghost btn-sm", sorts > 0 && "lit")} onClick={(e) => toggle("sort", e.currentTarget)}>
          <Icon name="sort" size={14} /> Sort{sorts ? ` · ${sorts}` : ""}
        </button>
        {view.type !== "calendar" && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={(e) => toggle("props", e.currentTarget)}>
            <Icon name="eye" size={14} /> {view.type === "kanban" ? "Card properties" : "Properties"}
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="More"
          onClick={(e) =>
            setMenu({
              anchor: e.currentTarget,
              items: [
                { label: exporting ? "Exporting…" : "Export CSV", icon: "download", disabled: exporting, onSelect: onExport },
                ...(onRemove ? [{ label: "Remove from page", icon: "trash" as const, onSelect: onRemove }] : []),
              ],
            })
          }
        >
          <Icon name="more" size={16} />
        </button>
        {c.canEdit && (
          <button type="button" className="btn btn-primary btn-sm" onClick={onNew}>
            New
          </button>
        )}
      </div>
      {panel && (
        <Popover anchor={panel.anchor} onClose={() => setPanel(null)} align="right" width={panel.kind === "props" ? 280 : 400}>
          {panel.kind === "filter" ? <FilterPanel c={c} /> : panel.kind === "sort" ? <SortPanel c={c} /> : <PropertiesPanel c={c} kanban={view.type === "kanban"} />}
        </Popover>
      )}
      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} align="right" />}
    </div>
  );
};
