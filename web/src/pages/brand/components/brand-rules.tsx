import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Form, Input, InputNumber, Select, Skeleton, Tag } from "antd";
import { useTranslation } from "react-i18next";
import { assertBrandSession, fetchBrandPreview, updateBrand, type Brand } from "@/services/api/platform/brands";
import { useSessionStore } from "@/stores/use-session-store";
import { decodeChannelModel, useEffectiveConfig } from "@/stores/use-config-store";
import { isByokAllowed } from "@/lib/platform";

export function BrandRules({ brand, onChanged }: { brand: Brand; onChanged: () => Promise<void> }) {
    const { t } = useTranslation();
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId)!;
    const generation = useSessionStore((state) => state.generation);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [form] = Form.useForm();
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const revision = useRef(0);
    const queue = useRef(Promise.resolve());
    const latest = useRef<Record<string, unknown>>({});
    useEffect(() => { form.setFieldsValue({ requiredTerms: brand.requiredTerms, avoidTerms: brand.avoidTerms, defaultParams: brand.defaultParams }); return () => { revision.current++; if (timer.current) clearTimeout(timer.current); }; }, [brand.id, workspaceId, generation, form]);
    const save = (input: Record<string, unknown>) => {
        latest.current = input;
        const current = ++revision.current;
        if (timer.current) clearTimeout(timer.current);
        setSaving(true); setError(null);
        timer.current = setTimeout(() => {
            queue.current = queue.current.then(async () => {
                if (current !== revision.current) return;
                try {
                    assertBrandSession(workspaceId, generation);
                    await form.validateFields();
                    const defaults = Object.fromEntries(Object.entries((input.defaultParams || {}) as Record<string, unknown>).filter(([, value]) => value !== undefined && value !== null && value !== ""));
                    await updateBrand(workspaceId, brand.id, { requiredTerms: input.requiredTerms as string[], avoidTerms: input.avoidTerms as string[], defaultParams: defaults });
                    if (current === revision.current) { await onChanged(); setSaving(false); }
                } catch (error) { if (current === revision.current) { setError(error instanceof Error ? error.message : t("platform.brandInvalidRules")); setSaving(false); } }
            });
        }, 300);
    };
    return <section className="platform-card"><div className="flex items-center justify-between gap-3"><h2>{t("platform.brandRules")}</h2>{brand.canEdit ? <span className="platform-muted text-[11px]" role="status">{saving ? t("platform.saving") : error ? t("platform.brandNotSaved") : t("platform.autoSaved")}</span> : null}</div>{error ? <Alert className="mt-3" type="error" showIcon title={error} action={<Button size="small" onClick={() => save(latest.current)}>{t("platform.retry")}</Button>} /> : null}
        {brand.canEdit ? <Form form={form} layout="vertical" className="mt-4" onValuesChange={(_, values) => save(values)}><Form.Item name="requiredTerms" label={t("platform.requiredTerms")}><Select mode="tags" maxCount={20} open={false} tokenSeparators={["，", ","]} /></Form.Item><Form.Item name="avoidTerms" label={t("platform.avoidTerms")}><Select mode="tags" maxCount={30} open={false} tokenSeparators={["，", "、", ","]} /></Form.Item><details><summary className="mb-3 cursor-pointer text-xs">{t("platform.defaultParameters")}</summary><div className="grid grid-cols-2 gap-x-3">{["model", "quality", "size", "background", "resolution", "aspect_ratio", "mode", "voice", "response_format"].map((key) => <Form.Item key={key} name={["defaultParams", key]} label={t(`platform.brandParams.${key}`)}><Input allowClear /></Form.Item>)}{["n", "seconds", "speed", "temperature", "max_output_tokens"].map((key) => <Form.Item key={key} name={["defaultParams", key]} label={t(`platform.brandParams.${key}`)}><InputNumber className="w-full" /></Form.Item>)}{["generate_audio", "watermark"].map((key) => <Form.Item key={key} name={["defaultParams", key]} label={t(`platform.brandParams.${key}`)}><Select allowClear options={[{ value: true, label: t("platform.enabled") }, { value: false, label: t("platform.disabled") }]} /></Form.Item>)}</div></details><p className="platform-muted text-xs">{t("platform.brandDefaultsHint")}</p></Form> : <div className="mt-4 space-y-4"><div><p className="platform-muted mb-2 text-xs">{t("platform.requiredTerms")}</p>{brand.requiredTerms.map((term) => <Tag color="success" key={term}>{term}</Tag>)}</div><div><p className="platform-muted mb-2 text-xs">{t("platform.avoidTerms")}</p>{brand.avoidTerms.map((term) => <Tag color="error" key={term}>{term}</Tag>)}</div><p className="platform-muted text-xs">{t("platform.defaultParameters")}</p><pre className="overflow-auto text-xs">{JSON.stringify(brand.defaultParams, null, 2)}</pre></div>}
    </section>;
}

export function BrandPreview({ brand }: { brand: Brand }) {
    const { t } = useTranslation();
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId)!;
    const generation = useSessionStore((state) => state.generation);
    const model = useEffectiveConfig().imageModel;
    const selected = decodeChannelModel(model);
    const [prompt, setPrompt] = useState("");
    const [debounced, setDebounced] = useState("");
    useEffect(() => { const timer = setTimeout(() => setDebounced(prompt), 300); return () => clearTimeout(timer); }, [prompt]);
    const params = { prompt: debounced, ...(selected?.channelId === "platform" ? { modelId: selected.model } : { capability: "text" as const }) };
    const query = useQuery({ queryKey: ["platform", "brand-preview", generation, workspaceId, brand.id, brand.updatedAt, params], queryFn: ({ signal }) => fetchBrandPreview(workspaceId, brand.id, params, signal) });
    return <section className="platform-card"><h2>{t("platform.injectionPreview")}</h2><Input.TextArea className="mt-3" aria-label={t("platform.examplePrompt")} placeholder={t("platform.examplePrompt")} value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={2} />{query.isPending ? <Skeleton className="mt-4" active paragraph={{ rows: 5 }} /> : query.error ? <Alert className="mt-4" type="error" title={query.error.message} action={<Button size="small" onClick={() => void query.refetch()}>{t("platform.retry")}</Button>} /> : <pre className="brand-injection mt-3" aria-live="polite">{query.data?.text}</pre>}<p className="platform-muted mt-3 text-xs">{selected?.channelId === "platform" || !isByokAllowed() ? t("platform.brandPreviewReferences", { count: query.data?.attachedReferenceCount || 0 }) : t("platform.brandByokTextOnly")}</p></section>;
}
