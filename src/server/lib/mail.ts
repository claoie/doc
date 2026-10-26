import { config } from "server/config";
import { log } from "./logger";
import { sendSmtp } from "./smtp";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

type Transport = (mail: Mail) => Promise<void>;

const MAX_QUEUE = 1000;
const MAX_ATTEMPTS = 3;

const stripHeader = (value: string) => value.replace(/[\r\n\u0000]+/g, " ").trim();

const encodeWord = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

const base64Lines = (value: string) =>
  (Buffer.from(value, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");

export const buildMessage = (mail: Mail, from: { address: string; name: string }): string => {
  const boundary = `b-${crypto.randomUUID()}`;
  const domain = from.address.split("@")[1] ?? "localhost";
  const fromName = stripHeader(from.name).replace(/"/g, "");
  return [
    `From: ${fromName ? `"${encodeWord(fromName)}" ` : ""}<${stripHeader(from.address)}>`,
    `To: <${stripHeader(mail.to)}>`,
    `Subject: ${encodeWord(stripHeader(mail.subject))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
};

const defaultTransport: Transport = async (mail) => {
  const settings = config.mail;
  if (settings.driver === "log") {
    log.info("mail (log driver)", { to: mail.to, subject: mail.subject });
    return;
  }
  const to = stripHeader(mail.to);
  await sendSmtp(
    {
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      ignoreTls: settings.ignoreTls,
      username: settings.username,
      password: settings.password,
    },
    {
      from: stripHeader(settings.fromAddress),
      to,
      data: buildMessage({ ...mail, to }, { address: settings.fromAddress, name: settings.fromName }),
    },
  );
};

let transport: Transport = defaultTransport;
const queue: { mail: Mail; attempts: number }[] = [];
let draining: Promise<void> | null = null;
let retries = 0;

/** Replaces the delivery function; `null` restores the configured driver. */
export const setMailTransport = (next: Transport | null) => {
  transport = next ?? defaultTransport;
};

const drain = async () => {
  while (queue.length) {
    const item = queue.shift()!;
    try {
      await transport(item.mail);
    } catch (error) {
      item.attempts++;
      log.error("mail delivery failed", error, { subject: item.mail.subject, attempt: item.attempts });
      if (item.attempts < MAX_ATTEMPTS) {
        retries++;
        setTimeout(() => {
          retries--;
          enqueue(item);
        }, 15_000 * item.attempts).unref();
      }
    }
  }
};

const enqueue = (item: { mail: Mail; attempts: number }) => {
  if (queue.length >= MAX_QUEUE) {
    log.warn("mail queue full, dropping message", { subject: item.mail.subject });
    return;
  }
  queue.push(item);
  draining ??= drain().finally(() => {
    draining = null;
  });
};

/** Queues an email; delivery happens in the background and never throws into the caller. */
export const sendMail = (mail: Mail) => enqueue({ mail, attempts: 0 });

/** Resolves once the queue is empty (pending retries are not awaited). */
export const flushMail = async () => {
  while (draining) await draining;
  return { pendingRetries: retries };
};
