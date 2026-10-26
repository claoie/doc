import type { Mark, Node } from "common/editor/model";
import type { Schema } from "common/editor/schema";
import { nodeSize } from "common/editor/tokens";

/**
 * A view descriptor mirrors one document node and the DOM rendered for it.
 * The tree of descriptors is how the view converts between DOM points and
 * document positions, and how it reuses DOM across updates.
 */
export interface NodeView {
  dom: HTMLElement;
  /** Where child content renders; absent for leaf node views. */
  contentDOM?: HTMLElement;
  /** Returns true when it updated itself for the new node; false to be re-created. */
  update?: (node: Node) => boolean;
  selectNode?: () => void;
  deselectNode?: () => void;
  destroy?: () => void;
  /** Events inside the node view that the editor must not handle. */
  stopEvent?: (event: Event) => boolean;
  /** DOM mutations inside the node view that are not content edits. */
  ignoreMutation?: (mutation: MutationRecord) => boolean;
}

export class Desc {
  node: Node;
  dom: globalThis.Node;
  contentDOM: HTMLElement | null;
  textDOM: Text | null;
  children: Desc[] = [];
  parent: Desc | null;
  view: NodeView | null;

  constructor(
    node: Node,
    dom: globalThis.Node,
    contentDOM: HTMLElement | null,
    textDOM: Text | null,
    parent: Desc | null,
    view: NodeView | null,
  ) {
    this.node = node;
    this.dom = dom;
    this.contentDOM = contentDOM;
    this.textDOM = textDOM;
    this.parent = parent;
    this.view = view;
  }

  get isText() {
    return this.textDOM !== null;
  }

  size(schema: Schema) {
    return nodeSize(this.node, schema);
  }

  destroy() {
    for (const child of this.children) child.destroy();
    this.view?.destroy?.();
  }
}

export type NodeViewFactory = (
  node: Node,
  getPos: () => number,
  helpers: { schema: Schema; dispatchAttrs: (attrs: Record<string, unknown>) => void },
) => NodeView;

export interface RenderSpec {
  dom: HTMLElement;
  contentDOM?: HTMLElement;
}

export type NodeRenderer = (node: Node) => RenderSpec;
export type MarkRenderer = (mark: Mark) => RenderSpec;
