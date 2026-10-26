import type { Node } from "common/editor/model";
import { $ } from "common/editor/resolved";
import { nodeSize } from "common/editor/tokens";
import { schema } from "common/editor/doc-schema";
import {
  chain,
  deleteBackward,
  deleteForward,
  deleteSelection,
  exitCode,
  insertHardBreak,
  insertText,
  liftListItem,
  selectAll,
  sinkListItem,
  splitBlock,
  toggleMark,
  setBlockType,
  toggleList,
  indentBlocks,
  type Command,
} from "common/editor/commands";
import { History } from "common/editor/history";
import { applyTransaction, createState, isEmpty, selFrom, Transaction, type EditorState } from "common/editor/state";
import { textblockStartAfter } from "common/editor/commands";
import type { NodeViewFactory } from "./desc";
import { EditorView } from "./view";
import { markRenderers, nodeRenderers } from "./render";
import { runInputRules } from "./inputrules";
import { handleCopy, handlePasteEvent, handleDropEvent } from "./clipboard";
import { leaveTableVertically } from "./table";

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export type KeyHandler = (editor: Editor, event: KeyboardEvent) => boolean;

export interface EditorOptions {
  doc: Node;
  editable?: boolean;
  nodeViews?: Record<string, NodeViewFactory>;
  /** Called after every state change. */
  onUpdate?: (editor: Editor, tr: Transaction | null) => void;
  /** Local document changes, for sending to collaborators. */
  onLocalChange?: (editor: Editor, tr: Transaction) => void;
  onFocusChange?: (editor: Editor, focused: boolean) => void;
  /** Key handlers that run before the built-in keymap (menus, suggestions). */
  keyHandlers?: KeyHandler[];
  /** Upload pasted or dropped files; returns nodes to insert. */
  uploadFiles?: (files: File[], editor: Editor) => void;
  placeholder?: string;
}

const normalizeKey = (event: KeyboardEvent): string => {
  const parts: string[] = [];
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (mod) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (!isMac && event.metaKey) parts.push("Meta");
  if (isMac && event.ctrlKey) parts.push("Ctrl");
  let key = event.key;
  if (key === " ") key = "Space";
  if (key.length === 1) key = key.toLowerCase();
  // With Alt on macOS, event.key is the composed character; fall back to the code.
  if (event.altKey && event.code.startsWith("Key")) key = event.code.slice(3).toLowerCase();
  if (event.code.startsWith("Digit") && (mod || event.altKey)) key = event.code.slice(5);
  parts.push(key);
  return parts.join("-");
};

export class Editor {
  state: EditorState;
  readonly view: EditorView;
  readonly history = new History();
  options: EditorOptions;
  private lastInputRule: { tr: Transaction; before: EditorState } | null = null;
  private updateListeners = new Set<(tr: Transaction | null) => void>();
  private focusListeners = new Set<(focused: boolean) => void>();
  private keymap: Record<string, (editor: Editor) => boolean>;

  constructor(mount: HTMLElement, options: EditorOptions) {
    this.options = options;
    const start = textblockStartAfter(options.doc, 0, schema) ?? 0;
    this.state = createState(schema, options.doc, { anchor: start, head: start });
    this.keymap = this.buildKeymap();
    this.view = new EditorView(mount, {
      state: this.state,
      nodes: nodeRenderers,
      marks: markRenderers,
      nodeViews: options.nodeViews,
      editable: options.editable,
      dispatch: (tr) => this.dispatch(tr),
      handleKeyDown: (_view, event) => this.handleKeyDown(event),
      handleBeforeInput: (_view, event) => this.handleBeforeInput(event),
      handlePaste: (_view, event) => handlePasteEvent(this, event),
      handleDrop: (_view, event) => handleDropEvent(this, event),
      onFocusChange: (_view, focused) => {
        this.view.refreshAttrs();
        options.onFocusChange?.(this, focused);
        this.focusListeners.forEach((l) => l(focused));
      },
      nodeAttrs: (state) => this.nodeAttrs(state),
    });
    this.view.refreshAttrs();
    this.view.dom.addEventListener("copy", (e) => handleCopy(this, e as ClipboardEvent, false));
    this.view.dom.addEventListener("cut", (e) => handleCopy(this, e as ClipboardEvent, true));
  }

