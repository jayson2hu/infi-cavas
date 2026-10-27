import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { balance, grant, lockWorkspace } from "../src/billing/ledger";
import { db, sqlClient } from "../src/db/client";
import { brandAssets, brands, generationJobs, generationOutputs, modelRoutes, models, pricingRules, providers, sessions, users, workspaceMembers, workspaces } from "../src/db/schema";
import { drainArchives } from "../src/gateway/archive";
import { encryptSecret } from "../src/lib/crypto";
import { tokenHash } from "../src/lib/ids";
import { objectCleanupPrefix, runObjectCleanup, stageObjectCleanup, sweepObjectCleanups } from "../src/lib/object-cleanup";
import { deleteObject, headObject, putObject, readObject } from "../src/lib/s3";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV6kAAAAASUVORK5CYII=", "base64");
type Actor = "owner" | "admin" | "editor" | "member" | "outsider";
const actors: Actor[] = ["owner", "admin", "editor", "member", "outsider"];
const fixtures: Array<{ workspaceId: string; otherWorkspaceId: string; userIds: string[]; modelIds: string[]; providerId: string }> = [];
const objectKeys = new Set<string>();

afterAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  await drainArchives();
  for (const f of fixtures) {
    const outputs = await db.select({ key: generationOutputs.objectKey }).from(generationOutputs).innerJoin(generationJobs, eq(generationOutputs.jobId, generationJobs.id)).where(eq(generationJobs.workspaceId, f.workspaceId));
    for (const output of outputs) if (output.key) objectKeys.add(output.key);
    await db.delete(workspaces).where(inArray(workspaces.id, [f.workspaceId, f.otherWorkspaceId]));
    await db.delete(users).where(inArray(users.id, f.userIds));
    await db.delete(models).where(inArray(models.id, f.modelIds));
    await db.delete(providers).where(eq(providers.id, f.providerId));
  }
  for (const key of objectKeys) await deleteObject(key);
});

