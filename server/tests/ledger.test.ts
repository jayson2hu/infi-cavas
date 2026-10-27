import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ledgerTest = databaseUrl ? test : test.skip;
const prefix = `ledger_${randomUUID().replaceAll("-", "")}`;
const workspaceIds: string[] = [];
const userIds: string[] = [];
const modelId = `${prefix}_image`;
const providerId = `${prefix}_provider`;
let client: postgres.Sql;
let ledger: typeof import("../src/billing/ledger");
let sweeper: typeof import("../src/billing/sweeper");
let environment: typeof import("../src/env");
let database: typeof import("../src/db/client");

beforeAll(async () => {
  if (!databaseUrl) return;
  client = postgres(databaseUrl, { max: 1 });
  ledger = await import("../src/billing/ledger");
  sweeper = await import("../src/billing/sweeper");
  environment = await import("../src/env");
  database = await import("../src/db/client");
  await client`INSERT INTO models (id, display_name, capability) VALUES (${modelId}, '账本验收模型', 'image')`;
  await client`INSERT INTO providers (id, name, base_url, api_key_encrypted) VALUES (${providerId}, '扫描验收供应商', 'https://example.invalid', 'not-a-real-key')`;
});

afterAll(async () => {
  if (!databaseUrl) return;
  try {
    await client.begin(async (tx) => {
      if (workspaceIds.length) await tx`DELETE FROM workspaces WHERE id IN ${tx(workspaceIds)}`;
      if (userIds.length) {
        await tx`DELETE FROM redeem_codes WHERE created_by IN ${tx(userIds)}`;
        await tx`DELETE FROM users WHERE id IN ${tx(userIds)}`;
      }
      await tx`DELETE FROM models WHERE id = ${modelId}`;
      await tx`DELETE FROM providers WHERE id = ${providerId}`;
    });
  } finally { await client.end(); }
});

async function fixture(amount = 100, role: "owner" | "member" | "admin" = "owner", cap: number | null = null) {
  const suffix = workspaceIds.length;
  const ownerId = `${prefix}_owner_${suffix}`;
  const workspaceId = `${prefix}_ws_${suffix}`;
  const userId = role === "owner" ? ownerId : `${prefix}_member_${suffix}`;
  workspaceIds.push(workspaceId);
  userIds.push(ownerId);
  if (userId !== ownerId) userIds.push(userId);
  await client`INSERT INTO users (id,email,password_hash,name,last_workspace_id) VALUES (${ownerId}, ${`${ownerId}@example.test`}, 'test-only', '账本验收所有者', ${workspaceId})`;
  await client`INSERT INTO workspaces (id,name,kind,owner_id) VALUES (${workspaceId}, ${workspaceId}, 'team', ${ownerId})`;
  await client`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (${workspaceId}, ${ownerId}, 'owner')`;
  if (userId !== ownerId) {
    await client`INSERT INTO users (id,email,password_hash,name,last_workspace_id) VALUES (${userId}, ${`${userId}@example.test`}, 'test-only', '账本验收成员', ${workspaceId})`;
    await client`INSERT INTO workspace_members (workspace_id,user_id,role,monthly_cap) VALUES (${workspaceId}, ${userId}, ${role}, ${cap})`;
  }
  await ledger.grant({ workspaceId, userId: ownerId, kind: "purchase", amount, source: "test:ledger" });
  return { ownerId, userId, workspaceId };
}

function input(account: { workspaceId: string; userId: string }, estimateCredits = 10) {
  return { workspaceId: account.workspaceId, userId: account.userId, modelId, capability: "image" as const, endpoint: "images/generations", estimateCredits };
}

