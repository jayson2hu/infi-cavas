import { afterAll, beforeEach, expect, test } from "bun:test";
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import type { Me } from "../src/services/api/platform/types";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
const { platformApi, PlatformApiError } = await import("../src/services/api/platform/client");
const { useSessionStore } = await import("../src/stores/use-session-store");
const { safePlatformRedirect } = await import("../src/lib/platform");
const originalAdapter = platformApi.defaults.adapter;
const session = (id = "ws_a"): Me => ({ user: { id: "usr_a", email: "member@example.test", name: "Member", avatarUrl: null, isPlatformAdmin: false }, currentWorkspaceId: id, workspaces: ["ws_a", "ws_b"].map((id) => ({ id, name: id, kind: "team", role: "owner", plan: "free", defaultBrandId: null, memberCount: 1 })) });
const response = (config: InternalAxiosRequestConfig, data: unknown, status = 200): AxiosResponse => ({ config, data, status, statusText: "", headers: {} });
function denied(config: InternalAxiosRequestConfig, status: number) {
    return new AxiosError("denied", undefined, config, undefined, response(config, { error: { code: "denied", message: "拒绝访问" } }, status));
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const tick = () => Promise.resolve().then(() => Promise.resolve());

beforeEach(() => {
    useSessionStore.getState().clear();
    platformApi.defaults.adapter = async (config) => response(config, session(String(config.headers.get("X-IC-Workspace") || "ws_a")));
});
afterAll(() => {
    platformApi.defaults.adapter = originalAdapter;
    useSessionStore.getState().clear();
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

test("bootstrap deduplicates requests and treats missing session as anonymous", async () => {
    let calls = 0;
    platformApi.defaults.adapter = async (config) => { calls++; throw denied(config, 401); };
    useSessionStore.setState({ status: "idle" });
    await Promise.all([useSessionStore.getState().initialize(), useSessionStore.getState().initialize()]);
    expect(calls).toBe(1);
    expect(useSessionStore.getState().status).toBe("ready");
    expect(useSessionStore.getState().user).toBeNull();
});

test("switching workspace changes every subsequent request header", async () => {
    await useSessionStore.getState().refresh();
    await useSessionStore.getState().switchWorkspace("ws_b");
    let requested = "";
    platformApi.defaults.adapter = async (config) => { requested = String(config.headers.get("X-IC-Workspace")); return response(config, {}); };
    await platformApi.get("/billing/summary");
    expect(requested).toBe("ws_b");
    expect(useSessionStore.getState().currentWorkspaceId).toBe("ws_b");
    expect(platformApi.defaults.withCredentials).toBe(true);
});

test("a failed workspace switch keeps the previous workspace usable", async () => {
    await useSessionStore.getState().refresh();
    platformApi.defaults.adapter = async (config) => { throw denied(config, 403); };
    await expect(useSessionStore.getState().switchWorkspace("ws_b")).rejects.toBeInstanceOf(PlatformApiError);
    expect(useSessionStore.getState().currentWorkspaceId).toBe("ws_a");
    expect(useSessionStore.getState().switching).toBe(false);
});

test("late session response cannot overwrite a newer workspace selection", async () => {
    const older = deferred<AxiosResponse>();
    let oldConfig!: InternalAxiosRequestConfig;
    platformApi.defaults.adapter = async (config) => {
        if (config.headers.get("X-IC-Workspace") === "ws_a") { oldConfig = config; return older.promise; }
        return response(config, session("ws_b"));
    };
    const pending = useSessionStore.getState().refresh("ws_a");
    await tick();
    await useSessionStore.getState().refresh("ws_b");
    older.resolve(response(oldConfig, session("ws_a")));
    await pending;
    expect(useSessionStore.getState().currentWorkspaceId).toBe("ws_b");
});

test("logout prevents an in-flight session response from restoring the account", async () => {
    await useSessionStore.getState().refresh();
    const pendingResponse = deferred<AxiosResponse>();
    let pendingConfig!: InternalAxiosRequestConfig;
    platformApi.defaults.adapter = async (config) => {
        if (config.url === "/auth/logout") return response(config, undefined, 204);
        pendingConfig = config;
        return pendingResponse.promise;
    };
    const pending = useSessionStore.getState().refresh();
    await tick();
    await useSessionStore.getState().logout();
    pendingResponse.resolve(response(pendingConfig, session()));
    await pending;
    expect(useSessionStore.getState().user).toBeNull();
    expect(useSessionStore.getState().workspaces).toEqual([]);
});

test("a stale 401 from the previous workspace does not clear the new session", async () => {
    await useSessionStore.getState().refresh();
    const pendingResponse = deferred<AxiosResponse>();
    let pendingConfig!: InternalAxiosRequestConfig;
    platformApi.defaults.adapter = async (config) => {
        if (config.url === "/billing/summary") { pendingConfig = config; return pendingResponse.promise; }
        return response(config, session("ws_b"));
    };
    const pending = platformApi.get("/billing/summary").catch((error) => error);
    await tick();
    await useSessionStore.getState().switchWorkspace("ws_b");
    pendingResponse.reject(denied(pendingConfig, 401));
    await pending;
    expect(useSessionStore.getState().currentWorkspaceId).toBe("ws_b");
    expect(useSessionStore.getState().user?.id).toBe("usr_a");
});

test("redirect accepts local destinations and rejects external or normalized external URLs", () => {
    expect(safePlatformRedirect("/billing?tab=usage")).toBe("/billing?tab=usage");
    expect(safePlatformRedirect("/invite/abc")).toBe("/invite/abc");
    for (const value of ["https://example.test", "//example.test", "/\\example.test", "/\n/example.test", "javascript:alert(1)", null]) expect(safePlatformRedirect(value)).toBe("/");
});
