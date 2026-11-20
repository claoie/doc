import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { AuthConfig, PublicWorkspace } from "common/api-types";
import { api } from "../api";
import { Link, useLocation } from "../router";
import { Button, Field, Input, errorMessage } from "../components/ui";

type Mode = "login" | "setup" | "forgot-password" | "reset-password" | "invite";

/** Why the server sent the browser back from single sign-on (`/login?sso_error=…`). */
const SSO_ERRORS: Record<string, string> = {
  access_denied: "Single sign-on was cancelled or access was denied.",
  unavailable: "The identity provider could not be reached. Try again in a moment.",
  no_email: "Your single sign-on account has no email address. Ask an administrator to add one.",
  account_exists: "An account with your email address already exists here, linked to another single sign-on account. Ask an administrator.",
  deactivated: "Your account in this workspace is deactivated. Ask a workspace admin to reactivate it.",
  rate_limited: "Too many sign-in attempts. Try again in a minute.",
};

/** A full-page navigation to the server, which sends the browser on to the identity provider. */
const SsoButton = ({ next }: { next: string | null }) => {
  const returnTo = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return (
    <a className="btn btn-primary auth-sso" href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>
      Sign in with SSO
    </a>
  );
};

const AuthShell = ({ title, subtitle, children, workspace }: { title: string; subtitle?: ReactNode; children: ReactNode; workspace?: PublicWorkspace | null }) => (
  <div className="auth-screen">
    <div className="auth-card">
      {workspace?.logoUrl ? <img className="auth-logo" src={workspace.logoUrl} alt="" /> : <div className="auth-mark">{(workspace?.name ?? "D").slice(0, 1)}</div>}
      <h1>{title}</h1>
      {subtitle && <p className="auth-subtitle">{subtitle}</p>}
      {children}
    </div>
  </div>
);

