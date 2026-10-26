import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Favorites, Space, User, Workspace, TreeItem } from "common/api-types";
import { api } from "./api";
import { realtime } from "./realtime";

interface AppState {
  user: User;
  workspace: Workspace;
  spaces: Space[];
  favorites: Favorites;
  setUser: (user: User) => void;
  setWorkspace: (workspace: Workspace) => void;
  refreshSpaces: () => Promise<Space[]>;
  refreshFavorites: () => Promise<void>;
  isAdmin: boolean;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
}

const AppContext = createContext<AppState | null>(null);

export const useApp = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside of AppProvider");
  return ctx;
};

export const applyTheme = (theme: string | undefined) => {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
};

const mobile = () => window.matchMedia("(max-width: 800px)").matches;

export const AppProvider = ({
  initial,
  children,
}: {
  initial: { user: User; workspace: Workspace; spaces: Space[] };
  children: ReactNode;
}) => {
  const [user, setUser] = useState(initial.user);
  const [workspace, setWorkspace] = useState(initial.workspace);
  const [spaces, setSpaces] = useState(initial.spaces);
  const [favorites, setFavorites] = useState<Favorites>({ pages: [], spaces: [] });
  const [sidebarOpen, setSidebarOpenState] = useState(() => {
    if (mobile()) return false;
    try {
      return localStorage.getItem("sidebar") !== "closed";
    } catch {
      return true;
    }
  });
  const [searchOpen, setSearchOpen] = useState(false);

  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpenState(open);
    if (!mobile()) {
      try {
        localStorage.setItem("sidebar", open ? "open" : "closed");
      } catch {
        // storage unavailable
      }
    }
  }, []);

  const refreshSpaces = useCallback(async () => {
    const next = await api.spaces();
    setSpaces(next);
    return next;
  }, []);

  const refreshFavorites = useCallback(async () => {
    setFavorites(await api.favorites());
  }, []);

  useEffect(() => {
    void refreshFavorites();
  }, [refreshFavorites]);

  useEffect(() => applyTheme(user.preferences.theme), [user.preferences.theme]);

  useEffect(() => {
    realtime.start();
    const off = realtime.onEvent((e) => {
      if (e.kind === "page" || e.kind === "tree") treeCache.invalidate(e.spaceId);
    });
    return () => {
      off();
      realtime.stop();
    };
  }, []);

  const value = useMemo(
    () => ({
      user,
      workspace,
      spaces,
      favorites,
      setUser,
      setWorkspace,
      refreshSpaces,
      refreshFavorites,
      isAdmin: user.role === "owner" || user.role === "admin",
      sidebarOpen,
      setSidebarOpen,
      searchOpen,
      setSearchOpen,
    }),
    [user, workspace, spaces, favorites, refreshSpaces, refreshFavorites, sidebarOpen, setSidebarOpen, searchOpen],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

/**
 * Page tree cache keyed by space and parent. Components subscribe to a
 * space; any change to it (realtime event or local mutation) refetches the
 * levels that are loaded.
 */
class TreeCache {
  private levels = new Map<string, TreeItem[]>();
  private listeners = new Map<string, Set<() => void>>();
  private inflight = new Map<string, Promise<TreeItem[]>>();

  private key(spaceId: string, parentId: string | null) {
    return `${spaceId}:${parentId ?? ""}`;
  }

  get(spaceId: string, parentId: string | null) {
    return this.levels.get(this.key(spaceId, parentId));
  }

  async load(spaceId: string, parentId: string | null): Promise<TreeItem[]> {
    const key = this.key(spaceId, parentId);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = api
      .tree(spaceId, parentId)
      .then((items) => {
        this.levels.set(key, items);
        this.emit(spaceId);
        return items;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  invalidate(spaceId: string) {
    const prefix = `${spaceId}:`;
    for (const key of [...this.levels.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const parent = key.slice(prefix.length) || null;
      void this.load(spaceId, parent).catch(() => this.levels.delete(key));
    }
  }

  /** Applies a local change immediately (optimistic), before the refetch lands. */
  patch(spaceId: string, parentId: string | null, fn: (items: TreeItem[]) => TreeItem[]) {
    const key = this.key(spaceId, parentId);
    this.levels.set(key, fn(this.levels.get(key) ?? []));
    this.emit(spaceId);
  }

  subscribe(spaceId: string, fn: () => void) {
    const set = this.listeners.get(spaceId) ?? new Set();
    set.add(fn);
    this.listeners.set(spaceId, set);
    return () => {
      set.delete(fn);
    };
  }

  private emit(spaceId: string) {
    this.listeners.get(spaceId)?.forEach((l) => l());
  }
}

export const treeCache = new TreeCache();

export const useTreeLevel = (spaceId: string, parentId: string | null, enabled = true) => {
  const [, force] = useState(0);
  useEffect(() => treeCache.subscribe(spaceId, () => force((n) => n + 1)), [spaceId]);
  useEffect(() => {
    if (enabled && !treeCache.get(spaceId, parentId)) void treeCache.load(spaceId, parentId).catch(() => undefined);
  }, [spaceId, parentId, enabled]);
  return treeCache.get(spaceId, parentId);
};
