import { useEffect } from "react";
import { App } from "antd";
import { useQuery } from "@tanstack/react-query";
import { fetchPlatformModels } from "@/services/api/platform/models";
import { useSessionStore } from "@/stores/use-session-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useCreditsStore } from "@/stores/use-credits-store";
import { InsufficientCreditsModal } from "@/components/billing/insufficient-credits-modal";
import "@/services/api/platform/gateway-observer";
import { BrandRuntime } from "@/components/brand/brand-runtime";

export function PlatformRuntime() {
    const { message } = App.useApp();
    const userId = useSessionStore((state) => state.user?.id);
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId);
    const generation = useSessionStore((state) => state.generation);
    const models = useQuery({ queryKey: ["platform", "models", userId, workspaceId, generation], queryFn: ({ signal }) => fetchPlatformModels(workspaceId!, signal), enabled: Boolean(userId && workspaceId) });
    useEffect(() => {
        useCreditsStore.getState().reset();
    }, [generation]);
    useEffect(() => { useConfigStore.getState().setPlatformModels(models.data || []); }, [models.data, workspaceId, generation]);
    useEffect(() => { if (models.error) message.error(models.error.message); }, [models.error, message]);
    useEffect(() => {
        const controller = new AbortController();
        useCreditsStore.getState().clearError();
        if (!userId || !workspaceId) return;
        void useCreditsStore.getState().refresh(workspaceId).catch((error: Error) => { if (!controller.signal.aborted) message.error(error.message); });
        return () => controller.abort();
    }, [userId, workspaceId, generation, message]);
    return <><BrandRuntime /><InsufficientCreditsModal /></>;
}
