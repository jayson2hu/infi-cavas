import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db, type Transaction } from "../db/client";
import { brands, users, workspaceInvites, workspaceMembers, workspaces } from "../db/schema";
import { env } from "../env";
import { lockWorkspace } from "../billing/ledger";
import type { AppEnv } from "../lib/context";
import { invariant } from "../lib/errors";
import { id, randomToken } from "../lib/ids";
import { requireSession, requireWorkspaceRoleInTransaction, workspaceContext } from "../middleware/session";

export async function listWorkspaces(userId: string) {
  return db.select({ id: workspaces.id, name: workspaces.name, kind: workspaces.kind, role: workspaceMembers.role, plan: workspaces.plan, defaultBrandId: workspaces.defaultBrandId, memberCount: sql<number>`(select count(*)::int from workspace_members m where m.workspace_id = ${workspaces.id})` })
    .from(workspaceMembers).innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId)).where(eq(workspaceMembers.userId, userId)).orderBy(workspaces.createdAt);
}

export async function acceptInvite(tx: Transaction, token: string, userId: string) {
  const [location] = await tx.select({ workspaceId: workspaceInvites.workspaceId }).from(workspaceInvites).where(eq(workspaceInvites.token, token));
  invariant(location, 404, "invite_not_found", "邀请不存在");
  await lockWorkspace(tx, location.workspaceId);
  const [invite] = await tx.select().from(workspaceInvites).where(eq(workspaceInvites.token, token)).for("update");
  invariant(invite, 404, "invite_not_found", "邀请不存在");
  invariant(!invite.acceptedAt && invite.expiresAt > new Date(), 409, "invite_expired", "邀请已过期或已使用");
  // Existing members must never gain a higher role by accepting another invitation.
  await tx.insert(workspaceMembers).values({ workspaceId: invite.workspaceId, userId, role: invite.role }).onConflictDoNothing();
  await tx.update(workspaceInvites).set({ acceptedAt: new Date(), acceptedBy: userId }).where(eq(workspaceInvites.token, token));
  await tx.update(users).set({ lastWorkspaceId: invite.workspaceId, updatedAt: new Date() }).where(eq(users.id, userId));
  return invite.workspaceId;
}

