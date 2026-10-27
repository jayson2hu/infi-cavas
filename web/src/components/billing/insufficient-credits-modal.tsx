import { Button, Modal } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useCreditsStore } from "@/stores/use-credits-store";

export function InsufficientCreditsModal() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const error = useCreditsStore((state) => state.error);
    const clearError = useCreditsStore((state) => state.clearError);
    return <Modal title={t(error?.code === "member_cap_exceeded" ? "platform.creditsLimitTitle" : "platform.insufficientCredits")} open={Boolean(error)} onCancel={clearError} footer={<><Button onClick={clearError}>{t("platform.understood")}</Button>{error?.code !== "member_cap_exceeded" ? <Button type="primary" onClick={() => { clearError(); navigate("/billing"); }}>{t("platform.goToBilling")}</Button> : null}</>}><p>{error?.message}</p></Modal>;
}
