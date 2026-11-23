import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";
import type { AuthConfig, Space, User, Workspace } from "common/api-types";
import { api, ApiError, setUnauthorizedHandler } from "./api";
import { startErrorReports } from "./error-reports";
import { match, navigate, useLocation } from "./router";
import { AppProvider, applyTheme } from "./store";
import { FeedbackProvider, Spinner } from "./components/ui";
import { AuthPage } from "./pages/AuthPages";
import { AppRoutes } from "./AppRoutes";
import { SharedPageView } from "./pages/SharedPage";
import "../styles/base.css";
import "../styles/editor.css";
import "../styles/app.css";
import "../styles/bases.css";

type Sso = AuthConfig["sso"];
type Session = { user: User; workspace: Workspace; spaces: Space[]; sso: Sso };

/** What a server without single sign-on answers, and the fallback when the question fails. */
const PASSWORDS_ONLY: Sso = { enabled: false, localLogin: true };

const PUBLIC_AUTH = ["/login", "/setup", "/forgot-password", "/reset-password", "/invites/:id"];

const Root = () => {
  const location = useLocation();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [sso, setSso] = useState<Sso>(PASSWORDS_ONLY);
  const [bootError, setBootError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ needsSetup }, mode] = await Promise.all([
        api.setupStatus(),
        api
          .authConfig()
          .then((c) => c.sso)
          .catch(() => PASSWORDS_ONLY),
      ]);
      setNeedsSetup(needsSetup);
      setSso(mode);
      if (needsSetup) {
        setSession(null);
        return;
      }
      const me = await api.me();
      const spaces = await api.spaces();
      applyTheme(me.user.preferences.theme);
      setSession({ ...me, spaces, sso: mode });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setSession(null);
      else setBootError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
    setUnauthorizedHandler(() => setSession(null));
  }, [load]);

  const isShare = location.pathname.startsWith("/share/");
  if (isShare) return <SharedPageView />;

  if (bootError) {
    return (
      <div className="center-screen">
        <p>{bootError}</p>
        <button className="btn" onClick={() => location && window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }
  if (session === undefined) {
    return (
      <div className="center-screen">
        <Spinner />
      </div>
    );
  }

  const onAuthed = async () => {
    await load();
    const next = new URLSearchParams(window.location.search).get("next");
    navigate(next && next.startsWith("/") && !next.startsWith("//") ? next : "/", { replace: true });
  };

  const authRoute = PUBLIC_AUTH.find((p) => match(p, location.pathname));
  if (needsSetup) return <AuthPage mode="setup" sso={sso} onAuthed={onAuthed} />;
  if (!session) {
    if (authRoute && authRoute !== "/setup") {
      const mode = authRoute === "/invites/:id" ? "invite" : (authRoute.slice(1) as "login" | "forgot-password" | "reset-password");
      return <AuthPage mode={mode} sso={sso} onAuthed={onAuthed} />;
    }
    if (location.pathname !== "/login") {
      const next = location.pathname === "/" ? "" : `?next=${encodeURIComponent(location.href)}`;
      return <Redirect to={`/login${next}`} />;
    }
    return <AuthPage mode="login" sso={sso} onAuthed={onAuthed} />;
  }
  if (authRoute && authRoute !== "/invites/:id" && authRoute !== "/reset-password") return <Redirect to="/" />;
  return (
    <AppProvider initial={session} key={session.user.id}>
      <AppRoutes onSignedOut={() => setSession(null)} />
    </AppProvider>
  );
};

const Redirect = ({ to }: { to: string }) => {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
};

startErrorReports();

createRoot(document.getElementById("root")!).render(
  <FeedbackProvider>
    <Root />
  </FeedbackProvider>,
);
