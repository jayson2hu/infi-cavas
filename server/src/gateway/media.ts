import { invariant } from "../lib/errors";
import { imageSize } from "image-size";

export function validateImageBytes(bytes: Uint8Array, mimeType: string, mask = false) {
  let size: ReturnType<typeof imageSize> | undefined;
  try { size = imageSize(bytes); } catch { /* Report one validation error for malformed image headers. */ }
  const type = size && ({ png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as Record<string, string>)[size.type ?? ""];
  invariant(size && size.width > 0 && size.height > 0 && type && mimeType === type && (!mask || type === "image/png"), 422, "invalid_reference_file", "参考图片格式与文件内容不匹配，请使用 PNG、JPEG 或 WebP");
  return { width: size.width, height: size.height, mimeType: type };
}

export async function validateReferenceImages(body: FormData) {
  const imageFields = new Set(["image", "image[]", "first_frame", "last_frame", "mask"]);
  for (const [field, entry] of body.entries()) {
    if (!imageFields.has(field)) continue;
    const value: unknown = entry;
    invariant(value instanceof File && value.size > 0, 422, "invalid_reference_file", "参考图片必须是有效文件");
    validateImageBytes(new Uint8Array(await value.arrayBuffer()), value.type, field === "mask");
  }
}

export function assertNoMediaSecret(bytes: Uint8Array, secrets: string[]) {
  invariant(!secrets.some((secret) => secret && Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from(secret))), 502, "invalid_upstream_media", "供应商返回的媒体内容不合法");
}

export function guardMediaStream(body: ReadableStream<Uint8Array>, secrets: string[]) {
  const keep = Math.max(0, ...secrets.map((secret) => Buffer.byteLength(secret) - 1));
  let tail = new Uint8Array();
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const bytes = new Uint8Array(tail.length + chunk.length);
      bytes.set(tail); bytes.set(chunk, tail.length);
      assertNoMediaSecret(bytes, secrets);
      const end = Math.max(0, bytes.length - keep);
      if (end) controller.enqueue(bytes.slice(0, end));
      tail = bytes.slice(end);
    },
    flush(controller) { if (tail.length) controller.enqueue(tail); },
  }));
}
