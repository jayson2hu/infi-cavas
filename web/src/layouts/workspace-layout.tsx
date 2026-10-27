import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Avatar, Button, Drawer, Dropdown, Form, Input, Modal, Skeleton } from "antd";
import { Bot, ChevronDown, Coins, CreditCard, FileText, Home, Images, LayoutGrid, Menu, Plus, Settings, Users, Video, ImagePlus } from "lucide-react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AgentPanel } from "@/components/agent/agent-panel";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { useLocalAgentAllowed } from "@/lib/platform";
import { BRAND_NAME } from "@/constant/runtime-config";
import { createWorkspace } from "@/services/api/platform/workspaces";
import { fetchBillingSummary } from "@/services/api/platform/billing";
import { useSessionStore } from "@/stores/use-session-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCreditsStore } from "@/stores/use-credits-store";
import { CreditsBadge } from "@/components/billing/credits-badge";
import { BrandSelector } from "@/components/brand/brand-selector";

const primaryNavigation = [{ path: "/", key: "home", icon: Home }, { path: "/canvas", key: "canvas", icon: LayoutGrid }, { path: "/templates", key: "templates", icon: LayoutGrid }, { path: "/brand", key: "brand", icon: Images }, { path: "/assets", key: "assets", icon: Images }, { path: "/prompts", key: "prompts", icon: FileText }];
const workspaceNavigation = [{ path: "/team", key: "team", icon: Users }, { path: "/billing", key: "billing", icon: CreditCard }, { path: "/config", key: "config", icon: Settings }];

