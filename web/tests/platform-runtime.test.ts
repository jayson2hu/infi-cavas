import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";

const gitBash = join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe");
const shell = process.platform === "win32" ? existsSync(gitBash) ? gitBash : null : Bun.which("sh");

test.skipIf(!shell)("container runtime config preserves Unicode and cannot execute product-name contents", () => {
    const testResults = resolve(import.meta.dir, "../../test-results");
    mkdirSync(testResults, { recursive: true });
    const folder = mkdtempSync(join(testResults, "canvas-runtime-"));
    const output = join(folder, "config.js");
    const quotedOutput = `'${output.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
    const script = readFileSync(resolve(import.meta.dir, "../docker-entrypoint.sh"), "utf8").replace("/usr/share/nginx/html/config.js", quotedOutput);
    const name = '测试画布 " \\ \n ${doNotExecute} </script> \u2028';
    try {
        const result = spawnSync(shell!, ["-s"], { input: script, encoding: "utf8", env: { ...process.env, PLATFORM_API_BASE: "/api", BRAND_NAME: name } });
        expect(result.status).toBe(0);
        const window: { __RUNTIME_CONFIG__?: { PLATFORM_API_BASE: string; BRAND_NAME: string } } = {};
        runInNewContext(readFileSync(output, "utf8"), { window, TextDecoder, Uint8Array, atob });
        expect(window.__RUNTIME_CONFIG__?.PLATFORM_API_BASE).toBe("/api");
        expect(window.__RUNTIME_CONFIG__?.BRAND_NAME).toBe(name);
    } finally {
        if (existsSync(output)) unlinkSync(output);
        rmdirSync(folder);
    }
});
