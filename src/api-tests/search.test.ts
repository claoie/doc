import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { doc, startServer, type Client, type TestServer } from "./harness";
import {
  NO_SUCH_ID,
  anyTime,
  createPage,
  createSpace,
  data,
  docOf,
  expectInvalid,
  expectUnauthorized,
  paragraph,
  person,
  spaceRef,
  text,
  treeItem,
  type Person,
} from "./harness/spaces-pages";

let t: TestServer;
let owner: Client;
let ownerUser: any;
let space: any;
let hidden: any;
/** Reads `space` only. */
let anna: Person;
let annabel: Person;
let joanna: Person;
let underscore: Person;
let zed: Person;

const search = async (client: Client, q: string, extra = "") => data(await client.get(`/search?q=${encodeURIComponent(q)}${extra}`)) as any[];
const found = async (q: string, extra = "") => (await search(anna.client, q, extra)).map((r) => r.title);
const highlights = async (q: string, extra = "") => (await search(anna.client, q, extra)).map((r) => r.highlight);

/** A page in `space` with one paragraph per line of text. */
const page = (title: string | null, ...lines: string[]) => createPage(owner, { spaceId: space.id, title, ...(lines.length ? { content: doc(...lines) } : {}) });

let counter = 0;
/** A space of its own, read by anna, for tests whose results must not mix with the shared pages. */
const island = async () => {
  const created = await createSpace(owner, `Island ${++counter}`, `island-${counter}`);
  data(await owner.post(`/spaces/${created.id}/members/add`, { role: "reader", userIds: [anna.id] }));
  return created;
};

beforeAll(async () => {
  t = await startServer();
  ({ owner, user: ownerUser } = await t.setupOwner());
  space = await createSpace(owner, "Library", "library");
  hidden = await createSpace(owner, "Vault", "vault");
  anna = await person(t, owner, "anna@example.com", { space: space.id, spaceRole: "reader" });
  annabel = await person(t, owner, "annabel@example.com");
  joanna = await person(t, owner, "joanna@example.com");
  underscore = await person(t, owner, "per_cent@example.com");
  zed = await person(t, owner, "zed-annoyed@example.com");
  data(await owner.post("/members/deactivate", { userId: zed.id }));
  await page("Quarterly planning", "Roadmap for the next quarter with <script>alert(1)</script> inside.");
  await page("Team handbook", "How we plan our quarterly offsites and onboarding.");
  await page("회의록 정리", "다음 주 일정과 예산 논의");
  await page("프로젝트계획서", "본문 내용");
  await page("Café Zürich", "Ｆｕｌｌｗｉｄｔｈ words and ﬁne ligatures");
  await page(null, "An untitled page about zeppelins");
  await page("100%_done", "nothing special");
  const trashed = await page("Trashed zeppelin", "zeppelins in the trash");
  data(await owner.post(`/pages/${trashed.id}/delete`));
  await createPage(owner, { spaceId: hidden.id, title: "Hidden zeppelin", content: doc("zeppelins in the vault, quarterly") });
});

afterAll(async () => {
  await t.close();
});

describe("without a session", () => {
  test("search answers 401", async () => {
    expectUnauthorized(await t.client().get("/search?q=plan"));
    expectUnauthorized(await t.client().get("/search/suggest?q=plan"));
  });
});

