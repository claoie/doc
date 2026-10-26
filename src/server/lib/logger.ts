import { config } from "server/config";

type Fields = Record<string, unknown>;

const write = (level: "info" | "warn" | "error", message: string, fields?: Fields) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg: message, ...fields });
  if (level === "info") console.log(line);
  else console.error(line);
};

const errorFields = (error: unknown): Fields =>
  error instanceof Error ? { error: error.message, stack: error.stack } : { error: String(error) };

export const log = {
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, error?: unknown, fields?: Fields) =>
    write("error", message, { ...fields, ...(error === undefined ? {} : errorFields(error)) }),
};

export interface RequestLog {
  method: string;
  path: string;
  status: number;
  ms: number;
  userId: string | null;
}

/** One line per request. Only the path is logged: query strings may carry tokens or share keys. */
export const logRequest = (entry: RequestLog) => {
  // Health checks poll constantly and carry no debugging value.
  if (!config.logRequests || entry.path === "/api/health") return;
  console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));
};
