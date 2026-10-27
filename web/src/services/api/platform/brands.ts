import { platformApi } from "./client";
import { useSessionStore } from "@/stores/use-session-store";
import i18n from "@/i18n";

export type BrandColor = { id?: string; name: string; role: "primary" | "secondary" | "background" | "accent"; hex: string; sort?: number };
export type BrandAsset = { id: string; kind: "logo" | "sku" | "style_ref"; title: string; spec: string | null; url: string; width: number | null; height: number | null; attachOnGenerate: boolean; tags: string[]; sort: number };
export type BrandInput = { name: string; industry?: string | null; description?: string | null; requiredTerms?: string[]; avoidTerms?: string[]; defaultParams?: Record<string, unknown>; enforced?: boolean; editorUserIds?: string[] };
export type BrandSummary = { id: string; name: string; industry: string | null; isDefault: boolean; logoUrl: string | null; colors: BrandColor[]; skuCount: number; usedInProjects: number; updatedAt: string };
export type Brand = BrandSummary & BrandInput & { requiredTerms: string[]; avoidTerms: string[]; defaultParams: Record<string, unknown>; enforced: boolean; editorUserIds: string[]; assets: BrandAsset[]; canEdit: boolean };
export type BrandRules = Pick<Brand, "id" | "name" | "requiredTerms" | "avoidTerms" | "colors" | "enforced" | "defaultParams">;
const path = (id: string) => `/brands/${encodeURIComponent(id)}`;
const context = (workspaceId: string, signal?: AbortSignal) => ({ signal, headers: { "X-IC-Workspace": workspaceId } });
export const fetchBrands = async (workspaceId: string, signal?: AbortSignal) => (await platformApi.get<BrandSummary[]>("/brands", context(workspaceId, signal))).data;
export const fetchBrand = async (workspaceId: string, id: string, signal?: AbortSignal) => (await platformApi.get<Brand>(path(id), context(workspaceId, signal))).data;
export const createBrand = async (workspaceId: string, input: BrandInput) => (await platformApi.post<Brand>("/brands", input, context(workspaceId))).data;
export const updateBrand = async (workspaceId: string, id: string, input: Partial<BrandInput>) => (await platformApi.patch<Brand>(path(id), input, context(workspaceId))).data;
export const deleteBrand = async (workspaceId: string, id: string) => { await platformApi.delete(path(id), context(workspaceId)); };
export const replaceBrandColors = async (workspaceId: string, id: string, colors: BrandColor[]) => (await platformApi.put<BrandColor[]>(`${path(id)}/colors`, colors, context(workspaceId))).data;
export const updateBrandAsset = async (workspaceId: string, id: string, assetId: string, input: Partial<Pick<BrandAsset, "title" | "spec" | "attachOnGenerate" | "sort" | "tags">>) => (await platformApi.patch<BrandAsset>(`${path(id)}/assets/${encodeURIComponent(assetId)}`, input, context(workspaceId))).data;
export const deleteBrandAsset = async (workspaceId: string, id: string, assetId: string) => { await platformApi.delete(`${path(id)}/assets/${encodeURIComponent(assetId)}`, context(workspaceId)); };
export const fetchBrandPreview = async (workspaceId: string, id: string, params: { prompt: string; modelId?: string; capability?: "image" | "text" }, signal?: AbortSignal) => (await platformApi.get<{ text: string; attachedReferenceCount: number }>(`${path(id)}/injection-preview`, { ...context(workspaceId, signal), params })).data;

export function assertBrandSession(workspaceId: string, generation: number) {
    const session = useSessionStore.getState();
    if (workspaceId !== session.currentWorkspaceId || generation !== session.generation) throw new Error(i18n.t("platform.brandContextChanged"));
}
export async function uploadBrandAsset(workspaceId: string, id: string, file: File, input: { kind: BrandAsset["kind"]; title: string; spec?: string; tags?: string[]; attachOnGenerate?: boolean }) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 20971520 || file.size === 0) throw new Error(i18n.t("platform.brandUploadLimit"));
    const generation = useSessionStore.getState().generation;
    assertBrandSession(workspaceId, generation);
    const signed = (await platformApi.post<{ uploadUrl: string; objectKey: string; headers: Record<string, string> }>("/uploads/presign", { purpose: "brand_asset", mimeType: file.type, bytes: file.size }, context(workspaceId))).data;
    assertBrandSession(workspaceId, generation);
    const uploaded = await fetch(signed.uploadUrl, { method: "PUT", headers: signed.headers, body: file, credentials: "omit" });
    if (!uploaded.ok) throw new Error(i18n.t("platform.brandUploadFailed"));
    assertBrandSession(workspaceId, generation);
    return (await platformApi.post<BrandAsset>(`${path(id)}/assets`, { ...input, objectKey: signed.objectKey }, context(workspaceId))).data;
}
export async function downloadBrandAsset(workspaceId: string, asset: BrandAsset) {
    const generation = useSessionStore.getState().generation;
    assertBrandSession(workspaceId, generation);
    const response = await fetch(asset.url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(i18n.t("platform.brandDownloadFailed"));
    const blob = await response.blob();
    assertBrandSession(workspaceId, generation);
    return new File([blob], asset.title, { type: blob.type });
}
