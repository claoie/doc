import { useEffect, useState } from "react";
import type { Space, TreeItem } from "common/api-types";
import { api } from "../api";
import { useApp, treeCache } from "../store";
import { Button, Modal, Spinner, cx, errorMessage, useToast } from "../components/ui";
import { Icon } from "../components/Icon";
import { canWrite } from "../layout/Sidebar";
import { navigate, pageUrl } from "../router";

/** Picks a new parent (any page in a writable space, or the space root). */
export const MoveDialog = ({ page, space, onClose, onMoved }: { page: TreeItem; space: Space; onClose: () => void; onMoved?: (spaceId: string) => void }) => {
  const { spaces } = useApp();
  const toast = useToast();
  const [targetSpace, setTargetSpace] = useState(space.id);
  const [parentId, setParentId] = useState<string | null>(page.parentId);
  const [busy, setBusy] = useState(false);
  const writable = spaces.filter(canWrite);

  const submit = async () => {
    setBusy(true);
    try {
      if (targetSpace !== space.id) {
        await api.movePageToSpace(page.id, targetSpace);
        if (parentId) {
          await api.movePage(page.id, parentId, null);
        }
      } else {
        const siblings = await api.tree(space.id, parentId);
        const last = siblings.filter((s) => s.id !== page.id).at(-1);
        await api.movePage(page.id, parentId, last?.id ?? null);
      }
      treeCache.invalidate(space.id);
      if (targetSpace !== space.id) treeCache.invalidate(targetSpace);
      toast("Page moved", "success");
      onMoved?.(targetSpace);
      onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Move “${page.title || "Untitled"}”`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            Move here
          </Button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Space</span>
        <select
          className="input"
          value={targetSpace}
          onChange={(e) => {
            setTargetSpace(e.target.value);
            setParentId(null);
          }}
        >
          {writable.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="move-tree">
        <button type="button" className={cx("move-row", parentId === null && "active")} onClick={() => setParentId(null)}>
          <Icon name="space" size={15} /> Top level of the space
        </button>
        <MoveLevel spaceId={targetSpace} parentId={null} depth={0} exclude={page.id} selected={parentId} onSelect={setParentId} />
      </div>
    </Modal>
  );
};

const MoveLevel = ({
  spaceId,
  parentId,
  depth,
  exclude,
  selected,
  onSelect,
}: {
  spaceId: string;
  parentId: string | null;
  depth: number;
  exclude: string;
  selected: string | null;
  onSelect: (id: string) => void;
}) => {
  const [items, setItems] = useState<TreeItem[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    api
      .tree(spaceId, parentId)
      .then(setItems)
      .catch(() => setItems([]));
  }, [spaceId, parentId]);
  if (!items) return <Spinner size={14} />;
  return (
    <>
      {items
        .filter((i) => i.id !== exclude)
        .map((item) => (
          <div key={item.id}>
            <div className={cx("move-row", selected === item.id && "active")} style={{ paddingLeft: 8 + depth * 16 }}>
              <button
                type="button"
                className={cx("tree-toggle", !item.hasChildren && "invisible")}
                onClick={() => setOpen((s) => new Set(s.has(item.id) ? [...s].filter((x) => x !== item.id) : [...s, item.id]))}
              >
                <Icon name={open.has(item.id) ? "chevronDown" : "chevronRight"} size={13} />
              </button>
              <button type="button" className="move-row-label" onClick={() => onSelect(item.id)}>
                <span>{item.icon || "📄"}</span> {item.title || "Untitled"}
              </button>
            </div>
            {open.has(item.id) && <MoveLevel spaceId={spaceId} parentId={item.id} depth={depth + 1} exclude={exclude} selected={selected} onSelect={onSelect} />}
          </div>
        ))}
    </>
  );
};

/** Copies a page and its subpages into another space. */
export const CopyToSpaceDialog = ({ page, space, onClose }: { page: TreeItem; space: Space; onClose: () => void }) => {
  const { spaces } = useApp();
  const toast = useToast();
  const targets = spaces.filter((s) => canWrite(s) && s.id !== space.id);
  const [target, setTarget] = useState(targets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const destination = spaces.find((s) => s.id === target);
    if (!destination) return;
    setBusy(true);
    try {
      const { page: copy } = await api.duplicatePage(page.id, destination.id);
      treeCache.invalidate(destination.id);
      toast(`Copied to ${destination.name}`, "success");
      onClose();
      navigate(pageUrl(destination.slug, copy));
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Copy “${page.title || "Untitled"}” to another space`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!target}>
            Copy
          </Button>
        </>
      }
    >
      {targets.length === 0 ? (
        <p className="muted">There is no other space you can add pages to.</p>
      ) : (
        <label className="field">
          <span className="field-label">Space</span>
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <span className="field-hint">The page and its subpages are copied; the original stays where it is.</span>
        </label>
      )}
    </Modal>
  );
};
