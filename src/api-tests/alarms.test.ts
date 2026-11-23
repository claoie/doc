import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startServer, until, type Client, type TestServer } from "./harness";
import { apiError } from "./harness/errors";
import { ISO, errorEntry } from "./harness/logs";
import { sameSessionOn } from "./harness/realtime";
import { startFakeWebhook, type FakeWebhook } from "./harness/webhook";

/**
 * Alarms: every error log line is posted to the Discord webhook in
 * `DISCORD_ALARM_WEBHOOK`, at most once a minute for each message; and
 * `POST /client-error`, where the web app reports the errors it did not
 * handle, which are logged at error level and so posted too.
 *
 * Each test starts its own server, so the once-a-minute limits start empty.
 */

const servers: TestServer[] = [];
const hooks: FakeWebhook[] = [];
let owner: Client;
let ownerId: string;

beforeAll(async () => {
  const first = await startServer();
  const setup = await first.setupOwner();
  owner = setup.owner;
  ownerId = setup.user.id;
  await first.close();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(hooks.splice(0).map((hook) => hook.stop()));
});

const start = async (env: Record<string, string | undefined> = {}) => {
  const server = await startServer({ keepDatabase: true, env });
  servers.push(server);
  return server;
};

const webhook = () => {
  const hook = startFakeWebhook();
  hooks.push(hook);
  return hook;
};

const report = { message: "TypeError: x is undefined", url: "/s/general/p/notes-abc", stack: "TypeError: x is undefined\n    at render (app.js:1:2)" };

const errorLines = (t: TestServer) => t.logEntries().filter((entry) => entry.level === "error");

/** Waits a moment for posts that should not come. */
const settle = () => Bun.sleep(300);

describe("POST /client-error", () => {
  test("logs the report at error level and posts it to the webhook", async () => {
    const hook = webhook();
    const t = await start({ DISCORD_ALARM_WEBHOOK: hook.url });
    const res = await sameSessionOn(t, owner).post("/client-error", report);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: {} });
    expect(errorLines(t)).toEqual([
      { t: expect.stringMatching(ISO), level: "error", msg: "client error", ...report, userId: ownerId },
    ]);
    expect(await hook.waitFor(1)).toEqual([
      {
        contentType: expect.stringMatching(/^application\/json/),
        body: {
          allowed_mentions: { parse: [] },
          embeds: [
            {
              title: "doc: client error",
              description: `\`\`\`\nmessage: TypeError: x is undefined\nurl: /s/general/p/notes-abc\nstack: TypeError: x is undefined\n    at render (app.js:1:2)\nuserId: ${ownerId}\n\`\`\``,
              color: 0xed4245,
              timestamp: expect.stringMatching(ISO),
            },
          ],
        },
      },
    ]);
  });

  test("takes a message alone, trimmed; the stack is kept as sent", async () => {
    const t = await start();
    const client = sameSessionOn(t, owner);
    expect((await client.post("/client-error", { message: "  boom  " })).status).toBe(200);
    expect((await client.post("/client-error", { message: "boom", stack: "  at a\n" })).status).toBe(200);
    expect(errorLines(t)).toEqual([
      { t: expect.stringMatching(ISO), level: "error", msg: "client error", message: "boom", userId: ownerId },
      { t: expect.stringMatching(ISO), level: "error", msg: "client error", message: "boom", stack: "  at a\n", userId: ownerId },
    ]);
  });

  test("refuses a report without a session, or with a missing or overlong field", async () => {
    const t = await start();
    expect((await t.client().post("/client-error", report)).body).toEqual(apiError("unauthorized", "Sign in required"));
    const client = sameSessionOn(t, owner);
    const refused = async (body: Record<string, unknown>) => {
      const res = await client.post("/client-error", body);
      expect(res.status).toBe(400);
      return res.body;
    };
    expect(await refused({})).toEqual(apiError("invalid_input", "message must be a string"));
    expect(await refused({ message: "  " })).toEqual(apiError("invalid_input", "message is required"));
    expect(await refused({ message: "é".repeat(1001) })).toEqual(apiError("invalid_input", "message must be at most 1000 characters"));
    expect(await refused({ message: "boom", url: "/".repeat(1001) })).toEqual(apiError("invalid_input", "url must be at most 1000 characters"));
    expect(await refused({ message: "boom", stack: "x".repeat(4001) })).toEqual(apiError("invalid_input", "stack must be at most 4000 characters"));
    expect(await refused({ message: "boom", stack: 1 })).toEqual(apiError("invalid_input", "stack must be a string"));
    expect((await client.post("/client-error", { message: "é".repeat(1000), url: "/".repeat(1000), stack: "x".repeat(4000) })).status).toBe(200);
    expect(errorLines(t)).toHaveLength(1);
  });

  test("takes ten reports a minute from one address", async () => {
    const t = await start();
    const client = sameSessionOn(t, owner);
    for (let i = 0; i < 10; i++) expect((await client.post("/client-error", { message: `boom ${i}` })).status).toBe(200);
    expect((await client.post("/client-error", { message: "boom 10" })).body).toEqual(
      apiError("rate_limited", "Too many attempts. Try again in a minute."),
    );
    // Another address has its own count.
    expect((await sameSessionOn(t, owner).post("/client-error", { message: "boom 11" })).status).toBe(200);
  });
});

