import type { Mark, Node } from "./model";
import { schema } from "./doc-schema";
import { addToMarkSet } from "./steps";
import { docToHtml, type HtmlOptions } from "./html";

// ===========================================================================
// Serializer
// ===========================================================================

export type MarkdownOptions = HtmlOptions;

const escapeText = (text: string) =>
  text
    .replace(/[\\`*_[\]<>~|]/g, (c) => "\\" + c)
    .replace(/==/g, "\\==")
    .replace(/\$(?=\S)/g, "\\$");

const escapeLineStart = (line: string) =>
  line.replace(/^(\s*)(#{1,6}\s|[-+]\s|\d+[.)]\s|>)/, (_m, sp: string, tok: string) => sp + "\\" + tok);

const MARK_SYNTAX: Record<string, [string, string]> = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  strike: ["~~", "~~"],
  highlight: ["==", "=="],
  underline: ["<u>", "</u>"],
  subscript: ["<sub>", "</sub>"],
  superscript: ["<sup>", "</sup>"],
};

const MARK_ORDER = ["link", "bold", "italic", "strike", "highlight", "underline", "subscript", "superscript"];

const inlineToMarkdown = (nodes: Node[], opts: MarkdownOptions): string => {
  let out = "";
  let open: Mark[] = [];
  const closeMark = (mark: Mark) => {
    if (mark.type === "link") return `](${linkHref(mark.attrs?.href, opts)})`;
    return MARK_SYNTAX[mark.type]?.[1] ?? "";
  };
  const openMark = (mark: Mark) => {
    if (mark.type === "link") return "[";
    return MARK_SYNTAX[mark.type]?.[0] ?? "";
  };
  const relevant = (marks: Mark[] | undefined) =>
    (marks ?? [])
      .filter((m) => m.type in MARK_SYNTAX || m.type === "link")
      .sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));

  const transition = (next: Mark[]) => {
    let keep = 0;
    while (keep < open.length && keep < next.length && sameMarkLoose(open[keep]!, next[keep]!)) keep++;
    for (let i = open.length - 1; i >= keep; i--) out += closeMark(open[i]!);
    for (let i = keep; i < next.length; i++) out += openMark(next[i]!);
    open = next;
  };

  for (const node of nodes) {
    if (node.type === "text") {
      const marks = relevant(node.marks);
      const isCode = node.marks?.some((m) => m.type === "code");
      let text = node.text ?? "";
      // Emphasis markers cannot sit next to whitespace; move it outside.
      const lead = marks.length ? (text.match(/^\s+/)?.[0] ?? "") : "";
      const trail = marks.length ? (text.match(/\s+$/)?.[0] ?? "") : "";
      if (lead || trail) {
        transition(open.filter((m) => marks.some((n) => sameMarkLoose(m, n))));
        out += lead;
        text = text.slice(lead.length, text.length - trail.length);
      }
      transition(marks);
      if (isCode) {
        const ticks = text.includes("`") ? "``" : "`";
        const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
        out += ticks + pad + text + pad + ticks;
      } else {
        out += escapeText(text);
      }
      if (trail) {
        transition([]);
        out += trail;
      }
      continue;
    }
    transition(node.type === "hardBreak" ? open : []);
    out += inlineAtom(node, opts);
  }
  transition([]);
  return out;
};

const sameMarkLoose = (a: Mark, b: Mark) => a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});

const linkHref = (href: unknown, opts: MarkdownOptions) => {
  const s = String(href ?? "");
  const mapped = opts.fileUrl && s.startsWith("/api/files/") ? opts.fileUrl(s) : s;
  return mapped.replace(/[()\s]/g, (c) => encodeURIComponent(c));
};

const inlineAtom = (node: Node, opts: MarkdownOptions): string => {
  const a = node.attrs ?? {};
  switch (node.type) {
    case "hardBreak":
      return "\\\n";
    case "mathInline":
      return `$${String(a.text ?? "")}$`;
    case "mention": {
      const label = String(a.label ?? "");
      if (a.entityType === "user") return `@${label}`;
      if (a.slugId && opts.pageHref) return `[${escapeText(label)}](${opts.pageHref(String(a.slugId), a.anchorId as string | null)})`;
      return escapeText(label);
    }
    case "status":
      return escapeText(String(a.text ?? ""));
    case "footnoteReference":
      return `[^${String(a.referenceNumber ?? a["data-id"] ?? "")}]`;
    default:
      return "";
  }
};

const fileUrl = (src: unknown, opts: MarkdownOptions) => {
  const s = String(src ?? "");
  return (opts.fileUrl ? opts.fileUrl(s) : s).replace(/[()\s]/g, (c) => encodeURIComponent(c));
};

const indentLines = (text: string, first: string, rest: string) =>
  text
    .split("\n")
    .map((line, i) => (i === 0 ? first + line : line ? rest + line : line))
    .join("\n");

const isSimpleTable = (table: Node) =>
  (table.content ?? []).every((row) =>
    (row.content ?? []).every(
      (cell) =>
        Number(cell.attrs?.colspan ?? 1) === 1 &&
        Number(cell.attrs?.rowspan ?? 1) === 1 &&
        (cell.content ?? []).length <= 1 &&
        (cell.content ?? []).every((b) => b.type === "paragraph"),
    ),
  );

const blocksToMarkdown = (nodes: Node[], opts: MarkdownOptions, tight = false): string =>
  nodes
    .map((n) => blockToMarkdown(n, opts))
    .filter((s) => s !== null)
    .join(tight ? "\n" : "\n\n");

const blockToMarkdown = (node: Node, opts: MarkdownOptions): string => {
  const a = node.attrs ?? {};
  const content = node.content ?? [];
  switch (node.type) {
    case "paragraph":
      return inlineToMarkdown(content, opts)
        .split("\n")
        .map(escapeLineStart)
        .join("\n");
    case "heading":
      return "#".repeat(Math.min(6, Math.max(1, Number(a.level) || 1))) + " " + inlineToMarkdown(content, opts).replace(/\\\n/g, " ");
    case "blockquote":
      return blocksToMarkdown(content, opts)
        .split("\n")
        .map((l) => (l ? "> " + l : ">"))
        .join("\n");
    case "bulletList":
    case "taskList":
    case "orderedList": {
      const start = Number(a.start) || 1;
      const tight = content.every((item) => (item.content ?? []).length <= 1 || (item.content ?? []).slice(1).every((c) => ["bulletList", "orderedList", "taskList"].includes(c.type)));
      return content
        .map((item, i) => {
          let marker = node.type === "orderedList" ? `${start + i}. ` : "- ";
          if (item.type === "taskItem") marker += item.attrs?.checked ? "[x] " : "[ ] ";
          const body = blocksToMarkdown(item.content ?? [], opts, tight);
          return indentLines(body || "", marker, " ".repeat(node.type === "orderedList" ? `${start + i}. `.length : 2));
        })
        .join(tight ? "\n" : "\n\n");
    }
    case "codeBlock": {
      const text = content.map((c) => c.text ?? "").join("");
      const fence = text.includes("```") ? "````" : "```";
      return `${fence}${a.language ?? ""}\n${text}\n${fence}`;
    }
    case "horizontalRule":
      return "---";
    case "pageBreak":
      return '<div data-type="pageBreak"></div>';
    case "image":
    case "drawio":
    case "excalidraw":
      return `![${escapeText(String(a.alt ?? a.title ?? ""))}](${fileUrl(a.src, opts)})`;
    case "video":
    case "audio":
    case "pdf": {
      const src = String(a.src ?? "");
      const name = String(a.alt ?? a.name ?? src.split("/").pop() ?? node.type);
      return `[${escapeText(decodeURIComponentSafe(name))}](${fileUrl(src, opts)})`;
    }
    case "attachment":
      return `[${escapeText(String(a.name ?? "file"))}](${fileUrl(a.url, opts)})`;
    case "embed":
    case "youtube":
      return `[${escapeText(String(a.src ?? ""))}](${String(a.src ?? "")})`;
    case "mathBlock":
      return `$$\n${String(a.text ?? "")}\n$$`;
    case "callout":
      return `:::${a.type ?? "info"}\n${blocksToMarkdown(content, opts)}\n:::`;
    case "details": {
      const summary = content.find((c) => c.type === "detailsSummary");
      const body = content.find((c) => c.type === "detailsContent");
      return `<details>\n<summary>${inlineToMarkdown(summary?.content ?? [], opts)}</summary>\n\n${blocksToMarkdown(body?.content ?? [], opts)}\n\n</details>`;
    }
    case "table": {
      if (!isSimpleTable(node)) return docToHtml({ type: "doc", content: [node] }, opts);
      const rows = content.map((row) =>
        (row.content ?? []).map((cell) =>
          inlineToMarkdown(cell.content?.[0]?.content ?? [], opts).replace(/\\\n/g, "<br>").replace(/\|/g, "\\|").replace(/\n/g, " "),
        ),
      );
      const width = Math.max(...rows.map((r) => r.length));
      const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
      const [head, ...body] = rows.map(pad);
      return [
        `| ${head!.join(" | ")} |`,
        `| ${head!.map(() => "---").join(" | ")} |`,
        ...body.map((r) => `| ${r.join(" | ")} |`),
      ].join("\n");
    }
    case "footnotes":
      return content
        .map((fn, i) => indentLines(blocksToMarkdown(fn.content ?? [], opts), `[^${i + 1}]: `, "    "))
        .join("\n");
    case "columns":
    case "column":
    case "transclusionSource":
    case "detailsContent":
      return blocksToMarkdown(content, opts);
    case "transclusionReference":
    case "subpages":
    case "base":
      return "";
    default:
      return content.length ? blocksToMarkdown(content, opts) : "";
  }
};

const decodeURIComponentSafe = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export const docToMarkdown = (doc: Node, opts: MarkdownOptions = {}): string =>
  blocksToMarkdown(doc.content ?? [], opts).replace(/\n{3,}/g, "\n\n").trim() + "\n";

// ===========================================================================
// Parser
// ===========================================================================

const s = schema;

export const looksLikeMarkdown = (text: string) =>
  /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|```|~~~|\|.*\|)/m.test(text) ||
  /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|~~[^~\n]+~~)/.test(text);

