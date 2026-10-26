import type { UserRef } from "./api-types";

export const PROPERTY_TYPES = [
  "text",
  "longText",
  "number",
  "select",
  "status",
  "multiSelect",
  "date",
  "person",
  "file",
  "page",
  "checkbox",
  "url",
  "email",
  "createdAt",
  "lastEditedAt",
  "lastEditedBy",
  "formula",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/** Values come from row metadata, never from cells. */
export const SYSTEM_TYPES: readonly PropertyType[] = ["createdAt", "lastEditedAt", "lastEditedBy"];
export const isSystemType = (type: PropertyType) => SYSTEM_TYPES.includes(type);
/** Types whose cells a user can edit. */
export const isEditableType = (type: PropertyType) => type !== "formula" && !isSystemType(type);
export const isChoiceType = (type: PropertyType) => type === "select" || type === "status" || type === "multiSelect";

export type StatusGroup = "todo" | "inProgress" | "complete";

export interface Choice {
  id: string;
  name: string;
  color: string;
  /** Only meaningful for status properties. */
  category?: StatusGroup;
}

export type NumberFormat = "plain" | "currency" | "percent" | "progress";
export type FormulaResultType = "number" | "string" | "boolean" | "date" | "null";

/** Per-type settings; unknown keys are kept so newer clients can add their own. */
export interface PropertyOptions {
  choices?: Choice[];
  choiceOrder?: string[];
  disableColors?: boolean;
  format?: NumberFormat;
  precision?: number;
  separators?: string;
  currencyCode?: string;
  currencySymbol?: string;
  dateFormat?: string;
  timeFormat?: "12h" | "24h";
  includeTime?: boolean;
  allowMultiple?: boolean;
  richText?: boolean;
  source?: string;
  resultType?: FormulaResultType;
  dependencies?: string[];
  defaultValue?: unknown;
  [key: string]: unknown;
}

export interface Property {
  id: string;
  name: string;
  type: PropertyType;
  options: PropertyOptions;
  isPrimary: boolean;
  position: string;
}

export interface FileValue {
  id: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
  url?: string;
}

export interface Row {
  id: string;
  cells: Record<string, unknown>;
  position: string;
  creatorId: string | null;
  lastEditorId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ViewType = "table" | "kanban" | "calendar";
export const VIEW_TYPES: readonly ViewType[] = ["table", "kanban", "calendar"];

export interface Sort {
  propertyId: string;
  direction: "asc" | "desc";
}

export const FILTER_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "ncontains",
  "startsWith",
  "endsWith",
  "isEmpty",
  "isNotEmpty",
  "before",
  "after",
  "onOrBefore",
  "onOrAfter",
  "any",
  "none",
  "all",
  "isWithin",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export const RELATIVE_DAYS = ["today", "tomorrow", "yesterday", "oneWeekAgo", "oneWeekFromNow", "oneMonthAgo", "oneMonthFromNow"] as const;
export const DATE_RANGES = ["pastWeek", "pastMonth", "pastYear", "thisWeek", "thisMonth", "thisYear", "nextWeek", "nextMonth", "nextYear"] as const;

export type DateFilterValue =
  | { mode: "exact"; date: string }
  | { mode: "relative"; preset: (typeof RELATIVE_DAYS)[number] }
  | { mode: "range"; preset: (typeof DATE_RANGES)[number] };

export interface FilterCondition {
  propertyId: string;
  op: FilterOperator;
  value?: unknown;
}

export interface FilterGroup {
  op: "and" | "or";
  children: (FilterCondition | FilterGroup)[];
}

export const isFilterGroup = (node: FilterCondition | FilterGroup): node is FilterGroup => "children" in node;

export interface ViewConfig {
  sorts?: Sort[];
  filter?: FilterGroup;
  /** Table columns left out of the view. */
  hiddenPropertyIds?: string[];
  /** Fields shown on kanban cards. */
  visiblePropertyIds?: string[];
  propertyOrder?: string[];
  propertyWidths?: Record<string, number>;
  /** Kanban columns and calendar placement. */
  groupByPropertyId?: string;
  datePropertyId?: string;
  hiddenChoiceIds?: string[];
  choiceOrder?: string[];
  [key: string]: unknown;
}

/** Kanban column for rows without a value. */
export const NO_VALUE = "__no_value";

export interface View {
  id: string;
  name: string;
  type: ViewType;
  config: ViewConfig;
  position: string;
}

export interface Base {
  id: string;
  slugId: string;
  spaceId: string;
  title: string | null;
  icon: string | null;
  properties: Property[];
  views: View[];
  canEdit: boolean;
}

export interface ResolvedPage {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  spaceSlug: string;
}

export interface RowReferences {
  users: Record<string, UserRef>;
  pages: Record<string, ResolvedPage>;
}

export interface RowsPage {
  items: Row[];
  nextCursor: string | null;
  references: RowReferences;
}

export type BaseEvent =
  | { op: "base"; base: Base }
  | { op: "rowCreated"; row: Row }
  | { op: "rowUpdated"; rowId: string; cells: Record<string, unknown>; position?: string; updatedAt: string; lastEditorId: string }
  | { op: "rowsDeleted"; rowIds: string[] }
  | { op: "rowsChanged" };

export const LIMITS = {
  text: 100_000,
  url: 2048,
  email: 320,
  name: 200,
  choices: 500,
  files: 100,
  rowsPerPage: 500,
  sorts: 10,
  filterChildren: 200,
  formula: 10_000,
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class CellError extends Error {}

const choiceIds = (prop: Property) => new Set((prop.options.choices ?? []).map((c) => c.id));

const asIdList = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.filter((v): v is string => typeof v === "string" && v.length > 0))];
};

