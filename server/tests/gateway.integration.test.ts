import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { balance, grant, refund } from "../src/billing/ledger";
import { db } from "../src/db/client";
import { apiTokens, creditTransactions, generationJobs, modelRoutes, models, pricingRules, providers, sessions, users, videoTasks, workspaceMembers, workspaces } from "../src/db/schema";
import { encryptSecret } from "../src/lib/crypto";
import { tokenHash } from "../src/lib/ids";
import { drainArchives } from "../src/gateway/archive";
import { createVideoPoller } from "../src/gateway/router";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
const prefix = `gateway_${randomUUID().replaceAll("-", "")}`;
const fixtures: Array<{ userId: string; workspaceId: string; modelId: string; providerId: string }> = [];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV6kAAAAASUVORK5CYII=";
const secret = `test-secret-${randomUUID()}`;
let sequence = 0;

afterAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  await drainArchives();
  for (const fixture of fixtures) {
    await db.delete(workspaces).where(eq(workspaces.id, fixture.workspaceId));
    await db.delete(users).where(eq(users.id, fixture.userId));
    await db.delete(models).where(eq(models.id, fixture.modelId));
    await db.delete(providers).where(eq(providers.id, fixture.providerId));
    await db.delete(providers).where(eq(providers.id, `${fixture.providerId}_fallback`));
  }
});

async function fixture(capability: "image" | "text" | "video" | "audio", fetcher: (url: string, init?: RequestInit) => Response | Promise<Response>, credits = 100) {
  const suffix = `${prefix}_${++sequence}`;
  const info = { userId: `usr_${suffix}`, workspaceId: `ws_${suffix}`, modelId: `model_${suffix}`, providerId: `prv_${suffix}` };
  const cookie = `ic_session=${suffix}`;
  fixtures.push(info);
  await db.insert(users).values({ id: info.userId, email: `${suffix}@example.test`, name: "网关验收", passwordHash: "not-a-login-password", lastWorkspaceId: info.workspaceId });
  await db.insert(workspaces).values({ id: info.workspaceId, ownerId: info.userId, name: "网关验收", kind: "personal" });
  await db.insert(workspaceMembers).values({ workspaceId: info.workspaceId, userId: info.userId, role: "owner" });
  await db.insert(sessions).values({ id: `ses_${suffix}`, userId: info.userId, tokenHash: tokenHash(suffix), expiresAt: new Date(Date.now() + 86400000) });
  await db.insert(providers).values({ id: info.providerId, name: "受控供应商", baseUrl: "https://upstream.example.test", apiKeyEncrypted: encryptSecret(secret) });
  await db.insert(models).values({ id: info.modelId, displayName: "验收模型", capability, supportsEdit: capability === "image" });
  await db.insert(modelRoutes).values({ modelId: info.modelId, providerId: info.providerId, upstreamModel: `upstream-${capability}` });
  const rule: import("../src/gateway/pricing").PricingRule = capability === "image" ? { unit: "per_image" as const, config: { standard: 4, hd: 8 } } : capability === "video" ? { unit: "per_second" as const, config: { price: 12 } } : capability === "audio" ? { unit: "per_1k_chars" as const, config: { price: 2 } } : { unit: "per_1k_tokens" as const, config: { input: 0.5, output: 2, hold: 10, min: 1 } };
  await db.insert(pricingRules).values({ modelId: info.modelId, ...rule });
  await grant({ workspaceId: info.workspaceId, userId: info.userId, kind: "purchase", amount: credits, source: "test" });
  let calls = 0;
  const app = createApp({ fetch: (async (url: string | URL | Request, init?: RequestInit) => { calls++; return fetcher(String(url), init); }) as typeof fetch });
  const request = (path: string, body?: Record<string, unknown> | FormData, extraHeaders: Record<string, string> = {}) => app.request(`/api/gateway/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: cookie, Origin: process.env.APP_ORIGIN!, "X-IC-Workspace": info.workspaceId, ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify({ model: info.modelId, ...body }),
  });
  return { ...info, app, request, calls: () => calls, cookie };
}

integration("图片按实际张数结算、透传模型与上下文、重复读取不扣点", async () => {
  const f = await fixture("image", (_url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${secret}`);
    expect(JSON.parse(String(init?.body)).model).toBe("upstream-image");
    return Response.json({ data: [{ b64_json: png }] });
  });
  const listing = await f.request("/models");
  expect((await listing.json()).data.find((model: { id: string }) => model.id === f.modelId).price_hint.config.standard).toBe(4);
  const response = await f.request("/images/generations", { prompt: "验收图", n: 2, size: "1024x1024" }, { "X-IC-Project": "project-test", "X-IC-Node": "node-test", "X-IC-Source": "plugin" });
  expect(response.status).toBe(200);
  expect(response.headers.get("X-IC-Credits-Charged")).toBe("4");
  expect(response.headers.get("X-IC-Credits-Balance")).toBe("96");
  const jobId = response.headers.get("X-IC-Job-Id")!;
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  expect(job).toMatchObject({ status: "succeeded", estimateCredits: 8, chargedCredits: 4, projectId: "project-test", nodeId: "node-test", source: "plugin" });
  expect(JSON.stringify(await response.json())).not.toContain(secret);
});

