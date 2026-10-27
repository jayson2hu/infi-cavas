import { useState } from "react";
import { App, Button, ColorPicker, Empty, Form, Input, Modal, Select } from "antd";
import { useTranslation } from "react-i18next";
import { replaceBrandColors, type Brand, type BrandColor } from "@/services/api/platform/brands";
import { useSessionStore } from "@/stores/use-session-store";

export function BrandColors({ brand, onChanged }: { brand: Brand; onChanged: () => Promise<void> }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId)!;
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [form] = Form.useForm<{ colors: BrandColor[] }>();
    const edit = () => { form.setFieldsValue({ colors: brand.colors }); setOpen(true); };
    const save = async ({ colors }: { colors: BrandColor[] }) => {
        setBusy(true);
        try { await replaceBrandColors(workspaceId, brand.id, (colors || []).map((color, sort) => ({ ...color, sort }))); await onChanged(); setOpen(false); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    return <section className="platform-card"><div className="flex items-center justify-between gap-3"><h2>{t("platform.brandColors")}</h2>{brand.canEdit ? <Button type="text" size="small" onClick={edit}>{t("platform.edit")}</Button> : null}</div><div className="mt-4 space-y-3">{brand.colors.map((color) => <button type="button" key={color.id || `${color.name}:${color.hex}`} onClick={brand.canEdit ? edit : undefined} disabled={!brand.canEdit} className="flex w-full items-center gap-3 text-left"><span className="h-8 w-8 shrink-0 rounded-lg border" style={{ background: color.hex, borderColor: "var(--workspace-border)" }} /><span className="min-w-0 flex-1 text-xs">{t(`platform.colorRoles.${color.role}`)} · {color.name}</span><code className="platform-muted text-[11px]">{color.hex}</code></button>)}</div>{!brand.colors.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("platform.noBrandColors")} /> : null}
        <Modal width={680} title={t("platform.brandColors")} open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden><Form form={form} layout="vertical" onFinish={save} disabled={busy}><Form.List name="colors">{(fields, { add, remove }) => <><div className="space-y-3">{fields.map((field) => <div key={field.key} className="grid grid-cols-[48px_1fr_auto] items-start gap-2 sm:grid-cols-[48px_1fr_120px_auto]"><Form.Item name={[field.name, "hex"]} getValueFromEvent={(_, hex) => hex} rules={[{ required: true, pattern: /^#[0-9A-Fa-f]{6}$/ }]}><ColorPicker format="hex" disabledAlpha /></Form.Item><Form.Item name={[field.name, "name"]} rules={[{ required: true, whitespace: true }]}><Input aria-label={t("platform.name")} placeholder={t("platform.name")} /></Form.Item><Form.Item name={[field.name, "role"]} className="col-span-2 sm:col-span-1" rules={[{ required: true }]}><Select aria-label={t("platform.colorRole")} options={["primary", "secondary", "background", "accent"].map((value) => ({ value, label: t(`platform.colorRoles.${value}`) }))} /></Form.Item><Button type="text" onClick={() => remove(field.name)}>{t("platform.remove")}</Button></div>)}</div><Button className="mb-5" disabled={fields.length >= 12} onClick={() => add({ name: "", hex: "#1C1917", role: "primary" })}>{t("platform.addColor")}</Button></>}</Form.List><div><Button type="primary" htmlType="submit" loading={busy}>{t("platform.save")}</Button></div></Form></Modal>
    </section>;
}
