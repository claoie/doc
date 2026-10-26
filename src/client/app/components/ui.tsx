import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

export const Button = ({
  variant = "default",
  icon,
  children,
  className,
  loading,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" | "ghost"; icon?: IconName; loading?: boolean }) => (
  <button type="button" {...rest} disabled={rest.disabled || loading} className={cx("btn", `btn-${variant}`, !children && "btn-icon", className)}>
    {icon && <Icon name={icon} size={16} />}
    {children}
  </button>
);

export const IconButton = ({ icon, label, active, size = 18, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; active?: boolean; size?: number }) => (
  <button type="button" aria-label={label} title={label} {...rest} className={cx("icon-button", active && "active", rest.className)}>
    <Icon name={icon} size={size} />
  </button>
);

export const Field = ({ label, hint, error, children }: { label?: string; hint?: ReactNode; error?: string | null; children: ReactNode }) => (
  <label className="field">
    {label && <span className="field-label">{label}</span>}
    {children}
    {hint && !error && <span className="field-hint">{hint}</span>}
    {error && <span className="field-error">{error}</span>}
  </label>
);

export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} className={cx("input", props.className)} />;

export const Spinner = ({ size = 18 }: { size?: number }) => <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;

export const Avatar = ({ name, url, size = 24 }: { name?: string | null; url?: string | null; size?: number }) => {
  const initials = (name || "?")
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  let hash = 0;
  for (const ch of name ?? "") hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  if (url) return <img className="avatar" src={url} alt={name ?? ""} style={{ width: size, height: size }} />;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue} 55% 55%)` }} aria-label={name ?? ""}>
      {initials}
    </span>
  );
};

export const userColor = (id: string) => {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 70% 45%)`;
};

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export const Modal = ({
  title,
  onClose,
  children,
  footer,
  width = 480,
}: {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true">
        {title && (
          <div className="modal-head">
            <h2>{title}</h2>
            <IconButton icon="x" label="Close" onClick={onClose} />
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
};

// ---------------------------------------------------------------------------
// Dropdown menu
// ---------------------------------------------------------------------------

export interface MenuItem {
  label: ReactNode;
  icon?: IconName;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  hint?: ReactNode;
  separator?: boolean;
}

export const useAnchoredPosition = (anchor: HTMLElement | null, open: boolean, align: "left" | "right" = "left") => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const el = ref.current!;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let left = align === "right" ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      let top = r.bottom + 4;
      if (top + h > window.innerHeight - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
      setPos({ top: top + window.scrollY, left: left + window.scrollX });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, open, align]);
  return { ref, style: pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" as const, top: 0, left: 0 } };
};

export const Menu = ({
  anchor,
  items,
  onClose,
  align = "left",
}: {
  anchor: HTMLElement | null;
  items: MenuItem[];
  onClose: () => void;
  align?: "left" | "right";
}) => {
  const { ref, style } = useAnchoredPosition(anchor, true, align);
  const [active, setActive] = useState(-1);
  const selectable = items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node) && !anchor?.contains(e.target as globalThis.Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = selectable.indexOf(active);
        const next = e.key === "ArrowDown" ? selectable[(idx + 1) % selectable.length] : selectable[(idx - 1 + selectable.length) % selectable.length];
        setActive(next ?? -1);
      } else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        items[active]?.onSelect?.();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose, active, items, selectable, ref]);
  return createPortal(
    <div className="menu" ref={ref} style={style} role="menu">
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="menu-separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={cx("menu-item", item.danger && "danger", i === active && "active")}
            disabled={item.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              item.onSelect?.();
              onClose();
            }}
          >
            {item.icon ? <Icon name={item.icon} size={16} /> : item.checked !== undefined ? <span className="menu-check">{item.checked ? "✓" : ""}</span> : null}
            <span className="menu-label">{item.label}</span>
            {item.hint && <span className="menu-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
};

const popoverStack: { current: HTMLDivElement | null }[] = [];

/**
 * Anchored panel that closes on Escape or an outside click. Nested popovers
 * close innermost first; clicks inside menus and dialogs opened from a
 * popover do not close it.
 */
export const Popover = ({
  anchor,
  onClose,
  children,
  align = "left",
  className,
  width,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
  width?: number;
}) => {
  const { ref, style } = useAnchoredPosition(anchor, true, align);
  const placed = !("visibility" in style);
  // Inputs inside are hidden until placed, so `autoFocus` alone misses them.
  useEffect(() => {
    const el = ref.current;
    if (!placed || !el || el.contains(document.activeElement)) return;
    el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [placed, ref]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    popoverStack.push(ref);
    const isTop = () => popoverStack[popoverStack.length - 1] === ref;
    const onDown = (e: MouseEvent) => {
      if (!isTop()) return;
      const target = e.target as Element;
      if (ref.current?.contains(target) || anchor?.contains(target) || target.closest?.(".menu, .modal-backdrop, .toast")) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !isTop()) return;
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      popoverStack.splice(popoverStack.indexOf(ref), 1);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, ref]);
  return createPortal(
    <div className={cx("popover", className)} ref={ref} style={{ ...style, ...(width ? { width } : {}) }}>
      {children}
    </div>,
    document.body,
  );
};

/** A button that opens a menu. */
export const MenuButton = ({ items, children, align = "right" }: { items: MenuItem[] | (() => MenuItem[]); children: (open: (el: HTMLElement) => void) => ReactNode; align?: "left" | "right" }) => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      {children((el) => setAnchor((a) => (a ? null : el)))}
      {anchor && <Menu anchor={anchor} items={typeof items === "function" ? items() : items} onClose={() => setAnchor(null)} align={align} />}
    </>
  );
};

// ---------------------------------------------------------------------------
// Toasts and confirmation
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  message: ReactNode;
  kind: "info" | "error" | "success";
}

const ToastContext = createContext<(message: ReactNode, kind?: Toast["kind"]) => void>(() => undefined);
const ConfirmContext = createContext<(opts: ConfirmOptions) => Promise<boolean>>(async () => false);

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

let toastSeq = 0;

export const FeedbackProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirm, setConfirm] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const toast = useCallback((message: ReactNode, kind: Toast["kind"] = "info") => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);
  const ask = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => setConfirm({ ...opts, resolve })), []);
  const close = (v: boolean) => {
    confirm?.resolve(v);
    setConfirm(null);
  };
  return (
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={ask}>
        {children}
        {createPortal(
          <div className="toasts" aria-live="polite">
            {toasts.map((t) => (
              <div key={t.id} className={cx("toast", `toast-${t.kind}`)}>
                {t.message}
              </div>
            ))}
          </div>,
          document.body,
        )}
        {confirm && (
          <Modal
            title={confirm.title}
            onClose={() => close(false)}
            footer={
              <>
                <Button onClick={() => close(false)}>Cancel</Button>
                <Button variant={confirm.danger ? "danger" : "primary"} onClick={() => close(true)} autoFocus>
                  {confirm.confirmLabel ?? "Confirm"}
                </Button>
              </>
            }
          >
            {confirm.message && <div className="confirm-message">{confirm.message}</div>}
          </Modal>
        )}
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
};

export const useToast = () => useContext(ToastContext);
export const useConfirm = () => useContext(ConfirmContext);

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

export const EmptyState = ({ icon, title, children }: { icon?: IconName; title: string; children?: ReactNode }) => (
  <div className="empty-state">
    {icon && <Icon name={icon} size={28} />}
    <div className="empty-title">{title}</div>
    {children && <div className="empty-body">{children}</div>}
  </div>
);

export const timeAgo = (iso: string | null | undefined) => {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

export const formatDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
