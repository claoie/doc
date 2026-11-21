import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { startFakeSmtp, startServer, until, type Client, type FakeSmtp, type ReceivedMail, type TestServer } from "./harness";
import { ISO, errorEntry } from "./harness/logs";
import { sameSessionOn } from "./harness/realtime";
import { startTlsSmtp, testCertificates, trustEnv, type TlsSmtp } from "./harness/tls-smtp";

/**
 * Mail as it leaves the server: the message it builds, the SMTP conversation
 * it has, authentication, TLS, the `log` driver, and what happens to mail that
 * is refused or still queued when the server stops.
 *
 * Mail settings are read from the environment, so each test starts a server
 * with the settings it is about and has the owner send invitations from it.
 * The servers follow one another on the same database: the workspace and its
 * owner are set up once.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const servers: TestServer[] = [];
const fakes: (FakeSmtp | TlsSmtp)[] = [];
let owner: Client;
let invitations = 0;

beforeAll(async () => {
  const first = await startServer();
  ({ owner } = await first.setupOwner());
  await first.close();
});

// Every server holds database connections: none outlives the test that started it.
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(fakes.splice(0).map((fake) => fake.stop()));
});

const start = async (options: Parameters<typeof startServer>[0] = {}) => {
  const server = await startServer({ keepDatabase: true, ...options });
  servers.push(server);
  return server;
};

/** Has the owner invite one new address per name through `server`: one mail each, in this order. */
const invite = async (server: TestServer, ...names: string[]) => {
  const emails = names.map((name) => `${name}-${++invitations}@example.com`);
  const res = await sameSessionOn(server, owner).post("/invitations", { emails, role: "member" });
  expect(res.status).toBe(200);
  return emails;
};

/** A server with `env`, and the one invitation mail it sent for a workspace called `workspaceName`. */
const withInvitation = async (env: Record<string, string | undefined> = {}, workspaceName = "Acme") => {
  const t = await start({ env });
  expect((await sameSessionOn(t, owner).post("/workspace/update", { name: workspaceName })).status).toBe(200);
  const [to] = await invite(t, "invited");
  const [mail] = await t.smtp.waitFor(1);
  return { t, mail: mail!, to: to! };
};

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

/** The header lines and the body of a message as it came over the wire. */
const split = (raw: string) => {
  const at = raw.indexOf("\r\n\r\n");
  return { headers: raw.slice(0, at).split("\r\n"), body: raw.slice(at + 4) };
};

/** Waits until `sessions` SMTP sessions have ended with QUIT. */
const untilQuit = (smtp: FakeSmtp, sessions: number) =>
  until(() => smtp.sessions.length >= sessions && smtp.sessions.every((s) => s.commands.at(-1) === "QUIT"), 5000, "the SMTP sessions to end");

const failedDelivery = (t: TestServer) => until(() => t.logEntries().find((e) => e.msg === "mail delivery failed"));

