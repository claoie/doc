import type { SQL } from "bun";
import {
  CellError,
  cellText,
  convertCell,
  isChoiceType,
  isEditableType,
  isFilterGroup,
  isSystemType,
  LIMITS,
  normalizeCells,
  PROPERTY_TYPES,
  VIEW_TYPES,
  type BaseEvent,
  type Choice,
  type FilterGroup,
  type Property,
  type PropertyOptions,
  type PropertyType,
  type ViewConfig,
} from "common/bases";
import { emptyDoc } from "common/editor/doc-schema";
import { affectedFormulas, compileFormula, computeFormulas, FormulaSyntaxError, renameInSource } from "common/formula";
import { isUuid, slugId } from "common/ids";
import { keyBetween } from "common/positions";
import { docText } from "common/text";
import { sql } from "server/db";
import {
  allRows,
  loadProperties,
  loadViews,
  newPropertyId,
  parseFilter,
  parseSorts,
  queryRows,
  requireBase,
  resolvePages,
  rowColumns,
  rowReferences,
  seedBase,
  toBase,
  toRow,
  toView,
  type RowRecord,
} from "server/lib/bases";
import { contentDisposition } from "server/lib/files";
import { badRequest, conflict, get, notFound, post, readJson } from "server/lib/http";
import { watchPage } from "server/lib/notifications";
import { requirePage, siblingPosition, toTreeItem, treeColumns, type PageAccess } from "server/lib/pages";
import { requireSpaceRole } from "server/lib/permissions";
import { input, type Input } from "server/lib/validate";
import { emitToSpace } from "server/realtime/hub";

type Db = SQL;

const NAME_RULE = { min: 1, max: LIMITS.name };
const TITLE_RULE = { min: 0, max: 500 };
const POSITION_RE = /^[0-9A-Za-z]{1,512}$/;
const BODY_LIMIT = 4 * 1024 * 1024;

const emit = (access: PageAccess, event: BaseEvent, requestId?: string) =>
  emitToSpace(access.page.space_id, { kind: "base", pageId: access.page.id, spaceId: access.page.space_id, event, requestId });

const emitBase = async (access: PageAccess, requestId?: string) => emit(access, { op: "base", base: await toBase(access) }, requestId);

const requestId = (body: Input) => body.optionalString("requestId", { max: 64 });

const position = (body: Input, key = "position") => {
  const value = body.optionalString(key, { max: 512 });
  if (value !== undefined && !POSITION_RE.test(value)) throw badRequest(`${key} is invalid`);
  return value;
};

const cellError = (error: unknown): never => {
  if (error instanceof CellError) throw badRequest(error.message);
  throw error;
};

// ---------------------------------------------------------------------------
// Property options

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const parseChoices = (value: unknown): Choice[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMITS.choices) throw badRequest("Invalid property options");
  const seen = new Set<string>();
  return value.map((c) => {
    if (!isObject(c)) throw badRequest("Invalid property options");
    const { id, name, color, category } = c;
    if (typeof id !== "string" || !id || id.length > 64 || seen.has(id)) throw badRequest("Invalid property options");
    if (typeof name !== "string" || name.length > 200) throw badRequest("Invalid property options");
    if (color !== undefined && (typeof color !== "string" || color.length > 32)) throw badRequest("Invalid property options");
    if (category !== undefined && category !== "todo" && category !== "inProgress" && category !== "complete") {
      throw badRequest("Invalid property options");
    }
    seen.add(id);
    return { id, name, color: (color as string | undefined) ?? "gray", ...(category ? { category } : {}) } as Choice;
  });
};

const DEFAULT_OPTIONS: Partial<Record<PropertyType, PropertyOptions>> = {
  select: { choices: [], choiceOrder: [] },
  multiSelect: { choices: [], choiceOrder: [] },
  number: { format: "plain" },
  date: { includeTime: false },
  person: { allowMultiple: false },
};

