import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// 平台模式默认关闭自带 Key：Key 只由管理后台统一管理。独立进程以获得真实的运行期配置。
if (!process.env.IC_PLATFORM_BYOK_OFF_PROCESS) {
    test("platform mode without ALLOW_BYOK keeps users on platform models only", () => {
        const env: Record<string, string | undefined> = { ...process.env, IC_PLATFORM_BYOK_OFF_PROCESS: "1", VITE_PLATFORM_API_BASE: "/api" };
        delete env.VITE_ALLOW_BYOK;
        const result = spawnSync(process.execPath, ["test", import.meta.filename], { encoding: "utf8", env });
        if (result.status !== 0) throw new Error(result.stdout + result.stderr);
        expect(result.status).toBe(0);
    }, 60000);
} else {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage, location: { origin: "http://localhost", pathname: "/" }, addEventListener: () => {}, removeEventListener: () => {} } });
    const { useConfigStore, defaultConfig, CONFIG_STORE_KEY, selectableModelsByCapability } = await import("../src/stores/use-config-store");
    const { isByokAllowed } = await import("../src/lib/platform");
    const catalog = [{ id: "gpt-image-2", object: "model" as const, owned_by: "platform" as const, capability: "image" as const, price_hint: { unit: "per_image" as const, config: { standard: 4, hd: 8 } } }];
    const byok = { id: "byok", name: "Own", baseUrl: "https://supplier.test", apiKey: "own-key", apiFormat: "openai" as const, models: [{ name: "own-model", capability: "image" as const }] };

    test("默认配置只有平台渠道，自带 Key 关闭", () => {
        expect(isByokAllowed()).toBe(false);
        expect(defaultConfig.channels.map((channel) => channel.id)).toEqual(["platform"]);
    });

    test("已有的本地渠道和自带 Key 选择被收敛到平台模型", () => {
        useConfigStore.setState({ config: { ...structuredClone(defaultConfig), channels: [...defaultConfig.channels, byok], imageModel: "byok::own-model", model: "byok::own-model" } });
        useConfigStore.getState().setPlatformModels(catalog);
        const config = useConfigStore.getState().config;
        expect(config.channels.map((channel) => channel.id)).toEqual(["platform"]);
        expect(config.imageModel).toBe("platform::gpt-image-2");
        expect(selectableModelsByCapability(config, "image")).toEqual(["platform::gpt-image-2"]);
    });

    test("不能通过设置或导入添加自带 Key 渠道，重新加载也不会恢复", async () => {
        useConfigStore.getState().updateConfig("channels", [byok]);
        expect(useConfigStore.getState().config.channels.map((channel) => channel.id)).toEqual(["platform"]);
        expect(useConfigStore.getState().importChannelCredentials({ baseUrl: "https://supplier.test", apiKey: "own-key" } as never).status).toBe("invalid-base-url");
        values.set(CONFIG_STORE_KEY, JSON.stringify({ version: 0, state: { config: { ...defaultConfig, channels: [byok] } } }));
        await useConfigStore.persist.rehydrate();
        expect(useConfigStore.getState().config.channels.map((channel) => channel.id)).toEqual(["platform"]);
    });
}
