import { useTranslation } from "react-i18next";
import { estimateConfigCredits, formatPriceHint, modelPriceRule } from "@/lib/platform-pricing";
import { useCreditsStore } from "@/stores/use-credits-store";
import { useSessionStore } from "@/stores/use-session-store";
import type { AiConfig } from "@/stores/use-config-store";

export function useGenerationCredits(config: AiConfig, input?: string, requests = 1) {
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId);
    const billing = useCreditsStore((state) => workspaceId ? state.billingEnabled[workspaceId] : undefined);
    const estimate = estimateConfigCredits(config, input);
    return billing === false || estimate === null ? null : estimate * requests;
}

export function GenerationCost({ config, input, requests = 1 }: { config: AiConfig; input?: string; requests?: number }) {
    const { t } = useTranslation();
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId);
    const balance = useCreditsStore((state) => workspaceId ? state.balances[workspaceId] : undefined);
    const billing = useCreditsStore((state) => workspaceId ? state.billingEnabled[workspaceId] : undefined);
    const rule = modelPriceRule(config);
    const estimate = useGenerationCredits(config, input, requests);
    if (!rule) return null;
    return <div className="my-2 space-y-1 text-[11px]" style={{ color: "var(--workspace-muted)" }}>
        <div>{billing === false ? t("platform.billingDisabled") : estimate === null ? formatPriceHint(rule) : t("platform.estimatedCredits", { count: estimate })}</div>
        {billing !== false && estimate !== null && balance !== undefined ? <div>{t("platform.remainingAfter", { count: Math.max(0, balance - estimate) })} · {t("platform.failedRefund")}</div> : null}
    </div>;
}
