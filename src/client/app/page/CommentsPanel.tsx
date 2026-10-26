import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Comment, Page, Space } from "common/api-types";
import type { Node } from "common/editor/model";
import { docToHtml } from "common/editor/html";
import { emptyDoc } from "common/editor/doc-schema";
import { Editor } from "../../editor/editor";
import { createNodeViews } from "../../editor/nodeviews";
import { api } from "../api";
import { realtime } from "../realtime";
import { useApp } from "../store";
import { Avatar, Button, IconButton, MenuButton, Spinner, cx, errorMessage, timeAgo, useConfirm, useToast } from "../components/ui";
import { EditorMenus } from "./editor-ui/EditorMenus";
import type { PageEditorHandle } from "./PageEditor";

const isEmptyDoc = (doc: Node) =>
  !(doc.content ?? []).some((b) => (b.content ?? []).some((c) => c.type !== "text" || c.text!.trim()));

/** A small rich-text editor for comment bodies. */
const CommentEditor = ({
  space,
  pageId,
  initial,
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  space: Space;
  pageId: string;
  initial?: Node;
  placeholder: string;
  submitLabel: string;
  onSubmit: (doc: Node) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) => {
  const mount = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [empty, setEmpty] = useState(!initial);
  const submitRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!mount.current) return;
    let ed: Editor | null = null;
    ed = new Editor(mount.current, {
      doc: initial ?? emptyDoc(),
      nodeViews: createNodeViews({ editor: () => ed, fileUrl: (s) => s }),
      placeholder,
      keyHandlers: [
        (_e, ev) => {
          if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
            submitRef.current();
            return true;
          }
          if (ev.key === "Escape" && onCancel) {
            onCancel();
            return true;
          }
          return false;
        },
      ],
    });
    ed.view.dom.classList.add("comment-editor-content");
    const off = ed.onUpdate(() => setEmpty(isEmptyDoc(ed!.state.doc)));
    setEditor(ed);
    if (autoFocus) setTimeout(() => ed?.focus(), 30);
    return () => {
      off();
      ed?.destroy();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!editor || isEmptyDoc(editor.state.doc) || busy) return;
    setBusy(true);
    try {
      await onSubmit(editor.state.doc);
    } finally {
      setBusy(false);
    }
  };
  submitRef.current = () => void submit();

  return (
    <div className="comment-editor">
      <div ref={mount} />
      {editor && <EditorMenus editor={editor} pageId={pageId} space={space} minimal />}
      <div className="comment-editor-actions">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button variant="primary" onClick={submit} disabled={empty} loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
};

