import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const suffix = randomUUID().replaceAll("-", "");
const userId = `usr_login_${suffix}`;
const workspaceId = `ws_login_${suffix}`;
const email = `${userId}@example.test`;
const password = "Security-test-password-42!";
const token = randomBytes(32).toString("base64url");
let client: postgres.Sql;
let app: ReturnType<(typeof import("../src/app"))["createApp"]>;

beforeAll(async () => {
  if (!databaseUrl) return;
  client = postgres(databaseUrl, { max: 1 });
  app = (await import("../src/app")).createApp();
  const passwordHash = await Bun.password.hash(password, "argon2id");
  await client.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash, name, last_workspace_id) VALUES (${userId}, ${email}, ${passwordHash}, '登录限流验收', ${workspaceId})`;
    await tx`INSERT INTO workspaces (id, name, kind, owner_id) VALUES (${workspaceId}, '空邀请验收', 'personal', ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (${`ses_login_${suffix}`}, ${userId}, ${createHash("sha256").update(token).digest("hex")}, now() + interval '1 day')`;
  });
});

afterAll(async () => {
  if (!databaseUrl || !client) return;
  try {
    await client.begin(async (tx) => {
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId} AND owner_id = ${userId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  } finally { await client.end(); }
});

integrationTest("成功登录不重置同 IP 五分钟内的失败计数", async () => {
  const login = (value: string) => app.request("/api/auth/login", {
    method: "POST", headers: { Origin: process.env.APP_ORIGIN ?? "http://localhost:3000", "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: value }),
  }, { requestIP: () => ({ address: "192.0.2.203", family: "IPv4", port: 42000 }) });
  for (let attempt = 0; attempt < 9; attempt += 1) expect((await login("wrong-password")).status).toBe(401);
  expect((await login(password)).status).toBe(200);
  expect((await login("wrong-password")).status).toBe(401);
  expect((await login(password)).status).toBe(429);
});

integrationTest("邀请请求允许空体并使用 member 默认角色", async () => {
  const response = await app.request(`/api/workspaces/${workspaceId}/invites`, {
    method: "POST", headers: { Origin: process.env.APP_ORIGIN ?? "http://localhost:3000", Cookie: `ic_session=${token}`, "X-IC-Workspace": workspaceId },
  });
  expect(response.status).toBe(201);
  const invite = await response.json() as { token: string };
  const [stored] = await client`SELECT role FROM workspace_invites WHERE token = ${invite.token}`;
  expect(stored.role).toBe("member");
});
