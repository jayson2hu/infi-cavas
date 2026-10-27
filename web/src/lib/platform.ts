import { ALLOW_BYOK, PLATFORM_API_BASE } from "@/constant/runtime-config";
import type { AiConfig } from "@/stores/use-config-store";
import { useSessionStore } from "@/stores/use-session-store";
import i18n from "@/i18n";
import { effectiveBrand } from "@/lib/platform-brand";

export const PLATFORM_CHANNEL_ID = "platform";
export function isPlatformEnabled() { return Boolean(PLATFORM_API_BASE); }
/** 平台模式下模型 Key 由管理后台统一管理；只有显式开启 ALLOW_BYOK（私有化部署）时用户才能自带 Key。纯前端模式始终可用。 */
export function isByokAllowed() { return !isPlatformEnabled() || ALLOW_BYOK; }
/** 本地 Agent（连接用户电脑上的 Codex）面向开发者：平台模式下仅平台管理员可见。 */
export function useLocalAgentAllowed() {
    const admin = useSessionStore((state) => Boolean(state.user?.isPlatformAdmin));
    return !isPlatformEnabled() || admin;
}

export function isPlatformGatewayUrl(value: string) {
    if (!isPlatformEnabled()) return false;
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    try {
        const candidate = new URL(value, origin);
        const gateway = new URL(`${PLATFORM_API_BASE}/gateway`, origin);
        return candidate.origin === gateway.origin && (candidate.pathname === gateway.pathname || candidate.pathname.startsWith(`${gateway.pathname}/`));
    } catch { return false; }
}

export function platformHeaders(config: Pick<AiConfig, "baseUrl" | "platformContext">): Record<string, string> {
    if (!isPlatformGatewayUrl(config.baseUrl)) return {};
    const context = config.platformContext;
    if (context?.sessionGeneration !== undefined && context.sessionGeneration !== useSessionStore.getState().generation) throw new Error(i18n.t("platform.sessionChanged"));
    if (context?.brandReady === false) throw new Error(i18n.t("platform.brandNotReady"));
    const brandId = context?.brandKit === false ? effectiveBrand(context)?.id || "none" : context?.brandId || effectiveBrand(context)?.id || (context?.brandReady ? "none" : undefined);
    const workspaceId = context?.workspaceId || useSessionStore.getState().currentWorkspaceId;
    const pathname = typeof window === "undefined" ? "" : window.location.pathname;
    const source = context?.source || (pathname.startsWith("/canvas/") ? "canvas" : pathname === "/image" ? "image-workbench" : pathname === "/video" ? "video-workbench" : "api");
    return {
        ...(workspaceId ? { "X-IC-Workspace": workspaceId } : {}),
        ...(brandId ? { "X-IC-Brand": brandId } : {}),
        ...(context?.projectId ? { "X-IC-Project": context.projectId } : {}),
        ...(context?.nodeId ? { "X-IC-Node": context.nodeId } : {}),
        "X-IC-Source": source,
    };
}

export function safePlatformRedirect(value: string | null, fallback = "/") {
    return value?.startsWith("/") && !value.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(value) ? value : fallback;
}
