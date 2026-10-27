import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Empty, Form, Input, Modal, Select, Skeleton, Tag } from "antd";
import { ArrowLeft, ArrowRight, Layers3, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BrandSelector } from "@/components/brand/brand-selector";
import { useSessionStore } from "@/stores/use-session-store";
import { useCreditsStore } from "@/stores/use-credits-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { assertBrandSession } from "@/services/api/platform/brands";
import { deleteTemplate, fetchTemplate, fetchTemplates, prepareTemplateInsertion, readTemplateImage, updateTemplate, type PlatformTemplate, type TemplateCategory, type TemplateInsertion, type TemplateValues } from "@/services/api/platform/templates";
import { TemplateVariables } from "./template-variables";
import { templateEstimates } from "./template-estimate";
import { templateErrorMessage } from "./template-error";
import "./templates.css";

export const TEMPLATE_CATEGORIES: TemplateCategory[] = ["ecommerce", "short_video", "brand", "social", "other"];

export function TemplateLibrary({ compact = false, onInsert }: { compact?: boolean; onInsert?: (input: TemplateInsertion) => Promise<void> | void }) {
    const { t } = useTranslation();
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId)!;
    const generation = useSessionStore((state) => state.generation);
    const [category, setCategory] = useState("all");
    const [search, setSearch] = useState("");
    const [compactSelected, setCompactSelected] = useState<string | null>(null);
    const [searchParams, setSearchParams] = useSearchParams();
    const selected = compact ? compactSelected : searchParams.get("id");
    const setSelected = (id: string | null) => {
        if (compact) setCompactSelected(id);
        else setSearchParams((current) => { const next = new URLSearchParams(current); if (id) next.set("id", id); else next.delete("id"); return next; });
    };
    const billingEnabled = useCreditsStore((state) => state.billingEnabled[workspaceId]);
    const list = useQuery({ queryKey: ["platform", "templates", generation, workspaceId, category, search], queryFn: ({ signal }) => fetchTemplates(workspaceId, { category: TEMPLATE_CATEGORIES.includes(category as TemplateCategory) ? category as TemplateCategory : undefined, scope: category === "team" ? "team" : "all", q: search || undefined }, signal) });
    const detail = useQuery({ queryKey: ["platform", "template", generation, workspaceId, selected], queryFn: ({ signal }) => fetchTemplate(workspaceId, selected!, signal), enabled: Boolean(selected) });
    useEffect(() => { setCompactSelected(null); }, [workspaceId, generation]);
    return <div className={compact ? "template-library is-compact" : "template-library"}>
        <div className="mb-5 flex flex-wrap items-center gap-3">
            <Input allowClear prefix={<Search size={15} />} className={compact ? "w-full" : "max-w-72"} placeholder={t("platform.templateSearch")} value={search} onChange={(event) => setSearch(event.target.value)} />
            <div className="flex max-w-full gap-1 overflow-x-auto">{["all", ...TEMPLATE_CATEGORIES, "team"].map((value) => <Button key={value} type={value === category ? "primary" : "text"} size="small" onClick={() => setCategory(value)}>{t(`platform.templateCategories.${value}`)}</Button>)}</div>
        </div>
        <div className="template-library-layout">
            {compact && selected ? null : <div className="min-w-0">
                {list.error ? <Alert type="error" title={list.error.message} action={<Button onClick={() => void list.refetch()}>{t("platform.retry")}</Button>} /> : list.isPending ? <Skeleton active /> : !list.data?.length ? <Empty description={t("platform.noTemplates")} /> : <div className="template-card-grid">{list.data.map((template) => <button type="button" key={template.id} data-template-id={template.id} className={`template-card${selected === template.id ? " is-selected" : ""}`} onClick={() => setSelected(template.id)}>
                    <div className="template-card-cover">{template.coverUrl ? <img src={template.coverUrl} alt="" /> : <div className="template-card-flow">{template.previewNodes.map((title, index) => <span key={`${index}:${title}`}>{index > 0 ? <ArrowRight size={14} /> : null}<span>{title}</span></span>)}{!template.previewNodes.length ? <Layers3 size={36} strokeWidth={1.2} /> : null}</div>}</div>
                    <div className="p-4"><div className="mb-2 flex items-start justify-between gap-2"><h2 className="text-base font-semibold">{template.name}</h2><Tag className="m-0 shrink-0">{t(template.scope === "official" ? "platform.officialTemplate" : "platform.teamTemplate")}</Tag></div><p className="line-clamp-2 min-h-10 text-xs leading-5 opacity-60">{template.description}</p><div className="mt-4 flex flex-wrap justify-between gap-2 text-xs opacity-65"><span>{billingEnabled === false ? t("platform.templatePlatformFree") : t("platform.templateStepEstimate", { count: template.estimateCredits })}</span><span>{t("platform.templateUseCount", { count: template.useCount })}</span></div></div>
                </button>)}</div>}
            </div>}
            {selected ? <aside className="template-detail min-w-0" data-template-id={selected}>{compact ? <Button className="mb-3" type="text" icon={<ArrowLeft size={15} />} onClick={() => setSelected(null)}>{t("platform.templateCenter")}</Button> : null}{detail.error ? <Alert type="error" title={detail.error.message} action={<Button onClick={() => void detail.refetch()}>{t("platform.retry")}</Button>} /> : detail.isPending ? <Skeleton active /> : detail.data ? <TemplateDetail key={`${generation}:${workspaceId}:${detail.data.id}`} template={detail.data} onInsert={onInsert} onDeleted={() => setSelected(null)} /> : null}</aside> : compact ? null : <aside className="template-detail flex items-center justify-center"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("platform.templateSelectHint")} /></aside>}
        </div>
    </div>;
}

