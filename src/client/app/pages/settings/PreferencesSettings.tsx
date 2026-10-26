import { useEffect } from "react";
import type { UserPreferences } from "common/api-types";
import { api } from "../../api";
import { useApp } from "../../store";
import { errorMessage, useToast } from "../../components/ui";
import { SettingsSection } from "./SettingsPage";

const Toggle = ({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <label className="toggle-row">
    <span>
      <span className="toggle-label">{label}</span>
      {description && <span className="muted small toggle-desc">{description}</span>}
    </span>
    <span className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </span>
  </label>
);

export const PreferencesSettings = () => {
  const { user, setUser } = useApp();
  const toast = useToast();
  const prefs = user.preferences;
  useEffect(() => {
    document.title = "Preferences";
  }, []);
  const set = async (patch: Partial<UserPreferences>) => {
    try {
      setUser((await api.updateMe({ preferences: patch })).user);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <>
      <SettingsSection title="Appearance">
        <label className="field">
          <span className="field-label">Theme</span>
          <select className="input" value={prefs.theme ?? "system"} onChange={(e) => set({ theme: e.target.value as UserPreferences["theme"] })}>
            <option value="system">Match system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <Toggle label="Full-width pages" description="Use the whole window width for page content." checked={!!prefs.fullPageWidth} onChange={(v) => set({ fullPageWidth: v })} />
      </SettingsSection>
      <SettingsSection title="Editing">
        <Toggle label="Show formatting toolbar" description="Keep a toolbar above the page instead of only the selection menu." checked={!!prefs.editorToolbar} onChange={(v) => set({ editorToolbar: v })} />
        <label className="field">
          <span className="field-label">Default page mode</span>
          <select className="input" value={prefs.pageEditMode ?? "edit"} onChange={(e) => set({ pageEditMode: e.target.value as "read" | "edit" })}>
            <option value="edit">Editing</option>
            <option value="read">Reading</option>
          </select>
        </label>
      </SettingsSection>
      <SettingsSection title="Email notifications" description="In-app notifications are always shown; these control emails.">
        <Toggle label="Comments on pages I watch" checked={prefs.notifyComments !== false} onChange={(v) => set({ notifyComments: v })} />
        <Toggle label="Mentions in comments" checked={prefs.notifyCommentMentions !== false} onChange={(v) => set({ notifyCommentMentions: v })} />
        <Toggle label="Mentions in pages" checked={prefs.notifyPageMentions !== false} onChange={(v) => set({ notifyPageMentions: v })} />
        <Toggle label="Updates to pages I watch" checked={prefs.notifyPageUpdates !== false} onChange={(v) => set({ notifyPageUpdates: v })} />
      </SettingsSection>
    </>
  );
};
