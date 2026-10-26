import { sql } from "server/db";
import { HttpError, badRequest } from "./http";
import { storage, type StoredObject } from "./storage";

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  drawio: "application/vnd.jgraph.mxfile",
  excalidraw: "application/json",
};

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

export const mimeFor = (name: string, declared?: string | null): string => {
  const type = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  if (type && type !== "application/octet-stream" && MIME_RE.test(type)) return type;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
};

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon"]);

/** Only types the browser renders passively are shown inline; everything else downloads. */
export const isInlineSafe = (mime: string) =>
  INLINE_IMAGE_TYPES.has(mime) || mime === "application/pdf" || /^(audio|video)\/[a-z0-9.+-]+$/.test(mime);

export const contentDisposition = (kind: "inline" | "attachment", name: string) => {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

const IMAGE_TYPES: { mime: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: "image/png", ext: "png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", ext: "gif", test: (b) => String.fromCharCode(...b.subarray(0, 4)) === "GIF8" },
  {
    mime: "image/webp",
    ext: "webp",
    test: (b) => String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP",
  },
];

const IMAGE_LIMIT = 10 * 1024 * 1024;

export type ImagePurpose = "avatar" | "workspace-logo" | "space-icon";

/** Stores an avatar/logo/icon after checking its magic bytes; returns the image file name. */
export const saveImage = async (file: File, purpose: ImagePurpose, uploaderId: string, spaceId?: string) => {
  if (file.size > IMAGE_LIMIT) throw new HttpError(413, "payload_too_large", "Images must be at most 10 MB");
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const type = IMAGE_TYPES.find((t) => t.test(head));
  if (!type) throw badRequest("Images must be PNG, JPEG, WebP or GIF");
  const name = `${crypto.randomUUID()}.${type.ext}`;
  const key = `images/${name}`;
  await storage.put(key, file);
  await sql`
    INSERT INTO files (purpose, space_id, uploader_id, name, mime, size, storage_key)
    VALUES (${purpose}, ${spaceId ?? null}, ${uploaderId}, ${name}, ${type.mime}, ${file.size}, ${key})`;
  return name;
};

export const removeImage = async (name: string | null | undefined) => {
  if (!name) return;
  const key = `images/${name}`;
  await sql`DELETE FROM files WHERE storage_key = ${key}`;
  await storage.remove(key);
};

export const IMAGE_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

const parseRange = (header: string, size: number): { start: number; end: number } | "invalid" | null => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, a, b] = match;
  if (!a && !b) return "invalid";
  let start: number;
  let end: number;
  if (!a) {
    start = Math.max(0, size - Number(b));
    end = size - 1;
  } else {
    start = Number(a);
    end = b ? Math.min(Number(b), size - 1) : size - 1;
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
};

export interface ServeOptions {
  mime: string;
  name: string;
  etag: string;
  lastModified?: Date;
  cacheControl: string;
  /** Force a download regardless of type. */
  download?: boolean;
}

/** Serves a stored object with range, conditional and safe-content headers. */
export const serveObject = (req: Request, object: StoredObject, options: ServeOptions): Response => {
  const inline = !options.download && isInlineSafe(options.mime);
  const headers = new Headers({
    "Content-Type": options.mime,
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", options.name),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": options.cacheControl,
    "Accept-Ranges": "bytes",
    ETag: options.etag,
  });
  if (options.mime !== "application/pdf") headers.set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
  if (options.lastModified) headers.set("Last-Modified", options.lastModified.toUTCString());
  if (req.headers.get("if-none-match") === options.etag) return new Response(null, { status: 304, headers });

  const rangeHeader = req.headers.get("range");
  const ifRange = req.headers.get("if-range");
  const range = rangeHeader && (!ifRange || ifRange === options.etag) ? parseRange(rangeHeader, object.size) : null;
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${object.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${object.size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(object.body(range.start, range.end), { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body(), { status: 200, headers });
};
