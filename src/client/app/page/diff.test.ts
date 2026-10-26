import { describe, expect, test } from "bun:test";
import { diffDocs } from "./diff";

const doc = (...texts: string[]) => ({ type: "doc", content: texts.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })) });

describe("version diff", () => {
  test("marks changed words inside a modified block and whole added blocks", () => {
    const result = diffDocs(doc("hello world", "keep"), doc("hello there world", "keep", "new block"));
    expect(result[0]).toEqual([
      { kind: "same", text: "hello " },
      { kind: "added", text: "there " },
      { kind: "same", text: "world" },
    ]);
    expect(result[1]).toEqual([{ kind: "same", text: "keep" }]);
    expect(result[2]).toEqual([{ kind: "added", text: "new block" }]);
  });
});
