import axios from "axios";
import { isPlatformEnabled, isPlatformGatewayUrl } from "@/lib/platform";
import { useCreditsStore } from "@/stores/use-credits-store";
import { useSessionStore } from "@/stores/use-session-store";
import type { CreditError } from "./types";

function getHeader(headers: unknown, name: string) {
    const source = headers as { get?: (key: string) => unknown; [key: string]: unknown } | undefined;
    return source?.get ? source.get(name) : source?.[name.toLowerCase()];
}
export function recordPlatformHeaders(headers: unknown, workspaceId: string | null, generation: number) {
    const raw = getHeader(headers, "X-IC-Credits-Balance");
    if (workspaceId && raw !== null && raw !== undefined && raw !== "") useCreditsStore.getState().setBalance(workspaceId, Number(raw), generation);
}
export async function recordPlatformError(status: number, payload: unknown, workspaceId: string | null, generation: number) {
    if (status !== 402 || workspaceId !== useSessionStore.getState().currentWorkspaceId || generation !== useSessionStore.getState().generation) return;
    if (payload instanceof Blob) { try { payload = JSON.parse(await payload.text()); } catch { return; } }
    if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch { return; } }
    if (workspaceId !== useSessionStore.getState().currentWorkspaceId || generation !== useSessionStore.getState().generation) return;
    const error = (payload as { error?: CreditError })?.error;
    if (error?.code === "insufficient_credits" || error?.code === "member_cap_exceeded") useCreditsStore.getState().showError(error, generation);
}
export async function refreshPlatformCredits(workspaceId: string | null, generation: number) {
    if (workspaceId && generation === useSessionStore.getState().generation) await useCreditsStore.getState().refresh(workspaceId).catch(() => undefined);
}

// Observe only the same-origin platform gateway; BYOK requests retain their original behavior.
if (isPlatformEnabled()) {
    axios.interceptors.request.use((config) => {
        if (isPlatformGatewayUrl(config.url || "")) { config.withCredentials = true; config.icSessionGeneration = useSessionStore.getState().generation; }
        return config;
    });
    axios.interceptors.response.use((response) => {
        if (isPlatformGatewayUrl(response.config.url || "")) {
            const workspaceId = String(response.config.headers.get("X-IC-Workspace") || "") || null;
            const generation = response.config.icSessionGeneration!;
            recordPlatformHeaders(response.headers, workspaceId, generation);
            if (getHeader(response.headers, "X-IC-Credits-Balance") !== undefined) void refreshPlatformCredits(workspaceId, generation);
        }
        return response;
    }, async (error) => {
        if (isPlatformGatewayUrl(error.config?.url || "")) {
            const workspaceId = String(error.config?.headers?.get?.("X-IC-Workspace") || "") || null;
            const generation = error.config?.icSessionGeneration;
            if (error.response?.data instanceof Blob) {
                try { error.response.data = JSON.parse(await error.response.data.text()); } catch { /* Preserve a non-JSON upstream error. */ }
            }
            recordPlatformHeaders(error.response?.headers, workspaceId, generation);
            await recordPlatformError(error.response?.status, error.response?.data, workspaceId, generation);
            void refreshPlatformCredits(workspaceId, generation);
        }
        return Promise.reject(error);
    });
}
