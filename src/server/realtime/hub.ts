import type { ServerWebSocket } from "bun";
import type { RealtimeEvent } from "common/api-types";

export interface SocketData {
  connectionId: string;
  userId: string;
  userName: string;
  /** Spaces whose tree events this socket receives. */
  spaces: Set<string>;
  /** Pages this socket has joined. */
  pages: Set<string>;
  /** Rate limiting: start of the current one-second window and messages in it. */
  windowStart: number;
  messages: number;
}

export type Socket = ServerWebSocket<SocketData>;

const byUser = new Map<string, Set<Socket>>();
const bySpace = new Map<string, Set<Socket>>();
const byPage = new Map<string, Set<Socket>>();

const add = (map: Map<string, Set<Socket>>, key: string, ws: Socket) => {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(ws);
};

const remove = (map: Map<string, Set<Socket>>, key: string, ws: Socket) => {
  const set = map.get(key);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) map.delete(key);
};

export const registry = {
  addSocket(ws: Socket) {
    add(byUser, ws.data.userId, ws);
    for (const spaceId of ws.data.spaces) add(bySpace, spaceId, ws);
    for (const pageId of ws.data.pages) add(byPage, pageId, ws);
  },
  removeSocket(ws: Socket) {
    remove(byUser, ws.data.userId, ws);
    for (const spaceId of ws.data.spaces) remove(bySpace, spaceId, ws);
    for (const pageId of ws.data.pages) remove(byPage, pageId, ws);
  },
  setSpaces(ws: Socket, spaceIds: Iterable<string>) {
    for (const spaceId of ws.data.spaces) remove(bySpace, spaceId, ws);
    ws.data.spaces = new Set(spaceIds);
    for (const spaceId of ws.data.spaces) add(bySpace, spaceId, ws);
  },
  joinPage(ws: Socket, pageId: string) {
    ws.data.pages.add(pageId);
    add(byPage, pageId, ws);
  },
  leavePage(ws: Socket, pageId: string) {
    ws.data.pages.delete(pageId);
    remove(byPage, pageId, ws);
  },
  userSockets: (userId: string): ReadonlySet<Socket> => byUser.get(userId) ?? new Set(),
  pageSockets: (pageId: string): ReadonlySet<Socket> => byPage.get(pageId) ?? new Set(),
  spaceSockets: (spaceId: string): ReadonlySet<Socket> => bySpace.get(spaceId) ?? new Set(),
  allSockets: (): Socket[] => [...byUser.values()].flatMap((set) => [...set]),
};

const broadcast = (sockets: ReadonlySet<Socket> | undefined, event: RealtimeEvent) => {
  if (!sockets?.size) return;
  const message = JSON.stringify({ t: "event", ...event });
  for (const ws of sockets) ws.send(message);
};

export const emitToSpace = (spaceId: string, event: RealtimeEvent) => broadcast(bySpace.get(spaceId), event);
export const emitToUser = (userId: string, event: RealtimeEvent) => broadcast(byUser.get(userId), event);
export const emitToPage = (pageId: string, event: RealtimeEvent) => broadcast(byPage.get(pageId), event);

type MembershipListener = (userIds: readonly string[] | "all") => void;
let membershipListener: MembershipListener | null = null;

/** Registers the handler that refreshes socket space subscriptions after membership changes. */
export const onMembershipChange = (listener: MembershipListener) => {
  membershipListener = listener;
};

/** Called by routes whenever space access may have changed for these users. */
export const membershipChanged = (userIds: readonly string[] | "all") => {
  if (userIds !== "all" && userIds.length === 0) return;
  membershipListener?.(userIds);
};

/** Closes every socket of a user (deactivation, deletion, password reset). */
export const disconnectUser = (userId: string) => {
  for (const ws of [...(byUser.get(userId) ?? [])]) ws.close(4001, "signed out");
};
