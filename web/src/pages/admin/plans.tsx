import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Form, Input, InputNumber, Modal, Segmented, Switch, Table, Tag } from "antd";
import { useTranslation } from "react-i18next";
import { approvePlanRequest, listAdminPlans, listPlanRequests, rejectPlanRequest, saveAdminPlan, type AdminPlan, type AdminPlanInput, type AdminPlanRequest } from "@/services/api/platform/admin";
import { useSessionStore } from "@/stores/use-session-store";

type Status = AdminPlanRequest["status"] | "all";
const statusColor = { pending: "processing", approved: "success", rejected: "default" } as const;

// 套餐与申请（I-041）：审核用户的升级申请，维护套餐目录（名称、每月点数、价格说明、上下架）。
export function PlansPanel() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const userId = useSessionStore((state) => state.user?.id);
    const [status, setStatus] = useState<Status>("pending");
    const requests = useQuery({ queryKey: ["platform", "admin", "plan-requests", userId, status], queryFn: ({ signal }) => listPlanRequests(status, signal) });
    const plans = useQuery({ queryKey: ["platform", "admin", "plans", userId], queryFn: ({ signal }) => listAdminPlans(signal) });
    const [approving, setApproving] = useState<AdminPlanRequest | null>(null);
    const [rejecting, setRejecting] = useState<AdminPlanRequest | null>(null);
    const [editing, setEditing] = useState<AdminPlan | null>(null);
    const [busy, setBusy] = useState(false);
    const [approveForm] = Form.useForm<{ note?: string }>();
    const [rejectForm] = Form.useForm<{ reason: string }>();
    const [planForm] = Form.useForm<AdminPlanInput>();
    const planName = (id: string) => plans.data?.find((plan) => plan.id === id)?.name ?? t(`platform.plans.${id}`);
    const run = async (action: () => Promise<unknown>, done: () => void) => {
        setBusy(true);
        try { await action(); done(); await queryClient.invalidateQueries({ queryKey: ["platform", "admin"] }); message.success(t("platform.saved")); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    const errorBlock = (error: Error | null, retry: () => unknown) => error ? <Alert type="error" showIcon title={error.message} action={<Button onClick={() => void retry()}>{t("platform.retry")}</Button>} /> : null;
    const time = (value: string | null) => value ? new Date(value).toLocaleString(i18n.language) : "—";
    return <div className="space-y-5">
        <section className="platform-card">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4"><h2>{t("platform.upgrade.requests")}</h2><Segmented<Status> value={status} onChange={setStatus} options={(["pending", "approved", "rejected", "all"] as const).map((value) => ({ value, label: t(`platform.upgrade.statuses.${value}`) }))} /></div>
            {errorBlock(requests.error, requests.refetch) || <Table<AdminPlanRequest> size="small" rowKey="id" loading={requests.isPending} dataSource={requests.data} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 960 }} columns={[
                { title: t("platform.upgrade.requestedAt"), dataIndex: "createdAt", render: time },
                { title: t("platform.upgrade.workspace"), dataIndex: "workspaceName", ellipsis: true },
                { title: t("platform.upgrade.requester"), dataIndex: "requesterEmail", ellipsis: true },
                { title: t("platform.upgrade.from"), dataIndex: "fromPlan", render: planName },
                { title: t("platform.upgrade.target"), dataIndex: "planName", render: (name: string, row) => <>{name}<div className="platform-muted text-xs">{t("platform.upgrade.monthly", { credits: row.monthlyCredits.toLocaleString(i18n.language) })}</div></> },
                { title: t("platform.note"), dataIndex: "note", ellipsis: true },
                { title: t("platform.status"), dataIndex: "status", render: (value: AdminPlanRequest["status"], row) => <><Tag color={statusColor[value]}>{t(`platform.upgrade.statuses.${value}`)}</Tag>{row.reviewNote ? <div className="platform-muted text-xs" title={row.reviewNote}>{row.reviewNote}</div> : null}</> },
                { title: "", key: "actions", fixed: "right", render: (_, row) => row.status === "pending" ? <div className="flex gap-1"><Button size="small" type="primary" onClick={() => { approveForm.resetFields(); setApproving(row); }}>{t("platform.upgrade.approve")}</Button><Button size="small" onClick={() => { rejectForm.resetFields(); setRejecting(row); }}>{t("platform.upgrade.reject")}</Button></div> : null },
            ]} />}
        </section>
        <section className="platform-card">
            <h2 className="mb-4">{t("platform.upgrade.catalog")}</h2>
            {errorBlock(plans.error, plans.refetch) || <Table<AdminPlan> size="small" rowKey="id" loading={plans.isPending} dataSource={plans.data} pagination={false} scroll={{ x: 760 }} columns={[
                { title: t("platform.plan"), dataIndex: "name", render: (name: string, row) => <>{name}<div className="platform-muted text-xs">{row.id}</div></> },
                { title: t("platform.planMonthlyCredits"), dataIndex: "monthlyCredits", render: (value: number) => value.toLocaleString(i18n.language) },
                { title: t("platform.upgrade.priceText"), dataIndex: "priceText", render: (value: string | null) => value || "—" },
                { title: t("platform.upgrade.planText"), dataIndex: "description", ellipsis: true },
                { title: t("platform.status"), dataIndex: "isActive", render: (value: boolean) => <Tag color={value ? "success" : "default"}>{t(value ? "platform.upgrade.active" : "platform.upgrade.inactive")}</Tag> },
                { title: "", key: "actions", render: (_, row) => <Button size="small" onClick={() => { setEditing(row); planForm.setFieldsValue({ name: row.name, monthlyCredits: row.monthlyCredits, priceText: row.priceText, description: row.description, isActive: row.isActive, sort: row.sort }); }}>{t("platform.upgrade.edit")}</Button> },
            ]} />}
        </section>
        <Modal title={t("platform.upgrade.approveTitle")} open={Boolean(approving)} onCancel={() => setApproving(null)} onOk={() => approveForm.submit()} okText={t("platform.upgrade.approve")} confirmLoading={busy} destroyOnHidden>
            {approving ? <p className="mb-4">{t("platform.upgrade.approveConfirm", { workspace: approving.workspaceName, plan: approving.planName, credits: approving.monthlyCredits.toLocaleString(i18n.language) })}</p> : null}
            <Form form={approveForm} layout="vertical" onFinish={({ note }) => void run(() => approvePlanRequest(approving!.id, note?.trim() || undefined), () => setApproving(null))}><Form.Item name="note" label={t("platform.upgrade.reviewNote")}><Input.TextArea rows={2} maxLength={500} /></Form.Item></Form>
        </Modal>
        <Modal title={t("platform.upgrade.reject")} open={Boolean(rejecting)} onCancel={() => setRejecting(null)} onOk={() => rejectForm.submit()} okText={t("platform.upgrade.reject")} okButtonProps={{ danger: true }} confirmLoading={busy} destroyOnHidden>
            <Form form={rejectForm} layout="vertical" onFinish={({ reason }) => void run(() => rejectPlanRequest(rejecting!.id, reason.trim()), () => setRejecting(null))}><Form.Item name="reason" label={t("platform.upgrade.rejectReason")} rules={[{ required: true, whitespace: true, message: t("platform.upgrade.rejectReasonRequired") }]}><Input.TextArea rows={3} maxLength={500} /></Form.Item></Form>
        </Modal>
        <Modal title={editing ? `${t("platform.upgrade.edit")} · ${editing.id}` : ""} open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={() => planForm.submit()} confirmLoading={busy} forceRender>
            <Form form={planForm} layout="vertical" onFinish={(input) => void run(() => saveAdminPlan(editing!.id, { ...input, priceText: input.priceText?.trim() || null, description: input.description?.trim() || null }), () => setEditing(null))}><div className="grid gap-x-4 sm:grid-cols-2">
                <Form.Item name="name" label={t("platform.plan")} rules={[{ required: true, whitespace: true }]}><Input maxLength={40} /></Form.Item>
                <Form.Item name="monthlyCredits" label={t("platform.planMonthlyCredits")} rules={[{ required: true }]}><InputNumber min={0} max={2147483647} precision={0} className="w-full" /></Form.Item>
                <Form.Item name="priceText" label={t("platform.upgrade.priceText")}><Input maxLength={40} /></Form.Item>
                <Form.Item name="sort" label={t("platform.upgrade.sort")}><InputNumber precision={0} className="w-full" /></Form.Item>
            </div><Form.Item name="description" label={t("platform.upgrade.planText")}><Input.TextArea rows={2} maxLength={200} /></Form.Item><Form.Item name="isActive" label={t("platform.upgrade.active")} valuePropName="checked" extra={t("platform.upgrade.inactiveHint")}><Switch /></Form.Item></Form>
        </Modal>
    </div>;
}
