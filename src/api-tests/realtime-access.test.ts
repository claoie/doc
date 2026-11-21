import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, doc, startServer, until, type Client, type Socket, type TestServer } from "./harness";
import { ERRORS, addToSpace, createPage, forget, insertText, join, nextPresence, pushSteps, sendSteps, untilStored, type PageRef } from "./harness/realtime";

/**
 * Access that changes while a page is open: the server re-checks the editors
 * of the pages concerned after every change of membership, role, trash or
 * space, and a socket's subscription to its spaces follows its memberships.
 */

let t: TestServer;
let owner: Client;
let ownerId: string;
const sockets: Socket[] = [];
let counter = 0;

const open = async (client: Client) => {
  const socket = await connect(client);
  sockets.push(socket);
  return socket;
};

const about = (pageId: string) => (m: Record<string, any>) => m.pageId === pageId && m.t !== "presence";

/** A new space of the owner's, and a page in it. */
const spaceWithPage = async () => {
  const n = ++counter;
  const created = await owner.post("/spaces", { name: `Space ${n}`, slug: `space-${n}` });
  const space = created.body.data.space as { id: string; slug: string };
  const page = await createPage(owner, space.id, doc("hello"));
  return { space, page };
};

const member = async (label: string) => {
  const { client, user } = await t.addMember(owner, `${label}-${++counter}@example.com`);
  return { client, id: user.id as string };
};

const group = async (userIds: string[]) => {
  const created = await owner.post("/groups", { name: `Group ${++counter}` });
  const id = created.body.data.group.id as string;
  if (userIds.length) expect((await owner.post(`/groups/${id}/members/add`, { userIds })).status).toBe(200);
  return id;
};

/** Gives a group a role in a space and returns the membership's id. */
const addGroupToSpace = async (spaceId: string, groupId: string, role: string) => {
  expect((await owner.post(`/spaces/${spaceId}/members/add`, { role, groupIds: [groupId] })).status).toBe(200);
  const members = (await owner.get(`/spaces/${spaceId}/members`)).body.data as { id: string; group?: { id: string } }[];
  return members.find((m) => m.group?.id === groupId)!.id;
};

const readOnlyNow = (page: PageRef, version: number, readOnly: boolean) => ({ t: "joined", pageId: page.id, version, readOnly });
const accessLost = (page: PageRef) => ({ t: "error", pageId: page.id, message: ERRORS.accessLost });

/** Whether a batch sent now is taken: resolves with the first answer about the page. */
const tryStep = (socket: Socket, page: PageRef, version: number) => {
  pushSteps(socket, page.id, version, [insertText(1, "x")]);
  return socket.next(about(page.id));
};

beforeAll(async () => {
  t = await startServer();
  const setup = await t.setupOwner();
  owner = setup.owner;
  ownerId = setup.user.id;
});

afterAll(async () => {
  for (const socket of sockets) socket.ws.close();
  await t.close();
});

