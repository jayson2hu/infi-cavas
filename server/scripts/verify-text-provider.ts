import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { createParser } from "eventsource-parser";
import { createApp } from "../src/app";
import { db, sqlClient } from "../src/db/client";
import { generationJobs, generationOutputs, modelRoutes, pricingRules, providers } from "../src/db/schema";
import { env } from "../src/env";
import { decryptSecret } from "../src/lib/crypto";
import { readObject } from "../src/lib/s3";
import { drainArchives } from "../src/gateway/archive";
import { actual, validatePricingRule } from "../src/gateway/pricing";

if (!process.argv.includes("--generate")) throw new Error("Usage: bun scripts/verify-text-provider.ts --generate");
const outputDir = resolve("../artifacts/acceptance");
await mkdir(outputDir, { recursive: true });
const report: Record<string, unknown> = { realProvider: true, model: "gpt-5.5", transport: "Hono app.request → real HTTPS responses SSE", startedAt: new Date().toISOString() };
let createdRoute = false;
try {
  const [provider] = await db.select().from(providers).where(eq(providers.id, "prv_local_acceptance"));
  if (!provider?.isActive) throw new Error("Configured acceptance provider is unavailable");
  createdRoute = (await db.insert(modelRoutes).values({ modelId: "gpt-5.5", providerId: provider.id, upstreamModel: "gpt-5.5", priority: 0 }).onConflictDoNothing().returning()).length > 0;
  const app = createApp();
  const credentials = JSON.parse(decryptSecret((await readFile(resolve("../.tools/acceptance-login.enc"), "utf8")).trim()));
  const login = await app.request("/api/auth/login", { method: "POST", headers: { Origin: env.APP_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(credentials) });
  if (!login.ok) throw new Error("Acceptance account login failed");
  const me = await login.json() as { currentWorkspaceId: string };
  const headers = { Cookie: login.headers.get("set-cookie")!.split(";")[0], Origin: env.APP_ORIGIN, "Content-Type": "application/json", "X-IC-Workspace": me.currentWorkspaceId, "X-IC-Source": "canvas", "X-IC-Project": "acceptance-real-text", "X-IC-Brand": "none" };
  const before = await (await app.request("/api/billing/summary", { headers })).json() as { balance: number };
  const started = Date.now();
  const response = await app.request("/api/gateway/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "这是软件连接验收。请只回复四个汉字：连接正常" }) });
  report.status = response.status;
  const raw = await response.text();
  if (raw.includes(decryptSecret(provider.apiKeyEncrypted))) throw new Error("Provider secret found in text response");
  if (!response.ok) {
    const payload = JSON.parse(raw) as { error?: { code?: string; message?: string } };
    const jobId = response.headers.get("X-IC-Job-Id");
    const [job] = jobId ? await db.select().from(generationJobs).where(eq(generationJobs.id, jobId)) : [];
    const after = await (await app.request("/api/billing/summary", { headers })).json() as { balance: number };
    Object.assign(report, { errorCode: payload.error?.code, errorMessage: payload.error?.message, jobId, jobStatus: job?.status, chargedCredits: job?.chargedCredits, balanceBefore: before.balance, balanceAfter: after.balance, refunded: before.balance === after.balance });
    throw new Error(`Real text generation HTTP ${response.status}`);
  }
  let text = "";
  let completed = false;
  let deltaCount = 0;
  const parser = createParser({ onEvent(event) {
    if (!event.data || event.data === "[DONE]") return;
    const value = JSON.parse(event.data) as { type?: string; delta?: string; response?: { status?: string } };
    if (value.type === "response.output_text.delta" && typeof value.delta === "string") { text += value.delta; deltaCount++; }
    if (value.type === "response.completed" && value.response?.status === "completed") completed = true;
  } });
  parser.feed(raw);
  if (!completed || !text.trim() || !deltaCount) throw new Error("Real text response lacks successful SSE terminal event or text deltas");
  const jobId = response.headers.get("X-IC-Job-Id")!;
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  const [price] = await db.select().from(pricingRules).where(eq(pricingRules.modelId, "gpt-5.5"));
  const expected = actual(validatePricingRule(price), {}, job.usage ? { usage: job.usage } : undefined);
  const after = await (await app.request("/api/billing/summary", { headers })).json() as { balance: number };
  if (job.status !== "succeeded" || job.chargedCredits !== expected || before.balance - after.balance !== expected) throw new Error("Real SSE usage settlement differs from pricing rule");
  await drainArchives();
  const [output] = await db.select().from(generationOutputs).where(eq(generationOutputs.jobId, jobId));
  if (!output?.objectKey || !(await readObject(output.objectKey)).bytes.length) throw new Error("Real text archive is unavailable");
  await writeFile(resolve(outputDir, "real-text.txt"), text);
  Object.assign(report, { success: true, jobId, generationSeconds: (Date.now() - started) / 1000, completed, deltaCount, usage: job.usage, expectedCredits: expected, chargedCredits: job.chargedCredits, balanceBefore: before.balance, balanceAfter: after.balance, archived: true });
} catch (error) {
  report.success = false;
  report.failure = error instanceof Error && !/sk-|Bearer/i.test(error.message) ? error.message : "Text verification failed";
  process.exitCode = 1;
} finally {
  if (createdRoute && report.success !== true) {
    await db.delete(modelRoutes).where(and(eq(modelRoutes.modelId, "gpt-5.5"), eq(modelRoutes.providerId, "prv_local_acceptance")));
    report.unusableAcceptanceRouteRemoved = true;
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(outputDir, "real-text.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await sqlClient.end();
}
