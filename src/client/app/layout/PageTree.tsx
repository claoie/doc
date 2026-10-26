import { copyText } from "../../editor/clipboard";
import { useCallback, useEffect, useState, type DragEvent } from "react";
import type { Space, TreeItem } from "common/api-types";
import { api } from "../api";
import { Link, navigate, pageUrl, useLocation } from "../router";
import { treeCache, useTreeLevel, useApp } from "../store";
import { Icon } from "../components/Icon";
import { Menu, cx, errorMessage, useConfirm, useToast, type MenuItem } from "../components/ui";
import { canWrite } from "./Sidebar";
import { CopyToSpaceDialog, MoveDialog } from "../page/MoveDialog";
import { ExportDialog } from "../page/ExportDialog";
import { EmojiPicker } from "../components/EmojiPicker";

const EXPANDED_STORAGE = "tree-expanded";

const loadExpanded = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_STORAGE) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

const saveExpanded = (set: Set<string>) => {
  try {
    localStorage.setItem(EXPANDED_STORAGE, JSON.stringify([...set].slice(-500)));
  } catch {
    // storage unavailable
  }
};

const expandedListeners = new Set<() => void>();
const expanded = loadExpanded();

const useExpanded = (id: string) => {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    expandedListeners.add(fn);
    return () => {
      expandedListeners.delete(fn);
    };
  }, []);
  return expanded.has(id);
};

export const setExpanded = (ids: string[], open: boolean) => {
  for (const id of ids) {
    if (open) expanded.add(id);
    else expanded.delete(id);
  }
  saveExpanded(expanded);
  expandedListeners.forEach((l) => l());
};

/** Where a drag would drop relative to the hovered row. */
type DropZone = "before" | "inside" | "after";

interface DragState {
  item: TreeItem;
}

let dragging: DragState | null = null;