integration("余额不足不调用上游、不创建job；成员月上限生效", async () => {
  const f = await fixture("image", () => Response.json({ data: [{ b64_json: png }] }), 2);
  const response = await f.request("/images/generations", { prompt: "验收图", n: 1 });
  expect(response.status).toBe(402);
  expect((await response.json()).error).toMatchObject({ code: "insufficient_credits", required: 4, balance: 2 });
  expect(f.calls()).toBe(0);
  expect(await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, f.workspaceId))).toHaveLength(0);
  await grant({ workspaceId: f.workspaceId, kind: "purchase", amount: 20, source: "test" });
  await db.update(workspaceMembers).set({ role: "member", monthlyCap: 3 }).where(and(eq(workspaceMembers.workspaceId, f.workspaceId), eq(workspaceMembers.userId, f.userId)));
  const capped = await f.request("/images/generations", { prompt: "验收图", n: 1 });
  expect(capped.status).toBe(402);
  expect((await capped.json()).error.code).toBe("member_cap_exceeded");
  expect(f.calls()).toBe(0);
});

integration("上游500全额退款并脱敏；可在发送响应前切换供应商", async () => {
  const f = await fixture("image", (url) => url.includes("fallback") ? Response.json({ data: [{ b64_json: png }] }) : Response.json({ error: { message: `provider error ${secret}` } }, { status: 500 }));
  const failed = await f.request("/images/generations", { prompt: "验收故障", n: 1 });
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain(secret);
  expect((await balance(f.workspaceId)).balance).toBe(100);
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, f.workspaceId));
  expect(job.status).toBe("failed");
  expect(job.error).not.toContain(secret);
  await db.insert(providers).values({ id: `${f.providerId}_fallback`, name: "故障切换", baseUrl: "https://fallback.example.test/v1", apiKeyEncrypted: encryptSecret(secret) });
  await db.insert(modelRoutes).values({ modelId: f.modelId, providerId: `${f.providerId}_fallback`, upstreamModel: "upstream-image", priority: 1 });
  const success = await f.request("/images/generations", { prompt: "故障切换", n: 1 });
  expect(success.status).toBe(200);
  expect((await balance(f.workspaceId)).balance).toBe(96);
});

integration("multipart图片编辑保留文件并只按输出图片计费", async () => {
  const f = await fixture("image", (url, init) => {
    expect(url).toEndWith("/v1/images/edits");
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("upstream-image");
    expect(form.get("image") instanceof File).toBe(true);
    return Response.json({ data: [{ b64_json: png }] });
  });
  const form = new FormData();
  form.set("model", f.modelId); form.set("prompt", "编辑图片"); form.set("n", "1");
  form.set("image", new File([Buffer.from(png, "base64")], "reference.png", { type: "image/png" }));
  const response = await f.request("/images/edits", form);
  expect(response.status).toBe(200);
  expect((await balance(f.workspaceId)).balance).toBe(96);
});

