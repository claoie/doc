import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Page, Space } from "common/api-types";
import type { Mark, Node } from "common/editor/model";
import { schema, emptyDoc } from "common/editor/doc-schema";
import { CollabClient } from "common/editor/collab";
import { uuid } from "common/ids";
import { Transaction, createState } from "common/editor/state";
import { descendants, nodeSize, nodesToItems, textBetween } from "common/editor/tokens";
import { textblockStartAfter } from "common/editor/commands";
import { Editor } from "../../editor/editor";
import { createNodeViews, type EditorContext } from "../../editor/nodeviews";
import { api } from "../api";
import { navigate, pageUrl } from "../router";
import { realtime, type PresenceUser } from "../realtime";
import { useApp } from "../store";
import { errorMessage, useToast, userColor } from "../components/ui";
import { EditorMenus, FixedToolbar } from "./editor-ui/EditorMenus";
import { RemoteCarets } from "./editor-ui/RemoteCarets";
import { insertUploadedFiles } from "./editor-ui/uploads";
import { openDiagramEditor } from "./editor-ui/diagrams";
import { loadMermaid } from "./editor-ui/mermaid";
import { BaseView } from "../base/BaseView";

export interface Heading {
  id: string | null;
  pos: number;
  level: number;
  text: string;
}

export interface PageEditorHandle {
  clientId: string;
  editor: () => Editor | null;
  focusStart: () => void;
  headings: () => Heading[];
  scrollToPos: (pos: number) => void;
  subscribe: (fn: () => void) => () => void;
  /** Ranges carrying a comment mark, by comment id. */
  commentRanges: () => Map<string, { from: number; to: number; text: string }>;
  addComment: (commentId: string, from: number, to: number) => void;
  setCommentResolved: (commentId: string, resolved: boolean) => void;
  removeComment: (commentId: string) => void;
  /** Replaces the whole document (restoring a version). */
  replaceDoc: (doc: Node) => void;
  pendingSelection: () => { from: number; to: number; text: string } | null;
}

const clientIdFor = () => uuid().slice(0, 12);

export const PageEditor = forwardRef<
  PageEditorHandle,
  {
    page: Page;
    space: Space;
    editable: boolean;
    onPresence: (users: PresenceUser[]) => void;
    /** Called when the server says whether this user may edit (it can change while the page is open). */
    onReadOnly?: (readOnly: boolean) => void;
    onOpenComments: (commentId: string | null) => void;
    activeComment: string | null;
  }
