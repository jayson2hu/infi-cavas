import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { TemplateBody } from "../../shared/template";
import { createApp } from "../src/app";
import { balance, grant, lockWorkspace } from "../src/billing/ledger";
import { db, sqlClient } from "../src/db/client";
import { seedDatabase } from "../src/db/seed";
import { brands, generationJobs, sessions, templates, users, workspaceMembers, workspaces } from "../src/db/schema";
import { tokenHash } from "../src/lib/ids";
import { runObjectCleanup, stageObjectCleanup } from "../src/lib/object-cleanup";
import { deleteObject, headObject, listObjectKeys, readObject } from "../src/lib/s3";
import { officialTemplateDefinitions, seedOfficialTemplates } from "../src/templates/official";
import { validateTemplateBody } from "../src/templates/validation";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV6kAAAAASUVORK5CYII=", "base64");
type Actor = "owner" | "editor" | "member" | "outsider";
const actors: Actor[] = ["owner", "editor", "member", "outsider"];
const fixtures: Array<{ workspaceId: string; otherWorkspaceId: string; userIds: string[] }> = [];
const templateIds = new Set<string>();
const objectKeys = new Set<string>();
const body = (): TemplateBody => ({ version: 1, variables: [{ key: "subject", label: "主题", type: "text" }, { key: "photo", label: "参考图", type: "image", required: false, bindNode: "photo" }], ops: [
  { type: "add_node", id: "photo", nodeType: "image", metadata: {} }, { type: "add_node", id: "brief", nodeType: "text", metadata: { content: "{{var.subject}}" } },
  { type: "add_node", id: "result", nodeType: "image", metadata: { prompt: "结合@[node:brief]的主题和参考图创作", model: "gpt-image-2", size: "1024x1024", count: 1 } },
  { type: "connect_nodes", fromNodeId: "photo", toNodeId: "result" }, { type: "connect_nodes", fromNodeId: "brief", toNodeId: "result" }], steps: [{ label: "生成主图", mode: "image", nodeIds: ["result"], estimate: 4 }] });

afterAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  if (templateIds.size) await db.delete(templates).where(inArray(templates.id, [...templateIds]));
  for (const fixture of fixtures) {
    for (const workspaceId of [fixture.workspaceId, fixture.otherWorkspaceId]) for await (const key of listObjectKeys(`ws/${workspaceId}/`)) objectKeys.add(key);
    await db.delete(workspaces).where(inArray(workspaces.id, [fixture.workspaceId, fixture.otherWorkspaceId]));
    await db.delete(users).where(inArray(users.id, fixture.userIds));
  }
  for (const key of objectKeys) await deleteObject(key);
});

