import type { Node } from "./editor/model";
import { nodes as nodeSpecs } from "./editor/doc-schema";

const isInline = (node: Node) => node.type === "text" || !!nodeSpecs[node.type]?.inline;

const inlineText = (node: Node): string => {
  const a = node.attrs ?? {};
  switch (node.type) {
    case "text":
      return node.text ?? "";
    case "hardBreak":
      return "\n";
    case "mention":
      return String(a.label ?? "");
    case "mathInline":
    case "status":
      return String(a.text ?? "");
    default:
      return (node.content ?? []).map(inlineText).join("");
  }
};

const collectLines = (node: Node, lines: string[]) => {
  const a = node.attrs ?? {};
  const children = node.content ?? [];
  if (node.type === "mathBlock") {
    if (a.text) lines.push(String(a.text));
    return;
  }
  if (node.type === "attachment" || node.type === "pdf") {
    if (a.name) lines.push(String(a.name));
    return;
  }
  if (node.type === "codeBlock" || (children.length > 0 && children.every(isInline))) {
    const line = children.map(inlineText).join("");
    if (line.trim()) lines.push(line);
    return;
  }
  for (const child of children) collectLines(child, lines);
};

/** Plain text of a document, one line per text block, for search and previews. */
export const docText = (doc: Node | null | undefined): string => {
  if (!doc) return "";
  const lines: string[] = [];
  collectLines(doc, lines);
  return lines.join("\n");
};

const walk = (node: Node, visit: (node: Node) => void) => {
  visit(node);
  for (const child of node.content ?? []) walk(child, visit);
};

const PAGE_PATH_RE = /^(?:https?:\/\/[^/?#]+)?(?:\/s\/[^/?#]+\/p\/([^/?#]+)|\/p\/([^/?#]+))\/?(?:[?#].*)?$/;

/** The slugId of an internal page URL (`/s/:space/p/:title-:slugId` or `/p/:slugId`), if it is one. */
export const pageSlugIdFromHref = (href: unknown): string | null => {
  if (typeof href !== "string") return null;
  const match = PAGE_PATH_RE.exec(href.trim());
  if (!match) return null;
  let segment = match[1] ?? match[2] ?? "";
  try {
    segment = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const slugId = segment.slice(segment.lastIndexOf("-") + 1);
  return /^[0-9A-Za-z]{1,32}$/.test(slugId) ? slugId : null;
};

/** URL segment for a page title: lower-case words joined by `-`, at most 60 characters. */
export const titleSlug = (title: string | null | undefined): string =>
  (title || "untitled")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";

/** In-app path of a page: `/s/:spaceSlug/p/:titleSlug-:slugId`. */
export const pagePath = (spaceSlug: string, title: string | null | undefined, slugId: string) =>
  `/s/${encodeURIComponent(spaceSlug)}/p/${encodeURIComponent(titleSlug(title))}-${slugId}`;

export interface DocLinks {
  pageIds: string[];
  slugIds: string[];
}

/** Pages a document references through page mentions and internal links. */
export const docLinks = (doc: Node | null | undefined): DocLinks => {
  const pageIds = new Set<string>();
  const slugIds = new Set<string>();
  if (!doc) return { pageIds: [], slugIds: [] };
  walk(doc, (node) => {
    if (node.type === "mention" && node.attrs?.entityType === "page") {
      if (typeof node.attrs.entityId === "string" && node.attrs.entityId) pageIds.add(node.attrs.entityId);
      else if (typeof node.attrs.slugId === "string" && node.attrs.slugId) slugIds.add(node.attrs.slugId);
    }
    for (const mark of node.marks ?? []) {
      if (mark.type !== "link") continue;
      const slugId = pageSlugIdFromHref(mark.attrs?.href);
      if (slugId) slugIds.add(slugId);
    }
  });
  return { pageIds: [...pageIds], slugIds: [...slugIds] };
};

/** Ids of users mentioned in a document. */
export const docMentionedUserIds = (doc: Node | null | undefined): string[] => {
  const ids = new Set<string>();
  if (!doc) return [];
  walk(doc, (node) => {
    if (node.type === "mention" && node.attrs?.entityType === "user" && typeof node.attrs.entityId === "string") {
      ids.add(node.attrs.entityId);
    }
  });
  return [...ids];
};
