import { describe, expect, test } from "bun:test";
import { cleanUrl, sanitizeNode, sanitizeStep } from "./sanitize";

describe("cleanUrl", () => {
  test("keeps safe URLs", () => {
    for (const url of ["/api/files/1/a.pdf", "#heading", "https://example.com", "http://x.y/z", "mailto:a@b.c", "tel:+1", "page"]) {
      expect(cleanUrl(url)).toBe(url);
    }
  });

  test("drops script URLs, including obfuscated schemes", () => {
    for (const url of ["javascript:alert(1)", " JavaScript:alert(1)", "java\tscript:alert(1)", "java\u0000script:x", "vbscript:x", "data:text/html,<script>", "file:///etc/passwd"]) {
      expect(cleanUrl(url)).toBe("");
    }
  });

  test("allows data images only when asked", () => {
    expect(cleanUrl("data:image/png;base64,AAAA")).toBe("");
    expect(cleanUrl("data:image/png;base64,AAAA", true)).toBe("data:image/png;base64,AAAA");
    expect(cleanUrl("data:text/html;base64,AAAA", true)).toBe("");
  });
});

describe("sanitizeNode", () => {
  test("cleans node and mark URL attributes deeply", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "pdf", attrs: { src: "javascript:alert(1)", name: "x" } },
        { type: "attachment", attrs: { url: "/api/files/1/a" } },
        { type: "paragraph", content: [{ type: "text", text: "hi", marks: [{ type: "link", attrs: { href: "javascript:x" } }] }] },
        { type: "image", attrs: { src: "data:image/png;base64,AA" } },
      ],
    };
    const clean = sanitizeNode(doc);
    expect(clean.content![0]!.attrs!.src).toBe("");
    expect(clean.content![1]).toBe(doc.content[1]);
    expect(clean.content![2]!.content![0]!.marks![0]!.attrs!.href).toBe("");
    expect(clean.content![3]!.attrs!.src).toBe("data:image/png;base64,AA");
  });
});

describe("sanitizeStep", () => {
  test("cleans inserted slices, marks and attribute changes", () => {
    const replace = sanitizeStep({ stepType: "replace", from: 1, to: 1, slice: [{ o: "pdf", a: { src: "javascript:x" } }, { c: 1 }] });
    expect(replace).toEqual({ stepType: "replace", from: 1, to: 1, slice: [{ o: "pdf", a: { src: "" } }, { c: 1 }] });
    const mark = sanitizeStep({ stepType: "addMark", from: 1, to: 2, mark: { type: "link", attrs: { href: "javascript:x" } } });
    expect(mark).toMatchObject({ mark: { attrs: { href: "" } } });
    const attr = sanitizeStep({ stepType: "attr", pos: 3, attrs: { src: "javascript:x", width: 10 } });
    expect(attr).toEqual({ stepType: "attr", pos: 3, attrs: { src: "", width: 10 } });
  });
});