describe("GET /search", () => {
  test("matches words of the title and of the text by prefix, title matches first", async () => {
    const res = await anna.client.get("/search?q=quart");
    expect(res.status).toBe(200);
    const [first, second] = res.body.data;
    expect(res.body).toEqual({
      data: [
        {
          ...treeItem(first),
          title: "Quarterly planning",
          space: spaceRef(space),
          highlight: "Roadmap for the next <mark>quarter</mark> with &lt;script&gt;alert(1)&lt;/script&gt; inside.",
          updatedAt: anyTime(),
        },
        { ...treeItem(second), title: "Team handbook", space: spaceRef(space), highlight: "How we plan our <mark>quarterly</mark> offsites and onboarding.", updatedAt: anyTime() },
      ],
    });
    expect(Object.keys(first).sort()).toEqual(["hasChildren", "highlight", "icon", "id", "isBase", "parentId", "position", "slugId", "space", "spaceId", "title", "updatedAt"]);
    // Words are matched from their start; a title is also matched by any piece of it, which is why the text of
    // "Team handbook" is not a match for `arterly`.
    expect(await found("arterly")).toEqual(["Quarterly planning"]);
    expect(await highlights("arterly")).toEqual(["Qu<mark>arterly</mark> planning"]);
    // Only when nothing matches that way is a piece of the text enough (see the fallback below).
    expect(await found("ffsites")).toEqual(["Team handbook"]);
    expect(await highlights("ffsites")).toEqual(["How we plan our quarterly o<mark>ffsites</mark> and onboarding."]);
    expect(await found("quarterlies")).toEqual([]);
    expect(await found("onboarding")).toEqual(["Team handbook"]);
  });

  test("every word must match, each by prefix, in any order and any case", async () => {
    expect(await found("plan quarterly")).toEqual(["Quarterly planning", "Team handbook"]);
    expect(await found("QUARTERLY   Plan")).toEqual(["Quarterly planning", "Team handbook"]);
    expect(await found("offsite, plan; (quarter)")).toEqual(["Team handbook"]);
    expect(await found("plan zeppelin")).toEqual([]);
    expect(await highlights("offsites plan")).toEqual(["How we <mark>plan</mark> our quarterly <mark>offsites</mark> and onboarding."]);
  });

  test("when only the title matches, the highlight is the title", async () => {
    expect(await highlights("handbook")).toEqual(["Team <mark>handbook</mark>"]);
    expect(await highlights("hand team")).toEqual(["<mark>Team</mark> <mark>handbook</mark>"]);
    // The words are marked where they stand; the query as typed is marked as a whole where it occurs, to the end of the word.
    expect(await highlights("team hand")).toEqual(["<mark>Team handbook</mark>"]);
    expect(await highlights("team handbook")).toEqual(["<mark>Team handbook</mark>"]);
    expect(await highlights("quarterly planning")).toEqual(["<mark>Quarterly planning</mark>"]);
  });

  test("an untitled page is found by its text", async () => {
    const [result] = await search(anna.client, "zeppelin");
    expect(result).toEqual({ ...treeItem(result), title: null, space: spaceRef(space), highlight: "An untitled page about <mark>zeppelins</mark>", updatedAt: anyTime() });
    expect(await found("zeppelin")).toEqual([null]);
  });

  test("only pages the user can read, outside the trash", async () => {
    expect((await search(owner, "zeppelin")).map((r) => r.title).sort()).toEqual(["Hidden zeppelin", null].sort());
    expect((await search(annabel.client, "zeppelin")).map((r) => r.title)).toEqual([]);
    expect((await search(annabel.client, "quart")).map((r) => r.title)).toEqual([]);
  });

  test("spaceId narrows the search to one space", async () => {
    expect((await search(owner, "quarterly")).map((r) => r.title).sort()).toEqual(["Hidden zeppelin", "Quarterly planning", "Team handbook"]);
    expect((await search(owner, "quarterly", `&spaceId=${hidden.id.toUpperCase()}`)).map((r) => [r.title, r.space])).toEqual([["Hidden zeppelin", spaceRef(hidden)]]);
    expect((await search(owner, "quarterly", `&spaceId=${space.id}`)).map((r) => r.title)).toEqual(["Quarterly planning", "Team handbook"]);
    expect(await search(owner, "quarterly", "&spaceId=")).toHaveLength(3);
    expect(await search(owner, "quarterly", `&spaceId=${NO_SUCH_ID}`)).toEqual([]);
    // A space the user cannot read gives nothing.
    expect(await found("quarterly", `&spaceId=${hidden.id}`)).toEqual([]);
    expectInvalid(await owner.get("/search?q=quarterly&spaceId=library"), "spaceId must be a valid id");
  });

  test("titleOnly ignores the text", async () => {
    expect(await found("onboarding", "&titleOnly=1")).toEqual([]);
    expect(await found("quart", "&titleOnly=true")).toEqual(["Quarterly planning"]);
    expect(await highlights("quart", "&titleOnly=1")).toEqual(["<mark>Quarterly</mark> planning"]);
    expect(await found("quart", "&titleOnly=0")).toEqual(["Quarterly planning", "Team handbook"]);
    expect(await found("quart", "&titleOnly=false")).toEqual(["Quarterly planning", "Team handbook"]);
    expect(await found("quart", "&titleOnly=")).toEqual(["Quarterly planning", "Team handbook"]);
    // An untitled page has no title to match.
    expect(await found("zeppelin", "&titleOnly=1")).toEqual([]);
    for (const value of ["yes", "2", "TRUE"]) expectInvalid(await anna.client.get(`/search?q=quart&titleOnly=${value}`), "titleOnly must be a boolean");
  });

  test("an empty query finds nothing; a query may be 500 characters long", async () => {
    for (const q of ["", "   ", "%20%09"]) {
      const res = await anna.client.get(`/search?q=${q}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [] });
    }
    expect(data(await anna.client.get("/search"))).toEqual([]);
    // Punctuation alone has no words: it can only match as a piece of a title or of a text.
    expect(await found("...")).toEqual([]);
    expect(data(await anna.client.get(`/search?q=${"q".repeat(500)}`))).toEqual([]);
    expect(data(await anna.client.get(`/search?q=%20${"q".repeat(500)}%20`))).toEqual([]);
    expectInvalid(await anna.client.get(`/search?q=${"q".repeat(501)}`), "q must be at most 500 characters");
  });

  test("characters with a meaning in query syntax or in LIKE are taken literally", async () => {
    for (const q of ["plan & | ! :* ( ' \\", "quarter:*", "'quarter'", "quarter | zeppelin", "!quarter", "a<->b", "\\", "'", ":", "(", "&"]) {
      expect((await anna.client.get(`/search?q=${encodeURIComponent(q)}`)).status).toBe(200);
    }
    expect(await found("plan & | ! :* ( ' \\")).toEqual(["Quarterly planning", "Team handbook"]);
    // Read as the words `quarter` and `zeppelin`, both required.
    expect(await found("quarter | zeppelin")).toEqual([]);
    expect(await found("%_")).toEqual(["100%_done"]);
    expect(await highlights("%_")).toEqual(["100<mark>%_</mark>done"]);
    expect(await found("%")).toEqual(["100%_done"]);
    expect(await found("_")).toEqual(["100%_done"]);
    expect(await found("0%_d")).toEqual(["100%_done"]);
  });

  test("the query is lower-cased and normalised (NFKC); what is stored is not", async () => {
    expect(await found("CAFÉ")).toEqual(["Café Zürich"]);
    expect(await found("zürich")).toEqual(["Café Zürich"]);
    // Full-width letters in the query are folded to plain ones, a decomposed accent is composed.
    expect(await found("ｃａｆé")).toEqual(["Café Zürich"]);
    expect(await found("café")).toEqual(["Café Zürich"]);
    expect(await highlights("café zür")).toEqual(["<mark>Café</mark> <mark>Zürich</mark>"]);
    expect(await found("ＱＵＡＲＴ")).toEqual(["Quarterly planning", "Team handbook"]);
    // The text holds full-width letters and a ligature: plain letters do not find them.
    expect(await found("fullwidth")).toEqual([]);
    expect(await found("fine")).toEqual([]);
    // The ligature itself is folded to `fi` as a word, which matches nothing; it is then found as a piece of the text.
    expect(await found("ﬁne")).toEqual(["Café Zürich"]);
    expect(await highlights("ﬁne")).toEqual(["Ｆｕｌｌｗｉｄｔｈ words and <mark>ﬁne</mark> ligatures"]);
    expect(await found("ligatures")).toEqual(["Café Zürich"]);
    expect(await found("cafe")).toEqual([]);
  });

  test("Korean: words match by prefix, and a piece of a title matches anywhere", async () => {
    expect(await found("회의")).toEqual(["회의록 정리"]);
    expect(await found("예산")).toEqual(["회의록 정리"]);
    expect(await highlights("예산")).toEqual(["다음 주 일정과 <mark>예산</mark> 논의"]);
    expect(await found("일정과 예")).toEqual(["회의록 정리"]);
    expect(await highlights("일정과 예")).toEqual(["다음 주 <mark>일정과 예산</mark> 논의"]);
    expect(await found("계획")).toEqual(["프로젝트계획서"]);
    expect(await highlights("계획")).toEqual(["프로젝트<mark>계획</mark>서"]);
    expect(await found("계획", "&titleOnly=1")).toEqual(["프로젝트계획서"]);
  });

  test("when nothing matches by word or title, a piece of the text is enough", async () => {
    const own = await island();
    await createPage(owner, { spaceId: own.id, title: "노트", content: doc("프로젝트계획서를작성했다") });
    await createPage(owner, { spaceId: own.id, title: "Disbelief", content: doc("It was Unbelievable, truly.") });
    const q = (query: string, extra = "") => search(anna.client, query, `&spaceId=${own.id}${extra}`);
    expect((await q("계획서를")).map((r) => [r.title, r.highlight])).toEqual([["노트", "프로젝트<mark>계획서를</mark>작성했다"]]);
    expect((await q("BELIEVABLE")).map((r) => [r.title, r.highlight])).toEqual([["Disbelief", "It was Un<mark>believable</mark>, truly."]]);
    expect((await q("able, tru")).map((r) => r.highlight)).toEqual(["It was Unbeliev<mark>able, tru</mark>ly."]);
    // Not for titles only, and not past the first page.
    expect(await q("계획서를", "&titleOnly=1")).toEqual([]);
    expect(await q("계획서를", "&offset=1")).toEqual([]);
    expect(await q("believable", "&offset=0&limit=1")).toHaveLength(1);
    // As soon as something matches by word, the pieces are not looked for: `unbelievable` is no match for `was believ`.
    expect(await q("was believ")).toEqual([]);
    expect((await q("was")).map((r) => r.title)).toEqual(["Disbelief"]);
  });

  test("a page whose title is exactly the query comes first, then title matches, then the latest update", async () => {
    const own = await island();
    const make = async (title: string, body: string, updatedAt: string) => {
      const created = await createPage(owner, { spaceId: own.id, title, content: doc(body) });
      await t.sql`UPDATE pages SET updated_at = ${updatedAt}::timestamptz WHERE id = ${created.id}`;
      return created;
    };
    await make("Pelican notes", "pelican pelican pelican pelican", "2025-01-05T00:00:00Z");
    await make("Birds", "a pelican is mentioned in the text only", "2025-01-06T00:00:00Z");
    const exact = await make("PELICAN", "nothing about the bird", "2025-01-01T00:00:00Z");
    await make("Twin", "the same pelican text", "2025-01-02T00:00:00Z");
    await make("Twin", "the same pelican text", "2025-01-03T00:00:00Z");
    const results = await search(anna.client, "pelican", `&spaceId=${own.id}`);
    expect(results.map((r) => [r.title, r.updatedAt])).toEqual([
      ["PELICAN", "2025-01-01T00:00:00.000Z"],
      ["Pelican notes", "2025-01-05T00:00:00.000Z"],
      ["Birds", "2025-01-06T00:00:00.000Z"],
      ["Twin", "2025-01-03T00:00:00.000Z"],
      ["Twin", "2025-01-02T00:00:00.000Z"],
    ]);
    expect(results[0].id).toBe(exact.id);
    // Exactness is about the whole query as typed, case aside.
    expect((await search(anna.client, " Pelican  ", `&spaceId=${own.id}`))[0].title).toBe("PELICAN");
    expect((await search(anna.client, "pelican notes", `&spaceId=${own.id}`)).map((r) => r.title)).toEqual(["Pelican notes"]);
  });

  test("limit and offset page through the results; the default limit is 20, the largest 50", async () => {
    const own = await island();
    for (let i = 0; i < 52; i++) {
      const created = await createPage(owner, { spaceId: own.id, title: `Heron ${String(i).padStart(2, "0")}` });
      await t.sql`UPDATE pages SET updated_at = '2025-02-01T00:00:00Z'::timestamptz + make_interval(mins => ${i}) WHERE id = ${created.id}`;
    }
    const q = async (extra: string) => (await search(anna.client, "heron", `&spaceId=${own.id}${extra}`)).map((r) => Number(r.title.slice(6)));
    const newestFirst = Array.from({ length: 52 }, (_, i) => 51 - i);
    expect(await q("")).toEqual(newestFirst.slice(0, 20));
    expect(await q("&limit=50")).toEqual(newestFirst.slice(0, 50));
    expect(await q("&limit=3&offset=50")).toEqual([1, 0]);
    expect(await q("&limit=1")).toEqual([51]);
    expect(await q("&offset=52")).toEqual([]);
    expect(await q("&limit=&offset=")).toEqual(newestFirst.slice(0, 20));
    for (const limit of ["0", "51", "-1", "2.5", "x"]) expectInvalid(await anna.client.get(`/search?q=heron&limit=${limit}`), "limit must be an integer between 1 and 50");
    for (const offset of ["-1", "10001", "x"]) expectInvalid(await anna.client.get(`/search?q=heron&offset=${offset}`), "offset must be an integer between 0 and 10000");
    expect(await q("&offset=10000")).toEqual([]);
  });

  test("at most eight words of the query count, each cut at 50 characters", async () => {
    const own = await island();
    await createPage(owner, { spaceId: own.id, title: "Greek", content: doc("alpha beta gamma delta epsilon zeta eta theta", `${"x".repeat(55)} end`) });
    const q = async (query: string) => (await search(anna.client, query, `&spaceId=${own.id}`)).map((r) => r.title);
    expect(await q("alpha beta gamma delta epsilon zeta eta theta")).toEqual(["Greek"]);
    expect(await q("alpha beta gamma delta epsilon zeta eta theta missing")).toEqual(["Greek"]);
    expect(await q("alpha beta gamma delta epsilon zeta eta missing")).toEqual([]);
    // Repeated words count once.
    expect(await q("alpha alpha alpha alpha alpha alpha alpha alpha alpha beta")).toEqual(["Greek"]);
    expect(await q(`${"x".repeat(50)}yyyyy`)).toEqual(["Greek"]);
    expect(await q(`${"x".repeat(49)}y`)).toEqual([]);
  });

  describe("the highlight", () => {
    let own: any;
    const one = async (body: unknown, query: string, title = "Sample") => {
      const created = await createPage(owner, { spaceId: own.id, title, content: typeof body === "string" ? doc(body) : body });
      const results = await search(anna.client, query, `&spaceId=${own.id}`);
      data(await owner.post(`/pages/${created.id}/delete-permanently`));
      return results.map((r) => r.highlight);
    };

    beforeAll(async () => {
      own = await island();
    });

    test("escapes the text and marks every occurrence, each extended to the end of its word", async () => {
      expect(await one(`Say "hi" & <wave> to the wavers; Waving is a wave`, "wav")).toEqual([
        "Say &quot;hi&quot; &amp; &lt;<mark>wave</mark>&gt; to the <mark>wavers</mark>; <mark>Waving</mark> is a <mark>wave</mark>",
      ]);
      // Inside a word only the piece itself is marked.
      expect(await one("microwave ovens and waves", "wave")).toEqual(["micro<mark>wave</mark> ovens and <mark>waves</mark>"]);
      // Line breaks and runs of blanks become single spaces.
      expect(await one(docOf(paragraph(text("first   line")), paragraph(text("second\tline with a wave"))), "wave")).toEqual(["first line second line with a <mark>wave</mark>"]);
    });

    test("is a window of about 200 characters around the first match, cut at spaces and marked with …", async () => {
      const long = `${"lorem ".repeat(60)}needle <b> ${"ipsum ".repeat(60)}`;
      expect(await one(long, "needle")).toEqual([`…${"lorem ".repeat(10)}<mark>needle</mark> &lt;b&gt; ${"ipsum ".repeat(20)}ipsum…`]);
      // A match near the start: no leading mark, the window is cut at the last space before 200 characters.
      expect(await one(`needle ${"hay ".repeat(100)}`, "needle")).toEqual([`<mark>needle</mark> ${"hay ".repeat(47)}hay…`]);
      // A short text is given whole.
      expect(await one("just a needle here", "needle")).toEqual(["just a <mark>needle</mark> here"]);
      // A match within the last characters: the window still starts a third of its width before the match.
      expect(await one(`${"hay ".repeat(100)}needle`, "needle")).toEqual([`…${"hay ".repeat(16)}<mark>needle</mark>`]);
      // Without spaces to cut at, the window is cut where it falls.
      expect(await one(`${"a".repeat(150)} needle ${"b".repeat(300)}`, "needle")).toEqual([`…<mark>needle</mark> ${"b".repeat(193)}…`]);
    });

    test("when the match is by title only and the text is long, the title is shown", async () => {
      expect(await one("words ".repeat(100), "sample")).toEqual(["<mark>Sample</mark>"]);
      expect(await one("words ".repeat(100), "<b>", "A <b>bold</b> title")).toEqual(["A <mark>&lt;b&gt;bold</mark>&lt;/<mark>b</mark>&gt; title"]);
    });
  });
});

describe("GET /search/suggest", () => {
  const suggest = async (client: Client, query: string) => {
    const res = await client.get(`/search/suggest${query}`);
    expect(res.status).toBe(200);
    return res.body.data as { users: any[]; pages: any[] };
  };
  const listed = (user: any, preferences: Record<string, unknown> = {}) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: null,
    role: user.role,
    locale: null,
    timezone: null,
    preferences,
    createdAt: user.createdAt,
    lastLoginAt: anyTime(),
  });

  test("suggests users by a piece of their name or email, names starting with it first; deactivated users never", async () => {
    data(await anna.client.post("/me/update", { preferences: { theme: "dark" } }));
    const res = await anna.client.get("/search/suggest?q=ANN&users=1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        // One's own preferences are included, other people's never.
        users: [listed(anna.user, { theme: "dark" }), listed(annabel.user), listed(joanna.user)],
        pages: [],
      },
    });
    expect((await suggest(owner, "?q=ann&users=1")).users).toEqual([listed(anna.user), listed(annabel.user), listed(joanna.user)]);
    expect((await suggest(owner, "?q=zed&users=1")).users).toEqual([]);
    // By email: everyone is at example.com, so the order is by name.
    expect((await suggest(owner, "?q=example.com&users=1")).users.map((u) => u.name)).toEqual(["anna", "annabel", "joanna", "Owner", "per_cent"]);
    expect((await suggest(owner, "?q=OWNER@&users=1")).users).toEqual([{ ...listed(ownerUser), name: "Owner" }]);
    expect((await suggest(owner, "?q=o&users=1")).users.map((u) => u.name)).toEqual(["Owner", "anna", "annabel", "joanna", "per_cent"]);
    // % and _ are plain characters.
    expect((await suggest(owner, "?q=_&users=1")).users.map((u) => u.name)).toEqual(["per_cent"]);
    expect((await suggest(owner, "?q=%25&users=1")).users).toEqual([]);
    expect((await suggest(owner, "?q=r_c&users=1")).users.map((u) => u.name)).toEqual(["per_cent"]);
    expect((await suggest(owner, "?q=nobody-by-this-name&users=1")).users).toEqual([]);
  });

  test("suggests pages the user can read by a piece of their title, titles starting with it first, then the latest update", async () => {
    const own = await island();
    const make = async (title: string | null, updatedAt: string, spaceId = own.id) => {
      const created = await createPage(owner, { spaceId, title });
      await t.sql`UPDATE pages SET updated_at = ${updatedAt}::timestamptz WHERE id = ${created.id}`;
      return created;
    };
    const inner = await make("An otter story", "2025-03-05T00:00:00Z");
    const older = await make("Otter facts", "2025-03-01T00:00:00Z");
    const newer = await make("OTTERS!", "2025-03-02T00:00:00Z");
    await make("Hotter days", "2025-03-06T00:00:00Z", hidden.id);
    const trashed = await make("Otter in the trash", "2025-03-07T00:00:00Z");
    data(await owner.post(`/pages/${trashed.id}/delete`));
    const res = await anna.client.get("/search/suggest?q=Otter&users=0&pages=1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        users: [],
        pages: [
          { ...treeItem(newer), space: spaceRef(own) },
          { ...treeItem(older), space: spaceRef(own) },
          { ...treeItem(inner), space: spaceRef(own) },
        ],
      },
    });
    expect((await suggest(owner, "?q=otter&pages=1")).pages.map((p) => p.title)).toEqual(["OTTERS!", "Otter facts", "Hotter days", "An otter story"]);
    expect((await suggest(owner, `?q=otter&pages=1&spaceId=${hidden.id}`)).pages.map((p) => p.title)).toEqual(["Hotter days"]);
    expect((await suggest(anna.client, `?q=otter&pages=1&spaceId=${hidden.id}`)).pages).toEqual([]);
    expect((await suggest(anna.client, `?q=otter&pages=1&spaceId=${own.id.toUpperCase()}`)).pages).toHaveLength(3);
    expect((await suggest(anna.client, "?q=otter&pages=1&spaceId=")).pages).toHaveLength(3);
    expect((await suggest(anna.client, "?q=tters!&pages=1")).pages.map((p) => p.title)).toEqual(["OTTERS!"]);
    // The text of a page is not looked at.
    expect((await suggest(anna.client, "?q=roadmap&pages=1")).pages).toEqual([]);
    expect((await suggest(anna.client, "?q=%25_&pages=1")).pages.map((p) => p.title)).toEqual(["100%_done"]);
    expectInvalid(await anna.client.get("/search/suggest?q=otter&spaceId=nope"), "spaceId must be a valid id");
  });

  test("users and pages are both suggested unless one of the switches is given", async () => {
    const shape = async (query: string) => {
      const { users, pages } = await suggest(anna.client, `?q=an${query}`);
      return [users.length > 0, pages.length > 0];
    };
    // `an` is in anna, annabel, joanna and in "Quarterly planning", "Team handbook".
    expect(await shape("")).toEqual([true, true]);
    expect(await shape("&users=1&pages=1")).toEqual([true, true]);
    // Naming one switch turns the other off, whatever the named one says.
    expect(await shape("&users=1")).toEqual([true, false]);
    expect(await shape("&pages=1")).toEqual([false, true]);
    expect(await shape("&users=0")).toEqual([false, false]);
    expect(await shape("&pages=0")).toEqual([false, false]);
    expect(await shape("&users=")).toEqual([false, false]);
    expect(await shape("&users=0&pages=1")).toEqual([false, true]);
    expect(await shape("&users=true&pages=false")).toEqual([true, false]);
    expect(await shape("&users=0&pages=0")).toEqual([false, false]);
    expectInvalid(await anna.client.get("/search/suggest?q=an&users=yes"), "users must be a boolean");
    expectInvalid(await anna.client.get("/search/suggest?q=an&pages=2"), "pages must be a boolean");
  });

  test("without a query everything is suggested, up to the limit: 10 by default, 25 at most", async () => {
    const own = await island();
    for (let i = 0; i < 27; i++) await createPage(owner, { spaceId: own.id, title: `Suggested ${i}` });
    const all = await suggest(owner, "");
    expect(all.users.map((u) => u.name)).toEqual(["anna", "annabel", "joanna", "Owner", "per_cent"]);
    expect(all.pages).toHaveLength(10);
    expect(await suggest(owner, "?q=")).toEqual(all);
    const some = await suggest(owner, `?limit=2&spaceId=${own.id}`);
    expect([some.users.map((u) => u.name), some.pages.map((p) => p.title)]).toEqual([["anna", "annabel"], ["Suggested 26", "Suggested 25"]]);
    expect((await suggest(owner, `?limit=25&spaceId=${own.id}`)).pages).toHaveLength(25);
    expect((await suggest(owner, `?q=suggested&spaceId=${own.id}`)).pages).toHaveLength(10);
    // Untitled pages are suggested when there is no query.
    expect((await suggest(anna.client, `?limit=25&spaceId=${space.id}`)).pages.map((p) => p.title)).toContain(null);
    for (const limit of ["0", "26", "-1", "x"]) expectInvalid(await owner.get(`/search/suggest?limit=${limit}`), "limit must be an integer between 1 and 25");
    expect((await suggest(owner, `?q=${"s".repeat(100)}`)).pages).toEqual([]);
    expectInvalid(await owner.get(`/search/suggest?q=${"s".repeat(101)}`), "q must be at most 100 characters");
    expect(underscore.user.name).toBe("per_cent");
  });
});