interface Ctx {
  footnotes: Map<string, Node[]>;
  footnoteOrder: string[];
}

export const markdownToDoc = (markdown: string): Node => {
  let text = markdown.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  text = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  const ctx: Ctx = { footnotes: new Map(), footnoteOrder: [] };
  const blocks = parseBlocks(text.split("\n"), ctx);
  if (ctx.footnoteOrder.length) {
    blocks.push(
      s.node(
        "footnotes",
        undefined,
        ctx.footnoteOrder.map((label, i) =>
          s.node("footnote", { id: `fn:${i + 1}`, "data-id": label }, ctx.footnotes.get(label) ?? [s.node("paragraph")]),
        ),
      ),
    );
  }
  return { type: "doc", content: blocks.length ? blocks : [s.node("paragraph")] };
};

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const FOOTDEF = /^\[\^([^\]]+)\]:\s?(.*)$/;
const CALLOUT_OPEN = /^:::(\w+)?\s*$/;
const CALLOUT_CLOSE = /^:::\s*$/;

const startsBlock = (line: string) =>
  FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line) || /^ {0,3}([-*+]|1[.)])[ \t]+\S/.test(line) || CALLOUT_OPEN.test(line) || /^\s*\$\$\s*$/.test(line);

const parseBlocks = (lines: string[], ctx: Ctx): Node[] => {
  const out: Node[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    let m: RegExpMatchArray | null;

    if ((m = line.match(FENCE))) {
      const fence = m[1]!;
      const lang = m[2] || null;
      const indent = line.match(/^ */)![0].length;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i]!)) {
        body.push(lines[i]!.replace(new RegExp(`^ {0,${indent}}`), ""));
        i++;
      }
      i++;
      const code = body.join("\n");
      out.push(s.node("codeBlock", { language: lang }, code ? [s.text(code)] : []));
      continue;
    }

    if (/^\s*\$\$\s*$/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push(s.node("mathBlock", { text: body.join("\n") }));
      continue;
    }
    if ((m = line.match(/^\s*\$\$(.+)\$\$\s*$/))) {
      out.push(s.node("mathBlock", { text: m[1]!.trim() }));
      i++;
      continue;
    }

    if ((m = line.match(ATX))) {
      out.push(s.node("heading", { level: m[1]!.length }, parseInline(m[2] ?? "", ctx)));
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push(s.node("horizontalRule"));
      i++;
      continue;
    }

    if ((m = line.match(CALLOUT_OPEN))) {
      const kind = m[1] ?? "info";
      const body: string[] = [];
      i++;
      let depth = 1;
      while (i < lines.length) {
        const l = lines[i]!;
        if (CALLOUT_OPEN.test(l) && !CALLOUT_CLOSE.test(l)) depth++;
        if (CALLOUT_CLOSE.test(l) && --depth === 0) break;
        body.push(l);
        i++;
      }
      i++;
      if (kind === "details") {
        out.push(detailsNode("", parseBlocks(body, ctx)));
      } else {
        const types = ["default", "info", "note", "success", "warning", "danger"];
        const inner = parseBlocks(body, ctx);
        out.push(s.node("callout", { type: types.includes(kind) ? kind : "info" }, inner.length ? inner : [s.node("paragraph")]));
      }
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim()) {
        const q = lines[i]!.match(QUOTE);
        if (q) body.push(q[1]!);
        else if (startsBlock(lines[i]!)) break;
        else body.push(lines[i]!);
        i++;
      }
      const inner = parseBlocks(body, ctx);
      out.push(s.node("blockquote", undefined, inner.length ? inner : [s.node("paragraph")]));
      continue;
    }

    if (/^\s*<details[\s>]/i.test(line)) {
      const body: string[] = [];
      let depth = 0;
      while (i < lines.length) {
        const l = lines[i]!;
        depth += (l.match(/<details[\s>]/gi) ?? []).length;
        depth -= (l.match(/<\/details>/gi) ?? []).length;
        body.push(l);
        i++;
        if (depth <= 0) break;
      }
      const joined = body.join("\n");
      const summary = joined.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1] ?? "";
      const inner = joined
        .replace(/^\s*<details[^>]*>/i, "")
        .replace(/<\/details>\s*$/i, "")
        .replace(/<summary>[\s\S]*?<\/summary>/i, "");
      out.push(detailsNode(summary.trim(), parseBlocks(inner.split("\n"), ctx), /<details[^>]*\sopen/i.test(joined)));
      continue;
    }

    if (/^\s*<div data-type="pageBreak"><\/div>\s*$/.test(line)) {
      out.push(s.node("pageBreak"));
      i++;
      continue;
    }

    if ((m = line.match(FOOTDEF))) {
      const label = m[1]!;
      const body = [m[2]!];
      i++;
      while (i < lines.length && (/^ {4}/.test(lines[i]!) || (!lines[i]!.trim() && /^ {4}/.test(lines[i + 1] ?? "")))) {
        body.push(lines[i]!.replace(/^ {4}/, ""));
        i++;
      }
      if (!ctx.footnotes.has(label)) ctx.footnoteOrder.push(label);
      ctx.footnotes.set(label, parseBlocks(body, ctx));
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const rows: string[][] = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(splitRow(lines[i++]!));
      const width = rows[0]!.length;
      out.push(
        s.node(
          "table",
          undefined,
          rows.map((cells, r) =>
            s.node(
              "tableRow",
              undefined,
              Array.from({ length: width }, (_, c) =>
                s.node(r === 0 ? "tableHeader" : "tableCell", undefined, [
                  s.node("paragraph", undefined, parseInline((cells[c] ?? "").replace(/<br\s*\/?>/gi, "\n"), ctx)),
                ]),
              ),
            ),
          ),
        ),
      );
      continue;
    }

    if ((m = line.match(LIST)) && (m[4] !== undefined || lines[i + 1]?.trim())) {
      const result = parseList(lines, i, ctx);
      out.push(result.node);
      i = result.next;
      continue;
    }

    if (/^ {4,}\S/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^ {4,}/.test(lines[i]!) || !lines[i]!.trim())) body.push(lines[i++]!.replace(/^ {4}/, ""));
      while (body.length && !body[body.length - 1]!.trim()) body.pop();
      out.push(s.node("codeBlock", { language: null }, [s.text(body.join("\n"))]));
      continue;
    }

    // Paragraph (with setext heading detection).
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!)) {
      if (/^ {0,3}=+\s*$/.test(lines[i]!) || (/^ {0,3}-+\s*$/.test(lines[i]!) && para.length)) break;
      if (lines[i]!.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) break;
      para.push(lines[i]!);
      i++;
    }
    if (i < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[i]!)) {
      const level = lines[i]!.trim()[0] === "=" ? 1 : 2;
      out.push(s.node("heading", { level }, parseInline(para.join(" "), ctx)));
      i++;
      continue;
    }
    const inline = parseInline(para.map((l) => l.replace(/^ {1,3}/, "")).join("\n"), ctx);
    const images = inline.filter((n) => n.type === "image");
    const rest = inline.filter((n) => n.type !== "image");
    if (rest.some((n) => n.type !== "text" || n.text!.trim())) out.push(s.node("paragraph", undefined, trimNodes(rest)));
    out.push(...images);
  }
  return out;
};