ledgerTest("100 点并发 20 次各冻结 10 点：恰好 10 次成功，无负余额或失败任务残留", async () => {
  const account = await fixture();
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => ledger.hold(input(account))));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(10);
  const failures = results.filter((result) => result.status === "rejected");
  expect(failures).toHaveLength(10);
  for (const failure of failures) expect(failure.status === "rejected" && failure.reason.code).toBe("insufficient_credits");
  expect((await ledger.balance(account.workspaceId)).balance).toBe(0);
  expect(await client`SELECT id FROM generation_jobs WHERE workspace_id = ${account.workspaceId}`).toHaveLength(10);
  expect(await client`SELECT id FROM credit_transactions WHERE workspace_id = ${account.workspaceId} AND type = 'hold'`).toHaveLength(10);
  expect(await client`SELECT id FROM credit_buckets WHERE workspace_id = ${account.workspaceId} AND remaining < 0`).toHaveLength(0);
});

ledgerTest("套餐优先、临期桶其次；少结算逆序退还原桶；超额结算扣到零并记录 overdraft", async () => {
  const account = await fixture(20);
  const subscription = await ledger.grant({ workspaceId: account.workspaceId, kind: "subscription", amount: 10, source: "test:plan", expiresAt: new Date(Date.now() + 30 * 86400000) });
  const gift = await ledger.grant({ workspaceId: account.workspaceId, kind: "gift", amount: 15, source: "test:gift", expiresAt: new Date(Date.now() + 86400000) });
  await ledger.grant({ workspaceId: account.workspaceId, kind: "gift", amount: 99, source: "test:expired", expiresAt: new Date(Date.now() - 1000) });
  const held = await ledger.hold(input(account, 20));
  expect(held.job.holdBreakdown).toEqual([{ bucketId: subscription.id, amount: 10 }, { bucketId: gift.id, amount: 10 }]);
  expect(held.balance).toBe(25);
  const settled = await ledger.settle(held.job.id, 12);
  expect(settled.balance).toBe(33);
  const [storedGift] = await client`SELECT remaining FROM credit_buckets WHERE id = ${gift.id}`;
  expect(storedGift.remaining).toBe(13);
  const [transaction] = await client`SELECT amount, breakdown FROM credit_transactions WHERE job_id = ${held.job.id} AND type = 'settle'`;
  expect(transaction.amount).toBe(8);
  expect(transaction.breakdown).toEqual([{ bucketId: gift.id, amount: 8 }]);

  const scarce = await fixture(25);
  const first = await ledger.hold(input(scarce, 10));
  const extra = await ledger.settle(first.job.id, 40);
  expect(extra.job.chargedCredits).toBe(25);
  expect(extra.job.overdraft).toBe(true);
  expect(extra.balance).toBe(0);
  const [net] = await client`SELECT sum(amount)::int AS amount FROM credit_transactions WHERE job_id = ${first.job.id}`;
  expect(net.amount).toBe(-25);
});

ledgerTest("settle 与 refund 并发和重复调用只产生一个终态、一条终结流水", async () => {
  const account = await fixture();
  const held = await ledger.hold(input(account, 10));
  await Promise.all(Array.from({ length: 20 }, (_, index) => index % 2 ? ledger.refund(held.job.id) : ledger.settle(held.job.id, 6)));
  const [job] = await client`SELECT status, charged_credits FROM generation_jobs WHERE id = ${held.job.id}`;
  expect(["succeeded", "failed"]).toContain(job.status);
  expect((await ledger.balance(account.workspaceId)).balance).toBe(job.status === "succeeded" ? 94 : 100);
  expect(await client`SELECT id FROM credit_transactions WHERE job_id = ${held.job.id} AND type IN ('settle','refund')`).toHaveLength(1);
  const again = await ledger.refund(held.job.id);
  expect(again.job.status).toBe(job.status);
  expect(again.job.chargedCredits).toBe(job.charged_credits);
});

