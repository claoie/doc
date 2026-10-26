import { useEffect, useState } from "react";
import type { TreeItemWithSpace } from "common/api-types";
import { api } from "../api";
import { Link, pageUrl } from "../router";
import { Icon } from "../components/Icon";
import { EmptyState, Spinner } from "../components/ui";
import { TopBar } from "../layout/TopBar";

export const LabelPage = ({ labelId }: { labelId: string }) => {
  const [pages, setPages] = useState<TreeItemWithSpace[] | null>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    api
      .labelPages(labelId)
      .then(setPages)
      .catch(() => setPages([]));
    api
      .labels()
      .then((all) => setName(all.find((l) => l.id === labelId)?.name ?? ""))
      .catch(() => undefined);
  }, [labelId]);
  useEffect(() => {
    document.title = name ? `#${name}` : "Label";
  }, [name]);
  return (
    <>
      <TopBar crumbs={[{ label: name ? `#${name}` : "Label" }]} />
      <div className="content">
        <h1 className="page-heading">
          <Icon name="label" size={22} /> {name}
        </h1>
        {!pages && <Spinner />}
        {pages?.length === 0 && <EmptyState title="No pages with this label" />}
        <div className="page-list">
          {pages?.map((p) => (
            <Link key={p.id} to={pageUrl(p.space.slug, p)} className="page-list-row">
              <span className="page-list-icon">{p.icon || <Icon name={p.isBase ? "table" : "page"} size={16} />}</span>
              <span className="page-list-title">{p.title || "Untitled"}</span>
              <span className="page-list-space">{p.space.name}</span>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
};
