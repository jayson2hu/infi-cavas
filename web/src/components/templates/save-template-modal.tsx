import { useMemo, useState } from "react";
import { Alert, App, Button, Checkbox, Form, Input, Modal, Select, Upload } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { serializeTemplate, templateImageInputs, templateSelection } from "@/lib/templates/serialize";
import type { TemplateVariableBinding } from "@/lib/templates/types";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useSessionStore } from "@/stores/use-session-store";
import { assertBrandSession } from "@/services/api/platform/brands";
import { createTemplate, permanentTemplateImage, uploadTemplateImage, type TemplateCategory } from "@/services/api/platform/templates";
import { TEMPLATE_CATEGORIES } from "./template-library";
import { templateErrorMessage } from "./template-error";
import { templateGenerationSnapshot } from "./template-estimate";

export function SaveTemplateModal({ nodes, connections, selectedNodeIds, onClose }: { nodes: CanvasNodeData[]; connections: CanvasConnection[]; selectedNodeIds: Set<string>; onClose: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const config = useEffectiveConfig({ source: "canvas" });
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId)!;
    const generation = useSessionStore((state) => state.generation);
    const [snapshot] = useState(() => ({ nodes: structuredClone(nodes), connections: structuredClone(connections), selectedNodeIds: [...selectedNodeIds] }));
    const selected = useMemo(() => templateSelection(snapshot.nodes, snapshot.selectedNodeIds), [snapshot]);
    const candidates = selected.filter((node) => ["text", "image"].includes(node.type) && (node.metadata?.content || node.metadata?.storageKey) && !node.metadata?.generationMode && !node.metadata?.generationType && !node.metadata?.prompt);
    const [variables, setVariables] = useState<TemplateVariableBinding[]>([]);
    const [cover, setCover] = useState<File | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const save = async (input: { name: string; category: TemplateCategory; description?: string }) => {
        setBusy(true); setError("");
        try {
            assertBrandSession(workspaceId, generation);
            const parameters = templateGenerationSnapshot(selected, config);
            const images = templateImageInputs({ ...snapshot, variables });
            const convert = (imageContents: Record<string, string>) => serializeTemplate({ ...snapshot, ...parameters, variables, imageContents, stepLabel: (index, mode) => t("platform.templateSavedStep", { index, mode: t(`platform.capabilities.${mode}`) }) });
            // Validate graph/variables before uploading any permanent image bytes.
            convert(Object.fromEntries(images.map((node) => [node.id, "/api/files/validation-only"])));
            const imageContents = Object.fromEntries(await Promise.all(images.map(async (node) => [node.id, await permanentTemplateImage(node, workspaceId, generation)])));
            const body = convert(imageContents);
            const coverObjectKey = cover ? await uploadTemplateImage(workspaceId, cover, "template_cover") : undefined;
            assertBrandSession(workspaceId, generation);
            await createTemplate(workspaceId, { ...input, body, coverObjectKey, previewNodes: body.steps.slice(0, 3).map((step) => step.label) });
            assertBrandSession(workspaceId, generation);
            await queryClient.invalidateQueries({ queryKey: ["platform", "templates", generation, workspaceId] });
            message.success(t("platform.templateSaved")); onClose();
        } catch (error) { setError(templateErrorMessage(error)); }
        finally { setBusy(false); }
    };
    return <Modal open title={t("platform.templateSave")} footer={null} onCancel={() => !busy && onClose()} width={600}>
        <p className="mb-4 text-sm opacity-65">{t("platform.templateSaveResultHint")}</p>
        {error ? <Alert className="mb-4" type="error" title={error} /> : null}
        <Form layout="vertical" onFinish={save} disabled={busy} initialValues={{ category: "other" }}>
            <Form.Item name="name" label={t("platform.templateName")} rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>
            <Form.Item name="category" label={t("platform.templateCategory")} rules={[{ required: true }]}><Select options={TEMPLATE_CATEGORIES.map((value) => ({ value, label: t(`platform.templateCategories.${value}`) }))} /></Form.Item>
            <Form.Item name="description" label={t("platform.templateSaveDescription")}><Input.TextArea rows={2} /></Form.Item>
            <Form.Item label={t("platform.templateCover")}><Upload accept="image/png,image/jpeg,image/webp" maxCount={1} fileList={cover ? [{ uid: "cover", name: cover.name, status: "done" }] : []} beforeUpload={(file) => { setCover(file); return false; }} onRemove={() => { setCover(null); }}><Button>{t("platform.templateImageUpload")}</Button></Upload></Form.Item>
            {candidates.length ? <section className="mb-5"><h3 className="mb-1 text-sm font-semibold">{t("platform.templateSaveInputs")}</h3><p className="mb-3 text-xs opacity-60">{t("platform.templateVariableHint")}</p><div className="space-y-3">{candidates.map((node, index) => {
                const binding = variables.find((variable) => variable.nodeId === node.id);
                return <div key={node.id} className="flex items-center gap-3"><Checkbox checked={Boolean(binding)} onChange={(event) => setVariables((current) => event.target.checked ? [...current, { nodeId: node.id, key: `input${index + 1}`, label: node.title || t(`platform.capabilities.${node.type}`), required: true, ...(node.type === "image" ? { allowBrandSku: true } : {}) }] : current.filter((variable) => variable.nodeId !== node.id))}>{node.title || t(`platform.capabilities.${node.type}`)}</Checkbox>{binding ? <Input className="ml-auto max-w-52" aria-label={t("platform.templateVariableLabel")} value={binding.label} onChange={(event) => setVariables((current) => current.map((variable) => variable.nodeId === node.id ? { ...variable, label: event.target.value } : variable))} /> : null}</div>;
            })}</div></section> : null}
            <Button type="primary" htmlType="submit" loading={busy} disabled={!selected.length}>{t("platform.templateSave")}</Button>
        </Form>
    </Modal>;
}