describe("a member's role in the space changes", () => {
  test("a writer made reader is told the page is read-only, and its steps are refused from then on", async () => {
    const { space, page } = await spaceWithPage();
    const m = await member("demoted");
    const membership = await addToSpace(owner, space.id, m.id, "writer");
    const socket = await open(m.client);
    const other = await open(owner);
    expect(await join(socket, page.id, 0, "m")).toEqual(readOnlyNow(page, 0, false));
    await join(other, page.id, 0, "o");
    await sendSteps(socket, page.id, 0, [insertText(6, "!")], "m");
    await other.nextOf("steps", { version: 1 });

    expect((await owner.post(`/spaces/${space.id}/members/role`, { memberId: membership, role: "reader" })).status).toBe(200);
    // At the page's version, without the document: nothing the client has is out of date.
    expect(await socket.next(about(page.id))).toEqual(readOnlyNow(page, 1, true));
    expect(await tryStep(socket, page, 1)).toEqual({ t: "error", pageId: page.id, message: ERRORS.readOnly });
    // The owner, whose access did not change, hears nothing; the reader still follows along.
    expect(other.inbox.filter(about(page.id))).toEqual([]);
    await sendSteps(other, page.id, 1, [insertText(1, ">")], "o");
    expect(await socket.next(about(page.id))).toEqual({ t: "steps", pageId: page.id, version: 2, steps: [insertText(1, ">")], clientIds: ["o"] });
    // What the demoted writer typed before is saved under their name.
    socket.send({ t: "leave", pageId: page.id });
    other.send({ t: "leave", pageId: page.id });
    const row = await untilStored(t, page.id, 2);
    expect(row.content).toEqual(doc(">hello!"));
    expect([...row.contributor_ids].sort()).toEqual([ownerId, m.id].sort());
  });

  test("a reader made writer or admin is told the page can be edited", async () => {
    const { space, page } = await spaceWithPage();
    const m = await member("promoted");
    const membership = await addToSpace(owner, space.id, m.id, "reader");
    const socket = await open(m.client);
    expect(await join(socket, page.id, 0)).toEqual(readOnlyNow(page, 0, true));

    expect((await owner.post(`/spaces/${space.id}/members/role`, { memberId: membership, role: "writer" })).status).toBe(200);
    expect(await socket.next(about(page.id))).toEqual(readOnlyNow(page, 0, false));
    expect(await tryStep(socket, page, 0)).toMatchObject({ t: "steps", version: 1 });

    // Between writer and admin nothing changes for the page, so nothing is sent.
    expect((await owner.post(`/spaces/${space.id}/members/role`, { memberId: membership, role: "admin" })).status).toBe(200);
    expect(await socket.quiet(about(page.id), 150)).toBe(true);
    expect((await owner.post(`/spaces/${space.id}/members/role`, { memberId: membership, role: "reader" })).status).toBe(200);
    expect(await socket.next(about(page.id))).toEqual(readOnlyNow(page, 1, true));
    expect(await socket.quiet(about(page.id), 150)).toBe(true);

    // Adding someone who is a member already sets their role.
    expect((await owner.post(`/spaces/${space.id}/members/add`, { role: "admin", userIds: [m.id] })).status).toBe(200);
    expect(await socket.next(about(page.id))).toEqual(readOnlyNow(page, 1, false));
  });

  test("every page the member has open is re-checked, on every socket", async () => {
    const { space, page } = await spaceWithPage();
    const second = await createPage(owner, space.id, doc("second"));
    const elsewhere = await spaceWithPage();
    const m = await member("two-pages");
    const membership = await addToSpace(owner, space.id, m.id, "writer");
    await addToSpace(owner, elsewhere.space.id, m.id, "writer");
    const a = await open(m.client);
    const b = await open(m.client);
    await join(a, page.id, 0);
    await join(a, second.id, 0);
    await join(a, elsewhere.page.id, 0);
    await join(b, page.id, 0);

    expect((await owner.post(`/spaces/${space.id}/members/role`, { memberId: membership, role: "reader" })).status).toBe(200);
    expect(await a.next(about(page.id))).toEqual(readOnlyNow(page, 0, true));
    expect(await a.next(about(second.id))).toEqual(readOnlyNow(second, 0, true));
    expect(await b.next(about(page.id))).toEqual(readOnlyNow(page, 0, true));
    // The page in the other space is untouched.
    expect(await tryStep(a, elsewhere.page, 0)).toMatchObject({ t: "steps", version: 1 });
    expect(a.inbox.filter((x) => x.t === "joined")).toEqual([]);
  });
});

