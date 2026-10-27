import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { db } from "../db/client";
import { apiTokens, users } from "../db/schema";
import type { AppEnv } from "../lib/context";
import { invariant } from "../lib/errors";
import { tokenHash } from "../lib/ids";
import { requireSession, workspaceContext } from "../middleware/session";

export const gatewayAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = c.req.header("Authorization")?.match(/^Bearer (ick_\S+)$/)?.[1];
  if (!token) return requireSession(c, async () => { await workspaceContext(c); await next(); });
  const [found] = await db.select({ token: apiTokens, user: users }).from(apiTokens).innerJoin(users, eq(users.id, apiTokens.userId)).where(and(eq(apiTokens.tokenHash, tokenHash(token)), isNull(apiTokens.revokedAt)));
  invariant(found, 401, "invalid_token", "API Token 无效");
  invariant(!c.req.header("X-IC-Workspace") || c.req.header("X-IC-Workspace") === found.token.workspaceId, 403, "workspace_forbidden", "Token 不属于此工作区");
  c.set("user", found.user);
  c.set("apiTokenId", found.token.id);
  await workspaceContext(c, found.token.workspaceId);
  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, found.token.id));
  await next();
});
