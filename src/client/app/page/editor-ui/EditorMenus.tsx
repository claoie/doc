import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Space, Suggestions } from "common/api-types";
import type { Node } from "common/editor/model";
import { schema } from "common/editor/doc-schema";
import { uuid } from "common/ids";
import { $ } from "common/editor/resolved";
import { isEmpty, selFrom, selTo, Transaction } from "common/editor/state";
import { descendants, nodeAt, nodeSize } from "common/editor/tokens";
import {
  activeMark,
  blockTypeActive,
  deleteSelection,
  insertText,
  markActive,
  markRange,
  setBlockType,
  setMark,
  toggleList,
  toggleMark,
  toggleWrap,
  unsetMark,
  clearFormatting,
} from "common/editor/commands";
import {
  addColumn,
  addRow,
  deleteColumn,
  deleteRow,
  deleteTable,
  mergeCells,
  setCellAttrs,
  splitCell,
  tableContext,
  toggleHeaderColumn,
  toggleHeaderRow,
  goToCell,
} from "common/editor/table";
import type { Editor } from "../../../editor/editor";
import { Icon, type IconName } from "../../components/Icon";
import { cx, errorMessage, useToast } from "../../components/ui";
import { treeCache } from "../../store";
import { api } from "../../api";
import { navigate, pageUrl } from "../../router";
import { filterSlash, type SlashItem } from "./slash-items";
import { insertUploadedFiles, pickFiles } from "./uploads";
import { EmojiPicker, loadEmoji, rememberEmoji, searchEmoji, type Emoji } from "../../components/EmojiPicker";
import { FindReplace } from "./FindReplace";

interface Suggest {
  kind: "slash" | "mention" | "emoji";
  from: number;
  to: number;
  query: string;
}

const TEXT_COLORS = [
  ["Default", ""],
  ["Gray", "#A8A29E"],
  ["Brown", "#92400E"],
  ["Orange", "#FFA500"],
  ["Yellow", "#EAB308"],
  ["Green", "#008A00"],
  ["Blue", "#2563EB"],
  ["Purple", "#9333EA"],
  ["Pink", "#BA4081"],
  ["Red", "#E00000"],
] as const;

const HIGHLIGHT_COLORS = [
  ["Default", ""],
  ["Gray", "#dfdfd7"],
  ["Brown", "#d7c4b7"],
  ["Orange", "#f5c8a9"],
  ["Yellow", "#faf594"],
  ["Green", "#7edb6c"],
  ["Blue", "#98d8f2"],
  ["Purple", "#e0d6ed"],
  ["Pink", "#f5cfe0"],
  ["Red", "#ffc6c2"],
] as const;

const CELL_COLORS = [
  ["Default", ""],
  ["Gray", "#eaecef"],
  ["Blue", "#b4d5ff"],
  ["Green", "#acf5d2"],
  ["Yellow", "#fef1b4"],
  ["Red", "#ffbead"],
  ["Pink", "#ffc7fe"],
  ["Purple", "#c1b7f2"],
] as const;

/** Re-renders when the editor state changes. */
const useEditorState = (editor: Editor) => {
  const [, setTick] = useState(0);
  useEffect(() => editor.onUpdate(() => setTick((t) => t + 1)), [editor]);
  return editor.state;
};

const findSuggest = (editor: Editor): Suggest | null => {
  const { state } = editor;
  if (!isEmpty(state.selection) || state.selection.node || !editor.editable) return null;
  const pos = state.selection.head;
  const $pos = $(state.doc, pos, schema);
  if (!schema.isTextblock($pos.parent.type) || schema.nodes[$pos.parent.type]?.code) return null;
  let before = "";
  let offset = $pos.start();
  for (const child of $pos.parent.content ?? []) {
    if (offset >= pos) break;
    const len = child.type === "text" ? child.text!.length : 1;
    const take = Math.min(len, pos - offset);
    before += child.type === "text" ? (child.marks?.some((m) => m.type === "code") ? " ".repeat(take) : child.text!.slice(0, take)) : "￼";
    offset += len;
  }
  let m = before.match(/(?:^|\s)\/([^/\uFFFC]{0,30})$/);
  if (m && !/^\s|\s{2}$/.test(m[1]!) && (m[1]!.match(/\s/g) ?? []).length <= 2) {
    return { kind: "slash", from: pos - m[1]!.length - 1, to: pos, query: m[1]! };
  }
  m = before.match(/(?:^|\s)@([^@￼]{0,40})$/);
  if (m && !m[1]!.startsWith(" ") && (m[1]!.match(/\s+/g) ?? []).length <= 3) return { kind: "mention", from: pos - m[1]!.length - 1, to: pos, query: m[1]! };
  m = before.match(/(?:^|\s):([a-z0-9_+-]{2,30})$/i);
  if (m) return { kind: "emoji", from: pos - m[1]!.length - 1, to: pos, query: m[1]! };
  return null;
};

