import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";
import { startServer, type Client, type TestServer } from "./harness";
import { apiError } from "./harness/errors";

/**
 * `GET /files/:id/:name`: serving a page's file from the local storage driver
 * (src/server/routes/files.ts, lib/files.ts `serveObject`, lib/shares.ts
 * `shareAllowsPage`). Uploading is in files.test.ts.
 */

let t: TestServer;
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

const SANDBOX = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

const newPage = async (title: string, parentId?: string, space = spaceId) => {
  const res = await owner.post("/pages", { spaceId: space, title, parentId });
  expect(res.status).toBe(200);
  return res.body.data.page as { id: string; slugId: string };
};

const put = async (name: string, body: BodyInit, type = "application/octet-stream", page = pageId): Promise<Uploaded> => {
  const res = await owner.raw("POST", `/files?${new URLSearchParams({ pageId: page, name })}`, { body, headers: { "Content-Type": type } });
  expect(res.status).toBe(200);
  return (await res.json()).data;
};

const fetchFile = async (client: Client, file: Pick<Uploaded, "url">, init: RequestInit & { query?: string } = {}) => {
  const { query = "", ...rest } = init;
  const res = await client.raw(rest.method ?? "GET", file.url.slice("/api".length) + query, rest);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: new TextDecoder().decode(bytes) };
};

const share = async (id: string, includeChildren = false) => {
  const res = await owner.post(`/pages/${id}/share`, { includeChildren });
  expect(res.status).toBe(200);
  return res.body.data.share.key as string;
};

const FILE_NOT_FOUND = apiError("not_found", "File not found");

beforeAll(async () => {
  t = await startServer();
  const setup = await t.setupOwner();
  owner = setup.owner;
  spaceId = setup.spaceId;
  pageId = (await newPage("Serving")).id;
});

afterAll(async () => {
  await t.close();
});