describe("the message", () => {
  let t: TestServer;
  let mail: ReceivedMail;
  let to: string;

  beforeAll(async () => {
    t = await startServer({ keepDatabase: true });
    expect((await sameSessionOn(t, owner).post("/workspace/update", { name: "Acme" })).status).toBe(200);
    [to] = (await invite(t, "invited")) as [string];
    mail = (await t.smtp.waitFor(1))[0]!;
  });

  afterAll(async () => {
    await t.close();
  });

  test("has From, To, Subject, Date, Message-ID and MIME headers, in that order", () => {
    const { headers } = split(mail.raw);
    expect(headers).toEqual([
      'From: "Doc Tests" <docs@doc.test>',
      `To: <${to}>`,
      "Subject: Owner invited you to Acme",
      expect.stringMatching(/^Date: (Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d\d (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d\d:\d\d:\d\d GMT$/),
      expect.stringMatching(new RegExp(`^Message-ID: <${UUID}@doc\\.test>$`)),
      "MIME-Version: 1.0",
      expect.stringMatching(new RegExp(`^Content-Type: multipart/alternative; boundary="b-${UUID}"$`)),
    ]);
    const date = new Date(headers[3]!.slice("Date: ".length)).getTime();
    expect(Math.abs(Date.now() - date)).toBeLessThan(60_000);
    // The envelope carries the bare addresses.
    expect(mail.from).toBe("docs@doc.test");
    expect(mail.to).toBe(to);
  });

  test("is multipart/alternative: the text, then the HTML, each base64 in lines of 76 characters", () => {
    const { headers, body } = split(mail.raw);
    const boundary = /boundary="([^"]+)"/.exec(headers[6]!)![1]!;
    const parts = body.split(`--${boundary}`);
    // Nothing before the first boundary; after the closing one, the end of the message.
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("");
    expect(parts[3]).toBe("--\r\n\r\n");
    const decoded: string[] = [];
    for (const [index, type] of [
      [1, "text/plain"],
      [2, "text/html"],
    ] as const) {
      const part = parts[index]!;
      const head = `\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`;
      expect(part.startsWith(head)).toBe(true);
      expect(part.endsWith("\r\n")).toBe(true);
      const lines = part.slice(head.length, -2).split("\r\n");
      for (const line of lines.slice(0, -1)) expect(line).toMatch(/^[A-Za-z0-9+/]{76}$/);
      expect(lines.at(-1)).toMatch(/^[A-Za-z0-9+/]{1,76}={0,2}$/);
      expect(lines.at(-1)!.length).toBeLessThanOrEqual(76);
      // Both parts are long enough to wrap, so the wrapping was put to the test.
      expect(lines.length).toBeGreaterThan(1);
      decoded.push(Buffer.from(lines.join(""), "base64").toString("utf8"));
    }
    expect(decoded[0]).toMatch(/^Owner invited you to join Acme\.\n\nAccept invitation: http:\/\/doc\.test\/invites\/[0-9a-f-]{36}\?token=[\w-]{43}$/);
    expect(decoded[1]).toMatch(/^<!doctype html><html><body style="[^"]+"><div style="[^"]+"><p style="margin:0 0 16px">Owner invited you to join Acme\.<\/p>.*<\/div><\/body><\/html>$/);
    expect(decoded[0]).toBe(mail.text);
    expect(decoded[1]).toBe(mail.html);
  });

  test("every message has its own Message-ID and boundary", async () => {
    await invite(t, "second");
    const second = (await t.smtp.waitFor(2))[1]!;
    expect(second.headers["message-id"]).toMatch(new RegExp(`^<${UUID}@doc\\.test>$`));
    expect(second.headers["message-id"]).not.toBe(mail.headers["message-id"]);
    expect(second.headers["content-type"]).not.toBe(mail.headers["content-type"]);
  });
});