export const workspaceRoutes = new Hono<AppEnv>();
workspaceRoutes.use("*", requireSession);
workspaceRoutes.get("/", async (c) => c.json(await listWorkspaces(c.get("user").id)));
workspaceRoutes.post("/", async (c) => {
  const { name } = z.object({ name: z.string().trim().min(1) }).parse(await c.req.json());
  const workspaceId = id("ws");
  await db.transaction(async (tx) => {
    await tx.insert(workspaces).values({ id: workspaceId, name, kind: "team", ownerId: c.get("user").id });
    await tx.insert(workspaceMembers).values({ workspaceId, userId: c.get("user").id, role: "owner" });
    await tx.update(users).set({ lastWorkspaceId: workspaceId }).where(eq(users.id, c.get("user").id));
  });
  return c.json((await listWorkspaces(c.get("user").id)).find((workspace) => workspace.id === workspaceId)!, 201);
});
workspaceRoutes.use("/:workspaceId/*", async (c, next) => { await workspaceContext(c, c.req.param("workspaceId")); await next(); });
workspaceRoutes.patch("/:workspaceId", async (c) => {
  await workspaceContext(c, c.req.param("workspaceId"));
  invariant(c.get("membership").role !== "member", 403, "forbidden", "需要工作区管理员权限");
  const input = z.object({ name: z.string().trim().min(1).optional(), defaultBrandId: z.string().nullable().optional() }).parse(await c.req.json());
  await db.transaction(async (tx) => {
    await requireWorkspaceRoleInTransaction(tx, c.get("workspace").id, c.get("user").id);
    if (input.defaultBrandId) {
      const [brand] = await tx.select().from(brands).where(and(eq(brands.id, input.defaultBrandId), eq(brands.workspaceId, c.get("workspace").id)));
      invariant(brand, 403, "brand_forbidden", "品牌不属于此工作区");
    }
    await tx.update(workspaces).set({ ...input, updatedAt: new Date() }).where(eq(workspaces.id, c.get("workspace").id));
  });
  return c.json((await listWorkspaces(c.get("user").id)).find((workspace) => workspace.id === c.get("workspace").id)!);
});
const memberSelection = { userId: users.id, name: users.name, email: users.email, avatarUrl: users.avatarUrl, role: workspaceMembers.role, monthlyCap: workspaceMembers.monthlyCap, joinedAt: workspaceMembers.joinedAt };
workspaceRoutes.get("/:workspaceId/members", async (c) => c.json(await db.select(memberSelection).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, c.get("workspace").id))));
workspaceRoutes.patch("/:workspaceId/members/:userId", async (c) => {
  invariant(c.get("membership").role !== "member", 403, "forbidden", "需要工作区管理员权限");
  const input = z.object({ role: z.enum(["admin", "member"]).optional(), monthlyCap: z.number().int().min(0).max(2147483647).nullable().optional() }).parse(await c.req.json());
  const where = and(eq(workspaceMembers.workspaceId, c.get("workspace").id), eq(workspaceMembers.userId, c.req.param("userId")));
  await db.transaction(async (tx) => {
    await requireWorkspaceRoleInTransaction(tx, c.get("workspace").id, c.get("user").id);
    const [member] = await tx.select().from(workspaceMembers).where(where).for("update");
    invariant(member, 404, "member_not_found", "成员不存在");
    invariant(member.role !== "owner", 403, "owner_protected", "不能修改所有者");
    await tx.update(workspaceMembers).set(input).where(where);
  });
  const [member] = await db.select(memberSelection).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(where);
  return c.json(member);
});
workspaceRoutes.delete("/:workspaceId/members/:userId", async (c) => {
  invariant(c.get("membership").role !== "member", 403, "forbidden", "需要工作区管理员权限");
  const where = and(eq(workspaceMembers.workspaceId, c.get("workspace").id), eq(workspaceMembers.userId, c.req.param("userId")));
  await db.transaction(async (tx) => {
    await requireWorkspaceRoleInTransaction(tx, c.get("workspace").id, c.get("user").id);
    const [member] = await tx.select().from(workspaceMembers).where(where).for("update");
    invariant(member, 404, "member_not_found", "成员不存在");
    invariant(member.role !== "owner", 403, "owner_protected", "不能移除所有者");
    await tx.delete(workspaceMembers).where(where);
    await tx.update(users).set({ lastWorkspaceId: null }).where(and(eq(users.id, member.userId), eq(users.lastWorkspaceId, member.workspaceId)));
  });
  return c.body(null, 204);
});
workspaceRoutes.post("/:workspaceId/invites", async (c) => {
  invariant(c.get("membership").role !== "member", 403, "forbidden", "需要工作区管理员权限");
  const body = await c.req.text();
  const { role } = z.object({ role: z.enum(["admin", "member"]).default("member") }).parse(body.trim() ? JSON.parse(body) : {});
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 7 * 86400000);
  await db.transaction(async (tx) => {
    await requireWorkspaceRoleInTransaction(tx, c.get("workspace").id, c.get("user").id);
    await tx.insert(workspaceInvites).values({ token, workspaceId: c.get("workspace").id, role, createdBy: c.get("user").id, expiresAt });
  });
  return c.json({ token, expiresAt, url: `${env.APP_ORIGIN}/invite/${token}` }, 201);
});

export const inviteRoutes = new Hono<AppEnv>();
inviteRoutes.get("/:token", async (c) => {
  const [invite] = await db.select({ workspaceName: workspaces.name, role: workspaceInvites.role, expiresAt: workspaceInvites.expiresAt, acceptedAt: workspaceInvites.acceptedAt }).from(workspaceInvites).innerJoin(workspaces, eq(workspaces.id, workspaceInvites.workspaceId)).where(eq(workspaceInvites.token, c.req.param("token")));
  invariant(invite, 404, "invite_not_found", "邀请不存在");
  return c.json({ workspaceName: invite.workspaceName, role: invite.role, expired: !!invite.acceptedAt || invite.expiresAt <= new Date() });
});
inviteRoutes.post("/:token/accept", requireSession, async (c) => {
  const workspaceId = await db.transaction((tx) => acceptInvite(tx, c.req.param("token"), c.get("user").id));
  return c.json((await listWorkspaces(c.get("user").id)).find((workspace) => workspace.id === workspaceId)!);
});
