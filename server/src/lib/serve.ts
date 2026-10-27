type TimeoutServer = { timeout(request: Request, seconds: number): void };
type FetchApp = { fetch(request: Request, env?: unknown): Response | Promise<Response> };

// Bun.serve 默认 10 秒无数据即断开连接；网关请求（生图、文本流、视频下载）由各自的上游超时控制，这里关闭 Bun 的空闲超时。
export function bunFetch(app: FetchApp) {
  return (request: Request, server: TimeoutServer) => {
    if (new URL(request.url).pathname.startsWith("/api/gateway/")) server.timeout(request, 0);
    return app.fetch(request, server);
  };
}