describe("the message's headers", () => {
  test("a subject that is not plain ASCII is one UTF-8 encoded word; an ASCII one is sent as it is", async () => {
    const name = 'Acmé & Søns — 日本語 🚀 "quoted"';
    const { mail } = await withInvitation({}, name);
    // Accident: the whole subject is one encoded word on one line, however long (RFC 2047 allows 75 characters per word).
    expect(split(mail.raw).headers[2]).toBe(`Subject: =?UTF-8?B?${base64(`Owner invited you to ${name}`)}?=`);
    expect(mail.subject).toBe(`Owner invited you to ${name}`);
    expect(mail.text).toContain(`Owner invited you to join ${name}.`);
    expect(mail.html).toContain("Owner invited you to join Acmé &amp; Søns — 日本語 🚀 &quot;quoted&quot;.");

    const ascii = await withInvitation({}, 'Acme <"Docs"> ~ {1}');
    expect(split(ascii.mail.raw).headers[2]).toBe('Subject: Owner invited you to Acme <"Docs"> ~ {1}');
  });

  test("line breaks in a subject cannot start a header of their own", async () => {
    const { mail } = await withInvitation({}, "Acme\r\nBcc: evil@example.com\n\nX-Injected: yes");
    const { headers } = split(mail.raw);
    // Each run of line breaks became one space.
    expect(headers[2]).toBe("Subject: Owner invited you to Acme Bcc: evil@example.com X-Injected: yes");
    expect(headers.map((h) => h.split(":")[0])).toEqual(["From", "To", "Subject", "Date", "Message-ID", "MIME-Version", "Content-Type"]);
    // In the body they are text like any other.
    expect(mail.text).toContain("Owner invited you to join Acme\r\nBcc: evil@example.com\n\nX-Injected: yes.");
  });

  test("the sender's name is quoted, loses its own quotes and line breaks, and is encoded when it is not ASCII", async () => {
    const encoded = await withInvitation({ MAIL_FROM_NAME: "Dôcs Tëam ✉" });
    expect(split(encoded.mail.raw).headers[0]).toBe(`From: "=?UTF-8?B?${base64("Dôcs Tëam ✉")}?=" <docs@doc.test>`);

    const stripped = await withInvitation({ MAIL_FROM_NAME: 'The "Docs"\r\nBcc: evil@example.com' });
    expect(split(stripped.mail.raw).headers).toHaveLength(7);
    expect(split(stripped.mail.raw).headers[0]).toBe('From: "The Docs Bcc: evil@example.com" <docs@doc.test>');

    const nameless = await withInvitation({ MAIL_FROM_NAME: '""' });
    expect(split(nameless.mail.raw).headers[0]).toBe("From: <docs@doc.test>");
  });

  test("without MAIL_FROM settings it is sent as Doc <noreply@localhost>, to the SMTP server on localhost", async () => {
    const { mail } = await withInvitation({ MAIL_FROM_NAME: undefined, MAIL_FROM_ADDRESS: undefined, SMTP_HOST: undefined });
    const { headers } = split(mail.raw);
    expect(headers[0]).toBe('From: "Doc" <noreply@localhost>');
    expect(headers[4]).toMatch(new RegExp(`^Message-ID: <${UUID}@localhost>$`));
    expect(mail.from).toBe("noreply@localhost");
    // An empty value is no value.
    const empty = await withInvitation({ MAIL_FROM_NAME: "", MAIL_FROM_ADDRESS: "" });
    expect(split(empty.mail.raw).headers[0]).toBe('From: "Doc" <noreply@localhost>');
  });

  test("the Message-ID is at the sender address's domain, or at localhost when it has none", async () => {
    const other = await withInvitation({ MAIL_FROM_ADDRESS: "wiki@mail.example.org" });
    expect(split(other.mail.raw).headers[4]).toMatch(new RegExp(`^Message-ID: <${UUID}@mail\\.example\\.org>$`));
    expect(other.mail.from).toBe("wiki@mail.example.org");
    const bare = await withInvitation({ MAIL_FROM_ADDRESS: "postmaster" });
    expect(split(bare.mail.raw).headers[0]).toBe('From: "Doc Tests" <postmaster>');
    expect(split(bare.mail.raw).headers[4]).toMatch(new RegExp(`^Message-ID: <${UUID}@localhost>$`));
    expect(bare.mail.from).toBe("postmaster");
  });
});

