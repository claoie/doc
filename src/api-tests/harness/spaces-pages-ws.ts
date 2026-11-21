/** Realtime helpers for the spaces and pages test files. */
import type { Client } from "./client";
import { connect, type Message, type Socket } from "./ws";

/**
 * Resolves once everything the server sent before now has arrived: messages
 * on one socket keep their order, so the answer to a ping comes after them.
 */
export const sync = async (socket: Socket) => {
  socket.send({ t: "ping" });
  await socket.nextOf("pong");
};

/** Opens the realtime socket and waits until the server handles its messages. */
export const openSocket = async (client: Client): Promise<Socket> => {
  const socket = await connect(client);
  await sync(socket);
  return socket;
};

/** The `event` messages received so far, taken out of the inbox, once the socket is in sync. */
export const takeEvents = async (socket: Socket): Promise<Message[]> => {
  await sync(socket);
  const events = socket.inbox.filter((m) => m.t === "event");
  for (const event of events) socket.inbox.splice(socket.inbox.indexOf(event), 1);
  return events;
};

/** Joins a page on the socket, so page-level events reach it; resolves with the server's answer. */
export const joinPage = async (socket: Socket, pageId: string): Promise<Message> => {
  socket.send({ t: "join", pageId, version: 0 });
  return socket.next((m) => (m.t === "joined" || m.t === "error") && m.pageId === pageId);
};

export const treeEvent = (spaceId: string) => ({ t: "event", kind: "tree", spaceId });