/** Validates options for a non-formula type and merges them over the type's defaults. */
const parseOptions = (type: PropertyType, raw: unknown): PropertyOptions => {
  if (raw === undefined || raw === null) return { ...DEFAULT_OPTIONS[type] };
  if (!isObject(raw) || JSON.stringify(raw).length > 256 * 1024) throw badRequest("Invalid property options");
  const options: PropertyOptions = { ...DEFAULT_OPTIONS[type], ...raw };
  if (isChoiceType(type)) {
    options.choices = parseChoices(raw.choices);
    const ids = new Set(options.choices.map((c) => c.id));
    const order = Array.isArray(raw.choiceOrder) ? raw.choiceOrder.filter((id): id is string => typeof id === "string" && ids.has(id)) : [];
    options.choiceOrder = [...new Set([...order, ...options.choices.map((c) => c.id)])];
  }
  if (type === "number") {
    if (raw.format !== undefined && !["plain", "currency", "percent", "progress"].includes(raw.format as string)) throw badRequest("Invalid property options");
    if (raw.precision !== undefined && raw.precision !== null && (!Number.isInteger(raw.precision) || (raw.precision as number) < 0 || (raw.precision as number) > 20)) {
      throw badRequest("Invalid property options");
    }
  }
  if (type === "date" && raw.timeFormat !== undefined && raw.timeFormat !== "12h" && raw.timeFormat !== "24h") throw badRequest("Invalid property options");
  return options;
};

/** Compiles a formula; its source, result type and dependencies are derived on the server. */
const formulaOptions = (raw: unknown, props: Property[], selfId: string | null): PropertyOptions => {
  const options = isObject(raw) ? raw : {};
  const source = typeof options.source === "string" ? options.source : "";
  try {
    const compiled = compileFormula(source, props, selfId);
    return {
      ...(isObject(options.formatOptions) ? { formatOptions: options.formatOptions } : {}),
      source,
      resultType: compiled.resultType,
      dependencies: compiled.dependencies,
    };
  } catch (error) {
    if (error instanceof FormulaSyntaxError) throw badRequest(error.message);
    throw error;
  }
};

const uniqueViolation = (error: unknown) => (error as { errno?: string; code?: string })?.errno === "23505" || (error as { code?: string })?.code === "23505";

// ---------------------------------------------------------------------------
// Bulk cell rewrites

/** Applies per-row cell patches in one statement; a null value removes a key. */
const patchRows = async (db: Db, pageId: string, patches: Map<string, Record<string, unknown>>) => {
  if (patches.size === 0) return;
  const payload = Object.fromEntries(patches);
  await db`
    UPDATE base_rows r SET cells = apply_cell_patch(r.cells, p.value)
    FROM jsonb_each(${payload}::jsonb) p
    WHERE r.page_id = ${pageId} AND r.id = p.key::uuid`;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const rowMeta = (row: RowRecord) => ({ createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });

/** Recomputes the given formulas on every row, writing only values that changed. */
const backfillFormulas = async (db: Db, pageId: string, props: Property[], formulaIds: string[]) => {
  if (formulaIds.length === 0) return 0;
  let changed = 0;
  const now = Date.now();
  for await (const rows of allRows(pageId, db)) {
    const patches = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const values = computeFormulas(props, row.cells ?? {}, rowMeta(row), formulaIds, now);
      const patch: Record<string, unknown> = {};
      for (const [id, value] of Object.entries(values)) if (!same(row.cells?.[id], value)) patch[id] = value;
      if (Object.keys(patch).length) patches.set(row.id, patch);
    }
    await patchRows(db, pageId, patches);
    changed += patches.size;
  }
  return changed;
};

