import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { instantiateTemplate, templateBounds } from "@/lib/templates/instantiate";
import { resetTemplateRun, runTemplateSteps } from "@/lib/templates/run";
import type { TemplateRun } from "@/lib/templates/types";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { isRegisteredNodeType } from "@/lib/canvas/node-registry";
import { getNodeSpec } from "@/constant/canvas";
import type { CanvasGenerationMode, CanvasNodeData, Position } from "@/types/canvas";
import { assertBrandSession } from "@/services/api/platform/brands";
import { useTemplate, type TemplateInsertion } from "@/services/api/platform/templates";
import { useSessionStore } from "@/stores/use-session-store";
import { isPlatformEnabled } from "@/lib/platform";
import { templateErrorMessage } from "@/components/templates/template-error";

export function useCanvasTemplates({ projectId, loaded, nodes, nodesRef, selectedNodeIds, setNodes, applyOps, undoOps, center, generate, stopNode }: {
    projectId: string; loaded: boolean; nodes: CanvasNodeData[]; nodesRef: MutableRefObject<CanvasNodeData[]>; selectedNodeIds: Set<string>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>; applyOps: (ops: CanvasAgentOp[]) => CanvasAgentSnapshot; undoOps: () => unknown; center: () => Position;
    generate: (nodeId: string, mode: CanvasGenerationMode, prompt: string, options: { forceInPlace: boolean }) => Promise<boolean>; stopNode: (nodeId: string) => void;
}) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const location = useLocation();
    const navigate = useNavigate();
    const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
    const [undoGroupId, setUndoGroupId] = useState<string | null>(null);
    const [saveOpen, setSaveOpen] = useState(false);
    const inserted = useRef(new Set<string>());
    const insertionNodes = useRef<CanvasNodeData[] | null>(null);
    const liveProject = useRef(projectId);
    liveProject.current = projectId;
    const stopNodeRef = useRef(stopNode);
    stopNodeRef.current = stopNode;
    const running = useRef<{ groupId: string; controller: AbortController; nodeIds: string[] } | null>(null);
    const selectedGroup = nodes.find((node) => selectedNodeIds.has(node.id) && node.metadata?.templateRun);
    const group = nodes.find((node) => node.id === running.current?.groupId) || selectedGroup || nodes.find((node) => node.id === activeGroupId) || nodes.find((node) => node.metadata?.templateRun);
    const stop = useCallback(() => {
        const current = running.current;
        if (!current) return;
        current.controller.abort();
        current.nodeIds.forEach((nodeId) => stopNodeRef.current(nodeId));
    }, []);
    useEffect(() => { setActiveGroupId(null); setUndoGroupId(null); return () => { stop(); running.current = null; }; }, [projectId, stop]);
    useEffect(() => useSessionStore.subscribe((state, previous) => { if (state.generation !== previous.generation || state.currentWorkspaceId !== previous.currentWorkspaceId) stop(); }), [stop]);
    useEffect(() => { if (running.current && !nodes.some((node) => node.id === running.current?.groupId)) stop(); }, [nodes, stop]);
    const insert = useCallback(async (input: TemplateInsertion) => {
        assertBrandSession(input.workspaceId, input.generation);
        if (!loaded) throw new Error(t("platform.templateNotReady"));
        const unavailable = input.template.body.ops.filter((op) => op.type === "add_node" && !isRegisteredNodeType(op.nodeType));
        if (unavailable.length) throw new Error(t("platform.templateMissingPlugin"));
        const bounds = templateBounds(input.template.body, getNodeSpec);
        const point = center();
        const result = instantiateTemplate(input.template, input.values, { x: point.x - (bounds.left + bounds.right) / 2, y: point.y - (bounds.top + bounds.bottom) / 2 }, { images: input.images, groupTitle: t("platform.templateGroupTitle", { name: input.template.name }), nodeSize: getNodeSpec });
        insertionNodes.current = applyOps(result.ops).nodes;
        setActiveGroupId(result.groupId); setUndoGroupId(result.groupId);
        message.success(t("platform.templateReady"));
        // Counting usage is independent from insertion and never repeats the canvas mutation.
        try { await useTemplate(input.workspaceId, input.template.id); }
        catch (error) { message.warning((error as Error).message); }
    }, [applyOps, center, loaded, message, t]);
    useEffect(() => {
        const input = (location.state as { templateInsertion?: TemplateInsertion } | null)?.templateInsertion;
        if (!isPlatformEnabled() || !loaded || !input || inserted.current.has(location.key)) return;
        inserted.current.add(location.key);
        navigate(location.pathname, { replace: true, state: null });
        void insert(input).catch((error) => message.error(templateErrorMessage(error)));
    }, [insert, loaded, location.key, location.pathname, location.state, message, navigate]);
    const run = async () => {
        if (!group?.metadata?.templateRun || running.current) return;
        const { currentWorkspaceId, generation } = useSessionStore.getState();
        if (!currentWorkspaceId) return;
        flushSync(() => setNodes((current) => { nodesRef.current = current; return current; }));
        const source = nodesRef.current.find((node) => node.id === group.id)?.metadata?.templateRun;
        if (!source) return;
        const initial = source.status === "completed" ? resetTemplateRun(source) : source;
        const recoveringVideos = new Map(source.status === "completed" ? [] : nodesRef.current.filter((node) => node.type === "video" && node.metadata?.videoTaskId && !node.metadata.content && Object.values(initial.idMap).includes(node.id)).map((node) => [node.id, node.metadata!.videoTaskId!]));
        const controller = new AbortController();
        const scope = { groupId: group.id, controller, nodeIds: Object.values(initial.idMap) };
        running.current = scope;
        setUndoGroupId(null);
        const update = (run: TemplateRun) => {
            if (running.current !== scope || liveProject.current !== projectId) return;
            flushSync(() => setNodes((current) => { const next = current.map((node) => node.id === group.id ? { ...node, metadata: { ...node.metadata, templateRun: run } } : node); nodesRef.current = next; return next; }));
        };
        try {
            const result = await runTemplateSteps(initial, { signal: controller.signal, onUpdate: update, generate: async (nodeId, mode) => {
                assertBrandSession(currentWorkspaceId, generation);
                if (controller.signal.aborted) return false;
                flushSync(() => setNodes((current) => { nodesRef.current = current; return current; }));
                const target = nodesRef.current.find((node) => node.id === nodeId);
                if (!target) throw new Error(t("platform.templateRunMissing"));
                if (recoveringVideos.has(nodeId) && target.metadata?.status === "success" && target.metadata.content && (!target.metadata.videoTaskId || target.metadata.videoTaskId === recoveringVideos.get(nodeId))) return true;
                const ok = await generate(nodeId, mode, target.metadata?.composerContent ?? target.metadata?.prompt ?? "", { forceInPlace: true });
                if (liveProject.current !== projectId || running.current !== scope) return false;
                flushSync(() => setNodes((current) => { nodesRef.current = current; return current; }));
                return ok && !controller.signal.aborted;
            } });
            if (liveProject.current !== projectId || running.current !== scope) return;
            if (result.status === "completed") message.success(t("platform.templateComplete"));
            else if (result.status === "failed") message.error(result.error || t("platform.templateFailed"));
        } catch (error) { update({ ...initial, status: "failed", error: templateErrorMessage(error) }); message.error(templateErrorMessage(error)); }
        finally { if (running.current === scope) running.current = null; }
    };
    const undo = () => { if (running.current) return; undoOps(); setUndoGroupId(null); setActiveGroupId(null); };
    return { group, insert, run, stop, undo: undoGroupId && nodes === insertionNodes.current && nodes.some((node) => node.id === undoGroupId) ? undo : undefined, saveOpen, setSaveOpen };
}
