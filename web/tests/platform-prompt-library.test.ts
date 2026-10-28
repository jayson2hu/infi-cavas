import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// 提示词库内容来自 GitHub 社区仓库：平台模式默认关闭，PROMPT_LIBRARY=true 才开启；纯前端模式始终开启。
// 运行期配置在模块加载时读取，所以每种组合在独立进程里验证。
const cases: Array<{ name: string; env: Record<string, string>; expected: boolean }> = [
    { name: "平台模式默认关闭", env: { VITE_PLATFORM_API_BASE: "/api" }, expected: false },
    { name: "平台模式显式开启", env: { VITE_PLATFORM_API_BASE: "/api", VITE_PROMPT_LIBRARY: "true" }, expected: true },
    { name: "非 true 值视为关闭", env: { VITE_PLATFORM_API_BASE: "/api", VITE_PROMPT_LIBRARY: "yes" }, expected: false },
    { name: "纯前端模式始终开启", env: {}, expected: true },
];

if (!process.env.IC_PROMPT_LIBRARY_EXPECT) {
    for (const item of cases) {
        test(item.name, () => {
            const env: Record<string, string | undefined> = { ...process.env, ...item.env, IC_PROMPT_LIBRARY_EXPECT: String(item.expected) };
            if (!item.env.VITE_PLATFORM_API_BASE) delete env.VITE_PLATFORM_API_BASE;
            if (!item.env.VITE_PROMPT_LIBRARY) delete env.VITE_PROMPT_LIBRARY;
            const result = spawnSync(process.execPath, ["test", import.meta.filename], { encoding: "utf8", env });
            if (result.status !== 0) throw new Error(result.stdout + result.stderr);
        }, 60000);
    }
} else {
    const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, location: { origin: "http://localhost", pathname: "/" }, addEventListener: () => {}, removeEventListener: () => {} } });
    const { isPromptLibraryEnabled } = await import("../src/lib/platform");
    test(`isPromptLibraryEnabled() === ${process.env.IC_PROMPT_LIBRARY_EXPECT}`, () => {
        expect(isPromptLibraryEnabled()).toBe(process.env.IC_PROMPT_LIBRARY_EXPECT === "true");
    });
}
