import { and, eq, gt } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { db, type Transaction } from "../db/client";
import { lockWorkspace } from "../billing/ledger";
import { sessions, users, workspaceMembers, workspaces } from "../db/schema";
import { env } from "../env";
import type { AppEnv } from "../lib/context";
import { ApiError, invariant } from "../lib/errors";
import { tokenHash } from "../lib/ids";

export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const cookieOptions = { httpOnly: true, secure: new URL(env.APP_ORIGIN).protocol === "https:", sameSite: "Lax" as const, path: "/", maxAge: SESSION_SECONDS };

export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, "ic_session");
  invariant(token, 401, "unauthenticated", "请先登录");
  const [found] = await db.select({ session: sessions, user: users }).from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash(token)), gt(sessions.expiresAt, new Date())));
  invariant(found, 401, "unauthenticated", "登录已过期，请重新登录");
  if (found.session.expiresAt.getTime() - Date.now() < SESSION_SECONDS * 500) {
    await db.update(sessions).set({ expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000) }).where(eq(sessions.id, found.session.id));
    setCookie(c, "ic_session", token, cookieOptions);
  }
  c.set("user", found.user);
  await next();
});

export async function workspaceContext(c: Context<AppEnv>, requestedId?: string) {
  const workspaceId = requestedId || c.req.header("X-IC-Workspace") || c.get("user").lastWorkspaceId;
  invariant(workspaceId, 403, "workspace_required", "请选择工作区");
  const [found] = await db.select({ workspace: workspaces, membership: workspaceMembers }).from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, c.get("user").id), eq(workspaceMembers.workspaceId, workspaceId)));
  invariant(found, 403, "workspace_forbidden", "无权访问此工作区");
  c.set("workspace", found.workspace);
  c.set("membership", found.membership);
  return found;
}

export const requireWorkspace = createMiddleware<AppEnv>(async (c, next) => { await workspaceContext(c); await next(); });
export async function requireWorkspaceRoleInTransaction(tx: Transaction, workspaceId: string, userId: string, roles: Array<"owner" | "admin" | "member"> = ["owner", "admin"]) {
  await lockWorkspace(tx, workspaceId);
  const [membership] = await tx.select().from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).for("update");
  invariant(membership && roles.includes(membership.role), 403, "forbidden", "没有执行此操作的权限");
  return membership;
}
export const requireWorkspaceRole = (...roles: Array<"owner" | "admin" | "member">) => createMiddleware<AppEnv>(async (c, next) => {
  if (!roles.includes(c.get("membership").role)) throw new ApiError(403, "forbidden", "没有执行此操作的权限");
  await next();
});
export const requirePlatformAdmin = createMiddleware<AppEnv>(async (c, next) => {
  invariant(c.get("user").isPlatformAdmin, 403, "forbidden", "需要平台管理员权限");
  await next();
});
