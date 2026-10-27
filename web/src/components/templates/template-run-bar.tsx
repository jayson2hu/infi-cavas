import { App, Button, Tooltip } from "antd";
import { Play, Square, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCreditsStore } from "@/stores/use-credits-store";
import { useSessionStore } from "@/stores/use-session-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { TemplateBody } from "../../../../shared/template";
import { templateEstimates } from "./template-estimate";

export function TemplateRunBar({ group, nodes, onRun, onStop, onUndo }: { group?: CanvasNodeData; nodes: CanvasNodeData[]; onRun: () => Promise<void>; onStop: () => void; onUndo?: () => void }) {
    const { t } = useTranslation();
    const { modal } = App.useApp();
    const config = useEffectiveConfig({ source: "canvas" });
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId);
    const billingEnabled = useCreditsStore((state) => workspaceId ? state.billingEnabled[workspaceId] : undefined);
    const run = group?.metadata?.templateRun;
    if (!run) return null;
    const reverse = new Map(Object.entries(run.idMap).map(([local, actual]) => [actual, local]));
    const body: TemplateBody = { version: 1, variables: [], ops: nodes.filter((node) => reverse.has(node.id)).map((node) => ({ type: "add_node", id: reverse.get(node.id)!, nodeType: node.type, metadata: node.metadata })), steps: run.steps.map((step) => ({ ...step, nodeIds: run.status === "completed" ? step.nodeIds : step.nodeIds.filter((id) => !run.completedNodeIds.includes(run.idMap[id])) })).filter((step) => step.nodeIds.length) };
    const estimate = templateEstimates(body, config);
    const platformFree = estimate.platform && billingEnabled === false;
    const amount = platformFree ? 0 : estimate.total;
    const cost = platformFree ? t("platform.templatePlatformFree") : amount === null ? t("platform.templateNoPrice") : !estimate.platform && amount === 0 ? t("platform.templateByok") : t("platform.templateTotal", { count: amount });
    return <div data-template-run-bar className="absolute left-1/2 top-16 z-[75] flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-x-4 gap-y-1 px-3 py-2 text-xs" style={{ color: theme.node.text, background: theme.toolbar.panel }} onPointerDown={(event) => event.stopPropagation()}>
        <strong className="max-w-44 truncate">{run.templateName}</strong><Tooltip title={run.steps[run.stepIndex]?.label || t("platform.templateComplete")}><span>{t("platform.templateRunning", { current: Math.min(run.stepIndex + 1, run.steps.length), total: run.steps.length })} · {t(`platform.templateRunStatus.${run.status}`)}</span></Tooltip>
        {run.status === "running" ? <Button type="text" size="small" icon={<Square size={13} />} onClick={onStop}>{t("platform.templateStop")}</Button> : <Button type="text" size="small" icon={<Play size={13} />} onClick={() => modal.confirm({ title: t("platform.templateConfirm"), content: <><p>{t("platform.templateConfirmDescription")}</p><p className="mt-3 font-semibold">{cost}</p></>, okText: t("platform.templateRun"), onOk: () => { void onRun(); } })}>{t(run.status === "failed" || run.status === "stopped" ? "platform.templateResume" : "platform.templateRun")}{amount !== null && amount > 0 ? ` · ${t("platform.creditAmount", { count: amount })}` : ""}</Button>}
        {onUndo && run.status !== "running" ? <Button type="text" size="small" icon={<Undo2 size={13} />} onClick={onUndo}>{t("platform.templateUndo")}</Button> : null}
    </div>;
}