const Floating = ({
  editor,
  pos,
  children,
  placement = "below",
  className,
  anchorNode,
}: {
  editor: Editor;
  pos: number;
  children: ReactNode;
  placement?: "below" | "above";
  className?: string;
  /** Position relative to the node at `pos` rather than the caret there. */
  anchorNode?: boolean;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden", top: 0, left: 0 });
  useEffect(() => {
    const place = () => {
      const rect = anchorNode ? (editor.view.nodeDOM(pos)?.querySelector(".media-frame, iframe, img") ?? editor.view.nodeDOM(pos))?.getBoundingClientRect() : editor.view.coordsAtPos(pos);
      const el = ref.current;
      if (!rect || !el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let left = rect.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      let top = placement === "below" ? rect.bottom + 6 : rect.top - h - 8;
      if (placement === "below" && top + h > window.innerHeight - 8) top = rect.top - h - 6;
      if (placement === "above" && top < 8) top = rect.bottom + 8;
      const next = { top: Math.round(top + window.scrollY), left: Math.round(left + window.scrollX) };
      setStyle((prev) => (prev.top === next.top && prev.left === next.left && prev.visibility === undefined ? prev : next));
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  });
  const placed = style.visibility !== "hidden";
  useEffect(() => {
    const el = ref.current;
    if (!placed || !el || el.contains(document.activeElement)) return;
    el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [placed]);
  return createPortal(
    <div ref={ref} className={cx("floating", className)} style={style} onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
      {children}
    </div>,
    document.body,
  );
};

export const EditorMenus = ({
  editor,
  pageId,
  space,
  onComment,
  onClickComment,
  minimal = false,
}: {
  editor: Editor;
  pageId: string;
  space: Space;
  onComment?: (from: number, to: number) => void;
  onClickComment?: (id: string) => void;
  /** Comment editors only get mentions, emoji and inline formatting. */
  minimal?: boolean;
}) => {
  const state = useEditorState(editor);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [linkEditing, setLinkEditing] = useState(false);
  const [focused, setFocused] = useState(editor.view.focused);
  const suggest = findSuggest(editor);
  const suggestKey = suggest ? `${suggest.kind}:${suggest.from}` : null;
  const activeSuggest = suggest && suggestKey !== dismissed ? suggest : null;
  const keyRef = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const openEmojiPicker = useCallback(() => {
    const rect = editor.view.coordsAtPos(editor.state.selection.head);
    const anchor = document.createElement("span");
    anchor.className = "caret-anchor";
    anchor.style.cssText = `position:absolute;left:${(rect?.left ?? 0) + window.scrollX}px;top:${(rect?.top ?? 0) + window.scrollY}px;width:1px;height:${rect?.height ?? 18}px`;
    document.body.append(anchor);
    setEmojiAnchor(anchor);
  }, [editor]);

  useEffect(() => {
    const handler = (_ed: Editor, e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "f" && !minimal) {
        setFindOpen(true);
        return true;
      }
      if (mod && e.key.toLowerCase() === "k") {
        if (!isEmpty(editor.state.selection) || activeMark(editor.state, "link")) {
          setLinkEditing(true);
          return true;
        }
      }
      if (e.key === "Tab" && tableContext(editor.state)) {
        return editor.run(goToCell(e.shiftKey ? -1 : 1));
      }
      return keyRef.current?.(e) ?? false;
    };
    const handlers = (editor.options.keyHandlers ??= []);
    handlers.unshift(handler);
    const offFocus = editor.onFocus(setFocused);
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest?.(".comment-mark") as HTMLElement | null;
      if (el?.dataset.commentId) onClickComment?.(el.dataset.commentId);
      const link = (e.target as HTMLElement).closest?.("a[data-href]") as HTMLElement | null;
      if (link && (e.metaKey || e.ctrlKey || !editor.editable)) {
        e.preventDefault();
        const href = link.dataset.href ?? "";
        if (href.startsWith("/") && !href.startsWith("//") && !(e.metaKey || e.ctrlKey)) navigate(href);
        else window.open(href, "_blank", "noopener");
      } else if (link) {
        e.preventDefault();
      }
    };
    editor.view.dom.addEventListener("click", onClick);
    return () => {
      const i = handlers.indexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
      offFocus();
      editor.view.dom.removeEventListener("click", onClick);
    };
  }, [editor, onClickComment, minimal]);

  useEffect(() => {
    if (suggestKey !== dismissed && dismissed && !suggestKey) setDismissed(null);
  }, [suggestKey, dismissed]);

  const sel = state.selection;
  const selectedNode = sel.node ? nodeAt(state.doc, sel.anchor, schema)?.node ?? null : null;
  const tableCtx = tableContext(state);
  const inTable = !!tableCtx;
  const headCell = tableCtx && !isEmpty(sel) ? tableContext(state, sel.anchor === selFrom(sel) ? sel.head : sel.anchor) : null;
  const spansCells = !!headCell && headCell.table === tableCtx!.table && headCell.cell !== tableCtx!.cell;
  const showBubble = focused && editor.editable && !isEmpty(sel) && !sel.node && !activeSuggest && !inCode(editor);
  const cursorLink = isEmpty(sel) && focused ? activeMark(state, "link") : null;

  return (
    <>
      {activeSuggest?.kind === "slash" && !minimal && (
        <SlashMenu editor={editor} suggest={activeSuggest} pageId={pageId} spaceId={space?.id} keyRef={keyRef} onDismiss={() => setDismissed(suggestKey)} openEmoji={openEmojiPicker} />
      )}
      {activeSuggest?.kind === "mention" && <MentionMenu editor={editor} suggest={activeSuggest} space={space} keyRef={keyRef} onDismiss={() => setDismissed(suggestKey)} />}
      {activeSuggest?.kind === "emoji" && <EmojiMenu editor={editor} suggest={activeSuggest} keyRef={keyRef} onDismiss={() => setDismissed(suggestKey)} />}
      {!activeSuggest && <KeyReset keyRef={keyRef} />}
      {showBubble && !linkEditing && (
        <BubbleMenu editor={editor} minimal={minimal} onLink={() => setLinkEditing(true)} onComment={onComment ? () => onComment(selFrom(sel), selTo(sel)) : undefined} />
      )}
      {linkEditing && <LinkEditor editor={editor} space={space} onClose={() => setLinkEditing(false)} />}
      {!linkEditing && cursorLink && !showBubble && <LinkPreview editor={editor} href={String(cursorLink.attrs?.href ?? "")} onEdit={() => setLinkEditing(true)} />}
      {selectedNode && editor.editable && !minimal && <NodeToolbar editor={editor} node={selectedNode} pos={sel.anchor} />}
      {inTable && editor.editable && focused && (!showBubble || spansCells) && !minimal && <TableToolbar editor={editor} />}
      {findOpen && <FindReplace editor={editor} onClose={() => setFindOpen(false)} />}
      {emojiAnchor && (
        <EmojiPicker
          anchor={emojiAnchor}
          onSelect={(char) => {
            editor.run(insertText(char));
            editor.focus();
          }}
          onClose={() => {
            emojiAnchor.remove();
            setEmojiAnchor(null);
          }}
        />
      )}
    </>
  );
};

const KeyReset = ({ keyRef }: { keyRef: React.MutableRefObject<((e: KeyboardEvent) => boolean) | null> }) => {
  useEffect(() => {
    keyRef.current = null;
  });
  return null;
};

const inCode = (editor: Editor) => {
  const $pos = $(editor.state.doc, selFrom(editor.state.selection), schema);
  return !!schema.nodes[$pos.parent.type]?.code;
};

const useListKeys = <T,>(
  items: T[],
  keyRef: React.MutableRefObject<((e: KeyboardEvent) => boolean) | null>,
  choose: (item: T) => void,
  onDismiss: () => void,
) => {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [items.length]);
  useEffect(() => {
    keyRef.current = (e) => {
      if (e.key === "ArrowDown") {
        setActive((a) => (items.length ? (a + 1) % items.length : 0));
        return true;
      }
      if (e.key === "ArrowUp") {
        setActive((a) => (items.length ? (a - 1 + items.length) % items.length : 0));
        return true;
      }
      if ((e.key === "Enter" || e.key === "Tab") && items.length) {
        const item = items[Math.min(active, items.length - 1)];
        if (item !== undefined) choose(item);
        return true;
      }
      if (e.key === "Escape") {
        onDismiss();
        return true;
      }
      return false;
    };
  });
  return [active, setActive] as const;
};

const deleteTrigger = (editor: Editor, suggest: Suggest) => {
  const tr = new Transaction(editor.state);
  tr.delete(suggest.from, suggest.to);
  tr.setSelection({ anchor: suggest.from, head: suggest.from });
  editor.dispatch(tr);
};

const SlashMenu = ({
  editor,
  suggest,
  pageId,
  spaceId,
  keyRef,
  onDismiss,
  openEmoji,
}: {
  editor: Editor;
  suggest: Suggest;
  pageId: string;
  spaceId?: string;
  openEmoji: () => void;
  keyRef: React.MutableRefObject<((e: KeyboardEvent) => boolean) | null>;
  onDismiss: () => void;
}) => {
  const items = useMemo(() => filterSlash(suggest.query), [suggest.query]);
  const listRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const choose = useCallback(
    (item: SlashItem) => {
      deleteTrigger(editor, suggest);
      item.run(editor, {
        pickFiles: (accept, multiple) => {
          void pickFiles(accept, multiple).then((files) => {
            if (files.length) void insertUploadedFiles(editor, files, pageId, (m) => alert(m));
          });
        },
        openEmoji,
        createBase: spaceId
          ? async (template) => {
              try {
                const { page } = await api.createBase({ spaceId, parentId: pageId, template });
                treeCache.invalidate(spaceId);
                return page.id;
              } catch (e) {
                toast(errorMessage(e), "error");
                return null;
              }
            }
          : undefined,
      });
      editor.focus();
    },
    [editor, suggest, pageId, spaceId, openEmoji, toast],
  );
  const [active, setActive] = useListKeys(items, keyRef, choose, onDismiss);
  useEffect(() => {
    listRef.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [active]);
  if (!items.length) return null;
  let lastGroup = "";
  return (
    <Floating editor={editor} pos={suggest.from} className="suggest-menu slash-menu">
      <div ref={listRef} className="suggest-scroll">
        {items.map((item, i) => {
          const header = item.group !== lastGroup && !suggest.query ? item.group : null;
          lastGroup = item.group;
          return (
            <div key={item.title}>
              {header && <div className="suggest-group">{header}</div>}
              <button type="button" className={cx("suggest-item", i === active && "active")} onMouseEnter={() => setActive(i)} onClick={() => choose(item)}>
                <span className="suggest-icon">
                  <Icon name={item.icon} size={18} />
                </span>
                <span className="suggest-text">
                  <span className="suggest-title">{item.title}</span>
                  <span className="suggest-desc">{item.description}</span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </Floating>
  );
};

const MentionMenu = ({
  editor,
  suggest,
  space,
  keyRef,
  onDismiss,
}: {
  editor: Editor;
  suggest: Suggest;
  space: Space;
  keyRef: React.MutableRefObject<((e: KeyboardEvent) => boolean) | null>;
  onDismiss: () => void;
}) => {
  const [results, setResults] = useState<Suggestions>({ users: [], pages: [] });
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .suggest({ q: suggest.query, spaceId: space.id, users: true, pages: true, limit: 6 })
        .then(setResults)
        .catch(() => undefined);
    }, 120);
    return () => clearTimeout(t);
  }, [suggest.query, space.id]);
  type Entry = { kind: "user"; id: string; label: string; sub: string } | { kind: "page"; id: string; label: string; slugId: string; icon: string | null; sub: string } | { kind: "create"; label: string };
  const entries: Entry[] = [
    ...results.users.map((u) => ({ kind: "user" as const, id: u.id, label: u.name, sub: u.email })),
    ...results.pages.map((p) => ({ kind: "page" as const, id: p.id, label: p.title || "Untitled", slugId: p.slugId, icon: p.icon, sub: p.space.name })),
    ...(suggest.query.trim() ? [{ kind: "create" as const, label: suggest.query.trim() }] : []),
  ];
  const choose = async (entry: Entry) => {
    if (entry.kind === "create") {
      const { page } = await api.createPage({ spaceId: space.id, title: entry.label });
      insertMention(editor, suggest, { entityType: "page", entityId: page.id, slugId: page.slugId, label: page.title ?? entry.label });
      return;
    }
    if (entry.kind === "user") insertMention(editor, suggest, { entityType: "user", entityId: entry.id, label: entry.label });
    else insertMention(editor, suggest, { entityType: "page", entityId: entry.id, slugId: entry.slugId, label: entry.label });
  };
  const [active, setActive] = useListKeys(entries, keyRef, (e) => void choose(e), onDismiss);
  return (
    <Floating editor={editor} pos={suggest.from} className="suggest-menu">
      {results.users.length > 0 && <div className="suggest-group">People</div>}
      {entries.map((entry, i) => (
        <div key={i}>
          {entry.kind === "page" && i === results.users.length && <div className="suggest-group">Pages</div>}
          <button type="button" className={cx("suggest-item compact", i === active && "active")} onMouseEnter={() => setActive(i)} onClick={() => void choose(entry)}>
            <span className="suggest-icon">{entry.kind === "user" ? <Icon name="user" size={16} /> : entry.kind === "page" ? entry.icon || <Icon name="page" size={16} /> : <Icon name="plus" size={16} />}</span>
            <span className="suggest-text">
              <span className="suggest-title">{entry.kind === "create" ? `Create page “${entry.label}”` : entry.label}</span>
              {entry.kind !== "create" && <span className="suggest-desc">{entry.sub}</span>}
            </span>
          </button>
        </div>
      ))}
      {!entries.length && <div className="suggest-empty">Type to search people and pages</div>}
    </Floating>
  );
};

const mentionId = () => uuid();

const insertMention = (editor: Editor, suggest: Suggest, attrs: Record<string, unknown>) => {
  const tr = new Transaction(editor.state);
  const node: Node = schema.node("mention", { id: mentionId(), ...attrs });
  tr.replace(suggest.from, suggest.to, [{ n: node }, { t: " " }]);
  tr.setSelection({ anchor: suggest.from + 2, head: suggest.from + 2 });
  editor.dispatch(tr);
  editor.focus();
};

const EmojiMenu = ({
  editor,
  suggest,
  keyRef,
  onDismiss,
}: {
  editor: Editor;
  suggest: Suggest;
  keyRef: React.MutableRefObject<((e: KeyboardEvent) => boolean) | null>;
  onDismiss: () => void;
}) => {
  const [all, setAll] = useState<Emoji[]>([]);
  useEffect(() => {
    void loadEmoji().then(setAll);
  }, []);
  const items = useMemo(() => searchEmoji(all, suggest.query.replace(/_/g, " "), 8), [all, suggest.query]);
  const choose = (e: Emoji) => {
    rememberEmoji(e.char);
    const tr = new Transaction(editor.state);
    tr.insertText(e.char + " ", suggest.from, suggest.to);
    tr.setSelection({ anchor: suggest.from + e.char.length + 1, head: suggest.from + e.char.length + 1 });
    editor.dispatch(tr);
  };
  const [active, setActive] = useListKeys(items, keyRef, choose, onDismiss);
  if (!items.length) return null;
  return (
    <Floating editor={editor} pos={suggest.from} className="suggest-menu emoji-menu">
      {items.map((e, i) => (
        <button key={e.char + e.name} type="button" className={cx("suggest-item compact", i === active && "active")} onMouseEnter={() => setActive(i)} onClick={() => choose(e)}>
          <span className="suggest-icon">{e.char}</span>
          <span className="suggest-title">:{e.name.replace(/\s+/g, "_")}:</span>
        </button>
      ))}
    </Floating>
  );
};

const ToolButton = ({ icon, label, active, onClick, children }: { icon?: IconName; label: string; active?: boolean; onClick: () => void; children?: ReactNode }) => (
  <button type="button" className={cx("tool", active && "active")} title={label} aria-label={label} onClick={onClick}>
    {icon ? <Icon name={icon} size={16} /> : children}
  </button>
);

const BLOCK_CHOICES: { label: string; icon: IconName; type: string; attrs?: Record<string, unknown>; wrap?: boolean; list?: boolean }[] = [
  { label: "Text", icon: "alignLeft", type: "paragraph" },
  { label: "Heading 1", icon: "heading", type: "heading", attrs: { level: 1 } },
  { label: "Heading 2", icon: "heading", type: "heading", attrs: { level: 2 } },
  { label: "Heading 3", icon: "heading", type: "heading", attrs: { level: 3 } },
  { label: "To-do list", icon: "listTask", type: "taskList", list: true },
  { label: "Bullet list", icon: "list", type: "bulletList", list: true },
  { label: "Numbered list", icon: "listOrdered", type: "orderedList", list: true },
  { label: "Quote", icon: "quote", type: "blockquote", wrap: true },
  { label: "Code", icon: "code", type: "codeBlock" },
  { label: "Callout", icon: "callout", type: "callout", wrap: true, attrs: { type: "info" } },
];

const BubbleMenu = ({ editor, onLink, onComment, minimal }: { editor: Editor; onLink: () => void; onComment?: () => void; minimal?: boolean }) => {
  const state = editor.state;
  const [panel, setPanel] = useState<"block" | "color" | "align" | null>(null);
  const run = (cmd: Parameters<Editor["run"]>[0]) => {
    editor.run(cmd);
  };
  const $from = $(state.doc, selFrom(state.selection), schema);
  const current = BLOCK_CHOICES.find((c) => (c.list || c.wrap ? $from.findDepth((n) => n.type === c.type) > 0 : blockTypeActive(state, c.type, c.attrs))) ?? BLOCK_CHOICES[0]!;
  const parentAlign = ($from.parent.attrs?.textAlign as string) || "left";
  return (
    <Floating editor={editor} pos={selFrom(state.selection)} placement="above" className="bubble">
      <div className="toolbar">
        {!minimal && (
          <>
            <button type="button" className="tool tool-wide" onClick={() => setPanel(panel === "block" ? null : "block")}>
              {current.label} <Icon name="chevronDown" size={12} />
            </button>
            <span className="tool-sep" />
          </>
        )}
        <ToolButton icon="bold" label="Bold" active={markActive(state, "bold")} onClick={() => run(toggleMark("bold"))} />
        <ToolButton icon="italic" label="Italic" active={markActive(state, "italic")} onClick={() => run(toggleMark("italic"))} />
        <ToolButton icon="underline" label="Underline" active={markActive(state, "underline")} onClick={() => run(toggleMark("underline"))} />
        <ToolButton icon="strike" label="Strikethrough" active={markActive(state, "strike")} onClick={() => run(toggleMark("strike"))} />
        <ToolButton icon="code" label="Inline code" active={markActive(state, "code")} onClick={() => run(toggleMark("code"))} />
        <ToolButton icon="link" label="Link" active={markActive(state, "link")} onClick={onLink} />
        {!minimal && <ToolButton icon="x" label="Clear formatting" onClick={() => run(clearFormatting)} />}
        {!minimal && <ToolButton icon="color" label="Color" onClick={() => setPanel(panel === "color" ? null : "color")} />}
        {!minimal && (
          <ToolButton icon={parentAlign === "center" ? "alignCenter" : parentAlign === "right" ? "alignRight" : parentAlign === "justify" ? "alignJustify" : "alignLeft"} label="Alignment" onClick={() => setPanel(panel === "align" ? null : "align")} />
        )}
        {onComment && (
          <>
            <span className="tool-sep" />
            <ToolButton icon="comment" label="Comment" onClick={onComment} />
          </>
        )}
      </div>
      {panel === "block" && (
        <div className="toolbar-panel">
          {BLOCK_CHOICES.map((c) => (
            <button
              key={c.label}
              type="button"
              className={cx("panel-item", c === current && "active")}
              onClick={() => {
                if (c.list) run(toggleList(c.type));
                else if (c.wrap) run(toggleWrap(c.type, c.attrs));
                else run(setBlockType(c.type, c.attrs));
                setPanel(null);
              }}
            >
              <Icon name={c.icon} size={16} /> {c.label}
            </button>
          ))}
        </div>
      )}
      {panel === "color" && (
        <div className="toolbar-panel color-panel">
          <div className="panel-label">Text color</div>
          <div className="swatches">
            {TEXT_COLORS.map(([name, color]) => (
              <button
                key={name}
                type="button"
                className="swatch-btn"
                title={name}
                style={{ color: color || "var(--text)" }}
                onClick={() => run(color ? setMark(schema.mark("textStyle", { color })) : unsetMark("textStyle"))}
              >
                A
              </button>
            ))}
          </div>
          <div className="panel-label">Highlight</div>
          <div className="swatches">
            {HIGHLIGHT_COLORS.map(([name, color]) => (
              <button
                key={name}
                type="button"
                className="swatch-btn"
                title={name}
                style={{ background: color || "transparent" }}
                onClick={() => run(color ? setMark(schema.mark("highlight", { color, colorName: name.toLowerCase() })) : unsetMark("highlight"))}
              >
                {color ? "" : "∅"}
              </button>
            ))}
          </div>
        </div>
      )}
      {panel === "align" && (
        <div className="toolbar-panel">
          {(["left", "center", "right", "justify"] as const).map((align) => (
            <button key={align} type="button" className={cx("panel-item", parentAlign === align && "active")} onClick={() => (setAlign(editor, align), setPanel(null))}>
              <Icon name={align === "left" ? "alignLeft" : align === "center" ? "alignCenter" : align === "right" ? "alignRight" : "alignJustify"} size={16} /> {align[0]!.toUpperCase() + align.slice(1)}
            </button>
          ))}
        </div>
      )}
    </Floating>
  );
};

const setAlign = (editor: Editor, align: string) => {
  const { state } = editor;
  const tr = new Transaction(state);
  const from = selFrom(state.selection);
  const to = selTo(state.selection);
  descendants(state.doc, schema, (node, pos) => {
    const end = pos + nodeSize(node, schema);
    if (end < from || pos > to) return false;
    if (node.type === "paragraph" || node.type === "heading") {
      tr.setNodeAttrs(pos, { ...node.attrs, textAlign: align === "left" ? null : align });
      return false;
    }
    return !schema.isTextblock(node.type);
  });
  if (tr.docChanged) editor.dispatch(tr);
};

const LinkEditor = ({ editor, space, onClose }: { editor: Editor; space: Space; onClose: () => void }) => {
  const state = editor.state;
  const existing = activeMark(state, "link");
  const range = isEmpty(state.selection) ? markRange(state, "link") : { from: selFrom(state.selection), to: selTo(state.selection) };
  const [href, setHref] = useState(String(existing?.attrs?.href ?? ""));
  const [pages, setPages] = useState<Suggestions["pages"]>([]);
  useEffect(() => {
    const q = href.trim();
    if (!q || /^(https?:|mailto:|\/)/.test(q)) {
      setPages([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .suggest({ q, spaceId: space.id, pages: true, limit: 5 })
        .then((r) => setPages(r.pages))
        .catch(() => undefined);
    }, 150);
    return () => clearTimeout(t);
  }, [href, space.id]);
  if (!range) {
    onClose();
    return null;
  }
  const apply = (value: string, internal = false) => {
    const url = value.trim();
    if (!url) {
      editor.run((s, d) => unsetMark("link")({ ...s, selection: { anchor: range.from, head: range.to } }, d));
    } else {
      const normalized = internal || /^(https?:|mailto:|tel:|\/|#)/.test(url) ? url : `https://${url}`;
      editor.run((s, d) => setMark(schema.mark("link", { href: normalized, internal }))({ ...s, selection: { anchor: range.from, head: range.to } }, d));
    }
    onClose();
    editor.focus();
  };
  return (
    <Floating editor={editor} pos={range.from} className="link-editor">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply(href);
        }}
      >
        <input
          className="input"
          data-autofocus
          placeholder="Paste a link or search pages"
          value={href}
          onChange={(e) => setHref(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onClose();
              editor.focus();
            }
          }}
        />
        <div className="row gap-s link-actions">
          <button type="submit" className="btn btn-primary">
            Apply
          </button>
          {existing && (
            <button type="button" className="btn" onClick={() => apply("")}>
              Remove link
            </button>
          )}
        </div>
      </form>
      {pages.map((p) => (
        <button key={p.id} type="button" className="suggest-item compact" onClick={() => apply(pageUrl(p.space.slug, p), true)}>
          <span className="suggest-icon">{p.icon || <Icon name={p.isBase ? "table" : "page"} size={16} />}</span>
          <span className="suggest-title">{p.title || "Untitled"}</span>
        </button>
      ))}
    </Floating>
  );
};

const LinkPreview = ({ editor, href, onEdit }: { editor: Editor; href: string; onEdit: () => void }) => (
  <Floating editor={editor} pos={editor.state.selection.head} className="link-preview">
    <a href={href} target="_blank" rel="noopener noreferrer" className="link-preview-url">
      {href}
    </a>
    {editor.editable && (
      <button type="button" className="tool" onClick={onEdit} aria-label="Edit link">
        <Icon name="edit" size={15} />
      </button>
    )}
  </Floating>
);

const NodeToolbar = ({ editor, node, pos }: { editor: Editor; node: Node; pos: number }) => {
  const alignable = ["image", "video", "drawio", "excalidraw", "embed"].includes(node.type);
  const setAttrs = (attrs: Record<string, unknown>) => {
    const tr = new Transaction(editor.state);
    tr.setNodeAttrs(pos, { ...node.attrs, ...attrs });
    editor.dispatch(tr);
  };
  const src = String(node.attrs?.src ?? node.attrs?.url ?? "");
  return (
    <Floating editor={editor} pos={pos} placement="above" className="bubble" anchorNode>
      <div className="toolbar">
        {alignable && (
          <>
            <ToolButton icon="alignLeft" label="Align left" active={node.attrs?.align === "left"} onClick={() => setAttrs({ align: "left" })} />
            <ToolButton icon="alignCenter" label="Align center" active={(node.attrs?.align ?? "center") === "center"} onClick={() => setAttrs({ align: "center" })} />
            <ToolButton icon="alignRight" label="Align right" active={node.attrs?.align === "right"} onClick={() => setAttrs({ align: "right" })} />
            <span className="tool-sep" />
          </>
        )}
        {node.type === "image" && (
          <ToolButton
            icon="edit"
            label="Alt text"
            onClick={() => {
              const alt = prompt("Describe this image", String(node.attrs?.alt ?? ""));
              if (alt !== null) setAttrs({ alt: alt || null });
            }}
          />
        )}
        {node.type === "image" && !!node.attrs?.width && <ToolButton icon="fullWidth" label="Original size" onClick={() => setAttrs({ width: null })} />}
        {src && src.startsWith("/api/files/") && <ToolButton icon="download" label="Download" onClick={() => window.open(src, "_blank")} />}
        <ToolButton icon="trash" label="Delete" onClick={() => editor.run(deleteSelection)} />
      </div>
    </Floating>
  );
};

const TableToolbar = ({ editor }: { editor: Editor }) => {
  const ctx = tableContext(editor.state);
  const [open, setOpen] = useState(false);
  const [colors, setColors] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tablePos = ctx?.tablePos ?? -1;
  useEffect(() => {
    const place = () => {
      const dom = tablePos >= 0 ? editor.view.nodeDOM(tablePos) : null;
      if (!dom) return setPos(null);
      const r = dom.getBoundingClientRect();
      const next = { top: Math.round(r.top + window.scrollY), left: Math.round(Math.max(4, r.left - 30) + window.scrollX) };
      setPos((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  });
  if (!ctx || !pos) return null;
  const run = (cmd: Parameters<Editor["run"]>[0]) => {
    editor.run(cmd);
    setOpen(false);
  };
  const item = (label: string, cmd: Parameters<Editor["run"]>[0], icon?: IconName) => (
    <button type="button" className="panel-item" onClick={() => run(cmd)}>
      {icon && <Icon name={icon} size={15} />} {label}
    </button>
  );
  return createPortal(
    <div className="table-handle-wrap" style={{ position: "absolute", top: pos.top, left: pos.left }} onMouseDown={(e) => e.preventDefault()}>
      <button type="button" className="table-handle" aria-label="Table options" title="Table options" onClick={() => setOpen((o) => !o)}>
        <Icon name="table" size={14} />
      </button>
      {open && (
        <div className="bubble table-menu">
          <div className="toolbar-panel">
            {item("Insert row above", addRow(false))}
            {item("Insert row below", addRow(true))}
            {item("Insert column left", addColumn(false))}
            {item("Insert column right", addColumn(true))}
            <div className="menu-separator" />
            {item("Delete row", deleteRow)}
            {item("Delete column", deleteColumn)}
            <div className="menu-separator" />
            {item("Merge selected cells", mergeCells)}
            {item("Split cell", splitCell)}
            {item("Toggle header row", toggleHeaderRow)}
            {item("Toggle header column", toggleHeaderColumn)}
            <button type="button" className="panel-item" onClick={() => setColors((c) => !c)}>
              <Icon name="color" size={15} /> Cell color
            </button>
            {colors && (
              <div className="swatches">
                {CELL_COLORS.map(([name, color]) => (
                  <button
                    key={name}
                    type="button"
                    className="swatch-btn"
                    title={name}
                    style={{ background: color || "transparent" }}
                    onClick={() => run(setCellAttrs({ backgroundColor: color || null, backgroundColorName: color ? name.toLowerCase() : null }))}
                  >
                    {color ? "" : "∅"}
                  </button>
                ))}
              </div>
            )}
            <div className="menu-separator" />
            {item("Delete table", deleteTable, "trash")}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
};

/** Always-visible formatting toolbar (a user preference). */
export const FixedToolbar = ({ editor, pageId }: { editor: Editor; pageId: string }) => {
  const state = useEditorState(editor);
  const [panel, setPanel] = useState<"color" | "insert" | null>(null);
  const run = (cmd: Parameters<Editor["run"]>[0]) => {
    editor.run(cmd);
    editor.focus();
  };
  const $from = $(state.doc, selFrom(state.selection), schema);
  const current = BLOCK_CHOICES.find((c) => (c.list || c.wrap ? $from.findDepth((n) => n.type === c.type) > 0 : blockTypeActive(state, c.type, c.attrs))) ?? BLOCK_CHOICES[0]!;
  const insertItems = filterSlash("").filter((i) => i.group !== "Embeds");
  return (
    <div className="fixed-toolbar" onMouseDown={(e) => e.target instanceof HTMLSelectElement || e.preventDefault()}>
      <select
        className="toolbar-select"
        value={current.label}
        aria-label="Block type"
        onChange={(e) => {
          const c = BLOCK_CHOICES.find((x) => x.label === e.target.value);
          if (!c) return;
          if (c.list) run(toggleList(c.type));
          else if (c.wrap) run(toggleWrap(c.type, c.attrs));
          else run(setBlockType(c.type, c.attrs));
        }}
      >
        {BLOCK_CHOICES.map((c) => (
          <option key={c.label}>{c.label}</option>
        ))}
      </select>
      <span className="tool-sep" />
      <ToolButton icon="bold" label="Bold" active={markActive(state, "bold")} onClick={() => run(toggleMark("bold"))} />
      <ToolButton icon="italic" label="Italic" active={markActive(state, "italic")} onClick={() => run(toggleMark("italic"))} />
      <ToolButton icon="underline" label="Underline" active={markActive(state, "underline")} onClick={() => run(toggleMark("underline"))} />
      <ToolButton icon="strike" label="Strikethrough" active={markActive(state, "strike")} onClick={() => run(toggleMark("strike"))} />
      <ToolButton icon="code" label="Inline code" active={markActive(state, "code")} onClick={() => run(toggleMark("code"))} />
      <ToolButton icon="color" label="Color" onClick={() => setPanel(panel === "color" ? null : "color")} />
      <span className="tool-sep" />
      <ToolButton icon="list" label="Bullet list" onClick={() => run(toggleList("bulletList"))} />
      <ToolButton icon="listOrdered" label="Numbered list" onClick={() => run(toggleList("orderedList"))} />
      <ToolButton icon="listTask" label="To-do list" onClick={() => run(toggleList("taskList"))} />
      <span className="tool-sep" />
      <ToolButton icon="alignLeft" label="Align left" onClick={() => setAlign(editor, "left")} />
      <ToolButton icon="alignCenter" label="Align center" onClick={() => setAlign(editor, "center")} />
      <ToolButton icon="alignRight" label="Align right" onClick={() => setAlign(editor, "right")} />
      <span className="tool-sep" />
      <ToolButton icon="plus" label="Insert" onClick={() => setPanel(panel === "insert" ? null : "insert")} />
      <ToolButton icon="undo" label="Undo" onClick={() => editor.undo()} />
      <ToolButton icon="redo" label="Redo" onClick={() => editor.redo()} />
      {panel === "color" && (
        <div className="fixed-toolbar-panel">
          <div className="panel-label">Text color</div>
          <div className="swatches">
            {TEXT_COLORS.map(([name, color]) => (
              <button key={name} type="button" className="swatch-btn" title={name} style={{ color: color || "var(--text)" }} onClick={() => run(color ? setMark(schema.mark("textStyle", { color })) : unsetMark("textStyle"))}>
                A
              </button>
            ))}
          </div>
          <div className="panel-label">Highlight</div>
          <div className="swatches">
            {HIGHLIGHT_COLORS.map(([name, color]) => (
              <button key={name} type="button" className="swatch-btn" title={name} style={{ background: color || "transparent" }} onClick={() => run(color ? setMark(schema.mark("highlight", { color, colorName: name.toLowerCase() })) : unsetMark("highlight"))}>
                {color ? "" : "∅"}
              </button>
            ))}
          </div>
        </div>
      )}
      {panel === "insert" && (
        <div className="fixed-toolbar-panel insert-panel">
          {insertItems.map((item) => (
            <button
              key={item.title}
              type="button"
              className="panel-item"
              onClick={() => {
                setPanel(null);
                item.run(editor, {
                  pickFiles: (accept, multiple) => {
                    void pickFiles(accept, multiple).then((files) => {
                      if (files.length) void insertUploadedFiles(editor, files, pageId, (m) => alert(m));
                    });
                  },
                  openEmoji: () => undefined,
                });
                editor.focus();
              }}
            >
              <Icon name={item.icon} size={15} /> {item.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
