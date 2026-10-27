# 验收证据

状态：按用户最新确认“目前没有，先完成代码与本机验收”，本次代码与本机验收交付通过。M0–M5开发与本机可执行验收已完成，真实完整电商模板通过。干净机器Docker/MinIO、真实文本/音视频能力及文档Windows standalone重新打包保留为后续验证，不宣告完整生产交付成功。

验收分层：纯函数单测 → 真实 PostgreSQL 事务与并发 → HTTP 权限/网关/存储集成 → 独立浏览器的桌面和 390px 操作 → 生产 compose/真实供应商验证。

完整清单来自交付包 `05-任务拆解与验收.md`。命令、结果和证据路径按里程碑记录；M5逐项结论见 `m5-acceptance.md`，受环境限制的项目单独列在文末。

## M0 证据

| 检查 | 结果 |
| --- | --- |
| 指定基线完整性 | 官方 codeload 9f2bd9f 的 506 文件全部存在；初始化后503文件hash一致，另外3文件为明确修改的 AGENTS/.gitignore/CHANGELOG。细节在忽略Git的 .tools/upstream-integrity.json。 |
| server: bun run typecheck | 通过 |
| web: bun run typecheck | 修正上游 Modal styles.content→container 后通过 |
| web: bun test | 15 pass，0 fail |
| server: bun run db:generate | 生成 drizzle/0000_friendly_salo.sql，23表 |
| server: bun run db:migrate | 真实 PostgreSQL16.6 的 ic 与 ic_test 均成功 |
| server: bun test（设置TEST_DATABASE_URL） | 2 pass，0 fail；health契约、23表/209列/38外键/20CHECK/10二级索引与权威SQL完整 pg_catalog 等价 |
| HTTP监听与Docker | 本地服务启动命令两次被自动审批阻止（含仅监听127.0.0.1的替代方式）；未运行Docker，因为本机无Docker/WSL。不能将app.request等同部署验收。 |
| S3 | 本机协议测试服务预签名PUT/GET/HEAD/CORS通过；非MinIO，实际MinIO验收未执行。 |

## M0 原文件修改理由

- AGENTS.md：追加用户本次要求的二开约束和验收规则，保留原作者规范。
- .gitignore/.dockerignore：排除本机工具、凭据、数据库和验收产物，避免进入Git或镜像构建上下文。
- CHANGELOG.md：记录平台基础增量。
- web/src/components/layout/model-script-editor.tsx：按实际antd6类型将单个样式槽从content改为container，修复基线上已有类型错误。

## M1 当前证据

- `server/tests/auth.integration.test.ts`：真实PG+Hono `app.request`，5项测试、92断言、0失败。
- 已覆盖注册邮箱规范化、重复邮箱409、口令argon2id、Cookie HttpOnly、会话只存哈希、错误口令401、Origin403、未登录401、member越权403、跨工作区403、成员上限、邀请接受/过期409、注册邀请失败整体回滚、会话续期/退出/过期。
- 独立安全审查发现代理IP下的全局限流问题及撤权竞态，均已修复并完成真实PG回归，证据见m1-security.md。

## M2 当前证据

