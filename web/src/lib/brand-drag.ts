import { assertBrandSession, downloadBrandAsset, fetchBrand } from "@/services/api/platform/brands";
import { useSessionStore } from "@/stores/use-session-store";
import i18n from "@/i18n";

export const BRAND_ASSET_DRAG_TYPE = "application/x-infinite-canvas-brand-asset";
export type BrandAssetDrag = { workspaceId: string; generation: number; brandId: string; assetId: string };
export function parseBrandAssetDrag(value: string): BrandAssetDrag | null {
    try { const data = JSON.parse(value); return typeof data?.workspaceId === "string" && Number.isSafeInteger(data.generation) && typeof data.brandId === "string" && typeof data.assetId === "string" ? data : null; } catch { return null; }
}
export async function brandAssetFile(data: BrandAssetDrag) {
    assertBrandSession(data.workspaceId, data.generation);
    const brand = await fetchBrand(data.workspaceId, data.brandId);
    assertBrandSession(data.workspaceId, data.generation);
    const asset = brand.assets.find((asset) => asset.id === data.assetId && asset.kind === "sku");
    if (!asset) throw new Error(i18n.t("platform.brandAssetMissing"));
    return downloadBrandAsset(data.workspaceId, asset);
}
export function brandAssetDrag(brandId: string, assetId: string): BrandAssetDrag {
    const session = useSessionStore.getState();
    return { workspaceId: session.currentWorkspaceId || "", generation: session.generation, brandId, assetId };
}