const detailsNode = (summary: string, blocks: Node[], open = false) =>
  s.node("details", { open }, [
    s.node("detailsSummary", undefined, parseInline(summary, { footnotes: new Map(), footnoteOrder: [] })),
    s.node("detailsContent", undefined, blocks.length ? blocks : [s.node("paragraph")]),
  ]);

const splitRow = (line: string) => {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (t[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
};

const parseList = (lines: string[], start: number, ctx: Ctx): { node: Node; next: number } => {
  const first = lines[start]!.match(LIST)!;
  const ordered = /\d/.test(first[2]!);
  const bulletChar = ordered ? first[2]!.slice(-1) : first[2]!;
  const items: { blocks: Node[]; checked: boolean | null }[] = [];
  let i = start;
  let loose = false;
  while (i < lines.length) {
    const m = lines[i]!.match(LIST);
    if (!m) break;
    const isOrdered = /\d/.test(m[2]!);
    if (isOrdered !== ordered || (ordered ? m[2]!.slice(-1) : m[2]) !== bulletChar) break;
    const indent = m[1]!.length + m[2]!.length + Math.min((m[3] ?? " ").length, 4);
    const body: string[] = [m[4] ?? ""];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (!l.trim()) {
        const nextLine = lines[i + 1];
        if (nextLine !== undefined && (nextLine.match(/^ */)![0].length >= indent)) {
          body.push("");
          loose = true;
          i++;
          continue;
        }
        break;
      }
      const lead = l.match(/^ */)![0].length;
      if (lead >= indent) {
        body.push(l.slice(indent));
        i++;
        continue;
      }
      if (LIST.test(l) || startsBlock(l)) break;
      body.push(l.trim());
      i++;
    }
    let checked: boolean | null = null;
    const task = body[0]!.match(/^\[([ xX])\](?:\s+|$)(.*)$/);
    if (task) {
      checked = task[1] !== " ";
      body[0] = task[2]!;
    }
    let blocks = parseBlocks(body, ctx);
    if (!blocks.length || blocks[0]!.type !== "paragraph") blocks = [s.node("paragraph"), ...blocks];
    items.push({ blocks, checked });
    if (i < lines.length && !lines[i]!.trim()) {
      const peek = lines[i + 1];
      if (peek && LIST.test(peek)) {
        loose = true;
        i++;
      }
    }
  }
  void loose;
  const isTask = items.length > 0 && items[0]!.checked !== null;
  if (isTask) {
    return { node: s.node("taskList", undefined, items.map((it) => s.node("taskItem", { checked: !!it.checked }, it.blocks))), next: i };
  }
  const listItems = items.map((it) => s.node("listItem", undefined, it.blocks));
  if (ordered) {
    const startNum = Number(first[2]!.slice(0, -1)) || 1;
    return { node: s.node("orderedList", { start: startNum }, listItems), next: i };
  }
  return { node: s.node("bulletList", undefined, listItems), next: i };
};

const trimNodes = (nodes: Node[]): Node[] => {
  const out = nodes.slice();
  if (out[0]?.type === "text") out[0] = { ...out[0], text: out[0].text!.replace(/^\s+/, "") };
  const last = out[out.length - 1];
  if (last?.type === "text") out[out.length - 1] = { ...last, text: last.text!.replace(/\s+$/, "") };
  return mergeTextNodes(out.filter((n) => n.type !== "text" || n.text));
};

const mergeTextNodes = (nodes: Node[]): Node[] => {
  const out: Node[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (last && last.type === "text" && n.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(n.marks ?? [])) {
      out[out.length - 1] = { ...last, text: last.text! + n.text! };
    } else out.push(n);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const withMark = (nodes: Node[], mark: Mark): Node[] =>
  nodes.map((n) => {
    if (n.type === "text") return { ...n, marks: addToMarkSet(n.marks, mark, s) };
    if (s.isInline(n.type) && n.type !== "hardBreak") return n;
    return n;
  });

const text = (t: string, marks?: Mark[]): Node => (marks?.length ? { type: "text", text: t, marks } : { type: "text", text: t });

const URL_RE = /^(https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]!?]/;

const findClosing = (src: string, from: number, delim: string): number => {
  let i = from;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "`") {
      const run = src.slice(i).match(/^`+/)![0];
      const close = src.indexOf(run, i + run.length);
      if (close > 0) {
        i = close + run.length;
        continue;
      }
    }
    if (src.startsWith(delim, i) && i > from && !/\s/.test(src[i - 1]!)) {
      // For single-char delimiters, do not stop on a doubled one.
      if (delim.length === 1 && src[i + 1] === delim[0] && delim !== "~") {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
};

const INLINE_HTML: Record<string, Mark> = {
  u: { type: "underline" },
  ins: { type: "underline" },
  sub: { type: "subscript" },
  sup: { type: "superscript" },
  mark: s.mark("highlight"),
  s: { type: "strike" },
  del: { type: "strike" },
  strike: { type: "strike" },
  b: { type: "bold" },
  strong: { type: "bold" },
  i: { type: "italic" },
  em: { type: "italic" },
  kbd: { type: "code" },
  code: { type: "code" },
};

export const parseInline = (src: string, ctx: Ctx): Node[] => {
  const out: Node[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(text(buf));
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const rest = src.slice(i);
    let m: RegExpMatchArray | null;

    if (c === "\\" && i + 1 < src.length) {
      if (src[i + 1] === "\n") {
        flush();
        out.push({ type: "hardBreak" });
        i += 2;
        continue;
      }
      if (/[!-/:-@[-`{-~]/.test(src[i + 1]!)) {
        buf += src[i + 1];
        i += 2;
        continue;
      }
    }
    if (c === "\n") {
      flush();
      // Two trailing spaces or not: every newline in a paragraph is a line break.
      buf = "";
      if (out.length && out[out.length - 1]!.type === "text") {
        const last = out[out.length - 1]!;
        out[out.length - 1] = { ...last, text: last.text!.replace(/ +$/, "") };
      }
      out.push({ type: "hardBreak" });
      i++;
      continue;
    }
    if (c === "`") {
      const run = rest.match(/^`+/)![0];
      const close = src.indexOf(run, i + run.length);
      if (close > 0) {
        flush();
        let code = src.slice(i + run.length, close).replace(/\n/g, " ");
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        out.push(text(code, [{ type: "code" }]));
        i = close + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }
    if ((m = rest.match(/^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/))) {
      flush();
      out.push(s.node("image", { src: m[2], alt: m[1] || null }));
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^\[\^([^\]\s]+)\]/)) && !rest.startsWith("[^]")) {
      flush();
      const label = m[1]!;
      if (!ctx.footnotes.has(label) && !ctx.footnoteOrder.includes(label)) ctx.footnoteOrder.push(label);
      const n = ctx.footnoteOrder.indexOf(label) + 1;
      out.push(s.node("footnoteReference", { "data-id": label, referenceNumber: String(n) }));
      i += m[0].length;
      continue;
    }
    if (c === "[") {
      const close = matchBracket(src, i);
      if (close > 0) {
        const after = src.slice(close + 1).match(/^\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/);
        if (after) {
          flush();
          const inner = parseInline(src.slice(i + 1, close), ctx);
          out.push(...withMark(inner, s.mark("link", { href: after[1] })));
          i = close + 1 + after[0].length;
          continue;
        }
      }
    }
    if ((m = rest.match(/^<((?:https?|mailto):[^>\s]+)>/))) {
      flush();
      out.push(text(m[1]!, [s.mark("link", { href: m[1] })]));
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^<br\s*\/?>/i))) {
      flush();
      out.push({ type: "hardBreak" });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^<(\w+)>/)) && INLINE_HTML[m[1]!.toLowerCase()]) {
      const tag = m[1]!.toLowerCase();
      const close = src.toLowerCase().indexOf(`</${tag}>`, i + m[0].length);
      if (close > 0) {
        flush();
        const inner = parseInline(src.slice(i + m[0].length, close), ctx);
        out.push(...withMark(inner, INLINE_HTML[tag]!));
        i = close + tag.length + 3;
        continue;
      }
    }
    if ((buf === "" || /[\s(]$/.test(buf)) && (m = rest.match(URL_RE))) {
      flush();
      const url = m[0];
      out.push(text(url, [s.mark("link", { href: url.startsWith("www.") ? `https://${url}` : url })]));
      i += url.length;
      continue;
    }
    if (c === "$" && src[i + 1] !== "$" && !/\s/.test(src[i + 1] ?? " ")) {
      const close = src.indexOf("$", i + 1);
      if (close > i + 1 && !/\s/.test(src[close - 1]!) && !/\d/.test(src[close + 1] ?? "")) {
        flush();
        out.push(s.node("mathInline", { text: src.slice(i + 1, close) }));
        i = close + 1;
        continue;
      }
    }
    const delims: [string, Mark][] = [
      ["**", { type: "bold" }],
      ["__", { type: "bold" }],
      ["~~", { type: "strike" }],
      ["==", s.mark("highlight")],
      ["*", { type: "italic" }],
      ["_", { type: "italic" }],
    ];
    let matched = false;
    for (const [d, mark] of delims) {
      if (!rest.startsWith(d)) continue;
      if (/\s/.test(src[i + d.length] ?? " ")) continue;
      if (d[0] === "_" && /\w/.test(src[i - 1] ?? "")) continue;
      const close = findClosing(src, i + d.length, d);
      if (close < 0) continue;
      if (d[0] === "_" && /\w/.test(src[close + d.length] ?? "")) continue;
      flush();
      out.push(...withMark(parseInline(src.slice(i + d.length, close), ctx), mark));
      i = close + d.length;
      matched = true;
      break;
    }
    if (matched) continue;
    buf += c;
    i++;
  }
  flush();
  return mergeTextNodes(out);
};

const matchBracket = (src: string, open: number) => {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) return i;
  }
  return -1;
};
