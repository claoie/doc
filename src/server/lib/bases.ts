import type { SQL } from "bun";
import type { SpaceRole } from "common/api-types";
import {
  cellText,
  columnKind,
  dateRange,
  DEFAULT_STATUS_CHOICES,
  FILTER_OPERATORS,
  isFilterGroup,
  LIMITS,
  OPERATORS_BY_KIND,
  type Base,
  type FilterCondition,
  type FilterGroup,
  type Property,
  type PropertyOptions,
  type PropertyType,
  type ResolvedPage,
  type Row,
  type RowReferences,
  type Sort,
  type View,
  type ViewConfig,
  type ViewType,
} from "common/bases";
import { isUuid, shortId } from "common/ids";
import { keyBetween } from "common/positions";
import { sql } from "server/db";
import type { AuthUser } from "./auth";
import { badRequest, notFound } from "./http";
import { requirePage, type PageAccess } from "./pages";
import { hasRole, readableSpaceIds } from "./permissions";
import { iso, userRefs } from "./users";

type Db = SQL;
type Fragment = SQL.Query<unknown>;

interface PropertyRow {
  id: string;
  name: string;
  type: PropertyType;
  options: PropertyOptions;
  is_primary: boolean;
  position: string;
}

interface ViewRow {
  id: string;
  name: string;
  type: ViewType;
  config: ViewConfig;
  position: string;
}

export interface RowRecord {
  id: string;
  cells: Record<string, unknown>;
  position: string;
  creator_id: string | null;
  last_editor_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export const toProperty = (row: PropertyRow): Property => ({
  id: row.id,
  name: row.name,
  type: row.type,
  options: row.options ?? {},
  isPrimary: row.is_primary,
  position: row.position,
});

export const toView = (row: ViewRow): View => ({
  id: row.id,
  name: row.name,
  type: row.type,
  config: row.config ?? {},
  position: row.position,
});

export const toRow = (row: RowRecord): Row => ({
  id: row.id,
  cells: row.cells ?? {},
  position: row.position,
  creatorId: row.creator_id,
  lastEditorId: row.last_editor_id,
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!,
});

export const rowColumns = () => sql.unsafe(`r.id, r.cells, r.position, r.creator_id, r.last_editor_id, r.created_at, r.updated_at`);

export const loadProperties = async (pageId: string, db: Db = sql): Promise<Property[]> =>
  (await db`
    SELECT id, name, type, options, is_primary, position FROM base_properties
    WHERE page_id = ${pageId} ORDER BY position, id`).map(toProperty);

export const loadViews = async (pageId: string, db: Db = sql): Promise<View[]> =>
  (await db`SELECT id, name, type, config, position FROM base_views WHERE page_id = ${pageId} ORDER BY position, id`).map(toView);

export const toBase = async (access: PageAccess): Promise<Base> => {
  const [properties, views] = await Promise.all([loadProperties(access.page.id), loadViews(access.page.id)]);
  return {
    id: access.page.id,
    slugId: access.page.slug_id,
    spaceId: access.page.space_id,
    title: access.page.title,
    icon: access.page.icon,
    properties,
    views,
    canEdit: !access.page.deleted_at && hasRole(access.role, "writer"),
  };
};

/** Like `requirePage`, but the page must be a base. */
export const requireBase = async (user: AuthUser, ref: string, min: SpaceRole): Promise<PageAccess> => {
  const access = await requirePage(user, ref, min);
  if (!access.page.is_base) throw notFound("Base");
  return access;
};

export const newPropertyId = () => shortId("p");
export const newChoiceId = () => shortId("c");

/** Default properties, one empty row and a table view (plus a kanban board for the kanban template). */
export const seedBase = async (db: Db, pageId: string, userId: string, template: "table" | "kanban") => {
  const props: { id: string; name: string; type: PropertyType; options: PropertyOptions; primary: boolean }[] = [
    { id: newPropertyId(), name: "Title", type: "text", options: {}, primary: true },
    { id: newPropertyId(), name: "Text 1", type: "text", options: {}, primary: false },
    { id: newPropertyId(), name: "Text 2", type: "text", options: {}, primary: false },
  ];
  if (template === "kanban") {
    props.push({
      id: newPropertyId(),
      name: "Status",
      type: "status",
      options: {
        choices: DEFAULT_STATUS_CHOICES,
        choiceOrder: DEFAULT_STATUS_CHOICES.map((c) => c.id),
        defaultValue: DEFAULT_STATUS_CHOICES[0]!.id,
      },
      primary: false,
    });
  }
  let position: string | null = null;
  for (const p of props) {
    position = keyBetween(position, null);
    await db`
      INSERT INTO base_properties (page_id, id, name, type, options, is_primary, position)
      VALUES (${pageId}, ${p.id}, ${p.name}, ${p.type}, ${p.options}::jsonb, ${p.primary}, ${position})`;
  }
  const first = keyBetween(null, null);
  const second = keyBetween(first, null);
  await db`INSERT INTO base_rows (page_id, position, creator_id, last_editor_id) VALUES (${pageId}, ${first}, ${userId}, ${userId})`;
  // The kanban template opens on its board.
  await db`
    INSERT INTO base_views (page_id, name, type, position, creator_id)
    VALUES (${pageId}, 'Table', 'table', ${template === "kanban" ? second : first}, ${userId})`;
  if (template === "kanban") {
    const status = props[props.length - 1]!;
    await db`
      INSERT INTO base_views (page_id, name, type, config, position, creator_id)
      VALUES (${pageId}, 'Board', 'kanban', ${{ groupByPropertyId: status.id }}::jsonb, ${first}, ${userId})`;
  }
};

// ---------------------------------------------------------------------------
// Filters and sorts compile to SQL over a `base_rows` row aliased `r`.

const join = (parts: Fragment[], glue: "AND" | "OR"): Fragment =>
  parts.reduce((acc, part) => (glue === "AND" ? sql`${acc} AND ${part}` : sql`${acc} OR ${part}`));

const cell = (prop: Property) => sql`(r.cells -> ${prop.id}::text)`;

/** The comparable expression for a property, per its column kind; bare dates are local days at `tzOffset`. */
const columnExpr = (prop: Property, tzOffset: number): Fragment => {
  switch (prop.type) {
    case "createdAt":
      return sql`r.created_at`;
    case "lastEditedAt":
      return sql`r.updated_at`;
    case "lastEditedBy":
      return sql`coalesce(r.last_editor_id, r.creator_id)::text`;
  }
  switch (columnKind(prop)) {
    case "number":
      return sql`cell_number(${cell(prop)})`;
    case "time":
      return sql`cell_time(${cell(prop)}, ${tzOffset}::int)`;
    case "flag":
      return sql`cell_flag(${cell(prop)})`;
    case "list":
      return sql`cell_list(${cell(prop)})`;
    case "text":
      return sql`(r.cells ->> ${prop.id}::text)`;
  }
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const asText = (value: unknown) => (value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));
const asList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value]).map((v) => String(v));
const isTrue = (value: unknown) => value === true || (typeof value === "string" && /^(true|1|yes|on)$/i.test(value.trim()));
const FALSE = () => sql`false`;
const TRUE = () => sql`true`;

