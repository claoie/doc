import { useEffect, useState, type RefObject } from "react";
import { IconButton, cx } from "../components/ui";
import type { Heading, PageEditorHandle } from "./PageEditor";

export const TableOfContents = ({ editor, onClose }: { editor: RefObject<PageEditorHandle | null>; onClose: () => void }) => {
  const [headings, setHeadings] = useState<Heading[]>([]);
  useEffect(() => {
    const read = () => setHeadings(editor.current?.headings() ?? []);
    read();
    return editor.current?.subscribe(read);
  }, [editor]);
  const min = Math.min(...headings.map((h) => h.level), 6);
  return (
    <aside className="side-panel toc-panel" aria-label="Table of contents">
      <div className="side-panel-head">
        <h2>On this page</h2>
        <IconButton icon="x" label="Close" onClick={onClose} />
      </div>
      <div className="side-panel-body">
        {!headings.length && <div className="muted pad">Add headings to see an outline here.</div>}
        {headings.map((h, i) => (
          <button key={i} type="button" className={cx("toc-item", `toc-level-${h.level - min}`)} onClick={() => editor.current?.scrollToPos(h.pos)}>
            {h.text || "Untitled heading"}
          </button>
        ))}
      </div>
    </aside>
  );
};
