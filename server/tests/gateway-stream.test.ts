import { expect, test } from "bun:test";
import { createParser } from "eventsource-parser";
import { responseStream } from "../src/gateway/response-stream";
import { guardMediaStream } from "../src/gateway/media";
import { env } from "../src/env";

const secret = "provider-key-1234567890";
const delta = (value: string, output_index = 0) => `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: value, output_index })}\n\n`;
const completed = 'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":8}}}\n\n';

test("SSE解码后脱敏跨事件Key并保持各输出项的归属", async () => {
  let success = 0;
  let failure = 0;
  let archived = "";
  const stream = responseStream({ response: new Response(delta("第一段", 0) + delta(secret.slice(0, 8), 1) + delta(secret.slice(8), 1) + delta("结束", 2) + completed), signal: new AbortController().signal, secrets: [secret],
    complete: async (usage, text) => { expect(usage).toEqual({ input_tokens: 5, output_tokens: 8 }); success++; archived = text; }, failed: async () => { failure++; } });
  const byIndex = new Map<number, string>();
  const events: string[] = [];
  const parser = createParser({ onEvent(event) { const data = JSON.parse(event.data); events.push(event.event ?? ""); if (typeof data.delta === "string") byIndex.set(data.output_index, (byIndex.get(data.output_index) ?? "") + data.delta); } });
  parser.feed(await new Response(stream).text());
  expect([...byIndex.values()].join("")).toBe("第一段[REDACTED]结束");
  expect(byIndex.get(0)).toBe("第一段");
  expect(byIndex.get(1)).toBe("[REDACTED]");
  expect(byIndex.get(2)).toBe("结束");
  expect(archived).toBe("第一段[REDACTED]结束");
  expect(events.at(-1)).toBe("response.completed");
  expect(success).toBe(1); expect(failure).toBe(0);
});

test("SSE只有失败事件名称、无终态EOF或完成前消费取消均不结算", async () => {
  for (const source of [delta("未完成"), 'event: error\ndata: {"message":"failed"}\n\ndata: [DONE]\n\n', 'event: response.failed\ndata: failed\n\ndata: [DONE]\n\n']) {
    let success = 0; let failure = 0;
    const stream = responseStream({ response: new Response(source), signal: new AbortController().signal, secrets: [secret], complete: async () => { success++; }, failed: async () => { failure++; } });
    expect(await new Response(stream).text()).toContain("点数已退还");
    expect(success).toBe(0); expect(failure).toBe(1);
  }
  let success = 0; let failure = 0;
  const upstream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(delta("足够长的流式输出".repeat(10)))); } });
  const stream = responseStream({ response: new Response(upstream), signal: new AbortController().signal, secrets: [secret], complete: async () => { success++; }, failed: async () => { failure++; } });
  const reader = stream.getReader(); await reader.read(); await reader.cancel();
  expect(success).toBe(0); expect(failure).toBeGreaterThanOrEqual(1);
});

test("二进制流中的Key跨网络chunk时不泄露完整Key", async () => {
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(`media-${secret.slice(0, 10)}`)); controller.enqueue(encoder.encode(secret.slice(10))); controller.close(); } });
  const reader = guardMediaStream(upstream, [secret]).getReader();
  let output = "";
  let rejected = false;
  try { for (;;) { const part = await reader.read(); if (part.done) break; output += new TextDecoder().decode(part.value); } } catch { rejected = true; }
  expect(rejected).toBe(true); expect(output).not.toContain(secret);
});

test("收到完成事件即结束响应并取消仍未关闭的上游连接", async () => {
  let success = 0; let upstreamCancelled = false;
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(delta("完成") + completed)); }, cancel() { upstreamCancelled = true; } });
  const stream = responseStream({ response: new Response(source), signal: new AbortController().signal, secrets: [secret], complete: async () => { success++; }, failed: async () => { throw new Error("unexpected refund"); } });
  expect(await new Response(stream).text()).toContain("response.completed");
  expect(success).toBe(1); expect(upstreamCancelled).toBe(true);
});

test("只出现在完成消息里的文本也必须经过结果审核", async () => {
  const original = env.MODERATION_BLOCKLIST;
  env.MODERATION_BLOCKLIST = ["blocked-test-marker"];
  try {
    for (const source of ['event: response.completed\ndata: {"response":{"output":[{"content":[{"text":"blocked-test-marker"}]}]}}\n\n', 'event: response.output_text.done\ndata: {"text":"blocked-test-marker"}\n\n' + completed]) {
      let success = 0; let failure = 0;
      const stream = responseStream({ response: new Response(source), signal: new AbortController().signal, secrets: [secret], complete: async () => { success++; }, failed: async () => { failure++; } });
      const output = await new Response(stream).text();
      expect(output).not.toContain("blocked-test-marker"); expect(output).toContain("点数已退还");
      expect(success).toBe(0); expect(failure).toBe(1);
    }
  } finally { env.MODERATION_BLOCKLIST = original; }
});
