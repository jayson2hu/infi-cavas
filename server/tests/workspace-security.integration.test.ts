import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const suffix = randomUUID().replaceAll("-", "");
const workspaceId = `ws_security_${suffix}`;
const ownerId = `usr_owner_${suffix}`;
const adminId = `usr_admin_${suffix}`;
const memberId = `usr_member_${suffix}`;
const token = randomBytes(32).toString("base64url");
const originalName = `权限竞态验收 ${suffix}`;
let client: postgres.Sql;
let app: ReturnType<(typeof import("../src/app"))["createApp"]>;

beforeAll(async () => {
  if (!databaseUrl) return;
  client = postgres(databaseUrl, { max: 3 });
  app = (await import("../src/app")).createApp();
  await client.begin(async (tx) => {
    for (const userId of [ownerId, adminId, memberId]) {
      await tx`INSERT INTO users (id, email, password_hash, name, last_workspace_id)
        VALUES (${userId}, ${`${userId}@example.test`}, 'fixture-no-password-login', '权限验收', ${workspaceId})`;
    }
    await tx`INSERT INTO workspaces (id, name, kind, owner_id) VALUES (${workspaceId}, ${originalName}, 'team', ${ownerId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
      (${workspaceId}, ${ownerId}, 'owner'), (${workspaceId}, ${adminId}, 'admin'), (${workspaceId}, ${memberId}, 'member')`;
    await tx`INSERT INTO sessions (id, user_id, token_hash, expires_at)
      VALUES (${`ses_security_${suffix}`}, ${adminId}, ${createHash("sha256").update(token).digest("hex")}, now() + interval '1 day')`;
  });
});

afterAll(async () => {
  if (!databaseUrl || !client) return;
  try {
    await client.begin(async (tx) => {
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId} AND owner_id = ${ownerId}`;
      await tx`DELETE FROM users WHERE id IN ${tx([ownerId, adminId, memberId])}`;
    });
  } finally { await client.end(); }
});

async function waitForBlockedRequest(blockerPid: number, request: Promise<Response>) {
  let response: Response | undefined;
  void request.then((value) => { response = value; });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (response) throw new Error(`权限写请求未等待撤权事务，提前返回 ${response.status}`);
    const rows = await client`SELECT pid FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`;
    if (rows.length) return;
  }
  throw new Error("未观察到权限写请求等待数据库锁");
}

for (const action of [
  { label: "角色修改", method: "PATCH", path: `/api/workspaces/${workspaceId}/members/${adminId}`, body: { role: "admin" } },
  { label: "工作区改名", method: "PATCH", path: `/api/workspaces/${workspaceId}`, body: { name: "不应写入" } },
  { label: "移除成员", method: "DELETE", path: `/api/workspaces/${workspaceId}/members/${memberId}` },
  { label: "创建邀请", method: "POST", path: `/api/workspaces/${workspaceId}/invites`, body: { role: "admin" } },
]) {
  integrationTest(`${action.label}在等待期间被撤销管理员权限后必须拒绝`, async () => {
    await client`UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ${workspaceId} AND user_id = ${adminId}`;
    let pending!: Promise<Response>;
    await client.begin(async (tx) => {
      const [connection] = await tx`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
      await tx`UPDATE workspace_members SET role = 'member' WHERE workspace_id = ${workspaceId} AND user_id = ${adminId}`;
      // The middleware can still see the committed admin role; the write must recheck after this transaction commits.
      pending = Promise.resolve(app.request(action.path, {
        method: action.method,
        headers: { Cookie: `ic_session=${token}`, "X-IC-Workspace": workspaceId, Origin: process.env.APP_ORIGIN ?? "http://localhost:3000", "Content-Type": "application/json" },
        body: action.body ? JSON.stringify(action.body) : undefined,
      }));
      await waitForBlockedRequest(connection.pid as number, pending);
    });
    const response = await pending;
    expect(response.status).toBe(403);
    const [admin] = await client`SELECT role FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id = ${adminId}`;
    expect(admin.role).toBe("member");
    const [workspace] = await client`SELECT name FROM workspaces WHERE id = ${workspaceId}`;
    expect(workspace.name).toBe(originalName);
    expect(await client`SELECT user_id FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id = ${memberId}`).toHaveLength(1);
    expect(await client`SELECT token FROM workspace_invites WHERE workspace_id = ${workspaceId}`).toHaveLength(0);
  }, 10000);
}
