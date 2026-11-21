import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { startServer, type ApiResponse, type Client, type TestServer } from "./harness";
import { rawRequest } from "./harness/raw-http";
import { apiError } from "./harness/errors";

/**
 * `POST /files`: uploading a file to a page (src/server/routes/files.ts,
 * lib/files.ts `mimeFor`, lib/storage.ts `safeFileName` and the local driver).
 * Serving is in files-serving.test.ts, the S3 driver in storage-s3.test.ts.
 */

let t: TestServer;
/** A second copy of the server on the same database, refusing files over 1000 bytes. */
let small: TestServer;
let owner: Client;
let ownerId: string;
let spaceId: string;
let pageId: string;
let pageSlugId: string;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const text = async (res: Response): Promise<ApiResponse> => {
  const body = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed, headers: res.headers, text: body };
};

/** `POST /files?<query>` with the given body, as the app sends it. */
const upload = async (client: Client, query: Record<string, string>, body: BodyInit | null, type: string | null = "application/octet-stream") =>
  text(
    await client.raw("POST", `/files?${new URLSearchParams(query)}`, {
      body,
      headers: type === null ? {} : { "Content-Type": type },
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit),
  );

const newPage = async (title: string, space = spaceId, client = owner) => {
  const res = await client.post("/pages", { spaceId: space, title });
  expect(res.status).toBe(200);
  return res.body.data.page as { id: string; slugId: string };
};

/** Every file under the server's storage directory, relative to it. */
const stored = (server: TestServer): string[] => {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${rel}${entry.name}/`);
      else out.push(rel + entry.name);
    }
  };
  walk(server.storageDir, "");
  return out.sort();
};

/** Directories under `files/` (one per stored object, named after the object's id). */
const objectDirs = (server: TestServer): string[] => {
  const dir = path.join(server.storageDir, "files");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

const fileRow = async (id: string) => {
  const [row] = await t.sql`
    SELECT id, purpose, page_id, space_id, uploader_id, name, mime, size::int AS size, storage_key, created_at, updated_at
    FROM files WHERE id = ${id}`;
  return row;
};

const download = async (client: Client, url: string) => {
  const res = await client.raw("GET", url.slice("/api".length));
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
};

const chunked = (...parts: (Uint8Array | string)[]) => {
  const queue = parts.map((part) => (typeof part === "string" ? new TextEncoder().encode(part) : part));
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
};

const onSmall = (client: Client): Client => {
  const copy = small.client();
  copy.cookie = client.cookie;
  return copy;
};

beforeAll(async () => {
  t = await startServer();
  const setup = await t.setupOwner();
  owner = setup.owner;
  ownerId = setup.user.id;
  spaceId = setup.spaceId;
  ({ id: pageId, slugId: pageSlugId } = await newPage("Files"));
  small = await startServer({ keepDatabase: true, env: { FILE_SIZE_LIMIT: "1000" } });
});

afterAll(async () => {
  await small?.close();
  await t.close();
});

describe("POST /files: storing the request body", () => {
  test("the body is stored byte for byte and described in the answer", async () => {
    const bytes = new Uint8Array(1024).map((_, i) => i % 256);
    const res = await upload(owner, { pageId, name: "all bytes.bin" }, bytes);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { id: expect.stringMatching(UUID), name: "all bytes.bin", mime: "application/octet-stream", size: 1024, url: expect.any(String) },
    });
    const file = res.body.data;
    expect(file.url).toBe(`/api/files/${file.id}/all%20bytes.bin`);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    // On disk: <storage>/files/<file id>/<name>.
    expect(new Uint8Array(readFileSync(path.join(t.storageDir, "files", file.id, "all bytes.bin")))).toEqual(bytes);
    const row = await fileRow(file.id);
    expect(row).toEqual({
      id: file.id,
      purpose: "page",
      page_id: pageId,
      space_id: spaceId,
      uploader_id: ownerId,
      name: "all bytes.bin",
      mime: "application/octet-stream",
      size: 1024,
      storage_key: `files/${file.id}/all bytes.bin`,
      created_at: expect.any(Date),
      updated_at: expect.any(Date),
    });
    expect(row.updated_at.getTime()).toBe(row.created_at.getTime());

    const back = await download(owner, file.url);
    expect(back.status).toBe(200);
    expect(back.bytes).toEqual(bytes);
  });

  test("a body sent in chunks without a declared length is stored whole", async () => {
    const res = await upload(owner, { pageId, name: "chunks.txt" }, chunked("one ", "two ", "three"), "text/plain");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: expect.stringMatching(UUID), name: "chunks.txt", mime: "text/plain", size: 13, url: expect.any(String) });
    expect(readFileSync(path.join(t.storageDir, "files", res.body.data.id, "chunks.txt"), "utf8")).toBe("one two three");
  });

  test("a multipart form body is not parsed: its bytes are the file", async () => {
    const form = new FormData();
    form.append("file", new File(["inside"], "inner.txt", { type: "text/plain" }));
    const res = await text(await owner.raw("POST", `/files?pageId=${pageId}&name=form.bin`, { body: form }));
    expect(res.status).toBe(200);
    // The boundary parameter is dropped from the type.
    expect(res.body.data.mime).toBe("multipart/form-data");
    const onDisk = readFileSync(path.join(t.storageDir, "files", res.body.data.id, "form.bin"), "utf8");
    expect(onDisk).toContain('Content-Disposition: form-data; name="file"; filename="inner.txt"');
    expect(onDisk).toContain("inside");
    expect(res.body.data.size).toBe(Buffer.byteLength(onDisk));
  });

  test("a JSON body is stored as a file too", async () => {
    const res = await upload(owner, { pageId, name: "data.json" }, '{"a":1}', "application/json");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "data.json", mime: "application/json", size: 7 });
    expect(readFileSync(path.join(t.storageDir, "files", res.body.data.id, "data.json"), "utf8")).toBe('{"a":1}');
  });

  test("two uploads with the same name are two files", async () => {
    const first = (await upload(owner, { pageId, name: "same.txt" }, "first", "text/plain")).body.data;
    const second = (await upload(owner, { pageId, name: "same.txt" }, "second", "text/plain")).body.data;
    expect(second.id).not.toBe(first.id);
    expect(new TextDecoder().decode((await download(owner, first.url)).bytes)).toBe("first");
    expect(new TextDecoder().decode((await download(owner, second.url)).bytes)).toBe("second");
  });

  test("an empty body is refused, however it is sent, and nothing is stored", async () => {
    const before = stored(t);
    const [{ n: rowsBefore }] = await t.sql`SELECT count(*)::int AS n FROM files`;
    const expected = apiError("invalid_input", "The file is empty");
    const noBody = await upload(owner, { pageId, name: "empty.txt" }, null);
    expect([noBody.status, noBody.body]).toEqual([400, expected]);
    const emptyString = await upload(owner, { pageId, name: "empty.txt" }, "");
    expect([emptyString.status, emptyString.body]).toEqual([400, expected]);
    const emptyBytes = await upload(owner, { pageId, name: "empty.txt" }, new Uint8Array(0));
    expect([emptyBytes.status, emptyBytes.body]).toEqual([400, expected]);
    // No Content-Length and no body at all, and a declared length of zero.
    const head = `POST /api/files?pageId=${pageId}&name=empty.txt HTTP/1.1\nHost: localhost:${t.port}\nCookie: ${owner.cookieHeader()}\nContent-Type: text/plain`;
    const bare = await rawRequest(t.port, head);
    expect([bare.status, JSON.parse(bare.body)]).toEqual([400, expected]);
    const zero = await rawRequest(t.port, `${head}\nContent-Length: 0`);
    expect([zero.status, JSON.parse(zero.body)]).toEqual([400, expected]);
    expect(stored(t)).toEqual(before);
    const [{ n: rowsAfter }] = await t.sql`SELECT count(*)::int AS n FROM files`;
    expect(rowsAfter).toBe(rowsBefore);
  });

  test("a chunked body that ends at once makes a file of no bytes", async () => {
    const head = `POST /api/files?pageId=${pageId}&name=nothing.txt HTTP/1.1\nHost: localhost:${t.port}\nCookie: ${owner.cookieHeader()}\nContent-Type: text/plain\nTransfer-Encoding: chunked`;
    const res = await rawRequest(t.port, head, "0\r\n\r\n");
    // Accident: only a missing body counts as empty; a chunked body of length zero is stored.
    expect(res.status).toBe(200);
    const file = JSON.parse(res.body).data;
    expect(file).toEqual({ id: expect.stringMatching(UUID), name: "nothing.txt", mime: "text/plain", size: 0, url: expect.any(String) });
    expect((await fileRow(file.id)).size).toBe(0);
    const back = await download(owner, file.url);
    expect(back.status).toBe(200);
    expect(back.bytes.length).toBe(0);
    expect(back.headers.get("etag")).toMatch(new RegExp(`^"${file.id}-\\d+-0"$`));
    // No range of an empty file can be satisfied.
    const ranged = await owner.raw("GET", file.url.slice("/api".length), { headers: { Range: "bytes=0-" } });
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get("content-range")).toBe("bytes */0");
    await ranged.arrayBuffer();
  });

  test("the file belongs to the page given by id, in any letter case, or by slugId", async () => {
    const upper = await upload(owner, { pageId: pageId.toUpperCase(), name: "upper.txt" }, "x");
    expect(upper.status).toBe(200);
    expect((await fileRow(upper.body.data.id)).page_id).toBe(pageId);
    const bySlug = await upload(owner, { pageId: pageSlugId, name: "slug.txt" }, "x");
    expect(bySlug.status).toBe(200);
    expect((await fileRow(bySlug.body.data.id)).page_id).toBe(pageId);
  });
});

describe("POST /files: the query", () => {
  const invalid = (message: string) => apiError("invalid_input", message);
  const notFound = (what: string) => apiError("not_found", `${what} not found`);

  test("pageId is required and names a page", async () => {
    const missing = await text(await owner.raw("POST", "/files", { body: "x" }));
    expect([missing.status, missing.body]).toEqual([400, invalid("pageId must be a string")]);
    const nameOnly = await upload(owner, { name: "a.txt" }, "x");
    expect([nameOnly.status, nameOnly.body]).toEqual([400, invalid("pageId must be a string")]);
    const blank = await upload(owner, { pageId: "" }, "x");
    expect([blank.status, blank.body]).toEqual([400, invalid("pageId is required")]);
    const spaces = await upload(owner, { pageId: "   " }, "x");
    expect([spaces.status, spaces.body]).toEqual([400, invalid("pageId is required")]);
    const long = await upload(owner, { pageId: "a".repeat(65) }, "x");
    expect([long.status, long.body]).toEqual([400, invalid("pageId must be at most 64 characters")]);
    // 64 characters pass validation and then name no page.
    const atLimit = await upload(owner, { pageId: "a".repeat(64) }, "x");
    expect([atLimit.status, atLimit.body]).toEqual([404, notFound("Page")]);
    const notAnId = await upload(owner, { pageId: "not an id!" }, "x");
    expect([notAnId.status, notAnId.body]).toEqual([404, notFound("Page")]);
    const unknown = await upload(owner, { pageId: crypto.randomUUID() }, "x");
    expect([unknown.status, unknown.body]).toEqual([404, notFound("Page")]);
    const unknownSlug = await upload(owner, { pageId: "0000000000" }, "x");
    expect([unknownSlug.status, unknownSlug.body]).toEqual([404, notFound("Page")]);
  });

  test("the page id is trimmed", async () => {
    const res = await upload(owner, { pageId: `  ${pageId}  `, name: "trim.txt" }, "x");
    expect(res.status).toBe(200);
  });

  test("name defaults to `file` when absent and is refused when blank or too long", async () => {
    const absent = await upload(owner, { pageId }, "x");
    expect(absent.status).toBe(200);
    expect(absent.body.data).toEqual({
      id: expect.stringMatching(UUID),
      name: "file",
      mime: "application/octet-stream",
      size: 1,
      url: `/api/files/${absent.body.data.id}/file`,
    });
    const blank = await upload(owner, { pageId, name: "" }, "x");
    expect([blank.status, blank.body]).toEqual([400, invalid("name is required")]);
    const spaces = await upload(owner, { pageId, name: "  \t " }, "x");
    expect([spaces.status, spaces.body]).toEqual([400, invalid("name is required")]);
    const long = await upload(owner, { pageId, name: "n".repeat(1025) }, "x");
    expect([long.status, long.body]).toEqual([400, invalid("name must be at most 1024 characters")]);
  });

  test("the length of name counts code points, after trimming", async () => {
    // 1024 code points (1025 UTF-16 units) pass; the stored name is cut to 255.
    const atLimit = await upload(owner, { pageId, name: "n".repeat(1023) + "😀" }, "x");
    expect(atLimit.status).toBe(200);
    expect(atLimit.body.data.name).toBe("n".repeat(255));
    const over = await upload(owner, { pageId, name: "n".repeat(1024) + "😀" }, "x");
    expect([over.status, over.body]).toEqual([400, invalid("name must be at most 1024 characters")]);
    const padded = await upload(owner, { pageId, name: `  ${"n".repeat(1024)}  ` }, "x");
    expect(padded.status).toBe(200);
    expect(padded.body.data.name).toBe("n".repeat(255));
  });

  test("replaceId is refused when blank or too long, and names a file", async () => {
    const blank = await upload(owner, { pageId, replaceId: "" }, "x");
    expect([blank.status, blank.body]).toEqual([400, invalid("replaceId is required")]);
    const long = await upload(owner, { pageId, replaceId: "f".repeat(65) }, "x");
    expect([long.status, long.body]).toEqual([400, invalid("replaceId must be at most 64 characters")]);
    const notAnId = await upload(owner, { pageId, replaceId: "nope" }, "x");
    expect([notAnId.status, notAnId.body]).toEqual([404, notFound("File")]);
    const unknown = await upload(owner, { pageId, replaceId: crypto.randomUUID() }, "x");
    expect([unknown.status, unknown.body]).toEqual([404, notFound("File")]);
  });

  test("unknown query parameters are ignored", async () => {
    const res = await upload(owner, { pageId, name: "extra.txt", folder: "x", size: "999" }, "abc");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "extra.txt", size: 3 });
  });

  test("the page is checked before the body: a refused upload to an unknown page is 404 even when empty", async () => {
    const res = await upload(owner, { pageId: crypto.randomUUID() }, null);
    expect([res.status, res.body]).toEqual([404, notFound("Page")]);
  });
});

describe("POST /files: who may upload", () => {
  let reader: Client;
  let writer: Client;
  let admin: Client;
  let outsider: Client;

  beforeAll(async () => {
    const add = async (email: string, role: string | null) => {
      const member = await t.addMember(owner, email);
      if (role) {
        const added = await owner.post(`/spaces/${spaceId}/members/add`, { role, userIds: [member.user.id] });
        expect(added.status).toBe(200);
      }
      return member.client;
    };
    reader = await add("files-reader@example.com", "reader");
    writer = await add("files-writer@example.com", "writer");
    admin = await add("files-admin@example.com", "admin");
    outsider = await add("files-outsider@example.com", null);
  });

  test("without a session the upload is refused", async () => {
    const res = await upload(t.client(), { pageId, name: "a.txt" }, "x");
    expect(res.status).toBe(401);
    expect(res.body).toEqual(apiError("unauthorized", "Sign in required"));
  });

  test("someone outside the space cannot tell the page exists", async () => {
    const res = await upload(outsider, { pageId, name: "a.txt" }, "x");
    expect(res.status).toBe(404);
    expect(res.body).toEqual(apiError("not_found", "Page not found"));
  });

  test("a reader cannot upload", async () => {
    const res = await upload(reader, { pageId, name: "a.txt" }, "x");
    expect(res.status).toBe(403);
    expect(res.body).toEqual(apiError("forbidden", "You do not have permission to do this"));
  });

  test("a writer and a space admin can, and are recorded as the uploader", async () => {
    for (const client of [writer, admin]) {
      const res = await upload(client, { pageId, name: "mine.txt" }, "x", "text/plain");
      expect(res.status).toBe(200);
      const me = (await client.get("/me")).body.data.user.id;
      expect((await fileRow(res.body.data.id)).uploader_id).toBe(me);
    }
  });

  test("nobody can upload to a page in the trash", async () => {
    const page = await newPage("Trashed");
    expect((await owner.post(`/pages/${page.id}/delete`)).status).toBe(200);
    for (const client of [owner, writer]) {
      const res = await upload(client, { pageId: page.id, name: "a.txt" }, "x");
      expect(res.status).toBe(404);
      expect(res.body).toEqual(apiError("not_found", "Page not found"));
    }
    // The role is checked first: a reader is told they may not, not that the page is gone.
    const asReader = await upload(reader, { pageId: page.id, name: "a.txt" }, "x");
    expect(asReader.status).toBe(403);
    expect((await owner.post(`/pages/${page.id}/restore`)).status).toBe(200);
    expect((await upload(writer, { pageId: page.id, name: "a.txt" }, "x")).status).toBe(200);
  });

  test("a request from another site is refused before anything else", async () => {
    const res = await text(
      await owner.raw("POST", `/files?pageId=${pageId}&name=a.txt`, { body: "x", headers: { Origin: "https://evil.example", "Content-Type": "text/plain" } }),
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual(apiError("forbidden_origin", "Cross-origin request rejected"));
    const sameSite = await text(
      await owner.raw("POST", `/files?pageId=${pageId}&name=a.txt`, { body: "x", headers: { Origin: "http://doc.test", "Content-Type": "text/plain" } }),
    );
    expect(sameSite.status).toBe(200);
  });
});

describe("POST /files: the type of the file", () => {
  const mimeOf = async (name: string, type: string | null) => {
    const res = await upload(owner, { pageId, name }, "x", type);
    expect(res.status).toBe(200);
    return res.body.data.mime as string;
  };

  test.each([
    ["text/plain", "text/plain"],
    ["image/svg+xml", "image/svg+xml"],
    ["application/x-custom.thing+v1", "application/x-custom.thing+v1"],
    ["a!#$&^_.+-b/c!#$&^_.+-d", "a!#$&^_.+-b/c!#$&^_.+-d"],
    // Lower-cased, parameters and surrounding spaces dropped.
    ["TEXT/HTML; charset=UTF-8", "text/html"],
    ["Application/Vnd.API+JSON;v=1;q=0.5", "application/vnd.api+json"],
    ["  text/css  ", "text/css"],
    ["text/markdown ; charset=utf-8", "text/markdown"],
    // 127 characters on either side of the slash are the most a type may have.
    [`${"x".repeat(127)}/${"y".repeat(127)}`, `${"x".repeat(127)}/${"y".repeat(127)}`],
  ])("the declared type %p is kept as %p", async (declared, expected) => {
    expect(await mimeOf("m.png", declared)).toBe(expected);
  });

  test.each([
    ["application/octet-stream"],
    ["APPLICATION/OCTET-STREAM"],
    ["application/octet-stream; charset=binary"],
    ["nonsense"],
    ["a/b/c"],
    ["*/*"],
    ["text/*"],
    ["/plain"],
    ["text/"],
    ["text/pl ain"],
    ["text/plain,text/html"],
    ["-text/plain"],
    ["text/.plain"],
    ["tëxt/plain"],
    [`${"x".repeat(128)}/y`],
    [`x/${"y".repeat(128)}`],
    ["; charset=utf-8"],
  ])("the declared type %p is not trusted: the extension decides", async (declared) => {
    expect(await mimeOf("m.png", declared)).toBe("image/png");
    expect(await mimeOf("m.unknownext", declared)).toBe("application/octet-stream");
  });

  test("without a Content-Type header the extension decides", async () => {
    expect(await mimeOf("m.pdf", null)).toBe("application/pdf");
    expect(await mimeOf("m", null)).toBe("application/octet-stream");
  });

  test.each([
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["avif", "image/avif"],
    ["bmp", "image/bmp"],
    ["ico", "image/x-icon"],
    ["svg", "image/svg+xml"],
    ["pdf", "application/pdf"],
    ["mp3", "audio/mpeg"],
    ["wav", "audio/wav"],
    ["ogg", "audio/ogg"],
    ["m4a", "audio/mp4"],
    ["mp4", "video/mp4"],
    ["webm", "video/webm"],
    ["mov", "video/quicktime"],
    ["txt", "text/plain"],
    ["md", "text/markdown"],
    ["csv", "text/csv"],
    ["json", "application/json"],
    ["html", "text/html"],
    ["htm", "text/html"],
    ["xml", "application/xml"],
    ["zip", "application/zip"],
    ["doc", "application/msword"],
    ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["xls", "application/vnd.ms-excel"],
    ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["ppt", "application/vnd.ms-powerpoint"],
    ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["drawio", "application/vnd.jgraph.mxfile"],
    ["excalidraw", "application/json"],
  ])("a file ending in .%s is %s", async (extension, expected) => {
    expect(await mimeOf(`document.${extension}`, "application/octet-stream")).toBe(expected);
  });

  test("the extension is what follows the last dot, in any letter case", async () => {
    expect(await mimeOf("PHOTO.JPG", "application/octet-stream")).toBe("image/jpeg");
    expect(await mimeOf("Report.Final.PdF", "application/octet-stream")).toBe("application/pdf");
    expect(await mimeOf("archive.tar.gz", "application/octet-stream")).toBe("application/octet-stream");
    expect(await mimeOf("image.png.txt", "application/octet-stream")).toBe("text/plain");
    expect(await mimeOf("ends-with-dot.", "application/octet-stream")).toBe("application/octet-stream");
    expect(await mimeOf("no-extension", "application/octet-stream")).toBe("application/octet-stream");
    expect(await mimeOf("x.tiff", "application/octet-stream")).toBe("application/octet-stream");
    expect(await mimeOf("x.exe", "application/octet-stream")).toBe("application/octet-stream");
  });

  test("a name without a dot is its own extension", async () => {
    // Accident: `png` (also what `.png` is sanitised to) is taken for an image, `file` is not in the table.
    expect(await mimeOf("png", "application/octet-stream")).toBe("image/png");
    expect(await mimeOf(".pdf", "application/octet-stream")).toBe("application/pdf");
    expect(await mimeOf("HTML", "application/octet-stream")).toBe("text/html");
  });
});

describe("POST /files: the stored name", () => {
  const nameOf = async (name: string) => {
    const res = await upload(owner, { pageId, name }, "x");
    expect([name, res.status]).toEqual([name, 200]);
    const file = res.body.data as { id: string; name: string; url: string };
    // The URL carries the name percent-encoded, and the object is stored under it.
    expect(file.url).toBe(`/api/files/${file.id}/${encodeURIComponent(file.name)}`);
    expect((await fileRow(file.id)).storage_key).toBe(`files/${file.id}/${file.name}`);
    expect(stored(t)).toContain(`files/${file.id}/${file.name}`);
    return file.name;
  };

  test.each([
    ["plain.txt", "plain.txt"],
    ["With Spaces & Symbols #1 (final) [v2]+=;,.txt", "With Spaces & Symbols #1 (final) [v2]+=;,.txt"],
    // Path separators are removed, not replaced.
    ["a/b\\c.txt", "abc.txt"],
    ["../../etc/passwd", "etcpasswd"],
    ["..\\..\\windows\\system32", "windowssystem32"],
    ["dir/", "dir"],
    // Control characters are removed.
    ["tab\there\nand\rthere\u0000\u001f\u007f.txt", "tabhereandthere.txt"],
    // Leading dots and spaces are removed, inner and trailing dots stay.
    [".hidden", "hidden"],
    ["...  . ..many.txt", "many.txt"],
    [". .env.local", "env.local"],
    ["a..b...c", "a..b...c"],
    ["trailing.dot.", "trailing.dot."],
    // Nothing left: `file`.
    ["..", "file"],
    [". . .", "file"],
    ["///", "file"],
    ["\u0001\u0002", "file"],
    ["/.\\.", "file"],
    // Percent signs and quotes are ordinary characters.
    ["100%.txt", "100%.txt"],
    ["a%2Fb", "a%2Fb"],
    ['say "hi".txt', 'say "hi".txt'],
    ["it's.txt", "it's.txt"],
    ["a?b#c&d=e.txt", "a?b#c&d=e.txt"],
    ["semi;colon.txt", "semi;colon.txt"],
    // Any script.
    ["naïve résumé.pdf", "naïve résumé.pdf"],
    ["日本語のファイル.txt", "日本語のファイル.txt"],
    ["emoji 😀🎉.png", "emoji 😀🎉.png"],
    ["مرحبا بالعالم.txt", "مرحبا بالعالم.txt"],
    ["עברית.txt", "עברית.txt"],
    // Other Unicode controls and spaces are kept (only U+0000–U+001F and U+007F go).
    ["zero​width.txt", "zero​width.txt"],
    ["c1\u0085control.txt", "c1\u0085control.txt"],
    ["nb sp.txt", "nb sp.txt"],
  ])("%p is stored as %p", async (given, expected) => {
    expect(await nameOf(given)).toBe(expected);
  });

  test("the name is normalised to NFC", async () => {
    expect(await nameOf("été.txt")).toBe("été.txt");
    expect(await nameOf("한.txt")).toBe("한.txt");
    expect(await nameOf("Å.txt")).toBe("Å.txt");
    // Compatibility characters are not folded (NFC, not NFKC).
    expect(await nameOf("ﬁle ①.txt")).toBe("ﬁle ①.txt");
  });

  test("a leading space that only shows after trimming Unicode space is removed too", async () => {
    // U+00A0 and U+3000 count as white space at the start and at the end.
    expect(await nameOf(" 　 padded.txt　")).toBe("padded.txt");
    expect(await nameOf("﻿bom.txt")).toBe("bom.txt");
  });

  test("a name of 255 characters is kept, a longer one is cut to 255 keeping its extension", async () => {
    expect(await nameOf("k".repeat(251) + ".txt")).toBe("k".repeat(251) + ".txt");
    expect(await nameOf("k".repeat(255))).toBe("k".repeat(255));
    expect(await nameOf("k".repeat(252) + ".txt")).toBe("k".repeat(251) + ".txt");
    expect(await nameOf("k".repeat(300) + ".txt")).toBe("k".repeat(251) + ".txt");
    expect(await nameOf("k".repeat(1000) + ".tar.gz")).toBe("k".repeat(252) + ".gz");
    expect(await nameOf("k".repeat(300))).toBe("k".repeat(255));
    expect(await nameOf("k".repeat(256))).toBe("k".repeat(255));
  });

  test("an extension is kept only up to 15 characters after the dot", async () => {
    const ext15 = "." + "e".repeat(15);
    const ext16 = "." + "e".repeat(16);
    expect(await nameOf("k".repeat(300) + ext15)).toBe("k".repeat(239) + ext15);
    // Too long to be an extension: the name is simply cut.
    expect(await nameOf("k".repeat(300) + ext16)).toBe("k".repeat(255));
    // The last dot decides, wherever it is.
    expect(await nameOf("k".repeat(10) + "." + "z".repeat(300))).toBe("k".repeat(10) + "." + "z".repeat(244));
    expect(await nameOf("k".repeat(300) + ".")).toBe("k".repeat(254) + ".");
  });

  test("a name whose bytes do not fit a file name of the storage directory fails", async () => {
    const before = stored(t);
    // 100 characters, 300 bytes.
    const res = await upload(owner, { pageId, name: "文".repeat(100) + ".txt" }, "x");
    // Accident: the local driver stores under the name itself, and the file system refuses names over 255 bytes.
    expect(res.status).toBe(500);
    expect(res.body).toEqual(apiError("internal_error", "Something went wrong"));
    expect(stored(t)).toEqual(before);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM files WHERE name LIKE '文%'`;
    expect(n).toBe(0);
    // 85 such characters fit.
    expect(await nameOf("文".repeat(83) + ".txt")).toBe("文".repeat(83) + ".txt");
  });
});

