import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, doc, startServer, target, type Client, type TestServer } from "./harness";

let t: TestServer;
let owner: Client;
let spaceId: string;

beforeAll(async () => {
  t = await startServer();
  ({ owner, spaceId } = await t.setupOwner());
});

afterAll(async () => {
  await t.close();
});

describe(`the ${target} server answers`, () => {
  test("health, without a session", async () => {
    const res = await t.client().get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { ok: true } });
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("unknown endpoints and missing sessions in the error envelope", async () => {
    const missing = await owner.get("/no-such-endpoint");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: "not_found", message: "Endpoint not found" } } as never);
    const anonymous = await t.client().get("/me");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ error: { code: "unauthorized", message: "Sign in required" } } as never);
  });

  test("a page round trip, mail and the realtime socket", async () => {
    const created = await owner.post("/pages", { spaceId, title: "Smoke", content: doc("hello") });
    expect(created.status).toBe(200);
    const page = created.body.data.page;
    expect(page.content).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] });

    await t.addMember(owner, "member@example.com");
    await t.smtp.waitFor(1);
    expect(t.outbox[0]).toMatchObject({ to: "member@example.com", from: "docs@doc.test", subject: "Owner invited you to Acme" });
    expect(t.outbox[0]!.text).toContain("http://doc.test/invites/");

    const socket = await connect(owner);
    socket.send({ t: "ping" });
    expect(await socket.nextOf("pong")).toEqual({ t: "pong" });
    socket.send({ t: "join", pageId: page.id, version: page.docVersion });
    expect(await socket.nextOf("joined")).toEqual({ t: "joined", pageId: page.id, version: 0, readOnly: false });
    await socket.close();
  });

  test("the built web app outside /api", async () => {
    const res = await t.client().fetch("/some/app/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root"></div>');
  });
});