- 后端最终全量：58 tests、457 assertions、0 fail（12个文件，5.42秒）；加载本机真实PG/S3配置，包括并发冻结、幂等竞争、月度重置、兑换码、网关契约及安全补充回归。类型检查通过。
- 真实供应商验收：`gpt-image-2` 返回200，23.49秒，余额200→196，扣点4，job状态succeeded，S3归档已读回且非空。证据为 `artifacts/acceptance/real-provider.json` 与 `real-provider-image.png`，已目视检查输出确为产品摄影图片。
- 真实请求使用 Hono app.request 调用认证路由并连接实际HTTPS上游；不是浏览器端到端，也不等同HTTP部署验证。
- 测试供应商已加密配置在本机ic数据库；上游Key没有出现在响应或报告中。本机验收账号凭据亦加密存于忽略Git的.tools目录。
- 独立网关审查已完成JSON转义密钥脱敏、SSE终态、视频终态竞争与响应校验边界修复；专项21项/130断言通过，见m2-gateway-security.md。
- 前端全量24项/61顶层断言通过；其中平台模式独立子进程14项/48断言覆盖四项账户/工作区隔离回归、视频归属、SSE余额刷新、持久化排除、定价和双语完整性，见m2-frontend.md。
- 前端类型检查通过；生产构建25.34秒完成，保留原项目混合导入及较大bundle警告，未以无关拆包重构扩大改动范围。
- 浏览器基线9项通过（24.8秒，pageerror=0）：真实注册/HttpOnly/赠200点、团队邀请注册、成员额度12、成员UI及API403、CSV账本、390px首页/团队/账单无横滚、登出/错密/重新登录。两名测试用户及关联工作区清理成功。截图经逐张视觉检查，见m2-browser-acceptance.md和artifacts/acceptance/browser/report.json。
- 浏览器使用构建产物与真实Hono/PG，但传输为Playwright route.fulfill→stdio，不监听端口、不调用真实供应商；明确不等价HTTP或Docker部署验收。
- 交付规格复核补齐`billing/payment.ts`的二期PaymentProvider类型契约；MVP仍仅手动加点与兑换码，没有接入或宣称在线支付。
- 已执行`server/scripts/verify-secret-handling.ts`：使用加密保存的真实验收Key在内存中对照，316个源码/配置/文本验收文件与当前应用数据库23表20行均无明文匹配。报告`artifacts/acceptance/secret-audit.json`只写位置与计数，不写匹配内容；此静态/数据库检查与网关响应脱敏回归互补，不表示覆盖未来任意日志。

## M3 当前证据

- `server/scripts/verify-brand-provider.ts --generate`真实供应商参考图编辑通过：上传现有产品图→真实S3读取/固化→默认强制品牌→请求`X-IC-Brand:none`仍套用→上游实际`/v1/images/edits`且附1张参考图，实际prompt与预览逐字一致。
- HTTP200，28.511秒，n=1扣4点，余额196→192，job succeeded且brandId匹配；生成归档已从S3读回。临时品牌/素材已删除，原工作区默认品牌已恢复。
- 单次热请求扣除真实上游完整响应传输后，网关额外耗时67ms，符合本样本100ms目标；不是并发负载测试，不能推广为所有环境性能保证。
- 证据`artifacts/acceptance/real-brand.json`、`real-brand-image.png`。图片已目视确认为与参考产品一致的白色陶瓷杯；供应商仍将1024x1024请求返回1374x1145，I-017保持开放。
- 后端最终完整回归77项/679断言、0失败（14文件，7.85秒），类型检查通过；包含M3专项19项/222断言及S3校验签名/创建和删除恢复修复。前端完整24项/61顶层断言、平台子suite23项/90断言通过；类型检查及最终生产构建29.88秒通过。
- 浏览器最终7组/18.77秒通过，pageerror=0，包含真实上传、完整品牌侧栏、强制开关、SKU拖入和ZIP原始字节校验；测试数据与临时桶清理完成。详见m3-browser-acceptance.md，产物artifacts/acceptance/browser-m3/。

## M4 当前证据

- 后端类型检查及完整93项/878断言通过；六个官方种子、模板CRUD/权限、AJV语义、图片固化/删除恢复和清理跨数据库隔离验证通过，见m4-backend.md。
- 转换及运行核心12项/58断言通过，覆盖权威模板实例化、保存归并、参数快照、步骤依赖、并发中间进度、失败续跑与停止，见m4-core.md。
- 前端全量39项/125顶层断言通过；六模板首轮浏览器22组/45.34秒通过，pageerror=0，临时用户与存储清理完成。包括电商5+3图片、真实主图SHA256依赖与40点账本、永久素材保存再实例化、失败只重试未完成节点、并发停止退款以及全部六种工作流导出。
- 视频刷新专项发现模型列表晚于画布恢复时不自动重试，已修复配置就绪后一次恢复及只读查询不依赖品牌加载。最终DmlSXDY7构建：六模板27组/50.94秒、视频恢复6组/22.53秒通过，pageErrors/transportErrors均0；测试用户与存储清理成功。视频恢复两个分支均仅3个创建请求、整套171点。
- 最终文档m4-browser-acceptance.md，报告artifacts/acceptance/browser-m4/report.json与browser-m4-video-recovery/report.json。使用受控上游，不代表真实音视频供应商能力或HTTP部署验收；multipart文件通过实际浏览器Blob字节重建，文件重定向由传输桥跟随，偏差已记录。