const isEmpty = (prop: Property, expr: Fragment): Fragment => {
  const kind = columnKind(prop);
  if (kind === "text") return sql`(${expr} IS NULL OR ${expr} = '')`;
  if (kind === "list") return sql`coalesce(jsonb_array_length(${expr}), 0) = 0`;
  return sql`${expr} IS NULL`;
};

const compileCondition = (prop: Property, c: FilterCondition, now: number, tzOffset: number): Fragment => {
  const kind = columnKind(prop);
  if (!OPERATORS_BY_KIND[kind].includes(c.op)) throw badRequest(`Operator ${c.op} is not supported for ${kind} properties`);
  const expr = columnExpr(prop, tzOffset);
  if (c.op === "isEmpty") return isEmpty(prop, expr);
  if (c.op === "isNotEmpty") return sql`NOT ${isEmpty(prop, expr)}`;

  if (kind === "text") {
    const v = asText(c.value);
    const like = (pattern: string) => sql`${expr} ILIKE ${pattern}`;
    switch (c.op) {
      case "eq":
        return sql`${expr} = ${v}`;
      case "neq":
        return sql`${expr} IS DISTINCT FROM ${v}`;
      case "contains":
        return like(`%${escapeLike(v)}%`);
      case "ncontains":
        return sql`NOT coalesce(${like(`%${escapeLike(v)}%`)}, false)`;
      case "startsWith":
        return like(`${escapeLike(v)}%`);
      case "endsWith":
        return like(`%${escapeLike(v)}`);
      case "gt":
        return sql`${expr} > ${v}`;
      case "gte":
        return sql`${expr} >= ${v}`;
      case "lt":
        return sql`${expr} < ${v}`;
      case "lte":
        return sql`${expr} <= ${v}`;
      case "any": {
        const list = asList(c.value);
        return list.length ? sql`${expr} = ANY(${sql.array(list, "text")})` : FALSE();
      }
      case "none": {
        const list = asList(c.value);
        return list.length ? sql`(${expr} IS NULL OR NOT (${expr} = ANY(${sql.array(list, "text")})))` : TRUE();
      }
      case "all": {
        const list = asList(c.value);
        if (list.length === 0) return TRUE();
        return list.length > 1 ? FALSE() : sql`${expr} = ${list[0]!}`;
      }
    }
  }

  if (kind === "number") {
    const n = typeof c.value === "number" ? c.value : c.value === "" || c.value === null ? NaN : Number(c.value);
    if (!Number.isFinite(n)) return c.op === "neq" ? TRUE() : FALSE();
    const v = String(n);
    switch (c.op) {
      case "eq":
        return sql`${expr} = ${v}::numeric`;
      case "neq":
        return sql`${expr} IS DISTINCT FROM ${v}::numeric`;
      case "gt":
        return sql`${expr} > ${v}::numeric`;
      case "gte":
        return sql`${expr} >= ${v}::numeric`;
      case "lt":
        return sql`${expr} < ${v}::numeric`;
      case "lte":
        return sql`${expr} <= ${v}::numeric`;
    }
  }

  if (kind === "flag") {
    const want = isTrue(c.value);
    const matches = want ? sql`coalesce(${expr}, false) = true` : sql`coalesce(${expr}, false) = false`;
    return c.op === "eq" ? matches : sql`NOT (${matches})`;
  }

  if (kind === "time") {
    const range = dateRange(c.value, now, tzOffset);
    if (!range) return FALSE();
    const start = new Date(range[0]).toISOString();
    const end = new Date(range[1]).toISOString();
    const within = sql`(${expr} >= ${start}::timestamptz AND ${expr} < ${end}::timestamptz)`;
    switch (c.op) {
      case "eq":
      case "isWithin":
        return within;
      case "neq":
        return sql`NOT coalesce(${within}, false)`;
      case "before":
      case "lt":
        return sql`${expr} < ${start}::timestamptz`;
      case "onOrBefore":
      case "lte":
        return sql`${expr} < ${end}::timestamptz`;
      case "after":
      case "gt":
        return sql`${expr} >= ${end}::timestamptz`;
      case "onOrAfter":
      case "gte":
        return sql`${expr} >= ${start}::timestamptz`;
    }
  }

  if (kind === "list") {
    const list = asList(c.value);
    const arr = sql.array(list, "text");
    switch (c.op) {
      case "eq":
        return list.length ? sql`coalesce(${expr} ? ${list[0]!}, false)` : FALSE();
      case "neq":
        return list.length ? sql`NOT coalesce(${expr} ? ${list[0]!}, false)` : TRUE();
      case "any":
        return list.length ? sql`coalesce(${expr} ?| ${arr}, false)` : FALSE();
      case "none":
        return list.length ? sql`NOT coalesce(${expr} ?| ${arr}, false)` : TRUE();
      case "all":
        return list.length ? sql`coalesce(${expr} ?& ${arr}, false)` : TRUE();
      case "contains": {
        const v = asText(c.value);
        return v ? sql`coalesce(${expr}::text ILIKE ${`%${escapeLike(v)}%`}, false)` : FALSE();
      }
      case "ncontains": {
        const v = asText(c.value);
        return v ? sql`NOT coalesce(${expr}::text ILIKE ${`%${escapeLike(v)}%`}, false)` : TRUE();
      }
    }
  }
  throw badRequest(`Operator ${c.op} is not supported for ${kind} properties`);
};

