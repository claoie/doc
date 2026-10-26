import type { Mark, Node } from "common/editor/model";
import { markTag } from "common/editor/html";
import type { MarkRenderer, NodeRenderer, RenderSpec } from "./desc";

export const h = (
  tag: string,
  attrs: Record<string, string | number | boolean | null | undefined> = {},
  ...children: (globalThis.Node | string | null | undefined)[]
): HTMLElement => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
};

const same = (dom: HTMLElement): RenderSpec => ({ dom, contentDOM: dom });

const blockStyle = (node: Node) => {
  const a = node.attrs ?? {};
  const style: string[] = [];
  if (a.textAlign && a.textAlign !== "left") style.push(`text-align: ${a.textAlign}`);
  const indent = Number(a.indent) || 0;
  return {
    style: style.join("; ") || null,
    "data-indent": indent > 0 ? indent : null,
  };
};

export const nodeRenderers: Record<string, NodeRenderer> = {
  paragraph: (node) => same(h("p", blockStyle(node))),
  heading: (node) => {
    const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
    return same(h(`h${level}`, { id: (node.attrs?.id as string) ?? null, ...blockStyle(node) }));
  },
  blockquote: () => same(h("blockquote")),
  bulletList: () => same(h("ul")),
  orderedList: (node) => {
    const start = Number(node.attrs?.start) || 1;
    return same(h("ol", { start: start !== 1 ? start : null }));
  },
  listItem: () => same(h("li")),
  taskList: () => same(h("ul", { "data-type": "taskList" })),
  horizontalRule: () => ({ dom: h("div", { class: "hr-block" }, h("hr")) }),
  pageBreak: () => ({ dom: h("div", { class: "page-break", "data-type": "pageBreak" }) }),
  hardBreak: () => ({ dom: h("br") }),
  tableRow: () => same(h("tr")),
  detailsSummary: () => same(h("div", { class: "details-summary" })),
  detailsContent: () => same(h("div", { class: "details-content" })),
  columns: (node) => {
    const dom = h("div", {
      class: "columns",
      "data-layout": String(node.attrs?.layout ?? "two_equal"),
      "data-width-mode": node.attrs?.widthMode === "wide" ? "wide" : null,
    });
    return same(dom);
  },
  column: (node) => {
    const width = Number(node.attrs?.width) || 0;
    return same(h("div", { class: "column", style: width ? `flex: ${width}` : null }));
  },
  footnotes: () => same(h("ol", { class: "footnotes" })),
  footnote: (node) => same(h("li", { class: "footnote", id: (node.attrs?.id as string) ?? null })),
};

export const markRenderers: Record<string, MarkRenderer> = new Proxy(
  {},
  {
    get: (_t, type: string) => (mark: Mark) => {
      const [tag, attrs] = markTag({ ...mark, type });
      if (type === "link") {
        // Links inside the editor are not navigated on plain click.
        return { dom: h(tag, { ...attrs, target: null, rel: null, "data-href": attrs.href as string }) };
      }
      return { dom: h(tag, attrs) };
    },
  },
);
