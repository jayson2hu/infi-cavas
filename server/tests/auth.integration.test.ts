import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const origin = process.env.APP_ORIGIN ?? "http://localhost:3000";
const password = "Integration-test-password-42!";
const runId = randomUUID().replaceAll("-", "");
const createdEmails = new Set<string>();
let app: ReturnType<(typeof import("../src/app"))["createApp"]>;
let client: postgres.Sql;

type Me = {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  workspaces: Array<{ id: string; kind: string; role: string }>;
  currentWorkspaceId: string;
};

beforeAll(async () => {
  if (!databaseUrl) return;
  const { createApp } = await import("../src/app");
  app = createApp();
  client = postgres(databaseUrl, { max: 1 });
});

afterAll(async () => {
  if (!databaseUrl) return;
  try {
    if (createdEmails.size) {
      await client.begin(async (tx) => {
        const rows = await tx`SELECT id FROM users WHERE email IN ${tx([...createdEmails])}`;
        const userIds = rows.map((row) => row.id as string);
        if (!userIds.length) return;
        // 只清理此运行明确注册的用户及其工作区；不使用 TRUNCATE 或全表删除。
        await tx`DELETE FROM workspaces WHERE owner_id IN ${tx(userIds)}`;
        await tx`DELETE FROM users WHERE id IN ${tx(userIds)}`;
      });
    }
  } finally {
    await client.end();
  }
});