/**
 * Validates one incoming cell value against its property and returns what is
 * stored. `null` clears the cell; `undefined` means the key is ignored
 * (properties that are not user-editable).
 */
export const normalizeCell = (prop: Property, value: unknown): unknown => {
  if (!isEditableType(prop.type)) return undefined;
  if (value === null || value === undefined) return null;
  const fail = (detail: string): never => {
    throw new CellError(`Invalid value for "${prop.name}": ${detail}`);
  };
  switch (prop.type) {
    case "text":
    case "longText": {
      const s = typeof value === "string" ? value : String(value);
      if (s.length > LIMITS.text) fail("text too long");
      return s === "" ? null : s;
    }
    case "url": {
      const s = String(value).trim();
      if (!s) return null;
      if (s.length > LIMITS.url || /\s/.test(s)) fail("not a URL");
      return s;
    }
    case "email": {
      const s = String(value).trim();
      if (!s) return null;
      if (s.length > LIMITS.email || !EMAIL_RE.test(s)) fail("not an email address");
      return s;
    }
    case "number": {
      if (typeof value === "string" && value.trim() === "") return null;
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) fail("not a number");
      return n;
    }
    case "checkbox": {
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      if (typeof value === "string") {
        const s = value.trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(s)) return true;
        if (["false", "0", "no", "off", ""].includes(s)) return false;
      }
      return fail("not a checkbox value");
    }
    case "date": {
      const s = value instanceof Date ? value.toISOString() : String(value).trim();
      if (!s) return null;
      if (Number.isNaN(Date.parse(s))) fail("not a date");
      return s;
    }
    case "select":
    case "status": {
      const id = Array.isArray(value) ? value[0] : value;
      if (id === null || id === undefined || id === "") return null;
      if (typeof id !== "string" || !choiceIds(prop).has(id)) fail("unknown option");
      return id;
    }
    case "multiSelect": {
      const ids = asIdList(value);
      const known = choiceIds(prop);
      if (ids.some((id) => !known.has(id))) fail("unknown option");
      return ids.length ? ids : null;
    }
    case "person": {
      const ids = asIdList(value);
      if (ids.some((id) => id.length > 64)) fail("invalid user id");
      if (!ids.length) return null;
      return prop.options.allowMultiple ? ids : ids[0];
    }
    case "page": {
      const s = String(value).trim();
      if (!s) return null;
      if (s.length > 64) fail("invalid page id");
      return s;
    }
    case "file": {
      if (!Array.isArray(value)) return fail("expected a list of files");
      if (value.length > LIMITS.files) fail("too many files");
      const files = value.map((f): FileValue => {
        if (!f || typeof f !== "object") return fail("invalid file");
        const { id, fileName, mimeType, fileSize, url } = f as Record<string, unknown>;
        if (typeof id !== "string" || !id || id.length > 128) return fail("invalid file id");
        if (typeof fileName !== "string" || fileName.length > 1024) return fail("invalid file name");
        if (url !== undefined && (typeof url !== "string" || url.length > LIMITS.url)) return fail("invalid file url");
        return {
          id,
          fileName,
          ...(typeof mimeType === "string" ? { mimeType } : {}),
          ...(typeof fileSize === "number" ? { fileSize } : {}),
          ...(typeof url === "string" ? { url } : {}),
        };
      });
      return files.length ? files : null;
    }
  }
  return undefined;
};