## 供应商能力补充验证

- 真实`/v1/models`列出17个模型，包含gpt-image-2/gpt-5.5，不含规格示例sora-2/gpt-4o-mini-tts。模型目录不作为真实调用成功的证据。
- 一次真实gpt-5.5 `/responses` SSE验收返回400，供应商提示`unknown provider for model gpt-5.5`；数据库job为failed、冻结10点后全退10点、charged=0。本次不可用文本路由已移除，未改动已验收图片路由，证据`artifacts/acceptance/real-text.json`。真实文本成功验收未完成。

## M5 最终本机证据

- 后端类型检查与完整98项/936断言通过。真实PG多进程新库初始化、23表/一次迁移/六种子、运营编辑保留、独立S3桶CORS、失败固定日志通过；官方模板删除后不随seed复活及素材回收/回滚/发布竞争已补验，见m5-deployment.md。
- 前端类型检查与完整42项/133顶层断言通过；最终发行记录补齐后构建index-sSvZtVl8.js，34.04秒通过，与真实验收CyPMoyEb业务代码相同，仅增加I029的CHANGELOG文字。M5三模式18组通过（平台14、免计费1、纯前端3）；最终首页英文与轮询补验3组通过，可见/隐藏/恢复每5.5秒任务GET增量1/0/1。该可见性测试采用合成document状态与真实事件订阅，未冒充原生后台标签操作。均无page/transport异常，隔离数据清理成功，见m5-acceptance.md。
- 真实供应商完整电商模板：注册→真实首页→模板变量/图片→新画布→5张场景候选+3张适配，84.84秒；纯生成77.39秒。最多8次约束下实际8次gpt-image-2请求全部成功，3个适配请求的输入SHA256等于实际主图。验收工作区200→160、8个job/账本合计40点、8份S3归档哈希一致。
- 真实报告artifacts/acceptance/browser-m5-real-ecom/zero-call-retry/report.json，图片与ZIP同目录；已目视八图联系表及画布。首次仅因测试选择器重复匹配失败，供应商调用0且清理成功；修复后用独立一次性marker恢复，保留原记录，付费流程只执行一次。见m5-real-provider.md。8张实际像素均有I017所列供应商差异，保留原图。
- 最终密钥明文扫描481份源码/公开文档/构建资源/文本证据与应用库23表29行，无匹配；报告secret-audit.json。此结果与API转义/SSE脱敏测试共同限定验证范围，不承诺未来任意编码或日志。
- 双语文档MDX、Next路由类型与TypeScript最终验证通过；曾生成81页静态内容，但Windows standalone Shiki缓存导致重打包失败，删除缓存链接又被自动审批拒绝，未换工具删除。详见m5-docs.md与I028。

## 仍需外部条件的验收

1. 在具备Docker/MinIO且允许HTTP服务运行的机器执行干净部署和真实代理/CORS流程。当前机器无Docker/WSL，本地HTTP监听两次被自动审批拒绝；YAML/配置检查不能代替实机验证。
2. 配置真正可调用的文本、视频和语音供应商路由，再验证相应官方模板的真实输出。当前供应商文本调用被拒绝，未提供已验证的音视频能力；受控多模态流程已过。
3. 若要运行独立文档服务镜像，需要在合适环境完成standalone构建与启动验证。主应用Web生产构建已通过，与此独立文档问题分开。

用户已明确当前没有可用部署环境，要求先完成代码与本机验收。上述外部验收保留为后续事项，不阻塞本次交付，也不把未执行项标为成功。本次收尾仅调整交付范围记录并复核已有报告与构建产物，未再次调用付费图片接口。
