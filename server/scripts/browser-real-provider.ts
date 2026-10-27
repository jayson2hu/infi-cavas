/** Explicit paid acceptance only. Never used by the application or ordinary tests. */
import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import type { BrowserRequestContext } from "./browser-controlled-provider";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function createBrowserRealImageProvider(origin: string, context: () => BrowserRequestContext | undefined) {
  const rows: Record<string, unknown>[] = [];
  const nativeFetch = fetch;
  async function forward(input: string | URL | Request, init?: RequestInit) {
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (target.origin !== origin || !["/v1/images/generations", "/v1/images/edits"].includes(target.pathname) || init?.method !== "POST") throw new Error("真实验收仅允许指定图片供应商端点");
    const values = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].filter(([, value]) => typeof value === "string")) : typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (values.model !== "gpt-image-2" || Number(values.n ?? 1) !== 1 || rows.length >= 8) throw new Error("真实验收仅允许8次gpt-image-2单图请求");
    const row: Record<string, unknown> = { ...context(), sequence: rows.length + 1, endpoint: target.pathname, model: values.model, n: 1, size: values.size, inputHashes: [], outputHashes: [], outputSizes: [], status: "running", startedAt: Date.now() };
    // Reserve the bounded slot before any await; concurrent requests cannot exceed eight.
    rows.push(row);
    if (init.body instanceof FormData) for (const [name, value] of init.body.entries()) {
      const file: unknown = value;
      if (["image", "image[]"].includes(name) && file instanceof File) (row.inputHashes as string[]).push(hash(new Uint8Array(await file.arrayBuffer())));
    }
    try {
      const response = await nativeFetch(input, { ...init, redirect: "error" });
      row.httpStatus = response.status;
      if (response.ok) {
        const payload = await response.clone().json() as { data?: { b64_json?: string }[] };
        for (const item of payload.data ?? []) if (item.b64_json) {
          const bytes = Buffer.from(item.b64_json, "base64");
          (row.outputHashes as string[]).push(hash(bytes));
          const size = imageSize(bytes);
          (row.outputSizes as unknown[]).push({ width: size.width, height: size.height, bytes: bytes.length });
        }
      }
      row.status = response.ok ? "succeeded" : "failed";
      return response;
    } catch (error) { row.status = init?.signal?.aborted ? "cancelled" : "failed"; throw error; }
    finally { row.finishedAt = Date.now(); }
  }
  return { fetch: Object.assign(forward, { preconnect: fetch.preconnect }) as typeof fetch, traces: () => rows.map((row) => ({ ...row })) };
}
