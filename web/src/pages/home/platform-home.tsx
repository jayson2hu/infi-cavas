import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Empty, Skeleton, Tag } from "antd";
import { ArrowRight, Image, Layers3, Plus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { fetchTemplates } from "@/services/api/platform/templates";
import { fetchJobs } from "@/services/api/platform/billing";
import { ensureImagePreview, getImagePreviewRevision, previewUrlFor, resolveImageUrl, subscribeImagePreviews } from "@/services/image-storage";
import { useSessionStore } from "@/stores/use-session-store";
import { useBrandStore } from "@/stores/use-brand-store";
import { useCreditsStore } from "@/stores/use-credits-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { firstProjectImage, popularTemplates, recentProjects } from "./home-data";
import "./platform-home.css";

const subscribeVisibility = (listener: () => void) => { document.addEventListener("visibilitychange", listener); return () => document.removeEventListener("visibilitychange", listener); };
const isVisible = () => document.visibilityState === "visible";

function ProjectPreview({ project }: { project: CanvasProject }) {
    const { t, i18n } = useTranslation();
    const first = firstProjectImage(project);
    const storageKey = first?.storageKey;
    const content = first?.content || "";
    const [source, setSource] = useState("");
    const [failed, setFailed] = useState(false);
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const preview = previewUrlFor(storageKey) || source;
    useEffect(() => {
        let active = true;
        setSource(""); setFailed(false);
        // Persisted blob URLs are invalid after reload; IndexedDB supplies a fresh one.
        const fallback = content.startsWith("blob:") ? "" : content;
        void ensureImagePreview(storageKey).catch(() => undefined);
        void resolveImageUrl(storageKey, fallback).then((url) => { if (active) setSource(url); }).catch(() => undefined);
        return () => { active = false; };
    }, [content, storageKey]);
    return <Link className="home-project" data-project-id={project.id} to={`/canvas/${project.id}`}>
        <div className="home-project-preview">{preview && !failed ? <img src={preview} alt="" loading="lazy" onError={() => setFailed(true)} /> : <div className="home-project-placeholder"><Image size={25} strokeWidth={1.25} /><span>{t("platform.homeNoPreview")}</span></div>}</div>
        <div className="home-project-info"><strong>{project.title}</strong><time dateTime={project.updatedAt}>{new Date(project.updatedAt).toLocaleDateString(i18n.language, { month: "short", day: "numeric" })}</time></div>
    </Link>;
}

export default function PlatformHomePage() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId)!;
    const generation = useSessionStore((state) => state.generation);
    const billingEnabled = useCreditsStore((state) => state.billingEnabled[workspaceId]);
    const brand = useBrandStore((state) => state.workspaceId === workspaceId && state.generation === generation ? state.brand : null);
    const brandReady = useBrandStore((state) => state.workspaceId === workspaceId && state.generation === generation && state.ready);
    const brandError = useBrandStore((state) => state.workspaceId === workspaceId && state.generation === generation ? state.error : null);
    const loadBrand = useBrandStore((state) => state.load);
    const projects = useCanvasStore((state) => state.projects);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const visible = useSyncExternalStore(subscribeVisibility, isVisible);
    const templates = useQuery({ queryKey: ["platform", "templates", generation, workspaceId, "all", ""], queryFn: ({ signal }) => fetchTemplates(workspaceId, { scope: "all" }, signal) });
    const jobs = useQuery({ queryKey: ["platform", "homeJobs", generation, workspaceId], queryFn: ({ signal }) => fetchJobs(workspaceId, {}, signal), enabled: visible, refetchInterval: visible ? 5000 : false, refetchIntervalInBackground: false });
    const recommended = useMemo(() => popularTemplates(templates.data || []), [templates.data]);
    const recent = useMemo(() => recentProjects(projects), [projects]);
    const latestJobs = useMemo(() => [...(jobs.data?.items || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4), [jobs.data]);
    return <div className="platform-page platform-home">
        <header className="platform-page-heading"><div><h1>{t("platform.homeHeading")}</h1><p>{t("platform.homeDescription")}</p></div></header>
        <div className="home-columns"><main className="home-main">
            <section aria-labelledby="home-templates-title"><div className="home-section-heading"><h2 id="home-templates-title">{t("platform.homeTemplates")}</h2><Link to="/templates">{t("platform.homeViewAll")}<ArrowRight size={14} /></Link></div>
                {templates.error ? <Alert type="error" title={templates.error.message} action={<Button onClick={() => void templates.refetch()}>{t("platform.retry")}</Button>} /> : templates.isPending ? <Skeleton active /> : !recommended.length ? <div className="platform-card"><Empty description={t("platform.noTemplates")} /></div> : <div className="home-template-grid">{recommended.map((template) => <Link key={template.id} data-template-id={template.id} className="home-template" to={`/templates?id=${encodeURIComponent(template.id)}`}>
                    <div className="home-template-visual">{template.coverUrl ? <img src={template.coverUrl} alt="" loading="lazy" /> : <Layers3 size={30} strokeWidth={1.2} />}<span className="home-category">{t(`platform.templateCategories.${template.category}`)}</span></div>
                    <div className="home-template-body"><h3>{template.name}</h3><p>{template.description}</p><div className="home-template-flow">{template.previewNodes.slice(0, 3).map((title, index) => <span key={`${index}:${title}`}>{index ? <ArrowRight size={10} /> : null}<span>{title}</span></span>)}</div><footer><span>{billingEnabled === false ? t("platform.templatePlatformFree") : t("platform.homeTemplateCost", { count: template.estimateCredits })}</span><ArrowRight size={15} /></footer></div>
                </Link>)}</div>}
            </section>
            <section aria-labelledby="home-projects-title"><div className="home-section-heading"><h2 id="home-projects-title">{t("platform.homeRecentCanvases")}</h2><Link to="/canvas">{t("platform.homeViewAll")}<ArrowRight size={14} /></Link></div><div className="home-local-note"><span>{t("platform.templateCategories.all")}</span><small>{t("platform.homeLocalCanvases")}</small></div>
                {!hydrated ? <Skeleton active /> : recent.length ? <div className="home-project-grid">{recent.map((project) => <ProjectPreview key={project.id} project={project} />)}</div> : <div className="platform-card home-empty"><Empty description={t("platform.homeNoCanvases")} /><Button type="primary" icon={<Plus size={15} />} onClick={() => navigate(`/canvas/${createProject()}`)}>{t("platform.newCanvas")}</Button></div>}
            </section>
        </main><aside className="home-side">
            <section className="platform-card home-brand" aria-labelledby="home-brand-title"><div className="home-section-heading"><h2 id="home-brand-title">{t("platform.currentBrand")}</h2><Link to="/brand">{t("platform.manageBrands")}</Link></div>
                {brandError ? <Alert type="error" title={brandError} action={<Button onClick={() => void loadBrand(workspaceId, generation)}>{t("platform.retry")}</Button>} /> : !brandReady ? <Skeleton active /> : brand ? <><div className="home-brand-identity"><span className="home-brand-logo">{brand.logoUrl ? <img src={brand.logoUrl} alt="" /> : brand.name.slice(0, 1)}</span><div><Link to={`/brand/${brand.id}`}><strong>{brand.name}</strong></Link><p>{t("platform.skuCount", { count: brand.skuCount })}</p></div></div>{brand.colors.length ? <div className="home-brand-colors">{brand.colors.map((color, index) => <span key={color.id || index} style={{ background: color.hex }} title={`${color.name} ${color.hex}`} aria-label={`${color.name} ${color.hex}`} />)}</div> : <p className="home-muted">{t("platform.homeNoColors")}</p>}<div className="home-brand-rules"><strong>{t("platform.homeBrandRules")}</strong><p>{brand.enforced ? t("platform.brandEnforced") : t("platform.templateUsingBrand")}</p>{brand.requiredTerms.length ? <p>{t("platform.homeRequiredTerms", { terms: brand.requiredTerms.join("、") })}</p> : null}{brand.avoidTerms.length ? <p>{t("platform.homeAvoidTerms", { terms: brand.avoidTerms.join("、") })}</p> : null}{!brand.requiredTerms.length && !brand.avoidTerms.length ? <p>{t("platform.homeNoTerms")}</p> : null}</div></> : <div className="home-brand-empty"><Layers3 size={28} strokeWidth={1.3} /><p>{t("platform.homeBrandEmpty")}</p><Link to="/brand">{t("platform.createBrand")}<ArrowRight size={14} /></Link></div>}
            </section>
            <section className="platform-card home-jobs" aria-labelledby="home-jobs-title"><div className="home-section-heading"><h2 id="home-jobs-title">{t("platform.homeRecentJobs")}</h2><Link to="/billing">{t("platform.homeViewAll")}</Link></div>
                {jobs.error ? <Alert type="error" title={jobs.error.message} action={<Button onClick={() => void jobs.refetch()}>{t("platform.retry")}</Button>} /> : jobs.isPending ? <Skeleton active /> : !latestJobs.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("platform.homeNoJobs")} /> : <div className="home-job-list">{latestJobs.map((job) => <div key={job.id} data-job-id={job.id} className="home-job"><div className="home-job-heading"><strong title={job.modelId}>{job.modelId}</strong><Tag color={job.status === "succeeded" ? "green" : job.status === "held" ? "processing" : "red"}>{t(`platform.homeJobStatuses.${job.status}`)}</Tag></div>{job.prompt ? <p title={job.prompt}>{job.prompt}</p> : null}<div className="home-job-meta"><time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString(i18n.language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time><span>{t(job.status === "held" ? "platform.templateStepEstimate" : "platform.creditAmount", { count: job.status === "held" ? job.estimateCredits : job.chargedCredits })}</span></div>{job.projectId && projects.some((project) => project.id === job.projectId) ? <Link to={`/canvas/${job.projectId}`}>{t("platform.homeOpenCanvas")}<ArrowRight size={12} /></Link> : null}</div>)}</div>}
            </section>
        </aside></div>
    </div>;
}