export const AuthPage = ({ mode: requested, sso, onAuthed }: { mode: Mode; sso: AuthConfig["sso"]; onAuthed: () => Promise<void> }) => {
  const location = useLocation();
  // With single sign-on as the only way in, there are no passwords to set or reset, and no invitations to accept.
  const ssoOnly = sso.enabled && !sso.localLogin;
  const mode: Mode = ssoOnly ? "login" : requested;
  const ssoError = location.search.get("sso_error");
  const [workspace, setWorkspace] = useState<PublicWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [form, setForm] = useState({ workspaceName: "", name: "", email: "", password: "", confirm: "" });
  const [invite, setInvite] = useState<{ email: string; workspaceName: string } | null>(null);
  const token = location.search.get("token") ?? "";
  const inviteId = mode === "invite" ? location.pathname.split("/")[2] ?? "" : "";

  useEffect(() => {
    if (mode !== "setup") api.publicWorkspace().then(setWorkspace).catch(() => undefined);
    if (mode === "invite") {
      api
        .invitationInfo(inviteId, token)
        .then(setInvite)
        .catch((e) => setError(errorMessage(e)));
    }
  }, [mode, inviteId, token]);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if ((mode === "setup" || mode === "reset-password" || mode === "invite") && form.password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (mode === "reset-password" && form.password !== form.confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") {
        await api.login(form.email.trim(), form.password);
        await onAuthed();
      } else if (mode === "setup") {
        await api.setup({ workspaceName: form.workspaceName.trim() || "My workspace", name: form.name.trim(), email: form.email.trim(), password: form.password });
        await onAuthed();
      } else if (mode === "forgot-password") {
        await api.forgotPassword(form.email.trim());
        setDone(true);
      } else if (mode === "reset-password") {
        await api.resetPassword(token, form.password);
        await onAuthed();
      } else if (mode === "invite") {
        await api.acceptInvitation({ id: inviteId, token, name: form.name.trim(), password: form.password });
        await onAuthed();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (mode === "setup") {
    return (
      <AuthShell title="Set up your workspace" subtitle="Create the owner account to get started.">
        {sso.enabled && (
          <>
            <SsoButton next={null} />
            <div className="auth-divider">or</div>
          </>
        )}
        <form className="auth-form" onSubmit={submit}>
          <Field label="Workspace name">
            <Input value={form.workspaceName} onChange={set("workspaceName")} placeholder="My workspace" autoFocus />
          </Field>
          <Field label="Your name">
            <Input value={form.name} onChange={set("name")} required maxLength={50} autoComplete="name" />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={set("email")} required autoComplete="email" />
          </Field>
          <Field label="Password" hint="At least 8 characters">
            <Input type="password" value={form.password} onChange={set("password")} required minLength={8} maxLength={70} autoComplete="new-password" />
          </Field>
          {error && <div className="form-error">{error}</div>}
          <Button variant="primary" type="submit" loading={busy}>
            Create workspace
          </Button>
        </form>
      </AuthShell>
    );
  }

  if (mode === "forgot-password") {
    return (
      <AuthShell title="Reset your password" subtitle={done ? undefined : "We'll email you a link to set a new password."} workspace={workspace}>
        {done ? (
          <p className="auth-note">If an account exists for that email, a reset link is on its way. The link expires in 30 minutes.</p>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <Field label="Email">
              <Input type="email" value={form.email} onChange={set("email")} required autoFocus autoComplete="email" />
            </Field>
            {error && <div className="form-error">{error}</div>}
            <Button variant="primary" type="submit" loading={busy}>
              Send reset link
            </Button>
          </form>
        )}
        <div className="auth-links">
          <Link to="/login">Back to sign in</Link>
        </div>
      </AuthShell>
    );
  }

  if (mode === "reset-password") {
    return (
      <AuthShell title="Choose a new password" workspace={workspace}>
        <form className="auth-form" onSubmit={submit}>
          <Field label="New password" hint="At least 8 characters">
            <Input type="password" value={form.password} onChange={set("password")} required minLength={8} maxLength={70} autoFocus autoComplete="new-password" />
          </Field>
          <Field label="Confirm password">
            <Input type="password" value={form.confirm} onChange={set("confirm")} required autoComplete="new-password" />
          </Field>
          {error && <div className="form-error">{error}</div>}
          <Button variant="primary" type="submit" loading={busy}>
            Set password
          </Button>
        </form>
      </AuthShell>
    );
  }

  if (mode === "invite") {
    return (
      <AuthShell title={invite ? `Join ${invite.workspaceName}` : "Accept invitation"} subtitle={invite ? `You were invited as ${invite.email}.` : undefined} workspace={workspace}>
        {invite ? (
          <form className="auth-form" onSubmit={submit}>
            <Field label="Your name">
              <Input value={form.name} onChange={set("name")} required maxLength={50} autoFocus autoComplete="name" />
            </Field>
            <Field label="Password" hint="At least 8 characters">
              <Input type="password" value={form.password} onChange={set("password")} required minLength={8} maxLength={70} autoComplete="new-password" />
            </Field>
            {error && <div className="form-error">{error}</div>}
            <Button variant="primary" type="submit" loading={busy}>
              Join workspace
            </Button>
          </form>
        ) : (
          <>{error ? <div className="form-error">{error}</div> : <p className="auth-note">Checking invitation…</p>}</>
        )}
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={workspace?.name ? `Sign in to ${workspace.name}` : "Sign in"}
      subtitle={ssoOnly && requested === "setup" ? "The first person to sign in sets up the workspace." : undefined}
      workspace={workspace}
    >
      {sso.enabled && (
        <>
          {ssoError && <div className="form-error auth-error">{SSO_ERRORS[ssoError] ?? "Single sign-on didn't complete. Try again."}</div>}
          <SsoButton next={location.search.get("next")} />
        </>
      )}
      {sso.localLogin && (
        <>
          {sso.enabled && <div className="auth-divider">or</div>}
          <form className="auth-form" onSubmit={submit}>
            <Field label="Email">
              <Input type="email" value={form.email} onChange={set("email")} required autoFocus={!sso.enabled} autoComplete="email" />
            </Field>
            <Field label="Password">
              <Input type="password" value={form.password} onChange={set("password")} required autoComplete="current-password" />
            </Field>
            {error && <div className="form-error">{error}</div>}
            <Button variant={sso.enabled ? "default" : "primary"} type="submit" loading={busy}>
              Sign in
            </Button>
          </form>
          <div className="auth-links">
            <Link to="/forgot-password">Forgot password?</Link>
          </div>
        </>
      )}
    </AuthShell>
  );
};
