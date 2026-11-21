import net from "node:net";

export interface RawResponse {
  status: number;
  /** Header names lower-cased; repeated headers joined with ", ". */
  headers: Record<string, string>;
  body: string;
  /** Everything the server sent, undecoded. */
  raw: string;
}

/**
 * Sends bytes to the server over a plain socket and returns its first answer.
 * For requests `fetch` cannot make: a request line that is not normalized
 * (`/../`, a NUL byte), or headers that do not match the body (a declared
 * `Content-Length` with no body behind it).
 *
 * `head` is the request line and headers, lines separated by `\n` (sent as
 * CRLF), without the final blank line; `Connection: close` is added.
 */
export const rawRequest = (port: number, head: string, body: Uint8Array | string = "", timeoutMs = 5000): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, "localhost");
    const chunks: Buffer[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      const raw = Buffer.concat(chunks).toString("latin1");
      const split = raw.indexOf("\r\n\r\n");
      const headerBlock = split < 0 ? raw : raw.slice(0, split);
      const [statusLine = "", ...lines] = headerBlock.split("\r\n");
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1] ?? 0);
      if (!status) return reject(new Error(`no HTTP answer: ${JSON.stringify(raw.slice(0, 200))}`));
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
      }
      let payload = split < 0 ? "" : raw.slice(split + 4);
      if (/chunked/i.test(headers["transfer-encoding"] ?? "")) {
        let decoded = "";
        for (let at = 0; at < payload.length; ) {
          const lineEnd = payload.indexOf("\r\n", at);
          if (lineEnd < 0) break;
          const size = parseInt(payload.slice(at, lineEnd), 16);
          if (!size) break;
          decoded += payload.slice(lineEnd + 2, lineEnd + 2 + size);
          at = lineEnd + 2 + size + 2;
        }
        payload = decoded;
      }
      resolve({ status, headers, body: Buffer.from(payload, "latin1").toString("utf8"), raw });
    };
    const complete = () => {
      const raw = Buffer.concat(chunks).toString("latin1");
      const split = raw.indexOf("\r\n\r\n");
      if (split < 0) return false;
      const headerBlock = raw.slice(0, split).toLowerCase();
      if (/^head /i.test(head)) return true;
      const length = /\r\ncontent-length:\s*(\d+)/.exec(headerBlock)?.[1];
      if (length !== undefined) return raw.length - split - 4 >= Number(length);
      if (/\r\ntransfer-encoding:\s*chunked/.test(headerBlock)) return raw.endsWith("0\r\n\r\n");
      return /^http\/1\.[01] (1\d\d|204|304)/.test(headerBlock);
    };
    const timer = setTimeout(() => (chunks.length ? finish() : (socket.destroy(), reject(new Error("no answer from the server")))), timeoutMs);
    socket.on("connect", () => {
      socket.write(`${head.split("\n").join("\r\n")}\r\nConnection: close\r\n\r\n`);
      if (body.length) socket.write(body);
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (complete()) finish();
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", (error) => {
      if (chunks.length) finish();
      else if (!done) {
        done = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
