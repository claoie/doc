import type { Attrs, Mark, Node } from "./model";

export interface NodeSpec {
  /** Content expression, e.g. `"block+"`, `"inline*"`, `"(tableCell | tableHeader)+"`. */
  content?: string;
  /** Space-separated groups this node belongs to, e.g. `"block"`. */
  group?: string;
  inline?: boolean;
  /** Leaf node with no content (size 1). Implied when `content` is empty and the node is not text. */
  atom?: boolean;
  attrs?: Attrs;
  /** Marks allowed on inline children: `"_"` for all (default for textblocks), `""` for none. */
  marks?: string;
  /** Text inside is literal (code): Enter inserts a newline and marks are not allowed. */
  code?: boolean;
  /** Edits like joining and lifting never cross this node's boundary. */
  isolating?: boolean;
  /** Selected and deleted as a whole. */
  selectable?: boolean;
}

export interface MarkSpec {
  attrs?: Attrs;
  /** Marks are exclusive by type unless this is set (e.g. comments can stack). */
  stackable?: boolean;
  /** Typing at the mark's end continues it (default true). */
  inclusive?: boolean;
}

type Matcher = (types: string[]) => boolean;

/**
 * Compiles a content expression into a matcher over a list of child type
 * names, by translating it into a regular expression over the space-joined
 * names.
 */
const compileContent = (expr: string, groups: Map<string, string[]>): Matcher => {
  const tokens = expr.match(/\w+|[()|*+?]/g) ?? [];
  let source = "";
  for (const token of tokens) {
    if (/^\w+$/.test(token)) {
      const members = groups.get(token) ?? [token];
      source += `(?:(?:${members.join("|")}) )`;
    } else {
      source += token;
    }
  }
  const re = new RegExp(`^(?:${source})$`);
  return (types) => re.test(types.map((t) => t + " ").join(""));
};

export class Schema {
  readonly nodes: Record<string, NodeSpec>;
  readonly marks: Record<string, MarkSpec>;
  private matchers = new Map<string, Matcher>();
  private groups = new Map<string, string[]>();

  constructor(nodes: Record<string, NodeSpec>, marks: Record<string, MarkSpec>) {
    this.nodes = nodes;
    this.marks = marks;
    for (const [name, spec] of Object.entries(nodes)) {
      for (const group of (spec.group ?? "").split(" ").filter(Boolean)) {
        const members = this.groups.get(group) ?? [];
        members.push(name);
        this.groups.set(group, members);
      }
    }
    for (const [name, spec] of Object.entries(nodes)) {
      if (spec.content) this.matchers.set(name, compileContent(spec.content, this.groups));
    }
  }

  spec(type: string): NodeSpec {
    const spec = this.nodes[type];
    if (!spec) throw new Error(`Unknown node type: ${type}`);
    return spec;
  }

  isKnown(type: string) {
    return type in this.nodes;
  }

  isLeaf(type: string) {
    return type !== "text" && !this.nodes[type]?.content;
  }

  isInline(type: string) {
    return type === "text" || !!this.nodes[type]?.inline;
  }

  isTextblock(type: string) {
    const spec = this.nodes[type];
    if (!spec?.content) return false;
    return /\b(inline|text)\b/.test(spec.content);
  }

  isBlock(type: string) {
    return !this.isInline(type);
  }

  inGroup(type: string, group: string) {
    return (this.groups.get(group) ?? []).includes(type);
  }

  groupMembers(group: string) {
    return this.groups.get(group) ?? [];
  }

  allowsMark(parentType: string, markType: string) {
    const spec = this.nodes[parentType];
    if (!spec) return false;
    if (spec.code) return false;
    if (spec.marks === undefined && !this.isTextblock(parentType)) return false;
    const marks = spec.marks ?? "_";
    if (marks === "_") return true;
    return marks.split(" ").includes(markType);
  }

  validContent(type: string, children: readonly Node[]) {
    const matcher = this.matchers.get(type);
    if (!matcher) return children.length === 0;
    return matcher(children.map((c) => c.type));
  }

  /** Default attrs merged with the given ones; unknown attrs are kept so foreign data survives. */
  attrs(type: string, attrs?: Attrs): Attrs | undefined {
    const defaults = this.nodes[type]?.attrs;
    if (!defaults && !attrs) return undefined;
    return { ...defaults, ...attrs };
  }

  markAttrs(type: string, attrs?: Attrs): Attrs | undefined {
    const defaults = this.marks[type]?.attrs;
    if (!defaults && !attrs) return undefined;
    return { ...defaults, ...attrs };
  }

  mark(type: string, attrs?: Attrs): Mark {
    const merged = this.markAttrs(type, attrs);
    return merged ? { type, attrs: merged } : { type };
  }

  node(type: string, attrs?: Attrs, content?: Node[], marks?: Mark[]): Node {
    const node: Node = { type };
    const merged = this.attrs(type, attrs);
    if (merged) node.attrs = merged;
    if (!this.isLeaf(type)) node.content = content ?? [];
    if (marks?.length) node.marks = marks;
    return node;
  }

  text(text: string, marks?: Mark[]): Node {
    return marks?.length ? { type: "text", text, marks } : { type: "text", text };
  }

  /**
   * Checks a whole subtree. Returns the path of the first invalid node, or
   * null when valid.
   */
  check(node: Node, path: number[] = []): number[] | null {
    if (node.type === "text") return node.text ? null : path;
    if (!this.isKnown(node.type)) return path;
    const children = node.content ?? [];
    if (!this.validContent(node.type, children)) return path;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      for (const mark of child.marks ?? []) {
        if (!this.marks[mark.type] || !this.allowsMark(node.type, mark.type)) return [...path, i];
      }
      const bad = this.check(child, [...path, i]);
      if (bad) return bad;
    }
    return null;
  }
}
