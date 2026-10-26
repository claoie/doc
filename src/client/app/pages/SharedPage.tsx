import { useEffect, useMemo, useRef, useState } from "react";
import type { PublicPage, PublicShare, TreeItem } from "common/api-types";
import { emptyDoc } from "common/editor/doc-schema";
import { Editor } from "../../editor/editor";
import { createNodeViews } from "../../editor/nodeviews";
import { api } from "../api";
import { Link, match, navigate, slugIdFrom, slugify, useLocation } from "../router";
import { Icon } from "../components/Icon";
import { EmptyState, Spinner, cx } from "../components/ui";
import { loadMermaid } from "../page/editor-ui/mermaid";
import { CellView, TYPE_ICONS } from "../base/cells";
import { columnWidth, visibleColumns } from "../base/format";

const shareUrl = (key: string, page: { slugId: string; title: string | null }) => `/share/${key}/p/${slugify(page.title)}-${page.slugId}`;

const ReadOnlyDoc = ({ page, shareKey }: { page: PublicPage; shareKey: string }) => {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mount.current) return;
    let editor: Editor | null = null;
    editor = new Editor(mount.current, {
      doc: page.content ?? emptyDoc(),
      editable: false,
      nodeViews: createNodeViews({
        editor: () => editor,
        fileUrl: (src) => src,
        pageHref: (slugId) => `/share/${shareKey}/p/${slugId}`,
        openPage: (slugId) => navigate(`/share/${shareKey}/p/${slugId}`),
        loadMermaid,
      }),
    });
    return () => editor?.destroy();
  }, [page.id, page.content, shareKey]);
  return <div ref={mount} />;
};

const EMPTY_REFS = { users: {}, pages: {} };

const SharedBase = ({ base }: { base: NonNullable<PublicPage["base"]> }) => {
  const config = base.view?.config ?? {};
  const columns = visibleColumns(base.properties, config);
  const template = columns.map((p) => `${columnWidth(p, config)}px`).join(" ") + " minmax(0, 1fr)";
  return (
    <div className="base-table shared-base">
      <div className="grid-scroll" role="grid">
        <div className="grid-row grid-header" role="row" style={{ gridTemplateColumns: template }}>
          {columns.map((p) => (
            <div key={p.id} role="columnheader" className="grid-cell grid-head">
              <span className="grid-head-button">
                <Icon name={TYPE_ICONS[p.type]} size={14} />
                <span className="ellipsis">{p.name}</span>
              </span>
            </div>
          ))}
          <div className="grid-cell grid-fill" />
        </div>
        {base.rows.map((row) => (
          <div key={row.id} role="row" className="grid-row" style={{ gridTemplateColumns: template }}>
            {columns.map((p) => (
              <div key={p.id} role="gridcell" className="grid-cell">
                <CellView prop={p} row={row} refs={EMPTY_REFS} />
              </div>
            ))}
            <div className="grid-cell grid-fill" />
          </div>
        ))}
      </div>
      <div className="grid-footer muted">
        {base.rows.length}
        {base.truncated ? "+" : ""} {base.rows.length === 1 ? "row" : "rows"}
      </div>
    </div>
  );
};

