import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { startTestServer, type Client, type TestContext } from "server/test-helpers";

let t: TestContext;
let owner: Client;
let spaceId: string;

beforeAll(async () => {
  t = await startTestServer();
  ({ owner, spaceId } = await t.setupOwner());
});

afterAll(async () => {
  delete process.env.FILE_SIZE_LIMIT;
  await t.close();
});

const storedFiles = () => {
  try {
    return readdirSync(`${process.env.STORAGE_PATH}/files`).length;
  } catch {
    return 0;
  }
};

describe("file uploads", () => {
  test("a file is stored from the raw body and can be replaced", async () => {
    const page = (await owner.post("/pages", { spaceId, title: "Files" })).body.data.page;
    const up = await owner.uploadFile(new File(["first"], "a.txt", { type: "text/plain" }), page.id);
    expect(up.status).toBe(200);
    expect(up.body.data).toMatchObject({ name: "a.txt", size: 5, mime: "text/plain" });
    const replaced = await owner.uploadFile(new File(["second!"], "b.txt", { type: "text/plain" }), page.id, up.body.data.id);
    expect(replaced.body.data).toMatchObject({ id: up.body.data.id, name: "a.txt", size: 7 });
    const res = await owner.raw("GET", up.body.data.url.replace("/api", ""));
    expect(await res.text()).toBe("second!");
  });

  test("concurrent replacements leave exactly one stored object", async () => {
    const page = (await owner.post("/pages", { spaceId, title: "Race" })).body.data.page;
    const before = storedFiles();
    const up = await owner.uploadFile(new File(["v0"], "r.txt", { type: "text/plain" }), page.id);
    const results = await Promise.all(
      ["v1", "v2", "v3"].map((v) => owner.uploadFile(new File([v], "r.txt", { type: "text/plain" }), page.id, up.body.data.id)),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(storedFiles()).toBe(before + 1);
  });

  test("oversized uploads are refused without leaving bytes behind", async () => {
    const page = (await owner.post("/pages", { spaceId, title: "Big" })).body.data.page;
    process.env.FILE_SIZE_LIMIT = "1000";
    try {
      const before = storedFiles();
      const declared = await owner.uploadFile(new File([new Uint8Array(2000)], "big.bin"), page.id);
      expect(declared.status).toBe(413);
      // Without a declared length the limit is enforced while streaming.
      const chunks = [new Uint8Array(600), new Uint8Array(600)];
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.shift();
          if (next) controller.enqueue(next);
          else controller.close();
        },
      });
      const streamed = await owner.raw("POST", `/files?pageId=${page.id}&name=big.bin`, { body, headers: { "Content-Type": "application/octet-stream" }, duplex: "half" } as RequestInit);
      expect(streamed.status).toBe(413);
      expect(storedFiles()).toBe(before);
    } finally {
      delete process.env.FILE_SIZE_LIMIT;
    }
  });
});
