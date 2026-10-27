import { Result, Tabs } from "antd";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/use-session-store";
import { ProvidersPanel } from "./providers";
import { ModelsPanel } from "./models";
import { WorkspacesPanel } from "./workspaces";
import { RedeemCodesPanel } from "./redeem-codes";

export default function AdminPage() {
    const { t } = useTranslation();
    const admin = useSessionStore((state) => state.user?.isPlatformAdmin);
    if (!admin) return <Result status="403" title="403" subTitle={t("platform.adminOnly")} />;
    return <main className="platform-page"><header className="platform-page-heading"><div><h1>{t("platform.adminTitle")}</h1><p>{t("platform.adminDescription")}</p></div></header><Tabs destroyOnHidden items={[{ key: "providers", label: t("platform.providers"), children: <ProvidersPanel /> }, { key: "models", label: t("platform.modelPricing"), children: <ModelsPanel /> }, { key: "workspaces", label: t("platform.workspaceCredits"), children: <WorkspacesPanel /> }, { key: "codes", label: t("platform.redeemCode"), children: <RedeemCodesPanel /> }]} /></main>;
}
