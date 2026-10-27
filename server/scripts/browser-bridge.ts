/** Browser acceptance transport only: stdin/stdout JSON lines, no HTTP listener. */
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { AsyncLocalStorage } from "node:async_hooks";
import { eq, inArray } from "drizzle-orm";
import { DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createBrowserControlledProvider, type BrowserRequestContext } from "./browser-controlled-provider";
import { createBrowserRealImageProvider } from "./browser-real-provider";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("浏览器验收必须显式设置 TEST_DATABASE_URL");
const database = new URL(testUrl);
if (database.pathname !== "/ic_test" || !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)) {
  throw new Error("浏览器验收桥仅允许本机 ic_test 测试数据库");
}
const origin = process.env.BROWSER_TEST_ORIGIN ?? "http://canvas.test";
const storageEnabled = process.env.BROWSER_TEST_STORAGE === "true";
const templatesEnabled = process.env.BROWSER_TEST_STAGE === "m4";
const realProviderEnabled = process.argv.includes("--real-ecom") && process.env.BROWSER_REAL_ECOM === "execute-paid-once";
let providerEncryptionSecret = realProviderEnabled ? process.env.APP_SECRET : undefined;
const realProviderOrigin = "https://laikankan8.top";
if (realProviderEnabled && (!templatesEnabled || !storageEnabled || !providerEncryptionSecret)) throw new Error("真实验收配置不完整");
if (templatesEnabled && !storageEnabled) throw new Error("模板浏览器验收必须启用独占存储");
const storageBucket = `ic-browser-${randomBytes(10).toString("hex")}`;
const fixtureModelId = `browser-image-${storageBucket}`;
const fixtureProviderId = `browser-provider-${storageBucket}`;
const fixtureModels = { image: fixtureModelId, ...(templatesEnabled ? { text: `browser-text-${storageBucket}`, video: `browser-video-${storageBucket}`, audio: `browser-audio-${storageBucket}` } : {}) };
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = testUrl;
process.env.APP_ORIGIN = origin;
process.env.APP_SECRET = randomBytes(32).toString("hex");
process.env.ALLOW_SIGNUP = "true";
process.env.SIGNUP_BONUS_CREDITS = process.env.BROWSER_TEST_SIGNUP_BONUS ?? (templatesEnabled ? "2000" : "200");
process.env.BILLING_ENABLED = process.env.BROWSER_TEST_BILLING ?? "true";
process.env.ADMIN_EMAILS = process.env.BROWSER_TEST_ADMIN_EMAIL ?? "";
process.env.TRUST_PROXY = "false";
process.env.S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? (storageEnabled ? process.env.S3_ENDPOINT : undefined) ?? "http://127.0.0.1:9000";
process.env.S3_PUBLIC_ENDPOINT = process.env.TEST_S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT;
process.env.S3_REGION = process.env.TEST_S3_REGION ?? process.env.S3_REGION ?? "us-east-1";
process.env.S3_BUCKET = storageBucket;
process.env.S3_ACCESS_KEY = process.env.TEST_S3_ACCESS_KEY ?? (storageEnabled ? process.env.S3_ACCESS_KEY : undefined) ?? "browser-test-only";
process.env.S3_SECRET_KEY = process.env.TEST_S3_SECRET_KEY ?? (storageEnabled ? process.env.S3_SECRET_KEY : undefined) ?? "browser-test-only";
process.env.S3_FORCE_PATH_STYLE = "true";
const storageOrigin = new URL(process.env.S3_PUBLIC_ENDPOINT).origin;
for (const endpoint of [process.env.S3_ENDPOINT, process.env.S3_PUBLIC_ENDPOINT]) {
  const parsed = new URL(endpoint);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== "/") {
    throw new Error("浏览器验收桥仅允许本机 S3 根地址");
  }
}

