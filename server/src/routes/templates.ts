import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { TemplateBody } from "../../../shared/template";
import { db, type Transaction } from "../db/client";
import { brands, templates, users } from "../db/schema";
import type { AppEnv } from "../lib/context";
import { invariant } from "../lib/errors";
import { id } from "../lib/ids";
import { finishObjectCleanup, stageObjectCleanup } from "../lib/object-cleanup";
import { deleteObject, fileUrl } from "../lib/s3";
import { requireSession, requireWorkspace, requireWorkspaceRoleInTransaction } from "../middleware/session";
import { materializeTemplateImages } from "../templates/storage";
import { templateObjectKeys, validateTemplateBody } from "../templates/validation";

const category = z.enum(["ecommerce", "short_video", "brand", "social", "other"]);
const templateInput = z.object({ name: z.string().trim().min(1), category, description: z.string().optional(), coverObjectKey: z.string().nullable().optional(), previewNodes: z.array(z.string()).max(3).optional(), body: z.unknown() }).strict();
type Template = typeof templates.$inferSelect;
const scope = (workspaceId: string) => or(isNull(templates.workspaceId), eq(templates.workspaceId, workspaceId));
const summary = (template: Template) => ({ id: template.id, scope: template.workspaceId ? "team" : "official", name: template.name, category: template.category, description: template.description, coverUrl: template.coverObjectKey ? fileUrl(template.coverObjectKey) : null, previewNodes: template.previewNodes, estimateCredits: template.estimateCredits, useCount: template.useCount });
const estimatedCredits = (body: TemplateBody) => body.steps.reduce((sum, step) => sum + (step.estimate ?? 0), 0);

async function isBrandEditor(workspaceId: string, userId: string, client: typeof db | Transaction = db) {
  const [brand] = await client.select({ id: brands.id }).from(brands).where(and(eq(brands.workspaceId, workspaceId), sql`${userId} = any(${brands.editorUserIds})`)).limit(1);
  return Boolean(brand);
}
async function authorizeTeamWrite(c: Context<AppEnv>, tx: Transaction) {
  const membership = await requireWorkspaceRoleInTransaction(tx, c.get("workspace").id, c.get("user").id, ["owner", "admin", "member"]);
  invariant(membership.role !== "member" || await isBrandEditor(c.get("workspace").id, c.get("user").id, tx), 403, "template_readonly", "需要工作区管理员或品牌编辑权限");
}
async function lockTemplate(c: Context<AppEnv>, tx: Transaction, write: boolean) {
  const membership = await requireWorkspaceRoleInTransaction(tx, c.get("workspace").id, c.get("user").id, ["owner", "admin", "member"]);
  const [template] = await tx.select().from(templates).where(and(eq(templates.id, c.req.param("templateId")!), scope(c.get("workspace").id), eq(templates.isPublished, true))).for("update");
  invariant(template, 404, "template_not_found", "模板不存在或不属于此工作区");
  if (write && template.workspaceId === null) {
    const [user] = await tx.select({ admin: users.isPlatformAdmin }).from(users).where(eq(users.id, c.get("user").id));
    invariant(user?.admin, 403, "template_readonly", "只有平台管理员可以修改官方模板");
  } else if (write) invariant(membership.role !== "member" || await isBrandEditor(template.workspaceId!, c.get("user").id, tx), 403, "template_readonly", "需要工作区管理员或品牌编辑权限");
  return template;
}
async function detail(c: Context<AppEnv>, template: Template) {
  const canEdit = template.workspaceId === null ? c.get("user").isPlatformAdmin : c.get("membership").role !== "member" || await isBrandEditor(template.workspaceId, c.get("user").id);
  return { ...summary(template), body: template.body, canEdit };
}
async function cleanTemporary(keys: Set<string>) {
  for (const key of keys) await deleteObject(key).catch(() => { console.error(JSON.stringify({ event: "template_temporary_cleanup_failed" })); });
}

