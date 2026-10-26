import { useEffect, useState } from "react";
import type { Space } from "common/api-types";
import { api } from "../api";
import { Link, match, navigate, pageUrl, useLocation } from "../router";
import { useApp, treeCache } from "../store";
import { Icon } from "../components/Icon";
import { Avatar, IconButton, Menu, cx, errorMessage, useToast, type MenuItem } from "../components/ui";
import { PageTree } from "./PageTree";
import { NotificationsPanel, useUnreadCount } from "./Notifications";
import { CreateSpaceDialog } from "../pages/settings/SpacesSettings";
import { ImportDialog } from "../page/ImportDialog";

const LAST_SPACE = "last-space";

export const useCurrentSpace = (): Space | null => {
  const { spaces, workspace } = useApp();
  const { pathname } = useLocation();
  const slug = match("/s/:space/*", pathname)?.space ?? match("/s/:space", pathname)?.space;
  const fromUrl = slug ? spaces.find((s) => s.slug.toLowerCase() === slug.toLowerCase()) : undefined;
  useEffect(() => {
    if (fromUrl) {
      try {
        localStorage.setItem(LAST_SPACE, fromUrl.id);
      } catch {
        // storage unavailable
      }
    }
  }, [fromUrl]);
  if (fromUrl) return fromUrl;
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_SPACE);
  } catch {
    last = null;
  }
  return spaces.find((s) => s.id === last) ?? spaces.find((s) => s.id === workspace.defaultSpaceId) ?? spaces[0] ?? null;
};

export const canWrite = (space: Space | null) => space?.role === "admin" || space?.role === "writer";