async function fixture(fetcher: (url: string, init?: RequestInit) => Response | Promise<Response> = () => Response.json({ data: [{ b64_json: png.toString("base64") }] })) {
  const suffix = randomUUID().replaceAll("-", "");
  const workspaceId = `ws_brand_${suffix}`;
  const otherWorkspaceId = `ws_other_${suffix}`;
  const userIds = Object.fromEntries(actors.map((actor) => [actor, `usr_${actor}_${suffix}`])) as Record<Actor, string>;
  const cookies = Object.fromEntries(actors.map((actor) => [actor, `ic_session=${actor}_${suffix}`])) as Record<Actor, string>;
  const modelIds = { image: `image_${suffix}`, text: `text_${suffix}`, audio: `audio_${suffix}`, video: `video_${suffix}` };
  const providerId = `prv_${suffix}`;
  fixtures.push({ workspaceId, otherWorkspaceId, userIds: Object.values(userIds), modelIds: Object.values(modelIds), providerId });
  await db.insert(users).values(actors.map((actor) => ({ id: userIds[actor], email: `${actor}_${suffix}@example.test`, name: actor, passwordHash: "fixture-not-a-login", lastWorkspaceId: actor === "outsider" ? otherWorkspaceId : workspaceId })));
  await db.insert(workspaces).values([{ id: workspaceId, name: "品牌测试", kind: "team", ownerId: userIds.owner }, { id: otherWorkspaceId, name: "其他工作区", kind: "personal", ownerId: userIds.outsider }]);
  await db.insert(workspaceMembers).values(actors.map((actor) => ({ workspaceId: actor === "outsider" ? otherWorkspaceId : workspaceId, userId: userIds[actor], role: actor === "owner" || actor === "outsider" ? "owner" as const : actor === "admin" ? "admin" as const : "member" as const })));
  await db.insert(sessions).values(actors.map((actor) => ({ id: `ses_${actor}_${suffix}`, userId: userIds[actor], tokenHash: tokenHash(`${actor}_${suffix}`), expiresAt: new Date(Date.now() + 86400000) })));
  await db.insert(providers).values({ id: providerId, name: "受控品牌上游", baseUrl: "https://brand-upstream.example.test", apiKeyEncrypted: encryptSecret("test-only-brand-provider") });
  for (const capability of ["image", "text", "audio", "video"] as const) {
    await db.insert(models).values({ id: modelIds[capability], displayName: capability, capability, supportsEdit: capability === "image", maxReferenceImages: 2 });
    await db.insert(modelRoutes).values({ modelId: modelIds[capability], providerId, upstreamModel: `upstream-${capability}` });
    const rule: import("../src/gateway/pricing").PricingRule = capability === "image" ? { unit: "per_image", config: { standard: 4, hd: 8 } } : capability === "text" ? { unit: "per_1k_tokens", config: { input: 1, output: 2, hold: 10, min: 1 } } : capability === "audio" ? { unit: "per_1k_chars", config: { price: 2 } } : { unit: "per_second", config: { price: 12 } };
    await db.insert(pricingRules).values({ modelId: modelIds[capability], ...rule });
  }
  await grant({ workspaceId, userId: userIds.owner, kind: "purchase", amount: 100, source: "test:brand" });
  let calls = 0;
  const app = createApp({ fetch: (async (url: string | URL | Request, init?: RequestInit) => { calls++; return fetcher(String(url), init); }) as typeof fetch });
  const request = (path: string, method = "GET", body?: unknown, actor: Actor = "owner", headers: Record<string, string> = {}) => app.request(`/api${path}`, { method, headers: { Cookie: cookies[actor], Origin: process.env.APP_ORIGIN!, "X-IC-Workspace": actor === "outsider" ? otherWorkspaceId : workspaceId, ...(body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const createBrand = async (input: Record<string, unknown> = {}) => {
    const response = await request("/brands", "POST", { name: "松风", requiredTerms: ["自然光"], avoidTerms: ["水印"], defaultParams: { model: modelIds.image }, editorUserIds: [userIds.editor], ...input });
    expect(response.status).toBe(201); return response.json() as Promise<{ id: string; canEdit: boolean }>;
  };
  const upload = async (actor: Actor = "owner", purpose = "brand_asset", bytes: Uint8Array = png, mimeType = "image/png") => {
    const response = await request("/uploads/presign", "POST", { purpose, mimeType, bytes: bytes.length }, actor);
    expect(response.status).toBe(200);
    const result = await response.json() as { uploadUrl: string; objectKey: string; headers: Record<string, string> };
    objectKeys.add(result.objectKey);
    expect((await fetch(result.uploadUrl, { method: "PUT", headers: result.headers, body: new Uint8Array(bytes) })).status).toBe(200);
    return result;
  };
  const addAsset = async (brandId: string, kind: "logo" | "sku" | "style_ref" = "style_ref", actor: Actor = "owner") => {
    const uploaded = await upload(actor);
    const response = await request(`/brands/${brandId}/assets`, "POST", { kind, title: "验收素材", objectKey: uploaded.objectKey, attachOnGenerate: kind === "style_ref" }, actor);
    expect(response.status).toBe(201);
    const asset = await response.json() as { id: string; url: string; width: number; height: number };
    objectKeys.add(decodeURIComponent(asset.url.slice("/api/files/".length)));
    return { ...asset, uploaded };
  };
  return { app, request, createBrand, upload, addAsset, workspaceId, otherWorkspaceId, userIds, cookies, modelIds, calls: () => calls };
}

integration("品牌权限区分创建、内容编辑和管理员配置，跨工作区不能读写", async () => {
  const f = await fixture(); const brand = await f.createBrand();
  expect((await f.request("/brands", "POST", { name: "越权创建" }, "member")).status).toBe(403);
  expect((await (await f.request(`/brands/${brand.id}`, "GET", undefined, "member")).json()).canEdit).toBe(false);
  expect((await (await f.request(`/brands/${brand.id}`, "GET", undefined, "editor")).json()).canEdit).toBe(true);
  expect((await f.request(`/brands/${brand.id}`, "PATCH", { name: "越权编辑" }, "member")).status).toBe(403);
  expect((await f.request(`/brands/${brand.id}`, "PATCH", { requiredTerms: ["编辑者更新"] }, "editor")).status).toBe(200);
  for (const body of [{ enforced: true }, { editorUserIds: [f.userIds.member] }]) expect((await f.request(`/brands/${brand.id}`, "PATCH", body, "editor")).status).toBe(403);
  expect((await f.request(`/brands/${brand.id}`, "GET", undefined, "outsider")).status).toBe(404);
  expect((await f.request(`/brands/${brand.id}`, "PATCH", { name: "其他工作区" }, "outsider")).status).toBe(404);
  expect((await f.request(`/brands/${brand.id}`, "PATCH", { editorUserIds: [f.userIds.outsider] })).status).toBe(422);
  expect((await f.request(`/brands/${brand.id}`, "PATCH", { defaultParams: { apiKey: "should-not-store" } })).status).toBe(422);
  expect((await f.request(`/workspaces/${f.workspaceId}`, "PATCH", { defaultBrandId: brand.id })).status).toBe(200);
  expect((await f.request(`/brands/${brand.id}`, "DELETE", undefined, "editor")).status).toBe(403);
  await f.request(`/workspaces/${f.workspaceId}`, "PATCH", { defaultBrandId: null });
  await f.request(`/brands/${brand.id}`, "PATCH", { enforced: true });
  expect((await f.request(`/brands/${brand.id}`, "DELETE", undefined, "editor")).status).toBe(403);
  expect((await f.request(`/brands/${brand.id}`, "DELETE", undefined, "admin")).status).toBe(204);
});

integration("真实S3上传验证并固化图片，重放临时PUT不能改掉已保存素材", async () => {
  const f = await fixture(); const brand = await f.createBrand(); const asset = await f.addAsset(brand.id, "sku");
  expect(asset.width).toBe(1); expect(asset.height).toBe(1);
  const finalKey = decodeURIComponent(asset.url.slice("/api/files/".length));
  const signedHeaders = new URL(asset.uploaded.uploadUrl).searchParams.get("X-Amz-SignedHeaders")!;
  for (const header of ["content-type", "content-length", "x-amz-meta-workspace", "x-amz-meta-user", "x-amz-meta-purpose", "x-amz-meta-bytes", "x-amz-meta-mime"]) expect(signedHeaders.split(";")).toContain(header);
  expect(new URL(asset.uploaded.uploadUrl).searchParams.has("x-amz-checksum-crc32")).toBe(false);
  expect(new URL(asset.uploaded.uploadUrl).searchParams.has("x-amz-sdk-checksum-algorithm")).toBe(false);
  expect(finalKey).not.toBe(asset.uploaded.objectKey);
  expect(Buffer.from((await readObject(finalKey)).bytes).equals(png)).toBe(true);
  const replacement = Buffer.alloc(png.length, 65);
  expect((await fetch(asset.uploaded.uploadUrl, { method: "PUT", headers: asset.uploaded.headers, body: replacement })).status).toBe(200);
  expect(Buffer.from((await readObject(finalKey)).bytes).equals(png)).toBe(true);
  const replay = await f.request(`/brands/${brand.id}/assets`, "POST", { kind: "sku", title: "伪装图片", objectKey: asset.uploaded.objectKey });
  expect(replay.status).toBe(422);
  expect((await (await f.request("/brands")).json())[0].skuCount).toBe(1);
  expect((await f.request(`/brands/${brand.id}/assets/${asset.id}`, "DELETE")).status).toBe(204);
  await expect(headObject(finalKey)).rejects.toThrow();
});

integration("上传用途、上传用户、真实MIME与20MB边界均在关联前验证", async () => {
  const f = await fixture(); const brand = await f.createBrand();
  for (const body of [{ purpose: "brand_asset", mimeType: "image/svg+xml", bytes: 20 }, { purpose: "brand_asset", mimeType: "image/png", bytes: 20971521 }, { purpose: "brand_asset", mimeType: "image/png", bytes: 0 }]) expect((await f.request("/uploads/presign", "POST", body)).status).toBe(422);
  expect((await f.request("/uploads/presign", "POST", { purpose: "brand_asset", mimeType: "image/png", bytes: 20971520 })).status).toBe(200);
  for (const upload of [await f.upload("owner", "template_image"), await f.upload("member"), await f.upload("outsider")]) {
    expect((await f.request(`/brands/${brand.id}/assets`, "POST", { kind: "sku", title: "错误关联", objectKey: upload.objectKey })).status).toBe(403);
  }
  const wrongMime = await f.upload("owner", "brand_asset", png, "image/jpeg");
  expect((await f.request(`/brands/${brand.id}/assets`, "POST", { kind: "sku", title: "MIME伪装", objectKey: wrongMime.objectKey })).status).toBe(422);
  const forgedKey = `ws/${f.workspaceId}/uploads/brand_asset/forged.png`; objectKeys.add(forgedKey);
  await putObject(forgedKey, png, "image/png");
  expect((await f.request(`/brands/${brand.id}/assets`, "POST", { kind: "sku", title: "无签名信息", objectKey: forgedKey })).status).toBe(403);
  expect(await db.select().from(brandAssets).where(eq(brandAssets.brandId, brand.id))).toHaveLength(0);
});

integration("文件图片地址按路径工作区验证成员权，跨工作区和内部任务拒绝", async () => {
  const f = await fixture(); const brand = await f.createBrand(); const asset = await f.addAsset(brand.id);
  await db.update(users).set({ lastWorkspaceId: f.otherWorkspaceId }).where(eq(users.id, f.userIds.editor));
  const response = await f.app.request(asset.url, { headers: { Cookie: f.cookies.editor } });
  expect(response.status).toBe(302);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  const stored = await fetch(response.headers.get("Location")!); expect(stored.status).toBe(200);
  expect(Buffer.from(await stored.arrayBuffer()).equals(png)).toBe(true);
  expect((await f.app.request(asset.url, { headers: { Cookie: f.cookies.outsider } })).status).toBe(403);
  expect((await f.app.request(asset.url, { headers: { Cookie: f.cookies.editor, "X-IC-Workspace": f.otherWorkspaceId } })).status).toBe(403);
  expect((await f.app.request("/api/files/internal/cleanup/anything.json", { headers: { Cookie: f.cookies.owner } })).status).toBe(403);
});

integration("品牌参考改写generations为edits，默认参数先估价且预览等于实际提示词", async () => {
  let captured: FormData | undefined; let endpoint = "";
  const f = await fixture((url, init) => { endpoint = url; captured = init?.body as FormData; return Response.json({ data: [{ b64_json: png.toString("base64") }, { b64_json: png.toString("base64") }] }); });
  const brand = await f.createBrand({ enforced: true, defaultParams: { model: f.modelIds.image, n: 2, size: "1024x1024", quality: "high" } });
  await f.addAsset(brand.id); await f.addAsset(brand.id);
  expect((await f.request(`/brands/${brand.id}/colors`, "PUT", [{ name: "主色", role: "primary", hex: "#1F3B2D" }])).status).toBe(200);
  await f.request(`/workspaces/${f.workspaceId}`, "PATCH", { defaultBrandId: brand.id });
  const preview = await (await f.request(`/brands/${brand.id}/injection-preview?${new URLSearchParams({ prompt: "产品摄影", modelId: f.modelIds.image })}`)).json();
  const response = await f.request("/gateway/v1/images/generations", "POST", { prompt: "产品摄影" }, "member", { "X-IC-Brand": "none", "X-IC-Project": "brand-project" });
  expect(response.status).toBe(200); expect(endpoint).toEndWith("/v1/images/edits");
  expect(captured!.get("prompt")).toBe(preview.text); expect(captured!.getAll("image[]")).toHaveLength(2);
  expect(captured!.get("n")).toBe("2"); expect(captured!.get("quality")).toBe("high");
  expect(response.headers.get("X-IC-Credits-Charged")).toBe("8"); expect((await balance(f.workspaceId)).balance).toBe(92);
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, f.workspaceId));
  expect(job).toMatchObject({ brandId: brand.id, endpoint: "images/edits", estimateCredits: 8, chargedCredits: 8 });
  expect((await (await f.request("/brands")).json())[0].usedInProjects).toBe(1);
});

integration("用户参考图优先且品牌仅补剩余位置，none和非编辑模型不强加参考图", async () => {
  let captured: RequestInit | undefined; let url = "";
  const f = await fixture((path, init) => { url = path; captured = init; return Response.json({ data: [{ b64_json: png.toString("base64") }] }); });
  const brand = await f.createBrand(); await f.addAsset(brand.id); await f.addAsset(brand.id);
  await f.request(`/workspaces/${f.workspaceId}`, "PATCH", { defaultBrandId: brand.id });
  const form = new FormData(); form.set("model", f.modelIds.image); form.set("prompt", "用户编辑"); form.set("n", "1"); form.append("image", new File([png], "user.png", { type: "image/png" }));
  const response = await f.request("/gateway/v1/images/edits", "POST", form);
  expect(response.status).toBe(200);
  const sent = captured!.body as FormData; const images = sent.getAll("image[]") as File[];
  expect(images).toHaveLength(2); expect(images[0].name).toBe("user.png"); expect(images[1].name).toStartWith("brand-");
  const preview = await (await f.request(`/brands/${brand.id}/injection-preview?${new URLSearchParams({ prompt: "用户编辑", modelId: f.modelIds.image, originalReferenceCount: "1" })}`)).json();
  expect(sent.get("prompt")).toBe(preview.text); expect(preview.attachedReferenceCount).toBe(1);
  expect((await f.request("/gateway/v1/images/generations", "POST", { model: f.modelIds.image, prompt: "独立生成", n: 1 }, "owner", { "X-IC-Brand": "none" })).status).toBe(200);
  expect(url).toEndWith("/v1/images/generations"); expect(JSON.parse(String(captured!.body)).prompt).toBe("独立生成");
  await db.update(models).set({ supportsEdit: false }).where(eq(models.id, f.modelIds.image));
  expect((await f.request("/gateway/v1/images/generations", "POST", { model: f.modelIds.image, prompt: "纯文字", n: 1 })).status).toBe(200);
  expect(url).toEndWith("/v1/images/generations"); expect(JSON.parse(String(captured!.body)).prompt).toContain("[品牌]");
  expect(JSON.parse(String(captured!.body)).prompt).not.toContain("[参考图]");
});

integration("无效或跨工作区显式品牌、缺失参考对象均不冻结点数或创建任务", async () => {
  const f = await fixture(); const brand = await f.createBrand(); const asset = await f.addAsset(brand.id);
  const [row] = await db.select().from(brandAssets).where(eq(brandAssets.id, asset.id)); await deleteObject(row.objectKey);
  const failed = await f.request("/gateway/v1/images/generations", "POST", { model: f.modelIds.image, prompt: "无法加载", n: 1 }, "owner", { "X-IC-Brand": brand.id });
  expect(failed.ok).toBe(false);
  const outsider = await f.request("/gateway/v1/images/generations", "POST", { model: f.modelIds.image, prompt: "越权", n: 1 }, "outsider", { "X-IC-Brand": brand.id });
  expect(outsider.status).toBe(404);
  expect((await f.request("/gateway/v1/images/generations", "POST", { model: f.modelIds.image, prompt: "无效品牌", n: 1 }, "owner", { "X-IC-Brand": "brd_missing" })).status).toBe(404);
  expect(f.calls()).toBe(0); expect((await balance(f.workspaceId)).balance).toBe(100);
  expect(await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, f.workspaceId))).toHaveLength(0);
});

