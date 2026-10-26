import { describe, expect, test } from "bun:test";
import { crc32, readZipDirectory, readZipEntry, zipStream } from "./zip";

const scratch = `${process.env.TMPDIR ?? "/tmp"}/zip-test-${process.pid}.zip`;

describe("zip", () => {
  test("crc32 matches the reference check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("round-trips entries through the central directory and unzip", async () => {
    const big = "lorem ipsum ".repeat(5000);
    const streamed = new Uint8Array(70_000).map((_, i) => (i * 7) % 251);
    const zip = new Uint8Array(
      await new Response(
        zipStream([
          { name: "Page.md", data: big },
          { name: "Folder/Child (1).html", data: "<h1>한국어</h1>" },
          { name: "files/abc/image.bin", size: streamed.length, open: () => new Blob([streamed]).stream() },
        ]),
      ).arrayBuffer(),
    );
    const entries = readZipDirectory(zip);
    expect(entries.map((e) => e.name)).toEqual(["Page.md", "Folder/Child (1).html", "files/abc/image.bin"]);
    expect(entries[0]!.method).toBe(8);
    expect(entries[2]!.method).toBe(0);
    expect(new TextDecoder().decode(readZipEntry(zip, entries[0]!))).toBe(big);
    expect(new TextDecoder().decode(readZipEntry(zip, entries[1]!))).toBe("<h1>한국어</h1>");
    expect(readZipEntry(zip, entries[2]!)).toEqual(streamed);

    await Bun.write(scratch, zip);
    const check = Bun.spawnSync(["unzip", "-t", scratch]);
    expect(check.exitCode).toBe(0);
    expect(check.stdout.toString()).toContain("No errors detected");
    await Bun.file(scratch).delete();
  });
});
