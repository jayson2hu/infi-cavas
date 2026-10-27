import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Skeleton, Tag } from "antd";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { acceptInvite, fetchInvite } from "@/services/api/platform/workspaces";
import { useSessionStore } from "@/stores/use-session-store";

export default function AcceptInvitePage() {
    const { token = "" } = useParams();
    const { t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const user = useSessionStore((state) => state.user);
    const refresh = useSessionStore((state) => state.refresh);
    const [busy, setBusy] = useState(false);
    const invite = useQuery({ queryKey: ["platform", "invite", token], queryFn: ({ signal }) => fetchInvite(token, signal) });
    const accept = async () => {
        setBusy(true);
        try {
            const workspace = await acceptInvite(token);
            await refresh(workspace.id);
            message.success(t("platform.inviteAccepted"));
            navigate("/", { replace: true });
        } catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    return <main className="platform-auth"><section className="platform-auth-card">
        <h1>{t("platform.joinWorkspace")}</h1>
        {invite.isPending ? <Skeleton active /> : invite.error ? <Alert type="error" showIcon title={invite.error.message} action={<Button onClick={() => void invite.refetch()}>{t("platform.retry")}</Button>} /> : invite.data ? <>
            <p className="platform-muted">{t("platform.inviteDescription", { workspace: invite.data.workspaceName })}</p>
            <Tag className="mb-6">{t(`platform.roles.${invite.data.role}`)}</Tag>
            {invite.data.expired ? <Alert type="warning" showIcon title={t("platform.inviteExpired")} /> : user ? <Button type="primary" size="large" block loading={busy} onClick={() => void accept()}>{t("platform.acceptInvite")}</Button> : <>
                <Link to={`/login?redirect=${encodeURIComponent(`/invite/${token}`)}`}><Button type="primary" size="large" block>{t("platform.loginToAccept")}</Button></Link>
                <p className="platform-auth-switch"><Link to={`/register?inviteToken=${encodeURIComponent(token)}`}>{t("platform.registerToAccept")}</Link></p>
            </>}
        </> : null}
        <p className="platform-auth-switch"><Link to="/">{t("platform.backHome")}</Link></p>
    </section></main>;
}
