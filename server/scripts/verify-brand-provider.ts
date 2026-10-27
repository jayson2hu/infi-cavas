import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { imageSize } from "image-size";
import { createApp } from "../src/app";
import { db, sqlClient } from "../src/db/client";
import { generationJobs, generationOutputs } from "../src/db/schema";
import { env } from "../src/env";
import { decryptSecret } from "../src/lib/crypto";
import { readObject } from "../src/lib/s3";
import { drainArchives } from "../src/gateway/archive";

// Deliberately separate from tests/startup: this command spends real provider credits.
if (!process.argv.includes("--generate")) throw new Error("Usage: bun scripts/verify-brand-provider.ts --generate");
const outputDir = resolve("../artifacts/acceptance");
await mkdir(outputDir, { recursive: true });
const report: Record<string, unknown> = { realProvider: true, transport: "Hono app.request → real HTTPS image edit", startedAt: new Date().toISOString() };
let upstreamPath = "";
let upstreamPrompt = "";
let upstreamReferences = 0;
let upstreamMilliseconds = 0;
let cookie = "";
let workspaceId = "";
let brandId = "";
let previousDefault: string | null = null;
const app = createApp({ fetch: (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
  if (init?.method === "POST" && /\/images\/(generations|edits)$/.test(path)) {
    upstreamPath = path;
  }
  if (init?.method === "POST" && init.body instanceof FormData) {
    upstreamPrompt = String(init.body.get("prompt") ?? "");
    upstreamReferences = [...init.body.entries()].filter(([key, value]) => ["image", "image[]"].includes(key) && typeof value !== "string").length;
  }
  // Image-only acceptance: include response transfer time in upstream latency.
  const started = performance.now();
  try {
    const response = await fetch(input, init);
    const bytes = await response.arrayBuffer();
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally { upstreamMilliseconds += performance.now() - started; }
}) as typeof fetch });

