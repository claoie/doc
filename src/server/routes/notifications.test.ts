import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "server/db";
import { startTestServer, type Client, type TestContext } from "server/test-helpers";

let t: TestContext;
let owner: Client;

beforeAll(async () => {
  t = await startTestServer();
  ({ owner } = await t.setupOwner());
});

afterAll(async () => {
  await t.close();
});

describe("notifications", () => {
  test("pages a user can no longer read are not described", async () => {
    const space = (await owner.post("/spaces", { name: "Team", slug: "team" })).body.data.space;
    const page = (await owner.post("/pages", { spaceId: space.id, title: "Roadmap" })).body.data.page;
    const { client: member, user } = await t.addMember(owner, "watcher@example.com");
    await owner.post(`/spaces/${space.id}/members/add`, { role: "reader", userIds: [user.id] });
    await sql`INSERT INTO notifications (user_id, kind, page_id) VALUES (${user.id}, 'page.updated', ${page.id})`;
    expect((await member.get("/notifications")).body.data[0].page).toMatchObject({ title: "Roadmap" });

    const members = (await owner.get(`/spaces/${space.id}/members`)).body.data as { id: string; user: { id: string } | null }[];
    await owner.post(`/spaces/${space.id}/members/remove`, { memberId: members.find((m) => m.user?.id === user.id)!.id });
    expect((await member.get("/notifications")).body.data[0].page).toBeNull();
  });
});

describe("allowed email domains", () => {
  test("members cannot move their address outside the workspace domains", async () => {
    const { client: member } = await t.addMember(owner, "domain-check@example.com");
    await owner.post("/workspace/update", { emailDomains: ["example.com"] });
    const outside = await member.post("/me/update", { email: "me@elsewhere.org", currentPassword: "member-password" });
    expect(outside.status).toBe(400);
    const inside = await member.post("/me/update", { email: "renamed@example.com", currentPassword: "member-password" });
    expect(inside.status).toBe(200);
    await owner.post("/workspace/update", { emailDomains: [] });
  });
});
