import { copyData, copyText } from "./clipboard";
import type { Attrs, Node } from "common/editor/model";
import { docToHtml } from "common/editor/html";
import { cleanUrl } from "common/editor/sanitize";
import { Transaction } from "common/editor/state";
import { nodeSize } from "common/editor/tokens";
import { embedFor } from "common/embed";
import type { NodeView, NodeViewFactory } from "./desc";
import type { Editor } from "./editor";
import { h } from "./render";
import { highlight, LANGUAGES } from "./highlight";
import { latexToMathML } from "./latex";
import { openPopover } from "./popover";
import { tableView, cellView } from "./table";

export interface UploadedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

export interface ChildPage {
  id: string;
  title: string | null;
  icon: string | null;
  href: string;
}

/** What node views need from the surrounding app. */
export interface EditorContext {
  editor: () => Editor | null;
  pageId?: string;
  /** Rewrites stored file URLs for display (e.g. adds a share key). */
  fileUrl: (src: string) => string;
  uploadFile?: (file: File, replaceId?: string) => Promise<UploadedFile>;
  childPages?: (pageId: string) => Promise<ChildPage[]>;
  lookupSynced?: (pageId: string, blockId: string) => Promise<Node[] | null>;
  openPage?: (slugId: string, anchorId?: string | null) => void;
  pageHref?: (slugId: string, anchorId?: string | null) => string;
  openDiagram?: (kind: "drawio" | "excalidraw", attrs: Attrs, save: (result: { file: UploadedFile; width?: number; height?: number }) => void) => void;
  loadMermaid?: () => Promise<{ render: (id: string, code: string) => Promise<{ svg: string }> }>;
  /** Renders an inline base into `el`; returns a cleanup function. */
  mountBase?: (el: HTMLElement, pageId: string, remove: () => void) => () => void;
}

const editable = (ctx: EditorContext) => !!ctx.editor()?.editable;

