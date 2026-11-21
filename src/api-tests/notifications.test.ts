import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { doc, startServer, until, type Client, type TestServer } from "./harness";
import {
  NO_SUCH_ID,
  anyId,
  anyTime,
  createPage,
  createSpace,
  data,
  docOf,
  expectInvalid,
  expectUnauthorized,
  memberRow,
  paragraph,
  person,
  text,
  userRef,
  type Person,
} from "./harness/spaces-pages";
import { openSocket, takeEvents } from "./harness/spaces-pages-ws";

let t: TestServer;
let owner: Client;
let ownerUser: any;
let team: any;
let alice: Person;
let bob: Person;
/** A reader of the space. */
let carol: Person;
/** A member of the workspace with no access to the space. */
let dave: Person;
/** Reads the space through a group only. */
let gina: Person;
/** Was a reader of the space, then deactivated. */
let sleepy: Person;

const mention = (user: { id: string; name: string }) => ({ type: "mention", attrs: { entityType: "user", entityId: user.id, label: user.name } });
const say = async (who: Person | Client, pageId: string, body: unknown, parentId?: string) =>
  data(await ("client" in who ? who.client : who).post("/comments", { pageId, body: typeof body === "string" ? doc(body) : body, ...(parentId ? { parentId } : {}) })).comment;

const inbox = async (who: Person | Client, query = "") => data(await ("client" in who ? who.client : who).get(`/notifications${query}`)) as any[];
/** The user's notifications about one page, oldest first. */
const about = async (who: Person | Client, page: any) => (await inbox(who, "?limit=100")).filter((n) => n.page?.id === page.id).reverse();
/**
 * Notifications are written after the answer to the request that causes them. Waits until `who` holds `count` about
 * the page: `who` must be notified by the last step of the action (watchers of a new comment, participants of a
 * thread on a reply), so everything the action sends has been written by then.
 */
const arrived = (who: Person | Client, page: any, count: number) =>
  until(async () => {
    const list = await about(who, page);
    return list.length >= count ? list : null;
  });

const pageRef = (page: any) => ({ id: page.id, slugId: page.slugId, title: page.title, icon: page.icon, spaceId: page.spaceId, spaceSlug: "team" });
const notification = (kind: string, actor: any, page: any, comment: any) => ({
  id: anyId(),
  kind,
  actor: userRef(actor),
  page: pageRef(page),
  comment: { id: comment.id, parentId: comment.parentId },
  data: {},
  createdAt: anyTime(),
  readAt: null,
});

/** Mails about a page, found by its title in the subject. */
const mailsAbout = (title: string) => t.outbox.filter((mail) => mail.subject.endsWith(title));
const mailed = (title: string, count: number) => until(() => (mailsAbout(title).length >= count ? mailsAbout(title) : null));
const emailedAt = async (pageId: string) =>
  Object.fromEntries((await t.sql`SELECT u.name, n.kind, n.emailed_at FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.page_id = ${pageId}`).map((r: any) => [`${r.name}:${r.kind}`, r.emailed_at !== null]));

const html = (paragraphs: string[], url: string) =>
  `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#222;line-height:1.5"><div style="max-width:560px;margin:0 auto;padding:24px">${paragraphs
    .map((p) => `<p style="margin:0 0 16px">${p}</p>`)
    .join("")}<p style="margin:24px 0"><a href="${url}" style="background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open page</a></p><p style="color:#666;font-size:12px">${url}</p></div></body></html>`;

beforeAll(async () => {
  t = await startServer();
  ({ owner, user: ownerUser } = await t.setupOwner());
  team = await createSpace(owner, "Team", "team");
  alice = await person(t, owner, "alice@example.com", { space: team.id, spaceRole: "writer" });
  bob = await person(t, owner, "bob@example.com", { space: team.id, spaceRole: "writer" });
  carol = await person(t, owner, "carol@example.com", { space: team.id, spaceRole: "reader" });
  dave = await person(t, owner, "dave@example.com");
  gina = await person(t, owner, "gina@example.com");
  const guild = data(await owner.post("/groups", { name: "Guild" })).group;
  data(await owner.post(`/groups/${guild.id}/members/add`, { userIds: [gina.id] }));
  data(await owner.post(`/spaces/${team.id}/members/add`, { role: "reader", groupIds: [guild.id] }));
  sleepy = await person(t, owner, "sleepy@example.com", { space: team.id, spaceRole: "reader" });
});

