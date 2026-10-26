import { NO_VALUE, type Choice, type Property, type Row, type RowReferences, type View, type ViewConfig } from "common/bases";
import { isErrorValue } from "common/formula";

export const DEFAULT_WIDTH = 180;
export const PRIMARY_WIDTH = 260;
export const MIN_WIDTH = 80;
export const MAX_WIDTH = 1200;

export const DATE_FORMATS = ["MMM d, yyyy", "MMMM d, yyyy", "yyyy-MM-dd", "MM/dd/yyyy", "dd/MM/yyyy", "d MMM yyyy"] as const;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` values are calendar days; anything else is an instant shown in local time. */
export const parseDate = (value: unknown): { date: Date; dateOnly: boolean } | null => {
  if (typeof value !== "string" || !value) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (day) return { date: new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])), dateOnly: true };
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : { date: new Date(t), dateOnly: false };
};

export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Formats with the tokens yyyy, MMMM, MMM, MM, dd, d. */
export const formatPattern = (d: Date, pattern: string) =>
  pattern.replace(/yyyy|MMMM|MMM|MM|dd|d/g, (token) => {
    switch (token) {
      case "yyyy":
        return String(d.getFullYear());
      case "MMMM":
        return MONTHS[d.getMonth()]!;
      case "MMM":
        return MONTHS[d.getMonth()]!.slice(0, 3);
      case "MM":
        return pad(d.getMonth() + 1);
      case "dd":
        return pad(d.getDate());
      default:
        return String(d.getDate());
    }
  });

const formatTime = (d: Date, twelve: boolean) => {
  if (!twelve) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const h = d.getHours() % 12 || 12;
  return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
};

export const formatDate = (value: unknown, prop: Pick<Property, "options">): string => {
  const parsed = parseDate(value);
  if (!parsed) return typeof value === "string" ? value : "";
  const pattern = DATE_FORMATS.includes(prop.options.dateFormat as never) ? prop.options.dateFormat! : DATE_FORMATS[0];
  const text = formatPattern(parsed.date, pattern);
  if (!prop.options.includeTime || parsed.dateOnly) return text;
  return `${text} ${formatTime(parsed.date, prop.options.timeFormat !== "24h")}`;
};

export const formatTimestamp = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${formatPattern(d, "MMM d, yyyy")} ${formatTime(d, true)}`;
};

export const formatNumber = (value: unknown, prop: Pick<Property, "options">): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) return value === null || value === undefined ? "" : String(value);
  const o = prop.options;
  const precision = typeof o.precision === "number" ? Math.max(0, Math.min(20, o.precision)) : undefined;
  const digits = precision === undefined ? { maximumFractionDigits: 10 } : { minimumFractionDigits: precision, maximumFractionDigits: precision };
  switch (o.format) {
    case "currency":
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: o.currencyCode || "USD", ...(precision === undefined ? {} : digits) }).format(value);
      } catch {
        return `${o.currencySymbol || o.currencyCode || ""} ${new Intl.NumberFormat(undefined, digits).format(value)}`.trim();
      }
    case "percent":
      return `${new Intl.NumberFormat(undefined, digits).format(value)}%`;
    case "progress":
      return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
  }
  return new Intl.NumberFormat(undefined, digits).format(value);
};

export const choicesOf = (prop: Property): Choice[] => {
  const choices = prop.options.choices ?? [];
  const order = prop.options.choiceOrder ?? [];
  const byId = new Map(choices.map((c) => [c.id, c]));
  const ordered = order.flatMap((id) => byId.get(id) ?? []);
  return [...ordered, ...choices.filter((c) => !order.includes(c.id))];
};

export const listOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : []);

/** The raw value a cell shows: system columns read from row metadata. */
export const readCell = (prop: Property, row: Row): unknown => {
  switch (prop.type) {
    case "createdAt":
      return row.createdAt;
    case "lastEditedAt":
      return row.updatedAt;
    case "lastEditedBy":
      return row.lastEditorId ?? row.creatorId;
  }
  return row.cells[prop.id];
};

export const isEmptyValue = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Plain text of a cell for copying, card titles and tooltips. */
export const cellToText = (prop: Property, row: Row, refs: RowReferences): string => {
  const value = readCell(prop, row);
  switch (prop.type) {
    case "checkbox":
      return value === true ? "true" : "false";
    case "createdAt":
    case "lastEditedAt":
      return formatTimestamp(String(value));
    case "lastEditedBy":
    case "person":
      return listOf(value).map((id) => refs.users[id]?.name ?? "").filter(Boolean).join(", ");
    case "select":
    case "status":
    case "multiSelect": {
      const choices = prop.options.choices ?? [];
      return listOf(value).map((id) => choices.find((c) => c.id === id)?.name ?? "").filter(Boolean).join(", ");
    }
    case "page":
      return typeof value === "string" && refs.pages[value] ? refs.pages[value]!.title || "Untitled" : "";
    case "file":
      return Array.isArray(value) ? value.map((f: { fileName?: string }) => f.fileName ?? "").join(", ") : "";
    case "number":
      return formatNumber(value, prop);
    case "date":
      return formatDate(value, prop);
    case "formula":
      if (isErrorValue(value)) return "#ERROR";
      if (prop.options.resultType === "number") return formatNumber(value, prop);
      return value === null || value === undefined ? "" : String(value);
  }
  return value === null || value === undefined ? "" : String(value);
};

/** Columns in view order: primary first, then the view's order, then the rest by position. */
export const orderedProperties = (props: Property[], config: ViewConfig): Property[] => {
  const primary = props.find((p) => p.isPrimary);
  const rest = props.filter((p) => !p.isPrimary);
  const order = config.propertyOrder ?? [];
  const byId = new Map(rest.map((p) => [p.id, p]));
  const listed = order.flatMap((id) => byId.get(id) ?? []);
  return [...(primary ? [primary] : []), ...listed, ...rest.filter((p) => !order.includes(p.id))];
};

export const visibleColumns = (props: Property[], config: ViewConfig): Property[] => {
  const hidden = new Set(config.hiddenPropertyIds ?? []);
  return orderedProperties(props, config).filter((p) => p.isPrimary || !hidden.has(p.id));
};

export const columnWidth = (prop: Property, config: ViewConfig) =>
  Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, config.propertyWidths?.[prop.id] ?? (prop.isPrimary ? PRIMARY_WIDTH : DEFAULT_WIDTH)));

export const groupCandidates = (props: Property[]) => props.filter((p) => p.type === "select" || p.type === "status");

export const groupProperty = (props: Property[], view: View): Property | undefined => {
  const candidates = groupCandidates(props);
  return candidates.find((p) => p.id === view.config.groupByPropertyId) ?? candidates[0];
};

export const kanbanColumns = (prop: Property, config: ViewConfig): string[] => {
  const all = choicesOf(prop).map((c) => c.id);
  const order = (config.choiceOrder ?? []).filter((id) => all.includes(id));
  return [...order, ...all.filter((id) => !order.includes(id)), NO_VALUE];
};

export const moveInList = (list: string[], id: string, targetId: string, edge: "before" | "after"): string[] => {
  const out = list.filter((x) => x !== id);
  const index = out.indexOf(targetId);
  if (index < 0) return [...out, id];
  out.splice(edge === "before" ? index : index + 1, 0, id);
  return out;
};

export const SORTABLE = (p: Property) => p.type !== "file";

export const newRequestId = () => `r${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