async function fixture() {
  const suffix = randomUUID().replaceAll("-", "");
  const workspaceId = `ws_tpl_${suffix}`; const otherWorkspaceId = `ws_tpl_other_${suffix}`;
  const userIds = Object.fromEntries(actors.map((actor) => [actor, `usr_${actor}_${suffix}`])) as Record<Actor, string>;
  const cookies = Object.fromEntries(actors.map((actor) => [actor, `ic_session=${actor}_${suffix}`])) as Record<Actor, string>;
  const brandId = `brd_${suffix}`;
  fixtures.push({ workspaceId, otherWorkspaceId, userIds: Object.values(userIds) });
  await db.insert(users).values(actors.map((actor) => ({ id: userIds[actor], email: `${actor}_${suffix}@example.test`, name: actor, passwordHash: "test-not-a-login", lastWorkspaceId: actor === "outsider" ? otherWorkspaceId : workspaceId })));
  await db.insert(workspaces).values([{ id: workspaceId, ownerId: userIds.owner, name: "模板测试", kind: "team" }, { id: otherWorkspaceId, ownerId: userIds.outsider, name: "其他工作区", kind: "personal" }]);
  await db.insert(workspaceMembers).values(actors.map((actor) => ({ workspaceId: actor === "outsider" ? otherWorkspaceId : workspaceId, userId: userIds[actor], role: actor === "owner" || actor === "outsider" ? "owner" as const : "member" as const })));
  await db.insert(sessions).values(actors.map((actor) => ({ id: `ses_${actor}_${suffix}`, userId: userIds[actor], tokenHash: tokenHash(`${actor}_${suffix}`), expiresAt: new Date(Date.now() + 86400000) })));
  await db.insert(brands).values({ id: brandId, workspaceId, name: "编辑授权", createdBy: userIds.owner, editorUserIds: [userIds.editor] });
  await grant({ workspaceId, userId: userIds.owner, kind: "purchase", amount: 100, source: "test:templates" });
  const app = createApp();
  const request = (path: string, method = "GET", input?: unknown, actor: Actor = "owner") => app.request(`/api${path}`, { method, headers: { Cookie: cookies[actor], Origin: process.env.APP_ORIGIN!, "X-IC-Workspace": actor === "outsider" ? otherWorkspaceId : workspaceId, "Content-Type": "application/json" }, body: input === undefined ? undefined : JSON.stringify(input) });
  const upload = async (purpose = "template_image", actor: Actor = "owner") => {
    const response = await request("/uploads/presign", "POST", { purpose, mimeType: "image/png", bytes: png.length }, actor); expect(response.status).toBe(200);
    const uploaded = await response.json() as { uploadUrl: string; objectKey: string; headers: Record<string, string> }; objectKeys.add(uploaded.objectKey);
    expect((await fetch(uploaded.uploadUrl, { method: "PUT", headers: uploaded.headers, body: png })).status).toBe(200);
    return { ...uploaded, url: `/api/files/${uploaded.objectKey}` };
  };
  const create = async (input: Record<string, unknown> = {}, actor: Actor = "owner") => {
    const response = await request("/templates", "POST", { name: "团队产品模板", category: "ecommerce", body: body(), ...input }, actor); expect(response.status).toBe(201);
    const template = await response.json() as { id: string; body: TemplateBody; coverUrl: string | null; estimateCredits: number; canEdit: boolean; useCount: number };
    templateIds.add(template.id); return template;
  };
  return { app, request, upload, create, userIds, cookies, workspaceId, otherWorkspaceId, brandId };
}

integration("模板CRUD隔离团队，品牌编辑者可发布，普通成员只读与使用", async () => {
  const f = await fixture(); const template = await f.create({}, "editor");
  expect(template.canEdit).toBe(true); expect(template.estimateCredits).toBe(4);
  expect((await f.request("/templates", "POST", { name: "拒绝创建", category: "other", body: body() }, "member")).status).toBe(403);
  expect((await (await f.request(`/templates/${template.id}`, "GET", undefined, "member")).json()).canEdit).toBe(false);
  expect((await f.request(`/templates/${template.id}`, "PATCH", { name: "拒绝修改" }, "member")).status).toBe(403);
  expect((await f.request(`/templates/${template.id}`, "DELETE", undefined, "member")).status).toBe(403);
  for (const [method, suffix] of [["GET", ""], ["PATCH", ""], ["DELETE", ""], ["POST", "/use"]]) expect((await f.request(`/templates/${template.id}${suffix}`, method, method === "PATCH" ? { name: "越权" } : undefined, "outsider")).status).toBe(404);
  const listing = await (await f.request("/templates?scope=team&category=ecommerce&q=产品")).json(); expect(listing).toHaveLength(1); expect(listing[0].body).toBeUndefined();
  expect((await (await f.request("/templates?scope=team", "GET", undefined, "outsider")).json())).toHaveLength(0);
  const used = await Promise.all(Array.from({ length: 12 }, () => f.request(`/templates/${template.id}/use`, "POST", undefined, "member")));
  expect(used.every((response) => response.status === 204)).toBe(true);
  expect((await (await f.request(`/templates/${template.id}`)).json()).useCount).toBe(12);
  expect((await balance(f.workspaceId)).balance).toBe(100); expect(await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, f.workspaceId))).toHaveLength(0);
  expect((await f.request(`/templates/${template.id}`, "PATCH", { name: "更新模板" }, "editor")).status).toBe(200);
  expect((await f.request(`/templates/${template.id}`, "DELETE", undefined, "editor")).status).toBe(204);
  expect(await db.select().from(templates).where(eq(templates.id, template.id))).toHaveLength(0);
});

