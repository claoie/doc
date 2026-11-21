import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { startServer, type Client, type TestServer } from "./harness";
import { startFakeS3, type FakeS3 } from "./harness/s3";
import { readZip } from "./harness/zip";
import { apiError } from "./harness/errors";

/**
 * `STORAGE_DRIVER=s3` (src/server/lib/storage.ts): the server keeps files and
 * images in an S3-compatible store. The store is the fake of harness/s3.ts,
 * which checks every request's signature and is the oracle for what ended up
 * stored. The tests say nothing about how a server uploads (one PUT or parts,
 * copy or read-and-write), only about what the bucket holds afterwards.
 */

const MIB = 1024 * 1024;
const LIMIT = 12 * MIB;

let s3: FakeS3;
let t: TestServer;
/** A second copy of the server on the same database and bucket, refusing files over 1000 bytes. */
let small: TestServer;
let owner: Client;
let spaceId: string;
let pageId: string;

interface Uploaded {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

/** Bytes that differ everywhere, so parts in the wrong order or a shifted range would show. */
const noise = (length: number) => {
  const out = new Uint8Array(length);
  for (let at = 0; at < length; at += 65536) crypto.getRandomValues(out.subarray(at, Math.min(length, at + 65536)));
  return out;
};

const same = (a: Uint8Array | null | undefined, b: Uint8Array) => !!a && a.length === b.length && Buffer.compare(a, b) === 0;

const streamOf = (bytes: Uint8Array, chunk = 256 * 1024) => {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(at, Math.min(bytes.length, at + chunk)));
      at += chunk;
    },
  });
};

const post = async (client: Client, query: Record<string, string>, body: BodyInit, type = "application/octet-stream") => {
  const res = await client.raw("POST", `/files?${new URLSearchParams(query)}`, {
    body,
    headers: { "Content-Type": type },
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: json };
};

const put = async (name: string, body: BodyInit | Uint8Array, type = "application/octet-stream", page = pageId): Promise<Uploaded> => {
  const res = await post(owner, { pageId: page, name }, body as BodyInit, type);
  expect(res.status).toBe(200);
  return res.body.data;
};

const get = async (client: Client, url: string, init: RequestInit = {}) => {
  const res = await client.raw(init.method ?? "GET", url.slice("/api".length), init);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: () => new TextDecoder().decode(bytes) };
};

const newPage = async (title: string, extra: Record<string, unknown> = {}) => {
  const res = await owner.post("/pages", { spaceId, title, ...extra });
  expect(res.status).toBe(200);
  return res.body.data.page as { id: string; slugId: string; content: any };
};

const storageKey = async (fileId: string): Promise<string> => {
  const [row] = await t.sql`SELECT storage_key FROM files WHERE id = ${fileId}`;
  return row.storage_key;
};

const fileRows = async () => (await t.sql`SELECT count(*)::int AS n FROM files`)[0].n as number;

const onSmall = (client: Client) => {
  const copy = small.client();
  copy.cookie = client.cookie;
  return copy;
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const GIF = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0, 59]);

beforeAll(async () => {
  s3 = await startFakeS3();
  t = await startServer({ env: { ...s3.env, FILE_SIZE_LIMIT: String(LIMIT) } });
  const setup = await t.setupOwner();
  owner = setup.owner;
  spaceId = setup.spaceId;
  pageId = (await newPage("S3")).id;
  small = await startServer({ keepDatabase: true, env: { ...s3.env, FILE_SIZE_LIMIT: "1000" } });
});

afterAll(async () => {
  await small?.close();
  await t?.close();
  await s3?.stop();
});