describe("a member is removed", () => {
  test("from the space: the page is closed for them", async () => {
    const { space, page } = await spaceWithPage();
    const m = await member("removed");
    const membership = await addToSpace(owner, space.id, m.id, "writer");
    const socket = await open(m.client);
    const other = await open(owner);
    await join(other, page.id, 0, "o");
    await join(socket, page.id, 0, "m");
    await nextPresence(other, page.id, (users) => users.length === 2);
    forget(other);
    await sendSteps(socket, page.id, 0, [insertText(6, "!")], "m");
    await other.nextOf("steps", { version: 1 });

    expect((await owner.post(`/spaces/${space.id}/members/remove`, { memberId: membership })).status).toBe(200);
    expect(await socket.next(about(page.id))).toEqual(accessLost(page));
    // They are off the page: not listed, not sent steps or events, and editing needs a join that is refused.
    const presence = await nextPresence(other, page.id, (users) => users.length === 1);
    expect(presence.users.map((u: any) => u.clientId)).toEqual(["o"]);
    await sendSteps(other, page.id, 1, [insertText(1, ">")], "o");
    expect((await owner.post("/comments", { pageId: page.id, body: doc("a comment") })).status).toBe(200);
    await other.nextOf("event", { kind: "comments" });
    expect(await tryStep(socket, page, 2)).toEqual({ t: "error", pageId: page.id, message: ERRORS.notJoined });
    socket.send({ t: "join", pageId: page.id, version: 1 });
    expect(await socket.next(about(page.id))).toEqual({ t: "error", pageId: page.id, message: ERRORS.noAccess });
    expect(socket.inbox.filter((x) => x.t === "steps" || x.t === "event")).toEqual([]);
    // The socket itself stays open.
    socket.send({ t: "ping" });
    expect(await socket.nextOf("pong")).toEqual({ t: "pong" });
  });

  test("as the last one on the page: what they typed is saved as they are taken off it", async () => {
    const { space, page } = await spaceWithPage();
    const m = await member("removed-last");
    const membership = await addToSpace(owner, space.id, m.id, "writer");
    const socket = await open(m.client);
    await join(socket, page.id, 0, "m");
    await sendSteps(socket, page.id, 0, [insertText(6, "!")], "m");
    expect((await owner.post(`/spaces/${space.id}/members/remove`, { memberId: membership })).status).toBe(200);
    expect(await socket.next(about(page.id))).toEqual(accessLost(page));
    const row = await untilStored(t, page.id, 1, 1500);
    expect(row.content).toEqual(doc("hello!"));
    expect(row.last_editor_id).toBe(m.id);
  });

  test("from the workspace: their sockets are closed", async () => {
    const { space, page } = await spaceWithPage();
    const m = await member("deleted");
    await addToSpace(owner, space.id, m.id, "writer");
    const socket = await open(m.client);
    const other = await open(owner);
    await join(other, page.id, 0, "o");
    await join(socket, page.id, 0, "m");
    await nextPresence(other, page.id, (users) => users.length === 2);
    forget(other);
    expect((await owner.post("/members/delete", { userId: m.id })).status).toBe(200);
    expect(await socket.closed).toEqual({ code: 4001, reason: "signed out" });
    // Their caret is gone from the page.
    expect((await nextPresence(other, page.id)).users.map((u: any) => u.clientId)).toEqual(["o"]);
  });
});

