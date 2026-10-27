import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db, type Transaction } from "../db/client";
import { generationJobs, modelRoutes, models, pricingRules, providers, videoTasks } from "../db/schema";
import { pricingRuleSchema, MAX_CREDITS, type PricingRule } from "../gateway/pricing";
import type { AppEnv } from "../lib/context";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { ApiError, invariant } from "../lib/errors";
import { id } from "../lib/ids";
import { requirePlatformAdmin, requireSession } from "../middleware/session";

const integer = z.number().int().min(-2147483648).max(MAX_CREDITS);
const baseUrl = z.string().url().superRefine((value, c) => {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    c.addIssue({ code: "custom", message: "供应商地址必须是无内嵌凭据、查询参数或片段的 HTTP(S) URL" });
  }
}).transform((value) => value.replace(/\/+$/, "").replace(/\/v1$/, ""));
const providerInput = z.object({ name: z.string().trim().min(1), baseUrl, apiKey: z.string().trim().min(1), isActive: z.boolean().optional() });
const providerPatch = providerInput.partial().extend({ apiKey: z.string().trim().optional() });
const routeInput = z.object({ providerId: z.string().min(1), upstreamModel: z.string().trim().min(1), priority: integer.default(0) });
const routesInput = z.array(routeInput).refine((routes) => new Set(routes.map((route) => route.providerId)).size === routes.length, "同一模型不能重复设置相同供应商");
const modelInput = z.object({
  id: z.string().trim().min(1), displayName: z.string().trim().min(1), capability: z.enum(["image", "video", "text", "audio"]),
  supportsEdit: z.boolean().default(false), maxReferenceImages: integer.min(0).default(8), isActive: z.boolean().default(true), sort: integer.default(0),
  routes: routesInput, pricing: pricingRuleSchema,
});
const modelPatch = z.object({
  displayName: z.string().trim().min(1).optional(), capability: z.enum(["image", "video", "text", "audio"]).optional(),
  supportsEdit: z.boolean().optional(), maxReferenceImages: integer.min(0).optional(), isActive: z.boolean().optional(), sort: integer.optional(),
  routes: routesInput.optional(), pricing: pricingRuleSchema.optional(),
});
type Provider = typeof providers.$inferSelect;
type UpstreamFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function publicProvider(provider: Provider) {
  const secret = decryptSecret(provider.apiKeyEncrypted);
  const redact = (value: string) => value.replaceAll(secret, "[REDACTED]");
  return { id: provider.id, name: redact(provider.name), baseUrl: redact(provider.baseUrl), apiFormat: provider.apiFormat, isActive: provider.isActive, createdAt: provider.createdAt, last4: secret.length > 4 ? secret.slice(-4) : "" };
}

function checkPricingCapability(capability: typeof models.$inferSelect.capability, pricing: PricingRule) {
  const units = { image: "per_image", video: "per_second", text: "per_1k_tokens", audio: "per_1k_chars" };
  invariant(pricing.unit === units[capability], 422, "pricing_capability_mismatch", "计价单位与模型能力不匹配");
}

async function checkRoutes(tx: Transaction, routes: z.infer<typeof routesInput>) {
  if (!routes.length) return;
  const existing = await tx.select({ id: providers.id }).from(providers).where(inArray(providers.id, routes.map((route) => route.providerId))).for("key share");
  invariant(existing.length === routes.length, 422, "provider_not_found", "模型路由中存在无效供应商");
}

async function listModels(modelId?: string) {
  const selected = await db.select().from(models).where(modelId ? eq(models.id, modelId) : undefined).orderBy(models.sort, models.id);
  if (!selected.length) return [];
  const ids = selected.map((model) => model.id);
  const [routes, pricing] = await Promise.all([
    db.select().from(modelRoutes).where(inArray(modelRoutes.modelId, ids)).orderBy(modelRoutes.priority),
    db.select().from(pricingRules).where(inArray(pricingRules.modelId, ids)),
  ]);
  return selected.map((model) => {
    const rule = pricing.find((entry) => entry.modelId === model.id);
    return { ...model, routes: routes.filter((route) => route.modelId === model.id).map(({ providerId, upstreamModel, priority }) => ({ providerId, upstreamModel, priority })), pricing: rule ? { unit: rule.unit, config: rule.config } : null };
  });
}