describe("uploads end up in the bucket", () => {
  test("a small file is one object under files/<id>/<name>, and nothing is written to the local disk", async () => {
    const bytes = new TextEncoder().encode("hello, bucket");
    const file = await put("hello.txt", bytes, "text/plain");
    expect(file).toEqual({ id: expect.any(String), name: "hello.txt", mime: "text/plain", size: 13, url: `/api/files/${file.id}/hello.txt` });
    expect(await storageKey(file.id)).toBe(`files/${file.id}/hello.txt`);
    expect(s3.keys()).toContain(`files/${file.id}/hello.txt`);
    expect(same(s3.read(`files/${file.id}/hello.txt`), bytes)).toBe(true);
    expect(s3.pendingUploads()).toEqual([]);
    expect(existsSync(t.storageDir) ? readdirSync(t.storageDir) : []).toEqual([]);
    const back = await get(owner, file.url);
    expect(back.status).toBe(200);
    expect(back.text()).toBe("hello, bucket");
  });

  test.each([
    ["two  spaces and (parens).txt"],
    ["plus+and&ampersand=equals;semi,comma@at$dollar.txt"],
    ["bang!quote'star*tilde~.txt"],
    ["question?mark#hash.txt"],
    ["percent % and %41 %zz.txt"],
    ['colon:pipe|angle<>quote".txt'],
    ["[brackets]{braces}^caret`tick.txt"],
    ["ünï cödé 文字 😀 مرحبا.txt"],
  ])("the name %p is the object's key as it is", async (name) => {
    const bytes = new TextEncoder().encode(`content of ${name}`);
    const file = await put(name, bytes, "text/plain");
    expect(file.name).toBe(name);
    expect(same(s3.read(`files/${file.id}/${name}`), bytes)).toBe(true);
    expect(s3.keys().filter((key) => key.startsWith(`files/${file.id}/`))).toEqual([`files/${file.id}/${name}`]);
    const back = await get(owner, file.url);
    expect([back.status, back.text()]).toEqual([200, `content of ${name}`]);
    const ranged = await get(owner, file.url, { headers: { Range: "bytes=0-6" } });
    expect([ranged.status, ranged.text()]).toEqual([206, "content"]);
  });

  test("a name of more than 255 bytes can be stored here", async () => {
    // (The local driver cannot: the file system limits names to 255 bytes.)
    const name = "文".repeat(90) + ".txt";
    const file = await put(name, "x", "text/plain");
    expect(file.name).toBe(name);
    expect(s3.keys()).toContain(`files/${file.id}/${name}`);
    expect((await get(owner, file.url)).text()).toBe("x");
    // Longer names in such scripts are not tried: the Bun server answers 200 for them without storing anything.
  });

  test("when a long name is cut, the extension is measured in UTF-16 units and the name in code points", async () => {
    // ".😀😀😀😀😀😀😀a" is 16 UTF-16 units (9 code points): still an extension.
    const kept = await put("k".repeat(300) + "." + "😀".repeat(7) + "a", "x");
    expect(kept.name).toBe("k".repeat(246) + "." + "😀".repeat(7) + "a");
    expect([...kept.name].length).toBe(255);
    // ".😀😀😀😀😀😀😀😀" is 17 units: not an extension, the name is simply cut.
    const dropped = await put("k".repeat(300) + "." + "😀".repeat(8), "x");
    expect(dropped.name).toBe("k".repeat(255));
    expect(s3.keys()).toContain(`files/${kept.id}/${kept.name}`);
  });

  test.each([
    ["exactly 5 MiB", 5 * MIB],
    ["5 MiB and one byte", 5 * MIB + 1],
    ["over 5 MiB", 6 * MIB + 123],
    ["over 10 MiB", 11 * MIB + 7],
    ["exactly the limit", LIMIT],
  ])(
    "a file of %s is stored whole",
    async (_label, size) => {
      const bytes = noise(size);
      const file = await put(`large-${size}.bin`, bytes);
      expect(file.size).toBe(size);
      const key = `files/${file.id}/large-${size}.bin`;
      expect(s3.objects.get(key)?.body.length).toBe(size);
      expect(same(s3.read(key), bytes)).toBe(true);
      expect(s3.pendingUploads()).toEqual([]);
      const [row] = await t.sql`SELECT size::int AS size, storage_key FROM files WHERE id = ${file.id}`;
      expect(row).toEqual({ size, storage_key: key });
      const back = await get(owner, file.url);
      expect(back.status).toBe(200);
      expect(same(back.bytes, bytes)).toBe(true);
    },
    30_000,
  );

  test(
    "a large body sent in chunks without a declared length is stored whole",
    async () => {
      const bytes = noise(11 * MIB + 4321);
      const res = await post(owner, { pageId, name: "streamed.bin" }, streamOf(bytes));
      expect(res.status).toBe(200);
      expect(res.body.data.size).toBe(bytes.length);
      expect(same(s3.read(`files/${res.body.data.id}/streamed.bin`), bytes)).toBe(true);
      expect(s3.pendingUploads()).toEqual([]);
    },
    30_000,
  );

  test("an empty body is refused before the store is asked anything", async () => {
    s3.clearRequests();
    const res = await owner.raw("POST", `/files?pageId=${pageId}&name=empty.txt`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(apiError("invalid_input", "The file is empty"));
    expect(s3.requests).toEqual([]);
  });
});

describe("downloads come from the bucket", () => {
  let bytes: Uint8Array;
  let file: Uploaded;

  beforeAll(async () => {
    bytes = noise(5 * MIB + 300_000);
    file = await put("ranges.bin", bytes, "video/mp4");
  });

  test("the whole file with the headers of a file", async () => {
    const res = await get(owner, file.url);
    expect(res.status).toBe(200);
    expect(same(res.bytes, bytes)).toBe(true);
    const [row] = await t.sql`SELECT updated_at FROM files WHERE id = ${file.id}`;
    const updated = new Date(row.updated_at);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-disposition")).toBe("inline; filename=\"ranges.bin\"; filename*=UTF-8''ranges.bin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("etag")).toBe(`"${file.id}-${updated.getTime()}-${bytes.length}"`);
    expect(res.headers.get("last-modified")).toBe(updated.toUTCString());
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
  });

  test.each([
    ["bytes=0-99", 0, 99],
    ["bytes=1000-1999", 1000, 1999],
    // Across the 5 MiB mark, where a multipart upload has its seam.
    [`bytes=${5 * MIB - 10}-${5 * MIB + 9}`, 5 * MIB - 10, 5 * MIB + 9],
    [`bytes=${5 * MIB}-`, 5 * MIB, 5 * MIB + 299_999],
    ["bytes=-500", 5 * MIB + 299_500, 5 * MIB + 299_999],
    [`bytes=${5 * MIB + 299_999}-`, 5 * MIB + 299_999, 5 * MIB + 299_999],
    ["bytes=5542870-99999999", 5542870, 5 * MIB + 299_999],
  ])("Range: %s answers exactly those bytes", async (range, start, end) => {
    const res = await get(owner, file.url, { headers: { Range: range } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
    expect(res.bytes.length).toBe(end - start + 1);
    expect(same(res.bytes, bytes.subarray(start, end + 1))).toBe(true);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  test("ranges that cannot be satisfied, conditions and HEAD behave as with local storage", async () => {
    const etag = (await get(owner, file.url, { method: "HEAD" })).headers.get("etag")!;
    const unsatisfiable = await get(owner, file.url, { headers: { Range: `bytes=${bytes.length}-` } });
    expect([unsatisfiable.status, unsatisfiable.bytes.length]).toEqual([416, 0]);
    expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
    const notModified = await get(owner, file.url, { headers: { "If-None-Match": etag } });
    expect([notModified.status, notModified.bytes.length]).toEqual([304, 0]);
    const ifRange = await get(owner, file.url, { headers: { Range: "bytes=0-9", "If-Range": etag } });
    expect([ifRange.status, ifRange.bytes.length]).toEqual([206, 10]);
    const stale = await get(owner, file.url, { headers: { Range: "bytes=0-9", "If-Range": '"stale"' } });
    expect([stale.status, stale.bytes.length]).toEqual([200, bytes.length]);
    const malformed = await get(owner, file.url, { headers: { Range: "bytes=1-2,5-6" } });
    expect([malformed.status, malformed.bytes.length]).toEqual([200, bytes.length]);
    const head = await get(owner, file.url, { method: "HEAD" });
    expect([head.status, head.bytes.length]).toEqual([200, 0]);
    expect(head.headers.get("content-type")).toBe("video/mp4");
    const headRange = await get(owner, file.url, { method: "HEAD", headers: { Range: "bytes=5-9" } });
    expect(headRange.status).toBe(206);
    expect(headRange.headers.get("content-range")).toBe(`bytes 5-9/${bytes.length}`);
  });

  test("a share key opens the file to someone without a session", async () => {
    const shared = await owner.post(`/pages/${pageId}/share`, {});
    const key = shared.body.data.share.key as string;
    const res = await t.client().raw("GET", `${file.url.slice("/api".length)}?share=${key}`, { headers: { Range: "bytes=10-19" } });
    expect(res.status).toBe(206);
    expect(same(new Uint8Array(await res.arrayBuffer()), bytes.subarray(10, 20))).toBe(true);
    expect((await owner.post(`/pages/${pageId}/share/delete`)).status).toBe(200);
  });

  test("a file whose object is gone from the bucket is 404", async () => {
    const lost = await put("lost.txt", "soon gone", "text/plain");
    expect((await get(owner, lost.url)).status).toBe(200);
    expect(s3.objects.delete(`files/${lost.id}/lost.txt`)).toBe(true);
    const res = await owner.get(lost.url.slice("/api".length));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(apiError("not_found", "File not found"));
    const head = await get(owner, lost.url, { method: "HEAD" });
    expect(head.status).toBe(404);
  });
});

describe("the size limit", () => {
  test("a declared length over the limit is refused without writing to the bucket", async () => {
    const rows = await fileRows();
    const keys = s3.keys();
    s3.clearRequests();
    const res = await post(owner, { pageId, name: "declared.bin" }, new Uint8Array(LIMIT + 1));
    expect(res.status).toBe(413);
    expect(res.body).toEqual(apiError("payload_too_large", `Files must be at most ${LIMIT} bytes`));
    expect(s3.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD")).toEqual([]);
    expect(s3.keys()).toEqual(keys);
    expect(await fileRows()).toBe(rows);
  }, 30_000);

  test(
    "a streamed body that runs over the limit leaves nothing in the bucket, whole or in parts",
    async () => {
      const rows = await fileRows();
      const keys = s3.keys();
      // By the time the limit is passed, 12 MiB have been handed to the store.
      const res = await post(owner, { pageId, name: "runaway.bin" }, streamOf(noise(LIMIT + 1)));
      expect(res.status).toBe(413);
      expect(res.body).toEqual(apiError("payload_too_large", `Files must be at most ${LIMIT} bytes`));
      expect(s3.keys()).toEqual(keys);
      expect(s3.pendingUploads()).toEqual([]);
      expect(await fileRows()).toBe(rows);
    },
    30_000,
  );

  test("the same holds for a small limit and a short body", async () => {
    const rows = await fileRows();
    const keys = s3.keys();
    const client = onSmall(owner);
    const atLimit = await post(client, { pageId, name: "limit.bin" }, streamOf(new Uint8Array(1000).fill(3), 400));
    expect(atLimit.status).toBe(200);
    expect(same(s3.read(`files/${atLimit.body.data.id}/limit.bin`), new Uint8Array(1000).fill(3))).toBe(true);
    const over = await post(client, { pageId, name: "over.bin" }, streamOf(new Uint8Array(1001), 400));
    expect(over.status).toBe(413);
    expect(over.body).toEqual(apiError("payload_too_large", "Files must be at most 1000 bytes"));
    expect(s3.keys()).toEqual([...keys, `files/${atLimit.body.data.id}/limit.bin`].sort());
    expect(s3.pendingUploads()).toEqual([]);
    expect(await fileRows()).toBe(rows + 1);
  });

  test("a replacement over the limit leaves the file's object as it was", async () => {
    const client = onSmall(owner);
    const first = await post(client, { pageId, name: "guarded.txt" }, "small enough", "text/plain");
    const file = first.body.data as Uploaded;
    const key = await storageKey(file.id);
    const keys = s3.keys();
    const res = await post(client, { pageId, replaceId: file.id }, streamOf(new Uint8Array(1500), 400), "text/plain");
    expect(res.status).toBe(413);
    expect(s3.keys()).toEqual(keys);
    expect(s3.pendingUploads()).toEqual([]);
    expect(await storageKey(file.id)).toBe(key);
    expect((await get(owner, file.url)).text()).toBe("small enough");
  });
});

describe("replacing a file", () => {
  test("the new bytes are an object of their own and the old object is deleted", async () => {
    const file = await put("diagram.drawio", "version one");
    const oldKey = await storageKey(file.id);
    const before = s3.keys().length;
    const res = await post(owner, { pageId, replaceId: file.id }, "version two!", "application/xml");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: file.id, name: "diagram.drawio", mime: "application/xml", size: 12, url: file.url });
    const newKey = await storageKey(file.id);
    expect(newKey).not.toBe(oldKey);
    expect(newKey).toMatch(/^files\/[0-9a-f-]{36}\/diagram\.drawio$/);
    expect(s3.objects.has(oldKey)).toBe(false);
    expect(new TextDecoder().decode(s3.read(newKey)!)).toBe("version two!");
    expect(s3.keys().length).toBe(before);
    expect((await get(owner, file.url)).text()).toBe("version two!");
  });

  test(
    "a large file can replace a small one and the other way round",
    async () => {
      const file = await put("grows.bin", "tiny");
      const before = s3.keys().length;
      const large = noise(6 * MIB);
      expect((await post(owner, { pageId, replaceId: file.id }, large)).status).toBe(200);
      expect(same(s3.read(await storageKey(file.id)), large)).toBe(true);
      expect((await post(owner, { pageId, replaceId: file.id }, "tiny again")).status).toBe(200);
      expect(new TextDecoder().decode(s3.read(await storageKey(file.id))!)).toBe("tiny again");
      expect(s3.keys().length).toBe(before);
      expect(s3.pendingUploads()).toEqual([]);
    },
    30_000,
  );

  test("replacements racing each other leave exactly one object", async () => {
    const file = await put("race.txt", "v0", "text/plain");
    const before = s3.keys().length;
    const versions = ["v1-a", "v2-bb", "v3-ccc", "v4-dddd"];
    const results = await Promise.all(versions.map((v) => post(owner, { pageId, replaceId: file.id }, v, "text/plain")));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(s3.keys().length).toBe(before);
    const kept = new TextDecoder().decode(s3.read(await storageKey(file.id))!);
    expect(versions).toContain(kept);
    expect((await get(owner, file.url)).text()).toBe(kept);
  });
});

describe("deleting", () => {
  test("a page in the trash keeps its objects; deleting it for good removes them, descendants' included", async () => {
    const root = await newPage("Doomed");
    const child = await newPage("Doomed child", { parentId: root.id });
    const a = await put("a.txt", "a", "text/plain", root.id);
    const b = await put("b.bin", noise(5 * MIB + 5), "application/octet-stream", child.id);
    const other = await put("survivor.txt", "stays", "text/plain");
    expect((await owner.post(`/pages/${root.id}/delete`)).status).toBe(200);
    expect(s3.objects.has(`files/${a.id}/a.txt`)).toBe(true);
    expect(s3.objects.has(`files/${b.id}/b.bin`)).toBe(true);
    expect((await owner.post(`/pages/${root.id}/delete-permanently`)).status).toBe(200);
    expect(s3.objects.has(`files/${a.id}/a.txt`)).toBe(false);
    expect(s3.objects.has(`files/${b.id}/b.bin`)).toBe(false);
    expect(s3.objects.has(`files/${other.id}/survivor.txt`)).toBe(true);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM files WHERE id IN (${a.id}, ${b.id})`;
    expect(n).toBe(0);
  }, 30_000);

  test("deleting a space removes the objects of its files and its icon", async () => {
    const created = await owner.post("/spaces", { name: "Short-lived", slug: "short-lived" });
    const space = created.body.data.space.id as string;
    const page = (await owner.post("/pages", { spaceId: space, title: "In the space" })).body.data.page;
    const file = await put("in-space.txt", "x", "text/plain", page.id);
    const replaced = await put("replaced.txt", "one", "text/plain", page.id);
    expect((await post(owner, { pageId: page.id, replaceId: replaced.id }, "two", "text/plain")).status).toBe(200);
    const replacedKey = await storageKey(replaced.id);
    const icon = await owner.upload(`/spaces/${space}/icon`, { file: new File([PNG], "icon.png") });
    const iconName = (icon.body.data.space.iconUrl as string).slice("/api/images/".length);
    expect(s3.objects.has(`images/${iconName}`)).toBe(true);
    const elsewhere = await put("elsewhere.txt", "stays", "text/plain");

    expect((await owner.post(`/spaces/${space}/delete`)).status).toBe(200);
    expect(s3.objects.has(`files/${file.id}/in-space.txt`)).toBe(false);
    expect(s3.objects.has(replacedKey)).toBe(false);
    expect(s3.objects.has(`images/${iconName}`)).toBe(false);
    expect(s3.objects.has(`files/${elsewhere.id}/elsewhere.txt`)).toBe(true);
  });
});

describe("duplicating a page with files", () => {
  test(
    "every file is copied to an object of its own, and the copy's document points at it",
    async () => {
      const page = await newPage("Original with files");
      const smallBytes = new TextEncoder().encode("small file");
      const largeBytes = noise(5 * MIB + 1234);
      const smallFile = await put("small one.txt", smallBytes, "text/plain", page.id);
      const largeFile = await put("large.bin", largeBytes, "application/octet-stream", page.id);
      const content = {
        type: "doc",
        content: [
          { type: "attachment", attrs: { url: smallFile.url, name: smallFile.name, attachmentId: smallFile.id } },
          { type: "video", attrs: { src: largeFile.url, attachmentId: largeFile.id } },
        ],
      };
      const source = await newPage("Original document", { content });
      // The files belong to the page that is duplicated.
      await t.sql`UPDATE files SET page_id = ${source.id} WHERE id IN (${smallFile.id}, ${largeFile.id})`;

      const keysBefore = s3.keys();
      const res = await owner.post(`/pages/${source.id}/duplicate`, {});
      expect(res.status).toBe(200);
      const copy = res.body.data.page;
      const [attachment, video] = copy.content.content;
      const copiedSmall = attachment.attrs.attachmentId as string;
      const copiedLarge = video.attrs.attachmentId as string;
      expect(copiedSmall).not.toBe(smallFile.id);
      expect(copiedLarge).not.toBe(largeFile.id);
      expect(attachment.attrs.url).toBe(`/api/files/${copiedSmall}/small%20one.txt`);
      expect(video.attrs.src).toBe(`/api/files/${copiedLarge}/large.bin`);

      expect(s3.keys()).toEqual([...keysBefore, `files/${copiedSmall}/small one.txt`, `files/${copiedLarge}/large.bin`].sort());
      expect(same(s3.read(`files/${copiedSmall}/small one.txt`), smallBytes)).toBe(true);
      expect(same(s3.read(`files/${copiedLarge}/large.bin`), largeBytes)).toBe(true);
      expect(same(s3.read(`files/${smallFile.id}/small one.txt`), smallBytes)).toBe(true);
      expect(s3.pendingUploads()).toEqual([]);

      const rows = await t.sql`SELECT id, page_id, name, mime, size::int AS size, storage_key FROM files WHERE page_id = ${copy.id} ORDER BY name`;
      expect([...rows]).toEqual([
        { id: copiedLarge, page_id: copy.id, name: "large.bin", mime: "application/octet-stream", size: largeBytes.length, storage_key: `files/${copiedLarge}/large.bin` },
        { id: copiedSmall, page_id: copy.id, name: "small one.txt", mime: "text/plain", size: 10, storage_key: `files/${copiedSmall}/small one.txt` },
      ]);
      const served = await get(owner, video.attrs.src);
      expect(same(served.bytes, largeBytes)).toBe(true);

      // The copy and the original are independent.
      expect((await owner.post(`/pages/${source.id}/delete`)).status).toBe(200);
      expect((await owner.post(`/pages/${source.id}/delete-permanently`)).status).toBe(200);
      expect(s3.objects.has(`files/${smallFile.id}/small one.txt`)).toBe(false);
      expect((await get(owner, attachment.attrs.url)).text()).toBe("small file");
    },
    30_000,
  );

  test("a replaced file is copied from where its bytes now are", async () => {
    const page = await newPage("Original with a replaced file");
    const file = await put("replaced.txt", "one", "text/plain", page.id);
    expect((await post(owner, { pageId: page.id, replaceId: file.id }, "two", "text/plain")).status).toBe(200);
    const res = await owner.post(`/pages/${page.id}/duplicate`, {});
    expect(res.status).toBe(200);
    const [row] = await t.sql`SELECT id, storage_key FROM files WHERE page_id = ${res.body.data.page.id}`;
    expect(row.storage_key).toBe(`files/${row.id}/replaced.txt`);
    expect(new TextDecoder().decode(s3.read(row.storage_key)!)).toBe("two");
  });
});

describe("avatars, logos and icons", () => {
  test("an image is an object under images/, served to anyone, and removed when replaced or removed", async () => {
    const member = (await t.addMember(owner, "s3-avatar@example.com")).client;
    const uploaded = await member.upload("/me/avatar", { file: new File([PNG], "me.png", { type: "image/png" }) });
    expect(uploaded.status).toBe(200);
    const first = (uploaded.body.data.user.avatarUrl as string).slice("/api/images/".length);
    expect(first).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(same(s3.read(`images/${first}`), PNG)).toBe(true);

    const served = await t.client().raw("GET", `/images/${first}`);
    expect(served.status).toBe(200);
    expect(same(new Uint8Array(await served.arrayBuffer()), PNG)).toBe(true);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(served.headers.get("etag")).toBe(`"${first}"`);
    const ranged = await t.client().raw("GET", `/images/${first}`, { headers: { Range: "bytes=1-3" } });
    expect(ranged.status).toBe(206);
    expect(same(new Uint8Array(await ranged.arrayBuffer()), PNG.subarray(1, 4))).toBe(true);

    const replaced = await member.upload("/me/avatar", { file: new File([GIF], "me.gif") });
    const second = (replaced.body.data.user.avatarUrl as string).slice("/api/images/".length);
    expect(second).toMatch(/\.gif$/);
    expect(s3.objects.has(`images/${first}`)).toBe(false);
    expect(same(s3.read(`images/${second}`), GIF)).toBe(true);
    expect((await t.client().get(`/images/${first}`)).status).toBe(404);

    expect((await member.post("/me/avatar/remove")).status).toBe(200);
    expect(s3.objects.has(`images/${second}`)).toBe(false);
    const gone = await t.client().get(`/images/${second}`);
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual(apiError("not_found", "Image not found"));
  });

  test("the workspace logo is kept the same way", async () => {
    const res = await owner.upload("/workspace/logo", { file: new File([PNG], "logo.png") });
    const name = (res.body.data.workspace.logoUrl as string).slice("/api/images/".length);
    expect(same(s3.read(`images/${name}`), PNG)).toBe(true);
    expect((await owner.post("/workspace/logo/remove")).status).toBe(200);
    expect(s3.objects.has(`images/${name}`)).toBe(false);
  });

  test("an image of 10 MiB is stored whole", async () => {
    const big = noise(10 * MIB);
    big.set(PNG);
    const member = (await t.addMember(owner, "s3-big-avatar@example.com")).client;
    const res = await member.upload("/me/avatar", { file: new File([big], "big.png") });
    expect(res.status).toBe(200);
    const name = (res.body.data.user.avatarUrl as string).slice("/api/images/".length);
    expect(same(s3.read(`images/${name}`), big)).toBe(true);
    expect(s3.pendingUploads()).toEqual([]);
  }, 30_000);
});

describe("exporting with files", () => {
  test(
    "the archive holds the bytes the bucket holds, and leaves out a file whose object is gone",
    async () => {
      const page = await newPage("Export from the bucket");
      const smallBytes = new TextEncoder().encode("attached text");
      const largeBytes = noise(5 * MIB + 99);
      const smallFile = await put("notes.txt", smallBytes, "text/plain", page.id);
      const largeFile = await put("clip.mp4", largeBytes, "video/mp4", page.id);
      const lostFile = await put("lost.png", PNG, "image/png", page.id);
      const content = {
        type: "doc",
        content: [
          { type: "attachment", attrs: { url: smallFile.url, name: "notes.txt" } },
          { type: "video", attrs: { src: largeFile.url } },
          { type: "image", attrs: { src: lostFile.url } },
        ],
      };
      const exported = await newPage("Export me", { content });
      await t.sql`UPDATE files SET page_id = ${exported.id} WHERE id IN (${smallFile.id}, ${largeFile.id}, ${lostFile.id})`;
      s3.objects.delete(`files/${lostFile.id}/lost.png`);

      const res = await owner.raw("GET", `/pages/${exported.id}/export?files=1`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/zip");
      const entries = readZip(new Uint8Array(await res.arrayBuffer()));
      expect(entries.map((e) => e.name).sort()).toEqual(["Export me.md", `files/${largeFile.id}/clip.mp4`, `files/${smallFile.id}/notes.txt`].sort());
      expect(entries[0]!.name).toBe("Export me.md");
      expect(entries[0]!.text).toBe(
        `# Export me\n\n[notes.txt](files/${smallFile.id}/notes.txt)\n\n[clip.mp4](files/${largeFile.id}/clip.mp4)\n\n![](files/${lostFile.id}/lost.png)\n`,
      );
      expect(same(entries.find((e) => e.name.endsWith("notes.txt"))!.data, smallBytes)).toBe(true);
      expect(same(entries.find((e) => e.name.endsWith("clip.mp4"))!.data, largeBytes)).toBe(true);
    },
    30_000,
  );
});

describe("how the server talks to the store", () => {
  test("every request was addressed path-style to the bucket and carried a valid Signature Version 4", async () => {
    // Covers everything the tests above sent, and one round of its own: the fake has refused none of it.
    const file = await put("signed.txt", "signed", "text/plain");
    expect((await get(owner, file.url, { headers: { Range: "bytes=1-2" } })).text()).toBe("ig");
    expect(s3.requests.length).toBeGreaterThan(1);
    const refused = s3.requests.filter((r) => r.error && !["NoSuchKey"].includes(r.error));
    expect(refused.map((r) => [r.method, r.path, r.status, r.error])).toEqual([]);
    for (const request of s3.requests) {
      expect(request.path.startsWith(`/${s3.bucket}/`)).toBe(true);
      expect(request.headers.authorization).toMatch(
        new RegExp(`^AWS4-HMAC-SHA256 Credential=${s3.accessKeyId}/\\d{8}/${s3.region}/s3/aws4_request,\\s*SignedHeaders=[a-z0-9;-]+,\\s*Signature=[0-9a-f]{64}$`),
      );
      expect(request.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
      expect(request.headers["x-amz-content-sha256"]).toBeDefined();
    }
  });
});

describe("a server whose credentials the store refuses", () => {
  test("cannot store or read anything", async () => {
    const file = await put("readable.txt", "readable", "text/plain");
    const bad = await startServer({ keepDatabase: true, env: { ...s3.env, S3_SECRET_ACCESS_KEY: "not-the-secret" } });
    try {
      const client = bad.client();
      client.cookie = owner.cookie;
      const rows = await fileRows();
      const keys = s3.keys();
      s3.clearRequests();
      const res = await post(client, { pageId, name: "refused.txt" }, "x", "text/plain");
      expect(res.status).toBe(500);
      expect(res.body).toEqual(apiError("internal_error", "Something went wrong"));
      expect(s3.requests.length).toBeGreaterThan(0);
      expect(s3.requests.every((r) => r.status === 403 && r.error === "SignatureDoesNotMatch")).toBe(true);
      expect(s3.keys()).toEqual(keys);
      expect(await fileRows()).toBe(rows);
      // Accident: a store that refuses to say whether an object exists reads as a missing file.
      const read = await client.get(file.url.slice("/api".length));
      expect(read.status).toBe(404);
      expect(read.body).toEqual(apiError("not_found", "File not found"));
    } finally {
      await bad.close();
      s3.clearRequests();
    }
  });
});

describe("when the store cannot be reached", () => {
  let offline: FakeS3;
  let server: TestServer;
  let client: Client;
  let page: { id: string };
  let file: Uploaded;
  let avatarUrl: string;

  beforeAll(async () => {
    offline = await startFakeS3({ bucket: "offline-bucket" });
    server = await startServer({ keepDatabase: true, env: offline.env });
    client = server.client();
    client.cookie = owner.cookie;
    page = await newPage("Offline");
    const uploaded = await post(client, { pageId: page.id, name: "stranded.txt" }, "stranded", "text/plain");
    expect(uploaded.status).toBe(200);
    file = uploaded.body.data;
    const avatar = await client.upload("/me/avatar", { file: new File([PNG], "me.png") });
    expect(avatar.status).toBe(200);
    avatarUrl = avatar.body.data.user.avatarUrl;
    await offline.stop();
  });

  afterAll(async () => {
    await server?.close();
  });

  const INTERNAL = apiError("internal_error", "Something went wrong");

  test("an upload fails with 500 and records nothing", async () => {
    const rows = await fileRows();
    const res = await post(client, { pageId: page.id, name: "unreachable.txt" }, "x", "text/plain");
    expect([res.status, res.body]).toEqual([500, INTERNAL]);
    const large = await post(client, { pageId: page.id, name: "unreachable.bin" }, new Uint8Array(6 * MIB));
    expect([large.status, large.body]).toEqual([500, INTERNAL]);
    expect(await fileRows()).toBe(rows);
  }, 30_000);

  test("a replacement fails with 500 and the file's row is unchanged", async () => {
    const [before] = await t.sql`SELECT storage_key, size::int AS size, updated_at FROM files WHERE id = ${file.id}`;
    const res = await post(client, { pageId: page.id, replaceId: file.id }, "replacement", "text/plain");
    expect([res.status, res.body]).toEqual([500, INTERNAL]);
    const [after] = await t.sql`SELECT storage_key, size::int AS size, updated_at FROM files WHERE id = ${file.id}`;
    expect(after).toEqual(before);
  });

  test("files and images read as missing", async () => {
    // Accident: any failure to look an object up is answered like a missing object.
    const res = await client.get(file.url.slice("/api".length));
    expect([res.status, res.body]).toEqual([404, apiError("not_found", "File not found")]);
    const image = await server.client().get(avatarUrl.slice("/api".length));
    expect([image.status, image.body]).toEqual([404, apiError("not_found", "Image not found")]);
  });

  test("a new avatar fails with 500 and the old one stays", async () => {
    const res = await client.upload("/me/avatar", { file: new File([GIF], "me.gif") });
    expect([res.status, res.body]).toEqual([500, INTERNAL]);
    expect((await client.get("/me")).body.data.user.avatarUrl).toBe(avatarUrl);
  });

  test("duplicating a page with files fails with 500 and makes no page", async () => {
    const res = await client.post(`/pages/${page.id}/duplicate`, {});
    expect([res.status, res.body]).toEqual([500, INTERNAL]);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM pages WHERE title = 'Copy of Offline'`;
    expect(n).toBe(0);
    // A page without files does not need the store.
    const plain = await newPage("Offline without files");
    expect((await client.post(`/pages/${plain.id}/duplicate`, {})).status).toBe(200);
  });

  test("an export with files still answers, without the files it could not read", async () => {
    const content = { type: "doc", content: [{ type: "attachment", attrs: { url: file.url, name: "stranded.txt" } }] };
    expect((await client.post(`/pages/${page.id}/content`, { content })).status).toBeOneOf([200, 503]);
    const res = await client.raw("GET", `/pages/${page.id}/export?files=1`);
    expect(res.status).toBe(200);
    const entries = readZip(new Uint8Array(await res.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual(["Offline.md"]);
  });

  test("deleting the page for good succeeds and forgets its files", async () => {
    expect((await client.post(`/pages/${page.id}/delete`)).status).toBe(200);
    const res = await client.post(`/pages/${page.id}/delete-permanently`);
    expect([res.status, res.body]).toEqual([200, { data: {} }]);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM files WHERE id = ${file.id}`;
    expect(n).toBe(0);
    // Removing the avatar succeeds as well.
    const removed = await client.post("/me/avatar/remove");
    expect(removed.status).toBe(200);
    expect(removed.body.data.user.avatarUrl).toBeNull();
  });
});