export const PageTree = ({ space, onNewChild }: { space: Space; onNewChild: (parentId: string | null) => void }) => {
  const items = useTreeLevel(space.id, null);
  if (!items) return <div className="tree-loading">Loading…</div>;
  if (!items.length) {
    return (
      <div className="sidebar-empty">
        No pages yet.
        {canWrite(space) && (
          <>
            {" "}
            <button type="button" className="link-button" onClick={() => onNewChild(null)}>
              Create the first page
            </button>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="tree" role="tree">
      {items.map((item) => (
        <TreeRow key={item.id} item={item} space={space} depth={0} siblings={items} onNewChild={onNewChild} />
      ))}
    </div>
  );
};

const TreeRow = ({
  item,
  space,
  depth,
  siblings,
  onNewChild,
}: {
  item: TreeItem;
  space: Space;
  depth: number;
  siblings: TreeItem[];
  onNewChild: (parentId: string | null) => void;
}) => {
  const open = useExpanded(item.id);
  const children = useTreeLevel(space.id, item.id, open && item.hasChildren);
  const { pathname } = useLocation();
  const { favorites, refreshFavorites } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [drop, setDrop] = useState<DropZone | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [dialog, setDialog] = useState<"move" | "copy" | "export" | null>(null);
  const [iconPicker, setIconPicker] = useState<HTMLElement | null>(null);
  const active = pathname.endsWith(`-${item.slugId}`) || pathname.endsWith(`/${item.slugId}`);
  const writable = canWrite(space);
  const url = pageUrl(space.slug, item);

  const toggle = () => setExpanded([item.id], !open);

  const onDragStart = (e: DragEvent) => {
    if (!writable) return;
    dragging = { item };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", item.title || "Untitled");
  };

  const zoneFor = (e: DragEvent): DropZone => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    return y < 0.28 ? "before" : y > 0.72 ? "after" : "inside";
  };

  const onDragOver = (e: DragEvent) => {
    if (!dragging || dragging.item.id === item.id || !writable) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDrop(zoneFor(e));
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    const zone = zoneFor(e);
    setDrop(null);
    const moved = dragging?.item;
    dragging = null;
    if (!moved || moved.id === item.id) return;
    let parentId: string | null;
    let afterId: string | null;
    if (zone === "inside") {
      parentId = item.id;
      const kids = treeCache.get(space.id, item.id);
      afterId = kids?.length ? kids[kids.length - 1]!.id : null;
    } else {
      parentId = item.parentId;
      const others = siblings.filter((s) => s.id !== moved.id);
      const idx = others.findIndex((s) => s.id === item.id);
      afterId = zone === "after" ? item.id : (others[idx - 1]?.id ?? null);
    }
    try {
      await api.movePage(moved.id, parentId, afterId);
      if (zone === "inside") setExpanded([item.id], true);
      treeCache.invalidate(space.id);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const isFavorite = favorites.pages.some((p) => p.id === item.id);

  const setIcon = async (icon: string | null) => {
    setIconPicker(null);
    try {
      await api.updatePage(item.id, { icon });
      treeCache.patch(space.id, item.parentId, (items) => items.map((i) => (i.id === item.id ? { ...i, icon } : i)));
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const menuItems = (): MenuItem[] => [
    ...(writable ? [{ label: "Add subpage", icon: "plus" as const, onSelect: () => onNewChild(item.id) }] : []),
    {
      label: isFavorite ? "Remove from favorites" : "Add to favorites",
      icon: "star",
      onSelect: async () => {
        await (isFavorite ? api.removeFavorite({ pageId: item.id }) : api.addFavorite({ pageId: item.id }));
        void refreshFavorites();
      },
    },
    {
      label: "Copy link",
      icon: "link",
      onSelect: () => {
        void copyText(location.origin + url).then((ok) => toast(ok ? "Link copied" : "Could not copy the link", ok ? "info" : "error"));
      },
    },
    { label: "Open in new tab", icon: "external", onSelect: () => window.open(url, "_blank") },
    { label: "Export", icon: "download", onSelect: () => setDialog("export") },
    ...(writable
      ? [
          {
            label: "Duplicate",
            icon: "copy" as const,
            onSelect: async () => {
              try {
                const { page } = await api.duplicatePage(item.id);
                treeCache.invalidate(space.id);
                navigate(pageUrl(space.slug, page));
              } catch (err) {
                toast(errorMessage(err), "error");
              }
            },
          },
          { label: "Move", icon: "move" as const, onSelect: () => setDialog("move") },
          { label: "Copy to space", icon: "copy" as const, onSelect: () => setDialog("copy") },
          { separator: true, label: "" },
          {
            label: "Move to trash",
            icon: "trash" as const,
            danger: true,
            onSelect: async () => {
              const ok = await confirm({
                title: "Move to trash?",
                message: item.hasChildren ? "This page and all its subpages will be moved to trash." : "You can restore it from the trash.",
                confirmLabel: "Move to trash",
                danger: true,
              });
              if (!ok) return;
              try {
                await api.trashPage(item.id);
                treeCache.invalidate(space.id);
                if (active) navigate(`/s/${space.slug}`);
                toast("Moved to trash");
              } catch (err) {
                toast(errorMessage(err), "error");
              }
            },
          },
        ]
      : []),
  ];

  return (
    <div role="treeitem" aria-expanded={item.hasChildren ? open : undefined}>
      <div
        className={cx("tree-row", active && "active", drop && `drop-${drop}`)}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable={writable}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={() => setDrop(null)}
        onDrop={onDrop}
        onDragEnd={() => {
          dragging = null;
          setDrop(null);
        }}
      >
        <button type="button" className={cx("tree-toggle", !item.hasChildren && "invisible")} onClick={toggle} aria-label={open ? "Collapse" : "Expand"} tabIndex={-1}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        </button>
        {writable ? (
          <button type="button" className="tree-icon tree-icon-button" aria-label="Change icon" onClick={(e) => setIconPicker(e.currentTarget)}>
            {item.icon || <Icon name={item.isBase ? "table" : "page"} size={15} />}
          </button>
        ) : null}
        <Link to={url} className="tree-link" draggable={false}>
          {!writable && <span className="tree-icon">{item.icon || <Icon name={item.isBase ? "table" : "page"} size={15} />}</span>}
          <span className="tree-title">{item.title || "Untitled"}</span>
        </Link>
        <span className="tree-actions">
          <button type="button" className="tree-action" aria-label="Page actions" onClick={(e) => setMenu(e.currentTarget)}>
            <Icon name="more" size={15} />
          </button>
          {writable && (
            <button type="button" className="tree-action" aria-label="Add subpage" onClick={() => onNewChild(item.id)}>
              <Icon name="plus" size={15} />
            </button>
          )}
        </span>
      </div>
      {open && item.hasChildren && (
        <div role="group">
          {children === undefined && <div className="tree-loading" style={{ paddingLeft: 26 + depth * 14 }}>Loading…</div>}
          {children?.map((child) => (
            <TreeRow key={child.id} item={child} space={space} depth={depth + 1} siblings={children} onNewChild={onNewChild} />
          ))}
        </div>
      )}
      {menu && <Menu anchor={menu} items={menuItems()} onClose={() => setMenu(null)} />}
      {dialog === "move" && <MoveDialog page={item} space={space} onClose={() => setDialog(null)} />}
      {dialog === "copy" && <CopyToSpaceDialog page={item} space={space} onClose={() => setDialog(null)} />}
      {dialog === "export" && <ExportDialog page={item} onClose={() => setDialog(null)} />}
      {iconPicker && (
        <EmojiPicker
          anchor={iconPicker}
          onSelect={(icon) => void setIcon(icon)}
          onRemove={item.icon ? () => void setIcon(null) : undefined}
          onClose={() => setIconPicker(null)}
        />
      )}
    </div>
  );
};

/** Expands the tree along a page's ancestors (called when a page opens). */
export const useRevealInTree = (ids: string[]) => {
  const key = ids.join(",");
  const reveal = useCallback(() => setExpanded(ids, true), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ids.length) reveal();
  }, [reveal, ids.length]);
};
