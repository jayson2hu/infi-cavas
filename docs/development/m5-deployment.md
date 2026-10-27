# M5 部署配置与服务初始化

先阅读 `m5-plan.md`、交付包 05 的 M5/最终验收清单，以及真实 Dockerfile、Compose、nginx、运行期 config.js、环境变量、迁移、种子、S3 和扫描器代码。沿用 Bun、Hono、Drizzle、PostgreSQL 16 和 MinIO/S3，没有修改业务表或字段。

## 部署合同

主 `docker-compose.yml` 包含 web、server、postgres、minio、bucket-init。postgres 健康与 bucket-init 成功后才启动 server；MinIO 健康后运行一次性 bucket-init；server 健康后启动 web。bucket-init 与 server 使用同一后端镜像和环境，通过 AWS SDK 的既有 ensureBucket 创建存储桶并设置 CORS，不通过 shell 拼接密钥。

web 使用 `/api` 运行期平台入口。server 没有宿主机端口，监听容器内 0.0.0.0:8787 并开启 TRUST_PROXY。PostgreSQL 不映射端口；web 默认只绑定 127.0.0.1:3000，MinIO API 默认只绑定 127.0.0.1:9000，9001 控制台不映射。数据分别保存在 postgres 与 minio named volumes；不提供自动删除卷的启动命令。

`nginx.conf` 的 `/api/` 保留原请求路径，关闭响应与请求 buffering，使用 HTTP/1.1、900 秒读写代理超时和 100MB 请求上限，覆盖 X-Real-IP/X-Forwarded-For 为当前连接地址。上述超时/大小来自交付包。不能给 server 公开端口后继续信任外部头。若还有一层 TLS 反向代理，内层默认看到的是该代理地址；部署者应配置明确的受信任 real_ip 来源或直接在入口处理 TLS，不能直接信任任意客户端传来的 IP 头。PG 健康检查沿用原开发配置的 5s/5s/10；新增健康检查使用 Docker 自身默认周期，没有增加业务重试边界。

`docker-compose.web-only.yml` 通过当前源码 Dockerfile 构建 `infinite-canvas-web-only:local`，并显式将 PLATFORM_API_BASE 设为空，使 `up --build` 得到当前分支的纯前端与署名版本。原 `docker-compose.local.yml` 无需更改，继续使用默认 Dockerfile 本地构建纯前端。默认 Dockerfile 选择 `nginx.web-only.conf`，不解析不存在的 server；只有平台 Compose 通过 NGINX_CONF 构建参数选择 API 代理配置。

根 `.env.example` 的 POSTGRES_PASSWORD、APP_SECRET、S3_ACCESS_KEY、S3_SECRET_KEY、DATABASE_URL 故意留空；Compose 对缺失或空值直接拒绝。生成示例为每个密码/secret 独立生成 32 字节随机 hex，S3_ACCESS_KEY 独立生成 10 字节 hex 标识，不复用秘密。不存在可以直接误用的演示生产密码。APP_SECRET 用于供应商密钥加密，持久部署必须备份并保留原值，不能每次启动自动重建。

DATABASE_URL 必须显式填写容器主机 postgres 和数据库名；用户名/密码含 URL 特殊字符时应编码，POSTGRES_PASSWORD 本身仍为原始值。S3_ENDPOINT 为服务端容器地址，S3_PUBLIC_ENDPOINT 必须为浏览器实际访问、且 Host 与签名一致的地址。远端部署不能把 localhost 或 minio 容器名给浏览器；应提供 HTTPS 对象存储入口，并保留签名路径/Host。CORS 按 APP_ORIGIN 的 origin 精确设置。每个环境应使用独立 bucket；I026 的清理命名空间防护不能代替环境隔离，同一数据库实例应使用一致的明确 DATABASE_URL。

## 启动与迁移互斥

新增 `server/src/bootstrap.ts` 顺序等待 migrateDatabase、seedDatabase、ensureBucket。`server/src/index.ts` 先动态加载并完成 bootstrap，之后才加载应用、启动原扫描器并提供 Bun 监听描述符。配置校验、数据库或对象存储初始化失败时输出固定 startup_failed 信息并退出，不把异常对象、SQL、连接字符串或密钥写入日志。

迁移使用独立保留的 PostgreSQL 会话持有 `pg_advisory_lock(71423, 0)`，在锁持有期间调用原 Drizzle migrator，并在 finally 中解锁、归还连接。扫描器原锁使用 71423 的其他编号，不冲突。迁移会使用连接池中的另一连接；目前项目未配置 max=1，不能将共享池改成只有一个连接而不同时调整该实现。这样避免直接包装 postgres reserve() 的类型/运行时差异：其声明看似完整 Sql，实际缺少 Drizzle 所需 options/begin。没有手写 SQL 迁移或增加锁表。

