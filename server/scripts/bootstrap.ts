// Initializes dependencies without starting a listener or background scanners.
export {};
try {
  await (await import("../src/bootstrap")).bootstrap();
  await (await import("../src/db/client")).sqlClient.end();
  console.info(JSON.stringify({ event: "bootstrap_ready" }));
} catch {
  console.error(JSON.stringify({ event: "bootstrap_failed", message: "初始化失败，请检查环境配置、数据库和对象存储" }));
  process.exit(1);
}
