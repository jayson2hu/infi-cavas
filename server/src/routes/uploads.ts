import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { templates } from "../db/schema";
import type { TemplateBody } from "../../../shared/template";
import { templateObjectKeys } from "../templates/validation";
import type { AppEnv } from "../lib/context";
import { ApiError, invariant } from "../lib/errors";
import { assertWorkspaceObject, signGet } from "../lib/s3";
import { presignUpload, uploadSchema } from "../lib/uploads";
import { requireSession, requireWorkspace, requireWorkspaceRoleInTransaction, workspaceContext } from "../middleware/session";

export const uploadRoutes = new Hono<AppEnv>();
uploadRoutes.use("*", requireSession, requireWorkspace);
uploadRoutes.post("/presign", async (c) => {
  const input = uploadSchema.parse(await c.req.json());
  return c.json(await db.transaction(async (tx) => {
    await requireWorkspaceRoleInTransaction(tx, c.get("workspace").id, c.get("user").id, ["owner", "admin", "member"]);
    return presignUpload(c.get("workspace").id, c.get("user").id, input);
  }));
});

export const fileRoutes = new Hono<AppEnv>();
fileRoutes.use("*", requireSession);
fileRoutes.get("/*", async (c) => {
  let objectKey: string;
  try { objectKey = decodeURIComponent(c.req.path.slice("/api/files/".length)); }
  catch { throw new ApiError(403, "file_forbidden", "文件路径不合法"); }
  if (objectKey.startsWith("official/templates/")) {
    await workspaceContext(c);
    const [template] = await db.select().from(templates).where(and(eq(templates.id, objectKey.split("/")[2]), isNull(templates.workspaceId), eq(templates.isPublished, true)));
    invariant(template && templateObjectKeys(template.body as TemplateBody, template.coverObjectKey).includes(objectKey), 403, "file_forbidden", "无权访问此文件");
    c.header("Cache-Control", "private, no-store");
    return c.redirect(await signGet(objectKey), 302);
  }
  const workspaceId = objectKey.split("/")[1];
  invariant(workspaceId && (!c.req.header("X-IC-Workspace") || c.req.header("X-IC-Workspace") === workspaceId), 403, "file_forbidden", "无权访问此文件");
  assertWorkspaceObject(objectKey, workspaceId);
  await workspaceContext(c, workspaceId);
  c.header("Cache-Control", "private, no-store");
  return c.redirect(await signGet(objectKey), 302);
});