const { createApp } = await import("../src/app");
const { db, sqlClient } = await import("../src/db/client");
const { users, workspaces, redeemCodes, providers, models, modelRoutes, pricingRules, templates } = await import("../src/db/schema");
const { officialTemplateDefinitions } = await import("../src/templates/official");
const { validateTemplateBody } = await import("../src/templates/validation");
const { estimate } = await import("../src/gateway/pricing");
const fixtureTemplates: { id: string; sourceTemplateId: string; name: string; onlyModelIdsSubstituted: boolean }[] = [];
const { encryptSecret, decryptSecret } = await import("../src/lib/crypto");
let providerCiphertext = encryptSecret(`browser-test-${randomBytes(24).toString("hex")}`);
if (realProviderEnabled) {
  const ciphertext = (await Bun.file(new URL("../../.tools/provider-secret.enc", import.meta.url)).text()).trim();
  providerCiphertext = encryptSecret(decryptSecret(ciphertext, providerEncryptionSecret!));
  providerEncryptionSecret = undefined;
}
const { s3, ensureBucket } = await import("../src/lib/s3");
const { drainArchives } = await import("../src/gateway/archive");
const createdUsers = new Set<string>();
const requestContext = new AsyncLocalStorage<BrowserRequestContext>();
const controlled = templatesEnabled && !realProviderEnabled ? createBrowserControlledProvider(
  await Bun.file(process.env.BROWSER_TEST_IMAGES!).json() as string[],
  new Uint8Array(await Bun.file(process.env.BROWSER_TEST_VIDEO!).arrayBuffer()),
  new Uint8Array(await Bun.file(process.env.BROWSER_TEST_AUDIO!).arrayBuffer()),
  () => requestContext.getStore(),
) : undefined;
const realProvider = realProviderEnabled ? createBrowserRealImageProvider(realProviderOrigin, () => requestContext.getStore()) : undefined;
const controlledFetch: typeof fetch = Object.assign(async () => {
  // No real provider request can leave the acceptance process, even after an accidental UI click.
  throw new Error("浏览器验收禁止调用真实模型供应商");
}, { preconnect: fetch.preconnect });
const app = createApp({ fetch: realProvider?.fetch ?? controlled?.fetch ?? controlledFetch });
let input: ReturnType<typeof createInterface> | undefined;
let cleaned = false;
const controllers = new Map<number, AbortController>();
const pending = new Set<Promise<void>>();

async function cleanup() {
  if (cleaned) return;
  if (fixtureTemplates.length) await db.delete(templates).where(inArray(templates.id, fixtureTemplates.map((item) => item.id)));
  if (createdUsers.size) {
    const ids = [...createdUsers];
    await db.transaction(async (tx) => {
      // Only identities returned by successful registration in this bridge are eligible.
      await tx.delete(workspaces).where(inArray(workspaces.ownerId, ids));
      await tx.delete(redeemCodes).where(inArray(redeemCodes.createdBy, ids));
      await tx.delete(users).where(inArray(users.id, ids));
    });
  }
  if (storageEnabled) {
    await db.delete(models).where(inArray(models.id, Object.values(fixtureModels)));
    await db.delete(providers).where(eq(providers.id, fixtureProviderId));
    // This bucket name is generated by this process and never supplied by a caller.
    try {
      let continuation: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: storageBucket, ContinuationToken: continuation }));
        const objects = page.Contents?.flatMap((item) => item.Key ? [{ Key: item.Key }] : []) ?? [];
        if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: storageBucket, Delete: { Objects: objects, Quiet: true } }));
        continuation = page.NextContinuationToken;
      } while (continuation);
      await s3.send(new DeleteBucketCommand({ Bucket: storageBucket }));
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
    }
  }
  cleaned = true;
}

type Message = { id: number; operation?: "ping" | "close" | "storage" | "trace" | "control" | "cancel"; requestId?: number; control?: { failNodeIds?: string[]; holdNodeIds?: string[]; holdVideoPolls?: boolean; release?: boolean; providerUnavailable?: boolean }; url?: string; method?: string; headers?: Record<string, string>; bodyBase64?: string; multipart?: { key: string; value?: string; name?: string; mimeType?: string; base64?: string }[] };
let writeQueue = Promise.resolve();
async function write(value: unknown) {
  const line = `${JSON.stringify(value)}\n`;
  const current = writeQueue.then(async () => { await Bun.write(Bun.stdout, line); });
  writeQueue = current.catch(() => {});
  await current;
}
async function writeResponse(message: Message, response: Response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") headers.push([name, value]);
  });
  for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
  await write({ id: message.id, status: response.status, headers, bodyBase64: bytes.toString("base64") });
  return bytes;
}

