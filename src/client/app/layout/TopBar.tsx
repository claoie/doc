import type { ReactNode } from "react";
import { Link } from "../router";
import { useApp } from "../store";
import { IconButton } from "../components/ui";
import { Icon } from "../components/Icon";

export interface Crumb {
  label: ReactNode;
  to?: string;
  icon?: string | null;
}

export const TopBar = ({ crumbs, actions }: { crumbs: Crumb[]; actions?: ReactNode }) => {
  const { sidebarOpen, setSidebarOpen } = useApp();
  return (
    <header className="topbar">
      {!sidebarOpen && <IconButton icon="menu" label="Open sidebar" onClick={() => setSidebarOpen(true)} />}
      <nav className="crumbs" aria-label="Breadcrumbs">
        {crumbs.map((c, i) => (
          <span key={i} className="crumb">
            {i > 0 && <Icon name="chevronRight" size={12} className="crumb-sep" />}
            {c.to ? (
              <Link to={c.to} className="crumb-link">
                {c.icon && <span className="crumb-icon">{c.icon}</span>}
                <span>{c.label}</span>
              </Link>
            ) : (
              <span className="crumb-current">
                {c.icon && <span className="crumb-icon">{c.icon}</span>}
                <span>{c.label}</span>
              </span>
            )}
          </span>
        ))}
      </nav>
      <div className="topbar-actions">{actions}</div>
    </header>
  );
};