/** Rewrites one property's cells into another type. */
const convertRows = async (db: Db, userId: string, pageId: string, from: Property, to: { type: PropertyType; options: PropertyOptions }) => {
  for await (const rows of allRows(pageId, db)) {
    const holding = rows.filter((r) => r.cells && from.id in r.cells);
    if (!holding.length) continue;
    const refs = from.type === "person" || from.type === "lastEditedBy" ? await rowReferences(userId, [from], holding) : { users: {}, pages: {} };
    const pages = from.type === "page" ? await resolvePages(userId, holding.map((r) => String(r.cells[from.id]))) : {};
    const patches = new Map<string, Record<string, unknown>>();
    for (const row of holding) {
      const next = convertCell(row.cells[from.id], from, to, toRow(row), { users: refs.users, pages });
      if (!same(row.cells[from.id], next)) patches.set(row.id, { [from.id]: next ?? null });
    }
    await patchRows(db, pageId, patches);
  }
};

/** Drops references to a property from view configs so stored filters stay valid. */
const stripFromViews = async (db: Db, pageId: string, propertyId: string) => {
  const strip = (group: FilterGroup): FilterGroup => ({
    op: group.op,
    children: group.children
      .map((c) => (isFilterGroup(c) ? strip(c) : c))
      .filter((c) => (isFilterGroup(c) ? c.children.length > 0 : c.propertyId !== propertyId)),
  });
  for (const view of await loadViews(pageId, db)) {
    const c = view.config;
    const next: ViewConfig = { ...c };
    if (c.sorts) next.sorts = c.sorts.filter((s) => s.propertyId !== propertyId);
    if (c.filter) next.filter = strip(c.filter);
    for (const key of ["hiddenPropertyIds", "visiblePropertyIds", "propertyOrder"] as const) {
      if (c[key]) next[key] = c[key]!.filter((id) => id !== propertyId);
    }
    if (c.propertyWidths) next.propertyWidths = Object.fromEntries(Object.entries(c.propertyWidths).filter(([id]) => id !== propertyId));
    if (c.groupByPropertyId === propertyId) delete next.groupByPropertyId;
    if (c.datePropertyId === propertyId) delete next.datePropertyId;
    if (!same(c, next)) await db`UPDATE base_views SET config = ${next}::jsonb, updated_at = now() WHERE id = ${view.id}`;
  }
};

// ---------------------------------------------------------------------------
// View config

const parseConfig = (raw: unknown): ViewConfig => {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw) || JSON.stringify(raw).length > 256 * 1024) throw badRequest("Invalid view config");
  const config: ViewConfig = { ...raw };
  if ("filter" in raw) config.filter = parseFilter(raw.filter);
  if ("sorts" in raw) config.sorts = parseSorts(raw.sorts);
  for (const key of ["hiddenPropertyIds", "visiblePropertyIds", "propertyOrder", "hiddenChoiceIds", "choiceOrder"] as const) {
    const v = raw[key];
    if (v !== undefined && (!Array.isArray(v) || v.length > 500 || !v.every((id) => typeof id === "string" && id.length <= 64))) {
      throw badRequest("Invalid view config");
    }
  }
  if (raw.propertyWidths !== undefined) {
    const widths = raw.propertyWidths;
    if (!isObject(widths) || !Object.values(widths).every((w) => typeof w === "number" && w >= 1 && w <= 5000)) throw badRequest("Invalid view config");
  }
  for (const key of ["groupByPropertyId", "datePropertyId"] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || (raw[key] as string).length > 64)) throw badRequest("Invalid view config");
  }
  return config;
};

/** A patch: `null` removes a key, absent keys are kept, anything else replaces the key. */
const applyConfigPatch = (config: ViewConfig, patch: Record<string, unknown>): ViewConfig => {
  const next: Record<string, unknown> = { ...config };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return parseConfig(next);
};

// ---------------------------------------------------------------------------
// CSV

/** Spreadsheets run cells starting with these as formulas; plain numbers are left alone. */
const neutralize = (value: string) => (/^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value) ? `'${value}` : value);
const csvField = (raw: string) => {
  const value = neutralize(raw);
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
};
const csvLine = (fields: string[]) => `${fields.map(csvField).join(",")}\r\n`;

