import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { uuid } from "./ids";

describe("uuid", () => {
  test("is a random v4 UUID", () => {
    const ids = Array.from({ length: 200 }, uuid);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(200);
  });

  test("works without crypto.randomUUID, as in pages served over plain http", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      expect(uuid()).toHaveLength(36);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });

  test("browser code never calls the secure-context-only crypto.randomUUID", async () => {
    const offenders: string[] = [];
    for (const dir of ["src/client", "src/common"]) {
      for await (const file of new Glob("**/*.{ts,tsx}").scan(dir)) {
        if (file.endsWith(".test.ts")) continue;
        const text = await Bun.file(`${dir}/${file}`).text();
        if (/crypto\.randomUUID\(/.test(text)) offenders.push(`${dir}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
