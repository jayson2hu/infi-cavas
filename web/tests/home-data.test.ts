import { expect, test } from "bun:test";
import { firstProjectImage, popularTemplates, recentProjects } from "../src/pages/home/home-data";
import type { TemplateSummary } from "../src/services/api/platform/templates";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "../src/types/canvas";

test("home recommends the top four actual use counts without changing query data", () => {
    const templates = [4, 20, 2, 7, 15, 1].map((useCount, index) => ({ id: String(index), useCount }) as TemplateSummary);
    expect(popularTemplates(templates).map((item) => item.useCount)).toEqual([20, 15, 7, 4]);
    expect(templates.map((item) => item.useCount)).toEqual([4, 20, 2, 7, 15, 1]);
    expect(popularTemplates([])).toEqual([]);
});

test("home uses only six most recently changed local projects", () => {
    const projects = Array.from({ length: 8 }, (_, index) => ({ id: String(index), updatedAt: `2026-10-${String(index + 10).padStart(2, "0")}T00:00:00.000Z` }) as CanvasProject);
    expect(recentProjects(projects).map((item) => item.id)).toEqual(["7", "6", "5", "4", "3", "2"]);
    expect(projects[0].id).toBe("0");
});

test("home finds real image data including generated image arrays, and ignores text/video content", () => {
    const nodes = [
        { type: "text", metadata: { content: "not an image" } },
        { type: "video", metadata: { content: "https://example.test/video.mp4" } },
        { type: "image", metadata: {} },
        { type: "image", metadata: { images: [{ content: "blob:old", storageKey: "image:result" }] } },
        { type: "image", metadata: { content: "https://example.test/later.png" } },
    ] as CanvasNodeData[];
    expect(firstProjectImage({ nodes })).toEqual({ content: "blob:old", storageKey: "image:result" });
    expect(firstProjectImage({ nodes: nodes.slice(0, 3) })).toBeNull();
    expect(firstProjectImage({ nodes: [{ ...nodes[2], metadata: { content: "blob:old", storageKey: "image:first" } }, ...nodes] })).toEqual({ content: "blob:old", storageKey: "image:first" });
});
