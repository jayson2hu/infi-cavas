import { create } from "zustand";
import { fetchBrand, fetchBrands, type Brand, type BrandSummary } from "@/services/api/platform/brands";
import { useSessionStore } from "@/stores/use-session-store";
import type { AiConfig } from "@/stores/use-config-store";

type BrandState = {
    workspaceId: string | null;
    generation: number;
    brands: BrandSummary[];
    brand: Brand | null;
    defaultBrand: Brand | null;
    selections: Record<string, string>;
    ready: boolean;
    error: string | null;
    overrides: Partial<AiConfig>;
    override: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    load: (workspaceId: string, generation: number) => Promise<void>;
    select: (brandId: string) => Promise<void>;
    reset: () => void;
};
let revision = 0;
const empty = { workspaceId: null, generation: -1, brands: [], brand: null, defaultBrand: null, selections: {}, overrides: {}, ready: false, error: null };
const selectionKey = (workspaceId: string) => `infinite-canvas:brand:${useSessionStore.getState().user?.id}:${workspaceId}`;
export const useBrandStore = create<BrandState>((set, get) => ({
    ...empty,
    override: (key, value) => set((state) => ({ overrides: { ...state.overrides, [key]: value } })),
    load: async (workspaceId, generation) => {
        if (useSessionStore.getState().generation !== generation || useSessionStore.getState().currentWorkspaceId !== workspaceId) return;
        const current = ++revision;
        const previous = get();
        const valid = () => current === revision && useSessionStore.getState().generation === generation && useSessionStore.getState().currentWorkspaceId === workspaceId;
        set({ ...(get().generation === generation ? {} : empty), workspaceId, generation, brands: previous.workspaceId === workspaceId && previous.generation === generation ? previous.brands : [], brand: null, defaultBrand: null, ready: false, error: null });
        try {
            const brands = await fetchBrands(workspaceId);
            if (!valid()) return;
            const defaultId = brands.find((brand) => brand.isDefault)?.id;
            let selected: string | undefined = get().selections[workspaceId];
            if (selected === undefined) { try { selected = localStorage.getItem(selectionKey(workspaceId)) || undefined; } catch { /* Storage can be disabled by the browser. */ } }
            const selectedId = selected === "none" ? null : brands.some((brand) => brand.id === selected) ? selected : defaultId;
            const [defaultBrand, selectedBrand] = await Promise.all([defaultId ? fetchBrand(workspaceId, defaultId) : null, selectedId && selectedId !== defaultId ? fetchBrand(workspaceId, selectedId) : null]);
            if (!valid()) return;
            const brand = selectedId === defaultId || (!selectedId && defaultBrand?.enforced) ? defaultBrand : selectedBrand;
            set({ brands, brand, defaultBrand, ready: true, overrides: previous.workspaceId === workspaceId && previous.generation === generation && previous.brand?.id === brand?.id ? previous.overrides : {} });
        } catch (error) { if (valid()) set({ ready: false, error: (error as Error).message }); }
    },
    select: async (brandId) => {
        const { workspaceId, generation } = get();
        if (!workspaceId || useSessionStore.getState().generation !== generation || useSessionStore.getState().currentWorkspaceId !== workspaceId) return;
        set((state) => ({ selections: { ...state.selections, [workspaceId]: brandId } }));
        try { localStorage.setItem(selectionKey(workspaceId), brandId); } catch { /* Selection still works for this session. */ }
        await get().load(workspaceId, generation);
    },
    reset: () => { revision++; set(empty); },
}));
