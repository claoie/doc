import { sanitizeStep } from "common/editor/sanitize";
import type { Node } from "common/editor/model";
import { schema, emptyDoc } from "common/editor/doc-schema";
import { Authority } from "common/editor/collab";
import type { Step } from "common/editor/steps";
import { contentSize, nodesToItems } from "common/editor/tokens";
import { isUuid } from "common/ids";
import { canEditPage, canReadPage, loadPageForCollab, savePageContent } from "server/lib/pages";
import { log } from "server/lib/logger";
import { registry, type Socket } from "./hub";

const SAVE_DEBOUNCE_MS = 2_000;
const SAVE_MAX_DELAY_MS = 10_000;
const MAX_STEPS_PER_MESSAGE = 2_000;
const PRESENCE_COLORS = ["#e5484d", "#f76b15", "#ffb224", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];

interface Client {
  clientId: string;
  userId: string;
  name: string;
  color: string;
  readOnly: boolean;
  selection: { anchor: number; head: number } | null;
}

class PageSession {
  readonly clients = new Map<Socket, Client>();
  readonly editors = new Set<string>();
  lastEditor: string | null = null;
  dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt = 0;
  private saving: Promise<void> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly pageId: string,
    readonly authority: Authority,
  ) {}

  scheduleSave() {
    const now = Date.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = now;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, this.firstDirtyAt + SAVE_MAX_DELAY_MS - now));
    this.saveTimer = setTimeout(() => void this.save(), wait);
  }

  async save(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.saving) await this.saving;
    if (!this.dirty) return;
    this.dirty = false;
    this.firstDirtyAt = 0;
    const contributors = [...this.editors];
    this.editors.clear();
    const input = {
      content: this.authority.doc,
      docVersion: this.authority.version,
      editorId: this.lastEditor,
      contributorIds: contributors,
    };
    this.saving = savePageContent(this.pageId, input)
      .catch((error) => {
        // Keep the changes in memory and try again on the next edit or close.
        this.dirty = true;
        for (const id of contributors) this.editors.add(id);
        log.error("saving page content failed", error, { pageId: this.pageId });
      })
      .finally(() => {
        this.saving = null;
      });
    await this.saving;
  }

  broadcast(message: Record<string, unknown>, except?: Socket) {
    const data = JSON.stringify(message);
    for (const ws of this.clients.keys()) if (ws !== except) ws.send(data);
  }

  sendPresence() {
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      const users = [...this.clients.values()].map((c) => ({
        clientId: c.clientId,
        userId: c.userId,
        name: c.name,
        color: c.color,
        selection: c.selection,
      }));
      this.broadcast({ t: "presence", pageId: this.pageId, users });
    }, 50);
  }
}

const sessions = new Map<string, Promise<PageSession | null>>();

const openSession = (pageId: string): Promise<PageSession | null> => {
  let pending = sessions.get(pageId);
  if (!pending) {
    pending = loadPageForCollab(pageId).then((row) => {
      if (!row) return null;
      const doc = row.content && (row.content.content ?? []).length ? row.content : emptyDoc();
      return new PageSession(pageId, new Authority(schema, doc, row.docVersion));
    });
    pending.catch(() => sessions.delete(pageId));
    sessions.set(pageId, pending);
  }
  return pending;
};

const colorFor = (userId: string) => {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length]!;
};

const send = (ws: Socket, message: Record<string, unknown>) => ws.send(JSON.stringify(message));

const isStep = (value: unknown): value is Step => {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  const num = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  switch (s.stepType) {
    case "replace":
      return num(s.from) && num(s.to) && Array.isArray(s.slice);
    case "replaceAround":
      return num(s.from) && num(s.to) && num(s.gapFrom) && num(s.gapTo) && num(s.insert) && Array.isArray(s.slice);
    case "addMark":
    case "removeMark":
      return num(s.from) && num(s.to) && !!s.mark && typeof (s.mark as Record<string, unknown>).type === "string";
    case "attr":
      return num(s.pos) && !!s.attrs && typeof s.attrs === "object";
    default:
      return false;
  }
};

/** Sends whatever brings a client at `version` up to date. */
const catchUp = (ws: Socket, session: PageSession, version: number, readOnly: boolean) => {
  const { authority } = session;
  const missed = version === authority.version ? null : authority.stepsSince(version);
  if (version === authority.version) {
    send(ws, { t: "joined", pageId: session.pageId, version, readOnly });
  } else if (missed) {
    send(ws, { t: "joined", pageId: session.pageId, version, readOnly });
    send(ws, { t: "steps", pageId: session.pageId, version: missed.version, steps: missed.steps, clientIds: missed.clientIds });
  } else {
    send(ws, { t: "joined", pageId: session.pageId, version: authority.version, doc: authority.doc, readOnly });
  }
};

/** Sessions are keyed by the canonical (lower-case) page id. */
const pageKey = (value: unknown): string | null => (isUuid(value) ? value.toLowerCase() : null);

export const joinPage = async (ws: Socket, rawPageId: unknown, version: unknown, clientId?: unknown) => {
  const pageId = pageKey(rawPageId);
  if (!pageId) return;
  const userId = ws.data.userId;
  if (!(await canReadPage(userId, pageId))) {
    send(ws, { t: "error", pageId, message: "You do not have access to this page" });
    return;
  }
  const readOnly = !(await canEditPage(userId, pageId));
  const session = await openSession(pageId);
  if (!session) {
    send(ws, { t: "error", pageId, message: "Page not found" });
    return;
  }
  const existing = session.clients.get(ws);
  session.clients.set(ws, {
    clientId: typeof clientId === "string" && clientId.length <= 64 ? clientId : (existing?.clientId ?? ""),
    userId,
    name: ws.data.userName,
    color: colorFor(userId),
    readOnly,
    selection: existing?.selection ?? null,
  });
  registry.joinPage(ws, pageId);
  const v = typeof version === "number" && Number.isInteger(version) ? version : -1;
  catchUp(ws, session, v, readOnly);
  session.sendPresence();
};

