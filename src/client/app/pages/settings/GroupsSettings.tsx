import { useCallback, useEffect, useState } from "react";
import type { Group, Member, User } from "common/api-types";
import { api } from "../../api";
import { Link, navigate } from "../../router";
import { useApp } from "../../store";
import { Avatar, Button, Field, IconButton, Input, Modal, Spinner, errorMessage, useConfirm, useToast } from "../../components/ui";
import { SettingsSection } from "./SettingsPage";

export const GroupsSettings = () => {
  const { isAdmin } = useApp();
  const toast = useToast();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    api
      .groups()
      .then(setGroups)
      .catch((e) => toast(errorMessage(e), "error"));
  }, [toast]);
  useEffect(() => {
    document.title = "Groups";
    load();
  }, [load]);
  return (
    <SettingsSection title="Groups" description="Grant space access to several people at once." actions={isAdmin && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New group</Button>}>
      {!groups && <Spinner />}
      <div className="list">
        {groups?.map((g) => (
          <Link key={g.id} to={`/settings/groups/${g.id}`} className="list-row clickable">
            <div className="list-main">
              <div>
                {g.name} {g.isDefault && <span className="pill">Default</span>}
              </div>
              <div className="muted small">{g.description || `${g.memberCount} ${g.memberCount === 1 ? "member" : "members"}`}</div>
            </div>
            <span className="muted">{g.memberCount}</span>
          </Link>
        ))}
      </div>
      {creating && <GroupDialog onClose={() => setCreating(false)} onSaved={(g) => navigate(`/settings/groups/${g.id}`)} />}
    </SettingsSection>
  );
};

const GroupDialog = ({ group, onClose, onSaved }: { group?: Group; onClose: () => void; onSaved: (g: Group) => void }) => {
  const toast = useToast();
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const { group: saved } = group ? await api.updateGroup(group.id, { name: group.isDefault ? undefined : name.trim(), description: description.trim() }) : await api.createGroup(name.trim(), description.trim());
      onSaved(saved);
      onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={group ? "Edit group" : "New group"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={group?.isDefault} autoFocus maxLength={50} />
      </Field>
      <Field label="Description">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
      </Field>
    </Modal>
  );
};

export const GroupDetail = ({ groupId }: { groupId: string }) => {
  const { isAdmin } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<User[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    api
      .groups()
      .then((all) => setGroup(all.find((g) => g.id === groupId) ?? null))
      .catch(() => undefined);
    api
      .groupMembers(groupId)
      .then((r) => setMembers(r.items))
      .catch((e) => toast(errorMessage(e), "error"));
  }, [groupId, toast]);
  useEffect(load, [load]);
  if (!group) return <Spinner />;
  return (
    <SettingsSection
      title={group.name}
      description={group.description ?? undefined}
      actions={
        isAdmin && (
          <div className="row gap-s">
            <Button onClick={() => setEditing(true)}>Edit</Button>
            {!group.isDefault && (
              <Button
                variant="danger"
                onClick={async () => {
                  if (!(await confirm({ title: `Delete ${group.name}?`, message: "Members lose access granted through this group.", confirmLabel: "Delete", danger: true }))) return;
                  try {
                    await api.deleteGroup(group.id);
                    navigate("/settings/groups");
                  } catch (e) {
                    toast(errorMessage(e), "error");
                  }
                }}
              >
                Delete
              </Button>
            )}
            {!group.isDefault && (
              <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
                Add members
              </Button>
            )}
          </div>
        )
      }
    >
      {group.isDefault && <p className="muted">Everyone in the workspace belongs to this group.</p>}
      {!members && <Spinner />}
      <div className="list">
        {members?.map((m) => (
          <div key={m.id} className="list-row">
            <Avatar name={m.name} url={m.avatarUrl} size={28} />
            <div className="list-main">
              <div>{m.name}</div>
              <div className="muted small">{m.email}</div>
            </div>
            {isAdmin && !group.isDefault && (
              <IconButton
                icon="x"
                label={`Remove ${m.name}`}
                onClick={async () => {
                  await api.removeGroupMember(group.id, m.id).catch((e) => toast(errorMessage(e), "error"));
                  load();
                }}
              />
            )}
          </div>
        ))}
      </div>
      {editing && <GroupDialog group={group} onClose={() => setEditing(false)} onSaved={load} />}
      {adding && <UserPicker title="Add members" exclude={members?.map((m) => m.id) ?? []} onClose={() => setAdding(false)} onPick={async (ids) => {
        await api.addGroupMembers(group.id, ids).catch((e) => toast(errorMessage(e), "error"));
        load();
      }} />}
    </SettingsSection>
  );
};

export const UserPicker = ({ title, exclude, onClose, onPick }: { title: string; exclude: string[]; onClose: () => void; onPick: (ids: string[]) => Promise<void> }) => {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<Member[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .members({ query: query.trim() || undefined, limit: 50 })
        .then((r) => setUsers(r.items.filter((u) => !exclude.includes(u.id) && !u.deactivatedAt)))
        .catch(() => undefined);
    }, 150);
    return () => clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!picked.length}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await onPick(picked);
              setBusy(false);
              onClose();
            }}
          >
            Add {picked.length || ""}
          </Button>
        </>
      }
    >
      <input className="input" autoFocus placeholder="Search people" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="list picker-list">
        {users.map((u) => (
          <label key={u.id} className="list-row clickable">
            <input type="checkbox" checked={picked.includes(u.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, u.id] : p.filter((x) => x !== u.id)))} />
            <Avatar name={u.name} url={u.avatarUrl} size={24} />
            <div className="list-main">
              <div>{u.name}</div>
              <div className="muted small">{u.email}</div>
            </div>
          </label>
        ))}
      </div>
    </Modal>
  );
};
