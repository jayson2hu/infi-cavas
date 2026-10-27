import { App, Button } from "antd";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { TemplateLibrary } from "@/components/templates/template-library";

export default function TemplatesPage() {
    const { t } = useTranslation();
    const { modal } = App.useApp();
    const navigate = useNavigate();
    return <main className="platform-page"><header className="platform-page-heading"><div><h1>{t("platform.templateCenter")}</h1><p>{t("platform.templateDescription")}</p></div><Button icon={<Plus size={16} />} onClick={() => modal.info({ title: t("platform.templateSave"), content: t("platform.templateSaveGuide"), okText: t("platform.openCanvases"), onOk: () => navigate("/canvas") })}>{t("platform.templateSave")}</Button></header><TemplateLibrary /></main>;
}