describe("the SMTP conversation", () => {
  test("is EHLO, MAIL FROM, RCPT TO, DATA and QUIT, one connection per message, in the order they were queued", async () => {
    const t = await start();
    const emails = await invite(t, "first", "second", "third");
    await t.smtp.waitFor(3);
    await untilQuit(t.smtp, 3);
    expect(t.outbox.map((m) => m.to)).toEqual(emails);
    expect(t.smtp.sessions.map((s) => s.commands)).toEqual(
      emails.map((email) => [expect.stringMatching(/^EHLO \S+$/), "MAIL FROM:<docs@doc.test>", `RCPT TO:<${email}>`, "DATA", "QUIT"]),
    );
  });

  test("a line that is a single dot inside the message does not end it", async () => {
    // Base64 bodies and fixed header names leave one way for a line of the message to start with a dot: the
    // domain of the sender address, which is copied into the Message-ID as it is configured, line breaks and
    // all (a bug of its own, reported and not asserted here). Whatever becomes of that header, the message has
    // to arrive whole: on the wire, a dot at the start of a line is doubled.
    const { t, mail, to } = await withInvitation({ MAIL_FROM_ADDRESS: "docs@doc.test\r\n.\r\n.hidden: yes" });
    await untilQuit(t.smtp, 1);
    expect(t.smtp.sessions.map((s) => s.commands)).toEqual([
      [expect.stringMatching(/^EHLO \S+$/), "MAIL FROM:<docs@doc.test . .hidden: yes>", `RCPT TO:<${to}>`, "DATA", "QUIT"],
    ]);
    expect(t.outbox).toHaveLength(1);
    expect(split(mail.raw).headers[0]).toBe('From: "Doc Tests" <docs@doc.test . .hidden: yes>');
    expect(mail.text).toMatch(/^Owner invited you to join Acme\.\n\nAccept invitation: http:\/\/doc\.test\/invites\/[0-9a-f-]{36}\?token=[\w-]{43}$/);
    expect(mail.html).toMatch(/^<!doctype html>.*<\/html>$/);
    expect(mail.raw.endsWith("--\r\n\r\n")).toBe(true);
  });

  /** What a server with `env` sends between EHLO and MAIL FROM to a mail server that announces `capabilities`. */
  const authenticated = async (capabilities: string[], env: Record<string, string | undefined>) => {
    const smtp = await startFakeSmtp({ capabilities });
    fakes.push(smtp);
    const t = await start({ smtp, env });
    const [to] = await invite(t, "invited");
    await smtp.waitFor(1);
    await untilQuit(smtp, 1);
    expect(smtp.sessions).toHaveLength(1);
    const commands = smtp.sessions[0]!.commands;
    expect(commands[0]).toMatch(/^EHLO \S+$/);
    expect(commands.slice(-4)).toEqual(["MAIL FROM:<docs@doc.test>", `RCPT TO:<${to}>`, "DATA", "QUIT"]);
    return commands.slice(1, -4);
  };
  const credentials = { SMTP_USERNAME: "mailer@example.com", SMTP_PASSWORD: "p@ss wörd" };
  const plain = [`AUTH PLAIN ${base64("\0mailer@example.com\0p@ss wörd")}`];

  test("with a user name it authenticates with AUTH PLAIN when the server offers it", async () => {
    expect(await authenticated(["SIZE 35882577", "AUTH PLAIN LOGIN"], credentials)).toEqual(plain);
    expect(await authenticated(["auth login cram-md5 plain"], credentials)).toEqual(plain);
  });

  test("with AUTH LOGIN when the server offers that and not PLAIN", async () => {
    expect(await authenticated(["AUTH LOGIN"], credentials)).toEqual(["AUTH LOGIN", base64("mailer@example.com"), base64("p@ss wörd")]);
    expect(await authenticated(["8BITMIME", "auth cram-md5 login"], credentials)).toEqual(["AUTH LOGIN", base64("mailer@example.com"), base64("p@ss wörd")]);
  });

  test("with AUTH PLAIN when the server announces no way to authenticate, or neither of the two", async () => {
    expect(await authenticated([], credentials)).toEqual(plain);
    expect(await authenticated(["SIZE 1000", "AUTH CRAM-MD5"], credentials)).toEqual(plain);
  });

  test("a user name without a password authenticates with an empty one; a password alone is not used", async () => {
    expect(await authenticated(["AUTH PLAIN"], { SMTP_USERNAME: "mailer" })).toEqual([`AUTH PLAIN ${base64("\0mailer\0")}`]);
    expect(await authenticated(["AUTH LOGIN"], { SMTP_USERNAME: "mailer", SMTP_PASSWORD: "" })).toEqual(["AUTH LOGIN", base64("mailer"), ""]);
    expect(await authenticated(["AUTH PLAIN LOGIN"], { SMTP_USERNAME: "", SMTP_PASSWORD: "secret" })).toEqual([]);
  });

  test("a server that offers STARTTLS is asked for it first, unless SMTP_IGNORETLS is set", async () => {
    // This fake does not speak TLS. With SMTP_IGNORETLS the offer is passed over and the mail goes out in the clear.
    expect(await authenticated(["STARTTLS", "AUTH PLAIN"], { SMTP_IGNORETLS: "true" })).toEqual([]);
    expect(await authenticated(["starttls"], { SMTP_IGNORETLS: "1", ...credentials })).toEqual(plain);
    // Without it the upgrade is asked for and, here, refused: the mail is not sent in the clear instead.
    const smtp = await startFakeSmtp({ capabilities: ["STARTTLS"] });
    fakes.push(smtp);
    const t = await start({ smtp, env: { SMTP_IGNORETLS: "false", ...credentials } });
    await invite(t, "invited");
    expect(errorEntry(await failedDelivery(t))).toEqual({ t: expect.stringMatching(ISO), level: "error", msg: "mail delivery failed", subject: "Owner invited you to Acme", attempt: 1 });
    expect(smtp.sessions.map((s) => s.commands)).toEqual([[expect.stringMatching(/^EHLO \S+$/), "STARTTLS"]]);
    expect(smtp.outbox).toEqual([]);
  });
});