afterAll(async () => {
  await t.close();
});

describe("without a session", () => {
  test("every notification endpoint answers 401", async () => {
    const anonymous = t.client();
    for (const path of ["/notifications", "/notifications/unread-count"]) expectUnauthorized(await anonymous.get(path));
    for (const path of ["/notifications/read", "/notifications/read-all"]) expectUnauthorized(await anonymous.post(path, { ids: [] }));
  });
});

describe("a new comment", () => {
  test("notifies the watchers of the page, by notification, socket event and email", async () => {
    const page = await createPage(alice.client, { spaceId: team.id, title: "Launch plan", icon: "🚀" });
    data(await carol.client.post(`/pages/${page.id}/watch`, { watching: true }));
    data(await sleepy.client.post(`/pages/${page.id}/watch`, { watching: true }));
    data(await owner.post("/members/deactivate", { userId: sleepy.id }));
    // Someone who watched and then lost the space.
    const ex = await person(t, owner, "ex@example.com", { space: team.id, spaceRole: "reader" });
    data(await ex.client.post(`/pages/${page.id}/watch`, { watching: true }));
    data(await owner.post(`/spaces/${team.id}/members/remove`, { memberId: await memberRow(owner, team.id, ex.id) }));
    // Watching the space is not watching its pages' comments.
    data(await gina.client.post(`/spaces/${team.id}/watch`, { watching: true }));
    const sockets = { alice: await openSocket(alice.client), bob: await openSocket(bob.client), gina: await openSocket(gina.client) };

    const comment = await say(bob, page.id, docOf(paragraph(text("Looks good to me.")), paragraph(text("Ship it!"))));
    const forAlice = await arrived(alice, page, 1);
    expect(forAlice).toEqual([notification("comment.created", bob.user, page, comment)]);
    expect(await about(carol, page)).toEqual([notification("comment.created", bob.user, page, comment)]);
    // Not the author of the comment, nor those who cannot read the page, are deactivated, or only watch the space.
    for (const who of [bob, ex, gina, dave, owner]) expect(await about(who, page)).toEqual([]);
    const rows = await t.sql`SELECT u.name FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.page_id = ${page.id} ORDER BY u.name`;
    expect(rows.map((r: any) => r.name)).toEqual(["alice", "carol"]);

    expect(await takeEvents(sockets.alice)).toEqual([{ t: "event", kind: "notification" }]);
    expect(await takeEvents(sockets.bob)).toEqual([]);
    expect(await takeEvents(sockets.gina)).toEqual([]);
    await Promise.all(Object.values(sockets).map((socket) => socket.close()));

    const url = `http://doc.test/s/team/p/launch-plan-${page.slugId}`;
    const mails = (await mailed("Launch plan", 2)).sort((a, b) => a.to.localeCompare(b.to));
    expect(mails.map((mail) => ({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html }))).toEqual(
      ["alice@example.com", "carol@example.com"].map((to) => ({
        from: "docs@doc.test",
        to,
        subject: "bob commented on Launch plan",
        text: `bob commented on Launch plan.\n\nLooks good to me.\nShip it!\n\nOpen page: ${url}`,
        html: html(["bob commented on Launch plan.", "Looks good to me.\nShip it!"], url),
      })),
    );
    expect(await emailedAt(page.id)).toEqual({ "alice:comment.created": true, "carol:comment.created": true });
    expect(data(await alice.client.get("/notifications/unread-count")).count).toBeGreaterThanOrEqual(1);
    data(await owner.post("/members/activate", { userId: sleepy.id }));
  });

  test("notifies the people it mentions as mentioned, and not a second time as watchers", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Mentions" });
    data(await alice.client.post(`/pages/${page.id}/watch`, { watching: true }));
    data(await owner.post("/members/deactivate", { userId: sleepy.id }));
    const comment = await say(
      bob,
      page.id,
      docOf(
        paragraph(text("cc "), mention(alice.user), mention(carol.user), mention(gina.user), mention(dave.user), mention(sleepy.user), mention(bob.user), mention(alice.user)),
        paragraph({ type: "mention", attrs: { entityType: "user", entityId: "not-an-id", label: "nobody" } }, { type: "mention", attrs: { entityType: "user", entityId: NO_SUCH_ID, label: "ghost" } }),
        paragraph({ type: "mention", attrs: { entityType: "page", entityId: ownerUser.id, label: "a page mention" } }, { type: "mention", attrs: { entityType: "user", entityId: 7 } }),
      ),
    );
    // The owner watches the page and is not mentioned.
    expect(await arrived(owner, page, 1)).toEqual([notification("comment.created", bob.user, page, comment)]);
    for (const who of [alice, carol, gina]) expect(await about(who, page)).toEqual([notification("comment.mention", bob.user, page, comment)]);
    for (const who of [bob, dave]) expect(await about(who, page)).toEqual([]);
    const rows = await t.sql`SELECT u.name, n.kind, n.comment_id, n.actor_id, n.data FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.page_id = ${page.id} ORDER BY u.name`;
    expect(rows).toEqual([
      { name: "Owner", kind: "comment.created", comment_id: comment.id, actor_id: bob.id, data: {} },
      { name: "alice", kind: "comment.mention", comment_id: comment.id, actor_id: bob.id, data: {} },
      { name: "carol", kind: "comment.mention", comment_id: comment.id, actor_id: bob.id, data: {} },
      { name: "gina", kind: "comment.mention", comment_id: comment.id, actor_id: bob.id, data: {} },
    ]);
    const mails = await mailed("Mentions", 4);
    expect(mails.map((mail) => [mail.to, mail.subject]).sort()).toEqual([
      ["alice@example.com", "bob mentioned you in a comment on Mentions"],
      ["carol@example.com", "bob mentioned you in a comment on Mentions"],
      ["gina@example.com", "bob mentioned you in a comment on Mentions"],
      ["owner@example.com", "bob commented on Mentions"],
    ]);
    const url = `http://doc.test/s/team/p/mentions-${page.slugId}`;
    expect(mails.find((mail) => mail.to === "gina@example.com")!.text).toBe(`bob mentioned you in a comment on Mentions.\n\ncc alicecarolginadavesleepybobalice\nnobodyghost\na page mention\n\nOpen page: ${url}`);
    data(await owner.post("/members/activate", { userId: sleepy.id }));
  });
});