const formatSize = (bytes: unknown) => {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

const cssWidth = (width: unknown): string | null => {
  if (width === null || width === undefined || width === "") return null;
  if (typeof width === "string" && width.endsWith("%")) return width;
  const n = Number(width);
  return Number.isFinite(n) && n > 0 ? `${n}px` : null;
};

// ---------------------------------------------------------------------------

const taskItem = (ctx: EditorContext): NodeViewFactory => (node, _getPos, { dispatchAttrs }) => {
  const input = h("input", { type: "checkbox" }) as HTMLInputElement;
  input.checked = !!node.attrs?.checked;
  const check = h("span", { class: "task-check", contenteditable: "false" }, input);
  const body = h("div", { class: "task-body" });
  const dom = h("li", { class: "task-item", "data-checked": String(!!node.attrs?.checked) }, check, body);
  input.addEventListener("mousedown", (e) => e.preventDefault());
  input.addEventListener("change", () => {
    if (!editable(ctx)) {
      input.checked = !input.checked;
      return;
    }
    dispatchAttrs({ checked: input.checked });
  });
  return {
    dom,
    contentDOM: body,
    update(next) {
      if (next.type !== "taskItem") return false;
      node = next;
      input.checked = !!next.attrs?.checked;
      dom.setAttribute("data-checked", String(!!next.attrs?.checked));
      return true;
    },
    stopEvent: (e) => check.contains(e.target as globalThis.Node),
    ignoreMutation: (m) => check.contains(m.target),
  };
};

let mermaidSeq = 0;

const codeBlock = (ctx: EditorContext): NodeViewFactory => (node, _getPos, { dispatchAttrs }) => {
  const select = h("select", { "aria-label": "Language" }) as HTMLSelectElement;
  const languages = new Set(LANGUAGES);
  if (node.attrs?.language) languages.add(String(node.attrs.language));
  const fillOptions = () => {
    select.textContent = "";
    for (const lang of languages) select.append(h("option", { value: lang === "plaintext" ? "" : lang }, lang));
  };
  fillOptions();
  select.value = String(node.attrs?.language ?? "");
  const copy = h("button", { type: "button" }, "Copy");
  const toolbar = h("div", { class: "code-toolbar", contenteditable: "false" }, select, copy);
  const overlay = h("code", { class: "code-overlay", "aria-hidden": "true" });
  const code = h("code", { class: "code-content", spellcheck: "false" });
  const scroller = h("div", { class: "code-scroll" }, overlay, code);
  const preview = h("div", { class: "mermaid-preview", contenteditable: "false" });
  const dom = h("pre", { class: "code-block" }, toolbar, scroller);
  let renderedMermaid = "";

  const paint = (n: Node) => {
    const text = (n.content ?? []).map((c) => c.text ?? "").join("");
    overlay.textContent = "";
    for (const token of highlight(text + "\n", n.attrs?.language as string | null)) {
      overlay.append(token.cls ? h("span", { class: token.cls }, token.text) : document.createTextNode(token.text));
    }
    dom.setAttribute("data-language", String(n.attrs?.language ?? ""));
    if (n.attrs?.language === "mermaid" && ctx.loadMermaid) {
      if (!preview.isConnected) dom.append(preview);
      if (renderedMermaid !== text) {
        renderedMermaid = text;
        const id = `mermaid-${++mermaidSeq}`;
        ctx
          .loadMermaid()
          .then((m) => m.render(id, text || "flowchart LR"))
          .then(({ svg }) => {
            if (renderedMermaid === text) preview.innerHTML = svg;
          })
          .catch((err: unknown) => {
            if (renderedMermaid === text) preview.textContent = `Diagram error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
          });
      }
    } else if (preview.isConnected) {
      preview.remove();
      renderedMermaid = "";
    }
  };
  paint(node);

  select.addEventListener("change", () => dispatchAttrs({ language: select.value || null }));
  copy.addEventListener("click", () => {
    const text = (node.content ?? []).map((c) => c.text ?? "").join("");
    void copyText(text).then((ok) => {
      copy.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    });
  });
  const syncEditable = () => {
    select.disabled = !editable(ctx);
  };
  syncEditable();
  return {
    dom,
    contentDOM: code,
    update(next) {
      if (next.type !== "codeBlock") return false;
      node = next;
      if (next.attrs?.language && !languages.has(String(next.attrs.language))) {
        languages.add(String(next.attrs.language));
        fillOptions();
      }
      select.value = String(next.attrs?.language ?? "");
      syncEditable();
      paint(next);
      return true;
    },
    stopEvent: (e) => toolbar.contains(e.target as globalThis.Node) || preview.contains(e.target as globalThis.Node),
    ignoreMutation: (m) => !code.contains(m.target) || m.target === code && m.type === "attributes",
  };
};

const CALLOUT_ICONS: Record<string, string> = { info: "ℹ️", note: "📝", success: "✅", warning: "⚠️", danger: "⛔", default: "💡" };
const CALLOUT_TYPES = ["info", "note", "success", "warning", "danger", "default"];

const callout = (ctx: EditorContext): NodeViewFactory => (node, _getPos, { dispatchAttrs }) => {
  const icon = h("span", { class: "callout-icon", contenteditable: "false", role: "button", "aria-label": "Callout style" });
  const body = h("div", { class: "callout-body" });
  const dom = h("div", { class: "callout" }, icon, body);
  const paint = (n: Node) => {
    const type = CALLOUT_TYPES.includes(String(n.attrs?.type)) ? String(n.attrs?.type) : "info";
    dom.setAttribute("data-callout-type", type);
    icon.textContent = (n.attrs?.icon as string) || CALLOUT_ICONS[type]!;
  };
  paint(node);
  icon.addEventListener("mousedown", (e) => e.preventDefault());
  icon.addEventListener("click", () => {
    if (!editable(ctx)) return;
    openPopover(icon, (close) => {
      const panel = h("div", { class: "popover-panel callout-picker" });
      const row = h("div", { class: "popover-row" });
      for (const type of CALLOUT_TYPES) {
        const b = h("button", { type: "button", class: "chip", "data-callout-type": type, title: type }, CALLOUT_ICONS[type]!, " ", type);
        b.addEventListener("click", () => {
          dispatchAttrs({ type, icon: null });
          close();
        });
        row.append(b);
      }
      const input = h("input", { placeholder: "Custom emoji", maxlength: "8", value: String(node.attrs?.icon ?? "") }) as HTMLInputElement;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          dispatchAttrs({ icon: input.value.trim() || null });
          close();
        }
      });
      panel.append(row, input);
      return panel;
    });
  });
  return {
    dom,
    contentDOM: body,
    update(next) {
      if (next.type !== "callout") return false;
      node = next;
      paint(next);
      return true;
    },
    stopEvent: (e) => icon.contains(e.target as globalThis.Node),
    ignoreMutation: (m) => icon.contains(m.target),
  };
};

const details = (ctx: EditorContext): NodeViewFactory => (node, _getPos, { dispatchAttrs }) => {
  const toggle = h("button", { type: "button", class: "details-toggle", contenteditable: "false", "aria-label": "Toggle" });
  const content = h("div", { class: "details-inner" });
  const dom = h("div", { class: "details", "data-open": String(!!node.attrs?.open) }, toggle, content);
  toggle.addEventListener("mousedown", (e) => e.preventDefault());
  toggle.addEventListener("click", () => {
    const open = dom.getAttribute("data-open") !== "true";
    if (editable(ctx)) dispatchAttrs({ open });
    else dom.setAttribute("data-open", String(open));
  });
  return {
    dom,
    contentDOM: content,
    update(next) {
      if (next.type !== "details") return false;
      node = next;
      dom.setAttribute("data-open", String(!!next.attrs?.open));
      return true;
    },
    stopEvent: (e) => toggle.contains(e.target as globalThis.Node),
    ignoreMutation: (m) => m.target === dom && m.type === "attributes",
  };
};

/** Image, video, drawio and excalidraw: aligned, resizable media. */
const media = (ctx: EditorContext): NodeViewFactory => (node, getPos, { dispatchAttrs }) => {
  const type = node.type;
  const frame = h("div", { class: "media-frame" });
  const dom = h("div", { class: `media media-${type}` }, frame);
  let el: HTMLImageElement | HTMLVideoElement;
  if (type === "video") {
    el = h("video", { controls: true, preload: "metadata", playsinline: true }) as HTMLVideoElement;
  } else {
    el = h("img", { loading: "lazy", draggable: "false" }) as HTMLImageElement;
  }
  const left = h("div", { class: "media-handle left", contenteditable: "false" });
  const right = h("div", { class: "media-handle right", contenteditable: "false" });
  frame.append(el, left, right);
  if (type === "drawio" || type === "excalidraw") {
    const edit = h("button", { type: "button", class: "media-edit", contenteditable: "false" }, "Edit diagram");
    edit.addEventListener("click", () => openDiagram());
    frame.append(edit);
    el.addEventListener("dblclick", () => openDiagram());
  }
  const openDiagram = () => {
    if (!editable(ctx) || !ctx.openDiagram) return;
    ctx.openDiagram(type as "drawio" | "excalidraw", node.attrs ?? {}, ({ file, width, height }) => {
      dispatchAttrs({
        src: `${file.url}?t=${Date.now()}`,
        attachmentId: file.id,
        size: file.size,
        ...(width && height ? { aspectRatio: width / height } : {}),
      });
    });
  };
  const paint = (n: Node) => {
    const a = n.attrs ?? {};
    dom.setAttribute("data-align", String(a.align ?? "center"));
    const src = cleanUrl(ctx.fileUrl(String(a.src ?? "")), type === "image" || type === "drawio" || type === "excalidraw");
    if (!src && (type === "drawio" || type === "excalidraw")) {
      el.removeAttribute("src");
      frame.classList.add("media-empty");
      frame.setAttribute("data-label", type === "drawio" ? "Empty diagram — click Edit diagram" : "Empty drawing — click Edit diagram");
    } else {
      frame.classList.remove("media-empty");
      if (el.getAttribute("src") !== src) el.setAttribute("src", src);
    }
    if (a.alt) el.setAttribute(type === "video" ? "aria-label" : "alt", String(a.alt));
    const w = cssWidth(a.width);
    frame.style.width = w ?? "";
  };
  paint(node);
  const startResize = (side: "left" | "right") => (e: PointerEvent) => {
    if (!editable(ctx)) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = frame.getBoundingClientRect().width;
    const maxW = dom.getBoundingClientRect().width;
    const centered = dom.getAttribute("data-align") === "center";
    const move = (ev: PointerEvent) => {
      const delta = (ev.clientX - startX) * (side === "left" ? -1 : 1) * (centered ? 2 : 1);
      frame.style.width = `${Math.round(Math.max(60, Math.min(maxW, startW + delta)))}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const width = Math.round(frame.getBoundingClientRect().width);
      dispatchAttrs({ width });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  left.addEventListener("pointerdown", startResize("left"));
  right.addEventListener("pointerdown", startResize("right"));
  void getPos;
  return {
    dom,
    update(next) {
      if (next.type !== type) return false;
      node = next;
      paint(next);
      return true;
    },
    stopEvent: (e) => left.contains(e.target as globalThis.Node) || right.contains(e.target as globalThis.Node) || (e.target as HTMLElement).classList?.contains("media-edit") || (type === "video" && e.type !== "mousedown" && el.contains(e.target as globalThis.Node)),
    ignoreMutation: () => true,
  };
};

const audio = (ctx: EditorContext): NodeViewFactory => (node) => {
  const el = h("audio", { controls: true, preload: "metadata" }) as HTMLAudioElement;
  const dom = h("div", { class: "audio-block" }, el);
  const paint = (n: Node) => el.setAttribute("src", cleanUrl(ctx.fileUrl(String(n.attrs?.src ?? ""))));
  paint(node);
  return {
    dom,
    update(next) {
      if (next.type !== "audio") return false;
      paint(next);
      return true;
    },
    stopEvent: (e) => e.type !== "mousedown",
    ignoreMutation: () => true,
  };
};

const pdf = (ctx: EditorContext): NodeViewFactory => (node) => {
  const frame = h("iframe", { title: String(node.attrs?.name ?? "PDF"), loading: "lazy" }) as HTMLIFrameElement;
  const caption = h("div", { class: "pdf-caption" });
  const dom = h("div", { class: "pdf-block" }, frame, caption);
  const paint = (n: Node) => {
    const src = cleanUrl(ctx.fileUrl(String(n.attrs?.src ?? "")));
    if (frame.getAttribute("src") !== src) frame.setAttribute("src", src);
    frame.style.height = `${Number(n.attrs?.height) || 600}px`;
    caption.textContent = String(n.attrs?.name ?? "");
  };
  paint(node);
  return {
    dom,
    update(next) {
      if (next.type !== "pdf") return false;
      paint(next);
      return true;
    },
    ignoreMutation: () => true,
  };
};

const attachment = (ctx: EditorContext): NodeViewFactory => (node) => {
  const name = h("div", { class: "name" });
  const meta = h("div", { class: "meta" });
  const link = h("a", { class: "attachment-card", target: "_blank", rel: "noopener" }, h("span", { class: "attachment-icon" }, "📎"), h("div", {}, name, meta));
  const dom = h("div", { class: "attachment-block" }, link);
  const paint = (n: Node) => {
    const a = n.attrs ?? {};
    link.setAttribute("href", cleanUrl(ctx.fileUrl(String(a.url ?? ""))));
    name.textContent = String(a.name ?? "File");
    meta.textContent = [formatSize(a.size), a.mime ? String(a.mime) : ""].filter(Boolean).join(" · ");
  };
  paint(node);
  link.addEventListener("click", (e) => {
    if (editable(ctx) && !(e.metaKey || e.ctrlKey)) e.preventDefault();
  });
  link.addEventListener("dblclick", () => window.open(link.getAttribute("href") ?? "", "_blank", "noopener"));
  return {
    dom,
    update(next) {
      if (next.type !== "attachment") return false;
      paint(next);
      return true;
    },
    ignoreMutation: () => true,
  };
};

const embed = (ctx: EditorContext): NodeViewFactory => (node, _getPos, { dispatchAttrs }) => {
  const dom = h("div", { class: "media embed-block" });
  const paint = (n: Node) => {
    dom.textContent = "";
    const a = n.attrs ?? {};
    dom.setAttribute("data-align", String(a.align ?? "center"));
    const src = n.type === "youtube" ? String(a.src ?? "") : String(a.src ?? "");
    const resolved = src ? embedFor(src) : null;
    if (!resolved) {
      if (!editable(ctx)) {
        dom.append(h("div", { class: "embed-empty" }, src ? `Cannot embed ${src}` : "Empty embed"));
        return;
      }
      const input = h("input", { placeholder: `Paste ${a.provider && a.provider !== "iframe" ? a.provider : "a"} link`, value: src }) as HTMLInputElement;
      const button = h("button", { type: "button", class: "button primary" }, "Embed");
      const submit = () => {
        const value = input.value.trim();
        if (value) dispatchAttrs({ src: value });
      };
      button.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      });
      dom.append(h("div", { class: "placeholder-card" }, input, button));
      return;
    }
    const frame = h("iframe", {
      class: "embed-frame",
      src: resolved.url,
      loading: "lazy",
      allowfullscreen: true,
      allow: "autoplay; fullscreen; picture-in-picture; clipboard-write",
      sandbox: "allow-scripts allow-same-origin allow-popups allow-forms allow-presentation",
      referrerpolicy: "strict-origin-when-cross-origin",
    });
    frame.style.height = `${Number(a.height) || 480}px`;
    const w = Number(a.width);
    if (w && n.type === "embed") frame.style.maxWidth = `${w}px`;
    dom.append(frame);
  };
  paint(node);
  return {
    dom,
    update(next) {
      if (next.type !== node.type) return false;
      const changed = JSON.stringify(next.attrs) !== JSON.stringify(node.attrs);
      node = next;
      if (changed) paint(next);
      return true;
    },
    stopEvent: (e) => (e.target as HTMLElement).closest?.(".placeholder-card") !== null,
    ignoreMutation: () => true,
  };
};

const mathEditor = (initial: string, display: boolean, save: (text: string) => void) => (close: () => void) => {
  const textarea = h("textarea", { class: "math-input", rows: display ? "4" : "2", spellcheck: "false", placeholder: "LaTeX, e.g. \\frac{a}{b}" }) as HTMLTextAreaElement;
  textarea.value = initial;
  const preview = h("div", { class: "math-preview" });
  const render = () => (preview.innerHTML = textarea.value.trim() ? latexToMathML(textarea.value, display) : "");
  render();
  textarea.addEventListener("input", render);
  const done = h("button", { type: "button", class: "button primary" }, "Done");
  const commit = () => {
    save(textarea.value);
    close();
  };
  done.addEventListener("click", commit);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !display)) {
      e.preventDefault();
      commit();
    }
  });
  setTimeout(() => textarea.focus());
  return h("div", { class: "popover-panel math-editor" }, textarea, preview, h("div", { class: "popover-actions" }, done));
};

