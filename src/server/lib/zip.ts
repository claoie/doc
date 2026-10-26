import { chunks } from "./streams";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export const crc32Update = (crc: number, bytes: Uint8Array): number => {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export const crc32 = (bytes: Uint8Array) => crc32Update(0, bytes);

export type ZipInput =
  | { name: string; data: Uint8Array | string; date?: Date }
  /** Streamed without compression; `open` is called twice (checksum pass, then data pass). */
  | { name: string; size: number; open: () => ReadableStream<Uint8Array>; date?: Date };

const encoder = new TextEncoder();
const LIMIT = 0xffffffff;

const dosDateTime = (date: Date) => {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};

interface CentralRecord {
  name: Uint8Array;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

const localHeader = (r: CentralRecord) => {
  const out = new Uint8Array(30 + r.name.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 0x0800, true);
  v.setUint16(8, r.method, true);
  v.setUint16(10, r.time, true);
  v.setUint16(12, r.date, true);
  v.setUint32(14, r.crc, true);
  v.setUint32(18, r.compressedSize, true);
  v.setUint32(22, r.size, true);
  v.setUint16(26, r.name.length, true);
  v.setUint16(28, 0, true);
  out.set(r.name, 30);
  return out;
};

const centralHeader = (r: CentralRecord) => {
  const out = new Uint8Array(46 + r.name.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 20, true);
  v.setUint16(8, 0x0800, true);
  v.setUint16(10, r.method, true);
  v.setUint16(12, r.time, true);
  v.setUint16(14, r.date, true);
  v.setUint32(16, r.crc, true);
  v.setUint32(20, r.compressedSize, true);
  v.setUint32(24, r.size, true);
  v.setUint16(28, r.name.length, true);
  v.setUint32(42, r.offset, true);
  out.set(r.name, 46);
  return out;
};

const endOfCentralDirectory = (count: number, size: number, offset: number) => {
  const out = new Uint8Array(22);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, size, true);
  v.setUint32(16, offset, true);
  return out;
};

async function* generate(inputs: AsyncIterable<ZipInput> | Iterable<ZipInput>): AsyncGenerator<Uint8Array> {
  const records: CentralRecord[] = [];
  let offset = 0;
  for await (const input of inputs) {
    if (records.length >= 0xffff) throw new Error("too many zip entries");
    const { time, date } = dosDateTime(input.date ?? new Date());
    const name = encoder.encode(input.name);
    if ("data" in input) {
      const raw = typeof input.data === "string" ? encoder.encode(input.data) : input.data;
      const compressed = Bun.deflateSync(raw as Uint8Array<ArrayBuffer>);
      const deflate = compressed.length < raw.length;
      const body = deflate ? compressed : raw;
      const record: CentralRecord = {
        name,
        method: deflate ? 8 : 0,
        crc: crc32(raw),
        compressedSize: body.length,
        size: raw.length,
        offset,
        time,
        date,
      };
      if (offset + 30 + name.length + body.length > LIMIT) throw new Error("zip archive too large");
      const header = localHeader(record);
      yield header;
      yield body;
      offset += header.length + body.length;
      records.push(record);
    } else {
      if (offset + input.size + 30 + name.length > LIMIT) throw new Error("zip archive too large");
      let crc = 0;
      let size = 0;
      for await (const chunk of chunks(input.open())) {
        crc = crc32Update(crc, chunk);
        size += chunk.length;
      }
      const record: CentralRecord = { name, method: 0, crc, compressedSize: size, size, offset, time, date };
      const header = localHeader(record);
      yield header;
      let written = 0;
      for await (const chunk of chunks(input.open())) {
        written += chunk.length;
        yield chunk;
      }
      if (written !== size) throw new Error(`zip entry ${input.name} changed while archiving`);
      offset += header.length + size;
      records.push(record);
    }
  }
  const directoryOffset = offset;
  let directorySize = 0;
  for (const record of records) {
    const header = centralHeader(record);
    directorySize += header.length;
    yield header;
  }
  yield endOfCentralDirectory(records.length, directorySize, directoryOffset);
}

/** Streams a zip archive (deflate for in-memory entries, stored for streamed ones). */
export const zipStream = (inputs: AsyncIterable<ZipInput> | Iterable<ZipInput>): ReadableStream<Uint8Array> => {
  const iterator = generate(inputs);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
};

export interface ZipDirectoryEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** Reads the central directory of a zip archive held in memory. */
export const readZipDirectory = (zip: Uint8Array): ZipDirectoryEntry[] => {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip archive");
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const entries: ZipDirectoryEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt central directory");
    const nameLength = v.getUint16(p + 28, true);
    const extraLength = v.getUint16(p + 30, true);
    const commentLength = v.getUint16(p + 32, true);
    entries.push({
      name: decoder.decode(zip.subarray(p + 46, p + 46 + nameLength)),
      method: v.getUint16(p + 10, true),
      crc: v.getUint32(p + 16, true),
      compressedSize: v.getUint32(p + 20, true),
      size: v.getUint32(p + 24, true),
      offset: v.getUint32(p + 42, true),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

/** Extracts one entry's bytes from an in-memory archive. */
export const readZipEntry = (zip: Uint8Array, entry: ZipDirectoryEntry): Uint8Array => {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const start = entry.offset + 30 + v.getUint16(entry.offset + 26, true) + v.getUint16(entry.offset + 28, true);
  const body = zip.subarray(start, start + entry.compressedSize);
  return entry.method === 8 ? Bun.inflateSync(body as Uint8Array<ArrayBuffer>) : body;
};
