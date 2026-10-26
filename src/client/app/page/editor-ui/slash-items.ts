import type { Node } from "common/editor/model";
import { schema } from "common/editor/doc-schema";
import {
  insertBlocks,
  insertInline,
  insertText,
  setBlockType,
  toggleList,
  toggleWrap,
  type Command,
} from "common/editor/commands";
import { createTable } from "common/editor/table";
import { Transaction } from "common/editor/state";
import { nodeSize, nodesToItems } from "common/editor/tokens";
import type { Editor } from "../../../editor/editor";
import type { IconName } from "../../components/Icon";
import { EMBED_PROVIDERS } from "common/embed";

export interface SlashItem {
  title: string;
  description: string;
  icon: IconName;
  keywords: string[];
  group: string;
  run: (editor: Editor, ctx: SlashContext) => void;
}

export interface SlashContext {
  pickFiles: (accept: string, multiple: boolean) => void;
  openEmoji: () => void;
  /** Creates a base as a child page and resolves to its id. */
  createBase?: (template: "table" | "kanban") => Promise<string | null>;
}

const insertBase = (template: "table" | "kanban") => (editor: Editor, ctx: SlashContext) => {
  void ctx.createBase?.(template).then((pageId) => {
    if (pageId) editor.run(insertBlocks([schema.node("base", { pageId })]));
  });
};

