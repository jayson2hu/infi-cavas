import { expect, test } from "bun:test";
import { collectGroupDescendantIds } from "../src/lib/canvas/canvas-group-members";
import { applyUngroupSelection, collectGroupMemberNodes } from "../src/lib/canvas/canvas-node-geometry";
import type { CanvasNodeData } from "../src/types/canvas";

const node = (id: string, type: string, groupId?: string): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { groupId } });

test("nested template groups include every descendant without unrelated nodes", () => {
    const nodes = [node("outer", "group"), node("inner", "group", "outer"), node("image", "image", "inner"), node("text", "text", "outer"), node("other", "image")];
    expect([...collectGroupDescendantIds(new Set(["outer"]), nodes)]).toEqual(["outer", "inner", "text", "image"]);
    expect(collectGroupMemberNodes(new Set(["outer"]), nodes).map((node) => node.id)).toEqual(["image", "text"]);
});

test("ungrouping an outer group preserves the populated inner group", () => {
    const nodes = [node("outer", "group"), node("inner", "group", "outer"), node("image", "image", "inner")];
    const result = applyUngroupSelection(new Set(["outer"]), nodes, []);
    expect(result?.nodes.map((node) => node.id)).toEqual(["inner", "image"]);
    expect(result?.nodes[0].metadata?.groupId).toBeUndefined();
    expect(result?.nodes[1].metadata?.groupId).toBe("inner");
});

test("damaged cyclic local groups cannot loop descendant collection forever", () => {
    const nodes = [node("a", "group", "b"), node("b", "group", "a"), node("image", "image", "b")];
    expect([...collectGroupDescendantIds(new Set(["a"]), nodes)]).toEqual(["a", "b", "image"]);
});
