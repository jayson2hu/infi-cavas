import axios from "axios";
import { PLATFORM_API_BASE } from "@/constant/runtime-config";
import i18n from "@/i18n";

let workspaceId = (): string | null => null;
let sessionGeneration = () => 0;
let onUnauthorized = () => {};
declare module "axios" { interface AxiosRequestConfig { icSessionGeneration?: number } }
export function bindPlatformSession(getWorkspaceId: () => string | null, clearSession: () => void, getGeneration: () => number) {
    workspaceId = getWorkspaceId;
    onUnauthorized = clearSession;
    sessionGeneration = getGeneration;
}

export class PlatformApiError extends Error {
    constructor(message: string, public status: number, public code: string, public details: Record<string, unknown> = {}) {
        super(message);
        this.name = "PlatformApiError";
    }
}

export const platformApi = axios.create({ baseURL: PLATFORM_API_BASE, withCredentials: true });
platformApi.interceptors.request.use((config) => {
    const id = workspaceId();
    config.icSessionGeneration = sessionGeneration();
    if (id && !config.headers.has("X-IC-Workspace")) config.headers.set("X-IC-Workspace", id);
    return config;
});
platformApi.interceptors.response.use((response) => response, (error) => {
    if (axios.isCancel(error)) return Promise.reject(error);
    const status = error.response?.status || 0;
    const data = error.response?.data?.error;
    const requestWorkspace = error.config?.headers?.get?.("X-IC-Workspace");
    if (status === 401 && !["/auth/login", "/auth/register", "/auth/me"].includes(error.config?.url) && requestWorkspace === workspaceId() && error.config?.icSessionGeneration === sessionGeneration()) onUnauthorized();
    return Promise.reject(new PlatformApiError(data?.message || i18n.t("platform.requestFailed"), status, data?.code || "request_failed", data || {}));
});
