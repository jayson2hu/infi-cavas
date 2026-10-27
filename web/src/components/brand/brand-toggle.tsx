import { Switch, Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import type { AiConfig } from "@/stores/use-config-store";
import { effectiveBrand } from "@/lib/platform-brand";

export function BrandToggle({ config, enabled, onChange }: { config: AiConfig; enabled: boolean; onChange: (enabled: boolean) => void }) {
    const { t } = useTranslation();
    const context = config.platformContext;
    const brand = effectiveBrand(context, true);
    if (!brand && !context?.defaultBrand) return null;
    const enforced = Boolean(brand?.enforced || context?.defaultBrand?.enforced);
    return <div className="mt-3 space-y-1 text-[11px]" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-2"><span className="truncate">{t("platform.applyBrand", { name: brand?.name || context?.defaultBrand?.name })}</span><Tooltip title={enforced ? t("platform.brandEnforced") : undefined}><Switch size="small" aria-label={t("platform.brandKit")} checked={enforced || enabled} disabled={enforced || context?.brandReady === false} onChange={onChange} /></Tooltip></div>
        {enforced ? <p className="opacity-60">{t("platform.brandEnforced")}</p> : null}
        {!config.model.startsWith("platform::") ? <p className="opacity-60">{t("platform.brandByokTextOnly")}</p> : null}
    </div>;
}