/** Validates the shape of an untrusted filter tree. */
export const parseFilter = (value: unknown, depth = 0): FilterGroup | undefined => {
  if (value === undefined || value === null) return undefined;
  const fail = () => badRequest("Invalid filter");
  if (depth > 10 || typeof value !== "object" || Array.isArray(value)) throw fail();
  const group = value as Record<string, unknown>;
  if ((group.op !== "and" && group.op !== "or") || !Array.isArray(group.children)) throw fail();
  if (group.children.length > LIMITS.filterChildren) throw fail();
  const children = group.children.map((child): FilterGroup | FilterCondition => {
    if (!child || typeof child !== "object") throw fail();
    if ("children" in child) return parseFilter(child, depth + 1)!;
    const { propertyId, op, value: v } = child as Record<string, unknown>;
    if (typeof propertyId !== "string" || !FILTER_OPERATORS.includes(op as never)) throw fail();
    return { propertyId, op: op as FilterCondition["op"], value: v };
  });
  return { op: group.op, children };
};

export const parseSorts = (value: unknown): Sort[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > LIMITS.sorts) throw badRequest("Invalid sorts");
  return value.map((s) => {
    if (!s || typeof s !== "object" || typeof s.propertyId !== "string" || (s.direction !== "asc" && s.direction !== "desc")) {
      throw badRequest("Invalid sorts");
    }
    return { propertyId: s.propertyId, direction: s.direction };
  });
};

