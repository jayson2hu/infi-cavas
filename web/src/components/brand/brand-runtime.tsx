import { useEffect } from "react";
import { useSessionStore } from "@/stores/use-session-store";
import { useBrandStore } from "@/stores/use-brand-store";

export function BrandRuntime() {
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId);
    const generation = useSessionStore((state) => state.generation);
    const defaultBrandId = useSessionStore((state) => state.workspaces.find((workspace) => workspace.id === state.currentWorkspaceId)?.defaultBrandId);
    useEffect(() => {
        if (workspaceId) void useBrandStore.getState().load(workspaceId, generation);
        else useBrandStore.getState().reset();
    }, [workspaceId, generation, defaultBrandId]);
    return null;
}
