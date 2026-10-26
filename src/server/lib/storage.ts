import { mkdir, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { S3Client } from "bun";
import { config } from "server/config";

export interface StoredObject {
  size: number;
  /** Body for the whole object or the inclusive byte range `[start, end]`. */
  body(start?: number, end?: number): BodyInit;
}

export class TooLarge extends Error {}

/** Yields the chunks of `stream`, throwing `TooLarge` once more than `limit` bytes have passed. */
async function* limited(stream: ReadableStream<Uint8Array>, limit: number): AsyncGenerator<Uint8Array> {
  let size = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > limit) throw new TooLarge();
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

interface Driver {
  put(key: string, data: Blob | Uint8Array | string): Promise<void>;
  /** Writes a stream without holding it in memory; returns its size. Nothing is kept on failure. */
  putStream(key: string, stream: ReadableStream<Uint8Array>, limit: number): Promise<number>;
  get(key: string): Promise<StoredObject | null>;
  remove(key: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
}

const assertKey = (key: string) => {
  if (!/^(files|images)\/[^\\\0]+$/.test(key) || key.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new Error("invalid storage key");
  }
};

const localDriver = (root: string): Driver => {
  const resolve = (key: string) => {
    assertKey(key);
    return path.join(path.resolve(root), key);
  };
  return {
    async put(key, data) {
      await Bun.write(resolve(key), data);
    },
    async putStream(key, stream, limit) {
      const target = resolve(key);
      await mkdir(path.dirname(target), { recursive: true });
      const sink = Bun.file(target).writer();
      let size = 0;
      try {
        for await (const chunk of limited(stream, limit)) {
          sink.write(chunk);
          await sink.flush();
          size += chunk.byteLength;
        }
        await sink.end();
        return size;
      } catch (error) {
        await Promise.resolve(sink.end()).catch(() => undefined);
        await rm(target, { force: true });
        if (key.startsWith("files/")) await rmdir(path.dirname(target)).catch(() => undefined);
        throw error;
      }
    },
    async get(key) {
      const file = Bun.file(resolve(key));
      const info = await stat(resolve(key)).catch(() => null);
      if (!info?.isFile()) return null;
      return {
        size: info.size,
        body: (start, end) => (start === undefined ? file : file.slice(start, (end ?? info.size - 1) + 1)),
      };
    },
    async remove(key) {
      const target = resolve(key);
      await rm(target, { force: true });
      if (key.startsWith("files/")) await rmdir(path.dirname(target)).catch(() => undefined);
    },
    async copy(from, to) {
      await Bun.write(resolve(to), Bun.file(resolve(from)));
    },
  };
};

const s3Driver = (): Driver => {
  const s3 = config.s3;
  const client = new S3Client({
    bucket: s3.bucket,
    region: s3.region,
    endpoint: s3.endpoint,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    virtualHostedStyle: !s3.forcePathStyle,
  });
  return {
    async put(key, data) {
      assertKey(key);
      await client.write(key, data);
    },
    async putStream(key, stream, limit) {
      assertKey(key);
      const sink = client.file(key).writer({ partSize: 5 * 1024 * 1024, queueSize: 1 });
      let size = 0;
      try {
        for await (const chunk of limited(stream, limit)) {
          sink.write(chunk);
          await sink.flush();
          size += chunk.byteLength;
        }
        await sink.end();
        return size;
      } catch (error) {
        await Promise.resolve(sink.end()).catch(() => undefined);
        await client.delete(key).catch(() => undefined);
        throw error;
      }
    },
    async get(key) {
      assertKey(key);
      const file = client.file(key);
      const info = await file.stat().catch(() => null);
      if (!info) return null;
      return {
        size: info.size,
        // An S3File handed to Response becomes a redirect; streaming keeps our headers.
        body: (start, end) =>
          (start === undefined ? file : file.slice(start, (end ?? info.size - 1) + 1)).stream(),
      };
    },
    async remove(key) {
      assertKey(key);
      await client.delete(key).catch(() => undefined);
    },
    async copy(from, to) {
      assertKey(from);
      assertKey(to);
      await client.write(to, client.file(from));
    },
  };
};

let driver: Driver | null = null;

const current = (): Driver => (driver ??= config.storageDriver === "s3" ? s3Driver() : localDriver(config.storagePath));

/** Re-reads the storage configuration (used by tests after changing env). */
export const resetStorage = () => {
  driver = null;
};

export const storage = {
  put: (key: string, data: Blob | Uint8Array | string) => current().put(key, data),
  putStream: (key: string, stream: ReadableStream<Uint8Array>, limit: number) => current().putStream(key, stream, limit),
  get: (key: string) => current().get(key),
  remove: (key: string) => current().remove(key),
  copy: (from: string, to: string) => current().copy(from, to),
  removeMany: async (keys: readonly string[]) => {
    for (const key of keys) await current().remove(key);
  },
};

/** File name safe for storage keys and headers: no path separators or control characters, ≤ 255 chars. */
export const safeFileName = (name: string): string => {
  const cleaned = name
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\]+/g, "")
    .replace(/^[.\s]+/, "")
    .trim();
  const chars = [...cleaned];
  if (chars.length <= 255) return cleaned || "file";
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : "";
  return chars.slice(0, 255 - [...ext].length).join("") + ext;
};

export const fileStorageKey = (fileId: string, name: string) => `files/${fileId}/${safeFileName(name)}`;
