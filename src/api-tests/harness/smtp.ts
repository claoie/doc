import net from "node:net";

/** One message the server under test delivered. */
export interface ReceivedMail {
  /** Envelope sender and recipient (MAIL FROM / RCPT TO). */
  from: string;
  to: string;
  /** Decoded headers, lower-cased names. */
  headers: Record<string, string>;
  subject: string;
  /** Decoded text/plain and text/html parts. */
  text: string;
  html: string;
  /** The message as it came over the wire, after dot-unstuffing. */
  raw: string;
}

export interface SmtpSession {
  /** Every command line the client sent, in order (AUTH payloads included). */
  commands: string[];
}

export interface FakeSmtpOptions {
  /** Capability lines after the greeting line of the EHLO answer. Default: none. */
  capabilities?: string[];
}

export interface FakeSmtp {
  port: number;
  /** Delivered messages, in order. */
  outbox: ReceivedMail[];
  sessions: SmtpSession[];
  /** The next `n` deliveries are refused with 451 at the end of DATA. */
  failNext(n: number): void;
  /** Resolves once the outbox holds `count` messages. */
  waitFor(count: number, timeoutMs?: number): Promise<ReceivedMail[]>;
  /** Resolves once no message has arrived for `quietMs`. */
  settle(quietMs?: number): Promise<void>;
  clear(): void;
  stop(): Promise<void>;
}

const decodeWords = (value: string) =>
  value.replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_m, b64: string) => Buffer.from(b64, "base64").toString("utf8"));

const parseHeaders = (block: string) => {
  const headers: Record<string, string> = {};
  for (const line of block.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = decodeWords(line.slice(colon + 1).trim());
  }
  return headers;
};

const parseMessage = (raw: string) => {
  const split = raw.indexOf("\r\n\r\n");
  const headers = parseHeaders(split < 0 ? raw : raw.slice(0, split));
  const body = split < 0 ? "" : raw.slice(split + 4);
  const boundary = /boundary="([^"]+)"/.exec(headers["content-type"] ?? "")?.[1];
  const parts: Record<string, string> = {};
  if (boundary) {
    for (const part of body.split(`--${boundary}`)) {
      const at = part.indexOf("\r\n\r\n");
      if (at < 0) continue;
      const partHeaders = parseHeaders(part.slice(0, at).trim());
      const type = (partHeaders["content-type"] ?? "").split(";")[0]!.trim();
      const content = part.slice(at + 4);
      parts[type] =
        (partHeaders["content-transfer-encoding"] ?? "").toLowerCase() === "base64"
          ? Buffer.from(content.replace(/\s+/g, ""), "base64").toString("utf8")
          : content;
    }
  }
  return { headers, text: parts["text/plain"] ?? "", html: parts["text/html"] ?? "" };
};

/**
 * A small SMTP server on localhost. The servers under test deliver their mail
 * to it, so tests read what was sent the same way for both of them.
 */
export const startFakeSmtp = async (options: FakeSmtpOptions = {}): Promise<FakeSmtp> => {
  const outbox: ReceivedMail[] = [];
  const sessions: SmtpSession[] = [];
  let failures = 0;
  let lastArrival = Date.now();
  const arrivals: (() => void)[] = [];

  const server = net.createServer((socket) => {
    const session: SmtpSession = { commands: [] };
    sessions.push(session);
    socket.setEncoding("utf8");
    let buffer = "";
    let from = "";
    let to = "";
    let inData = false;
    let awaitingLogin = 0;
    const reply = (line: string) => socket.write(line + "\r\n");
    reply("220 fake.smtp.test ESMTP");
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          const raw = buffer.slice(0, end + 2).replace(/(^|\r\n)\.\./g, "$1.");
          buffer = buffer.slice(end + 5);
          inData = false;
          if (failures > 0) {
            failures--;
            reply("451 4.3.0 try again later");
          } else {
            outbox.push({ from, to, raw, subject: "", ...parseMessage(raw) });
            const mail = outbox[outbox.length - 1]!;
            mail.subject = mail.headers.subject ?? "";
            lastArrival = Date.now();
            for (const wake of arrivals.splice(0)) wake();
            reply("250 2.0.0 queued");
          }
          continue;
        }
        const index = buffer.indexOf("\r\n");
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        session.commands.push(line);
        if (awaitingLogin > 0) {
          awaitingLogin--;
          reply(awaitingLogin > 0 ? "334 UGFzc3dvcmQ6" : "235 2.7.0 authenticated");
          continue;
        }
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO" || verb === "HELO") {
          const lines = ["fake.smtp.test", ...(options.capabilities ?? [])];
          lines.forEach((l, i) => reply(`250${i === lines.length - 1 ? " " : "-"}${l}`));
        } else if (verb === "AUTH") {
          if (/^AUTH LOGIN$/i.test(line)) {
            awaitingLogin = 2;
            reply("334 VXNlcm5hbWU6");
          } else {
            reply("235 2.7.0 authenticated");
          }
        } else if (verb === "MAIL") {
          from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          reply("250 2.1.0 ok");
        } else if (verb === "RCPT") {
          to = /<([^>]*)>/.exec(line)?.[1] ?? "";
          reply("250 2.1.5 ok");
        } else if (verb === "DATA") {
          inData = true;
          reply("354 end with <CRLF>.<CRLF>");
        } else if (verb === "QUIT") {
          reply("221 2.0.0 bye");
          socket.end();
        } else {
          reply("502 5.5.2 command not recognized");
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    outbox,
    sessions,
    failNext(n) {
      failures = n;
    },
    async waitFor(count, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (outbox.length < count) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`expected ${count} mails, got ${outbox.length} after ${timeoutMs} ms`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left);
          arrivals.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return outbox;
    },
    async settle(quietMs = 250) {
      for (;;) {
        const idle = Date.now() - lastArrival;
        if (idle >= quietMs) return;
        await Bun.sleep(quietMs - idle);
      }
    },
    clear() {
      outbox.length = 0;
      sessions.length = 0;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Idle keep-alive connections would keep `close` waiting.
        (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
};
