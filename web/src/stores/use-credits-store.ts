import { create } from "zustand";
import { fetchBillingSummary } from "@/services/api/platform/billing";
import type { CreditError } from "@/services/api/platform/types";
import { useSessionStore } from "@/stores/use-session-store";

type CreditsState = {
    balances: Record<string, number>;
    billingEnabled: Record<string, boolean>;
    error: CreditError | null;
    setBalance: (workspaceId: string, balance: number, generation?: number) => void;
    refresh: (workspaceId: string) => Promise<void>;
    showError: (error: CreditError, generation?: number) => void;
    clearError: () => void;
    reset: () => void;
};
const revisions = new Map<string, number>();
let epoch = 0;
export const useCreditsStore = create<CreditsState>((set, get) => ({
    balances: {}, billingEnabled: {}, error: null,
    setBalance: (workspaceId, balance, generation = useSessionStore.getState().generation) => { if (generation === useSessionStore.getState().generation && Number.isSafeInteger(balance) && balance >= 0) { revisions.set(workspaceId, (revisions.get(workspaceId) || 0) + 1); set((state) => ({ balances: { ...state.balances, [workspaceId]: balance } })); } },
    refresh: (workspaceId) => {
        const current = epoch;
        const generation = useSessionStore.getState().generation;
        const revision = (revisions.get(workspaceId) || 0) + 1;
        revisions.set(workspaceId, revision);
        const request = fetchBillingSummary(workspaceId).then((summary) => {
            if (epoch !== current || revisions.get(workspaceId) !== revision || generation !== useSessionStore.getState().generation) return;
            get().setBalance(workspaceId, summary.balance);
            set((state) => ({ billingEnabled: { ...state.billingEnabled, [workspaceId]: summary.billingEnabled } }));
        });
        return request;
    },
    showError: (error, generation = useSessionStore.getState().generation) => { if (generation === useSessionStore.getState().generation) set({ error }); },
    clearError: () => set({ error: null }),
    reset: () => { epoch++; revisions.clear(); set({ balances: {}, billingEnabled: {}, error: null }); },
}));
