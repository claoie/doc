import { sql } from "server/db";
import { publicGet } from "server/lib/http";

export const routes = [
  publicGet("/health", async () => {
    await sql`SELECT 1`;
    return { ok: true };
  }),
];
