import { useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Avatar, Button, Empty, Form, Input, Modal, Select, Skeleton, Switch, Table, Tabs, Tag, Upload } from "antd";
import { ArrowLeft, Plus, Upload as UploadIcon } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { assertBrandSession, createBrand, deleteBrand, fetchBrand, updateBrand, uploadBrandAsset, type Brand, type BrandAsset, type BrandInput } from "@/services/api/platform/brands";
import { fetchMembers, updateWorkspace } from "@/services/api/platform/workspaces";
import { fetchJobs } from "@/services/api/platform/billing";
import { useSessionStore } from "@/stores/use-session-store";
import { useBrandStore } from "@/stores/use-brand-store";
import { BrandAssets } from "./components/brand-assets";
import { BrandColors } from "./components/brand-colors";
import { BrandPreview, BrandRules } from "./components/brand-rules";
import "./brand.css";

export default function BrandPage() {
    const { id } = useParams();
    const { t, i18n } = useTranslation();
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId)!;
    const generation = useSessionStore((state) => state.generation);
    const role = useSessionStore((state) => state.workspaces.find((workspace) => workspace.id === state.currentWorkspaceId)?.role);
    const manage = role === "owner" || role === "admin";
    const brands = useBrandStore((state) => state.brands);
    const ready = useBrandStore((state) => state.ready);
    const brandError = useBrandStore((state) => state.error);
    const query = useQuery({ queryKey: ["platform", "brand", generation, workspaceId, id], queryFn: ({ signal }) => fetchBrand(workspaceId, id!, signal), enabled: Boolean(id) });
    const members = useQuery({ queryKey: ["platform", "members", generation, workspaceId], queryFn: ({ signal }) => fetchMembers(workspaceId, signal) });
    const [tab, setTab] = useState("overview");
    const [editing, setEditing] = useState<Brand | "new" | null>(null);
    const [busy, setBusy] = useState(false);
    const [uploadKind, setUploadKind] = useState<BrandAsset["kind"] | null>(null);
    const [files, setFiles] = useState<File[]>([]);
    const [form] = Form.useForm<BrandInput>();
    const brand = query.data;
    const refresh = async () => {
        await Promise.all([queryClient.invalidateQueries({ queryKey: ["platform", "brand", generation, workspaceId] }), queryClient.invalidateQueries({ queryKey: ["platform", "brand-preview", generation, workspaceId] }), useBrandStore.getState().load(workspaceId, generation)]);
    };
    const edit = (value?: Brand) => { setEditing(value || "new"); form.resetFields(); form.setFieldsValue(value || { name: "", enforced: false, editorUserIds: [] }); };
    const save = async (input: BrandInput) => {
        setBusy(true);
        try {
            const values = { ...input, ...(manage ? {} : { enforced: undefined, editorUserIds: undefined }) };
            const result = editing === "new" ? await createBrand(workspaceId, values) : await updateBrand(workspaceId, (editing as Brand).id, values);
            await refresh(); assertBrandSession(workspaceId, generation); setEditing(null); navigate(`/brand/${result.id}`); message.success(t("platform.saved"));
        } catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    const setDefault = async () => {
        if (!brand) return;
        setBusy(true);
        try { await updateWorkspace(workspaceId, { defaultBrandId: brand.isDefault ? null : brand.id }); assertBrandSession(workspaceId, generation); await useSessionStore.getState().refresh(workspaceId); await refresh(); message.success(t("platform.saved")); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    const upload = async () => {
        if (!brand || !uploadKind || !files.length) return;
        setBusy(true);
        const pending = [...files];
        try {
            for (const file of pending) { assertBrandSession(workspaceId, generation); await uploadBrandAsset(workspaceId, brand.id, file, { kind: uploadKind, title: file.name, attachOnGenerate: false }); setFiles((files) => files.filter((item) => item !== file)); }
            setUploadKind(null); message.success(t("platform.brandUploaded"));
        } catch (error) { message.error((error as Error).message); }
        finally { await refresh(); setBusy(false); }
    };
    const uploadOpen = (kind: BrandAsset["kind"] = "sku") => { setFiles([]); setUploadKind(kind); };
    const assets = (kind: BrandAsset["kind"]) => brand ? <BrandAssets brand={brand} kind={kind} onChanged={refresh} onUpload={uploadOpen} /> : null;
    const permissions = brand ? <section className="platform-card"><div className="flex items-center justify-between"><h2>{t("platform.brandPermissions")}</h2>{manage ? <Button type="text" size="small" onClick={() => edit(brand)}>{t("platform.edit")}</Button> : null}</div><dl className="platform-facts mt-4"><div><dt>{t("platform.brandEditors")}</dt><dd>{brand.editorUserIds.length ? brand.editorUserIds.map((id) => members.data?.find((member) => member.userId === id)?.name || t("platform.brandMemberEditor")).join("、") : t("platform.brandAdminsOnly")}</dd></div><div><dt>{t("platform.brandUsableBy")}</dt><dd>{t("platform.brandAllMembers")}</dd></div><div><dt>{t("platform.brandEnforcement")}</dt><dd>{t(brand.enforced ? "platform.enabled" : "platform.disabled")}</dd></div></dl></section> : null;
    return <main className="platform-page">
        {!id ? <><header className="platform-page-heading"><div><h1>{t("platform.brandLibrary")}</h1><p>{t("platform.brandLibraryDescription")}</p></div>{manage ? <Button type="primary" icon={<Plus size={16} />} onClick={() => edit()}>{t("platform.createBrand")}</Button> : null}</header>{brandError ? <Alert type="error" title={brandError} action={<Button onClick={() => void useBrandStore.getState().load(workspaceId, generation)}>{t("platform.retry")}</Button>} /> : !ready ? <Skeleton active paragraph={{ rows: 5 }} /> : brands.length ? <div className="brand-library-grid">{brands.map((item) => <Link to={`/brand/${item.id}`} className="platform-card brand-library-card" key={item.id}><Avatar src={item.logoUrl} shape="square" size={56}>{item.name.slice(0, 1)}</Avatar><h2 className="mt-4">{item.name} {item.isDefault ? <Tag>{t("platform.defaultBrand")}</Tag> : null}</h2><p className="platform-muted mt-2 text-xs">{item.industry || t("platform.brandNoIndustry")} · {t("platform.skuCount", { count: item.skuCount })}</p><div className="mt-4 flex gap-2">{item.colors.map((color) => <i key={color.id || color.hex} className="h-4 w-4 rounded-full border" style={{ background: color.hex, borderColor: "var(--workspace-border)" }} />)}</div></Link>)}</div> : <Empty description={t("platform.noBrands")} />}</> : query.isPending ? <Skeleton active paragraph={{ rows: 10 }} /> : query.error ? <Alert type="error" showIcon title={query.error.message} action={<Button onClick={() => void query.refetch()}>{t("platform.retry")}</Button>} /> : brand ? <>
            <header className="platform-page-heading"><div className="flex min-w-0 items-center gap-4"><Avatar shape="square" size={64} src={brand.logoUrl}>{brand.name.slice(0, 1)}</Avatar><div className="min-w-0"><h1 className="break-words">{brand.name} {brand.isDefault ? <Tag className="align-middle">{t("platform.defaultBrand")}</Tag> : null}</h1><p>{brand.industry || t("platform.brandNoIndustry")} · {t("platform.skuCount", { count: brand.skuCount })} · {t("platform.brandProjectCount", { count: brand.usedInProjects })} · {t("platform.brandUpdated", { date: new Date(brand.updatedAt).toLocaleDateString(i18n.language) })}</p></div></div><div className="flex flex-wrap gap-2"><Button icon={<ArrowLeft size={14} />} onClick={() => navigate("/brand")}>{t("platform.switchBrand")}</Button>{brand.canEdit ? <Button onClick={() => edit(brand)}>{t("platform.editBrand")}</Button> : null}{manage ? <Button loading={busy} onClick={() => void setDefault()}>{t(brand.isDefault ? "platform.unsetDefaultBrand" : "platform.setDefaultBrand")}</Button> : null}{brand.canEdit ? <Button type="primary" icon={<UploadIcon size={15} />} onClick={() => uploadOpen()}>{t("platform.brandUpload")}</Button> : null}</div></header>
            <Tabs activeKey={tab} onChange={setTab} items={["overview", "sku", "style_ref", "rules", "jobs"].map((key) => ({ key, label: t(`platform.brandTabs.${key}`) }))} />
            {tab === "overview" ? <div className="brand-overview-grid"><div className="space-y-5 min-w-0"><div className="brand-identity-grid">{assets("logo")}<BrandColors brand={brand} onChanged={refresh} /></div>{assets("sku")}{assets("style_ref")}</div><aside className="space-y-5 min-w-0"><BrandRules key={`${generation}:${workspaceId}:${brand.id}`} brand={brand} onChanged={refresh} /><BrandPreview brand={brand} />{permissions}</aside></div> : tab === "sku" || tab === "style_ref" ? assets(tab) : tab === "rules" ? <div className="brand-rules-grid"><BrandRules key={`${generation}:${workspaceId}:${brand.id}`} brand={brand} onChanged={refresh} /><div className="space-y-5"><BrandPreview brand={brand} />{permissions}</div></div> : <BrandJobs brandId={brand.id} />}
        </> : null}
        <Modal width={640} title={t(editing === "new" ? "platform.createBrand" : "platform.editBrand")} open={Boolean(editing)} onCancel={() => setEditing(null)} footer={null} destroyOnHidden><Form form={form} layout="vertical" disabled={busy} onFinish={save}><Form.Item name="name" label={t("platform.brandName")} rules={[{ required: true, whitespace: true }]}><Input /></Form.Item><Form.Item name="industry" label={t("platform.industry")}><Input /></Form.Item><Form.Item name="description" label={t("platform.description")}><Input.TextArea rows={3} /></Form.Item>{manage ? <><Form.Item name="editorUserIds" label={t("platform.brandEditors")}><Select mode="multiple" loading={members.isPending} options={members.data?.map((member) => ({ value: member.userId, label: `${member.name} (${member.email})` }))} /></Form.Item><Form.Item name="enforced" valuePropName="checked" label={t("platform.brandEnforcement")} extra={t("platform.brandEnforcedHint")}><Switch /></Form.Item></> : null}<div className="flex justify-between gap-3"><Button type="primary" htmlType="submit" loading={busy}>{t("platform.save")}</Button>{editing && editing !== "new" && (manage || (!editing.isDefault && !editing.enforced)) ? <Button danger onClick={() => modal.confirm({ title: t("platform.deleteBrandConfirm", { name: editing.name }), content: t("platform.deleteBrandDescription"), onOk: async () => { await deleteBrand(workspaceId, editing.id); setEditing(null); await refresh(); navigate("/brand"); } })}>{t("platform.remove")}</Button> : null}</div></Form></Modal>
        <Modal title={t("platform.brandUpload")} open={Boolean(uploadKind)} onCancel={() => !busy && setUploadKind(null)} onOk={() => void upload()} confirmLoading={busy} okButtonProps={{ disabled: !files.length }} destroyOnHidden><Select aria-label={t("platform.brandAssetType")} className="mb-4 w-full" value={uploadKind} disabled={busy} onChange={setUploadKind} options={["logo", "sku", "style_ref"].map((value) => ({ value, label: t(`platform.brandAssetKinds.${value}`) }))} /><Upload.Dragger multiple accept="image/png,image/jpeg,image/webp" disabled={busy} fileList={files.map((file, index) => ({ uid: String(index), name: file.name, status: "done" }))} beforeUpload={(file) => { setFiles((files) => [...files, file]); return false; }} onRemove={(file) => { setFiles((files) => files.filter((_, index) => String(index) !== file.uid)); }}><UploadIcon size={28} className="mx-auto mb-3" /><p>{t("platform.brandUploadPrompt")}</p><p className="platform-muted mt-2 text-xs">{t("platform.brandUploadLimit")}</p></Upload.Dragger></Modal>
    </main>;
}

function BrandJobs({ brandId }: { brandId: string }) {
    const { t, i18n } = useTranslation();
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId)!;
    const generation = useSessionStore((state) => state.generation);
    const query = useInfiniteQuery({ queryKey: ["platform", "brand-jobs", generation, workspaceId, brandId], initialPageParam: undefined as string | undefined, queryFn: ({ signal, pageParam }) => fetchJobs(workspaceId, { brandId, cursor: pageParam }, signal), getNextPageParam: (page) => page.nextCursor || undefined });
    return <section className="platform-card">{query.error ? <Alert type="error" title={query.error.message} action={<Button onClick={() => void query.refetch()}>{t("platform.retry")}</Button>} /> : <Table rowKey="id" loading={query.isPending} pagination={false} scroll={{ x: 560 }} dataSource={query.data?.pages.flatMap((page) => page.items)} columns={[{ title: t("platform.time"), dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString(i18n.language) }, { title: t("platform.model"), dataIndex: "modelId" }, { title: t("platform.status"), dataIndex: "status", render: (value: string) => t(`platform.jobStatuses.${value}`) }, { title: t("platform.credits"), dataIndex: "chargedCredits" }]} />}{query.hasNextPage ? <Button className="mt-4" onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>{t("platform.loadMore")}</Button> : null}</section>;
}
