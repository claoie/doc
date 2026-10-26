import { useEffect, useState, type RefObject } from "react";
import type { Page, PageVersion, PageVersionSummary } from "common/api-types";
import { docToHtml } from "common/editor/html";
import { diffDocs } from "./diff";
import { api } from "../api";
import { Avatar, Button, Modal, Spinner, cx, errorMessage, formatDateTime, useConfirm, useToast } from "../components/ui";
import type { PageEditorHandle } from "./PageEditor";

export const HistoryDialog = ({ page, canRestore, editor, onClose }: { page: Page; canRestore: boolean; editor: RefObject<PageEditorHandle | null>; onClose: () => void }) => {
  const toast = useToast();
  const confirm = useConfirm();
  const [versions, setVersions] = useState<PageVersionSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState<PageVersion | null>(null);
  const [previous, setPrevious] = useState<PageVersion | null>(null);
  const [showChanges, setShowChanges] = useState(false);

  useEffect(() => {
    api
      .versions(page.id)
      .then((v) => {
        setVersions(v);
        if (v[0]) setSelected(v[0].id);
      })
      .catch((e) => toast(errorMessage(e), "error"));
  }, [page.id, toast]);

  useEffect(() => {
    if (!selected) return;
    setVersion(null);
    setPrevious(null);
    api
      .version(selected)
      .then(setVersion)
      .catch((e) => toast(errorMessage(e), "error"));
    const index = versions?.findIndex((v) => v.id === selected) ?? -1;
    const older = index >= 0 ? versions?.[index + 1] : undefined;
    if (older) api.version(older.id).then(setPrevious).catch(() => undefined);
  }, [selected, toast, versions]);

  const restore = async () => {
    if (!version?.content) return;
    const ok = await confirm({
      title: "Restore this version?",
      message: `The page will be replaced with the version from ${formatDateTime(version.createdAt)}. The current content stays in history.`,
      confirmLabel: "Restore",
    });
    if (!ok) return;
    editor.current?.replaceDoc(version.content);
    if (version.title !== page.title && version.title !== null) await api.updatePage(page.id, { title: version.title }).catch(() => undefined);
    toast("Version restored", "success");
    onClose();
  };

  return (
    <Modal title="Page history" onClose={onClose} width={1000}>
      <div className="history">
        <div className="history-list">
          {!versions && <Spinner />}
          {versions?.length === 0 && <div className="muted pad">No saved versions yet. Versions are saved a few minutes after editing.</div>}
          {versions?.map((v) => (
            <button key={v.id} type="button" className={cx("history-item", v.id === selected && "active")} onClick={() => setSelected(v.id)}>
              <span className="history-date">{formatDateTime(v.createdAt)}</span>
              <span className="history-editor">
                <Avatar name={v.editor?.name} url={v.editor?.avatarUrl} size={16} /> {v.editor?.name ?? "Unknown"}
              </span>
            </button>
          ))}
        </div>
        <div className="history-preview">
          {selected && !version && <Spinner />}
          {version && (
            <>
              <div className="history-preview-head">
                <h1 className="history-title">{version.title || "Untitled"}</h1>
                <label className="check-row history-toggle">
                  <input type="checkbox" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} disabled={!previous} />
                  <span>Highlight changes</span>
                </label>
                {canRestore && (
                  <Button variant="primary" icon="restore" onClick={restore}>
                    Restore this version
                  </Button>
                )}
              </div>
              {showChanges && previous ? (
                <div className="history-diff">
                  {diffDocs(previous.content, version.content).map((parts, i) => (
                    <p key={i} className={parts.every((p) => p.kind === "added") ? "diff-block-added" : parts.every((p) => p.kind === "removed") ? "diff-block-removed" : undefined}>
                      {parts.map((p, j) => (p.kind === "same" ? <span key={j}>{p.text}</span> : p.kind === "added" ? <ins key={j}>{p.text}</ins> : <del key={j}>{p.text}</del>))}
                    </p>
                  ))}
                </div>
              ) : (
                <div className="editor editor-static" dangerouslySetInnerHTML={{ __html: version.content ? docToHtml(version.content) : "" }} />
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};