integration("SSE在完成前输出，完成后按usage结算，跨chunk的Key不会泄漏", async () => {
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => { complete = resolve; });
  const encoder = new TextEncoder();
  const f = await fixture("text", () => new Response(new ReadableStream({ async start(controller) {
    controller.enqueue(encoder.encode(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "流式输出".repeat(30) })}\n\n`));
    await gate;
    const secretEvent = `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: secret })}\n\n`;
    const split = secretEvent.indexOf(secret) + 8;
    controller.enqueue(encoder.encode(secretEvent.slice(0, split)));
    controller.enqueue(encoder.encode(secretEvent.slice(split)));
    controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":100}}}\n\n'));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } }));
  const response = await f.request("/responses", { input: "测试文本", stream: true });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(first.value!.length).toBeGreaterThan(0);
  expect((await balance(f.workspaceId)).balance).toBe(90);
  complete();
  let output = new TextDecoder().decode(first.value);
  for (;;) { const part = await reader.read(); if (part.done) break; output += new TextDecoder().decode(part.value); }
  expect(output).toContain("response.completed");
  expect(output).not.toContain(secret);
  expect((await balance(f.workspaceId)).balance).toBe(99);
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, f.workspaceId));
  expect(job.usage).toMatchObject({ input_tokens: 100, output_tokens: 100 });
  expect(job.chargedCredits).toBe(1);
});

integration("文本流供应商错误全额退款", async () => {
  const f = await fixture("text", () => new Response('event: error\ndata: {"type":"error","error":{"message":"failure"}}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
  const response = await f.request("/responses", { input: "测试错误", stream: true });
  expect(await response.text()).toContain("点数已退还");
  expect((await balance(f.workspaceId)).balance).toBe(100);
});

integration("语音返回二进制并按字符计费", async () => {
  const f = await fixture("audio", () => new Response(new Uint8Array([73, 68, 51, 1, 2, 3]), { headers: { "Content-Type": "audio/mpeg" } }));
  const response = await f.request("/audio/speech", { input: "测试语音", voice: "alloy" });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
  expect((await response.arrayBuffer()).byteLength).toBe(6);
  expect((await balance(f.workspaceId)).balance).toBe(99);
});

integration("视频只返回网关id，重复完成轮询仅结算一次，失败任务退款", async () => {
  let videoStatus = "queued";
  const f = await fixture("video", (url, init) => {
    if (url.endsWith("/content")) return new Response(new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112]), { headers: { "Content-Type": "video/mp4" } });
    if (init?.method === "POST") return Response.json({ id: "upstream-private-task", status: "queued" });
    return Response.json({ id: "upstream-private-task", status: videoStatus, url: "https://provider.example/private" });
  });
  const created = await f.request("/videos", { prompt: "视频验收", seconds: 4 });
  const task = await created.json();
  expect(task.id).toStartWith("vt_");
  expect(JSON.stringify(task)).not.toContain("upstream-private");
  expect((await balance(f.workspaceId)).balance).toBe(52);
  videoStatus = "completed";
  const complete = await f.request(`/videos/${task.id}`);
  expect((await complete.json()).url).toBe(`/api/gateway/v1/videos/${task.id}/content`);
  await f.request(`/videos/${task.id}`);
  const [row] = await db.select().from(videoTasks).where(eq(videoTasks.id, task.id));
  expect(await db.select().from(creditTransactions).where(and(eq(creditTransactions.jobId, row.jobId), eq(creditTransactions.type, "settle")))).toHaveLength(1);
  expect((await balance(f.workspaceId)).balance).toBe(52);
  const again = await f.request("/videos", { prompt: "视频故障", seconds: 4 });
  videoStatus = "failed";
  const failedTask = await again.json();
  await f.request(`/videos/${failedTask.id}`);
  expect((await balance(f.workspaceId)).balance).toBe(52);
});

integration("API Token只访问所属工作区，撤销后失效", async () => {
  const f = await fixture("image", () => Response.json({ data: [{ b64_json: png }] }));
  const token = `ick_${randomUUID()}`;
  const tokenId = `tok_${randomUUID()}`;
  await db.insert(apiTokens).values({ id: tokenId, workspaceId: f.workspaceId, userId: f.userId, name: "测试", tokenHash: tokenHash(token), last4: token.slice(-4) });
  const allowed = await f.app.request("/api/gateway/v1/models", { headers: { Authorization: `Bearer ${token}` } });
  expect(allowed.status).toBe(200);
  const denied = await f.app.request("/api/gateway/v1/models", { headers: { Authorization: `Bearer ${token}`, "X-IC-Workspace": "ws_other" } });
  expect(denied.status).toBe(403);
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));
  expect((await f.app.request("/api/gateway/v1/models", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
});

integration("Unicode转义的供应商Key在错误、成功JSON及job中均脱敏", async () => {
  let fail = true;
  const encoded = [...secret].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const f = await fixture("image", () => new Response(fail ? `{"error":{"message":"failure ${encoded}"}}` : `{"data":[{"b64_json":"${png}","revised_prompt":"${encoded}"}]}`, { status: fail ? 500 : 200, headers: { "Content-Type": "application/json" } }));
  const failed = await f.request("/images/generations", { prompt: "测试脱敏", n: 1 });
  expect(failed.status).toBe(500);
  expect((await failed.json()).error.message).toBe("failure [REDACTED]");
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, f.workspaceId));
  expect(job.error).toBe("failure [REDACTED]");
  fail = false;
  const success = await f.request("/images/generations", { prompt: "测试脱敏", n: 1 });
  expect((await success.json()).data[0].revised_prompt).toBe("[REDACTED]");
});

integration("带凭据的供应商图片URL只用于下载，浏览器仅收到图片数据", async () => {
  let downloaded = false;
  const f = await fixture("image", (url) => {
    if (url.startsWith("https://media.example.test/")) { expect(url).toContain(secret); downloaded = true; return new Response(Buffer.from(png, "base64"), { headers: { "Content-Type": "image/png" } }); }
    return Response.json({ data: [{ url: `https://media.example.test/image.png?api_key=${secret}` }] });
  });
  const response = await f.request("/images/generations", { prompt: "下载图片", n: 1 });
  expect(response.status).toBe(200); expect(downloaded).toBe(true);
  const payload = await response.json(); expect(payload.data[0].url).toBeUndefined(); expect(payload.data[0].b64_json).toBe(png);
});

