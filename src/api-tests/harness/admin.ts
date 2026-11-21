/**
 * Helpers shared by the suites for the HTTP layer, sign-in and workspace
 * administration (`http`, `auth`, `me`, `workspace`, `members`, `invitations`,
 * `groups`). Nothing here imports the server's code: the expected values are
 * written out, so the suites do not depend on what they check.
 */
import { expect } from "bun:test";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ApiResponse, Client } from "./client";
import type { TestServer } from "./server";
import type { ReceivedMail } from "./smtp";

/** `2026-01-31T12:34:56.789Z`: every timestamp of the API. */
export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Ids are lower-case UUIDs. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Session, reset and invitation tokens: 32 random bytes in base64url, unpadded. */
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** How passwords are stored: argon2id, 19 MiB, 2 passes, 1 lane, a 32-byte salt and a 32-byte hash. */
export const ARGON2_HASH = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{43}\$[A-Za-z0-9+/]{43}$/;

export const SESSION_COOKIE = /^session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/;
export const CLEARED_COOKIE = "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";

export const NOT_FOUND = { error: { code: "not_found", message: "Endpoint not found" } };
export const UNAUTHORIZED = { error: { code: "unauthorized", message: "Sign in required" } };
export const NOT_ADMIN = { error: { code: "forbidden", message: "Only workspace admins can do this" } };
export const RATE_LIMITED = { error: { code: "rate_limited", message: "Too many attempts. Try again in a minute." } };

/** The status and the whole error envelope of a refused request. */
export const expectError = (res: { status: number; body: unknown }, status: number, code: string, message: string) => {
  expect({ status: res.status, body: res.body }).toEqual({ status, body: { error: { code, message } } });
};

/** 400 `invalid_input` with this message. */
export const expectInvalid = (res: { status: number; body: unknown }, message: string) => expectError(res, 400, "invalid_input", message);

/** The status and the whole body of an answer. */
export const expectBody = (res: { status: number; body: unknown }, status: number, body: unknown) => {
  expect({ status: res.status, body: res.body }).toEqual({ status, body });
};

/** The headers every JSON answer of the API carries. */
export const expectApiHeaders = (headers: Headers) => {
  expect(headers.get("content-type")).toBe("application/json;charset=utf-8");
  expect(headers.get("cache-control")).toBe("no-store");
  expect(headers.get("x-content-type-options")).toBe("nosniff");
};

/** The rows of a query as a plain array. */
export const rows = async (query: unknown): Promise<any[]> => Array.from((await query) as any[]);

export const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** A `user` as the API returns it, with the given fields pinned and the rest checked by type. */
export const userShape = (fields: Record<string, unknown> = {}) => ({
  id: expect.stringMatching(UUID),
  email: expect.any(String),
  name: expect.any(String),
  avatarUrl: null,
  role: "member",
  locale: null,
  timezone: null,
  preferences: {},
  createdAt: expect.stringMatching(ISO),
  lastLoginAt: expect.stringMatching(ISO),
  ...fields,
});

/** The smallest files the server accepts as each image type: it only looks at the first bytes. */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
export const GIF = new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000");
export const WEBP = new TextEncoder().encode("RIFF$\u0000\u0000\u0000WEBPVP8 ");

export const imageFile = (bytes: Uint8Array, name = "image.bin", type = "application/octet-stream") => new File([bytes as unknown as BlobPart], name, { type });

/** Where an image served at `/api/images/<name>` lives on the server's disk. */
export const imagePath = (t: TestServer, url: string) => path.join(t.storageDir, "images", url.split("/").pop()!);
export const imageStored = (t: TestServer, url: string) => existsSync(imagePath(t, url));

/** The id and token of an invitation link (`<APP_URL>/invites/<id>?token=<token>`). */
export const inviteParts = (url: string) => {
  const link = new URL(url);
  return { id: link.pathname.split("/").pop()!, token: link.searchParams.get("token")! };
};

/** Signs in with a password as a new client. */
export const signIn = async (t: TestServer, email: string, password: string, headers: Record<string, string> = {}): Promise<Client> => {
  const client = t.client();
  const res = await client.request("POST", "/auth/login", { email, password }, headers);
  if (res.status !== 200) throw new Error(`sign-in as ${email} failed: ${res.status} ${res.text}`);
  return client;
};

