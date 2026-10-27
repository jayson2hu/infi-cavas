import { useState } from "react";
import { App, Button, Empty, Form, Image, Input, Modal, Select, Switch } from "antd";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { deleteBrandAsset, updateBrandAsset, type Brand, type BrandAsset } from "@/services/api/platform/brands";
import { useSessionStore } from "@/stores/use-session-store";

export function BrandAssets({ brand, kind, onChanged, onUpload }: { brand: Brand; kind: BrandAsset["kind"]; onChanged: () => Promise<void>; onUpload: (kind: BrandAsset["kind"]) => void }) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId)!;
    const [editing, setEditing] = useState<BrandAsset | null>(null);
    const [busy, setBusy] = useState(false);
    const [form] = Form.useForm();
    const assets = brand.assets.filter((asset) => asset.kind === kind).sort((a, b) => a.sort - b.sort);
    const change = async (asset: BrandAsset, input: Partial<BrandAsset>) => {
        setBusy(true);
        try { await updateBrandAsset(workspaceId, brand.id, asset.id, input); await onChanged(); setEditing(null); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    return <section className="platform-card"><div className="flex items-center justify-between gap-3"><h2>{t(`platform.brandAssetKinds.${kind}`)}</h2>{brand.canEdit ? <Button type="text" size="small" icon={<Plus size={14} />} onClick={() => onUpload(kind)}>{t("platform.brandUpload")}</Button> : <span className="platform-muted text-xs">{assets.length}</span>}</div>
        {kind === "style_ref" ? <p className="platform-muted mt-2 text-xs">{t("platform.brandReferenceHint")}</p> : null}
        {assets.length ? <Image.PreviewGroup><div className={`brand-asset-grid mt-4 ${kind === "logo" ? "brand-logos" : ""}`}>{assets.map((asset) => <article key={asset.id} className="min-w-0"><div className={`brand-asset-image ${kind === "style_ref" && asset.attachOnGenerate ? "is-attached" : ""}`}><Image src={asset.url} alt={asset.title} width="100%" height="100%" styles={{ image: { objectFit: "contain", width: "100%", height: "100%" } }} /></div><strong className="mt-2 block truncate text-xs" title={asset.title}>{asset.title}</strong>{asset.spec ? <p className="platform-muted mt-1 truncate text-xs">{asset.spec}</p> : null}{kind === "style_ref" ? <div className="mt-2 flex items-center gap-2 text-xs"><Switch size="small" aria-label={t("platform.attachOnGenerate")} checked={asset.attachOnGenerate} disabled={!brand.canEdit || busy} onChange={(attachOnGenerate) => void change(asset, { attachOnGenerate })} />{t("platform.attachOnGenerate")}</div> : null}{brand.canEdit ? <div className="mt-1 flex gap-1"><Button type="text" size="small" onClick={() => { setEditing(asset); form.setFieldsValue(asset); }}>{t("platform.edit")}</Button><Button type="text" size="small" danger disabled={busy} onClick={() => modal.confirm({ title: t("platform.deleteAssetConfirm", { name: asset.title }), onOk: async () => { try { await deleteBrandAsset(workspaceId, brand.id, asset.id); await onChanged(); } catch (error) { message.error((error as Error).message); throw error; } } })}>{t("platform.remove")}</Button></div> : null}</article>)}</div></Image.PreviewGroup> : <Empty className="my-6" image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("platform.noBrandAssets")} />}
        <Modal title={t("platform.editBrandAsset")} open={Boolean(editing)} onCancel={() => setEditing(null)} footer={null} destroyOnHidden><Form form={form} layout="vertical" disabled={busy} onFinish={(input) => editing && void change(editing, input)}><Form.Item name="title" label={t("platform.name")} rules={[{ required: true, whitespace: true }]}><Input /></Form.Item><Form.Item name="spec" label={t("platform.skuSpec")}><Input /></Form.Item><Form.Item name="tags" label={t("platform.tags")}><Select mode="tags" open={false} /></Form.Item><Button type="primary" htmlType="submit" loading={busy}>{t("platform.save")}</Button></Form></Modal>
    </section>;
}
