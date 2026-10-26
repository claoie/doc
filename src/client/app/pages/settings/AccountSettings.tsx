import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SessionInfo } from "common/api-types";
import { api } from "../../api";
import { useApp } from "../../store";
import { Avatar, Button, Field, Input, Spinner, errorMessage, timeAgo, useToast } from "../../components/ui";
import { SettingsSection } from "./SettingsPage";

export const AccountSettings = () => {
  const { user, setUser } = useApp();
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [emailPassword, setEmailPassword] = useState("");
  const [passwords, setPasswords] = useState({ current: "", next: "", confirm: "" });
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = "Profile & security";
    api
      .sessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("profile");
    try {
      const body: Parameters<typeof api.updateMe>[0] = { name: name.trim() };
      if (email.trim() !== user.email) Object.assign(body, { email: email.trim(), currentPassword: emailPassword });
      const { user: next } = await api.updateMe(body);
      setUser(next);
      setEmailPassword("");
      toast("Profile saved", "success");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (passwords.next.length < 8) return toast("New password must be at least 8 characters", "error");
    if (passwords.next !== passwords.confirm) return toast("New passwords do not match", "error");
    setBusy("password");
    try {
      await api.changePassword(passwords.current, passwords.next);
      setPasswords({ current: "", next: "", confirm: "" });
      toast("Password changed. Other sessions were signed out.", "success");
      setSessions(await api.sessions());
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <SettingsSection title="Profile">
        <div className="avatar-row">
          <Avatar name={user.name} url={user.avatarUrl} size={56} />
          <div className="row gap-s">
            <Button icon="upload" onClick={() => fileRef.current?.click()}>
              Upload photo
            </Button>
            {user.avatarUrl && (
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    setUser((await api.removeAvatar()).user);
                  } catch (err) {
                    toast(errorMessage(err), "error");
                  }
                }}
              >
                Remove
              </Button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  setUser((await api.uploadAvatar(file)).user);
                } catch (err) {
                  toast(errorMessage(err), "error");
                }
                e.target.value = "";
              }}
            />
          </div>
        </div>
        <form className="form" onSubmit={saveProfile}>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={50} />
          </Field>
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          {email.trim() !== user.email && (
            <Field label="Current password" hint="Required to change your email">
              <Input type="password" value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} required autoComplete="current-password" />
            </Field>
          )}
          <div>
            <Button variant="primary" type="submit" loading={busy === "profile"}>
              Save profile
            </Button>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection title="Password">
        <form className="form" onSubmit={changePassword}>
          <Field label="Current password">
            <Input type="password" value={passwords.current} onChange={(e) => setPasswords((p) => ({ ...p, current: e.target.value }))} required autoComplete="current-password" />
          </Field>
          <Field label="New password" hint="At least 8 characters">
            <Input type="password" value={passwords.next} onChange={(e) => setPasswords((p) => ({ ...p, next: e.target.value }))} required minLength={8} maxLength={70} autoComplete="new-password" />
          </Field>
          <Field label="Confirm new password">
            <Input type="password" value={passwords.confirm} onChange={(e) => setPasswords((p) => ({ ...p, confirm: e.target.value }))} required autoComplete="new-password" />
          </Field>
          <div>
            <Button variant="primary" type="submit" loading={busy === "password"}>
              Change password
            </Button>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection title="Sessions" description="Devices currently signed in to your account.">
        {!sessions && <Spinner />}
        <div className="list">
          {sessions?.map((s) => (
            <div key={s.id} className="list-row">
              <div className="list-main">
                <div>{describeAgent(s.userAgent)}</div>
                <div className="muted small">
                  {s.ip ?? "Unknown IP"} · last active {timeAgo(s.lastSeenAt)}
                </div>
              </div>
              {s.current ? (
                <span className="pill">This device</span>
              ) : (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await api.revokeSession(s.id).catch((err) => toast(errorMessage(err), "error"));
                    setSessions(await api.sessions());
                  }}
                >
                  Sign out
                </Button>
              )}
            </div>
          ))}
        </div>
      </SettingsSection>
    </>
  );
};

const describeAgent = (ua: string | null) => {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
};
