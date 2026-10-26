import { useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { titleSlug } from "common/text";

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

window.addEventListener("popstate", notify);

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const snapshot = () => location.pathname + location.search + location.hash;

export const useLocation = () => {
  const href = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(href, location.origin);
  return { pathname: url.pathname, search: url.searchParams, hash: url.hash, href };
};

const guards = new Set<() => boolean>();

/** Registers a check that can block navigation (e.g. unsaved changes). */
export const useNavigationGuard = (shouldBlock: () => boolean) => {
  useEffect(() => {
    guards.add(shouldBlock);
    return () => {
      guards.delete(shouldBlock);
    };
  }, [shouldBlock]);
};

export const navigate = (to: string, opts: { replace?: boolean } = {}) => {
  if (to === snapshot()) return;
  for (const guard of guards) if (guard()) return;
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  notify();
  if (!to.includes("#")) window.scrollTo(0, 0);
};

export const Link = ({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
  <a
    {...rest}
    href={to}
    onClick={(e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target) return;
      e.preventDefault();
      navigate(to);
    }}
  />
);

export type Params = Record<string, string>;

/** Matches `pattern` like `/s/:space/p/:page`; returns params or null. */
export const match = (pattern: string, pathname: string): Params | null => {
  const p = pattern.split("/").filter(Boolean);
  const s = pathname.split("/").filter(Boolean);
  const wildcard = p[p.length - 1] === "*";
  if (!wildcard && p.length !== s.length) return null;
  if (wildcard && s.length < p.length - 1) return null;
  const params: Params = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i]!;
    if (part === "*") {
      params["*"] = s.slice(i).join("/");
      break;
    }
    const seg = s[i];
    if (seg === undefined) return null;
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(seg);
    else if (part !== seg) return null;
  }
  return params;
};

export const slugify = titleSlug;

export const pageUrl = (spaceSlug: string, page: { slugId: string; title: string | null }, anchor?: string | null) =>
  `/s/${encodeURIComponent(spaceSlug)}/p/${encodeURIComponent(slugify(page.title))}-${page.slugId}${anchor ? `#${anchor}` : ""}`;

export const slugIdFrom = (segment: string) => {
  const parts = segment.split("-");
  return parts[parts.length - 1] ?? segment;
};
