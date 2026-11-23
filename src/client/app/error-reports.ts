const MAX_REPORTS = 5;
const MESSAGE_MAX = 1000;
const STACK_MAX = 4000;
const URL_MAX = 1000;

const reported = new Set<string>();

const cut = (text: string, max: number) => [...text].slice(0, max).join("");

/**
 * Sends an error the app did not handle to the server, which posts it to the
 * alarm webhook: each message once per page load, and at most five in all.
 */
export const reportError = (error: unknown) => {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).trim();
  if (!message || reported.has(message) || reported.size >= MAX_REPORTS) return;
  reported.add(message);
  const stack = error instanceof Error && error.stack?.trim() ? cut(error.stack, STACK_MAX) : undefined;
  // Only the path: query strings may carry tokens.
  const body = JSON.stringify({ message: cut(message, MESSAGE_MAX), url: cut(window.location.pathname, URL_MAX), stack });
  fetch("/api/client-error", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body,
  }).catch(() => undefined);
};

export const resetErrorReports = () => reported.clear();

export const startErrorReports = () => {
  // Without an error object the event comes from a script of another origin
  // ("Script error.") or from the browser itself (a ResizeObserver loop).
  window.addEventListener("error", (event) => {
    if (event.error != null) reportError(event.error);
  });
  window.addEventListener("unhandledrejection", (event) => reportError(event.reason));
};