export const compileFilter = (props: Property[], group: FilterGroup | undefined, now: number, tzOffset: number): Fragment => {
  if (!group) return TRUE();
  const byId = new Map(props.map((p) => [p.id, p]));
  const walk = (g: FilterGroup): Fragment | null => {
    const parts = g.children.flatMap((child) => {
      if (isFilterGroup(child)) return walk(child) ?? [];
      const prop = byId.get(child.propertyId);
      if (!prop) throw badRequest(`Filter references unknown property ${child.propertyId}`);
      return [compileCondition(prop, child, now, tzOffset)];
    });
    if (parts.length === 0) return null;
    return sql`(${join(parts, g.op === "and" ? "AND" : "OR")})`;
  };
  return walk(group) ?? TRUE();
};

/** What a property sorts by: choices by their option order, people by name, everything else by value. */
const sortExpr = (prop: Property, tzOffset: number): Fragment => {
  if (prop.type === "select" || prop.type === "status") {
    const order = choicesOrder(prop);
    return sql`array_position(${sql.array(order, "text")}::text[], ${columnExpr(prop, tzOffset)})`;
  }
  if (prop.type === "lastEditedBy") {
    return sql`(SELECT lower(u.name) FROM users u WHERE u.id = coalesce(r.last_editor_id, r.creator_id))`;
  }
  if (prop.type === "person" && !prop.options.allowMultiple) {
    const id = columnExpr(prop, tzOffset);
    return sql`(SELECT lower(u.name) FROM users u WHERE u.id = CASE WHEN ${id} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (${id})::uuid END)`;
  }
  return columnKind(prop) === "list" ? sql`${columnExpr(prop, tzOffset)}::text` : columnExpr(prop, tzOffset);
};

const choicesOrder = (prop: Property): string[] => {
  const ids = (prop.options.choices ?? []).map((c) => c.id);
  const order = (prop.options.choiceOrder ?? []).filter((id) => ids.includes(id));
  return [...order, ...ids.filter((id) => !order.includes(id))];
};

export const compileSorts = (props: Property[], sorts: Sort[] | undefined, tzOffset = 0): Fragment | null => {
  if (!sorts?.length) return null;
  const byId = new Map(props.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const parts: Fragment[] = [];
  for (const s of sorts) {
    if (seen.has(s.propertyId)) continue;
    seen.add(s.propertyId);
    const prop = byId.get(s.propertyId);
    if (!prop) throw badRequest(`Sort references unknown property ${s.propertyId}`);
    const expr = sortExpr(prop, tzOffset);
    parts.push(s.direction === "asc" ? sql`${expr} ASC NULLS LAST` : sql`${expr} DESC NULLS LAST`);
  }
  return parts.length ? parts.reduce((acc, part) => sql`${acc}, ${part}`) : null;
};

// ---------------------------------------------------------------------------
// Pagination cursors are opaque base64url JSON.

const encodeCursor = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decodeCursor = (cursor: string | undefined): Record<string, unknown> | null => {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
};

export interface RowQuery {
  filter?: FilterGroup;
  sorts?: Sort[];
  cursor?: string;
  limit: number;
  tzOffset: number;
}

/**
 * Unsorted lists page by `(position, id)` keyset so concurrent inserts do not
 * shift pages; sorted lists page by offset because the sort keys are nullable
 * expressions.
 */
export const queryRows = async (pageId: string, props: Property[], q: RowQuery): Promise<{ rows: RowRecord[]; nextCursor: string | null }> => {
  const where = compileFilter(props, q.filter, Date.now(), q.tzOffset);
  const order = compileSorts(props, q.sorts, q.tzOffset);
  const cursor = decodeCursor(q.cursor);
  if (order) {
    const offset = typeof cursor?.o === "number" && cursor.o >= 0 ? Math.floor(cursor.o) : 0;
    const rows: RowRecord[] = await sql`
      SELECT ${rowColumns()} FROM base_rows r
      WHERE r.page_id = ${pageId} AND ${where}
      ORDER BY ${order}, r.position, r.id
      LIMIT ${q.limit + 1} OFFSET ${offset}`;
    const more = rows.length > q.limit;
    return { rows: rows.slice(0, q.limit), nextCursor: more ? encodeCursor({ o: offset + q.limit }) : null };
  }
  const after =
    typeof cursor?.p === "string" && isUuid(cursor.i) ? sql`(r.position, r.id) > (${cursor.p}::text COLLATE "C", ${cursor.i}::uuid)` : TRUE();
  const rows: RowRecord[] = await sql`
    SELECT ${rowColumns()} FROM base_rows r
    WHERE r.page_id = ${pageId} AND ${where} AND ${after}
    ORDER BY r.position, r.id
    LIMIT ${q.limit + 1}`;
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: more && last ? encodeCursor({ p: last.position, i: last.id }) : null };
};

