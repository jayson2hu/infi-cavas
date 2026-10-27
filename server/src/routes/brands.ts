import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { injectBrand } from "../../../shared/brand-inject";
import { db, type Transaction } from "../db/client";
import { brandAssets, brandColors, brands, models, workspaceMembers, workspaces } from "../db/schema";
import type { AppEnv } from "../lib/context";
import { loadBrand, lockEditableBrand } from "../lib/brands";
import { invariant } from "../lib/errors";
import { id } from "../lib/ids";
import { deleteObject, fileUrl, putObject } from "../lib/s3";
import { imageExtension, readUploadedImage } from "../lib/uploads";
import { finishObjectCleanup, stageObjectCleanup } from "../lib/object-cleanup";
import { requireSession, requireWorkspace, requireWorkspaceRoleInTransaction } from "../middleware/session";

const name = z.string().trim().min(1);
const optionalText = z.string().nullable().optional();
const defaultParams = z.object({
  model: name.optional(), quality: name.optional(), size: name.optional(), n: z.number().int().positive().optional(), background: name.optional(),
  seconds: z.number().positive().optional(), resolution: name.optional(), aspect_ratio: name.optional(), generate_audio: z.boolean().optional(), watermark: z.boolean().optional(), mode: name.optional(),
  voice: name.optional(), speed: z.number().positive().optional(), response_format: name.optional(), temperature: z.number().optional(), max_output_tokens: z.number().int().positive().optional(),
}).strict();
const brandInput = z.object({ name: name.optional(), industry: optionalText, description: optionalText, requiredTerms: z.array(name).max(20).optional(), avoidTerms: z.array(name).max(30).optional(), defaultParams: defaultParams.optional(), enforced: z.boolean().optional(), editorUserIds: z.array(name).refine((values) => new Set(values).size === values.length).optional() }).strict();
const assetFields = { title: name, spec: optionalText, attachOnGenerate: z.boolean().optional(), tags: z.array(name).optional() };
const assetInput = z.object({ kind: z.enum(["logo", "sku", "style_ref"]), objectKey: name, ...assetFields }).strict();
const assetPatch = z.object({ ...assetFields, sort: z.int32().optional() }).partial().strict();
const publicAsset = (asset: typeof brandAssets.$inferSelect) => ({ id: asset.id, kind: asset.kind, title: asset.title, spec: asset.spec, url: fileUrl(asset.objectKey), width: asset.width, height: asset.height, attachOnGenerate: asset.attachOnGenerate, tags: asset.tags, sort: asset.sort });

async function validateConfiguration(tx: Transaction, workspaceId: string, input: z.infer<typeof brandInput>) {
  if (input.editorUserIds?.length) {
    const members = await tx.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, input.editorUserIds)));
    invariant(members.length === input.editorUserIds.length, 422, "invalid_brand_editors", "品牌编辑者必须是当前工作区成员");
  }
  if (input.defaultParams?.model) {
    const [model] = await tx.select().from(models).where(and(eq(models.id, input.defaultParams.model), eq(models.isActive, true)));
    invariant(model, 422, "invalid_brand_model", "品牌默认模型不存在或未开放");
  }
}

async function summaries(workspaceId: string, defaultBrandId: string | null, brandId?: string) {
  const rows = await db.select({ brand: brands,
    skuCount: sql<number>`(select count(*)::int from brand_assets a where a.brand_id = brands.id and a.kind = 'sku')`,
    usedInProjects: sql<number>`(select count(distinct j.project_id)::int from generation_jobs j where j.brand_id = brands.id and j.workspace_id = brands.workspace_id and j.created_at >= clock_timestamp() - interval '30 days')`,
    logoKey: sql<string | null>`(select a.object_key from brand_assets a where a.brand_id = brands.id and a.kind = 'logo' order by a.sort, a.created_at, a.id limit 1)`,
  }).from(brands).where(and(eq(brands.workspaceId, workspaceId), brandId ? eq(brands.id, brandId) : undefined)).orderBy(desc(brands.updatedAt), asc(brands.id));
  if (!rows.length) return [];
  const colors = await db.select().from(brandColors).where(inArray(brandColors.brandId, rows.map(({ brand }) => brand.id))).orderBy(asc(brandColors.sort), asc(brandColors.id));
  return rows.map(({ brand, logoKey, ...counts }) => ({ id: brand.id, name: brand.name, industry: brand.industry, isDefault: brand.id === defaultBrandId, logoUrl: logoKey ? fileUrl(logoKey) : null, colors: colors.filter((color) => color.brandId === brand.id).map(({ brandId: _brandId, ...color }) => color), ...counts, updatedAt: brand.updatedAt }));
}

