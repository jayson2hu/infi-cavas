import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Avatar, Button, Form, Input, InputNumber, Modal, Select, Skeleton, Table, Tag } from "antd";
import { Copy, Plus, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCopyText } from "@/hooks/use-copy-text";
import { createInvite, fetchMembers, removeMember, updateMember, updateWorkspace } from "@/services/api/platform/workspaces";
import type { Invite, Member } from "@/services/api/platform/types";
import { useSessionStore } from "@/stores/use-session-store";

export default function TeamPage() {
    const { t, i18n } = useTranslation();
    const { message, modal } = App.useApp();
    const copy = useCopyText();
    const queryClient = useQueryClient();
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId)!;
    const userId = useSessionStore((state) => state.user?.id);
    const workspace = useSessionStore((state) => state.workspaces.find((item) => item.id === state.currentWorkspaceId));
    const refresh = useSessionStore((state) => state.refresh);
    const canManage = workspace?.role === "owner" || workspace?.role === "admin";
    const key = ["platform", "members", userId, workspaceId];
    const members = useQuery({ queryKey: key, queryFn: ({ signal }) => fetchMembers(workspaceId, signal) });
    const [inviteOpen, setInviteOpen] = useState(false);
    const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
    const [invite, setInvite] = useState<Invite | null>(null);
    const [editing, setEditing] = useState<Member | null>(null);
    const [renaming, setRenaming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [memberForm] = Form.useForm();
    const [nameForm] = Form.useForm();
    const roleOptions = ["admin", "member"].map((role) => ({ value: role, label: t(`platform.roles.${role}`) }));
    const invalidate = () => queryClient.invalidateQueries({ queryKey: key });
    const inviteMember = async () => {
        setBusy(true);
        try { setInvite(await createInvite(workspaceId, inviteRole)); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    const saveMember = async (values: { role: "admin" | "member"; monthlyCap?: number | null }) => {
        if (!editing) return;
        setBusy(true);
        try { await updateMember(workspaceId, editing.userId, { role: values.role, monthlyCap: values.monthlyCap ?? null }); await invalidate(); await refresh(); setEditing(null); message.success(t("platform.saved")); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    const remove = (member: Member) => modal.confirm({ title: t("platform.removeMemberTitle", { name: member.name }), content: t("platform.removeMemberDescription"), okText: t("platform.remove"), cancelText: t("common.cancel"), okButtonProps: { danger: true }, onOk: async () => { try { await removeMember(workspaceId, member.userId); await invalidate(); await refresh(); message.success(t("platform.memberRemoved")); } catch (error) { message.error((error as Error).message); throw error; } } });
    const rename = async ({ name }: { name: string }) => {
        setBusy(true);
        try { await updateWorkspace(workspaceId, { name: name.trim() }); await refresh(); setRenaming(false); message.success(t("platform.saved")); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    return <main className="platform-page">
        <header className="platform-page-heading"><div><h1>{t("platform.teamTitle")}</h1><p>{t("platform.teamDescription", { workspace: workspace?.name })}</p></div>{canManage ? <div className="flex flex-wrap gap-2"><Button onClick={() => { nameForm.setFieldsValue({ name: workspace?.name }); setRenaming(true); }}>{t("platform.renameWorkspace")}</Button><Button type="primary" icon={<Plus size={16} />} onClick={() => { setInvite(null); setInviteRole("member"); setInviteOpen(true); }}>{t("platform.inviteMember")}</Button></div> : null}</header>
        <section className="platform-card">
            <div className="mb-5 flex items-center gap-2"><Users size={18} /><h2>{t("platform.memberList")}</h2><Tag>{members.data?.length ?? workspace?.memberCount ?? "—"}</Tag></div>
            {members.isPending ? <Skeleton active paragraph={{ rows: 5 }} /> : members.error ? <Alert type="error" showIcon title={members.error.message} action={<Button onClick={() => void members.refetch()}>{t("platform.retry")}</Button>} /> : <Table<Member> rowKey="userId" dataSource={members.data} pagination={false} scroll={{ x: 650 }} columns={[
                { title: t("platform.member"), key: "member", render: (_, member) => <div className="flex items-center gap-3"><Avatar src={member.avatarUrl}>{member.name.slice(0, 1)}</Avatar><div><strong>{member.name}</strong>{member.userId === userId ? <small className="platform-muted"> {t("platform.you")}</small> : null}<div className="platform-muted text-xs">{member.email}</div></div></div> },
                { title: t("platform.role"), dataIndex: "role", render: (role: string) => <Tag>{t(`platform.roles.${role}`)}</Tag> },
                { title: t("platform.monthlyCap"), dataIndex: "monthlyCap", render: (cap: number | null, member) => member.role !== "member" || cap === null ? t("platform.unlimited") : t("platform.creditAmount", { count: cap }) },
                { title: t("platform.joinedAt"), dataIndex: "joinedAt", render: (date: string) => new Date(date).toLocaleDateString(i18n.language) },
                ...(canManage ? [{ title: t("platform.actions"), key: "actions", render: (_: unknown, member: Member) => member.role === "owner" ? <span className="platform-muted">{t("platform.ownerProtected")}</span> : <div className="flex gap-2"><Button size="small" onClick={() => { memberForm.setFieldsValue({ role: member.role, monthlyCap: member.monthlyCap }); setEditing(member); }}>{t("platform.edit")}</Button><Button size="small" danger onClick={() => remove(member)}>{t("platform.remove")}</Button></div> }] : []),
            ]} />}
        </section>
        <Modal title={t("platform.inviteMember")} open={inviteOpen} onCancel={() => setInviteOpen(false)} footer={null} destroyOnHidden>{invite ? <div className="space-y-4"><Alert type="success" showIcon title={t("platform.inviteReady")} /><Input aria-label={t("platform.inviteLink")} readOnly value={invite.url} /><Button icon={<Copy size={15} />} onClick={() => copy(invite.url)}>{t("platform.copyInvite")}</Button><p className="platform-muted">{t("platform.inviteValidUntil", { date: new Date(invite.expiresAt).toLocaleString(i18n.language) })}</p></div> : <div className="space-y-4"><p className="platform-muted">{t("platform.inviteHint")}</p><label htmlFor="invite-role">{t("platform.role")}</label><Select id="invite-role" value={inviteRole} onChange={setInviteRole} options={roleOptions} className="w-full" /><Button type="primary" loading={busy} onClick={() => void inviteMember()}>{t("platform.createInvite")}</Button></div>}</Modal>
        <Modal title={t("platform.editMember")} open={Boolean(editing)} onCancel={() => setEditing(null)} footer={null} destroyOnHidden><Form form={memberForm} layout="vertical" onFinish={saveMember} disabled={busy}><Form.Item name="role" label={t("platform.role")}><Select options={roleOptions} /></Form.Item><Form.Item name="monthlyCap" label={t("platform.monthlyCap")} extra={t("platform.capHint")}><InputNumber min={0} max={2147483647} precision={0} placeholder={t("platform.unlimited")} className="w-full" /></Form.Item><Button htmlType="submit" type="primary" loading={busy}>{t("platform.save")}</Button></Form></Modal>
        <Modal title={t("platform.renameWorkspace")} open={renaming} onCancel={() => setRenaming(false)} footer={null} destroyOnHidden><Form form={nameForm} layout="vertical" onFinish={rename} disabled={busy}><Form.Item name="name" label={t("platform.workspaceName")} rules={[{ required: true, whitespace: true, message: t("platform.workspaceNameRequired") }]}><Input /></Form.Item><Button htmlType="submit" type="primary" loading={busy}>{t("platform.save")}</Button></Form></Modal>
    </main>;
}