ledgerTest("余额不足原子回滚；成员上限在并发冻结中生效；管理员不受成员上限限制", async () => {
  const poor = await fixture(5);
  await expect(ledger.hold(input(poor, 10))).rejects.toMatchObject({ code: "insufficient_credits", status: 402 });
  expect((await ledger.balance(poor.workspaceId)).balance).toBe(5);
  expect(await client`SELECT id FROM generation_jobs WHERE workspace_id = ${poor.workspaceId}`).toHaveLength(0);
  expect(await client`SELECT id FROM credit_transactions WHERE workspace_id = ${poor.workspaceId}`).toHaveLength(1);
  const member = await fixture(100, "member", 15);
  const results = await Promise.allSettled([ledger.hold(input(member)), ledger.hold(input(member))]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const failure = results.find((result) => result.status === "rejected");
  expect(failure?.status === "rejected" && failure.reason.code).toBe("member_cap_exceeded");
  const admin = await fixture(100, "admin", 0);
  expect((await ledger.hold(input(admin, 20))).balance).toBe(80);
  await client`DELETE FROM workspace_members WHERE workspace_id = ${member.workspaceId} AND user_id = ${member.userId}`;
  await expect(ledger.hold(input(member, 1))).rejects.toMatchObject({ status: 403 });
});

ledgerTest("关闭计费不检查余额或上限，记录用量；稍后重新启用也不会补扣此前免费任务", async () => {
  const account = await fixture(0, "member", 0);
  const original = environment.env.BILLING_ENABLED;
  try {
    environment.env.BILLING_ENABLED = false;
    const held = await ledger.hold(input(account, 100));
    expect(held.job.estimateCredits).toBe(100);
    expect(held.job.holdBreakdown).toEqual([]);
    environment.env.BILLING_ENABLED = true;
    const settled = await ledger.settle(held.job.id, 999, { usage: { input_tokens: 123 } });
    expect(settled.job.status).toBe("succeeded");
    expect(settled.job.chargedCredits).toBe(0);
    expect(settled.job.usage).toEqual({ input_tokens: 123 });
    expect(settled.balance).toBe(0);
    expect(await client`SELECT id FROM credit_transactions WHERE job_id = ${held.job.id}`).toHaveLength(0);
  } finally { environment.env.BILLING_ENABLED = original; }
});

ledgerTest("兑换码并发最多兑换一次，跨工作区共享次数也不能超用", async () => {
  const first = await fixture(0);
  const second = await fixture(0);
  const third = await fixture(0);
  const code = `${prefix}_coupon`;
  await client`INSERT INTO redeem_codes (code,credits,kind,max_uses,created_by) VALUES (${code.toUpperCase()}, 50, 'gift', 2, ${first.ownerId})`;
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => ledger.redeem(first.workspaceId, first.ownerId, code)));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect((await ledger.balance(first.workspaceId)).balance).toBe(50);
  expect((await ledger.redeem(second.workspaceId, second.ownerId, code)).balance).toBe(50);
  await expect(ledger.redeem(third.workspaceId, third.ownerId, code)).rejects.toMatchObject({ status: 409 });
  const [stored] = await client`SELECT used_count FROM redeem_codes WHERE code = ${code.toUpperCase()}`;
  expect(stored.used_count).toBe(2);
});

ledgerTest("套餐重置清空旧桶；旧任务退款不复活过期点数；并发月度扫描只发放一次", async () => {
  const account = await fixture(0);
  await database.db.transaction((tx) => ledger.setPlanInTransaction(tx, account.workspaceId, "team", 30));
  const held = await ledger.hold(input(account, 20));
  await database.db.transaction((tx) => ledger.setPlanInTransaction(tx, account.workspaceId, "team", 50));
  expect((await ledger.refund(held.job.id)).balance).toBe(50);
  const [old] = await client`SELECT remaining FROM credit_buckets WHERE id = ${held.job.holdBreakdown[0].bucketId}`;
  expect(old.remaining).toBe(0);
  const nextHeld = await ledger.hold(input(account, 10));
  await client`UPDATE workspaces SET period_end = now() - interval '1 day' WHERE id = ${account.workspaceId}`;
  const renewed = await Promise.all([ledger.renewPeriod(account.workspaceId), ledger.renewPeriod(account.workspaceId)]);
  expect(renewed.filter(Boolean)).toHaveLength(1);
  expect((await ledger.balance(account.workspaceId)).balance).toBe(50);
  expect((await ledger.refund(nextHeld.job.id)).balance).toBe(50);
  const [workspace] = await client`SELECT period_start, period_end FROM workspaces WHERE id = ${account.workspaceId}`;
  expect(new Date(workspace.period_start).getTime()).toBeLessThan(Date.now());
  expect(new Date(workspace.period_end).getTime()).toBeGreaterThan(Date.now());
  expect(await client`SELECT id FROM credit_transactions WHERE workspace_id = ${account.workspaceId} AND type = 'expire'`).toHaveLength(4);
});

