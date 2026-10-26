import type { Attrs, Mark, Node } from "common/editor/model";
import type { Schema } from "common/editor/schema";
import { addToMarkSet } from "common/editor/steps";

/**
 * Converts HTML (pasted content, imported files) into document nodes. Reads
 * the editor's own HTML shapes exactly and maps common HTML from other
 * editors and web pages onto the closest node types.
 */

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "details", "dialog", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
  "summary", "tbody", "thead", "tfoot", "tr", "td", "th", "video", "audio", "iframe",
]);

const IGNORE = new Set(["script", "style", "template", "noscript", "head", "meta", "link", "title", "svg", "button", "input", "select", "textarea", "colgroup", "col"]);

const num = (v: string | null | undefined, fallback: number | null = null) => {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const widthValue = (v: string | null) => {
  if (!v) return null;
  if (/%$/.test(v)) return v;
  return num(v);
};

const cssColor = (el: HTMLElement, prop: "color" | "backgroundColor") => {
  const v = el.style[prop];
  if (!v || v === "inherit" || v === "transparent" || v === "initial") return null;
  return v;
};

export class HtmlParser {
  constructor(readonly schema: Schema) {}

  parse(html: string): Node[] {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return this.parseElement(doc.body);
  }

  parseElement(el: Element): Node[] {
    const blocks = this.blocks(el, [], false);
    return this.normalizeBlocks(blocks, "doc");
  }

  // -----------------------------------------------------------------------

  private isBlockEl(node: globalThis.Node): boolean {
    if (!(node instanceof HTMLElement)) return false;
    const tag = node.tagName.toLowerCase();
    if (BLOCK_TAGS.has(tag)) {
      if (tag === "div" && node.dataset.type === "mathInline") return false;
      return true;
    }
    if (tag === "img") return !node.closest("p, li, td, th, h1, h2, h3, h4, h5, h6") || node.parentElement?.childNodes.length === 1;
    return Array.from(node.children).some((c) => this.isBlockEl(c));
  }

  /** Parses child nodes into blocks, collecting runs of inline content into paragraphs. */
  private blocks(el: globalThis.Node, marks: Mark[], pre: boolean): Node[] {
    const out: Node[] = [];
    let inline: Node[] = [];
    const flush = () => {
      const trimmed = trimInline(inline);
      if (trimmed.length) out.push(this.schema.node("paragraph", undefined, trimmed));
      inline = [];
    };
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        inline.push(...this.textNodes((child as Text).data, marks, pre));
        continue;
      }
      if (!(child instanceof HTMLElement)) continue;
      const tag = child.tagName.toLowerCase();
      if (IGNORE.has(tag)) continue;
      if (this.isBlockEl(child)) {
        flush();
        out.push(...this.block(child, marks));
      } else {
        inline.push(...this.inline(child, marks, pre));
      }
    }
    flush();
    return out;
  }

  private textNodes(text: string, marks: Mark[], pre: boolean): Node[] {
    const t = pre ? text : text.replace(/[\s ]+/g, (m) => (m.includes(" ") ? " " : " "));
    if (!t) return [];
    return [this.schema.text(t, marks.length ? marks : undefined)];
  }

  private inline(el: HTMLElement, marks: Mark[], pre: boolean): Node[] {
    const tag = el.tagName.toLowerCase();
    const type = el.dataset.type;
    const s = this.schema;
    if (tag === "br") return [{ type: "hardBreak" }];
    if (type === "mention") {
      return [
        s.node("mention", {
          id: el.dataset.id ?? null,
          label: el.dataset.label ?? (el.textContent ?? "").replace(/^@/, ""),
          entityType: el.dataset.entityType ?? null,
          entityId: el.dataset.entityId ?? null,
          slugId: el.dataset.slugId ?? null,
          creatorId: el.dataset.creatorId ?? null,
          anchorId: el.dataset.anchorId ?? null,
        }),
      ];
    }
    if (type === "mathInline") return [s.node("mathInline", { text: el.textContent ?? "" })];
    if (type === "status") {
      return [s.node("status", { text: el.textContent ?? "", color: el.dataset.color ?? "gray" })];
    }
    if (tag === "sup" && el.querySelector("a.footnote-ref")) {
      const a = el.querySelector("a.footnote-ref") as HTMLElement;
      return [
        s.node("footnoteReference", {
          "data-id": a.dataset.id ?? null,
          referenceNumber: a.dataset.referenceNumber ?? a.textContent ?? null,
        }),
      ];
    }
    if (tag === "img") {
      // Inline images become their own block; the caller flushes around it.
      return [];
    }
    const added = this.marksFor(el);
    let next = marks;
    for (const m of added) next = addToMarkSet(next, m, s);
    const isPre = pre || tag === "code" && el.closest("pre") !== null;
    const result: Node[] = [];
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) result.push(...this.textNodes((child as Text).data, next, isPre));
      else if (child instanceof HTMLElement && !IGNORE.has(child.tagName.toLowerCase())) {
        result.push(...this.inline(child, next, isPre));
      }
    }
    return result;
  }

  private marksFor(el: HTMLElement): Mark[] {
    const s = this.schema;
    const tag = el.tagName.toLowerCase();
    const marks: Mark[] = [];
    const style = el.style;
    if (tag === "strong" || tag === "b") {
      // Google Docs wraps everything in <b style="font-weight:normal">.
      if (!(style.fontWeight === "normal" || style.fontWeight === "400")) marks.push(s.mark("bold"));
    }
    if (tag === "em" || tag === "i") marks.push(s.mark("italic"));
    if (tag === "u" || tag === "ins") marks.push(s.mark("underline"));
    if (tag === "s" || tag === "strike" || tag === "del") marks.push(s.mark("strike"));
    if (tag === "code" || tag === "kbd" || tag === "samp") marks.push(s.mark("code"));
    if (tag === "sub") marks.push(s.mark("subscript"));
    if (tag === "sup") marks.push(s.mark("superscript"));
    if (tag === "a" && el.getAttribute("href")) {
      marks.push(
        s.mark("link", {
          href: el.getAttribute("href"),
          internal: el.dataset.internal === "true",
        }),
      );
    }
    if (tag === "mark") {
      marks.push(
        s.mark("highlight", {
          color: el.dataset.color ?? cssColor(el, "backgroundColor"),
          colorName: el.dataset.highlightColorName ?? null,
        }),
      );
    }
    if (tag === "span" && el.dataset.commentId) {
      marks.push(s.mark("comment", { commentId: el.dataset.commentId, resolved: el.dataset.resolved === "true" }));
    }
    if (tag !== "mark") {
      const weight = style.fontWeight;
      if ((weight === "bold" || Number(weight) >= 600) && tag !== "strong" && tag !== "b" && !/^h\d$/.test(tag)) {
        marks.push(s.mark("bold"));
      }
      if (style.fontStyle === "italic" && tag !== "em" && tag !== "i") marks.push(s.mark("italic"));
      const deco = style.textDecoration || style.textDecorationLine;
      if (deco?.includes("underline") && tag !== "u" && tag !== "a") marks.push(s.mark("underline"));
      if (deco?.includes("line-through") && tag !== "s") marks.push(s.mark("strike"));
      if (style.verticalAlign === "super" && tag !== "sup") marks.push(s.mark("superscript"));
      if (style.verticalAlign === "sub" && tag !== "sub") marks.push(s.mark("subscript"));
      const color = cssColor(el, "color");
      if (color && tag !== "a") marks.push(s.mark("textStyle", { color }));
      const bg = cssColor(el, "backgroundColor");
      if (bg && tag === "span") marks.push(s.mark("highlight", { color: bg }));
    }
    return marks;
  }

  private blockAttrs(el: HTMLElement): Attrs {
    const align = el.style.textAlign;
    return {
      textAlign: align && ["left", "center", "right", "justify"].includes(align) ? align : null,
      indent: num(el.dataset.indent, 0) ?? 0,
      id: el.dataset.id ?? null,
    };
  }

  private block(el: HTMLElement, marks: Mark[]): Node[] {
    const s = this.schema;
    const tag = el.tagName.toLowerCase();
    const type = el.dataset.type;
    const inline = (src: HTMLElement = el) => trimInline(this.inlineChildren(src, marks, false));
    const children = (src: HTMLElement = el) => this.blocks(src, marks, false);

    if (/^h[1-6]$/.test(tag)) {
      return [s.node("heading", { ...this.blockAttrs(el), id: el.id || null, level: Number(tag[1]) }, inline())];
    }
    switch (type) {
      case "callout":
        return [s.node("callout", { type: el.dataset.calloutType ?? "info", icon: el.dataset.calloutIcon ?? null }, children())];
      case "detailsSummary":
        return [s.node("detailsSummary", undefined, inline())];
      case "detailsContent":
        return [s.node("detailsContent", undefined, children())];
      case "columns":
        return [s.node("columns", { layout: el.dataset.layout ?? "two_equal", widthMode: el.dataset.widthMode ?? "normal" }, children())];
      case "column":
        return [s.node("column", { width: num(el.dataset.width) }, children())];
      case "transclusionSource":
        return [s.node("transclusionSource", { id: el.dataset.id ?? null }, children())];
      case "transclusionReference":
        return [s.node("transclusionReference", { sourcePageId: el.dataset.sourcePageId ?? null, transclusionId: el.dataset.transclusionId ?? null })];
      case "pageBreak":
        return [s.node("pageBreak")];
      case "subpages":
        return [s.node("subpages")];
      case "base-embed":
        return el.dataset.pageId ? [s.node("base", { pageId: el.dataset.pageId })] : [];
      case "mathBlock":
        return [s.node("mathBlock", { text: el.textContent ?? "" })];
      case "attachment":
        return [
          s.node("attachment", {
            url: el.dataset.attachmentUrl ?? el.querySelector("a")?.getAttribute("href") ?? "",
            name: el.dataset.attachmentName ?? el.textContent?.trim() ?? null,
            mime: el.dataset.attachmentMime ?? null,
            size: num(el.dataset.attachmentSize),
            attachmentId: el.dataset.attachmentId ?? null,
          }),
        ];
      case "pdf": {
        const frame = el.querySelector("iframe");
        return [
          s.node("pdf", {
            src: frame?.getAttribute("src") ?? "",
            name: el.dataset.name ?? null,
            attachmentId: el.dataset.attachmentId ?? null,
            size: num(el.dataset.size),
            width: num(frame?.getAttribute("width"), 800),
            height: num(frame?.getAttribute("height"), 600),
          }),
        ];
      }
      case "drawio":
      case "excalidraw":
        return [
          s.node(type, {
            src: el.dataset.src ?? el.querySelector("img")?.getAttribute("src") ?? "",
            title: el.dataset.title ?? null,
            alt: el.dataset.alt ?? null,
            width: widthValue(el.dataset.width ?? null),
            height: num(el.dataset.height),
            size: num(el.dataset.size),
            aspectRatio: num(el.dataset.aspectRatio),
            align: el.dataset.align ?? "center",
            attachmentId: el.dataset.attachmentId ?? null,
          }),
        ];
      case "embed":
        return [
          s.node("embed", {
            src: el.dataset.src ?? el.querySelector("a")?.getAttribute("href") ?? "",
            provider: el.dataset.provider ?? "",
            align: el.dataset.align ?? "center",
            width: num(el.dataset.width, 800),
            height: num(el.dataset.height, 600),
          }),
        ];
      case "taskList":
        return [s.node("taskList", undefined, this.listItems(el, "taskItem", marks))];
      case "taskItem":
        return this.listItems(el.parentElement ?? el, "taskItem", marks).slice(0, 1);
    }
    if (el.hasAttribute("data-youtube-video")) {
      const frame = el.querySelector("iframe");
      return [s.node("youtube", { src: frame?.getAttribute("src") ?? null })];
    }
    if (el.classList.contains("tableWrapper") && el.querySelector("table")) {
      return this.block(el.querySelector("table") as HTMLElement, marks);
    }
    switch (tag) {
      case "p":
        return [s.node("paragraph", this.blockAttrs(el), inline())].concat(this.blockImages(el));
      case "blockquote":
        return [s.node("blockquote", undefined, children())];
      case "ul":
        if (Array.from(el.children).some((li) => li.querySelector(":scope > input[type=checkbox]"))) {
          return [s.node("taskList", undefined, this.listItems(el, "taskItem", marks))];
        }
        return [s.node("bulletList", undefined, this.listItems(el, "listItem", marks))];
      case "ol":
        if (el.classList.contains("footnotes")) {
          return [s.node("footnotes", undefined, Array.from(el.children).map((li) => s.node("footnote", { id: li.id || null, "data-id": (li as HTMLElement).dataset.id ?? null }, this.normalizeBlocks(this.blocks(li, marks, false), "footnote"))))];
        }
        return [s.node("orderedList", { start: num(el.getAttribute("start"), 1), type: el.getAttribute("type") }, this.listItems(el, "listItem", marks))];
      case "li":
        return [s.node("paragraph", undefined, inline())];
      case "pre": {
        const code = el.querySelector("code");
        const cls = (code?.className ?? el.className).match(/language-([\w+#-]+)/);
        const text = (code ?? el).textContent ?? "";
        return [s.node("codeBlock", { language: cls?.[1] ?? el.dataset.language ?? null }, text ? [s.text(text.replace(/\n$/, ""))] : [])];
      }
      case "hr":
        return [s.node("horizontalRule")];
      case "img":
        return [this.image(el)];
      case "figure": {
        const img = el.querySelector("img");
        if (img) return [this.image(img)];
        return children();
      }
      case "video":
        return [
          s.node("video", {
            src: el.getAttribute("src") ?? el.querySelector("source")?.getAttribute("src") ?? "",
            alt: el.getAttribute("aria-label"),
            width: widthValue(el.getAttribute("width")),
            height: num(el.getAttribute("height")),
            align: el.dataset.align ?? "center",
            attachmentId: el.dataset.attachmentId ?? null,
            size: num(el.dataset.size),
            aspectRatio: num(el.dataset.aspectRatio),
          }),
        ];
      case "audio":
        return [
          s.node("audio", {
            src: el.getAttribute("src") ?? el.querySelector("source")?.getAttribute("src") ?? "",
            attachmentId: el.dataset.attachmentId ?? null,
            size: num(el.dataset.size),
          }),
        ];
      case "iframe": {
        const src = el.getAttribute("src") ?? "";
        if (/youtube(-nocookie)?\.com\/embed\//.test(src)) return [s.node("embed", { src, provider: "youtube" })];
        return [s.node("embed", { src, provider: "iframe", width: num(el.getAttribute("width"), 800), height: num(el.getAttribute("height"), 600) })];
      }
      case "details": {
        const summary = el.querySelector(":scope > summary");
        const rest = document.createElement("div");
        for (const c of Array.from(el.childNodes)) if (c !== summary) rest.appendChild(c.cloneNode(true));
        const contentEl = rest.querySelector(':scope > [data-type="detailsContent"]') as HTMLElement | null;
        return [
          s.node("details", { open: el.hasAttribute("open") }, [
            s.node("detailsSummary", undefined, summary ? inline(summary as HTMLElement) : []),
            s.node("detailsContent", undefined, this.normalizeBlocks(children(contentEl ?? rest), "detailsContent")),
          ]),
        ];
      }
      case "table":
        return [this.table(el, marks)];
      case "dl":
      case "dt":
      case "dd":
        return children();
    }
    return children();
  }

  /** Images that sat inside a paragraph are lifted out as blocks after it. */
  private blockImages(el: HTMLElement): Node[] {
    return Array.from(el.querySelectorAll("img")).map((img) => this.image(img as HTMLElement));
  }

  private image(el: HTMLElement): Node {
    return this.schema.node("image", {
      src: el.getAttribute("src") ?? "",
      alt: el.getAttribute("alt"),
      width: widthValue(el.getAttribute("width")),
      height: num(el.getAttribute("height")),
      align: el.dataset.align ?? "center",
      attachmentId: el.dataset.attachmentId ?? null,
      size: num(el.dataset.size),
      aspectRatio: num(el.dataset.aspectRatio),
    });
  }

  private inlineChildren(el: HTMLElement, marks: Mark[], pre: boolean): Node[] {
    const out: Node[] = [];
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) out.push(...this.textNodes((child as Text).data, marks, pre));
      else if (child instanceof HTMLElement && !IGNORE.has(child.tagName.toLowerCase())) {
        if (this.isBlockEl(child)) {
          // Block content inside an inline-only context: keep its text.
          out.push(...this.inlineChildren(child, marks, pre));
        } else {
          out.push(...this.inline(child, marks, pre));
        }
      }
    }
    return out;
  }

  private listItems(list: HTMLElement, itemType: "listItem" | "taskItem", marks: Mark[]): Node[] {
    const items: Node[] = [];
    for (const li of Array.from(list.children)) {
      if (li.tagName.toLowerCase() !== "li") {
        // Stray nested list directly inside a list: attach to previous item.
        if (["ul", "ol"].includes(li.tagName.toLowerCase()) && items.length) {
          const prev = items[items.length - 1]!;
          prev.content = [...(prev.content ?? []), ...this.block(li as HTMLElement, marks)];
        }
        continue;
      }
      const el = li as HTMLElement;
      const checkbox = el.querySelector(":scope > input[type=checkbox], :scope > label > input[type=checkbox]") as HTMLInputElement | null;
      const checked = el.dataset.checked === "true" || !!checkbox?.checked;
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(":scope > input[type=checkbox], :scope > label:has(> input[type=checkbox])").forEach((n) => n.remove());
      const blocks = this.normalizeBlocks(this.blocks(clone, marks, false), itemType);
      items.push(this.schema.node(itemType, itemType === "taskItem" ? { checked } : undefined, blocks));
    }
    return items.length ? items : [this.schema.node(itemType, undefined, [this.schema.node("paragraph")])];
  }

  private table(el: HTMLElement, marks: Mark[]): Node {
    const s = this.schema;
    const rows: Node[] = [];
    const trs = Array.from(el.querySelectorAll("tr")).filter((tr) => tr.closest("table") === el);
    for (const tr of trs) {
      const cells: Node[] = [];
      for (const cell of Array.from(tr.children)) {
        const tag = cell.tagName.toLowerCase();
        if (tag !== "td" && tag !== "th") continue;
        const c = cell as HTMLElement;
        const colwidth = c.getAttribute("colwidth")?.split(",").map((n) => Number(n)).filter((n) => n > 0) ?? null;
        const type = tag === "th" ? "tableHeader" : "tableCell";
        cells.push(
          s.node(
            type,
            {
              colspan: num(c.getAttribute("colspan"), 1),
              rowspan: num(c.getAttribute("rowspan"), 1),
              colwidth: colwidth?.length ? colwidth : null,
              backgroundColor: c.dataset.backgroundColor ?? cssColor(c, "backgroundColor"),
              backgroundColorName: c.dataset.backgroundColorName ?? null,
            },
            this.normalizeBlocks(this.blocks(c, marks, false), type),
          ),
        );
      }
      if (cells.length) rows.push(s.node("tableRow", undefined, cells));
    }
    if (!rows.length) {
      rows.push(s.node("tableRow", undefined, [s.node("tableCell", undefined, [s.node("paragraph")])]));
    }
    return s.node("table", undefined, rows);
  }

  /**
   * Makes a block list valid for a parent: wraps stray inline content,
   * replaces disallowed blocks with their text, and fills required content.
   */
  normalizeBlocks(blocks: Node[], parentType: string): Node[] {
    const s = this.schema;
    let result = blocks.flatMap((b) => this.fixNode(b));
    if (parentType === "listItem" || parentType === "taskItem" || parentType === "footnote") {
      if (!result.length || result[0]!.type !== "paragraph") result = [s.node("paragraph"), ...result];
    }
    if (!s.validContent(parentType, result)) {
      result = result.flatMap((b) => (s.validContent(parentType, [b]) || s.validContent(parentType, [...result.filter((x) => x !== b), b]) ? [b] : this.toParagraphs(b)));
    }
    if (!result.length && s.spec(parentType).content?.includes("+")) result = [s.node("paragraph")];
    return result;
  }

  private fixNode(node: Node): Node[] {
    const s = this.schema;
    if (node.type === "text") return [node];
    if (!s.isKnown(node.type)) return this.toParagraphs(node);
    if (s.check(node) === null) return [node];
    if (s.isTextblock(node.type)) {
      const content = (node.content ?? []).filter((c) => s.isInline(c.type));
      return [{ ...node, content: content.map((c) => (c.marks ? { ...c, marks: c.marks.filter((m) => s.allowsMark(node.type, m.type)) } : c)) }];
    }
    if (node.content) {
      const fixed = { ...node, content: this.normalizeBlocks(node.content, node.type) };
      if (s.check(fixed) === null) return [fixed];
    }
    return this.toParagraphs(node);
  }

  private toParagraphs(node: Node): Node[] {
    const s = this.schema;
    if (s.isTextblock(node.type)) return [s.node("paragraph", undefined, (node.content ?? []).filter((c) => s.isInline(c.type)))];
    if (s.isInline(node.type)) return [s.node("paragraph", undefined, [node])];
    return (node.content ?? []).flatMap((c) => this.toParagraphs(c));
  }
}

const trimInline = (nodes: Node[]): Node[] => {
  const out = nodes.slice();
  while (out.length && out[0]!.type === "text" && !out[0]!.text!.trim()) out.shift();
  while (out.length && out[out.length - 1]!.type === "text" && !out[out.length - 1]!.text!.trim()) out.pop();
  if (out[0]?.type === "text") out[0] = { ...out[0], text: out[0].text!.replace(/^\s+/, "") };
  const last = out[out.length - 1];
  if (last?.type === "text") out[out.length - 1] = { ...last, text: last.text!.replace(/\s+$/, "") };
  return mergeAdjacent(out.filter((n) => n.type !== "text" || n.text));
};

const mergeAdjacent = (nodes: Node[]): Node[] => {
  const out: Node[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (last && last.type === "text" && n.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(n.marks ?? [])) {
      out[out.length - 1] = { ...last, text: last.text! + n.text! };
    } else out.push(n);
  }
  return out;
};
