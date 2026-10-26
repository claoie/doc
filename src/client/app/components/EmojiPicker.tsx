import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition } from "./ui";

export interface Emoji {
  char: string;
  name: string;
  group: string;
}

let cache: Emoji[] | null = null;

export const loadEmoji = async (): Promise<Emoji[]> => {
  if (cache) return cache;
  const { EMOJI_GROUPS } = await import("../emoji-data");
  cache = EMOJI_GROUPS.flatMap(([group, entries]) =>
    entries.split("|").map((entry) => {
      const space = entry.indexOf(" ");
      return { char: entry.slice(0, space), name: entry.slice(space + 1), group };
    }),
  );
  return cache;
};

const RECENT_EMOJI_STORAGE = "recent-emoji";

export const recentEmoji = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_EMOJI_STORAGE) ?? "[]") as string[];
  } catch {
    return [];
  }
};

export const rememberEmoji = (char: string) => {
  try {
    const list = [char, ...recentEmoji().filter((c) => c !== char)].slice(0, 24);
    localStorage.setItem(RECENT_EMOJI_STORAGE, JSON.stringify(list));
  } catch {
    // storage unavailable
  }
};

export const searchEmoji = (all: Emoji[], query: string, limit = 50) => {
  const q = query.toLowerCase().trim();
  if (!q) return all.slice(0, limit);
  const starts = all.filter((e) => e.name.startsWith(q) || e.name.includes(` ${q}`));
  const contains = all.filter((e) => !starts.includes(e) && e.name.includes(q));
  return [...starts, ...contains].slice(0, limit);
};

export const EmojiPicker = ({
  anchor,
  onSelect,
  onClose,
  onRemove,
}: {
  anchor: HTMLElement;
  onSelect: (char: string) => void;
  onClose: () => void;
  onRemove?: () => void;
}) => {
  const [all, setAll] = useState<Emoji[]>(cache ?? []);
  const [query, setQuery] = useState("");
  const { ref, style } = useAnchoredPosition(anchor, true);
  useEffect(() => {
    void loadEmoji().then(setAll);
  }, []);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node) && !anchor.contains(e.target as globalThis.Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose, ref]);
  const groups = useMemo(() => {
    if (query.trim()) return [["Results", searchEmoji(all, query, 200)] as const];
    const recent = recentEmoji()
      .map((c) => all.find((e) => e.char === c))
      .filter((e): e is Emoji => !!e);
    const byGroup = new Map<string, Emoji[]>();
    for (const e of all) byGroup.set(e.group, [...(byGroup.get(e.group) ?? []), e]);
    return [...(recent.length ? [["Recent", recent] as const] : []), ...[...byGroup.entries()].map(([g, list]) => [g, list] as const)];
  }, [all, query]);
  const pick = (char: string) => {
    rememberEmoji(char);
    onSelect(char);
    onClose();
  };
  return createPortal(
    <div className="emoji-picker" ref={ref} style={style}>
      <div className="emoji-picker-head">
        <input className="input" autoFocus placeholder="Search emoji" value={query} onChange={(e) => setQuery(e.target.value)} />
        {onRemove && (
          <button type="button" className="btn btn-ghost" onClick={() => (onRemove(), onClose())}>
            Remove
          </button>
        )}
      </div>
      <div className="emoji-grid-scroll">
        {groups.map(([name, list]) => (
          <div key={name}>
            <div className="emoji-group-name">{name}</div>
            <div className="emoji-grid">
              {list.map((e) => (
                <button key={e.char + e.name} type="button" title={e.name} onClick={() => pick(e.char)}>
                  {e.char}
                </button>
              ))}
            </div>
          </div>
        ))}
        {!all.length && <div className="muted pad">Loading…</div>}
      </div>
    </div>,
    document.body,
  );
};