ledgerTest("扫描器回查 30 分钟视频，2 小时视频和 30 分钟非视频孤儿退款", async () => {
  const account = await fixture();
  const polling = await ledger.hold({ ...input(account), capability: "video", endpoint: "videos", providerId });
  const timedOut = await ledger.hold({ ...input(account), capability: "video", endpoint: "videos", providerId });
  const orphan = await ledger.hold(input(account));
  const completedLate = await ledger.hold({ ...input(account), capability: "video", endpoint: "videos", providerId });
  const stillPending = await ledger.hold({ ...input(account), capability: "video", endpoint: "videos", providerId });
  const taskId = `${prefix}_video`;
  const completedTaskId = `${prefix}_video_complete`;
  const pendingTaskId = `${prefix}_video_pending`;
  await client`INSERT INTO video_tasks (id,job_id,provider_id,upstream_task_id) VALUES (${taskId}, ${polling.job.id}, ${providerId}, 'fixture-task')`;
  await client`INSERT INTO video_tasks (id,job_id,provider_id,upstream_task_id) VALUES (${completedTaskId}, ${completedLate.job.id}, ${providerId}, 'completed-task'), (${pendingTaskId}, ${stillPending.job.id}, ${providerId}, 'pending-task')`;
  // 只有本次创建的任务被修改时间。若测试库已有其他过期任务，先拒绝扫描，避免触碰它们。
  expect(await client`SELECT id FROM generation_jobs WHERE status = 'held' AND created_at <= now() - interval '30 minutes'`).toHaveLength(0);
  await client`UPDATE generation_jobs SET created_at = now() - interval '31 minutes' WHERE id IN ${client([polling.job.id, orphan.job.id])}`;
  await client`UPDATE generation_jobs SET created_at = now() - interval '121 minutes' WHERE id IN ${client([timedOut.job.id, completedLate.job.id, stillPending.job.id])}`;
  const polled: string[] = [];
  const stats = await sweeper.sweepHeldJobs(async (received) => {
    polled.push(received);
    if (received === taskId) await ledger.settle(polling.job.id, 8);
    if (received === completedTaskId) await ledger.settle(completedLate.job.id, 6);
  });
  expect(polled).toHaveLength(3);
  expect(polled).toEqual(expect.arrayContaining([taskId, completedTaskId, pendingTaskId]));
  expect(stats).toMatchObject({ checked: 5, refunded: 3, errors: 0 });
  expect((await ledger.balance(account.workspaceId)).balance).toBe(86);
  const states = await client`SELECT status FROM generation_jobs WHERE id IN ${client([timedOut.job.id, orphan.job.id, stillPending.job.id])}`;
  expect(states.every((row) => row.status === "timeout")).toBe(true);
});

