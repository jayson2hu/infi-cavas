import { expect, test } from "bun:test";
import { bunFetch } from "../src/lib/serve";

test("网关请求关闭 Bun 的 10 秒空闲超时，其他接口保持默认", async () => {
  const calls: Array<[string, number]> = [];
  const server = { timeout: (request: Request, seconds: number) => { calls.push([new URL(request.url).pathname, seconds]); } };
  const handler = bunFetch({ fetch: () => new Response("ok") });
  await handler(new Request("http://localhost/api/gateway/v1/images/generations", { method: "POST" }), server);
  await handler(new Request("http://localhost/api/billing/summary"), server);
  expect(calls).toEqual([["/api/gateway/v1/images/generations", 0]]);
});

test("真实 Bun.serve 下，超过 10 秒才返回的网关请求不会被断开", async () => {
  const handler = bunFetch({ fetch: async () => { await Bun.sleep(11000); return new Response("ok"); } });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/gateway/v1/images/generations`, { method: "POST" });
    expect(await response.text()).toBe("ok");
  } finally { server.stop(true); }
}, 20000);
