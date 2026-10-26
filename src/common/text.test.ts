import { describe, expect, test } from "bun:test";
import type { Node } from "./editor/model";
import { docLinks, docMentionedUserIds, docText, pageSlugIdFromHref } from "./text";

const p = (...content: Node[]): Node => ({ type: "paragraph", content });
const t = (text: string, marks?: Node["marks"]): Node => ({ type: "text", text, ...(marks ? { marks } : {}) });

const doc: Node = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [t("Title")] },
    p(t("Hello "), { type: "mention", attrs: { entityType: "user", entityId: "u1", label: "Sam" } }, t("!")),
    p(),
    {
      type: "bulletList",
      content: [{ type: "listItem", content: [p(t("item "), { type: "mathInline", attrs: { text: "x^2" } })] }],
    },
    { type: "mathBlock", attrs: { text: "E = mc^2" } },
    { type: "codeBlock", content: [t("const a = 1;\nconst b = 2;")] },
    p(
      { type: "mention", attrs: { entityType: "page", entityId: "p-uuid", slugId: "abc", label: "Other page" } },
      t(" and "),
      t("link", [{ type: "link", attrs: { href: "/s/general/p/my-title-XyZ123" } }]),
      t(" and "),
      t("short", [{ type: "link", attrs: { href: "https://doc.example.com/p/Q1w2E3#heading" } }]),
      t(" and "),
      t("external", [{ type: "link", attrs: { href: "https://example.com/blog" } }]),
    ),
    p(t("again "), { type: "mention", attrs: { entityType: "user", entityId: "u1", label: "Sam" } }),
    p({ type: "mention", attrs: { entityType: "user", entityId: "u2", label: "Lee" } }),
  ],
};

describe("docText", () => {
  test("joins blocks with newlines and includes inline atoms", () => {
    expect(docText(doc)).toBe(
      [
        "Title",
        "Hello Sam!",
        "item x^2",
        "E = mc^2",
        "const a = 1;\nconst b = 2;",
        "Other page and link and short and external",
        "again Sam",
        "Lee",
      ].join("\n"),
    );
  });

  test("handles empty input", () => {
    expect(docText(null)).toBe("");
    expect(docText({ type: "doc", content: [p()] })).toBe("");
  });
});

describe("docLinks", () => {
  test("collects page mentions and internal links", () => {
    expect(docLinks(doc)).toEqual({ pageIds: ["p-uuid"], slugIds: ["XyZ123", "Q1w2E3"] });
  });

  test("parses page hrefs", () => {
    expect(pageSlugIdFromHref("/s/space/p/a-b-c-SLUG1")).toBe("SLUG1");
    expect(pageSlugIdFromHref("/s/space/p/SLUG2")).toBe("SLUG2");
    expect(pageSlugIdFromHref("/p/SLUG3?x=1")).toBe("SLUG3");
    expect(pageSlugIdFromHref("/s/space/p/%ED%95%9C-SLUG4")).toBe("SLUG4");
    expect(pageSlugIdFromHref("/settings")).toBeNull();
    expect(pageSlugIdFromHref("/s/space/p/title-sl/ug")).toBeNull();
    expect(pageSlugIdFromHref(undefined)).toBeNull();
  });
});

describe("docMentionedUserIds", () => {
  test("dedupes mentioned users", () => {
    expect(docMentionedUserIds(doc)).toEqual(["u1", "u2"]);
  });
});
