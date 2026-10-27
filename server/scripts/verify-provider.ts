import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db, sqlClient } from "../src/db/client";
import { seedDatabase } from "../src/db/seed";
import { generationJobs, generationOutputs, modelRoutes, providers, users } from "../src/db/schema";
import { env } from "../src/env";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";
import { readObject } from "../src/lib/s3";
import { drainArchives } from "../src/gateway/archive";

// Explicitly invoked acceptance command; never part of seed or application startup.
const encryptedKeyPath = process.argv[2];
const providerBaseUrl = process.argv[3];
if (!encryptedKeyPath || !providerBaseUrl) throw new Error("Usage: bun scripts/verify-provider.ts encrypted-key-file https://provider --generate");
const outputDir = resolve("../artifacts/acceptance");
await mkdir(outputDir, { recursive: true });
const report: Record<string, unknown> = { providerBaseUrl, model: "gpt-image-2", startedAt: new Date().toISOString(), realProvider: true, transport: "Hono app.request → authenticated real HTTPS upstream" };
try {
  const encrypted = (await readFile(resolve(encryptedKeyPath), "utf8")).trim();
  const key = decryptSecret(encrypted);
  const listed = await fetch(`${providerBaseUrl.replace(/\/$/, "")}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
  const listing = await listed.json() as { data?: Array<{ id: string }> };
  if (!listed.ok || !listing.data?.some((model) => model.id === "gpt-image-2")) throw new Error("Provider does not list requested image model");
  report.modelsConnected = true;
  await seedDatabase();
  const providerId = "prv_local_acceptance";
  await db.insert(providers).values({ id: providerId, name: "验收供应商", baseUrl: providerBaseUrl, apiKeyEncrypted: encrypted }).onConflictDoUpdate({ target: providers.id, set: { baseUrl: providerBaseUrl, apiKeyEncrypted: encrypted, isActive: true } });
  await db.insert(modelRoutes).values({ modelId: "gpt-image-2", providerId, upstreamModel: "gpt-image-2" }).onConflictDoUpdate({ target: [modelRoutes.modelId, modelRoutes.providerId], set: { upstreamModel: "gpt-image-2", priority: 0 } });
  if (process.argv.includes("--generate")) {
    const app = createApp();
    const login = { email: `acceptance-${Date.now()}@local.test`, password: randomBytes(24).toString("base64url"), name: "验收管理员" };
    const registered = await app.request("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json", Origin: env.APP_ORIGIN }, body: JSON.stringify(login) });
    if (registered.status !== 201) throw new Error("Acceptance registration failed");
    const me = await registered.json() as { user: { id: string }; currentWorkspaceId: string };
    await db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, me.user.id));
    // Credentials are local, encrypted with the same development secret and never printed.
    await writeFile(resolve("../.tools/acceptance-login.enc"), encryptSecret(JSON.stringify(login)));
    const headers = { Cookie: registered.headers.get("set-cookie")!.split(";")[0], Origin: env.APP_ORIGIN, "X-IC-Workspace": me.currentWorkspaceId, "X-IC-Source": "canvas", "X-IC-Project": "acceptance-real-provider", "Content-Type": "application/json" };
    const before = await (await app.request("/api/billing/summary", { headers })).json() as { balance: number };
    const start = Date.now();
    const response = await app.request("/api/gateway/v1/images/generations", { method: "POST", headers, body: JSON.stringify({ model: "gpt-image-2", prompt: "产品摄影验收图：一只没有商标的白色陶瓷杯，置于浅灰背景，柔和侧光，居中构图，无文字，无水印。", size: "1024x1024", quality: "low", n: 1, output_format: "png" }) });
    const raw = await response.text();
    if (raw.includes(key)) throw new Error("Secret redaction assertion failed");
    const payload = JSON.parse(raw) as { data?: Array<{ b64_json?: string }>; error?: { code?: string } };
    report.generationStatus = response.status;
    report.generationSeconds = (Date.now() - start) / 1000;
    if (!response.ok || !payload.data?.[0]?.b64_json) { report.errorCode = payload.error?.code; throw new Error("Real generation did not return an image"); }
    await writeFile(resolve(outputDir, "real-provider-image.png"), Buffer.from(payload.data[0].b64_json, "base64"));
    await drainArchives();
    const jobId = response.headers.get("X-IC-Job-Id")!;
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [output] = await db.select().from(generationOutputs).where(eq(generationOutputs.jobId, jobId));
    const after = await (await app.request("/api/billing/summary", { headers })).json() as { balance: number };
    if (job.status !== "succeeded" || job.chargedCredits !== 4 || before.balance - after.balance !== 4) throw new Error("Real generation billing assertion failed");
    if (!output?.objectKey || !(await readObject(output.objectKey)).bytes.length) throw new Error("Real generation S3 archive assertion failed");
    Object.assign(report, { jobId, workspaceId: me.currentWorkspaceId, chargedCredits: job.chargedCredits, balanceBefore: before.balance, balanceAfter: after.balance, archived: true, imageFile: "real-provider-image.png", success: true });
  }
} catch (error) {
  report.success = false;
  report.failure = error instanceof Error && !error.message.includes("sk-") ? error.message : "Verification failed";
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(outputDir, "real-provider.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await sqlClient.end();
}
