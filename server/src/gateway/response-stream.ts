import { createParser, type EventSourceMessage } from "eventsource-parser";
import { ApiError } from "../lib/errors";
import { checkResult, responseText } from "./moderation";
import { redactPayload, redactSecrets } from "./upstream";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
type StreamOptions = {
  response: Response; signal: AbortSignal; secrets: string[];
  complete: (usage: Record<string, unknown> | undefined, text: string) => Promise<void>;
  failed: (cancelled: boolean) => Promise<void>;
};

export function responseStream(options: StreamOptions) {
  const reader = options.response.body!.getReader();
  const encoder = new TextEncoder();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const decoder = new TextDecoder();
      let usage: Record<string, unknown> | undefined;
      let text = "";
      let completed = false;
      let tail = "";
      const deltas: Array<{ event: EventSourceMessage; data: Record<string, unknown>; value: string }> = [];
      const terminal: string[] = [];
      const keep = Math.max(0, ...options.secrets.map((secret) => secret.length - 1));
      const pattern = options.secrets.filter(Boolean).sort((a, b) => b.length - a.length).map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      const frame = (event: EventSourceMessage, data: unknown) => `${event.id ? `id: ${redactSecrets(event.id, options.secrets)}\n` : ""}${event.event ? `event: ${redactSecrets(event.event, options.secrets)}\n` : ""}${(typeof data === "string" ? data : JSON.stringify(redactPayload(data, options.secrets))).split(/\r?\n/).map((line) => `data: ${line}\n`).join("")}\n`;
      const emit = (value: string) => { if (!cancelled) controller.enqueue(encoder.encode(value)); };
      const flushDelta = (final = false) => {
        let end = final ? tail.length : Math.max(0, tail.length - keep);
        const matches = pattern ? [...tail.matchAll(new RegExp(pattern, "g"))] : [];
        for (const match of matches) if (match.index! < end && match.index! + match[0].length > end) end = match.index!;
        let offset = 0;
        while (deltas.length && offset < end) {
          const next = deltas[0];
          const limit = Math.min(end, offset + next.value.length);
          let cursor = offset;
          let value = "";
          for (const match of matches) {
            const start = match.index!;
            const finish = start + match[0].length;
            if (finish <= offset || start >= limit) continue;
            value += tail.slice(cursor, Math.max(cursor, start));
            if (start >= offset) value += "[REDACTED]";
            cursor = Math.max(cursor, finish);
          }
          value += tail.slice(cursor, limit);
          if (value) emit(frame(next.event, { ...next.data, delta: value }));
          next.value = next.value.slice(limit - offset);
          if (!next.value) deltas.shift();
          offset = limit;
        }
        tail = tail.slice(end);
      };
      const parser = createParser({ onEvent(event) {
        if (completed) return;
        if (["error", "response.failed", "response.incomplete"].includes(event.event ?? "")) throw new ApiError(502, "upstream_stream_failed", "供应商文本生成失败");
        if (event.data === "[DONE]") { completed = true; terminal.push(frame(event, "[DONE]")); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(event.data); } catch { emit(frame(event, redactSecrets(event.data, options.secrets))); return; }
        const data = record(parsed);
        const types = [String(data.type ?? ""), event.event ?? ""];
        if (types.some((type) => ["error", "response.failed", "response.incomplete"].includes(type))) throw new ApiError(502, "upstream_stream_failed", "供应商文本生成失败");
        if (types.includes("response.completed")) {
          const response = record(data.response);
          checkResult(responseText(response));
          if (response.status && response.status !== "completed") throw new ApiError(502, "upstream_stream_failed", "供应商文本生成失败");
          usage = record(response.usage);
          completed = true;
          terminal.push(frame(event, data));
          return;
        }
        if (types.includes("response.output_text.delta") && typeof data.delta === "string") {
          text += data.delta;
          checkResult(text);
          if (data.delta) { tail += data.delta; deltas.push({ event, data, value: data.delta }); flushDelta(); }
          return;
        }
        if (types.includes("response.output_text.done")) { checkResult(responseText(data)); flushDelta(true); }
        emit(frame(event, data));
      } });
      const abort = () => { cancelled = true; void reader.cancel().catch(() => {}); };
      options.signal.addEventListener("abort", abort, { once: true });
      try {
        options.signal.throwIfAborted();
        while (!cancelled && !completed) {
          const { value, done } = await reader.read();
          parser.feed(decoder.decode(value, { stream: !done }));
          if (done) break;
        }
        if (cancelled || options.signal.aborted) { await options.failed(true); return; }
        if (!completed) throw new ApiError(502, "incomplete_stream", "文本流未正常完成");
        checkResult(text);
        await options.complete(usage, redactSecrets(text, options.secrets));
        if (cancelled) return;
        flushDelta(true);
        terminal.forEach(emit);
        controller.close();
      } catch {
        await options.failed(cancelled);
        if (!cancelled) {
          emit('event: error\ndata: {"error":{"message":"文本生成失败，点数已退还"}}\n\n');
          controller.close();
        }
      } finally {
        options.signal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        if (cancelled) { try { controller.close(); } catch { /* The consumer may already have cancelled. */ } }
      }
    },
    async cancel() { cancelled = true; await reader.cancel().catch(() => {}); await options.failed(true); },
  });
}