export const CommentsPanel = ({
  page,
  space,
  canComment,
  editor,
  activeComment,
  setActiveComment,
  onClose,
}: {
  page: Page;
  space: Space;
  canComment: boolean;
  editor: RefObject<PageEditorHandle | null>;
  activeComment: string | null;
  setActiveComment: (id: string | null) => void;
  onClose: () => void;
}) => {
  const { user } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState<{ from: number; to: number; text: string } | null>(() => editor.current?.pendingSelection() ?? null);
  const [editing, setEditing] = useState<string | null>(null);
  const [replying, setReplying] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .comments(page.id)
      .then(setComments)
      .catch((e) => toast(errorMessage(e), "error"));
  }, [page.id, toast]);

  useEffect(() => {
    load();
    return realtime.onEvent((e) => e.kind === "comments" && e.pageId === page.id && load());
  }, [load, page.id]);

  // A new selection-comment request arrives while the panel is open.
  useEffect(() => {
    const pending = editor.current?.pendingSelection();
    if (pending && activeComment === null) setDraft(pending);
  }, [activeComment, editor]);

  useEffect(() => {
    if (!activeComment) return;
    document.getElementById(`comment-${activeComment}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [activeComment, comments]);

  useEffect(() => {
    const hash = location.hash.match(/^#comment-(.+)$/)?.[1];
    if (hash) setActiveComment(hash);
  }, [setActiveComment]);

  const threads = (comments ?? []).filter((c) => !c.parentId);
  const visible = threads.filter((c) => showResolved || !c.resolvedAt);
  const replies = (id: string) => (comments ?? []).filter((c) => c.parentId === id);

  const create = async (body: Node, parentId?: string) => {
    try {
      const anchored = !parentId && !!draft;
      const { comment } = await api.createComment({ pageId: page.id, parentId, body, quote: parentId ? null : (draft?.text ?? null), anchored });
      if (anchored && draft) editor.current?.addComment(comment.id, draft.from, draft.to);
      setDraft(null);
      setReplying(null);
      setActiveComment(parentId ?? comment.id);
      load();
    } catch (e) {
      toast(errorMessage(e), "error");
      throw e;
    }
  };

  const focusInEditor = (c: Comment) => {
    setActiveComment(c.id);
    const range = editor.current?.commentRanges().get(c.id);
    if (range) editor.current?.scrollToPos(range.from);
  };

  return (
    <aside className="side-panel comments-panel" aria-label="Comments">
      <div className="side-panel-head">
        <h2>Comments</h2>
        <div className="row gap-s">
          <button type="button" className={cx("chip", showResolved && "active")} onClick={() => setShowResolved((s) => !s)}>
            Resolved
          </button>
          <IconButton icon="x" label="Close comments" onClick={onClose} />
        </div>
      </div>
      <div className="side-panel-body">
        {canComment && (
          <div className="comment-new">
            {draft && <blockquote className="comment-quote">{draft.text}</blockquote>}
            <CommentEditor
              key={draft ? `${draft.from}-${draft.to}` : "page"}
              space={space}
              pageId={page.id}
              placeholder={draft ? "Comment on the selected text" : "Add a comment to this page"}
              submitLabel="Comment"
              autoFocus={!!draft}
              onSubmit={(body) => create(body)}
              onCancel={draft ? () => setDraft(null) : undefined}
            />
          </div>
        )}
        {!comments && <Spinner />}
        {comments && !visible.length && <div className="muted pad">No comments yet.</div>}
        {visible.map((c) => (
          <div key={c.id} id={`comment-${c.id}`} className={cx("comment-thread", activeComment === c.id && "active", c.resolvedAt && "resolved")} onClick={() => focusInEditor(c)}>
            {c.quote && <blockquote className="comment-quote">{c.quote}</blockquote>}
            {[c, ...replies(c.id)].map((item) => (
              <div key={item.id} className="comment">
                <div className="comment-head">
                  <Avatar name={item.author?.name} url={item.author?.avatarUrl} size={22} />
                  <span className="comment-author">{item.author?.name ?? "Deleted user"}</span>
                  <span className="muted small">
                    {timeAgo(item.createdAt)}
                    {item.editedAt && " · edited"}
                  </span>
                  {(item.author?.id === user.id || space.role === "admin") && (
                    <span className="comment-menu" onClick={(e) => e.stopPropagation()}>
                      <MenuButton
                        items={[
                          ...(item.author?.id === user.id ? [{ label: "Edit", icon: "edit" as const, onSelect: () => setEditing(item.id) }] : []),
                          {
                            label: "Delete",
                            icon: "trash",
                            danger: true,
                            onSelect: async () => {
                              const ok = await confirm({ title: "Delete comment?", message: item.parentId ? undefined : "Replies will be deleted too.", confirmLabel: "Delete", danger: true });
                              if (!ok) return;
                              try {
                                await api.deleteComment(item.id);
                                if (!item.parentId) editor.current?.removeComment(item.id);
                                load();
                              } catch (e) {
                                toast(errorMessage(e), "error");
                              }
                            },
                          },
                        ]}
                      >
                        {(open) => <IconButton icon="more" label="Comment actions" size={15} onClick={(e) => open(e.currentTarget)} />}
                      </MenuButton>
                    </span>
                  )}
                </div>
                {editing === item.id ? (
                  <CommentEditor
                    space={space}
                    pageId={page.id}
                    initial={item.body}
                    placeholder="Edit comment"
                    submitLabel="Save"
                    autoFocus
                    onCancel={() => setEditing(null)}
                    onSubmit={async (body) => {
                      try {
                        await api.updateComment(item.id, body);
                        setEditing(null);
                        load();
                      } catch (e) {
                        toast(errorMessage(e), "error");
                      }
                    }}
                  />
                ) : (
                  <div className="comment-body editor-static" dangerouslySetInnerHTML={{ __html: docToHtml(item.body) }} />
                )}
              </div>
            ))}
            {canComment && (
              <div className="comment-actions" onClick={(e) => e.stopPropagation()}>
                {replying === c.id ? (
                  <CommentEditor space={space} pageId={page.id} placeholder="Reply" submitLabel="Reply" autoFocus onCancel={() => setReplying(null)} onSubmit={(body) => create(body, c.id)} />
                ) : (
                  <>
                    <button type="button" className="link-button" onClick={() => setReplying(c.id)}>
                      Reply
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      onClick={async () => {
                        try {
                          const resolved = !c.resolvedAt;
                          await api.resolveComment(c.id, resolved);
                          editor.current?.setCommentResolved(c.id, resolved);
                          load();
                        } catch (e) {
                          toast(errorMessage(e), "error");
                        }
                      }}
                    >
                      {c.resolvedAt ? "Reopen" : "Resolve"}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
};
