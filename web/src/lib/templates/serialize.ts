import { validateTemplateSemantics, type TemplateBody, type TemplateMode, type TemplateNodeOp, type TemplateVariable } from "../../../../shared/template";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { TemplateError } from "./errors";
import type { TemplateVariableBinding } from "./types";

export type SerializeTemplateInput = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds?: readonly string[];
    variables?: TemplateVariableBinding[];
    imageContents?: Record<string, string>;
    estimates?: Record<string, number>;
    generationDefaults?: Record<string, CanvasNodeMetadata>;
    stepLabel?: (index: number, mode: TemplateMode) => string;
};
const modes = new Set<string>(["text", "image", "video", "audio"]);
const transient = new Set(["status", "errorDetails", "images", "primaryImageId", "texts", "primaryTextId", "storageKey", "references", "templateRun", "videoTaskId", "videoTaskProvider", "videoTaskWorkspaceId", "videoTaskUserId"]);
const privateField = /^(api_?key|authorization|cookie|access_?token|platformContext|brandInstructions)$/i;

export function templateSelection(nodes: CanvasNodeData[], selectedNodeIds?: readonly string[]) {
    if (!selectedNodeIds?.length) return nodes;
    const selected = new Set(selectedNodeIds);
    let changed = true;
    while (changed) {
        changed = false;
        for (const node of nodes) if (node.metadata?.groupId && selected.has(node.metadata.groupId) && !selected.has(node.id)) { selected.add(node.id); changed = true; }
    }
    return nodes.filter((node) => selected.has(node.id));
}

function analyze(input: SerializeTemplateInput) {
    const selected = templateSelection(input.nodes, input.selectedNodeIds);
    if (!selected.length) throw new TemplateError("emptySelection");
    const selectedById = new Map(selected.map((node) => [node.id, node]));
    if (selectedById.size !== selected.length) throw new TemplateError("invalid");
    const bindings = new Map((input.variables ?? []).map((variable) => [variable.nodeId, variable]));
    const aliases = new Map<string, string>();
    // A config's generated children are past outputs of one operation, not additional operations.
    for (const node of selected) {
        if (node.type !== "config") continue;
        const mode = node.metadata?.generationMode ?? "image";
        for (const edge of input.connections.filter((edge) => edge.fromNodeId === node.id)) {
            const child = selectedById.get(edge.toNodeId);
            if (!child || child.type !== mode || bindings.has(child.id)) continue;
            const parents = input.connections.filter((connection) => connection.toNodeId === child.id && selectedById.get(connection.fromNodeId)?.type === "config");
            if (parents.length === 1 && (child.metadata?.generationType || (child.metadata?.model && child.metadata?.prompt))) aliases.set(child.id, node.id);
        }
    }
    const nodes = selected.filter((node) => !aliases.has(node.id));
    const generators = new Map<string, TemplateMode>();
    for (const node of nodes) {
        if (bindings.has(node.id)) continue;
        if (node.type === "config") generators.set(node.id, node.metadata?.generationMode ?? "image");
        else if (modes.has(node.type) && (node.metadata?.generationMode || node.metadata?.generationType || node.metadata?.prompt)) generators.set(node.id, node.type as TemplateMode);
    }
    return { selectedById, nodes, generators, aliases, bindings };
}

export function templateImageInputs(input: Pick<SerializeTemplateInput, "nodes" | "connections" | "selectedNodeIds" | "variables">) {
    const { nodes, generators } = analyze(input);
    return nodes.filter((node) => node.type === "image" && !generators.has(node.id) && Boolean(node.metadata?.content || node.metadata?.storageKey));
}