integration("文本和语音只加instructions，原输入不被替换且语音按原文计费", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const f = await fixture((url, init) => { requests.push(JSON.parse(String(init?.body))); return url.endsWith("/audio/speech") ? new Response(new Uint8Array([73, 68, 51, 1]), { headers: { "Content-Type": "audio/mpeg" } }) : Response.json({ output_text: "受控回复", usage: { input_tokens: 1, output_tokens: 1 } }); });
  const brand = await f.createBrand(); await f.addAsset(brand.id); await f.request(`/workspaces/${f.workspaceId}`, "PATCH", { defaultBrandId: brand.id });
  expect((await f.request("/gateway/v1/responses", "POST", { model: f.modelIds.text, input: [{ role: "user", content: "原始问题" }], instructions: "原系统指令" })).status).toBe(200);
  expect(requests[0].input).toEqual([{ role: "user", content: "原始问题" }]); expect(requests[0].instructions).toContain("[品牌] 松风"); expect(requests[0].instructions).toEndWith("原系统指令"); expect(requests[0].instructions).not.toContain("[参考图]");
  const audio = await f.request("/gateway/v1/audio/speech", "POST", { model: f.modelIds.audio, input: "只朗读这句话", voice: "alloy" });
  expect(audio.status).toBe(200); expect(audio.headers.get("X-IC-Credits-Charged")).toBe("1");
  expect(requests[1].input).toBe("只朗读这句话"); expect(requests[1].instructions).toContain("[品牌] 松风"); expect(requests[1].instructions).not.toContain("只朗读这句话");
});

