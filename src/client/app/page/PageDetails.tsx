import { useEffect, useState, type RefObject } from "react";
import type { Page, TreeItemWithSpace } from "common/api-types";
import { contentSize, textBetween } from "common/editor/tokens";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Avatar, IconButton, Spinner, formatDateTime } from "../components/ui";
import { Link, pageUrl } from "../router";
import type { PageEditorHandle } from "./PageEditor";

const LinkList = ({ title, load }: { title: string; load: () => Promise<TreeItemWithSpace[]> }) => {
  const [items, setItems] = useState<TreeItemWithSpace[] | null>(null);
  const [limit, setLimit] = useState(10);
  useEffect(() => {
    load()
      .then(setItems)
      .catch(() => setItems([]));
  }, [load]);
  return (
    <section className="details-section">
      <h3>
        {title} {items && <span className="muted">{items.length}</span>}
      </h3>
      {!items && <Spinner size={14} />}
      {items?.length === 0 && <div className="muted small">None</div>}
      {items?.slice(0, limit).map((p) => (
        <Link key={p.id} to={pageUrl(p.space.slug, p)} className="details-link">
          {p.icon || <Icon name={p.isBase ? "table" : "page"} size={14} />}
          <span className="ellipsis">{p.title || "Untitled"}</span>
        </Link>
      ))}
      {items && items.length > limit && (
        <button type="button" className="link-button small" onClick={() => setLimit((l) => l + 20)}>
          Load more
        </button>
      )}
    </section>
  );
};

export const PageDetails = ({ page, editor, onClose }: { page: Page; editor: RefObject<PageEditorHandle | null>; onClose: () => void }) => {
  const [stats, setStats] = useState({ words: 0, chars: 0 });
  useEffect(() => {
    const read = () => {
      const ed = editor.current?.editor();
      if (!ed) return;
      const text = textBetween(ed.state.doc, 0, contentSize(ed.state.doc, ed.state.schema), ed.state.schema, " ");
      setStats({ words: (text.match(/[\p{L}\p{N}]+/gu) ?? []).length, chars: text.replace(/\s/g, "").length });
    };
    read();
    return editor.current?.subscribe(read);
  }, [editor]);
  const [incoming] = useState(() => () => api.backlinks(page.id));
  const [outgoing] = useState(() => () => api.outgoingLinks(page.id));
  return (
    <aside className="side-panel details-panel" aria-label="Page details">
      <div className="side-panel-head">
        <h2>Details</h2>
        <IconButton icon="x" label="Close" onClick={onClose} />
      </div>
      <div className="side-panel-body">
        <section className="details-section">
          <div className="details-row">
            <span className="muted">Created by</span>
            <span className="details-person">
              {page.creator ? <Avatar name={page.creator.name} url={page.creator.avatarUrl} size={18} /> : null}
              {page.creator?.name ?? "Unknown"}
            </span>
          </div>
          <div className="details-row">
            <span className="muted">Last updated by</span>
            <span className="details-person">
              {page.lastEditor ? <Avatar name={page.lastEditor.name} url={page.lastEditor.avatarUrl} size={18} /> : null}
              {page.lastEditor?.name ?? "Unknown"}
            </span>
          </div>
        </section>
        <section className="details-section">
          <h3>Stats</h3>
          <div className="details-row">
            <span className="muted">Words</span>
            <span>{stats.words.toLocaleString()}</span>
          </div>
          <div className="details-row">
            <span className="muted">Characters</span>
            <span>{stats.chars.toLocaleString()}</span>
          </div>
          <div className="details-row">
            <span className="muted">Created</span>
            <span>{formatDateTime(page.createdAt)}</span>
          </div>
          <div className="details-row">
            <span className="muted">Last updated</span>
            <span>{formatDateTime(page.updatedAt)}</span>
          </div>
        </section>
        <LinkList title="Incoming links" load={incoming} />
        <LinkList title="Outgoing links" load={outgoing} />
      </div>
    </aside>
  );
};