describe("groups", () => {
  test("joining a group that can write makes a reader's open page editable; leaving it makes it read-only again", async () => {
    const { space, page } = await spaceWithPage();
    const m = await member("grouped");
    await addToSpace(owner, space.id, m.id, "reader");
    const writers = await group([]);
    await addGroupToSpace(space.id, writers, "writer");
    const socket = await open(m.client);
    expect(await join(socket, page.id, 0)).toEqual(readOnlyNow(page, 0, true));

    expect((await owner.post(`/groups/${writers}/members/add`, { userIds: [m.id] })).status).toBe(200);
    expect(await socket.next(about(page.id))).toEqual(readOnlyNow(page, 0, false));
    expect((await owner.post(`/groups/${writers}/members/remove`, { userId: m.id })).status).toBe(200);
    expect(await socket.next(about(page.id))).toEqual(readOnlyNow(page, 0, true));
  });

  test("someone whose only way into the space was a group loses the page when they leave the group", async () => {
    const { space, page } = await spaceWithPage();
    const m = await member("group-only");
    const writers = await group([m.id]);
    await addGroupToSpace(space.id, writers, "writer");
    const socket = await open(m.client);
    expect(await join(socket, page.id, 0)).toEqual(readOnlyNow(page, 0, false));
    expect((await owner.post(`/groups/${writers}/members/remove`, { userId: m.id })).status).toBe(200);
    expect(await socket.next(about(page.id))).toEqual(accessLost(page));
  });

  test("a group's role in the space changing, or the group leaving the space, reaches each of its members", async () => {
    const { space, page } = await spaceWithPage();
    const first = await member("group-a");
    const second = await member("group-b");
    await addToSpace(owner, space.id, second.id, "reader");
    const team = await group([first.id, second.id]);
    const a = await open(first.client);
    const b = await open(second.client);
    expect(await join(b, page.id, 0)).toEqual(readOnlyNow(page, 0, true));

    // The group is given the space: the member who could only read can now write.
    const membership = await addGroupToSpace(space.id, team, "writer");
    expect(await b.next(about(page.id))).toEqual(readOnlyNow(page, 0, false));
    expect(await join(a, page.id, 0)).toEqual(readOnlyNow(page, 0, false));

    expect((await owner.post(`/spaces/${space.id}/members/role`, { memberId: membership, role: "reader" })).status).toBe(200);
    expect(await a.next(about(page.id))).toEqual(readOnlyNow(page, 0, true));
    expect(await b.next(about(page.id))).toEqual(readOnlyNow(page, 0, true));

    expect((await owner.post(`/spaces/${space.id}/members/remove`, { memberId: membership })).status).toBe(200);
    expect(await a.next(about(page.id))).toEqual(accessLost(page));
    // The second member is still a reader on their own.
    expect(await b.quiet(about(page.id), 150)).toBe(true);
  });

  test("deleting a group takes away what it gave", async () => {
    const { space, page } = await spaceWithPage();
    const first = await member("group-deleted-a");
    const second = await member("group-deleted-b");
    await addToSpace(owner, space.id, second.id, "reader");
    const team = await group([first.id, second.id]);
    await addGroupToSpace(space.id, team, "admin");
    const a = await open(first.client);
    const b = await open(second.client);
    expect(await join(a, page.id, 0)).toEqual(readOnlyNow(page, 0, false));
    expect(await join(b, page.id, 0)).toEqual(readOnlyNow(page, 0, false));
    expect((await owner.post(`/groups/${team}/delete`)).status).toBe(200);
    expect(await a.next(about(page.id))).toEqual(accessLost(page));
    expect(await b.next(about(page.id))).toEqual(readOnlyNow(page, 0, true));
  });
});

