import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { ZodError } from "zod";
import postgres from "postgres";
import type { AppEnv } from "../src/lib/context";
import { ApiError } from "../src/lib/errors";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const suffix = randomUUID().replaceAll("-", "");
const adminId = `usr_admin_api_${suffix}`;
const memberId = `usr_regular_api_${suffix}`;
const workspaceId = `ws_admin_api_${suffix}`;
const modelId = `admin-model-${suffix}`;
const jobId = `job_admin_api_${suffix}`;
const secret = `synthetic-provider-secret-${suffix}`;
const adminToken = randomBytes(32).toString("base64url");
const memberToken = randomBytes(32).toString("base64url");
const providerIds = new Set<string>();
let client: postgres.Sql;
let app: Hono<AppEnv>;
let requestedUrl = "";
let requestedAuth = "";
let failUpstream = false;
let providerId: string;

beforeAll(async () => {
  if (!databaseUrl) return;
  client = postgres(databaseUrl, { max: 1 });
  const { createAdminRoutes } = await import("../src/routes/admin");
  const { checkOrigin } = await import("../src/middleware/origin");
  app = new Hono<AppEnv>();
  app.use("*", checkOrigin);
  app.route("/api/admin", createAdminRoutes({ fetch: async (input, init) => {
    requestedUrl = String(input);
    requestedAuth = new Headers(init?.headers).get("Authorization") ?? "";
    if (failUpstream) return Response.json({ error: { message: `secret echo ${secret}` } }, { status: 500 });
    return Response.json({ data: [{ id: "test-image" }, { id: secret }, { id: "test-text" }] });
  } }));
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof ZodError) return c.json({ error: { code: "validation_error" } }, 422);
    return c.json({ error: { code: "internal_error" } }, 500);
  });
  await client.begin(async (tx) => {
    for (const [userId, token, isAdmin] of [[adminId, adminToken, true], [memberId, memberToken, false]] as const) {
      await tx`INSERT INTO users (id, email, password_hash, name, is_platform_admin) VALUES (${userId}, ${`${userId}@example.test`}, 'fixture-no-password-login', '管理接口验收', ${isAdmin})`;
      await tx`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (${`ses_${userId}`}, ${userId}, ${createHash("sha256").update(token).digest("hex")}, now() + interval '1 day')`;
    }
    await tx`INSERT INTO workspaces (id, name, kind, owner_id) VALUES (${workspaceId}, '供应商历史验收', 'personal', ${adminId})`;
  });
});

afterAll(async () => {
  if (!databaseUrl || !client) return;
  try {
    await client.begin(async (tx) => {
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId} AND owner_id = ${adminId}`;
      await tx`DELETE FROM models WHERE id = ${modelId}`;
      if (providerIds.size) await tx`DELETE FROM providers WHERE id IN ${tx([...providerIds])}`;
      await tx`DELETE FROM users WHERE id IN ${tx([adminId, memberId])}`;
    });
  } finally { await client.end(); }
});

const request = (path: string, method = "GET", body?: unknown, token = adminToken) => app.request(`/api/admin${path}`, {
  method, headers: { Origin: process.env.APP_ORIGIN ?? "http://localhost:3000", "Content-Type": "application/json", Cookie: `ic_session=${token}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});

integrationTest("管理接口拒绝普通用户，供应商 Key 加密落库且响应仅有末四位", async () => {
  expect((await request("/providers", "GET", undefined, memberToken)).status).toBe(403);
  const response = await request("/providers", "POST", { name: "验收供应商", baseUrl: "https://provider.example.test/v1/", apiKey: secret });
  expect(response.status).toBe(201);
  const provider = await response.json() as { id: string; last4: string; baseUrl: string };
  providerId = provider.id;
  providerIds.add(providerId);
  expect(provider.last4).toBe(secret.slice(-4));
  expect(provider.baseUrl).toBe("https://provider.example.test");
  expect(JSON.stringify(provider)).not.toContain(secret);
  expect(provider).not.toHaveProperty("apiKeyEncrypted");
  expect(provider).not.toHaveProperty("apiKey");
  const [stored] = await client`SELECT api_key_encrypted FROM providers WHERE id = ${providerId}`;
  expect(stored.api_key_encrypted).not.toContain(secret);
  const { decryptSecret } = await import("../src/lib/crypto");
  expect(decryptSecret(stored.api_key_encrypted)).toBe(secret);
  const patched = await request(`/providers/${providerId}`, "PATCH", { name: "更名供应商", apiKey: "" });
  expect(patched.status).toBe(200);
  const [unchanged] = await client`SELECT api_key_encrypted FROM providers WHERE id = ${providerId}`;
  expect(unchanged.api_key_encrypted).toBe(stored.api_key_encrypted);
  expect((await request("/providers", "POST", { name: "不合法", baseUrl: `https://user:${secret}@provider.example.test`, apiKey: secret })).status).toBe(422);
});

integrationTest("连通测试转发解密 Key，但过滤上游回显密钥和敏感错误", async () => {
  const response = await request(`/providers/${providerId}/test`, "POST");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, models: ["test-image", "test-text"] });
  expect(requestedUrl).toBe("https://provider.example.test/v1/models");
  expect(requestedAuth).toBe(`Bearer ${secret}`);
  failUpstream = true;
  const failure = await request(`/providers/${providerId}/test`, "POST");
  expect(failure.status).toBe(502);
  expect(await failure.text()).not.toContain(secret);
  failUpstream = false;
});

