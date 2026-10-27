import { randomInt } from "node:crypto";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { balance, grantInTransaction, lockWorkspace, setPlanInTransaction } from "../billing/ledger";
import { db, type Transaction } from "../db/client";
import { planUpgradeRequests, plans, redeemCodes, users, workspaces } from "../db/schema";
import type { AppEnv } from "../lib/context";
import { invariant } from "../lib/errors";
import { requirePlatformAdmin, requireSession } from "../middleware/session";
import { nextCursor, PAGE_SIZE, readCursor } from "./billing";

const positiveInteger = z.number().int().min(1).max(2147483647);
const validDays = positiveInteger.nullable().optional();
const kind = z.enum(["purchase", "gift"]);
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const createCode = () => Array.from({ length: 16 }, () => codeAlphabet[randomInt(codeAlphabet.length)]).join("");

async function assertAdmin(tx: Transaction, userId: string) {
  const [user] = await tx.select({ allowed: users.isPlatformAdmin }).from(users).where(eq(users.id, userId)).for("update");
  invariant(user?.allowed, 403, "forbidden", "需要平台管理员权限");
}

export const adminBillingRoutes = new Hono<AppEnv>();
adminBillingRoutes.use("*", requireSession, requirePlatformAdmin);
adminBillingRoutes.get("/workspaces", async (c) => {
  const cursor = readCursor(c.req.query("cursor"));
  const q = c.req.query("q")?.trim();
  const rows = await db.select({
    id: workspaces.id, name: workspaces.name, kind: workspaces.kind, ownerId: workspaces.ownerId, ownerEmail: users.email,
    plan: workspaces.plan, planMonthlyCredits: workspaces.planMonthlyCredits, periodEnd: workspaces.periodEnd, createdAt: workspaces.createdAt,
    balance: sql<number>`(select coalesce(sum(b.remaining), 0) from credit_buckets b where b.workspace_id = ${workspaces.id} and (b.expires_at is null or b.expires_at > clock_timestamp()))`.mapWith(Number),
    monthCharged: sql<number>`(select coalesce(sum(j.charged_credits), 0) from generation_jobs j where j.workspace_id = ${workspaces.id} and j.created_at >= date_trunc('month', clock_timestamp()))`.mapWith(Number),
    cursorCreatedAt: sql<string>`to_char(${workspaces.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(workspaces).innerJoin(users, eq(users.id, workspaces.ownerId)).where(and(
    q ? ilike(workspaces.name, `%${q}%`) : undefined,
    cursor ? sql`(${workspaces.createdAt}, ${workspaces.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id})` : undefined,
  )).orderBy(desc(workspaces.createdAt), desc(workspaces.id)).limit(PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  return c.json({ items: page.map(({ cursorCreatedAt: _, ...workspace }) => workspace), nextCursor: rows.length > PAGE_SIZE ? nextCursor(page.at(-1)) : null });
});

adminBillingRoutes.post("/workspaces/:workspaceId/grant", async (c) => {
  const input = z.object({ credits: positiveInteger, kind, validDays, note: z.string().optional() }).parse(await c.req.json());
  const workspaceId = c.req.param("workspaceId");
  const expiresAt = input.validDays == null ? null : new Date(Date.now() + input.validDays * 86400000);
  invariant(!expiresAt || Number.isFinite(expiresAt.getTime()), 422, "invalid_expiration", "点数有效期不合法");
  const result = await db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    await assertAdmin(tx, c.get("user").id);
    const bucket = await grantInTransaction(tx, { workspaceId, userId: c.get("user").id, kind: input.kind, amount: input.credits, expiresAt, source: `admin:${c.get("user").id}`, note: input.note });
    return { bucketId: bucket.id, ...await balance(workspaceId, tx) };
  });
  return c.json(result);
});

adminBillingRoutes.put("/workspaces/:workspaceId/plan", async (c) => {
  const input = z.object({ plan: z.enum(["free", "team", "enterprise"]), monthlyCredits: z.number().int().min(0).max(2147483647) }).parse(await c.req.json());
  const workspaceId = c.req.param("workspaceId");
  const result = await db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    await assertAdmin(tx, c.get("user").id);
    const workspace = await setPlanInTransaction(tx, workspaceId, input.plan, input.monthlyCredits, c.get("user").id);
    return { workspace, ...await balance(workspaceId, tx) };
  });
  return c.json(result);
});

adminBillingRoutes.get("/redeem-codes", async (c) => c.json(await db.select().from(redeemCodes).orderBy(desc(redeemCodes.createdAt), redeemCodes.code)));
adminBillingRoutes.post("/redeem-codes", async (c) => {
  const input = z.object({ credits: positiveInteger, kind, count: z.number().int().min(1).max(500), maxUses: positiveInteger.default(1), validDays, expiresAt: z.iso.datetime({ offset: true }).nullable().optional(), note: z.string().optional() }).parse(await c.req.json());
  const codes = Array.from({ length: input.count }, createCode);
  await db.transaction(async (tx) => {
    await assertAdmin(tx, c.get("user").id);
    await tx.insert(redeemCodes).values(codes.map((code) => ({ code, credits: input.credits, kind: input.kind, maxUses: input.maxUses, validDays: input.validDays ?? null, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, createdBy: c.get("user").id, note: input.note })));
  });
  return c.json({ codes }, 201);
});

adminBillingRoutes.get("/plans", async (c) => c.json(await db.select().from(plans).orderBy(plans.sort, plans.id)));
adminBillingRoutes.put("/plans/:planId", async (c) => {
  const input = z.object({ name: z.string().trim().min(1).max(40), monthlyCredits: z.number().int().min(0).max(2147483647), priceText: z.string().trim().max(40).nullable().optional(), description: z.string().trim().max(200).nullable().optional(), isActive: z.boolean(), sort: z.number().int().default(0) }).parse(await c.req.json());
  const planId = c.req.param("planId");
  const updated = await db.transaction(async (tx) => {
    await assertAdmin(tx, c.get("user").id);
    const [row] = await tx.update(plans).set({ ...input, priceText: input.priceText || null, description: input.description || null, updatedAt: new Date() }).where(eq(plans.id, planId)).returning();
    invariant(row, 404, "plan_not_found", "套餐不存在");
    return row;
  });
  return c.json(updated);
});

adminBillingRoutes.get("/plan-requests", async (c) => {
  const status = z.enum(["pending", "approved", "rejected", "all"]).default("pending").parse(c.req.query("status") || undefined);
  const rows = await db.select({
    id: planUpgradeRequests.id, workspaceId: planUpgradeRequests.workspaceId, workspaceName: workspaces.name, requesterEmail: users.email,
    planId: planUpgradeRequests.planId, planName: plans.name, monthlyCredits: plans.monthlyCredits, fromPlan: planUpgradeRequests.fromPlan,
    note: planUpgradeRequests.note, status: planUpgradeRequests.status, reviewNote: planUpgradeRequests.reviewNote, createdAt: planUpgradeRequests.createdAt, reviewedAt: planUpgradeRequests.reviewedAt,
  }).from(planUpgradeRequests)
    .innerJoin(workspaces, eq(workspaces.id, planUpgradeRequests.workspaceId))
    .innerJoin(users, eq(users.id, planUpgradeRequests.userId))
    .innerJoin(plans, eq(plans.id, planUpgradeRequests.planId))
    .where(status === "all" ? undefined : eq(planUpgradeRequests.status, status))
    .orderBy(desc(planUpgradeRequests.createdAt)).limit(200);
  return c.json(rows);
});

async function lockPendingRequest(tx: Transaction, requestId: string) {
  const [request] = await tx.select().from(planUpgradeRequests).where(eq(planUpgradeRequests.id, requestId)).for("update");
  invariant(request, 404, "request_not_found", "申请不存在");
  invariant(request.status === "pending", 409, "request_closed", "该申请已处理");
  return request;
}
adminBillingRoutes.post("/plan-requests/:requestId/approve", async (c) => {
  const input = z.object({ note: z.string().trim().max(500).optional() }).parse(await c.req.json().catch(() => ({})));
  const userId = c.get("user").id;
  const result = await db.transaction(async (tx) => {
    await assertAdmin(tx, userId);
    const request = await lockPendingRequest(tx, c.req.param("requestId"));
    const [plan] = await tx.select().from(plans).where(eq(plans.id, request.planId));
    // 以批准时的套餐额度为准，管理员可先在套餐目录里调整再批准。
    const workspace = await setPlanInTransaction(tx, request.workspaceId, plan.id as "free" | "team" | "enterprise", plan.monthlyCredits, userId);
    await tx.update(planUpgradeRequests).set({ status: "approved", reviewedBy: userId, reviewNote: input.note || null, reviewedAt: new Date() }).where(eq(planUpgradeRequests.id, request.id));
    return { workspace, ...await balance(request.workspaceId, tx) };
  });
  return c.json(result);
});
adminBillingRoutes.post("/plan-requests/:requestId/reject", async (c) => {
  const input = z.object({ reason: z.string().trim().min(1).max(500) }).parse(await c.req.json());
  const userId = c.get("user").id;
  await db.transaction(async (tx) => {
    await assertAdmin(tx, userId);
    const request = await lockPendingRequest(tx, c.req.param("requestId"));
    await tx.update(planUpgradeRequests).set({ status: "rejected", reviewedBy: userId, reviewNote: input.reason, reviewedAt: new Date() }).where(eq(planUpgradeRequests.id, request.id));
  });
  return c.body(null, 204);
});
