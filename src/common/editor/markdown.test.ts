import { describe, expect, test } from "bun:test";
import { docToMarkdown, markdownToDoc } from "./markdown";
import { schema } from "./doc-schema";

const roundTrip = (md: string) => docToMarkdown(markdownToDoc(md));

describe("markdown", () => {
  test("parses common blocks", () => {
    const doc = markdownToDoc(`# Title\n\nSome **bold** and *italic* with \`code\` and [a link](https://x.y).\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [ ] todo\n- [x] done\n\n> quote\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n:::warning\nCareful\n:::\n\n$$\nx^2\n$$\n`);
    expect(schema.check(doc)).toBeNull();
    expect(doc.content!.map((n) => n.type)).toEqual([
      "heading", "paragraph", "bulletList", "orderedList", "taskList", "blockquote", "codeBlock", "horizontalRule", "table", "callout", "mathBlock",
    ]);
    const para = doc.content![1]!;
    expect(para.content!.find((n) => n.text === "bold")!.marks).toEqual([{ type: "bold" }]);
    expect(para.content!.find((n) => n.text === "a link")!.marks![0]!.type).toBe("link");
    const nested = doc.content![2]!.content![1]!.content![1]!;
    expect(nested.type).toBe("bulletList");
    expect(doc.content![4]!.content![1]!.attrs!.checked).toBe(true);
  });

  test("round trips", () => {
    const md = `# Title\n\nSome **bold** text, ~~struck~~, ==marked==.\n\n- one\n- two\n\n1. a\n2. b\n\n\`\`\`js\nx()\n\`\`\`\n\n| h1 | h2 |\n| --- | --- |\n| c1 | c2 |\n`;
    expect(roundTrip(md)).toBe(md);
  });

  test("keeps korean text and inline math", () => {
    const doc = markdownToDoc("안녕하세요 $a+b$ 세계");
    expect(doc.content![0]!.content!.map((n) => n.type)).toEqual(["text", "mathInline", "text"]);
  });

  test("escapes special characters", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a *b* [c]" }] }] };
    const md = docToMarkdown(doc);
    expect(markdownToDoc(md).content![0]!.content).toEqual([{ type: "text", text: "a *b* [c]" }]);
  });
});
