import { expect, test } from "bun:test";
import { resolveClientIp } from "../src/middleware/client-ip";

test("直连模式不信任客户端伪造的真实 IP 请求头", () => {
  expect(resolveClientIp("203.0.113.10", "198.51.100.1", false)).toBe("203.0.113.10");
});

test("可信反向代理下不同客户端使用各自的 IP", () => {
  expect(resolveClientIp("172.18.0.2", "198.51.100.1", true)).toBe("198.51.100.1");
  expect(resolveClientIp("172.18.0.2", "198.51.100.2", true)).toBe("198.51.100.2");
  expect(resolveClientIp("172.18.0.2", "2001:db8::1", true)).toBe("2001:db8::1");
});

test("代理缺失或无效 IP 头时回退到连接地址，不接受任意限流键", () => {
  for (const header of [undefined, "not-an-ip", "198.51.100.1, 198.51.100.2", "198.51.100.1:80"]) {
    expect(resolveClientIp("172.18.0.2", header, true)).toBe("172.18.0.2");
  }
  expect(resolveClientIp(undefined, "spoofed", false)).toBe("unknown");
});