describe("the page itself changes", () => {
  test("in the trash it is read-only for everyone; restored, it can be edited again", async () => {
    const { space, page } = await spaceWithPage();
    const child = await createPage(owner, space.id, doc("child"), { parentId: page.id });
    const sibling = await createPage(owner, space.id, doc("sibling"));
    const w = await member("trash-writer");
    const r = await member("trash-reader");
    await addToSpace(owner, space.id, w.id, "writer");
    await addToSpace(owner, space.id, r.id, "reader");
    const a = await open(owner);
    const b = await open(w.client);
    const c = await open(r.client);
    await join(a, page.id, 0, "a");
    await join(b, page.id, 0, "b");
    await join(b, child.id, 0, "b");
    await join(b, sibling.id, 0, "b");
    await join(c, page.id, 0, "c");
    await sendSteps(b, page.id, 0, [insertText(6, "!")], "b");
    await a.nextOf("steps", { version: 1 });
    await c.nextOf("steps", { version: 1 });

    expect((await w.client.post(`/pages/${page.id}/delete`)).status).toBe(200);
    expect(await a.next(about(page.id))).toEqual(readOnlyNow(page, 1, true));
    expect(await b.next(about(page.id))).toEqual(readOnlyNow(page, 1, true));
    // Its child went to the trash with it.
    expect(await b.next(about(child.id))).toEqual(readOnlyNow(child, 0, true));
    expect(await tryStep(a, page, 1)).toEqual({ t: "error", pageId: page.id, message: ERRORS.readOnly });
    expect(await tryStep(b, child, 0)).toEqual({ t: "error", pageId: child.id, message: ERRORS.readOnly });
    // The sibling is not in the trash; the reader's view of the page did not change.
    expect(await tryStep(b, sibling, 0)).toMatchObject({ t: "steps", version: 1 });
    expect(c.inbox.filter(about(page.id))).toEqual([]);

    expect((await owner.post(`/pages/${page.id}/restore`)).status).toBe(200);
    expect(await a.next(about(page.id))).toEqual(readOnlyNow(page, 1, false));
    expect(await b.next(about(page.id))).toEqual(readOnlyNow(page, 1, false));
    expect(await b.next(about(child.id))).toEqual(readOnlyNow(child, 0, false));
    expect(await tryStep(b, page, 1)).toMatchObject({ t: "steps", version: 2 });
    expect(await c.next(about(page.id))).toMatchObject({ t: "steps", version: 2 });
    expect(c.inbox.filter((x) => x.t === "joined")).toEqual([]);
  });

  test("moved to another space, each editor keeps what that space gives them", async () => {
    const { space, page } = await spaceWithPage();
    const child = await createPage(owner, space.id, doc("child"), { parentId: page.id });
    const target = await spaceWithPage();
    const stays = await member("move-writer");
    const reads = await member("move-reader");
    const loses = await member("move-outsider");
    for (const m of [stays, reads, loses]) await addToSpace(owner, space.id, m.id, "writer");
    await addToSpace(owner, target.space.id, stays.id, "writer");
    await addToSpace(owner, target.space.id, reads.id, "reader");
    const a = await open(stays.client);
    const b = await open(reads.client);
    const c = await open(loses.client);
    for (const socket of [a, b, c]) expect(await join(socket, page.id, 0)).toEqual(readOnlyNow(page, 0, false));
    expect(await join(c, child.id, 0)).toEqual(readOnlyNow(child, 0, false));

    const moved = await owner.post(`/pages/${page.id}/move-to-space`, { spaceId: target.space.id });
    expect(moved.status).toBe(200);
    expect(await b.next(about(page.id))).toEqual(readOnlyNow(page, 0, true));
    expect(await c.next(about(page.id))).toEqual(accessLost(page));
    expect(await c.next(about(child.id))).toEqual(accessLost(child));
    expect(await tryStep(a, page, 0)).toMatchObject({ t: "steps", version: 1 });
    expect(a.inbox.filter((x) => x.t === "joined" || x.t === "error")).toEqual([]);
  });

  test("deleted for good, it is closed for everyone who had it or a page under it open", async () => {
    const { space, page } = await spaceWithPage();
    const child = await createPage(owner, space.id, doc("child"), { parentId: page.id });
    const m = await member("deleted-page");
    await addToSpace(owner, space.id, m.id, "reader");
    const a = await open(owner);
    const b = await open(m.client);
    await join(a, page.id, 0);
    await join(a, child.id, 0);
    await join(b, child.id, 0);
    expect((await owner.post(`/pages/${page.id}/delete-permanently`)).status).toBe(200);
    expect(await a.next(about(page.id))).toEqual(accessLost(page));
    expect(await a.next(about(child.id))).toEqual(accessLost(child));
    expect(await b.next(about(child.id))).toEqual(accessLost(child));
    expect(await tryStep(a, page, 0)).toEqual({ t: "error", pageId: page.id, message: ERRORS.notJoined });
  });

  test("its space deleted, it is closed for the members of the space", async () => {
    const { space, page } = await spaceWithPage();
    const m = await member("deleted-space");
    await addToSpace(owner, space.id, m.id, "writer");
    const a = await open(owner);
    const b = await open(m.client);
    await join(a, page.id, 0);
    await join(b, page.id, 0);
    expect((await owner.post(`/spaces/${space.id}/delete`)).status).toBe(200);
    expect(await a.next(about(page.id))).toEqual(accessLost(page));
    expect(await b.next(about(page.id))).toEqual(accessLost(page));
  });
});