function request(path: string, method = "GET", options: {
  cookie?: string;
  workspaceId?: string;
  body?: unknown;
  origin?: string | null;
} = {}) {
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.workspaceId) headers.set("X-IC-Workspace", options.workspaceId);
  if (method !== "GET" && method !== "HEAD" && options.origin !== null) {
    headers.set("Origin", options.origin ?? origin);
  }
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  return app.request(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function sessionCookie(response: Response) {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toMatch(/^ic_session=.+/);
  return cookie!;
}

function emailFor(label: string) {
  const email = `auth-${runId}-${label}@example.test`;
  createdEmails.add(email);
  return email;
}

async function register(label: string, inviteToken?: string) {
  const email = emailFor(label);
  const response = await request("/api/auth/register", "POST", {
    body: { email, password, name: `集成验收 ${label}`, inviteToken },
  });
  expect(response.status).toBe(201);
  return { response, email, cookie: sessionCookie(response), me: await response.json() as Me };
}

async function createTeam(cookie: string, label: string) {
  const response = await request("/api/workspaces", "POST", {
    cookie,
    body: { name: `验收工作区 ${runId} ${label}` },
  });
  expect(response.status).toBe(201);
  const workspace = await response.json() as { id: string; role: string; kind: string };
  expect(workspace.role).toBe("owner");
  expect(workspace.kind).toBe("team");
  return workspace.id;
}

async function invite(cookie: string, workspaceId: string) {
  const response = await request(`/api/workspaces/${workspaceId}/invites`, "POST", {
    cookie, workspaceId, body: { role: "member" },
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { token: string; url: string };
  expect(body.url).toBe(`${origin}/invite/${body.token}`);
  return body.token;
}

integrationTest("注册创建个人工作区与赠点；密码和会话只存哈希；登录和重复注册遵循状态码", async () => {
  const account = await register("registration");
  const cookieHeader = account.response.headers.get("set-cookie")!;
  expect(cookieHeader).toMatch(/HttpOnly/i);
  expect(cookieHeader).toMatch(/SameSite=Lax/i);
  expect(cookieHeader).toMatch(/Path=\//i);
  expect(account.me.user.email).toBe(account.email);
  expect(account.me.user).not.toHaveProperty("passwordHash");
  expect(account.me.workspaces).toHaveLength(1);
  expect(account.me.workspaces[0]).toMatchObject({ kind: "personal", role: "owner" });
  expect(account.me.currentWorkspaceId).toBe(account.me.workspaces[0].id);

  const [storedUser] = await client`SELECT password_hash FROM users WHERE id = ${account.me.user.id}`;
  expect(storedUser.password_hash).toMatch(/^\$argon2id\$/);
  expect(await Bun.password.verify(password, storedUser.password_hash)).toBe(true);
  const token = account.cookie.slice("ic_session=".length);
  const [storedSession] = await client`SELECT token_hash FROM sessions WHERE user_id = ${account.me.user.id}`;
  expect(storedSession.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
  expect(storedSession.token_hash).not.toBe(token);

  const me = await request("/api/auth/me", "GET", { cookie: account.cookie });
  expect(me.status).toBe(200);
  expect((await me.json() as Me).user.id).toBe(account.me.user.id);
  const summary = await request("/api/billing/summary", "GET", { cookie: account.cookie });
  expect(summary.status).toBe(200);
  const bonus = Number(process.env.SIGNUP_BONUS_CREDITS ?? 200);
  expect((await summary.json() as { balance: number }).balance).toBe(bonus);
  const [grant] = await client`
    SELECT sum(amount)::int AS amount FROM credit_transactions
    WHERE workspace_id = ${account.me.currentWorkspaceId} AND type = 'grant'
  `;
  expect(grant.amount ?? 0).toBe(bonus);

  const wrongPassword = await request("/api/auth/login", "POST", {
    body: { email: account.email, password: "incorrect-password" },
  });
  expect(wrongPassword.status).toBe(401);
  expect(wrongPassword.headers.get("set-cookie")).toBeNull();
  const duplicate = await request("/api/auth/register", "POST", {
    body: { email: account.email.toUpperCase(), password, name: "重复注册" },
  });
  expect(duplicate.status).toBe(409);
  const login = await request("/api/auth/login", "POST", {
    body: { email: account.email.toUpperCase(), password },
  });
  expect(login.status).toBe(200);
  expect(sessionCookie(login)).not.toBe(account.cookie);
});

integrationTest("跨 Origin 和缺失 Origin 的写请求被拒绝，未认证请求不能读取工作区数据", async () => {
  const account = await register("origin");
  const unauthorized = await request("/api/billing/summary");
  expect(unauthorized.status).toBe(401);
  for (const invalidOrigin of ["https://untrusted.example", "null", null]) {
    const response = await request("/api/auth/logout", "POST", {
      cookie: account.cookie, origin: invalidOrigin,
    });
    expect(response.status).toBe(403);
  }
  expect((await request("/api/auth/me", "GET", { cookie: account.cookie })).status).toBe(200);
});

integrationTest("member 不能提升角色或邀请；工作区请求头与路径均隔离权限；移除后立即失去访问权", async () => {
  const owner = await register("permissions-owner");
  const member = await register("permissions-member");
  const workspaceId = await createTeam(owner.cookie, "权限");
  const token = await invite(owner.cookie, workspaceId);
  const accepted = await request(`/api/invites/${token}/accept`, "POST", { cookie: member.cookie });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ id: workspaceId, role: "member" });

  const escalation = await request(`/api/workspaces/${workspaceId}/members/${member.me.user.id}`, "PATCH", {
    cookie: member.cookie, workspaceId, body: { role: "admin", monthlyCap: null },
  });
  expect(escalation.status).toBe(403);
  const forbiddenInvite = await request(`/api/workspaces/${workspaceId}/invites`, "POST", {
    cookie: member.cookie, workspaceId, body: { role: "admin" },
  });
  expect(forbiddenInvite.status).toBe(403);
  const crossWorkspace = await request("/api/billing/summary", "GET", {
    cookie: member.cookie, workspaceId: owner.me.currentWorkspaceId,
  });
  expect(crossWorkspace.status).toBe(403);
  const crossPath = await request(`/api/workspaces/${owner.me.currentWorkspaceId}/members`, "GET", {
    cookie: member.cookie, workspaceId,
  });
  expect(crossPath.status).toBe(403);

  const cap = await request(`/api/workspaces/${workspaceId}/members/${member.me.user.id}`, "PATCH", {
    cookie: owner.cookie, workspaceId, body: { monthlyCap: 10 },
  });
  expect(cap.status).toBe(200);
  expect(await cap.json()).toMatchObject({ role: "member", monthlyCap: 10 });
  const switchWorkspace = await request("/api/auth/me", "GET", { cookie: member.cookie, workspaceId });
  expect(switchWorkspace.status).toBe(200);
  expect((await switchWorkspace.json() as Me).currentWorkspaceId).toBe(workspaceId);
  const ownSummary = await request("/api/billing/summary", "GET", { cookie: member.cookie });
  expect(ownSummary.status).toBe(200);
  expect(await ownSummary.json()).toMatchObject({ myMonthlyCap: 10 });

  const removed = await request(`/api/workspaces/${workspaceId}/members/${member.me.user.id}`, "DELETE", {
    cookie: owner.cookie, workspaceId,
  });
  expect(removed.status).toBe(204);
  expect((await request("/api/billing/summary", "GET", { cookie: member.cookie, workspaceId })).status).toBe(403);
});

integrationTest("有效邀请可随注册接受；过期邀请返回 409 且注册用户与赠点事务回滚", async () => {
  const owner = await register("invite-owner");
  const workspaceId = await createTeam(owner.cookie, "邀请");
  const validToken = await invite(owner.cookie, workspaceId);
  const preview = await request(`/api/invites/${validToken}`);
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({ role: "member", expired: false });
  const invited = await register("invite-new-user", validToken);
  expect(invited.me.currentWorkspaceId).toBe(workspaceId);
  expect(invited.me.workspaces).toHaveLength(2);
  expect(invited.me.workspaces).toContainEqual(expect.objectContaining({ id: workspaceId, role: "member" }));
  const [acceptedInvite] = await client`SELECT accepted_by, accepted_at FROM workspace_invites WHERE token = ${validToken}`;
  expect(acceptedInvite.accepted_by).toBe(invited.me.user.id);
  expect(acceptedInvite.accepted_at).not.toBeNull();

  const expiredToken = await invite(owner.cookie, workspaceId);
  await client`UPDATE workspace_invites SET expires_at = now() - interval '1 second' WHERE token = ${expiredToken}`;
  const expiredPreview = await request(`/api/invites/${expiredToken}`);
  expect(await expiredPreview.json()).toMatchObject({ expired: true });
  const acceptance = await request(`/api/invites/${expiredToken}/accept`, "POST", { cookie: invited.cookie });
  expect(acceptance.status).toBe(409);
  const failedEmail = emailFor("invite-rolled-back");
  const failedRegistration = await request("/api/auth/register", "POST", {
    body: { email: failedEmail, password, name: "应回滚的注册", inviteToken: expiredToken },
  });
  expect(failedRegistration.status).toBe(409);
  expect(failedRegistration.headers.get("set-cookie")).toBeNull();
  expect(await client`SELECT id FROM users WHERE email = ${failedEmail}`).toHaveLength(0);
  const [untouchedInvite] = await client`SELECT accepted_by, accepted_at FROM workspace_invites WHERE token = ${expiredToken}`;
  expect(untouchedInvite.accepted_by).toBeNull();
  expect(untouchedInvite.accepted_at).toBeNull();
});

integrationTest("会话剩余不足 15 天时续期；退出和数据库过期都会使旧 Cookie 失效", async () => {
  const account = await register("session");
  const token = account.cookie.slice("ic_session=".length);
  const hash = createHash("sha256").update(token).digest("hex");
  await client`UPDATE sessions SET expires_at = now() + interval '1 day' WHERE token_hash = ${hash}`;
  const renewal = await request("/api/auth/me", "GET", { cookie: account.cookie });
  expect(renewal.status).toBe(200);
  const renewedCookie = sessionCookie(renewal);
  const [renewed] = await client`SELECT expires_at FROM sessions WHERE token_hash = ${hash}`;
  expect(new Date(renewed.expires_at).getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
  const logout = await request("/api/auth/logout", "POST", { cookie: renewedCookie });
  expect(logout.status).toBe(204);
  expect(logout.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  expect((await request("/api/auth/me", "GET", { cookie: renewedCookie })).status).toBe(401);
  expect(await client`SELECT id FROM sessions WHERE token_hash = ${hash}`).toHaveLength(0);

  const login = await request("/api/auth/login", "POST", { body: { email: account.email, password } });
  expect(login.status).toBe(200);
  const expiredCookie = sessionCookie(login);
  const expiredHash = createHash("sha256").update(expiredCookie.slice("ic_session=".length)).digest("hex");
  await client`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = ${expiredHash}`;
  expect((await request("/api/auth/me", "GET", { cookie: expiredCookie })).status).toBe(401);
});
