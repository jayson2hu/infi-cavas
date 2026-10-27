import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ProTable } from "@ant-design/pro-components";
import { Alert, App, Button, Form, Input, InputNumber, Modal, Select, Switch, Tag } from "antd";
import { useTranslation } from "react-i18next";
import { disableManagedModel, listManagedModels, listProviders, saveManagedModel, type ManagedModel } from "@/services/api/platform/admin";
import type { ModelCapability, PriceRule } from "@/services/api/platform/types";
import { formatPriceHint } from "@/lib/platform-pricing";
import { useSessionStore } from "@/stores/use-session-store";

const units: Record<ModelCapability, PriceRule["unit"]> = { image: "per_image", video: "per_second", text: "per_1k_tokens", audio: "per_1k_chars" };
const fields = { per_image: ["standard", "hd"], per_second: ["price"], per_1k_tokens: ["input", "output", "hold", "min"], per_1k_chars: ["price"] };
export function ModelsPanel() {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const queryClient = useQueryClient();
    const userId = useSessionStore((state) => state.user?.id);
    const query = useQuery({ queryKey: ["platform", "admin", "models", userId], queryFn: ({ signal }) => listManagedModels(signal) });
    const providers = useQuery({ queryKey: ["platform", "admin", "providers", userId], queryFn: ({ signal }) => listProviders(signal) });
    const [editing, setEditing] = useState<ManagedModel | null>(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [form] = Form.useForm<ManagedModel>();
    const capability = Form.useWatch("capability", form) as ModelCapability | undefined;
    const unit = capability ? units[capability] : "per_image";
    const refresh = async () => {
        await query.refetch();
        await queryClient.invalidateQueries({ queryKey: ["platform", "models"] });
    };
    const edit = (model?: ManagedModel) => { setEditing(model || null); form.resetFields(); form.setFieldsValue(model || { capability: "image", supportsEdit: false, maxReferenceImages: 8, isActive: true, sort: 0, routes: [], pricing: { unit: "per_image", config: {} } }); setOpen(true); };
    const save = async (input: ManagedModel) => {
        setBusy(true);
        try { await saveManagedModel({ ...input, pricing: { unit, config: input.pricing.config }, routes: input.routes || [] }, editing?.id); await refresh(); setOpen(false); message.success(t("platform.saved")); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    return <>
        {query.error || providers.error ? <Alert type="error" showIcon title={(query.error || providers.error)?.message} action={<Button onClick={() => { void query.refetch(); void providers.refetch(); }}>{t("platform.retry")}</Button>} /> : null}
        {!providers.isPending && !providers.data?.length ? <Alert className="mb-4" showIcon type="info" title={t("platform.noProviders")} /> : null}
        <ProTable<ManagedModel> rowKey="id" search={false} options={false} pagination={false} loading={query.isPending} dataSource={query.data} scroll={{ x: 850 }} headerTitle={t("platform.modelPricing")} toolBarRender={() => [<Button key="add" type="primary" onClick={() => edit()}>{t("platform.addModel")}</Button>]} columns={[
            { title: t("platform.model"), dataIndex: "id" }, { title: t("platform.displayName"), dataIndex: "displayName" }, { title: t("platform.capability"), dataIndex: "capability", renderText: (value: string) => t(`platform.capabilities.${value}`) }, { title: t("platform.modelPricing"), dataIndex: "pricing", render: (_, row) => row.pricing ? formatPriceHint(row.pricing) : "—" }, { title: t("platform.status"), dataIndex: "isActive", render: (_, row) => <Tag>{t(row.isActive ? "platform.active" : "platform.inactive")}</Tag> }, { title: t("platform.actions"), valueType: "option", render: (_, row) => [<Button key="edit" size="small" onClick={() => edit(row)}>{t("platform.edit")}</Button>, <Button key="disable" size="small" disabled={!row.isActive} danger onClick={() => modal.confirm({ title: t("platform.disableModelConfirm", { name: row.displayName }), onOk: async () => { try { await disableManagedModel(row.id); await refresh(); } catch (error) { message.error((error as Error).message); throw error; } } })}>{t("platform.disable")}</Button>] },
        ]} />
        <Modal width={760} title={t(editing ? "platform.editModel" : "platform.addModel")} open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden><Form form={form} layout="vertical" onFinish={save} disabled={busy}>
            <div className="grid gap-x-4 sm:grid-cols-2"><Form.Item name="id" label={t("platform.modelId")} rules={[{ required: true, whitespace: true }]}><Input disabled={Boolean(editing)} /></Form.Item><Form.Item name="displayName" label={t("platform.displayName")} rules={[{ required: true, whitespace: true }]}><Input /></Form.Item><Form.Item name="capability" label={t("platform.capability")} rules={[{ required: true }]}><Select options={Object.keys(units).map((value) => ({ value, label: t(`platform.capabilities.${value}`) }))} onChange={() => form.setFieldValue(["pricing", "config"], {})} /></Form.Item><Form.Item name="sort" label={t("platform.sort")}><InputNumber precision={0} /></Form.Item><Form.Item name="isActive" valuePropName="checked" label={t("platform.active")}><Switch /></Form.Item>{capability === "image" ? <><Form.Item name="supportsEdit" valuePropName="checked" label={t("platform.supportsEdit")}><Switch /></Form.Item><Form.Item name="maxReferenceImages" label={t("platform.maxReferences")}><InputNumber min={0} max={2147483647} precision={0} /></Form.Item></> : null}</div>
            <h3 className="mb-4 font-semibold">{t("platform.providerRoutes")}</h3><Form.List name="routes">{(routes, { add, remove }) => <><div className="space-y-3">{routes.map((route) => <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_80px_auto]" key={route.key}><Form.Item name={[route.name, "providerId"]} label={t("platform.provider")} rules={[{ required: true }]}><Select options={providers.data?.map((provider) => ({ value: provider.id, label: provider.name }))} /></Form.Item><Form.Item name={[route.name, "upstreamModel"]} label={t("platform.upstreamModel")} rules={[{ required: true, whitespace: true }]}><Input /></Form.Item><Form.Item name={[route.name, "priority"]} label={t("platform.priority")}><InputNumber precision={0} className="w-full" /></Form.Item><Button className="mt-7" onClick={() => remove(route.name)}>{t("platform.remove")}</Button></div>)}</div><Button className="my-4" disabled={!providers.data?.length} onClick={() => add({ priority: 0 })}>{t("platform.addRoute")}</Button></>}</Form.List>
            <h3 className="mb-4 font-semibold">{t("platform.modelPricing")} · {t(`platform.pricingUnits.${unit}`)}</h3><div className="grid gap-x-4 sm:grid-cols-2">{fields[unit].map((key) => <Form.Item key={key} name={["pricing", "config", key]} label={t(`platform.priceFields.${key}`)} rules={[{ required: true }]}><InputNumber min={key === "hold" || key === "min" ? 1 : 0} max={2147483647} precision={key === "hold" || key === "min" ? 0 : undefined} className="w-full" /></Form.Item>)}</div><Button type="primary" htmlType="submit" loading={busy}>{t("platform.save")}</Button>
        </Form></Modal>
    </>;
}
