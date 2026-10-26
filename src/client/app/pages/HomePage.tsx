import { useEffect, useState } from "react";
import type { RecentPage, Space } from "common/api-types";
import { api } from "../api";
import { Link, pageUrl } from "../router";
import { useApp } from "../store";
import { Icon } from "../components/Icon";
import { Avatar, EmptyState, Spinner, timeAgo } from "../components/ui";
import { TopBar } from "../layout/TopBar";

export const RecentList = ({ pages }: { pages: RecentPage[] | null }) => {
  if (!pages) return <Spinner />;
  if (!pages.length) return <EmptyState icon="page" title="No pages yet" />;
  return (
    <div className="page-list">
      {pages.map((p) => (
        <Link key={p.id} to={pageUrl(p.space.slug, p)} className="page-list-row">
          <span className="page-list-icon">{p.icon || <Icon name={p.isBase ? "table" : "page"} size={16} />}</span>
          <span className="page-list-title">{p.title || "Untitled"}</span>
          <span className="page-list-space">{p.space.name}</span>
          <span className="page-list-meta">
            {p.lastEditor && <Avatar name={p.lastEditor.name} url={p.lastEditor.avatarUrl} size={18} />}
            {timeAgo(p.updatedAt)}
          </span>
        </Link>
      ))}
    </div>
  );
};

export const HomePage = () => {
  const { user, spaces, favorites } = useApp();
  const [recent, setRecent] = useState<RecentPage[] | null>(null);
  const [tab, setTab] = useState<"recent" | "mine">(() => {
    try {
      return localStorage.getItem("home-tab") === "mine" ? "mine" : "recent";
    } catch {
      return "recent";
    }
  });
  useEffect(() => {
    document.title = "Home";
    setRecent(null);
    api
      .recent({ limit: 30, creatorId: tab === "mine" ? user.id : undefined })
      .then(setRecent)
      .catch(() => setRecent([]));
    try {
      localStorage.setItem("home-tab", tab);
    } catch {
      // storage unavailable
    }
  }, [tab, user.id]);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <>
      <TopBar crumbs={[{ label: "Home" }]} />
      <div className="content">
        <h1 className="page-heading">
          {greeting}, {user.name.split(" ")[0]}
        </h1>
        {favorites.pages.length > 0 && (
          <section className="home-section">
            <h2>Favorites</h2>
            <div className="card-grid">
              {favorites.pages.map((p) => (
                <Link key={p.id} to={pageUrl(p.space.slug, p)} className="card">
                  <span className="card-icon">{p.icon || <Icon name={p.isBase ? "table" : "page"} size={20} />}</span>
                  <span className="card-title">{p.title || "Untitled"}</span>
                  <span className="card-meta">{p.space.name}</span>
                </Link>
              ))}
            </div>
          </section>
        )}
        <section className="home-section">
          <h2>Spaces</h2>
          <div className="card-grid">
            {spaces.map((s: Space) => (
              <Link key={s.id} to={`/s/${s.slug}`} className="card">
                {s.iconUrl ? <img src={s.iconUrl} alt="" className="card-space-icon" /> : <span className="card-space-icon">{s.name.slice(0, 1)}</span>}
                <span className="card-title">{s.name}</span>
                <span className="card-meta">
                  {s.memberCount} {s.memberCount === 1 ? "member" : "members"}
                </span>
              </Link>
            ))}
          </div>
        </section>
        <section className="home-section">
          <div className="tabs">
            <button type="button" className={tab === "recent" ? "tab active" : "tab"} onClick={() => setTab("recent")}>
              Recently updated
            </button>
            <button type="button" className={tab === "mine" ? "tab active" : "tab"} onClick={() => setTab("mine")}>
              Created by me
            </button>
          </div>
          <RecentList pages={recent} />
        </section>
      </div>
    </>
  );
};
