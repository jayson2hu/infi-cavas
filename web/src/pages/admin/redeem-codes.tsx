import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ProTable } from "@ant-design/pro-components";
import { Alert, App, Button, DatePicker, Form, Input, InputNumber, Modal, Select } from "antd";
import { Download } from "lucide-react";
import type { Dayjs } from "dayjs";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";
import { createRedeemCodes, listRedeemCodes, type RedeemCode, type RedeemCodeInput } from "@/services/api/platform/admin";
import { toCsv } from "@/lib/csv";
import { useSessionStore } from "@/stores/use-session-store";

export function RedeemCodesPanel() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const userId = useSessionStore((state) => state.user?.id);
    const query = useQuery({ queryKey: ["platform", "admin", "redeem-codes", userId], queryFn: ({ signal }) => listRedeemCodes(signal) });
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [created, setCreated] = useState<string[]>([]);
    const [form] = Form.useForm();
    const exportCodes = (rows: Array<Array<string | number | null>>) => saveAs(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }), "redeem-codes.csv");
    const save = async (input: Omit<RedeemCodeInput, "expiresAt"> & { expiresAt?: Dayjs | null }) => {
        setBusy(true);
        try { const result = await createRedeemCodes({ ...input, validDays: input.validDays ?? null, expiresAt: input.expiresAt?.toISOString() || null }); setCreated(result.codes); setOpen(false); form.resetFields(); await query.refetch(); message.success(t("platform.codesCreated", { count: result.codes.length })); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    return <>
        {query.error ? <Alert type="error" showIcon title={query.error.message} action={<Button onClick={() => void query.refetch()}>{t("platform.retry")}</Button>} /> : null}
        {created.length ? <Alert className="mb-4" type="success" showIcon title={t("platform.codesCreated", { count: created.length })} action={<Button icon={<Download size={15} />} onClick={() => exportCodes([[t("platform.redeemCode")], ...created.map((code) => [code])])}>{t("platform.exportCreatedCodes")}</Button>} /> : null}
        <ProTable<RedeemCode> rowKey="code" search={false} options={false} pagination={{ pageSize: 20 }} loading={query.isPending} dataSource={query.data} scroll={{ x: 850 }} headerTitle={t("platform.redeemCode")} toolBarRender={() => [<Button key="export" icon={<Download size={16} />} disabled={!query.data?.length} onClick={() => exportCodes([[t("platform.redeemCode"), t("platform.credits"), t("platform.creditKind"), t("platform.maxUses"), t("platform.usedCount"), t("platform.expiresAt")], ...(query.data || []).map((code) => [code.code, code.credits, t(`platform.buckets.${code.kind}`), code.maxUses, code.usedCount, code.expiresAt])])}>{t("platform.exportCsv")}</Button>, <Button key="create" type="primary" onClick={() => { form.resetFields(); form.setFieldsValue({ kind: "purchase", count: 1, maxUses: 1 }); setOpen(true); }}>{t("platform.createCodes")}</Button>]} columns={[
            { title: t("platform.redeemCode"), dataIndex: "code", copyable: true }, { title: t("platform.credits"), dataIndex: "credits" }, { title: t("platform.creditKind"), dataIndex: "kind", renderText: (value: string) => t(`platform.buckets.${value}`) }, { title: t("platform.usedCount"), dataIndex: "usedCount", render: (_, row) => `${row.usedCount} / ${row.maxUses}` }, { title: t("platform.expiresAt"), dataIndex: "expiresAt", renderText: (value: string | null) => value ? new Date(value).toLocaleString(i18n.language) : t("platform.noExpiry") }, { title: t("platform.note"), dataIndex: "note", ellipsis: true },
        ]} />
        <Modal title={t("platform.createCodes")} open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden><Form form={form} layout="vertical" onFinish={save} disabled={busy}><div className="grid gap-x-4 sm:grid-cols-2">
            <Form.Item name="credits" label={t("platform.credits")} rules={[{ required: true }]}><InputNumber min={1} max={2147483647} precision={0} className="w-full" /></Form.Item><Form.Item name="kind" label={t("platform.creditKind")} rules={[{ required: true }]}><Select options={["purchase", "gift"].map((value) => ({ value, label: t(`platform.buckets.${value}`) }))} /></Form.Item><Form.Item name="count" label={t("platform.codeCount")} rules={[{ required: true }]}><InputNumber min={1} max={500} precision={0} className="w-full" /></Form.Item><Form.Item name="maxUses" label={t("platform.maxUses")} rules={[{ required: true }]}><InputNumber min={1} max={2147483647} precision={0} className="w-full" /></Form.Item><Form.Item name="validDays" label={t("platform.validDays")} extra={t("platform.noExpiryHint")}><InputNumber min={1} max={2147483647} precision={0} className="w-full" /></Form.Item><Form.Item name="expiresAt" label={t("platform.expiresAt")}><DatePicker showTime className="w-full" /></Form.Item>
        </div><Form.Item name="note" label={t("platform.note")}><Input.TextArea rows={2} /></Form.Item><Button type="primary" htmlType="submit" loading={busy}>{t("platform.createCodes")}</Button></Form></Modal>
    </>;
}
