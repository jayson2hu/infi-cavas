export type TemplateErrorCode = "invalid" | "required" | "option" | "imageMissing" | "idCollision" | "externalReference" | "emptySelection" | "noSteps" | "unsupportedVariable" | "imageUploadMissing" | "cyclic";

export class TemplateError extends Error {
    constructor(public code: TemplateErrorCode, public detail = "") {
        super(detail || code);
        this.name = "TemplateError";
    }
}
