import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { balance, redeem } from "../billing/ledger";
import { db } from "../db/client";
import { creditPackages, creditTransactions, generationJobs, generationOutputs, users, workspaceMembers } from "../db/schema";
import { env } from "../env";
import type { AppEnv } from "../lib/context";
import { ApiError, invariant } from "../lib/errors";
import { requireSession, requireWorkspace, requireWorkspaceRole } from "../middleware/session";

export { balance } from "../billing/ledger";
export const PAGE_SIZE = 50;
export function readCursor(value: string | undefined) {
  if (!value) return null;
  try {
    return z.object({ id: z.string().min(1), createdAt: z.iso.datetime({ offset: true }) })
      .parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new ApiError(422, "invalid_cursor", "分页游标不合法");
  }
}
export const nextCursor = (row?: { id: string; createdAt: Date; cursorCreatedAt?: string }) => row ? Buffer.from(JSON.stringify({ id: row.id, createdAt: row.cursorCreatedAt ?? row.createdAt.toISOString() })).toString("base64url") : null;

export const billingRoutes = new Hono<AppEnv>();
billingRoutes.use("*", requireSession, requireWorkspace);
billingRoutes.get("/summary", async (c) => {
  const workspace = c.get("workspace");
  const month = sql`${generationJobs.createdAt} >= date_trunc('month', clock_timestamp())`;
  const [[stats], [refunds], current] = await Promise.all([
    db.select({
      monthCharged: sql<number>`coalesce(sum(${generationJobs.chargedCredits}) filter (where ${month}), 0)`.mapWith(Number),
      myMonthCharged: sql<number>`coalesce(sum(${generationJobs.chargedCredits}) filter (where ${month} and ${generationJobs.userId} = ${c.get("user").id}), 0)`.mapWith(Number),
      lastMonthSamePeriodCharged: sql<number>`coalesce(sum(${generationJobs.chargedCredits}) filter (where ${generationJobs.createdAt} >= date_trunc('month', clock_timestamp()) - interval '1 month' and ${generationJobs.createdAt} < least(date_trunc('month', clock_timestamp()), date_trunc('month', clock_timestamp()) - interval '1 month' + (clock_timestamp() - date_trunc('month', clock_timestamp())))), 0)`.mapWith(Number),
      image: sql<number>`count(*) filter (where ${month} and ${generationJobs.capability} = 'image')`.mapWith(Number),
      video: sql<number>`count(*) filter (where ${month} and ${generationJobs.capability} = 'video')`.mapWith(Number),
      text: sql<number>`count(*) filter (where ${month} and ${generationJobs.capability} = 'text')`.mapWith(Number),
      audio: sql<number>`count(*) filter (where ${month} and ${generationJobs.capability} = 'audio')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${month} and ${generationJobs.status} in ('failed','timeout'))`.mapWith(Number),
      succeeded: sql<number>`count(*) filter (where ${month} and ${generationJobs.status} = 'succeeded')`.mapWith(Number),
      recentCharged: sql<number>`coalesce(sum(${generationJobs.chargedCredits}) filter (where ${generationJobs.createdAt} >= clock_timestamp() - interval '7 days'), 0)`.mapWith(Number),
    }).from(generationJobs).where(eq(generationJobs.workspaceId, workspace.id)),
    db.select({ amount: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)`.mapWith(Number) }).from(creditTransactions)
      .where(and(eq(creditTransactions.workspaceId, workspace.id), eq(creditTransactions.type, "refund"), sql`${creditTransactions.createdAt} >= date_trunc('month', clock_timestamp())`)),
    balance(workspace.id),
  ]);
  const projected = stats.recentCharged > 0 ? new Date(Date.now() + Math.ceil(current.balance * 7 / stats.recentCharged) * 86400000) : null;
  return c.json({
    plan: workspace.plan, planMonthlyCredits: workspace.planMonthlyCredits, periodEnd: workspace.periodEnd,
    ...current, monthCharged: stats.monthCharged, lastMonthSamePeriodCharged: stats.lastMonthSamePeriodCharged,
    monthJobs: { image: stats.image, video: stats.video, text: stats.text, audio: stats.audio },
    monthRefunded: refunds.amount, monthFailedJobs: stats.failed,
    successRate: stats.succeeded + stats.failed ? stats.succeeded / (stats.succeeded + stats.failed) * 100 : 0,
    projectedDepletionDate: projected && Number.isFinite(projected.getTime()) ? projected.toISOString().slice(0, 10) : null,
    myMonthCharged: stats.myMonthCharged, myMonthlyCap: c.get("membership").monthlyCap, billingEnabled: env.BILLING_ENABLED,
  });
});

billingRoutes.get("/daily", async (c) => {
  const range = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).parse(c.req.query());
  invariant(!range.from || !range.to || range.from <= range.to, 422, "invalid_date_range", "开始日期不能晚于结束日期");
  const from = range.from ? sql`${range.from}::date` : sql`date_trunc('month', clock_timestamp())`;
  const to = range.to ? sql`${range.to}::date + interval '1 day'` : sql`current_date + interval '1 day'`;
  const rows = await db.select({
    date: sql<string>`to_char(${generationJobs.createdAt}, 'YYYY-MM-DD')`,
    image: sql<number>`coalesce(sum(${generationJobs.chargedCredits}) filter (where ${generationJobs.capability} = 'image'), 0)`.mapWith(Number),
    video: sql<number>`coalesce(sum(${generationJobs.chargedCredits}) filter (where ${generationJobs.capability} = 'video'), 0)`.mapWith(Number),
    text: sql<number>`coalesce(sum(${generationJobs.chargedCredits}) filter (where ${generationJobs.capability} = 'text'), 0)`.mapWith(Number),
    audio: sql<number>`coalesce(sum(${generationJobs.chargedCredits}) filter (where ${generationJobs.capability} = 'audio'), 0)`.mapWith(Number),
  }).from(generationJobs).where(and(eq(generationJobs.workspaceId, c.get("workspace").id), sql`${generationJobs.createdAt} >= ${from} and ${generationJobs.createdAt} < ${to}`))
    .groupBy(sql`to_char(${generationJobs.createdAt}, 'YYYY-MM-DD')`).orderBy(sql`to_char(${generationJobs.createdAt}, 'YYYY-MM-DD')`);
  return c.json(rows);
});

billingRoutes.get("/members", requireWorkspaceRole("owner", "admin"), async (c) => {
  return c.json(await db.select({
    userId: users.id, name: users.name, role: workspaceMembers.role, monthlyCap: workspaceMembers.monthlyCap,
    monthCharged: sql<number>`coalesce(sum(${generationJobs.chargedCredits}), 0)`.mapWith(Number),
  }).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId))
    .leftJoin(generationJobs, and(eq(generationJobs.workspaceId, workspaceMembers.workspaceId), eq(generationJobs.userId, workspaceMembers.userId), sql`${generationJobs.createdAt} >= date_trunc('month', clock_timestamp())`))
    .where(eq(workspaceMembers.workspaceId, c.get("workspace").id)).groupBy(users.id, workspaceMembers.role, workspaceMembers.monthlyCap).orderBy(users.name, users.id));
});

billingRoutes.get("/jobs", async (c) => {
  const filter = z.object({ cursor: z.string().optional(), status: z.enum(["held", "succeeded", "failed", "timeout"]).optional(), brandId: z.string().optional() }).parse(c.req.query());
  const cursor = readCursor(filter.cursor);
  const rows = await db.select({
    id: generationJobs.id, userName: users.name, modelId: generationJobs.modelId, capability: generationJobs.capability,
    status: generationJobs.status, estimateCredits: generationJobs.estimateCredits, chargedCredits: generationJobs.chargedCredits,
    brandId: generationJobs.brandId, projectId: generationJobs.projectId, source: generationJobs.source, params: generationJobs.params,
    prompt: generationJobs.prompt, error: generationJobs.error, createdAt: generationJobs.createdAt, finishedAt: generationJobs.finishedAt,
    cursorCreatedAt: sql<string>`to_char(${generationJobs.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(generationJobs).innerJoin(users, eq(users.id, generationJobs.userId)).where(and(
    eq(generationJobs.workspaceId, c.get("workspace").id),
    c.get("membership").role === "member" ? eq(generationJobs.userId, c.get("user").id) : undefined,
    filter.status ? eq(generationJobs.status, filter.status) : undefined,
    filter.brandId ? eq(generationJobs.brandId, filter.brandId) : undefined,
    cursor ? sql`(${generationJobs.createdAt}, ${generationJobs.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id})` : undefined,
  )).orderBy(desc(generationJobs.createdAt), desc(generationJobs.id)).limit(PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  const outputs = page.length ? await db.select().from(generationOutputs).where(inArray(generationOutputs.jobId, page.map((job) => job.id))) : [];
  return c.json({ items: page.map(({ cursorCreatedAt: _, ...job }) => ({ ...job, outputs: outputs.filter((output) => output.jobId === job.id && output.objectKey).map((output) => ({ kind: output.kind, url: `/api/files/${output.objectKey!.split("/").map(encodeURIComponent).join("/")}` })) })), nextCursor: rows.length > PAGE_SIZE ? nextCursor(page.at(-1)) : null });
});

billingRoutes.get("/transactions", requireWorkspaceRole("owner", "admin"), async (c) => {
  const cursor = readCursor(c.req.query("cursor"));
  const rows = await db.select({ id: creditTransactions.id, type: creditTransactions.type, amount: creditTransactions.amount, jobId: creditTransactions.jobId, note: creditTransactions.note, createdAt: creditTransactions.createdAt, cursorCreatedAt: sql<string>`to_char(${creditTransactions.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
    .from(creditTransactions).where(and(eq(creditTransactions.workspaceId, c.get("workspace").id), cursor ? sql`(${creditTransactions.createdAt}, ${creditTransactions.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id})` : undefined))
    .orderBy(desc(creditTransactions.createdAt), desc(creditTransactions.id)).limit(PAGE_SIZE + 1);
  const items = rows.slice(0, PAGE_SIZE);
  return c.json({ items: items.map(({ cursorCreatedAt: _, ...item }) => item), nextCursor: rows.length > PAGE_SIZE ? nextCursor(items.at(-1)) : null });
});

billingRoutes.post("/redeem", requireWorkspaceRole("owner"), async (c) => {
  const { code } = z.object({ code: z.string().trim().min(1) }).parse(await c.req.json());
  return c.json(await redeem(c.get("workspace").id, c.get("user").id, code));
});
billingRoutes.get("/packages", async (c) => c.json(await db.select({ id: creditPackages.id, name: creditPackages.name, credits: creditPackages.credits, bonusCredits: creditPackages.bonusCredits, priceCents: creditPackages.priceCents }).from(creditPackages).where(eq(creditPackages.isActive, true)).orderBy(creditPackages.sort, creditPackages.id)));