describe("TLS", () => {
  const certs = testCertificates();
  // Without the openssl command there is no certificate to test with.
  const tlsTest = test.skipIf(!certs);

  /** A server pointed at the TLS fake by the name its certificate is for, and an invitation sent from it. */
  const deliver = async (smtp: TlsSmtp, env: Record<string, string | undefined>) => {
    fakes.push(smtp);
    const unused = await startFakeSmtp();
    fakes.push(unused);
    const t = await start({ smtp: { ...unused, port: smtp.port }, env: { SMTP_HOST: "localhost", ...env } });
    const [to] = await invite(t, "invited");
    return { t, to: to! };
  };
  const ended = (smtp: TlsSmtp) => until(() => smtp.sessions.length === 1 && [...smtp.sessions[0]!.plain, ...smtp.sessions[0]!.secure].at(-1) === "QUIT");

  tlsTest("with SMTP_SECURE the whole conversation is inside TLS", async () => {
    const smtp = await startTlsSmtp({ mode: "implicit", capabilities: ["AUTH PLAIN"] });
    const { to } = await deliver(smtp, { SMTP_SECURE: "true", SMTP_USERNAME: "mailer", SMTP_PASSWORD: "secret", ...trustEnv(certs!) });
    const [mail] = await smtp.waitFor(1);
    await ended(smtp);
    expect(mail).toMatchObject({ from: "docs@doc.test", to, secure: true });
    expect(mail!.raw).toContain("Subject: Owner invited you to Acme\r\n");
    expect(smtp.sessions).toEqual([
      { plain: [], secure: [expect.stringMatching(/^EHLO \S+$/), `AUTH PLAIN ${base64("\0mailer\0secret")}`, "MAIL FROM:<docs@doc.test>", `RCPT TO:<${to}>`, "DATA", "QUIT"] },
    ]);
  });

  tlsTest("a server that offers STARTTLS is upgraded: EHLO again, then everything else inside TLS", async () => {
    const smtp = await startTlsSmtp({ mode: "starttls", capabilities: ["AUTH LOGIN"] });
    const { to } = await deliver(smtp, { SMTP_USERNAME: "mailer", SMTP_PASSWORD: "secret", ...trustEnv(certs!) });
    const [mail] = await smtp.waitFor(1);
    await ended(smtp);
    expect(mail).toMatchObject({ from: "docs@doc.test", to, secure: true });
    // The way to authenticate is the one announced after the upgrade.
    expect(smtp.sessions).toEqual([
      {
        plain: [expect.stringMatching(/^EHLO \S+$/), "STARTTLS"],
        secure: [expect.stringMatching(/^EHLO \S+$/), "AUTH LOGIN", base64("mailer"), base64("secret"), "MAIL FROM:<docs@doc.test>", `RCPT TO:<${to}>`, "DATA", "QUIT"],
      },
    ]);
  });

  tlsTest("with SMTP_IGNORETLS the offer is passed over and nothing is encrypted", async () => {
    const smtp = await startTlsSmtp({ mode: "starttls" });
    const { to } = await deliver(smtp, { SMTP_IGNORETLS: "true", ...trustEnv(certs!) });
    const [mail] = await smtp.waitFor(1);
    await ended(smtp);
    expect(mail).toMatchObject({ to, secure: false });
    expect(smtp.sessions).toEqual([{ plain: [expect.stringMatching(/^EHLO \S+$/), "MAIL FROM:<docs@doc.test>", `RCPT TO:<${to}>`, "DATA", "QUIT"], secure: [] }]);
  });

  tlsTest("a certificate that cannot be verified stops the delivery, with SMTP_SECURE and with STARTTLS", async () => {
    const failure = { t: expect.stringMatching(ISO), level: "error", msg: "mail delivery failed", subject: "Owner invited you to Acme", attempt: 1 };
    // Signed by an authority the server was not told to trust.
    const unknownAuthority = await startTlsSmtp({ mode: "implicit" });
    const first = await deliver(unknownAuthority, { SMTP_SECURE: "true" });
    expect(errorEntry(await failedDelivery(first.t))).toEqual(failure);
    expect(unknownAuthority.outbox).toEqual([]);
    expect(unknownAuthority.sessions.flatMap((s) => s.secure)).toEqual([]);

    // Signed by itself, while another authority is trusted.
    const selfSigned = await startTlsSmtp({ mode: "starttls", untrusted: true });
    const second = await deliver(selfSigned, trustEnv(certs!));
    expect(errorEntry(await failedDelivery(second.t))).toEqual(failure);
    expect(selfSigned.outbox).toEqual([]);
    // It got as far as asking for the upgrade, and sent nothing after it.
    expect(selfSigned.sessions).toEqual([{ plain: [expect.stringMatching(/^EHLO \S+$/), "STARTTLS"], secure: [] }]);
  });
});

