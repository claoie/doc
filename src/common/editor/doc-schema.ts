import { Schema, type NodeSpec, type MarkSpec } from "./schema";

const media = { group: "block", isolating: true, selectable: true };

const CELL_CONTENT =
  "(paragraph | heading | bulletList | orderedList | taskList | blockquote | callout | image | video | audio | subpages | attachment | mathBlock | details | codeBlock)+";

const SYNCED_CONTENT =
  "(paragraph | heading | blockquote | codeBlock | horizontalRule | bulletList | orderedList | taskList | image | video | audio | attachment | callout | details | embed | mathBlock | table | drawio | excalidraw | pdf | subpages | columns | youtube)+";

export const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+ footnotes?" },
  paragraph: {
    group: "block",
    content: "inline*",
    attrs: { id: null, textAlign: null, indent: 0 },
  },
  heading: {
    group: "block",
    content: "inline*",
    attrs: { id: null, level: 1, textAlign: null, indent: 0 },
  },
  blockquote: { group: "block", content: "block+" },
  bulletList: { group: "block list", content: "listItem+" },
  orderedList: { group: "block list", content: "listItem+", attrs: { start: 1, type: null } },
  listItem: { content: "paragraph block*" },
  taskList: { group: "block list", content: "taskItem+" },
  taskItem: { content: "paragraph block*", attrs: { checked: false } },
  codeBlock: {
    group: "block",
    content: "text*",
    marks: "",
    code: true,
    isolating: true,
    attrs: { language: null },
  },
  horizontalRule: { group: "block", selectable: true },
  pageBreak: { group: "block", selectable: true },
  hardBreak: { group: "inline", inline: true },
  text: { group: "inline" },

  image: {
    ...media,
    attrs: {
      src: "",
      width: null,
      height: null,
      align: "center",
      alt: null,
      attachmentId: null,
      size: null,
      aspectRatio: null,
    },
  },
  video: {
    ...media,
    attrs: {
      src: "",
      alt: null,
      attachmentId: null,
      width: null,
      height: null,
      size: null,
      align: "center",
      aspectRatio: null,
    },
  },
  audio: { ...media, attrs: { src: "", attachmentId: null, size: null } },
  attachment: {
    ...media,
    attrs: { url: "", name: null, mime: null, size: null, attachmentId: null },
  },
  pdf: {
    ...media,
    attrs: { src: "", name: null, attachmentId: null, size: null, width: 800, height: 600 },
  },
  drawio: {
    ...media,
    attrs: {
      src: "",
      title: null,
      alt: null,
      width: null,
      height: null,
      size: null,
      aspectRatio: null,
      align: "center",
      attachmentId: null,
    },
  },
  excalidraw: {
    ...media,
    attrs: {
      src: "",
      title: null,
      alt: null,
      width: null,
      height: null,
      size: null,
      aspectRatio: null,
      align: "center",
      attachmentId: null,
    },
  },

  table: { group: "block", content: "tableRow+", isolating: true },
  tableRow: { content: "(tableCell | tableHeader)*" },
  tableCell: {
    content: CELL_CONTENT,
    isolating: true,
    attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null, backgroundColorName: null },
  },
  tableHeader: {
    content: CELL_CONTENT,
    isolating: true,
    attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null, backgroundColorName: null },
  },

  callout: { group: "block", content: "block+", isolating: true, attrs: { type: "info", icon: null } },
  details: {
    group: "block",
    content: "detailsSummary detailsContent",
    isolating: true,
    attrs: { open: false },
  },
  detailsSummary: { content: "inline*", isolating: true },
  detailsContent: { content: "block*" },
  columns: {
    group: "block",
    content: "column+",
    isolating: true,
    attrs: { layout: "two_equal", widthMode: "normal" },
  },
  column: { content: "block+", isolating: true, attrs: { width: null } },
  transclusionSource: { group: "block", content: SYNCED_CONTENT, isolating: true, attrs: { id: null } },
  transclusionReference: {
    group: "block",
    selectable: true,
    attrs: { sourcePageId: null, transclusionId: null },
  },
  footnotes: { content: "footnote*", isolating: true, attrs: { class: "footnotes" } },
  footnote: { content: "paragraph+", isolating: true, attrs: { id: null, "data-id": null } },

  mathInline: { group: "inline", inline: true, attrs: { text: "" } },
  mathBlock: { group: "block", selectable: true, attrs: { text: "" } },
  mention: {
    group: "inline",
    inline: true,
    attrs: {
      id: null,
      label: null,
      entityType: null,
      entityId: null,
      slugId: null,
      creatorId: null,
      anchorId: null,
    },
  },
  status: { group: "inline", inline: true, attrs: { text: "", color: "gray" } },
  footnoteReference: {
    group: "inline",
    inline: true,
    attrs: { class: "footnote-ref", "data-id": null, referenceNumber: null, href: null },
  },

  embed: {
    ...media,
    attrs: { src: "", provider: "", align: "center", width: 800, height: 600 },
  },
  youtube: { ...media, attrs: { src: null, start: 0, width: 640, height: 480 } },
  subpages: { group: "block", selectable: true },
  base: { group: "block", selectable: true, attrs: { pageId: null } },
};

export const marks: Record<string, MarkSpec> = {
  link: {
    inclusive: false,
    attrs: { href: null, target: "_blank", rel: "noopener noreferrer nofollow", class: null, internal: false },
  },
  bold: {},
  italic: {},
  underline: {},
  strike: {},
  code: { inclusive: false },
  highlight: { attrs: { color: null, colorName: null } },
  textStyle: { attrs: { color: null } },
  subscript: {},
  superscript: {},
  comment: { inclusive: false, stackable: true, attrs: { commentId: null, resolved: false } },
};

export const schema = new Schema(nodes, marks);

export const emptyDoc = () => ({
  type: "doc",
  content: [{ type: "paragraph", attrs: { id: null, textAlign: null, indent: 0 } }],
});
