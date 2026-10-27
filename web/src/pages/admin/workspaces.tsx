import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ProTable } from "@ant-design/pro-components";
import { Alert, App, Button, Form, Input, InputNumber, Modal, Select } from "antd";
import { useTranslation } from "react-i18next";
import { grantWorkspace, listAdminWorkspaces, setWorkspacePlan, type AdminWorkspace, type GrantInput } from "@/services/api/platform/admin";
import { useSessionStore } from "@/stores/use-session-store";
import { useCreditsStore } from "@/stores/use-credits-store";

export function WorkspacesPanel() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const userId = useSessionStore((state) => state.user?.id);
    const [search, setSearch] = useState("");
    const query = useInfiniteQuery({ queryKey: ["platform", "admin", "workspaces", userId, search], initialPageParam: undefined as string | undefined, queryFn: ({ pageParam, signal }) => listAdminWorkspaces(search, pageParam, signal), getNextPageParam: (page) => page.nextCursor || undefined });
    const [editing, setEditing] = useState<AdminWorkspace | null>(null);
    const [mode, setMode] = useState<"grant" | "plan">("grant");
    const [busy, setBusy] = useState(false);
    const [form] = Form.useForm();
    const edit = (workspace: AdminWorkspace, nextMode: "grant" | "plan") => { setEditing(workspace); setMode(nextMode); form.resetFields(); form.setFieldsValue(nextMode === "plan" ? { plan: workspace.plan, monthlyCredits: workspace.planMonthlyCredits } : { kind: "purchase" }); };
    const save = async (input: GrantInput & { plan: AdminWorkspace["plan"]; monthlyCredits: number }) => {
        if (!editing) return;
        setBusy(true);
        try {
            if (mode === "grant") await grantWorkspace(editing.id, { credits: input.credits, kind: input.kind, validDays: input.validDays ?? null, note: input.note });
            else await setWorkspacePlan(editing.id, { plan: input.plan, monthlyCredits: input.monthlyCredits });
            await query.refetch();
            if (editing.id === useSessionStore.getState().currentWorkspaceId) await useCreditsStore.getState().refresh(editing.id);
            setEditing(null); message.success(t("platform.saved"));
        } catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    return <>
        <Input.Search className="mb-4 max-w-md" placeholder={t("platform.searchWorkspace")} allowClear onSearch={setSearch} />
        {query.error ? <Alert type="error" showIcon title={query.error.message} action={<Button onClick={() => void query.refetch()}>{t("platform.retry")}</Button>} /> : null}
        <ProTable<AdminWorkspace> rowKey="id" search={false} options={false} pagination={false} loading={query.isPending} dataSource={query.data?.pages.flatMap((page) => page.items)} scroll={{ x: 820 }} headerTitle={t("platform.workspaceCredits")} columns={[
            { title: t("platform.workspaceName"), dataIndex: "name" }, { title: t("platform.ownerEmail"), dataIndex: "ownerEmail", ellipsis: true }, { title: t("platform.plan"), dataIndex: "plan", renderText: (value: string) => t(`platform.plans.${value}`) }, { title: t("platform.balance"), dataIndex: "balance", renderText: (value: number) => value.toLocaleString(i18n.language) }, { title: t("platform.monthCharged"), dataIndex: "monthCharged" }, { title: t("platform.actions"), valueType: "option", render: (_, row) => [<Button key="grant" size="small" onClick={() => edit(row, "grant")}>{t("platform.grantCredits")}</Button>, <Button key="plan" size="small" onClick={() => edit(row, "plan")}>{t("platform.setPlan")}</Button>] },
        ]} />{query.hasNextPage ? <Button className="mt-4" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{t("platform.loadMore")}</Button> : null}
        <Modal title={`${t(mode === "grant" ? "platform.grantCredits" : "platform.setPlan")} · ${editing?.name || ""}`} open={Boolean(editing)} onCancel={() => setEditing(null)} footer={null} destroyOnHidden><Form form={form} layout="vertical" disabled={busy} onFinish={save}>
            {mode === "grant" ? <><Form.Item name="credits" label={t("platform.credits")} rules={[{ required: true }]}><InputNumber min={1} max={2147483647} precision={0} className="w-full" /></Form.Item><Form.Item name="kind" label={t("platform.creditKind")} rules={[{ required: true }]}><Select options={["purchase", "gift"].map((value) => ({ value, label: t(`platform.buckets.${value}`) }))} /></Form.Item><Form.Item name="validDays" label={t("platform.validDays")} extra={t("platform.noExpiryHint")}><InputNumber min={1} max={2147483647} precision={0} className="w-full" /></Form.Item><Form.Item name="note" label={t("platform.note")}><Input.TextArea rows={2} /></Form.Item></> : <><Alert className="mb-5" type="info" showIcon title={t("platform.planResetHint")} /><Form.Item name="plan" label={t("platform.plan")} rules={[{ required: true }]}><Select options={["free", "team", "enterprise"].map((value) => ({ value, label: t(`platform.plans.${value}`) }))} /></Form.Item><Form.Item name="monthlyCredits" label={t("platform.planMonthlyCredits")} rules={[{ required: true }]}><InputNumber min={0} max={2147483647} precision={0} className="w-full" /></Form.Item></>}
            <Button type="primary" htmlType="submit" loading={busy}>{t("platform.save")}</Button>
        </Form></Modal>
    </>;
}
