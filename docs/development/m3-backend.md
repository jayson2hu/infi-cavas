# M3 品牌、上传与网关注入后端

本阶段先阅读了权威 `specs/schema.sql`、`specs/openapi.yaml`、交付包 PRD/技术方案/UI/验收章节、`m3-plan.md`，以及实际网关、会话与工作区权限、S3、账本、扫描器和现有测试代码。数据库仍为原规格 23 张表，没有新增字段或迁移。

## 实现与原文件修改理由

- 新增 `shared/brand-inject.ts`：前后端共用无外部依赖的纯函数，生成相同品牌文字格式，选择实际附带的风格图，解析 none/enforced，并按能力补齐缺失的默认参数。服务器的 `gateway/brand-inject.ts` 负责工作区内品牌解析和真实对象读取，不把权限与网络逻辑放进共享纯函数。
- 新增 `routes/brands.ts` 与 `lib/brands.ts`：品牌 CRUD、颜色整体替换、素材修改、预览及 SKU/Logo/近 30 天项目数。owner/admin 可创建；普通 member 仅在 editorUserIds 中可编辑。所有写操作按工作区、成员、品牌顺序加锁后重新检查权限；enforced/editorUserIds 仅管理员可改，默认或强制品牌仅管理员可删除。删除默认品牌时清空工作区指向。
- 新增 `routes/uploads.ts` 与 `lib/uploads.ts`：沿用规格 20MB、PNG/JPEG/WebP、PUT 5 分钟、GET 10 分钟边界。预签名 PUT 绑定实际 Content-Type、Content-Length 和工作区/上传人/用途/大小/MIME 元数据。业务关联时验证真实 HEAD 与 GET 字节，禁止跨工作区、跨上传人和跨用途关联。
- 修改 `gateway/media.ts`、server 依赖及锁文件：采用成熟 `image-size` 解析器验证类型与尺寸，替换自行读取 PNG/JPEG/WebP 魔数；网关参考图与品牌上传共用校验。这是图片头及尺寸解析，不能等同于完整像素解码或图片内容审核。
- 修改 `lib/s3.ts`：支持签名上传元数据与内部清理任务遍历；预签名专用客户端采用 `requestChecksumCalculation: WHEN_REQUIRED`，避免 SDK 在签名时对尚不存在的 Body 写入空体 CRC32 导致真实 S3/MinIO BadDigest。实际有 Body 的服务器上传继续使用默认 SDK 校验。
- 修改 `gateway/router.ts`：品牌默认参数在模型选择和估价前补齐；图片参考只追加到用户图后，尊重模型上限，并可将 generations 改写为 edits。job 记录实际 brandId、endpoint 与注入提示词，输出张数仍由 n 决定。缺失参考对象或无效/跨工作区品牌在 hold 前失败，不创建 job、不冻结点数。
- 修改 `app.ts`：挂载 brands、uploads、files 路由。`/files/*` 从对象路径解析所属工作区并检查当前用户成员权，支持不能发送工作区请求头的 img；如显式请求头与路径冲突则拒绝，内部清理对象永不通过该接口公开。
- 新增 `lib/object-cleanup.ts`，修改 `billing/sweeper.ts`：资产创建与删除在工作区锁事务中先持久记录 S3 清理任务。数据库提交后才决定删除对象或作废任务；失败由既有 5 分钟扫描重试，没有新增定时参数。清理范围严格限制为该工作区、该品牌的最终对象。
- 修改根 `Dockerfile` 和 `server/Dockerfile`：复制共享纯函数目录到 `/app/shared`，防止构建/运行缺少模块。这里只调整依赖路径，没有执行或宣称 Docker 验收通过。

## 上传固化和故障恢复

预签名对象仅写入 `ws/<workspace>/uploads/<purpose>/...` 临时位置。资产关联时将已经验证的确切字节写入没有客户端 PUT 授权的 `ws/<workspace>/brands/<brand>/<asset>.<ext>`，业务记录只引用最终对象。重放旧 PUT 即使改掉临时对象，也不会改变已保存素材。

