import type { Node } from "common/editor/model";

export type DiffPart = { kind: "same" | "added" | "removed"; text: string };

/** Plain text of each top-level block (and list items), for comparing versions. */
export const blockTexts = (doc: Node | null): string[] => {
  const out: string[] = [];
  const text = (n: Node): string =>
    n.type === "text" ? (n.text ?? "") : n.type === "hardBreak" ? "\n" : String(n.attrs?.text ?? n.attrs?.label ?? "") + (n.content ?? []).map(text).join("");
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (["bulletList", "orderedList", "taskList", "blockquote", "callout", "columns", "column", "details", "detailsContent", "table", "tableRow", "transclusionSource"].includes(n.type)) {
        walk(n.content ?? []);
      } else {
        const t = text(n).trim();
        if (t) out.push(t);
      }
    }
  };
  walk(doc?.content ?? []);
  return out;
};

/** Longest-common-subsequence diff of two token lists. */
const lcsDiff = <T,>(a: T[], b: T[], eq: (x: T, y: T) => boolean): { kind: DiffPart["kind"]; item: T }[] => {
  const n = a.length;
  const m = b.length;
  // Guard against quadratic blow-up on huge documents.
  if (n * m > 4_000_000) {
    return [...a.map((item) => ({ kind: "removed" as const, item })), ...b.map((item) => ({ kind: "added" as const, item }))];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = eq(a[i]!, b[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: { kind: DiffPart["kind"]; item: T }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i]!, b[j]!)) {
      out.push({ kind: "same", item: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "removed", item: a[i++]! });
    } else {
      out.push({ kind: "added", item: b[j++]! });
    }
  }
  while (i < n) out.push({ kind: "removed", item: a[i++]! });
  while (j < m) out.push({ kind: "added", item: b[j++]! });
  return out;
};

const words = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];

const merge = (parts: DiffPart[]): DiffPart[] => {
  const out: DiffPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.kind === p.kind) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
};

/**
 * Block-level diff where changed blocks are diffed word by word. Each entry
 * is one block's parts.
 */
export const diffDocs = (older: Node | null, newer: Node | null): DiffPart[][] => {
  const a = blockTexts(older);
  const b = blockTexts(newer);
  const blocks = lcsDiff(a, b, (x, y) => x === y);
  const result: DiffPart[][] = [];
  for (let k = 0; k < blocks.length; k++) {
    const cur = blocks[k]!;
    const next = blocks[k + 1];
    // A removed block followed by an added one is a modification: diff its words.
    if (cur.kind === "removed" && next?.kind === "added") {
      const parts = lcsDiff(words(cur.item), words(next.item), (x, y) => x === y).map((p) => ({ kind: p.kind, text: p.item }));
      result.push(merge(parts));
      k++;
      continue;
    }
    result.push([{ kind: cur.kind, text: cur.item }]);
  }
  return result;
};
