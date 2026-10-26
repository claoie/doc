import { useEffect } from "react";
import { match, slugIdFrom, useLocation } from "./router";
import { AppLayout } from "./layout/AppLayout";
import { HomePage } from "./pages/HomePage";
import { SpaceHome } from "./pages/SpaceHome";
import { PageView } from "./page/PageView";
import { TrashPage } from "./pages/TrashPage";
import { SettingsPage } from "./pages/settings/SettingsPage";
import { LabelPage } from "./pages/LabelPage";
import { NotFound } from "./pages/NotFound";
import { useApp } from "./store";
import { api } from "./api";
import { navigate, pageUrl } from "./router";
import { Spinner } from "./components/ui";

export const AppRoutes = ({ onSignedOut }: { onSignedOut: () => void }) => {
  const { pathname } = useLocation();
  const { setSidebarOpen } = useApp();

  useEffect(() => {
    if (window.matchMedia("(max-width: 800px)").matches) setSidebarOpen(false);
  }, [pathname, setSidebarOpen]);

  let content: React.ReactNode;
  let params: Record<string, string> | null;
  if (pathname === "/") content = <HomePage />;
  else if ((params = match("/s/:space/p/:page", pathname))) content = <PageView key={slugIdFrom(params.page!)} pageSegment={params.page!} />;
  else if ((params = match("/s/:space/trash", pathname))) content = <TrashPage spaceSlug={params.space!} />;
  else if ((params = match("/s/:space/settings", pathname))) content = <SettingsPage section="space" spaceSlug={params.space} />;
  else if ((params = match("/s/:space", pathname))) content = <SpaceHome key={params.space} spaceSlug={params.space!} />;
  else if ((params = match("/settings/:section", pathname))) content = <SettingsPage section={params.section!} />;
  else if ((params = match("/settings/groups/:id", pathname))) content = <SettingsPage section="group" groupId={params.id} />;
  else if (pathname === "/settings") content = <SettingsPage section="account" />;
  else if ((params = match("/labels/:id", pathname))) content = <LabelPage labelId={params.id!} />;
  else if ((params = match("/p/:page", pathname))) content = <PageRedirect page={params.page!} />;
  else content = <NotFound />;

  return <AppLayout onSignedOut={onSignedOut}>{content}</AppLayout>;
};

/** Resolves a bare `/p/<slugId>` link (used inside documents) to the page's full URL. */
const PageRedirect = ({ page }: { page: string }) => {
  const { hash } = useLocation();
  useEffect(() => {
    api
      .page(slugIdFrom(page))
      .then((d) => navigate(pageUrl(d.space.slug, d.page) + hash, { replace: true }))
      .catch(() => navigate("/", { replace: true }));
  }, [page, hash]);
  return <Spinner />;
};
