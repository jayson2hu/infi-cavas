import { and, eq, sql } from "drizzle-orm";
import { db, type Transaction } from "../db/client";
import { creditBuckets, creditTransactions, generationJobs, redeemCodes, redeemCodeUses, workspaceMembers, workspaces, type CreditBreakdown } from "../db/schema";
import { env } from "../env";
import { ApiError, invariant } from "../lib/errors";
import { id } from "../lib/ids";

export async function lockWorkspace(tx: Transaction, workspaceId: string) {
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
  invariant(workspace, 404, "workspace_not_found", "工作区不存在");
  return workspace;
}

export type GrantInput = { workspaceId: string; userId?: string; kind: "subscription" | "purchase" | "gift"; amount: number; expiresAt?: Date | null; source: string; note?: string };
export async function grantInTransaction(tx: Transaction, input: GrantInput) {
  invariant(Number.isSafeInteger(input.amount) && input.amount >= 0 && input.amount <= 2147483647, 422, "invalid_credits", "点数必须为非负整数");
  await lockWorkspace(tx, input.workspaceId);
  const [bucket] = await tx.insert(creditBuckets).values({ id: id("cb"), workspaceId: input.workspaceId, kind: input.kind, granted: input.amount, remaining: input.amount, expiresAt: input.expiresAt ?? null, source: input.source }).returning();
  await tx.insert(creditTransactions).values({ id: id("ctx"), workspaceId: input.workspaceId, userId: input.userId, type: "grant", amount: input.amount, breakdown: [{ bucketId: bucket.id, amount: input.amount }], note: input.note ?? input.source });
  return bucket;
}
export const grant = (input: GrantInput) => db.transaction((tx) => grantInTransaction(tx, input));

type Job = typeof generationJobs.$inferSelect;
type Bucket = typeof creditBuckets.$inferSelect;
export type HoldInput = {
  jobId?: string;
  workspaceId: string;
  userId: string;
  modelId: string;
  providerId?: string | null;
  capability: Job["capability"];
  endpoint: string;
  estimateCredits: number;
  apiTokenId?: string | null;
  brandId?: string | null;
  projectId?: string | null;
  nodeId?: string | null;
  source?: string | null;
  params?: Record<string, unknown>;
  prompt?: string | null;
};
export type LedgerResult = { job: Job; balance: number; balanceBreakdown: Record<Bucket["kind"], number> };
export type SettlementDetails = { usage?: Record<string, unknown>; providerId?: string };
export type RefundDetails = { status?: "failed" | "timeout"; error?: string; providerId?: string };

function credits(value: number) {
  invariant(Number.isSafeInteger(value) && value >= 0 && value <= 2147483647, 422, "invalid_credits", "点数必须为非负整数");
}

export async function balance(workspaceId: string, client: typeof db | Transaction = db) {
  const rows = await client.select({ kind: creditBuckets.kind, amount: sql<number>`coalesce(sum(${creditBuckets.remaining}), 0)`.mapWith(Number) })
    .from(creditBuckets).where(and(eq(creditBuckets.workspaceId, workspaceId), sql`(${creditBuckets.expiresAt} is null or ${creditBuckets.expiresAt} > clock_timestamp())`))
    .groupBy(creditBuckets.kind);
  const balanceBreakdown = { subscription: 0, purchase: 0, gift: 0 };
  for (const row of rows) balanceBreakdown[row.kind] = row.amount;
  return { balance: Object.values(balanceBreakdown).reduce((sum, amount) => sum + amount, 0), balanceBreakdown };
}

// 所有写入先锁工作区，再锁成员/任务，最后按同一顺序锁桶。
async function lockBuckets(tx: Transaction, workspaceId: string) {
  return tx.select().from(creditBuckets).where(eq(creditBuckets.workspaceId, workspaceId))
    .orderBy(sql`(${creditBuckets.kind} = 'subscription') desc`, sql`${creditBuckets.expiresAt} asc nulls last`, creditBuckets.createdAt, creditBuckets.id).for("update");
}

function availableBuckets(buckets: Bucket[]) {
  const now = Date.now();
  return buckets.filter((bucket) => bucket.remaining > 0 && (!bucket.expiresAt || bucket.expiresAt.getTime() > now));
}