const createBasePage = async (
  user: { id: string },
  options: { spaceId: string; parentId: string | null; afterId?: string | null; title: string | null; icon: string | null; template: "table" | "kanban" },
) => {
  const id = await sql.begin(async (tx) => {
    if (options.parentId) {
      const [parent] = await tx`SELECT id FROM pages WHERE id = ${options.parentId} AND space_id = ${options.spaceId} AND deleted_at IS NULL`;
      if (!parent) throw notFound("Parent page");
    }
    const pos = await siblingPosition(tx, options.spaceId, options.parentId, options.afterId === null ? undefined : options.afterId);
    const content = emptyDoc();
    const [row] = await tx`
      INSERT INTO pages (slug_id, space_id, parent_id, position, title, icon, content, text_content,
        creator_id, last_editor_id, contributor_ids, is_base)
      VALUES (${slugId()}, ${options.spaceId}, ${options.parentId}, ${pos}, ${options.title}, ${options.icon}, ${content}::jsonb,
        ${docText(content)}, ${user.id}, ${user.id}, ARRAY[${user.id}]::uuid[], true)
      RETURNING id`;
    await seedBase(tx, row.id, user.id, options.template);
    return row.id as string;
  });
  await watchPage(id, [user.id]);
  emitToSpace(options.spaceId, { kind: "tree", spaceId: options.spaceId });
  const [tree] = await sql`SELECT ${treeColumns()} FROM pages p WHERE p.id = ${id}`;
  return toTreeItem(tree);
};

