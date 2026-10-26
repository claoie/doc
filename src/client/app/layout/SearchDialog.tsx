import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SearchResult } from "common/api-types";
import { api } from "../api";
import { navigate, pageUrl } from "../router";
import { useApp } from "../store";
import { Icon } from "../components/Icon";
import { Spinner, cx, timeAgo } from "../components/ui";
import { useCurrentSpace } from "./Sidebar";

export const SearchDialog = ({ onClose }: { onClose: () => void }) => {
  const space = useCurrentSpace();
  const { spaces } = useApp();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "space">("all");
  const [titleOnly, setTitleOnly] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .search({ q, spaceId: scope === "space" ? space?.id : undefined, titleOnly, limit: 30 })
        .then((r) => {
          if (seq.current === id) {
            setResults(r);
            setActive(0);
          }
        })
        .catch(() => seq.current === id && setResults([]))
        .finally(() => seq.current === id && setLoading(false));
    }, 160);
    return () => clearTimeout(timer);
  }, [query, scope, titleOnly, space?.id]);

  const open = (r: SearchResult) => {
    onClose();
    navigate(pageUrl(r.space.slug, r));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (!results?.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(results.length - 1, a + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const r = results[active];
        if (r) open(r);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return createPortal(
    <div className="modal-backdrop search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-dialog" role="dialog" aria-label="Search">
        <div className="search-input-row">
          <Icon name="search" size={18} />
          <input autoFocus placeholder="Search pages" value={query} onChange={(e) => setQuery(e.target.value)} />
          {loading && <Spinner size={16} />}
        </div>
        <div className="search-filters">
          <button type="button" className={cx("chip", scope === "all" && "active")} onClick={() => setScope("all")}>
            All spaces
          </button>
          {space && spaces.length > 1 && (
            <button type="button" className={cx("chip", scope === "space" && "active")} onClick={() => setScope("space")}>
              {space.name}
            </button>
          )}
          <button type="button" className={cx("chip", titleOnly && "active")} onClick={() => setTitleOnly((t) => !t)}>
            Titles only
          </button>
        </div>
        <div className="search-results">
          {results?.length === 0 && <div className="search-empty">No pages match “{query.trim()}”.</div>}
          {!results && <div className="search-empty">Type to search titles and content.</div>}
          {results?.map((r, i) => (
            <button key={r.id} type="button" className={cx("search-result", i === active && "active")} onMouseEnter={() => setActive(i)} onClick={() => open(r)}>
              <span className="search-result-icon">{r.icon || <Icon name={r.isBase ? "table" : "page"} size={16} />}</span>
              <span className="search-result-body">
                <span className="search-result-title">{r.title || "Untitled"}</span>
                {r.highlight && (
                  <span className="search-result-snippet">
                    <Highlighted html={r.highlight} />
                  </span>
                )}
                <span className="search-result-meta">
                  {r.space.name} · {timeAgo(r.updatedAt)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
};

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Renders server highlight text (escaped, with `<mark>` tags) without injecting HTML. */
export const Highlighted = ({ html }: { html: string }) => {
  const parts = html.split(/(<mark>|<\/mark>)/);
  let marked = false;
  return (
    <>
      {parts.map((part, i) => {
        if (part === "<mark>") {
          marked = true;
          return null;
        }
        if (part === "</mark>") {
          marked = false;
          return null;
        }
        return marked ? <mark key={i}>{decode(part)}</mark> : <span key={i}>{decode(part)}</span>;
      })}
    </>
  );
};