const math = (ctx: EditorContext): NodeViewFactory => (node, _getPos, { dispatchAttrs }) => {
  const display = node.type === "mathBlock";
  const dom = h(display ? "div" : "span", { class: display ? "math-block" : "math-inline" });
  const paint = (n: Node) => {
    const text = String(n.attrs?.text ?? "");
    if (text.trim()) dom.innerHTML = latexToMathML(text, display);
    else {
      dom.textContent = "";
      dom.append(h("span", { class: "math-empty" }, display ? "Empty equation" : "math"));
    }
  };
  paint(node);
  const open = () => {
    if (!editable(ctx)) return;
    openPopover(dom, mathEditor(String(node.attrs?.text ?? ""), display, (text) => dispatchAttrs({ text })));
  };
  dom.addEventListener("click", open);
  if (!String(node.attrs?.text ?? "").trim() && editable(ctx)) setTimeout(() => dom.isConnected && open(), 30);
  return {
    dom,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      paint(next);
      return true;
    },
    ignoreMutation: () => true,
  };
};

const mention = (ctx: EditorContext): NodeViewFactory => (node) => {
  const a = node.attrs ?? {};
  const isPage = a.entityType === "page";
  const dom = h(isPage ? "a" : "span", { class: "mention", "data-entity-type": String(a.entityType ?? "") });
  const paint = (n: Node) => {
    const attrs = n.attrs ?? {};
    dom.textContent = attrs.entityType === "user" ? `@${attrs.label ?? ""}` : String(attrs.label ?? "");
    if (attrs.entityType === "page" && attrs.slugId && ctx.pageHref) {
      dom.setAttribute("href", ctx.pageHref(String(attrs.slugId), attrs.anchorId as string | null));
    }
  };
  paint(node);
  dom.addEventListener("click", (e) => {
    if (!isPage || !node.attrs?.slugId) return;
    e.preventDefault();
    ctx.openPage?.(String(node.attrs.slugId), node.attrs.anchorId as string | null);
  });
  return {
    dom,
    update(next) {
      if (next.type !== "mention" || next.attrs?.entityType !== a.entityType) return false;
      node = next;
      paint(next);
      return true;
    },
    ignoreMutation: () => true,
  };
};

