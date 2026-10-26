import { existsSync } from "node:fs";
import path from "node:path";
import { createApp } from "server/app";
import { config } from "server/config";
import { connect, disconnect, migrate } from "server/db";
import { purgeExpiredSessions } from "server/lib/auth";
import { log } from "server/lib/logger";
import { flushMail } from "server/lib/mail";
import { purgeTrash } from "server/lib/pages";
import { shutdownRealtime } from "server/realtime/ws";
import type { SocketData } from "server/realtime/hub";

const HOUR = 60 * 60 * 1000;

/**
 * The bundle lives in `build/server`, next to `build/client`; in development
 * this file runs from `src/server`, where the sibling `client` is source code.
 */
const resolveStaticDir = (): string | null => {
  const dev = path.basename(import.meta.dir) === "server" && path.basename(path.dirname(import.meta.dir)) === "src";
  const dir = dev ? path.resolve(import.meta.dir, "..", "..", "build", "client") : path.resolve(import.meta.dir, "..", "client");
  return existsSync(path.join(dir, "index.html")) ? dir : null;
};

const runHousekeeping = async () => {
  try {
    const purged = await purgeTrash();
    if (purged) log.info("trash purged", { pages: purged });
    await purgeExpiredSessions();
  } catch (error) {
    log.error("housekeeping failed", error);
  }
};

const main = async () => {
  connect(config.databaseUrl, config.databasePoolMax);
  await migrate();
  const staticDir = resolveStaticDir();
  const app = createApp({ staticDir });
  const server = Bun.serve<SocketData>({
    port: config.port,
    maxRequestBodySize: config.fileSizeLimit + 2 * 1024 * 1024,
    idleTimeout: 60,
    fetch: app.fetch,
    websocket: app.websocket,
  });
  log.info("server started", { port: server.port, staticDir });

  setTimeout(runHousekeeping, 60_000).unref();
  setInterval(runHousekeeping, HOUR).unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    try {
      await shutdownRealtime();
      await server.stop();
      await flushMail();
      await disconnect();
    } catch (error) {
      log.error("shutdown failed", error);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
};

main().catch((error) => {
  log.error("startup failed", error);
  process.exit(1);
});