/** The token of the reset link in a "reset your password" mail. */
export const resetToken = (mail: ReceivedMail) => {
  const match = /\/reset-password\?token=([A-Za-z0-9_-]+)$/.exec(mail.text);
  if (!match) throw new Error(`no reset link in: ${mail.text}`);
  return match[1]!;
};

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The HTML part of a transactional mail: its paragraphs, then the button and the link written out. */
export const mailHtml = (paragraphs: string[], action?: { label: string; url: string }) =>
  '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#222;line-height:1.5">' +
  '<div style="max-width:560px;margin:0 auto;padding:24px">' +
  paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join("") +
  (action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(action.label)}</a></p>` +
      `<p style="color:#666;font-size:12px">${escapeHtml(action.url)}</p>`
    : "") +
  "</div></body></html>";

/** Checks a whole transactional mail: envelope, sender, recipient, subject, text and HTML. */
export const expectMail = (
  mail: ReceivedMail | undefined,
  expected: { to: string; subject: string; paragraphs: string[]; action?: { label: string; url: string } },
) => {
  expect(mail).toBeDefined();
  expect({
    from: mail!.from,
    to: mail!.to,
    fromHeader: mail!.headers.from,
    toHeader: mail!.headers.to,
    subject: mail!.subject,
    text: mail!.text,
    html: mail!.html,
  }).toEqual({
    from: "docs@doc.test",
    to: expected.to,
    fromHeader: '"Doc Tests" <docs@doc.test>',
    toHeader: `<${expected.to}>`,
    subject: expected.subject,
    text: [...expected.paragraphs, ...(expected.action ? [`${expected.action.label}: ${expected.action.url}`] : [])].join("\n\n"),
    html: mailHtml(expected.paragraphs, expected.action),
  });
};

/** The mails delivered to one address, in order. */
export const mailsTo = (t: TestServer, address: string) => t.outbox.filter((mail) => mail.to === address);

/** Waits until `count` mails have reached `address` and returns them. */
export const waitForMailsTo = async (t: TestServer, address: string, count = 1, timeoutMs = 5000): Promise<ReceivedMail[]> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const mails = mailsTo(t, address);
    if (mails.length >= count) return mails;
    if (Date.now() > deadline) throw new Error(`expected ${count} mails to ${address}, got ${mails.length} after ${timeoutMs} ms`);
    await Bun.sleep(10);
  }
};

let markers = 0;

/**
 * Proves that no mail is still on its way: has the server send one more (an
 * invitation by `admin` to a throwaway address, revoked again), waits for it,
 * then for a quiet moment. Mail the server queued before that has arrived by then.
 */
export const flushMail = async (t: TestServer, admin: Client, domain = "flush.example") => {
  const address = `marker-${++markers}-${Date.now()}@${domain}`;
  const invited = await admin.post("/invitations", { emails: [address] });
  if (invited.status !== 200) throw new Error(`the marker invitation failed: ${invited.status} ${invited.text}`);
  await waitForMailsTo(t, address);
  await admin.post("/invitations/revoke", { id: invited.body.data[0].id });
  await t.smtp.settle(100);
};

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * One request written to a socket as it is, for what `fetch` would tidy up
 * first (dot segments in the path, a missing `Host`). `head` is the request
 * line and headers without the final blank line; `Connection: close` is added.
 */
export const rawRequest = (port: number, head: string, body = ""): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      if (split < 0) return reject(new Error(`no HTTP response: ${JSON.stringify(text.slice(0, 200))}`));
      const [statusLine, ...lines] = text.slice(0, split).split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({ status: Number(statusLine!.split(" ")[1]), headers, body: text.slice(split + 4) });
    });
    socket.write(`${head}\r\nConnection: close\r\n\r\n${body}`);
  });

/** The answer of a `Response` as the suites compare it: status and parsed JSON body. */
export const read = async (res: Response | Promise<Response>): Promise<ApiResponse> => {
  const response = await res;
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body, headers: response.headers, text };
};