async function handle(message: Message) {
  const controller = new AbortController();
  controllers.set(message.id, controller);
  try {
    const url = new URL(message.url ?? "/", origin);
    const method = message.method ?? "GET";
    if (message.operation === "storage") {
      if (!storageEnabled || url.origin !== storageOrigin || !url.pathname.startsWith(`/${storageBucket}/`) || !["PUT", "GET", "HEAD", "OPTIONS"].includes(method)) throw new Error("仅允许本次独占测试桶");
      const headers = new Headers(message.headers);
      if (headers.has("authorization") || headers.has("cookie")) throw new Error("存储桥不接受凭据请求头");
      headers.delete("host"); headers.delete("content-length");
      await writeResponse(message, await fetch(url, { method, headers, signal: controller.signal, body: ["GET", "HEAD", "OPTIONS"].includes(method) || !message.bodyBase64 ? undefined : Buffer.from(message.bodyBase64, "base64"), redirect: "error" }));
      return;
    }
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) throw new Error("仅允许同源业务 API");
    const headers = new Headers(message.headers);
    let requestBody: FormData | Uint8Array<ArrayBuffer> | undefined = ["GET", "HEAD"].includes(method) || !message.bodyBase64 ? undefined : new Uint8Array(Buffer.from(message.bodyBase64, "base64"));
    if (message.multipart) {
      if (!templatesEnabled || !headers.get("content-type")?.includes("multipart/form-data")) throw new Error("仅模板验收可重建浏览器multipart文件字段");
      const form = new FormData();
      for (const entry of message.multipart) {
        if (entry.base64 !== undefined) form.append(entry.key, new File([Buffer.from(entry.base64, "base64")], entry.name ?? "file", { type: entry.mimeType ?? "application/octet-stream" }));
        else form.append(entry.key, entry.value ?? "");
      }
      headers.delete("content-type"); headers.delete("content-length");
      requestBody = form;
    }
    await requestContext.run({ nodeId: headers.get("X-IC-Node") ?? undefined, projectId: headers.get("X-IC-Project") ?? undefined, workspaceId: headers.get("X-IC-Workspace") ?? undefined, source: headers.get("X-IC-Source") ?? undefined }, async () => {
      const response = await app.request(new Request(url, {
        method, headers, signal: controller.signal,
        body: requestBody,
      }));
      const bytes = await writeResponse(message, response);
      if (url.pathname === "/api/auth/register" && response.status === 201) {
        const payload = JSON.parse(bytes.toString("utf8")) as { user: { id: string } };
        createdUsers.add(payload.user.id);
      }
    });
  } catch (error) {
    await write({ id: message.id, bridgeError: error instanceof Error ? error.name : "UnknownError" });
  } finally { controllers.delete(message.id); }
}