export function serializeTemplate(input: SerializeTemplateInput): TemplateBody {
    const { nodes, generators, aliases, bindings, selectedById } = analyze(input);
    if (!generators.size) throw new TemplateError("noSteps");
    const localIds = new Map(nodes.map((node, index) => [node.id, `node_${index + 1}`]));
    const local = (id: string) => localIds.get(aliases.get(id) ?? id);
    const variableKeys = new Set<string>();
    for (const binding of input.variables ?? []) {
        const node = selectedById.get(binding.nodeId);
        if (!node || !["text", "image"].includes(node.type)) throw new TemplateError("unsupportedVariable", binding.label);
        if (!/^[a-z][a-zA-Z0-9_]{0,31}$/.test(binding.key) || !binding.label.trim() || variableKeys.has(binding.key) || (input.variables ?? []).filter((item) => item.nodeId === binding.nodeId).length !== 1) throw new TemplateError("invalid", binding.key);
        variableKeys.add(binding.key);
    }
    const replace = (value: unknown): unknown => {
        if (typeof value === "string") return value.replace(/@\[node:([^\]]+)\]/g, (_match, id: string) => {
            const target = local(id);
            if (!target) throw new TemplateError("externalReference", id);
            return `@[node:${target}]`;
        });
        if (Array.isArray(value)) return value.map(replace);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !privateField.test(key)).map(([key, item]) => [key, replace(item)]));
        return value;
    };
    const left = Math.min(...nodes.map((node) => node.position.x));
    const top = Math.min(...nodes.map((node) => node.position.y));
    const variables: TemplateVariable[] = [];
    const additions: TemplateNodeOp[] = nodes.map((node) => {
        const mode = generators.get(node.id);
        const defaults = mode && input.generationDefaults && Object.hasOwn(input.generationDefaults, node.id) ? input.generationDefaults[node.id] : {};
        const explicit = Object.fromEntries(Object.entries(node.metadata ?? {}).filter(([, value]) => value !== undefined));
        const metadata: Record<string, unknown> = Object.fromEntries(Object.entries({ ...defaults, ...explicit }).filter(([key]) => !transient.has(key) && !privateField.test(key)));
        delete metadata.groupId;
        if (node.metadata?.groupId && local(node.metadata.groupId)) metadata.groupId = local(node.metadata.groupId);
        if (typeof metadata.model === "string" && metadata.model.includes("::")) metadata.model = metadata.model.slice(metadata.model.indexOf("::") + 2);
        if (mode) {
            metadata.generationMode = mode;
            metadata.prompt = node.metadata?.composerContent ?? node.metadata?.prompt ?? (node.type === "config" ? node.metadata?.content : "") ?? "";
            for (const key of ["content", "naturalWidth", "naturalHeight", "bytes", "mimeType", "durationMs", "generationType"]) delete metadata[key];
        } else if (node.type === "image" && (node.metadata?.content || node.metadata?.storageKey)) {
            const content = input.imageContents && Object.hasOwn(input.imageContents, node.id) ? input.imageContents[node.id] : undefined;
            if (!content?.startsWith("/api/files/")) throw new TemplateError("imageUploadMissing", node.title);
            metadata.content = content;
        }
        const binding = bindings.get(node.id);
        if (binding) {
            if (node.type === "image") variables.push({ key: binding.key, label: binding.label, type: "image", bindNode: local(node.id)!, required: binding.required ?? true, placeholder: binding.placeholder, allowBrandSku: binding.allowBrandSku ?? true, ...(typeof metadata.content === "string" ? { default: metadata.content } : {}) });
            else {
                variables.push({ key: binding.key, label: binding.label, type: "text", required: binding.required ?? true, placeholder: binding.placeholder, default: node.metadata?.content ?? "" });
                metadata.content = `{{var.${binding.key}}}`;
            }
        }
        return { type: "add_node", id: local(node.id)!, nodeType: mode ?? node.type, title: replace(node.title) as string, x: node.position.x - left, y: node.position.y - top, width: node.width, height: node.height, metadata: replace(metadata) as Record<string, unknown> };
    });
    const connections = new Map<string, { type: "connect_nodes"; fromNodeId: string; toNodeId: string }>();
    for (const edge of input.connections) {
        const from = local(edge.fromNodeId);
        const to = local(edge.toNodeId);
        if (from && to && from !== to) connections.set(`${from}\0${to}`, { type: "connect_nodes", fromNodeId: from, toNodeId: to });
    }
    const dependencies = new Map(additions.map((node) => [node.id, new Set<string>()]));
    for (const edge of connections.values()) dependencies.get(edge.toNodeId)!.add(edge.fromNodeId);
    for (const node of additions) {
        for (const field of ["content", "prompt", "composerContent"]) {
            const text = node.metadata?.[field];
            if (typeof text === "string") for (const match of text.matchAll(/@\[node:([^\]]+)\]/g)) dependencies.get(node.id)!.add(match[1]);
        }
        if (typeof node.metadata?.groupId === "string") dependencies.get(node.metadata.groupId)?.add(node.id);
    }
    const generatorLocals = new Map([...generators].map(([id, mode]) => [local(id)!, { id, mode }]));
    const depths = new Map<string, number>();
    const visiting = new Set<string>();
    const depth = (id: string): number => {
        if (depths.has(id)) return depths.get(id)!;
        if (visiting.has(id)) throw new TemplateError("cyclic");
        if (!dependencies.has(id)) throw new TemplateError("externalReference", id);
        visiting.add(id);
        const parents = [...dependencies.get(id)!];
        const result = Math.max(0, ...parents.map(depth)) + (generatorLocals.has(id) ? 1 : 0);
        visiting.delete(id); depths.set(id, result); return result;
    };
    additions.forEach((node) => depth(node.id));
    const levels = new Map<string, { depth: number; mode: TemplateMode; nodeIds: string[]; estimate: number }>();
    for (const [id, generator] of generatorLocals) {
        const level = depth(id);
        const key = `${level}:${generator.mode}`;
        const group = levels.get(key) ?? { depth: level, mode: generator.mode, nodeIds: [], estimate: 0 };
        const estimate = input.estimates && Object.hasOwn(input.estimates, generator.id) ? input.estimates[generator.id] : 0;
        if (!Number.isSafeInteger(estimate) || estimate < 0) throw new TemplateError("invalid", "estimate");
        group.nodeIds.push(id); group.estimate += estimate; levels.set(key, group);
    }
    const names = { text: "文本", image: "图片", video: "视频", audio: "语音" };
    const steps = [...levels.values()].sort((a, b) => a.depth - b.depth).map((step, index) => ({ label: input.stepLabel?.(index + 1, step.mode) ?? `${names[step.mode]} · ${index + 1}`, nodeIds: step.nodeIds, mode: step.mode, estimate: step.estimate }));
    const body: TemplateBody = { version: 1, variables, ops: [...additions, ...connections.values()], steps };
    const issues = validateTemplateSemantics(body);
    if (issues.length) throw new TemplateError("invalid", issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    return body;
}
