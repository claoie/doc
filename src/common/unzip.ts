/**
 * Minimal zip reader (stored and deflated entries) built on the platform's
 * DecompressionStream, for importing exported page folders.
 */
export interface ZipEntry {
  name: string;
  size: number;
  read: () => Promise<Uint8Array>;
}

const MAX_ENTRIES = 20000;
const MAX_TOTAL = 512 * 1024 * 1024;

const inflateRaw = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export const readZip = (buffer: ArrayBuffer): ZipEntry[] => {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file");
  const count = view.getUint16(eocd + 10, true);
  if (count > MAX_ENTRIES) throw new Error("Zip has too many entries");
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Corrupt zip directory");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    total += size;
    if (total > MAX_TOTAL) throw new Error("Zip contents are too large");
    if (name.endsWith("/") || name.includes("..") || name.startsWith("/") || name.startsWith("__MACOSX/")) continue;
    entries.push({
      name,
      size,
      read: async () => {
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const data = bytes.subarray(start, start + compressedSize);
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new Error(`Unsupported compression in ${name}`);
      },
    });
  }
  return entries;
};