种子沿用事务与 onConflictDoNothing，重复启动不覆盖模型配置、价格、官方模板运营修改、使用次数和发布状态。I029 补充修复官方 DELETE：保留同 ID 的 isPublished=false 记录，使重启不重新创建运营已删除的默认模板；团队模板仍物理删除，官方下架对象按锁定后的发布状态回收，详见 `m4-backend.md`。ensureBucket 对已存在桶重新设置本应用 CORS，保留已有对象。初始化完毕才开始原 5 分钟/1 小时扫描，不添加新的扫描器或定时参数。

新增 `server/scripts/bootstrap.ts` 供独立初始化验收，运行依赖初始化后关闭数据库连接并退出；没有监听或后台扫描。`server/scripts/ensure-bucket.ts` 是 Compose bucket-init 的专用入口。两者同样捕获配置/初始化异常，使用固定 bootstrap_failed/bucket_failed 信息退出。

## 原文件修改理由

| 文件 | 修改理由 |
| --- | --- |
| Dockerfile | 冻结 web 锁文件安装，统一 Bun 1.3.14；复制构建所需根 LICENSE；以 NGINX_CONF 保留默认纯前端构建；运行镜像公开原 MIT 全文 |
| server/Dockerfile | 保留共享模块和 specs 打包，补原 LICENSE；继续冻结后端锁文件安装 |
| docker-compose.yml | 从单一静态镜像调整为平台五服务、健康/初始化依赖、持久卷、内网服务与必填秘密 |
| docker-compose.dev.yml | 使用同一自动初始化入口，去掉重复手动迁移；增加 MinIO 健康依赖，避免新入口先于对象存储启动 |
| nginx.conf | 增加平台 API 流式代理、规格指定超时/请求大小及可信 IP 覆盖；保留 SPA 和 config.js no-store |
| server/src/index.ts | 启动前完成初始化，失败退出并脱敏，初始化成功后才启动扫描器/监听 |
| server/src/db/migrate.ts | 为多个启动进程的首次迁移增加真实 PostgreSQL advisory lock |

新增文件为根 `.env.example`、`docker-compose.web-only.yml`、`nginx.web-only.conf`、bootstrap 模块、两个无监听初始化脚本及 bootstrap 集成测试。原 LICENSE、作者链接、画布本地数据和纯前端模式没有被替换。

## 验收证据与边界

- `bun run typecheck` 通过。
- bootstrap 专项 3 项测试、28 次断言通过。使用真实 PG16 新数据库与随机命名的独立 S3rver 存储桶；测试结束删除自己的数据库和桶，不操作用户数据。
- 三个独立 Bun 进程均在 PostgreSQL 中实际等待同一 advisory lock；释放锁后都成功完成。新库有规格 23 张业务表、1 条 Drizzle 迁移记录、6 个官方模板，桶的 CORS origin 正确。
- 修改模型名称/启用状态、价格、模板名称/useCount/发布状态并写入对象后，再次并发初始化，所有运营修改和对象保留。
- 无监听初始化入口在无效配置和不存在数据库时以非零退出，固定日志不包含测试凭据或连接 URL。没有调用实际 server 监听入口作验收。
- I029 修复后的最终完整后端 `bun test`：17 个文件，98 项通过、0 失败、936 次断言，M1–M4 回归继续通过。新增官方 DELETE→seed 不复活、对象回收、下架回滚和模板锁等待期间发布状态改变的检查；固定种子记录在测试结束恢复。
- 四个 Compose 文件均用 Bun YAML 解析器解析通过；静态断言检查依赖关系、内网端口、锁文件安装、构建 COPY 来源、LICENSE/shared/specs、默认纯前端配置与代理项，证据为 `artifacts/acceptance/m5-deployment-static.json`。远端 Compose 官方 JSON Schema 下载超时，该项未完成，不计为通过。指定 MinIO 版本的上游 `Dockerfile.release` 明确复制静态 curl，健康检查命令所依赖的工具有源码依据。
- 独立只读复核暂未发现配置阻断，确认启动次序、内网 server、IP 头覆盖、必填秘密和打包依赖；完整部署证据仍需实机验证。
- 最终文档交叉核对发现 web-only 曾仍指向原上游 GHCR 镜像，已改为当前源码 build 与本地镜像，并补静态断言确认构建来源和空平台入口；复核通过。此次只有 Compose/文档调整，没有重复执行已通过的 96 项后端测试。

本机没有 Docker/WSL，HTTP 监听启动已被自动审批拒绝，因此没有执行 Docker 构建、docker compose config/up、nginx -t、MinIO 实机或“干净机器从注册到出图”验收。S3rver 测试不能替代 MinIO 签名、CORS、镜像健康及持久卷重启验收。公开部署文档、版本记录、todo/pending-test 和最终进度由主线程统一汇总；不得把本记录中的静态检查写成生产部署已成功。
