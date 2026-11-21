/**
 * A strict reader for the zip archives the servers produce, so tests can
 * check what an export contains without an `unzip` binary. It reads the whole
 * archive (no zip64, no encryption, no spanning) and throws on anything a
 * careful unzip tool would complain about.
 */

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflated. */
  method: number;
  /** General purpose flags; bit 11 (0x0800) says the name is UTF-8. */
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** The entry's time stamp, read as UTC. */
  modified: Date;
  /** The uncompressed bytes. */
  data: Uint8Array;
  /** The uncompressed bytes as UTF-8 text. */
  text: string;
}

const fail = (message: string): never => {
  throw new Error(`invalid zip archive: ${message}`);
};

const dosDate = (date: number, time: number) =>
  new Date(Date.UTC(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2));

/**
 * Parses an archive: finds the end-of-central-directory record at the very
 * end, walks the central directory, and for each entry checks that its local
 * header agrees with the directory, that entries follow each other without
 * gaps, and that the data inflates to the recorded size and CRC-32.
 */
export const readZip = (zip: Uint8Array): ZipEntry[] => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50) fail("no end-of-central-directory record at the end");
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) fail("multi-disk archive");
  const count = view.getUint16(end + 10, true);
  if (view.getUint16(end + 8, true) !== count) fail("entry counts disagree");
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 20, true) !== 0) fail("unexpected archive comment");
  if (directoryOffset + directorySize !== end) fail("the central directory does not end where the end record starts");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  let expectedOffset = 0;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) fail(`entry ${i}: bad central directory signature`);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const nameBytes = zip.subarray(at + 46, at + 46 + nameLength);
    const name = decoder.decode(nameBytes);
    at += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x0001) fail(`${name}: encrypted`);
    if (flags & 0x0008) fail(`${name}: sizes in a data descriptor`);
    if (method !== 0 && method !== 8) fail(`${name}: unsupported compression method ${method}`);
    if (offset !== expectedOffset) fail(`${name}: starts at ${offset}, expected ${expectedOffset}`);
    if (view.getUint32(offset, true) !== 0x04034b50) fail(`${name}: bad local header signature`);
    const localNameLength = view.getUint16(offset + 26, true);
    const localExtraLength = view.getUint16(offset + 28, true);
    const localName = decoder.decode(zip.subarray(offset + 30, offset + 30 + localNameLength));
    if (localName !== name) fail(`${name}: the local header names ${localName}`);
    if (
      view.getUint16(offset + 6, true) !== flags ||
      view.getUint16(offset + 8, true) !== method ||
      view.getUint16(offset + 10, true) !== time ||
      view.getUint16(offset + 12, true) !== date ||
      view.getUint32(offset + 14, true) !== crc ||
      view.getUint32(offset + 18, true) !== compressedSize ||
      view.getUint32(offset + 22, true) !== size
    ) {
      fail(`${name}: the local header disagrees with the central directory`);
    }
    const start = offset + 30 + localNameLength + localExtraLength;
    const body = zip.subarray(start, start + compressedSize);
    if (body.length !== compressedSize) fail(`${name}: data cut short`);
    expectedOffset = start + compressedSize;
    if (method === 0 && compressedSize !== size) fail(`${name}: stored entry with different sizes`);
    const data = method === 8 ? Bun.inflateSync(body as Uint8Array<ArrayBuffer>) : body;
    if (data.length !== size) fail(`${name}: inflates to ${data.length} bytes, recorded ${size}`);
    if (Bun.hash.crc32(data) !== crc) fail(`${name}: CRC-32 mismatch`);
    if (name.startsWith("/") || name.split("/").includes("..") || name.includes("\\")) fail(`${name}: unsafe entry name`);
    if (!(flags & 0x0800) && [...nameBytes].some((b) => b > 0x7f)) fail(`${name}: a non-ASCII name without the UTF-8 flag`);
    const copy = data.slice();
    entries.push({ name, method, flags, crc, compressedSize, size, modified: dosDate(date, time), data: copy, text: new TextDecoder().decode(copy) });
  }
  if (at !== end) fail("the central directory has a different size than recorded");
  if (expectedOffset !== directoryOffset) fail("the central directory does not follow the last entry");
  const names = entries.map((entry) => entry.name);
  if (new Set(names).size !== names.length) fail("duplicate entry names");
  return entries;
};
