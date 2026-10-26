const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

const randomString = (alphabet: string, length: number): string => {
  // Rejection sampling keeps every character uniformly distributed.
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
};

/** Public page identifier used in URLs: 10 base-62 characters. */
export const slugId = (): string => randomString(BASE62, 10);

/** Public share key: 10 characters of `[0-9a-z]`. */
export const shareKey = (): string => randomString(BASE36, 10);

/** Secret token (sessions, password resets, invitations): 32 random bytes, base64url. */
export const token = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_ID_RE = /^[0-9A-Za-z]{1,32}$/;

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

export const isSlugId = (value: unknown): value is string => typeof value === "string" && SLUG_ID_RE.test(value);

/** Short id for records scoped to one parent (base properties, choices): a prefix plus 9 of `[0-9a-z]`. */
export const shortId = (prefix: string): string => prefix + randomString(BASE36, 9);

/**
 * Random v4 UUID. Unlike `crypto.randomUUID`, this also works in pages that
 * are not a secure context (served over plain http on a non-local host).
 */
export const uuid = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