  get schema() {
    return this.state.schema;
  }

  get doc() {
    return this.state.doc;
  }

  get editable() {
    return this.view.editable;
  }

  setEditable(editable: boolean) {
    this.view.setEditable(editable);
    this.view.refreshAttrs();
  }

  dispatch(tr: Transaction) {
    const before = this.state;
    this.state = applyTransaction(this.state, tr);
    const remote = !!tr.getMeta("remote");
    if (tr.docChanged) {
      if (remote) {
        this.history.mapThrough(tr.mapping);
      } else if (!tr.getMeta("history") && !tr.getMeta("addToHistory:false")) {
        if (tr.getMeta("inputRule")) this.history.closeGroup();
        this.history.record(tr, before.selection);
        if (tr.getMeta("inputRule")) this.history.closeGroup();
      }
      if (!remote) this.options.onLocalChange?.(this, tr);
    }
    if (!tr.getMeta("inputRule") && (tr.docChanged || tr.selectionSet)) {
      if (!tr.getMeta("keepInputRule")) this.lastInputRule = null;
    }
    if (tr.docChanged && !remote && this.editable) this.ensureTrailingParagraph();
    this.view.updateState(this.state);
    if (tr.scrollIntoView && this.view.focused) this.scrollToSelection();
    this.options.onUpdate?.(this, tr);
    this.updateListeners.forEach((l) => l(tr));
  }

  /** Listens to every state change; returns an unsubscribe function. */
  onUpdate(fn: (tr: Transaction | null) => void) {
    this.updateListeners.add(fn);
    return () => {
      this.updateListeners.delete(fn);
    };
  }

  onFocus(fn: (focused: boolean) => void) {
    this.focusListeners.add(fn);
    return () => {
      this.focusListeners.delete(fn);
    };
  }

  /**
   * Keeps an empty paragraph after a trailing block (table, code, callout…)
   * so there is always somewhere to type below it.
   */
  private ensureTrailingParagraph() {
    const children = this.state.doc.content ?? [];
    const last = children[children.length - 1];
    if (!last) {
      // Deleting everything (Safari's select-all reaches outside the first
      // block) must still leave a paragraph to type in.
      const tr = new Transaction(this.state);
      tr.replace(0, 0, [{ o: "paragraph" }, { c: 1 }]);
      tr.setSelection({ anchor: 1, head: 1 });
      this.state = applyTransaction(this.state, tr);
      this.options.onLocalChange?.(this, tr);
      return;
    }
    if (last.type === "paragraph" || last.type === "heading") return;
    let end = 0;
    for (const child of children) end += nodeSize(child, this.state.schema);
    // Footnotes stay last; the paragraph goes before them.
    if (last.type === "footnotes") {
      const prev = children[children.length - 2];
      if (!prev || prev.type === "paragraph") return;
      end -= nodeSize(last, this.state.schema);
    }
    const tr = new Transaction(this.state);
    tr.replace(end, end, [{ o: "paragraph" }, { c: 1 }]);
    this.state = applyTransaction(this.state, tr);
    this.options.onLocalChange?.(this, tr);
  }

  /** Runs a command against the current state. */
  run(command: Command): boolean {
    return command(this.state, (tr) => this.dispatch(tr));
  }

  focus() {
    this.view.focus();
  }

  undo() {
    const tr = this.history.undo(this.state);
    if (tr) this.dispatch(tr);
    return !!tr;
  }

  redo() {
    const tr = this.history.redo(this.state);
    if (tr) this.dispatch(tr);
    return !!tr;
  }

  insertText(text: string, from?: number, to?: number) {
    const ok = this.run(insertText(text, from, to));
    if (ok && text.length <= 2) {
      const before = this.state;
      const tr = runInputRules(this.state, this.state.selection.head);
      if (tr) {
        this.dispatch(tr);
        this.lastInputRule = { tr, before };
      }
    }
    return ok;
  }

