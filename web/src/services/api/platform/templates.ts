import i18n from "@/i18n";
import { platformApi } from "./client";
import { assertBrandSession } from "./brands";
import { useSessionStore } from "@/stores/use-session-store";
import { uploadImage, getImageBlob } from "@/services/image-storage";
import type { TemplateImageValue, TemplateValues } from "@/lib/templates/types";
import type { TemplateBody } from "../../../../../shared/template";
import type { CanvasNodeData } from "@/types/canvas";

export type TemplateCategory = "ecommerce" | "short_video" | "brand" | "social" | "other";
export type TemplateSummary = { id: string; scope: "official" | "team"; name: string; category: TemplateCategory; description: string; coverUrl: string | null; previewNodes: string[]; estimateCredits: number; useCount: number };
export type PlatformTemplate = TemplateSummary & { body: TemplateBody; canEdit: boolean };
export type TemplateInput = { name: string; category: TemplateCategory; description?: string; coverObjectKey?: string; previewNodes?: string[]; body: TemplateBody };
export type { TemplateImageValue, TemplateValues };
export type TemplateInsertion = { template: PlatformTemplate; values: TemplateValues; images?: Record<string, TemplateImageValue>; workspaceId: string; generation: number };
const path = (id: string) => `/templates/${encodeURIComponent(id)}`;
const context = (workspaceId: string, signal?: AbortSignal) => ({ signal, headers: { "X-IC-Workspace": workspaceId } });
export const fetchTemplates = async (workspaceId: string, params: { category?: TemplateCategory; scope?: "all" | "official" | "team"; q?: string }, signal?: AbortSignal) => (await platformApi.get<TemplateSummary[]>("/templates", { ...context(workspaceId, signal), params })).data;
export const fetchTemplate = async (workspaceId: string, id: string, signal?: AbortSignal) => (await platformApi.get<PlatformTemplate>(path(id), context(workspaceId, signal))).data;
export const createTemplate = async (workspaceId: string, input: TemplateInput) => (await platformApi.post<PlatformTemplate>("/templates", input, context(workspaceId))).data;
export const updateTemplate = async (workspaceId: string, id: string, input: TemplateInput) => (await platformApi.patch<PlatformTemplate>(path(id), input, context(workspaceId))).data;
export const deleteTemplate = async (workspaceId: string, id: string) => { await platformApi.delete(path(id), context(workspaceId)); };
export const useTemplate = async (workspaceId: string, id: string) => { await platformApi.post(`${path(id)}/use`, {}, context(workspaceId)); };

export async function localTemplateImage(file: Blob, workspaceId: string, generation: number): Promise<TemplateImageValue> {
    assertBrandSession(workspaceId, generation);
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size === 0 || file.size > 20971520) throw new Error(i18n.t("platform.brandUploadLimit"));
    const image = await uploadImage(file instanceof File ? file : new File([file], "template-image", { type: file.type }));
    assertBrandSession(workspaceId, generation);
    if (!image.storageKey) throw new Error(i18n.t("platform.brandUploadFailed"));
    return { content: image.url, storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height, mimeType: image.mimeType, bytes: image.bytes };
}

export async function readTemplateImage(url: string, workspaceId: string, generation: number) {
    assertBrandSession(workspaceId, generation);
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(i18n.t("platform.brandDownloadFailed"));
    return localTemplateImage(await response.blob(), workspaceId, generation);
}

export async function prepareTemplateInsertion(input: TemplateInsertion): Promise<TemplateInsertion> {
    assertBrandSession(input.workspaceId, input.generation);
    const body = input.template.body;
    const images: Record<string, TemplateImageValue> = {};
    const boundImages = new Set(body.variables.filter((variable) => variable.type === "image").map((variable) => variable.bindNode));
    await Promise.all(body.ops.map(async (op) => {
        if (op.type !== "add_node" || op.nodeType !== "image" || boundImages.has(op.id) || typeof op.metadata?.content !== "string" || !op.metadata.content) return;
        images[op.id] = await readTemplateImage(op.metadata.content, input.workspaceId, input.generation);
    }));
    assertBrandSession(input.workspaceId, input.generation);
    return { ...input, images };
}

export async function uploadTemplateImage(workspaceId: string, file: Blob, purpose: "template_image" | "template_cover" = "template_image") {
    const generation = useSessionStore.getState().generation;
    assertBrandSession(workspaceId, generation);
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size === 0 || file.size > 20971520) throw new Error(i18n.t("platform.brandUploadLimit"));
    const signed = (await platformApi.post<{ uploadUrl: string; objectKey: string; headers: Record<string, string> }>("/uploads/presign", { purpose, mimeType: file.type, bytes: file.size }, context(workspaceId))).data;
    assertBrandSession(workspaceId, generation);
    const response = await fetch(signed.uploadUrl, { method: "PUT", headers: signed.headers, body: file, credentials: "omit" });
    if (!response.ok) throw new Error(i18n.t("platform.brandUploadFailed"));
    assertBrandSession(workspaceId, generation);
    return signed.objectKey;
}

export async function permanentTemplateImage(node: CanvasNodeData, workspaceId: string, generation: number) {
    assertBrandSession(workspaceId, generation);
    const blob = node.metadata?.storageKey ? await getImageBlob(node.metadata.storageKey) : node.metadata?.content ? await fetch(node.metadata.content, { credentials: "same-origin" }).then((response) => { if (!response.ok) throw new Error(i18n.t("platform.brandDownloadFailed")); return response.blob(); }) : null;
    if (!blob) throw new Error(i18n.t("platform.brandDownloadFailed"));
    assertBrandSession(workspaceId, generation);
    const objectKey = await uploadTemplateImage(workspaceId, blob);
    assertBrandSession(workspaceId, generation);
    return `/api/files/${objectKey}`;
}
