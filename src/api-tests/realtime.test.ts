import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, doc, startServer, type Client, type Socket, type TestServer } from "./harness";
import {
  EMPTY_DOC,
  ERRORS,
  PRESENCE_COLORS,
  addToSpace,
  createPage,
  forget,
  insertText,
  join,
  leave,
  liveDoc,
  nextPresence,
  presenceColor,
  pushSteps,
  sendSteps,
  untilStored,
} from "./harness/realtime";

/**
 * The realtime socket `/api/ws`: opening it, the message protocol, presence,
 * its limits and what closes it. What steps do to a document is in
 * realtime-steps.test.ts, saving in realtime-save.test.ts.
 */

let t: TestServer;
let owner: Client;
let ownerId: string;
let spaceId: string;
let reader: Client;
let readerId: string;
const sockets: Socket[] = [];

/** Opens a socket that is closed when the file ends. */
const open = async (client: Client, headers?: Record<string, string>) => {
  const socket = await connect(client, headers ? { headers } : {});
  sockets.push(socket);
  return socket;
};

const page = (content: unknown = doc("hello")) => createPage(owner, spaceId, content);

/** The headers of a WebSocket handshake, for requests that are expected to be refused. */
const handshake = (extra: Record<string, string> = {}) => ({
  Upgrade: "websocket",
  Connection: "Upgrade",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version": "13",
  ...extra,
});

/** Messages about a page other than presence, which arrives on its own clock. */
const about = (pageId: string) => (m: Record<string, any>) => m.pageId === pageId && m.t !== "presence";

beforeAll(async () => {
  t = await startServer();
  const setup = await t.setupOwner();
  owner = setup.owner;
  ownerId = setup.user.id;
  spaceId = setup.spaceId;
  const member = await t.addMember(owner, "reader@example.com");
  reader = member.client;
  readerId = member.user.id;
  await addToSpace(owner, spaceId, readerId, "reader");
});

afterAll(async () => {
  for (const socket of sockets) socket.ws.close();
  await t.close();
});

