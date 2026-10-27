import { nanoid } from "nanoid";
import { validateTemplateSemantics, type TemplateBody, type TemplateNodeOp } from "../../../../shared/template";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { CANVAS_NODE_DIMENSIONS } from "@/constant/canvas-dimensions";
import { GROUP_WRAP_PADDING, GROUP_WRAP_TOP_PADDING } from "@/lib/canvas/canvas-node-geometry";
import type { CanvasNodeMetadata, Position } from "@/types/canvas";
import { TemplateError } from "./errors";
import type { TemplateImageValue, TemplateRun, TemplateValues } from "./types";

const nodeOps = (body: TemplateBody) => body.ops.filter((op): op is TemplateNodeOp => op.type === "add_node");

type NodeSizeResolver = (nodeType: string) => { width: number; height: number };
const defaultNodeSize: NodeSizeResolver = (type) => CANVAS_NODE_DIMENSIONS[type as keyof typeof CANVAS_NODE_DIMENSIONS] ?? CANVAS_NODE_DIMENSIONS.image;

export function templateBounds(body: TemplateBody, nodeSize: NodeSizeResolver = defaultNodeSize) {
    const nodes = nodeOps(body);
    if (!nodes.length) throw new TemplateError("emptySelection");
    return nodes.reduce((bounds, node, index) => {
        const spec = nodeSize(node.nodeType);
        const x = node.x ?? index * 36;
        const y = node.y ?? index * 36;
        return { left: Math.min(bounds.left, x), top: Math.min(bounds.top, y), right: Math.max(bounds.right, x + (node.width ?? spec.width)), bottom: Math.max(bounds.bottom, y + (node.height ?? spec.height)) };
    }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
}

export function instantiateTemplate(template: { id: string; name: string; body: TemplateBody }, values: TemplateValues, origin: Position, options: { idFactory?: () => string; images?: Record<string, TemplateImageValue>; groupTitle?: string; nodeSize?: NodeSizeResolver } = {}) {
    let issues;
    try { issues = validateTemplateSemantics(template.body); } catch { throw new TemplateError("invalid"); }
    if (issues.length) throw new TemplateError("invalid", issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) throw new TemplateError("invalid", "origin");
    const nodes = nodeOps(template.body);
    const locals = new Set(nodes.map((node) => node.id));
    const used = new Set<string>();
    const createId = () => {
        const id = (options.idFactory ?? nanoid)();
        if (!id || used.has(id) || locals.has(id)) throw new TemplateError("idCollision");
        used.add(id);
        return id;
    };
    const mapping = new Map(nodes.map((node) => [node.id, createId()]));
    const idMap = Object.fromEntries(mapping);
    const groupId = createId();
    const textValues = new Map<string, string>();
    const images = new Map(Object.entries(options.images ?? {}));
    const assertImage = (image: TemplateImageValue, label: string) => {
        if (!image.content || !image.storageKey || !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) || !Number.isFinite(image.naturalWidth) || image.naturalWidth <= 0 || !Number.isFinite(image.naturalHeight) || image.naturalHeight <= 0 || !Number.isFinite(image.bytes) || image.bytes <= 0) throw new TemplateError("imageMissing", label);
    };
    for (const [nodeId, image] of images) {
        if (!nodes.some((node) => node.id === nodeId && node.nodeType === "image")) throw new TemplateError("invalid", nodeId);
        assertImage(image, nodeId);
    }
    for (const variable of template.body.variables) {
        const supplied = Object.hasOwn(values, variable.key) ? values[variable.key] : undefined;
        if (variable.type === "image") {
            if (!supplied || typeof supplied === "string") {
                if ((variable.required !== false || supplied) && !images.has(variable.bindNode!)) throw new TemplateError("imageMissing", variable.label);
                continue;
            }
            assertImage(supplied, variable.label);
            images.set(variable.bindNode!, supplied);
        } else {
            const value = supplied ?? variable.default ?? "";
            if (typeof value !== "string") throw new TemplateError("invalid", variable.label);
            if (variable.required !== false && !value.trim()) throw new TemplateError("required", variable.label);
            if (variable.type === "select" && value && !variable.options?.includes(value)) throw new TemplateError("option", variable.label);
            textValues.set(variable.key, value);
        }
    }
    // A single pass rewrites only template syntax. Variable contents remain literal.
    const replace = (value: unknown): unknown => {
        if (typeof value === "string") return value.replace(/\{\{var\.([^{}]+)\}\}|@\[node:([^\]]+)\]/g, (_match, variable: string | undefined, nodeId: string | undefined) => variable !== undefined ? textValues.get(variable)! : `@[node:${mapping.get(nodeId!)!}]`);
        if (Array.isArray(value)) return value.map(replace);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
        return value;
    };
    const additions: CanvasAgentOp[] = nodes.map((node, index) => {
        const metadata = replace(node.metadata ?? {}) as CanvasNodeMetadata;
        const image = images.get(node.id);
        if (node.nodeType === "image" && metadata.content && !image) throw new TemplateError("imageMissing", node.title ?? node.id);
        const originalGroup = node.metadata?.groupId;
        metadata.groupId = typeof originalGroup === "string" ? mapping.get(originalGroup) : groupId;
        if (image) Object.assign(metadata, { content: image.content, storageKey: image.storageKey, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, mimeType: image.mimeType, bytes: image.bytes, status: "success" });
        return { type: "add_node", id: mapping.get(node.id)!, nodeType: node.nodeType, title: replace(node.title) as string | undefined, x: (node.x ?? index * 36) + origin.x, y: (node.y ?? index * 36) + origin.y, width: node.width, height: node.height, metadata };
    });
    const connections: CanvasAgentOp[] = template.body.ops.filter((op) => op.type === "connect_nodes").map((op) => ({ type: "connect_nodes", fromNodeId: mapping.get(op.fromNodeId)!, toNodeId: mapping.get(op.toNodeId)! }));
    const bounds = templateBounds(template.body, options.nodeSize);
    const templateRun: TemplateRun = { templateId: template.id, templateName: template.name, steps: structuredClone(template.body.steps), idMap, stepIndex: 0, status: "idle", completedNodeIds: [] };
    const group: CanvasAgentOp = { type: "add_node", id: groupId, nodeType: "group", title: options.groupTitle ?? `模板 · ${template.name}`, x: bounds.left + origin.x - GROUP_WRAP_PADDING, y: bounds.top + origin.y - GROUP_WRAP_TOP_PADDING, width: bounds.right - bounds.left + GROUP_WRAP_PADDING * 2, height: bounds.bottom - bounds.top + GROUP_WRAP_PADDING + GROUP_WRAP_TOP_PADDING, metadata: { templateRun } as CanvasNodeMetadata };
    // All nodes precede connections, including when a valid template lists edges first.
    return { ops: [...additions, group, ...connections, { type: "select_nodes", ids: [groupId] } as CanvasAgentOp], idMap, groupId };
}