describe("GET /files/:id/:name: the answer", () => {
  let file: Uploaded;

  beforeAll(async () => {
    file = await put("hello world.txt", "0123456789", "text/plain");
  });

  test("the whole file with every header", async () => {
    const res = await fetchFile(owner, file);
    expect(res.status).toBe(200);
    expect(res.text).toBe("0123456789");
    const [row] = await t.sql`SELECT updated_at FROM files WHERE id = ${file.id}`;
    const updated = new Date(row.updated_at);
    expect(Object.fromEntries([...res.headers].filter(([name]) => name !== "date"))).toEqual({
      "content-type": "text/plain",
      "content-disposition": "attachment; filename=\"hello world.txt\"; filename*=UTF-8''hello%20world.txt",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-cache",
      "accept-ranges": "bytes",
      etag: `"${file.id}-${updated.getTime()}-10"`,
      "last-modified": updated.toUTCString(),
      "content-security-policy": SANDBOX,
      "content-length": "10",
    });
    // The ETag is `"<file id>-<milliseconds of the last change>-<size>"`.
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f-]{36}-\d{13}-10"$/);
    expect(res.headers.get("last-modified")).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  });

  test("HEAD answers the same headers and no body", async () => {
    const got = await fetchFile(owner, file);
    const head = await fetchFile(owner, file, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.bytes.length).toBe(0);
    const pick = (headers: Headers) => Object.fromEntries([...headers].filter(([name]) => name !== "date"));
    expect(pick(head.headers)).toEqual(pick(got.headers));
    expect(head.headers.get("content-length")).toBe("10");
  });

  test("the name in the URL is not looked at", async () => {
    for (const name of ["other.bin", "hello%20world.txt", "x.png", "%E6%96%87.pdf", "a%2Fb", "..."]) {
      const res = await fetchFile(owner, { url: `/api/files/${file.id}/${name}` });
      expect([name, res.status, res.text]).toEqual([name, 200, "0123456789"]);
      // Type and download name are the stored ones.
      expect(res.headers.get("content-type")).toBe("text/plain");
      expect(res.headers.get("content-disposition")).toBe("attachment; filename=\"hello world.txt\"; filename*=UTF-8''hello%20world.txt");
    }
  });

  test("but a name there must be, in one segment, and well-formed", async () => {
    const endpoint = apiError("not_found", "Endpoint not found");
    for (const suffix of ["", "/", "/a/b", "/a/b/", "/%E0%A4%A", "/%zz", "/%ff"]) {
      const res = await owner.get(`/files/${file.id}${suffix}`);
      expect([suffix, res.status, res.body]).toEqual([suffix, 404, endpoint]);
    }
    // Empty segments do not count: a trailing or doubled slash changes nothing.
    for (const pathname of [`/files/${file.id}/a/`, `/files//${file.id}//a`]) {
      const res = await owner.raw("GET", pathname);
      expect([pathname, res.status, await res.text()]).toEqual([pathname, 200, "0123456789"]);
    }
  });

  test("the id may be written in upper case; anything else that is not a file's id is 404", async () => {
    const upper = await fetchFile(owner, { url: `/api/files/${file.id.toUpperCase()}/x` });
    expect(upper.status).toBe(200);
    expect(upper.headers.get("etag")).toStartWith(`"${file.id}-`);
    for (const id of ["nope", "123", file.id.replace(/-/g, ""), `${file.id}0`, `{${file.id}}`, crypto.randomUUID(), "00000000-0000-0000-0000-000000000000"]) {
      const res = await owner.get(`/files/${id}/x`);
      expect([id, res.status, res.body]).toEqual([id, 404, FILE_NOT_FOUND]);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("other methods are no endpoint", async () => {
    const res = await owner.post(file.url.slice("/api".length), {});
    expect(res.status).toBe(404);
    expect(res.body).toEqual(apiError("not_found", "Endpoint not found"));
  });

  test("an avatar or icon is not served here", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect((await owner.upload("/me/avatar", { file: new File([png], "me.png", { type: "image/png" }) })).status).toBe(200);
    const [row] = await t.sql`SELECT id, name FROM files WHERE purpose = 'avatar' ORDER BY created_at DESC LIMIT 1`;
    const res = await owner.get(`/files/${row.id}/${row.name}`);
    expect([res.status, res.body]).toEqual([404, FILE_NOT_FOUND]);
  });

  test("a file whose object is gone from storage is 404", async () => {
    const lost = await put("lost.txt", "soon gone", "text/plain");
    expect((await fetchFile(owner, lost)).status).toBe(200);
    rmSync(path.join(t.storageDir, "files", lost.id), { recursive: true });
    const res = await owner.get(lost.url.slice("/api".length));
    expect([res.status, res.body]).toEqual([404, FILE_NOT_FOUND]);
    const head = await fetchFile(owner, lost, { method: "HEAD" });
    expect(head.status).toBe(404);
    // The row is still there: the upload is listed for the page.
    const listed = await owner.get(`/pages/${pageId}/files`);
    expect(listed.body.data.map((f: Uploaded) => f.id)).toContain(lost.id);
  });

  test("a replaced file is served with its new bytes, type, ETag and date", async () => {
    const replaced = await put("replace-me.txt", "old", "text/plain");
    const before = await fetchFile(owner, replaced);
    const res = await owner.raw("POST", `/files?pageId=${pageId}&replaceId=${replaced.id}`, { body: "newer!", headers: { "Content-Type": "text/markdown" } });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    const after = await fetchFile(owner, replaced);
    expect(after.text).toBe("newer!");
    expect(after.headers.get("content-type")).toBe("text/markdown");
    expect(after.headers.get("content-length")).toBe("6");
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
    expect(after.headers.get("etag")).toMatch(new RegExp(`^"${replaced.id}-\\d{13}-6"$`));
    const [row] = await t.sql`SELECT updated_at FROM files WHERE id = ${replaced.id}`;
    expect(after.headers.get("last-modified")).toBe(new Date(row.updated_at).toUTCString());
    // The old ETag no longer matches.
    const conditional = await fetchFile(owner, replaced, { headers: { "If-None-Match": before.headers.get("etag")! } });
    expect(conditional.status).toBe(200);
  });
});

describe("GET /files/:id/:name: inline or download", () => {
  test.each([
    ["image/png"],
    ["image/jpeg"],
    ["image/gif"],
    ["image/webp"],
    ["image/avif"],
    ["image/bmp"],
    ["image/x-icon"],
    ["audio/mpeg"],
    ["audio/wav"],
    ["audio/ogg"],
    ["audio/mp4"],
    ["audio/x-custom.thing+v1-2"],
    ["video/mp4"],
    ["video/webm"],
    ["video/quicktime"],
    ["video/x-matroska"],
  ])("%s is shown inline, sandboxed", async (mime) => {
    const file = await put("media", "data", mime);
    expect(file.mime).toBe(mime);
    const res = await fetchFile(owner, file);
    expect(res.headers.get("content-type")).toBe(mime);
    expect(res.headers.get("content-disposition")).toBe("inline; filename=\"media\"; filename*=UTF-8''media");
    expect(res.headers.get("content-security-policy")).toBe(SANDBOX);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a PDF is shown inline and is the one type without the sandbox policy", async () => {
    const file = await put("paper.pdf", "%PDF-1.4");
    expect(file.mime).toBe("application/pdf");
    for (const method of ["GET", "HEAD"]) {
      const res = await fetchFile(owner, file, { method });
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toBe("inline; filename=\"paper.pdf\"; filename*=UTF-8''paper.pdf");
      expect(res.headers.get("content-security-policy")).toBeNull();
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const ranged = await fetchFile(owner, file, { headers: { Range: "bytes=0-3" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-security-policy")).toBeNull();
    const notModified = await fetchFile(owner, file, { headers: { "If-None-Match": ranged.headers.get("etag")! } });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("content-security-policy")).toBeNull();
  });

  test.each([
    ["image/svg+xml"],
    ["image/tiff"],
    ["image/heic"],
    ["image/png2"],
    ["text/html"],
    ["text/plain"],
    ["text/javascript"],
    ["text/css"],
    ["application/json"],
    ["application/xml"],
    ["application/xhtml+xml"],
    ["application/zip"],
    ["application/pdf2"],
    ["application/x-pdf"],
    ["multipart/form-data"],
    // An underscore is not among the characters an inline audio or video type may have.
    ["audio/x_custom"],
    ["video/a!b"],
    ["audiox/mpeg"],
  ])("%s is offered as a download", async (mime) => {
    const file = await put("thing", "data", mime);
    expect(file.mime).toBe(mime);
    const res = await fetchFile(owner, file);
    expect(res.headers.get("content-type")).toBe(mime);
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=\"thing\"; filename*=UTF-8''thing");
    expect(res.headers.get("content-security-policy")).toBe(SANDBOX);
  });

  test("a file of unknown type is a download", async () => {
    const file = await put("blob", "data");
    const res = await fetchFile(owner, file);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toStartWith("attachment; ");
  });
});

describe("GET /files/:id/:name: the download name", () => {
  test.each([
    ["plain.txt", "plain.txt", "plain.txt"],
    ["two words.txt", "two words.txt", "two%20words.txt"],
    // Characters outside ASCII become `_` in the plain name, one per UTF-16 unit, and UTF-8 escapes in the other.
    ["naïve résumé.txt", "na_ve r_sum_.txt", "na%C3%AFve%20r%C3%A9sum%C3%A9.txt"],
    ["日本語 ファイル.txt", "___ ____.txt", "%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB.txt"],
    ["emoji 😀.txt", "emoji __.txt", "emoji%20%F0%9F%98%80.txt"],
    ["مرحبا.txt", "_____.txt", "%D9%85%D8%B1%D8%AD%D8%A8%D8%A7.txt"],
    ["nb sp.txt", "nb_sp.txt", "nb%C2%A0sp.txt"],
    // A double quote would end the quoted name.
    ['say "hi".txt', "say _hi_.txt", "say%20%22hi%22.txt"],
    // These stay as they are in the plain name and are escaped in the other.
    ["100% sure; yes, no=maybe?.txt", "100% sure; yes, no=maybe?.txt", "100%25%20sure%3B%20yes%2C%20no%3Dmaybe%3F.txt"],
    ["a+b&c#d@e$f[g]{h}|i^j`k<l>m.txt", "a+b&c#d@e$f[g]{h}|i^j`k<l>m.txt", "a%2Bb%26c%23d%40e%24f%5Bg%5D%7Bh%7D%7Ci%5Ej%60k%3Cl%3Em.txt"],
    // And these are not escaped at all.
    ["it's (1)*!~-_.txt", "it's (1)*!~-_.txt", "it's%20(1)*!~-_.txt"],
  ])("%p is offered as filename=%p and filename*=UTF-8''%s", async (name, ascii, encoded) => {
    const file = await put(name, "x", "text/plain");
    expect(file.name).toBe(name);
    const res = await fetchFile(owner, file);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`);
  });

  test("a backslash or a control character in a stored name becomes `_` as well", async () => {
    // Uploads never store such names; the rows are arranged directly.
    const file = await put("arranged.txt", "x", "text/plain");
    await t.sql`UPDATE files SET name = ${"back\\slash\tand\u007fdel.txt"} WHERE id = ${file.id}`;
    const res = await fetchFile(owner, file);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=\"back_slash_and_del.txt\"; filename*=UTF-8''back%5Cslash%09and%7Fdel.txt");
  });
});

describe("GET /files/:id/:name: conditional requests", () => {
  let file: Uploaded;
  let etag: string;

  beforeAll(async () => {
    file = await put("conditional.txt", "0123456789", "text/plain");
    etag = (await fetchFile(owner, file)).headers.get("etag")!;
  });

  test("If-None-Match with the current ETag is 304, with the headers and no body", async () => {
    for (const method of ["GET", "HEAD"]) {
      const res = await fetchFile(owner, file, { method, headers: { "If-None-Match": etag } });
      expect(res.status).toBe(304);
      expect(res.bytes.length).toBe(0);
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("content-type")).toBe("text/plain");
      expect(res.headers.get("content-disposition")).toBe("attachment; filename=\"conditional.txt\"; filename*=UTF-8''conditional.txt");
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe(SANDBOX);
      expect(res.headers.get("last-modified")).not.toBeNull();
      expect(res.headers.get("content-range")).toBeNull();
    }
  });

  test("only the exact ETag matches: no weak form, list or wildcard", async () => {
    for (const value of [`W/${etag}`, `"other", ${etag}`, `${etag}, "other"`, "*", etag.slice(1, -1), etag.toUpperCase(), `${etag} `, '""']) {
      const res = await fetchFile(owner, file, { headers: { "If-None-Match": value } });
      // `fetch` trims the header value, so the padded one arrives exact.
      const expected = value.trim() === etag ? 304 : 200;
      expect([value, res.status]).toEqual([value, expected]);
      if (expected === 200) expect(res.text).toBe("0123456789");
    }
  });

  test("If-None-Match wins over Range", async () => {
    const res = await fetchFile(owner, file, { headers: { "If-None-Match": etag, Range: "bytes=0-1" } });
    expect(res.status).toBe(304);
    const invalid = await fetchFile(owner, file, { headers: { "If-None-Match": etag, Range: "bytes=50-" } });
    expect(invalid.status).toBe(304);
  });

  test("If-Modified-Since is not looked at", async () => {
    const future = new Date(Date.now() + 86_400_000).toUTCString();
    const res = await fetchFile(owner, file, { headers: { "If-Modified-Since": future } });
    expect(res.status).toBe(200);
    expect(res.text).toBe("0123456789");
  });
});

describe("GET /files/:id/:name: byte ranges", () => {
  let file: Uploaded;
  let etag: string;

  beforeAll(async () => {
    file = await put("ranges.txt", "0123456789", "text/plain");
    etag = (await fetchFile(owner, file)).headers.get("etag")!;
  });

  test.each([
    ["bytes=0-4", "bytes 0-4/10", "01234"],
    ["bytes=0-0", "bytes 0-0/10", "0"],
    ["bytes=9-9", "bytes 9-9/10", "9"],
    ["bytes=2-7", "bytes 2-7/10", "234567"],
    ["bytes=0-9", "bytes 0-9/10", "0123456789"],
    // Open end.
    ["bytes=5-", "bytes 5-9/10", "56789"],
    ["bytes=0-", "bytes 0-9/10", "0123456789"],
    ["bytes=9-", "bytes 9-9/10", "9"],
    // The last n bytes.
    ["bytes=-3", "bytes 7-9/10", "789"],
    ["bytes=-1", "bytes 9-9/10", "9"],
    ["bytes=-10", "bytes 0-9/10", "0123456789"],
    ["bytes=-100", "bytes 0-9/10", "0123456789"],
    // An end past the last byte is cut back.
    ["bytes=3-100", "bytes 3-9/10", "3456789"],
    ["bytes=9-10", "bytes 9-9/10", "9"],
    ["bytes=0-99999999999999999999", "bytes 0-9/10", "0123456789"],
    // Leading zeros.
    ["bytes=00-01", "bytes 0-1/10", "01"],
  ])("Range: %s answers 206 %s", async (range, contentRange, body) => {
    const res = await fetchFile(owner, file, { headers: { Range: range } });
    expect(res.status).toBe(206);
    expect(res.text).toBe(body);
    expect(res.headers.get("content-range")).toBe(contentRange);
    expect(res.headers.get("content-length")).toBe(String(body.length));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=\"ranges.txt\"; filename*=UTF-8''ranges.txt");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("content-security-policy")).toBe(SANDBOX);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("last-modified")).not.toBeNull();
  });

  test.each([["bytes=10-"], ["bytes=10-12"], ["bytes=100-200"], ["bytes=5-2"], ["bytes=9-8"], ["bytes=-"], ["bytes=-0"], ["bytes=99999999999999999999-"]])(
    "Range: %s cannot be satisfied: 416",
    async (range) => {
      const res = await fetchFile(owner, file, { headers: { Range: range } });
      expect(res.status).toBe(416);
      expect(res.bytes.length).toBe(0);
      expect(res.headers.get("content-range")).toBe("bytes */10");
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(res.headers.get("content-type")).toBe("text/plain");
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
    },
  );

  test.each([["bytes=abc"], ["bytes=1-x"], ["bytes=0-1,3-4"], ["bytes=0-1, 3-4"], ["items=0-1"], ["bytes 0-1"], ["0-1"], ["bytes=1"], ["bytes=--1"], ["bytes=1--2"], ["bytes=0x1-0x2"], ["bytes=1.5-2"]])(
    "Range: %s is not a range the server understands: the whole file",
    async (range) => {
      const res = await fetchFile(owner, file, { headers: { Range: range } });
      expect(res.status).toBe(200);
      expect(res.text).toBe("0123456789");
      expect(res.headers.get("content-range")).toBeNull();
      expect(res.headers.get("content-length")).toBe("10");
    },
  );

  test("HEAD with a Range answers the headers of the part", async () => {
    const res = await fetchFile(owner, file, { method: "HEAD", headers: { Range: "bytes=2-3" } });
    expect(res.status).toBe(206);
    expect(res.bytes.length).toBe(0);
    expect(res.headers.get("content-range")).toBe("bytes 2-3/10");
    expect(res.headers.get("content-length")).toBe("2");
    const unsatisfiable = await fetchFile(owner, file, { method: "HEAD", headers: { Range: "bytes=10-" } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10");
  });

  test("If-Range with the current ETag keeps the range", async () => {
    const res = await fetchFile(owner, file, { headers: { Range: "bytes=0-1", "If-Range": etag } });
    expect(res.status).toBe(206);
    expect(res.text).toBe("01");
    expect(res.headers.get("content-range")).toBe("bytes 0-1/10");
    const unsatisfiable = await fetchFile(owner, file, { headers: { Range: "bytes=10-", "If-Range": etag } });
    expect(unsatisfiable.status).toBe(416);
  });

  test("If-Range with anything else answers the whole file, even for a range that cannot be satisfied", async () => {
    for (const condition of ['"another-etag"', `W/${etag}`, etag.slice(1, -1), "Sat, 01 Jan 2000 00:00:00 GMT", "Fri, 01 Jan 2100 00:00:00 GMT", "garbage"]) {
      for (const range of ["bytes=0-1", "bytes=10-"]) {
        const res = await fetchFile(owner, file, { headers: { Range: range, "If-Range": condition } });
        expect([condition, range, res.status]).toEqual([condition, range, 200]);
        expect(res.text).toBe("0123456789");
        expect(res.headers.get("content-range")).toBeNull();
      }
    }
  });

  test("If-Range without Range changes nothing", async () => {
    const res = await fetchFile(owner, file, { headers: { "If-Range": etag } });
    expect(res.status).toBe(200);
    expect(res.text).toBe("0123456789");
  });

  test("ranges of a larger file are cut at the right offsets", async () => {
    const bytes = new Uint8Array(300_000).map((_, i) => (i * 31 + (i >> 8)) % 256);
    const large = await put("large.bin", bytes);
    const middle = await fetchFile(owner, large, { headers: { Range: "bytes=65536-131071" } });
    expect(middle.status).toBe(206);
    expect(middle.headers.get("content-range")).toBe("bytes 65536-131071/300000");
    expect(middle.headers.get("content-length")).toBe("65536");
    expect(middle.bytes).toEqual(bytes.subarray(65536, 131072));
    const tail = await fetchFile(owner, large, { headers: { Range: "bytes=-1000" } });
    expect(tail.headers.get("content-range")).toBe("bytes 299000-299999/300000");
    expect(tail.bytes).toEqual(bytes.subarray(299000));
    const rest = await fetchFile(owner, large, { headers: { Range: "bytes=299999-" } });
    expect(rest.bytes).toEqual(bytes.subarray(299999));
    const whole = await fetchFile(owner, large);
    expect(whole.headers.get("content-length")).toBe("300000");
    expect(whole.bytes).toEqual(bytes);
  });
});

describe("GET /files/:id/:name: with a session", () => {
  let file: Uploaded;
  let reader: Client;
  let outsider: Client;
  let viaGroup: Client;

  beforeAll(async () => {
    file = await put("members.txt", "for members", "text/plain");
    const readerMember = await t.addMember(owner, "serve-reader@example.com");
    expect((await owner.post(`/spaces/${spaceId}/members/add`, { role: "reader", userIds: [readerMember.user.id] })).status).toBe(200);
    reader = readerMember.client;
    outsider = (await t.addMember(owner, "serve-outsider@example.com")).client;
    const grouped = await t.addMember(owner, "serve-grouped@example.com");
    viaGroup = grouped.client;
    const group = await owner.post("/groups", { name: "File readers" });
    expect(group.status).toBe(200);
    expect((await owner.post(`/groups/${group.body.data.group.id}/members/add`, { userIds: [grouped.user.id] })).status).toBe(200);
    expect((await owner.post(`/spaces/${spaceId}/members/add`, { role: "reader", groupIds: [group.body.data.group.id] })).status).toBe(200);
  });

  test("nobody signed in is told to sign in", async () => {
    for (const method of ["GET", "HEAD"]) {
      const res = await t.client().raw(method, file.url.slice("/api".length));
      expect(res.status).toBe(401);
      if (method === "GET") expect(await res.json()).toEqual(apiError("unauthorized", "Sign in required"));
      else await res.arrayBuffer();
    }
    // An unknown file is 404 even then: the file is looked up first.
    const unknown = await t.client().get(`/files/${crypto.randomUUID()}/x`);
    expect([unknown.status, unknown.body]).toEqual([404, FILE_NOT_FOUND]);
  });

  test("an empty share parameter is the same as none", async () => {
    const anonymous = await t.client().get(`${file.url.slice("/api".length)}?share=`);
    expect(anonymous.status).toBe(401);
    const member = await fetchFile(owner, file, { query: "?share=" });
    expect(member.status).toBe(200);
  });

  test("a reader of the space gets the file, directly or through a group", async () => {
    for (const client of [reader, viaGroup, owner]) {
      const res = await fetchFile(client, file);
      expect(res.status).toBe(200);
      expect(res.text).toBe("for members");
    }
  });

  test("a member of the workspace who is not in the space cannot tell the file exists", async () => {
    const res = await outsider.get(file.url.slice("/api".length));
    expect([res.status, res.body]).toEqual([404, FILE_NOT_FOUND]);
  });

  test("a workspace admin outside the space cannot read it either", async () => {
    const created = await owner.post("/spaces", { name: "Serving private", slug: "serving-private" });
    const privateSpace = created.body.data.space.id as string;
    const privatePage = await newPage("Private", undefined, privateSpace);
    const secret = await put("secret.txt", "secret", "text/plain", privatePage.id);
    const admin = await t.addMember(owner, "serve-admin@example.com", "admin");
    const res = await admin.client.get(secret.url.slice("/api".length));
    expect([res.status, res.body]).toEqual([404, FILE_NOT_FOUND]);
    expect((await fetchFile(owner, secret)).status).toBe(200);
  });

  test("a file of a page in the trash is still served to members", async () => {
    const page = await newPage("Trashed with a file");
    const trashed = await put("trashed.txt", "in the trash", "text/plain", page.id);
    expect((await owner.post(`/pages/${page.id}/delete`)).status).toBe(200);
    const res = await fetchFile(reader, trashed);
    expect([res.status, res.text]).toEqual([200, "in the trash"]);
  });

  test("a file is gone once its page is deleted for good", async () => {
    const page = await newPage("Deleted with a file");
    const doomed = await put("doomed.txt", "bye", "text/plain", page.id);
    expect((await owner.post(`/pages/${page.id}/delete`)).status).toBe(200);
    expect((await owner.post(`/pages/${page.id}/delete-permanently`)).status).toBe(200);
    const res = await owner.get(doomed.url.slice("/api".length));
    expect([res.status, res.body]).toEqual([404, FILE_NOT_FOUND]);
  });

  test("a file row that lost its space is not served", async () => {
    // Deleting a space removes its files, so such a row is arranged directly.
    const orphan = await put("orphan.txt", "x", "text/plain");
    await t.sql`UPDATE files SET space_id = NULL WHERE id = ${orphan.id}`;
    const res = await owner.get(orphan.url.slice("/api".length));
    expect([res.status, res.body]).toEqual([404, FILE_NOT_FOUND]);
  });
});

describe("GET /files/:id/:name?share=<key>: through a shared page", () => {
  let root: { id: string; slugId: string };
  let child: { id: string; slugId: string };
  let grandchild: { id: string; slugId: string };
  let rootFile: Uploaded;
  let childFile: Uploaded;
  let grandchildFile: Uploaded;
  let unrelatedFile: Uploaded;
  let anonymous: Client;

  beforeAll(async () => {
    root = await newPage("Shared root");
    child = await newPage("Shared child", root.id);
    grandchild = await newPage("Shared grandchild", child.id);
    rootFile = await put("root.png", "root bytes", "image/png", root.id);
    childFile = await put("child.txt", "child bytes", "text/plain", child.id);
    grandchildFile = await put("grandchild.txt", "grandchild bytes", "text/plain", grandchild.id);
    unrelatedFile = await put("unrelated.txt", "unrelated bytes", "text/plain");
    anonymous = t.client();
  });

  const withKey = (client: Client, file: Uploaded, key: string, init: RequestInit = {}) => fetchFile(client, file, { ...init, query: `?share=${key}` });

  test("the key of a share of the file's page opens the file to anyone, exactly as a member gets it", async () => {
    const key = await share(root.id);
    const res = await withKey(anonymous, rootFile, key);
    expect(res.status).toBe(200);
    expect(res.text).toBe("root bytes");
    const asMember = await fetchFile(owner, rootFile);
    const pick = (headers: Headers) => Object.fromEntries([...headers].filter(([name]) => name !== "date"));
    expect(pick(res.headers)).toEqual(pick(asMember.headers));
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("content-disposition")).toBe("inline; filename=\"root.png\"; filename*=UTF-8''root.png");

    // Ranges, conditions and HEAD work the same.
    const ranged = await withKey(anonymous, rootFile, key, { headers: { Range: "bytes=5-" } });
    expect([ranged.status, ranged.text, ranged.headers.get("content-range")]).toEqual([206, "bytes", "bytes 5-9/10"]);
    const notModified = await withKey(anonymous, rootFile, key, { headers: { "If-None-Match": res.headers.get("etag")! } });
    expect(notModified.status).toBe(304);
    const head = await withKey(anonymous, rootFile, key, { method: "HEAD" });
    expect([head.status, head.headers.get("content-length")]).toEqual([200, "10"]);
  });

  test("a share without children does not open files of pages below", async () => {
    const key = await share(root.id, false);
    for (const file of [childFile, grandchildFile, unrelatedFile]) {
      const res = await anonymous.get(`${file.url.slice("/api".length)}?share=${key}`);
      expect([file.name, res.status, res.body]).toEqual([file.name, 404, FILE_NOT_FOUND]);
    }
    expect((await withKey(anonymous, rootFile, key)).status).toBe(200);
  });

  test("a share with children opens files of every page below, and no others", async () => {
    const key = await share(root.id, true);
    expect((await withKey(anonymous, rootFile, key)).text).toBe("root bytes");
    expect((await withKey(anonymous, childFile, key)).text).toBe("child bytes");
    expect((await withKey(anonymous, grandchildFile, key)).text).toBe("grandchild bytes");
    const unrelated = await anonymous.get(`${unrelatedFile.url.slice("/api".length)}?share=${key}`);
    expect([unrelated.status, unrelated.body]).toEqual([404, FILE_NOT_FOUND]);
  });

  test("a share of a page below does not open files of the pages above", async () => {
    const key = await share(child.id, true);
    expect((await withKey(anonymous, childFile, key)).status).toBe(200);
    expect((await withKey(anonymous, grandchildFile, key)).status).toBe(200);
    const above = await anonymous.get(`${rootFile.url.slice("/api".length)}?share=${key}`);
    expect([above.status, above.body]).toEqual([404, FILE_NOT_FOUND]);
    expect((await owner.post(`/pages/${child.id}/share/delete`)).status).toBe(200);
    expect((await anonymous.get(`${childFile.url.slice("/api".length)}?share=${key}`)).status).toBe(404);
  });

  test("the key counts even with a session: a member with a wrong key gets 404", async () => {
    const key = await share(root.id, false);
    // The owner could read the child's file without a key.
    expect((await fetchFile(owner, childFile)).status).toBe(200);
    const res = await owner.get(`${childFile.url.slice("/api".length)}?share=${key}`);
    expect([res.status, res.body]).toEqual([404, FILE_NOT_FOUND]);
    const wrong = await owner.get(`${rootFile.url.slice("/api".length)}?share=zzzzzzzzzz`);
    expect([wrong.status, wrong.body]).toEqual([404, FILE_NOT_FOUND]);
    // And someone outside the space gets in with the right one.
    const outsider = (await t.addMember(owner, "serve-share-outsider@example.com")).client;
    expect((await outsider.get(rootFile.url.slice("/api".length))).status).toBe(404);
    expect((await withKey(outsider, rootFile, key)).text).toBe("root bytes");
  });

  test("a key that is not a key, or of no share, is 404", async () => {
    const key = await share(root.id, true);
    for (const bad of [key.toUpperCase(), `${key}x`, key.slice(0, 9), "0000000000", "NOT-A-KEY", "a".repeat(33), "ключ", "a b", "%00", "a'b"]) {
      const res = await anonymous.get(`${rootFile.url.slice("/api".length)}?share=${encodeURIComponent(bad)}`);
      expect([bad, res.status, res.body]).toEqual([bad, 404, FILE_NOT_FOUND]);
    }
    // The first `share` parameter is the one that counts.
    const first = await anonymous.get(`${rootFile.url.slice("/api".length)}?share=${key}&share=0000000000`);
    expect(first.status).toBe(200);
    const second = await anonymous.get(`${rootFile.url.slice("/api".length)}?share=0000000000&share=${key}`);
    expect(second.status).toBe(404);
  });

  test("a page below that is in the trash is closed until it is restored", async () => {
    const key = await share(root.id, true);
    expect((await owner.post(`/pages/${child.id}/delete`)).status).toBe(200);
    for (const file of [childFile, grandchildFile]) {
      const res = await anonymous.get(`${file.url.slice("/api".length)}?share=${key}`);
      expect([file.name, res.status, res.body]).toEqual([file.name, 404, FILE_NOT_FOUND]);
    }
    expect((await withKey(anonymous, rootFile, key)).status).toBe(200);
    expect((await owner.post(`/pages/${child.id}/restore`)).status).toBe(200);
    expect((await withKey(anonymous, childFile, key)).status).toBe(200);
    expect((await withKey(anonymous, grandchildFile, key)).status).toBe(200);
  });

  test("trashing the shared page ends the share, also after a restore", async () => {
    const page = await newPage("Shared then trashed");
    const file = await put("gone.txt", "x", "text/plain", page.id);
    const key = await share(page.id);
    expect((await withKey(anonymous, file, key)).status).toBe(200);
    expect((await owner.post(`/pages/${page.id}/delete`)).status).toBe(200);
    expect((await anonymous.get(`${file.url.slice("/api".length)}?share=${key}`)).status).toBe(404);
    expect((await owner.post(`/pages/${page.id}/restore`)).status).toBe(200);
    const res = await anonymous.get(`${file.url.slice("/api".length)}?share=${key}`);
    expect([res.status, res.body]).toEqual([404, FILE_NOT_FOUND]);
  });

  test("deleting the share closes the file", async () => {
    const key = await share(root.id, true);
    expect((await withKey(anonymous, childFile, key)).status).toBe(200);
    expect((await owner.post(`/pages/${root.id}/share/delete`)).status).toBe(200);
    for (const file of [rootFile, childFile]) {
      const res = await anonymous.get(`${file.url.slice("/api".length)}?share=${key}`);
      expect([res.status, res.body]).toEqual([404, FILE_NOT_FOUND]);
    }
  });

  test("a file row that lost its page is not opened by any key", async () => {
    const page = await newPage("Shared with an orphan");
    const orphan = await put("orphan.txt", "x", "text/plain", page.id);
    const key = await share(page.id);
    expect((await withKey(anonymous, orphan, key)).status).toBe(200);
    await t.sql`UPDATE files SET page_id = NULL WHERE id = ${orphan.id}`;
    const res = await anonymous.get(`${orphan.url.slice("/api".length)}?share=${key}`);
    expect([res.status, res.body]).toEqual([404, FILE_NOT_FOUND]);
    // Members still reach it through the space.
    expect((await fetchFile(owner, orphan)).status).toBe(200);
  });

  test("while sharing is disabled for the workspace no key opens a file; shares come back with the setting", async () => {
    const key = await share(root.id, true);
    expect((await withKey(anonymous, rootFile, key)).status).toBe(200);
    expect((await owner.post("/workspace/update", { settings: { sharingDisabled: true } })).status).toBe(200);
    try {
      for (const file of [rootFile, childFile]) {
        const res = await anonymous.get(`${file.url.slice("/api".length)}?share=${key}`);
        expect([res.status, res.body]).toEqual([404, FILE_NOT_FOUND]);
      }
      // Members are not affected.
      expect((await fetchFile(owner, rootFile)).status).toBe(200);
    } finally {
      expect((await owner.post("/workspace/update", { settings: { sharingDisabled: false } })).status).toBe(200);
    }
    expect((await withKey(anonymous, rootFile, key)).status).toBe(200);
    expect((await withKey(anonymous, childFile, key)).status).toBe(200);
  });

  test("disabling sharing for the space removes its shares for good", async () => {
    const created = await owner.post("/spaces", { name: "Serving shared", slug: "serving-shared" });
    const space = created.body.data.space.id as string;
    const page = await newPage("In a space that stops sharing", undefined, space);
    const file = await put("space.txt", "x", "text/plain", page.id);
    const key = await share(page.id);
    expect((await withKey(anonymous, file, key)).status).toBe(200);
    expect((await owner.post(`/spaces/${space}/update`, { settings: { sharingDisabled: true } })).status).toBe(200);
    expect((await anonymous.get(`${file.url.slice("/api".length)}?share=${key}`)).status).toBe(404);
    expect((await owner.post(`/spaces/${space}/update`, { settings: { sharingDisabled: false } })).status).toBe(200);
    const res = await anonymous.get(`${file.url.slice("/api".length)}?share=${key}`);
    expect([res.status, res.body]).toEqual([404, FILE_NOT_FOUND]);
  });
});