const STATUS_COLORS = ["gray", "blue", "green", "yellow", "red", "purple"];

const status = (ctx: EditorContext): NodeViewFactory => (node, _getPos, { dispatchAttrs }) => {
  const dom = h("span", { class: "status-badge" });
  const paint = (n: Node) => {
    dom.setAttribute("data-color", String(n.attrs?.color ?? "gray"));
    dom.textContent = String(n.attrs?.text || "Set status");
  };
  paint(node);
  const open = () => {
    if (!editable(ctx)) return;
    openPopover(dom, (close) => {
      const input = h("input", { value: String(node.attrs?.text ?? ""), placeholder: "Status", maxlength: "40" }) as HTMLInputElement;
      const row = h("div", { class: "popover-row" });
      for (const color of STATUS_COLORS) {
        const b = h("button", { type: "button", class: "swatch status-badge", "data-color": color, title: color }, color);
        b.addEventListener("click", () => dispatchAttrs({ color, text: input.value }));
        row.append(b);
      }
      input.addEventListener("input", () => dispatchAttrs({ text: input.value }));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          close();
        }
      });
      setTimeout(() => input.focus());
      return h("div", { class: "popover-panel" }, input, row);
    });
  };
  dom.addEventListener("click", open);
  if (!node.attrs?.text && editable(ctx)) setTimeout(() => dom.isConnected && open(), 30);
  return {
    dom,
    update(next) {
      if (next.type !== "status") return false;
      node = next;
      paint(next);
      return true;
    },
    ignoreMutation: () => true,
  };
};

