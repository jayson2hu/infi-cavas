import { App, Button, Input, Modal, Select, Upload } from "antd";
import { ImagePlus } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBrandStore } from "@/stores/use-brand-store";
import { useSessionStore } from "@/stores/use-session-store";
import { downloadBrandAsset } from "@/services/api/platform/brands";
import { localTemplateImage, type TemplateValues } from "@/services/api/platform/templates";
import type { TemplateVariable } from "../../../../shared/template";

export function TemplateVariables({ variables, values, onChange }: { variables: TemplateVariable[]; values: TemplateValues; onChange: (values: TemplateValues) => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const brand = useBrandStore((state) => state.brand);
    const [skuFor, setSkuFor] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const valuesRef = useRef(values);
    valuesRef.current = values;
    const set = (key: string, value: TemplateValues[string]) => onChange({ ...valuesRef.current, [key]: value });
    const choose = async (key: string, file: Blob | (() => Promise<Blob>)) => {
        const { currentWorkspaceId, generation } = useSessionStore.getState();
        if (!currentWorkspaceId) return;
        setBusy(key);
        try { set(key, await localTemplateImage(typeof file === "function" ? await file() : file, currentWorkspaceId, generation)); setSkuFor(null); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(null); }
    };
    return <>
        <div className="space-y-4">{variables.map((variable) => {
            const value = Object.hasOwn(values, variable.key) ? values[variable.key] : undefined;
            return <div key={variable.key}>
                <label className="mb-1.5 block text-sm font-medium" htmlFor={`template-var-${variable.key}`}>{variable.label}{variable.required !== false ? <span className="ml-1 opacity-60">*</span> : null}</label>
                {variable.type === "image" ? <div className="space-y-2">
                    {typeof value === "object" ? <img src={value.content} alt={variable.label} className="h-28 w-full rounded-lg object-contain" /> : null}
                    <Upload accept="image/png,image/jpeg,image/webp" showUploadList={false} beforeUpload={(file) => { void choose(variable.key, file); return Upload.LIST_IGNORE; }} disabled={Boolean(busy)}><Button icon={<ImagePlus size={15} />} loading={busy === variable.key} disabled={Boolean(busy)}>{t("platform.templateImageUpload")}</Button></Upload>
                    {variable.allowBrandSku ? <Button type="text" className="max-w-full" disabled={!brand?.assets.some((asset) => asset.kind === "sku") || Boolean(busy)} onClick={() => setSkuFor(variable.key)}>{t("platform.chooseBrandSku")}</Button> : null}
                    {variable.placeholder ? <p className="text-xs opacity-55">{variable.placeholder}</p> : null}
                </div> : variable.type === "select" ? <Select id={`template-var-${variable.key}`} className="w-full" value={typeof value === "string" ? value : undefined} placeholder={variable.placeholder} options={variable.options?.map((option) => ({ value: option, label: option }))} onChange={(next) => set(variable.key, next)} /> : <Input.TextArea id={`template-var-${variable.key}`} autoSize={{ minRows: 2, maxRows: 6 }} value={typeof value === "string" ? value : ""} placeholder={variable.placeholder} onChange={(event) => set(variable.key, event.target.value)} />}
            </div>;
        })}</div>
        <Modal open={Boolean(skuFor)} title={t("platform.chooseBrandSku")} footer={null} onCancel={() => setSkuFor(null)}><div className="grid grid-cols-3 gap-3">{brand?.assets.filter((asset) => asset.kind === "sku").map((asset) => <button key={asset.id} type="button" disabled={Boolean(busy)} onClick={() => { const workspaceId = useSessionStore.getState().currentWorkspaceId; if (skuFor && workspaceId) void choose(skuFor, () => downloadBrandAsset(workspaceId, asset)); }} className="min-w-0 text-left"><img src={asset.url} alt={asset.title} className="aspect-square w-full rounded-lg object-contain" /><span className="mt-1 block truncate text-xs">{asset.title}</span></button>)}</div></Modal>
    </>;
}
