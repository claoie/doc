import { useEffect, useState } from "react";
import type { TreeItemWithSpace } from "common/api-types";
import { api } from "../api";
import { Link, pageUrl } from "../router";
import { Icon } from "../components/Icon";

export const Backlinks = ({ pageId }: { pageId: string }) => {
  const [links, setLinks] = useState<TreeItemWithSpace[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    api
      .backlinks(pageId)
      .then(setLinks)
      .catch(() => setLinks([]));
  }, [pageId]);
  if (!links.length) return null;
  return (
    <section className="backlinks">
      <button type="button" className="backlinks-toggle" onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        {links.length} {links.length === 1 ? "page links" : "pages link"} here
      </button>
      {open && (
        <div className="backlinks-list">
          {links.map((l) => (
            <Link key={l.id} to={pageUrl(l.space.slug, l)} className="backlink">
              <span>{l.icon || "📄"}</span> {l.title || "Untitled"} <span className="muted small">{l.space.name}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
};
