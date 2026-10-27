# 平台服务

运行时 Bun 1.3，HTTP Hono，数据库 PostgreSQL16/Drizzle，对象存储为 S3 兼容接口。

从仓库根目录启动开发依赖与后端：

```sh
docker compose -f docker-compose.dev.yml up --build
```

也可启动本机后端：复制 `.env.example` 为 `server/.env` 并填好连接配置，然后在 `server/` 执行：

```sh
bun install --frozen-lockfile
bun run db:migrate
bun run dev
```

开发服务默认仅监听 `127.0.0.1:8787`，健康检查为 `GET /api/health`。容器通过 `HOST=0.0.0.0` 监听容器网络。浏览器开发请求由 Vite `/api` 代理送至后端，`APP_ORIGIN` 需匹配浏览器来源。

验证：

```sh
bun run typecheck
bun test
```

集成测试必须显式设置 `TEST_DATABASE_URL` 指向独立的已迁移 PostgreSQL 测试库。测试预加载会将 `DATABASE_URL` 切换到该库；未配置时数据库集成用例明确跳过。不要将生产库用作测试库。

真实执行结果与限制见 `../docs/development/acceptance.md`。尚未完成的功能不得视为可用的生产服务。