integration("模板结构和语义错误以422与字段路径返回", async () => {
  const f = await fixture();
  const invalid = body(); invalid.steps[0].nodeIds = ["missing"];
  const response = await f.request("/templates", "POST", { name: "错误", category: "other", body: invalid }); expect(response.status).toBe(422);
  expect((await response.json()).error.fields[0].path).toStartWith("/steps/0");
  expect((await f.request("/templates", "POST", { name: "错误版本", category: "other", body: { ...body(), version: 2 } })).status).toBe(422);
  const privateBody = body(); (privateBody.ops[2] as any).metadata.apiKey = "private";
  expect((await f.request("/templates", "POST", { name: "私有数据", category: "other", body: privateBody })).status).toBe(422);
});

integration("默认图片与节点图片复用同一固化对象，封面独立且PUT重放无效", async () => {
  const f = await fixture(); const uploaded = await f.upload(); const cover = await f.upload("template_cover"); const content = body();
  (content.ops[0] as any).metadata.content = uploaded.url; content.variables[1].default = uploaded.url;
  const template = await f.create({ body: content, coverObjectKey: cover.objectKey });
  const imageUrl = (template.body.ops[0] as any).metadata.content as string;
  const imageKey = imageUrl.slice("/api/files/".length); const coverKey = template.coverUrl!.slice("/api/files/".length); objectKeys.add(imageKey); objectKeys.add(coverKey);
  expect(template.body.variables[1].default).toBe(imageUrl); expect(imageUrl).not.toBe(uploaded.url); expect(imageKey).toStartWith(`ws/${f.workspaceId}/templates/${template.id}/`);
  expect((template.body.ops[0] as any).metadata.naturalWidth).toBe(1);
  expect((await fetch(uploaded.uploadUrl, { method: "PUT", headers: uploaded.headers, body: Buffer.alloc(png.length, 65) })).status).toBe(200);
  expect(Buffer.from((await readObject(imageKey)).bytes).equals(png)).toBe(true);
  expect((await f.request(`/templates/${template.id}`, "PATCH", { description: "保留现有图片", body: template.body })).status).toBe(200);
  expect(Buffer.from((await readObject(imageKey)).bytes).equals(png)).toBe(true);
  const withoutImage = structuredClone(template.body); delete (withoutImage.ops[0] as any).metadata.content; delete withoutImage.variables[1].default;
  expect((await f.request(`/templates/${template.id}`, "PATCH", { body: withoutImage, coverObjectKey: null })).status).toBe(200);
  await expect(headObject(imageKey)).rejects.toThrow(); await expect(headObject(coverKey)).rejects.toThrow();
});

integration("模板素材拒绝跨工作区、跨上传人、错误用途和其他模板最终key", async () => {
  const f = await fixture();
  for (const image of [await f.upload("template_image", "outsider"), await f.upload("template_image", "member"), await f.upload("brand_asset")]) {
    const content = body(); (content.ops[0] as any).metadata.content = image.url;
    expect((await f.request("/templates", "POST", { name: "错误图片", category: "other", body: content })).status).toBe(403);
  }
  const uploaded = await f.upload(); const content = body(); (content.ops[0] as any).metadata.content = uploaded.url;
  const original = await f.create({ body: content });
  expect((await f.request("/templates", "POST", { name: "冒用其他模板对象", category: "other", body: original.body })).status).toBe(403);
  const wrong = body(); (wrong.ops[0] as any).metadata.content = "https://provider.test/private.png";
  expect((await f.request("/templates", "POST", { name: "外部图片", category: "other", body: wrong })).status).toBe(422);
});

