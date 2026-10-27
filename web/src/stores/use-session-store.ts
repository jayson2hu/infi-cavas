import { create } from "zustand";
import * as auth from "@/services/api/platform/auth";
import { bindPlatformSession, PlatformApiError } from "@/services/api/platform/client";
import type { Me, SessionUser, Workspace } from "@/services/api/platform/types";

type SessionState = {
    generation: number;
    user: SessionUser | null;
    workspaces: Workspace[];
    currentWorkspaceId: string | null;
    status: "idle" | "loading" | "ready" | "error";
    error: string | null;
    switching: boolean;
    initialize: () => Promise<void>;
    refresh: (workspaceId?: string) => Promise<void>;
    switchWorkspace: (workspaceId: string) => Promise<void>;
    login: (input: { email: string; password: string }) => Promise<void>;
    register: (input: auth.RegisterInput) => Promise<void>;
    logout: () => Promise<void>;
    clear: () => void;
};

let revision = 0;
let initializing: Promise<void> | null = null;
const anonymous = { user: null, workspaces: [], currentWorkspaceId: null, error: null, switching: false };

export const useSessionStore = create<SessionState>((set, get) => {
    const apply = (session: Me) => set({ ...session, generation: get().generation + (get().user?.id === session.user.id ? 0 : 1), status: "ready", error: null, switching: false });
    const authenticate = async (request: () => Promise<Me>) => {
        const current = ++revision;
        set({ ...anonymous, generation: get().generation + 1 });
        const session = await request();
        if (current === revision) apply(session);
    };
    return {
        ...anonymous,
        generation: 0,
        status: "idle",
        clear: () => { ++revision; set({ ...anonymous, generation: get().generation + 1, status: "ready" }); },
        initialize: () => {
            if (initializing) return initializing;
            if (get().status === "ready") return Promise.resolve();
            set({ status: "loading", error: null });
            initializing = get().refresh().catch((error: Error) => set({ status: "error", error: error.message })).finally(() => { initializing = null; });
            return initializing;
        },
        refresh: async (workspaceId) => {
            const current = ++revision;
            try {
                const session = await auth.fetchSession(workspaceId);
                if (current === revision) apply(session);
            } catch (error) {
                if (current !== revision) return;
                if (error instanceof PlatformApiError && error.status === 401) get().clear();
                else throw error;
            }
        },
        switchWorkspace: async (workspaceId) => {
            if (get().switching || workspaceId === get().currentWorkspaceId || !get().workspaces.some((workspace) => workspace.id === workspaceId)) return;
            set({ switching: true });
            try { await get().refresh(workspaceId); }
            finally { set({ switching: false }); }
        },
        login: (input) => authenticate(() => auth.login(input)),
        register: (input) => authenticate(() => auth.register(input)),
        logout: async () => { const current = get().generation; await auth.logout(); if (get().generation === current) get().clear(); },
    };
});

bindPlatformSession(() => useSessionStore.getState().currentWorkspaceId, () => useSessionStore.getState().clear(), () => useSessionStore.getState().generation);
