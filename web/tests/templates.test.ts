import { describe, expect, test } from "bun:test";
import { instantiateTemplate, templateBounds } from "../src/lib/templates/instantiate";
import { serializeTemplate, templateImageInputs, templateSelection } from "../src/lib/templates/serialize";
import { resetTemplateRun, runTemplateSteps } from "../src/lib/templates/run";
import { TemplateError } from "../src/lib/templates/errors";
import type { TemplateImageValue, TemplateRun } from "../src/lib/templates/types";
import type { TemplateBody } from "../../shared/template";
import type { CanvasConnection, CanvasNodeData } from "../src/types/canvas";
import example from "../../specs/template-example.json";

const image: TemplateImageValue = { content: "blob:local-product", storageKey: "image:local-product", naturalWidth: 640, naturalHeight: 480, mimeType: "image/png", bytes: 1234 };
const ids = () => { let index = 0; return () => `fresh-${++index}`; };
const template = () => ({ id: example.id, name: example.name, body: structuredClone(example.body) as TemplateBody });
const inputValues = () => ({ product: image, sellingPoints: "自然清香", scene: example.body.variables[2].default! });
const nodesOf = (ops: ReturnType<typeof instantiateTemplate>["ops"]) => ops.filter((op) => op.type === "add_node");
const node = (id: string, type: string, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({ id, type, title: id, position: { x: 100, y: 200 }, width: 240, height: 180, metadata });
const edge = (from: string, to: string): CanvasConnection => ({ id: `${from}-${to}`, fromNodeId: from, toNodeId: to });

describe("template instantiation", () => {
    test("authoritative ecommerce example remaps all IDs, inputs, positions, edges and runtime steps without mutation", () => {
        const original = template(); const snapshot = JSON.stringify(original);
        const result = instantiateTemplate(original, inputValues(), { x: 1000, y: 500 }, { idFactory: ids() });
        const nodes = nodesOf(result.ops);
        expect(new Set(nodes.map((node) => node.id)).size).toBe(7);
        expect(nodes.every((node) => !Object.keys(result.idMap).includes(node.id!))).toBe(true);
        expect(nodes.find((node) => node.id === result.idMap.product)?.metadata).toMatchObject({ ...image, groupId: result.groupId, status: "success" });
        expect(nodes.find((node) => node.id === result.idMap.points)?.metadata?.content).toBe("自然清香");
        expect(nodes.find((node) => node.id === result.idMap.scene)).toMatchObject({ x: 1380, y: 600, metadata: { count: 5 } });
        expect(nodes.find((node) => node.id === result.idMap.size_tb)).toMatchObject({ x: 1760, y: 440 });
        expect(result.ops.filter((op) => op.type === "connect_nodes")).toHaveLength(5);
        expect(result.ops.at(-1)).toEqual({ type: "select_nodes", ids: [result.groupId] });
        expect(nodes.at(-1)?.metadata?.templateRun).toMatchObject({ templateId: original.id, stepIndex: 0, status: "idle", completedNodeIds: [], idMap: result.idMap });
        expect(JSON.stringify(original)).toBe(snapshot);
        expect(templateBounds(original.body)).toEqual({ left: 0, top: -60, right: 980, bottom: 810 });
    });
    test("variables are substituted once and references in template strings map correctly", () => {
        const source = template();
        const scene = source.body.ops.find((op) => op.type === "add_node" && op.id === "scene")! as Extract<TemplateBody["ops"][number], { type: "add_node" }>;
        scene.title = "{{var.sellingPoints}} @[node:product]";
        scene.metadata!.prompt = "{{var.sellingPoints}} 与 @[node:product]";
        const result = instantiateTemplate(source, { ...inputValues(), sellingPoints: "字面 {{var.scene}} @[node:external] $&" }, { x: 0, y: 0 }, { idFactory: ids() });
        const generated = nodesOf(result.ops).find((node) => node.id === result.idMap.scene)!;
        expect(generated.title).toBe(`字面 {{var.scene}} @[node:external] $& @[node:${result.idMap.product}]`);
        expect(generated.metadata?.prompt).toBe(`字面 {{var.scene}} @[node:external] $& 与 @[node:${result.idMap.product}]`);
    });
    test("edges may precede nodes; nested groups and prototype-like local IDs remain safe", () => {
        const body: TemplateBody = { version: 1, variables: [], ops: [
            { type: "connect_nodes", fromNodeId: "constructor", toNodeId: "output" },
            { type: "add_node", id: "constructor", nodeType: "text", metadata: { content: "输入", groupId: "__proto__" } },
            { type: "add_node", id: "__proto__", nodeType: "group" },
            { type: "add_node", id: "output", nodeType: "image", metadata: { prompt: "@[node:constructor]", groupId: "__proto__" } },
        ], steps: [{ label: "出图", nodeIds: ["output"], mode: "image" }] };
        const result = instantiateTemplate({ id: "t", name: "T", body }, {}, { x: 0, y: 0 }, { idFactory: ids() });
        const nodes = nodesOf(result.ops);
        expect(nodes.find((node) => node.id === result.idMap.constructor)?.metadata?.groupId).toBe(result.idMap.__proto__);
        expect(nodes.find((node) => node.id === result.idMap.__proto__)?.metadata?.groupId).toBe(result.groupId);
        expect(result.ops.findIndex((op) => op.type === "connect_nodes")).toBe(4);
        expect({}.toString).toBe(Object.prototype.toString);
    });
    test("required variables, select options, image preparation and duplicate ID factories reject before insertion", () => {
        expect(() => instantiateTemplate(template(), { ...inputValues(), sellingPoints: " " }, { x: 0, y: 0 })).toThrow(TemplateError);
        expect(() => instantiateTemplate(template(), { ...inputValues(), scene: "未知场景" }, { x: 0, y: 0 })).toThrow(TemplateError);
        expect(() => instantiateTemplate(template(), { ...inputValues(), product: "/api/files/ws/x/input.png" }, { x: 0, y: 0 })).toThrow(TemplateError);
        expect(() => instantiateTemplate(template(), inputValues(), { x: 0, y: 0 }, { idFactory: () => "same" })).toThrow(TemplateError);
        const source = template(); source.body.variables = source.body.variables.filter((variable) => variable.type !== "image");
        const product = source.body.ops.find((op) => op.type === "add_node" && op.id === "product") as Extract<TemplateBody["ops"][number], { type: "add_node" }>;
        product.metadata = { content: "/api/files/ws/test/input.png" };
        expect(() => instantiateTemplate(source, inputValues(), { x: 0, y: 0 })).toThrow(TemplateError);
        const result = instantiateTemplate(source, inputValues(), { x: 0, y: 0 }, { images: { product: image }, idFactory: ids() });
        expect(nodesOf(result.ops).find((node) => node.id === result.idMap.product)?.metadata?.storageKey).toBe(image.storageKey);
    });
    test("prototype-like variable names use explicit values or declared defaults", () => {
        const source = template();
        source.body.variables.push({ key: "constructor", label: "合法变量", type: "text", default: "默认文案" });
        const points = source.body.ops.find((op) => op.type === "add_node" && op.id === "points") as Extract<TemplateBody["ops"][number], { type: "add_node" }>;
        points.metadata!.content = "{{var.constructor}}";
        const result = instantiateTemplate(source, inputValues(), { x: 0, y: 0 });
        expect(nodesOf(result.ops).find((op) => op.id === result.idMap.points)?.metadata?.content).toBe("默认文案");
    });
});

describe("save canvas as template", () => {
    test("config plus historical result becomes one reusable target and downstream references follow it", () => {
        const nodes = [node("product", "image", { content: "blob:product", storageKey: "image:p" }), node("points", "text", { content: "卖点" }), node("config", "config", { generationMode: "image", prompt: "展示 @[node:product]", count: 5, model: "private-channel::gpt-image-2" }), node("old-result", "image", { prompt: "旧提示词", model: "private-channel::gpt-image-2", content: "blob:old", generationType: "edit", videoTaskId: "secret-task" }), node("resize", "image", { prompt: "适配 @[node:old-result]", generationMode: "image", size: "1088x1920" })];
        const connections = [edge("product", "config"), edge("points", "config"), edge("config", "old-result"), edge("old-result", "resize")];
        const input = { nodes, connections, imageContents: { product: "/api/files/ws/test/uploads/template_image/p.png" }, estimates: { config: 20, resize: 8 }, variables: [{ nodeId: "product", key: "product", label: "商品" }, { nodeId: "points", key: "points", label: "卖点" }] };
        const body = serializeTemplate(input);
        const additions = body.ops.filter((op) => op.type === "add_node");
        expect(additions).toHaveLength(4);
        expect(additions.find((op) => op.title === "config")).toMatchObject({ nodeType: "image", metadata: { count: 5, model: "gpt-image-2", generationMode: "image" } });
        expect(body.steps.map((step) => step.estimate)).toEqual([20, 8]);
        expect(body.variables.map((variable) => variable.type)).toEqual(["image", "text"]);
        expect(JSON.stringify(body)).not.toMatch(/blob:|private-channel|secret-task|old-result|storageKey/);
        expect(templateImageInputs(input).map((node) => node.id)).toEqual(["product"]);
        expect(nodes[3].metadata?.content).toBe("blob:old");
        const instance = instantiateTemplate({ id: "saved", name: "Saved", body }, { product: image, points: "新卖点" }, { x: 0, y: 0 }, { idFactory: ids() });
        expect(nodesOf(instance.ops)).toHaveLength(5);
    });
    test("independent generation nodes share a step and nested group selection retains members", () => {
        const nodes = [node("outer", "group"), node("inner", "group", { groupId: "outer" }), node("input", "text", { content: "输入", groupId: "inner" }), node("a", "image", { prompt: "A", groupId: "inner" }), node("b", "image", { prompt: "B", groupId: "outer" }), node("unselected", "text", { content: "外部" })];
        expect(templateSelection(nodes, ["outer"]).map((node) => node.id)).toEqual(["outer", "inner", "input", "a", "b"]);
        const body = serializeTemplate({ nodes, connections: [edge("input", "a"), edge("input", "b")], selectedNodeIds: ["outer"], estimates: { a: 4, b: 4 } });
        expect(body.steps).toHaveLength(1); expect(body.steps[0].nodeIds).toHaveLength(2); expect(body.steps[0].estimate).toBe(8);
        const instance = instantiateTemplate({ id: "nested", name: "Nested", body }, {}, { x: 0, y: 0 }, { idFactory: ids() });
        expect(nodesOf(instance.ops)).toHaveLength(6);
    });
    test("unprepared images, external mentions, cycles and empty generation workflows fail clearly", () => {
        const photo = node("p", "image", { content: "blob:p" }); const target = node("g", "image", { prompt: "生成" });
        expect(() => serializeTemplate({ nodes: [photo, target], connections: [] })).toThrow(TemplateError);
        expect(() => serializeTemplate({ nodes: [node("g", "image", { prompt: "@[node:missing]" })], connections: [] })).toThrow(TemplateError);
        expect(() => serializeTemplate({ nodes: [target, node("h", "image", { prompt: "另一个" })], connections: [edge("g", "h"), edge("h", "g")] })).toThrow(TemplateError);
        expect(() => serializeTemplate({ nodes: [node("text", "text", { content: "静态" })], connections: [] })).toThrow(TemplateError);
    });
    test("saved generation parameters capture effective defaults while explicit node choices keep priority", () => {
        const defaults = { config: { count: 5, size: "1024x1024", model: "platform::gpt-image-2" } };
        const body = serializeTemplate({ nodes: [node("config", "config", { prompt: "产品图", count: undefined })], connections: [], generationDefaults: defaults });
        expect(body.ops[0]).toMatchObject({ nodeType: "image", metadata: { count: 5, size: "1024x1024", model: "gpt-image-2" } });
        const overridden = serializeTemplate({ nodes: [node("config", "config", { prompt: "产品图", count: 2 })], connections: [], generationDefaults: defaults });
        expect(overridden.ops[0]).toMatchObject({ metadata: { count: 2 } });
    });
});

describe("template step runner", () => {
    const run = (): TemplateRun => ({ templateId: "t", templateName: "T", idMap: { a: "A", b: "B", c: "C" }, steps: [{ label: "parallel", nodeIds: ["a", "b"], mode: "image" }, { label: "next", nodeIds: ["c"], mode: "image" }], stepIndex: 0, status: "idle", completedNodeIds: [] });
    test("starts peers concurrently and never starts dependent step until every peer succeeds", async () => {
        const calls: string[] = []; const gates = new Map<string, (ok: boolean) => void>(); const snapshots: TemplateRun[] = [];
        const result = runTemplateSteps(run(), { signal: new AbortController().signal, onUpdate: (state) => { snapshots.push(state); }, generate: async (id) => { calls.push(id); return id === "C" ? true : new Promise<boolean>((resolve) => gates.set(id, resolve)); } });
        await new Promise((resolve) => setTimeout(resolve, 0)); expect(calls).toEqual(["A", "B"]);
        gates.get("A")!(true); await new Promise((resolve) => setTimeout(resolve, 0)); expect(calls).not.toContain("C");
        expect(snapshots.at(-1)).toMatchObject({ status: "running", stepIndex: 0, completedNodeIds: ["A"] });
        gates.get("B")!(true); const complete = await result;
        expect(calls).toEqual(["A", "B", "C"]); expect(complete.status).toBe("completed"); expect(complete.stepIndex).toBe(2);
    });
    test("failure stops the step; retry skips completed siblings and resets only on explicit rerun", async () => {
        const failed = await runTemplateSteps(run(), { signal: new AbortController().signal, onUpdate: () => {}, generate: async (id) => id !== "B" });
        expect(failed.status).toBe("failed"); expect(failed.stepIndex).toBe(0); expect(failed.completedNodeIds).toEqual(["A"]);
        const calls: string[] = [];
        const retried = await runTemplateSteps(failed, { signal: new AbortController().signal, onUpdate: () => {}, generate: async (id) => { calls.push(id); return true; } });
        expect(calls).toEqual(["B", "C"]); expect(retried.status).toBe("completed");
        expect(resetTemplateRun(retried)).toMatchObject({ status: "idle", stepIndex: 0, completedNodeIds: [] });
    });
    test("abort propagates stopped state and never advances to downstream nodes", async () => {
        const controller = new AbortController(); const calls: string[] = [];
        const pending = runTemplateSteps(run(), { signal: controller.signal, onUpdate: () => {}, generate: async (id) => { calls.push(id); return new Promise<boolean>((resolve) => controller.signal.addEventListener("abort", () => resolve(false), { once: true })); } });
        await new Promise((resolve) => setTimeout(resolve, 0)); controller.abort();
        const result = await pending; expect(result.status).toBe("stopped"); expect(result.stepIndex).toBe(0); expect(calls).toEqual(["A", "B"]);
    });
});
