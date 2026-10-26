import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { schema } from "common/editor/doc-schema";
import { descendants, nodeSize } from "common/editor/tokens";
import { Transaction } from "common/editor/state";
import type { Editor } from "../../../editor/editor";
import { Icon } from "../../components/Icon";
import { cx } from "../../components/ui";

interface Match {
  from: number;
  to: number;
}

const HIGHLIGHT = "find-match";
const CURRENT = "find-current";

type HighlightRegistry = Map<string, unknown>;
const registry = (): HighlightRegistry | null => (CSS as unknown as { highlights?: HighlightRegistry }).highlights ?? null;
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

const findMatches = (editor: Editor, query: string, caseSensitive: boolean): Match[] => {
  if (!query) return [];
  const matches: Match[] = [];
  const needle = caseSensitive ? query : query.toLowerCase();
  descendants(editor.state.doc, schema, (node, pos) => {
    if (!schema.isTextblock(node.type)) return true;
    // Concatenate the block's text runs, keeping a map back to positions.
    let text = "";
    const offsets: number[] = [];
    let p = pos + 1;
    for (const child of node.content ?? []) {
      if (child.type === "text") {
        for (let i = 0; i < child.text!.length; i++) {
          text += child.text![i];
          offsets.push(p + i);
        }
      } else {
        text += "￼";
        offsets.push(p);
      }
      p += nodeSize(child, schema);
    }
    const hay = caseSensitive ? text : text.toLowerCase();
    let idx = hay.indexOf(needle);
    while (idx >= 0) {
      matches.push({ from: offsets[idx]!, to: offsets[idx + needle.length - 1]! + 1 });
      idx = hay.indexOf(needle, idx + Math.max(1, needle.length));
    }
    return false;
  });
  return matches;
};

export const FindReplace = ({ editor, onClose }: { editor: Editor; onClose: () => void }) => {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [current, setCurrent] = useState(0);
  const [version, setVersion] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => editor.onUpdate((tr) => tr?.docChanged && setVersion((v) => v + 1)), [editor]);

  const matches = useMemo(() => findMatches(editor, query, caseSensitive), [editor, query, caseSensitive, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const index = matches.length ? Math.min(current, matches.length - 1) : -1;

  useEffect(() => {
    const reg = registry();
    if (!reg || !HighlightCtor) return;
    const toRange = (m: Match) => {
      const a = editor.view.domFromPos(m.from);
      const b = editor.view.domFromPos(m.to);
      const r = document.createRange();
      try {
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, b.offset);
      } catch {
        return null;
      }
      return r;
    };
    const ranges = matches.map(toRange).filter((r): r is Range => !!r);
    reg.set(HIGHLIGHT, new HighlightCtor(...ranges));
    const cur = index >= 0 ? toRange(matches[index]!) : null;
    if (cur) {
      reg.set(CURRENT, new HighlightCtor(cur));
      const rect = cur.getBoundingClientRect();
      if (rect.top < 80 || rect.bottom > window.innerHeight - 80) window.scrollBy({ top: rect.top - window.innerHeight / 3, behavior: "smooth" });
    } else reg.delete(CURRENT);
    return () => {
      reg.delete(HIGHLIGHT);
      reg.delete(CURRENT);
    };
  }, [matches, index, editor]);

  const move = (delta: number) => matches.length && setCurrent((c) => (Math.min(c, matches.length - 1) + delta + matches.length) % matches.length);

  const replaceOne = () => {
    const m = matches[index];
    if (!m || !editor.editable) return;
    const tr = new Transaction(editor.state);
    tr.insertText(replacement, m.from, m.to);
    editor.dispatch(tr);
  };

  const replaceAll = () => {
    if (!matches.length || !editor.editable) return;
    const tr = new Transaction(editor.state);
    for (const m of [...matches].reverse()) tr.insertText(replacement, m.from, m.to);
    editor.dispatch(tr);
  };

  return createPortal(
    <div className="find-panel" role="search">
      <div className="find-row">
        <input
          ref={inputRef}
          className="input"
          autoFocus
          placeholder="Find"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCurrent(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              move(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") onClose();
          }}
        />
        <span className="find-count">{query ? `${matches.length ? index + 1 : 0}/${matches.length}` : ""}</span>
        <button type="button" className={cx("tool", caseSensitive && "active")} title="Match case" onClick={() => setCaseSensitive((c) => !c)}>
          Aa
        </button>
        <button type="button" className="tool" title="Previous" onClick={() => move(-1)}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <button type="button" className="tool" title="Next" onClick={() => move(1)}>
          <Icon name="chevronRight" size={16} />
        </button>
        <button type="button" className="tool" title="Close" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      {editor.editable && (
        <div className="find-row">
          <input className="input" placeholder="Replace with" value={replacement} onChange={(e) => setReplacement(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} />
          <button type="button" className="btn" onClick={replaceOne} disabled={!matches.length}>
            Replace
          </button>
          <button type="button" className="btn" onClick={replaceAll} disabled={!matches.length}>
            All
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
};
