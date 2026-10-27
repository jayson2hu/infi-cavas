import type { TemplateBody } from "../../../shared/template";
import { invariant } from "../lib/errors";
import { id } from "../lib/ids";
import { stageObjectCleanup } from "../lib/object-cleanup";
import { fileUrl, putObject } from "../lib/s3";
import { imageExtension, readUploadedImage, type UploadPurpose } from "../lib/uploads";
import { templateImageReferences, templateObjectKey } from "./validation";

type TemplateStorage = { workspaceId: string; userId: string; templateId: string; official: boolean; existingKeys: Set<string>; cleanups: string[]; temporaryKeys: Set<string> };

// The caller holds workspace and template locks until the rewritten body is committed.
export async function materializeTemplateImages(body: TemplateBody, coverObjectKey: string | null, context: TemplateStorage) {
  const copied = new Map<string, { key: string; width?: number; height?: number; mimeType?: string; bytes?: number }>();
  const prefix = `${context.official ? "official" : `ws/${context.workspaceId}`}/templates/${context.templateId}/`;
  const freeze = async (source: string, purpose: UploadPurpose) => {
    if (context.existingKeys.has(source)) {
      invariant(source.startsWith(prefix), 403, "template_image_forbidden", "图片不属于此模板");
      return { key: source };
    }
    const previous = copied.get(`${purpose}:${source}`);
    if (previous) return previous;
    const image = await readUploadedImage(source, context.workspaceId, context.userId, purpose);
    const key = `${prefix}${id("img")}.${imageExtension(image.mimeType)}`;
    const cleanup = await stageObjectCleanup({ workspaceId: context.workspaceId, templateId: context.templateId, official: context.official, objectKeys: [key] });
    if (cleanup) context.cleanups.push(cleanup);
    await putObject(key, image.bytes, image.mimeType);
    const result = { key, width: image.width, height: image.height, mimeType: image.mimeType, bytes: image.bytes.length };
    copied.set(`${purpose}:${source}`, result);
    context.temporaryKeys.add(source);
    return result;
  };
  for (const reference of templateImageReferences(body)) {
    const image = await freeze(templateObjectKey(reference.value), "template_image");
    reference.set(fileUrl(image.key));
    if (reference.metadata && image.width) Object.assign(reference.metadata, { naturalWidth: image.width, naturalHeight: image.height, mimeType: image.mimeType, bytes: image.bytes });
  }
  return { body, coverObjectKey: coverObjectKey ? (await freeze(templateObjectKey(fileUrl(coverObjectKey)), "template_cover")).key : null };
}