integration("删除事务回滚保留图片，提交后S3故障能由下一扫描恢复且幂等", async () => {
  const f = await fixture(); const brand = await f.createBrand(); const asset = await f.addAsset(brand.id);
  const [row] = await db.select().from(brandAssets).where(eq(brandAssets.id, asset.id));
  let taskKey: string | null = null;
  await expect(db.transaction(async (tx) => { await lockWorkspace(tx, f.workspaceId); taskKey = await stageObjectCleanup({ workspaceId: f.workspaceId, brandId: brand.id, assetId: asset.id, objectKeys: [row.objectKey] }); await tx.delete(brandAssets).where(eq(brandAssets.id, asset.id)); throw new Error("受控DB回滚"); })).rejects.toThrow("受控DB回滚");
  objectKeys.add(taskKey!); expect(await runObjectCleanup(taskKey!)).toBe("cancelled"); expect((await readObject(row.objectKey)).bytes.length).toBe(png.length);
  await db.transaction(async (tx) => { await lockWorkspace(tx, f.workspaceId); taskKey = await stageObjectCleanup({ workspaceId: f.workspaceId, brandId: brand.id, assetId: asset.id, objectKeys: [row.objectKey] }); await tx.delete(brandAssets).where(eq(brandAssets.id, asset.id)); });
  objectKeys.add(taskKey!);
  await expect(runObjectCleanup(taskKey!, async () => { throw new Error("受控S3故障"); })).rejects.toThrow("受控S3故障");
  expect((await readObject(row.objectKey)).bytes.length).toBe(png.length); expect((await readObject(taskKey!)).bytes.length).toBeGreaterThan(0);
  expect((await sweepObjectCleanups()).completed).toBeGreaterThanOrEqual(1);
  await expect(headObject(row.objectKey)).rejects.toThrow(); await expect(headObject(taskKey!)).rejects.toThrow();
  expect(await runObjectCleanup(taskKey!)).toBe("missing"); expect((await sweepObjectCleanups()).errors).toBe(0);
  const uncommittedKey = `ws/${f.workspaceId}/brands/${brand.id}/ba_rolled_back.png`; objectKeys.add(uncommittedKey);
  await expect(db.transaction(async (tx) => { await lockWorkspace(tx, f.workspaceId); taskKey = await stageObjectCleanup({ workspaceId: f.workspaceId, brandId: brand.id, assetId: "ba_rolled_back", objectKeys: [uncommittedKey] }); await putObject(uncommittedKey, png, "image/png"); throw new Error("受控创建回滚"); })).rejects.toThrow("受控创建回滚");
  objectKeys.add(taskKey!); expect(await runObjectCleanup(taskKey!)).toBe("completed"); await expect(headObject(uncommittedKey)).rejects.toThrow();
});