export const routes = [
  post("/bases", async (ctx) => {
    const body = input(await readJson(ctx));
    const spaceId = body.uuid("spaceId");
    await requireSpaceRole(ctx.user, spaceId, "writer");
    const page = await createBasePage(ctx.user, {
      spaceId,
      parentId: body.optionalUuid("parentId") ?? null,
      afterId: body.optionalUuid("afterId"),
      title: body.nullableString("title", TITLE_RULE) ?? null,
      icon: body.nullableString("icon", { max: 100 }) ?? null,
      template: body.oneOf("template", ["table", "kanban"] as const) ?? "table",
    });
    return { page };
  }),

  post("/pages/:id/convert-to-base", async (ctx) => {
    const access = await requirePage(ctx.user, ctx.params.id!, "writer");
    if (access.page.is_base) throw badRequest("This page is already a base");
    const template = input(await readJson(ctx)).oneOf("template", ["table", "kanban"] as const) ?? "table";
    await sql.begin(async (tx) => {
      const [existing] = await tx`SELECT 1 FROM base_properties WHERE page_id = ${access.page.id} LIMIT 1`;
      if (existing) throw conflict("already_base", "This page already has base data");
      await tx`UPDATE pages SET is_base = true, updated_at = now(), last_editor_id = ${ctx.user.id} WHERE id = ${access.page.id}`;
      await seedBase(tx, access.page.id, ctx.user.id, template);
    });
    emitToSpace(access.page.space_id, { kind: "tree", spaceId: access.page.space_id });
    return toBase({ ...access, page: { ...access.page, is_base: true } });
  }),

  post("/bases/resolve-pages", async (ctx) => {
    const body = input(await readJson(ctx));
    const ids = body.strings("pageIds", 500, { max: 64 }) ?? [];
    return { pages: await resolvePages(ctx.user.id, ids) };
  }),

  get("/bases/:id", async (ctx) => toBase(await requireBase(ctx.user, ctx.params.id!, "reader"))),

  // Rows -------------------------------------------------------------------

  post("/bases/:id/rows/query", async (ctx) => {
    const access = await requireBase(ctx.user, ctx.params.id!, "reader");
    const body = input(await readJson(ctx));
    const props = await loadProperties(access.page.id);
    const { rows, nextCursor } = await queryRows(access.page.id, props, {
      filter: parseFilter(body.raw("filter")),
      sorts: parseSorts(body.raw("sorts")),
      cursor: body.optionalString("cursor", { max: 2000 }),
      limit: body.integer("limit", 1, LIMITS.rowsPerPage) ?? 100,
      tzOffset: body.integer("tzOffset", -900, 900) ?? 0,
    });
    return { items: rows.map(toRow), nextCursor, references: await rowReferences(ctx.user.id, props, rows) };
  }),

  post("/bases/:id/rows", async (ctx) => {
    const access = await requireBase(ctx.user, ctx.params.id!, "writer");
    const body = input(await readJson(ctx, BODY_LIMIT));
    const props = await loadProperties(access.page.id);
    let cells: Record<string, unknown> = {};
    try {
      cells = normalizeCells(props, body.object("cells") ?? {}, true);
    } catch (error) {
      cellError(error);
    }
    for (const [k, v] of Object.entries(cells)) if (v === null) delete cells[k];
    const explicit = position(body);
    const afterRowId = body.optionalUuid("afterRowId");
    const row = await sql.begin(async (tx) => {
      let pos = explicit;
      if (!pos && afterRowId) {
        const [after] = await tx`SELECT position FROM base_rows WHERE id = ${afterRowId} AND page_id = ${access.page.id}`;
        if (after) {
          const [next] = await tx`SELECT min(position) AS position FROM base_rows WHERE page_id = ${access.page.id} AND position > ${after.position}`;
          pos = keyBetween(after.position, next?.position ?? null);
        }
      }
      if (!pos) {
        const [last] = await tx`SELECT max(position) AS position FROM base_rows WHERE page_id = ${access.page.id}`;
        pos = keyBetween(last?.position ?? null, null);
      }
      const now = new Date().toISOString();
      const formulas = computeFormulas(props, cells, { createdAt: now, updatedAt: now });
      for (const [id, value] of Object.entries(formulas)) if (value !== null) cells[id] = value;
      const [inserted] = await tx`
        INSERT INTO base_rows (page_id, cells, position, creator_id, last_editor_id)
        VALUES (${access.page.id}, ${cells}::jsonb, ${pos}, ${ctx.user.id}, ${ctx.user.id})
        RETURNING id, cells, position, creator_id, last_editor_id, created_at, updated_at`;
      return toRow(inserted as RowRecord);
    });
    emit(access, { op: "rowCreated", row }, requestId(body));
    return row;
  }),

  get("/bases/:id/rows/:rowId", async (ctx) => {
    const access = await requireBase(ctx.user, ctx.params.id!, "reader");
    if (!isUuid(ctx.params.rowId)) throw notFound("Row");
    const [row] = await sql`SELECT ${rowColumns()} FROM base_rows r WHERE r.id = ${ctx.params.rowId} AND r.page_id = ${access.page.id}`;
    if (!row) throw notFound("Row");
    const props = await loadProperties(access.page.id);
    return { row: toRow(row as RowRecord), references: await rowReferences(ctx.user.id, props, [row as RowRecord]) };
  }),

  post("/bases/:id/rows/:rowId/update", async (ctx) => {
    const access = await requireBase(ctx.user, ctx.params.id!, "writer");
    const body = input(await readJson(ctx, BODY_LIMIT));
    const props = await loadProperties(access.page.id);
    let patch: Record<string, unknown> = {};
    try {
      patch = normalizeCells(props, body.object("cells") ?? {});
    } catch (error) {
      cellError(error);
    }
    const pos = position(body);
    if (!isUuid(ctx.params.rowId)) throw notFound("Row");
    const result = await sql.begin(async (tx) => {
      const [current] = await tx`
        SELECT ${rowColumns()} FROM base_rows r WHERE r.id = ${ctx.params.rowId!} AND r.page_id = ${access.page.id} FOR UPDATE`;
      if (!current) throw notFound("Row");
      const row = current as RowRecord;
      for (const [k, v] of Object.entries(patch)) if (same(row.cells?.[k], v)) delete patch[k];
      if (Object.keys(patch).length === 0 && (pos === undefined || pos === row.position)) return { row: toRow(row), changed: null };
      const merged: Record<string, unknown> = { ...row.cells };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      const affected = affectedFormulas(props, Object.keys(patch));
      if (affected.length) {
        const values = computeFormulas(props, merged, { createdAt: row.created_at.toISOString(), updatedAt: new Date().toISOString() }, affected);
        for (const [id, value] of Object.entries(values)) if (!same(row.cells?.[id], value)) patch[id] = value;
      }
      const [updated] = await tx`
        UPDATE base_rows SET cells = apply_cell_patch(cells, ${patch}::jsonb), updated_at = now(), last_editor_id = ${ctx.user.id},
          position = coalesce(${pos ?? null}::text, position)
        WHERE id = ${row.id}
        RETURNING id, cells, position, creator_id, last_editor_id, created_at, updated_at`;
      return { row: toRow(updated as RowRecord), changed: patch };
    });
    if (result.changed) {
      emit(
        access,
        {
          op: "rowUpdated",
          rowId: result.row.id,
          cells: result.changed,
          ...(pos !== undefined ? { position: result.row.position } : {}),
          updatedAt: result.row.updatedAt,
          lastEditorId: ctx.user.id,
        },
        requestId(body),
      );
    }
    return result.row;
  }),

  post("/bases/:id/rows/delete", async (ctx) => {
    const access = await requireBase(ctx.user, ctx.params.id!, "writer");
    const body = input(await readJson(ctx));
    const ids = body.uuids("rowIds", 500) ?? [];
    if (ids.length === 0) throw badRequest("rowIds is required");
    const deleted = await sql`DELETE FROM base_rows WHERE page_id = ${access.page.id} AND id = ANY(${sql.array(ids, "uuid")}) RETURNING id`;
    const rowIds = deleted.map((r: { id: string }) => r.id);
    if (rowIds.length) emit(access, { op: "rowsDeleted", rowIds }, requestId(body));
    return { rowIds };
  }),

  // Properties -------------------------------------------------------------

  post("/bases/:id/properties", async (ctx) => {
    const access = await requireBase(ctx.user, ctx.params.id!, "writer");
    const body = input(await readJson(ctx));
    const name = body.string("name", NAME_RULE);
    const type = body.oneOf("type", PROPERTY_TYPES);
    if (!type) throw badRequest("type is required");
    const props = await loadProperties(access.page.id);
    if (props.some((p) => p.name.trim().toLowerCase() === name.toLowerCase())) throw badRequest("A property with this name already exists");
    const id = newPropertyId();
    const options = type === "formula" ? formulaOptions(body.raw("options"), props, id) : parseOptions(type, body.raw("options"));
    const last = props.reduce<string | null>((max, p) => (max === null || p.position > max ? p.position : max), null);
    const property: Property = { id, name, type, options, isPrimary: false, position: keyBetween(last, null) };
    try {
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO base_properties (page_id, id, name, type, options, position)
          VALUES (${access.page.id}, ${id}, ${name}, ${type}, ${options}::jsonb, ${property.position})`;
        if (type === "formula") await backfillFormulas(tx, access.page.id, [...props, property], [id]);
      });
    } catch (error) {
      if (uniqueViolation(error)) throw badRequest("A property with this name already exists");
      throw error;
    }
    await emitBase(access, requestId(body));
    if (type === "formula") emit(access, { op: "rowsChanged" });
    return property;
  }),

  post("/bases/:id/properties/:propertyId/update", async (ctx) => {
    const access = await requireBase(ctx.user, ctx.params.id!, "writer");
    const body = input(await readJson(ctx));
    const props = await loadProperties(access.page.id);
    const prop = props.find((p) => p.id === ctx.params.propertyId);
    if (!prop) throw notFound("Property");
    const name = body.optionalString("name", NAME_RULE);
    const type = body.oneOf("type", PROPERTY_TYPES) ?? prop.type;
    const pos = position(body);
    if (name !== undefined && props.some((p) => p.id !== prop.id && p.name.trim().toLowerCase() === name.toLowerCase())) {
      throw badRequest("A property with this name already exists");
    }
    const typeChanged = type !== prop.type;
    if (typeChanged) {
      if (prop.isPrimary) throw badRequest("The primary property cannot change type");
      if (!isEditableType(prop.type)) throw badRequest("This property cannot change type");
      if (isSystemType(type) || type === "formula") throw badRequest(`A property cannot be converted to ${type}`);
    }
    const renamed = name !== undefined && name !== prop.name;
    const others = props.map((p) => (p.id === prop.id && renamed ? { ...p, name: name! } : p));
    let options = prop.options;
    if (body.has("options") || typeChanged) {
      options = type === "formula" ? formulaOptions(body.raw("options"), others, prop.id) : parseOptions(type, body.has("options") ? body.raw("options") : undefined);
    }
    const next: Property = { ...prop, name: name ?? prop.name, type, options, position: pos ?? prop.position };
    const nextProps = others.map((p) => (p.id === prop.id ? next : p));
    let rowsChanged = false;
    try {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE base_properties SET name = ${next.name}, type = ${next.type}, options = ${next.options}::jsonb,
            position = ${next.position}, updated_at = now()
          WHERE page_id = ${access.page.id} AND id = ${prop.id}`;
        if (renamed) {
          for (const f of nextProps.filter((p) => p.type === "formula" && p.options.dependencies?.includes(prop.id))) {
            const source = renameInSource(f.options.source ?? "", prop.name, next.name);
            if (source === f.options.source) continue;
            f.options = { ...f.options, source };
            await tx`UPDATE base_properties SET options = ${f.options}::jsonb, updated_at = now() WHERE page_id = ${access.page.id} AND id = ${f.id}`;
          }
        }
        if (typeChanged) {
          await convertRows(tx, ctx.user.id, access.page.id, prop, next);
          rowsChanged = true;
        } else if (isChoiceType(type) && body.has("options")) {
          // Removing an option clears it from cells.
          const kept = new Set((next.options.choices ?? []).map((c) => c.id));
          const removed = (prop.options.choices ?? []).filter((c) => !kept.has(c.id));
          if (removed.length) {
            await convertRows(tx, ctx.user.id, access.page.id, prop, next);
            rowsChanged = true;
          }
        } else if (type === "person" && body.has("options") && !!prop.options.allowMultiple !== !!next.options.allowMultiple) {
          await convertRows(tx, ctx.user.id, access.page.id, prop, next);
          rowsChanged = true;
        }
        const recompute = new Set(affectedFormulas(nextProps, [prop.id]));
        if (type === "formula" && body.has("options")) recompute.add(prop.id);
        if ((typeChanged || recompute.size) && (await backfillFormulas(tx, access.page.id, nextProps, [...recompute]))) rowsChanged = true;
      });
    } catch (error) {
      if (uniqueViolation(error)) throw badRequest("A property with this name already exists");
      throw error;
    }
    await emitBase(access, requestId(body));
    if (rowsChanged) emit(access, { op: "rowsChanged" });
    return next;
  }),

  post("/bases/:id/properties/:propertyId/delete", async (ctx) => {
    const access = await requireBase(ctx.user, ctx.params.id!, "writer");
    const body = input(await readJson(ctx));
    const props = await loadProperties(access.page.id);
    const prop = props.find((p) => p.id === ctx.params.propertyId);
    if (!prop) throw notFound("Property");
    if (prop.isPrimary) throw badRequest("The primary property cannot be deleted");
    const rest = props.filter((p) => p.id !== prop.id);
    await sql.begin(async (tx) => {
      await tx`DELETE FROM base_properties WHERE page_id = ${access.page.id} AND id = ${prop.id}`;
      await tx`UPDATE base_rows SET cells = cells - ${prop.id}::text WHERE page_id = ${access.page.id} AND cells ? ${prop.id}::text`;
      await stripFromViews(tx, access.page.id, prop.id);
      await backfillFormulas(tx, access.page.id, rest, affectedFormulas(props, [prop.id]));
    });
    await emitBase(access, requestId(body));
    emit(access, { op: "rowsChanged" });
    return {};
  }),

  // Views ------------------------------------------------------------------

  post("/bases/:id/views", async (ctx) => {
    const access = await requireBase(ctx.user, ctx.params.id!, "writer");
    const body = input(await readJson(ctx));
    const name = body.optionalString("name", { min: 0, max: LIMITS.name }) || "View";
    const type = body.oneOf("type", VIEW_TYPES) ?? "table";
    const config = parseConfig(body.raw("config"));
    const [last] = await sql`SELECT max(position) AS position FROM base_views WHERE page_id = ${access.page.id}`;
    const [row] = await sql`
      INSERT INTO base_views (page_id, name, type, config, position, creator_id)
      VALUES (${access.page.id}, ${name}, ${type}, ${config}::jsonb, ${keyBetween(last?.position ?? null, null)}, ${ctx.user.id})
      RETURNING id, name, type, config, position`;
    await emitBase(access, requestId(body));
    return toView(row);
  }),

  post("/bases/:id/views/:viewId/update", async (ctx) => {
    const access = await requireBase(ctx.user, ctx.params.id!, "writer");
    const body = input(await readJson(ctx));
    if (!isUuid(ctx.params.viewId)) throw notFound("View");
    const [view] = await sql`
      SELECT id, name, type, config, position FROM base_views WHERE page_id = ${access.page.id} AND id = ${ctx.params.viewId}`;
    if (!view) throw notFound("View");
    const name = body.optionalString("name", { min: 0, max: LIMITS.name }) || view.name;
    const type = body.oneOf("type", VIEW_TYPES) ?? view.type;
    const patch = body.object("config");
    const config = patch ? applyConfigPatch(view.config ?? {}, patch) : view.config;
    const pos = position(body) ?? view.position;
    const [row] = await sql`
      UPDATE base_views SET name = ${name}, type = ${type}, config = ${config}::jsonb, position = ${pos}, updated_at = now()
      WHERE id = ${view.id} RETURNING id, name, type, config, position`;
    await emitBase(access, requestId(body));
    return toView(row);
  }),

  post("/bases/:id/views/:viewId/delete", async (ctx) => {
    const access = await requireBase(ctx.user, ctx.params.id!, "writer");
    const body = input(await readJson(ctx));
    if (!isUuid(ctx.params.viewId)) throw notFound("View");
    await sql.begin(async (tx) => {
      const views = await tx`SELECT id FROM base_views WHERE page_id = ${access.page.id} FOR UPDATE`;
      if (!views.some((v: { id: string }) => v.id === ctx.params.viewId!.toLowerCase())) throw notFound("View");
      if (views.length <= 1) throw badRequest("A base must keep at least one view");
      await tx`DELETE FROM base_views WHERE id = ${ctx.params.viewId!}`;
    });
    await emitBase(access, requestId(body));
    return {};
  }),

  // Export -----------------------------------------------------------------

  get("/bases/:id/export.csv", async (ctx) => {
    const access = await requireBase(ctx.user, ctx.params.id!, "reader");
    const props = await loadProperties(access.page.id);
    const batches = allRows(access.page.id);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("\uFEFF" + csvLine(props.map((p) => p.name))));
      },
      async pull(controller) {
        const next = await batches.next();
        if (next.done) return controller.close();
        const refs = await rowReferences(ctx.user.id, props, next.value);
        const lines = next.value.map((row) => {
          const r = toRow(row);
          return csvLine(props.map((p) => cellText(p, r.cells[p.id], r, refs)));
        });
        controller.enqueue(encoder.encode(lines.join("")));
      },
      async cancel() {
        await batches.return(undefined);
      },
    });
    const name = (access.page.title || "Untitled base").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 150);
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": contentDisposition("attachment", `${name}.csv`),
        "Cache-Control": "no-store",
      },
    });
  }),
];
