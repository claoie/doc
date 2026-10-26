import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../api";
import { useApp } from "../../store";
import { Button, Field, Input, errorMessage, useToast } from "../../components/ui";
import { SettingsSection } from "./SettingsPage";

export const WorkspaceSettings = () => {
  const { workspace, setWorkspace } = useApp();
  const toast = useToast();
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? "");
  const [domains, setDomains] = useState(workspace.emailDomains.join(", "));
  const [retention, setRetention] = useState(String(workspace.settings.trashRetentionDays ?? 30));
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    document.title = "Workspace settings";
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const days = Math.max(1, Math.round(Number(retention) || 30));
      const { workspace: next } = await api.updateWorkspace({
        name: name.trim(),
        description: description.trim(),
        emailDomains: domains
          .split(/[,\s]+/)
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
        settings: { ...workspace.settings, trashRetentionDays: days },
      });
      setWorkspace(next);
      toast("Workspace saved", "success");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const setSetting = async (patch: Record<string, unknown>) => {
    try {
      const { workspace: next } = await api.updateWorkspace({ settings: { ...workspace.settings, ...patch } });
      setWorkspace(next);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  return (
    <>
      <SettingsSection title="Workspace">
        <div className="avatar-row">
          {workspace.logoUrl ? <img src={workspace.logoUrl} alt="" className="logo-preview" /> : <span className="logo-preview">{workspace.name.slice(0, 1)}</span>}
          <div className="row gap-s">
            <Button icon="upload" onClick={() => fileRef.current?.click()}>
              Upload logo
            </Button>
            {workspace.logoUrl && (
              <Button variant="ghost" onClick={async () => setWorkspace((await api.removeLogo()).workspace)}>
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
                  setWorkspace((await api.uploadLogo(file)).workspace);
                } catch (err) {
                  toast(errorMessage(err), "error");
                }
                e.target.value = "";
              }}
            />
          </div>
        </div>
        <form className="form" onSubmit={save}>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </Field>
          <Field label="Allowed email domains" hint="Only people with these email domains can be invited. Leave empty to allow any.">
            <Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com, example.org" />
          </Field>
          <Field label="Days to keep pages in trash">
            <Input type="number" min={1} max={3650} value={retention} onChange={(e) => setRetention(e.target.value)} />
          </Field>
          <div>
            <Button variant="primary" type="submit" loading={busy}>
              Save
            </Button>
          </div>
        </form>
      </SettingsSection>
      <SettingsSection title="Sharing">
        <label className="toggle-row">
          <span>
            <span className="toggle-label">Allow publishing pages to the web</span>
            <span className="muted small toggle-desc">Turning this off unpublishes every public page.</span>
          </span>
          <span className="switch">
            <input type="checkbox" checked={!workspace.settings.sharingDisabled} onChange={(e) => setSetting({ sharingDisabled: !e.target.checked })} />
            <span />
          </span>
        </label>
        <label className="field">
          <span className="field-label">Default mode for new members</span>
          <select className="input" value={workspace.settings.defaultPageEditMode ?? "edit"} onChange={(e) => setSetting({ defaultPageEditMode: e.target.value })}>
            <option value="edit">Editing</option>
            <option value="read">Reading</option>
          </select>
        </label>
      </SettingsSection>
    </>
  );
};
