import { Coins } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useCreditsStore } from "@/stores/use-credits-store";
import { useSessionStore } from "@/stores/use-session-store";

export function CreditsBadge() {
    const { t, i18n } = useTranslation();
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId);
    const balance = useCreditsStore((state) => workspaceId ? state.balances[workspaceId] : undefined);
    if (!workspaceId) return null;
    return <Link to="/billing" className="inline-flex items-center gap-1.5 text-xs" style={{ color: "var(--workspace-text)" }} title={t("platform.viewBilling")}><Coins size={15} /><span>{balance === undefined ? "—" : balance.toLocaleString(i18n.language)} {t("platform.credits")}</span></Link>;
}
