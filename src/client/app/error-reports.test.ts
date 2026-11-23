import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { reportError, resetErrorReports, startErrorReports } from "./error-reports";

type Listener = (event: any) => void;

describe("error reports", () => {
  let listeners: Record<string, Listener>;
  let sent: any[];

  beforeEach(() => {
    listeners = {};
    sent = [];
    (globalThis as any).window = {
      location: { pathname: "/s/general/p/notes-abc", search: "?token=secret" },
      addEventListener: (type: string, listener: Listener) => (listeners[type] = listener),
    };
    spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
      sent.push({ url, method: init.method, keepalive: init.keepalive, body: JSON.parse(init.body as string) });
      return new Response(null, { status: 200 });
    }) as never);
  });

  afterEach(() => {
    mock.restore();
    resetErrorReports();
    delete (globalThis as any).window;
  });

  test("sends the message, the page's path without its query, and the stack", () => {
    const error = new TypeError("x is undefined");
    error.stack = "TypeError: x is undefined\n    at render (app.js:1:2)";
    reportError(error);
    expect(sent).toEqual([
      {
        url: "/api/client-error",
        method: "POST",
        keepalive: true,
        body: { message: "TypeError: x is undefined", url: "/s/general/p/notes-abc", stack: "TypeError: x is undefined\n    at render (app.js:1:2)" },
      },
    ]);
  });

  test("sends each message once and five in all", () => {
    reportError("same");
    reportError("same");
    for (let i = 0; i < 10; i++) reportError(`error ${i}`);
    expect(sent.map((s) => s.body.message)).toEqual(["same", "error 0", "error 1", "error 2", "error 3"]);
  });

  test("cuts what it sends to the server's limits, counting code points", () => {
    const error = new Error("😀".repeat(2000));
    error.stack = "😀".repeat(5000);
    reportError(error);
    const { body } = sent[0];
    expect([...body.message]).toHaveLength(1000);
    expect([...body.stack]).toHaveLength(4000);
  });

  test("reports uncaught errors and unhandled rejections, but not errors without an error object", () => {
    startErrorReports();
    listeners.error!({ error: new Error("thrown"), message: "Uncaught Error: thrown" });
    listeners.error!({ error: null, message: "Script error." });
    listeners.error!({ error: null, message: "ResizeObserver loop completed with undelivered notifications." });
    listeners.unhandledrejection!({ reason: new Error("rejected") });
    listeners.unhandledrejection!({ reason: "a string" });
    expect(sent.map((s) => s.body.message)).toEqual(["Error: thrown", "Error: rejected", "a string"]);
  });

  test("skips a blank message, and names a missing reason", () => {
    reportError("   ");
    reportError(undefined);
    expect(sent.map((s) => s.body.message)).toEqual(["undefined"]);
  });
});