integration("编辑者在等待工作区锁时被撤权，旧权限不能继续修改品牌", async () => {
  const f = await fixture(); const brand = await f.createBrand(); let pending!: Promise<Response>;
  await sqlClient.begin(async (tx) => {
    const [connection] = await tx`SELECT pg_backend_pid() AS pid`;
    await tx`SELECT id FROM workspaces WHERE id = ${f.workspaceId} FOR UPDATE`;
    await tx`UPDATE brands SET editor_user_ids = '{}' WHERE id = ${brand.id}`;
    pending = Promise.resolve(f.request(`/brands/${brand.id}`, "PATCH", { name: "越权更新" }, "editor"));
    let response: Response | undefined; void pending.then((value) => { response = value; });
    const deadline = Date.now() + 5000; let blocked = false;
    while (Date.now() < deadline) { if (response) throw new Error(`Request bypassed lock: ${response.status}`); const waiting = await sqlClient`SELECT pid FROM pg_stat_activity WHERE ${connection.pid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`; if (waiting.length) { blocked = true; break; } }
    expect(blocked).toBe(true);
  });
  expect((await pending).status).toBe(403);
  expect((await (await f.request(`/brands/${brand.id}`)).json()).name).toBe("松风");
});

integration("品牌颜色整体替换、资产更新与默认品牌删除清理均生效", async () => {
  const f = await fixture(); const brand = await f.createBrand();
  const logo = await f.addAsset(brand.id, "logo"); const sku = await f.addAsset(brand.id, "sku");
  const summary = (await (await f.request("/brands")).json())[0]; expect(summary.logoUrl).toBe(logo.url); expect(summary.skuCount).toBe(1); expect(summary.updatedByName).toBeUndefined();
  expect((await f.request(`/brands/${brand.id}/colors`, "PUT", [{ name: "主色", role: "primary", hex: "#123456" }], "editor")).status).toBe(200);
  expect((await f.request(`/brands/${brand.id}/colors`, "PUT", Array.from({ length: 13 }, () => ({ name: "超限", role: "accent", hex: "#123456" })))).status).toBe(422);
  expect((await f.request(`/brands/${brand.id}/colors`, "PUT", [{ name: "无效", role: "primary", hex: "#xyz" }])).status).toBe(422);
  expect((await f.request(`/brands/${brand.id}/colors`, "PUT", [], "editor")).status).toBe(200);
  expect((await (await f.request(`/brands/${brand.id}`)).json()).colors).toEqual([]);
  expect((await f.request(`/brands/${brand.id}/assets/${sku.id}`, "PATCH", { title: "更新SKU", spec: "500ml", tags: ["新品"], sort: 2 }, "editor")).status).toBe(200);
  expect((await f.request(`/brands/${brand.id}/assets/${sku.id}`, "PATCH", {}, "editor")).status).toBe(200);
  expect((await f.request(`/brands/${brand.id}/assets/${sku.id}`, "PATCH", { attachOnGenerate: true }, "editor")).status).toBe(422);
  await f.request(`/workspaces/${f.workspaceId}`, "PATCH", { defaultBrandId: brand.id });
  expect((await f.request(`/brands/${brand.id}`, "DELETE")).status).toBe(204);
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, f.workspaceId)); expect(workspace.defaultBrandId).toBeNull();
  for (const asset of [logo, sku]) await expect(headObject(decodeURIComponent(asset.url.slice("/api/files/".length)))).rejects.toThrow();
  expect((await f.request(`/brands/${brand.id}`)).status).toBe(404);
});

