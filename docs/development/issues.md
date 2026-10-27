# 问题与决策记录

| 编号 | 问题 | 处理与状态 |
| --- | --- | --- |
| I-001 | 目录未包含源码，GitHub Git 连接 reset | 官方codeload指定commit已导入本地dev；506文件完整性校验通过。已解决。 |
| I-002 | 本机无 Bun、PostgreSQL、Docker；WSL 不可用 | 在 `.tools` 准备便携 Bun 与真实 PostgreSQL，避免更改系统配置。Docker 全栈验收须单独记录，不冒充已执行。 |
| I-003 | 03 文档将供应商映射描述为 models 字段 | 按权威 SQL 使用 model_routes；不修改表结构。已决策。 |
| I-004 | 03 上传示例使用 kind，OpenAPI 使用 purpose | 按 OpenAPI 实现 purpose。已决策。 |
| I-005 | 文本定价正文与 SQL 的配置键不同 | 使用 SQL 的 input/output/hold/min。已决策。 |
| I-006 | brands 无 updated_by，接口设计包含最近编辑人 | 遵循权威SQL且不新增字段；不输出伪造updatedByName，界面显示真实更新时间。差异已决策。 |
| I-007 | SSE 已发送响应头后无法补写最终余额 | 流结束后刷新账单摘要；非流式继续通过响应头更新。已决策。 |
| I-008 | 模板实例化要求纯函数却含上传与随机 ID | 上传在调用层完成，转换接收图片数据与可注入 ID 工厂。已决策。 |
| I-009 | 保存模板的 config 节点与空 image 原位生成存在语义差异 | 生成config与历史输出归并为一个空结果节点并重映射下游，保存有效参数，模板强制原位生成。纯核回归及实际电商保存后再次实例化完整运行通过，见m4-core.md和browser-m4/report.json。已解决。 |
| I-010 | MinIO 官方 Windows 下载返回 410 | 生产仍按指定 MinIO/S3；本机验收可用 S3 协议测试服务，须明确与真实 MinIO 的区别。调查中。 |
| I-011 | 初始缺少真实供应商配置 | 用户已提供测试供应商，Key加密落库；真实生成、扣点和S3读回通过。产品名和运营价格保持可配置。 |
| I-012 | 上游基线的antd6 styles.content类型错误 | 一行改为styles.container，前端类型检查和build通过。已解决。 |
| I-013 | Bun首次安装Windows esbuild缓存EPERM | 独立缓存目录和copyfile安装成功，web保留原锁文件。已解决。 |
| I-014 | 本地HTTP服务启动被自动审批阻止 | 两次被拒绝，信息仅为blocked by policy；不再启动监听。浏览器将以page.route和stdio→app.request验证真实UI/数据库，不把该结果视为HTTP部署验收。 |
| I-015 | nginx反代下socket IP限流影响所有用户 | 显式可信代理配置默认关闭；client-ip和限流回归通过，M5核对nginx覆盖IP和后端内网限制。 |
| I-016 | 成员撤权竞态可能恢复权限 | 统一workspace→操作者membership→目标锁序并事务重查；真实PG竞争回归通过。已解决。 |
| I-017 | 真实供应商实际输出像素不同于请求 | 完整真实模板8图再现：1024x1024→1374x1145（5图）或1254x1254，1088x1920→941x1672，1248x1664→1086x1448。Pillow/哈希/目视核验，保留原图不拉伸，按请求规格计价。供应商行为仍开放，详见browser-m5-real-ecom/zero-call-retry/report.json。 |
| I-018 | JSON转义/SSE跨事件Key回显及视频迟到状态竞争 | 已补解码后脱敏、SSE终态、取消退款、视频竞争校验；21项网关回归130断言通过，见m2-gateway-security.md。 |
| I-019 | 旧账号响应污染新会话、切工作区误扣、删除BYOK回退平台 | 四种情况已复现并修复；账号generation、工作区快照和禁止回退回归通过，见m2-frontend.md。已解决。 |
| I-020 | 品牌预览仅传prompt无法确定模型参考图上限 | 保留原接口并兼容增加modelId/originalReferenceCount/capability可选查询；预览与网关复用shared/brand-inject，M3回归与真实品牌请求一致性已通过，见m3-backend.md。已解决。 |
| I-021 | 5分钟预签名PUT可覆盖已经关联的品牌素材 | 临时对象绑定签名metadata，读取实际bytes验证后写入无PUT授权的最终key；真实S3重放及真实供应商品牌生成验证通过，见m3-backend.md。已解决。 |
| I-022 | 品牌删除先删S3再提交PG，失败回滚可能保留失效素材 | 内部持久清理任务结合工作区锁与原维护扫描；创建rollback/删除rollback/提交后故障恢复及幂等回归通过，不增加业务表。见m3-backend.md，已解决。 |
| I-023 | 画布下载品牌素材时自定义工作区头随302跳到S3 | 文件路径已包含工作区且后端校验成员权限；浏览器素材下载移除自定义头并仅同源携带Cookie。请求构造回归及SKU原图ZIP通过，见m3-browser-acceptance.md；真实跨域部署仍列环境限制。 |
| I-024 | 测试供应商目录列出gpt-5.5，但真实responses请求返回400 unknown provider for model gpt-5.5 | 已真实验证失败并核对账本：冻结10、退款10、charged=0。移除本次新增不可用文本路由，保留可用图片路由。受控SSE回归通过不等同真实文本通过；视频sora-2和tts也未在该供应商目录中。 |
| I-025 | AWS SDK预签名无Body PUT自动携带空内容CRC32，真实S3可能BadDigest | 仅预签名client设置requestChecksumCalculation=WHEN_REQUIRED；真实Body的服务端PUT仍保留校验。签名URL无空体checksum、包含Content-Type/length/metadata回归通过；MinIO实机仍待部署环境。 |

