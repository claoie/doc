import type { Node } from "common/editor/model";

/** Rebuilds a document bottom-up, letting `fn` replace any node (async). */
export const mapNodes = async (node: Node, fn: (node: Node) => Promise<Node>): Promise<Node> => {
  const content = node.content ? await Promise.all(node.content.map((c) => mapNodes(c, fn))) : undefined;
  return fn(content ? { ...node, content } : node);
};
