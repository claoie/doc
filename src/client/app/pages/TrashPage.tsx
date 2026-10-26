import { useCallback, useEffect, useState } from "react";
import type { TrashItem } from "common/api-types";
import { api } from "../api";
import { navigate, pageUrl } from "../router";
import { useApp, treeCache } from "../store";
import { Icon } from "../components/Icon";
import { Button, EmptyState, Spinner, errorMessage, timeAgo, useConfirm, useToast } from "../components/ui";
import { TopBar } from "../layout/TopBar";
import { canWrite } from "../layout/Sidebar";

export const TrashPage = ({ spaceSlug }: { spaceSlug: string }) => {
  const { spaces, workspace } = useApp();
  const space = spaces.find((s) => s.slug.toLowerCase() === spaceSlug.toLowerCase());
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    if (!space) return;
    api
      .trash(space.id)
      .then(setItems)
      .catch((e) => {
        toast(errorMessage(e), "error");
        setItems([]);
      });
  }, [space, toast]);

  useEffect(() => {
    document.title = "Trash";
    load();
  }, [load]);

  if (!space) return <EmptyState icon="space" title="Space not found" />;
  const retention = workspace.settings.trashRetentionDays ?? 30;
  const visible = items?.filter((i) => (i.title || "Untitled").toLowerCase().includes(query.toLowerCase()));

  const restore = async (item: TrashItem) => {
    try {
      const { page } = await api.restorePage(item.id);
      treeCache.invalidate(space.id);
      toast(
        <span>
          Restored “{page.title || "Untitled"}”.{" "}
          <button type="button" className="link-button" onClick={() => navigate(pageUrl(space.slug, page))}>
            Open
          </button>
        </span>,
        "success",
      );
      load();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const remove = async (item: TrashItem) => {
    const ok = await confirm({
      title: "Delete permanently?",
      message: `“${item.title || "Untitled"}” and its subpages will be deleted forever. This cannot be undone.`,
      confirmLabel: "Delete forever",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deletePagePermanently(item.id);
      load();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <>
      <TopBar crumbs={[{ label: space.name, to: `/s/${space.slug}` }, { label: "Trash" }]} />
      <div className="content">
        <h1 className="page-heading">Trash</h1>
        <p className="muted">Pages in the trash are deleted forever after {retention} days.</p>
        <input className="input trash-search" placeholder="Filter by title" value={query} onChange={(e) => setQuery(e.target.value)} />
        {!visible && <Spinner />}
        {visible?.length === 0 && <EmptyState icon="trash" title={items?.length ? "No matching pages" : "Trash is empty"} />}
        <div className="page-list">
          {visible?.map((item) => (
            <div key={item.id} className="page-list-row static">
              <span className="page-list-icon">{item.icon || <Icon name={item.isBase ? "table" : "page"} size={16} />}</span>
              <span className="page-list-title">{item.title || "Untitled"}</span>
              <span className="page-list-meta">
                Deleted {timeAgo(item.deletedAt)}
                {item.deletedBy && ` by ${item.deletedBy.name}`}
              </span>
              {canWrite(space) && (
                <span className="row gap-s">
                  <Button icon="restore" onClick={() => restore(item)}>
                    Restore
                  </Button>
                  {space.role === "admin" && <Button icon="trash" variant="danger" onClick={() => remove(item)} aria-label="Delete permanently" />}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
};
