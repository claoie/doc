import { HttpError } from "./http";

const WINDOW_MS = 60_000;
const MAX_TRACKED = 10_000;

const buckets = new Map<string, { count: number; resetAt: number }>();

const sweep = (now: number) => {
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
};

/** Fixed one-minute window per `scope` + client IP; throws 429 once `limit` is exceeded. */
export const rateLimit = (scope: string, ip: string, limit = 10) => {
  const now = Date.now();
  if (buckets.size > MAX_TRACKED) sweep(now);
  const key = `${scope}:${ip}`;
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, bucket);
  }
  bucket.count++;
  if (bucket.count > limit) {
    throw new HttpError(429, "rate_limited", "Too many attempts. Try again in a minute.");
  }
};

export const resetRateLimits = () => buckets.clear();
