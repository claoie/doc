import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { SearchDialog } from "./SearchDialog";
import { useApp } from "../store";
import { cx } from "../components/ui";

const MIN_SIDEBAR = 220;
const MAX_SIDEBAR = 600;

const savedWidth = () => {
  try {
    const n = Number(localStorage.getItem("sidebar-width"));
    return n >= MIN_SIDEBAR && n <= MAX_SIDEBAR ? n : 260;
  } catch {
    return 260;
  }
};

export const AppLayout = ({ children, onSignedOut }: { children: ReactNode; onSignedOut: () => void }) => {
  const { sidebarOpen, setSidebarOpen, searchOpen, setSearchOpen } = useApp();
  const [width, setWidth] = useState(savedWidth);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = width;
    let current = start;
    const onMove = (ev: PointerEvent) => {
      current = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, start + ev.clientX - startX));
      setWidth(current);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing");
      try {
        localStorage.setItem("sidebar-width", String(current));
      } catch {
        // storage unavailable
      }
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The editor claims some shortcuts (Mod+K adds a link to a selection).
      if (e.defaultPrevented) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        setSidebarOpen(!sidebarOpen);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sidebarOpen, setSidebarOpen, setSearchOpen]);

  return (
    <div className={cx("app", sidebarOpen ? "sidebar-open" : "sidebar-closed")} style={{ "--sidebar-width": `${width}px` } as CSSProperties}>
      <Sidebar onSignedOut={onSignedOut} />
      {sidebarOpen && (
        <div
          className="sidebar-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={startResize}
          onDoubleClick={() => {
            setWidth(260);
            try {
              localStorage.removeItem("sidebar-width");
            } catch {
              // storage unavailable
            }
          }}
        />
      )}
      {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}
      <main className="main">{children}</main>
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
    </div>
  );
};
