import { useState } from "react";
import { Alert, Button, Form, Input } from "antd";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BRAND_NAME } from "@/constant/runtime-config";
import { safePlatformRedirect } from "@/lib/platform";
import { useSessionStore } from "@/stores/use-session-store";

export default function RegisterPage() {
    const { t } = useTranslation();
    const [params] = useSearchParams();
    const navigate = useNavigate();
    const register = useSessionStore((state) => state.register);
    const user = useSessionStore((state) => state.user);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const redirect = safePlatformRedirect(params.get("redirect"));
    const inviteToken = params.get("inviteToken") || undefined;
    if (user) return <Navigate to={redirect} replace />;
    const submit = async (values: { email: string; password: string; name: string }) => {
        setBusy(true);
        setError(null);
        try { await register({ ...values, inviteToken }); navigate(redirect, { replace: true }); }
        catch (error) { setError((error as Error).message); }
        finally { setBusy(false); }
    };
    return (
        <main className="platform-auth">
            <section className="platform-auth-card">
                <img className="platform-auth-logo" src="/logo.svg" alt="" />
                <h1>{BRAND_NAME || t("meta.title")}</h1>
                <p className="platform-muted">{t("platform.tagline")}</p>
                <h2>{t("platform.register")}</h2>
                {error ? <Alert type="error" showIcon title={error} className="mb-5" /> : null}
                <Form layout="vertical" requiredMark={false} onFinish={submit} disabled={busy}>
                    <Form.Item name="name" label={t("platform.name")} rules={[{ required: true, whitespace: true, message: t("platform.nameRequired") }, { max: 40, message: t("platform.nameTooLong") }]}><Input autoComplete="name" size="large" maxLength={40} /></Form.Item>
                    <Form.Item name="email" label={t("platform.email")} rules={[{ required: true, message: t("platform.emailRequired") }, { type: "email", message: t("platform.emailInvalid") }]}><Input type="email" autoComplete="email" size="large" /></Form.Item>
                    <Form.Item name="password" label={t("platform.password")} rules={[{ required: true, message: t("platform.passwordRequired") }, { min: 8, message: t("platform.passwordLength") }]}><Input.Password autoComplete="new-password" size="large" /></Form.Item>
                    <Button type="primary" size="large" htmlType="submit" block loading={busy}>{t("platform.register")}</Button>
                </Form>
                <p className="platform-auth-switch"><Link to={`/login?redirect=${encodeURIComponent(inviteToken ? `/invite/${inviteToken}` : redirect)}`}>{t("platform.hasAccount")}</Link></p>
                <a className="platform-attribution" href="https://github.com/basketikun/infinite-canvas" target="_blank" rel="noreferrer">{t("platform.basedOn")}</a>
            </section>
        </main>
    );
}