async function deduct(tx: Transaction, buckets: Bucket[], amount: number) {
  const breakdown: CreditBreakdown = [];
  let outstanding = amount;
  for (const bucket of availableBuckets(buckets)) {
    if (!outstanding) break;
    const taken = Math.min(bucket.remaining, outstanding);
    await tx.update(creditBuckets).set({ remaining: bucket.remaining - taken }).where(eq(creditBuckets.id, bucket.id));
    bucket.remaining -= taken;
    breakdown.push({ bucketId: bucket.id, amount: taken });
    outstanding -= taken;
  }
  return { breakdown, outstanding };
}

async function restore(tx: Transaction, job: Job, buckets: Bucket[], amount: number) {
  const breakdown: CreditBreakdown = [];
  let outstanding = amount;
  for (const held of [...job.holdBreakdown].reverse()) {
    if (!outstanding) break;
    const bucket = buckets.find((item) => item.id === held.bucketId);
    invariant(bucket, 500, "ledger_bucket_missing", "账本关联的点数桶不存在");
    const returned = Math.min(outstanding, held.amount);
    await tx.update(creditBuckets).set({ remaining: bucket.remaining + returned }).where(eq(creditBuckets.id, bucket.id));
    bucket.remaining += returned;
    breakdown.push({ bucketId: held.bucketId, amount: returned });
    outstanding -= returned;
  }
  invariant(outstanding === 0, 500, "ledger_breakdown_invalid", "冻结明细与点数不一致");
  return breakdown;
}

async function expireBuckets(tx: Transaction, workspaceId: string, buckets: Bucket[], note: string) {
  for (const bucket of buckets) {
    if (!bucket.remaining) continue;
    await tx.update(creditBuckets).set({ remaining: 0 }).where(eq(creditBuckets.id, bucket.id));
    await tx.insert(creditTransactions).values({ id: id("ctx"), workspaceId, type: "expire", amount: -bucket.remaining, breakdown: [{ bucketId: bucket.id, amount: bucket.remaining }], note });
    bucket.remaining = 0;
  }
}

export async function hold(input: HoldInput): Promise<LedgerResult> {
  credits(input.estimateCredits);
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);
    const [member] = await tx.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId))).for("update");
    invariant(member, 403, "workspace_forbidden", "无权访问此工作区");
    const buckets = await lockBuckets(tx, input.workspaceId);
    const currentBalance = availableBuckets(buckets).reduce((sum, bucket) => sum + bucket.remaining, 0);
    if (env.BILLING_ENABLED && member.role === "member" && member.monthlyCap !== null) {
      const [usage] = await tx.select({ amount: sql<number>`coalesce(sum(case when ${generationJobs.status} = 'succeeded' then ${generationJobs.chargedCredits} when ${generationJobs.status} = 'held' and coalesce(${generationJobs.params}->>'billingEnabled', 'true') <> 'false' then ${generationJobs.estimateCredits} else 0 end), 0)`.mapWith(Number) })
        .from(generationJobs).where(and(eq(generationJobs.workspaceId, input.workspaceId), eq(generationJobs.userId, input.userId), sql`${generationJobs.createdAt} >= date_trunc('month', clock_timestamp())`));
      if (usage.amount + input.estimateCredits > member.monthlyCap) {
        throw new ApiError(402, "member_cap_exceeded", `已达到本月个人上限（${member.monthlyCap} 点），请联系管理员调整`, { required: input.estimateCredits, balance: currentBalance, monthlyCap: member.monthlyCap });
      }
    }
    if (env.BILLING_ENABLED && currentBalance < input.estimateCredits) {
      throw new ApiError(402, "insufficient_credits", `点数不足，本次需要 ${input.estimateCredits} 点，剩余 ${currentBalance} 点`, { required: input.estimateCredits, balance: currentBalance });
    }
    const held = env.BILLING_ENABLED ? await deduct(tx, buckets, input.estimateCredits) : { breakdown: [], outstanding: 0 };
    const { jobId, ...fields } = input;
    const [job] = await tx.insert(generationJobs).values({ ...fields, id: jobId ?? id("job"), status: "held", holdBreakdown: held.breakdown, params: { ...input.params, billingEnabled: env.BILLING_ENABLED } }).returning();
    if (env.BILLING_ENABLED) await tx.insert(creditTransactions).values({ id: id("ctx"), workspaceId: input.workspaceId, userId: input.userId, type: "hold", amount: -input.estimateCredits, breakdown: held.breakdown, jobId: job.id });
    return { job, ...await balance(input.workspaceId, tx) };
  });
}