>(({ page, space, editable, onPresence, onReadOnly, onOpenComments, activeComment }, ref) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const listeners = useRef(new Set<() => void>());
  const clientId = useRef(clientIdFor()).current;
  const [editor, setEditor] = useState<Editor | null>(null);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [status, setStatus] = useState<"syncing" | "saved" | "offline" | "error">("saved");
  const { user } = useApp();
  const toast = useToast();
  const editableRef = useRef(editable);
  const readOnlyFromServer = useRef(false);
  const onReadOnlyRef = useRef(onReadOnly);
  onReadOnlyRef.current = onReadOnly;
  const pendingSel = useRef<{ from: number; to: number; text: string } | null>(null);
  const [embeds, setEmbeds] = useState<{ key: string; el: HTMLElement; pageId: string; remove: () => void }[]>([]);
  const embedSeq = useRef(0);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const ctx: EditorContext = {
      editor: () => editorRef.current,
      pageId: page.id,
      fileUrl: (src) => src,
      uploadFile: (file, replaceId) => api.uploadFile(file, page.id, replaceId),
      childPages: async (pageId) => {
        const items = await api.tree(space.id, pageId);
        return items.map((i) => ({ id: i.id, title: i.title, icon: i.icon, href: pageUrl(space.slug, i) }));
      },
      lookupSynced: async (pageId, blockId) => {
        const [result] = await api.lookupSynced([{ pageId, blockId }]);
        return result?.content ?? null;
      },
      pageHref: (slugId, anchor) => `/p/${slugId}${anchor ? `#${anchor}` : ""}`,
      openPage: async (slugId, anchor) => {
        try {
          const d = await api.page(slugId);
          navigate(pageUrl(d.space.slug, d.page, anchor));
        } catch (e) {
          toast(errorMessage(e), "error");
        }
      },
      openDiagram: (kind, attrs, save) => openDiagramEditor(kind, attrs, page.id, save),
      loadMermaid,
      mountBase: (el, pageId, remove) => {
        const key = `base-${++embedSeq.current}`;
        setEmbeds((list) => [...list, { key, el, pageId, remove }]);
        return () => setEmbeds((list) => list.filter((e) => e.key !== key));
      },
    };

    const collab = new CollabClient(clientId, page.docVersion);
    let inFlight = false;
    let sendTimer: ReturnType<typeof setTimeout> | null = null;
    let sendAfterComposition = false;
    let incomingHeld = false;

    const send = (force = false) => {
      sendTimer = null;
      if (inFlight || !realtime.connected) return;
      // Steps that arrived during the composition wait for it, so the version is stale until then.
      if (incomingHeld && !force) {
        if (!sendAfterComposition) {
          sendAfterComposition = true;
          ed.view.whenNotComposing(() => {
            sendAfterComposition = false;
            scheduleSend();
          });
        }
        return;
      }
      const out = collab.sendable();
      if (!out) {
        setStatus("saved");
        return;
      }
      inFlight = true;
      setStatus("syncing");
      realtime.send({ t: "steps", pageId: page.id, version: out.version, steps: out.steps, clientId });
    };
    const scheduleSend = () => {
      if (!sendTimer) sendTimer = setTimeout(send, 60);
    };

    const ed = new Editor(mount, {
      doc: page.content ?? emptyDoc(),
      editable: false,
      nodeViews: createNodeViews(ctx),
      placeholder: "Start writing, or type '/' for commands",
      onUpdate: (_e, tr) => {
        listeners.current.forEach((l) => l());
        if (tr?.selectionSet || tr?.docChanged) sendPresence();
      },
      onLocalChange: (_e, tr) => {
        collab.addLocal(tr);
        setStatus("syncing");
        scheduleSend();
      },
      uploadFiles: (files, e) => insertUploadedFiles(e, files, page.id, (msg) => toast(msg, "error")),
    });
    editorRef.current = ed;
    setEditor(ed);

    let presenceTimer: ReturnType<typeof setTimeout> | null = null;
    const sendPresence = () => {
      if (presenceTimer) return;
      presenceTimer = setTimeout(() => {
        presenceTimer = null;
        const sel = ed.view.focused ? ed.state.selection : null;
        realtime.send({ t: "presence", pageId: page.id, selection: sel ? { anchor: sel.anchor, head: sel.head } : null });
      }, 120);
    };

    const applyEditable = () => ed.setEditable(editableRef.current && !readOnlyFromServer.current);

    const close = realtime.openPage(
      page.id,
      {
        onJoined: (msg) => {
          readOnlyFromServer.current = msg.readOnly;
          onReadOnlyRef.current?.(msg.readOnly);
          if (msg.doc) {
            // Too far behind to catch up step by step: start from the server's document.
            const fresh = createState(schema, msg.doc);
            const start = textblockStartAfter(msg.doc, 0, schema) ?? 0;
            ed.state = { ...fresh, selection: { anchor: start, head: start } };
            ed.view.updateState(ed.state);
            collab.version = msg.version;
            collab.unconfirmed = [];
          }
          inFlight = false;
          applyEditable();
          setStatus(collab.sendable() ? "syncing" : "saved");
          scheduleSend();
          sendPresence();
        },
        onSteps: (msg) => {
          if (ed.view.isComposing && !incomingHeld) {
            incomingHeld = true;
            ed.view.whenNotComposing(() => {
              incomingHeld = false;
            });
          }
          ed.view.whenNotComposing(() => {
            const base = msg.version - msg.steps.length;
            if (base !== collab.version) {
              // Missed something; ask the server to bring us up to date.
              realtime.send({ t: "join", pageId: page.id, version: collab.version, clientId });
              return;
            }
            const ownConfirmed = msg.clientIds.some((id) => id === clientId);
            const tr = collab.receive(ed.state, msg.steps, msg.clientIds);
            if (ownConfirmed) inFlight = false;
            if (tr) ed.dispatch(tr);
            if (collab.sendable()) scheduleSend();
            else if (!inFlight) setStatus("saved");
          });
        },
        onRejected: () => {
          inFlight = false;
          // The server follows a rejection with the steps we are missing.
          setTimeout(scheduleSend, 200);
        },
        onPresence: (users) => {
          setPresence(users);
          onPresence(users);
        },
        onError: (message) => {
          setStatus("error");
          toast(message, "error");
        },
        onReconnect: () => {
          inFlight = false;
          realtime.send({ t: "join", pageId: page.id, version: collab.version, clientId });
        },
      },
      page.docVersion,
      clientId,
    );
    const offStatus = realtime.onStatus((s) => {
      if (s === "closed") setStatus("offline");
    });

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (collab.sendable()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (collab.sendable()) send(true);
      close();
      offStatus();
      if (sendTimer) clearTimeout(sendTimer);
      if (presenceTimer) clearTimeout(presenceTimer);
      ed.destroy();
      editorRef.current = null;
    };
  }, [page.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    editableRef.current = editable;
    editor?.setEditable(editable && !readOnlyFromServer.current);
  }, [editable, editor]);

  // Highlight the active comment's ranges.
  useEffect(() => {
    const root = mountRef.current;
    if (!root) return;
    root.querySelectorAll(".comment-mark.active").forEach((el) => el.classList.remove("active"));
    if (activeComment) root.querySelectorAll(`.comment-mark[data-comment-id="${CSS.escape(activeComment)}"]`).forEach((el) => el.classList.add("active"));
  });

  useImperativeHandle(
    ref,
    () => ({
      clientId,
      editor: () => editorRef.current,
      focusStart: () => {
        const ed = editorRef.current;
        if (!ed) return;
        const start = textblockStartAfter(ed.state.doc, 0, schema) ?? 0;
        const tr = new Transaction(ed.state);
        tr.setSelection({ anchor: start, head: start });
        ed.dispatch(tr);
        ed.focus();
      },
      headings: () => {
        const ed = editorRef.current;
        if (!ed) return [];
        const out: Heading[] = [];
        descendants(ed.state.doc, schema, (node, pos) => {
          if (node.type === "heading") {
            out.push({ id: (node.attrs?.id as string) ?? null, pos, level: Number(node.attrs?.level) || 1, text: (node.content ?? []).map((c) => c.text ?? "").join("") });
            return false;
          }
          return node.type !== "paragraph" && node.type !== "codeBlock";
        });
        return out;
      },
      scrollToPos: (pos) => {
        const dom = editorRef.current?.view.nodeDOM(pos);
        dom?.scrollIntoView({ behavior: "smooth", block: "start" });
      },
      subscribe: (fn) => {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
      commentRanges: () => {
        const ed = editorRef.current;
        const map = new Map<string, { from: number; to: number; text: string }>();
        if (!ed) return map;
        descendants(ed.state.doc, schema, (node, pos) => {
          const mark = node.marks?.find((m) => m.type === "comment");
          if (mark && node.type === "text") {
            const id = String(mark.attrs?.commentId);
            const end = pos + nodeSize(node, schema);
            const prev = map.get(id);
            map.set(id, prev ? { from: Math.min(prev.from, pos), to: Math.max(prev.to, end), text: prev.text + (node.text ?? "") } : { from: pos, to: end, text: node.text ?? "" });
          }
          return true;
        });
        return map;
      },
      addComment: (commentId, from, to) => {
        const ed = editorRef.current;
        if (!ed) return;
        const tr = new Transaction(ed.state);
        tr.addMark(from, to, schema.mark("comment", { commentId, resolved: false }));
        ed.dispatch(tr);
      },
      setCommentResolved: (commentId, resolved) => {
        const ed = editorRef.current;
        if (!ed) return;
        const tr = new Transaction(ed.state);
        forEachCommentMark(ed.state.doc, commentId, (from, to, mark) => {
          tr.removeMark(from, to, mark);
          tr.addMark(from, to, schema.mark("comment", { commentId, resolved }));
        });
        if (tr.docChanged) ed.dispatch(tr);
      },
      removeComment: (commentId) => {
        const ed = editorRef.current;
        if (!ed) return;
        const tr = new Transaction(ed.state);
        forEachCommentMark(ed.state.doc, commentId, (from, to, mark) => tr.removeMark(from, to, mark));
        if (tr.docChanged) ed.dispatch(tr);
      },
      replaceDoc: (doc) => {
        const ed = editorRef.current;
        if (!ed) return;
        const tr = new Transaction(ed.state);
        const size = (ed.state.doc.content ?? []).reduce((s, n) => s + nodeSize(n, schema), 0);
        const items = (doc.content ?? []).length ? doc.content! : emptyDoc().content;
        tr.replace(0, size, nodesToItems(items, schema));
        tr.setSelection({ anchor: 1, head: 1 });
        ed.dispatch(tr);
      },
      pendingSelection: () => pendingSel.current,
    }),
    [clientId],
  );

  return (
    <div className="page-editor">
      <div className={`sync-status sync-${status}`} title={status === "saved" ? "All changes saved" : status === "syncing" ? "Saving…" : status === "offline" ? "Offline — changes will sync when you reconnect" : "Sync error"}>
        {status === "syncing" ? "Saving…" : status === "offline" ? "Offline" : status === "error" ? "Sync error" : "Saved"}
      </div>
      {editor && editable && user.preferences.editorToolbar && <FixedToolbar editor={editor} pageId={page.id} />}
      <div ref={mountRef} className="editor-mount" />
      {editor && (
        <EditorMenus
          editor={editor}
          pageId={page.id}
          space={space}
          onComment={(from, to) => {
            pendingSel.current = { from, to, text: textBetween(editor.state.doc, from, to, schema, " ") };
            onOpenComments(null);
          }}
          onClickComment={(id) => onOpenComments(id)}
        />
      )}
      {editor && <RemoteCarets editor={editor} users={presence.filter((p) => p.clientId !== clientId)} selfId={user.id} color={userColor} />}
      {embeds.map((e) => createPortal(<BaseView pageId={e.pageId} editable={editable} embedded onRemove={editable ? e.remove : undefined} />, e.el, e.key))}
    </div>
  );
});

PageEditor.displayName = "PageEditor";

const forEachCommentMark = (doc: Node, commentId: string, fn: (from: number, to: number, mark: Mark) => void) => {
  const hits: [number, number, Mark][] = [];
  descendants(doc, schema, (node, pos) => {
    const mark = node.marks?.find((m) => m.type === "comment" && m.attrs?.commentId === commentId);
    if (mark) hits.push([pos, pos + nodeSize(node, schema), mark]);
    return true;
  });
  for (const [from, to, mark] of hits) fn(from, to, mark);
};