ledgerTest("账单接口返回真实汇总、权限过滤、微秒游标分页；后台加点/套餐/兑换码受平台权限保护", async () => {
  const { createApp } = await import("../src/app");
  const { adminBillingRoutes } = await import("../src/routes/admin-billing");
  const app = createApp();
  // 独立挂载当前被测路由，不启动监听，也不要求主线程同时修改 app.ts。
  app.route("/api/admin", adminBillingRoutes);
  const account = await fixture(100, "member", 100);
  const token = randomUUID();
  const memberToken = randomUUID();
  await client`INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (${`${prefix}_session_owner`}, ${account.ownerId}, ${createHash('sha256').update(token).digest('hex')}, now() + interval '1 day'), (${`${prefix}_session_member`}, ${account.userId}, ${createHash('sha256').update(memberToken).digest('hex')}, now() + interval '1 day')`;
  const request = (path: string, method = "GET", body?: unknown, member = false) => app.request(path, { method, headers: { Cookie: `ic_session=${member ? memberToken : token}`, Origin: process.env.APP_ORIGIN!, "Content-Type": "application/json", "X-IC-Workspace": account.workspaceId }, body: body === undefined ? undefined : JSON.stringify(body) });
  const succeeded = await ledger.hold(input(account, 10));
  await ledger.settle(succeeded.job.id, 8);
  const failed = await ledger.hold(input({ ...account, userId: account.ownerId }, 5));
  await ledger.refund(failed.job.id);
  const summary = await request("/api/billing/summary");
  expect(summary.status).toBe(200);
  expect(await summary.json()).toMatchObject({ balance: 92, monthCharged: 8, monthJobs: { image: 2, video: 0, text: 0, audio: 0 }, monthRefunded: 5, monthFailedJobs: 1, successRate: 50 });
  const daily = await request("/api/billing/daily");
  expect(daily.status).toBe(200);
  expect(await daily.json()).toContainEqual(expect.objectContaining({ image: 8, video: 0 }));
  expect((await request("/api/billing/members", "GET", undefined, true)).status).toBe(403);
  expect((await request("/api/billing/transactions", "GET", undefined, true)).status).toBe(403);
  const memberJobs = await (await request("/api/billing/jobs", "GET", undefined, true)).json() as { items: Array<{ id: string }> };
  expect(memberJobs.items.map((item) => item.id)).toEqual([succeeded.job.id]);
  const members = await (await request("/api/billing/members")).json();
  expect(members).toContainEqual(expect.objectContaining({ userId: account.userId, monthCharged: 8, monthlyCap: 100 }));

  for (let i = 0; i < 51; i++) await ledger.grant({ workspaceId: account.workspaceId, kind: "gift", amount: 1, source: "test:pagination" });
  // 同一毫秒内的 PostgreSQL 微秒差异必须保留，不能由 JS Date 截断游标。
  await client`UPDATE credit_transactions SET created_at = date_trunc('second', now()) + interval '0.123456 seconds' WHERE workspace_id = ${account.workspaceId}`;
  const page1 = await (await request("/api/billing/transactions")).json() as { items: Array<{ id: string }>; nextCursor: string };
  const page2 = await (await request(`/api/billing/transactions?cursor=${page1.nextCursor}`)).json() as { items: Array<{ id: string }>; nextCursor: null };
  expect(page1.items).toHaveLength(50);
  expect(page2.items).toHaveLength(6);
  expect(new Set([...page1.items, ...page2.items].map((item) => item.id)).size).toBe(56);
  expect(page2.nextCursor).toBeNull();
  expect((await request("/api/billing/jobs?cursor=broken")).status).toBe(422);

  expect((await request(`/api/admin/workspaces/${account.workspaceId}/grant`, "POST", { credits: 7, kind: "gift" })).status).toBe(403);
  await client`UPDATE users SET is_platform_admin = true WHERE id = ${account.ownerId}`;
  const grant = await request(`/api/admin/workspaces/${account.workspaceId}/grant`, "POST", { credits: 7, kind: "gift" });
  expect(grant.status).toBe(200);
  expect(await grant.json()).toMatchObject({ balance: 150 });
  const plan = await request(`/api/admin/workspaces/${account.workspaceId}/plan`, "PUT", { plan: "team", monthlyCredits: 30 });
  expect(plan.status).toBe(200);
  expect(await plan.json()).toMatchObject({ balance: 180, workspace: { plan: "team", planMonthlyCredits: 30 } });
  const codes = await request("/api/admin/redeem-codes", "POST", { credits: 9, kind: "gift", count: 2 });
  expect(codes.status).toBe(201);
  const generated = await codes.json() as { codes: string[] };
  expect(generated.codes).toHaveLength(2);
  expect(generated.codes.every((code) => /^[A-HJ-NP-Z2-9]{16}$/.test(code))).toBe(true);
  const redeemed = await request("/api/billing/redeem", "POST", { code: generated.codes[0] });
  expect(redeemed.status).toBe(200);
  expect(await redeemed.json()).toMatchObject({ credits: 9, balance: 189 });
  expect((await request("/api/billing/redeem", "POST", { code: generated.codes[0] })).status).toBe(409);
});