describe("a reply", () => {
  test("notifies everyone who wrote in the thread, not the watchers of the page", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Threads" });
    const top = await say(alice, page.id, "What do you think?");
    expect(await arrived(owner, page, 1)).toEqual([notification("comment.created", alice.user, page, top)]);

    const first = await say(bob, page.id, "I agree", top.id);
    expect(await arrived(alice, page, 1)).toEqual([notification("comment.reply", bob.user, page, first)]);
    expect(first.parentId).toBe(top.id);
    // The owner watches the page but wrote nothing in the thread.
    expect(await about(owner, page)).toHaveLength(1);
    expect(await about(bob, page)).toEqual([]);

    const second = await say(alice, page.id, "Good", first.id);
    expect(await arrived(bob, page, 1)).toEqual([notification("comment.reply", alice.user, page, second)]);
    expect(await about(alice, page)).toHaveLength(1);

    const third = await say(owner, page.id, "Late to this", top.id);
    expect(await arrived(alice, page, 2)).toEqual([notification("comment.reply", bob.user, page, first), notification("comment.reply", ownerUser, page, third)]);
    expect(await about(bob, page)).toEqual([notification("comment.reply", alice.user, page, second), notification("comment.reply", ownerUser, page, third)]);
    expect(await about(owner, page)).toHaveLength(1);

    const mails = await mailed("Threads", 5);
    // Mail leaves in the order the notifications were made; the last two went out together.
    expect(mails.slice(0, 3).map((mail) => [mail.to, mail.subject])).toEqual([
      ["owner@example.com", "alice commented on Threads"],
      ["alice@example.com", "bob replied to a comment on Threads"],
      ["bob@example.com", "alice replied to a comment on Threads"],
    ]);
    expect(mails.slice(3).map((mail) => [mail.to, mail.subject]).sort()).toEqual([
      ["alice@example.com", "Owner replied to a comment on Threads"],
      ["bob@example.com", "Owner replied to a comment on Threads"],
    ]);
    expect(mails[1]!.text).toBe(`bob replied to a comment on Threads.\n\nI agree\n\nOpen page: http://doc.test/s/team/p/threads-${page.slugId}`);
  });

  test("someone mentioned in a reply is told once, as mentioned", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Thread mentions" });
    const top = await say(bob, page.id, "Opening");
    const one = await say(owner, page.id, "Owner joins", top.id);
    expect(await arrived(bob, page, 1)).toEqual([notification("comment.reply", ownerUser, page, one)]);
    // Bob wrote in the thread and is mentioned; carol is mentioned without having written.
    const two = await say(alice, page.id, docOf(paragraph(text("ping "), mention(bob.user), mention(carol.user))), top.id);
    expect(await arrived(owner, page, 2)).toEqual([notification("comment.created", bob.user, page, top), notification("comment.reply", alice.user, page, two)]);
    expect(await about(bob, page)).toEqual([notification("comment.reply", ownerUser, page, one), notification("comment.mention", alice.user, page, two)]);
    expect(await about(carol, page)).toEqual([notification("comment.mention", alice.user, page, two)]);
    expect(await about(alice, page)).toEqual([]);
  });
});

