import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { startServer, type Client, type TestServer } from "./harness";
import { apiError } from "./harness/errors";

/**
 * Avatars, the workspace logo and space icons: what `saveImage` and
 * `removeImage` (src/server/lib/files.ts) keep, and `GET /images/:name`
 * (src/server/routes/files.ts), which serves them to anyone.
 */

let t: TestServer;
let owner: Client;
let ownerId: string;
let spaceId: string;

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 9, 9, 9, 9, 9, 9]);
const GIF = new Uint8Array([...ascii("GIF89a"), 1, 0, 1, 0, 0, 0, 0, 59, 7, 7, 7, 7]);
const WEBP = new Uint8Array([...ascii("RIFF"), 20, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8 "), 5, 5, 5, 5, 5, 5]);

const IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;
const SANDBOX = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
const IMAGE_NOT_FOUND = apiError("not_found", "Image not found");

const images = () => {
  const dir = path.join(t.storageDir, "images");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

const setAvatar = async (client: Client, bytes: Uint8Array, fileName = "avatar", type = "") => {
  const res = await client.upload("/me/avatar", { file: new File([bytes as Uint8Array<ArrayBuffer>], fileName, { type }) });
  return res;
};

/** Uploads an avatar and returns the image's name (`<uuid>.<ext>`). */
const avatarName = async (client: Client, bytes: Uint8Array, fileName = "avatar", type = "") => {
  const res = await setAvatar(client, bytes, fileName, type);
  expect(res.status).toBe(200);
  const url: string = res.body.data.user.avatarUrl;
  expect(url).toStartWith("/api/images/");
  return url.slice("/api/images/".length);
};

const fetchImage = async (name: string, init: RequestInit = {}, client: Client = t.client()) => {
  const res = await client.raw(init.method ?? "GET", `/images/${name}`, init);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes };
};

const imageRow = async (name: string) => {
  const [row] = await t.sql`
    SELECT purpose, page_id, space_id, uploader_id, name, mime, size::int AS size, storage_key FROM files WHERE name = ${name}`;
  return row ?? null;
};

beforeAll(async () => {
  t = await startServer();
  const setup = await t.setupOwner();
  owner = setup.owner;
  ownerId = setup.user.id;
  spaceId = setup.spaceId;
});

afterAll(async () => {
  await t.close();
});

describe("what an uploaded image is stored as", () => {
  test.each([
    ["PNG", PNG, "png", "image/png"],
    ["JPEG", JPEG, "jpg", "image/jpeg"],
    ["GIF", GIF, "gif", "image/gif"],
    ["WebP", WEBP, "webp", "image/webp"],
  ] as const)("a %s image is recognised by its first bytes", async (_label, bytes, extension, mime) => {
    const name = await avatarName(owner, bytes);
    expect(name).toMatch(IMAGE_NAME);
    expect(name.endsWith(`.${extension}`)).toBe(true);
    expect(await imageRow(name)).toEqual({
      purpose: "avatar",
      page_id: null,
      space_id: null,
      uploader_id: ownerId,
      name,
      mime,
      size: bytes.length,
      storage_key: `images/${name}`,
    });
    expect(new Uint8Array(readFileSync(path.join(t.storageDir, "images", name)))).toEqual(bytes);
    const served = await fetchImage(name);
    expect(served.status).toBe(200);
    expect(served.bytes).toEqual(bytes);
    expect(served.headers.get("content-type")).toBe(mime);
  });

  test("the name and type the browser sent are not believed", async () => {
    const name = await avatarName(owner, PNG, "really-a.gif", "image/gif");
    expect(name.endsWith(".png")).toBe(true);
    expect((await imageRow(name)).mime).toBe("image/png");
    const svgNamed = await avatarName(owner, JPEG, "../../evil.svg", "image/svg+xml");
    expect(svgNamed).toMatch(IMAGE_NAME);
    expect(svgNamed.endsWith(".jpg")).toBe(true);
  });

  test("the shortest signatures are enough", async () => {
    expect((await avatarName(owner, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).endsWith(".png")).toBe(true);
    expect((await avatarName(owner, new Uint8Array([0xff, 0xd8, 0xff]))).endsWith(".jpg")).toBe(true);
    expect((await avatarName(owner, new Uint8Array(ascii("GIF8")))).endsWith(".gif")).toBe(true);
    expect((await avatarName(owner, new Uint8Array(ascii("GIF87a")))).endsWith(".gif")).toBe(true);
    expect((await avatarName(owner, new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")])))).toMatch(/\.webp$/);
  });

  test.each([
    ["nothing", new Uint8Array(0)],
    ["text", new Uint8Array(ascii("just some text, long enough"))],
    ["SVG", new Uint8Array(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))],
    ["HTML", new Uint8Array(ascii("<!doctype html><script>alert(1)</script>"))],
    ["a PDF", new Uint8Array(ascii("%PDF-1.7 ...."))],
    ["a truncated PNG signature", new Uint8Array([0x89, 0x50, 0x4e])],
    ["a truncated JPEG signature", new Uint8Array([0xff, 0xd8])],
    ["a JPEG signature after one byte", new Uint8Array([0, 0xff, 0xd8, 0xff, 0xe0])],
    ["GIF7", new Uint8Array(ascii("GIF7xa......"))],
    ["a WAVE file", new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE"), 1, 2, 3, 4])],
    ["RIFF without WEBP", new Uint8Array(ascii("RIFF"))],
    ["WEBP at the wrong offset", new Uint8Array([...ascii("RIFF"), ...ascii("WEBP"), 0, 0, 0, 0])],
    ["a BMP", new Uint8Array([...ascii("BM"), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ["an AVIF", new Uint8Array([0, 0, 0, 28, ...ascii("ftypavif"), 0, 0, 0, 0])],
  ])("%s is not an image the server takes", async (_label, bytes) => {
    const before = images();
    const current = (await owner.get("/me")).body.data.user.avatarUrl;
    const res = await setAvatar(owner, bytes, "claimed.png", "image/png");
    expect(res.status).toBe(400);
    expect(res.body).toEqual(apiError("invalid_input", "Images must be PNG, JPEG, WebP or GIF"));
    expect(images()).toEqual(before);
    expect((await owner.get("/me")).body.data.user.avatarUrl).toBe(current);
  });

  test("an image of exactly 10 MiB is taken, one byte more is not", async () => {
    const big = new Uint8Array(10 * 1024 * 1024);
    big.set(PNG);
    const name = await avatarName(owner, big);
    expect((await imageRow(name)).size).toBe(10 * 1024 * 1024);
    const before = images();
    const over = new Uint8Array(10 * 1024 * 1024 + 1);
    over.set(PNG);
    const res = await setAvatar(owner, over);
    expect(res.status).toBe(413);
    expect(res.body).toEqual(apiError("payload_too_large", "Images must be at most 10 MB"));
    // The size is checked before the content.
    const overAndNoImage = await setAvatar(owner, new Uint8Array(10 * 1024 * 1024 + 1));
    expect(overAndNoImage.status).toBe(413);
    expect(overAndNoImage.body).toEqual(apiError("payload_too_large", "Images must be at most 10 MB"));
    expect(images()).toEqual(before);
    expect((await owner.get("/me")).body.data.user.avatarUrl).toBe(`/api/images/${name}`);
  });

  test("a form over 11 MiB is refused before it is read", async () => {
    const huge = new Uint8Array(11 * 1024 * 1024 + 1);
    huge.set(PNG);
    const res = await setAvatar(owner, huge);
    expect(res.status).toBe(413);
    expect(res.body).toEqual(apiError("payload_too_large", "File is too large"));
  });

  test("the image must come as the form field `file`", async () => {
    const wrongField = await owner.upload("/me/avatar", { image: new File([PNG], "a.png") });
    expect(wrongField.status).toBe(400);
    expect(wrongField.body).toEqual(apiError("invalid_input", 'Missing file field "file"'));
    const textField = await owner.upload("/me/avatar", { file: "not a file" });
    expect(textField.status).toBe(400);
    expect(textField.body).toEqual(apiError("invalid_input", 'Missing file field "file"'));
    const rawBody = await owner.raw("POST", "/me/avatar", { body: PNG, headers: { "Content-Type": "image/png" } });
    expect(rawBody.status).toBe(415);
    expect(await rawBody.json()).toEqual(apiError("unsupported_media_type", "Expected multipart/form-data"));
    const malformed = await owner.raw("POST", "/me/avatar", { body: "garbage", headers: { "Content-Type": "multipart/form-data; boundary=x" } });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual(apiError("invalid_input", "Malformed multipart body"));
  });
});

describe("replacing and removing images", () => {
  test("a new avatar replaces the old one in storage and in the database", async () => {
    const member = (await t.addMember(owner, "avatar-swap@example.com")).client;
    const first = await avatarName(member, PNG);
    expect(images()).toContain(first);
    const second = await avatarName(member, GIF);
    expect(second).not.toBe(first);
    expect(images()).toContain(second);
    expect(images()).not.toContain(first);
    expect(await imageRow(first)).toBeNull();
    expect((await fetchImage(first)).status).toBe(404);
    expect((await fetchImage(second)).status).toBe(200);

    const removed = await member.post("/me/avatar/remove");
    expect(removed.status).toBe(200);
    expect(removed.body.data.user.avatarUrl).toBeNull();
    expect(images()).not.toContain(second);
    expect(await imageRow(second)).toBeNull();
    const gone = await t.client().get(`/images/${second}`);
    expect([gone.status, gone.body]).toEqual([404, IMAGE_NOT_FOUND]);

    // Removing when there is none changes nothing.
    const again = await member.post("/me/avatar/remove");
    expect(again.status).toBe(200);
    expect(again.body.data.user.avatarUrl).toBeNull();
  });

  test("a refused upload keeps the current avatar", async () => {
    const member = (await t.addMember(owner, "avatar-keep@example.com")).client;
    const name = await avatarName(member, JPEG);
    expect((await setAvatar(member, new Uint8Array(ascii("not an image")))).status).toBe(400);
    expect((await member.get("/me")).body.data.user.avatarUrl).toBe(`/api/images/${name}`);
    expect((await fetchImage(name)).bytes).toEqual(JPEG);
  });

  test("the workspace logo is stored the same way, with its own purpose", async () => {
    const res = await owner.upload("/workspace/logo", { file: new File([WEBP], "logo.webp", { type: "image/webp" }) });
    expect(res.status).toBe(200);
    const url: string = res.body.data.workspace.logoUrl;
    const name = url.slice("/api/images/".length);
    expect(name).toMatch(/\.webp$/);
    expect(await imageRow(name)).toEqual({
      purpose: "workspace-logo",
      page_id: null,
      space_id: null,
      uploader_id: ownerId,
      name,
      mime: "image/webp",
      size: WEBP.length,
      storage_key: `images/${name}`,
    });
    // Anyone can see it, signed in or not.
    expect((await t.client().get("/workspace/public")).body.data.logoUrl).toBe(url);
    expect((await fetchImage(name)).bytes).toEqual(WEBP);

    const replaced = await owner.upload("/workspace/logo", { file: new File([PNG], "logo.png") });
    const next = (replaced.body.data.workspace.logoUrl as string).slice("/api/images/".length);
    expect(images()).toContain(next);
    expect(images()).not.toContain(name);
    expect(await imageRow(name)).toBeNull();

    const removed = await owner.post("/workspace/logo/remove");
    expect(removed.status).toBe(200);
    expect(removed.body.data.workspace.logoUrl).toBeNull();
    expect(images()).not.toContain(next);
    expect(await imageRow(next)).toBeNull();
    expect((await owner.post("/workspace/logo/remove")).status).toBe(200);
  });

  test("a space icon is stored with its space, and goes when the space is deleted", async () => {
    const created = await owner.post("/spaces", { name: "Iconic", slug: "iconic" });
    const space = created.body.data.space.id as string;
    const res = await owner.upload(`/spaces/${space}/icon`, { file: new File([GIF], "icon.gif") });
    expect(res.status).toBe(200);
    const url: string = res.body.data.space.iconUrl;
    const name = url.slice("/api/images/".length);
    expect(name).toMatch(/\.gif$/);
    expect(await imageRow(name)).toEqual({
      purpose: "space-icon",
      page_id: null,
      space_id: space,
      uploader_id: ownerId,
      name,
      mime: "image/gif",
      size: GIF.length,
      storage_key: `images/${name}`,
    });
    expect((await fetchImage(name)).bytes).toEqual(GIF);

    const replaced = await owner.upload(`/spaces/${space}/icon`, { file: new File([JPEG], "icon.jpg") });
    const next = (replaced.body.data.space.iconUrl as string).slice("/api/images/".length);
    expect(images()).not.toContain(name);
    expect(await imageRow(name)).toBeNull();
    expect(images()).toContain(next);

    const removed = await owner.post(`/spaces/${space}/icon/remove`);
    expect(removed.body.data.space.iconUrl).toBeNull();
    expect(images()).not.toContain(next);

    const last = await owner.upload(`/spaces/${space}/icon`, { file: new File([PNG], "icon.png") });
    const lastName = (last.body.data.space.iconUrl as string).slice("/api/images/".length);
    expect(images()).toContain(lastName);
    expect((await owner.post(`/spaces/${space}/delete`)).status).toBe(200);
    expect(images()).not.toContain(lastName);
    expect(await imageRow(lastName)).toBeNull();
    expect((await fetchImage(lastName)).status).toBe(404);
    // The default space is untouched.
    expect((await owner.get(`/spaces/${spaceId}`)).status).toBe(200);
  });
});

describe("GET /images/:name", () => {
  let png: string;

  beforeAll(async () => {
    const member = (await t.addMember(owner, "image-owner@example.com")).client;
    png = await avatarName(member, PNG);
  });

  test("is answered to anyone, cached for a year as immutable, with every header", async () => {
    const res = await fetchImage(png);
    expect(res.status).toBe(200);
    expect(res.bytes).toEqual(PNG);
    expect(Object.fromEntries([...res.headers].filter(([name]) => name !== "date"))).toEqual({
      "content-type": "image/png",
      "content-disposition": `inline; filename="${png}"; filename*=UTF-8''${png}`,
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=31536000, immutable",
      "accept-ranges": "bytes",
      etag: `"${png}"`,
      "content-security-policy": SANDBOX,
      "content-length": String(PNG.length),
    });
    // Signed in or not makes no difference.
    const asOwner = await fetchImage(png, {}, owner);
    expect(asOwner.status).toBe(200);
    expect(asOwner.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("HEAD, conditional requests and ranges work as for files", async () => {
    const head = await fetchImage(png, { method: "HEAD" });
    expect([head.status, head.bytes.length, head.headers.get("content-length")]).toEqual([200, 0, String(PNG.length)]);
    expect(head.headers.get("etag")).toBe(`"${png}"`);

    const notModified = await fetchImage(png, { headers: { "If-None-Match": `"${png}"` } });
    expect([notModified.status, notModified.bytes.length]).toEqual([304, 0]);
    expect(notModified.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(notModified.headers.get("etag")).toBe(`"${png}"`);
    expect((await fetchImage(png, { headers: { "If-None-Match": `W/"${png}"` } })).status).toBe(200);
    expect((await fetchImage(png, { headers: { "If-None-Match": png } })).status).toBe(200);

    const ranged = await fetchImage(png, { headers: { Range: "bytes=1-3" } });
    expect(ranged.status).toBe(206);
    expect(ranged.bytes).toEqual(PNG.subarray(1, 4));
    expect(ranged.headers.get("content-range")).toBe(`bytes 1-3/${PNG.length}`);
    expect(ranged.headers.get("content-length")).toBe("3");
    const tail = await fetchImage(png, { headers: { Range: "bytes=-4", "If-Range": `"${png}"` } });
    expect(tail.bytes).toEqual(PNG.subarray(PNG.length - 4));
    const whole = await fetchImage(png, { headers: { Range: "bytes=1-3", "If-Range": '"other"' } });
    expect([whole.status, whole.bytes.length]).toEqual([200, PNG.length]);
    const unsatisfiable = await fetchImage(png, { headers: { Range: `bytes=${PNG.length}-` } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${PNG.length}`);
  });

  test("only names of the form <lower-case uuid>.<png|jpg|gif|webp> are looked up", async () => {
    const id = png.slice(0, 36);
    const names = [
      png.toUpperCase(),
      `${id.toUpperCase()}.png`,
      `${id}.PNG`,
      `${id}.jpeg`,
      `${id}.svg`,
      `${id}.png.png`,
      `${id}`,
      `${id}.`,
      `x${png}`,
      `${png}x`,
      ` ${png}`,
      `${id.replace(/-/g, "")}.png`,
      "avatar.png",
      "..%2F..%2Fetc%2Fpasswd",
      `..%2Fimages%2F${png}`,
      `%2e%2e%2ffiles%2f${id}.png`,
      `${id}.png%00`,
      `${id}.png%0A`,
    ];
    for (const name of names) {
      const res = await t.client().get(`/images/${name.replace(/ /g, "%20")}`);
      expect([name, res.status, res.body]).toEqual([name, 404, IMAGE_NOT_FOUND]);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("a well-formed name of no image is 404, as is the same image under another extension", async () => {
    const id = png.slice(0, 36);
    for (const name of [`${crypto.randomUUID()}.png`, `${id}.jpg`, `${id}.gif`, `${id}.webp`, "00000000-0000-0000-0000-000000000000.png"]) {
      const res = await t.client().get(`/images/${name}`);
      expect([name, res.status, res.body]).toEqual([name, 404, IMAGE_NOT_FOUND]);
    }
  });

  test("the path has exactly one segment after /images", async () => {
    const endpoint = apiError("not_found", "Endpoint not found");
    for (const pathname of ["/images", "/images/", `/images/${png}/x`, `/images/x/${png}`, "/images/%zz"]) {
      const res = await t.client().get(pathname);
      expect([pathname, res.status, res.body]).toEqual([pathname, 404, endpoint]);
    }
    const posted = await owner.post(`/images/${png}`, {});
    expect([posted.status, posted.body]).toEqual([404, endpoint]);
  });

  test("the type comes from the extension in the name", async () => {
    // The stored row plays no part: an object put under another extension is served as that type.
    const [row] = await t.sql`SELECT mime FROM files WHERE name = ${png}`;
    expect(row.mime).toBe("image/png");
    await t.sql`UPDATE files SET mime = 'image/gif' WHERE name = ${png}`;
    try {
      expect((await fetchImage(png)).headers.get("content-type")).toBe("image/png");
    } finally {
      await t.sql`UPDATE files SET mime = 'image/png' WHERE name = ${png}`;
    }
  });

  test("an image whose object is gone from storage is 404", async () => {
    const member = (await t.addMember(owner, "image-lost@example.com")).client;
    const name = await avatarName(member, JPEG);
    rmSync(path.join(t.storageDir, "images", name));
    const res = await t.client().get(`/images/${name}`);
    expect([res.status, res.body]).toEqual([404, IMAGE_NOT_FOUND]);
    // The user still points at it.
    expect((await member.get("/me")).body.data.user.avatarUrl).toBe(`/api/images/${name}`);
    // Replacing it works although there is nothing to remove.
    const next = await avatarName(member, PNG);
    expect((await fetchImage(next)).status).toBe(200);
    expect(await imageRow(name)).toBeNull();
  });

  test("a page's file is not reachable as an image", async () => {
    const page = (await owner.post("/pages", { spaceId, title: "Not an image" })).body.data.page;
    const uploaded = await owner.uploadFile(new File([PNG], "picture.png", { type: "image/png" }), page.id);
    expect(uploaded.status).toBe(200);
    const res = await t.client().get(`/images/${uploaded.body.data.id}.png`);
    expect([res.status, res.body]).toEqual([404, IMAGE_NOT_FOUND]);
  });
});