export const templateRoutes = new Hono<AppEnv>();
templateRoutes.use("*", requireSession, requireWorkspace);
templateRoutes.get("/", async (c) => {
  const query = z.object({ category: category.optional(), scope: z.enum(["all", "official", "team"]).default("all"), q: z.string().default("") }).parse(c.req.query());
  const rows = await db.select().from(templates).where(and(scope(c.get("workspace").id), eq(templates.isPublished, true), query.category ? eq(templates.category, query.category) : undefined, query.scope === "official" ? isNull(templates.workspaceId) : query.scope === "team" ? eq(templates.workspaceId, c.get("workspace").id) : undefined, query.q ? ilike(templates.name, `%${query.q}%`) : undefined)).orderBy(desc(templates.updatedAt), asc(templates.id));
  return c.json(rows.map(summary));
});
templateRoutes.get("/:templateId", async (c) => {
  const [template] = await db.select().from(templates).where(and(eq(templates.id, c.req.param("templateId")), scope(c.get("workspace").id), eq(templates.isPublished, true)));
  invariant(template, 404, "template_not_found", "模板不存在或不属于此工作区");
  return c.json(await detail(c, template));
});
templateRoutes.post("/", async (c) => {
  const input = templateInput.parse(await c.req.json());
  const body = structuredClone(validateTemplateBody(input.body));
  const templateId = id("tpl");
  const cleanups: string[] = [];
  const temporaryKeys = new Set<string>();
  let template: Template;
  try {
    template = await db.transaction(async (tx) => {
      await authorizeTeamWrite(c, tx);
      const stored = await materializeTemplateImages(body, input.coverObjectKey ?? null, { workspaceId: c.get("workspace").id, userId: c.get("user").id, templateId, official: false, existingKeys: new Set(), cleanups, temporaryKeys });
      const [created] = await tx.insert(templates).values({ ...input, ...stored, id: templateId, workspaceId: c.get("workspace").id, createdBy: c.get("user").id, estimateCredits: estimatedCredits(body) }).returning();
      return created;
    });
  } finally { for (const cleanup of cleanups) await finishObjectCleanup(cleanup); }
  await cleanTemporary(temporaryKeys);
  return c.json(await detail(c, template), 201);
});
templateRoutes.patch("/:templateId", async (c) => {
  const input = templateInput.partial().parse(await c.req.json());
  const requestedBody = input.body === undefined ? undefined : structuredClone(validateTemplateBody(input.body));
  const cleanups: string[] = [];
  const temporaryKeys = new Set<string>();
  let template: Template;
  try {
    template = await db.transaction(async (tx) => {
      const existing = await lockTemplate(c, tx, true);
      const oldKeys = templateObjectKeys(existing.body as TemplateBody, existing.coverObjectKey);
      const oldCleanup = await stageObjectCleanup({ workspaceId: c.get("workspace").id, templateId: existing.id, official: existing.workspaceId === null, objectKeys: oldKeys });
      if (oldCleanup) cleanups.push(oldCleanup);
      const body = requestedBody ?? structuredClone(existing.body as TemplateBody);
      const stored = await materializeTemplateImages(body, input.coverObjectKey === undefined ? existing.coverObjectKey : input.coverObjectKey, { workspaceId: c.get("workspace").id, userId: c.get("user").id, templateId: existing.id, official: existing.workspaceId === null, existingKeys: new Set(oldKeys), cleanups, temporaryKeys });
      const [updated] = await tx.update(templates).set({ ...input, ...stored, estimateCredits: estimatedCredits(body), updatedAt: new Date() }).where(eq(templates.id, existing.id)).returning();
      return updated;
    });
  } finally { for (const cleanup of cleanups) await finishObjectCleanup(cleanup); }
  await cleanTemporary(temporaryKeys);
  return c.json(await detail(c, template));
});
templateRoutes.delete("/:templateId", async (c) => {
  const cleanup = await db.transaction(async (tx) => {
    const template = await lockTemplate(c, tx, true);
    const cleanup = await stageObjectCleanup({ workspaceId: c.get("workspace").id, templateId: template.id, official: template.workspaceId === null, objectKeys: templateObjectKeys(template.body as TemplateBody, template.coverObjectKey) });
    if (template.workspaceId === null) await tx.update(templates).set({ isPublished: false, updatedAt: new Date() }).where(eq(templates.id, template.id));
    else await tx.delete(templates).where(eq(templates.id, template.id));
    return cleanup;
  });
  await finishObjectCleanup(cleanup);
  return c.body(null, 204);
});
templateRoutes.post("/:templateId/use", async (c) => {
  await db.transaction(async (tx) => { const template = await lockTemplate(c, tx, false); await tx.update(templates).set({ useCount: sql`${templates.useCount} + 1` }).where(eq(templates.id, template.id)); });
  return c.body(null, 204);
});
