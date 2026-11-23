import { until } from "./server";

export interface WebhookPost {
  contentType: string | null;
  body: any;
}

export interface FakeWebhook {
  /** The URL to give the server as `DISCORD_ALARM_WEBHOOK`. */
  url: string;
  /** What was posted to it, in order. */
  posts: WebhookPost[];
  /** The status it answers with. Default 204, as Discord does. */
  status: number;
  /** Resolves with the posts once there are at least `count`. */
  waitFor(count: number, timeoutMs?: number): Promise<WebhookPost[]>;
  stop(): Promise<void>;
}

/** A stand-in for a Discord webhook. */
export const startFakeWebhook = (): FakeWebhook => {
  const posts: WebhookPost[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      posts.push({ contentType: req.headers.get("content-type"), body: JSON.parse(await req.text()) });
      return new Response(null, { status: hook.status });
    },
  });
  const hook: FakeWebhook = {
    url: `http://127.0.0.1:${server.port}/api/webhooks/1/token`,
    posts,
    status: 204,
    waitFor: (count, timeoutMs = 5000) => until(() => (posts.length >= count ? posts : null), timeoutMs, `${count} webhook posts`),
    stop: () => server.stop(true),
  };
  return hook;
};
