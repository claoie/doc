import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { savePageContent } from "server/lib/pages";
import { highlight } from "server/lib/search";
import { doc, startTestServer, type Client, type TestContext } from "server/test-helpers";

let t: TestContext;
let owner: Client;
let ownerId: string;
let spaceId: string;

const create = async (title: string, text?: string) => {
  const res = await owner.post("/pages", { spaceId, title });
  const page = res.body.data.page;
  if (text) await savePageContent(page.id, { content: doc(text), docVersion: 1, editorId: ownerId, contributorIds: [] });
  return page;
};

const search = async (q: string, extra = "") =>
  (await owner.get(`/search?q=${encodeURIComponent(q)}${extra}`)).body.data as { title: string; highlight: string }[];

beforeAll(async () => {
  t = await startTestServer();
  const setup = await t.setupOwner();
  owner = setup.owner;
  ownerId = setup.user.id;
  spaceId = setup.spaceId;
  await create("Quarterly planning", "Roadmap for the next quarter with <script>alert(1)</script> inside.");
  await create("Team handbook", "How we plan our quarterly offsites and onboarding.");
  await create("회의록 정리", "다음 주 일정과 예산 논의");
  await create("프로젝트계획서", "본문 내용");
});

afterAll(async () => {
  await t.close();
});

describe("search", () => {
  test("prefix matches English titles and text, ranking title matches first", async () => {
    const results = await search("quart");
    expect(results.map((r) => r.title)).toEqual(["Quarterly planning", "Team handbook"]);
    expect(results[1]!.highlight).toContain("<mark>quarterly</mark>");
  });

  test("escapes text around highlights", async () => {
    const [result] = await search("roadmap");
    expect(result!.highlight).toContain("<mark>Roadmap</mark>");
    expect(result!.highlight).toContain("&lt;script&gt;");
    expect(result!.highlight).not.toContain("<script>");
  });

  test("matches Korean titles by word prefix and by substring", async () => {
    expect((await search("회의")).map((r) => r.title)).toEqual(["회의록 정리"]);
    expect((await search("계획")).map((r) => r.title)).toEqual(["프로젝트계획서"]);
    expect((await search("예산")).map((r) => r.title)).toEqual(["회의록 정리"]);
    expect((await search("일정과 예")).map((r) => r.title)).toEqual(["회의록 정리"]);
  });

  test("title-only search ignores body text", async () => {
    expect((await search("onboarding", "&titleOnly=1")).map((r) => r.title)).toEqual([]);
    expect((await search("handbook", "&titleOnly=1")).map((r) => r.title)).toEqual(["Team handbook"]);
  });

  test("tsquery syntax in the query is inert", async () => {
    expect((await owner.get(`/search?q=${encodeURIComponent("plan & | ! :* ( ' \\")}`)).status).toBe(200);
    expect((await owner.get(`/search?q=${encodeURIComponent("%_")}`)).body.data).toEqual([]);
  });

  test("suggest returns users and pages", async () => {
    const res = await owner.get("/search/suggest?q=own");
    expect(res.body.data.users.map((u: { email: string }) => u.email)).toEqual(["owner@example.com"]);
    const pages = await owner.get("/search/suggest?q=team&users=0&pages=1");
    expect(pages.body.data.users).toEqual([]);
    expect(pages.body.data.pages.map((p: { title: string }) => p.title)).toEqual(["Team handbook"]);
  });

  test("highlight builds an escaped excerpt around the first match", () => {
    const text = `${"lorem ".repeat(60)}needle <b> ${"ipsum ".repeat(60)}`;
    const html = highlight(text, ["needle"]);
    expect(html.startsWith("…")).toBe(true);
    expect(html).toContain("<mark>needle</mark> &lt;b&gt;");
    expect(html.length).toBeLessThan(300);
  });
});