async function request(path: string, method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) {
  return app.request(`/api${path}`, { method, headers: { Cookie: cookie, Origin: env.APP_ORIGIN, "X-IC-Workspace": workspaceId, "Content-Type": "application/json", ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json<T>(response: Response, expected = 200): Promise<T> {
  if (response.status !== expected) throw new Error(`Acceptance API returned HTTP ${response.status}; expected ${expected}`);
  return response.json() as Promise<T>;
}

try {
  const credentials = JSON.parse(decryptSecret((await readFile(resolve("../.tools/acceptance-login.enc"), "utf8")).trim()));
  const login = await request("/auth/login", "POST", credentials);
  const me = await json<{ currentWorkspaceId: string; workspaces: Array<{ id: string; defaultBrandId: string | null }> }>(login);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  workspaceId = me.currentWorkspaceId;
  previousDefault = me.workspaces.find((workspace) => workspace.id === workspaceId)?.defaultBrandId ?? null;
  const brand = await json<{ id: string }>(await request("/brands", "POST", { name: "陶瓷产品验收品牌", industry: "家居", requiredTerms: ["柔和侧光", "简洁产品摄影"], avoidTerms: ["水印", "额外商标"], enforced: true, defaultParams: { model: "gpt-image-2" } }), 201);
  brandId = brand.id;
  await json(await request(`/brands/${brandId}/colors`, "PUT", [{ name: "背景", role: "background", hex: "#E6E2D9", sort: 0 }]));
  const image = await readFile(resolve(outputDir, "real-provider-image.png"));
  const upload = await json<{ uploadUrl: string; objectKey: string; headers: Record<string, string> }>(await request("/uploads/presign", "POST", { purpose: "brand_asset", mimeType: "image/png", bytes: image.length }));
  const put = await fetch(upload.uploadUrl, { method: "PUT", headers: upload.headers, body: image });
  if (!put.ok) throw new Error("Real S3 presigned upload failed");
  const asset = await json<{ id: string; url: string }>(await request(`/brands/${brandId}/assets`, "POST", { kind: "style_ref", title: "陶瓷产品摄影参考", objectKey: upload.objectKey, attachOnGenerate: true }), 201);
  await json(await request(`/workspaces/${workspaceId}`, "PATCH", { defaultBrandId: brandId }));
  const file = await request(asset.url.replace(/^\/api/, ""));
  if (file.status !== 302) throw new Error("Asset file permission redirect failed");
  const stored = await fetch(file.headers.get("Location")!);
  if (!stored.ok || !Buffer.from(await stored.arrayBuffer()).equals(image)) throw new Error("Frozen brand asset differs from uploaded image");
  const prompt = "参考所附照片的产品摄影风格，拍摄一只无商标的白色陶瓷杯，浅暖灰背景，保持杯子形状，画面无文字。";
  const preview = await json<{ text: string; attachedReferenceCount: number }>(await request(`/brands/${brandId}/injection-preview?${new URLSearchParams({ prompt, modelId: "gpt-image-2", originalReferenceCount: "0" })}`));
  if (preview.attachedReferenceCount !== 1) throw new Error("Brand preview did not include the enabled reference");
  const before = await json<{ balance: number }>(await request("/billing/summary"));
  const started = Date.now();
  const generated = await request("/gateway/v1/images/generations", "POST", { model: "gpt-image-2", prompt, n: 1, size: "1024x1024", quality: "low", output_format: "png" }, { "X-IC-Brand": "none", "X-IC-Source": "canvas", "X-IC-Project": "acceptance-real-brand" });
  report.generationStatus = generated.status;
  const totalMilliseconds = Date.now() - started;
  report.generationSeconds = totalMilliseconds / 1000;
  report.gatewayExtraMilliseconds = Math.round(totalMilliseconds - upstreamMilliseconds);
  report.gatewayLatencyMeasurement = "Single warm image-edit request; real upstream response transfer excluded. Not a load test.";
  const payload = await json<{ data: Array<{ b64_json: string }> }>(generated);
  if (upstreamPath !== "/v1/images/edits" || upstreamReferences !== 1 || upstreamPrompt !== preview.text) throw new Error("Actual brand injection differs from preview or did not rewrite generations to edits");
  const bytes = Buffer.from(payload.data[0].b64_json, "base64");
  const size = imageSize(bytes);
  const imageFile = `real-brand-image.${size.type === "jpg" ? "jpg" : size.type ?? "png"}`;
  await writeFile(resolve(outputDir, imageFile), bytes);
  await drainArchives();
  const jobId = generated.headers.get("X-IC-Job-Id")!;
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  const [output] = await db.select().from(generationOutputs).where(eq(generationOutputs.jobId, jobId));
  const after = await json<{ balance: number }>(await request("/billing/summary"));
  if (job.status !== "succeeded" || job.brandId !== brandId || job.chargedCredits !== 4 || before.balance - after.balance !== 4) throw new Error("Brand real generation ledger assertion failed");
  if (!output?.objectKey || !(await readObject(output.objectKey)).bytes.length) throw new Error("Brand real generation archive assertion failed");
  Object.assign(report, { success: true, jobId, workspaceId, brandId, upstreamPath, upstreamReferences, previewMatchesActual: true, enforcedIgnoresNone: true, immutableAssetVerified: true, chargedCredits: job.chargedCredits, balanceBefore: before.balance, balanceAfter: after.balance, archived: true, imageFile, requestedSize: "1024x1024", actualSize: `${size.width}x${size.height}` });
} catch (error) {
  report.success = false;
  report.failure = error instanceof Error && !/sk-|Bearer/i.test(error.message) ? error.message : "Brand verification failed";
  process.exitCode = 1;
} finally {
  if (brandId) {
    try {
      await json(await request(`/workspaces/${workspaceId}`, "PATCH", { defaultBrandId: previousDefault }));
      const removed = await request(`/brands/${brandId}`, "DELETE");
      if (removed.status !== 204) throw new Error("Brand cleanup failed");
      report.cleanup = true;
    } catch { report.cleanup = false; report.success = false; process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(outputDir, "real-brand.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await sqlClient.end();
}
