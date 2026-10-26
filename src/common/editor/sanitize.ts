import type { Attrs, Mark, Node } from "./model";
import type { Step } from "./steps";
import type { SliceItem } from "./tokens";

const URL_ATTRS = new Set(["src", "url", "href"]);
const ALLOWED_SCHEME = /^(https?|mailto|tel):/i;

/**
 * A URL that is safe to put in `href`/`src`: relative, fragment, http(s),
 * mailto or tel, and `data:image/` when `allowDataImage`. Anything else
 * (javascript:, data:text/html, vbscript:, ...) becomes "".
 */
export const cleanUrl = (value: unknown, allowDataImage = false): string => {
  if (typeof value !== "string") return "";
  const s = value.trim();
  if (!s) return "";
  // Browsers ignore control characters and whitespace inside the scheme.
  const compact = s.replace(/[\s\u0000-\u001f\u007f]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  if (!scheme) return s;
  if (ALLOWED_SCHEME.test(compact)) return s;
  if (allowDataImage && /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml);/i.test(compact)) return s;
  return "";
};

const cleanAttrs = (attrs: Attrs | undefined, allowDataImage: boolean): Attrs | undefined => {
  if (!attrs) return attrs;
  let out: Attrs | undefined;
  for (const key of Object.keys(attrs)) {
    if (!URL_ATTRS.has(key)) continue;
    const value = attrs[key];
    if (value === null || value === undefined) continue;
    const clean = cleanUrl(value, allowDataImage);
    if (clean !== value) {
      out ??= { ...attrs };
      out[key] = clean;
    }
  }
  return out ?? attrs;
};

const cleanMarks = (marks: Mark[] | undefined): Mark[] | undefined => {
  if (!marks?.length) return marks;
  let changed = false;
  const out = marks.map((mark) => {
    const attrs = cleanAttrs(mark.attrs, false);
    if (attrs === mark.attrs) return mark;
    changed = true;
    return { ...mark, attrs };
  });
  return changed ? out : marks;
};

/** Images may come from `data:` URLs; nothing else may. */
const allowsDataImage = (type: string) => type === "image" || type === "drawio" || type === "excalidraw";

/** Returns the node with every URL attribute (node or mark) made safe. */
export const sanitizeNode = (node: Node): Node => {
  const attrs = cleanAttrs(node.attrs, allowsDataImage(node.type));
  const marks = cleanMarks(node.marks);
  const content = node.content?.map(sanitizeNode);
  const contentChanged = !!content && content.some((child, i) => child !== node.content![i]);
  if (attrs === node.attrs && marks === node.marks && !contentChanged) return node;
  return { ...node, ...(attrs ? { attrs } : {}), ...(marks ? { marks } : {}), ...(content ? { content } : {}) };
};

const sanitizeItem = (item: SliceItem): SliceItem => {
  if ("n" in item) return { n: sanitizeNode(item.n) };
  if ("o" in item) {
    const a = cleanAttrs(item.a, allowsDataImage(item.o));
    const m = cleanMarks(item.m);
    return a === item.a && m === item.m ? item : { ...item, ...(a ? { a } : {}), ...(m ? { m } : {}) };
  }
  if ("t" in item) {
    const m = cleanMarks(item.m);
    return m === item.m ? item : { ...item, m };
  }
  return item;
};

/**
 * Makes the content a step inserts safe. Attribute steps do not carry the
 * node type, so data-image URLs are not allowed through them.
 */
export const sanitizeStep = (step: Step): Step => {
  switch (step.stepType) {
    case "replace":
    case "replaceAround":
      return { ...step, slice: step.slice.map(sanitizeItem) };
    case "addMark":
    case "removeMark":
      return { ...step, mark: cleanMarks([step.mark])![0]! };
    case "attr":
      return { ...step, attrs: cleanAttrs(step.attrs, false) ?? step.attrs };
  }
};