export const Sidebar = ({ onSignedOut }: { onSignedOut: () => void }) => {
  const { user, workspace, spaces, favorites, isAdmin, setSidebarOpen, setSearchOpen, setUser, refreshFavorites } = useApp();
  const space = useCurrentSpace();
  const { pathname } = useLocation();
  const toast = useToast();
  const unread = useUnreadCount();
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [createSpace, setCreateSpace] = useState(false);
  const [importing, setImporting] = useState(false);

  const newPage = async (parentId: string | null = null) => {
    if (!space) return;
    try {
      const { page } = await api.createPage({ spaceId: space.id, parentId });
      treeCache.invalidate(space.id);
      navigate(pageUrl(space.slug, page));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const newBase = async () => {
    if (!space) return;
    try {
      const { page } = await api.createBase({ spaceId: space.id });
      treeCache.invalidate(space.id);
      navigate(pageUrl(space.slug, page));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const setTheme = async (theme: "light" | "dark" | "system") => {
    try {
      const { user: next } = await api.updateMe({ preferences: { theme } });
      setUser(next);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const workspaceMenu = (anchor: HTMLElement) =>
    setMenu({
      anchor,
      items: [
        { label: user.email, disabled: true },
        { separator: true, label: "" },
        { label: "Account settings", icon: "user", onSelect: () => navigate("/settings/account") },
        ...(isAdmin ? [{ label: "Workspace settings", icon: "settings" as const, onSelect: () => navigate("/settings/workspace") }] : []),
        { separator: true, label: "" },
        { label: "Light theme", checked: user.preferences.theme === "light", onSelect: () => setTheme("light") },
        { label: "Dark theme", checked: user.preferences.theme === "dark", onSelect: () => setTheme("dark") },
        { label: "System theme", checked: !user.preferences.theme || user.preferences.theme === "system", onSelect: () => setTheme("system") },
        { separator: true, label: "" },
        {
          label: "Sign out",
          icon: "logout",
          onSelect: async () => {
            await api.logout().catch(() => undefined);
            onSignedOut();
            navigate("/login", { replace: true });
          },
        },
      ],
    });

  const spaceMenu = (anchor: HTMLElement) =>
    setMenu({
      anchor,
      items: [
        ...spaces.map((s) => ({ label: s.name, checked: s.id === space?.id, onSelect: () => navigate(`/s/${s.slug}`) })),
        { separator: true, label: "" },
        { label: "Create space", icon: "plus" as const, onSelect: () => setCreateSpace(true) },
        ...(isAdmin ? [{ label: "Manage spaces", icon: "settings" as const, onSelect: () => navigate("/settings/spaces") }] : []),
      ],
    });

  const spaceActions = async (anchor: HTMLElement) => {
    if (!space) return;
    const watching = await api
      .spaceWatch(space.id)
      .then((w) => w.watching)
      .catch(() => false);
    const favorite = favorites.spaces.some((s) => s.id === space.id);
    setMenu({
      anchor,
      items: [
        ...(canWrite(space) ? [{ label: "New page", icon: "plus" as const, onSelect: () => newPage(null) }] : []),
        ...(canWrite(space) ? [{ label: "New base", icon: "table" as const, onSelect: () => newBase() }] : []),
        ...(canWrite(space) ? [{ label: "Import pages", icon: "upload" as const, onSelect: () => setImporting(true) }] : []),
        {
          label: watching ? "Stop watching space" : "Watch space",
          icon: "bell",
          onSelect: async () => {
            await api.setSpaceWatch(space.id, !watching).catch((e) => toast(errorMessage(e), "error"));
            toast(watching ? "You will no longer get updates for this space" : "You will be notified about changes in this space");
          },
        },
        {
          label: favorite ? "Remove space from favorites" : "Add space to favorites",
          icon: "star",
          onSelect: async () => {
            await (favorite ? api.removeFavorite({ spaceId: space.id }) : api.addFavorite({ spaceId: space.id }));
            void refreshFavorites();
          },
        },
        { label: "Space settings", icon: "settings", onSelect: () => navigate(`/s/${space.slug}/settings`) },
        { label: "Trash", icon: "trash", onSelect: () => navigate(`/s/${space.slug}/trash`) },
      ],
    });
  };

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="sidebar-head">
        <button type="button" className="workspace-switch" onClick={(e) => workspaceMenu(e.currentTarget)}>
          {workspace.logoUrl ? <img src={workspace.logoUrl} alt="" className="workspace-logo" /> : <span className="workspace-logo">{workspace.name.slice(0, 1)}</span>}
          <span className="workspace-name">{workspace.name}</span>
          <Icon name="chevronDown" size={14} />
        </button>
        <IconButton icon="sidebar" label="Close sidebar" onClick={() => setSidebarOpen(false)} />
      </div>

      <nav className="sidebar-nav">
        <button type="button" className="nav-item" onClick={() => setSearchOpen(true)}>
          <Icon name="search" size={16} />
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>
        <Link to="/" className={cx("nav-item", pathname === "/" && "active")}>
          <Icon name="home" size={16} />
          <span>Home</span>
        </Link>
        <button type="button" className={cx("nav-item", notificationsOpen && "active")} onClick={() => setNotificationsOpen((o) => !o)}>
          <Icon name="bell" size={16} />
          <span>Notifications</span>
          {unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
        </button>
        <Link to="/settings/account" className={cx("nav-item", pathname.startsWith("/settings") && "active")}>
          <Icon name="settings" size={16} />
          <span>Settings</span>
        </Link>
      </nav>

      <div className="sidebar-scroll">
        {favorites.pages.length > 0 && (
          <section className="sidebar-section">
            <div className="sidebar-section-title">Favorites</div>
            {favorites.pages.map((p) => (
              <Link key={p.id} to={pageUrl(p.space.slug, p)} className={cx("tree-row", pathname.endsWith(`-${p.slugId}`) && "active")} style={{ paddingLeft: 10 }}>
                <span className="tree-icon">{p.icon || <Icon name={p.isBase ? "table" : "page"} size={15} />}</span>
                <span className="tree-title">{p.title || "Untitled"}</span>
              </Link>
            ))}
          </section>
        )}

        <section className="sidebar-section">
          <div className="sidebar-space-row">
            <button type="button" className="space-switch" onClick={(e) => spaceMenu(e.currentTarget)}>
              {space?.iconUrl ? <img src={space.iconUrl} alt="" className="space-icon" /> : <span className="space-icon">{space?.name.slice(0, 1) ?? "?"}</span>}
              <span className="space-name">{space?.name ?? "No spaces"}</span>
              <Icon name="chevronDown" size={14} />
            </button>
            {space && <IconButton icon="more" label="Space actions" onClick={(e) => void spaceActions(e.currentTarget)} size={16} />}
            {space && canWrite(space) && <IconButton icon="plus" label="New page" onClick={() => newPage(null)} size={16} />}
          </div>
          {space ? (
            <PageTree space={space} onNewChild={newPage} />
          ) : (
            <div className="sidebar-empty">
              You are not a member of any space yet.{" "}
              <button type="button" className="link-button" onClick={() => setCreateSpace(true)}>
                Create one
              </button>
            </div>
          )}
        </section>
      </div>

      {space && (
        <div className="sidebar-foot">
          <Link to={`/s/${space.slug}/trash`} className={cx("nav-item", pathname === `/s/${space.slug}/trash` && "active")}>
            <Icon name="trash" size={16} />
            <span>Trash</span>
          </Link>
          <div className="sidebar-user">
            <Avatar name={user.name} url={user.avatarUrl} size={22} />
            <span>{user.name}</span>
          </div>
        </div>
      )}

      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
      {notificationsOpen && <NotificationsPanel onClose={() => setNotificationsOpen(false)} />}
      {createSpace && <CreateSpaceDialog onClose={() => setCreateSpace(false)} />}
      {importing && space && <ImportDialog space={space} onClose={() => setImporting(false)} />}
    </aside>
  );
};