  /** Backspace right after an input rule restores the typed text. */
  private undoInputRule(): boolean {
    const last = this.lastInputRule;
    if (!last) return false;
    this.lastInputRule = null;
    const tr = new Transaction(this.state);
    for (let i = last.tr.inverses.length - 1; i >= 0; i--) {
      if (!tr.maybeStep(last.tr.inverses[i]!)) return false;
    }
    tr.setSelection(last.before.selection);
    this.dispatch(tr);
    return true;
  }

  private scrollToSelection() {
    const rect = this.view.coordsAtPos(this.state.selection.head);
    if (!rect) return;
    const margin = 80;
    if (rect.bottom > window.innerHeight - margin) window.scrollBy({ top: rect.bottom - window.innerHeight + margin });
    else if (rect.top < margin) window.scrollBy({ top: rect.top - margin });
  }

  private nodeAttrs(state: EditorState) {
    const map = new Map<number, Record<string, string>>();
    const placeholder = this.options.placeholder;
    if (!placeholder || !this.view?.editable) return map;
    const { doc, schema: s } = state;
    const children = doc.content ?? [];
    if (children.length === 1 && children[0]!.type === "paragraph" && !(children[0]!.content ?? []).length) {
      map.set(0, { "data-placeholder": placeholder, class: "is-empty" });
      return map;
    }
    if (isEmpty(state.selection) && this.view?.focused) {
      const $head = $(doc, state.selection.head, s);
      if ($head.parent.type === "paragraph" && !($head.parent.content ?? []).length && $head.depth >= 1) {
        map.set($head.before(), { "data-placeholder": "Type '/' for commands", class: "is-empty" });
      }
    }
    return map;
  }

  private buildKeymap(): Record<string, (editor: Editor) => boolean> {
    const c = (command: Command) => (e: Editor) => e.run(command);
    return {
      "Mod-z": (e: Editor) => e.undo(),
      "Mod-Shift-z": (e: Editor) => e.redo(),
      "Mod-y": (e: Editor) => e.redo(),
      "Mod-b": c(toggleMark("bold")),
      "Mod-i": c(toggleMark("italic")),
      "Mod-u": c(toggleMark("underline")),
      "Mod-Shift-s": c(toggleMark("strike")),
      "Mod-Shift-x": c(toggleMark("strike")),
      "Mod-e": c(toggleMark("code")),
      "Mod-Shift-h": c(toggleMark("highlight")),
      "Mod-,": c(toggleMark("subscript")),
      "Mod-.": c(toggleMark("superscript")),
      "Mod-Alt-0": c(setBlockType("paragraph")),
      "Mod-Alt-1": c(setBlockType("heading", { level: 1 })),
      "Mod-Alt-2": c(setBlockType("heading", { level: 2 })),
      "Mod-Alt-3": c(setBlockType("heading", { level: 3 })),
      "Mod-Alt-4": c(setBlockType("heading", { level: 4 })),
      "Mod-Alt-5": c(setBlockType("heading", { level: 5 })),
      "Mod-Alt-6": c(setBlockType("heading", { level: 6 })),
      "Mod-Alt-c": c(setBlockType("codeBlock")),
      "Mod-Shift-7": c(toggleList("orderedList")),
      "Mod-Shift-8": c(toggleList("bulletList")),
      "Mod-Shift-9": c(toggleList("taskList")),
      "Mod-a": c(selectAll),
      ArrowDown: (e: Editor) => leaveTableVertically(e, 1),
      ArrowUp: (e: Editor) => leaveTableVertically(e, -1),
      "Mod-Enter": c(exitCode),
      "Shift-Enter": c(insertHardBreak),
      Tab: c(chain(sinkListItem, (state, dispatch) => {
        const parentType = $(state.doc, selFrom(state.selection), state.schema).parent.type;
        if (!state.schema.nodes[parentType]?.code) return false;
        return insertText("  ")(state, dispatch);
      }, indentBlocks(1))),
      "Shift-Tab": c(chain(liftListItem, indentBlocks(-1))),
      Backspace: (e: Editor) => {
        if (e.undoInputRule()) return true;
        return e.run(deleteBackward);
      },
      Delete: c(deleteForward),
      "Mod-Backspace": (e: Editor) => (isEmpty(e.state.selection) ? false : e.run(deleteSelection)),
    };
  }