integration("伪装图片和非文件参考图在冻结点数及调用上游前拒绝", async () => {
  const f = await fixture("image", () => Response.json({ data: [{ b64_json: png }] }));
  for (const reference of [new File(["not-an-image"], "fake.png", { type: "image/png" }), new File([Buffer.from(png, "base64")], "fake.jpg", { type: "image/jpeg" }), "not-a-file"]) {
    const form = new FormData(); form.set("model", f.modelId); form.set("image", reference);
    const response = await f.request("/images/edits", form);
    expect(response.status).toBe(422);
  }
  expect(f.calls()).toBe(0);
  expect((await balance(f.workspaceId)).balance).toBe(100);
  expect(await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, f.workspaceId))).toHaveLength(0);
});

integration("SSE事件名失败及未完成EOF全额退款", async () => {
  for (const source of ['event: error\ndata: {"message":"failed"}\n\n', 'event: response.output_text.delta\ndata: {"delta":"部分输出"}\n\n']) {
    const f = await fixture("text", () => new Response(source, { headers: { "Content-Type": "text/event-stream" } }));
    const response = await f.request("/responses", { input: "退款测试", stream: true });
    expect(await response.text()).toContain("点数已退还");
    expect((await balance(f.workspaceId)).balance).toBe(100);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, f.workspaceId));
    expect(job.status).toBe("failed"); expect(job.chargedCredits).toBe(0);
  }
});

