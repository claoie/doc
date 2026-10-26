import type { ReactNode } from "react";
import { Link } from "../../router";
import { useApp } from "../../store";
import { TopBar } from "../../layout/TopBar";
import { cx } from "../../components/ui";
import { AccountSettings } from "./AccountSettings";
import { PreferencesSettings } from "./PreferencesSettings";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { MembersSettings } from "./MembersSettings";
import { GroupsSettings, GroupDetail } from "./GroupsSettings";
import { SpacesSettings } from "./SpacesSettings";
import { SpaceSettings } from "./SpaceSettings";
import { NotFound } from "../NotFound";

const NAV: { section: string; label: string; admin?: boolean }[] = [
  { section: "account", label: "Profile & security" },
  { section: "preferences", label: "Preferences" },
  { section: "workspace", label: "General", admin: true },
  { section: "members", label: "Members" },
  { section: "groups", label: "Groups" },
  { section: "spaces", label: "Spaces" },
];

export const SettingsPage = ({ section, spaceSlug, groupId }: { section: string; spaceSlug?: string; groupId?: string }) => {
  const { isAdmin } = useApp();
  let body: ReactNode;
  switch (section) {
    case "account":
      body = <AccountSettings />;
      break;
    case "preferences":
      body = <PreferencesSettings />;
      break;
    case "workspace":
      body = isAdmin ? <WorkspaceSettings /> : <NotFound />;
      break;
    case "members":
      body = <MembersSettings />;
      break;
    case "groups":
      body = <GroupsSettings />;
      break;
    case "group":
      body = <GroupDetail groupId={groupId!} />;
      break;
    case "spaces":
      body = <SpacesSettings />;
      break;
    case "space":
      body = <SpaceSettings spaceSlug={spaceSlug!} />;
      break;
    default:
      return <NotFound />;
  }
  return (
    <>
      <TopBar crumbs={[{ label: "Settings" }]} />
      <div className="settings">
        <nav className="settings-nav">
          <div className="settings-nav-title">Account</div>
          {NAV.slice(0, 2).map((n) => (
            <Link key={n.section} to={`/settings/${n.section}`} className={cx("settings-nav-item", section === n.section && "active")}>
              {n.label}
            </Link>
          ))}
          <div className="settings-nav-title">Workspace</div>
          {NAV.slice(2)
            .filter((n) => !n.admin || isAdmin)
            .map((n) => (
              <Link key={n.section} to={`/settings/${n.section}`} className={cx("settings-nav-item", (section === n.section || (n.section === "groups" && section === "group") || (n.section === "spaces" && section === "space")) && "active")}>
                {n.label}
              </Link>
            ))}
        </nav>
        <div className="settings-body">{body}</div>
      </div>
    </>
  );
};

export const SettingsSection = ({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) => (
  <section className="settings-section">
    <div className="settings-section-head">
      <div>
        <h2>{title}</h2>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions}
    </div>
    {children}
  </section>
);
