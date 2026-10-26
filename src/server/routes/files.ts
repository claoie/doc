import type { UploadedFile } from "common/api-types";
import { isUuid } from "common/ids";
import { config } from "server/config";
import { sql } from "server/db";
import { IMAGE_NAME_RE, mimeFor, serveObject } from "server/lib/files";
import { HttpError, badRequest, notFound, post, publicGet, unauthorized } from "server/lib/http";
import { requirePage } from "server/lib/pages";
import { spaceRole } from "server/lib/permissions";
import { shareAllowsPage } from "server/lib/shares";
import { fileStorageKey, safeFileName, storage, TooLarge } from "server/lib/storage";
import { Input } from "server/lib/validate";

const fileUrl = (id: string, name: string) => `/api/files/${id}/${encodeURIComponent(name)}`;

const tooLarge = (limit: number) => new HttpError(413, "payload_too_large", `Files must be at most ${limit} bytes`);

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export const routes = [
  /**
   * The request body is the file itself (query: `pageId`, `name`, optional
   * `replaceId`); it is streamed to storage, never buffered.
   */
  post("/files", async (ctx): Promise<UploadedFile> => {
    const limit = config.fileSizeLimit;
    const query = Input.query(ctx.url);
    const { page } = await requirePage(ctx.user, query.string("pageId", { max: 64 }), "writer");
    const declared = Number(ctx.req.headers.get("content-length") ?? "0");
    if (declared > limit) throw tooLarge(limit);
    if (!ctx.req.body) throw badRequest("The file is empty");
    const type = (ctx.req.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const replaceId = query.optionalString("replaceId", { max: 64 });
    const store = async (key: string) => {
      try {
        return await storage.putStream(key, ctx.req.body!, limit);
      } catch (error) {
        if (error instanceof TooLarge) throw tooLarge(limit);
        throw error;
      }
    };

    if (replaceId) {
      if (!isUuid(replaceId)) throw notFound("File");
      const [existing] = await sql`
        SELECT id, name, storage_key FROM files
        WHERE id = ${replaceId} AND purpose = 'page' AND space_id = ${page.space_id}`;
      if (!existing) throw notFound("File");
      const mime = mimeFor(existing.name, type);
      // Write beside the old object so a failed upload leaves the file intact.
      const key = fileStorageKey(crypto.randomUUID(), existing.name);
      const size = await store(key);
      // The locked read returns the key current at swap time, so concurrent
      // replacements each remove the object they superseded.
      const swapped = await sql`
        UPDATE files f SET size = ${size}, mime = ${mime}, storage_key = ${key}, updated_at = now()
        FROM (SELECT id, storage_key FROM files WHERE id = ${existing.id} FOR UPDATE) prev
        WHERE f.id = prev.id
        RETURNING prev.storage_key AS old_key`.catch(async (error: unknown) => {
        await storage.remove(key);
        throw error;
      });
      if (!swapped.length) {
        await storage.remove(key);
        throw notFound("File");
      }
      await storage.remove(swapped[0].old_key);
      return { id: existing.id, name: existing.name, mime, size, url: fileUrl(existing.id, existing.name) };
    }

    const id = crypto.randomUUID();
    const name = safeFileName(query.optionalString("name", { max: 1024 }) || "file");
    const mime = mimeFor(name, type);
    const key = fileStorageKey(id, name);
    const size = await store(key);
    try {
      await sql`
        INSERT INTO files (id, purpose, page_id, space_id, uploader_id, name, mime, size, storage_key)
        VALUES (${id}, 'page', ${page.id}, ${page.space_id}, ${ctx.user.id}, ${name}, ${mime}, ${size}, ${key})`;
    } catch (error) {
      await storage.remove(key);
      throw error;
    }
    return { id, name, mime, size, url: fileUrl(id, name) };
  }),

  publicGet("/files/:id/:name", async (ctx) => {
    if (!isUuid(ctx.params.id)) throw notFound("File");
    const [file] = await sql`
      SELECT id, page_id, space_id, name, mime, size, storage_key, updated_at FROM files
      WHERE id = ${ctx.params.id} AND purpose = 'page'`;
    if (!file) throw notFound("File");
    const shareKey = ctx.url.searchParams.get("share");
    if (shareKey) {
      if (!file.page_id || !(await shareAllowsPage(shareKey, file.page_id))) throw notFound("File");
    } else {
      if (!ctx.user) throw unauthorized();
      if (!file.space_id || !(await spaceRole(ctx.user.id, file.space_id))) throw notFound("File");
    }
    const object = await storage.get(file.storage_key);
    if (!object) throw notFound("File");
    const updated = new Date(file.updated_at);
    return serveObject(ctx.req, object, {
      mime: file.mime,
      name: file.name,
      etag: `"${file.id}-${updated.getTime()}-${object.size}"`,
      lastModified: updated,
      cacheControl: "private, no-cache",
    });
  }),

  publicGet("/images/:name", async (ctx) => {
    const name = ctx.params.name!;
    if (!IMAGE_NAME_RE.test(name)) throw notFound("Image");
    const object = await storage.get(`images/${name}`);
    if (!object) throw notFound("Image");
    return serveObject(ctx.req, object, {
      mime: IMAGE_MIME[name.split(".").pop()!]!,
      name,
      etag: `"${name}"`,
      cacheControl: "public, max-age=31536000, immutable",
    });
  }),
];
