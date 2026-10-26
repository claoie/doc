import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { doc, startTestServer, type Client, type TestContext } from "server/test-helpers";

let t: TestContext;
let owner: Client;
let spaceId: string;

beforeAll(async () => {
  t = await startTestServer();
  ({ owner, spaceId } = await t.setupOwner());
});

afterAll(async () => {
  await t.close();
});

/** A WebSocket client that queues incoming messages for `next`. */
const connect = async (client: Client) => {
  const ws = new WebSocket(`${t.base.replace("http", "ws")}/api/ws`, { headers: { cookie: `session=${client.cookie}` } } as never);
  const inbox: Record<string, unknown>[] = [];
  const waiters: ((m: Record<string, unknown>) => void)[] = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else inbox.push(msg);
  };
  await new Promise((resolve) => (ws.onopen = resolve));
  const next = (pred: (m: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const found = inbox.findIndex(pred);
      if (found >= 0) return resolve(inbox.splice(found, 1)[0]!);
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 3000);
      const check = (m: Record<string, unknown>) => {
        if (pred(m)) {
          clearTimeout(timer);
          resolve(m);
        } else {
          inbox.push(m);
          waiters.push(check);
        }
      };
      waiters.push(check);
    });
  return { ws, next, send: (m: Record<string, unknown>) => ws.send(JSON.stringify(m)) };
};

const createPage = async (content = doc("hello")) => {
  const res = await owner.post("/pages", { spaceId, title: "Collab", content });
  return res.body.data.page as { id: string; slugId: string; docVersion: number };
};