integration("视频品牌只注入文字，默认秒数先冻结且显式秒数优先", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const f = await fixture((_url, init) => { sent.push(JSON.parse(String(init?.body))); return Response.json({ id: `controlled-video-${sent.length}` }); });
  const brand = await f.createBrand({ defaultParams: { model: f.modelIds.video, seconds: 4, generate_audio: false } });
  await f.addAsset(brand.id); await f.request(`/workspaces/${f.workspaceId}`, "PATCH", { defaultBrandId: brand.id });
  const first = await f.request("/gateway/v1/videos", "POST", { prompt: "商品短片" }); expect(first.status).toBe(200);
  expect(sent[0]).toMatchObject({ model: "upstream-video", seconds: 4, generate_audio: false }); expect(sent[0].prompt).toContain("[品牌] 松风"); expect(sent[0].prompt).not.toContain("[参考图]");
  expect((await balance(f.workspaceId)).balance).toBe(52);
  const second = await f.request("/gateway/v1/videos", "POST", { prompt: "短片", seconds: 2 }); expect(second.status).toBe(200); expect(sent[1].seconds).toBe(2); expect((await balance(f.workspaceId)).balance).toBe(28);
});

integration("清理任务拒绝跨工作区、非品牌最终路径和目录穿越", async () => {
  const f = await fixture(); const brand = await f.createBrand();
  for (const key of [`ws/${f.otherWorkspaceId}/brands/${brand.id}/asset.png`, `ws/${f.workspaceId}/uploads/brand_asset/asset.png`, `ws/${f.workspaceId}/brands/${brand.id}/../asset.png`]) {
    await expect(stageObjectCleanup({ workspaceId: f.workspaceId, brandId: brand.id, objectKeys: [key] })).rejects.toThrow();
  }
  await expect(runObjectCleanup(`ws/${f.workspaceId}/brands/${brand.id}/asset.png`)).rejects.toThrow();
});

