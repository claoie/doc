import net from "node:net";
import os from "node:os";
import tls from "node:tls";

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  ignoreTls: boolean;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

export interface Envelope {
  from: string;
  to: string;
  /** Full RFC 5322 message with CRLF line endings. */
  data: string;
}

interface Reply {
  code: number;
  lines: string[];
}

class SmtpConnection {
  private socket: net.Socket;
  private buffer = "";
  private lines: string[] = [];
  private replies: Reply[] = [];
  private waiters: { resolve: (reply: Reply) => void; reject: (error: Error) => void }[] = [];
  private failure: Error | null = null;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("SMTP connection closed")));
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        this.replies.push({ code: Number(line.slice(0, 3)), lines: this.lines.map((l) => l.slice(4)) });
        this.lines = [];
      }
    }
    while (this.replies.length && this.waiters.length) this.waiters.shift()!.resolve(this.replies.shift()!);
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  read(): Promise<Reply> {
    const reply = this.replies.shift();
    if (reply) return Promise.resolve(reply);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async command(line: string | null, expected: number[], label = line?.split(" ")[0] ?? "greeting"): Promise<Reply> {
    if (line !== null) this.socket.write(line + "\r\n");
    const reply = await this.read();
    if (!expected.includes(reply.code)) {
      throw new Error(`SMTP ${label} failed: ${reply.code} ${reply.lines.join(" ").slice(0, 200)}`);
    }
    return reply;
  }

  async upgrade(host: string): Promise<void> {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("close");
    const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ socket: this.socket, servername: host }, () => resolve(s));
      s.once("error", reject);
    });
    this.socket = secured;
    this.buffer = "";
    this.attach(secured);
  }

  write(data: string) {
    this.socket.write(data);
  }

  close() {
    this.socket.destroy();
  }
}

const open = (options: SmtpOptions): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const socket = options.secure
      ? tls.connect({ host: options.host, port: options.port, servername: options.host }, () => resolve(socket))
      : net.connect({ host: options.host, port: options.port }, () => resolve(socket));
    socket.once("error", reject);
  });

const capabilities = (reply: Reply) => reply.lines.slice(1).map((line) => line.toUpperCase());

/** Leading dots are doubled so a line consisting of "." cannot end the DATA section early. */
const dotStuff = (data: string) => data.replace(/(^|\r\n)\./g, "$1..");

export const sendSmtp = async (options: SmtpOptions, envelope: Envelope): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const socket = await open(options);
  const connection = new SmtpConnection(socket);
  const timer = setTimeout(() => socket.destroy(new Error("SMTP timeout")), timeoutMs);
  try {
    const name = os.hostname() || "localhost";
    await connection.command(null, [220]);
    let ehlo = await connection.command(`EHLO ${name}`, [250]);
    if (!options.secure && !options.ignoreTls && capabilities(ehlo).includes("STARTTLS")) {
      await connection.command("STARTTLS", [220]);
      await connection.upgrade(options.host);
      ehlo = await connection.command(`EHLO ${name}`, [250]);
    }
    if (options.username) {
      const auth = capabilities(ehlo).find((line) => line.startsWith("AUTH")) ?? "";
      const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
      if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
        await connection.command(`AUTH PLAIN ${b64(`\0${options.username}\0${options.password ?? ""}`)}`, [235], "AUTH");
      } else {
        await connection.command("AUTH LOGIN", [334], "AUTH");
        await connection.command(b64(options.username), [334], "AUTH");
        await connection.command(b64(options.password ?? ""), [235], "AUTH");
      }
    }
    await connection.command(`MAIL FROM:<${envelope.from}>`, [250]);
    await connection.command(`RCPT TO:<${envelope.to}>`, [250, 251]);
    await connection.command("DATA", [354]);
    connection.write(dotStuff(envelope.data.replace(/\r?\n/g, "\r\n")) + "\r\n.\r\n");
    await connection.command(null, [250], "DATA");
    await connection.command("QUIT", [221]).catch(() => undefined);
  } finally {
    clearTimeout(timer);
    connection.close();
  }
};
