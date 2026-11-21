import type { Client } from "./client";

export type Message = Record<string, any>;

export interface Socket {
  ws: WebSocket;
  /** Every message received so far that `next` has not handed out. */
  inbox: Message[];
  /** The next message matching `pred`, waiting up to `timeoutMs` for it. */
  next(pred?: (m: Message) => boolean, timeoutMs?: number): Promise<Message>;
  /** Shorthand for `next` on the message type `t` (and, optionally, more fields). */
  nextOf(t: string, fields?: Message, timeoutMs?: number): Promise<Message>;
  /** Resolves true when no message matching `pred` arrives within `ms`. */
  quiet(pred: (m: Message) => boolean, ms?: number): Promise<boolean>;
  send(message: Message | string): void;
  /** Resolves with the close code and reason once the socket closes. */
  closed: Promise<{ code: number; reason: string }>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  headers?: Record<string, string>;
  /** Path of the socket endpoint. */
  path?: string;
}

/**
 * Opens the realtime socket as `client`. Resolves once it is open, or rejects
 * when the server refuses the upgrade.
 */
export const connect = (client: Client, options: ConnectOptions = {}): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const headers = { cookie: client.cookieHeader(), "x-forwarded-for": client.ip, ...options.headers };
    const ws = new WebSocket(`${client.base.replace(/^http/, "ws")}${options.path ?? "/api/ws"}`, { headers } as never);
    const inbox: Message[] = [];
    const waiters: ((m: Message) => boolean)[] = [];
    let opened = false;
    let resolveClosed: (value: { code: number; reason: string }) => void = () => undefined;
    const closed = new Promise<{ code: number; reason: string }>((r) => (resolveClosed = r));

    ws.onmessage = (event) => {
      let message: Message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        message = { t: "unparsed", raw: String(event.data) };
      }
      const index = waiters.findIndex((waiter) => waiter(message));
      if (index >= 0) waiters.splice(index, 1);
      else inbox.push(message);
    };
    ws.onclose = (event) => {
      resolveClosed({ code: event.code, reason: event.reason });
      if (!opened) reject(new Error(`socket closed before opening (${event.code})`));
    };
    ws.onerror = () => {
      if (!opened) reject(new Error("socket failed to open"));
    };

    const next = (pred: (m: Message) => boolean = () => true, timeoutMs = 3000): Promise<Message> =>
      new Promise((done, failed) => {
        const found = inbox.findIndex(pred);
        if (found >= 0) return done(inbox.splice(found, 1)[0]!);
        const waiter = (m: Message) => {
          if (!pred(m)) return false;
          clearTimeout(timer);
          done(m);
          return true;
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          failed(new Error(`timed out waiting for a socket message; inbox: ${JSON.stringify(inbox).slice(0, 500)}`));
        }, timeoutMs);
        waiters.push(waiter);
      });

    ws.onopen = () => {
      opened = true;
      resolve({
        ws,
        inbox,
        next,
        nextOf: (t, fields = {}, timeoutMs) =>
          next((m) => m.t === t && Object.entries(fields).every(([key, value]) => m[key] === value), timeoutMs),
        quiet: (pred, ms = 300) =>
          next(pred, ms).then(
            () => false,
            () => true,
          ),
        send: (message) => ws.send(typeof message === "string" ? message : JSON.stringify(message)),
        closed,
        async close() {
          ws.close();
          await closed;
        },
      });
    };
  });
