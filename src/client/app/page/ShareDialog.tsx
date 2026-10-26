import { copyText } from "../../editor/clipboard";
import { useEffect, useState } from "react";
import type { Page, PageShareState, Space } from "common/api-types";
import { api } from "../api";
import { Link, pageUrl } from "../router";
import { Button, Modal, Spinner, errorMessage, useToast } from "../components/ui";
import { Icon } from "../components/Icon";

export const ShareDialog = ({ page, space, canShare, onClose }: { page: Page; space: Space; canShare: boolean; onClose: () => void }) => {
  const toast = useToast();
  const [state, setState] = useState<PageShareState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .pageShare(page.id)
      .then(setState)
      .catch((e) => toast(errorMessage(e), "error"));
  }, [page.id, toast]);

  const share = state?.share;
  const update = async (body: { includeChildren?: boolean; searchIndexing?: boolean }) => {
    setBusy(true);
    try {
      const { share: next } = await api.sharePage(page.id, { includeChildren: share?.includeChildren ?? false, searchIndexing: share?.searchIndexing ?? false, ...body });
      setState((s) => ({ inheritedFrom: s?.inheritedFrom ?? null, share: next }));
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const unshare = async () => {
    setBusy(true);
    try {
      await api.unsharePage(page.id);
      setState((s) => ({ inheritedFrom: s?.inheritedFrom ?? null, share: null }));
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const internalUrl = window.location.origin + pageUrl(space.slug, page);
  const publicUrl = share ? new URL(share.url, window.location.origin).toString() : null;

  return (
    <Modal title="Share" onClose={onClose} width={520}>
      {!state && <Spinner />}
      {state && (
        <div className="share-dialog">
          <div className="share-row">
            <Icon name="lock" />
            <div className="share-row-text">
              <strong>Workspace link</strong>
              <span className="muted small">Members of {space.name} can open this page.</span>
            </div>
            <Button
              icon="copy"
              onClick={() => {
                void copyText(internalUrl).then((ok) => toast(ok ? "Link copied" : "Could not copy the link", ok ? "info" : "error"));
              }}
            >
              Copy
            </Button>
          </div>
          <div className="share-row">
            <Icon name="globe" />
            <div className="share-row-text">
              <strong>Publish to the web</strong>
              <span className="muted small">Anyone with the link can view this page without signing in.</span>
            </div>
            {canShare && (
              <label className="switch">
                <input type="checkbox" checked={!!share} disabled={busy} onChange={(e) => (e.target.checked ? update({}) : unshare())} />
                <span />
              </label>
            )}
          </div>
          {state.inheritedFrom && !share && (
            <p className="muted small">
              This page is already public through{" "}
              <Link to={pageUrl(space.slug, state.inheritedFrom.page)} onClick={onClose}>
                {state.inheritedFrom.page.title || "Untitled"}
              </Link>
              , which shares its subpages.
            </p>
          )}
          {share && publicUrl && (
            <>
              <div className="share-url">
                <input className="input" readOnly value={publicUrl} onFocus={(e) => e.target.select()} />
                <Button
                  icon="copy"
                  onClick={() => {
                    void copyText(publicUrl).then((ok) => toast(ok ? "Public link copied" : "Could not copy the link", ok ? "info" : "error"));
                  }}
                />
                <a className="btn btn-icon" href={publicUrl} target="_blank" rel="noopener" aria-label="Open public page">
                  <Icon name="external" size={16} />
                </a>
              </div>
              {canShare && (
                <>
                  <label className="check-row">
                    <input type="checkbox" checked={share.includeChildren} disabled={busy} onChange={(e) => update({ includeChildren: e.target.checked })} />
                    <span>
                      Include subpages
                      <span className="muted small"> — visitors can browse every page under this one.</span>
                    </span>
                  </label>
                  <label className="check-row">
                    <input type="checkbox" checked={share.searchIndexing} disabled={busy} onChange={(e) => update({ searchIndexing: e.target.checked })} />
                    <span>
                      Allow search engines
                      <span className="muted small"> — let search engines index the public page.</span>
                    </span>
                  </label>
                </>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
};