export const SharedPageView = () => {
  const { pathname } = useLocation();
  const params = match("/share/:key/p/:page", pathname) ?? match("/share/:key", pathname);
  const key = params?.key ?? "";
  const pageParam = params?.page ? slugIdFrom(params.page) : null;
  const [share, setShare] = useState<PublicShare | null | undefined>(undefined);
  const [page, setPage] = useState<PublicPage | null | undefined>(undefined);
  const [breadcrumbs, setBreadcrumbs] = useState<TreeItem[]>([]);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    api
      .publicShare(key)
      .then(setShare)
      .catch(() => setShare(null));
  }, [key]);

  useEffect(() => {
    if (!share) return;
    if (!pageParam || pageParam === share.page.slugId) {
      setPage(share.page);
      setBreadcrumbs([]);
      return;
    }
    setPage(undefined);
    api
      .publicSharePage(key, pageParam)
      .then((r) => {
        setPage(r.page);
        setBreadcrumbs(r.breadcrumbs);
      })
      .catch(() => setPage(null));
  }, [share, pageParam, key]);

  useEffect(() => {
    if (page) document.title = `${page.icon ? page.icon + " " : ""}${page.title || "Untitled"}`;
  }, [page]);

  const children = useMemo(() => {
    const map = new Map<string | null, TreeItem[]>();
    for (const item of share?.tree ?? []) {
      const list = map.get(item.parentId) ?? [];
      list.push(item);
      map.set(item.parentId, list);
    }
    return map;
  }, [share]);

  if (share === undefined) {
    return (
      <div className="center-screen">
        <Spinner />
      </div>
    );
  }
  if (share === null) {
    return (
      <div className="center-screen">
        <EmptyState icon="lock" title="This page is not available">The link may have expired or the page is no longer public.</EmptyState>
      </div>
    );
  }

  const tree = share.tree?.length ? (
    <nav className={cx("share-nav", navOpen && "open")}>
      <ShareTreeLevel parentId={share.page.id} root={share.page} shareKey={key} children={children} activeSlug={page?.slugId ?? null} depth={0} />
    </nav>
  ) : null;

  return (
    <div className={cx("share-layout", tree && "with-nav")}>
      {tree}
      <main className="share-main">
        <header className="share-head">
          {tree && (
            <button type="button" className="icon-button share-nav-toggle" onClick={() => setNavOpen((o) => !o)} aria-label="Pages">
              <Icon name="menu" />
            </button>
          )}
          <nav className="crumbs">
            {breadcrumbs.map((b) => (
              <span key={b.id} className="crumb">
                <Link to={shareUrl(key, b)} className="crumb-link">
                  {b.icon} {b.title || "Untitled"}
                </Link>
                <Icon name="chevronRight" size={12} className="crumb-sep" />
              </span>
            ))}
          </nav>
        </header>
        {page === undefined && <Spinner />}
        {page === null && <EmptyState icon="page" title="Page not found" />}
        {page && (
          <article className="page-content share-content">
            {page.icon && <div className="page-icon static">{page.icon}</div>}
            <h1 className="page-title static">{page.title || (page.base ? "Untitled base" : "Untitled")}</h1>
            {page.base ? <SharedBase base={page.base} /> : <ReadOnlyDoc page={page} shareKey={key} />}
          </article>
        )}
      </main>
    </div>
  );
};

const ShareTreeLevel = ({
  parentId,
  root,
  shareKey,
  children,
  activeSlug,
  depth,
}: {
  parentId: string;
  root?: PublicPage;
  shareKey: string;
  children: Map<string | null, TreeItem[]>;
  activeSlug: string | null;
  depth: number;
}) => (
  <>
    {root && (
      <Link to={shareUrl(shareKey, root)} className={cx("tree-row", activeSlug === root.slugId && "active")} style={{ paddingLeft: 10 }}>
        <span className="tree-icon">{root.icon || "📄"}</span>
        <span className="tree-title">{root.title || "Untitled"}</span>
      </Link>
    )}
    {(children.get(parentId) ?? []).map((item) => (
      <div key={item.id}>
        <Link to={shareUrl(shareKey, item)} className={cx("tree-row", activeSlug === item.slugId && "active")} style={{ paddingLeft: 10 + (depth + 1) * 14 }}>
          <span className="tree-icon">{item.icon || "📄"}</span>
          <span className="tree-title">{item.title || "Untitled"}</span>
        </Link>
        <ShareTreeLevel parentId={item.id} shareKey={shareKey} children={children} activeSlug={activeSlug} depth={depth + 1} />
      </div>
    ))}
  </>
);
