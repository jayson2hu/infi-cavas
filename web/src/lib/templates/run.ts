import type { TemplateMode } from "../../../../shared/template";
import type { TemplateRun } from "./types";
import { TemplateError } from "./errors";

export function resetTemplateRun(run: TemplateRun): TemplateRun {
    return { ...run, status: "idle", stepIndex: 0, completedNodeIds: [], error: undefined };
}

export async function runTemplateSteps(run: TemplateRun, options: {
    signal: AbortSignal;
    generate: (nodeId: string, mode: TemplateMode) => Promise<boolean>;
    onUpdate: (run: TemplateRun) => void | Promise<void>;
}): Promise<TemplateRun> {
    if (!Number.isInteger(run.stepIndex) || run.stepIndex < 0 || run.stepIndex > run.steps.length || !run.steps.length) throw new TemplateError("invalid", "stepIndex");
    const completed = new Set(run.completedNodeIds);
    let current: TemplateRun = { ...run, status: "running", error: undefined, completedNodeIds: [...completed] };
    const update = async (patch: Partial<TemplateRun>) => {
        current = { ...current, ...patch, completedNodeIds: [...completed] };
        await options.onUpdate(current);
    };
    await update({});
    for (let stepIndex = Math.max(0, run.stepIndex); stepIndex < run.steps.length; stepIndex++) {
        if (options.signal.aborted) { await update({ status: "stopped", stepIndex }); return current; }
        await update({ stepIndex });
        const step = run.steps[stepIndex];
        const results = await Promise.all(step.nodeIds.map(async (localId) => {
            const nodeId = Object.hasOwn(run.idMap, localId) ? run.idMap[localId] : undefined;
            if (!nodeId) return { ok: false };
            if (completed.has(nodeId)) return { ok: true };
            if (options.signal.aborted) return { ok: false };
            try {
                const ok = await options.generate(nodeId, step.mode);
                if (ok) { completed.add(nodeId); await update({}); }
                return { ok };
            } catch (error) { return { ok: false, error: error instanceof Error ? error.message : undefined }; }
        }));
        if (options.signal.aborted) { await update({ status: "stopped", stepIndex }); return current; }
        if (results.some((result) => !result.ok)) {
            await update({ status: "failed", stepIndex, error: results.find((result) => result.error)?.error });
            return current;
        }
        await update({ stepIndex: stepIndex + 1 });
    }
    await update({ status: "completed", stepIndex: run.steps.length });
    return current;
}
