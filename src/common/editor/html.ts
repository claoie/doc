import { cleanUrl } from "./sanitize";
import type { Attrs, Mark, Node } from "./model";

/**
 * Serializes documents to HTML strings without a DOM, for export, clipboard
 * text/html and public pages. The element shapes match what the editor
 * renders and what the HTML parser reads back.
 */

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Tag = [name: string, attrs: Record<string, string | number | boolean | null | undefined>];

const attrString = (attrs: Tag[1]) =>
  Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined && v !== false && v !== "")
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${escapeHtml(String(v))}"`))
    .join("");

const open = ([name, attrs]: Tag) => `<${name}${attrString(attrs)}>`;
const close = ([name]: Tag) => `</${name}>`;

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

export const safeUrl = (url: unknown): string => cleanUrl(url, true);

/** A CSS color from document data, or null when it is anything else. */
export const safeColor = (value: unknown): string | null => {
  const v = String(value ?? "").trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  if (/^(rgb|hsl)a?\(\s*[\d.%\s,/-]+\)$/i.test(v)) return v;
  if (/^[a-z]{3,20}$/i.test(v)) return v;
  return null;
};

const styleOf = (parts: Record<string, string | null | undefined>) => {
  const s = Object.entries(parts)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  return s || null;
};

const blockAttrs = (a: Attrs) => ({
  "data-id": str(a.id),
  style: styleOf({ "text-align": ["center", "right", "justify"].includes(String(a.textAlign)) ? String(a.textAlign) : null }),
  "data-indent": Number(a.indent) > 0 ? Number(a.indent) : null,
});

export const markTag = (mark: Mark): Tag => {
  const a = mark.attrs ?? {};
  switch (mark.type) {
    case "bold":
      return ["strong", {}];
    case "italic":
      return ["em", {}];
    case "underline":
      return ["u", {}];
    case "strike":
      return ["s", {}];
    case "code":
      return ["code", {}];
    case "subscript":
      return ["sub", {}];
    case "superscript":
      return ["sup", {}];
    case "link":
      return [
        "a",
        {
          href: safeUrl(a.href),
          target: str(a.target),
          rel: str(a.rel),
          class: str(a.class),
          "data-internal": a.internal ? "true" : null,
        },
      ];
    case "highlight":
      return [
        "mark",
        {
          "data-color": str(a.color),
          style: safeColor(a.color) ? `background-color: ${safeColor(a.color)}; color: inherit` : null,
          "data-highlight-color-name": a.colorName ? String(a.colorName).toLowerCase() : null,
        },
      ];
    case "textStyle":
      return ["span", { style: safeColor(a.color) ? `color: ${safeColor(a.color)}` : null }];
    case "comment":
      return [
        "span",
        {
          class: a.resolved ? "comment-mark resolved" : "comment-mark",
          "data-comment-id": str(a.commentId),
          "data-resolved": a.resolved ? "true" : null,
        },
      ];
    default:
      return ["span", {}];
  }
};

export interface HtmlOptions {
  /** Rewrites file URLs (e.g. to relative paths in an export). */
  fileUrl?: (src: string) => string;
  /** Resolves a page mention or internal link to an href. */
  pageHref?: (slugId: string, anchorId?: string | null) => string;
}

const media = (opts: HtmlOptions, src: unknown) => {
  const s = safeUrl(src);
  return opts.fileUrl ? opts.fileUrl(s) : s;
};

const widthAttr = (w: unknown) => (w === null || w === undefined ? null : String(w));