| I-026 | 测试库与应用库共用S3桶时，全局清理队列可能将其他库对象误判为孤立对象 | 已按不含凭据的数据库主机/端口/数据库名哈希分隔持久清理队列；不增加表字段，不扫描其他命名空间或自动迁移旧全局任务。跨库忽略、同库恢复及凭据轮换一致性测试通过，包含于后端93项/878断言，见m4-backend.md。部署推荐每环境独立桶，同一数据库实例使用一致的DATABASE_URL地址。已解决。 |

| I-027 | 并发模板步骤进度延迟保存；视频刷新续跑可能重复创建，模型列表晚加载可能错过自动恢复 | 已逐节点保存进度、复用既有任务Promise、捕获续跑任务排除竞态，恢复候选等待模型就绪且只尝试一次；只读查询剥离品牌依赖，保留会话/工作区隔离。最终DmlSXDY7刷新两分支6组通过，含模型延迟750ms；均仅3次视频创建/整套171点，见m4-browser-acceptance.md。已解决。 |

| I-028 | 本机文档Next遥测配置与Windows standalone Shiki junction产生EPERM | 单次CI/禁用遥测后曾完成内容、类型和81页静态生成，退出0但standalone复制警告保留。最终重build清理junction失败，删除该生成链接又被自动审批拒绝（blocked by policy），未换工具删除。最终bun run types:check的MDX/路由类型/TS通过；Windows重新打包、文档服务器/Linux镜像运行未验收，见m5-docs.md。 |

| I-029 | 官方模板物理删除后，自动seed会在重启时重新创建 | 已用isPublished=false保留固定ID，团队仍物理删除；清理器持锁核对发布状态。删除后seed不复活、图片封面回收、404/403、故障恢复、回滚及锁等待期间重新发布保留对象均通过；完整后端98项/936断言，见m4-backend.md/m5-deployment.md。已解决，无新增表字段。 |

| I-030 | 文档types:check中Next typegen偶发把生成的.source/server.ts留为空，TS2306 | 已调整检查顺序为Next路由类型→完整fumadocs-mdx→tsc；避免后一个生成器破坏前一个的结果，不更换依赖。最终连续两次验证均通过，见m5-docs.md。已解决。 |
| I-031 | 真实 HTTP 部署时 Bun.serve 默认 10 秒空闲超时会断开生图、SSE 与视频下载（此前验收均经 app.request，未走真实 socket） | 新增 `server/src/lib/serve.ts`，对 `/api/gateway/*` 调用 `server.timeout(req, 0)`，超时仍由上游 AbortSignal 控制；`tests/serve.test.ts` 以真实 Bun.serve 跑 11 秒请求通过。已解决。 |
| I-032 | 上游多返回图片时按返回数量计费，可能超出用户请求张数并触发补扣 | `actual()` 改为按 min(返回张数, n) 计价，补充单测。已解决。 |
| I-034 | 模板"运行全部"确认框只显示预计点数，未按 04 规范显示当前余额 | 确认框在平台计费模式下追加当前余额（读 use-credits-store）。web typecheck 通过。已解决。 |
| I-033 | MinIO 官方自 2025-10 起停止在 Docker Hub 发布镜像，`minio/minio:RELEASE.2025-09-07T16-13-09Z` 已无法拉取（pull access denied），compose 在任何新机器上都起不来；原健康检查还依赖镜像内 curl | 经用户确认改用社区维护分支 `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`（与原版命令、环境变量一致，自带 mc），健康检查改为 `mc ready local`。实测镜像可拉取、`mc ready local` 返回就绪。整套 compose 冒烟见后续验收。 |
| I-035 | MinIO 不支持桶级 CORS 接口，`ensureBucket()` 调用 PutBucketCors 返回 501 NotImplemented，启动初始化失败，server 容器无法启动（原版与 pgsty 分支相同；此前验收使用的是其他 S3 协议测试服务） | `ensureBucket()` 对 501 视为由服务端统一配置 CORS 并继续；compose 为 MinIO 设置 `MINIO_API_CORS_ALLOW_ORIGIN=${APP_ORIGIN}`，实测仅放行站点来源、其他来源预检被拒。bootstrap 集成测试兼容两类 S3。真实 PG + MinIO 下后端 101 项全部通过。已解决。 |
| I-036 | 计费页每日消耗图只有少数天数据时，柱子按 flex:1 撑满整行（1 天时变成整块黑色矩形），与设计稿不符 | 柱宽上限 36px（`billing.css`）；真实部署中替换前端资源后截图确认单柱显示正常。已解决。 |

## 记录原则

问题关闭必须附代码位置或验证证据；环境限制与产品缺陷分别说明。禁止将“未执行”记为“通过”。
