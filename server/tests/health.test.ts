import { expect, test } from "bun:test";
import { createApp } from "../src/app";

test("健康检查遵循约定响应", async () => {
  const response = await createApp().request("/api/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
