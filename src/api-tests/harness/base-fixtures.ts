/**
 * Helpers shared by the test files about bases (`bases*.test.ts`,
 * `base-*.test.ts`): building bases, properties and rows through the API, and
 * the shapes every one of those files asserts.
 */
import { expect } from "bun:test";
import type { Base, Property, Row, RowsPage, View } from "common/bases";
import type { ApiResponse, Client } from "./client";
import type { Message, Socket } from "./ws";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `Date.prototype.toISOString` form: milliseconds and `Z`. */
export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Property ids: `p` and nine of `[0-9a-z]`. */
export const PROPERTY_ID = /^p[0-9a-z]{9}$/;
export const SLUG_ID = /^[0-9A-Za-z]{10}$/;

/** Asserts the whole error answer: status, code and message. */
export const expectError = (res: ApiResponse, status: number, code: string, message: string) => {
  expect({ status: res.status, body: res.body as unknown }).toEqual({ status, body: { error: { code, message } } });
};

/** A 400 `invalid_input` with exactly this message. */
export const expectInvalid = (res: ApiResponse, message: string) => expectError(res, 400, "invalid_input", message);

/** The `data` of an answer that must be a 200; loosely typed, as tests compare it with literals and matchers. */
export const ok = (res: ApiResponse): any => {
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${res.text}`);
  return res.body.data;
};

export const getBase = async (client: Client, id: string): Promise<Base> => ok(await client.get<Base>(`/bases/${id}`));

export const createBase = async (
  client: Client,
  spaceId: string,
  options: { title?: string | null; template?: "table" | "kanban"; parentId?: string } = {},
): Promise<Base> => {
  const { title = "Tasks", ...rest } = options;
  const created = ok(await client.post("/bases", { spaceId, title, ...rest }));
  return getBase(client, created.page.id);
};

export const addProperty = async (client: Client, baseId: string, name: string, type: string, options?: unknown): Promise<Property> =>
  ok(await client.post<Property>(`/bases/${baseId}/properties`, { name, type, options }));

export const updateProperty = async (client: Client, baseId: string, propertyId: string, body: Record<string, unknown>): Promise<Property> =>
  ok(await client.post<Property>(`/bases/${baseId}/properties/${propertyId}/update`, body));

export const addRow = async (client: Client, baseId: string, cells: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<Row> =>
  ok(await client.post<Row>(`/bases/${baseId}/rows`, { cells, ...extra }));

export const updateRow = async (client: Client, baseId: string, rowId: string, cells: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Row> =>
  ok(await client.post<Row>(`/bases/${baseId}/rows/${rowId}/update`, { cells, ...extra }));

export const getRow = async (client: Client, baseId: string, rowId: string): Promise<Row> =>
  ok(await client.get<{ row: Row }>(`/bases/${baseId}/rows/${rowId}`)).row;

export const queryRows = async (client: Client, baseId: string, body: Record<string, unknown> = {}): Promise<RowsPage> =>
  ok(await client.post<RowsPage>(`/bases/${baseId}/rows/query`, body));

/** Every row of a base in display order, following the cursors. */
export const allRows = async (client: Client, baseId: string, body: Record<string, unknown> = {}): Promise<Row[]> => {
  const rows: Row[] = [];
  let cursor: string | null = null;
  do {
    const page: RowsPage = await queryRows(client, baseId, { limit: 500, ...body, ...(cursor ? { cursor } : {}) });
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
};

/** Deletes the empty row a new base is seeded with, so a test starts from no rows. */
export const emptyBase = async (client: Client, baseId: string) => {
  const { items } = await queryRows(client, baseId);
  if (items.length) ok(await client.post(`/bases/${baseId}/rows/delete`, { rowIds: items.map((r) => r.id) }));
};

export const addView = async (client: Client, baseId: string, body: Record<string, unknown> = {}): Promise<View> =>
  ok(await client.post<View>(`/bases/${baseId}/views`, body));

export const and = (...children: unknown[]) => ({ op: "and", children });
export const or = (...children: unknown[]) => ({ op: "or", children });
/** A filter of one condition. */
export const where = (propertyId: string, op: string, value?: unknown) => and(value === undefined ? { propertyId, op } : { propertyId, op, value });

/** The next realtime event of a base (`kind: "base"`), optionally of one page and one `op`. */
export const nextBaseEvent = (socket: Socket, pageId?: string, op?: string): Promise<Message> =>
  socket.next((m) => m.t === "event" && m.kind === "base" && (!pageId || m.pageId === pageId) && (!op || m.event?.op === op));

/** The realtime events of bases the socket has received and not yet handed out, oldest first; they are removed from the inbox. */
export const drainBaseEvents = (socket: Socket, pageId?: string): Message[] => {
  const found: Message[] = [];
  for (let i = 0; i < socket.inbox.length; ) {
    const m = socket.inbox[i]!;
    if (m.t === "event" && m.kind === "base" && (!pageId || m.pageId === pageId)) found.push(...socket.inbox.splice(i, 1));
    else i++;
  }
  return found;
};

/**
 * Proves no realtime message is on its way: the server sends in order, so
 * once the answer to a ping sent now has arrived, everything sent before it
 * has arrived too. Returns what came in meanwhile, apart from the pong.
 */
export const settle = async (socket: Socket): Promise<Message[]> => {
  socket.send({ t: "ping" });
  await socket.nextOf("pong");
  return socket.inbox.splice(0);
};

/** The text of a `rows/query` cursor, decoded. */
export const decodeCursor = (cursor: string): unknown => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
export const encodeCursor = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

/** The shape of a row as every endpoint returns it. */
export const rowShape = (overrides: Partial<Record<keyof Row, unknown>> = {}) => ({
  id: expect.stringMatching(UUID),
  cells: {},
  position: expect.any(String),
  creatorId: expect.stringMatching(UUID),
  lastEditorId: expect.stringMatching(UUID),
  createdAt: expect.stringMatching(ISO),
  updatedAt: expect.stringMatching(ISO),
  ...overrides,
});
