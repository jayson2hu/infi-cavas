import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { applyBrandDefaults, injectBrand, selectBrandId, type BrandCapability } from "../../../shared/brand-inject";
import { db } from "../db/client";
import { brands } from "../db/schema";
import type { AppEnv } from "../lib/context";
import { loadBrand } from "../lib/brands";
import { assertWorkspaceObject, readObject } from "../lib/s3";
import { imageExtension } from "../lib/uploads";
import { validateImageBytes } from "./media";

export { injectBrand, selectBrandId, applyBrandDefaults } from "../../../shared/brand-inject";
export type GatewayBody = Record<string, unknown> | FormData;
export const bodyParams = (body: GatewayBody): Record<string, unknown> => body instanceof FormData ? Object.fromEntries([...body.entries()].filter(([, value]) => typeof value === "string")) : body;

export async function resolveBrand(c: Context<AppEnv>) {
  const workspace = c.get("workspace");
  const [defaultBrand] = workspace.defaultBrandId ? await db.select({ id: brands.id, enforced: brands.enforced }).from(brands).where(and(eq(brands.id, workspace.defaultBrandId), eq(brands.workspaceId, workspace.id))) : [];
  const brandId = selectBrandId(c.req.header("X-IC-Brand"), defaultBrand);
  return brandId ? loadBrand(workspace.id, brandId) : null;
}

export function withBrandDefaults(body: GatewayBody, brand: Awaited<ReturnType<typeof resolveBrand>>, capability: BrandCapability) {
  const params = applyBrandDefaults(brand?.defaultParams ?? {}, bodyParams(body), capability);
  if (!(body instanceof FormData)) return params;
  for (const [key, value] of Object.entries(params)) if (!body.has(key)) body.set(key, String(value));
  return body;
}

export async function injectGatewayBrand(input: { body: GatewayBody; brand: Awaited<ReturnType<typeof resolveBrand>>; capability: BrandCapability; endpoint: string; supportsEdit: boolean; maxReferenceImages: number; originalReferenceCount: number; signal: AbortSignal }) {
  const params = bodyParams(input.body);
  const injection = injectBrand({ ...input, prompt: String(params.prompt ?? params.input ?? "") });
  if (!input.brand) return { body: input.body, endpoint: input.endpoint };
  let body = input.body;
  const field = input.capability === "text" || input.capability === "audio" ? "instructions" : "prompt";
  const text = field === "instructions" ? [injection.instructions, params.instructions].filter(Boolean).join("\n") : injection.text;
  if (body instanceof FormData) body.set(field, text); else body = { ...body, [field]: text };
  if (injection.referenceKeys.length) {
    if (!(body instanceof FormData)) {
      const form = new FormData();
      for (const [key, value] of Object.entries(body)) if (value !== undefined && value !== null) form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      body = form;
    }
    const originals = [...body.entries()].filter(([key]) => key === "image" || key === "image[]").map(([, value]) => value);
    body.delete("image"); body.delete("image[]");
    for (const value of originals) body.append("image[]", value);
    for (const [index, objectKey] of injection.referenceKeys.entries()) {
      input.signal.throwIfAborted();
      assertWorkspaceObject(objectKey, input.brand.workspaceId);
      const image = await readObject(objectKey);
      validateImageBytes(image.bytes, image.mimeType);
      body.append("image[]", new File([new Uint8Array(image.bytes)], `brand-${index + 1}.${imageExtension(image.mimeType)}`, { type: image.mimeType }));
    }
  }
  input.signal.throwIfAborted();
  return { body, endpoint: injection.endpoint };
}
