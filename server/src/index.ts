let server;
try {
  await (await import("./bootstrap")).bootstrap();
  const [{ createApp }, { env }, { startSweeper }, { createVideoPoller }, { bunFetch }] = await Promise.all([
    import("./app"), import("./env"), import("./billing/sweeper"), import("./gateway/router"), import("./lib/serve"),
  ]);
  startSweeper(createVideoPoller());
  server = { hostname: env.HOST, port: env.PORT, fetch: bunFetch(createApp()) };
} catch {
  console.error(JSON.stringify({ event: "startup_failed", message: "服务初始化失败，请检查环境配置、数据库和对象存储" }));
  process.exit(1);
}
export default server;
