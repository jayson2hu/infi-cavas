import { db } from "../db/client";
import { generationOutputs } from "../db/schema";
import { id } from "../lib/ids";
import { putObject } from "../lib/s3";

type Output = { kind: "image" | "video" | "audio" | "text"; bytes: Uint8Array; mimeType: string };
const pending = new Set<Promise<unknown>>();
export function trackArchive<T>(jobId: string, task: Promise<T>) {
  pending.add(task);
  void task.catch(() => { console.error(JSON.stringify({ event: "archive_failed", jobId })); }).finally(() => pending.delete(task));
  return task;
}
export function enqueueArchive(job: { id: string; workspaceId: string }, outputs: Output[]) {
  const task = Promise.all(outputs.map(async (output, index) => {
    const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "text/plain": "txt" } as Record<string, string>)[output.mimeType] ?? "bin";
    const objectKey = `ws/${job.workspaceId}/outputs/${job.id}/${index}.${extension}`;
    await putObject(objectKey, output.bytes, output.mimeType);
    await db.insert(generationOutputs).values({ id: id("out"), jobId: job.id, kind: output.kind, objectKey, mimeType: output.mimeType, bytes: output.bytes.length });
    return objectKey;
  }));
  return trackArchive(job.id, task);
}
export const drainArchives = () => Promise.allSettled([...pending]);
