import { docToHtml } from "common/editor/html";
import { cut, insertFragment, textToFragment, type Fragment } from "common/editor/fragment";
import { markdownToDoc, looksLikeMarkdown } from "common/editor/markdown";
import { isEmpty, selFrom, selTo, Transaction } from "common/editor/state";
import { textBetween } from "common/editor/tokens";
import { deleteSelection, setMark } from "common/editor/commands";
import { $ } from "common/editor/resolved";
import type { Editor } from "./editor";
import { HtmlParser } from "./parse-html";

const SLICE_MIME = "application/x-doc-fragment";

export const handleCopy = (editor: Editor, event: ClipboardEvent, isCut: boolean) => {
  const { state } = editor;
  if (isEmpty(state.selection) || !event.clipboardData) return;
  const from = selFrom(state.selection);
  const to = selTo(state.selection);
  const fragment = cut(state.doc, from, to, state.schema);
  event.preventDefault();
  const html = docToHtml({ type: "doc", content: fragment.nodes });
  const text = textBetween(state.doc, from, to, state.schema, "\n\n");
  event.clipboardData.setData("text/html", html);
  event.clipboardData.setData("text/plain", text);
  event.clipboardData.setData(SLICE_MIME, JSON.stringify(fragment));
  if (isCut && editor.editable) editor.run(deleteSelection);
};

const urlPattern = /^https?:\/\/\S+$/i;

export const handlePasteEvent = (editor: Editor, event: ClipboardEvent): boolean => {
  const data = event.clipboardData;
  if (!data || !editor.editable) return false;
  const files = Array.from(data.files ?? []);
  if (files.length && editor.options.uploadFiles) {
    editor.options.uploadFiles(files, editor);
    return true;
  }
  const { state } = editor;
  const parentType = $(state.doc, selFrom(state.selection), state.schema).parent.type;
  const inCode = !!state.schema.nodes[parentType]?.code;
  const text = data.getData("text/plain");
  if (inCode) {
    if (!text) return true;
    return editor.run(insertFragment(textToFragment(text, state.schema))) || true;
  }
  const own = data.getData(SLICE_MIME);
  if (own) {
    try {
      const fragment = JSON.parse(own) as Fragment;
      if (editor.run(insertFragment(fragment))) return true;
    } catch {
      // fall through to HTML
    }
  }
  // A bare URL over a text selection becomes a link.
  if (text && urlPattern.test(text.trim()) && !isEmpty(state.selection)) {
    const href = text.trim();
    const from = selFrom(state.selection);
    const to = selTo(state.selection);
    editor.run((s, d) => setMark(s.schema.mark("link", { href }))({ ...s, selection: { anchor: from, head: to } }, d));
    return true;
  }
  const html = data.getData("text/html");
  if (html && !(event as ClipboardEvent & { shiftKey?: boolean }).shiftKey) {
    const nodes = new HtmlParser(state.schema).parse(html);
    if (nodes.length) {
      const single = nodes.length === 1 && state.schema.isTextblock(nodes[0]!.type);
      const fragment: Fragment = { nodes, openStart: single || state.schema.isTextblock(nodes[0]!.type) ? 1 : 0, openEnd: state.schema.isTextblock(nodes[nodes.length - 1]!.type) ? 1 : 0 };
      if (editor.run(insertFragment(fragment))) return true;
    }
  }
  if (text) {
    if (looksLikeMarkdown(text)) {
      const doc = markdownToDoc(text);
      const nodes = doc.content ?? [];
      if (nodes.length) {
        const fragment: Fragment = {
          nodes,
          openStart: state.schema.isTextblock(nodes[0]!.type) ? 1 : 0,
          openEnd: state.schema.isTextblock(nodes[nodes.length - 1]!.type) ? 1 : 0,
        };
        if (editor.run(insertFragment(fragment))) return true;
      }
    }
    return editor.run(insertFragment(textToFragment(text, state.schema))) || true;
  }
  return true;
};

export const handleDropEvent = (editor: Editor, event: DragEvent): boolean => {
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (!files.length || !editor.options.uploadFiles) return false;
  const pos = editor.view.posAtCoords(event.clientX, event.clientY);
  if (pos !== null) {
    const tr = new Transaction(editor.state);
    tr.setSelection({ anchor: pos, head: pos });
    editor.dispatch(tr);
  }
  editor.options.uploadFiles(files, editor);
  return true;
};

/**
 * Puts each `mime -> data` entry on the clipboard and reports whether it
 * worked. The async clipboard API exists only in secure contexts; elsewhere
 * (plain http) this falls back to the legacy copy command, which needs a
 * recent user gesture.
 */
export const copyData = async (items: Record<string, string>): Promise<boolean> => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      const types = Object.keys(items);
      if (types.length === 1 && types[0] === "text/plain") await navigator.clipboard.writeText(items["text/plain"]!);
      else await navigator.clipboard.write([new ClipboardItem(Object.fromEntries(types.map((t) => [t, new Blob([items[t]!], { type: t })])))]);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  const text = items["text/plain"] ?? "";
  const previous = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const savedRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const area = document.createElement("textarea");
  area.value = text || " ";
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, area.value.length);
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    for (const [type, data] of Object.entries(items)) event.clipboardData.setData(type, data);
  };
  document.addEventListener("copy", onCopy, true);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.removeEventListener("copy", onCopy, true);
  area.remove();
  previous?.focus?.({ preventScroll: true });
  if (savedRange && selection) {
    selection.removeAllRanges();
    selection.addRange(savedRange);
  }
  return ok;
};

export const copyText = (text: string): Promise<boolean> => copyData({ "text/plain": text });