integration("第二个图片验证失败会回滚模板并回收前一个已写入的最终图片", async () => {
  const f = await fixture(); const uploaded = await f.upload(); const foreign = await f.upload("template_image", "outsider"); const content = body();
  (content.ops[0] as any).metadata.content = uploaded.url; content.variables[1].default = foreign.url;
  expect((await f.request("/templates", "POST", { name: "回滚模板", category: "other", body: content })).status).toBe(403);
  expect(await db.select().from(templates).where(eq(templates.workspaceId, f.workspaceId))).toHaveLength(0);
  const finalKeys: string[] = []; for await (const key of listObjectKeys(`ws/${f.workspaceId}/templates/`)) finalKeys.push(key);
  expect(finalKeys).toEqual([]); expect((await readObject(uploaded.objectKey)).bytes.length).toBe(png.length);
});

integration("官方模板仅平台管理员修改，官方图片脱离私有工作区且仅当前引用可读取", async () => {
  const f = await fixture(); const templateId = `tpl_official_${randomUUID()}`; templateIds.add(templateId);
  await db.insert(templates).values({ id: templateId, workspaceId: null, name: "受控官方模板", category: "brand", body: body(), estimateCredits: 4 });
  expect((await f.request(`/templates/${templateId}`, "GET", undefined, "outsider")).status).toBe(200);
  expect((await f.request(`/templates/${templateId}`, "PATCH", { name: "工作区所有者不能改官方" })).status).toBe(403);
  expect((await f.request(`/templates/${templateId}`, "DELETE")).status).toBe(403);
  await db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, f.userIds.owner));
  const uploaded = await f.upload(); const cover = await f.upload("template_cover"); const content = body(); (content.ops[0] as any).metadata.content = uploaded.url;
  const response = await f.request(`/templates/${templateId}`, "PATCH", { body: content, coverObjectKey: cover.objectKey }); expect(response.status).toBe(200);
  const template = await response.json(); const imageUrl = template.body.ops[0].metadata.content as string; objectKeys.add(imageUrl.slice("/api/files/".length)); objectKeys.add(template.coverUrl.slice("/api/files/".length));
  expect(imageUrl).toStartWith(`/api/files/official/templates/${templateId}/`);
  const file = await f.request(imageUrl.replace("/api", ""), "GET", undefined, "outsider"); expect(file.status).toBe(302);
  expect(Buffer.from(await (await fetch(file.headers.get("Location")!)).arrayBuffer()).equals(png)).toBe(true);
  expect((await f.request(`/files/official/templates/${templateId}/not-associated.png`, "GET", undefined, "outsider")).status).toBe(403);
  expect((await f.request(`/templates/${templateId}`, "DELETE")).status).toBe(204);
  expect((await db.select().from(templates).where(eq(templates.id, templateId)))[0].isPublished).toBe(false);
  expect((await f.request(imageUrl.replace("/api", ""), "GET", undefined, "outsider")).status).toBe(403);
  await expect(headObject(imageUrl.slice("/api/files/".length))).rejects.toThrow();
});

integration("模板清理按数据库当前引用决定，回滚不删图且失败重试不碰保留封面", async () => {
  const f = await fixture(); const uploaded = await f.upload(); const cover = await f.upload("template_cover"); const content = body(); (content.ops[0] as any).metadata.content = uploaded.url;
  const template = await f.create({ body: content, coverObjectKey: cover.objectKey });
  const imageKey = String((template.body.ops[0] as any).metadata.content).slice("/api/files/".length); const coverKey = template.coverUrl!.slice("/api/files/".length); let task: string | null = null;
  const removed = structuredClone(template.body); delete (removed.ops[0] as any).metadata.content;
  await expect(db.transaction(async (tx) => { await lockWorkspace(tx, f.workspaceId); task = await stageObjectCleanup({ workspaceId: f.workspaceId, templateId: template.id, objectKeys: [imageKey, coverKey] }); await tx.update(templates).set({ body: removed }).where(eq(templates.id, template.id)); throw new Error("受控回滚"); })).rejects.toThrow("受控回滚");
  objectKeys.add(task!); expect(await runObjectCleanup(task!)).toBe("cancelled"); expect((await readObject(imageKey)).bytes.length).toBe(png.length);
  await db.transaction(async (tx) => { await lockWorkspace(tx, f.workspaceId); task = await stageObjectCleanup({ workspaceId: f.workspaceId, templateId: template.id, objectKeys: [imageKey, coverKey] }); await tx.update(templates).set({ body: removed }).where(eq(templates.id, template.id)); });
  objectKeys.add(task!); await expect(runObjectCleanup(task!, async () => { throw new Error("受控S3失败"); })).rejects.toThrow("受控S3失败");
  expect(await runObjectCleanup(task!)).toBe("completed"); await expect(headObject(imageKey)).rejects.toThrow(); expect((await readObject(coverKey)).bytes.length).toBe(png.length); expect(await runObjectCleanup(task!)).toBe("missing");
});

