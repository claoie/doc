import { Fragment, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Notification } from "common/api-types";
import { api } from "../api";
import { navigate, pageUrl } from "../router";
import { realtime } from "../realtime";
import { Avatar, Button, EmptyState, Spinner, cx, timeAgo } from "../components/ui";

const unreadListeners = new Set<(n: number) => void>();
let unreadValue = 0;

const setUnread = (n: number) => {
  unreadValue = n;
  unreadListeners.forEach((l) => l(n));
};

const refreshUnread = () =>
  api
    .unreadCount()
    .then((r) => setUnread(r.count))
    .catch(() => undefined);

export const useUnreadCount = () => {
  const [count, setCount] = useState(unreadValue);
  useEffect(() => {
    unreadListeners.add(setCount);
    void refreshUnread();
    const off = realtime.onEvent((e) => e.kind === "notification" && void refreshUnread());
    return () => {
      unreadListeners.delete(setCount);
      off();
    };
  }, []);
  return count;
};

const describe = (n: Notification) => {
  const who = n.actor?.name ?? "Someone";
  const page = n.page?.title || "Untitled";
  switch (n.kind) {
    case "comment.created":
      return `${who} commented on ${page}`;
    case "comment.reply":
      return `${who} replied to a comment on ${page}`;
    case "comment.mention":
      return `${who} mentioned you in a comment on ${page}`;
    case "page.mention":
      return `${who} mentioned you in ${page}`;
    case "page.updated":
      return `${who} updated ${page}`;
  }
};

type Tab = "all" | "direct" | "updates";

const DIRECT: Notification["kind"][] = ["comment.mention", "page.mention", "comment.reply"];

const groupOf = (iso: string, now = new Date()) => {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "This week";
  return "Older";
};

export const NotificationsPanel = ({ onClose }: { onClose: () => void }) => {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [tab, setTab] = useState<Tab>("all");

  const load = useCallback(() => {
    api
      .notifications({ limit: 100, unread: unreadOnly })
      .then(setItems)
      .catch(() => setItems([]));
  }, [unreadOnly]);

  useEffect(() => {
    load();
    return realtime.onEvent((e) => e.kind === "notification" && load());
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const visible = items?.filter((n) => tab === "all" || (tab === "direct") === DIRECT.includes(n.kind));

  const open = async (n: Notification) => {
    if (!n.readAt) {
      await api.readNotifications([n.id]).catch(() => undefined);
      void refreshUnread();
    }
    if (n.page) {
      onClose();
      const hash = n.comment ? `#comment-${n.comment.id}` : "";
      navigate(pageUrl(n.page.spaceSlug, n.page) + hash);
    }
  };

  return createPortal(
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer notifications" aria-label="Notifications">
        <div className="drawer-head">
          <h2>Notifications</h2>
          <div className="row gap-s">
            <button type="button" className={cx("chip", unreadOnly && "active")} onClick={() => setUnreadOnly((u) => !u)}>
              Unread
            </button>
            <Button
              variant="ghost"
              onClick={async () => {
                await api.readAllNotifications();
                setUnread(0);
                load();
              }}
            >
              Mark all read
            </Button>
          </div>
        </div>
        <div className="tabs notification-tabs">
          {(["all", "direct", "updates"] as const).map((t) => (
            <button key={t} type="button" className={cx("tab", tab === t && "active")} onClick={() => setTab(t)}>
              {t === "all" ? "All" : t === "direct" ? "Direct" : "Updates"}
            </button>
          ))}
        </div>
        <div className="drawer-body">
          {!items && <Spinner />}
          {visible?.length === 0 && <EmptyState icon="inbox" title="You're all caught up" />}
          {visible?.map((n, i) => (
            <Fragment key={n.id}>
            {(i === 0 || groupOf(visible[i - 1]!.createdAt) !== groupOf(n.createdAt)) && <div className="notification-group">{groupOf(n.createdAt)}</div>}
            <button type="button" className={cx("notification", !n.readAt && "unread")} onClick={() => open(n)}>
              <Avatar name={n.actor?.name} url={n.actor?.avatarUrl} size={28} />
              <span className="notification-body">
                <span>{describe(n)}</span>
                <span className="muted small">{timeAgo(n.createdAt)}</span>
              </span>
              {!n.readAt && (
                <span
                  role="button"
                  tabIndex={0}
                  className="dot"
                  title="Mark as read"
                  aria-label="Mark as read"
                  onClick={async (e) => {
                    e.stopPropagation();
                    await api.readNotifications([n.id]).catch(() => undefined);
                    void refreshUnread();
                    load();
                  }}
                />
              )}
            </button>
            </Fragment>
          ))}
        </div>
      </aside>
    </div>,
    document.body,
  );
};