describe("editing, resolving and deleting comments", () => {
  test("notify nobody; deleting a comment takes its notifications away", async () => {
    const page = await createPage(owner, { spaceId: team.id, title: "Quiet changes" });
    const first = await say(alice, page.id, "First");
    expect(await arrived(owner, page, 1)).toHaveLength(1);
    data(await alice.client.post(`/comments/${first.id}/update`, { body: docOf(paragraph(text("Now with "), mention(carol.user), mention(bob.user))) }));
    data(await bob.client.post(`/comments/${first.id}/resolve`, { resolved: true }));
    data(await bob.client.post(`/comments/${first.id}/resolve`, { resolved: false }));
    // A second comment marks the moment: whatever the edit or the resolving sent would be there before it.
    const second = await say(alice, page.id, "Second");
    expect(await arrived(owner, page, 2)).toEqual([notification("comment.created", alice.user, page, first), notification("comment.created", alice.user, page, second)]);
    for (const who of [carol, bob, alice]) expect(await about(who, page)).toEqual([]);
    expect((await mailed("Quiet changes", 2)).map((mail) => mail.to)).toEqual(["owner@example.com", "owner@example.com"]);
    data(await alice.client.post(`/comments/${first.id}/delete`));
    expect(await about(owner, page)).toEqual([notification("comment.created", alice.user, page, second)]);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM notifications WHERE page_id = ${page.id}`;
    expect(n).toBe(1);
  });
});

describe("notification emails", () => {
  test("each kind has a switch in the recipient's preferences that stops the email, not the notification", async () => {
    const title = "Preferences";
    const noComments = await person(t, owner, "no-comments@example.com", { space: team.id, spaceRole: "writer" });
    const noMentions = await person(t, owner, "no-mentions@example.com", { space: team.id, spaceRole: "writer" });
    const explicit = await person(t, owner, "explicit@example.com", { space: team.id, spaceRole: "writer" });
    data(await noComments.client.post("/me/update", { preferences: { notifyComments: false } }));
    data(await noMentions.client.post("/me/update", { preferences: { notifyCommentMentions: false, notifyPageUpdates: false, notifyPageMentions: false } }));
    data(await explicit.client.post("/me/update", { preferences: { notifyComments: true, notifyCommentMentions: true } }));
    const page = await createPage(owner, { spaceId: team.id, title });
    for (const who of [noComments, noMentions, explicit]) data(await who.client.post(`/pages/${page.id}/watch`, { watching: true }));

    // A comment that mentions one of them: three watchers and one mention.
    const first = await say(bob, page.id, docOf(paragraph(text("hello "), mention(noMentions.user))));
    await arrived(owner, page, 1);
    await until(async () => (await emailedAt(page.id))["Owner:comment.created"]);
    expect(await emailedAt(page.id)).toEqual({
      "Owner:comment.created": true,
      "explicit:comment.created": true,
      "no-comments:comment.created": false,
      "no-mentions:comment.mention": false,
    });
    await mailed(title, 2);
    await t.smtp.settle();
    expect(mailsAbout(title).map((mail) => [mail.to, mail.subject]).sort()).toEqual([
      ["explicit@example.com", "bob commented on Preferences"],
      ["owner@example.com", "bob commented on Preferences"],
    ]);
    expect(await about(noComments, page)).toEqual([notification("comment.created", bob.user, page, first)]);
    expect(await about(noMentions, page)).toEqual([notification("comment.mention", bob.user, page, first)]);

    // The switches are per kind: mentions still reach the one who turned comments off, and the other way round.
    const second = await say(bob, page.id, docOf(paragraph(text("and "), mention(noComments.user))));
    await arrived(owner, page, 2);
    await mailed(title, 6);
    // A reply to a thread they wrote in falls under the comments switch.
    const theirs = await say(noComments, page.id, "my thread");
    await arrived(owner, page, 3);
    const reply = await say(bob, page.id, "a reply", theirs.id);
    await arrived(noComments, page, 3);
    await until(async () => "no-comments:comment.reply" in (await emailedAt(page.id)));
    await mailed(title, 10);
    await t.smtp.settle();
    expect(mailsAbout(title).slice(2).map((mail) => [mail.to, mail.subject]).sort()).toEqual([
      // By commenting, bob came to watch the page.
      ["bob@example.com", "no-comments commented on Preferences"],
      ["explicit@example.com", "bob commented on Preferences"],
      ["explicit@example.com", "no-comments commented on Preferences"],
      ["no-comments@example.com", "bob mentioned you in a comment on Preferences"],
      ["no-mentions@example.com", "bob commented on Preferences"],
      ["no-mentions@example.com", "no-comments commented on Preferences"],
      ["owner@example.com", "bob commented on Preferences"],
      ["owner@example.com", "no-comments commented on Preferences"],
    ]);
    expect(await about(noComments, page)).toEqual([
      notification("comment.created", bob.user, page, first),
      notification("comment.mention", bob.user, page, second),
      notification("comment.reply", bob.user, page, reply),
    ]);
    const stamps = await t.sql`SELECT kind, emailed_at IS NOT NULL AS emailed FROM notifications WHERE user_id = ${noComments.id} AND page_id = ${page.id} ORDER BY created_at`;
    expect(stamps).toEqual([
      { kind: "comment.created", emailed: false },
      { kind: "comment.mention", emailed: true },
      { kind: "comment.reply", emailed: false },
    ]);
  });

  test("carry the first 300 characters of the comment, escaped in the HTML part", async () => {
    const title = "Excerpts";
    const page = await createPage(alice.client, { spaceId: team.id, title });
    const long = `<b>Tom & "Jerry"</b> ${"é".repeat(400)}`;
    await say(bob, page.id, docOf(paragraph(text(long)), paragraph(text("never reached"))));
    const url = `http://doc.test/s/team/p/excerpts-${page.slugId}`;
    const [mail] = await mailed(title, 1);
    const excerpt = `<b>Tom & "Jerry"</b> ${"é".repeat(279)}`;
    expect(excerpt).toHaveLength(300);
    expect(mail!.text).toBe(`bob commented on Excerpts.\n\n${excerpt}\n\nOpen page: ${url}`);
    expect(mail!.html).toBe(html(["bob commented on Excerpts.", `&lt;b&gt;Tom &amp; &quot;Jerry&quot;&lt;/b&gt; ${"é".repeat(279)}`], url));
    // The cut counts UTF-16 units and falls after a line break here.
    await say(bob, page.id, docOf(paragraph(text("a".repeat(298))), paragraph(text("second line"))));
    const [, second] = await mailed(title, 2);
    expect(second!.text).toBe(`bob commented on Excerpts.\n\n${"a".repeat(298)}\ns\n\nOpen page: ${url}`);
    // Accident: a cut inside an emoji leaves half of it, which reaches the mail as U+FFFD.
    await say(bob, page.id, `${"b".repeat(299)}😀 tail`);
    const [, , third] = await mailed(title, 3);
    expect(third!.text).toBe(`bob commented on Excerpts.\n\n${"b".repeat(299)}�\n\nOpen page: ${url}`);
  });

  test("name the page by its title, and link to it by a slug made from the title", async () => {
    const cases: [string | null, string, string][] = [
      [null, "Untitled", "untitled"],
      ["Crème Brûlée & Co.", "Crème Brûlée & Co.", "creme-brulee-co"],
      ["Q3 Plan/Review_v2 (FINAL)", "Q3 Plan/Review_v2 (FINAL)", "q3-plan-review-v2-final"],
      ["회의록 정리", "회의록 정리", encodeURIComponent("회의록-정리")],
      ["日本語のタイトル", "日本語のタイトル", encodeURIComponent("日本語のタイトル")],
      ["🎉🎉", "🎉🎉", "untitled"],
      ["ﬁne ½ Ⅷ", "ﬁne ½ Ⅷ", "fine-1-2-viii"],
      [`${"word ".repeat(20)}end`, `${"word ".repeat(20)}end`, "word-".repeat(12)],
    ];
    for (const [title, shown, slug] of cases) {
      const page = await createPage(alice.client, { spaceId: team.id, title });
      await say(bob, page.id, "titled");
      const mail = (await until(() => t.outbox.find((m) => m.text.endsWith(`-${page.slugId}`))))!;
      expect([mail.to, mail.subject]).toEqual(["alice@example.com", `bob commented on ${shown}`]);
      expect(mail.text).toBe(`bob commented on ${shown}.\n\ntitled\n\nOpen page: http://doc.test/s/team/p/${slug}-${page.slugId}`);
    }
  });
});

