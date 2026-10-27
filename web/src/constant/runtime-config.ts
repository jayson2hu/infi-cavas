// Runtime configuration access layer.
// Priority: window.__RUNTIME_CONFIG__ (injected by the container entrypoint) > build-time VITE_ variables > defaults.
// This supports both configuring the same image with docker run -e and injecting values during custom builds.
//
// Each analytics provider has its own variable; configured providers are enabled independently and all are disabled by default.
// Only GA4 and Baidu are supported. Both accept IDs only, and script URLs are assembled in code without arbitrary scripts or inline JavaScript.

type RuntimeConfig = {
    PLATFORM_API_BASE?: string;
    BRAND_NAME?: string;
    ALLOW_BYOK?: string; // 平台模式下是否允许用户自带 Key（私有化部署可开启），默认关闭
    ANALYTICS_GA4_ID?: string; // GA4 measurement ID (G-XXXX)
    ANALYTICS_BAIDU_ID?: string; // Baidu Analytics site ID
};

declare global {
    interface Window {
        __RUNTIME_CONFIG__?: RuntimeConfig;
    }
}

const runtime: RuntimeConfig = (typeof window !== "undefined" && window.__RUNTIME_CONFIG__) || {};

function read(key: keyof RuntimeConfig, buildTime: string | undefined, fallback = ""): string {
    const value = runtime[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof buildTime === "string" && buildTime.trim()) return buildTime.trim();
    return fallback;
}

export const ANALYTICS_GA4_ID = read("ANALYTICS_GA4_ID", import.meta.env.VITE_ANALYTICS_GA4_ID);
export const ANALYTICS_BAIDU_ID = read("ANALYTICS_BAIDU_ID", import.meta.env.VITE_ANALYTICS_BAIDU_ID);

// An explicitly empty runtime value disables platform mode even in a platform build.
export const PLATFORM_API_BASE = (typeof runtime.PLATFORM_API_BASE === "string" ? runtime.PLATFORM_API_BASE.trim() : import.meta.env.VITE_PLATFORM_API_BASE?.trim() || "").replace(/\/+$/, "");
export const BRAND_NAME = read("BRAND_NAME", import.meta.env.VITE_BRAND_NAME);
export const ALLOW_BYOK = read("ALLOW_BYOK", import.meta.env.VITE_ALLOW_BYOK) === "true";