function TemplateDetail({ template, onInsert, onDeleted }: { template: PlatformTemplate; onInsert?: (input: TemplateInsertion) => Promise<void> | void; onDeleted: () => void }) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId)!;
    const generation = useSessionStore((state) => state.generation);
    const config = useEffectiveConfig({ source: "canvas" });
    const billingEnabled = useCreditsStore((state) => state.billingEnabled[workspaceId]);
    const [values, setValues] = useState<TemplateValues>(() => Object.fromEntries(template.body.variables.filter((variable) => variable.type !== "image" && variable.default !== undefined).map((variable) => [variable.key, variable.default!])));
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(false);
    const [imagesLoading, setImagesLoading] = useState(false);
    const [form] = Form.useForm<{ name: string; description: string; category: TemplateCategory }>();
    const missing = template.body.variables.filter((variable) => { const value = Object.hasOwn(values, variable.key) ? values[variable.key] : undefined; return variable.required !== false && (!value || typeof value === "string" && !value.trim()); });
    const estimate = templateEstimates(template.body, config, values);
    const platformFree = estimate.platform && billingEnabled === false;
    useEffect(() => {
        let active = true;
        const defaults = template.body.variables.filter((variable) => variable.type === "image" && variable.default);
        if (!defaults.length) return;
        setImagesLoading(true);
        void Promise.all(defaults.map(async (variable) => {
            try { const image = await readTemplateImage(variable.default!, workspaceId, generation); if (active) setValues((current) => Object.hasOwn(current, variable.key) && current[variable.key] ? current : { ...current, [variable.key]: image }); }
            catch (error) { if (active) message.error(templateErrorMessage(error)); }
        })).finally(() => { if (active) setImagesLoading(false); });
        return () => { active = false; };
    }, [generation, message, template.body.variables, workspaceId]);
    const insert = async () => {
        setBusy(true);
        try {
            const prepared = await prepareTemplateInsertion({ template, values, workspaceId, generation });
            assertBrandSession(workspaceId, generation);
            if (onInsert) await onInsert(prepared);
            else { const projectId = useCanvasStore.getState().createProject(template.name); navigate(`/canvas/${projectId}`, { state: { templateInsertion: prepared } }); }
        } catch (error) { message.error(templateErrorMessage(error)); }
        finally { setBusy(false); }
    };
    const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["platform", "templates", generation, workspaceId] }), queryClient.invalidateQueries({ queryKey: ["platform", "template", generation, workspaceId, template.id] })]);
    return <>
        <h2 className="text-lg font-semibold">{template.name}</h2><p className="mt-2 text-sm leading-6 opacity-60">{template.description}</p>
        <h3 className="mb-3 mt-5 text-sm font-semibold">{t("platform.templateSteps")}</h3><ol className="space-y-3">{template.body.steps.map((step, index) => <li key={index} className="flex gap-3 text-xs"><span className="opacity-40">{String(index + 1).padStart(2, "0")}</span><span className="flex-1">{step.label}</span><span className="opacity-60">{platformFree ? t("platform.creditAmount", { count: 0 }) : estimate.steps[index] === null ? "—" : t("platform.creditAmount", { count: estimate.steps[index] })}</span></li>)}</ol>
        <div className="mb-4 mt-5"><BrandSelector /></div>
        <h3 className="mb-3 text-sm font-semibold">{t("platform.templateVariables")}</h3><TemplateVariables variables={template.body.variables} values={values} onChange={setValues} />
        <div className="mt-6 border-t pt-4" style={{ borderColor: "var(--workspace-border)" }}><strong className="text-sm">{platformFree ? t("platform.templatePlatformFree") : estimate.total === null ? t("platform.templateNoPrice") : !estimate.platform && estimate.total === 0 ? t("platform.templateByok") : t("platform.templateTotal", { count: estimate.total })}</strong><p className="my-2 text-xs opacity-60">{t(platformFree ? "platform.templateInsertFreeHint" : "platform.templateInsertHint")}</p>{missing.length ? <p className="mb-3 text-xs opacity-60">{t("platform.templateMissing", { fields: missing.map((variable) => variable.label).join("、") })}</p> : null}<Button type="primary" block loading={busy || imagesLoading} disabled={missing.length > 0 || imagesLoading} onClick={() => void insert()}>{t(onInsert ? "platform.insertTemplate" : "platform.useInNewCanvas")}</Button></div>
        {template.canEdit ? <div className="mt-3 flex justify-between"><Button type="text" size="small" onClick={() => { form.setFieldsValue(template); setEditing(true); }}>{t("platform.edit")}</Button><Button danger type="text" size="small" onClick={() => modal.confirm({ title: t("platform.templateDelete"), onOk: async () => { await deleteTemplate(workspaceId, template.id); assertBrandSession(workspaceId, generation); await refresh(); onDeleted(); } })}>{t("platform.remove")}</Button></div> : null}
        <Modal open={editing} title={t("platform.templateEdit")} footer={null} onCancel={() => setEditing(false)}><Form layout="vertical" form={form} onFinish={async (input) => { setBusy(true); try { await updateTemplate(workspaceId, template.id, { ...input, body: template.body, previewNodes: template.previewNodes }); assertBrandSession(workspaceId, generation); await refresh(); setEditing(false); message.success(t("platform.saved")); } catch (error) { message.error((error as Error).message); } finally { setBusy(false); } }}><Form.Item name="name" label={t("platform.templateName")} rules={[{ required: true, whitespace: true }]}><Input /></Form.Item><Form.Item name="category" label={t("platform.templateCategory")}><Select options={TEMPLATE_CATEGORIES.map((value) => ({ value, label: t(`platform.templateCategories.${value}`) }))} /></Form.Item><Form.Item name="description" label={t("platform.templateSaveDescription")}><Input.TextArea rows={3} /></Form.Item><Button type="primary" htmlType="submit" loading={busy}>{t("platform.save")}</Button></Form></Modal>
    </>;
}