integration("视频完成后迟到的失败或排队轮询不覆盖终态；内容JSON不泄露Key", async () => {
  const f = await fixture("video", (_url, init) => init?.method === "POST" ? Response.json({ id: "private-video" }) : Response.json({ error: { message: secret } }));
  const created = await f.request("/videos", { prompt: "并发视频", seconds: 4 });
  const { id: taskId } = await created.json();
  const [task] = await db.select().from(videoTasks).where(eq(videoTasks.id, taskId));
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const entered = gates.map(() => Promise.withResolvers<void>());
  const states = ["completed", "failed", "queued"];
  let started = 0;
  const poll = createVideoPoller((async (url: string | URL | Request) => {
    if (String(url).endsWith("/content")) return new Response(null, { status: 404 });
    const index = started++;
    entered[index].resolve();
    await gates[index].promise;
    return Response.json({ status: states[index], error: { message: secret } });
  }) as typeof fetch);
  const requests: Array<ReturnType<typeof poll>> = [];
  for (let index = 0; index < gates.length; index++) { requests.push(poll(taskId)); await Promise.race([entered[index].promise, requests[index]]); }
  gates[0].resolve(); expect((await requests[0]).status).toBe("completed");
  gates[1].resolve(); expect((await requests[1]).status).toBe("completed");
  gates[2].resolve(); expect((await requests[2]).status).toBe("completed");
  const [current] = await db.select().from(videoTasks).where(eq(videoTasks.id, taskId));
  expect(current.status).toBe("completed");
  expect(await db.select().from(creditTransactions).where(and(eq(creditTransactions.jobId, task.jobId), eq(creditTransactions.type, "settle")))).toHaveLength(1);
  expect(await db.select().from(creditTransactions).where(and(eq(creditTransactions.jobId, task.jobId), eq(creditTransactions.type, "refund")))).toHaveLength(0);
  const content = await f.request(`/videos/${taskId}/content`);
  expect(content.status).toBe(502); expect(await content.text()).not.toContain(secret);
  const other = await fixture("video", () => { throw new Error("should not fetch"); });
  expect((await other.request(`/videos/${taskId}/content`)).status).toBe(404);
});

integration("取消流式输出或同步生成后不结算；已退款任务不返回成功结果", async () => {
  const streamed = await fixture("text", () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "生成进行中".repeat(30) })}\n\n`)); } }), { headers: { "Content-Type": "text/event-stream" } }));
  const response = await streamed.request("/responses", { input: "取消测试", stream: true });
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
  expect((await balance(streamed.workspaceId)).balance).toBe(100);
  const [streamJob] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, streamed.workspaceId));
  expect(streamJob.status).toBe("failed");

  const controller = new AbortController();
  const image = await fixture("image", () => { controller.abort(); return Response.json({ data: [{ b64_json: png }] }); });
  const cancelled = await image.app.request("/api/gateway/v1/images/generations", { method: "POST", signal: controller.signal, headers: { Cookie: image.cookie, Origin: process.env.APP_ORIGIN!, "Content-Type": "application/json", "X-IC-Workspace": image.workspaceId }, body: JSON.stringify({ model: image.modelId, prompt: "同步取消", n: 1 }) });
  expect(cancelled.ok).toBe(false); expect((await balance(image.workspaceId)).balance).toBe(100);

  const refunded = await fixture("image", async () => {
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, refunded.workspaceId));
    await refund(job.id, { status: "timeout", error: "模拟守护进程超时退款" });
    return Response.json({ data: [{ b64_json: png }] });
  });
  const late = await refunded.request("/images/generations", { prompt: "迟到结果", n: 1 });
  expect(late.status).toBe(409); expect((await balance(refunded.workspaceId)).balance).toBe(100);
});

integration("视频退款后的迟到完成轮询保持失败且不写结算", async () => {
  const f = await fixture("video", () => Response.json({ id: "private-video" }));
  const created = await f.request("/videos", { prompt: "反向竞争", seconds: 4 });
  expect(created.status).toBe(200);
  const { id: taskId } = await created.json();
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const entered = gates.map(() => Promise.withResolvers<void>()); let started = 0;
  const poll = createVideoPoller((async (_url: string | URL | Request) => {
    const index = started++; entered[index].resolve();
    await gates[index].promise;
    return Response.json({ status: index === 0 ? "failed" : "completed", error: { message: "受控失败" } });
  }) as typeof fetch);
  const requests: Array<ReturnType<typeof poll>> = [];
  for (let index = 0; index < gates.length; index++) { requests.push(poll(taskId)); await Promise.race([entered[index].promise, requests[index]]); }
  gates[0].resolve(); expect((await requests[0]).status).toBe("failed");
  gates[1].resolve(); expect((await requests[1]).status).toBe("failed");
  const [task] = await db.select().from(videoTasks).where(eq(videoTasks.id, taskId));
  expect(task.status).toBe("failed"); expect((await balance(f.workspaceId)).balance).toBe(100);
  expect(await db.select().from(creditTransactions).where(and(eq(creditTransactions.jobId, task.jobId), eq(creditTransactions.type, "refund")))).toHaveLength(1);
  expect(await db.select().from(creditTransactions).where(and(eq(creditTransactions.jobId, task.jobId), eq(creditTransactions.type, "settle")))).toHaveLength(0);
});