async function detail(c: Context<AppEnv>, brandId: string) {
  const brand = await loadBrand(c.get("workspace").id, brandId);
  const [summary] = await summaries(brand.workspaceId, c.get("workspace").defaultBrandId, brandId);
  return { ...summary, description: brand.description, requiredTerms: brand.requiredTerms, avoidTerms: brand.avoidTerms, defaultParams: brand.defaultParams, enforced: brand.enforced, editorUserIds: brand.editorUserIds, assets: brand.assets.map(publicAsset), canEdit: c.get("membership").role !== "member" || brand.editorUserIds.includes(c.get("user").id) };
}

export const brandRoutes = new Hono<AppEnv>();
brandRoutes.use("*", requireSession, requireWorkspace);
brandRoutes.get("/", async (c) => c.json(await summaries(c.get("workspace").id, c.get("workspace").defaultBrandId)));
brandRoutes.post("/", async (c) => {
  const input = brandInput.extend({ name }).parse(await c.req.json());
  const brandId = id("brd");
  await db.transaction(async (tx) => {
    await requireWorkspaceRoleInTransaction(tx, c.get("workspace").id, c.get("user").id);
    await validateConfiguration(tx, c.get("workspace").id, input);
    await tx.insert(brands).values({ ...input, id: brandId, workspaceId: c.get("workspace").id, createdBy: c.get("user").id });
  });
  return c.json(await detail(c, brandId), 201);
});
brandRoutes.get("/:brandId", async (c) => c.json(await detail(c, c.req.param("brandId"))));
brandRoutes.patch("/:brandId", async (c) => {
  const input = brandInput.parse(await c.req.json());
  await db.transaction(async (tx) => {
    const { membership } = await lockEditableBrand(tx, c.get("workspace").id, c.get("user").id, c.req.param("brandId"));
    invariant(membership.role !== "member" || (input.enforced === undefined && input.editorUserIds === undefined), 403, "brand_admin_required", "只有工作区管理员可以设置强制套用和编辑者");
    await validateConfiguration(tx, c.get("workspace").id, input);
    await tx.update(brands).set({ ...input, updatedAt: new Date() }).where(eq(brands.id, c.req.param("brandId")));
  });
  return c.json(await detail(c, c.req.param("brandId")));
});
brandRoutes.delete("/:brandId", async (c) => {
  const cleanup = await db.transaction(async (tx) => {
    const { brand, membership } = await lockEditableBrand(tx, c.get("workspace").id, c.get("user").id, c.req.param("brandId"));
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, brand.workspaceId));
    invariant(membership.role !== "member" || (!brand.enforced && workspace.defaultBrandId !== brand.id), 403, "brand_admin_required", "只有工作区管理员可以删除默认品牌或强制套用品牌");
    const assets = await tx.select().from(brandAssets).where(eq(brandAssets.brandId, brand.id));
    const cleanup = await stageObjectCleanup({ workspaceId: brand.workspaceId, brandId: brand.id, objectKeys: assets.map((asset) => asset.objectKey) });
    await tx.update(workspaces).set({ defaultBrandId: null, updatedAt: new Date() }).where(and(eq(workspaces.id, brand.workspaceId), eq(workspaces.defaultBrandId, brand.id)));
    await tx.delete(brands).where(eq(brands.id, brand.id));
    return cleanup;
  });
  await finishObjectCleanup(cleanup);
  return c.body(null, 204);
});
brandRoutes.put("/:brandId/colors", async (c) => {
  const input = z.array(z.object({ id: z.string().optional(), name, role: z.enum(["primary", "secondary", "background", "accent"]), hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/), sort: z.int32().optional() }).strict()).max(12).parse(await c.req.json());
  const colors = input.map((color, index) => ({ ...color, id: id("bc"), brandId: c.req.param("brandId"), sort: color.sort ?? index }));
  await db.transaction(async (tx) => {
    await lockEditableBrand(tx, c.get("workspace").id, c.get("user").id, c.req.param("brandId"));
    await tx.delete(brandColors).where(eq(brandColors.brandId, c.req.param("brandId")));
    if (colors.length) await tx.insert(brandColors).values(colors);
    await tx.update(brands).set({ updatedAt: new Date() }).where(eq(brands.id, c.req.param("brandId")));
  });
  return c.json(colors.map(({ brandId: _brandId, ...color }) => color));
});
brandRoutes.post("/:brandId/assets", async (c) => {
  const input = assetInput.parse(await c.req.json());
  const workspaceId = c.get("workspace").id;
  const userId = c.get("user").id;
  const brand = await loadBrand(workspaceId, c.req.param("brandId"));
  invariant(c.get("membership").role !== "member" || brand.editorUserIds.includes(userId), 403, "brand_readonly", "没有编辑此品牌的权限");
  invariant(input.kind === "style_ref" || !input.attachOnGenerate, 422, "invalid_brand_reference", "只有风格参考图可以随生成附带");
  const image = await readUploadedImage(input.objectKey, workspaceId, userId, "brand_asset");
  const assetId = id("ba");
  const objectKey = `ws/${workspaceId}/brands/${brand.id}/${assetId}.${imageExtension(image.mimeType)}`;
  let cleanup: string | null = null;
  let asset: typeof brandAssets.$inferSelect;
  try {
    asset = await db.transaction(async (tx) => {
      await lockEditableBrand(tx, workspaceId, userId, brand.id);
      cleanup = await stageObjectCleanup({ workspaceId, brandId: brand.id, assetId, objectKeys: [objectKey] });
      await putObject(objectKey, image.bytes, image.mimeType);
      const [created] = await tx.insert(brandAssets).values({ ...input, id: assetId, brandId: brand.id, objectKey, width: image.width, height: image.height, mimeType: image.mimeType, bytes: image.bytes.length }).returning();
      await tx.update(brands).set({ updatedAt: new Date() }).where(eq(brands.id, brand.id));
      return created;
    });
  } catch (error) { await finishObjectCleanup(cleanup); throw error; }
  await finishObjectCleanup(cleanup);
  await deleteObject(input.objectKey).catch(() => { console.error(JSON.stringify({ event: "temporary_upload_cleanup_failed", assetId })); });
  return c.json(publicAsset(asset), 201);
});
brandRoutes.patch("/:brandId/assets/:assetId", async (c) => {
  const input = assetPatch.parse(await c.req.json());
  const asset = await db.transaction(async (tx) => {
    const { brand } = await lockEditableBrand(tx, c.get("workspace").id, c.get("user").id, c.req.param("brandId"));
    const [existing] = await tx.select().from(brandAssets).where(and(eq(brandAssets.id, c.req.param("assetId")), eq(brandAssets.brandId, brand.id))).for("update");
    invariant(existing, 404, "brand_asset_not_found", "品牌素材不存在");
    invariant(existing.kind === "style_ref" || !input.attachOnGenerate, 422, "invalid_brand_reference", "只有风格参考图可以随生成附带");
    const [updated] = Object.keys(input).length ? await tx.update(brandAssets).set(input).where(eq(brandAssets.id, existing.id)).returning() : [existing];
    await tx.update(brands).set({ updatedAt: new Date() }).where(eq(brands.id, brand.id));
    return updated;
  });
  return c.json(publicAsset(asset));
});
brandRoutes.delete("/:brandId/assets/:assetId", async (c) => {
  const cleanup = await db.transaction(async (tx) => {
    const { brand } = await lockEditableBrand(tx, c.get("workspace").id, c.get("user").id, c.req.param("brandId"));
    const [asset] = await tx.select().from(brandAssets).where(and(eq(brandAssets.id, c.req.param("assetId")), eq(brandAssets.brandId, brand.id))).for("update");
    invariant(asset, 404, "brand_asset_not_found", "品牌素材不存在");
    const cleanup = await stageObjectCleanup({ workspaceId: brand.workspaceId, brandId: brand.id, assetId: asset.id, objectKeys: [asset.objectKey] });
    await tx.delete(brandAssets).where(eq(brandAssets.id, asset.id));
    await tx.update(brands).set({ updatedAt: new Date() }).where(eq(brands.id, brand.id));
    return cleanup;
  });
  await finishObjectCleanup(cleanup);
  return c.body(null, 204);
});
brandRoutes.get("/:brandId/injection-preview", async (c) => {
  const query = z.object({ prompt: z.string().default(""), modelId: z.string().optional(), originalReferenceCount: z.coerce.number().int().nonnegative().default(0), capability: z.enum(["image", "video", "text", "audio"]).default("image") }).parse(c.req.query());
  const brand = await loadBrand(c.get("workspace").id, c.req.param("brandId"));
  const modelId = query.modelId ?? (typeof brand.defaultParams.model === "string" ? brand.defaultParams.model : undefined);
  const [model] = modelId ? await db.select().from(models).where(and(eq(models.id, modelId), eq(models.isActive, true))) : [];
  invariant(!modelId || model, 422, "invalid_brand_model", "预览模型不存在或未开放");
  invariant(query.capability !== "image" || query.originalReferenceCount <= (model?.maxReferenceImages ?? 8), 422, "invalid_references", "参考图片数量不符合模型要求");
  const injection = injectBrand({ brand, prompt: query.prompt, capability: query.capability, supportsEdit: model ? model.capability === "image" && model.supportsEdit : true, maxReferenceImages: model?.maxReferenceImages ?? 8, originalReferenceCount: query.originalReferenceCount });
  return c.json({ text: injection.text, attachedReferenceCount: injection.referenceKeys.length });
});
