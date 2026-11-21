export interface ApiResponse<T = any> {
  status: number;
  /** The parsed JSON body, or null when the body is empty or not JSON. */
  body: { data: T; error?: { code: string; message: string } };
  headers: Headers;
  /** The body as text. */
  text: string;
}

export interface ClientOptions {
  /** The address the server sees (through `X-Forwarded-For`; the servers run with `TRUST_PROXY`). */
  ip?: string;
}

let nextIp = 1;

/** A fresh client address, so one test's rate limits never count against another's. */
export const uniqueIp = () => {
  const n = nextIp++;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};

const parse = (text: string) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** HTTP client with a cookie jar, the way a browser would talk to the API. */
export class Client {
  readonly cookies = new Map<string, string>();
  ip: string;

  constructor(
    readonly base: string,
    options: ClientOptions = {},
  ) {
    this.ip = options.ip ?? uniqueIp();
  }

  /** The session cookie's value, or null when signed out. */
  get cookie(): string | null {
    return this.cookies.get("session") ?? null;
  }

  set cookie(value: string | null) {
    if (value === null) this.cookies.delete("session");
    else this.cookies.set("session", value);
  }

  /** The `Cookie` header this client sends. */
  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private remember(res: Response) {
    for (const header of res.headers.getSetCookie()) {
      const match = /^([^=;\s]+)=([^;]*)/.exec(header);
      if (!match) continue;
      if (/Max-Age=0/i.test(header) || !match[2]) this.cookies.delete(match[1]!);
      else this.cookies.set(match[1]!, match[2]!);
    }
  }

  /** A request to `/api<pathname>` with this client's cookies and address; redirects are not followed. */
  async raw(method: string, pathname: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(`/api${pathname}`, { ...init, method });
  }

  /** A request to any path of the server (the static files live outside `/api`). */
  async fetch(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size && !headers.has("cookie")) headers.set("cookie", this.cookieHeader());
    if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", this.ip);
    const res = await fetch(`${this.base}${pathname}`, { ...init, headers, redirect: "manual" });
    this.remember(res);
    return res;
  }

  async request<T = any>(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const res = await this.raw(method, pathname, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    });
    const text = await res.text();
    return { status: res.status, body: parse(text), headers: res.headers, text };
  }

  get<T = any>(pathname: string) {
    return this.request<T>("GET", pathname);
  }

  post<T = any>(pathname: string, body: unknown = {}) {
    return this.request<T>("POST", pathname, body);
  }

  /** Uploads a page file the way the app does: the raw bytes as the request body. */
  async uploadFile<T = any>(file: File, pageId: string, replaceId?: string): Promise<ApiResponse<T>> {
    const query = new URLSearchParams({ pageId, name: file.name, ...(replaceId ? { replaceId } : {}) });
    const res = await this.raw("POST", `/files?${query}`, { body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
    const text = await res.text();
    return { status: res.status, body: parse(text), headers: res.headers, text };
  }

  /** A multipart form upload (avatars, logos, icons). */
  async upload<T = any>(pathname: string, fields: Record<string, string | Blob>): Promise<ApiResponse<T>> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const res = await this.raw("POST", pathname, { body: form });
    const text = await res.text();
    return { status: res.status, body: parse(text), headers: res.headers, text };
  }
}
