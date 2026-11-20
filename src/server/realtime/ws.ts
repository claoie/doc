import type { Server, WebSocketHandler } from "bun";
import { config } from "server/config";
import { fail } from "server/lib/http";
import { listReadableSpaceIds } from "server/lib/permissions";
import { liveSessions, type AuthSession, type AuthUser } from "server/lib/auth";
import { log } from "server/lib/logger";
import { SIGNED_OUT, onMembershipChange, registry, type Socket, type SocketData } from "./hub";
import { disconnect, flushAll, joinPage, leavePage, receiveSteps, refreshOpenSessions, updatePresence } from "./collab";
import { isLeader, onLeadLost, releaseLease, stopLeading } from "./leader";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
/** Messages a socket may send per second before it is disconnected. */
const MAX_MESSAGES_PER_SECOND = 60;
/** "Try again later": clients reconnect, which reaches the leader within a try or two. */
const NOT_LEADER = 1013;
/** How often the leader checks that every open socket's session is still signed in. */
const SESSION_CHECK_MS = 60_000;

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
export const upgrade = async (request: Request, server: Server<SocketData>, user: AuthUser, session: AuthSession) => {
  if (!allowedOrigin(request)) return fail(403, "forbidden_origin", "Origin not allowed");
  const spaces = await listReadableSpaceIds(user.id);
  const data: SocketData = {
    connectionId: crypto.randomUUID(),
    sessionId: session.id,
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

// Turned away at once, not at their next message: a quiet editor would miss
// what others type on the new leader, and if this copy leads again, its
// session may have gone stale under it.
onLeadLost(() => {
  for (const ws of registry.allSockets()) ws.close(NOT_LEADER, "not the realtime leader");
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
    // Turned away here, not refused at the upgrade: clients back off further
    // after each connection that fails, and not after one that opened, so
    // they keep trying every second or so until they reach the leader.
    if (!isLeader()) {
      ws.close(NOT_LEADER, "not the realtime leader");
      return;
    }
    registry.addSocket(ws);
  },
  async message(ws, raw) {
    if (!isLeader()) {
      ws.close(NOT_LEADER, "not the realtime leader");
      return;
    }
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

/**
 * A socket never looks at its session again after it opens, and what ends a
 * session (signing out, deactivation, an identity provider's event) may happen
 * on another copy of the server. So the leader checks every open socket's
 * session at once, and closes the sockets whose session is no longer signed
 * in, as `disconnectUser` does.
 */
export const checkSocketSessions = async () => {
  if (!isLeader()) return;
  const sockets = registry.allSockets();
  if (sockets.length === 0) return;
  const live = await liveSessions([...new Set(sockets.map((ws) => ws.data.sessionId))]);
  for (const ws of sockets) if (!live.has(ws.data.sessionId)) ws.close(SIGNED_OUT, "signed out");
};

let sessionChecks: ReturnType<typeof setInterval> | null = null;

export const startSessionChecks = () => {
  sessionChecks ??= setInterval(() => {
    checkSocketSessions().catch((error) => log.error("checking socket sessions failed", error));
  }, SESSION_CHECK_MS);
  sessionChecks.unref();
};

/**
 * Called on shutdown before the database closes. Sockets go first so nothing
 * is accepted after the last save: clients resend what wasn't confirmed. The
 * lease goes last so a successor only loads documents once they are saved.
 */
export const shutdownRealtime = async () => {
  if (sessionChecks) clearInterval(sessionChecks);
  sessionChecks = null;
  stopLeading();
  for (const ws of registry.allSockets()) ws.close(1001, "server shutting down");
  await flushAll().catch((error) => log.error("flushing documents on shutdown failed", error));
  await releaseLease().catch((error) => log.error("releasing the realtime lease failed", error));
};