清理记录存放在仅服务端可访问的内部前缀。M4 的 I026 修复将其隔离为 `internal/cleanup/<数据库地址hash>/`，仅扫描当前数据库任务，详见 `m4-backend.md`。记录与业务删除使用同一工作区锁：扫描器必须等提交或回滚后再检查数据库目标。目标仍存在表示删除回滚或创建成功，只作废任务；目标已不存在才删除最终对象。单次 S3 删除失败保留清理任务；重复扫描与重复删除幂等。创建在写入最终对象后发生数据库回滚时，也由同一机制回收未关联对象。这里提供的是可恢复流程，不是 PostgreSQL 与 S3 的跨服务原子事务；S3 故障期间物理删除可延后，业务关联已经删除。

## 规格差异与明确决策

- preview 原接口只有 prompt，无法精确表达模型编辑能力和用户已有参考数量；增加可选 modelId、originalReferenceCount、capability。返回仍为 `{text, attachedReferenceCount}`。未选择模型时采用规格中的示例编辑能力和默认上限 8；前端传当前模型可获得准确预览。超过实际模型参考上限的预览请求也拒绝。
- SQL 没有 updated_by，不虚构 updatedByName；仅返回真实 updatedAt。nullable 的 industry、description、spec 允许传 null 清空。
- 默认参数只补缺失字段，不覆盖显式请求。model 为通用默认；image 使用 quality/size/n/background，video 使用 seconds/size/quality/resolution/aspect_ratio/generate_audio/watermark/mode，audio 使用 voice/speed/response_format，text 使用 temperature/max_output_tokens。连接地址、API Key、工作区等字段不能由品牌默认参数注入。
- text 的品牌块放到 instructions 前面，保留 input 与原有 instructions。audio 同样写 instructions，保留待朗读 input，避免读出品牌规则并保持按原文计费；video/image 写 prompt。音频和视频不附带品牌参考图。
- 普通编辑者不能通过删除默认或 enforced 品牌绕过管理员配置；删除判定读取锁定后的最新工作区状态，而非中间件旧快照。
- 清理任务为内部 S3 对象，不增加业务表或字段；复用已有扫描周期。上传签名 checksum 修复来自独立复核，S3rver 对某些校验的宽松行为不能作为真实 S3/MinIO 兼容验收结论。

## 验收证据

环境为 Bun 1.3.14、真实 PostgreSQL 16 测试库和本地 S3rver。测试直接调用 Hono app.request，供应商响应通过可注入 fetch 受控提供，不启动 HTTP 监听。

执行 `bun run typecheck` 通过。M3 专项 `bun test tests/brand-inject.test.ts tests/brands.integration.test.ts` 共 19 项通过、0 失败、222 次断言，覆盖：纯格式、参考排序/上限、none/enforced、参数白名单、图片解析、创建和编辑权限、两种撤权/默认变更竞态、真实签名上传与固化重放、上传用途/用户/MIME/20MB、文件工作区隔离、实际转发请求体改写、预览一致、文本/音频/视频参数与计费、颜色和统计、默认品牌删除，以及 S3 清理的回滚、失败重试和幂等。

整体 `bun test` 回归包含数据库 23 表等价检查、鉴权、账本、管理接口和网关：77 项通过、0 失败。独立只读审查已复核权限锁序、上传不可变、文件鉴权、清理恢复与默认参数顺序。

主线程另执行一次真实供应商参考图编辑，证据位于 `artifacts/acceptance/real-brand.json` 与 `real-brand-image.png`：HTTP 200、实际 `/v1/images/edits`、1 张参考图、prompt 与 preview 相同、强制品牌忽略 none、只按 n=1 扣 4 点（196→192）、结果归档和临时品牌清理通过。请求耗时 28.511 秒，单次热请求网关额外耗时 67ms；这不代表负载性能结论。供应商实际返回 1374×1145，而请求为 1024×1024，继续沿用 I017 记录该上游尺寸差异；没有偷偷裁切或重采样。

todo、pending-test 与版本级 CHANGELOG 由主线程统一汇总本阶段记录，避免并发修改；品牌后端完成不代表画布云同步或 Docker/MinIO 已验收。
