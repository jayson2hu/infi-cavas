import { z } from "zod";
import { validateImageBytes } from "../gateway/media";
import { ApiError, invariant } from "./errors";
import { id } from "./ids";
import { assertWorkspaceObject, headObject, readObject, signPut } from "./s3";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const uploadSchema = z.object({ purpose: z.enum(["brand_asset", "template_cover", "template_image", "avatar"]), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), bytes: z.number().int().positive().max(MAX_IMAGE_BYTES) });
export type UploadPurpose = z.infer<typeof uploadSchema>["purpose"];
export const imageExtension = (mimeType: string) => ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[mimeType];

export async function presignUpload(workspaceId: string, userId: string, input: z.infer<typeof uploadSchema>) {
  const objectKey = `ws/${workspaceId}/uploads/${input.purpose}/${id("upl")}.${imageExtension(input.mimeType)}`;
  const metadata = { workspace: workspaceId, user: userId, purpose: input.purpose, bytes: String(input.bytes), mime: input.mimeType };
  const uploadUrl = await signPut(objectKey, input.mimeType, input.bytes, metadata);
  return { uploadUrl, objectKey, headers: { "Content-Type": input.mimeType, ...Object.fromEntries(Object.entries(metadata).map(([key, value]) => [`x-amz-meta-${key}`, value])) } };
}

export async function readUploadedImage(objectKey: string, workspaceId: string, userId: string, purpose: UploadPurpose) {
  assertWorkspaceObject(objectKey, workspaceId);
  invariant(objectKey.startsWith(`ws/${workspaceId}/uploads/${purpose}/`), 403, "upload_forbidden", "上传文件用途不匹配");
  try {
    const head = await headObject(objectKey);
    invariant(head.Metadata?.workspace === workspaceId && head.Metadata?.user === userId && head.Metadata?.purpose === purpose, 403, "upload_forbidden", "无权关联此上传文件");
    invariant(head.ContentLength && head.ContentLength <= MAX_IMAGE_BYTES && head.ContentLength === Number(head.Metadata.bytes), 422, "invalid_upload_size", "上传图片大小与声明不符或超过20MB");
    invariant(head.ContentType === head.Metadata.mime && ["image/png", "image/jpeg", "image/webp"].includes(head.ContentType ?? ""), 422, "invalid_upload_type", "只支持 PNG、JPEG 或 WebP 图片");
    const object = await readObject(objectKey);
    invariant(object.bytes.length === head.ContentLength && object.mimeType === head.ContentType, 422, "upload_changed", "上传文件发生变化，请重新上传");
    return { bytes: object.bytes, ...validateImageBytes(object.bytes, object.mimeType) };
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) throw new ApiError(422, "upload_not_found", "上传文件不存在，请先上传图片");
    throw error;
  }
}