integrationTest("模型与路由定价原子保存，局部更新保留其他参数，删除只停用", async () => {
  const body = { id: modelId, displayName: "测试图片模型", capability: "image", supportsEdit: true, maxReferenceImages: 12, sort: 42, routes: [{ providerId, upstreamModel: "test-image", priority: 1 }], pricing: { unit: "per_image", config: { standard: 4, hd: 8 } } };
  expect((await request("/models", "POST", { ...body, routes: [{ providerId: "missing-provider", upstreamModel: "bad" }] })).status).toBe(422);
  expect(await client`SELECT id FROM models WHERE id = ${modelId}`).toHaveLength(0);
  const created = await request("/models", "POST", body);
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject(body);
  expect((await request("/models", "POST", body)).status).toBe(409);
  const patch = await request(`/models/${modelId}`, "PATCH", { displayName: "已更名" });
  expect(patch.status).toBe(200);
  expect(await patch.json()).toMatchObject({ displayName: "已更名", supportsEdit: true, maxReferenceImages: 12, sort: 42, routes: body.routes, pricing: body.pricing });
  expect((await request(`/models/${modelId}`, "PATCH", { pricing: { unit: "per_second", config: { price: 12 } } })).status).toBe(422);
  expect((await request(`/models/${modelId}`, "PATCH", { pricing: { unit: "per_image", config: { standard: -1, hd: 8 } } })).status).toBe(422);
  expect((await request(`/models/${modelId}`, "DELETE")).status).toBe(204);
  const [stored] = await client`SELECT is_active FROM models WHERE id = ${modelId}`;
  expect(stored.is_active).toBe(false);
  expect(await client`SELECT model_id FROM model_routes WHERE model_id = ${modelId}`).toHaveLength(1);
});

integrationTest("有历史引用的供应商删除仅停用，无历史供应商可物理删除", async () => {
  await client`INSERT INTO generation_jobs (id, workspace_id, user_id, model_id, provider_id, capability, endpoint, status, estimate_credits)
    VALUES (${jobId}, ${workspaceId}, ${adminId}, ${modelId}, ${providerId}, 'image', 'images/generations', 'failed', 0)`;
  expect((await request(`/providers/${providerId}`, "DELETE")).status).toBe(204);
  const [existing] = await client`SELECT is_active FROM providers WHERE id = ${providerId}`;
  expect(existing.is_active).toBe(false);
  const response = await request("/providers", "POST", { name: "未使用供应商", baseUrl: "https://unused.example.test", apiKey: `${secret}-unused` });
  expect(response.status).toBe(201);
  const unused = await response.json() as { id: string };
  providerIds.add(unused.id);
  expect((await request(`/providers/${unused.id}`, "DELETE")).status).toBe(204);
  expect(await client`SELECT id FROM providers WHERE id = ${unused.id}`).toHaveLength(0);
});
