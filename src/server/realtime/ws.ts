import type { Server, WebSocketHandler } from "bun";
import { config } from "server/config";
import { fail } from "server/lib/http";
import { listReadableSpaceIds } from "server/lib/permissions";
import type { AuthUser } from "server/lib/auth";
import { log } from "server/lib/logger";
import { onMembershipChange, registry, type Socket, type SocketData } from "./hub";
import { disconnect, flushAll, joinPage, leavePage, receiveSteps, refreshOpenSessions, updatePresence } from "./collab";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
/** Messages a socket may send per second before it is disconnected. */
const MAX_MESSAGES_PER_SECOND = 60;

const allowedOrigin = (request: Request): boolean => {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("host");
  try {
    const url = new URL(origin);
    return url.origin === new URL(config.appUrl).origin || url.host === host;
  } catch {
    return false;
  }
};

/** Upgrades an authenticated request to a realtime socket subscribed to the user's spaces. */
export const upgrade = async (request: Request, server: Server<SocketData>, user: AuthUser) => {
  if (!allowedOrigin(request)) return fail(403, "forbidden_origin", "Origin not allowed");
  const spaces = await listReadableSpaceIds(user.id);
  const data: SocketData = {
    connectionId: crypto.randomUUID(),
    userId: user.id,
    userName: user.name,
    spaces: new Set(spaces),
    pages: new Set(),
    windowStart: 0,
    messages: 0,
  };
  if (server.upgrade(request, { data })) return undefined;
  return fail(400, "upgrade_failed", "Expected a WebSocket upgrade");
};

const refreshSpaces = async (sockets: Socket[]) => {
  const byUser = new Map<string, Socket[]>();
  for (const ws of sockets) byUser.set(ws.data.userId, [...(byUser.get(ws.data.userId) ?? []), ws]);
  for (const [userId, userSockets] of byUser) {
    const spaces = await listReadableSpaceIds(userId);
    for (const ws of userSockets) registry.setSpaces(ws, spaces);
  }
};

onMembershipChange((userIds) => {
  const sockets =
    userIds === "all" ? registry.allSockets() : userIds.flatMap((id) => [...registry.userSockets(id)]);
  refreshSpaces(sockets).catch((error) => log.error("refreshing socket subscriptions failed", error));
  refreshOpenSessions(userIds === "all" ? {} : { userIds }).catch((error) => log.error("re-checking editor access failed", error));
});

const send = (ws: Socket, message: Record<string, unknown>) => ws.send(JSON.stringify(message));

const parse = (raw: string | Buffer): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

const handle = async (ws: Socket, message: Record<string, unknown>) => {
  switch (message.t) {
    case "ping":
      send(ws, { t: "pong" });
      return;
    case "join":
      return joinPage(ws, message.pageId, message.version, message.clientId);
    case "leave":
      return leavePage(ws, message.pageId);
    case "steps":
      return receiveSteps(ws, message);
    case "presence":
      return updatePresence(ws, message);
  }
};

export const websocket: WebSocketHandler<SocketData> = {
  maxPayloadLength: MAX_MESSAGE_BYTES,
  idleTimeout: 120,
  open(ws) {
    registry.addSocket(ws);
  },
  async message(ws, raw) {
    const now = Date.now();
    if (now - ws.data.windowStart >= 1000) {
      ws.data.windowStart = now;
      ws.data.messages = 0;
    }
    if (++ws.data.messages > MAX_MESSAGES_PER_SECOND) {
      ws.close(1008, "too many messages");
      return;
    }
    const message = parse(raw);
    if (!message) return;
    try {
      await handle(ws, message);
    } catch (error) {
      log.error("realtime message failed", error);
    }
  },
  close(ws) {
    void disconnect(ws).finally(() => registry.removeSocket(ws));
  },
};

/** Called on shutdown before the database closes: persist pending state, then close sockets. */
export const shutdownRealtime = async () => {
  await flushAll().catch((error) => log.error("flushing documents on shutdown failed", error));
  for (const ws of registry.allSockets()) ws.close(1001, "server shutting down");
};