const blockId = () => Array.from({ length: 12 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

const cmd = (command: Command) => (editor: Editor) => editor.run(command);

const columns = (count: number): Node =>
  schema.node(
    "columns",
    { layout: ["", "", "two_equal", "three_equal", "four_equal", "five_equal"][count] },
    Array.from({ length: count }, () => schema.node("column", undefined, [schema.node("paragraph")])),
  );

const embedItem = (id: string, title: string, description: string): SlashItem => ({
  title,
  description,
  icon: id === "youtube" || id === "vimeo" || id === "loom" ? "video" : "embed",
  keywords: [id, "embed"],
  group: "Embeds",
  run: cmd(insertBlocks([schema.node("embed", { provider: id, src: "" })], false)),
});

export const SLASH_ITEMS: SlashItem[] = [
  { title: "Text", description: "Plain paragraph text.", icon: "alignLeft", keywords: ["p", "paragraph"], group: "Basic", run: cmd(setBlockType("paragraph")) },
  { title: "To-do list", description: "Track tasks with checkboxes.", icon: "listTask", keywords: ["todo", "task", "checkbox", "check"], group: "Basic", run: cmd(toggleList("taskList")) },
  { title: "Heading 1", description: "Big section heading.", icon: "heading", keywords: ["h1", "title", "big"], group: "Basic", run: cmd(setBlockType("heading", { level: 1 })) },
  { title: "Heading 2", description: "Medium section heading.", icon: "heading", keywords: ["h2", "subtitle"], group: "Basic", run: cmd(setBlockType("heading", { level: 2 })) },
  { title: "Heading 3", description: "Small section heading.", icon: "heading", keywords: ["h3"], group: "Basic", run: cmd(setBlockType("heading", { level: 3 })) },
  { title: "Bullet list", description: "A simple bulleted list.", icon: "list", keywords: ["unordered", "ul", "point"], group: "Basic", run: cmd(toggleList("bulletList")) },
  { title: "Numbered list", description: "A list with numbering.", icon: "listOrdered", keywords: ["ordered", "ol", "number"], group: "Basic", run: cmd(toggleList("orderedList")) },
  { title: "Quote", description: "Capture a quotation.", icon: "quote", keywords: ["blockquote"], group: "Basic", run: cmd(toggleWrap("blockquote")) },
  { title: "Code", description: "A code snippet with highlighting.", icon: "code", keywords: ["codeblock", "pre"], group: "Basic", run: cmd(setBlockType("codeBlock")) },
  { title: "Divider", description: "Visually separate sections.", icon: "divider", keywords: ["hr", "horizontal rule", "line"], group: "Basic", run: cmd(insertBlocks([schema.node("horizontalRule")])) },
  { title: "Page break", description: "Start a new page when printing.", icon: "pageBreak", keywords: ["break", "print"], group: "Basic", run: cmd(insertBlocks([schema.node("pageBreak")])) },
  { title: "Table", description: "Insert a table.", icon: "table", keywords: ["grid", "rows", "columns"], group: "Basic", run: cmd(insertBlocks([createTable(schema, 3, 3, true)])) },
  { title: "Toggle block", description: "Content that can be collapsed.", icon: "toggle", keywords: ["details", "collapsible", "expand"], group: "Basic", run: cmd(insertBlocks([schema.node("details", { open: true }, [schema.node("detailsSummary"), schema.node("detailsContent", undefined, [schema.node("paragraph")])])])) },
  { title: "Callout", description: "Make text stand out.", icon: "callout", keywords: ["info", "warning", "note", "notice", "panel", "danger", "success"], group: "Basic", run: cmd(toggleWrap("callout", { type: "info" })) },
  { title: "Footnote", description: "Add a footnote reference.", icon: "footnote", keywords: ["reference", "citation", "note"], group: "Basic", run: (editor) => insertFootnote(editor) },

  { title: "Image", description: "Upload an image.", icon: "image", keywords: ["photo", "picture", "media"], group: "Media", run: (_e, c) => c.pickFiles("image/*", true) },
  { title: "Video", description: "Upload a video.", icon: "video", keywords: ["mp4", "movie", "media"], group: "Media", run: (_e, c) => c.pickFiles("video/*", false) },
  { title: "Audio", description: "Upload an audio file.", icon: "music", keywords: ["sound", "mp3", "music"], group: "Media", run: (_e, c) => c.pickFiles("audio/*", false) },
  { title: "Embed PDF", description: "Upload and show a PDF.", icon: "file", keywords: ["pdf", "document"], group: "Media", run: (_e, c) => c.pickFiles("application/pdf", false) },
  { title: "File attachment", description: "Upload any file.", icon: "attach", keywords: ["file", "upload", "zip", "csv"], group: "Media", run: (_e, c) => c.pickFiles("*/*", true) },

  { title: "Math inline", description: "An inline equation.", icon: "math", keywords: ["latex", "equation", "katex", "tex"], group: "Advanced", run: cmd(insertInline(schema.node("mathInline", { text: "" }))) },
  { title: "Math block", description: "A displayed equation.", icon: "math", keywords: ["latex", "equation", "katex", "tex"], group: "Advanced", run: cmd(insertBlocks([schema.node("mathBlock", { text: "" })], false)) },
  {
    title: "Mermaid diagram",
    description: "Diagrams from text.",
    icon: "diagram",
    keywords: ["mermaid", "chart", "flowchart", "uml", "sequence"],
    group: "Advanced",
    run: cmd(insertBlocks([schema.node("codeBlock", { language: "mermaid" }, [schema.text("flowchart LR\n    A --> B")])])),
  },
  { title: "Draw.io diagram", description: "Draw diagrams with diagrams.net.", icon: "diagram", keywords: ["drawio", "diagrams", "uml", "whiteboard"], group: "Advanced", run: cmd(insertBlocks([schema.node("drawio")], false)) },
  { title: "Excalidraw", description: "Sketch on a whiteboard.", icon: "edit", keywords: ["draw", "sketch", "whiteboard"], group: "Advanced", run: cmd(insertBlocks([schema.node("excalidraw")], false)) },
  { title: "Status", description: "A small status label.", icon: "status", keywords: ["badge", "label", "lozenge"], group: "Advanced", run: cmd(insertInline(schema.node("status", { text: "", color: "gray" }))) },
  { title: "Date", description: "Today's date.", icon: "calendar", keywords: ["today"], group: "Advanced", run: (e) => e.run(insertText(new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }))) },
  { title: "Time", description: "The current time.", icon: "clock", keywords: ["now", "clock"], group: "Advanced", run: (e) => e.run(insertText(new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))) },
  { title: "Emoji", description: "Insert an emoji.", icon: "emoji", keywords: ["smiley", "icon", "reaction"], group: "Advanced", run: (_e, c) => c.openEmoji() },
  { title: "Base", description: "An inline table with typed properties.", icon: "table", keywords: ["database", "inline", "table view", "spreadsheet"], group: "Advanced", run: insertBase("table") },
  { title: "Board", description: "An inline base shown as a kanban board.", icon: "kanban", keywords: ["kanban", "database", "inline"], group: "Advanced", run: insertBase("kanban") },
  { title: "Subpages", description: "List this page's subpages.", icon: "page", keywords: ["children", "child pages", "toc"], group: "Advanced", run: cmd(insertBlocks([schema.node("subpages")])) },
  {
    title: "Synced block",
    description: "Content that can be reused on other pages.",
    icon: "sync",
    keywords: ["sync", "transclusion", "reuse", "snippet"],
    group: "Advanced",
    run: cmd(insertBlocks([schema.node("transclusionSource", { id: blockId() }, [schema.node("paragraph")])])),
  },
  { title: "2 Columns", description: "Split content into two columns.", icon: "columns", keywords: ["layout", "split", "side"], group: "Layout", run: cmd(insertBlocks([columns(2)])) },
  { title: "3 Columns", description: "Split content into three columns.", icon: "columns", keywords: ["layout", "split"], group: "Layout", run: cmd(insertBlocks([columns(3)])) },
  { title: "4 Columns", description: "Split content into four columns.", icon: "columns", keywords: ["layout", "split"], group: "Layout", run: cmd(insertBlocks([columns(4)])) },
  { title: "5 Columns", description: "Split content into five columns.", icon: "columns", keywords: ["layout", "split"], group: "Layout", run: cmd(insertBlocks([columns(5)])) },

  embedItem("iframe", "Iframe embed", "Embed any web page."),
  ...EMBED_PROVIDERS.map((p) => embedItem(p.id, p.name, `Embed ${p.name}.`)),
];

