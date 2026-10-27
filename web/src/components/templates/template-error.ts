import i18n from "@/i18n";
import { TemplateError } from "@/lib/templates/errors";

export function templateErrorMessage(error: unknown) {
    return error instanceof TemplateError ? i18n.t(`platform.templateErrors.${error.code}`, { detail: error.detail }) : error instanceof Error ? error.message : i18n.t("platform.requestFailed");
}
