import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Base, FilterCondition, FilterGroup, Property, Row, RowReferences, Sort, View, ViewConfig } from "common/bases";
import { isFilterGroup } from "common/bases";
import { api } from "../api";
import { realtime } from "../realtime";
import { errorMessage, useToast } from "../components/ui";
import { newRequestId } from "./format";

const PAGE_SIZE = 100;

/** Drops conditions that are not filled in yet so a half-built filter does not hide every row. */
export const compactFilter = (group: FilterGroup | undefined): FilterGroup | undefined => {
  if (!group) return undefined;
  const children = group.children.flatMap((c): (FilterGroup | FilterCondition)[] => {
    if (isFilterGroup(c)) {
      const inner = compactFilter(c);
      return inner ? [inner] : [];
    }
    if (c.op === "isEmpty" || c.op === "isNotEmpty") return [c];
    if (c.value === undefined || c.value === null || c.value === "" || (Array.isArray(c.value) && c.value.length === 0)) return [];
    return [c];
  });
  return children.length ? { op: group.op, children } : undefined;
};

const applyPatch = (config: ViewConfig, patch: Record<string, unknown>): ViewConfig => {
  const next: Record<string, unknown> = { ...config };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else if (v !== undefined) next[k] = v;
  }
  return next as ViewConfig;
};

const mergeRefs = (a: RowReferences, b: RowReferences): RowReferences => ({ users: { ...a.users, ...b.users }, pages: { ...a.pages, ...b.pages } });

export interface BaseController {
  base: Base | null;
  error: string | null;
  reload: () => void;
  canEdit: boolean;
  view: View | null;
  setViewId: (id: string) => void;
  /** The view's config with any local, unsaved changes of a read-only viewer applied. */
  config: ViewConfig;
  hasDraft: boolean;
  resetDraft: () => void;
  patchConfig: (patch: Record<string, unknown>) => void;
  rows: Row[];
  references: RowReferences;
  addReferences: (refs: Partial<RowReferences>) => void;
  loadingRows: boolean;
  rowsError: string | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  loadAll: () => Promise<void>;
  createRow: (cells?: Record<string, unknown>, position?: string) => Promise<Row | null>;
  updateCells: (row: Row, cells: Record<string, unknown>) => Promise<void>;
  moveRow: (row: Row, position: string) => Promise<void>;
  deleteRows: (ids: string[]) => Promise<void>;
  saveProperty: (property: Property | null, body: { name: string; type: Property["type"]; options: Property["options"] }) => Promise<Property | null>;
  deleteProperty: (property: Property) => Promise<void>;
  createView: (name: string, type: View["type"], config?: ViewConfig) => Promise<void>;
  renameView: (view: View, name: string) => Promise<void>;
  deleteView: (view: View) => Promise<void>;
}

