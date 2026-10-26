/**
 * Lightweight floating panels for node views (math, status, link editing),
 * positioned next to an anchor element and closed on outside click/Escape.
 */
export interface Popover {
  el: HTMLElement;
  close: () => void;
}

let current: Popover | null = null;

export const closePopover = () => current?.close();

export const openPopover = (anchor: Element, build: (close: () => void) => HTMLElement, onClose?: () => void): Popover => {
  current?.close();
  const el = document.createElement("div");
  el.className = "popover";
  el.setAttribute("contenteditable", "false");
  const close = () => {
    if (!el.isConnected) return;
    el.remove();
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", place);
    if (current?.el === el) current = null;
    onClose?.();
  };
  const outside = (e: Event) => {
    if (!el.contains(e.target as globalThis.Node) && !anchor.contains(e.target as globalThis.Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  el.append(build(close));
  document.body.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = r.left + window.scrollX;
    let top = r.bottom + window.scrollY + 6;
    left = Math.max(8 + window.scrollX, Math.min(left, window.scrollX + window.innerWidth - w - 8));
    if (r.bottom + h + 12 > window.innerHeight && r.top - h - 6 > 0) top = r.top + window.scrollY - h - 6;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  place();
  setTimeout(() => {
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onKey, true);
  });
  window.addEventListener("resize", place);
  current = { el, close };
  return current;
};
