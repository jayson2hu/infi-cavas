import { and, asc, eq } from "drizzle-orm";
import { db, type Transaction } from "../db/client";
import { brandAssets, brandColors, brands } from "../db/schema";
import { requireWorkspaceRoleInTransaction } from "../middleware/session";
import { invariant } from "./errors";

export async function loadBrand(workspaceId: string, brandId: string, client: typeof db | Transaction = db) {
  const [brand] = await client.select().from(brands).where(and(eq(brands.id, brandId), eq(brands.workspaceId, workspaceId)));
  invariant(brand, 404, "brand_not_found", "品牌不存在或不属于此工作区");
  const colors = await client.select().from(brandColors).where(eq(brandColors.brandId, brandId)).orderBy(asc(brandColors.sort), asc(brandColors.id));
  const assets = await client.select().from(brandAssets).where(eq(brandAssets.brandId, brandId)).orderBy(asc(brandAssets.sort), asc(brandAssets.createdAt), asc(brandAssets.id));
  return { ...brand, colors, assets };
}

export async function lockEditableBrand(tx: Transaction, workspaceId: string, userId: string, brandId: string) {
  const membership = await requireWorkspaceRoleInTransaction(tx, workspaceId, userId, ["owner", "admin", "member"]);
  const [brand] = await tx.select().from(brands).where(and(eq(brands.id, brandId), eq(brands.workspaceId, workspaceId))).for("update");
  invariant(brand, 404, "brand_not_found", "品牌不存在或不属于此工作区");
  invariant(membership.role !== "member" || brand.editorUserIds.includes(userId), 403, "brand_readonly", "没有编辑此品牌的权限");
  return { brand, membership };
}