export const leavePage = async (ws: Socket, rawPageId: unknown) => {
  const pageId = pageKey(rawPageId);
  if (!pageId) return;
  registry.leavePage(ws, pageId);
  const pending = sessions.get(pageId);
  if (!pending) return;
  const session = await pending;
  if (!session || !session.clients.delete(ws)) return;
  session.sendPresence();
  if (session.clients.size === 0) {
    await session.save();
    // Someone may have re-joined while saving.
    if (session.clients.size === 0 && !session.dirty) sessions.delete(pageId);
  }
};

export const receiveSteps = async (ws: Socket, message: Record<string, unknown>) => {
  const { version, steps, clientId } = message;
  const pageId = pageKey(message.pageId);
  if (!pageId || typeof clientId !== "string" || clientId.length > 64) return;
  const session = await sessions.get(pageId);
  const client = session?.clients.get(ws);
  if (!session || !client) {
    send(ws, { t: "error", pageId, message: "Join the page before editing" });
    return;
  }
  if (client.readOnly) {
    send(ws, { t: "error", pageId, message: "This page is read-only for you" });
    return;
  }
  client.clientId = clientId;
  if (typeof version !== "number" || !Array.isArray(steps) || steps.length > MAX_STEPS_PER_MESSAGE || !steps.every(isStep)) {
    send(ws, { t: "rejected", pageId });
    return;
  }
  const { authority } = session;
  if (version !== authority.version) {
    send(ws, { t: "rejected", pageId });
    catchUp(ws, session, version, client.readOnly);
    return;
  }
  const accepted = authority.receive(version, steps.map(sanitizeStep), clientId);
  if (!accepted) {
    // The steps do not apply to the current document: reset this client.
    const message =
      authority.rejection === "too-large" ? "This page is too large to add more to it." : "A change could not be applied; the page was reloaded.";
    send(ws, { t: "error", pageId, message });
    send(ws, { t: "joined", pageId, version: authority.version, doc: authority.doc, readOnly: client.readOnly });
    return;
  }
  session.broadcast({ t: "steps", pageId, version: authority.version, steps: accepted, clientIds: accepted.map(() => clientId) });
  session.dirty = true;
  session.editors.add(client.userId);
  session.lastEditor = client.userId;
  session.scheduleSave();
};

export const updatePresence = async (ws: Socket, message: Record<string, unknown>) => {
  const { selection } = message;
  const pageId = pageKey(message.pageId);
  if (!pageId) return;
  const session = await sessions.get(pageId);
  const client = session?.clients.get(ws);
  if (!session || !client) return;
  const sel = selection as { anchor?: unknown; head?: unknown } | null;
  client.selection =
    sel && typeof sel.anchor === "number" && typeof sel.head === "number" ? { anchor: sel.anchor, head: sel.head } : null;
  session.sendPresence();
};

export const disconnect = async (ws: Socket) => {
  for (const pageId of [...ws.data.pages]) await leavePage(ws, pageId);
};

/**
 * Replaces a page's whole document from outside the editor (imports). Open
 * editors receive it as a regular step.
 */
export const replacePageContent = async (pageId: string, content: Node, userId: string) => {
  const session = await openSession(pageId);
  if (!session) return false;
  const { authority } = session;
  const size = contentSize(authority.doc, schema);
  const step: Step = { stepType: "replace", from: 0, to: size, slice: nodesToItems(content.content ?? [], schema) };
  const accepted = authority.receive(authority.version, [step], "server");
  if (!accepted) {
    if (session.clients.size === 0 && !session.dirty) sessions.delete(pageId);
    throw new Error(authority.rejection === "too-large" ? "too-large" : "invalid");
  }
  session.broadcast({ t: "steps", pageId, version: authority.version, steps: accepted, clientIds: ["server"] });
  session.dirty = true;
  session.editors.add(userId);
  session.lastEditor = userId;
  await session.save();
  // A failed save stays in memory for the next save attempt; report it.
  if (session.dirty) throw new Error("Saving the page failed");
  if (session.clients.size === 0) sessions.delete(pageId);
  return true;
};

/** Saves every open document (shutdown). */
export const flushAll = async () => {
  const all = await Promise.all([...sessions.values()]);
  await Promise.all(all.map((s) => s?.save()));
};

/** Drops a client whose access was removed, or updates whether it may edit. */
const recheckClient = async (session: PageSession, ws: Socket, client: Client) => {
  const { pageId } = session;
  if (!(await canReadPage(client.userId, pageId))) {
    send(ws, { t: "error", pageId, message: "You no longer have access to this page" });
    await leavePage(ws, pageId);
    return;
  }
  const readOnly = !(await canEditPage(client.userId, pageId));
  if (readOnly !== client.readOnly) {
    client.readOnly = readOnly;
    send(ws, { t: "joined", pageId, version: session.authority.version, readOnly });
  }
};

/**
 * Re-checks access for open editors after membership, role, trash or move
 * changes, limited to the given users and/or pages.
 */
export const refreshOpenSessions = async ({ userIds, pageIds }: { userIds?: readonly string[]; pageIds?: readonly string[] } = {}) => {
  const pages = pageIds ? new Set(pageIds) : null;
  for (const [pageId, pending] of [...sessions]) {
    if (pages && !pages.has(pageId)) continue;
    const session = await pending;
    if (!session) continue;
    for (const [ws, client] of [...session.clients]) {
      if (userIds && !userIds.includes(client.userId)) continue;
      await recheckClient(session, ws, client);
    }
  }
};
