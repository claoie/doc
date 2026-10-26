import { useEffect, useState } from "react";
import type { RecentPage, Space } from "common/api-types";
import { api } from "../api";
import { navigate, pageUrl } from "../router";
import { useApp, treeCache } from "../store";
import { Button, EmptyState, Spinner, errorMessage, useToast } from "../components/ui";
import { TopBar } from "../layout/TopBar";
import { RecentList } from "./HomePage";
import { canWrite } from "../layout/Sidebar";

export const SpaceHome = ({ spaceSlug }: { spaceSlug: string }) => {
  const { spaces } = useApp();
  const toast = useToast();
  const known = spaces.find((s) => s.slug.toLowerCase() === spaceSlug.toLowerCase());
  const [space, setSpace] = useState<Space | null | undefined>(known);
  const [recent, setRecent] = useState<RecentPage[] | null>(null);

  useEffect(() => {
    if (!known) {
      api
        .space(spaceSlug)
        .then((r) => setSpace(r.space))
        .catch(() => setSpace(null));
    } else setSpace(known);
  }, [spaceSlug, known]);

  useEffect(() => {
    if (!space) return;
    document.title = space.name;
    api
      .recent({ spaceId: space.id, limit: 30 })
      .then(setRecent)
      .catch(() => setRecent([]));
  }, [space]);

  if (space === undefined) return <Spinner />;
  if (space === null) return <EmptyState icon="space" title="Space not found">It may have been deleted, or you don't have access.</EmptyState>;

  const create = async () => {
    try {
      const { page } = await api.createPage({ spaceId: space.id });
      treeCache.invalidate(space.id);
      navigate(pageUrl(space.slug, page));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <>
      <TopBar crumbs={[{ label: space.name }]} actions={canWrite(space) && <Button icon="plus" onClick={create}>New page</Button>} />
      <div className="content">
        <div className="space-hero">
          {space.iconUrl ? <img src={space.iconUrl} alt="" className="space-hero-icon" /> : <span className="space-hero-icon">{space.name.slice(0, 1)}</span>}
          <div>
            <h1 className="page-heading">{space.name}</h1>
            {space.description && <p className="muted">{space.description}</p>}
          </div>
        </div>
        <section className="home-section">
          <h2>Recently updated in this space</h2>
          <RecentList pages={recent} />
        </section>
      </div>
    </>
  );
};
