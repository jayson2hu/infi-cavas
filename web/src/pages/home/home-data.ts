import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { TemplateSummary } from "@/services/api/platform/templates";

export const popularTemplates = (templates: TemplateSummary[]) => [...templates].sort((a, b) => b.useCount - a.useCount || a.id.localeCompare(b.id)).slice(0, 4);
export const recentProjects = (projects: CanvasProject[]) => [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);

export function firstProjectImage(project: Pick<CanvasProject, "nodes">) {
    for (const node of project.nodes) {
        if (node.type !== "image") continue;
        const metadata = node.metadata;
        if (metadata?.storageKey || metadata?.content) return { storageKey: metadata.storageKey, content: metadata.content || "" };
        const image = metadata?.images?.find((item) => item.storageKey || item.content);
        if (image) return { storageKey: image.storageKey, content: image.content };
    }
    return null;
}