describe("the log driver", () => {
  test("with MAIL_DRIVER=log, without MAIL_DRIVER or with an unknown one, mail is logged with its recipient and subject and goes nowhere", async () => {
    for (const MAIL_DRIVER of ["log", undefined, "sendmail"]) {
      const t = await start({ env: { MAIL_DRIVER } });
      const [to] = await invite(t, "invited");
      const line = await until(() => t.logEntries().find((e) => e.msg === "mail (log driver)"));
      expect([MAIL_DRIVER, line]).toEqual([MAIL_DRIVER, { t: expect.stringMatching(ISO), level: "info", msg: "mail (log driver)", to, subject: "Owner invited you to Acme" }]);
      await t.smtp.settle();
      expect(t.smtp.sessions).toEqual([]);
      // Neither the text nor the link with its token is in the log.
      expect(t.logs.join("\n")).not.toContain("token=");
    }
  });
});

describe("what the mail server answers", () => {
  const ACCEPT: Record<string, string> = { EHLO: "250 scripted.test", AUTH: "235 2.7.0 welcome", MAIL: "250 2.1.0 ok", RCPT: "250 2.1.5 ok", DATA: "354 go on", QUIT: "221 2.0.0 bye" };

  /**
   * A mail server that answers its n-th connection from the n-th script: the
   * reply to a command (by its first word), to the greeting or to the message
   * itself, or "close" to drop the connection there. What a script leaves out
   * is accepted.
   */
  const scripted = async (scripts: Record<string, string>[]) => {
    const sessions: string[][] = [];
    const server = net.createServer((socket) => {
      const script = scripts[sessions.length] ?? {};
      const commands: string[] = [];
      sessions.push(commands);
      socket.setEncoding("utf8");
      socket.on("error", () => undefined);
      const answer = (reply: string) => {
        if (reply === "close") socket.destroy();
        else socket.write(reply + "\r\n");
      };
      answer(script.greeting ?? "220 scripted.test ESMTP");
      let buffer = "";
      let inData = false;
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          if (inData) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end < 0) return;
            buffer = buffer.slice(end + 5);
            inData = false;
            commands.push("(message)");
            answer(script.message ?? "250 2.0.0 queued");
            continue;
          }
          const index = buffer.indexOf("\r\n");
          if (index < 0) return;
          const verb = buffer.slice(0, index).split(/[ :]/)[0]!.toUpperCase();
          buffer = buffer.slice(index + 2);
          commands.push(verb);
          const reply = script[verb] ?? ACCEPT[verb] ?? "502 5.5.2 command not recognized";
          answer(reply);
          if (verb === "DATA" && reply.startsWith("354")) inData = true;
          if (verb === "QUIT" && reply !== "close") socket.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as net.AddressInfo).port, sessions, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  };

  test("decides whether a message was delivered: any refusal on the way fails it, a clumsy goodbye does not", async () => {
    const whole = ["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "(message)", "QUIT"];
    const cases: [string, Record<string, string>, "delivered" | "failed", string[]][] = [
      ["everything accepted", {}, "delivered", whole],
      ["greeting and answers over several lines", { greeting: "220-scripted.test\r\n220 ready", MAIL: "250-ok\r\n250 really" }, "delivered", whole],
      ["an answer that is only its code", { MAIL: "250", RCPT: "250" }, "delivered", whole],
      ["the recipient will be forwarded (251)", { RCPT: "251 2.1.5 will forward" }, "delivered", whole],
      ["QUIT refused", { QUIT: "500 5.5.1 what?" }, "delivered", whole],
      ["connection dropped at QUIT", { QUIT: "close" }, "delivered", whole],
      ["greeting refuses service", { greeting: "554 5.3.2 no service here" }, "failed", []],
      ["connection dropped before the greeting", { greeting: "close" }, "failed", []],
      ["EHLO refused", { EHLO: "502 5.5.1 not implemented" }, "failed", ["EHLO"]],
      ["credentials refused", { AUTH: "535 5.7.8 bad credentials" }, "failed", ["EHLO", "AUTH"]],
      ["sender refused", { MAIL: "451 4.3.0 try later" }, "failed", ["EHLO", "AUTH", "MAIL"]],
      ["recipient refused", { RCPT: "550 5.1.1 no such user" }, "failed", ["EHLO", "AUTH", "MAIL", "RCPT"]],
      ["recipient answered with another 2xx", { RCPT: "252 2.5.2 cannot verify" }, "failed", ["EHLO", "AUTH", "MAIL", "RCPT"]],
      ["DATA refused", { DATA: "554 5.5.1 no" }, "failed", ["EHLO", "AUTH", "MAIL", "RCPT", "DATA"]],
      ["message refused", { message: "552 5.3.4 too big" }, "failed", ["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "(message)"]],
      ["connection dropped after the message", { message: "close" }, "failed", ["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "(message)"]],
    ];
    const smtp = await scripted(cases.map(([, script]) => script));
    const unused = await startFakeSmtp();
    fakes.push(unused);
    try {
      const t = await start({ smtp: { ...unused, port: smtp.port }, env: { SMTP_USERNAME: "mailer", SMTP_PASSWORD: "secret" } });
      const failures = () => t.logEntries().filter((e) => e.msg === "mail delivery failed");
      for (const [index, [label, , expected, commands]] of cases.entries()) {
        const failedBefore = failures().length;
        await invite(t, "scripted");
        // A delivery ends with QUIT; a failure is logged.
        const outcome = await until(() => (failures().length > failedBefore ? "failed" : smtp.sessions[index]?.includes("QUIT") ? "delivered" : null), 5000, label);
        expect([label, outcome, smtp.sessions[index]]).toEqual([label, expected, commands]);
      }
      expect(smtp.sessions).toHaveLength(cases.length);
      const failed = cases.filter(([, , expected]) => expected === "failed").length;
      expect(failures().map(errorEntry)).toEqual(
        Array.from({ length: failed }, () => ({ t: expect.stringMatching(ISO), level: "error", msg: "mail delivery failed", subject: "Owner invited you to Acme", attempt: 1 })),
      );
    } finally {
      await smtp.stop();
    }
  }, 20_000);
});

describe("deliveries that fail, and stopping", () => {
  test("a refused message is logged and does not hold up the ones behind it", async () => {
    const t = await start();
    t.smtp.failNext(1);
    const [refused, accepted] = await invite(t, "refused", "accepted");
    await t.smtp.waitFor(1);
    await t.smtp.settle();
    expect(t.outbox.map((m) => m.to)).toEqual([accepted!]);
    const failures = t.logEntries().filter((e) => e.msg === "mail delivery failed");
    expect(failures.map(errorEntry)).toEqual([{ t: expect.stringMatching(ISO), level: "error", msg: "mail delivery failed", subject: "Owner invited you to Acme", attempt: 1 }]);
    // The refused one was sent whole before it was refused.
    expect(t.smtp.sessions.map((s) => s.commands.slice(1, 4))).toEqual([
      ["MAIL FROM:<docs@doc.test>", `RCPT TO:<${refused}>`, "DATA"],
      ["MAIL FROM:<docs@doc.test>", `RCPT TO:<${accepted}>`, "DATA"],
    ]);
  });

  test("mail still queued when the server is told to stop is delivered before it exits", async () => {
    // A mail server that takes its time to greet: 700 ms pass before a delivery can even begin.
    const fake = await startFakeSmtp();
    fakes.push(fake);
    const slow = net.createServer((client) => {
      client.on("error", () => undefined);
      setTimeout(() => {
        const upstream = net.connect(fake.port, "127.0.0.1");
        upstream.on("error", () => client.destroy());
        client.pipe(upstream);
        upstream.pipe(client);
      }, 700);
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    try {
      const t = await start({ smtp: { ...fake, port: (slow.address() as net.AddressInfo).port } });
      const emails = await invite(t, "first", "second");
      expect(fake.outbox).toEqual([]);
      const code = await t.stop("SIGTERM");
      // Both were delivered, one after the other, by the time the process was gone.
      expect(fake.outbox.map((m) => m.to)).toEqual(emails);
      expect(code).toBe(0);
      expect(t.logEntries().filter((e) => e.level === "error")).toEqual([]);
    } finally {
      slow.close();
    }
  }, 15_000);
});
