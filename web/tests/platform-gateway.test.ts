import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";

// A separate process gives runtime-config its real platform-enabled startup state.
if (!process.env.IC_PLATFORM_TEST_PROCESS) {
    test("platform gateway and billing isolated regression suite", () => {
        const result = spawnSync(process.execPath, ["test", import.meta.filename], { encoding: "utf8", env: { ...process.env, IC_PLATFORM_TEST_PROCESS: "1", VITE_PLATFORM_API_BASE: "/api" } });
        if (result.status !== 0) throw new Error(result.stdout + result.stderr);
        expect(result.status).toBe(0);
    }, 60000);
} else {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage, location: { origin: "http://localhost", pathname: "/canvas/project-a" }, addEventListener: () => {}, removeEventListener: () => {} } });
    const { platformApi } = await import("../src/services/api/platform/client");
    const { useSessionStore } = await import("../src/stores/use-session-store");
    const { useCreditsStore } = await import("../src/stores/use-credits-store");
    const { useBrandStore } = await import("../src/stores/use-brand-store");
    const { useConfigStore, defaultConfig, CONFIG_STORE_KEY, createPlatformChannel, resolveModelRequestConfig, resolveModelScript, withLocalProxy } = await import("../src/stores/use-config-store");
    const { isPlatformGatewayUrl, platformHeaders } = await import("../src/lib/platform");
    const { recordPlatformHeaders, recordPlatformError } = await import("../src/services/api/platform/gateway-observer");
    const { estimateDisplayCredits, modelPriceRule } = await import("../src/lib/platform-pricing");
    const { createVideoGenerationTask, pollVideoGenerationTask } = await import("../src/services/api/video");
    const { requestImageQuestion, requestGeneration } = await import("../src/services/api/image");
    const { applyByokBrand, applyBrandConfigDefaults, brandDefaultsToConfig } = await import("../src/lib/platform-brand");
    const { buildGenerationConfig, buildVideoPollingConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
    const { downloadBrandAsset, uploadBrandAsset } = await import("../src/services/api/platform/brands");
    const { parseBrandAssetDrag } = await import("../src/lib/brand-drag");
    const { fetchTemplates, fetchTemplate, createTemplate, useTemplate, uploadTemplateImage, prepareTemplateInsertion } = await import("../src/services/api/platform/templates");
    const { templateEstimates, templateGenerationSnapshot } = await import("../src/components/templates/template-estimate");
    const { resetInterruptedGeneration } = await import("../src/lib/canvas/canvas-generation-helpers");
    const { toCsv } = await import("../src/lib/csv");
    const originalAdapter = axios.defaults.adapter;
    const originalPlatformAdapter = platformApi.defaults.adapter;
    const originalFetch = globalThis.fetch;
    const response = (config: InternalAxiosRequestConfig, data: unknown, status = 200, headers = {}): AxiosResponse => ({ config, data, status, statusText: "", headers });
    const user = (id: string) => ({ id, email: `${id}@example.test`, name: id, avatarUrl: null, isPlatformAdmin: false });
    const session = (id = "user-a", workspaceId = "ws-a") => ({ user: user(id), currentWorkspaceId: workspaceId, workspaces: ["ws-a", "ws-b"].map((id) => ({ id, name: id, kind: "team" as const, role: "owner" as const, plan: "free" as const, defaultBrandId: null, memberCount: 1 })) });
    const catalog = [
        { id: "gpt-image-2", object: "model" as const, owned_by: "platform" as const, capability: "image" as const, price_hint: { unit: "per_image" as const, config: { standard: 4, hd: 7 } } },
        { id: "video-model", object: "model" as const, owned_by: "platform" as const, capability: "video" as const, price_hint: { unit: "per_second" as const, config: { price: 2 } } },
        { id: "text-model", object: "model" as const, owned_by: "platform" as const, capability: "text" as const, price_hint: { unit: "per_1k_tokens" as const, config: { input: 1, output: 2, hold: 10, min: 1 } } },
    ];
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
    beforeEach(() => {
        values.clear();
        useSessionStore.getState().clear();
        useSessionStore.setState({ ...session(), status: "ready" });
        useCreditsStore.getState().reset();
        useBrandStore.getState().reset();
        useConfigStore.setState({ config: structuredClone(defaultConfig) });
        useConfigStore.getState().setPlatformModels(catalog);
        platformApi.defaults.adapter = async (config) => response(config, config.url?.startsWith("/auth") ? session() : { balance: 96, billingEnabled: true });
        axios.defaults.adapter = async (config) => response(config, { id: "task-a", status: "queued" });
    });
    afterEach(() => { globalThis.fetch = originalFetch; });
    afterAll(() => { axios.defaults.adapter = originalAdapter; platformApi.defaults.adapter = originalPlatformAdapter; });

    test("the platform channel is readonly, cannot be replaced, and is not persisted", () => {
        expect(useConfigStore.getState().config.channels[0].readonly).toBe(true);
        useConfigStore.getState().updateConfig("channels", [{ ...createPlatformChannel(), baseUrl: "https://evil.test", apiKey: "evil" }]);
        const channel = useConfigStore.getState().config.channels[0];
        expect(channel.baseUrl).toBe("/api/gateway");
        expect(channel.models[0].name).toBe("gpt-image-2");
        const persisted = JSON.parse(values.get(CONFIG_STORE_KEY)!);
        expect(persisted.state.config.channels.some((item: { id: string }) => item.id === "platform")).toBe(false);
    });

    test("hydration discards injected platform credentials and preserves BYOK credentials", async () => {
        const config = useConfigStore.getState().config;
        values.set(CONFIG_STORE_KEY, JSON.stringify({ version: 0, state: { config: { ...config, channels: [{ ...createPlatformChannel(catalog), baseUrl: "https://evil.test", apiKey: "injected" }, { id: "byok", name: "Own", baseUrl: "https://supplier.test", apiKey: "own-key", apiFormat: "openai", models: [{ name: "own-model", capability: "image" }] }] } } }));
        await useConfigStore.persist.rehydrate();
        expect(useConfigStore.getState().config.channels[0].baseUrl).toBe("/api/gateway");
        expect(useConfigStore.getState().config.channels[0].apiKey).toBe("platform");
        expect(useConfigStore.getState().config.channels[0].models).toEqual([]);
        expect(useConfigStore.getState().config.channels[1].apiKey).toBe("own-key");
    });

    test("platform URLs bypass local proxy and never execute model scripts; BYOK keeps its route", () => {
        useConfigStore.getState().updateConfig("proxyEnabled", true);
        useConfigStore.getState().updateConfig("proxyUrl", "http://127.0.0.1:8788");
        const config = useConfigStore.getState().config;
        config.channels[0].models[0].script = "throw new Error('must not run')";
        const byok = { id: "byok", name: "BYOK", baseUrl: "https://supplier.test", apiKey: "own-key", apiFormat: "openai" as const, models: [{ name: "own-model", capability: "image" as const }] };
        const complete = { ...config, channels: [...config.channels, byok] };
        expect(resolveModelScript(complete, "platform::gpt-image-2")).toBe("");
        expect(resolveModelRequestConfig(complete, "platform::gpt-image-2").baseUrl).toBe("/api/gateway");
        expect(resolveModelRequestConfig(complete, "byok::own-model").apiKey).toBe("own-key");
        expect(withLocalProxy("http://localhost/api/gateway/v1/images/generations")).toBe("http://localhost/api/gateway/v1/images/generations");
        expect(withLocalProxy("https://supplier.test/v1/images/generations")).toBe("http://127.0.0.1:8788/https://supplier.test/v1/images/generations");
        expect(isPlatformGatewayUrl("https://evil.test/api/gateway")).toBe(false);
        expect(isPlatformGatewayUrl("/api/gateway-evil")).toBe(false);
        expect(platformHeaders(byok)).toEqual({});
    });

    test("removed BYOK and unavailable platform models cannot fall back to another paid route", () => {
        const config = useConfigStore.getState().config;
        expect(() => resolveModelRequestConfig(config, "deleted-byok::gpt-image-2")).toThrow();
        expect(() => resolveModelRequestConfig(config, "platform::missing")).toThrow();
        expect(() => resolveModelRequestConfig({ ...config, channels: [] }, "platform::gpt-image-2")).toThrow();
    });

    test("generation snapshots keep their workspace and reject a changed account before sending", () => {
        const snapshot = resolveModelRequestConfig({ ...useConfigStore.getState().config, platformContext: { projectId: "project-a", nodeId: "node-a", source: "canvas" } }, "platform::gpt-image-2");
        useSessionStore.setState({ currentWorkspaceId: "ws-b" });
        expect(platformHeaders(snapshot)).toMatchObject({ "X-IC-Workspace": "ws-a", "X-IC-Project": "project-a", "X-IC-Node": "node-a", "X-IC-Source": "canvas" });
        useSessionStore.getState().clear();
        useSessionStore.setState(session("user-b"));
        expect(() => platformHeaders(snapshot)).toThrow();
    });

    test("an old 401 cannot log out a newer account in the same workspace", async () => {
        const pendingResponse = deferred<AxiosResponse>();
        let pendingConfig!: InternalAxiosRequestConfig;
        platformApi.defaults.adapter = async (config) => { if (config.url === "/auth/login") return response(config, session("user-b")); pendingConfig = config; return pendingResponse.promise; };
        const pending = platformApi.get("/billing/summary").catch((error) => error);
        await tick();
        useSessionStore.getState().clear();
        await useSessionStore.getState().login({ email: "user-b@example.test", password: "password" });
        pendingResponse.reject(new AxiosError("unauthorized", undefined, pendingConfig, undefined, response(pendingConfig, { error: { code: "unauthorized" } }, 401)));
        await pending;
        expect(useSessionStore.getState().user?.id).toBe("user-b");
    });

    test("old headers and 402 errors do not affect a new login, including asynchronous Blob parsing", async () => {
        const generation = useSessionStore.getState().generation;
        const body = deferred<string>();
        const blob = new Blob();
        blob.text = () => body.promise;
        const pending = recordPlatformError(402, blob, "ws-a", generation);
        useSessionStore.getState().clear();
        useSessionStore.setState(session("user-b"));
        useCreditsStore.getState().reset();
        useCreditsStore.getState().setBalance("ws-a", 200);
        recordPlatformHeaders(new Headers({ "X-IC-Credits-Balance": "96" }), "ws-a", generation);
        body.resolve(JSON.stringify({ error: { code: "member_cap_exceeded", message: "old account" } }));
        await pending;
        await recordPlatformError(402, { error: { code: "insufficient_credits", message: "old" } }, "ws-a", generation);
        expect(useCreditsStore.getState().balances["ws-a"]).toBe(200);
        expect(useCreditsStore.getState().error).toBeNull();
        await recordPlatformError(402, new Blob([JSON.stringify({ error: { code: "insufficient_credits", message: "current" } })]), "ws-a", useSessionStore.getState().generation);
        expect(useCreditsStore.getState().error?.message).toBe("current");
    });

    test("a delayed billing summary cannot overwrite newer balance headers or survive a reset", async () => {
        const pendingResponse = deferred<AxiosResponse>();
        let pendingConfig!: InternalAxiosRequestConfig;
        platformApi.defaults.adapter = async (config) => { pendingConfig = config; return pendingResponse.promise; };
        const pending = useCreditsStore.getState().refresh("ws-a");
        await tick();
        useCreditsStore.getState().setBalance("ws-a", 88);
        pendingResponse.resolve(response(pendingConfig, { balance: 100, billingEnabled: true }));
        await pending;
        expect(useCreditsStore.getState().balances["ws-a"]).toBe(88);
        const nextResponse = deferred<AxiosResponse>();
        platformApi.defaults.adapter = async (config) => { pendingConfig = config; return nextResponse.promise; };
        const next = useCreditsStore.getState().refresh("ws-a");
        await tick();
        useCreditsStore.getState().reset();
        nextResponse.resolve(response(pendingConfig, { balance: 50, billingEnabled: true }));
        await next;
        expect(useCreditsStore.getState().balances).toEqual({});
    });

    test("real Axios gateway observers ignore an old-account response", async () => {
        const delayed = deferred<AxiosResponse>();
        let sent!: InternalAxiosRequestConfig;
        axios.defaults.adapter = async (config) => { sent = config; return delayed.promise; };
        const pending = axios.post("/api/gateway/v1/images/generations", {}, { headers: { "X-IC-Workspace": "ws-a" } });
        await tick();
        expect(sent.withCredentials).toBe(true);
        useSessionStore.getState().clear();
        useSessionStore.setState(session("user-b"));
        useCreditsStore.getState().setBalance("ws-a", 200);
        delayed.resolve(response(sent, {}, 200, { "x-ic-credits-balance": "96" }));
        await pending; await tick();
        expect(useCreditsStore.getState().balances["ws-a"]).toBe(200);
    });

    test("video tasks retain original ownership through serialization and resume in their original workspace", async () => {
        const config = { ...useConfigStore.getState().config, model: "platform::video-model", size: "16:9", videoSeconds: "5" };
        const task = JSON.parse(JSON.stringify(await createVideoGenerationTask(config, "a test video")));
        expect(task.workspaceId).toBe("ws-a");
        expect(task.userId).toBe("user-a");
        useSessionStore.setState({ currentWorkspaceId: "ws-b" });
        let requested = "";
        axios.defaults.adapter = async (config) => { requested = String(config.headers.get("X-IC-Workspace")); return response(config, { id: task.id, status: "queued" }); };
        expect((await pollVideoGenerationTask(config, task)).status).toBe("pending");
        expect(requested).toBe("ws-a");
        useSessionStore.getState().clear();
        useSessionStore.setState(session("user-b"));
        await expect(pollVideoGenerationTask(config, task)).rejects.toThrow();
    });

    test("SSE completion refreshes held credits to the settled balance", async () => {
        let credentials: RequestCredentials | undefined;
        globalThis.fetch = (async (_input, init) => { credentials = init?.credentials; return new Response('data: {"type":"response.output_text.delta","delta":"hello"}\n\n', { headers: { "Content-Type": "text/event-stream", "X-IC-Credits-Balance": "90" } }); }) as typeof fetch;
        const text = await requestImageQuestion({ ...useConfigStore.getState().config, model: "platform::text-model" }, [{ role: "user", content: "hello" }], () => {});
        await tick();
        expect(credentials).toBe("include");
        expect(text).toBe("hello");
        expect(useCreditsStore.getState().balances["ws-a"]).toBe(96);
    });

    test("existing video polling ignores brand loading while creation and account guards remain enforced", async () => {
        const config = { ...useConfigStore.getState().config, model: "platform::video-model", videoModel: "platform::video-model", platformContext: { workspaceId: "ws-a", sessionGeneration: useSessionStore.getState().generation, brandReady: false, projectId: "project-a" } };
        const node = { id: "video-a", type: "video", title: "Video", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { model: "platform::video-model", videoTaskId: "existing-task" } };
        const task = { id: "existing-task", provider: "openai" as const, model: "platform::video-model", workspaceId: "ws-a", userId: "user-a" };
        const requests: InternalAxiosRequestConfig[] = [];
        axios.defaults.adapter = async (request) => { requests.push(request); return response(request, { id: task.id, status: "queued" }); };
        const polling = buildVideoPollingConfig(config, node);
        expect((await pollVideoGenerationTask(polling, task)).status).toBe("pending");
        expect(requests).toHaveLength(1);
        expect(requests[0].method).toBe("get");
        expect(requests[0].headers.get("X-IC-Workspace")).toBe("ws-a");
        expect(polling.platformContext).toMatchObject({ projectId: "project-a", nodeId: "video-a", sessionGeneration: config.platformContext.sessionGeneration });
        await expect(createVideoGenerationTask(buildGenerationConfig(config, node, "video"), "new video")).rejects.toThrow();
        expect(requests).toHaveLength(1);
        useSessionStore.getState().clear(); useSessionStore.setState(session("user-b"));
        await expect(pollVideoGenerationTask(polling, task)).rejects.toThrow();
    });

    test("display pricing matches integer rounding, HD boundary, Unicode and fractional rates", () => {
        const image = { unit: "per_image" as const, config: { standard: .1, hd: .3 } };
        expect(estimateDisplayCredits(image, { n: 10, size: "1536x1024" })).toBe(1);
        expect(estimateDisplayCredits(image, { n: 10, size: "1537x1024" })).toBe(3);
        expect(estimateDisplayCredits(image, { n: 3, size: "auto" })).toBe(1);
        expect(estimateDisplayCredits({ unit: "per_second", config: { price: .1 } }, { seconds: 30 })).toBe(3);
        expect(estimateDisplayCredits({ unit: "per_1k_chars", config: { price: 1000 } }, { input: "你好😀" })).toBe(3);
        expect(estimateDisplayCredits({ unit: "per_1k_tokens", config: { hold: 10 } }, {})).toBe(10);
        expect(estimateDisplayCredits(image, { size: "custom" })).toBeNull();
        const config = { ...useConfigStore.getState().config, model: "platform::model::with-colons", channels: [createPlatformChannel([{ ...catalog[0], id: "model::with-colons" }])] };
        expect(modelPriceRule(config)?.config.standard).toBe(4);
    });

    test("CSV exports preserve text, quotes and newlines while neutralizing spreadsheet formulas", () => {
        expect(toCsv([["=cmd()", " +SUM(1)", "a\"b\nc", -1, null]])).toBe('\ufeff"\'=cmd()","\' +SUM(1)","a""b\nc","-1",""');
    });

    test("platform locale keys match in both languages and every static UI reference exists", async () => {
        const zh = (await import("../src/i18n/locales/platform-zh-CN")).default;
        const en = (await import("../src/i18n/locales/platform-en-US")).default;
        const flatten = (value: object, prefix = ""): string[] => Object.entries(value).flatMap(([key, child]) => typeof child === "object" ? flatten(child, `${prefix}${key}.`) : [`${prefix}${key}`]);
        const keys = new Set(flatten(zh));
        expect([...keys].sort()).toEqual(flatten(en).sort());
        const missing = new Set<string>();
        for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: `${import.meta.dir}/../src`, absolute: true })) {
            const text = await Bun.file(file).text();
            for (const match of text.matchAll(/t\(["'`]platform\.([A-Za-z0-9_.]+)["'`]/g)) if (!keys.has(match[1])) missing.add(match[1]);
        }
        expect([...missing]).toEqual([]);
    });

    test("template APIs carry explicit workspace and use only increments the usage route", async () => {
        const requests: InternalAxiosRequestConfig[] = [];
        platformApi.defaults.adapter = async (config) => { requests.push(config); return response(config, config.url === "/templates" && config.method === "get" ? [] : { id: "tpl-a" }); };
        await fetchTemplates("ws-a", { category: "ecommerce", scope: "team", q: "商品" });
        await fetchTemplate("ws-a", "tpl-a");
        await createTemplate("ws-a", { name: "Reusable", category: "other", body: { version: 1, variables: [], ops: [{ type: "add_node", id: "image", nodeType: "image" }], steps: [{ label: "Image", nodeIds: ["image"], mode: "image" }] } });
        await useTemplate("ws-a", "tpl-a");
        expect(requests.map((request) => request.headers.get("X-IC-Workspace"))).toEqual(["ws-a", "ws-a", "ws-a", "ws-a"]);
        expect(requests.map((request) => request.url)).toEqual(["/templates", "/templates/tpl-a", "/templates", "/templates/tpl-a/use"]);
        expect(requests[0].params).toEqual({ category: "ecommerce", scope: "team", q: "商品" });
        expect(useCreditsStore.getState().balances).toEqual({});
    });

    test("template image upload preserves signed headers and rejects stale workspace completion", async () => {
        const signedHeaders = { "Content-Type": "image/png", "x-amz-meta-purpose": "template_image" };
        platformApi.defaults.adapter = async (config) => response(config, { uploadUrl: "https://storage.test/template", objectKey: "ws/ws-a/uploads/template_image/a.png", headers: signedHeaders });
        let sent: RequestInit | undefined;
        globalThis.fetch = (async (_input, options) => { sent = options; return new Response(null, { status: 200 }); }) as typeof fetch;
        expect(await uploadTemplateImage("ws-a", new Blob(["png"], { type: "image/png" }))).toBe("ws/ws-a/uploads/template_image/a.png");
        expect(sent?.headers).toEqual(signedHeaders);
        expect(sent?.credentials).toBe("omit");
        globalThis.fetch = (async () => { useSessionStore.setState({ currentWorkspaceId: "ws-b" }); return new Response(null, { status: 200 }); }) as typeof fetch;
        await expect(uploadTemplateImage("ws-a", new Blob(["png"], { type: "image/png" }))).rejects.toThrow();
    });

    test("template estimate matches separate image requests and current model prices", () => {
        const config = { ...useConfigStore.getState().config, imageModel: "platform::gpt-image-2", textModel: "platform::text-model", videoModel: "platform::video-model", channels: [createPlatformChannel([{ ...catalog[0], price_hint: { unit: "per_image", config: { standard: 1.5, hd: 3.5 } } }, ...catalog.slice(1)])] };
        const body = { version: 1 as const, variables: [], ops: [{ type: "add_node" as const, id: "image", nodeType: "image", metadata: { count: 5, size: "1024x1024" } }, { type: "add_node" as const, id: "text", nodeType: "text", metadata: { textCount: 3 } }, { type: "add_node" as const, id: "video", nodeType: "video", metadata: { seconds: "4" } }], steps: [{ label: "Images", nodeIds: ["image"], mode: "image" as const }, { label: "Text", nodeIds: ["text"], mode: "text" as const }, { label: "Video", nodeIds: ["video"], mode: "video" as const }] };
        expect(templateEstimates(body, config)).toEqual({ platform: true, steps: [10, 30, 8], total: 48 });
        body.ops[0].metadata = { ...body.ops[0].metadata, model: "gpt-image-2" } as typeof body.ops[0]["metadata"];
        expect(templateEstimates(body, config).total).toBe(48);
    });

    test("reopening a running template preserves completed node ids and enables resume", () => {
        const run = { templateId: "tpl", templateName: "T", idMap: { a: "A", b: "B" }, steps: [{ label: "Image", nodeIds: ["a", "b"], mode: "image" as const }], stepIndex: 0, completedNodeIds: ["A"], status: "running" as const };
        const nodes = resetInterruptedGeneration([{ id: "group", type: "group", title: "Template", position: { x: 0, y: 0 }, width: 500, height: 300, metadata: { templateRun: run } }]);
        expect(nodes[0].metadata?.templateRun).toEqual({ ...run, status: "stopped" });
        expect(run.status).toBe("running");
    });

    test("saving a template freezes effective generation parameters with matching estimates", () => {
        const config = { ...useConfigStore.getState().config, imageModel: "platform::gpt-image-2", canvasImageCount: "5", size: "1024x1024", quality: "high" };
        const nodes = [{ id: "config", type: "config", title: "Generate", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { prompt: "Scene" } }, { id: "input", type: "image", title: "Input", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { content: "blob:input" } }];
        const snapshot = templateGenerationSnapshot(nodes, config);
        expect(snapshot.generationDefaults.config).toMatchObject({ model: "platform::gpt-image-2", count: 5, size: "1024x1024", quality: "high" });
        expect(snapshot.estimates.config).toBe(20);
        expect(snapshot.generationDefaults.input).toBeUndefined();
        expect(nodes[0].metadata).toEqual({ prompt: "Scene" });
    });

    test("template preparation keeps the server body immutable and rejects a stale session", async () => {
        const template = { id: "t", name: "T", scope: "team" as const, category: "other" as const, description: "", coverUrl: null, previewNodes: [], estimateCredits: 0, useCount: 0, canEdit: true, body: { version: 1 as const, variables: [], ops: [{ type: "add_node" as const, id: "a", nodeType: "image" }], steps: [{ label: "Image", nodeIds: ["a"], mode: "image" as const }] } };
        const input = { template, values: {}, workspaceId: "ws-a", generation: useSessionStore.getState().generation };
        expect(await prepareTemplateInsertion(input)).toEqual({ ...input, images: {} });
        expect(template.body.ops).toEqual([{ type: "add_node", id: "a", nodeType: "image" }]);
        useSessionStore.setState({ currentWorkspaceId: "ws-b" });
        await expect(prepareTemplateInsertion(input)).rejects.toThrow();
    });

    const makeBrand = (id: string, isDefault = false, enforced = false) => ({ id, name: id, industry: null, description: null, isDefault, enforced, logoUrl: null, colors: [{ name: "primary", role: "primary" as const, hex: "#123456" }], requiredTerms: ["calm"], avoidTerms: ["neon"], defaultParams: { size: "1536x1024", n: 2, seconds: 8 }, editorUserIds: [], assets: [], canEdit: true, skuCount: 0, usedInProjects: 0, updatedAt: "2026-10-25T00:00:00Z" });
    const brandList = [makeBrand("brand-a", true), makeBrand("brand-b"), makeBrand("brand-c")];
    const brandAdapter = async (config: InternalAxiosRequestConfig) => response(config, config.url === "/brands" ? brandList : brandList.find((brand) => config.url === `/brands/${brand.id}`));

    test("M3 brand selection stores only an ID scoped to account and workspace, validating restored membership", async () => {
        platformApi.defaults.adapter = brandAdapter;
        const generation = useSessionStore.getState().generation;
        await useBrandStore.getState().load("ws-a", generation);
        await useBrandStore.getState().select("brand-b");
        expect(values.get("infinite-canvas:brand:user-a:ws-a")).toBe("brand-b");
        useBrandStore.getState().reset();
        await useBrandStore.getState().load("ws-a", generation);
        expect(useBrandStore.getState().brand?.id).toBe("brand-b");
        useSessionStore.getState().clear();
        useSessionStore.setState(session("user-b"));
        await useBrandStore.getState().load("ws-a", useSessionStore.getState().generation);
        expect(useBrandStore.getState().brand?.id).toBe("brand-a");
        values.set("infinite-canvas:brand:user-b:ws-a", "foreign-brand");
        useBrandStore.getState().reset();
        await useBrandStore.getState().load("ws-a", useSessionStore.getState().generation);
        expect(useBrandStore.getState().brand?.id).toBe("brand-a");
    });

    test("M3 a previous-workspace mutation refresh cannot invalidate the current brand load", async () => {
        platformApi.defaults.adapter = brandAdapter;
        const generation = useSessionStore.getState().generation;
        await useBrandStore.getState().load("ws-a", generation);
        useBrandStore.getState().override("size", "2048x2048");
        useSessionStore.setState({ currentWorkspaceId: "ws-b" });
        const pending = useBrandStore.getState().load("ws-b", generation);
        await useBrandStore.getState().load("ws-a", generation);
        await pending;
        expect(useBrandStore.getState().workspaceId).toBe("ws-b");
        expect(useBrandStore.getState().ready).toBe(true);
        expect(useBrandStore.getState().overrides).toEqual({});
        await useBrandStore.getState().load("ws-a", generation);
        expect(useBrandStore.getState().workspaceId).toBe("ws-b");
    });

    test("M3 a delayed earlier brand selection cannot replace the newer brand", async () => {
        platformApi.defaults.adapter = brandAdapter;
        await useBrandStore.getState().load("ws-a", useSessionStore.getState().generation);
        const delayed = deferred<AxiosResponse>();
        let sent!: InternalAxiosRequestConfig;
        platformApi.defaults.adapter = async (config) => { if (config.url === "/brands/brand-b") { sent = config; return delayed.promise; } return brandAdapter(config); };
        const earlier = useBrandStore.getState().select("brand-b");
        await tick();
        await useBrandStore.getState().select("brand-c");
        delayed.resolve(response(sent, brandList[1]));
        await earlier;
        expect(useBrandStore.getState().brand?.id).toBe("brand-c");
        expect(useBrandStore.getState().ready).toBe(true);
    });

    test("M3 node opt-out emits none, while enforced brands remain applied for platform and BYOK", () => {
        const brand = makeBrand("brand-a", true);
        const context = { workspaceId: "ws-a", sessionGeneration: useSessionStore.getState().generation, brandReady: true, brand, defaultBrand: brand, brandKit: false };
        const config = { ...useConfigStore.getState().config, baseUrl: "/api/gateway", systemPrompt: "own system", platformContext: context };
        expect(platformHeaders(config)["X-IC-Brand"]).toBe("none");
        expect(applyByokBrand(config).systemPrompt).toBe("own system");
        const enforced = { ...config, platformContext: { ...context, defaultBrand: { ...brand, enforced: true } } };
        expect(platformHeaders(enforced)["X-IC-Brand"]).toBe("brand-a");
        expect(applyByokBrand(enforced).systemPrompt).toContain("[品牌] brand-a");
        expect(() => applyByokBrand({ ...config, platformContext: { ...context, brandReady: false } })).toThrow();
    });

    test("M3 no-brand selection cannot bypass an enforced default, and overrides clear on brand switch", async () => {
        platformApi.defaults.adapter = async (config) => response(config, config.url === "/brands" ? [makeBrand("brand-a", true, true), brandList[1]] : config.url === "/brands/brand-a" ? makeBrand("brand-a", true, true) : brandList[1]);
        await useBrandStore.getState().load("ws-a", useSessionStore.getState().generation);
        await useBrandStore.getState().select("none");
        expect(useBrandStore.getState().brand?.id).toBe("brand-a");
        const originalSize = useConfigStore.getState().config.size;
        useConfigStore.getState().updateConfig("size", "2048x2048");
        expect(useBrandStore.getState().overrides.size).toBe("2048x2048");
        expect(useConfigStore.getState().config.size).toBe(originalSize);
        await useBrandStore.getState().select("brand-b");
        expect(useBrandStore.getState().overrides).toEqual({});
    });

    test("M3 brand defaults map API fields once; explicit node and workbench values take priority", () => {
        const config = useConfigStore.getState().config;
        const defaults = brandDefaultsToConfig({ model: "gpt-image-2", size: "1536x1024", n: 2, seconds: 8, generate_audio: false, speed: 1.2, temperature: .4, max_output_tokens: 400 }, config);
        expect(defaults).toMatchObject({ model: "platform::gpt-image-2", imageModel: "platform::gpt-image-2", size: "1536x1024", count: "2", canvasImageCount: "2", videoSeconds: "8", videoGenerateAudio: "false", audioSpeed: "1.2", temperature: .4, maxOutputTokens: 400 });
        const effective = applyBrandConfigDefaults(config, makeBrand("brand-a"));
        expect(buildGenerationConfig(effective, undefined, "image").count).toBe("2");
        const node = { id: "node-a", type: "config", title: "", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { size: "2048x2048", count: 3 } };
        expect(buildGenerationConfig(effective, node, "image")).toMatchObject({ size: "2048x2048", count: "3" });
        expect(applyBrandConfigDefaults(config, makeBrand("brand-a"), { size: "512x512" }).size).toBe("512x512");
    });

    test("M3 BYOK generation uses frozen brand text without references, gateway routing or platform credits", async () => {
        const brand = makeBrand("brand-a");
        const ownChannel = { id: "byok", name: "Own", baseUrl: "https://supplier.test", apiKey: "own-key", apiFormat: "openai" as const, models: [{ name: "own-image", capability: "image" as const }] };
        const config = { ...useConfigStore.getState().config, model: "byok::own-image", count: "1", systemPrompt: "own system", channels: [ownChannel], platformContext: { workspaceId: "ws-a", sessionGeneration: useSessionStore.getState().generation, brandReady: true, brand } };
        useBrandStore.setState({ brand: makeBrand("brand-b") });
        useCreditsStore.getState().setBalance("ws-a", 200);
        let sent!: InternalAxiosRequestConfig;
        axios.defaults.adapter = async (request) => { sent = request; return response(request, { data: [{ b64_json: "AA==" }] }); };
        await requestGeneration(config, "product shot");
        const body = JSON.parse(String(sent.data));
        expect(sent.url).toBe("https://supplier.test/v1/images/generations");
        expect(body.prompt).toContain("[品牌] brand-a");
        expect(body.prompt).toContain("own system");
        expect(body.prompt).not.toContain("brand-b");
        expect(body.prompt).not.toContain("[参考图]");
        expect(body.image).toBeUndefined();
        expect(sent.headers.get("X-IC-Brand")).toBeUndefined();
        expect(useCreditsStore.getState().balances["ws-a"]).toBe(200);
    });

    test("M3 SKU download follows authenticated file redirects without leaking workspace headers to S3", async () => {
        let options!: RequestInit;
        globalThis.fetch = (async (_url, init) => { options = init!; return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } }); }) as typeof fetch;
        const asset = { id: "sku-a", title: "product.png", kind: "sku" as const, url: "/api/files/ws/ws-a/brands/brand-a/sku-a.png", spec: null, width: 1, height: 1, attachOnGenerate: false, tags: [], sort: 0 };
        const file = await downloadBrandAsset("ws-a", asset);
        expect(options.credentials).toBe("same-origin");
        expect(options.headers).toBeUndefined();
        expect(file.name).toBe("product.png");
        expect(file.type).toBe("image/png");
        expect(file.size).toBe(3);
        expect(parseBrandAssetDrag('{"url":"https://evil.test"}')).toBeNull();
    });

    test("M3 upload forwards signed headers, rejects invalid files, and stops linking after a workspace switch", async () => {
        let calls = 0;
        platformApi.defaults.adapter = async (config) => { calls++; return response(config, { uploadUrl: "https://storage.test/object", objectKey: "uploads/object", headers: { "Content-Type": "image/png", "x-amz-meta-purpose": "brand_asset" } }); };
        await expect(uploadBrandAsset("ws-a", "brand-a", new File(["text"], "text.txt", { type: "text/plain" }), { kind: "sku", title: "bad" })).rejects.toThrow();
        expect(calls).toBe(0);
        let headers: HeadersInit | undefined;
        globalThis.fetch = (async (_url, init) => { headers = init?.headers; useSessionStore.setState({ currentWorkspaceId: "ws-b" }); return new Response(null, { status: 200 }); }) as typeof fetch;
        await expect(uploadBrandAsset("ws-a", "brand-a", new File([new Uint8Array([1])], "product.png", { type: "image/png" }), { kind: "sku", title: "product" })).rejects.toThrow();
        expect(headers).toEqual({ "Content-Type": "image/png", "x-amz-meta-purpose": "brand_asset" });
        expect(calls).toBe(1);
    });
}
