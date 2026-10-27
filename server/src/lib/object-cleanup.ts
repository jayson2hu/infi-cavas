import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { brandAssets, brands, templates, workspaces } from "../db/schema";
import { env } from "../env";
import { templateObjectKeys } from "../templates/validation";
import type { TemplateBody } from "../../../shared/template";
import { invariant } from "./errors";
import { id } from "./ids";
import { assertWorkspaceObject, deleteObject, listObjectKeys, putObject, readObject } from "./s3";

export function objectCleanupPrefix(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const database = JSON.stringify([url.hostname.toLowerCase(), url.port || "5432", decodeURIComponent(url.pathname)]);
  return `internal/cleanup/${createHash("sha256").update(database).digest("hex")}/`;
}
const prefix = objectCleanupPrefix(env.DATABASE_URL);
const cleanupSchema = z.object({ version: z.literal(1), workspaceId: z.string(), brandId: z.string().optional(), assetId: z.string().optional(), templateId: z.string().optional(), official: z.boolean().optional(), objectKeys: z.array(z.string()).min(1) }).strict().refine((task) => Boolean(task.brandId) !== Boolean(task.templateId) && (!task.assetId || task.brandId) && (!task.official || task.templateId));
type Cleanup = z.infer<typeof cleanupSchema>;

function validateKeys(task: Cleanup) {
  for (const objectKey of task.objectKeys) {
    if (!task.official) assertWorkspaceObject(objectKey, task.workspaceId);
    const target = task.templateId ? `${task.official ? "official" : `ws/${task.workspaceId}`}/templates/${task.templateId}/` : `ws/${task.workspaceId}/brands/${task.brandId}/`;
    invariant(objectKey.startsWith(target) && !/[\\\u0000-\u001f?#]/.test(objectKey) && !objectKey.split("/").some((part) => !part || part === "." || part === ".."), 403, "cleanup_forbidden", "清理任务不能访问目标资源以外的对象");
  }
}

// Call while holding the workspace lock and before removing the database records.
export async function stageObjectCleanup(input: Omit<Cleanup, "version">) {
  if (!input.objectKeys.length) return null;
  const task = cleanupSchema.parse({ version: 1, ...input });
  validateKeys(task);
  const key = `${prefix}${id("cleanup")}.json`;
  await putObject(key, new TextEncoder().encode(JSON.stringify(task)), "application/json");
  return key;
}

export async function runObjectCleanup(key: string, remove: typeof deleteObject = deleteObject) {
  invariant(key.startsWith(prefix) && !key.slice(prefix.length).includes("/"), 403, "cleanup_forbidden", "清理任务路径不合法");
  let bytes: Uint8Array;
  try { bytes = (await readObject(key)).bytes; }
  catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return "missing"; throw error; }
  const task = cleanupSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  validateKeys(task);
  return db.transaction(async (tx) => {
    // The deleter holds this lock until commit/rollback; a sweep cannot race its pending transaction.
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, task.workspaceId)).for("update");
    if (task.templateId) {
      const [template] = await tx.select().from(templates).where(eq(templates.id, task.templateId)).for("update");
      const retained = new Set(template && (template.workspaceId !== null || template.isPublished) ? templateObjectKeys(template.body as TemplateBody, template.coverObjectKey) : []);
      const unused = task.objectKeys.filter((objectKey) => !retained.has(objectKey));
      for (const objectKey of unused) await remove(objectKey);
      await deleteObject(key);
      return unused.length ? "completed" : "cancelled";
    }
    const remaining = task.assetId
      ? await tx.select({ id: brandAssets.id }).from(brandAssets).where(eq(brandAssets.id, task.assetId))
      : await tx.select({ id: brands.id }).from(brands).where(eq(brands.id, task.brandId!));
    if (!remaining.length) for (const objectKey of task.objectKeys) await remove(objectKey);
    await deleteObject(key);
    return remaining.length ? "cancelled" : "completed";
  });
}

export async function finishObjectCleanup(key: string | null) {
  if (!key) return;
  try { await runObjectCleanup(key); }
  catch { console.error(JSON.stringify({ event: "object_cleanup_pending", task: key.slice(prefix.length) })); }
}

export async function sweepObjectCleanups(remove: typeof deleteObject = deleteObject) {
  const stats = { checked: 0, completed: 0, cancelled: 0, errors: 0 };
  for await (const key of listObjectKeys(prefix)) {
    stats.checked++;
    try { const result = await runObjectCleanup(key, remove); if (result === "completed" || result === "cancelled") stats[result]++; }
    catch { stats.errors++; console.error(JSON.stringify({ event: "object_cleanup_pending", task: key.slice(prefix.length) })); }
  }
  return stats;
}
