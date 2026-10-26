import { sanitizeNode } from "common/editor/sanitize";
import type { Mark, Node } from "common/editor/model";
import { MAX_DOC_SIZE } from "common/editor/collab";
import { marks as markSpecs, nodes as nodeSpecs, schema } from "common/editor/doc-schema";
import { badRequest } from "./http";

const MAX_DEPTH = 100;
const MAX_NODES = 200_000;


/** Structural check of an editor document from an untrusted client. */
export const validateDoc = (value: unknown, field = "content", rootType = "doc"): Node => {
  let count = 0;
  let positions = 0;
  const check = (node: unknown, depth: number): void => {
    if (++count > MAX_NODES) throw badRequest(`${field} is too large`);
    if (depth > MAX_DEPTH) throw badRequest(`${field} is nested too deeply`);
    if (!node || typeof node !== "object" || Array.isArray(node)) throw badRequest(`${field} has an invalid node`);
    const n = node as Record<string, unknown>;
    if (typeof n.type !== "string" || !(n.type in nodeSpecs)) throw badRequest(`${field} has an unknown node type`);
    if (n.attrs !== undefined && (!n.attrs || typeof n.attrs !== "object" || Array.isArray(n.attrs))) {
      throw badRequest(`${field} has invalid attributes`);
    }
    if (n.text !== undefined && typeof n.text !== "string") throw badRequest(`${field} has invalid text`);
    // Counted like the editor's positions: the root adds none, leaves one, other nodes two.
    if (depth > 0) positions += n.type === "text" ? (typeof n.text === "string" ? n.text.length : 0) : schema.isLeaf(n.type) ? 1 : 2;
    if (positions > MAX_DOC_SIZE) throw badRequest(`${field} is too large`);
    if (n.marks !== undefined) {
      if (!Array.isArray(n.marks)) throw badRequest(`${field} has invalid marks`);
      for (const mark of n.marks as unknown[]) {
        const m = mark as Record<string, unknown> | null;
        if (!m || typeof m !== "object" || typeof m.type !== "string" || !(m.type in markSpecs)) {
          throw badRequest(`${field} has an unknown mark`);
        }
      }
    }
    if (n.content !== undefined) {
      if (!Array.isArray(n.content)) throw badRequest(`${field} has invalid content`);
      for (const child of n.content) check(child, depth + 1);
    }
  };
  check(value, 0);
  if ((value as Node).type !== rootType) throw badRequest(`${field} must be a ${rootType} node`);
  return sanitizeNode(value as Node);
};

/** Returns a copy of the tree with `fn` applied to every node (children first). */
export const mapDoc = (node: Node, fn: (node: Node) => Node): Node => {
  const content = node.content?.map((child) => mapDoc(child, fn));
  return fn(content ? { ...node, content } : node);
};

export const walkDoc = (node: Node, visit: (node: Node) => void) => {
  visit(node);
  for (const child of node.content ?? []) walkDoc(child, visit);
};

export const stripCommentMarks = (doc: Node): Node =>
  mapDoc(doc, (node) => {
    if (!node.marks?.some((m) => m.type === "comment")) return node;
    const marks = node.marks.filter((m) => m.type !== "comment");
    const { marks: _, ...rest } = node;
    return marks.length ? { ...rest, marks } : rest;
  });

const FILE_URL_RE = /^\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/[^?#]*)?([?#].*)?$/i;

export const parseFileUrl = (url: unknown): { fileId: string; rest: string; suffix: string } | null => {
  if (typeof url !== "string") return null;
  const match = FILE_URL_RE.exec(url);
  return match ? { fileId: match[1]!.toLowerCase(), rest: match[2] ?? "", suffix: match[3] ?? "" } : null;
};

const URL_ATTRS = ["src", "url"] as const;

/** Ids of uploaded files referenced by a document (attachment ids and `/api/files/...` URLs). */
export const fileIdsInDoc = (doc: Node): Set<string> => {
  const ids = new Set<string>();
  walkDoc(doc, (node) => {
    const a = node.attrs;
    if (!a) return;
    if (typeof a.attachmentId === "string" && a.attachmentId) ids.add(a.attachmentId.toLowerCase());
    for (const key of URL_ATTRS) {
      const parsed = parseFileUrl(a[key]);
      if (parsed) ids.add(parsed.fileId);
    }
  });
  return ids;
};

/**
 * Rewrites file references: `url(parsed)` returns the new URL for a
 * `/api/files/...` attribute (or null to keep it) and `ids` maps attachment ids.
 */
export const rewriteFileRefs = (
  doc: Node,
  url: (parsed: { fileId: string; rest: string; suffix: string }, original: string) => string | null,
  ids?: ReadonlyMap<string, string>,
): Node =>
  mapDoc(doc, (node) => {
    const a = node.attrs;
    if (!a) return node;
    let attrs: Record<string, unknown> | null = null;
    for (const key of URL_ATTRS) {
      const original = a[key];
      const parsed = parseFileUrl(original);
      if (!parsed) continue;
      const next = url(parsed, original as string);
      if (next !== null && next !== original) (attrs ??= { ...a })[key] = next;
    }
    if (ids && typeof a.attachmentId === "string") {
      const mapped = ids.get(a.attachmentId.toLowerCase());
      if (mapped) (attrs ??= { ...a }).attachmentId = mapped;
    }
    return attrs ? { ...node, attrs } : node;
  });

/** Rewrites link mark hrefs with `fn` (return null to keep the href). */
export const rewriteLinks = (doc: Node, fn: (href: string) => string | null): Node =>
  mapDoc(doc, (node) => {
    if (!node.marks?.some((m) => m.type === "link")) return node;
    let changed = false;
    const marks = node.marks.map((mark): Mark => {
      if (mark.type !== "link" || typeof mark.attrs?.href !== "string") return mark;
      const next = fn(mark.attrs.href);
      if (next === null || next === mark.attrs.href) return mark;
      changed = true;
      return { ...mark, attrs: { ...mark.attrs, href: next } };
    });
    return changed ? { ...node, marks } : node;
  });

/** Public-share view of a document: no comment marks, file URLs authorized by the share key. */
export const publicDoc = (doc: Node | null, shareKey: string): Node | null => {
  if (!doc) return doc;
  return rewriteFileRefs(stripCommentMarks(doc), (parsed) => {
    const hashIndex = parsed.suffix.indexOf("#");
    const query = hashIndex >= 0 ? parsed.suffix.slice(0, hashIndex) : parsed.suffix;
    const hash = hashIndex >= 0 ? parsed.suffix.slice(hashIndex) : "";
    return `/api/files/${parsed.fileId}${parsed.rest}${query ? `${query}&` : "?"}share=${shareKey}${hash}`;
  });
};

/** Every `transclusionSource` block of a document: its id and its content. */
export const syncedBlocksOf = (doc: Node): { blockId: string; content: Node[] }[] => {
  const blocks = new Map<string, Node[]>();
  walkDoc(doc, (node) => {
    if (node.type !== "transclusionSource") return;
    const id = node.attrs?.id;
    if (typeof id === "string" && id && id.length <= 100) blocks.set(id, node.content ?? []);
  });
  return [...blocks].map(([blockId, content]) => ({ blockId, content }));
};