export default function WorkspaceLayout({ children }: { children?: ReactNode }) {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const user = useSessionStore((state) => state.user)!;
    const workspaces = useSessionStore((state) => state.workspaces);
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId)!;
    const switchWorkspace = useSessionStore((state) => state.switchWorkspace);
    const refresh = useSessionStore((state) => state.refresh);
    const logout = useSessionStore((state) => state.logout);
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const liveBalance = useCreditsStore((state) => state.balances[workspaceId]);
    const [mobileOpen, setMobileOpen] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const [form] = Form.useForm<{ name: string }>();
    const createProject = useCanvasStore((state) => state.createProject);
    const agentToken = useAgentStore((state) => state.token);
    const agentEnabled = useAgentStore((state) => state.enabled);
    const agentConnected = useAgentStore((state) => state.connected);
    const connectAgent = useAgentStore((state) => state.connectAgent);
    const toggleAgent = useAgentStore((state) => state.togglePanel);
    const agentAllowed = useLocalAgentAllowed();
    const autoConnect = useRef(false);
    useEffect(() => {
        if (!agentAllowed || autoConnect.current || agentEnabled || agentConnected || !agentToken.trim()) return;
        autoConnect.current = true;
        void connectAgent({ silent: true });
    }, [agentAllowed, agentConnected, agentEnabled, agentToken, connectAgent]);
    const summary = useQuery({ queryKey: ["platform", "summary", user.id, workspaceId], queryFn: ({ signal }) => fetchBillingSummary(workspaceId, signal) });
    const changeWorkspace = async (id: string) => {
        try { await switchWorkspace(id); setMobileOpen(false); }
        catch (error) { message.error((error as Error).message); }
    };
    const create = async ({ name }: { name: string }) => {
        setCreating(true);
        try { const result = await createWorkspace(name.trim()); await refresh(result.id); setCreateOpen(false); form.resetFields(); message.success(t("platform.workspaceCreated")); }
        catch (error) { message.error((error as Error).message); }
        finally { setCreating(false); }
    };
    const navigation = (items: typeof primaryNavigation) => items.map(({ path, key, icon: Icon }) => <NavLink key={path} end={path === "/"} to={path} className={({ isActive }) => `platform-nav-link${isActive ? " is-active" : ""}`} onClick={() => setMobileOpen(false)}><Icon size={18} strokeWidth={1.8} /><span>{t(`platform.navigation.${key}`)}</span></NavLink>);
    const sidebar = <>
        <Link className="platform-brand" to="/" onClick={() => setMobileOpen(false)}><span className="platform-brand-icon"><img src="/logo.svg" alt="" /></span><span><strong>{BRAND_NAME || t("meta.title")}</strong><small>{t("platform.basedOn")}</small></span></Link>
        <Dropdown trigger={["click"]} menu={{ selectedKeys: [workspaceId], items: [...workspaces.map((item) => ({ key: item.id, label: item.name, onClick: () => void changeWorkspace(item.id) })), { type: "divider" }, { key: "create", label: t("platform.createWorkspace"), icon: <Plus size={15} />, onClick: () => setCreateOpen(true) }] }}>
            <button type="button" className="platform-workspace-switch" aria-label={t("platform.switchWorkspace")}><Avatar size={24} shape="square">{workspace?.name.slice(0, 1)}</Avatar><span>{workspace?.name}</span><ChevronDown size={14} /></button>
        </Dropdown>
        <nav aria-label={t("platform.mainNavigation")}>{navigation(primaryNavigation)}<div className="platform-nav-divider" />{navigation(workspaceNavigation)}{user.isPlatformAdmin ? <NavLink to="/admin" className="platform-nav-link" onClick={() => setMobileOpen(false)}><Settings size={18} />{t("platform.adminTitle")}</NavLink> : null}<details className="platform-more"><summary>{t("platform.more")}</summary><NavLink to="/image" className="platform-nav-link" onClick={() => setMobileOpen(false)}><ImagePlus size={18} />{t("navigation.image")}</NavLink><NavLink to="/video" className="platform-nav-link" onClick={() => setMobileOpen(false)}><Video size={18} />{t("navigation.video")}</NavLink></details></nav>
        <div className="platform-sidebar-balance">
            <BrandSelector />
            <div className="flex items-center justify-between gap-2"><span>{t("platform.balance")}</span><Coins size={15} /></div>
            {summary.isPending ? <Skeleton.Input active size="small" /> : summary.error ? <button className="platform-text-button" onClick={() => void summary.refetch()}>{t("platform.retry")}</button> : summary.data ? <><strong>{(liveBalance ?? summary.data.balance).toLocaleString(i18n.language)} <small>{t("platform.credits")}</small></strong>{summary.data.planMonthlyCredits > 0 ? <div className="platform-balance-track"><span style={{ width: `${Math.min(100, (liveBalance ?? summary.data.balance) / summary.data.planMonthlyCredits * 100)}%`, background: (liveBalance ?? summary.data.balance) / summary.data.planMonthlyCredits < 0.1 ? "var(--workspace-warning)" : undefined }} /></div> : null}<Link to="/billing" onClick={() => setMobileOpen(false)}>{t(summary.data.billingEnabled ? "platform.viewBilling" : "platform.usageTitle")}</Link></> : null}
        </div>
    </>;
    return <div className="platform-shell">
        <aside className="platform-sidebar">{sidebar}</aside>
        <div className="platform-workspace-main">
            <header className="platform-topbar">
                <Button className="platform-mobile-menu" type="text" icon={<Menu size={20} />} aria-label={t("topNav.openMenu")} onClick={() => setMobileOpen(true)} />
                <span className="platform-topbar-workspace">{workspace?.name}</span>
                <div className="platform-topbar-actions">
                    <CreditsBadge />
                    {agentAllowed ? <Button type="text" icon={<Bot size={18} />} aria-label={t("topNav.openAgent")} onClick={toggleAgent} /> : null}
                    <div className="platform-desktop-actions"><UserStatusActions /></div>
                    <Button className="platform-desktop-actions" type="text" onClick={() => navigate("/templates")}>{t("platform.templateCenter")}</Button>
                    <Button type="primary" icon={<Plus size={16} />} onClick={() => navigate(`/canvas/${createProject()}`)}>{t("platform.newCanvas")}</Button>
                    <VersionReleaseModal>{(openAbout) => <Dropdown trigger={["click"]} menu={{ items: [{ key: "name", label: <span>{user.name}<br /><small>{user.email}</small></span>, disabled: true }, { type: "divider" }, { key: "about", label: t("platform.about"), onClick: openAbout }, { key: "logout", label: t("platform.logout"), onClick: () => void logout().then(() => navigate("/login", { replace: true })).catch((error: Error) => message.error(error.message)) }] }}><button type="button" className="platform-avatar-button" aria-label={t("platform.accountMenu")}><Avatar src={user.avatarUrl}>{user.name.slice(0, 1)}</Avatar></button></Dropdown>}</VersionReleaseModal>
                </div>
            </header>
            <div className="platform-workspace-content" key={`${user.id}:${workspaceId}`}>{children || <Outlet />}</div>
        </div>
        <AgentPanel />
        <AppConfigModal />
        <Drawer title={t("platform.mainNavigation")} placement="left" size={280} open={mobileOpen} onClose={() => setMobileOpen(false)} styles={{ body: { background: "var(--workspace-sidebar)", display: "flex", flexDirection: "column", gap: 12 } }}>{sidebar}<UserStatusActions /></Drawer>
        <Modal title={t("platform.createWorkspace")} open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden><Form form={form} layout="vertical" onFinish={create} disabled={creating}><Form.Item name="name" label={t("platform.workspaceName")} rules={[{ required: true, whitespace: true, message: t("platform.workspaceNameRequired") }]}><Input autoComplete="organization" /></Form.Item><Button htmlType="submit" type="primary" loading={creating}>{t("platform.createWorkspace")}</Button></Form></Modal>
    </div>;
}