export const nodeToHtml = (node: Node, opts: HtmlOptions = {}): string => {
  const a = node.attrs ?? {};
  const inner = () => (node.content ?? []).map((c) => nodeToHtml(c, opts)).join("");
  const wrap = (tag: Tag, body = inner()) => open(tag) + body + close(tag);
  switch (node.type) {
    case "doc":
      return inner();
    case "text": {
      let html = escapeHtml(node.text ?? "");
      const marks = node.marks ?? [];
      for (let i = marks.length - 1; i >= 0; i--) {
        const tag = markTag(marks[i]!);
        html = open(tag) + html + close(tag);
      }
      return html;
    }
    case "paragraph":
      return wrap(["p", blockAttrs(a)]);
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(a.level) || 1));
      return wrap([`h${level}`, { id: str(a.id), ...blockAttrs({ ...a, id: null }) }]);
    }
    case "blockquote":
      return wrap(["blockquote", {}]);
    case "bulletList":
      return wrap(["ul", {}]);
    case "orderedList":
      return wrap(["ol", { start: Number(a.start) !== 1 ? Number(a.start) : null, type: str(a.type) }]);
    case "listItem":
      return wrap(["li", {}]);
    case "taskList":
      return wrap(["ul", { "data-type": "taskList" }]);
    case "taskItem":
      return wrap(["li", { "data-type": "taskItem", "data-checked": a.checked ? "true" : "false" }]);
    case "codeBlock": {
      const lang = a.language ? `language-${a.language}` : null;
      return `<pre><code${attrString({ class: lang })}>${escapeHtml((node.content ?? []).map((c) => c.text ?? "").join(""))}</code></pre>`;
    }
    case "horizontalRule":
      return "<hr>";
    case "pageBreak":
      return '<div data-type="pageBreak" class="page-break"></div>';
    case "hardBreak":
      return "<br>";
    case "image":
      return open([
        "img",
        {
          src: media(opts, a.src),
          alt: str(a.alt),
          width: widthAttr(a.width),
          height: widthAttr(a.height),
          "data-align": str(a.align),
          "data-attachment-id": str(a.attachmentId),
          "data-size": str(a.size),
          "data-aspect-ratio": str(a.aspectRatio),
        },
      ]);
    case "video":
      return wrap(
        [
          "video",
          {
            controls: true,
            src: media(opts, a.src),
            "aria-label": str(a.alt),
            width: widthAttr(a.width),
            height: widthAttr(a.height),
            "data-align": str(a.align),
            "data-attachment-id": str(a.attachmentId),
            "data-size": str(a.size),
            "data-aspect-ratio": str(a.aspectRatio),
          },
        ],
        "",
      );
    case "audio":
      return wrap(
        [
          "audio",
          {
            controls: true,
            preload: "metadata",
            src: media(opts, a.src),
            "data-attachment-id": str(a.attachmentId),
            "data-size": str(a.size),
          },
        ],
        "",
      );
    case "attachment": {
      const url = media(opts, a.url);
      return wrap(
        [
          "div",
          {
            "data-type": "attachment",
            "data-attachment-url": url,
            "data-attachment-name": str(a.name),
            "data-attachment-mime": str(a.mime),
            "data-attachment-size": str(a.size),
            "data-attachment-id": str(a.attachmentId),
          },
        ],
        `<a href="${escapeHtml(url)}" class="attachment" target="_blank">${escapeHtml(String(a.name ?? url))}</a>`,
      );
    }
    case "pdf": {
      const src = media(opts, a.src);
      return wrap(
        [
          "div",
          {
            "data-type": "pdf",
            "data-name": str(a.name),
            "data-attachment-id": str(a.attachmentId),
            "data-size": str(a.size),
          },
        ],
        `<iframe src="${escapeHtml(src)}" width="${escapeHtml(String(a.width ?? 800))}" height="${escapeHtml(String(a.height ?? 600))}"></iframe>`,
      );
    }
    case "drawio":
    case "excalidraw": {
      const src = media(opts, a.src);
      return wrap(
        [
          "div",
          {
            "data-type": node.type,
            "data-src": src,
            "data-title": str(a.title),
            "data-alt": str(a.alt),
            "data-width": widthAttr(a.width),
            "data-height": widthAttr(a.height),
            "data-size": str(a.size),
            "data-aspect-ratio": str(a.aspectRatio),
            "data-align": str(a.align),
            "data-attachment-id": str(a.attachmentId),
          },
        ],
        `<img src="${escapeHtml(src)}" alt="${escapeHtml(String(a.alt ?? a.title ?? node.type))}"${a.width ? ` width="${escapeHtml(String(a.width))}"` : ""}>`,
      );
    }
    case "table":
      return `<div class="tableWrapper">${wrap(["table", {}], `<tbody>${inner()}</tbody>`)}</div>`;
    case "tableRow":
      return wrap(["tr", {}]);
    case "tableCell":
    case "tableHeader": {
      const cw = Array.isArray(a.colwidth) ? (a.colwidth as unknown[]).join(",") : null;
      return wrap([
        node.type === "tableHeader" ? "th" : "td",
        {
          colspan: Number(a.colspan) > 1 ? Number(a.colspan) : null,
          rowspan: Number(a.rowspan) > 1 ? Number(a.rowspan) : null,
          colwidth: cw,
          style: safeColor(a.backgroundColor) ? `background-color: ${safeColor(a.backgroundColor)}` : null,
          "data-background-color": str(a.backgroundColor),
          "data-background-color-name": a.backgroundColorName ? String(a.backgroundColorName).toLowerCase() : null,
        },
      ]);
    }
    case "callout":
      return wrap(["div", { "data-type": "callout", "data-callout-type": str(a.type), "data-callout-icon": str(a.icon) }]);
    case "details":
      return wrap(["details", { open: !!a.open }]);
    case "detailsSummary":
      return wrap(["summary", { "data-type": "detailsSummary" }]);
    case "detailsContent":
      return wrap(["div", { "data-type": "detailsContent" }]);
    case "columns":
      return wrap([
        "div",
        { "data-type": "columns", "data-layout": str(a.layout), "data-width-mode": a.widthMode === "wide" ? "wide" : null },
      ]);
    case "column":
      return wrap(["div", { "data-type": "column", "data-width": str(a.width), style: Number(a.width) > 0 ? `flex: ${Number(a.width)}` : null }]);
    case "transclusionSource":
      return wrap(["div", { "data-type": "transclusionSource", "data-id": str(a.id) }]);
    case "transclusionReference":
      return open([
        "div",
        {
          "data-type": "transclusionReference",
          "data-source-page-id": str(a.sourcePageId),
          "data-transclusion-id": str(a.transclusionId),
        },
      ]) + "</div>";
    case "footnotes":
      return wrap(["ol", { class: "footnotes" }]);
    case "footnote":
      return wrap(["li", { id: str(a.id), "data-id": str(a["data-id"]) }]);
    case "footnoteReference": {
      const n = String(a.referenceNumber ?? "");
      return `<sup id="fnref:${escapeHtml(n)}"><a class="footnote-ref" data-id="${escapeHtml(String(a["data-id"] ?? ""))}" data-reference-number="${escapeHtml(n)}" href="#fn:${escapeHtml(n)}">${escapeHtml(n)}</a></sup>`;
    }
    case "mathInline":
      return `<span data-type="mathInline" data-katex="true">${escapeHtml(String(a.text ?? ""))}</span>`;
    case "mathBlock":
      return `<div data-type="mathBlock" data-katex="true">${escapeHtml(String(a.text ?? ""))}</div>`;
    case "mention": {
      const label = String(a.label ?? a.id ?? "");
      const attrs = {
        "data-type": "mention",
        class: "mention",
        "data-id": str(a.id),
        "data-label": str(a.label),
        "data-entity-type": str(a.entityType),
        "data-entity-id": str(a.entityId),
        "data-slug-id": str(a.slugId),
        "data-creator-id": str(a.creatorId),
        "data-anchor-id": str(a.anchorId),
      };
      const text = a.entityType === "user" ? `@${label}` : label;
      if (a.entityType === "page" && a.slugId && opts.pageHref) {
        return `<a href="${escapeHtml(opts.pageHref(String(a.slugId), str(a.anchorId)))}"${attrString(attrs)}>${escapeHtml(text)}</a>`;
      }
      return wrap(["span", attrs], escapeHtml(text));
    }
    case "status":
      return wrap(["span", { "data-type": "status", "data-color": str(a.color) }], escapeHtml(String(a.text ?? "")));
    case "embed": {
      const src = safeUrl(a.src);
      return wrap(
        [
          "div",
          {
            "data-type": "embed",
            "data-src": src,
            "data-provider": str(a.provider),
            "data-align": str(a.align),
            "data-width": str(a.width),
            "data-height": str(a.height),
          },
        ],
        `<a href="${escapeHtml(src)}" target="_blank">${escapeHtml(src)}</a>`,
      );
    }
    case "youtube":
      return wrap(["div", { "data-youtube-video": true }], `<iframe src="${escapeHtml(safeUrl(a.src))}" width="${escapeHtml(String(a.width ?? 640))}" height="${escapeHtml(String(a.height ?? 480))}" allowfullscreen></iframe>`);
    case "subpages":
      return '<div data-type="subpages"></div>';
    case "base":
      return `<div data-type="base-embed" data-page-id="${escapeHtml(str(a.pageId) ?? "")}"></div>`;
    default:
      return node.content ? `<div>${inner()}</div>` : "";
  }
};

export const docToHtml = (doc: Node, opts?: HtmlOptions) => nodeToHtml(doc, opts);
