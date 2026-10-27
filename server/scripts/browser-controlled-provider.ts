/** Test-only provider: deterministic local media, request traces and explicit fault controls. */
import { createHash } from "node:crypto";

export type BrowserRequestContext = { nodeId?: string; projectId?: string; workspaceId?: string; source?: string };
type Trace = BrowserRequestContext & {
  sequence: number; endpoint: string; model: string; prompt: string; n: number; size?: string;
  inputHashes: string[]; outputHashes: string[]; status: "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  startedAt: number; finishedAt?: number;
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function createBrowserControlledProvider(images: string[], video: Uint8Array, audio: Uint8Array, context: () => BrowserRequestContext | undefined) {
  if (!images.length) throw new Error("受控供应商缺少本地PNG测试素材");
  const traces: Trace[] = [];
  const failNodes = new Set<string>();
  const holdNodes = new Set<string>();
  const waiting = new Map<number, () => void>();
  const videos = new Set<string>();
  let imageIndex = 0;
  let holdVideoPolls = false;

  async function forward(url: string | URL | Request, init?: RequestInit): Promise<Response> {
    const target = new URL(typeof url === "string" || url instanceof URL ? url : url.url);
    if (target.origin !== "https://browser-no-network.invalid") throw new Error("浏览器验收禁止访问真实供应商");
    const endpoint = target.pathname.replace(/^\/v1\//, "");
    const params: Record<string, unknown> = init?.body instanceof FormData
      ? Object.fromEntries([...init.body.entries()].filter(([, value]) => typeof value === "string"))
      : typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const inputHashes: string[] = [];
    if (init?.body instanceof FormData) {
      for (const [name, value] of init.body.entries()) {
        const file: unknown = value;
        if (["image", "image[]", "first_frame", "last_frame"].includes(name) && file instanceof File) inputHashes.push(hash(new Uint8Array(await file.arrayBuffer())));
      }
    }
    const trace: Trace = {
      ...context(), sequence: traces.length + 1, endpoint, model: String(params.model ?? ""),
      prompt: [params.prompt, params.instructions, params.input].filter((value) => value !== undefined).map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n"), n: Number(params.n ?? 1),
      ...(params.size ? { size: String(params.size) } : {}), inputHashes, outputHashes: [], status: "running", startedAt: Date.now(),
    };
    traces.push(trace);
    const signal = init?.signal;
    try {
      signal?.throwIfAborted();
      if (trace.nodeId && holdNodes.has(trace.nodeId) || holdVideoPolls && /^videos\/[^/]+$/.test(endpoint)) {
        trace.status = "waiting";
        await new Promise<void>((resolve, reject) => {
          const abort = () => { waiting.delete(trace.sequence); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
          waiting.set(trace.sequence, () => { signal?.removeEventListener("abort", abort); waiting.delete(trace.sequence); resolve(); });
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      signal?.throwIfAborted();
      if (trace.nodeId && failNodes.delete(trace.nodeId)) {
        trace.status = "failed";
        return Response.json({ error: { message: "受控验收：本节点首次请求失败" } }, { status: 500 });
      }
      if (["images/generations", "images/edits"].includes(endpoint)) {
        const data = Array.from({ length: trace.n }, () => {
          const b64_json = images[imageIndex++ % images.length];
          trace.outputHashes.push(hash(Buffer.from(b64_json, "base64")));
          return { b64_json };
        });
        trace.status = "succeeded";
        return Response.json({ data });
      }
      if (endpoint === "responses") {
        const text = `受控模板文本 ${trace.sequence}：产品特写、场景展示与品牌收尾。`;
        const usage = { input_tokens: 100, output_tokens: 100 };
        trace.status = "succeeded";
        if (params.stream) {
          const events = [
            { type: "response.output_text.delta", delta: text },
            { type: "response.completed", response: { status: "completed", usage, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] } },
          ];
          return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
        }
        return Response.json({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], output_text: text, usage });
      }
      if (endpoint === "videos") {
        const id = `browser-video-${trace.sequence}`;
        videos.add(id);
        trace.status = "succeeded";
        return Response.json({ id, status: "queued" });
      }
      if (endpoint === "audio/speech") {
        if (!audio.length) throw new Error("受控供应商缺少本地WAV测试素材");
        trace.status = "succeeded";
        return new Response(new Uint8Array(audio), { headers: { "Content-Type": "audio/wav" } });
      }
      const match = /^videos\/([^/]+)(\/content)?$/.exec(endpoint);
      if (match && videos.has(match[1])) {
        trace.status = "succeeded";
        if (!match[2]) return Response.json({ id: match[1], status: "completed" });
        if (!video.length) throw new Error("受控供应商缺少本地WebM测试素材");
        return new Response(new Uint8Array(video), { headers: { "Content-Type": "video/webm" } });
      }
      throw new Error("受控供应商不支持此测试端点");
    } catch (error) {
      trace.status = signal?.aborted ? "cancelled" : "failed";
      throw error;
    } finally { trace.finishedAt = Date.now(); }
  }

  return {
    fetch: Object.assign(forward, { preconnect: fetch.preconnect }) as typeof fetch,
    traces: () => traces.map((trace) => ({ ...trace })),
    control(input: { failNodeIds?: string[]; holdNodeIds?: string[]; holdVideoPolls?: boolean; release?: boolean }) {
      if (input.failNodeIds) { failNodes.clear(); input.failNodeIds.forEach((id) => failNodes.add(id)); }
      if (input.holdNodeIds) { holdNodes.clear(); input.holdNodeIds.forEach((id) => holdNodes.add(id)); }
      if (input.holdVideoPolls !== undefined) holdVideoPolls = input.holdVideoPolls;
      if (input.release) { holdNodes.clear(); holdVideoPolls = false; for (const resume of [...waiting.values()]) resume(); }
      return { waiting: waiting.size, configuredFailures: failNodes.size, configuredHolds: holdNodes.size };
    },
  };
}
