import { copyText } from "../../editor/clipboard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageDetails, TreeItem } from "common/api-types";
import { api, ApiError } from "../api";
import { navigate, pageUrl, slugIdFrom, useLocation } from "../router";
import { useApp, treeCache } from "../store";
import { realtime } from "../realtime";
import { Icon } from "../components/Icon";
import { EmojiPicker } from "../components/EmojiPicker";
import { Avatar, EmptyState, IconButton, Menu, Spinner, cx, errorMessage, formatDateTime, useConfirm, useToast, type MenuItem } from "../components/ui";
import { TopBar, type Crumb } from "../layout/TopBar";
import { useRevealInTree } from "../layout/PageTree";
import { PageEditor, type PageEditorHandle } from "./PageEditor";
import { CommentsPanel } from "./CommentsPanel";
import { HistoryDialog } from "./HistoryDialog";
import { ShareDialog } from "./ShareDialog";
import { CopyToSpaceDialog, MoveDialog } from "./MoveDialog";
import { ExportDialog } from "./ExportDialog";
import { AttachmentsDialog } from "./AttachmentsDialog";
import { LabelsBar } from "./LabelsBar";
import { TableOfContents } from "./TableOfContents";
import { PageDetails as PageDetailsPanel } from "./PageDetails";
import { Backlinks } from "./Backlinks";
import { BaseView } from "../base/BaseView";
import type { PresenceUser } from "../realtime";
import { docToMarkdown } from "common/editor/markdown";
import { contentSize, textBetween } from "common/editor/tokens";

type Panel = "comments" | "toc" | "details" | null;