test("清理命名空间取规范数据库地址，凭据轮换不改变命名空间", () => {
  const prefix = objectCleanupPrefix("postgres://alice:password@DB.EXAMPLE/ic_test");
  expect(prefix).toBe(objectCleanupPrefix("postgresql://bob:new-password@db.example:5432/ic_test?sslmode=require"));
  expect(prefix).toBe(objectCleanupPrefix("postgres://alice:password@db.example/%69c_test"));
  expect(prefix).not.toBe(objectCleanupPrefix("postgres://alice:password@db.example/ic_development"));
  expect(prefix).not.toBe(objectCleanupPrefix("postgres://alice:password@db.example:5433/ic_test"));
  expect(prefix).toMatch(/^internal\/cleanup\/[a-f0-9]{64}\/$/);
});

integration("扫描仅恢复当前数据库任务，不读取或清理共享桶内另一数据库任务", async () => {
  const f = await fixture(); const brand = await f.createBrand(); const asset = await f.addAsset(brand.id);
  const [row] = await db.select().from(brandAssets).where(eq(brandAssets.id, asset.id));
  let currentTask: string | null = null;
  await db.transaction(async (tx) => {
    await lockWorkspace(tx, f.workspaceId);
    currentTask = await stageObjectCleanup({ workspaceId: f.workspaceId, brandId: brand.id, assetId: asset.id, objectKeys: [row.objectKey] });
    await tx.delete(brandAssets).where(eq(brandAssets.id, asset.id));
  });
  objectKeys.add(currentTask!);
  const foreignDatabase = new URL(process.env.DATABASE_URL!); foreignDatabase.pathname = `/foreign_${randomUUID()}`;
  const foreignTask = `${objectCleanupPrefix(foreignDatabase.href)}cleanup_foreign.json`;
  const foreignObject = `ws/ws_foreign_${randomUUID()}/brands/brd_foreign/asset.png`;
  objectKeys.add(foreignTask); objectKeys.add(foreignObject);
  await putObject(foreignObject, png, "image/png");
  await putObject(foreignTask, new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: foreignObject.split("/")[1], brandId: "brd_foreign", objectKeys: [foreignObject] })), "application/json");
  expect((await sweepObjectCleanups()).completed).toBeGreaterThanOrEqual(1);
  await expect(headObject(row.objectKey)).rejects.toThrow(); await expect(headObject(currentTask!)).rejects.toThrow();
  expect((await readObject(foreignObject)).bytes.length).toBe(png.length);
  expect((await readObject(foreignTask)).bytes.length).toBeGreaterThan(0);
  await expect(runObjectCleanup(foreignTask)).rejects.toThrow("清理任务路径不合法");
});

integration("等待期间变成默认品牌后，普通编辑者不能按旧快照删除", async () => {
  const f = await fixture(); const brand = await f.createBrand(); let pending!: Promise<Response>;
  await sqlClient.begin(async (tx) => {
    const [connection] = await tx`SELECT pg_backend_pid() AS pid`;
    await tx`SELECT id FROM workspaces WHERE id = ${f.workspaceId} FOR UPDATE`;
    await tx`UPDATE workspaces SET default_brand_id = ${brand.id} WHERE id = ${f.workspaceId}`;
    pending = Promise.resolve(f.request(`/brands/${brand.id}`, "DELETE", undefined, "editor"));
    let response: Response | undefined; void pending.then((value) => { response = value; });
    const deadline = Date.now() + 5000; let blocked = false;
    while (Date.now() < deadline) { if (response) throw new Error(`Request bypassed lock: ${response.status}`); const waiting = await sqlClient`SELECT pid FROM pg_stat_activity WHERE ${connection.pid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`; if (waiting.length) { blocked = true; break; } }
    expect(blocked).toBe(true);
  });
  expect((await pending).status).toBe(403); expect((await f.request(`/brands/${brand.id}`)).status).toBe(200);
});
