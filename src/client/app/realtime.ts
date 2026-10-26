import type { RealtimeEvent } from "common/api-types";
import type { Node } from "common/editor/model";
import type { Step } from "common/editor/steps";

export interface PresenceUser {
  clientId: string;
  userId: string;
  name: string;
  color: string;
  selection: { anchor: number; head: number } | null;
}

export type ServerMessage =
  | { t: "joined"; pageId: string; version: number; doc?: Node; readOnly: boolean }
  | { t: "steps"; pageId: string; version: number; steps: Step[]; clientIds: string[] }
  | { t: "rejected"; pageId: string }
  | { t: "presence"; pageId: string; users: PresenceUser[] }
  | ({ t: "event" } & RealtimeEvent)
  | { t: "error"; pageId?: string; message: string }
  | { t: "pong" };

export interface PageChannel {
  onJoined: (msg: Extract<ServerMessage, { t: "joined" }>) => void;
  onSteps: (msg: Extract<ServerMessage, { t: "steps" }>) => void;
  onRejected: () => void;
  onPresence: (users: PresenceUser[]) => void;
  onError?: (message: string) => void;
  /** Called after a reconnect so the channel can re-join with its version. */
  onReconnect: () => void;
}

type Status = "connecting" | "open" | "closed";

/**
 * One WebSocket per tab carries collaborative editing for open pages,
 * presence, and app events (tree changes, comments, notifications).
 */
class Realtime {
  private ws: WebSocket | null = null;
  private retry = 0;
  private queue: string[] = [];
  private pages = new Map<string, PageChannel>();
  private eventListeners = new Set<(e: RealtimeEvent) => void>();
  private statusListeners = new Set<(s: Status) => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  status: Status = "closed";

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    this.setStatus("closed");
  }

  private setStatus(s: Status) {
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  private connect() {
    if (this.stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    this.ws = ws;
    this.setStatus("connecting");
    ws.onopen = () => {
      const reconnected = this.retry > 0 || this.everOpened;
      this.everOpened = true;
      this.retry = 0;
      this.setStatus("open");
      for (const msg of this.queue.splice(0)) ws.send(msg);
      if (reconnected) this.pages.forEach((p) => p.onReconnect());
      this.pingTimer = setInterval(() => this.send({ t: "ping" }), 25_000);
    };
    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      this.route(msg);
    };
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.ws === ws) this.ws = null;
      this.setStatus("closed");
      if (this.stopped) return;
      const delay = Math.min(15_000, 500 * 2 ** this.retry++) + Math.random() * 300;
      setTimeout(() => this.connect(), delay);
    };
  }

  private everOpened = false;

  private route(msg: ServerMessage) {
    if (msg.t === "event") {
      const { t: _t, ...event } = msg;
      this.eventListeners.forEach((l) => l(event as RealtimeEvent));
      return;
    }
    if (msg.t === "pong") return;
    const channel = "pageId" in msg && msg.pageId ? this.pages.get(msg.pageId) : undefined;
    if (!channel) return;
    switch (msg.t) {
      case "joined":
        channel.onJoined(msg);
        break;
      case "steps":
        channel.onSteps(msg);
        break;
      case "rejected":
        channel.onRejected();
        break;
      case "presence":
        channel.onPresence(msg.users);
        break;
      case "error":
        channel.onError?.(msg.message);
        break;
    }
  }

  send(msg: Record<string, unknown>) {
    const data = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else if (msg.t !== "ping" && msg.t !== "presence") this.queue.push(data);
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  openPage(pageId: string, channel: PageChannel, version: number, clientId: string) {
    this.pages.set(pageId, channel);
    this.send({ t: "join", pageId, version, clientId });
    return () => {
      if (this.pages.get(pageId) === channel) {
        this.pages.delete(pageId);
        this.send({ t: "leave", pageId });
      }
    };
  }

  onEvent(fn: (e: RealtimeEvent) => void) {
    this.eventListeners.add(fn);
    return () => {
      this.eventListeners.delete(fn);
    };
  }

  onStatus(fn: (s: Status) => void) {
    this.statusListeners.add(fn);
    return () => {
      this.statusListeners.delete(fn);
    };
  }
}

export const realtime = new Realtime();
