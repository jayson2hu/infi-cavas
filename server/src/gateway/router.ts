import { and, asc, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { db } from "../db/client";
import { generationJobs, modelRoutes, models, pricingRules, providers, videoTasks } from "../db/schema";
import { balance, hold, lockWorkspace, refund, settle } from "../billing/ledger";
import type { AppEnv } from "../lib/context";
import { ApiError, invariant } from "../lib/errors";
import { id } from "../lib/ids";
import { assertWorkspaceObject, readObject } from "../lib/s3";
import { createRateLimiter } from "../middleware/rate-limit";
import { gatewayAuth } from "./auth";
import { enqueueArchive, trackArchive } from "./archive";
import { assertNoMediaSecret, guardMediaStream, validateReferenceImages } from "./media";
import { checkPrompt, checkResult, responseText } from "./moderation";
import { actual, estimate, validatePricingRule } from "./pricing";
import { responseStream } from "./response-stream";
import { bodyParams, injectGatewayBrand, resolveBrand, withBrandDefaults, type GatewayBody } from "./brand-inject";
import { fetchProvider, forwardModel, redactPayload, redactSecrets, upstreamError, type UpstreamFetch } from "./upstream";

type Capability = "image" | "video" | "text" | "audio";
export type GatewayOptions = { fetch?: UpstreamFetch };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function headersFor(c: Context<AppEnv>, result: Awaited<ReturnType<typeof hold>>) {
  c.header("X-IC-Job-Id", result.job.id);
  c.header("X-IC-Credits-Charged", String(result.job.chargedCredits));
  c.header("X-IC-Credits-Balance", String(result.balance));
  c.header("Cache-Control", "no-store");
}
function jsonResponse(c: Context<AppEnv>, value: unknown) { return c.body(JSON.stringify(value), 200, { "Content-Type": "application/json" }); }

async function prepare(c: Context<AppEnv>, endpoint: string, capability: Capability) {
  let body: GatewayBody = c.req.header("Content-Type")?.includes("multipart/form-data") ? await c.req.formData() : record(await c.req.json());
  const brand = await resolveBrand(c);
  body = withBrandDefaults(body, brand, capability);
  let params = bodyParams(body);
  invariant(typeof params.model === "string", 422, "model_required", "请选择模型");
  const [model] = await db.select().from(models).where(and(eq(models.id, params.model), eq(models.isActive, true)));
  invariant(model && model.capability === capability, 404, "model_not_found", "模型不存在或未开放");
  const [price] = await db.select().from(pricingRules).where(eq(pricingRules.modelId, model.id));
  invariant(price, 503, "pricing_unavailable", "此模型尚未配置定价");
  const rule = validatePricingRule(price);
  const [route] = await db.select({ providerId: providers.id }).from(modelRoutes).innerJoin(providers, eq(providers.id, modelRoutes.providerId)).where(and(eq(modelRoutes.modelId, model.id), eq(providers.isActive, true))).orderBy(asc(modelRoutes.priority));
  invariant(route, 503, "provider_unavailable", "此模型尚未配置可用供应商");
  if (endpoint === "images/edits") invariant(body instanceof FormData && model.supportsEdit, 422, "edit_unsupported", "此模型不支持图片编辑");
  const originals = body instanceof FormData ? [...body.getAll("image"), ...body.getAll("image[]")] : [];
  const originalCount = originals.filter((item) => item instanceof File).length;
  if (endpoint === "images/edits") invariant(originalCount > 0 && originalCount <= model.maxReferenceImages, 422, "invalid_references", "参考图片数量不符合模型要求");
  if (body instanceof FormData) await validateReferenceImages(body);
  const injected = await injectGatewayBrand({ body, brand, capability, endpoint, supportsEdit: model.supportsEdit, maxReferenceImages: model.maxReferenceImages, originalReferenceCount: originalCount, signal: c.req.raw.signal });
  body = injected.body;
  endpoint = injected.endpoint;
  params = bodyParams(body);
  const prompt = capability === "text" || capability === "audio" ? [params.instructions, responseText(params.input)].filter((value) => typeof value === "string").join("\n") : String(params.prompt ?? params.input ?? "");
  checkPrompt(prompt);
  const estimateCredits = estimate(rule, params);
  const jobParams = Object.fromEntries(["n", "size", "seconds", "quality", "voice", "response_format", "speed"].filter((key) => typeof params[key] === "string" || typeof params[key] === "number").map((key) => [key, params[key]]));
  const held = await hold({ workspaceId: c.get("workspace").id, userId: c.get("user").id, apiTokenId: c.get("apiTokenId"), brandId: brand?.id, modelId: model.id, providerId: route.providerId, capability, endpoint, estimateCredits, params: jobParams, prompt, projectId: c.req.header("X-IC-Project"), nodeId: c.req.header("X-IC-Node"), source: c.req.header("X-IC-Source") ?? (c.get("apiTokenId") ? "api" : "canvas") });
  headersFor(c, held);
  return { body, params, rule, model, held, endpoint, prompt };
}

async function failJob(c: Context<AppEnv>, jobId: string, error: unknown, secrets: string[] = []) {
  const message = error instanceof ApiError ? redactSecrets(error.message, secrets) : error instanceof Error && error.name === "AbortError" ? "请求已取消" : "模型供应商请求失败";
  headersFor(c, await refund(jobId, { error: message }));
  if (error instanceof ApiError) throw new ApiError(error.status, error.code, message, error.extra);
  throw new ApiError(502, "generation_failed", message);
}

export function createGatewayRoutes(options: GatewayOptions = {}) {
  const fetcher = options.fetch ?? fetch;
  const app = new Hono<AppEnv>();
  const limiter = createRateLimiter(60, 60000);
  app.use("*", gatewayAuth);
  app.use("*", bodyLimit({ maxSize: 100 * 1024 * 1024, onError: (c) => c.json({ error: { code: "body_too_large", message: "请求体不能超过100MB" } }, 413) }));
  app.use("*", async (c, next) => { if (c.req.method === "POST") { limiter.check(c.get("user").id); limiter.hit(c.get("user").id); } await next(); });
  app.get("/models", async (c) => {
    const rows = await db.select({ model: models, price: pricingRules }).from(models).innerJoin(pricingRules, eq(models.id, pricingRules.modelId)).innerJoin(modelRoutes, eq(modelRoutes.modelId, models.id)).innerJoin(providers, eq(modelRoutes.providerId, providers.id)).where(and(eq(models.isActive, true), eq(providers.isActive, true))).orderBy(asc(models.sort));
    return c.json({ object: "list", data: [...new Map(rows.map(({ model, price }) => [model.id, { id: model.id, object: "model", owned_by: "platform", display_name: model.displayName, capability: model.capability, supports_edit: model.supportsEdit, max_reference_images: model.maxReferenceImages, price_hint: { unit: price.unit, config: price.config } }])).values()] });
  });
  for (const endpoint of ["images/generations", "images/edits"] as const) app.post(`/${endpoint}`, async (c) => {
    const context = await prepare(c, endpoint, "image");
    let secrets: string[] = [];
    try {
      const result = await forwardModel(context.model.id, context.endpoint, context.body, c.req.raw.signal, fetcher);
      secrets = result.secrets;
      const payload = record(await result.response.json());
      invariant(Array.isArray(payload.data) && payload.data.length > 0, 502, "invalid_upstream_response", "供应商未返回图片");
      const outputs = await Promise.all(payload.data.map(async (item) => {
        const image = record(item);
        let bytes: Uint8Array;
        let mimeType = "image/png";
        if (typeof image.b64_json === "string") bytes = Buffer.from(image.b64_json, "base64");
        else {
          invariant(typeof image.url === "string" && /^https?:\/\//.test(image.url), 502, "invalid_upstream_response", "供应商图片格式不正确");
          const response = await fetcher(image.url, { signal: result.signal, redirect: "error" });
          invariant(response.ok, 502, "image_download_failed", "无法读取供应商图片");
          bytes = new Uint8Array(await response.arrayBuffer());
          mimeType = response.headers.get("Content-Type")?.split(";")[0] ?? mimeType;
          // The browser receives bytes rather than a provider URL containing credentials or requiring provider auth.
          image.b64_json = Buffer.from(bytes).toString("base64");
        }
        delete image.url;
        invariant(bytes.length > 0, 502, "invalid_upstream_response", "供应商返回空图片");
        assertNoMediaSecret(bytes, secrets);
        return { kind: "image" as const, bytes, mimeType };
      }));
      result.signal.throwIfAborted();
      const settled = await settle(context.held.job.id, actual(context.rule, context.params, payload), { providerId: result.provider.id });
      invariant(settled.job.status === "succeeded", 409, "job_finished", "生成任务已结束，请重新生成");
      headersFor(c, settled);
      enqueueArchive(settled.job, outputs);
      return jsonResponse(c, redactPayload(payload, secrets));
    } catch (error) { return failJob(c, context.held.job.id, error, secrets); }
  });
  app.post("/responses", async (c) => {
    const context = await prepare(c, "responses", "text");
    let secrets: string[] = [];
    try {
      const result = await forwardModel(context.model.id, context.endpoint, context.body, c.req.raw.signal, fetcher);
      secrets = result.secrets;
      if (!context.params.stream) {
        const payload = record(redactPayload(await result.response.json(), secrets));
        checkResult(responseText(payload));
        result.signal.throwIfAborted();
        const settled = await settle(context.held.job.id, actual(context.rule, context.params, payload), { usage: record(payload.usage), providerId: result.provider.id });
        invariant(settled.job.status === "succeeded", 409, "job_finished", "生成任务已结束，请重新生成");
        headersFor(c, settled);
        enqueueArchive(settled.job, [{ kind: "text", mimeType: "text/plain", bytes: new TextEncoder().encode(JSON.stringify(payload.output ?? payload.output_text ?? "")) }]);
        return jsonResponse(c, payload);
      }
      invariant(result.response.body, 502, "invalid_upstream_response", "供应商没有返回文本流");
      const encoder = new TextEncoder();
      const stream = responseStream({
        response: result.response, signal: result.signal, secrets,
        async complete(usage, text) {
            result.signal.throwIfAborted();
            const settled = await settle(context.held.job.id, actual(context.rule, context.params, usage ? { usage } : undefined), { usage, providerId: result.provider.id });
            invariant(settled.job.status === "succeeded", 409, "job_finished", "生成任务已结束，请重新生成");
            enqueueArchive(settled.job, [{ kind: "text", mimeType: "text/plain", bytes: encoder.encode(text) }]);
        },
        async failed(cancelled) { await refund(context.held.job.id, { error: cancelled ? "请求已取消" : "文本流中断或生成失败" }); },
      });
      return c.newResponse(stream, 200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    } catch (error) { return failJob(c, context.held.job.id, error, secrets); }
  });
  app.post("/audio/speech", async (c) => {
    const context = await prepare(c, "audio/speech", "audio");
    let secrets: string[] = [];
    try {
      const result = await forwardModel(context.model.id, context.endpoint, context.body, c.req.raw.signal, fetcher);
      secrets = result.secrets;
      const bytes = new Uint8Array(await result.response.arrayBuffer());
      const mimeType = result.response.headers.get("Content-Type")?.split(";")[0] ?? "audio/mpeg";
      invariant(bytes.length && (mimeType.startsWith("audio/") || mimeType === "application/octet-stream"), 502, "invalid_upstream_response", "供应商未返回有效音频");
      assertNoMediaSecret(bytes, secrets);
      result.signal.throwIfAborted();
      const settled = await settle(context.held.job.id, actual(context.rule, context.params), { providerId: result.provider.id });
      invariant(settled.job.status === "succeeded", 409, "job_finished", "生成任务已结束，请重新生成");
      headersFor(c, settled);
      enqueueArchive(settled.job, [{ kind: "audio", bytes, mimeType }]);
      return c.body(bytes, 200, { "Content-Type": mimeType });
    } catch (error) { return failJob(c, context.held.job.id, error, secrets); }
  });
  app.post("/videos", async (c) => {
    const context = await prepare(c, "videos", "video");
    let secrets: string[] = [];
    try {
      const result = await forwardModel(context.model.id, context.endpoint, context.body, c.req.raw.signal, fetcher);
      secrets = result.secrets;
      const payload = record(redactPayload(await result.response.json(), secrets));
      invariant(typeof payload.id === "string" && payload.id, 502, "invalid_upstream_response", "供应商未返回视频任务编号");
      const taskId = id("vt");
      await db.transaction(async (tx) => {
        await lockWorkspace(tx, context.held.job.workspaceId);
        const [job] = await tx.select().from(generationJobs).where(eq(generationJobs.id, context.held.job.id)).for("update");
        invariant(job.status === "held", 409, "job_finished", "生成任务已结束，请重新生成");
        result.signal.throwIfAborted();
        await tx.insert(videoTasks).values({ id: taskId, jobId: context.held.job.id, providerId: result.provider.id, upstreamTaskId: payload.id as string });
        await tx.update(generationJobs).set({ providerId: result.provider.id }).where(eq(generationJobs.id, context.held.job.id));
      });
      return c.json({ id: taskId, status: "queued" });
    } catch (error) { return failJob(c, context.held.job.id, error, secrets); }
  });
  const poll = createVideoPoller(fetcher);
  const taskContext = async (c: Context<AppEnv>) => {
    const [row] = await db.select({ task: videoTasks, job: generationJobs, provider: providers }).from(videoTasks).innerJoin(generationJobs, eq(generationJobs.id, videoTasks.jobId)).innerJoin(providers, eq(providers.id, videoTasks.providerId)).where(eq(videoTasks.id, c.req.param("id") ?? ""));
    invariant(row && row.job.workspaceId === c.get("workspace").id && (c.get("membership").role !== "member" || row.job.userId === c.get("user").id), 404, "video_not_found", "视频任务不存在");
    return row;
  };
  app.get("/videos/:id", async (c) => {
    const row = await taskContext(c);
    const result = await poll(row.task.id, c.req.raw.signal);
    c.header("X-IC-Job-Id", row.job.id);
    c.header("X-IC-Credits-Charged", String(result.chargedCredits));
    c.header("X-IC-Credits-Balance", String((await balance(row.job.workspaceId)).balance));
    return c.json({ id: row.task.id, status: result.status, ...(result.status === "completed" ? { url: `/api/gateway/v1/videos/${row.task.id}/content` } : {}), ...(result.error ? { error: { message: result.error } } : {}) });
  });
  app.get("/videos/:id/content", async (c) => {
    const row = await taskContext(c);
    invariant(row.job.status === "succeeded", 409, "video_not_ready", "视频尚未完成");
    if (row.task.outputObjectKey) { assertWorkspaceObject(row.task.outputObjectKey, row.job.workspaceId); const output = await readObject(row.task.outputObjectKey); return c.body(new Uint8Array(output.bytes), 200, { "Content-Type": output.mimeType }); }
    const result = await fetchProvider(row.provider, `videos/${encodeURIComponent(row.task.upstreamTaskId)}/content`, { signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(600000)]) }, fetcher);
    if (!result.response.ok) throw await upstreamError(result.response, [result.key]);
    const mimeType = result.response.headers.get("Content-Type")?.split(";")[0] ?? "";
    invariant(result.response.body && (mimeType.startsWith("video/") || mimeType === "application/octet-stream"), 502, "invalid_upstream_media", "供应商未返回有效视频");
    return c.newResponse(guardMediaStream(result.response.body, [result.key]), 200, { "Content-Type": mimeType });
  });
  return app;
}

export function createVideoPoller(fetcher: UpstreamFetch = fetch) {
  return async (taskId: string, signal: AbortSignal = new AbortController().signal) => {
    const [row] = await db.select({ task: videoTasks, job: generationJobs, provider: providers }).from(videoTasks).innerJoin(generationJobs, eq(generationJobs.id, videoTasks.jobId)).innerJoin(providers, eq(providers.id, videoTasks.providerId)).where(eq(videoTasks.id, taskId));
    invariant(row, 404, "video_not_found", "视频任务不存在");
    if (row.job.status !== "held") return { status: row.job.status === "succeeded" ? "completed" : "failed", chargedCredits: row.job.chargedCredits, error: row.job.error };
    const result = await fetchProvider(row.provider, `videos/${encodeURIComponent(row.task.upstreamTaskId)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]) }, fetcher);
    if (!result.response.ok) throw await upstreamError(result.response, [result.key]);
    const payload = record(redactPayload(await result.response.json(), [result.key]));
    const status = String(payload.status ?? "queued");
    signal.throwIfAborted();
    if (status === "completed") await settle(row.job.id, row.job.estimateCredits, { providerId: row.provider.id });
    if (["failed", "cancelled", "canceled"].includes(status)) {
      const message = typeof record(payload.error).message === "string" ? String(record(payload.error).message) : "视频生成失败";
      await refund(row.job.id, { error: message, providerId: row.provider.id });
    }
    // The ledger is authoritative: late failed/queued responses must not overwrite a completed task.
    const current = await db.transaction(async (tx) => {
      await lockWorkspace(tx, row.job.workspaceId);
      const [job] = await tx.select().from(generationJobs).where(eq(generationJobs.id, row.job.id)).for("update");
      const [task] = await tx.select().from(videoTasks).where(eq(videoTasks.id, taskId)).for("update");
      const effectiveStatus = job.status === "succeeded" ? "completed" : job.status === "held" ? status : "failed";
      await tx.update(videoTasks).set({ status: effectiveStatus, lastPolledAt: new Date() }).where(eq(videoTasks.id, taskId));
      return { job, status: effectiveStatus, archive: effectiveStatus === "completed" && task.status !== "completed" };
    });
    if (current.archive) trackArchive(row.job.id, (async () => {
      const content = await fetchProvider(row.provider, `videos/${encodeURIComponent(row.task.upstreamTaskId)}/content`, { signal: AbortSignal.timeout(600000) }, fetcher);
      if (!content.response.ok) return;
      const mimeType = content.response.headers.get("Content-Type")?.split(";")[0] ?? "";
      invariant(mimeType.startsWith("video/") || mimeType === "application/octet-stream", 502, "invalid_upstream_media", "供应商未返回有效视频");
      const bytes = new Uint8Array(await content.response.arrayBuffer());
      assertNoMediaSecret(bytes, [content.key]);
      const keys = await enqueueArchive(current.job, [{ kind: "video", mimeType, bytes }]);
      await db.update(videoTasks).set({ outputObjectKey: keys[0] }).where(eq(videoTasks.id, taskId));
    })());
    return { status: current.status, chargedCredits: current.job.chargedCredits, error: current.job.error };
  };
}