export const PageView = ({ pageSegment }: { pageSegment: string }) => {
  const slugId = slugIdFrom(pageSegment);
  const { user, favorites, refreshFavorites, setUser, spaces } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const location = useLocation();
  const [details, setDetails] = useState<PageDetails | null | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(() => (location.hash.startsWith("#comment-") ? "comments" : null));
  const [dialog, setDialog] = useState<"history" | "share" | "move" | "copy" | "export" | "files" | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [iconPicker, setIconPicker] = useState<HTMLElement | null>(null);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const editorRef = useRef<PageEditorHandle>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [watching, setWatching] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.page(slugId);
      setDetails(d);
      setTitle(d.page.title ?? "");
      setIcon(d.page.icon);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) setDetails(null);
      else toast(errorMessage(e), "error");
    }
  }, [slugId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const page = details?.page;
  const space = details?.space;

  useEffect(() => {
    if (!page || !space) return;
    // Keep the URL's title segment in sync with the current title.
    const want = pageUrl(space.slug, { slugId: page.slugId, title });
    if (decodeURIComponent(location.pathname) !== decodeURIComponent(want)) navigate(want + location.hash, { replace: true });
  }, [title, page?.slugId, space?.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.title = `${icon ? icon + " " : ""}${title || "Untitled"}`;
  }, [title, icon]);

  useEffect(() => {
    if (!page) return;
    api
      .pageWatch(page.id)
      .then((w) => setWatching(w.watching))
      .catch(() => undefined);
  }, [page?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!page) return;
    return realtime.onEvent((e) => {
      if (e.kind === "page" && e.pageId === page.id) {
        if (document.activeElement !== titleRef.current) setTitle(e.title ?? "");
        setIcon(e.icon);
      }
    });
  }, [page?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useRevealInTree(useMemo(() => (details ? [...details.breadcrumbs.map((b) => b.id)] : []), [details]));

  const isBase = !!page?.isBase;
  const editMode = isBase || (user.preferences.pageEditMode ?? "edit") === "edit";
  const [serverReadOnly, setServerReadOnly] = useState(false);
  useEffect(() => setServerReadOnly(false), [page?.id]);
  const canEdit = !!details?.canEdit && !serverReadOnly;
  const editable = canEdit && editMode && !page?.deletedAt;
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    if (!page || isBase) return;
    const check = () => {
      const doc = editorRef.current?.editor()?.state.doc;
      setEmpty(!!doc && (doc.content?.length ?? 0) <= 1 && !(doc.content?.[0]?.content?.length) && doc.content?.[0]?.type === "paragraph");
    };
    const t = setTimeout(check, 0);
    const off = editorRef.current?.subscribe(check);
    return () => {
      clearTimeout(t);
      off?.();
    };
  }, [page?.id, isBase, details]); // eslint-disable-line react-hooks/exhaustive-deps

  const convertToBase = async (template: "table" | "kanban") => {
    if (!page || !space) return;
    try {
      await api.convertToBase(page.id, template);
      treeCache.invalidate(space.id);
      await load();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const saveTitle = (value: string) => {
    if (!page || !space) return;
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(async () => {
      try {
        await api.updatePage(page.id, { title: value });
        treeCache.patch(space.id, page.parentId, (items) => items.map((i) => (i.id === page.id ? { ...i, title: value } : i)));
      } catch (e) {
        toast(errorMessage(e), "error");
      }
    }, 400);
  };

  const saveIcon = async (value: string | null) => {
    if (!page || !space) return;
    setIcon(value);
    try {
      await api.updatePage(page.id, { icon: value });
      treeCache.patch(space.id, page.parentId, (items) => items.map((i) => (i.id === page.id ? { ...i, icon: value } : i)));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const autosize = () => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(autosize, [title, details]);

  if (details === undefined) {
    return (
      <>
        <TopBar crumbs={[]} />
        <div className="content">
          <Spinner />
        </div>
      </>
    );
  }
  if (details === null || !page || !space) {
    return (
      <>
        <TopBar crumbs={[{ label: "Not found" }]} />
        <div className="content">
          <EmptyState icon="page" title="Page not found">
            It may have been deleted or moved, or you don't have access to it.
          </EmptyState>
        </div>
      </>
    );
  }

  const crumbs: Crumb[] = [
    { label: space.name, to: `/s/${space.slug}` },
    ...details.breadcrumbs
      .filter((b) => b.id !== page.id)
      .map((b: TreeItem) => ({ label: b.title || "Untitled", icon: b.icon, to: pageUrl(space.slug, b) })),
    { label: title || "Untitled", icon },
  ];

  const isFavorite = favorites.pages.some((p) => p.id === page.id);
  const fullWidth = !!user.preferences.fullPageWidth;

  const setPreference = async (prefs: Record<string, unknown>) => {
    try {
      const { user: next } = await api.updateMe({ preferences: prefs });
      setUser(next);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const menuItems = (): MenuItem[] => [
    {
      label: isFavorite ? "Remove from favorites" : "Add to favorites",
      icon: "star",
      onSelect: async () => {
        await (isFavorite ? api.removeFavorite({ pageId: page.id }) : api.addFavorite({ pageId: page.id }));
        void refreshFavorites();
      },
    },
    {
      label: watching ? "Stop watching" : "Watch for changes",
      icon: "bell",
      onSelect: async () => {
        await api.setPageWatch(page.id, !watching);
        setWatching(!watching);
        toast(watching ? "You will no longer get updates for this page" : "You will be notified when this page changes");
      },
    },
    {
      label: "Copy link",
      icon: "link",
      onSelect: () => {
        void copyText(window.location.origin + pageUrl(space.slug, { slugId: page.slugId, title })).then((ok) =>
          toast(ok ? "Link copied" : "Could not copy the link", ok ? "info" : "error"),
        );
      },
    },
    ...(isBase ? [] : [{
      label: "Copy as Markdown",
      icon: "copy" as const,
      onSelect: () => {
        const ed = editorRef.current?.editor();
        if (!ed) return;
        void copyText(`# ${title || "Untitled"}\n\n${docToMarkdown(ed.state.doc)}`).then((ok) =>
          toast(ok ? "Copied as Markdown" : "Could not copy", ok ? "info" : "error"),
        );
      },
    }]),
    { separator: true, label: "" },
    ...(canEdit && !isBase
      ? [
          { label: editMode ? "Switch to reading mode" : "Switch to editing mode", icon: (editMode ? "eye" : "edit") as "eye", onSelect: () => setPreference({ pageEditMode: editMode ? "read" : "edit" }) },
        ]
      : []),
    ...(isBase
      ? []
      : [
          { label: "Full width", checked: fullWidth, onSelect: () => setPreference({ fullPageWidth: !fullWidth }) },
          { label: "Table of contents", checked: panel === "toc", onSelect: () => setPanel(panel === "toc" ? null : "toc") },
          { label: "Page details", checked: panel === "details", onSelect: () => setPanel(panel === "details" ? null : "details") },
          { separator: true, label: "" },
          { label: "Page history", icon: "history" as const, onSelect: () => setDialog("history") },
          { label: "Attachments", icon: "attach" as const, onSelect: () => setDialog("files") },
          { label: "Export", icon: "download" as const, onSelect: () => setDialog("export") },
        ]),
    { label: "Print", icon: "print", onSelect: () => window.print() },
    ...(canEdit
      ? [
          { separator: true, label: "" },
          {
            label: "Duplicate",
            icon: "copy" as const,
            onSelect: async () => {
              try {
                const { page: copy } = await api.duplicatePage(page.id);
                treeCache.invalidate(space.id);
                navigate(pageUrl(space.slug, copy));
              } catch (e) {
                toast(errorMessage(e), "error");
              }
            },
          },
          { label: "Move", icon: "move" as const, onSelect: () => setDialog("move") },
          { label: "Copy to space", icon: "copy" as const, onSelect: () => setDialog("copy") },
          {
            label: "Move to trash",
            icon: "trash" as const,
            danger: true,
            onSelect: async () => {
              const ok = await confirm({ title: "Move to trash?", message: "This page and its subpages will be moved to trash.", confirmLabel: "Move to trash", danger: true });
              if (!ok) return;
              try {
                await api.trashPage(page.id);
                treeCache.invalidate(space.id);
                navigate(`/s/${space.slug}`);
                toast("Moved to trash");
              } catch (e) {
                toast(errorMessage(e), "error");
              }
            },
          },
        ]
      : []),
    { separator: true, label: "" },
    { label: `Last edited ${formatDateTime(page.updatedAt)}${page.lastEditor ? ` by ${page.lastEditor.name}` : ""}`, disabled: true },
    { label: `Created ${formatDateTime(page.createdAt)}${page.creator ? ` by ${page.creator.name}` : ""}${isBase ? "" : ` · ${wordCount()} words`}`, disabled: true },
  ];

  const wordCount = () => {
    const ed = editorRef.current?.editor();
    if (!ed) return 0;
    const text = textBetween(ed.state.doc, 0, contentSize(ed.state.doc, ed.state.schema), ed.state.schema, " ");
    return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  };

  const others = presence.filter((p) => p.clientId !== editorRef.current?.clientId);
  const uniqueOthers = others.filter((p, i) => others.findIndex((q) => q.userId === p.userId) === i);

  return (
    <>
      <TopBar
        crumbs={crumbs}
        actions={
          <>
            <div className="presence">
              {uniqueOthers.slice(0, 5).map((p) => (
                <span key={p.clientId} className="presence-avatar" style={{ borderColor: p.color }} title={p.name}>
                  <Avatar name={p.name} size={24} />
                </span>
              ))}
            </div>
            {canEdit && !editMode && <span className="mode-pill">Reading</span>}
            {!canEdit && <span className="mode-pill">View only</span>}
            <button type="button" className="btn btn-ghost" onClick={() => setDialog("share")}>
              Share
            </button>
            <IconButton icon="comment" label="Comments" active={panel === "comments"} onClick={() => setPanel(panel === "comments" ? null : "comments")} />
            <IconButton icon="star" label={isFavorite ? "Remove from favorites" : "Add to favorites"} active={isFavorite} onClick={async () => {
              await (isFavorite ? api.removeFavorite({ pageId: page.id }) : api.addFavorite({ pageId: page.id }));
              void refreshFavorites();
            }} />
            <IconButton icon="more" label="Page menu" onClick={(e) => setMenu(e.currentTarget)} />
          </>
        }
      />
      {page.deletedAt && (
        <div className="banner banner-warn">
          This page is in the trash.
          {canEdit && (
            <button type="button" className="link-button" onClick={async () => {
              await api.restorePage(page.id);
              treeCache.invalidate(space.id);
              void load();
            }}>
              Restore it
            </button>
          )}
        </div>
      )}
      <div className={cx("page-layout", panel && "with-panel")}>
        <article className={cx("page-content", (fullWidth || isBase) && "full-width", isBase && "base-page")}>
          <div className="page-head">
            <div className="page-head-tools">
              {!icon && editable && (
                <button type="button" className="ghost-tool" onClick={(e) => setIconPicker(e.currentTarget)}>
                  <Icon name="emoji" size={16} /> Add icon
                </button>
              )}
            </div>
            {icon && (
              <button type="button" className="page-icon" disabled={!editable} onClick={(e) => setIconPicker(e.currentTarget)} aria-label="Change icon">
                {icon}
              </button>
            )}
            <textarea
              ref={titleRef}
              className="page-title"
              rows={1}
              placeholder={isBase ? "Untitled base" : "Untitled"}
              value={title}
              readOnly={!editable}
              maxLength={500}
              onChange={(e) => {
                const value = e.target.value.replace(/\n/g, "");
                setTitle(value);
                saveTitle(value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || (e.key === "ArrowDown" && titleRef.current?.selectionStart === title.length)) {
                  e.preventDefault();
                  editorRef.current?.focusStart();
                }
              }}
            />
            <LabelsBar pageId={page.id} editable={editable} />
          </div>
          {isBase ? (
            <BaseView key={page.id} pageId={page.id} editable={canEdit && !page.deletedAt} />
          ) : (
            <>
          {empty && editable && (
            <div className="get-started">
              <span className="muted small">Get started with</span>
              <button type="button" className="chip" onClick={() => void convertToBase("table")}>
                <Icon name="table" size={14} /> Base
              </button>
              <button type="button" className="chip" onClick={() => void convertToBase("kanban")}>
                <Icon name="kanban" size={14} /> Board
              </button>
            </div>
          )}
          <PageEditor
            ref={editorRef}
            key={page.id}
            page={page}
            space={space}
            editable={editable}
            onPresence={setPresence}
            onReadOnly={setServerReadOnly}
            onOpenComments={(id) => {
              setActiveComment(id);
              setPanel("comments");
            }}
            activeComment={activeComment}
          />
            </>
          )}
          <Backlinks pageId={page.id} />
        </article>
        {panel === "comments" && (
          <CommentsPanel
            page={page}
            space={space}
            canComment={canEdit}
            editor={editorRef}
            activeComment={activeComment}
            setActiveComment={setActiveComment}
            onClose={() => setPanel(null)}
          />
        )}
        {panel === "toc" && <TableOfContents editor={editorRef} onClose={() => setPanel(null)} />}
        {panel === "details" && <PageDetailsPanel page={page} editor={editorRef} onClose={() => setPanel(null)} />}
      </div>
      {menu && <Menu anchor={menu} items={menuItems()} onClose={() => setMenu(null)} align="right" />}
      {iconPicker && <EmojiPicker anchor={iconPicker} onSelect={saveIcon} onRemove={icon ? () => saveIcon(null) : undefined} onClose={() => setIconPicker(null)} />}
      {dialog === "history" && <HistoryDialog page={page} canRestore={editable} editor={editorRef} onClose={() => setDialog(null)} />}
      {dialog === "share" && <ShareDialog page={page} space={space} canShare={canEdit} onClose={() => setDialog(null)} />}
      {dialog === "move" && <MoveDialog page={page} space={space} onClose={() => setDialog(null)} onMoved={(target) => target !== space.id && navigate(pageUrl(spaces.find((s) => s.id === target)?.slug ?? space.slug, { slugId: page.slugId, title }))} />}
      {dialog === "export" && <ExportDialog page={page} onClose={() => setDialog(null)} />}
      {dialog === "copy" && <CopyToSpaceDialog page={page} space={space} onClose={() => setDialog(null)} />}
      {dialog === "files" && <AttachmentsDialog pageId={page.id} onClose={() => setDialog(null)} />}
    </>
  );
};
