import { post, readJson } from "server/lib/http";
import { log } from "server/lib/logger";
import { rateLimit } from "server/lib/ratelimit";
import { input } from "server/lib/validate";

export const routes = [
  /** An error the web app did not handle, logged at error level and so sent on to the alarm webhook. */
  post("/client-error", async (ctx) => {
    rateLimit("client-error", ctx.ip);
    const body = input(await readJson(ctx));
    const message = body.string("message", { max: 1000 });
    const url = body.optionalString("url", { max: 1000 });
    const stack = body.optionalString("stack", { max: 4000, trim: false });
    log.error("client error", undefined, { message, url, stack, userId: ctx.user.id });
    return {};
  }),
];
