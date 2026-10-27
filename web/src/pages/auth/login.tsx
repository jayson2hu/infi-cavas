import { useState } from "react";
import { Alert, Button, Form, Input } from "antd";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BRAND_NAME } from "@/constant/runtime-config";
import { safePlatformRedirect } from "@/lib/platform";
import { useSessionStore } from "@/stores/use-session-store";

export default function LoginPage() {
    const { t } = useTranslation();
    const [params] = useSearchParams();
    const navigate = useNavigate();
    const login = useSessionStore((state) => state.login);
    const user = useSessionStore((state) => state.user);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const redirect = safePlatformRedirect(params.get("redirect"));
    const inviteToken = /^\/invite\/([^/?#]+)$/.exec(redirect)?.[1];
    if (user) return <Navigate to={redirect} replace />;
    const submit = async (values: { email: string; password: string }) => {
        setBusy(true);
        setError(null);
        try { await login(values); navigate(redirect, { replace: true }); }
        catch (error) { setError((error as Error).message); }
        finally { setBusy(false); }
    };
    return (
        <main className="platform-auth">
            <section className="platform-auth-card">
                <img className="platform-auth-logo" src="/logo.svg" alt="" />
                <h1>{BRAND_NAME || t("meta.title")}</h1>
                <p className="platform-muted">{t("platform.tagline")}</p>
                <h2>{t("platform.login")}</h2>
                {error ? <Alert type="error" showIcon title={error} className="mb-5" /> : null}
                <Form layout="vertical" requiredMark={false} onFinish={submit} disabled={busy}>
                    <Form.Item name="email" label={t("platform.email")} rules={[{ required: true, message: t("platform.emailRequired") }, { type: "email", message: t("platform.emailInvalid") }]}><Input type="email" autoComplete="email" size="large" /></Form.Item>
                    <Form.Item name="password" label={t("platform.password")} rules={[{ required: true, message: t("platform.passwordRequired") }]}><Input.Password autoComplete="current-password" size="large" /></Form.Item>
                    <Button type="primary" size="large" htmlType="submit" block loading={busy}>{t("platform.login")}</Button>
                </Form>
                <p className="platform-auth-switch"><Link to={inviteToken ? `/register?inviteToken=${encodeURIComponent(inviteToken)}` : `/register?redirect=${encodeURIComponent(redirect)}`}>{t("platform.noAccount")}</Link></p>
                <a className="platform-attribution" href="https://github.com/basketikun/infinite-canvas" target="_blank" rel="noreferrer">{t("platform.basedOn")}</a>
            </section>
        </main>
    );
}
