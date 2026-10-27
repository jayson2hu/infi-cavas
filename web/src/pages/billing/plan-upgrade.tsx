import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Form, Input, Modal, Skeleton, Tag } from "antd";
import { useTranslation } from "react-i18next";
import { fetchPlans, requestPlan, type PlanOption } from "@/services/api/platform/billing";

// 套餐升级（I-041）：一期由用户提交申请、平台管理员审核；二期接入支付后在此直接下单。
export function PlanUpgradeCard({ workspaceId, userId, manage }: { workspaceId: string; userId?: string; manage: boolean }) {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const plans = useQuery({ queryKey: ["platform", "plans", userId, workspaceId], queryFn: ({ signal }) => fetchPlans(workspaceId, signal) });
    const [target, setTarget] = useState<PlanOption | null>(null);
    const [busy, setBusy] = useState(false);
    const [form] = Form.useForm<{ note?: string }>();
    const data = plans.data;
    const planName = (id: string) => data?.plans.find((plan) => plan.id === id)?.name ?? t(`platform.plans.${id}`);
    const latest = data?.latestRequest;
    const pending = latest?.status === "pending";
    const submit = async ({ note }: { note?: string }) => {
        if (!target) return;
        setBusy(true);
        try { await requestPlan(workspaceId, { planId: target.id, note: note?.trim() || undefined }); await queryClient.invalidateQueries({ queryKey: ["platform", "plans"] }); setTarget(null); form.resetFields(); message.success(t("platform.upgrade.submitted")); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    return <section className="platform-card" data-plan-upgrade>
        <h2>{t("platform.upgrade.title")}</h2>
        <p className="platform-muted text-sm mt-3">{t("platform.upgrade.description")}</p>
        {plans.isPending ? <Skeleton active /> : plans.error ? <Alert className="mt-3" type="error" showIcon title={plans.error.message} action={<Button onClick={() => void plans.refetch()}>{t("platform.retry")}</Button>} /> : null}
        {latest && latest.status !== "approved" ? <Alert className="mt-3" showIcon type={pending ? "info" : "warning"} title={pending ? t("platform.upgrade.pending", { plan: planName(latest.planId), date: new Date(latest.createdAt).toLocaleDateString(i18n.language) }) : t("platform.upgrade.rejected", { plan: planName(latest.planId), reason: latest.reviewNote ?? "" })} /> : null}
        {data?.plans.map((plan) => {
            const current = plan.id === data.currentPlan;
            return <div key={plan.id} className="platform-package platform-plan-option" data-plan-id={plan.id}>
                <div className="flex items-center justify-between gap-2"><strong>{plan.name}</strong>{current ? <Tag color="success">{t("platform.upgrade.current")}</Tag> : null}</div>
                <span>{t("platform.upgrade.monthly", { credits: plan.monthlyCredits.toLocaleString(i18n.language) })}</span>
                {plan.priceText ? <small>{plan.priceText}</small> : null}
                {plan.description ? <small>{plan.description}</small> : null}
                {!current && manage ? <Button className="mt-1 self-start" size="small" disabled={pending} onClick={() => { form.resetFields(); setTarget(plan); }}>{t("platform.upgrade.apply")}</Button> : null}
            </div>;
        })}
        {data && !manage ? <p className="platform-muted text-xs mt-4">{t("platform.upgrade.managerOnly")}</p> : null}
        <Modal title={target ? `${t("platform.upgrade.apply")} · ${target.name}` : ""} open={Boolean(target)} onCancel={() => setTarget(null)} footer={null} destroyOnHidden>
            {target ? <p className="platform-muted mb-4">{t("platform.upgrade.monthly", { credits: target.monthlyCredits.toLocaleString(i18n.language) })}{target.priceText ? ` · ${target.priceText}` : ""}</p> : null}
            <Form form={form} layout="vertical" onFinish={submit} disabled={busy}>
                <Form.Item name="note" label={t("platform.upgrade.noteLabel")}><Input.TextArea rows={3} maxLength={500} showCount placeholder={t("platform.upgrade.notePlaceholder")} /></Form.Item>
                <Button type="primary" htmlType="submit" loading={busy}>{t("platform.upgrade.submit")}</Button>
            </Form>
        </Modal>
    </section>;
}