integration("品牌编辑者在模板写入等待期间被撤权，模板更新必须拒绝", async () => {
  const f = await fixture(); const template = await f.create(); let pending!: Promise<Response>;
  await sqlClient.begin(async (tx) => {
    const [connection] = await tx`SELECT pg_backend_pid() AS pid`; await tx`SELECT id FROM workspaces WHERE id = ${f.workspaceId} FOR UPDATE`; await tx`UPDATE brands SET editor_user_ids = '{}' WHERE id = ${f.brandId}`;
    pending = Promise.resolve(f.request(`/templates/${template.id}`, "PATCH", { name: "越权更新" }, "editor"));
    let response: Response | undefined; void pending.then((value) => { response = value; });
    const deadline = Date.now() + 5000; let blocked = false;
    while (Date.now() < deadline) { if (response) throw new Error(`Request bypassed lock: ${response.status}`); const waiting = await sqlClient`SELECT pid FROM pg_stat_activity WHERE ${connection.pid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`; if (waiting.length) { blocked = true; break; } }
    expect(blocked).toBe(true);
  });
  expect((await pending).status).toBe(403); expect((await (await f.request(`/templates/${template.id}`)).json()).name).toBe("团队产品模板");
});

integration("六个官方seed完整、按当前定价估计且幂等保留运营编辑", async () => {
  await seedDatabase(); const rows = await seedOfficialTemplates(); expect(rows).toHaveLength(6);
  expect(new Set(rows.map((row) => row.name))).toEqual(new Set(officialTemplateDefinitions.map((row) => row.name)));
  for (const row of rows) { const content = validateTemplateBody(row.body); expect(row.estimateCredits).toBe(content.steps.reduce((sum, step) => sum + (step.estimate ?? 0), 0)); }
  const ecom = rows.find((row) => row.id === "tpl_ecom_main_set")!; expect(ecom.estimateCredits).toBe(40);
  expect((ecom.body as TemplateBody).steps.map((step) => step.estimate)).toEqual([20, 20]);
  const editedName = "运营编辑保留测试";
  try {
    await db.update(templates).set({ name: editedName, useCount: 17 }).where(eq(templates.id, ecom.id));
    const rerun = (await seedOfficialTemplates()).find((row) => row.id === ecom.id)!; expect(rerun.name).toBe(editedName); expect(rerun.useCount).toBe(17); expect(rerun.body).toEqual(ecom.body);
  } finally { await db.update(templates).set({ name: ecom.name, useCount: ecom.useCount }).where(eq(templates.id, ecom.id)); }
});