/** Normalizes a patch; unknown and read-only keys are dropped, `null` values remain (they clear). */
export const normalizeCells = (props: Property[], patch: Record<string, unknown>, applyDefaults = false): Record<string, unknown> => {
  const byId = new Map(props.map((p) => [p.id, p]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const prop = byId.get(key);
    if (!prop) continue;
    const normalized = normalizeCell(prop, value);
    if (normalized !== undefined) out[key] = normalized;
  }
  if (applyDefaults) {
    for (const prop of props) {
      const fallback = prop.options.defaultValue;
      if (key(out, prop.id) || fallback === undefined || fallback === null || fallback === "") continue;
      try {
        const normalized = normalizeCell(prop, fallback);
        if (normalized !== undefined && normalized !== null) out[prop.id] = normalized;
      } catch {
        // A default that no longer validates (e.g. a deleted option) is skipped.
      }
    }
  }
  return out;
};

const key = (obj: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(obj, k);

export interface TextContext {
  users?: Record<string, { name: string } | undefined>;
  pages?: Record<string, { title: string | null } | undefined>;
}

/** Number to text without float noise (`0.1 + 0.2` reads `0.3`). */
export const numberText = (n: number): string => {
  if (!Number.isFinite(n)) return "";
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(15)));
};

/** Plain-text rendering of a cell, used by CSV export, search and type conversion. */
export const cellText = (prop: Property, value: unknown, row: Pick<Row, "createdAt" | "updatedAt" | "creatorId" | "lastEditorId">, ctx: TextContext = {}): string => {
  const choiceName = (id: unknown) => prop.options.choices?.find((c) => c.id === id)?.name ?? "";
  const userName = (id: unknown) => (typeof id === "string" ? (ctx.users?.[id]?.name ?? "") : "");
  switch (prop.type) {
    case "createdAt":
      return row.createdAt;
    case "lastEditedAt":
      return row.updatedAt;
    case "lastEditedBy":
      return userName(row.lastEditorId ?? row.creatorId);
    case "checkbox":
      return value === true ? "true" : "false";
  }
  if (value === null || value === undefined) return "";
  switch (prop.type) {
    case "select":
    case "status":
      return choiceName(value);
    case "multiSelect":
      return asIdList(value).map(choiceName).filter(Boolean).join(", ");
    case "person":
      return asIdList(value).map(userName).filter(Boolean).join(", ");
    case "page": {
      const page = typeof value === "string" ? ctx.pages?.[value] : undefined;
      return page ? page.title || "Untitled" : "";
    }
    case "file":
      return Array.isArray(value) ? value.map((f: FileValue) => f?.fileName ?? "").filter(Boolean).join(", ") : "";
    case "number":
      return typeof value === "number" ? numberText(value) : String(value);
    case "formula":
      if (value && typeof value === "object" && "error" in value) return "#ERROR";
      if (typeof value === "number") return numberText(value);
      return String(value);
  }
  return typeof value === "string" ? value : JSON.stringify(value);
};

const URL_RE = /^(https?:\/\/|mailto:|tel:)\S+$/i;

/**
 * Converts a stored cell to another property type. `null` means there is no
 * sensible representation and the cell is cleared.
 */
export const convertCell = (
  value: unknown,
  from: Property,
  to: { type: PropertyType; options: PropertyOptions },
  row: Pick<Row, "createdAt" | "updatedAt" | "creatorId" | "lastEditorId">,
  ctx: TextContext = {},
): unknown => {
  if (value === null || value === undefined) return null;
  if (from.type === to.type) {
    if (to.type === "person") return normalizeCell({ ...from, options: to.options }, value);
    if (isChoiceType(to.type)) {
      const known = new Set((to.options.choices ?? []).map((c) => c.id));
      const ids = asIdList(value).filter((id) => known.has(id));
      if (to.type === "multiSelect") return ids.length ? ids : null;
      return ids[0] ?? null;
    }
    return value;
  }
  // Choice, people and page cells hold ids; convert their display text instead.
  const byReference = isChoiceType(from.type) || from.type === "person" || from.type === "page" || from.type === "lastEditedBy";
  const text = typeof value === "string" && !byReference ? value : cellText(from, value, row, ctx);
  switch (to.type) {
    case "text":
    case "longText": {
      const s = to.type === "text" ? text.slice(0, 2000) : text;
      return s || null;
    }
    case "select":
    case "status":
    case "multiSelect": {
      if (!isChoiceType(from.type)) return null;
      const known = new Set((to.options.choices ?? []).map((c) => c.id));
      const ids = asIdList(value).filter((id) => known.has(id));
      if (to.type === "multiSelect") return ids.length ? ids : null;
      return ids[0] ?? null;
    }
    case "number": {
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      if (typeof value === "boolean") return value ? 1 : 0;
      const cleaned = text.replace(/[,\s]/g, "");
      if (!cleaned) return null;
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    }
    case "date": {
      const s = text.trim();
      return s && !Number.isNaN(Date.parse(s)) ? s : null;
    }
    case "checkbox": {
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      const s = text.trim().toLowerCase();
      if (["yes", "true", "1", "y", "on", "checked"].includes(s)) return true;
      if (["no", "false", "0", "n", "off"].includes(s)) return false;
      return null;
    }
    case "url": {
      const s = text.trim();
      return URL_RE.test(s) && s.length <= LIMITS.url ? s : null;
    }
    case "email": {
      const s = text.trim();
      return EMAIL_RE.test(s) && s.length <= LIMITS.email ? s : null;
    }
  }
  return null;
};

