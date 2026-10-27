import type { TemplateStep } from "../../../../shared/template";

export type TemplateImageValue = {
    content: string;
    storageKey: string;
    naturalWidth: number;
    naturalHeight: number;
    mimeType: string;
    bytes: number;
};
export type TemplateValues = Record<string, string | TemplateImageValue>;

/** Local canvas state. Step nodeIds are template-local; completedNodeIds are actual canvas IDs. */
export type TemplateRun = {
    templateId: string;
    templateName: string;
    steps: TemplateStep[];
    idMap: Record<string, string>;
    stepIndex: number;
    status: "idle" | "running" | "failed" | "stopped" | "completed";
    completedNodeIds: string[];
    error?: string;
};

export type TemplateVariableBinding = {
    nodeId: string;
    key: string;
    label: string;
    required?: boolean;
    placeholder?: string;
    allowBrandSku?: boolean;
};