describe("the spaces a socket hears about", () => {
  /** Creates pages in the space until the socket is, or is no longer, told about them. */
  const hears = async (socket: Socket, spaceId: string, expected: boolean) => {
    await until(
      async () => {
        expect((await owner.post("/pages", { spaceId, title: "Tree" })).status).toBe(200);
        const quiet = await socket.quiet((m) => m.t === "event" && m.kind === "tree" && m.spaceId === spaceId, 150);
        return quiet !== expected;
      },
      5000,
      expected ? "tree events to arrive" : "tree events to stop",
    );
  };

  test("are the ones the user is a member of when it opens", async () => {
    const mine = await spaceWithPage();
    const other = await spaceWithPage();
    const m = await member("subscribed");
    await addToSpace(owner, mine.space.id, m.id, "reader");
    const socket = await open(m.client);
    const ownerSocket = await open(owner);
    expect((await owner.post("/pages", { spaceId: other.space.id, title: "Elsewhere" })).status).toBe(200);
    expect((await owner.post("/pages", { spaceId: mine.space.id, title: "Here" })).status).toBe(200);
    // Only tree events are looked at: the owner's socket may still be told of the member who just joined.
    expect(await socket.nextOf("event", { kind: "tree" })).toEqual({ t: "event", kind: "tree", spaceId: mine.space.id });
    expect(await ownerSocket.nextOf("event", { kind: "tree" })).toEqual({ t: "event", kind: "tree", spaceId: other.space.id });
    expect(await ownerSocket.nextOf("event", { kind: "tree" })).toEqual({ t: "event", kind: "tree", spaceId: mine.space.id });
    expect(await socket.quiet((m) => m.kind === "tree", 100)).toBe(true);
  });

  test("a space the user is added to is heard from then on, and one they are removed from no longer", async () => {
    const { space } = await spaceWithPage();
    const m = await member("subscription-follows");
    const socket = await open(m.client);
    expect((await owner.post("/pages", { spaceId: space.id, title: "Before" })).status).toBe(200);
    const membership = await addToSpace(owner, space.id, m.id, "reader");
    await hears(socket, space.id, true);
    expect((await owner.post(`/spaces/${space.id}/members/remove`, { memberId: membership })).status).toBe(200);
    await hears(socket, space.id, false);
    expect((await owner.post("/pages", { spaceId: space.id, title: "After" })).status).toBe(200);
    expect(await socket.quiet((x) => x.kind === "tree", 150)).toBe(true);
  });

  test("group memberships count: joining and leaving a group changes what is heard", async () => {
    const { space } = await spaceWithPage();
    const m = await member("group-subscription");
    const team = await group([]);
    await addGroupToSpace(space.id, team, "reader");
    const socket = await open(m.client);
    expect((await owner.post(`/groups/${team}/members/add`, { userIds: [m.id] })).status).toBe(200);
    await hears(socket, space.id, true);
    expect((await owner.post(`/groups/${team}/members/remove`, { userId: m.id })).status).toBe(200);
    await hears(socket, space.id, false);
    expect((await owner.post("/pages", { spaceId: space.id, title: "After" })).status).toBe(200);
    expect(await socket.quiet((x) => x.kind === "tree", 150)).toBe(true);
  });

  test("a space the user creates is heard on the sockets they have open", async () => {
    const m = await member("space-creator");
    await t.sql`UPDATE users SET role = 'admin' WHERE id = ${m.id}`;
    const socket = await open(m.client);
    const created = await m.client.post("/spaces", { name: "Made here", slug: `made-here-${++counter}` });
    expect(created.status).toBe(200);
    const spaceId = created.body.data.space.id as string;
    await until(async () => {
      expect((await m.client.post("/pages", { spaceId, title: "Tree" })).status).toBe(200);
      return !(await socket.quiet((x) => x.kind === "tree" && x.spaceId === spaceId, 150));
    });
  });
});
