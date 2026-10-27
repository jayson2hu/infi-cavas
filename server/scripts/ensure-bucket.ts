export {};
try {
  await (await import("../src/lib/s3")).ensureBucket();
  console.info(JSON.stringify({ event: "bucket_ready" }));
} catch {
  console.error(JSON.stringify({ event: "bucket_failed", message: "存储桶初始化失败，请检查配置和对象存储" }));
  process.exit(1);
}