export function createAdminRoutes(options: { fetch?: UpstreamFetch } = {}) {
  const fetchUpstream = options.fetch ?? globalThis.fetch;
  const app = new Hono<AppEnv>();
  app.use("*", requireSession, requirePlatformAdmin);
  app.get("/providers", async (c) => c.json((await db.select().from(providers).orderBy(providers.createdAt)).map(publicProvider)));
  app.post("/providers", async (c) => {
    const input = providerInput.parse(await c.req.json());
    const [provider] = await db.insert(providers).values({ id: id("prv"), name: input.name, baseUrl: input.baseUrl, apiKeyEncrypted: encryptSecret(input.apiKey), isActive: input.isActive }).returning();
    return c.json(publicProvider(provider), 201);
  });
  app.patch("/providers/:id", async (c) => {
    const input = providerPatch.parse(await c.req.json());
    const provider = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(providers).where(eq(providers.id, c.req.param("id"))).for("update");
      invariant(existing, 404, "provider_not_found", "供应商不存在");
      const changes = { name: input.name, baseUrl: input.baseUrl, isActive: input.isActive, apiKeyEncrypted: input.apiKey ? encryptSecret(input.apiKey) : undefined };
      if (Object.values(changes).every((value) => value === undefined)) return existing;
      return (await tx.update(providers).set(changes).where(eq(providers.id, existing.id)).returning())[0];
    });
    return c.json(publicProvider(provider));
  });
  app.delete("/providers/:id", async (c) => {
    await db.transaction(async (tx) => {
      const [provider] = await tx.select().from(providers).where(eq(providers.id, c.req.param("id"))).for("update");
      invariant(provider, 404, "provider_not_found", "供应商不存在");
      const [job] = await tx.select({ id: generationJobs.id }).from(generationJobs).where(eq(generationJobs.providerId, provider.id)).limit(1);
      const [video] = await tx.select({ id: videoTasks.id }).from(videoTasks).where(eq(videoTasks.providerId, provider.id)).limit(1);
      // Historical jobs reference providers; retaining the row preserves ledger and video history.
      if (job || video) await tx.update(providers).set({ isActive: false }).where(eq(providers.id, provider.id));
      else await tx.delete(providers).where(eq(providers.id, provider.id));
    });
    return c.body(null, 204);
  });
  app.post("/providers/:id/test", async (c) => {
    const [provider] = await db.select().from(providers).where(eq(providers.id, c.req.param("id")));
    invariant(provider, 404, "provider_not_found", "供应商不存在");
    const secret = decryptSecret(provider.apiKeyEncrypted);
    try {
      const response = await fetchUpstream(`${provider.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${secret}` }, redirect: "error", signal: c.req.raw.signal });
      if (!response.ok) throw new Error();
      const payload = await response.json() as { data?: Array<{ id?: unknown }> };
      if (!Array.isArray(payload.data)) throw new Error();
      const names = payload.data.map((model) => model.id).filter((value): value is string => typeof value === "string" && !value.includes(secret));
      return c.json({ ok: true, models: names });
    } catch {
      throw new ApiError(502, "upstream_unavailable", "供应商连接失败，请检查地址与密钥");
    }
  });
  app.get("/models", async (c) => c.json(await listModels()));
  app.post("/models", async (c) => {
    const { routes, pricing, ...model } = modelInput.parse(await c.req.json());
    checkPricingCapability(model.capability, pricing);
    await db.transaction(async (tx) => {
      await checkRoutes(tx, routes);
      const inserted = await tx.insert(models).values(model).onConflictDoNothing().returning({ id: models.id });
      invariant(inserted.length, 409, "model_exists", "模型名称已存在");
      if (routes.length) await tx.insert(modelRoutes).values(routes.map((route) => ({ ...route, modelId: model.id })));
      await tx.insert(pricingRules).values({ modelId: model.id, ...pricing });
    });
    return c.json((await listModels(model.id))[0], 201);
  });
  app.patch("/models/:id", async (c) => {
    const { routes, pricing, ...changes } = modelPatch.parse(await c.req.json());
    await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(models).where(eq(models.id, c.req.param("id"))).for("update");
      invariant(existing, 404, "model_not_found", "模型不存在");
      const [oldPricing] = await tx.select().from(pricingRules).where(eq(pricingRules.modelId, existing.id));
      invariant(pricing || oldPricing, 422, "pricing_required", "请配置模型定价");
      checkPricingCapability(changes.capability ?? existing.capability, pricing ?? oldPricing);
      if (routes) await checkRoutes(tx, routes);
      if (Object.values(changes).some((value) => value !== undefined)) await tx.update(models).set(changes).where(eq(models.id, existing.id));
      if (routes) {
        await tx.delete(modelRoutes).where(eq(modelRoutes.modelId, existing.id));
        if (routes.length) await tx.insert(modelRoutes).values(routes.map((route) => ({ ...route, modelId: existing.id })));
      }
      if (pricing) await tx.insert(pricingRules).values({ modelId: existing.id, ...pricing }).onConflictDoUpdate({ target: pricingRules.modelId, set: { ...pricing, updatedAt: new Date() } });
    });
    return c.json((await listModels(c.req.param("id")))[0]);
  });
  app.delete("/models/:id", async (c) => {
    const updated = await db.update(models).set({ isActive: false }).where(eq(models.id, c.req.param("id"))).returning({ id: models.id });
    invariant(updated.length, 404, "model_not_found", "模型不存在");
    return c.body(null, 204);
  });
  return app;
}

export const adminRoutes = createAdminRoutes();