  private handleKeyDown(event: KeyboardEvent): boolean {
    for (const handler of this.options.keyHandlers ?? []) if (handler(this, event)) return true;
    if (!this.editable) return false;
    const key = normalizeKey(event);
    const binding = this.keymap[key];
    if (binding) {
      // Plain Backspace/Delete with a text selection go through beforeinput.
      if ((key === "Backspace" || key === "Delete") && !this.state.selection.node && !this.lastInputRule) {
        return false;
      }
      return binding(this);
    }
    if (key === "Enter" && this.state.selection.node) return this.run(splitBlock);
    return false;
  }

  private handleBeforeInput(event: InputEvent): boolean {
    const type = event.inputType;
    const prevent = () => {
      if (event.cancelable) event.preventDefault();
    };
    switch (type) {
      case "insertText": {
        if (this.view.composing || event.isComposing) return false;
        prevent();
        this.insertText(event.data ?? "");
        return true;
      }
      case "insertReplacementText": {
        prevent();
        const text = event.dataTransfer?.getData("text/plain") ?? event.data ?? "";
        const range = this.targetRange(event);
        if (range) this.insertText(text, range.from, range.to);
        else this.insertText(text);
        return true;
      }
      case "insertParagraph":
        prevent();
        this.run(splitBlock);
        return true;
      case "insertLineBreak":
        prevent();
        this.run(insertHardBreak);
        return true;
      case "deleteContentBackward":
        if (this.view.composing) return false;
        prevent();
        if (!this.undoInputRule()) this.run(deleteBackward);
        return true;
      case "deleteContentForward":
        prevent();
        this.run(deleteForward);
        return true;
      case "deleteWordBackward":
      case "deleteWordForward":
      case "deleteSoftLineBackward":
      case "deleteSoftLineForward":
      case "deleteHardLineBackward":
      case "deleteHardLineForward":
      case "deleteEntireSoftLine":
      case "deleteContent": {
        if (this.view.composing) return false;
        prevent();
        if (!isEmpty(this.state.selection)) {
          this.run(deleteSelection);
          return true;
        }
        const range = this.targetRange(event);
        if (range && range.from !== range.to) {
          const tr = new Transaction(this.state);
          tr.setSelection({ anchor: range.from, head: range.to });
          this.dispatch(tr);
          this.run(deleteSelection);
        } else if (type.endsWith("Backward")) {
          this.run(deleteBackward);
        } else {
          this.run(deleteForward);
        }
        return true;
      }
      case "deleteByCut":
      case "deleteByDrag":
        prevent();
        this.run(deleteSelection);
        return true;
      case "historyUndo":
        prevent();
        this.undo();
        return true;
      case "historyRedo":
        prevent();
        this.redo();
        return true;
      case "formatBold":
        prevent();
        this.run(toggleMark("bold"));
        return true;
      case "formatItalic":
        prevent();
        this.run(toggleMark("italic"));
        return true;
      case "formatUnderline":
        prevent();
        this.run(toggleMark("underline"));
        return true;
      case "formatStrikeThrough":
        prevent();
        this.run(toggleMark("strike"));
        return true;
      case "insertCompositionText":
      case "deleteCompositionText":
      case "insertFromComposition":
        return false;
      case "insertFromPaste":
      case "insertFromPasteAsQuotation":
      case "insertFromDrop":
        // Handled by the paste/drop listeners.
        prevent();
        return true;
      default:
        prevent();
        return true;
    }
  }

  private targetRange(event: InputEvent): { from: number; to: number } | null {
    const ranges = event.getTargetRanges?.() ?? [];
    const range = ranges[0];
    if (!range) return null;
    const from = this.view.posFromDOM(range.startContainer, range.startOffset);
    const to = this.view.posFromDOM(range.endContainer, range.endOffset);
    if (from === null || to === null) return null;
    return { from: Math.min(from, to), to: Math.max(from, to) };
  }

  destroy() {
    this.view.destroy();
  }
}
