import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const suffix = randomUUID().replaceAll("-", "");
const adminId = `usr_plan_admin_${suffix}`;
const ownerId = `usr_plan_owner_${suffix}`;
const memberId = `usr_plan_member_${suffix}`;
const workspaceId = `ws_plan_${suffix}`;
const tokens = { admin: randomBytes(32).toString("base64url"), owner: randomBytes(32).toString("base64url"), member: randomBytes(32).toString("base64url") };
let client: postgres.Sql;
let app: ReturnType<(typeof import("../src/app"))["createApp"]>;

beforeAll(async () => {
  if (!databaseUrl) return;
  client = postgres(databaseUrl, { max: 1 });
  app = (await import("../src/app")).createApp();
  await client.begin(async (tx) => {
    await tx`INSERT INTO plans (id, name, monthly_credits, sort) VALUES ('free','免费版',0,10), ('team','团队版',10000,20), ('enterprise','企业版',50000,30) ON CONFLICT (id) DO NOTHING`;
    for (const [userId, token, isAdmin] of [[adminId, tokens.admin, true], [ownerId, tokens.owner, false], [memberId, tokens.member, false]] as const) {
      await tx`INSERT INTO users (id, email, password_hash, name, is_platform_admin) VALUES (${userId}, ${`${userId}@example.test`}, 'x', '套餐验收', ${isAdmin})`;
      await tx`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (${`ses_${userId}`}, ${userId}, ${createHash("sha256").update(token).digest("hex")}, now() + interval '1 day')`;
    }
    await tx`INSERT INTO workspaces (id, name, kind, owner_id) VALUES (${workspaceId}, '套餐升级验收', 'team', ${ownerId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${ownerId}, 'owner'), (${workspaceId}, ${memberId}, 'member')`;
  });
});

afterAll(async () => {
  if (!databaseUrl || !client) return;
  try {
    await client.begin(async (tx) => {
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id IN ${tx([adminId, ownerId, memberId])}`;
    });
  } finally { await client.end(); }
});

const call = (path: string, who: keyof typeof tokens, method = "GET", body?: unknown) => app.request(path, {
  method,
  headers: { Origin: process.env.APP_ORIGIN ?? "http://localhost:3000", "Content-Type": "application/json", Cookie: `ic_session=${tokens[who]}`, "X-IC-Workspace": workspaceId },
  body: body === undefined ? undefined : JSON.stringify(body),
});

integrationTest("用户申请升级、管理员拒绝与批准：批准后切换套餐并发放当期订阅点数", async () => {
  const catalog = await (await call("/api/billing/plans", "owner")).json();
  expect(catalog.currentPlan).toBe("free");
  expect(catalog.plans.map((plan: { id: string }) => plan.id)).toEqual(expect.arrayContaining(["team", "enterprise"]));
  expect(catalog.latestRequest).toBeNull();

  // 普通成员不能申请；不能申请当前套餐。
  expect((await call("/api/billing/plan-requests", "member", "POST", { planId: "team" })).status).toBe(403);
  expect((await call("/api/billing/plan-requests", "owner", "POST", { planId: "free" })).status).toBe(409);

  // 同一工作区只能有一条待处理申请。
  expect((await call("/api/billing/plan-requests", "owner", "POST", { planId: "team", note: "需要更多额度" })).status).toBe(201);
  const duplicate = await call("/api/billing/plan-requests", "owner", "POST", { planId: "enterprise" });
  expect(duplicate.status).toBe(409);
  expect((await duplicate.json()).error.code).toBe("request_pending");

  // 管理接口仅平台管理员可用。
  expect((await call("/api/admin/plan-requests", "owner")).status).toBe(403);
  const pending = (await (await call("/api/admin/plan-requests", "admin")).json()).filter((row: { workspaceId: string }) => row.workspaceId === workspaceId);
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ planId: "team", fromPlan: "free", note: "需要更多额度", requesterEmail: `${ownerId}@example.test` });

  // 拒绝必须写原因；拒绝后用户能看到结果，并可重新申请。
  expect((await call(`/api/admin/plan-requests/${pending[0].id}/reject`, "admin", "POST", { reason: "" })).status).toBe(422);
  expect((await call(`/api/admin/plan-requests/${pending[0].id}/reject`, "admin", "POST", { reason: "请先联系销售确认合同" })).status).toBe(204);
  expect((await call(`/api/admin/plan-requests/${pending[0].id}/approve`, "admin", "POST", {})).status).toBe(409);
  expect((await (await call("/api/billing/plans", "owner")).json()).latestRequest).toMatchObject({ status: "rejected", reviewNote: "请先联系销售确认合同" });

  const created = await (await call("/api/billing/plan-requests", "owner", "POST", { planId: "enterprise" })).json();
  const [plan] = await client`SELECT monthly_credits FROM plans WHERE id = 'enterprise'`;
  const approved = await call(`/api/admin/plan-requests/${created.id}/approve`, "admin", "POST", { note: "已签约" });
  expect(approved.status).toBe(200);
  const result = await approved.json();
  expect(result.workspace).toMatchObject({ plan: "enterprise", planMonthlyCredits: plan.monthly_credits });
  expect(result.balance).toBe(plan.monthly_credits);
  const [bucket] = await client`SELECT kind, granted, remaining FROM credit_buckets WHERE workspace_id = ${workspaceId} AND kind = 'subscription'`;
  expect(bucket).toMatchObject({ kind: "subscription", granted: plan.monthly_credits, remaining: plan.monthly_credits });
  expect((await call(`/api/admin/plan-requests/${created.id}/approve`, "admin", "POST", {})).status).toBe(409);
  const after = await (await call("/api/billing/plans", "owner")).json();
  expect(after).toMatchObject({ currentPlan: "enterprise", latestRequest: { status: "approved" } });
});

integrationTest("管理员维护套餐目录，非管理员不可修改", async () => {
  const plans = await (await call("/api/admin/plans", "admin")).json();
  const team = plans.find((plan: { id: string }) => plan.id === "team");
  const body = { name: team.name, monthlyCredits: team.monthlyCredits, priceText: team.priceText, description: team.description, isActive: team.isActive, sort: team.sort };
  expect((await call("/api/admin/plans/team", "owner", "PUT", body)).status).toBe(403);
  expect((await call("/api/admin/plans/team", "admin", "PUT", { ...body, monthlyCredits: -1 })).status).toBe(422);
  expect((await call("/api/admin/plans/unknown", "admin", "PUT", body)).status).toBe(404);
  const saved = await call("/api/admin/plans/team", "admin", "PUT", body);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ id: "team", monthlyCredits: team.monthlyCredits });
});
