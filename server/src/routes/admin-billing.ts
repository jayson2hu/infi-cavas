import { randomInt } from "node:crypto";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { balance, grantInTransaction, lockWorkspace, setPlanInTransaction } from "../billing/ledger";
import { db, type Transaction } from "../db/client";
import { redeemCodes, users, workspaces } from "../db/schema";
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
