import { createMiddleware } from "hono/factory";
import { env } from "../env";
import { invariant } from "../lib/errors";

export const checkOrigin = createMiddleware(async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    // API Token is separately authenticated by the gateway; browser placeholder tokens still require Origin.
    const isTokenGateway = c.req.path.startsWith("/api/gateway/") && /^Bearer ick_\S+$/.test(c.req.header("Authorization") ?? "");
    invariant(isTokenGateway || c.req.header("Origin") === new URL(env.APP_ORIGIN).origin, 403, "invalid_origin", "请求来源不受信任");
  }
  await next();
});
