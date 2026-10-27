import { App, Empty, Skeleton } from "antd";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { BrandSelector } from "./brand-selector";
import { useBrandStore } from "@/stores/use-brand-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { BRAND_ASSET_DRAG_TYPE, brandAssetDrag } from "@/lib/brand-drag";
import { assertBrandSession, downloadBrandAsset, type BrandAsset } from "@/services/api/platform/brands";
import { useSessionStore } from "@/stores/use-session-store";
import { uploadImage } from "@/services/image-storage";
import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";

export function CanvasBrandTab({ onInsert }: { onInsert: (payload: InsertAssetPayload) => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const state = useBrandStore();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [busy, setBusy] = useState<string | null>(null);
    const brand = state.brand;
    const logos = brand?.assets.filter((asset) => asset.kind === "logo") || [];
    const skus = brand?.assets.filter((asset) => asset.kind === "sku") || [];
    const references = brand?.assets.filter((asset) => asset.kind === "style_ref") || [];
    const insert = async (asset: BrandAsset) => {
        const workspaceId = useSessionStore.getState().currentWorkspaceId;
        const generation = useSessionStore.getState().generation;
        if (!workspaceId) return;
        setBusy(asset.id);
        try { const file = await downloadBrandAsset(workspaceId, asset); const image = await uploadImage(file); assertBrandSession(workspaceId, generation); onInsert({ kind: "image", dataUrl: image.url, storageKey: image.storageKey, title: asset.title }); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(null); }
    };
    return <div className="thin-scrollbar h-full overflow-auto px-3 pb-5">
        <BrandSelector />
        <div className="my-4 flex items-center justify-between gap-2"><span className="text-xs opacity-60">{t("platform.brandDragHint")}</span><Link className="shrink-0 text-xs" to={brand ? `/brand/${brand.id}` : "/brand"}>{t("platform.manageBrands")}</Link></div>
        {!state.ready && !state.error ? <Skeleton active paragraph={{ rows: 4 }} /> : !brand ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("platform.noBrandAssets")} /> : <div className="space-y-5">
            <section aria-label={t("platform.brandAssetKinds.sku")}>
                <h3 className="mb-2 text-xs font-semibold">{t("platform.brandAssetKinds.sku")}</h3>
                <div className="grid grid-cols-3 gap-2">
                    {skus.map((asset) => <button key={asset.id} type="button" draggable={!busy} disabled={Boolean(busy)} onDragStart={(event) => { event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData(BRAND_ASSET_DRAG_TYPE, JSON.stringify(brandAssetDrag(brand.id, asset.id))); }} onClick={() => void insert(asset)} className="min-w-0 text-left" title={t("platform.insertSku")}>
                        <img src={asset.url} alt={asset.title} draggable={false} className="aspect-square w-full rounded-lg border object-contain" style={{ borderColor: theme.node.stroke }} />
                        <span className="mt-1 block truncate text-xs">{asset.title}</span><small className="block truncate text-[10px] opacity-60">{asset.spec}</small>
                    </button>)}
                </div>
                {!skus.length ? <p className="text-xs opacity-50">{t("platform.noBrandAssets")}</p> : null}
            </section>
            <section aria-label={t("platform.brandAssetKinds.style_ref")}>
                <h3 className="mb-2 text-xs font-semibold">{t("platform.brandAssetKinds.style_ref")}</h3>
                <div className="grid grid-cols-2 gap-2">
                    {references.map((asset) => <div key={asset.id} className="min-w-0" title={t("platform.brandReferenceHint")}>
                        <img src={asset.url} alt={asset.title} draggable={false} className="aspect-[4/3] w-full rounded-lg border-2 object-cover" style={{ borderColor: asset.attachOnGenerate ? theme.node.activeStroke : theme.node.stroke }} />
                        <span className="mt-1 block truncate text-xs">{asset.title}</span>
                        {asset.attachOnGenerate ? <span className="mt-0.5 flex items-center gap-1 text-[10px]"><Check className="size-3 shrink-0" />{t("platform.attachOnGenerate")}</span> : null}
                    </div>)}
                </div>
                {!references.length ? <p className="text-xs opacity-50">{t("platform.noBrandAssets")}</p> : null}
            </section>
            <section aria-label={t("platform.brandAssetKinds.logo")}>
                <h3 className="mb-2 text-xs font-semibold">{t("platform.brandAssetKinds.logo")}</h3>
                <div className="grid grid-cols-3 gap-2">{logos.map((asset) => <img key={asset.id} src={asset.url} alt={asset.title} title={asset.title} draggable={false} className="aspect-square w-full rounded-lg border object-contain p-1" style={{ borderColor: theme.node.stroke }} />)}</div>
                {!logos.length ? <p className="text-xs opacity-50">{t("platform.noBrandAssets")}</p> : null}
            </section>
            <section aria-label={t("platform.brandColors")}>
                <h3 className="mb-2 text-xs font-semibold">{t("platform.brandColors")}</h3>
                <div className="flex flex-wrap gap-2">{brand.colors.map((color) => <span key={color.id || color.hex} title={`${color.name} ${color.hex}`} className="h-6 w-6 rounded-full border" style={{ background: color.hex, borderColor: theme.node.stroke }} />)}</div>
                {!brand.colors.length ? <p className="text-xs opacity-50">{t("platform.noBrandColors")}</p> : null}
            </section>
            <section aria-label={t("platform.brandRules")}>
                <h3 className="mb-2 text-xs font-semibold">{t("platform.brandRules")}</h3>
                <dl className="space-y-2 text-xs leading-relaxed">
                    <div><dt className="opacity-60">{t("platform.requiredTerms")}</dt><dd className="break-words">{brand.requiredTerms.join(" · ") || t("platform.noBrandTerms")}</dd></div>
                    <div><dt className="opacity-60">{t("platform.avoidTerms")}</dt><dd className="break-words">{brand.avoidTerms.join(" · ") || t("platform.noBrandTerms")}</dd></div>
                </dl>
            </section>
        </div>}
    </div>;
}
