import { buildGenerationConfig, getGenerationCount } from "@/lib/canvas/canvas-generation-helpers";
import { estimateConfigCredits } from "@/lib/platform-pricing";
import { decodeChannelModel, type AiConfig } from "@/stores/use-config-store";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { TemplateBody } from "../../../../shared/template";
import type { TemplateValues } from "@/lib/templates/types";

function templateModelConfig(config: AiConfig, node: CanvasNodeData, mode: CanvasGenerationMode) {
    const effective = buildGenerationConfig(config, node, mode);
    if (decodeChannelModel(effective.model)) return effective;
    const channel = effective.channels.find((channel) => channel.models.some((model) => model.name === effective.model));
    return channel ? { ...effective, model: `${channel.id}::${effective.model}` } : effective;
}

export function estimateTemplateNodeCredits(config: AiConfig, node: CanvasNodeData, mode: CanvasGenerationMode, input = node.metadata?.composerContent ?? node.metadata?.prompt ?? "") {
    const effective = templateModelConfig(config, node, mode);
    const model = decodeChannelModel(effective.model);
    if (!model) return null;
    if (model.channelId !== "platform") return 0;
    const requests = mode === "image" ? getGenerationCount(effective.count) : mode === "text" ? getGenerationCount(String(node.metadata?.textCount || 1)) : 1;
    const amount = estimateConfigCredits(mode === "image" ? { ...effective, count: "1" } : effective, input);
    return amount === null ? null : amount * requests;
}

export function templateGenerationSnapshot(nodes: CanvasNodeData[], config: AiConfig) {
    const generationDefaults: Record<string, CanvasNodeMetadata> = {};
    const estimates: Record<string, number> = {};
    for (const node of nodes) {
        const mode = node.type === "config" ? node.metadata?.generationMode || "image" : node.type as CanvasGenerationMode;
        if (!["image", "text", "video", "audio"].includes(mode) || node.type !== "config" && !node.metadata?.generationMode && !node.metadata?.generationType && !node.metadata?.prompt) continue;
        const effective = buildGenerationConfig(config, node, mode);
        generationDefaults[node.id] = { generationMode: mode, model: effective.model, size: effective.size, quality: effective.quality, background: effective.background, count: getGenerationCount(effective.count), reasoningEffort: effective.reasoningEffort, ...(mode === "video" ? { seconds: effective.videoSeconds, vquality: effective.vquality, generateAudio: effective.videoGenerateAudio, watermark: effective.videoWatermark, videoMode: effective.videoMode } : {}), ...(mode === "audio" ? { audioVoice: effective.audioVoice, audioFormat: effective.audioFormat, audioSpeed: effective.audioSpeed, audioInstructions: effective.audioInstructions } : {}) };
        estimates[node.id] = estimateTemplateNodeCredits(config, node, mode) ?? 0;
    }
    return { generationDefaults, estimates };
}

export function templateEstimates(body: TemplateBody, config: AiConfig, values: TemplateValues = {}) {
    let platform = false;
    const nodes = new Map(body.ops.flatMap((op) => op.type === "add_node" ? [[op.id, op] as const] : []));
    const steps = body.steps.map((step) => {
        let total = 0;
        for (const id of step.nodeIds) {
            const op = nodes.get(id);
            if (!op) return null;
            const node = { id, type: op.nodeType, title: op.title || "", position: { x: op.x || 0, y: op.y || 0 }, width: op.width || 240, height: op.height || 240, metadata: op.metadata } as CanvasNodeData;
            const effective = templateModelConfig(config, node, step.mode);
            const model = decodeChannelModel(effective.model);
            if (!model) return null;
            if (model.channelId !== "platform") continue;
            platform = true;
            const prompt = String(op.metadata?.prompt || "").replace(/\{\{var\.([^{}]+)\}\}/g, (_, key) => typeof values[key] === "string" ? values[key] : "");
            const amount = estimateTemplateNodeCredits(config, node, step.mode, prompt);
            if (amount === null) return null;
            total += amount;
        }
        return total;
    });
    return { steps, platform, total: steps.every((value) => value !== null) ? steps.reduce<number>((sum, value) => sum + (value || 0), 0) : null };
}
