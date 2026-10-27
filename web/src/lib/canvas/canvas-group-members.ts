import type { CanvasNodeData } from "@/types/canvas";

/** Includes the selected IDs, followed by every nested group member. */
export function collectGroupDescendantIds(selected: Set<string>, nodes: CanvasNodeData[]) {
    const children = new Map<string, string[]>();
    for (const node of nodes) if (node.metadata?.groupId) children.set(node.metadata.groupId, [...children.get(node.metadata.groupId) || [], node.id]);
    const result = new Set(selected);
    const queue = [...selected];
    for (let index = 0; index < queue.length; index++) for (const id of children.get(queue[index]) || []) if (!result.has(id)) { result.add(id); queue.push(id); }
    return result;
}
