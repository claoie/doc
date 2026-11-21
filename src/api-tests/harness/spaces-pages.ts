/**
 * Helpers shared by the test files for spaces, pages and what hangs off a
 * page (labels, favorites, watching, comments, notifications, search).
 */
import { expect } from "bun:test";
import type { ApiResponse, Client } from "./client";
import type { TestServer } from "./server";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Timestamps are ISO strings in UTC with millisecond precision. */
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const SLUG_ID_RE = /^[0-9A-Za-z]{10}$/;

export const anyId = () => expect.stringMatching(UUID_RE);
export const anyTime = () => expect.stringMatching(ISO_RE);

/** A well-formed id that names nothing. */
export const NO_SUCH_ID = "00000000-0000-4000-8000-000000000000";

/** Asserts the whole error answer: status, code and message. */
export const expectError = (res: ApiResponse, status: number, code: string, message: string) => {
  expect({ status: res.status, body: res.body }).toEqual({ status, body: { error: { code, message } } } as never);
};

export const expectInvalid = (res: ApiResponse, message: string) => expectError(res, 400, "invalid_input", message);
export const expectForbidden = (res: ApiResponse, message = "You do not have permission to do this") =>
  expectError(res, 403, "forbidden", message);
export const expectNotFound = (res: ApiResponse, what: string) => expectError(res, 404, "not_found", `${what} not found`);
export const expectUnauthorized = (res: ApiResponse) => expectError(res, 401, "unauthorized", "Sign in required");

/** The answer's payload; fails with the error body when the request did not succeed. */
export const data = (res: ApiResponse): any => {
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${res.text}`);
  return res.body.data;
};

/** The compact reference to a user that pages, comments and notifications embed. */
export const userRef = (user: { id: string; name: string }) => ({ id: user.id, name: user.name, avatarUrl: null });

export interface Person {
  client: Client;
  user: any;
  id: string;
}

/** Invites and signs up a workspace member, optionally granting a role in a space. */
export const person = async (
  t: TestServer,
  owner: Client,
  email: string,
  options: { role?: "admin" | "member"; space?: string; spaceRole?: "admin" | "writer" | "reader" } = {},
): Promise<Person> => {
  const { client, user } = await t.addMember(owner, email, options.role ?? "member");
  if (options.space) {
    data(await owner.post(`/spaces/${options.space}/members/add`, { role: options.spaceRole ?? "writer", userIds: [user.id] }));
  }
  return { client, user, id: user.id };
};

export const createSpace = async (client: Client, name: string, slug: string) =>
  data(await client.post("/spaces", { name, slug })).space;

export const createPage = async (client: Client, body: Record<string, unknown>) => data(await client.post("/pages", body)).page;

/** The `treeItem` of a page as created (no children, not a base). */
export const treeItem = (page: any, overrides: Record<string, unknown> = {}) => ({
  id: page.id,
  slugId: page.slugId,
  title: page.title,
  icon: page.icon,
  parentId: page.parentId,
  spaceId: page.spaceId,
  position: page.position,
  hasChildren: false,
  isBase: false,
  ...overrides,
});

export const spaceRef = (space: any) => ({ id: space.id, name: space.name, slug: space.slug, iconUrl: space.iconUrl ?? null });

export const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
export const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
export const docOf = (...content: unknown[]) => ({ type: "doc", content });

/** The space-member row id of a user (or group) in a space. */
export const memberRow = async (client: Client, spaceId: string, id: string): Promise<string> => {
  const rows = data(await client.get(`/spaces/${spaceId}/members`)) as any[];
  const row = rows.find((r) => r.user?.id === id || r.group?.id === id);
  if (!row) throw new Error(`no space member for ${id}`);
  return row.id;
};

/** Titles of the pages of a listing, in order. */
export const titles = (res: ApiResponse) => (data(res) as any[]).map((p) => p.title);

/** Waits until `count` mails were delivered and forgets them (signing a member up sends two). */
export const drainMail = async (t: TestServer, count: number) => {
  await t.smtp.waitFor(count);
  t.smtp.clear();
};
