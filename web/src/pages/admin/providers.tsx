import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ProTable } from "@ant-design/pro-components";
import { Alert, App, Button, Form, Input, Modal, Switch, Tag } from "antd";
import { useTranslation } from "react-i18next";
import { deleteProvider, listProviders, saveProvider, testProvider, type Provider, type ProviderInput } from "@/services/api/platform/admin";
import { useSessionStore } from "@/stores/use-session-store";

export function ProvidersPanel() {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const queryClient = useQueryClient();
    const userId = useSessionStore((state) => state.user?.id);
    const query = useQuery({ queryKey: ["platform", "admin", "providers", userId], queryFn: ({ signal }) => listProviders(signal) });
    const [editing, setEditing] = useState<Provider | null>(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [testing, setTesting] = useState<string | null>(null);
    const [form] = Form.useForm<ProviderInput>();
    const edit = (provider?: Provider) => { setEditing(provider || null); form.resetFields(); form.setFieldsValue(provider ? { name: provider.name, baseUrl: provider.baseUrl, isActive: provider.isActive, apiKey: "" } : { isActive: true }); setOpen(true); };
    const save = async (input: ProviderInput) => {
        setBusy(true);
        try { await saveProvider(input, editing?.id); form.resetFields(); setOpen(false); await query.refetch(); await queryClient.invalidateQueries({ queryKey: ["platform", "models"] }); message.success(t("platform.saved")); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    const test = async (provider: Provider) => {
        setTesting(provider.id);
        try { const result = await testProvider(provider.id); modal.info({ title: t("platform.connectionSuccess"), width: 640, content: <div className="mt-4 flex max-h-80 flex-wrap gap-2 overflow-auto">{result.models.map((model) => <Tag key={model}>{model}</Tag>)}</div> }); }
        catch (error) { message.error((error as Error).message); }
        finally { setTesting(null); }
    };
    return <>
        {query.error ? <Alert type="error" showIcon title={query.error.message} action={<Button onClick={() => void query.refetch()}>{t("platform.retry")}</Button>} /> : null}
        <ProTable<Provider> rowKey="id" search={false} options={false} pagination={false} loading={query.isPending} dataSource={query.data} scroll={{ x: 800 }} headerTitle={t("platform.providers")} toolBarRender={() => [<Button key="add" type="primary" onClick={() => edit()}>{t("platform.addProvider")}</Button>]} columns={[
            { title: t("platform.name"), dataIndex: "name" }, { title: t("platform.baseUrl"), dataIndex: "baseUrl", ellipsis: true }, { title: t("platform.apiKey"), dataIndex: "last4", renderText: (value: string) => `•••• ${value}` }, { title: t("platform.status"), dataIndex: "isActive", render: (_, row) => <Tag>{t(row.isActive ? "platform.active" : "platform.inactive")}</Tag> },
            { title: t("platform.actions"), valueType: "option", render: (_, row) => [<Button key="test" size="small" loading={testing === row.id} onClick={() => void test(row)}>{t("platform.testConnection")}</Button>, <Button key="edit" size="small" onClick={() => edit(row)}>{t("platform.edit")}</Button>, <Button key="delete" size="small" danger onClick={() => modal.confirm({ title: t("platform.deleteProviderConfirm", { name: row.name }), onOk: async () => { try { await deleteProvider(row.id); await query.refetch(); await queryClient.invalidateQueries({ queryKey: ["platform", "models"] }); } catch (error) { message.error((error as Error).message); throw error; } } })}>{t("platform.remove")}</Button>] },
        ]} />
        <Modal title={t(editing ? "platform.editProvider" : "platform.addProvider")} open={open} onCancel={() => { setOpen(false); form.resetFields(); }} footer={null} destroyOnHidden><Form form={form} layout="vertical" onFinish={save} disabled={busy}><Form.Item name="name" label={t("platform.name")} rules={[{ required: true, whitespace: true }]}><Input /></Form.Item><Form.Item name="baseUrl" label={t("platform.baseUrl")} rules={[{ required: true }, { type: "url" }]}><Input placeholder="https://api.example.com" /></Form.Item><Form.Item name="apiKey" label={t("platform.apiKey")} extra={t(editing ? "platform.keepKeyHint" : "platform.serverKeyHint")} rules={[{ required: !editing, whitespace: true }]}><Input.Password autoComplete="new-password" /></Form.Item><Form.Item name="isActive" valuePropName="checked" label={t("platform.active")}><Switch /></Form.Item><Button type="primary" htmlType="submit" loading={busy}>{t("platform.save")}</Button></Form></Modal>
    </>;
}