async function lockJob(tx: Transaction, jobId: string) {
  const [reference] = await tx.select({ workspaceId: generationJobs.workspaceId }).from(generationJobs).where(eq(generationJobs.id, jobId));
  invariant(reference, 404, "job_not_found", "生成任务不存在");
  await lockWorkspace(tx, reference.workspaceId);
  const [job] = await tx.select().from(generationJobs).where(eq(generationJobs.id, jobId)).for("update");
  invariant(job, 404, "job_not_found", "生成任务不存在");
  return job;
}

export async function settle(jobId: string, actual: number, details: SettlementDetails = {}): Promise<LedgerResult> {
  credits(actual);
  return db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    if (job.status !== "held") return { job, ...await balance(job.workspaceId, tx) };
    const buckets = await lockBuckets(tx, job.workspaceId);
    const billed = job.params.billingEnabled !== false;
    const heldAmount = job.holdBreakdown.reduce((sum, item) => sum + item.amount, 0);
    let chargedCredits = billed ? actual : 0;
    let breakdown: CreditBreakdown = [];
    let overdraft = false;
    if (billed && actual < heldAmount) breakdown = await restore(tx, job, buckets, heldAmount - actual);
    if (billed && actual > heldAmount) {
      const extra = await deduct(tx, buckets, actual - heldAmount);
      chargedCredits -= extra.outstanding;
      overdraft = extra.outstanding > 0;
      breakdown = extra.breakdown.map((item) => ({ ...item, amount: -item.amount }));
    }
    const [settled] = await tx.update(generationJobs).set({ status: "succeeded", chargedCredits, overdraft, finishedAt: new Date(), ...details }).where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, "held"))).returning();
    if (billed) await tx.insert(creditTransactions).values({ id: id("ctx"), workspaceId: job.workspaceId, userId: job.userId, type: "settle", amount: heldAmount - chargedCredits, breakdown, jobId });
    // 退款回到原桶；原桶已过期时立即记过期流水，不恢复过期额度。
    await expireBuckets(tx, job.workspaceId, buckets.filter((bucket) => bucket.expiresAt && bucket.expiresAt.getTime() <= Date.now()), "点数有效期已结束");
    return { job: settled, ...await balance(job.workspaceId, tx) };
  });
}

export async function refund(jobId: string, details: RefundDetails = {}): Promise<LedgerResult> {
  return db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    if (job.status !== "held") return { job, ...await balance(job.workspaceId, tx) };
    const buckets = await lockBuckets(tx, job.workspaceId);
    const heldAmount = job.holdBreakdown.reduce((sum, item) => sum + item.amount, 0);
    const breakdown = await restore(tx, job, buckets, heldAmount);
    const [refunded] = await tx.update(generationJobs).set({ status: details.status ?? "failed", error: details.error ?? null, providerId: details.providerId ?? job.providerId, chargedCredits: 0, finishedAt: new Date() }).where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, "held"))).returning();
    if (job.params.billingEnabled !== false) await tx.insert(creditTransactions).values({ id: id("ctx"), workspaceId: job.workspaceId, userId: job.userId, type: "refund", amount: heldAmount, breakdown, jobId });
    await expireBuckets(tx, job.workspaceId, buckets.filter((bucket) => bucket.expiresAt && bucket.expiresAt.getTime() <= Date.now()), "点数有效期已结束");
    return { job: refunded, ...await balance(job.workspaceId, tx) };
  });
}

