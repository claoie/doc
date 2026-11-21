import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import type { Duplex } from "node:stream";

/**
 * A fake SMTP server that speaks TLS, for the servers' `SMTP_SECURE` (TLS from
 * the first byte) and STARTTLS (upgrade after EHLO) paths. Its certificate is
 * made when first needed, with the `openssl` command: a throw-away authority
 * and a certificate for `localhost` signed by it. A server under test trusts
 * it when it is started with `trustEnv()`.
 */

export interface TestCertificates {
  /** Directory holding the files below. */
  dir: string;
  /** The authority's certificate: what a client has to trust. */
  caFile: string;
  key: string;
  cert: string;
}

let certificates: TestCertificates | null | undefined;

const openssl = (cwd: string, args: string[]) => {
  const result = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
};

/** The test authority and certificate, or null when there is no `openssl` to make them with. */
export const testCertificates = (): TestCertificates | null => {
  if (certificates !== undefined) return certificates;
  if (spawnSync("openssl", ["version"]).status !== 0) return (certificates = null);
  const dir = mkdtempSync(path.join(tmpdir(), "doc-api-tls-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  openssl(dir, [
    "req", "-x509", ...ec, "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Doc API test authority",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  openssl(dir, ["req", ...ec, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=localhost"]);
  writeFileSync(
    path.join(dir, "leaf.ext"),
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n",
  );
  openssl(dir, ["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "leaf.ext"]);
  certificates = {
    dir,
    caFile: path.join(dir, "ca.pem"),
    key: readFileSync(path.join(dir, "leaf.key"), "utf8"),
    cert: readFileSync(path.join(dir, "leaf.pem"), "utf8"),
  };
  return certificates;
};

/**
 * Environment that makes a server trust the test authority: Node and Bun read
 * `NODE_EXTRA_CA_CERTS`; OpenSSL and the common Rust root-certificate loaders
 * read `SSL_CERT_FILE`.
 */
export const trustEnv = (certs: TestCertificates): Record<string, string> => ({ NODE_EXTRA_CA_CERTS: certs.caFile, SSL_CERT_FILE: certs.caFile });

export interface TlsSmtpSession {
  /** Command lines received before the connection was encrypted. */
  plain: string[];
  /** Command lines received over TLS. */
  secure: string[];
}

export interface TlsMail {
  from: string;
  to: string;
  /** The message as it came over the wire. */
  raw: string;
  /** Whether it arrived over TLS. */
  secure: boolean;
}

export interface TlsSmtp {
  port: number;
  outbox: TlsMail[];
  sessions: TlsSmtpSession[];
  /** Resolves once the outbox holds `count` messages. */
  waitFor(count: number, timeoutMs?: number): Promise<TlsMail[]>;
  stop(): Promise<void>;
}

export interface TlsSmtpOptions {
  /** "implicit": TLS from the first byte. "starttls": plain until the client asks to upgrade. */
  mode: "implicit" | "starttls";
  /** Capability lines announced over TLS (after the upgrade, in "starttls" mode). Default: none. */
  capabilities?: string[];
  /** Present a certificate the client has no reason to trust (signed by nobody it knows). */
  untrusted?: boolean;
}

/** Starts the TLS-speaking fake on localhost. Needs `testCertificates()` to be available. */
export const startTlsSmtp = async (options: TlsSmtpOptions): Promise<TlsSmtp> => {
  const certs = testCertificates();
  if (!certs) throw new Error("no openssl to make a test certificate with");
  let { key, cert } = certs;
  if (options.untrusted) {
    // A certificate for localhost signed by itself: valid in every way except that nobody trusts its issuer.
    openssl(certs.dir, [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "self.key", "-out", "self.pem", "-days", "2",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]);
    key = readFileSync(path.join(certs.dir, "self.key"), "utf8");
    cert = readFileSync(path.join(certs.dir, "self.pem"), "utf8");
  }
  const outbox: TlsMail[] = [];
  const sessions: TlsSmtpSession[] = [];
  const arrivals: (() => void)[] = [];

  /** Runs an SMTP session on `socket`. Resolves with the socket when the client asked for STARTTLS. */
  const serve = (socket: Duplex, session: TlsSmtpSession, secure: boolean, greet: boolean, onStartTls?: () => void) => {
    const log = secure ? session.secure : session.plain;
    let buffer = "";
    let from = "";
    let to = "";
    let inData = false;
    let awaitingLogin = 0;
    const reply = (line: string) => socket.write(line + "\r\n");
    if (greet) reply("220 tls.smtp.test ESMTP");
    socket.on("error", () => undefined);
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          outbox.push({ from, to, raw: buffer.slice(0, end + 2).replace(/(^|\r\n)\.\./g, "$1."), secure });
          buffer = buffer.slice(end + 5);
          inData = false;
          for (const wake of arrivals.splice(0)) wake();
          reply("250 2.0.0 queued");
          continue;
        }
        const index = buffer.indexOf("\r\n");
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        log.push(line);
        if (awaitingLogin > 0) {
          awaitingLogin--;
          reply(awaitingLogin > 0 ? "334 UGFzc3dvcmQ6" : "235 2.7.0 authenticated");
          continue;
        }
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") {
          const lines = ["tls.smtp.test", ...(secure ? (options.capabilities ?? []) : ["STARTTLS"])];
          lines.forEach((l, i) => reply(`250${i === lines.length - 1 ? " " : "-"}${l}`));
        } else if (verb === "STARTTLS" && onStartTls) {
          socket.off("data", onData);
          reply("220 2.0.0 ready to start TLS");
          onStartTls();
          return;
        } else if (/^AUTH LOGIN$/i.test(line)) {
          awaitingLogin = 2;
          reply("334 VXNlcm5hbWU6");
        } else if (verb === "AUTH") reply("235 2.7.0 authenticated");
        else if (verb === "MAIL") {
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
        } else reply("502 5.5.2 command not recognized");
      }
    };
    socket.on("data", onData);
  };

  // Sessions over TLS. In "starttls" mode this listener is internal: the plain
  // front hands a connection over to it once the client has asked to upgrade.
  const pending: TlsSmtpSession[] = [];
  const secureServer = tls.createServer({ key, cert }, (socket) => {
    const session = options.mode === "implicit" ? { plain: [], secure: [] } : pending.shift()!;
    if (options.mode === "implicit") sessions.push(session);
    serve(socket, session, true, options.mode === "implicit");
  });
  secureServer.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => secureServer.listen(0, "127.0.0.1", resolve));
  const securePort = (secureServer.address() as net.AddressInfo).port;

  let front: net.Server | null = null;
  if (options.mode === "starttls") {
    front = net.createServer((socket) => {
      const session: TlsSmtpSession = { plain: [], secure: [] };
      sessions.push(session);
      serve(socket, session, false, true, () => {
        pending.push(session);
        const inner = net.connect(securePort, "127.0.0.1");
        inner.on("error", () => socket.destroy());
        socket.on("error", () => inner.destroy());
        socket.pipe(inner);
        inner.pipe(socket);
      });
    });
    await new Promise<void>((resolve) => front!.listen(0, "127.0.0.1", resolve));
  }
  const closeAll = (server: net.Server) =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    });

  return {
    port: front ? (front.address() as net.AddressInfo).port : securePort,
    outbox,
    sessions,
    async waitFor(count, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (outbox.length < count) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`expected ${count} mails over TLS, got ${outbox.length} after ${timeoutMs} ms`);
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
    async stop() {
      if (front) await closeAll(front);
      await closeAll(secureServer);
    },
  };
};
