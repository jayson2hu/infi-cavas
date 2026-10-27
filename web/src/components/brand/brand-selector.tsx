import { App, Button, Select } from "antd";
import { Palette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useBrandStore } from "@/stores/use-brand-store";
import { useSessionStore } from "@/stores/use-session-store";

export function BrandSelector({ compact = false }: { compact?: boolean }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const state = useBrandStore();
    const workspaceId = useSessionStore((session) => session.currentWorkspaceId);
    const generation = useSessionStore((session) => session.generation);
    if (!workspaceId) return null;
    const active = state.workspaceId === workspaceId && state.generation === generation;
    return <div className="flex min-w-0 items-center gap-1.5">
        <Palette size={15} className="shrink-0 opacity-60" />
        <Select aria-label={t("platform.currentBrand")} size={compact ? "small" : "middle"} variant={compact ? "borderless" : "outlined"} className={compact ? "w-36 max-w-[30vw]" : "w-full"} disabled={!active || !state.ready} loading={!active || (!state.ready && !state.error)} value={active ? state.brand?.id || "none" : undefined} placeholder={t("platform.currentBrand")} onChange={(value) => void state.select(value).catch((error: Error) => message.error(error.message))} options={[{ value: "none", label: t("platform.noBrand"), disabled: Boolean(state.defaultBrand?.enforced) }, ...state.brands.map((brand) => ({ value: brand.id, label: `${brand.name}${brand.isDefault ? ` · ${t("platform.defaultBrand")}` : ""}` }))]} />
        {state.error ? <Button size="small" type="text" title={state.error} onClick={() => void state.load(workspaceId, generation)}>{t("platform.retry")}</Button> : null}
    </div>;
}