/** Every row of a base in display order, in batches, for exports and recomputation. */
export async function* allRows(pageId: string, db: Db = sql, batch = 500): AsyncGenerator<RowRecord[]> {
  let after: { position: string; id: string } | null = null;
  for (;;) {
    const cond: Fragment = after ? sql`(r.position, r.id) > (${after.position}::text COLLATE "C", ${after.id}::uuid)` : TRUE();
    const rows: RowRecord[] = await db`
      SELECT ${rowColumns()} FROM base_rows r WHERE r.page_id = ${pageId} AND ${cond}
      ORDER BY r.position, r.id LIMIT ${batch}`;
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < batch) return;
    const last = rows[rows.length - 1]!;
    after = { position: last.position, id: last.id };
  }
}

// ---------------------------------------------------------------------------
// References: names for users and titles for pages mentioned by cells.

const idsIn = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string");

/** Pages the user may read, resolved to what a cell needs to render a link. */
export const resolvePages = async (userId: string, ids: string[]): Promise<Record<string, ResolvedPage>> => {
  const valid = [...new Set(ids.filter(isUuid).map((id) => id.toLowerCase()))];
  if (!valid.length) return {};
  const rows = await sql`
    SELECT p.id, p.slug_id, p.title, p.icon, s.slug AS space_slug FROM pages p JOIN spaces s ON s.id = p.space_id
    WHERE p.id = ANY(${sql.array(valid, "uuid")}) AND p.deleted_at IS NULL AND p.space_id IN ${readableSpaceIds(userId)}`;
  return Object.fromEntries(
    rows.map((r: { id: string; slug_id: string; title: string | null; icon: string | null; space_slug: string }) => [
      r.id,
      { id: r.id, slugId: r.slug_id, title: r.title, icon: r.icon, spaceSlug: r.space_slug },
    ]),
  );
};

export const rowReferences = async (userId: string, props: Property[], rows: RowRecord[]): Promise<RowReferences> => {
  const people = props.filter((p) => p.type === "person").map((p) => p.id);
  const links = props.filter((p) => p.type === "page").map((p) => p.id);
  const userIds = new Set<string>();
  const pageIds = new Set<string>();
  for (const row of rows) {
    if (row.creator_id) userIds.add(row.creator_id);
    if (row.last_editor_id) userIds.add(row.last_editor_id);
    for (const id of people) for (const v of idsIn(row.cells?.[id])) userIds.add(v);
    for (const id of links) for (const v of idsIn(row.cells?.[id])) pageIds.add(v);
  }
  const [users, pages] = await Promise.all([userRefs([...userIds].filter(isUuid)), resolvePages(userId, [...pageIds])]);
  return { users: Object.fromEntries(users.map((u) => [u.id, u])), pages };
};

/** Every row of a base as plain text, in display order, for exports. */
export const baseText = async (pageId: string, userId: string, maxRows = 10_000): Promise<{ headers: string[]; rows: string[][] }> => {
  const props = await loadProperties(pageId);
  const rows: string[][] = [];
  for await (const batch of allRows(pageId)) {
    const refs = await rowReferences(userId, props, batch);
    for (const record of batch) {
      const row = toRow(record);
      rows.push(props.map((p) => cellText(p, row.cells[p.id], row, refs)));
      if (rows.length >= maxRows) return { headers: props.map((p) => p.name), rows };
    }
  }
  return { headers: props.map((p) => p.name), rows };
};