describe("realtime collaboration", () => {
  test("steps are confirmed, broadcast and saved", async () => {
    const page = await createPage();
    const a = await connect(owner);
    const b = await connect(owner);
    a.send({ t: "join", pageId: page.id, version: 0, clientId: "a" });
    b.send({ t: "join", pageId: page.id, version: 0, clientId: "b" });
    expect(await a.next((m) => m.t === "joined")).toMatchObject({ version: 0, readOnly: false });
    await b.next((m) => m.t === "joined");

    a.send({ t: "steps", pageId: page.id, version: 0, clientId: "a", steps: [{ stepType: "replace", from: 6, to: 6, slice: [{ t: "!" }] }] });
    const toA = await a.next((m) => m.t === "steps");
    const toB = await b.next((m) => m.t === "steps");
    expect(toA).toMatchObject({ version: 1, clientIds: ["a"] });
    expect(toB).toMatchObject({ version: 1, clientIds: ["a"] });

    a.send({ t: "leave", pageId: page.id });
    b.send({ t: "leave", pageId: page.id });
    await Bun.sleep(300);
    const saved = await owner.get(`/pages/${page.slugId}`);
    expect(saved.body.data.page.content.content[0].content[0].text).toBe("hello!");
    expect(saved.body.data.page.docVersion).toBe(1);
    a.ws.close();
    b.ws.close();
  });

  test("a stale client is rejected and caught up", async () => {
    const page = await createPage();
    const a = await connect(owner);
    const b = await connect(owner);
    a.send({ t: "join", pageId: page.id, version: 0, clientId: "a" });
    b.send({ t: "join", pageId: page.id, version: 0, clientId: "b" });
    await a.next((m) => m.t === "joined");
    await b.next((m) => m.t === "joined");
    a.send({ t: "steps", pageId: page.id, version: 0, clientId: "a", steps: [{ stepType: "replace", from: 1, to: 1, slice: [{ t: "A" }] }] });
    await a.next((m) => m.t === "steps");
    await b.next((m) => m.t === "steps");
    // b still thinks the version is 0.
    b.send({ t: "steps", pageId: page.id, version: 0, clientId: "b", steps: [{ stepType: "replace", from: 6, to: 6, slice: [{ t: "B" }] }] });
    expect(await b.next((m) => m.t === "rejected")).toMatchObject({ pageId: page.id });
    a.ws.close();
    b.ws.close();
  });

  test("readers join read-only and cannot send steps", async () => {
    const page = await createPage();
    const { client: reader, user } = await t.addMember(owner, "reader@example.com");
    await owner.post(`/spaces/${spaceId}/members/add`, { role: "reader", userIds: [user.id] });
    const r = await connect(reader);
    r.send({ t: "join", pageId: page.id, version: 0, clientId: "r" });
    expect(await r.next((m) => m.t === "joined")).toMatchObject({ readOnly: true });
    r.send({ t: "steps", pageId: page.id, version: 0, clientId: "r", steps: [{ stepType: "replace", from: 1, to: 1, slice: [{ t: "x" }] }] });
    expect(await r.next((m) => m.t === "error")).toMatchObject({ pageId: page.id });
    r.ws.close();
  });

  test("invalid steps reset the client with the server document", async () => {
    const page = await createPage();
    const a = await connect(owner);
    a.send({ t: "join", pageId: page.id, version: 0, clientId: "a" });
    await a.next((m) => m.t === "joined");
    a.send({ t: "steps", pageId: page.id, version: 0, clientId: "a", steps: [{ stepType: "replace", from: 0, to: 7, slice: [] }] });
    const reset = await a.next((m) => m.t === "joined" && "doc" in m);
    expect(reset).toMatchObject({ version: 0 });
    a.ws.close();
  });

  test("replacing content from outside reaches open editors", async () => {
    const page = await createPage();
    const a = await connect(owner);
    a.send({ t: "join", pageId: page.id, version: 0, clientId: "a" });
    await a.next((m) => m.t === "joined");
    const res = await owner.post(`/pages/${page.id}/content`, { content: doc("replaced") });
    expect(res.status).toBe(200);
    expect(await a.next((m) => m.t === "steps")).toMatchObject({ clientIds: ["server"], version: 1 });
    a.ws.close();
  });

  test("editors lose access when removed from the space and go read-only when demoted", async () => {
    const created = await owner.post("/spaces", { name: "Private", slug: `private-${Date.now()}` });
    const space = created.body.data.space;
    const page = (await owner.post("/pages", { spaceId: space.id, title: "Secret", content: doc("hello") })).body.data.page;
    const { client: member, user } = await t.addMember(owner, `editor-${Date.now()}@example.com`);
    await owner.post(`/spaces/${space.id}/members/add`, { role: "writer", userIds: [user.id] });
    const m = await connect(member);
    m.send({ t: "join", pageId: page.id, version: 0, clientId: "m" });
    expect(await m.next((x) => x.t === "joined")).toMatchObject({ readOnly: false });

    const members = (await owner.get(`/spaces/${space.id}/members`)).body.data as { id: string; user: { id: string } | null }[];
    const membership = members.find((x) => x.user?.id === user.id)!;
    await owner.post(`/spaces/${space.id}/members/role`, { memberId: membership.id, role: "reader" });
    expect(await m.next((x) => x.t === "joined")).toMatchObject({ readOnly: true });

    await owner.post(`/spaces/${space.id}/members/remove`, { memberId: membership.id });
    expect(await m.next((x) => x.t === "error")).toMatchObject({ message: "You no longer have access to this page" });
    m.send({ t: "steps", pageId: page.id, version: 0, clientId: "m", steps: [{ stepType: "replace", from: 1, to: 1, slice: [{ t: "x" }] }] });
    expect(await m.next((x) => x.t === "error")).toMatchObject({ message: "Join the page before editing" });
    m.ws.close();
  });

  test("trashing a page makes open editors read-only", async () => {
    const page = await createPage();
    const a = await connect(owner);
    a.send({ t: "join", pageId: page.id, version: 0, clientId: "a" });
    await a.next((m) => m.t === "joined");
    await owner.post(`/pages/${page.id}/delete`);
    expect(await a.next((m) => m.t === "joined")).toMatchObject({ readOnly: true });
    a.ws.close();
  });

  test("script URLs in steps are stripped before they are applied", async () => {
    const page = await createPage();
    const a = await connect(owner);
    a.send({ t: "join", pageId: page.id, version: 0, clientId: "a" });
    await a.next((m) => m.t === "joined");
    a.send({ t: "steps", pageId: page.id, version: 0, clientId: "a", steps: [{ stepType: "replace", from: 7, to: 7, slice: [{ o: "pdf", a: { src: "javascript:alert(1)" } }, { c: 1 }] }] });
    const echoed = await a.next((m) => m.t === "steps");
    expect(JSON.stringify(echoed)).not.toContain("javascript:");
    a.send({ t: "leave", pageId: page.id });
    await Bun.sleep(300);
    const saved = await owner.get(`/pages/${page.slugId}`);
    expect(saved.body.data.page.content.content[1]).toMatchObject({ type: "pdf", attrs: { src: "" } });
    a.ws.close();
  });

  test("an upper-case page id joins the same session", async () => {
    const page = await createPage();
    const a = await connect(owner);
    const b = await connect(owner);
    a.send({ t: "join", pageId: page.id, version: 0, clientId: "a" });
    b.send({ t: "join", pageId: page.id.toUpperCase(), version: 0, clientId: "b" });
    await a.next((m) => m.t === "joined");
    await b.next((m) => m.t === "joined");
    a.send({ t: "steps", pageId: page.id, version: 0, clientId: "a", steps: [{ stepType: "replace", from: 1, to: 1, slice: [{ t: "A" }] }] });
    expect(await b.next((m) => m.t === "steps")).toMatchObject({ version: 1 });
    a.ws.close();
    b.ws.close();
  });
});