integration("官方模板删除后保留下架ID，启动seed不复活并回收图片和封面", async () => {
  await seedDatabase();
  const [original] = await db.select().from(templates).where(eq(templates.id, "tpl_ecom_main_set"));
  const f = await fixture(); await db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, f.userIds.owner));
  try {
    const uploaded = await f.upload(); const cover = await f.upload("template_cover"); const content = body(); (content.ops[0] as any).metadata.content = uploaded.url;
    const response = await f.request(`/templates/${original.id}`, "PATCH", { body: content, coverObjectKey: cover.objectKey }); expect(response.status).toBe(200);
    const saved = await response.json(); const imageUrl = saved.body.ops[0].metadata.content as string;
    const keys = [imageUrl.slice("/api/files/".length), saved.coverUrl.slice("/api/files/".length)]; keys.forEach((key) => objectKeys.add(key));
    expect((await f.request(`/templates/${original.id}`, "DELETE")).status).toBe(204);
    await seedDatabase();
    const [removed] = await db.select().from(templates).where(eq(templates.id, original.id));
    expect(removed).toMatchObject({ id: original.id, isPublished: false, body: saved.body, useCount: original.useCount });
    expect((await (await f.request("/templates?scope=official")).json()).some((entry: { id: string }) => entry.id === original.id)).toBe(false);
    for (const [method, suffix] of [["GET", ""], ["PATCH", ""], ["DELETE", ""], ["POST", "/use"]]) expect((await f.request(`/templates/${original.id}${suffix}`, method, method === "PATCH" ? { name: "不可编辑已删除模板" } : undefined)).status).toBe(404);
    for (const key of keys) { await expect(headObject(key)).rejects.toThrow(); expect((await f.request(`/files/${key}`, "GET", undefined, "outsider")).status).toBe(403); }
  } finally { await db.update(templates).set(original).where(eq(templates.id, original.id)); }
});

integration("官方下架回滚保留对象，清理等到模板锁释放后按最新发布状态判定", async () => {
  const f = await fixture(); const templateId = `tpl_official_${randomUUID()}`; templateIds.add(templateId);
  await db.insert(templates).values({ id: templateId, workspaceId: null, name: "官方清理竞态", category: "brand", body: body(), estimateCredits: 4 });
  await db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, f.userIds.owner));
  const uploaded = await f.upload(); const content = body(); (content.ops[0] as any).metadata.content = uploaded.url;
  const response = await f.request(`/templates/${templateId}`, "PATCH", { body: content }); expect(response.status).toBe(200);
  const saved = await response.json(); const imageKey = String(saved.body.ops[0].metadata.content).slice("/api/files/".length); objectKeys.add(imageKey);
  let task: string | null = null;
  const unpublish = (rollback = false) => db.transaction(async (tx) => {
    await lockWorkspace(tx, f.workspaceId);
    task = await stageObjectCleanup({ workspaceId: f.workspaceId, templateId, official: true, objectKeys: [imageKey] });
    await tx.update(templates).set({ isPublished: false }).where(eq(templates.id, templateId));
    if (rollback) throw new Error("受控下架回滚");
  });
  await expect(unpublish(true)).rejects.toThrow("受控下架回滚"); objectKeys.add(task!);
  expect(await runObjectCleanup(task!)).toBe("cancelled"); expect((await readObject(imageKey)).bytes.length).toBe(png.length);
  await unpublish(); objectKeys.add(task!);
  await expect(runObjectCleanup(task!, async () => { throw new Error("受控S3失败"); })).rejects.toThrow("受控S3失败");
  let pending!: ReturnType<typeof runObjectCleanup>;
  await sqlClient.begin(async (tx) => {
    const [connection] = await tx`SELECT pg_backend_pid() AS pid`;
    await tx`UPDATE templates SET is_published = true WHERE id = ${templateId}`;
    pending = runObjectCleanup(task!); let finished = false; void pending.then(() => { finished = true; });
    const deadline = Date.now() + 5000; let blocked = false;
    while (Date.now() < deadline) { if (finished) throw new Error("Cleanup bypassed template lock"); const waiting = await sqlClient`SELECT pid FROM pg_stat_activity WHERE ${connection.pid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`; if (waiting.length) { blocked = true; break; } }
    expect(blocked).toBe(true);
  });
  expect(await pending).toBe("cancelled"); expect((await readObject(imageKey)).bytes.length).toBe(png.length);
  expect((await f.request(`/templates/${templateId}`, "DELETE")).status).toBe(204); await expect(headObject(imageKey)).rejects.toThrow();
});
