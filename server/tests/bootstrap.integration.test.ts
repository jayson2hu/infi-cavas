import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { DeleteBucketCommand, DeleteObjectCommand, GetBucketCorsCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { sqlClient } from "../src/db/client";
import { env } from "../src/env";
import { s3 } from "../src/lib/s3";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
const script = fileURLToPath(new URL("../scripts/bootstrap.ts", import.meta.url));
const databases: Array<{ name: string; client: ReturnType<typeof postgres>; bucket: string }> = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];

afterAll(async () => {
  for (const child of children) if (child.exitCode === null) { child.kill(); await child.exited; }
  for (const entry of databases) {
    await entry.client.end();
    await sqlClient`DROP DATABASE ${sqlClient(entry.name)}`;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: entry.bucket, Key: "retained.txt" }));
      await s3.send(new DeleteBucketCommand({ Bucket: entry.bucket }));
    } catch (error) { if ((error as { name: string }).name !== "NoSuchBucket") throw error; }
  }
});

function start(overrides: Record<string, string>, target = script) {
  const child = Bun.spawn([process.execPath, target], { env: { ...process.env, ...overrides }, stdout: "pipe", stderr: "pipe" });
  children.push(child);
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(([code, stdout, stderr]) => ({ code, output: stdout + stderr }));
}

integration("三个独立进程首次启动等待同一PG迁移锁，初始化完成后重复启动不覆盖运营数据", async () => {
  const suffix = randomUUID().replaceAll("-", ""); const name = `ic_bootstrap_${suffix}`; const bucket = `ic-bootstrap-${suffix}`;
  await sqlClient`CREATE DATABASE ${sqlClient(name)}`;
  const url = new URL(env.DATABASE_URL); url.pathname = `/${name}`;
  const client = postgres(url.href); databases.push({ name, client, bucket });
  const settings = { DATABASE_URL: url.href, S3_BUCKET: bucket };
  const holder = await client.reserve();
  let pending: Array<ReturnType<typeof start>> = [];
  try {
    await holder`select pg_advisory_lock(71423, 0)`;
    pending = Array.from({ length: 3 }, () => start(settings));
    const deadline = Date.now() + 15000; let waiters = 0;
    while (Date.now() < deadline) {
      const [row] = await client`select count(*)::int as count from pg_locks where locktype = 'advisory' and classid = 71423 and objid = 0 and not granted and database = (select oid from pg_database where datname = current_database())`;
      waiters = row.count; if (waiters === 3) break; await Bun.sleep(10);
    }
    expect(waiters).toBe(3);
    expect((await client`select to_regclass('public.users') as table_name`)[0].table_name).toBeNull();
  } finally { await holder`select pg_advisory_unlock(71423, 0)`; holder.release(); }
  for (const result of await Promise.all(pending)) { expect(result.code).toBe(0); expect(result.output).toContain('"event":"bootstrap_ready"'); }
  expect((await client`select count(*)::int as count from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)[0].count).toBe(25);
  expect((await client`select count(*)::int as count from drizzle.__drizzle_migrations`)[0].count).toBe(2);
  expect((await client`select count(*)::int as count from templates`)[0].count).toBe(6);
  // 支持桶级 CORS 的 S3 应写入站点来源；MinIO 不支持该接口（由 MINIO_API_CORS_ALLOW_ORIGIN 配置），启动仍须成功。
  const cors = await s3.send(new GetBucketCorsCommand({ Bucket: bucket })).catch((error: { name?: string }) => {
    if (error.name !== "NoSuchCORSConfiguration") throw error;
    return null;
  });
  if (cors) expect(cors.CORSRules?.[0].AllowedOrigins).toEqual([new URL(env.APP_ORIGIN).origin]);
  await client`update models set display_name = '运营修改', is_active = false where id = 'gpt-image-2'`;
  await client`update pricing_rules set config = ${client.json({ standard: 9, hd: 18 })} where model_id = 'gpt-image-2'`;
  await client`update templates set name = '运营模板', use_count = 31, is_published = false where id = 'tpl_ecom_main_set'`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "retained.txt", Body: "保留已有对象" }));
  for (const result of await Promise.all([start(settings), start(settings)])) expect(result.code).toBe(0);
  expect((await client`select display_name, is_active from models where id = 'gpt-image-2'`)[0]).toMatchObject({ display_name: "运营修改", is_active: false });
  expect((await client`select config from pricing_rules where model_id = 'gpt-image-2'`)[0].config).toEqual({ standard: 9, hd: 18 });
  expect((await client`select name, use_count, is_published from templates where id = 'tpl_ecom_main_set'`)[0]).toMatchObject({ name: "运营模板", use_count: 31, is_published: false });
  expect(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "retained.txt" }))).Body!.transformToString()).toBe("保留已有对象");
}, 30000);

test("无监听初始化入口配置失败只输出固定错误，不泄露环境值", async () => {
  const sentinel = `private-${randomUUID()}`;
  for (const target of [script, fileURLToPath(new URL("../scripts/ensure-bucket.ts", import.meta.url))]) {
    const result = await start({ DATABASE_URL: sentinel, APP_SECRET: sentinel, S3_SECRET_KEY: sentinel }, target);
    expect(result.code).toBe(1); expect(result.output).not.toContain(sentinel);
    expect(result.output.trim()).toMatch(/^\{"event":"(?:bootstrap|bucket)_failed","message":"[^\n]+"\}$/);
  }
});

integration("数据库初始化失败退出且不输出连接凭据", async () => {
  const url = new URL(env.DATABASE_URL); url.pathname = `/missing_bootstrap_${randomUUID().replaceAll("-", "")}`;
  const result = await start({ DATABASE_URL: url.href });
  expect(result.code).toBe(1); expect(result.output.trim()).toBe('{"event":"bootstrap_failed","message":"初始化失败，请检查环境配置、数据库和对象存储"}');
  expect(result.output).not.toContain(env.APP_SECRET); expect(result.output).not.toContain(url.href);
});
