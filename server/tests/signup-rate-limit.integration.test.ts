import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const suffix = randomUUID().replaceAll("-", "");
const ownerId = `usr_signup_${suffix}`;
const workspaceId = `ws_signup_${suffix}`;
const inviteToken = randomBytes(32).toString("base64url");
const emails = Array.from({ length: 5 }, (_, index) => `signup-${index}-${suffix}@example.test`);
let client: postgres.Sql;
let app: ReturnType<(typeof import("../src/app"))["createApp"]>;
let env: (typeof import("../src/env"))["env"];

beforeAll(async () => {
  if (!databaseUrl) return;
  client = postgres(databaseUrl, { max: 1 });
  app = (await import("../src/app")).createApp();
  env = (await import("../src/env")).env;
  await client.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash, name) VALUES (${ownerId}, ${`owner-${suffix}@example.test`}, 'x', '邀请人')`;
    await tx`INSERT INTO workspaces (id, name, kind, owner_id) VALUES (${workspaceId}, '注册限流验收', 'team', ${ownerId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${ownerId}, 'owner')`;
    await tx`INSERT INTO workspace_invites (token, workspace_id, role, created_by, expires_at) VALUES (${inviteToken}, ${workspaceId}, 'member', ${ownerId}, now() + interval '1 day')`;
  });
});

afterAll(async () => {
  if (!databaseUrl || !client) return;
  env.SIGNUP_RATE_LIMIT_PER_HOUR = 0;
  try {
    await client.begin(async (tx) => {
      const created = await tx`SELECT id FROM users WHERE email = ANY(${emails})`;
      const ids = [ownerId, ...created.map((row) => row.id as string)];
      await tx`DELETE FROM workspace_invites WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE owner_id = ANY(${ids})`;
      await tx`DELETE FROM users WHERE id = ANY(${ids})`;
    });
  } finally { await client.end(); }
});

const register = (email: string, extra: Record<string, string> = {}) => app.request("/api/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
  body: JSON.stringify({ email, password: "Signup-test-password-42!", name: "注册限流", ...extra }),
});

integrationTest("同一 IP 超过每小时注册上限返回 429 且不创建账号、不发放点数；邀请注册不受限", async () => {
  env.SIGNUP_RATE_LIMIT_PER_HOUR = 2;
  expect((await register(emails[0])).status).toBe(201);
  expect((await register(emails[1])).status).toBe(201);
  const blocked = await register(emails[2]);
  expect(blocked.status).toBe(429);
  expect((await blocked.json()).error.code).toBe("rate_limited");
  expect((await client`SELECT count(*)::int AS count FROM users WHERE email = ${emails[2]}`)[0].count).toBe(0);
  // 无效邀请不能绕过：整个注册事务回滚，不创建账号。
  expect((await register(emails[3], { inviteToken: "not-a-real-invite" })).status).toBe(404);
  expect((await client`SELECT count(*)::int AS count FROM users WHERE email = ${emails[3]}`)[0].count).toBe(0);
  // 凭有效邀请注册不计入限流。
  expect((await register(emails[4], { inviteToken })).status).toBe(201);
  expect((await client`SELECT count(*)::int AS count FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.email = ${emails[4]} AND m.workspace_id = ${workspaceId}`)[0].count).toBe(1);
});