export const useBase = (pageId: string, editable: boolean): BaseController => {
  const toast = useToast();
  const [base, setBase] = useState<Base | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewId, setViewIdState] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [references, setReferences] = useState<RowReferences>({ users: {}, pages: {} });
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingRows, setLoadingRows] = useState(true);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const ownRequests = useRef(new Set<string>());
  const generation = useRef(0);

  const tracked = () => {
    const id = newRequestId();
    ownRequests.current.add(id);
    if (ownRequests.current.size > 200) ownRequests.current.delete(ownRequests.current.values().next().value!);
    return id;
  };

  const reload = useCallback(() => {
    setError(null);
    api
      .base(pageId)
      .then(setBase)
      .catch((e) => setError(errorMessage(e)));
  }, [pageId]);

  useEffect(() => {
    setBase(null);
    reload();
  }, [reload]);

  const view = useMemo(() => {
    if (!base?.views.length) return null;
    return base.views.find((v) => v.id === viewId) ?? base.views[0]!;
  }, [base, viewId]);

  const setViewId = (id: string) => {
    setViewIdState(id);
    try {
      localStorage.setItem(`base-view:${pageId}`, id);
    } catch {
      // storage unavailable
    }
  };

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`base-view:${pageId}`);
      if (saved) setViewIdState(saved);
    } catch {
      // storage unavailable
    }
  }, [pageId]);

  const canEdit = editable && !!base?.canEdit;
  const draft = view ? drafts[view.id] : undefined;
  const config = useMemo(() => (view ? (draft ? applyPatch(view.config, draft) : view.config) : {}), [view, draft]);

  const filter = useMemo(() => compactFilter(config.filter), [config.filter]);
  const sorts: Sort[] | undefined = useMemo(() => {
    const ids = new Set(base?.properties.map((p) => p.id));
    const list = (config.sorts ?? []).filter((s) => ids.has(s.propertyId));
    return list.length ? list : undefined;
  }, [config.sorts, base?.properties]);
  const queryKey = JSON.stringify([filter ?? null, sorts ?? null]);

  const fetchPage = useCallback(
    async (from: string | null, replace: boolean) => {
      const gen = generation.current;
      setLoadingRows(true);
      setRowsError(null);
      try {
        const page = await api.baseRows(pageId, { filter, sorts, cursor: from, limit: PAGE_SIZE });
        if (gen !== generation.current) return;
        setRows((prev) => {
          if (replace) return page.items;
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...page.items.filter((r) => !seen.has(r.id))];
        });
        setReferences((prev) => mergeRefs(prev, page.references));
        setCursor(page.nextCursor);
        setHasMore(!!page.nextCursor);
      } catch (e) {
        if (gen === generation.current) setRowsError(errorMessage(e));
      } finally {
        if (gen === generation.current) setLoadingRows(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageId, queryKey],
  );

  const refetchRows = useCallback(() => {
    generation.current++;
    return fetchPage(null, true);
  }, [fetchPage]);

  useEffect(() => {
    if (!base) return;
    void refetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!base, refetchRows]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingRows) return;
    await fetchPage(cursor, false);
  }, [cursor, fetchPage, hasMore, loadingRows]);

  const loadAll = useCallback(async () => {
    const gen = ++generation.current;
    setLoadingRows(true);
    let next: string | null = null;
    const all: Row[] = [];
    let refs: RowReferences = { users: {}, pages: {} };
    try {
      do {
        const page = await api.baseRows(pageId, { filter, sorts, cursor: next, limit: 500 });
        if (gen !== generation.current) return;
        all.push(...page.items);
        refs = mergeRefs(refs, page.references);
        next = page.nextCursor;
      } while (next);
      setRows(all);
      setReferences((prev) => mergeRefs(prev, refs));
      setCursor(null);
      setHasMore(false);
    } catch (e) {
      setRowsError(errorMessage(e));
    } finally {
      if (gen === generation.current) setLoadingRows(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, queryKey]);

  const stateRef = useRef({ filter, sorts, hasMore, refetchRows });
  stateRef.current = { filter, sorts, hasMore, refetchRows };

  useEffect(() => {
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;
    const refetchSoon = () => {
      if (refetchTimer) clearTimeout(refetchTimer);
      refetchTimer = setTimeout(() => {
        refetchTimer = null;
        void stateRef.current.refetchRows();
      }, 300);
    };
    const off = realtime.onEvent((e) => {
      if (e.kind !== "base" || e.pageId !== pageId) return;
      if (e.requestId && ownRequests.current.has(e.requestId)) {
        ownRequests.current.delete(e.requestId);
        return;
      }
      const ev = e.event;
      switch (ev.op) {
        case "base":
          setBase(ev.base);
          return;
        case "rowCreated": {
          const s = stateRef.current;
          // The row's place depends on the server's filter and sort; ask again.
          if (s.filter || s.sorts) return refetchSoon();
          if (s.hasMore) return;
          setRows((prev) => {
            if (prev.some((r) => r.id === ev.row.id)) return prev;
            const index = prev.findIndex((r) => r.position > ev.row.position);
            const next = [...prev];
            next.splice(index < 0 ? next.length : index, 0, ev.row);
            return next;
          });
          return;
        }
        case "rowUpdated":
          setRows((prev) =>
            prev.map((r) => {
              if (r.id !== ev.rowId) return r;
              const cells = { ...r.cells };
              for (const [k, v] of Object.entries(ev.cells)) {
                if (v === null || v === undefined) delete cells[k];
                else cells[k] = v;
              }
              return { ...r, cells, position: ev.position ?? r.position, updatedAt: ev.updatedAt, lastEditorId: ev.lastEditorId };
            }),
          );
          if (ev.position !== undefined && !stateRef.current.sorts) {
            setRows((prev) => [...prev].sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1)));
          }
          return;
        case "rowsDeleted": {
          const gone = new Set(ev.rowIds);
          setRows((prev) => prev.filter((r) => !gone.has(r.id)));
          return;
        }
        case "rowsChanged":
          void stateRef.current.refetchRows();
          return;
      }
    });
    const offStatus = realtime.onStatus((s) => {
      if (s === "open") {
        reload();
        void stateRef.current.refetchRows();
      }
    });
    return () => {
      if (refetchTimer) clearTimeout(refetchTimer);
      off();
      offStatus();
    };
  }, [pageId, reload]);

  const fail = (e: unknown) => toast(errorMessage(e), "error");

  const patchConfig = (patch: Record<string, unknown>) => {
    if (!view || !base) return;
    if (!canEdit) {
      setDrafts((d) => ({ ...d, [view.id]: { ...(d[view.id] ?? {}), ...patch } }));
      return;
    }
    const nextView = { ...view, config: applyPatch(view.config, patch) };
    setBase({ ...base, views: base.views.map((v) => (v.id === view.id ? nextView : v)) });
    api.updateBaseView(pageId, view.id, { config: patch, requestId: tracked() }).catch((e) => {
      fail(e);
      reload();
    });
  };

  const sortRows = (list: Row[]) => (sorts ? list : [...list].sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0)));

  const createRow = async (cells?: Record<string, unknown>, position?: string) => {
    try {
      const row = await api.createBaseRow(pageId, { cells, position, requestId: tracked() });
      setRows((prev) => (prev.some((r) => r.id === row.id) ? prev : sortRows([...prev, row])));
      return row;
    } catch (e) {
      fail(e);
      return null;
    }
  };

  const updateCells = async (row: Row, cells: Record<string, unknown>) => {
    const changed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cells)) {
      const next = v === undefined ? null : v;
      if (JSON.stringify(row.cells[k] ?? null) !== JSON.stringify(next)) changed[k] = next;
    }
    if (!Object.keys(changed).length) return;
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== row.id) return r;
        const merged = { ...r.cells };
        for (const [k, v] of Object.entries(changed)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        return { ...r, cells: merged };
      }),
    );
    try {
      const saved = await api.updateBaseRow(pageId, row.id, { cells: changed, requestId: tracked() });
      setRows((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
    } catch (e) {
      fail(e);
      setRows((prev) => prev.map((r) => (r.id === row.id ? row : r)));
    }
  };

  const moveRow = async (row: Row, position: string) => {
    setRows((prev) => sortRows(prev.map((r) => (r.id === row.id ? { ...r, position } : r))));
    try {
      await api.updateBaseRow(pageId, row.id, { position, requestId: tracked() });
    } catch (e) {
      fail(e);
      void refetchRows();
    }
  };

  const deleteRows = async (ids: string[]) => {
    const gone = new Set(ids);
    setRows((prev) => prev.filter((r) => !gone.has(r.id)));
    try {
      for (let i = 0; i < ids.length; i += 500) await api.deleteBaseRows(pageId, ids.slice(i, i + 500), tracked());
    } catch (e) {
      fail(e);
      void refetchRows();
    }
  };

  const saveProperty: BaseController["saveProperty"] = async (property, body) => {
    try {
      const saved = property
        ? await api.updateBaseProperty(pageId, property.id, {
            ...(body.name !== property.name ? { name: body.name } : {}),
            ...(body.type !== property.type ? { type: body.type } : {}),
            ...(JSON.stringify(body.options) !== JSON.stringify(property.options) || body.type !== property.type ? { options: body.options } : {}),
            requestId: tracked(),
          })
        : await api.createBaseProperty(pageId, { ...body, requestId: tracked() });
      reload();
      if (body.type === "formula" || (property && (property.type !== body.type || JSON.stringify(property.options.choices) !== JSON.stringify(body.options.choices)))) {
        void refetchRows();
      }
      return saved;
    } catch (e) {
      fail(e);
      return null;
    }
  };

  const deleteProperty = async (property: Property) => {
    try {
      await api.deleteBaseProperty(pageId, property.id, tracked());
      reload();
      void refetchRows();
    } catch (e) {
      fail(e);
    }
  };

  const createView = async (name: string, type: View["type"], config?: ViewConfig) => {
    try {
      const created = await api.createBaseView(pageId, { name, type, config, requestId: tracked() });
      setBase((b) => (b ? { ...b, views: [...b.views, created] } : b));
      setViewId(created.id);
    } catch (e) {
      fail(e);
    }
  };

  const renameView = async (target: View, name: string) => {
    setBase((b) => (b ? { ...b, views: b.views.map((v) => (v.id === target.id ? { ...v, name } : v)) } : b));
    await api.updateBaseView(pageId, target.id, { name, requestId: tracked() }).catch(fail);
  };

  const deleteView = async (target: View) => {
    try {
      await api.deleteBaseView(pageId, target.id, tracked());
      setBase((b) => (b ? { ...b, views: b.views.filter((v) => v.id !== target.id) } : b));
    } catch (e) {
      fail(e);
    }
  };

  return {
    base,
    error,
    reload,
    canEdit,
    view,
    setViewId,
    config,
    hasDraft: !!draft && Object.keys(draft).length > 0,
    resetDraft: () => view && setDrafts((d) => ({ ...d, [view.id]: {} })),
    patchConfig,
    rows,
    references,
    addReferences: (refs) => setReferences((prev) => mergeRefs(prev, { users: refs.users ?? {}, pages: refs.pages ?? {} })),
    loadingRows,
    rowsError,
    hasMore,
    loadMore,
    loadAll,
    createRow,
    updateCells,
    moveRow,
    deleteRows,
    saveProperty,
    deleteProperty,
    createView,
    renameView,
    deleteView,
  };
};
