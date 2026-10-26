import { copyText } from "../../../editor/clipboard";
import { useCallback, useEffect, useState } from "react";
import type { Group, Invitation, Member, WorkspaceRole } from "common/api-types";
import { api } from "../../api";
import { useApp } from "../../store";
import { Avatar, Button, Field, IconButton, MenuButton, Modal, Spinner, errorMessage, timeAgo, useConfirm, useToast } from "../../components/ui";
import { SettingsSection } from "./SettingsPage";

const ROLE_LABEL: Record<WorkspaceRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export const MembersSettings = () => {
  const { user, isAdmin } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [query, setQuery] = useState("");
  const [members, setMembers] = useState<Member[] | null>(null);
  const [total, setTotal] = useState(0);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [inviting, setInviting] = useState(false);

  const load = useCallback(() => {
    api
      .members({ query: query.trim() || undefined, limit: 200 })
      .then((r) => {
        setMembers(r.items);
        setTotal(r.total);
      })
      .catch((e) => toast(errorMessage(e), "error"));
    if (isAdmin) api.invitations().then(setInvites).catch(() => undefined);
  }, [query, isAdmin, toast]);

  useEffect(() => {
    document.title = "Members";
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      if (success) toast(success, "success");
      load();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const canManage = (m: Member) => isAdmin && m.id !== user.id && !(m.role === "owner" && user.role !== "owner");

  return (
    <>
      <SettingsSection title="Members" description={`${total} ${total === 1 ? "person" : "people"} in this workspace.`} actions={isAdmin && <Button variant="primary" icon="plus" onClick={() => setInviting(true)}>Invite</Button>}>
        <input className="input" placeholder="Search by name or email" value={query} onChange={(e) => setQuery(e.target.value)} />
        {!members && <Spinner />}
        <div className="list">
          {members?.map((m) => (
            <div key={m.id} className="list-row">
              <Avatar name={m.name} url={m.avatarUrl} size={32} />
              <div className="list-main">
                <div>
                  {m.name} {m.id === user.id && <span className="muted">(you)</span>} {m.deactivatedAt && <span className="pill pill-warn">Deactivated</span>}
                </div>
                <div className="muted small">{m.email}</div>
              </div>
              {canManage(m) ? (
                <select className="input input-compact" value={m.role} onChange={(e) => act(() => api.changeRole(m.id, e.target.value as WorkspaceRole), "Role updated")}>
                  {user.role === "owner" && <option value="owner">Owner</option>}
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                </select>
              ) : (
                <span className="muted">{ROLE_LABEL[m.role]}</span>
              )}
              {canManage(m) && (
                <MenuButton
                  items={[
                    m.deactivatedAt
                      ? { label: "Reactivate", onSelect: () => act(() => api.activateMember(m.id), "Member reactivated") }
                      : { label: "Deactivate", onSelect: () => act(() => api.deactivateMember(m.id), "Member deactivated") },
                    {
                      label: "Remove from workspace",
                      danger: true,
                      onSelect: async () => {
                        const ok = await confirm({ title: `Remove ${m.name}?`, message: "Their account is deleted. Pages they wrote stay.", confirmLabel: "Remove", danger: true });
                        if (ok) await act(() => api.deleteMember(m.id), "Member removed");
                      },
                    },
                  ]}
                >
                  {(open) => <IconButton icon="more" label="Member actions" onClick={(e) => open(e.currentTarget)} />}
                </MenuButton>
              )}
            </div>
          ))}
        </div>
      </SettingsSection>
      {isAdmin && invites.length > 0 && (
        <SettingsSection title="Pending invitations">
          <div className="list">
            {invites.map((inv) => (
              <div key={inv.id} className="list-row">
                <div className="list-main">
                  <div>{inv.email}</div>
                  <div className="muted small">
                    {ROLE_LABEL[inv.role]} · invited {timeAgo(inv.createdAt)}
                    {inv.invitedBy && ` by ${inv.invitedBy.name}`}
                  </div>
                </div>
                <MenuButton
                  items={[
                    {
                      label: "Copy invite link",
                      icon: "link",
                      onSelect: async () => {
                        try {
                          const { url } = await api.invitationLink(inv.id);
                          if (await copyText(url)) toast("Invite link copied. Earlier links for this invite no longer work.");
                          // The earlier link was just revoked, so the new one must reach the admin somehow.
                          else window.prompt("Copy this invite link. Earlier links for this invite no longer work.", url);
                        } catch (e) {
                          toast(errorMessage(e), "error");
                        }
                      },
                    },
                    { label: "Resend email", icon: "refresh", onSelect: () => act(() => api.resendInvitation(inv.id), "Invitation sent") },
                    { label: "Revoke", icon: "x", danger: true, onSelect: () => act(() => api.revokeInvitation(inv.id), "Invitation revoked") },
                  ]}
                >
                  {(open) => <IconButton icon="more" label="Invitation actions" onClick={(e) => open(e.currentTarget)} />}
                </MenuButton>
              </div>
            ))}
          </div>
        </SettingsSection>
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} onDone={load} />}
    </>
  );
};

const InviteDialog = ({ onClose, onDone }: { onClose: () => void; onDone: () => void }) => {
  const toast = useToast();
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<{ email: string; url: string }[] | null>(null);
  useEffect(() => {
    api
      .groups()
      .then((g) => setGroups(g.filter((x) => !x.isDefault)))
      .catch(() => undefined);
  }, []);
  const submit = async () => {
    const list = emails
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (!list.length) return;
    setBusy(true);
    try {
      const created = await api.invite(list, role, groupIds);
      onDone();
      if (created.length) setLinks(created);
      else {
        toast("Everyone on that list is already a member");
        onClose();
      }
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  if (links) {
    return (
      <Modal title="Invitations sent" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <p className="muted">Each person got an email. You can also share their personal link:</p>
        <div className="list">
          {links.map((l) => (
            <div key={l.url} className="list-row">
              <div className="list-main">{l.email}</div>
              <Button icon="copy" onClick={() => void copyText(l.url).then((ok) => (ok ? toast("Link copied") : window.prompt("Copy this invite link", l.url)))}>
                Copy link
              </Button>
            </div>
          ))}
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title="Invite people"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            Send invitations
          </Button>
        </>
      }
    >
      <Field label="Email addresses" hint="Separate several with commas or new lines.">
        <textarea className="input" rows={3} value={emails} onChange={(e) => setEmails(e.target.value)} autoFocus />
      </Field>
      <Field label="Role">
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </Field>
      {groups.length > 0 && (
        <Field label="Add to groups">
          <div className="checks">
            {groups.map((g) => (
              <label key={g.id} className="check-row">
                <input type="checkbox" checked={groupIds.includes(g.id)} onChange={(e) => setGroupIds((ids) => (e.target.checked ? [...ids, g.id] : ids.filter((x) => x !== g.id)))} />
                <span>{g.name}</span>
              </label>
            ))}
          </div>
        </Field>
      )}
    </Modal>
  );
};