export const filterSlash = (query: string): SlashItem[] => {
  const q = query.toLowerCase().trim();
  if (!q) return SLASH_ITEMS;
  const fuzzy = (text: string) => {
    let i = 0;
    for (const ch of text.toLowerCase()) if (ch === q[i]) i++;
    return i === q.length;
  };
  const scored = SLASH_ITEMS.map((item) => {
    const title = item.title.toLowerCase();
    let score = 0;
    if (title.startsWith(q)) score = 4;
    else if (title.includes(q)) score = 3;
    else if (item.keywords.some((k) => k.startsWith(q))) score = 2;
    else if (fuzzy(title) || item.description.toLowerCase().includes(q)) score = 1;
    return { item, score };
  }).filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
};

/** Inserts a footnote reference at the cursor and its entry in the trailing footnote list. */
export const insertFootnote = (editor: Editor) => {
  const doc = editor.state.doc;
  const children = doc.content ?? [];
  const last = children[children.length - 1];
  const existing = last?.type === "footnotes" ? (last.content ?? []).length : 0;
  const number = existing + 1;
  const id = blockId();
  editor.run(insertInline(schema.node("footnoteReference", { "data-id": id, referenceNumber: String(number) })));
  const state = editor.state;
  const docNow = state.doc;
  const kids = docNow.content ?? [];
  const tail = kids[kids.length - 1];
  const footnote = schema.node("footnote", { id: `fn:${number}`, "data-id": id }, [schema.node("paragraph")]);
  let size = 0;
  for (const k of kids) size += nodeSize(k, schema);
  const tr = new Transaction(state);
  if (tail?.type === "footnotes") {
    const end = size - 1;
    tr.replace(end, end, nodesToItems([footnote], schema));
  } else {
    tr.replace(size, size, nodesToItems([schema.node("footnotes", undefined, [footnote])], schema));
  }
  editor.dispatch(tr);
};