describe("the webhook", () => {
  test("gets each message once a minute, while other messages still go out", async () => {
    const hook = webhook();
    // Nothing listens on port 1, so every invitation mail fails and logs an error.
    const t = await start({ DISCORD_ALARM_WEBHOOK: hook.url, SMTP_PORT: "1" });
    const client = sameSessionOn(t, owner);
    expect((await client.post("/client-error", { message: "first" })).status).toBe(200);
    expect((await client.post("/client-error", { message: "second" })).status).toBe(200);
    expect((await client.post("/invitations", { emails: ["invited@example.com"], role: "member" })).status).toBe(200);
    const failure = await until(() => t.logEntries().find((entry) => entry.msg === "mail delivery failed"));
    expect(errorEntry(failure)).toEqual({ t: expect.stringMatching(ISO), level: "error", msg: "mail delivery failed", subject: "Owner invited you to Acme", attempt: 1 });
    await hook.waitFor(2);
    await settle();
    expect(hook.posts.map((post) => post.body.embeds[0].title)).toEqual(["doc: client error", "doc: mail delivery failed"]);
    expect(hook.posts[0]!.body.embeds[0].description).toBe(`\`\`\`\nmessage: first\nuserId: ${ownerId}\n\`\`\``);
    expect(hook.posts[1]!.body.embeds[0].description).toMatch(/^```\nsubject: Owner invited you to Acme\nattempt: 1\nerror: .+\n```$/s);
  });

  test("cuts a long description to 4000 characters, counted as code points", async () => {
    const hook = webhook();
    const t = await start({ DISCORD_ALARM_WEBHOOK: hook.url });
    const long = { message: "m".repeat(1000), url: "/".repeat(1000), stack: "😀".repeat(4000) };
    expect((await sameSessionOn(t, owner).post("/client-error", long)).status).toBe(200);
    const [post] = await hook.waitFor(1);
    expect(post!.body.embeds[0].description).toBe(
      `\`\`\`\nmessage: ${"m".repeat(1000)}\nurl: ${"/".repeat(1000)}\nstack: ${"😀".repeat(1976)}…\n\`\`\``,
    );
  });

  test("a webhook that refuses or can't be reached is logged as a warning, not as another error", async () => {
    const hook = webhook();
    hook.status = 500;
    const t = await start({ DISCORD_ALARM_WEBHOOK: hook.url });
    expect((await sameSessionOn(t, owner).post("/client-error", { message: "boom" })).status).toBe(200);
    const warning = await until(() => t.logEntries().find((entry) => entry.msg === "sending an alarm failed"));
    expect(warning).toEqual({ t: expect.stringMatching(ISO), level: "warn", msg: "sending an alarm failed", alarm: "client error", error: "the webhook answered 500" });
    expect(errorLines(t)).toHaveLength(1);

    const unreachable = await start({ DISCORD_ALARM_WEBHOOK: "http://127.0.0.1:1/hook" });
    expect((await sameSessionOn(unreachable, owner).post("/client-error", { message: "boom" })).status).toBe(200);
    const { error, ...rest } = await until(() => unreachable.logEntries().find((entry) => entry.msg === "sending an alarm failed"));
    expect(rest).toEqual({ t: expect.stringMatching(ISO), level: "warn", msg: "sending an alarm failed", alarm: "client error" });
    expect(typeof error).toBe("string");
    expect(error).not.toBe("");
  });

  test("nothing is posted without DISCORD_ALARM_WEBHOOK", async () => {
    const t = await start({ DISCORD_ALARM_WEBHOOK: undefined });
    expect((await sameSessionOn(t, owner).post("/client-error", { message: "boom" })).status).toBe(200);
    await settle();
    expect(t.logEntries().filter((entry) => entry.level !== "info")).toEqual([
      { t: expect.stringMatching(ISO), level: "error", msg: "client error", message: "boom", userId: ownerId },
    ]);
  });
});
