import { isByokAllowed } from "@/lib/platform";
import { useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Empty, Form, Input, InputNumber, Modal, Progress, Skeleton, Table, Tag } from "antd";
import { Download, Gift } from "lucide-react";
import { saveAs } from "file-saver";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { fetchBillingSummary, fetchCreditPackages, fetchDailyUsage, fetchJobs, fetchMemberUsage, fetchTransactions, redeemCredits } from "@/services/api/platform/billing";
import { fetchPlatformModels } from "@/services/api/platform/models";
import { updateMember } from "@/services/api/platform/workspaces";
import type { UsageMember, CreditTransaction, GenerationJob } from "@/services/api/platform/types";
import { formatPriceHint } from "@/lib/platform-pricing";
import { toCsv } from "@/lib/csv";
import { useSessionStore } from "@/stores/use-session-store";
import { useCreditsStore } from "@/stores/use-credits-store";
import { PlanUpgradeCard } from "./plan-upgrade";
import "./billing.css";

export default function BillingPage() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const workspaceId = useSessionStore((state) => state.currentWorkspaceId)!;
    const userId = useSessionStore((state) => state.user?.id);
    const role = useSessionStore((state) => state.workspaces.find((workspace) => workspace.id === state.currentWorkspaceId)?.role);
    const liveBalance = useCreditsStore((state) => state.balances[workspaceId]);
    const manage = role === "owner" || role === "admin";
    const summary = useQuery({ queryKey: ["platform", "summary", userId, workspaceId], queryFn: ({ signal }) => fetchBillingSummary(workspaceId, signal) });
    const daily = useQuery({ queryKey: ["platform", "daily", userId, workspaceId], queryFn: ({ signal }) => fetchDailyUsage(workspaceId, signal) });
    const members = useQuery({ queryKey: ["platform", "usage-members", userId, workspaceId], queryFn: ({ signal }) => fetchMemberUsage(workspaceId, signal), enabled: manage });
    const models = useQuery({ queryKey: ["platform", "models", userId, workspaceId], queryFn: ({ signal }) => fetchPlatformModels(workspaceId, signal) });
    const packages = useQuery({ queryKey: ["platform", "packages", userId, workspaceId], queryFn: ({ signal }) => fetchCreditPackages(workspaceId, signal), enabled: summary.data?.billingEnabled === true });
    const jobs = useInfiniteQuery({ queryKey: ["platform", "jobs", userId, workspaceId], initialPageParam: undefined as string | undefined, queryFn: ({ pageParam, signal }) => fetchJobs(workspaceId, { cursor: pageParam }, signal), getNextPageParam: (page) => page.nextCursor || undefined });
    const transactions = useInfiniteQuery({ queryKey: ["platform", "transactions", userId, workspaceId], initialPageParam: undefined as string | undefined, queryFn: ({ pageParam, signal }) => fetchTransactions(workspaceId, pageParam, signal), getNextPageParam: (page) => page.nextCursor || undefined, enabled: manage });
    const [redeemOpen, setRedeemOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [editingMember, setEditingMember] = useState<UsageMember | null>(null);
    const [cap, setCap] = useState<number | null>(null);
    const [form] = Form.useForm();
    const number = (value: number) => value.toLocaleString(i18n.language);
    const stats = summary.data;
    const balance = liveBalance ?? stats?.balance;
    const redeem = async ({ code }: { code: string }) => {
        setBusy(true);
        const generation = useSessionStore.getState().generation;
        try { const result = await redeemCredits(workspaceId, code.trim()); useCreditsStore.getState().setBalance(workspaceId, result.balance, generation); await queryClient.invalidateQueries({ queryKey: ["platform"] }); setRedeemOpen(false); form.resetFields(); message.success(t("platform.redeemSuccess", { count: result.credits })); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    const saveCap = async () => {
        if (!editingMember) return;
        setBusy(true);
        try { await updateMember(workspaceId, editingMember.userId, { monthlyCap: cap }); await members.refetch(); setEditingMember(null); message.success(t("platform.saved")); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    const exportBill = async () => {
        setExporting(true);
        try {
            const rows: CreditTransaction[] = [];
            let cursor: string | undefined;
            do { const page = await fetchTransactions(workspaceId, cursor); rows.push(...page.items); cursor = page.nextCursor || undefined; } while (cursor);
            saveAs(new Blob([toCsv([[t("platform.time"), t("platform.transactionType"), t("platform.credits"), t("platform.jobId"), t("platform.note")], ...rows.map((row) => [row.createdAt, t(`platform.transactions.${row.type}`), row.amount, row.jobId, row.note])])], { type: "text/csv;charset=utf-8" }), `billing-${workspaceId}.csv`);
        } catch (error) { message.error((error as Error).message); }
        finally { setExporting(false); }
    };
    const errorBlock = (error: Error | null, retry: () => unknown) => error ? <Alert type="error" showIcon title={error.message} action={<Button onClick={() => void retry()}>{t("platform.retry")}</Button>} /> : null;
    const maxDay = Math.max(1, ...(daily.data || []).map((day) => day.image + day.video + day.text + day.audio));
    return <main className="platform-page">
        <header className="platform-page-heading"><div><h1>{t(stats?.billingEnabled === false ? "platform.usageTitle" : "platform.billingTitle")}</h1><p>{stats ? t("platform.planDescription", { plan: t(`platform.plans.${stats.plan}`), credits: number(stats.planMonthlyCredits), date: new Date(stats.periodEnd).toLocaleDateString(i18n.language) }) : t("platform.billingDescription")}</p></div><div className="flex flex-wrap gap-2">{manage ? <Button icon={<Download size={16} />} loading={exporting} onClick={() => void exportBill()}>{t("platform.exportBill")}</Button> : null}{stats?.billingEnabled && role === "owner" ? <Button type="primary" icon={<Gift size={16} />} onClick={() => setRedeemOpen(true)}>{t("platform.redeemCode")}</Button> : null}</div></header>
        {summary.isPending ? <Skeleton active paragraph={{ rows: 4 }} /> : errorBlock(summary.error, summary.refetch)}
        {stats ? <section className="platform-stat-grid platform-stat-grid-four">
            <div className="platform-card"><p className="platform-muted">{t("platform.balance")}</p><strong className="platform-stat">{number(balance ?? stats.balance)}</strong><span className="platform-muted"> {t("platform.credits")}</span>{stats.planMonthlyCredits > 0 ? <Progress percent={Math.min(100, Math.round((balance ?? stats.balance) / stats.planMonthlyCredits * 100))} showInfo={false} strokeColor="var(--workspace-text)" /> : null}<p className="platform-muted text-xs mt-3">{stats.projectedDepletionDate ? t("platform.projectedDepletion", { date: stats.projectedDepletionDate }) : t("platform.noDepletionEstimate")}</p></div>
            <div className="platform-card"><p className="platform-muted">{t("platform.monthCharged")}</p><strong className="platform-stat">{number(stats.monthCharged)}</strong><span className="platform-muted"> {t("platform.credits")}</span><p className="platform-muted text-xs mt-3">{stats.lastMonthSamePeriodCharged > 0 ? t("platform.monthComparison", { value: ((stats.monthCharged / stats.lastMonthSamePeriodCharged - 1) * 100).toFixed(1) }) : t("platform.noComparison")}</p></div>
            <div className="platform-card"><p className="platform-muted">{t("platform.generationCount")}</p><strong className="platform-stat">{number(Object.values(stats.monthJobs).reduce((a, b) => a + b, 0))}</strong><p className="platform-muted text-xs mt-3">{Object.entries(stats.monthJobs).map(([kind, value]) => `${t(`platform.capabilities.${kind}`)} ${value}`).join(" · ")}</p></div>
            <div className="platform-card"><p className="platform-muted">{t("platform.monthRefunded")}</p><strong className="platform-stat">{number(stats.monthRefunded)}</strong><span className="platform-muted"> {t("platform.credits")}</span><p className="platform-muted text-xs mt-3">{t("platform.successRate", { rate: stats.successRate.toFixed(1), count: stats.monthFailedJobs })}</p></div>
        </section> : null}
        <div className="platform-billing-grid mt-5"><div className="space-y-5 min-w-0">
            <section className="platform-card"><h2>{t("platform.dailyUsage")}</h2>{daily.isPending ? <Skeleton active /> : errorBlock(daily.error, daily.refetch) || (!daily.data?.length ? <Empty description={t("platform.noUsage")} /> : <><div className="platform-usage-chart" role="img" aria-label={t("platform.dailyUsage")}>{daily.data.map((day) => <div className="platform-usage-column" key={day.date} title={`${day.date}: ${t("platform.creditAmount", { count: day.image + day.video + day.text + day.audio })}`}><div className="platform-usage-bars">{(["audio", "text", "video", "image"] as const).map((kind) => <span key={kind} style={{ height: `${day[kind] / maxDay * 100}%`, background: `var(--workspace-chart-${kind})` }} />)}</div><small>{day.date.slice(5)}</small></div>)}</div><div className="platform-chart-legend">{["image", "video", "text", "audio"].map((kind) => <span key={kind}><i style={{ background: `var(--workspace-chart-${kind})` }} />{t(`platform.capabilities.${kind}`)}</span>)}</div></>)}</section>
            {manage ? <section className="platform-card"><h2 className="mb-4">{t("platform.memberUsage")}</h2>{errorBlock(members.error, members.refetch) || <Table<UsageMember> size="small" rowKey="userId" loading={members.isPending} dataSource={members.data} pagination={false} scroll={{ x: 480 }} columns={[{ title: t("platform.member"), dataIndex: "name" }, { title: t("platform.monthCharged"), dataIndex: "monthCharged", render: (value: number, member) => <div className="min-w-24">{number(value)}<Progress size="small" showInfo={false} percent={member.monthlyCap ? Math.min(100, value / member.monthlyCap * 100) : 0} strokeColor={member.monthlyCap && value / member.monthlyCap >= .9 ? "var(--workspace-warning)" : "var(--workspace-text)"} /></div> }, { title: t("platform.monthlyCap"), key: "cap", render: (_, member) => member.role === "owner" ? t("platform.unlimited") : <Button type="text" size="small" onClick={() => { setEditingMember(member); setCap(member.monthlyCap); }}>{member.monthlyCap === null || member.role !== "member" ? t("platform.unlimited") : number(member.monthlyCap)}</Button> }]} />}</section> : null}
            <section className="platform-card"><h2 className="mb-4">{t("platform.generationJobs")}</h2>{errorBlock(jobs.error, jobs.refetch) || <Table<GenerationJob> size="small" rowKey="id" loading={jobs.isPending} dataSource={jobs.data?.pages.flatMap((page) => page.items)} pagination={false} scroll={{ x: 600 }} columns={[{ title: t("platform.time"), dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString(i18n.language) }, { title: t("platform.model"), dataIndex: "modelId" }, { title: t("platform.status"), dataIndex: "status", render: (status: string, job) => <Tag title={job.error || undefined} color={status === "succeeded" ? "success" : status === "held" ? "processing" : "error"}>{t(`platform.jobStatuses.${status}`)}</Tag> }, { title: t("platform.credits"), dataIndex: "chargedCredits", render: (value: number, job) => job.status === "held" ? t("platform.frozenCredits", { count: job.estimateCredits }) : number(value) }]} />}{jobs.hasNextPage ? <Button className="mt-4" loading={jobs.isFetchingNextPage} onClick={() => void jobs.fetchNextPage()}>{t("platform.loadMore")}</Button> : null}</section>
            {manage ? <section className="platform-card"><h2 className="mb-4">{t("platform.ledgerTitle")}</h2>{errorBlock(transactions.error, transactions.refetch) || <Table<CreditTransaction> size="small" rowKey="id" loading={transactions.isPending} dataSource={transactions.data?.pages.flatMap((page) => page.items)} pagination={false} scroll={{ x: 640 }} columns={[{ title: t("platform.time"), dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString(i18n.language) }, { title: t("platform.transactionType"), dataIndex: "type", render: (type: string) => t(`platform.transactions.${type}`) }, { title: t("platform.credits"), dataIndex: "amount" }, { title: t("platform.jobId"), dataIndex: "jobId", ellipsis: true }, { title: t("platform.note"), dataIndex: "note", ellipsis: true }]} />}{transactions.hasNextPage ? <Button className="mt-4" loading={transactions.isFetchingNextPage} onClick={() => void transactions.fetchNextPage()}>{t("platform.loadMore")}</Button> : null}</section> : null}
        </div><aside className="space-y-5 min-w-0">
            {stats?.billingEnabled ? <PlanUpgradeCard workspaceId={workspaceId} userId={userId} manage={manage} /> : null}
            {stats?.billingEnabled ? <section className="platform-card"><h2>{t("platform.topupTitle")}</h2><p className="platform-muted text-sm mt-3">{t("platform.topupDescription")}</p>{errorBlock(packages.error, packages.refetch)}{packages.data?.map((item) => <div key={item.id} className="platform-package"><strong>{item.name}</strong><span>{t("platform.creditAmount", { count: item.credits + item.bonusCredits })}</span><small>{new Intl.NumberFormat(i18n.language, { style: "currency", currency: "CNY" }).format(item.priceCents / 100)}</small></div>)}{role === "owner" ? <Button className="mt-4" block onClick={() => setRedeemOpen(true)}>{t("platform.redeemCode")}</Button> : <p className="platform-muted text-xs mt-4">{t("platform.ownerRedeemOnly")}</p>}</section> : null}
            <section className="platform-card"><h2>{t("platform.modelPricing")}</h2>{models.isPending ? <Skeleton active /> : errorBlock(models.error, models.refetch) || (models.data?.length ? models.data.map((model) => <div className="platform-price-row" key={model.id}><strong>{model.id}</strong><span>{formatPriceHint(model.price_hint)}</span></div>) : <p className="platform-muted text-sm mt-3">{t("platform.noPlatformModels")}</p>)}</section>
            {isByokAllowed() ? <section className="platform-card"><h2>{t("platform.byokTitle")}</h2><p className="platform-muted text-sm mt-3">{t("platform.byokDescription")}</p><Link className="platform-text-button inline-block mt-4" to="/config">{t("platform.configureByok")}</Link></section> : null}
        </aside></div>
        <Modal title={t("platform.redeemCode")} open={redeemOpen} onCancel={() => setRedeemOpen(false)} footer={null} destroyOnHidden><Form form={form} layout="vertical" onFinish={redeem} disabled={busy}><Form.Item name="code" label={t("platform.redeemCode")} rules={[{ required: true, whitespace: true, message: t("platform.redeemRequired") }]}><Input autoComplete="off" /></Form.Item><Button htmlType="submit" type="primary" loading={busy}>{t("platform.redeem")}</Button></Form></Modal>
        <Modal title={t("platform.monthlyCap")} open={Boolean(editingMember)} onCancel={() => setEditingMember(null)} onOk={() => void saveCap()} confirmLoading={busy}><p className="platform-muted mb-4">{editingMember?.name} · {t("platform.capHint")}</p><InputNumber aria-label={t("platform.monthlyCap")} min={0} max={2147483647} precision={0} value={cap} onChange={setCap} placeholder={t("platform.unlimited")} className="w-full" /></Modal>
    </main>;
}