try {
  if (storageEnabled) {
    await ensureBucket();
    await db.transaction(async (tx) => {
      await tx.insert(providers).values({ id: fixtureProviderId, name: realProviderEnabled ? "浏览器真实图片验收供应商" : "浏览器验收受控供应商", baseUrl: realProviderEnabled ? realProviderOrigin : "https://browser-no-network.invalid", apiKeyEncrypted: providerCiphertext });
      await tx.insert(models).values({ id: fixtureModelId, displayName: realProviderEnabled ? "gpt-image-2（真实验收）" : "浏览器验收图片模型", capability: "image", supportsEdit: true, maxReferenceImages: 8, sort: -2147483648 });
      await tx.insert(modelRoutes).values({ modelId: fixtureModelId, providerId: fixtureProviderId, upstreamModel: realProviderEnabled ? "gpt-image-2" : "browser-test-image" });
      await tx.insert(pricingRules).values({ modelId: fixtureModelId, unit: "per_image", config: { standard: 4, hd: 8 } });
      if (templatesEnabled) {
        await tx.insert(models).values([
          { id: fixtureModels.text!, displayName: "浏览器验收文本模型", capability: "text", sort: -2147483648 },
          { id: fixtureModels.video!, displayName: "浏览器验收视频模型", capability: "video", sort: -2147483648 },
          { id: fixtureModels.audio!, displayName: "浏览器验收语音模型", capability: "audio", sort: -2147483648 },
        ]);
        await tx.insert(modelRoutes).values([
          { modelId: fixtureModels.text!, providerId: fixtureProviderId, upstreamModel: "browser-test-text" },
          { modelId: fixtureModels.video!, providerId: fixtureProviderId, upstreamModel: "browser-test-video" },
          { modelId: fixtureModels.audio!, providerId: fixtureProviderId, upstreamModel: "browser-test-audio" },
        ]);
        await tx.insert(pricingRules).values([
          { modelId: fixtureModels.text!, unit: "per_1k_tokens", config: { input: 0.5, output: 2, hold: 10, min: 1 } },
          { modelId: fixtureModels.video!, unit: "per_second", config: { price: 12 } },
          { modelId: fixtureModels.audio!, unit: "per_1k_chars", config: { price: 2 } },
        ]);
        const substitutions: Record<string, string> = { "gpt-image-2": fixtureModels.image, "gpt-5.5": fixtureModels.text!, "sora-2": fixtureModels.video!, "gpt-4o-mini-tts": fixtureModels.audio! };
        const reverse = Object.fromEntries(Object.entries(substitutions).map(([source, target]) => [target, source]));
        const rules = new Map((await tx.select().from(pricingRules).where(inArray(pricingRules.modelId, Object.values(fixtureModels)))).map((rule) => [rule.modelId, rule]));
        for (const definition of officialTemplateDefinitions) {
          if (realProviderEnabled && definition.id !== "tpl_ecom_main_set") continue;
          const body = structuredClone(definition.body);
          for (const op of body.ops) if (op.type === "add_node" && typeof op.metadata?.model === "string") {
            const replacement = substitutions[op.metadata.model];
            if (!replacement) throw new Error("官方模板引用了未配置的受控模型");
            op.metadata.model = replacement;
          }
          const restored = structuredClone(body);
          for (const op of restored.ops) if (op.type === "add_node" && typeof op.metadata?.model === "string") op.metadata.model = reverse[op.metadata.model];
          if (JSON.stringify(restored) !== JSON.stringify(definition.body)) throw new Error("受控模板副本超出了模型ID替换范围");
          validateTemplateBody(body);
          const estimateCredits = body.steps.reduce((total, step) => total + step.nodeIds.reduce((sum, id) => {
            const op = body.ops.find((op) => op.type === "add_node" && op.id === id);
            const metadata = op?.type === "add_node" ? op.metadata ?? {} : {};
            const model = typeof metadata.model === "string" ? metadata.model : fixtureModels[step.mode];
            const rule = rules.get(model!);
            if (!rule) throw new Error("受控模型缺少定价");
            return sum + estimate(rule, { n: metadata.count ?? 1, size: metadata.size === "1:1" ? "1024x1024" : metadata.size, seconds: metadata.seconds, input: String(metadata.prompt ?? "") });
          }, 0), 0);
          const id = `${storageBucket}-${definition.id}`;
          await tx.insert(templates).values({ ...definition, id, workspaceId: null, body, estimateCredits });
          fixtureTemplates.push({ id, sourceTemplateId: definition.id, name: definition.name, onlyModelIdsSubstituted: true });
        }
      }
    });
  }
  // Attach readline only when ready; otherwise an early ping can be emitted before its iterator starts.
  input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    let message: Message | undefined;
    try {
      message = JSON.parse(line) as Message;
      if (message.operation === "ping") {
        await write({ id: message.id, ok: true, origin, database: "ic_test", transport: "stdio-app.request", controlledProvider: Boolean(controlled), realProvider: realProviderEnabled, ...(storageEnabled ? { storageOrigin, storageBucket, fixtureModelId, fixtureModels, fixtureTemplates } : {}) });
        continue;
      }
      if (message.operation === "close") {
        for (const controller of controllers.values()) controller.abort();
        await Promise.allSettled([...pending]);
        if (templatesEnabled) await drainArchives();
        await cleanup();
        await write({ id: message.id, ok: true, cleanedUsers: createdUsers.size, storageCleaned: storageEnabled });
        break;
      }
      if (message.operation === "cancel") {
        const controller = controllers.get(message.requestId ?? -1);
        controller?.abort();
        await write({ id: message.id, ok: true, cancelled: Boolean(controller) });
        continue;
      }
      if (message.operation === "trace" || message.operation === "control") {
        if (realProvider && message.operation === "trace") { await write({ id: message.id, ok: true, traces: realProvider.traces() }); continue; }
        if (!controlled) throw new Error("当前验收未启用受控供应商");
        if (message.control?.providerUnavailable !== undefined) await db.update(providers).set({ baseUrl: message.control.providerUnavailable ? "https://browser-unavailable.invalid" : "https://browser-no-network.invalid" }).where(eq(providers.id, fixtureProviderId));
        await write({ id: message.id, ok: true, ...(message.operation === "trace" ? { traces: controlled.traces() } : controlled.control(message.control ?? {})) });
        continue;
      }
      const task = handle(message);
      pending.add(task);
      void task.finally(() => pending.delete(task));
      if (!templatesEnabled) await task;
    } catch (error) {
      // Do not put request bodies, cookies, connection strings or provider errors in transport logs.
      await write({ id: message?.id ?? null, bridgeError: error instanceof Error ? error.name : "UnknownError" });
    }
  }
} finally {
  input?.close();
  for (const controller of controllers.values()) controller.abort();
  await Promise.allSettled([...pending]);
  if (templatesEnabled) await drainArchives();
  try { await cleanup(); } finally { await sqlClient.end(); }
}