describe("GET /notifications", () => {
  let lister: Person;
  let page: any;
  let comment: any;
  let reply: any;
  let hiddenPage: any;
  let trashedPage: any;
  const insert = async (row: { kind: string; actorId?: string | null; pageId?: string | null; commentId?: string | null; data?: unknown; at: string; readAt?: string | null }) => {
    const [created] = await t.sql`
      INSERT INTO notifications (user_id, kind, actor_id, page_id, comment_id, data, created_at, read_at)
      VALUES (${lister.id}, ${row.kind}, ${row.actorId ?? null}, ${row.pageId ?? null}, ${row.commentId ?? null}, ${row.data ?? {}}::jsonb,
        ${row.at}::timestamptz, ${row.readAt ?? null}::timestamptz)
      RETURNING id`;
    return created.id as string;
  };
  let ids: Record<string, string>;

  beforeAll(async () => {
    // Page mentions and page updates are produced when content is saved through the realtime path; their rows,
    // like the others here, are arranged directly so that every field has a known value.
    lister = await person(t, owner, "lister@example.com", { space: team.id, spaceRole: "reader" });
    const hidden = await createSpace(owner, "Hidden", "hidden");
    page = await createPage(owner, { spaceId: team.id, title: "Listed", icon: "📋" });
    hiddenPage = await createPage(owner, { spaceId: hidden.id, title: "Out of sight" });
    trashedPage = await createPage(owner, { spaceId: team.id, title: "Thrown away" });
    comment = await say(owner, page.id, "top");
    reply = await say(owner, page.id, "reply", comment.id);
    const trashedComment = await say(owner, trashedPage.id, "on a page that will be trashed");
    data(await owner.post(`/pages/${trashedPage.id}/delete`));
    ids = {
      updated: await insert({ kind: "page.updated", pageId: page.id, at: "2025-06-01T10:00:00.123456Z", readAt: "2025-06-02T08:30:00.987654Z" }),
      mention: await insert({ kind: "page.mention", actorId: alice.id, pageId: page.id, data: { anchor: "h-1", n: 2 }, at: "2025-06-02T10:00:00Z" }),
      created: await insert({ kind: "comment.created", actorId: bob.id, pageId: page.id, commentId: comment.id, at: "2025-06-03T10:00:00Z" }),
      reply: await insert({ kind: "comment.reply", actorId: bob.id, pageId: page.id, commentId: reply.id, at: "2025-06-04T10:00:00Z", readAt: "2025-06-05T00:00:00Z" }),
      hidden: await insert({ kind: "page.updated", actorId: bob.id, pageId: hiddenPage.id, at: "2025-06-05T10:00:00Z" }),
      trashed: await insert({ kind: "comment.mention", actorId: bob.id, pageId: trashedPage.id, commentId: trashedComment.id, at: "2025-06-06T10:00:00Z" }),
      pageless: await insert({ kind: "something.else", at: "2025-06-07T10:00:00Z" }),
    };
  });

  test("lists the user's notifications, latest first, with what they are about", async () => {
    const res = await lister.client.get("/notifications");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        // The kind is passed through as stored.
        { id: ids.pageless, kind: "something.else", actor: null, page: null, comment: null, data: {}, createdAt: "2025-06-07T10:00:00.000Z", readAt: null },
        // A page in the trash, or in a space the user cannot read, is not described; nor is its comment.
        { id: ids.trashed, kind: "comment.mention", actor: userRef(bob.user), page: null, comment: null, data: {}, createdAt: "2025-06-06T10:00:00.000Z", readAt: null },
        { id: ids.hidden, kind: "page.updated", actor: userRef(bob.user), page: null, comment: null, data: {}, createdAt: "2025-06-05T10:00:00.000Z", readAt: null },
        { id: ids.reply, kind: "comment.reply", actor: userRef(bob.user), page: pageRef(page), comment: { id: reply.id, parentId: comment.id }, data: {}, createdAt: "2025-06-04T10:00:00.000Z", readAt: "2025-06-05T00:00:00.000Z" },
        { id: ids.created, kind: "comment.created", actor: userRef(bob.user), page: pageRef(page), comment: { id: comment.id, parentId: null }, data: {}, createdAt: "2025-06-03T10:00:00.000Z", readAt: null },
        { id: ids.mention, kind: "page.mention", actor: userRef(alice.user), page: pageRef(page), comment: null, data: { anchor: "h-1", n: 2 }, createdAt: "2025-06-02T10:00:00.000Z", readAt: null },
        { id: ids.updated, kind: "page.updated", actor: null, page: pageRef(page), comment: null, data: {}, createdAt: "2025-06-01T10:00:00.123Z", readAt: "2025-06-02T08:30:00.987Z" },
      ],
    });
    // Other people's notifications are their own.
    expect((await inbox(dave)).length).toBe(0);
  });

  test("unread keeps the unread ones; limit and offset page through", async () => {
    const order = ["pageless", "trashed", "hidden", "reply", "created", "mention", "updated"].map((key) => ids[key]);
    const got = async (query: string) => (await inbox(lister, query)).map((n) => n.id);
    const unread = order.filter((id) => id !== ids.reply && id !== ids.updated);
    for (const query of ["?unread=1", "?unread=true"]) expect(await got(query)).toEqual(unread);
    for (const query of ["?unread=0", "?unread=false", "?unread=", ""]) expect(await got(query)).toEqual(order);
    for (const value of ["yes", "TRUE", "2", "on"]) expectInvalid(await lister.client.get(`/notifications?unread=${value}`), "unread must be a boolean");
    expect(await got("?limit=2")).toEqual(order.slice(0, 2));
    expect(await got("?limit=3&offset=2")).toEqual(order.slice(2, 5));
    expect(await got("?unread=1&limit=2&offset=3")).toEqual(unread.slice(3, 5));
    expect(await got("?offset=7")).toEqual([]);
    expect(await got("?limit=100&offset=100000")).toEqual([]);
    for (const limit of ["0", "101", "-1", "1.5", "many"]) expectInvalid(await lister.client.get(`/notifications?limit=${limit}`), "limit must be an integer between 1 and 100");
    for (const offset of ["-1", "100001", "x"]) expectInvalid(await lister.client.get(`/notifications?offset=${offset}`), "offset must be an integer between 0 and 100000");
  });

  test("the default limit is 30, and notifications of the same moment are listed by id", async () => {
    const many = await person(t, owner, "many@example.com");
    await t.sql`
      INSERT INTO notifications (user_id, kind, created_at)
      SELECT ${many.id}, 'page.updated', '2025-01-01T00:00:00Z'::timestamptz + make_interval(mins => n / 2) FROM generate_series(1, 32) AS n`;
    const firstPage = await inbox(many);
    expect(firstPage).toHaveLength(30);
    const all = await inbox(many, "?limit=100");
    expect(all).toHaveLength(32);
    const expected = (await t.sql`SELECT id FROM notifications WHERE user_id = ${many.id} ORDER BY created_at DESC, id`).map((r: any) => r.id);
    expect(all.map((n) => n.id)).toEqual(expected);
    expect(firstPage.map((n) => n.id)).toEqual(expected.slice(0, 30));
    expect(data(await many.client.get("/notifications/unread-count"))).toEqual({ count: 32 });
  });

  test("the page comes back when it is restored or readable again; the actor is null once deleted", async () => {
    data(await owner.post(`/pages/${trashedPage.id}/restore`));
    const restored = (await inbox(lister)).find((n) => n.id === ids.trashed);
    expect(restored.page).toEqual(pageRef(trashedPage));
    expect(restored.comment).toEqual({ id: anyId(), parentId: null });
    data(await owner.post(`/pages/${trashedPage.id}/delete`));
    const temp = await person(t, owner, "temp-actor@example.com");
    const id = await insert({ kind: "page.updated", actorId: temp.id, pageId: page.id, at: "2025-07-01T00:00:00Z" });
    expect((await inbox(lister)).find((n) => n.id === id).actor).toEqual(userRef(temp.user));
    data(await owner.post("/members/delete", { userId: temp.id }));
    expect((await inbox(lister)).find((n) => n.id === id)).toEqual({ id, kind: "page.updated", actor: null, page: pageRef(page), comment: null, data: {}, createdAt: "2025-07-01T00:00:00.000Z", readAt: null });
    await t.sql`DELETE FROM notifications WHERE id = ${id}`;
  });

  describe("reading (continues with the same notifications)", () => {
    test("unread-count counts what is unread, whatever it is about", async () => {
      const res = await lister.client.get("/notifications/unread-count");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { count: 5 } });
      expect(data(await dave.client.get("/notifications/unread-count"))).toEqual({ count: 0 });
    });

    test("read marks the given notifications of the user as read, once", async () => {
      const [othersId] = (await t.sql`SELECT id FROM notifications WHERE user_id <> ${lister.id} AND read_at IS NULL LIMIT 1`).map((r: any) => r.id);
      const res = await lister.client.post("/notifications/read", { ids: [ids.created, ids.created!.toUpperCase(), ids.reply, othersId, NO_SUCH_ID] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: {} });
      const after = await inbox(lister);
      const created = after.find((n) => n.id === ids.created);
      expect(created.readAt).toMatch(/^20\d\d-/);
      expect(Date.parse(created.readAt)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
      // One that was read already keeps its time; someone else's is not touched.
      expect(after.find((n) => n.id === ids.reply).readAt).toBe("2025-06-05T00:00:00.000Z");
      const [other] = await t.sql`SELECT read_at FROM notifications WHERE id = ${othersId}`;
      expect(other.read_at).toBeNull();
      expect(data(await lister.client.get("/notifications/unread-count"))).toEqual({ count: 4 });
      expect((await inbox(lister, "?unread=1")).map((n) => n.id)).toEqual([ids.pageless, ids.trashed, ids.hidden, ids.mention]);
      // Reading it again does not move the time.
      data(await lister.client.post("/notifications/read", { ids: [ids.created] }));
      expect((await inbox(lister)).find((n) => n.id === ids.created).readAt).toBe(created.readAt);
    });

    test("ids must be a list of at most 500 ids", async () => {
      const read = (body: unknown) => lister.client.post("/notifications/read", body);
      expectInvalid(await read({}), "ids is required");
      for (const value of [null, "all", ids.mention, {}, 5]) expectInvalid(await read({ ids: value }), "ids must be a list of at most 500 ids");
      expectInvalid(await read({ ids: Array(501).fill(NO_SUCH_ID) }), "ids must be a list of at most 500 ids");
      for (const value of [["nope"], [ids.mention, 5], [null]]) expectInvalid(await read({ ids: value }), "ids must contain valid ids");
      expect(data(await read({ ids: [] }))).toEqual({});
      expect(data(await read({ ids: Array(500).fill(NO_SUCH_ID) }))).toEqual({});
      expect(data(await lister.client.get("/notifications/unread-count"))).toEqual({ count: 4 });
    });

    test("read-all marks everything of the user as read, and nothing of anyone else", async () => {
      const [{ before }] = await t.sql`SELECT count(*)::int AS before FROM notifications WHERE user_id <> ${lister.id} AND read_at IS NULL`;
      const res = await lister.client.post("/notifications/read-all");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: {} });
      expect(data(await lister.client.get("/notifications/unread-count"))).toEqual({ count: 0 });
      expect(await inbox(lister, "?unread=1")).toEqual([]);
      const all = await inbox(lister);
      expect(all).toHaveLength(7);
      expect(all.find((n) => n.id === ids.updated).readAt).toBe("2025-06-02T08:30:00.987Z");
      for (const n of all) expect(n.readAt).toEqual(anyTime());
      const [{ after }] = await t.sql`SELECT count(*)::int AS after FROM notifications WHERE user_id <> ${lister.id} AND read_at IS NULL`;
      expect(after).toBe(before);
      expect(before).toBeGreaterThan(0);
      // With nothing unread it is still fine.
      expect(data(await lister.client.post("/notifications/read-all"))).toEqual({});
    });
  });
});
