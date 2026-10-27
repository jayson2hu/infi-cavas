import { useEffect } from "react";
import { Alert, Button, Skeleton } from "antd";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/use-session-store";
import { PlatformRuntime } from "./platform-runtime";

export function PlatformSessionRoot() {
    const { t } = useTranslation();
    const status = useSessionStore((state) => state.status);
    const error = useSessionStore((state) => state.error);
    const initialize = useSessionStore((state) => state.initialize);
    useEffect(() => { void initialize(); }, [initialize]);
    if (status === "idle" || status === "loading") return <div className="platform-page"><Skeleton active paragraph={{ rows: 6 }} /></div>;
    if (status === "error") return <div className="platform-page"><Alert type="error" showIcon title={t("platform.loadFailed")} description={error} action={<Button onClick={() => void initialize()}>{t("platform.retry")}</Button>} /></div>;
    return <><PlatformRuntime /><Outlet /></>;
}

export function RequireSession() {
    const user = useSessionStore((state) => state.user);
    const switching = useSessionStore((state) => state.switching);
    const location = useLocation();
    if (!user) return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />;
    if (switching) return <div className="platform-page"><Skeleton active paragraph={{ rows: 6 }} /></div>;
    return <Outlet />;
}
