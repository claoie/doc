import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "../../../editor/editor";
import type { PresenceUser } from "../../realtime";
import { contentSize } from "common/editor/tokens";

interface Drawn {
  key: string;
  name: string;
  color: string;
  caret: { left: number; top: number; height: number } | null;
  boxes: { left: number; top: number; width: number; height: number }[];
}

/** Draws other people's carets and selections over the editor. */
export const RemoteCarets = ({ editor, users, selfId, color }: { editor: Editor; users: PresenceUser[]; selfId: string; color: (id: string) => string }) => {
  const [drawn, setDrawn] = useState<Drawn[]>([]);
  void selfId;

  useEffect(() => {
    const draw = () => {
      const size = contentSize(editor.state.doc, editor.state.schema);
      const clamp = (n: number) => Math.max(0, Math.min(size, n));
      const out: Drawn[] = [];
      for (const u of users) {
        if (!u.selection) continue;
        const c = u.color || color(u.userId);
        const head = clamp(u.selection.head);
        const anchor = clamp(u.selection.anchor);
        const rect = editor.view.coordsAtPos(head);
        const caret = rect ? { left: rect.left + window.scrollX, top: rect.top + window.scrollY, height: rect.height || 18 } : null;
        const boxes: Drawn["boxes"] = [];
        if (anchor !== head) {
          const a = editor.view.domFromPos(Math.min(anchor, head));
          const b = editor.view.domFromPos(Math.max(anchor, head));
          const range = document.createRange();
          try {
            range.setStart(a.node, a.offset);
            range.setEnd(b.node, b.offset);
            for (const r of Array.from(range.getClientRects())) {
              if (r.width < 1) continue;
              boxes.push({ left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, height: r.height });
            }
          } catch {
            // positions may briefly be out of range while a change lands
          }
        }
        out.push({ key: u.clientId, name: u.name, color: c, caret, boxes });
      }
      setDrawn(out);
    };
    draw();
    const off = editor.onUpdate(draw);
    window.addEventListener("resize", draw);
    window.addEventListener("scroll", draw, true);
    return () => {
      off();
      window.removeEventListener("resize", draw);
      window.removeEventListener("scroll", draw, true);
    };
  }, [editor, users, color]);

  return createPortal(
    <>
      {drawn.map((d) => (
        <div key={d.key}>
          {d.boxes.map((b, i) => (
            <div key={i} className="remote-selection" style={{ ...b, background: d.color }} />
          ))}
          {d.caret && (
            <div className="remote-caret" style={{ left: d.caret.left, top: d.caret.top, height: d.caret.height, background: d.color }}>
              <span className="remote-caret-label" style={{ background: d.color }}>
                {d.name}
              </span>
            </div>
          )}
        </div>
      ))}
    </>,
    document.body,
  );
};