export async function redeem(workspaceId: string, userId: string, rawCode: string) {
  const code = rawCode.trim().toUpperCase();
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const [member] = await tx.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).for("update");
    invariant(member?.role === "owner", 403, "forbidden", "只有工作区所有者可以兑换点数");
    const [coupon] = await tx.select().from(redeemCodes).where(eq(redeemCodes.code, code)).for("update");
    invariant(coupon, 404, "redeem_not_found", "兑换码不存在");
    const [used] = await tx.select().from(redeemCodeUses).where(and(eq(redeemCodeUses.code, code), eq(redeemCodeUses.workspaceId, workspaceId)));
    invariant(!used && coupon.usedCount < coupon.maxUses && (!coupon.expiresAt || coupon.expiresAt.getTime() > Date.now()), 409, "redeem_unavailable", "兑换码已用完、已兑换或已过期");
    const expiresAt = coupon.validDays === null ? null : new Date(Date.now() + coupon.validDays * 86400000);
    invariant(!expiresAt || Number.isFinite(expiresAt.getTime()), 422, "invalid_expiration", "点数有效期不合法");
    const bucket = await grantInTransaction(tx, { workspaceId, userId, kind: coupon.kind, amount: coupon.credits, expiresAt, source: `redeem:${code}` });
    await tx.insert(redeemCodeUses).values({ code, workspaceId, userId, bucketId: bucket.id });
    await tx.update(redeemCodes).set({ usedCount: coupon.usedCount + 1 }).where(eq(redeemCodes.code, code));
    return { credits: coupon.credits, ...await balance(workspaceId, tx) };
  });
}

export async function setPlanInTransaction(tx: Transaction, workspaceId: string, plan: "free" | "team" | "enterprise", monthlyCredits: number, userId?: string) {
  credits(monthlyCredits);
  await lockWorkspace(tx, workspaceId);
  const buckets = await lockBuckets(tx, workspaceId);
  const subscriptions = buckets.filter((bucket) => bucket.kind === "subscription");
  // 提前换套餐也结束旧桶有效期，避免旧任务稍后退款重新激活旧套餐额度。
  for (const bucket of subscriptions) {
    bucket.expiresAt = new Date();
    await tx.update(creditBuckets).set({ expiresAt: bucket.expiresAt }).where(eq(creditBuckets.id, bucket.id));
  }
  await expireBuckets(tx, workspaceId, subscriptions, "管理员调整套餐，结束原套餐周期");
  const [workspace] = await tx.update(workspaces).set({ plan, planMonthlyCredits: monthlyCredits, periodStart: sql`clock_timestamp()`, periodEnd: sql`clock_timestamp() + interval '1 month'`, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId)).returning();
  await grantInTransaction(tx, { workspaceId, userId, kind: "subscription", amount: monthlyCredits, expiresAt: workspace.periodEnd, source: "plan_period" });
  return workspace;
}

export async function renewPeriod(workspaceId: string) {
  return db.transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, workspaceId);
    const buckets = await lockBuckets(tx, workspaceId);
    const now = Date.now();
    const overdue = workspace.periodEnd.getTime() <= now;
    if (overdue) {
      for (const bucket of buckets.filter((bucket) => bucket.kind === "subscription")) {
        bucket.expiresAt = new Date(Math.min(now, bucket.expiresAt?.getTime() ?? now));
        await tx.update(creditBuckets).set({ expiresAt: bucket.expiresAt }).where(eq(creditBuckets.id, bucket.id));
      }
    }
    await expireBuckets(tx, workspaceId, buckets.filter((bucket) => (bucket.expiresAt && bucket.expiresAt.getTime() <= now) || (overdue && bucket.kind === "subscription")), "点数有效期已结束");
    if (!overdue) return false;
    // 跳过停机期间已经结束的月份，只发放当前周期；月份运算由 PostgreSQL 完成。
    const [updated] = await tx.update(workspaces).set({
      periodStart: sql`(select max(period) from generate_series(${workspace.periodEnd.toISOString()}::timestamptz, clock_timestamp(), interval '1 month') period)`,
      periodEnd: sql`(select max(period) + interval '1 month' from generate_series(${workspace.periodEnd.toISOString()}::timestamptz, clock_timestamp(), interval '1 month') period)`,
      updatedAt: new Date(),
    }).where(eq(workspaces.id, workspaceId)).returning();
    await grantInTransaction(tx, { workspaceId, kind: "subscription", amount: workspace.planMonthlyCredits, expiresAt: updated.periodEnd, source: "plan_period" });
    return true;
  });
}
