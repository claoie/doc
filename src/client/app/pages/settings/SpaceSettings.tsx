import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Group, ShareWithPage, Space, SpaceMember, SpaceRole } from "common/api-types";
import { api } from "../../api";
import { Link, navigate, pageUrl } from "../../router";
import { useApp } from "../../store";
import { Avatar, Button, Field, IconButton, Input, Modal, Spinner, errorMessage, useConfirm, useToast } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { SettingsSection } from "./SettingsPage";
import { UserPicker } from "./GroupsSettings";

export const SpaceSettings = ({ spaceSlug }: { spaceSlug: string }) => {
  const { refreshSpaces, isAdmin } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [space, setSpace] = useState<Space | null>(null);
  const [members, setMembers] = useState<SpaceMember[] | null>(null);
  const [shares, setShares] = useState<ShareWithPage[]>([]);
  const [form, setForm] = useState({ name: "", slug: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<"users" | "groups" | null>(null);
  const [addRole, setAddRole] = useState<SpaceRole>("writer");
  const [exportFormat, setExportFormat] = useState<"markdown" | "html">("markdown");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const { space: s } = await api.space(spaceSlug);
      setSpace(s);
      setForm({ name: s.name, slug: s.slug, description: s.description ?? "" });
      setMembers(await api.spaceMembers(s.id));
      setShares(await api.spaceShares(s.id).catch(() => []));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }, [spaceSlug, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!space) return <Spinner />;
  const admin = space.role === "admin" || (isAdmin && !space.role);
  document.title = `${space.name} settings`;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { space: next } = await api.updateSpace(space.id, { name: form.name.trim(), slug: form.slug.trim(), description: form.description.trim() });
      setSpace(next);
      await refreshSpaces();
      if (next.slug !== spaceSlug) navigate(`/s/${next.slug}/settings`, { replace: true });
      toast("Space saved", "success");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const memberAction = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setMembers(await api.spaceMembers(space.id));
      await refreshSpaces();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <>
      <div className="settings-back">
        <Link to={`/s/${space.slug}`}>
          <Icon name="arrowLeft" size={14} /> {space.name}
        </Link>
      </div>
      <SettingsSection title="Space">
        {admin && (
          <div className="avatar-row">
            {space.iconUrl ? <img src={space.iconUrl} alt="" className="logo-preview" /> : <span className="logo-preview">{space.name.slice(0, 1)}</span>}
            <div className="row gap-s">
              <Button icon="upload" onClick={() => fileRef.current?.click()}>
                Upload icon
              </Button>
              {space.iconUrl && (
                <Button variant="ghost" onClick={async () => setSpace((await api.removeSpaceIcon(space.id)).space)}>
                  Remove
                </Button>
              )}
              <input
                ref={fileRef}
                hidden
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    setSpace((await api.uploadSpaceIcon(space.id, file)).space);
                    await refreshSpaces();
                  } catch (err) {
                    toast(errorMessage(err), "error");
                  }
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        )}
        <form className="form" onSubmit={save}>
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} disabled={!admin} required maxLength={100} />
          </Field>
          <Field label="URL slug" hint="Changing it breaks old links to this space's pages.">
            <Input value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }))} disabled={!admin} required maxLength={50} />
          </Field>
          <Field label="Description">
            <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} disabled={!admin} maxLength={500} />
          </Field>
          {admin && (
            <div>
              <Button variant="primary" type="submit" loading={busy}>
                Save
              </Button>
            </div>
          )}
        </form>
      </SettingsSection>

      <SettingsSection
        title="Members"
        actions={
          admin && (
            <div className="row gap-s">
              <select className="input input-compact" value={addRole} onChange={(e) => setAddRole(e.target.value as SpaceRole)} aria-label="Role for new members">
                <option value="admin">Admin</option>
                <option value="writer">Writer</option>
                <option value="reader">Reader</option>
              </select>
              <Button icon="user" onClick={() => setAdding("users")}>
                Add people
              </Button>
              <Button icon="users" onClick={() => setAdding("groups")}>
                Add groups
              </Button>
            </div>
          )
        }
      >
        {!members && <Spinner />}
        <div className="list">
          {members?.map((m) => (
            <div key={m.id} className="list-row">
              {m.user ? <Avatar name={m.user.name} url={m.user.avatarUrl} size={28} /> : <span className="group-icon"><Icon name="users" size={16} /></span>}
              <div className="list-main">
                <div>{m.user?.name ?? m.group?.name}</div>
                <div className="muted small">{m.user ? m.user.email : `Group · ${m.group?.memberCount ?? 0} members`}</div>
              </div>
              {admin ? (
                <>
                  <select className="input input-compact" value={m.role} onChange={(e) => memberAction(() => api.changeSpaceMemberRole(space.id, m.id, e.target.value as SpaceRole))}>
                    <option value="admin">Admin</option>
                    <option value="writer">Writer</option>
                    <option value="reader">Reader</option>
                  </select>
                  <IconButton icon="x" label="Remove" onClick={() => memberAction(() => api.removeSpaceMember(space.id, m.id))} />
                </>
              ) : (
                <span className="muted">{m.role}</span>
              )}
            </div>
          ))}
        </div>
      </SettingsSection>

      {admin && (
        <SettingsSection title="Sharing">
          <label className="toggle-row">
            <span>
              <span className="toggle-label">Allow publishing pages from this space</span>
              <span className="muted small toggle-desc">Turning this off unpublishes every public page in the space.</span>
            </span>
            <span className="switch">
              <input
                type="checkbox"
                checked={!space.settings.sharingDisabled}
                onChange={async (e) => {
                  try {
                    const { space: next } = await api.updateSpace(space.id, { settings: { ...space.settings, sharingDisabled: !e.target.checked } });
                    setSpace(next);
                    setShares(await api.spaceShares(space.id).catch(() => []));
                  } catch (err) {
                    toast(errorMessage(err), "error");
                  }
                }}
              />
              <span />
            </span>
          </label>
          {shares.length > 0 && (
            <div className="list">
              {shares.map((s) => (
                <div key={s.id} className="list-row">
                  <Icon name="globe" size={16} />
                  <Link to={pageUrl(space.slug, s.page)} className="list-main">
                    {s.page.icon} {s.page.title || "Untitled"}
                  </Link>
                  <a href={s.url} target="_blank" rel="noopener" className="muted small">
                    Public link
                  </a>
                </div>
              ))}
            </div>
          )}
        </SettingsSection>
      )}

      {admin && (
        <SettingsSection title="Export" description="Download every page in this space as a zip file.">
          <div className="row gap-s">
            <select className="input input-compact" value={exportFormat} onChange={(e) => setExportFormat(e.target.value as "markdown" | "html")}>
              <option value="markdown">Markdown</option>
              <option value="html">HTML</option>
            </select>
            <a className="btn" href={api.spaceExportUrl(space.id, exportFormat, true)} download>
              <Icon name="download" size={16} /> Export space
            </a>
          </div>
        </SettingsSection>
      )}

      {admin && (
        <SettingsSection title="Delete space" description="Deletes the space, all its pages and files. This cannot be undone.">
          <div>
            <Button
              variant="danger"
              onClick={async () => {
                const ok = await confirm({ title: `Delete ${space.name}?`, message: "Every page and file in this space will be deleted permanently.", confirmLabel: "Delete space", danger: true });
                if (!ok) return;
                try {
                  await api.deleteSpace(space.id);
                  await refreshSpaces();
                  navigate("/");
                } catch (e) {
                  toast(errorMessage(e), "error");
                }
              }}
            >
              Delete space
            </Button>
          </div>
        </SettingsSection>
      )}

      {adding === "users" && (
        <UserPicker
          title={`Add people as ${addRole}`}
          exclude={members?.filter((m) => m.user).map((m) => m.user!.id) ?? []}
          onClose={() => setAdding(null)}
          onPick={(ids) => memberAction(() => api.addSpaceMembers(space.id, addRole, ids, []))}
        />
      )}
      {adding === "groups" && (
        <GroupPicker
          exclude={members?.filter((m) => m.group).map((m) => m.group!.id) ?? []}
          onClose={() => setAdding(null)}
          onPick={(ids) => memberAction(() => api.addSpaceMembers(space.id, addRole, [], ids))}
        />
      )}
    </>
  );
};

const GroupPicker = ({ exclude, onClose, onPick }: { exclude: string[]; onClose: () => void; onPick: (ids: string[]) => Promise<void> }) => {
  const [groups, setGroups] = useState<Group[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    api
      .groups()
      .then((g) => setGroups(g.filter((x) => !exclude.includes(x.id))))
      .catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal
      title="Add groups"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!picked.length}
            onClick={async () => {
              await onPick(picked);
              onClose();
            }}
          >
            Add
          </Button>
        </>
      }
    >
      <div className="list">
        {groups.map((g) => (
          <label key={g.id} className="list-row clickable">
            <input type="checkbox" checked={picked.includes(g.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, g.id] : p.filter((x) => x !== g.id)))} />
            <div className="list-main">
              <div>{g.name}</div>
              <div className="muted small">{g.memberCount} members</div>
            </div>
          </label>
        ))}
        {!groups.length && <div className="muted pad">No more groups to add.</div>}
      </div>
    </Modal>
  );
};