const DAY = 86_400_000;

/**
 * Resolves a date filter value to a half-open range `[start, end)` in epoch
 * milliseconds. Days are aligned to the viewer's zone, given as minutes east
 * of UTC; weeks start on Monday.
 */
export const dateRange = (value: unknown, now: number, offsetMinutes = 0): [number, number] | null => {
  const offset = offsetMinutes * 60_000;
  const local = new Date(now + offset);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const at = (yy: number, mm: number, dd: number) => Date.UTC(yy, mm, dd) - offset;
  const today = at(y, m, d);
  const day = (start: number): [number, number] => [start, start + DAY];
  const v: DateFilterValue | null =
    typeof value === "string" ? { mode: "exact", date: value } : value && typeof value === "object" ? (value as DateFilterValue) : null;
  if (!v) return null;
  if (v.mode === "exact") {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.date ?? "");
    if (match) return day(at(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    const t = Date.parse(v.date);
    if (Number.isNaN(t)) return null;
    const l = new Date(t + offset);
    return day(at(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()));
  }
  if (v.mode === "relative") {
    switch (v.preset) {
      case "today":
        return day(today);
      case "tomorrow":
        return day(at(y, m, d + 1));
      case "yesterday":
        return day(at(y, m, d - 1));
      case "oneWeekAgo":
        return day(at(y, m, d - 7));
      case "oneWeekFromNow":
        return day(at(y, m, d + 7));
      case "oneMonthAgo":
        return day(at(y, m - 1, d));
      case "oneMonthFromNow":
        return day(at(y, m + 1, d));
    }
    return null;
  }
  if (v.mode === "range") {
    const tomorrow = at(y, m, d + 1);
    const monday = at(y, m, d - ((local.getUTCDay() + 6) % 7));
    switch (v.preset) {
      case "pastWeek":
        return [at(y, m, d - 7), tomorrow];
      case "pastMonth":
        return [at(y, m - 1, d), tomorrow];
      case "pastYear":
        return [at(y - 1, m, d), tomorrow];
      case "thisWeek":
        return [monday, monday + 7 * DAY];
      case "thisMonth":
        return [at(y, m, 1), at(y, m + 1, 1)];
      case "thisYear":
        return [at(y, 0, 1), at(y + 1, 0, 1)];
      case "nextWeek":
        return [today, at(y, m, d + 7)];
      case "nextMonth":
        return [today, at(y, m + 1, d)];
      case "nextYear":
        return [today, at(y + 1, m, d)];
    }
  }
  return null;
};

/** How a property behaves in filters and sorts. */
export type ColumnKind = "text" | "number" | "time" | "flag" | "list";

export const columnKind = (prop: Property): ColumnKind => {
  switch (prop.type) {
    case "number":
      return "number";
    case "date":
    case "createdAt":
    case "lastEditedAt":
      return "time";
    case "checkbox":
      return "flag";
    case "multiSelect":
    case "file":
      return "list";
    case "person":
      return prop.options.allowMultiple ? "list" : "text";
    case "formula":
      switch (prop.options.resultType) {
        case "number":
          return "number";
        case "boolean":
          return "flag";
        case "date":
          return "time";
      }
      return "text";
  }
  return "text";
};

export const OPERATORS_BY_KIND: Record<ColumnKind, readonly FilterOperator[]> = {
  text: ["eq", "neq", "contains", "ncontains", "startsWith", "endsWith", "gt", "gte", "lt", "lte", "any", "none", "all", "isEmpty", "isNotEmpty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"],
  time: ["eq", "neq", "before", "after", "onOrBefore", "onOrAfter", "gt", "gte", "lt", "lte", "isWithin", "isEmpty", "isNotEmpty"],
  flag: ["eq", "neq", "isEmpty", "isNotEmpty"],
  list: ["eq", "neq", "any", "none", "all", "contains", "ncontains", "isEmpty", "isNotEmpty"],
};

export const DEFAULT_STATUS_CHOICES: Choice[] = [
  { id: "status-todo", name: "Not started", color: "gray", category: "todo" },
  { id: "status-doing", name: "In progress", color: "blue", category: "inProgress" },
  { id: "status-done", name: "Done", color: "green", category: "complete" },
];

export const CHOICE_COLORS = ["gray", "red", "pink", "grape", "violet", "indigo", "blue", "cyan", "teal", "green", "lime", "yellow", "orange"] as const;