describe("POST /files: the size limit", () => {
  const tooLarge = (limit: number) => apiError("payload_too_large", `Files must be at most ${limit} bytes`);

  test("a file of exactly FILE_SIZE_LIMIT bytes is accepted", async () => {
    const res = await upload(onSmall(owner), { pageId, name: "limit.bin" }, new Uint8Array(1000).fill(7));
    expect(res.status).toBe(200);
    expect(res.body.data.size).toBe(1000);
    expect(readFileSync(path.join(small.storageDir, "files", res.body.data.id, "limit.bin")).length).toBe(1000);
    const streamed = await upload(onSmall(owner), { pageId, name: "limit-streamed.bin" }, chunked(new Uint8Array(500), new Uint8Array(500)));
    expect(streamed.status).toBe(200);
    expect(streamed.body.data.size).toBe(1000);
  });

  test("a declared length over the limit is refused before anything is stored", async () => {
    const before = stored(small);
    const dirs = objectDirs(small);
    const [{ n: rowsBefore }] = await t.sql`SELECT count(*)::int AS n FROM files`;
    const res = await upload(onSmall(owner), { pageId, name: "big.bin" }, new Uint8Array(1001));
    expect(res.status).toBe(413);
    expect(res.body).toEqual(tooLarge(1000));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(stored(small)).toEqual(before);
    expect(objectDirs(small)).toEqual(dirs);
    const [{ n: rowsAfter }] = await t.sql`SELECT count(*)::int AS n FROM files`;
    expect(rowsAfter).toBe(rowsBefore);
  });

  test("a body that turns out longer than the limit is refused and what was written is removed", async () => {
    const before = stored(small);
    const dirs = objectDirs(small);
    const [{ n: rowsBefore }] = await t.sql`SELECT count(*)::int AS n FROM files`;
    const res = await upload(onSmall(owner), { pageId, name: "streamed.bin" }, chunked(new Uint8Array(600), new Uint8Array(600)));
    expect(res.status).toBe(413);
    expect(res.body).toEqual(tooLarge(1000));
    const oneByteOver = await upload(onSmall(owner), { pageId, name: "streamed.bin" }, chunked(new Uint8Array(1000), new Uint8Array(1)));
    expect(oneByteOver.status).toBe(413);
    expect(oneByteOver.body).toEqual(tooLarge(1000));
    expect(stored(small)).toEqual(before);
    // The directory made for the object is gone too.
    expect(objectDirs(small)).toEqual(dirs);
    const [{ n: rowsAfter }] = await t.sql`SELECT count(*)::int AS n FROM files`;
    expect(rowsAfter).toBe(rowsBefore);
  });

  test("a body far over the limit is refused with 413 as well", async () => {
    const before = stored(small);
    // More than FILE_SIZE_LIMIT + 2 MiB: the request is turned away before the handler runs.
    const res = await upload(onSmall(owner), { pageId, name: "huge.bin" }, new Uint8Array(3 * 1024 * 1024));
    // Accident: this answer has no JSON body.
    expect(res.status).toBe(413);
    expect(stored(small)).toEqual(before);
  });

  test("the limit is 50 MiB unless configured", async () => {
    const head = (length: number) =>
      `POST /api/files?pageId=${pageId}&name=declared.bin HTTP/1.1\nHost: localhost:${t.port}\nCookie: ${owner.cookieHeader()}\nContent-Type: application/octet-stream\nContent-Length: ${length}`;
    // Only the declared length is sent; the server answers without waiting for a body.
    const over = await rawRequest(t.port, head(50 * 1024 * 1024 + 1));
    expect(over.status).toBe(413);
    expect(JSON.parse(over.body)).toEqual(tooLarge(52428800));
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM files WHERE name = 'declared.bin'`;
    expect(n).toBe(0);
  });

  test("the permission check comes before the size check", async () => {
    const res = await upload(small.client(), { pageId, name: "big.bin" }, new Uint8Array(1001));
    expect(res.status).toBe(401);
    const unknownPage = await upload(onSmall(owner), { pageId: crypto.randomUUID(), name: "big.bin" }, new Uint8Array(1001));
    expect(unknownPage.status).toBe(404);
  });
});

describe("POST /files?replaceId: replacing a file's content", () => {
  const original = async (name = "diagram.drawio", content = "version one", type = "application/octet-stream", page = pageId) => {
    const res = await upload(owner, { pageId: page, name }, content, type);
    expect(res.status).toBe(200);
    return res.body.data as { id: string; name: string; mime: string; size: number; url: string };
  };

  test("the file keeps its id, name and URL and gets the new bytes, size and type", async () => {
    const file = await original();
    expect(file.mime).toBe("application/vnd.jgraph.mxfile");
    const before = await fileRow(file.id);
    const res = await upload(owner, { pageId, replaceId: file.id, name: "ignored.png" }, "version two, longer", "text/xml; charset=utf-8");
    expect(res.status).toBe(200);
    // `name` is not looked at when replacing.
    expect(res.body).toEqual({ data: { id: file.id, name: "diagram.drawio", mime: "text/xml", size: 19, url: file.url } });

    const after = await fileRow(file.id);
    expect(after).toMatchObject({ id: file.id, name: "diagram.drawio", mime: "text/xml", size: 19, page_id: pageId, space_id: spaceId, uploader_id: ownerId });
    expect(after.created_at.getTime()).toBe(before.created_at.getTime());
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());

    // The new object is stored beside the old one, which is removed with its directory.
    expect(after.storage_key).toMatch(/^files\/[0-9a-f-]{36}\/diagram\.drawio$/);
    expect(after.storage_key).not.toBe(before.storage_key);
    expect(existsSync(path.join(t.storageDir, before.storage_key))).toBe(false);
    expect(existsSync(path.join(t.storageDir, "files", file.id))).toBe(false);
    expect(readFileSync(path.join(t.storageDir, after.storage_key), "utf8")).toBe("version two, longer");

    const back = await download(owner, file.url);
    expect(new TextDecoder().decode(back.bytes)).toBe("version two, longer");
    expect(back.headers.get("content-type")).toBe("text/xml");
  });

  test("with no usable declared type, the type comes from the file's own name", async () => {
    const file = await original("photo.png", "one", "image/png");
    const res = await upload(owner, { pageId, replaceId: file.id, name: "other.pdf" }, "two", "application/octet-stream");
    expect(res.body.data).toEqual({ id: file.id, name: "photo.png", mime: "image/png", size: 3, url: file.url });
    const untyped = await upload(owner, { pageId, replaceId: file.id }, "three", null);
    expect(untyped.body.data.mime).toBe("image/png");
    const typed = await upload(owner, { pageId, replaceId: file.id }, "four", "image/webp");
    expect(typed.body.data.mime).toBe("image/webp");
  });

  test("a file can be replaced again and again; each time only one object remains", async () => {
    const file = await original("again.txt", "0", "text/plain");
    const dirsBefore = objectDirs(t).length;
    for (const content of ["1", "22", "333"]) {
      const res = await upload(owner, { pageId, replaceId: file.id }, content, "text/plain");
      expect(res.status).toBe(200);
      expect(res.body.data.size).toBe(content.length);
      expect(objectDirs(t).length).toBe(dirsBefore);
    }
    expect(new TextDecoder().decode((await download(owner, file.url)).bytes)).toBe("333");
  });

  test("the id may be written in upper case", async () => {
    const file = await original("upper.txt", "one", "text/plain");
    const res = await upload(owner, { pageId, replaceId: file.id.toUpperCase() }, "two", "text/plain");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(file.id);
  });

  test("the page given only has to be in the file's space", async () => {
    const other = await newPage("Another page of the space");
    const file = await original("cross-page.txt", "one", "text/plain");
    const res = await upload(owner, { pageId: other.id, replaceId: file.id }, "two", "text/plain");
    expect(res.status).toBe(200);
    // The file stays on its own page.
    expect((await fileRow(file.id)).page_id).toBe(pageId);
  });

  test("a file of another space is not found", async () => {
    const created = await owner.post("/spaces", { name: "Files elsewhere", slug: "files-elsewhere" });
    expect(created.status).toBe(200);
    const otherSpace = created.body.data.space.id as string;
    const otherPage = await newPage("Elsewhere", otherSpace);
    const elsewhere = await original("elsewhere.txt", "one", "text/plain", otherPage.id);
    const res = await upload(owner, { pageId, replaceId: elsewhere.id }, "two", "text/plain");
    expect(res.status).toBe(404);
    expect(res.body).toEqual(apiError("not_found", "File not found"));
    expect(new TextDecoder().decode((await download(owner, elsewhere.url)).bytes)).toBe("one");
    // And the other way round.
    const here = await original("here.txt", "one", "text/plain");
    const reverse = await upload(owner, { pageId: otherPage.id, replaceId: here.id }, "two", "text/plain");
    expect(reverse.status).toBe(404);
  });

  test("an image that is not a page file (an avatar) cannot be replaced", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const avatar = await owner.upload("/me/avatar", { file: new File([png], "me.png", { type: "image/png" }) });
    expect(avatar.status).toBe(200);
    const [row] = await t.sql`SELECT id FROM files WHERE purpose = 'avatar' ORDER BY created_at DESC LIMIT 1`;
    const res = await upload(owner, { pageId, replaceId: row.id }, "x", "image/png");
    expect(res.status).toBe(404);
    expect(res.body).toEqual(apiError("not_found", "File not found"));
  });

  test("an empty replacement is refused and the file stays as it was", async () => {
    const file = await original("keep.txt", "keep me", "text/plain");
    const res = await upload(owner, { pageId, replaceId: file.id }, null, "text/plain");
    expect(res.status).toBe(400);
    expect(res.body).toEqual(apiError("invalid_input", "The file is empty"));
    expect(new TextDecoder().decode((await download(owner, file.url)).bytes)).toBe("keep me");
  });

  test("a replacement over the size limit leaves the file as it was", async () => {
    const client = onSmall(owner);
    const first = await upload(client, { pageId, name: "guarded.txt" }, "small enough", "text/plain");
    expect(first.status).toBe(200);
    const file = first.body.data;
    const before = stored(small);
    const dirs = objectDirs(small);
    const row = await fileRow(file.id);

    const declared = await upload(client, { pageId, replaceId: file.id }, new Uint8Array(1001), "text/plain");
    expect(declared.status).toBe(413);
    expect(declared.body).toEqual(apiError("payload_too_large", "Files must be at most 1000 bytes"));
    const streamed = await upload(client, { pageId, replaceId: file.id }, chunked(new Uint8Array(600), new Uint8Array(600)), "text/plain");
    expect(streamed.status).toBe(413);
    expect(streamed.body).toEqual(apiError("payload_too_large", "Files must be at most 1000 bytes"));

    expect(stored(small)).toEqual(before);
    expect(objectDirs(small)).toEqual(dirs);
    expect(await fileRow(file.id)).toEqual(row);
    expect(readFileSync(path.join(small.storageDir, row.storage_key), "utf8")).toBe("small enough");
  });

  test("replacements racing each other all succeed and leave exactly one object", async () => {
    const file = await original("race.txt", "v0", "text/plain");
    const dirsBefore = objectDirs(t).length;
    const versions = ["v1-a", "v2-bb", "v3-ccc", "v4-dddd", "v5-eeeee"];
    const results = await Promise.all(versions.map((v) => upload(owner, { pageId, replaceId: file.id }, v, "text/plain")));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    for (const [i, r] of results.entries()) {
      expect(r.body.data).toEqual({ id: file.id, name: "race.txt", mime: "text/plain", size: versions[i]!.length, url: file.url });
    }
    expect(objectDirs(t).length).toBe(dirsBefore);
    // What is served is one of the versions, whole, and the row describes it.
    const row = await fileRow(file.id);
    const onDisk = readFileSync(path.join(t.storageDir, row.storage_key), "utf8");
    expect(versions).toContain(onDisk);
    expect(row.size).toBe(onDisk.length);
    expect(new TextDecoder().decode((await download(owner, file.url)).bytes)).toBe(onDisk);
  });
});

describe("a page's files when the page is duplicated or deleted", () => {
  const put = async (page: string, name: string, content: string) => {
    const res = await upload(owner, { pageId: page, name }, content, "text/plain");
    expect(res.status).toBe(200);
    return res.body.data as { id: string; name: string; url: string };
  };

  test("duplicating a page copies its files and points the copy's document at them", async () => {
    const page = await newPage("Original with files");
    const other = await newPage("Another page");
    const mine = await put(page.id, "mine one.txt", "mine");
    const replaced = await put(page.id, "replaced.txt", "old");
    expect((await upload(owner, { pageId: page.id, replaceId: replaced.id }, "new", "text/plain")).status).toBe(200);
    const foreign = await put(other.id, "foreign.txt", "foreign");
    const content = {
      type: "doc",
      content: [
        { type: "attachment", attrs: { url: `${mine.url}?v=2#top`, name: "mine one.txt", attachmentId: mine.id.toUpperCase() } },
        { type: "image", attrs: { src: `/api/files/${replaced.id.toUpperCase()}/any-name.png`, attachmentId: replaced.id } },
        { type: "image", attrs: { src: foreign.url, attachmentId: foreign.id } },
        { type: "image", attrs: { src: "https://example.com/remote.png", attachmentId: "not-a-file" } },
        {
          type: "paragraph",
          content: [{ type: "text", text: "commented link", marks: [{ type: "comment", attrs: { commentId: "c1" } }, { type: "link", attrs: { href: mine.url } }] }],
        },
      ],
    };
    expect((await owner.post(`/pages/${page.id}/content`, { content })).status).toBe(200);
    const filesBefore = stored(t);

    const res = await owner.post(`/pages/${page.id}/duplicate`, {});
    expect(res.status).toBe(200);
    const copy = res.body.data.page;
    expect(copy.title).toBe("Copy of Original with files");
    const rows = await t.sql`SELECT id, name, mime, size::int AS size, storage_key, space_id, uploader_id FROM files WHERE page_id = ${copy.id} ORDER BY name`;
    expect(rows.length).toBe(2);
    const [mineCopy, replacedCopy] = [...rows] as { id: string; name: string; storage_key: string }[];
    expect(rows[0]).toEqual({ id: expect.stringMatching(UUID), name: "mine one.txt", mime: "text/plain", size: 4, storage_key: `files/${mineCopy!.id}/mine one.txt`, space_id: spaceId, uploader_id: ownerId });
    expect(rows[1]).toEqual({ id: expect.stringMatching(UUID), name: "replaced.txt", mime: "text/plain", size: 3, storage_key: `files/${replacedCopy!.id}/replaced.txt`, space_id: spaceId, uploader_id: ownerId });
    expect(mineCopy!.id).not.toBe(mine.id);

    // The copies are files of their own on disk; the originals are untouched.
    expect(stored(t)).toEqual([...filesBefore, `files/${mineCopy!.id}/mine one.txt`, `files/${replacedCopy!.id}/replaced.txt`].sort());
    expect(readFileSync(path.join(t.storageDir, "files", mineCopy!.id, "mine one.txt"), "utf8")).toBe("mine");
    expect(readFileSync(path.join(t.storageDir, "files", replacedCopy!.id, "replaced.txt"), "utf8")).toBe("new");

    expect(copy.content).toEqual({
      type: "doc",
      content: [
        // The rest of the URL, its query and fragment are kept; ids are matched in any letter case.
        { type: "attachment", attrs: { url: `/api/files/${mineCopy!.id}/mine%20one.txt?v=2#top`, name: "mine one.txt", attachmentId: mineCopy!.id } },
        { type: "image", attrs: { src: `/api/files/${replacedCopy!.id}/any-name.png`, attachmentId: replacedCopy!.id } },
        // Files of other pages and other addresses stay as they are.
        { type: "image", attrs: { src: foreign.url, attachmentId: foreign.id } },
        { type: "image", attrs: { src: "https://example.com/remote.png", attachmentId: "not-a-file" } },
        // Comment marks are dropped; a link to a file is a mark and is not rewritten.
        { type: "paragraph", content: [{ type: "text", text: "commented link", marks: [{ type: "link", attrs: { href: mine.url } }] }] },
      ],
    });
    expect(new TextDecoder().decode((await download(owner, `/api/files/${mineCopy!.id}/x`)).bytes)).toBe("mine");
  });

  test("a page in the trash keeps its files on disk; deleting it for good removes them, descendants' included", async () => {
    const root = await newPage("Doomed with files");
    const childRes = await owner.post("/pages", { spaceId, title: "Doomed child", parentId: root.id });
    const child = childRes.body.data.page as { id: string };
    const a = await put(root.id, "a.txt", "a");
    const b = await put(child.id, "b.txt", "b");
    const replaced = await put(child.id, "c.txt", "old");
    expect((await upload(owner, { pageId: child.id, replaceId: replaced.id }, "new", "text/plain")).status).toBe(200);
    const replacedKey = (await fileRow(replaced.id)).storage_key as string;
    const survivor = await put(pageId, "survivor.txt", "stays");

    expect((await owner.post(`/pages/${root.id}/delete`)).status).toBe(200);
    for (const key of [`files/${a.id}/a.txt`, `files/${b.id}/b.txt`, replacedKey]) expect(stored(t)).toContain(key);
    expect((await owner.post(`/pages/${root.id}/delete-permanently`)).status).toBe(200);
    for (const key of [`files/${a.id}/a.txt`, `files/${b.id}/b.txt`, replacedKey]) expect(stored(t)).not.toContain(key);
    // Their directories are gone as well.
    for (const dir of [a.id, b.id, replacedKey.split("/")[1]!]) expect(objectDirs(t)).not.toContain(dir);
    expect(stored(t)).toContain(`files/${survivor.id}/survivor.txt`);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM files WHERE id IN (${a.id}, ${b.id}, ${replaced.id})`;
    expect(n).toBe(0);
    const gone = await owner.get(`/files/${a.id}/a.txt`);
    expect(gone.status).toBe(404);
  });

  test("deleting a space removes its pages' files from disk", async () => {
    const created = await owner.post("/spaces", { name: "Short-lived files", slug: "short-lived-files" });
    const space = created.body.data.space.id as string;
    const page = await newPage("In the space", space);
    const file = await put(page.id, "in-space.txt", "x");
    const elsewhere = await put(pageId, "elsewhere.txt", "stays");
    expect(stored(t)).toContain(`files/${file.id}/in-space.txt`);
    expect((await owner.post(`/spaces/${space}/delete`)).status).toBe(200);
    expect(stored(t)).not.toContain(`files/${file.id}/in-space.txt`);
    expect(objectDirs(t)).not.toContain(file.id);
    expect(stored(t)).toContain(`files/${elsewhere.id}/elsewhere.txt`);
    expect(await fileRow(file.id)).toBeUndefined();
  });
});