const footnoteReference: NodeViewFactory = (node) => {
  const dom = h("sup", { class: "footnote-ref" });
  const paint = (n: Node) => (dom.textContent = String(n.attrs?.referenceNumber ?? "*"));
  paint(node);
  dom.addEventListener("click", () => {
    const n = node.attrs?.referenceNumber;
    const target = dom.closest(".editor")?.querySelectorAll("ol.footnotes > li")[Number(n) - 1];
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  return {
    dom,
    update(next) {
      if (next.type !== "footnoteReference") return false;
      node = next;
      paint(next);
      return true;
    },
    ignoreMutation: () => true,
  };
};

const subpages = (ctx: EditorContext): NodeViewFactory => () => {
  const list = h("div", { class: "subpages-list" }, "Loading…");
  const dom = h("div", { class: "subpages-block" }, list);
  const load = () => {
    if (!ctx.pageId || !ctx.childPages) {
      list.textContent = "Subpages";
      return;
    }
    ctx
      .childPages(ctx.pageId)
      .then((pages) => {
        list.textContent = "";
        if (!pages.length) list.append(h("div", { class: "muted" }, "No subpages"));
        for (const p of pages) list.append(h("a", { href: p.href }, `${p.icon ? p.icon + " " : "📄 "}${p.title || "Untitled"}`));
      })
      .catch(() => (list.textContent = "Could not load subpages"));
  };
  load();
  return { dom, update: (next) => next.type === "subpages", ignoreMutation: () => true };
};

const base = (ctx: EditorContext): NodeViewFactory => (node, getPos) => {
  const pageId = typeof node.attrs?.pageId === "string" ? node.attrs.pageId : null;
  const dom = h("div", { class: "base-embed", contenteditable: "false" });
  let cleanup: (() => void) | null = null;
  if (!pageId) dom.append(h("div", { class: "muted" }, "Invalid base embed (missing page id)"));
  else if (ctx.mountBase) {
    cleanup = ctx.mountBase(dom, pageId, () => {
      const ed = ctx.editor();
      if (!ed) return;
      const pos = getPos();
      const tr = new Transaction(ed.state);
      tr.delete(pos, pos + nodeSize(node, ed.state.schema));
      ed.dispatch(tr);
    });
  }
  else dom.append(h("a", { href: ctx.pageHref?.(pageId) ?? "#", class: "base-embed-link" }, "Open base"));
  return {
    dom,
    update: (next) => next.type === "base" && next.attrs?.pageId === pageId,
    destroy: () => cleanup?.(),
    stopEvent: (event) => !(event.type === "mousedown" && (event.target as HTMLElement) === dom),
    ignoreMutation: () => true,
  };
};

const syncedSource = (ctx: EditorContext): NodeViewFactory => (node) => {
  const copy = h("button", { type: "button", class: "synced-copy", title: "Copy, then paste on another page to show this block there" }, "Copy synced block");
  const label = h("span", { class: "synced-label", contenteditable: "false" }, "Synced block", copy);
  const content = h("div", { class: "synced-content" });
  const dom = h("div", { class: "synced-source" }, label, content);
  copy.addEventListener("mousedown", (e) => e.preventDefault());
  copy.addEventListener("click", async () => {
    const blockId = node.attrs?.id as string | null;
    if (!ctx.pageId || !blockId) return;
    const html = `<div data-type="transclusionReference" data-source-page-id="${ctx.pageId}" data-transclusion-id="${blockId}"></div>`;
    const ok = await copyData({ "text/html": html, "text/plain": "Synced block" });
    copy.textContent = ok ? "Copied — paste it on another page" : "Copy failed";
    setTimeout(() => (copy.textContent = "Copy synced block"), 2000);
  });
  return {
    dom,
    contentDOM: content,
    update(next) {
      if (next.type !== "transclusionSource") return false;
      node = next;
      return true;
    },
    stopEvent: (e) => label.contains(e.target as globalThis.Node),
    ignoreMutation: (m) => label.contains(m.target),
  };
};

const syncedReference = (ctx: EditorContext): NodeViewFactory => (node) => {
  const body = h("div", { class: "synced-body" }, "Loading synced block…");
  const dom = h("div", { class: "synced-ref" }, body);
  const load = (n: Node) => {
    const pageId = n.attrs?.sourcePageId as string | null;
    const blockId = n.attrs?.transclusionId as string | null;
    if (!pageId || !blockId || !ctx.lookupSynced) {
      body.textContent = "Synced block unavailable";
      return;
    }
    ctx
      .lookupSynced(pageId, blockId)
      .then((content) => {
        if (!content) {
          body.textContent = "The source of this synced block was removed or is not accessible.";
          return;
        }
        body.innerHTML = docToHtml({ type: "doc", content }, { fileUrl: ctx.fileUrl, pageHref: ctx.pageHref });
      })
      .catch(() => (body.textContent = "Could not load synced block"));
  };
  load(node);
  return {
    dom,
    update(next) {
      if (next.type !== "transclusionReference") return false;
      if (JSON.stringify(next.attrs) !== JSON.stringify(node.attrs)) load(next);
      node = next;
      return true;
    },
    ignoreMutation: () => true,
  };
};

export const createNodeViews = (ctx: EditorContext): Record<string, NodeViewFactory> => ({
  taskItem: taskItem(ctx),
  codeBlock: codeBlock(ctx),
  callout: callout(ctx),
  details: details(ctx),
  image: media(ctx),
  video: media(ctx),
  drawio: media(ctx),
  excalidraw: media(ctx),
  audio: audio(ctx),
  pdf: pdf(ctx),
  attachment: attachment(ctx),
  embed: embed(ctx),
  youtube: embed(ctx),
  mathInline: math(ctx),
  mathBlock: math(ctx),
  mention: mention(ctx),
  status: status(ctx),
  footnoteReference,
  subpages: subpages(ctx),
  base: base(ctx),
  transclusionSource: syncedSource(ctx),
  transclusionReference: syncedReference(ctx),
  table: tableView(ctx),
  tableCell: cellView(ctx),
  tableHeader: cellView(ctx),
});

export type { NodeView };