describe("opening the socket", () => {
  test("without a session the upgrade is refused with 401", async () => {
    const res = await t.client().raw("GET", "/ws", { headers: handshake() });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Sign in required" } });

    const stranger = t.client();
    stranger.cookie = "not-a-session";
    const unknown = await stranger.raw("GET", "/ws", { headers: handshake() });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: { code: "unauthorized", message: "Sign in required" } });
    await expect(connect(stranger)).rejects.toThrow();
  });

  test("a request that is not a WebSocket handshake is answered 400", async () => {
    for (const method of ["GET", "POST"]) {
      const res = await owner.raw(method, "/ws");
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: { code: "upgrade_failed", message: "Expected a WebSocket upgrade" } });
    }
    // The session is checked first.
    const anonymous = await t.client().raw("GET", "/ws");
    expect(anonymous.status).toBe(401);
  });

  test("it opens without an Origin, with the app's origin and with the origin of the host it was asked on", async () => {
    const origins = [
      undefined,
      "http://doc.test",
      "http://doc.test/",
      "HTTP://DOC.TEST",
      `http://localhost:${t.port}`,
      // Only the host and port are compared with the request's own.
      `https://localhost:${t.port}`,
    ];
    for (const origin of origins) {
      const socket = await open(owner, origin ? { origin } : undefined);
      socket.send({ t: "ping" });
      expect(await socket.nextOf("pong")).toEqual({ t: "pong" });
      await socket.close();
    }
  });

  test("any other Origin is refused with 403", async () => {
    const refused = [
      "http://evil.test",
      "https://doc.test",
      "http://doc.test:8080",
      "http://sub.doc.test",
      `http://localhost:${t.port + 1}`,
      `http://127.0.0.1:${t.port}`,
      "null",
      "not a url",
    ];
    for (const origin of refused) {
      const res = await owner.raw("GET", "/ws", { headers: handshake({ Origin: origin }) });
      expect([origin, res.status]).toEqual([origin, 403]);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: { code: "forbidden_origin", message: "Origin not allowed" } });
    }
    await expect(connect(owner, { headers: { origin: "http://evil.test" } })).rejects.toThrow();
    // Without a session the origin is not looked at.
    const anonymous = await t.client().raw("GET", "/ws", { headers: handshake({ Origin: "http://evil.test" }) });
    expect(anonymous.status).toBe(401);
  });

  test("a signed-out session, an expired one and a deactivated user cannot open a socket", async () => {
    const signedOut = await t.addMember(owner, "signed-out@example.com");
    const cookie = signedOut.client.cookie!;
    expect((await signedOut.client.post("/auth/logout")).status).toBe(200);
    signedOut.client.cookie = cookie;
    expect((await signedOut.client.raw("GET", "/ws", { headers: handshake() })).status).toBe(401);
    await expect(connect(signedOut.client)).rejects.toThrow();

    const expired = await t.addMember(owner, "expired@example.com");
    await (await open(expired.client)).close();
    await t.sql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = ${expired.user.id}`;
    expect((await expired.client.raw("GET", "/ws", { headers: handshake() })).status).toBe(401);
    await expect(connect(expired.client)).rejects.toThrow();

    const deactivated = await t.addMember(owner, "deactivated@example.com");
    await (await open(deactivated.client)).close();
    await t.sql`UPDATE users SET deactivated_at = now() WHERE id = ${deactivated.user.id}`;
    const res = await deactivated.client.raw("GET", "/ws", { headers: handshake() });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Sign in required" } });
    await expect(connect(deactivated.client)).rejects.toThrow();
  });
});

describe("messages", () => {
  test("ping is answered with pong", async () => {
    const socket = await open(owner);
    socket.send({ t: "ping" });
    expect(await socket.next()).toEqual({ t: "pong" });
    socket.send({ t: "ping", extra: "fields are ignored" });
    expect(await socket.next()).toEqual({ t: "pong" });
  });

  test("text that is not JSON, JSON that is not an object and unknown types are ignored", async () => {
    const socket = await open(owner);
    const ignored = ["", "not json", "{", "[1,2]", '[{"t":"ping"}]', "5", '"ping"', "null", "true", "{}", '{"t":"nope"}', '{"t":null}', '{"t":["ping"]}', '{"T":"ping"}', '{"t":"PING"}', '{"t":"pong"}', '{"t":"joined"}', '{"t":"event","kind":"tree"}'];
    for (const message of ignored) socket.send(message);
    // The socket is still usable, and nothing was answered in between.
    socket.send({ t: "ping" });
    expect(await socket.next()).toEqual({ t: "pong" });
    expect(socket.inbox).toEqual([]);
  });

  test("a binary frame holding JSON is read like a text frame", async () => {
    const socket = await open(owner);
    socket.ws.send(new TextEncoder().encode('{"t":"ping"}'));
    expect(await socket.next()).toEqual({ t: "pong" });
    socket.ws.send(new Uint8Array([0xff, 0xfe, 0x00]));
    socket.send({ t: "ping" });
    expect(await socket.next()).toEqual({ t: "pong" });
  });
});

describe("join", () => {
  test("at the page's version: joined, without the document", async () => {
    const { id } = await page();
    const socket = await open(owner);
    socket.send({ t: "join", pageId: id, version: 0, clientId: "a" });
    expect(await socket.next(about(id))).toEqual({ t: "joined", pageId: id, version: 0, readOnly: false });
  });

  test("without a version, or with one that is not an integer: joined with the whole document", async () => {
    const { id } = await page();
    const socket = await open(owner);
    const whole = { t: "joined", pageId: id, version: 0, doc: doc("hello"), readOnly: false };
    socket.send({ t: "join", pageId: id });
    expect(await socket.next(about(id))).toEqual(whole);
    for (const version of [null, "0", 0.5, -1, -0.5, true, [0], { n: 0 }, 1e300]) {
      socket.send({ t: "join", pageId: id, version });
      expect([version, await socket.next(about(id))]).toEqual([version, whole]);
    }
  });

  test("with a version ahead of the page: the whole document at the page's version", async () => {
    const { id } = await page();
    const socket = await open(owner);
    expect(await join(socket, id, 1)).toEqual({ t: "joined", pageId: id, version: 0, doc: doc("hello"), readOnly: false });
    expect(await join(socket, id, 99)).toEqual({ t: "joined", pageId: id, version: 0, doc: doc("hello"), readOnly: false });
  });

  test("behind by steps still in history: joined at the client's version, then the steps it missed", async () => {
    const { id } = await page();
    const a = await open(owner);
    await join(a, id, 0, "a");
    await sendSteps(a, id, 0, [insertText(6, "!")], "a");
    await sendSteps(a, id, 1, [insertText(1, ">"), insertText(2, ">")], "a2");

    const b = await open(reader);
    b.send({ t: "join", pageId: id, version: 1, clientId: "b" });
    expect(await b.next(about(id))).toEqual({ t: "joined", pageId: id, version: 1, readOnly: true });
    expect(await b.next(about(id))).toEqual({
      t: "steps",
      pageId: id,
      version: 3,
      steps: [insertText(1, ">"), insertText(2, ">")],
      clientIds: ["a2", "a2"],
    });

    const c = await open(owner);
    c.send({ t: "join", pageId: id, version: 0, clientId: "c" });
    expect(await c.next(about(id))).toEqual({ t: "joined", pageId: id, version: 0, readOnly: false });
    expect(await c.next(about(id))).toEqual({
      t: "steps",
      pageId: id,
      version: 3,
      steps: [insertText(6, "!"), insertText(1, ">"), insertText(2, ">")],
      clientIds: ["a", "a2", "a2"],
    });
    expect(await liveDoc(c, id)).toEqual({ version: 3, doc: doc(">>hello!") });
  });

  test("behind a version that is no longer in history: the whole document", async () => {
    const { id } = await page();
    // Replacing the content from outside starts the history again at version 1.
    expect((await owner.post(`/pages/${id}/content`, { content: doc("replaced") })).status).toBe(200);
    const socket = await open(owner);
    expect(await join(socket, id, 0)).toEqual({ t: "joined", pageId: id, version: 1, doc: doc("replaced"), readOnly: false });
    expect(await join(socket, id, 1)).toEqual({ t: "joined", pageId: id, version: 1, readOnly: false });
  });

  test("history keeps the last 2000 steps", async () => {
    const { id } = await page(doc(""));
    const a = await open(owner);
    await join(a, id, 0);
    const many = Array.from({ length: 2000 }, () => insertText(1, "x"));
    expect((await sendSteps(a, id, 0, many)).version).toBe(2000);

    const b = await open(owner);
    b.send({ t: "join", pageId: id, version: 0 });
    expect(await b.next(about(id))).toEqual({ t: "joined", pageId: id, version: 0, readOnly: false });
    const all = await b.next(about(id));
    expect(all).toMatchObject({ t: "steps", version: 2000 });
    expect(all.steps).toHaveLength(2000);
    expect(all.clientIds).toHaveLength(2000);

    await sendSteps(a, id, 2000, [insertText(1, "y")]);
    await b.nextOf("steps", { version: 2001 });
    // The first step has left history: a client still at version 0 starts over.
    const whole = await join(b, id, 0);
    expect(whole).toEqual({ t: "joined", pageId: id, version: 2001, doc: doc("y" + "x".repeat(2000)), readOnly: false });
    b.send({ t: "join", pageId: id, version: 1 });
    expect(await b.next(about(id))).toEqual({ t: "joined", pageId: id, version: 1, readOnly: false });
    const rest = await b.next(about(id));
    expect(rest).toMatchObject({ t: "steps", version: 2001 });
    expect(rest.steps).toHaveLength(2000);
    expect(rest.steps[1999]).toEqual(insertText(1, "y"));
  });

  test("history keeps at most 2 MiB of steps", async () => {
    const { id } = await page(doc(""));
    const a = await open(owner);
    await join(a, id, 0);
    const size = 800_000;
    const fill = (from: number, to: number, ch: string) => ({ stepType: "replace", from, to, slice: [{ t: ch.repeat(size) }] });
    expect((await sendSteps(a, id, 0, [fill(1, 1, "a")])).version).toBe(1);
    expect((await sendSteps(a, id, 1, [fill(1, 1 + size, "b")])).version).toBe(2);
    // Two steps of 800 000 characters fit, so a client at version 0 still catches up.
    a.send({ t: "join", pageId: id, version: 0 });
    expect(await a.next(about(id))).toEqual({ t: "joined", pageId: id, version: 0, readOnly: false });
    expect((await a.next(about(id))).steps).toHaveLength(2);

    expect((await sendSteps(a, id, 2, [fill(1, 1 + size, "c")])).version).toBe(3);
    // Three do not: the oldest is dropped.
    const whole = await join(a, id, 0);
    expect(whole.version).toBe(3);
    expect(whole.doc.content[0].content[0].text).toBe("c".repeat(size));
    a.send({ t: "join", pageId: id, version: 1 });
    expect(await a.next(about(id))).toEqual({ t: "joined", pageId: id, version: 1, readOnly: false });
    const rest = await a.next(about(id));
    expect(rest.steps).toHaveLength(2);
    expect(rest.clientIds).toEqual(["a", "a"]);
  });

  test("a page id that is not a UUID is ignored", async () => {
    const { id, slugId } = await page();
    const socket = await open(owner);
    for (const pageId of [undefined, null, 5, "", "nope", slugId, id.slice(0, 35), `${id}0`, id.replaceAll("-", ""), `{${id}}`, [id], { id }]) {
      socket.send({ t: "join", pageId, version: 0 });
    }
    socket.send({ t: "ping" });
    expect(await socket.next()).toEqual({ t: "pong" });
    expect(await socket.quiet(() => true, 150)).toBe(true);
  });

  test("a page that does not exist, or that the user cannot read, answers with an error", async () => {
    const socket = await open(reader);
    const missing = "00000000-0000-4000-8000-000000000000";
    socket.send({ t: "join", pageId: missing, version: 0 });
    expect(await socket.next()).toEqual({ t: "error", pageId: missing, message: ERRORS.noAccess });

    const space = (await owner.post("/spaces", { name: "Private", slug: "private-join" })).body.data.space;
    const secret = await createPage(owner, space.id, doc("secret"));
    socket.send({ t: "join", pageId: secret.id.toUpperCase(), version: 0 });
    expect(await socket.next()).toEqual({ t: "error", pageId: secret.id, message: ERRORS.noAccess });
    // Nothing was joined: editing answers as for any page that is not open.
    pushSteps(socket, secret.id, 0, [insertText(1, "x")]);
    expect(await socket.next()).toEqual({ t: "error", pageId: secret.id, message: ERRORS.notJoined });
    // A workspace admin is not a member of every space either.
    const { client: admin } = await t.addMember(owner, "ws-admin@example.com", "admin");
    const adminSocket = await open(admin);
    adminSocket.send({ t: "join", pageId: secret.id, version: 0 });
    expect(await adminSocket.next()).toEqual({ t: "error", pageId: secret.id, message: ERRORS.noAccess });
  });

  test("an upper-case page id joins the same page, and answers carry the lower-case id", async () => {
    const { id } = await page();
    const a = await open(owner);
    const b = await open(owner);
    await join(a, id, 0, "a");
    b.send({ t: "join", pageId: id.toUpperCase(), version: 0, clientId: "b" });
    expect(await b.next(about(id))).toEqual({ t: "joined", pageId: id, version: 0, readOnly: false });
    pushSteps(b, id.toUpperCase(), 0, [insertText(1, "B")], "b");
    const confirmed = { t: "steps", pageId: id, version: 1, steps: [insertText(1, "B")], clientIds: ["b"] };
    expect(await a.nextOf("steps")).toEqual(confirmed);
    expect(await b.nextOf("steps")).toEqual(confirmed);
    b.send({ t: "presence", pageId: id.toUpperCase(), selection: { anchor: 2, head: 2 } });
    const presence = await nextPresence(a, id, (users) => users.some((u) => u.selection));
    expect(presence.users.map((u: any) => [u.clientId, u.selection])).toEqual([["a", null], ["b", { anchor: 2, head: 2 }]]);
    forget(a);
    b.send({ t: "leave", pageId: id.toUpperCase() });
    expect((await nextPresence(a, id)).users.map((u: any) => u.clientId)).toEqual(["a"]);
  });

  test("a reader joins read-only; writers and admins do not", async () => {
    const { id } = await page();
    const r = await open(reader);
    expect(await join(r, id, 0)).toEqual({ t: "joined", pageId: id, version: 0, readOnly: true });
    expect(await join(r, id, -1)).toEqual({ t: "joined", pageId: id, version: 0, doc: doc("hello"), readOnly: true });

    const writer = await t.addMember(owner, "join-writer@example.com");
    await addToSpace(owner, spaceId, writer.user.id, "writer");
    const w = await open(writer.client);
    expect(await join(w, id, 0)).toEqual({ t: "joined", pageId: id, version: 0, readOnly: false });
    const a = await open(owner);
    expect(await join(a, id, 0)).toEqual({ t: "joined", pageId: id, version: 0, readOnly: false });
  });

  test("a page in the trash is joined read-only, by writers too", async () => {
    const { id } = await page();
    expect((await owner.post(`/pages/${id}/delete`)).status).toBe(200);
    const a = await open(owner);
    expect(await join(a, id, 0)).toEqual({ t: "joined", pageId: id, version: 0, readOnly: true });
    pushSteps(a, id, 0, [insertText(1, "x")]);
    expect(await a.next(about(id))).toEqual({ t: "error", pageId: id, message: ERRORS.readOnly });
  });

  test("a page without content starts from one empty paragraph", async () => {
    const created = await createPage(owner, spaceId);
    const a = await open(owner);
    expect(await join(a, created.id, -1)).toEqual({ t: "joined", pageId: created.id, version: 0, doc: EMPTY_DOC, readOnly: false });

    for (const content of [{ type: "doc" }, { type: "doc", content: [] }]) {
      const { id } = await page(content);
      expect(await join(a, id, -1)).toEqual({ t: "joined", pageId: id, version: 0, doc: EMPTY_DOC, readOnly: false });
    }
    const nulled = await page();
    await t.sql`UPDATE pages SET content = NULL WHERE id = ${nulled.id}`;
    expect(await join(a, nulled.id, -1)).toEqual({ t: "joined", pageId: nulled.id, version: 0, doc: EMPTY_DOC, readOnly: false });
    // It can be typed into.
    await sendSteps(a, nulled.id, 0, [insertText(1, "typed")]);
    expect(await liveDoc(a, nulled.id)).toEqual({
      version: 1,
      doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: null, textAlign: null, indent: 0 }, content: [{ type: "text", text: "typed" }] }] },
    });
  });

  test("the version a page is stored at is the version it is joined at", async () => {
    const { id } = await page();
    await t.sql`UPDATE pages SET doc_version = 41 WHERE id = ${id}`;
    const a = await open(owner);
    expect(await join(a, id, 41)).toEqual({ t: "joined", pageId: id, version: 41, readOnly: false });
    expect(await join(a, id, 40)).toEqual({ t: "joined", pageId: id, version: 41, doc: doc("hello"), readOnly: false });
    expect((await sendSteps(a, id, 41, [insertText(1, "x")])).version).toBe(42);
  });

  test("joining again answers again and keeps the client's place and selection", async () => {
    const { id } = await page();
    const a = await open(owner);
    const b = await open(owner);
    await join(a, id, 0, "a");
    await join(b, id, 0, "b");
    a.send({ t: "presence", pageId: id, selection: { anchor: 1, head: 3 } });
    await nextPresence(b, id, (users) => users.length === 2 && users[0].selection !== null);

    // A second join without a client id keeps the first one; a new id replaces it.
    expect(await join(a, id, 0)).toEqual({ t: "joined", pageId: id, version: 0, readOnly: false });
    expect(await join(a, id, 0, "a-renamed")).toEqual({ t: "joined", pageId: id, version: 0, readOnly: false });
    const renamed = await nextPresence(b, id, (users) => users[0].clientId === "a-renamed");
    expect(renamed.users).toEqual([
      { clientId: "a-renamed", userId: ownerId, name: "Owner", color: presenceColor(ownerId), selection: { anchor: 1, head: 3 } },
      { clientId: "b", userId: ownerId, name: "Owner", color: presenceColor(ownerId), selection: null },
    ]);
    // One confirmation per batch, however often the page was joined.
    await sendSteps(b, id, 0, [insertText(1, "x")], "b");
    await a.nextOf("steps", { version: 1 });
    expect(await a.quiet((m) => m.t === "steps", 150)).toBe(true);
  });

  test("a client id that is not a string of at most 64 characters is not taken", async () => {
    const { id } = await page();
    const a = await open(owner);
    const clientIdAfter = async (clientId: unknown) => {
      // Leaving first, so that no earlier client id of this socket is kept.
      a.send({ t: "leave", pageId: id });
      a.send({ t: "join", pageId: id, version: 0, clientId });
      await a.nextOf("joined", { pageId: id });
      return (await nextPresence(a, id)).users[0].clientId;
    };
    expect(await clientIdAfter("x".repeat(64))).toBe("x".repeat(64));
    expect(await clientIdAfter("x".repeat(65))).toBe("");
    expect(await clientIdAfter(7)).toBe("");
    expect(await clientIdAfter(null)).toBe("");
    expect(await clientIdAfter("")).toBe("");
    expect(await clientIdAfter("ünï-😀")).toBe("ünï-😀");
  });
});

describe("leave", () => {
  test("a client that left gets no more steps and has to join again before it edits", async () => {
    const { id } = await page();
    const a = await open(owner);
    const b = await open(owner);
    await join(a, id, 0, "a");
    await join(b, id, 0, "b");
    await leave(b, id);

    await sendSteps(a, id, 0, [insertText(1, "x")]);
    pushSteps(b, id, 1, [insertText(1, "y")], "b");
    expect(await b.next(about(id))).toEqual({ t: "error", pageId: id, message: ERRORS.notJoined });
    expect(b.inbox.filter((m) => m.t === "steps")).toEqual([]);

    // Coming back with the version it left at, it is caught up.
    b.send({ t: "join", pageId: id, version: 0, clientId: "b" });
    expect(await b.next(about(id))).toEqual({ t: "joined", pageId: id, version: 0, readOnly: false });
    expect(await b.next(about(id))).toEqual({ t: "steps", pageId: id, version: 1, steps: [insertText(1, "x")], clientIds: ["a"] });
  });

  test("leaving a page that is not open, or with a bad id, is ignored", async () => {
    const { id } = await page();
    const a = await open(owner);
    for (const pageId of [id, id.toUpperCase(), "00000000-0000-4000-8000-000000000000", "nope", undefined, null, 5]) {
      a.send({ t: "leave", pageId });
    }
    a.send({ t: "ping" });
    expect(await a.next()).toEqual({ t: "pong" });
    expect(await a.quiet(() => true, 150)).toBe(true);
  });

  test("events about a page reach the sockets that have it open, until they leave", async () => {
    const { id } = await page();
    const other = await page();
    const a = await open(owner);
    const r = await open(reader);
    await join(a, id, 0);
    await join(r, id, 0);
    const comment = (pageId: string) => owner.post("/comments", { pageId, body: doc("a comment") });
    expect((await comment(id)).status).toBe(200);
    expect(await a.nextOf("event", { kind: "comments" })).toEqual({ t: "event", kind: "comments", pageId: id });
    expect(await r.nextOf("event", { kind: "comments" })).toEqual({ t: "event", kind: "comments", pageId: id });

    await leave(r, id);
    expect((await comment(id)).status).toBe(200);
    expect((await comment(other.id)).status).toBe(200);
    expect(await a.nextOf("event", { kind: "comments" })).toEqual({ t: "event", kind: "comments", pageId: id });
    expect(await a.quiet((m) => m.kind === "comments", 150)).toBe(true);
    expect(r.inbox.filter((m) => m.kind === "comments")).toEqual([]);
  });
});

describe("steps", () => {
  test("a batch is confirmed to every client on the page, its sender included", async () => {
    const { id } = await page();
    const a = await open(owner);
    const b = await open(owner);
    const r = await open(reader);
    const elsewhere = await open(owner);
    await join(a, id, 0, "a");
    await join(b, id, 0, "b");
    await join(r, id, 0, "r");
    await join(elsewhere, (await page()).id, 0, "e");

    const steps = [insertText(6, "!"), { stepType: "addMark", from: 1, to: 6, mark: { type: "bold" } }, { stepType: "replace", from: 1, to: 2, slice: [] }];
    pushSteps(a, id, 0, steps, "a");
    const confirmed = { t: "steps", pageId: id, version: 3, steps, clientIds: ["a", "a", "a"] };
    expect(await a.next(about(id))).toEqual(confirmed);
    expect(await b.next(about(id))).toEqual(confirmed);
    expect(await r.next(about(id))).toEqual(confirmed);

    // Each batch carries the client id it was sent with.
    pushSteps(b, id, 3, [insertText(1, "B")], "b-again");
    const second = { t: "steps", pageId: id, version: 4, steps: [insertText(1, "B")], clientIds: ["b-again"] };
    expect(await a.next(about(id))).toEqual(second);
    expect(await b.next(about(id))).toEqual(second);
    expect(await r.next(about(id))).toEqual(second);
    expect(elsewhere.inbox.filter((m) => m.t === "steps")).toEqual([]);
  });

  test("before joining, they are answered with an error", async () => {
    const { id } = await page();
    const a = await open(owner);
    pushSteps(a, id, 0, [insertText(1, "x")]);
    expect(await a.next()).toEqual({ t: "error", pageId: id, message: ERRORS.notJoined });
    pushSteps(a, id.toUpperCase(), 0, "not even steps");
    expect(await a.next()).toEqual({ t: "error", pageId: id, message: ERRORS.notJoined });
    pushSteps(a, "00000000-0000-4000-8000-000000000000", 0, [insertText(1, "x")]);
    expect(await a.next()).toEqual({ t: "error", pageId: "00000000-0000-4000-8000-000000000000", message: ERRORS.notJoined });
    expect((await untilStored(t, id, 0)).content).toEqual(doc("hello"));
  });

  test("from a reader, they are answered with an error and reach nobody", async () => {
    const { id } = await page();
    const a = await open(owner);
    const r = await open(reader);
    await join(a, id, 0, "a");
    await join(r, id, 0, "r");
    pushSteps(r, id, 0, [insertText(1, "x")], "r");
    expect(await r.next(about(id))).toEqual({ t: "error", pageId: id, message: ERRORS.readOnly });
    // Not even a look at the batch: a malformed one is answered the same way.
    pushSteps(r, id, "zero", null, "r");
    expect(await r.next(about(id))).toEqual({ t: "error", pageId: id, message: ERRORS.readOnly });
    expect(await a.quiet(about(id), 150)).toBe(true);
    expect(await liveDoc(a, id)).toEqual({ version: 0, doc: doc("hello") });
  });

  test("without a client id, with one that is not a string or is longer than 64 characters, or with a bad page id, they are ignored", async () => {
    const { id } = await page();
    const a = await open(owner);
    await join(a, id, 0, "a");
    for (const clientId of [undefined, null, 5, ["a"], "x".repeat(65)]) {
      a.send({ t: "steps", pageId: id, version: 0, steps: [insertText(1, "x")], ...(clientId === undefined ? {} : { clientId }) });
    }
    for (const pageId of [undefined, null, "nope", 5]) a.send({ t: "steps", pageId, version: 0, clientId: "a", steps: [insertText(1, "x")] });
    expect(await a.quiet((m) => m.t !== "presence", 200)).toBe(true);
    expect(await liveDoc(a, id)).toEqual({ version: 0, doc: doc("hello") });
    // 64 characters, and the empty string, are client ids.
    expect((await sendSteps(a, id, 0, [insertText(1, "x")], "x".repeat(64))).clientIds).toEqual(["x".repeat(64)]);
    expect((await sendSteps(a, id, 1, [insertText(1, "y")], "")).clientIds).toEqual([""]);
  });

  test("a batch that is not well formed is rejected", async () => {
    const { id } = await page();
    const a = await open(owner);
    const b = await open(owner);
    await join(a, id, 0, "a");
    await join(b, id, 0, "b");
    const ok = insertText(1, "x");
    const rejected = async (label: string, version: unknown, steps: unknown) => {
      pushSteps(a, id, version, steps);
      expect([label, await a.next(about(id))]).toEqual([label, { t: "rejected", pageId: id }]);
      expect(a.inbox.filter(about(id))).toEqual([]);
    };
    await rejected("version missing", undefined, [ok]);
    await rejected("version null", null, [ok]);
    await rejected("version a string", "0", [ok]);
    await rejected("steps missing", 0, undefined);
    await rejected("steps null", 0, null);
    await rejected("steps an object", 0, { 0: ok, length: 1 });
    await rejected("steps a string", 0, "steps");
    await rejected("more than 2000 steps", 0, Array.from({ length: 2001 }, () => ok));

    const malformed: [string, unknown][] = [
      ["null", null],
      ["a string", "replace"],
      ["a number", 1],
      ["an array", [ok]],
      ["no step type", { from: 1, to: 1, slice: [] }],
      ["unknown step type", { stepType: "insert", from: 1, to: 1, slice: [] }],
      ["step type in another case", { stepType: "Replace", from: 1, to: 1, slice: [] }],
      ["replace without from", { stepType: "replace", to: 1, slice: [] }],
      ["replace without to", { stepType: "replace", from: 1, slice: [] }],
      ["replace without slice", { stepType: "replace", from: 1, to: 1 }],
      ["replace with a slice that is not a list", { stepType: "replace", from: 1, to: 1, slice: { t: "x" } }],
      ["replace with a negative position", { stepType: "replace", from: -1, to: 1, slice: [] }],
      ["replace with a fractional position", { stepType: "replace", from: 1, to: 1.5, slice: [] }],
      ["replace with a position as a string", { stepType: "replace", from: "1", to: 1, slice: [] }],
      ["replace with a null position", { stepType: "replace", from: null, to: 1, slice: [] }],
      ["replaceAround without gapFrom", { stepType: "replaceAround", from: 0, to: 7, gapTo: 7, insert: 1, slice: [] }],
      ["replaceAround without gapTo", { stepType: "replaceAround", from: 0, to: 7, gapFrom: 0, insert: 1, slice: [] }],
      ["replaceAround without insert", { stepType: "replaceAround", from: 0, to: 7, gapFrom: 0, gapTo: 7, slice: [] }],
      ["replaceAround with a negative insert", { stepType: "replaceAround", from: 0, to: 7, gapFrom: 0, gapTo: 7, insert: -1, slice: [] }],
      ["replaceAround without slice", { stepType: "replaceAround", from: 0, to: 7, gapFrom: 0, gapTo: 7, insert: 0 }],
      ["replaceAround without from", { stepType: "replaceAround", to: 7, gapFrom: 0, gapTo: 7, insert: 0, slice: [] }],
      ["replaceAround without to", { stepType: "replaceAround", from: 0, gapFrom: 0, gapTo: 7, insert: 0, slice: [] }],
      ["addMark without a mark", { stepType: "addMark", from: 1, to: 2 }],
      ["addMark with a null mark", { stepType: "addMark", from: 1, to: 2, mark: null }],
      ["addMark with a mark name", { stepType: "addMark", from: 1, to: 2, mark: "bold" }],
      ["addMark with a mark without type", { stepType: "addMark", from: 1, to: 2, mark: { attrs: {} } }],
      ["addMark with a numeric mark type", { stepType: "addMark", from: 1, to: 2, mark: { type: 1 } }],
      ["addMark without to", { stepType: "addMark", from: 1, mark: { type: "bold" } }],
      ["addMark with a fractional from", { stepType: "addMark", from: 0.5, to: 2, mark: { type: "bold" } }],
      ["removeMark without a mark", { stepType: "removeMark", from: 1, to: 2 }],
      ["removeMark without from", { stepType: "removeMark", to: 2, mark: { type: "bold" } }],
      ["attr without pos", { stepType: "attr", attrs: {} }],
      ["attr with a negative pos", { stepType: "attr", pos: -1, attrs: {} }],
      ["attr without attrs", { stepType: "attr", pos: 0 }],
      ["attr with null attrs", { stepType: "attr", pos: 0, attrs: null }],
      ["attr with attrs that are not an object", { stepType: "attr", pos: 0, attrs: "level" }],
    ];
    for (const [label, step] of malformed) await rejected(label, 0, [step]);
    // One bad step refuses the whole batch.
    await rejected("a good step and a bad one", 0, [ok, { stepType: "replace" }]);

    // Nothing was applied, nobody else heard of it, and the page still takes steps.
    expect(await b.quiet(about(id), 150)).toBe(true);
    expect((await sendSteps(a, id, 0, [ok])).version).toBe(1);
  });

  test("a batch of 2000 steps is taken", async () => {
    const { id } = await page(doc(""));
    const a = await open(owner);
    await join(a, id, 0);
    const confirmed = await sendSteps(a, id, 0, Array.from({ length: 2000 }, (_, i) => insertText(1 + i, String(i % 10))));
    expect(confirmed.version).toBe(2000);
    expect(confirmed.clientIds).toEqual(Array.from({ length: 2000 }, () => "a"));
    expect((await liveDoc(a, id)).doc).toEqual(doc("0123456789".repeat(200)));
  });

  test("a batch made against an older version is rejected, and the client is sent what it missed", async () => {
    const { id } = await page();
    const a = await open(owner);
    const b = await open(owner);
    await join(a, id, 0, "a");
    await join(b, id, 0, "b");
    await sendSteps(a, id, 0, [insertText(1, "A")], "a");
    await b.nextOf("steps", { version: 1 });
    await sendSteps(a, id, 1, [insertText(2, "B")], "a");
    await b.nextOf("steps", { version: 2 });

    // b still thinks the page is at version 0.
    pushSteps(b, id, 0, [insertText(6, "!")], "b");
    expect(await b.next(about(id))).toEqual({ t: "rejected", pageId: id });
    expect(await b.next(about(id))).toEqual({ t: "joined", pageId: id, version: 0, readOnly: false });
    expect(await b.next(about(id))).toEqual({
      t: "steps",
      pageId: id,
      version: 2,
      steps: [insertText(1, "A"), insertText(2, "B")],
      clientIds: ["a", "a"],
    });
    // Nothing of the rejected batch was applied or shown to others.
    expect(await a.quiet(about(id), 150)).toBe(true);
    // Rebased onto version 2 by the client, it is taken.
    pushSteps(b, id, 2, [insertText(8, "!")], "b");
    const confirmed = { t: "steps", pageId: id, version: 3, steps: [insertText(8, "!")], clientIds: ["b"] };
    expect(await b.next(about(id))).toEqual(confirmed);
    expect(await a.next(about(id))).toEqual(confirmed);
    expect(await liveDoc(a, id)).toEqual({ version: 3, doc: doc("ABhello!") });
  });

  test("a batch made against a version the page never had is rejected, and the client is sent the document", async () => {
    const { id } = await page();
    const a = await open(owner);
    await join(a, id, 0);
    await sendSteps(a, id, 0, [insertText(6, "!")]);
    for (const version of [2, 1000, -1]) {
      pushSteps(a, id, version, [insertText(1, "x")]);
      expect(await a.next(about(id))).toEqual({ t: "rejected", pageId: id });
      expect(await a.next(about(id))).toEqual({ t: "joined", pageId: id, version: 1, doc: doc("hello!"), readOnly: false });
    }
    // Accident: a fractional version is compared as a number, found "in history", and echoed back
    // in `joined` before all the steps since the version below it.
    pushSteps(a, id, 0.5, [insertText(1, "x")]);
    expect(await a.next(about(id))).toEqual({ t: "rejected", pageId: id });
    expect(await a.next(about(id))).toEqual({ t: "joined", pageId: id, version: 0.5, readOnly: false });
    expect(await a.next(about(id))).toEqual({ t: "steps", pageId: id, version: 1, steps: [insertText(6, "!")], clientIds: ["a"] });
  });

  test("a batch that does not apply resets its sender to the page's document and reaches nobody else", async () => {
    const { id } = await page();
    const a = await open(owner);
    const b = await open(owner);
    await join(a, id, 0, "a");
    await join(b, id, 0, "b");
    await sendSteps(a, id, 0, [insertText(6, "!")]);
    await b.nextOf("steps", { version: 1 });

    // The first step applies, the second deletes past the end of the document.
    pushSteps(a, id, 1, [insertText(1, "x"), { stepType: "replace", from: 0, to: 100, slice: [] }]);
    expect(await a.next(about(id))).toEqual({ t: "error", pageId: id, message: ERRORS.invalidStep });
    expect(await a.next(about(id))).toEqual({ t: "joined", pageId: id, version: 1, doc: doc("hello!"), readOnly: false });
    expect(await b.quiet(about(id), 150)).toBe(true);
    // The page is as it was and still takes steps at its version.
    expect((await sendSteps(a, id, 1, [insertText(1, "x")])).version).toBe(2);
  });

  test("an empty batch is confirmed as it is", async () => {
    const { id } = await page();
    const a = await open(owner);
    const b = await open(owner);
    await join(a, id, 0, "a");
    await join(b, id, 0, "b");
    pushSteps(a, id, 0, []);
    // Accident: nothing changed, yet the batch is broadcast (and the page saved with its sender as an editor).
    expect(await a.next(about(id))).toEqual({ t: "steps", pageId: id, version: 0, steps: [], clientIds: [] });
    expect(await b.next(about(id))).toEqual({ t: "steps", pageId: id, version: 0, steps: [], clientIds: [] });
  });

  test("slice items that are not objects, or text that is not a string, get no answer at all", async () => {
    const { id } = await page();
    const a = await open(owner);
    await join(a, id, 0);
    // Accident: these throw inside the server while the batch is cleaned or applied; the message is
    // dropped (with an error in the server's log) instead of being rejected. The socket and the page are unharmed.
    const dropped = [
      [{ stepType: "replace", from: 1, to: 1, slice: [5] }],
      [{ stepType: "replace", from: 1, to: 1, slice: [null] }],
      [{ stepType: "replace", from: 1, to: 1, slice: ["x"] }],
      [{ stepType: "replace", from: 1, to: 1, slice: [{ n: null }] }],
      [{ stepType: "replace", from: 1, to: 1, slice: [{ t: 5 }] }],
      [{ stepType: "replaceAround", from: 0, to: 7, gapFrom: 0, gapTo: 7, insert: 0, slice: [7] }],
    ];
    for (const steps of dropped) pushSteps(a, id, 0, steps);
    expect(await a.quiet(about(id), 250)).toBe(true);
    expect((await sendSteps(a, id, 0, [insertText(1, "x")])).version).toBe(1);
  });

  test("URLs that could run script are emptied before a step is applied and confirmed", async () => {
    const { id, slugId } = await page();
    const a = await open(owner);
    const b = await open(reader);
    await join(a, id, 0, "a");
    await join(b, id, 0, "b");
    pushSteps(a, id, 0, [
      { stepType: "addMark", from: 1, to: 6, mark: { type: "link", attrs: { href: "javascript:alert(1)" } } },
      { stepType: "replace", from: 7, to: 7, slice: [{ o: "pdf", a: { src: "javascript:alert(1)", name: "x.pdf" } }, { c: 1 }] },
    ]);
    const confirmed = {
      t: "steps",
      pageId: id,
      version: 2,
      steps: [
        { stepType: "addMark", from: 1, to: 6, mark: { type: "link", attrs: { href: "" } } },
        { stepType: "replace", from: 7, to: 7, slice: [{ o: "pdf", a: { src: "", name: "x.pdf" } }, { c: 1 }] },
      ],
      clientIds: ["a", "a"],
    };
    expect(await a.next(about(id))).toEqual(confirmed);
    expect(await b.next(about(id))).toEqual(confirmed);
    a.send({ t: "leave", pageId: id });
    b.send({ t: "leave", pageId: id });
    await untilStored(t, id, 2);
    const saved = (await owner.get(`/pages/${slugId}`)).body.data.page;
    expect(saved.content).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello", marks: [{ type: "link", attrs: { href: "" } }] }] },
        // Accident: a leaf written as an opening and a closing token is taken, and keeps an empty content list.
        { type: "pdf", attrs: { src: "", name: "x.pdf" }, content: [] },
      ],
    });
  });
});

describe("presence", () => {
  test("everyone on a page is told who is there, in the order they joined", async () => {
    const { id } = await page();
    const a = await open(owner);
    await join(a, id, 0, "a");
    expect(await a.nextOf("presence")).toEqual({
      t: "presence",
      pageId: id,
      users: [{ clientId: "a", userId: ownerId, name: "Owner", color: presenceColor(ownerId), selection: null }],
    });

    const r = await open(reader);
    await join(r, id, 0, "r");
    const both = {
      t: "presence",
      pageId: id,
      users: [
        { clientId: "a", userId: ownerId, name: "Owner", color: presenceColor(ownerId), selection: null },
        { clientId: "r", userId: readerId, name: "reader", color: presenceColor(readerId), selection: null },
      ],
    };
    expect(await a.nextOf("presence")).toEqual(both);
    expect(await r.nextOf("presence")).toEqual(both);

    // A second tab of the same person is a second entry.
    const a2 = await open(owner);
    await join(a2, id, 0, "a2");
    const three = await a.nextOf("presence");
    expect(three.users.map((u: any) => [u.clientId, u.userId])).toEqual([["a", ownerId], ["r", readerId], ["a2", ownerId]]);
  });

  test("a caret colour is one of eight, picked by the user's id", async () => {
    // What the server is expected to compute: a 32-bit hash of the id's characters (h = h * 31 + code), by its absolute value.
    expect(presenceColor("00000000-0000-4000-8000-000000000000")).toBe("#12a594");
    expect(presenceColor("ffffffff-ffff-4fff-bfff-ffffffffffff")).toBe("#ffb224");
    expect(presenceColor("572d7af6-9196-4a91-aff4-87ef77b44eb3")).toBe("#f76b15");
    expect(presenceColor("3f2c9d1e-5b7a-4c8d-9e0f-a1b2c3d4e5f6")).toBe("#0090ff");
    const { id } = await page();
    const seen = new Map<string, string>();
    for (let i = 0; i < 6; i++) {
      const { client, user } = await t.addMember(owner, `colour-${i}@example.com`);
      await addToSpace(owner, spaceId, user.id, "reader");
      const socket = await open(client);
      await join(socket, id, 0, `c${i}`);
      const presence = await nextPresence(socket, id, (users) => users.length === i + 1);
      const mine = presence.users[i];
      expect(PRESENCE_COLORS).toContain(mine.color);
      expect(mine.color).toBe(presenceColor(user.id));
      seen.set(user.id, mine.color);
      // The same on another page, and for everyone else looking.
      const other = await page();
      await join(socket, other.id, 0, `c${i}`);
      expect((await nextPresence(socket, other.id)).users[0].color).toBe(mine.color);
      for (const [index, entry] of presence.users.entries()) {
        if (index < i) expect(seen.get(entry.userId)).toBe(entry.color);
      }
    }
  });

  test("a selection is shown to everyone; null or a malformed one clears it", async () => {
    const { id } = await page();
    const a = await open(owner);
    const r = await open(reader);
    await join(a, id, 0, "a");
    await join(r, id, 0, "r");
    await nextPresence(a, id, (users) => users.length === 2);
    await nextPresence(r, id, (users) => users.length === 2);
    // From here on every change is announced once, to both.
    forget(a);
    forget(r);
    const shown = async (selection: unknown, extra: Record<string, unknown> = {}) => {
      r.send({ t: "presence", pageId: id, selection, ...extra });
      const [toA, toR] = await Promise.all([a.nextOf("presence"), r.nextOf("presence")]);
      expect(toA).toEqual(toR);
      expect(toA.users[0]).toEqual({ clientId: "a", userId: ownerId, name: "Owner", color: presenceColor(ownerId), selection: null });
      expect(toA.users[1]).toMatchObject({ clientId: "r", userId: readerId });
      return toA.users[1].selection;
    };
    // Readers have a caret too.
    expect(await shown({ anchor: 1, head: 4 })).toEqual({ anchor: 1, head: 4 });
    expect(await shown({ anchor: 6, head: 2, extra: "dropped" })).toEqual({ anchor: 6, head: 2 });
    expect(await shown(null)).toBeNull();
    expect(await shown({ anchor: 3, head: 3 })).toEqual({ anchor: 3, head: 3 });
    expect(await shown(undefined)).toBeNull();
    for (const malformed of [{ anchor: 1 }, { head: 1 }, { anchor: "1", head: 2 }, { anchor: 1, head: null }, [1, 2], "1-2", 7, true, {}]) {
      await shown({ anchor: 2, head: 2 });
      expect([malformed, await shown(malformed)]).toEqual([malformed, null]);
    }
    // Positions are not checked against the document.
    expect(await shown({ anchor: -5, head: 1e9 })).toEqual({ anchor: -5, head: 1e9 });
    expect(await shown({ anchor: 1.5, head: 2.25 })).toEqual({ anchor: 1.5, head: 2.25 });
  });

  test("presence for a page that is not open, or with a bad id, is ignored", async () => {
    const { id } = await page();
    const a = await open(owner);
    const b = await open(owner);
    await join(a, id, 0, "a");
    await nextPresence(a, id);
    for (const pageId of [id, "nope", undefined, "00000000-0000-4000-8000-000000000000"]) {
      b.send({ t: "presence", pageId, selection: { anchor: 1, head: 1 } });
    }
    expect(await a.quiet((m) => m.t === "presence", 200)).toBe(true);
    expect(await b.quiet(() => true, 50)).toBe(true);
  });

  test("changes within 50 ms are sent as one message with the latest state", async () => {
    const { id } = await page();
    const a = await open(owner);
    const b = await open(owner);
    await join(a, id, 0, "a");
    await join(b, id, 0, "b");
    await nextPresence(a, id, (users) => users.length === 2);
    await nextPresence(b, id, (users) => users.length === 2);
    forget(a);
    forget(b);
    for (let head = 1; head <= 6; head++) a.send({ t: "presence", pageId: id, selection: { anchor: 1, head } });
    const sent = await b.nextOf("presence");
    expect(sent.users[0].selection).toEqual({ anchor: 1, head: 6 });
    expect(await b.quiet((m) => m.t === "presence", 200)).toBe(true);
    expect((await a.nextOf("presence")).users[0].selection).toEqual({ anchor: 1, head: 6 });
    expect(await a.quiet((m) => m.t === "presence", 100)).toBe(true);
  });

  test("the client id shown follows the one steps are sent with", async () => {
    const { id } = await page();
    const a = await open(owner);
    await join(a, id, 0, "first");
    expect((await a.nextOf("presence")).users[0].clientId).toBe("first");
    await sendSteps(a, id, 0, [insertText(1, "x")], "second");
    // Steps do not announce presence by themselves; the next change does.
    expect(await a.quiet((m) => m.t === "presence", 150)).toBe(true);
    a.send({ t: "presence", pageId: id, selection: null });
    expect((await a.nextOf("presence")).users[0].clientId).toBe("second");
    // Also when the batch itself is rejected.
    pushSteps(a, id, 1, "malformed", "third");
    await a.nextOf("rejected");
    a.send({ t: "presence", pageId: id, selection: null });
    expect((await a.nextOf("presence")).users[0].clientId).toBe("third");
  });

  test("someone who leaves, or whose socket closes, is taken off the list", async () => {
    const { id } = await page();
    const a = await open(owner);
    const b = await open(owner);
    const c = await open(reader);
    await join(a, id, 0, "a");
    await join(b, id, 0, "b");
    await join(c, id, 0, "c");
    await nextPresence(a, id, (users) => users.length === 3);
    await nextPresence(b, id, (users) => users.length === 3);
    forget(a);
    forget(b);
    b.send({ t: "leave", pageId: id });
    const afterLeave = await nextPresence(a, id, (users) => users.length === 2);
    expect(afterLeave.users.map((u: any) => u.clientId)).toEqual(["a", "c"]);
    // The one who left is not told.
    expect(await b.quiet((m) => m.t === "presence" && m.users.length === 2, 150)).toBe(true);
    await c.close();
    const afterClose = await nextPresence(a, id, (users) => users.length === 1);
    expect(afterClose.users.map((u: any) => u.clientId)).toEqual(["a"]);
  });
});

describe("limits", () => {
  test("60 messages in a second are answered; the 61st closes the socket with 1008", async () => {
    const steady = await open(owner);
    for (let i = 0; i < 60; i++) steady.send({ t: "ping" });
    for (let i = 0; i < 60; i++) await steady.nextOf("pong");
    // A new second, a new allowance.
    await Bun.sleep(1050);
    steady.send({ t: "ping" });
    expect(await steady.next()).toEqual({ t: "pong" });

    const flood = await open(owner);
    for (let i = 0; i < 61; i++) flood.send({ t: "ping" });
    expect(await flood.closed).toEqual({ code: 1008, reason: "too many messages" });
    expect(flood.inbox).toEqual(Array.from({ length: 60 }, () => ({ t: "pong" })));

    // Messages the server ignores count as well.
    const noisy = await open(owner);
    for (let i = 0; i < 61; i++) noisy.send("not json");
    expect(await noisy.closed).toEqual({ code: 1008, reason: "too many messages" });
    // Other sockets of the same user are not affected.
    steady.send({ t: "ping" });
    expect(await steady.next()).toEqual({ t: "pong" });
  });

  test("a message of 2 MiB is read; a larger one closes the socket", async () => {
    const limit = 2 * 1024 * 1024;
    const padded = (bytes: number) => `{"t":"ping","pad":"${"x".repeat(bytes - 21)}"}`;
    const a = await open(owner);
    expect(padded(limit)).toHaveLength(limit);
    a.send(padded(limit));
    expect(await a.next()).toEqual({ t: "pong" });
    a.send(padded(limit + 1));
    // "Message too big". The reason text is the server library's own and is not pinned.
    expect((await a.closed).code).toBe(1009);
  });
});

describe("what closes a socket", () => {
  /** The link of the newest password-reset mail to `email`. */
  const resetToken = async (email: string) => {
    const mail = await new Promise<{ text: string }>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const look = () => {
        const found = t.outbox.findLast((m) => m.to === email && m.subject.startsWith("Reset your"));
        if (found) resolve(found);
        else if (Date.now() > deadline) reject(new Error("no reset mail"));
        else setTimeout(look, 20);
      };
      look();
    });
    return new URL(/http:\/\/doc\.test\/reset-password\S+/.exec(mail.text)![0]).searchParams.get("token")!;
  };

  test("deactivating a user closes their sockets with 4001 at once, and saves what they typed", async () => {
    const { id } = await page();
    const { client, user } = await t.addMember(owner, "closed-deactivated@example.com");
    await addToSpace(owner, spaceId, user.id, "writer");
    const first = await open(client);
    const second = await open(client);
    const bystander = await open(owner);
    await join(first, id, 0, "m");
    await sendSteps(first, id, 0, [insertText(6, "!")], "m");

    expect((await owner.post("/members/deactivate", { userId: user.id })).status).toBe(200);
    expect(await first.closed).toEqual({ code: 4001, reason: "signed out" });
    expect(await second.closed).toEqual({ code: 4001, reason: "signed out" });
    expect((await untilStored(t, id, 1)).content).toEqual(doc("hello!"));
    bystander.send({ t: "ping" });
    expect(await bystander.nextOf("pong")).toEqual({ t: "pong" });
  });

  test("deleting a user closes their sockets with 4001 at once", async () => {
    const { client, user } = await t.addMember(owner, "closed-deleted@example.com");
    const socket = await open(client);
    expect((await owner.post("/members/delete", { userId: user.id })).status).toBe(200);
    expect(await socket.closed).toEqual({ code: 4001, reason: "signed out" });
  });

  test("resetting a password closes every socket of that user with 4001 at once", async () => {
    const { client } = await t.addMember(owner, "closed-reset@example.com");
    const first = await open(client);
    const second = await open(client);
    expect((await t.client().post("/auth/forgot-password", { email: "closed-reset@example.com" })).status).toBe(200);
    const token = await resetToken("closed-reset@example.com");
    const fresh = t.client();
    expect((await fresh.post("/auth/reset-password", { token, password: "a-new-password" })).status).toBe(200);
    expect(await first.closed).toEqual({ code: 4001, reason: "signed out" });
    expect(await second.closed).toEqual({ code: 4001, reason: "signed out" });
    // The session the reset signed in opens a socket again.
    const again = await open(fresh);
    again.send({ t: "ping" });
    expect(await again.next()).toEqual({ t: "pong" });
  });
});
