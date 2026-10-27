import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { modelRoutes, providers } from "../db/schema";
import { decryptSecret } from "../lib/crypto";
import { ApiError, invariant } from "../lib/errors";

export type Provider = typeof providers.$inferSelect;
export type UpstreamFetch = typeof fetch;
export const redactSecrets = (value: string, secrets: string[]) => secrets.reduce((text, secret) => secret ? text.split(secret).join("[REDACTED]") : text, value);
export function redactPayload(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactSecrets(key, secrets), redactPayload(item, secrets)]));
  return value;
}
export const providerUrl = (baseUrl: string, endpoint: string) => `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/${endpoint.replace(/^\//, "")}`;
export const timeoutFor = (endpoint: string) => endpoint === "responses" ? 300000 : endpoint === "audio/speech" ? 120000 : 600000;

export async function upstreamError(response: Response, secrets: string[]) {
  const text = await response.text();
  let message = "模型供应商请求失败";
  try {
    const body = JSON.parse(text);
    const candidate = body.error?.message ?? body.message;
    if (typeof candidate === "string") message = redactSecrets(candidate, secrets);
  } catch { /* HTML and arbitrary transport errors are not exposed. */ }
  return new ApiError(response.status >= 400 && response.status <= 599 ? response.status as 502 : 502, "upstream_error", message);
}

export async function fetchProvider(provider: Provider, endpoint: string, request: RequestInit, fetcher: UpstreamFetch = fetch) {
  const key = decryptSecret(provider.apiKeyEncrypted);
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${key}`);
  try {
    const response = await fetcher(providerUrl(provider.baseUrl, endpoint), { ...request, headers, redirect: "error" });
    return { response, key };
  } catch (error) {
    if (request.signal?.aborted) throw error;
    throw new ApiError(502, "upstream_unreachable", "无法连接模型供应商");
  }
}

export async function forwardModel(modelId: string, endpoint: string, body: Record<string, unknown> | FormData, signal: AbortSignal, fetcher: UpstreamFetch = fetch) {
  const routes = await db.select({ route: modelRoutes, provider: providers }).from(modelRoutes).innerJoin(providers, eq(providers.id, modelRoutes.providerId)).where(and(eq(modelRoutes.modelId, modelId), eq(providers.isActive, true))).orderBy(asc(modelRoutes.priority));
  invariant(routes.length, 503, "provider_unavailable", "此模型尚未配置可用供应商");
  const secrets: string[] = [];
  let lastError: unknown;
  for (const { route, provider } of routes) {
    if (signal.aborted) throw signal.reason;
    const deadline = AbortSignal.timeout(timeoutFor(endpoint));
    const combined = AbortSignal.any([signal, deadline]);
    const headers = new Headers();
    let payload: string | FormData;
    if (body instanceof FormData) {
      payload = new FormData();
      for (const [name, value] of body.entries()) payload.append(name, value);
      payload.set("model", route.upstreamModel);
    } else {
      payload = JSON.stringify({ ...body, model: route.upstreamModel });
      headers.set("Content-Type", "application/json");
    }
    const key = decryptSecret(provider.apiKeyEncrypted);
    secrets.push(key);
    try {
      const result = await fetchProvider(provider, endpoint, { method: "POST", body: payload, headers, signal: combined }, fetcher);
      if (result.response.status >= 500) { lastError = await upstreamError(result.response, secrets); continue; }
      if (!result.response.ok) throw await upstreamError(result.response, secrets);
      return { ...result, provider, secrets, signal: combined };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ApiError && error.status < 500) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof ApiError ? lastError : new ApiError(504, "upstream_timeout", "模型供应商响应超时");
}
