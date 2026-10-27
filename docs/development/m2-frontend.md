# M2 前端实现与验收记录

## 计划与阅读依据

先阅读 AGENTS、交付包 M2 任务与 UI 规范、OpenAPI 的 gateway/models、billing 和 admin 契约，以及真实后端实现的返回字段。阅读原 config store、模型选择器、图片/文本/视频/语音请求、画布生成与视频恢复路径、工作台日志、配置弹窗，再扩展实际调用链。继续使用 frontend-design 和 vercel-react-best-practices，沿用 Ant Design、ProTable、React Query 与现有 Zustand。

实施顺序为：只读平台渠道与请求上下文；余额和错误反馈；计费与平台管理页面；估算与双语文案；跨账号、跨工作区及任务恢复回归；记录未执行项。

## 已实现

- 平台开启时注入虚拟只读渠道，模型和价格来自 `/api/gateway/v1/models`。平台频道不持久化，不保存供应商 Key，不允许编辑/删除和自定义脚本，网关请求不进入用户本地代理。模型下线或显式选择的 BYOK 渠道被删除时，请求直接失败，不回退到另一个计费渠道。
- 使用 HttpOnly Cookie 会话访问平台网关；按实际请求带工作区、项目、节点、来源和可选品牌上下文。`useEffectiveConfig` 及请求配置冻结工作区与账号会话代次，读取图片等异步步骤之后也不会误用新工作区或新账号。
- 顶栏、侧栏与画布显示当前余额。Axios 响应和文本 SSE 接入余额头；SSE 结束后重新读取结算余额。402 显示点数不足或成员额度弹窗，普通上游错误维持既有提示行为。
- 图片、视频工作台和画布配置节点显示模型单价、生成估算、生成后余额和失败退点说明。文本批量按独立请求数量预扣估算；图片工作台按独立单图请求逐次向上取整，画布批量按网关请求 n 向上取整。未启用计费时隐藏按钮点数费用；无法可靠计算的参数显示单价，不编造估算。
- 用量与计费页使用真实 summary、daily、members、jobs、transactions、packages。包含四项统计、每日堆叠图、成员上限、游标分页任务/流水、全量账单 CSV、owner 兑换码、模型定价与 BYOK 说明。普通成员不请求管理流水和成员用量，充值区按 billingEnabled 控制。
- `/admin` 仅平台管理员可见：供应商创建/编辑/删除/连通性测试、模型与路由及四类定价、工作区搜索/发点/套餐设置、兑换码生成和 CSV 导出。供应商 Key 只在密码输入框输入，关闭或保存即重置；列表只读服务端 last4。模型/供应商变化立即使实际平台模型查询失效并刷新。
- 新文案同时提供中文和英文；页面私有图表样式放在 billing.css，图表 token 使用指定图片色 `#1c1917`、视频色 `#c08a3e` 和主题变体。未引入图表 UI 库，新增 decimal.js 与服务端一致处理小数向上取整。

## 审查问题与修复

| 发现的问题 | 已实施修复 | 回归证据 |
| --- | --- | --- |
| 旧用户的 401 在新用户登录同一工作区后清空新会话 | 请求捕获会话 generation，401 同时比较工作区和 generation；clear、认证开始及账号变化更新 generation | 实际 platformApi adapter 挂起 A 请求、登录 B、释放 A 的 401，B 保持登录 |
| 旧请求余额头、402 或 Blob 解析在新账号后污染余额与提示 | Axios、SSE、余额刷新及错误记录比较 generation；Blob await 后再次检查；账号变化重置余额缓存 | 旧头不覆盖 B 的 200 点，旧 402 不弹出；当前账号 Blob 402 正常显示 |
| 异步生成读取图片后动态读取工作区，切换可能误扣新工作区 | 有效配置与请求配置冻结 workspaceId，发起平台请求前拒绝旧账号代次 | 同一快照切区后头仍是 A；换账号后发前拒绝 |
| 显式失效 BYOK 渠道回退到首个平台渠道 | `resolveModelRequestConfig` 校验编码渠道与模型必须仍存在 | 删除 BYOK、删除平台模型、空渠道均抛错 |
| 视频刷新/恢复丢失任务原工作区 | task 保存 workspaceId/userId；画布 metadata 同步保存；轮询恢复原归属；不同账号或工作区的自动恢复跳过，不标任务失败 | 任务序列化后恢复仍请求 A 工作区；换账号拒绝 |
| 条件渲染导致费用组件 Hook 数量变化 | 所有 Hook 在提前返回前执行 | 类型检查及代码复核 |

## 原文件修改理由

M1 原文件理由继续见 m1-frontend.md；M2 增量如下。

| 原文件 | 修改理由 |
| --- | --- |
| web/src/stores/use-config-store.ts | 平台虚拟渠道、只读/持久化隔离、模型价格、上下文快照、平台脚本与代理限制、显式失效选择拒绝回退 |
| web/src/services/api/image.ts | 给图片/文本请求增加平台头，SSE 记录冻结余额并在终止后读取结算余额 |
| web/src/services/api/video.ts、audio.ts | 增加平台头；视频任务保存与恢复账号/工作区归属 |
| web/src/pages/canvas/project.tsx | 传项目来源上下文；保存/恢复视频任务归属，跨区自动恢复不污染日志 |
| web/src/types/canvas.ts | 视频任务的原工作区与账号元数据，仅浏览器本地节点数据，无业务数据库字段变更 |
| web/src/lib/canvas/canvas-generation-helpers.ts | 生成配置携带节点 ID 与画布来源 |
| web/src/pages/canvas/hooks/use-plugin-host.tsx | 插件通过已有生成入口时携带 plugin 来源 |
| web/src/pages/image/index.tsx、video/index.tsx | 工作台来源与生成费用提示；视频历史恢复尊重任务归属 |
| web/src/components/canvas/canvas-top-bar.tsx | 复用轻量余额入口 |
| web/src/components/canvas/canvas-config-node-panel.tsx | 模型费用及生成按钮估算，文本批量计算 |
| web/src/components/model-picker.tsx | 在真实平台模型旁展示定价提示 |
| web/src/components/layout/app-config-modal.tsx | BYOK 标签与说明；平台渠道隐藏编辑/删除 |
| web/src/router.tsx | 新增受保护 admin 路由 |
| web/src/styles/globals.css | 仅增加跨页面图表颜色 token，计费页面专有 CSS 单独存放 |
| web/package.json、bun.lock | 增加 decimal.js 10.6.0，避免浮点误差导致错误费用提示 |

新增 `services/api/platform`、`stores/use-credits-store.ts`、`components/billing`、`pages/admin` 与扩展后的 `pages/billing` 承载平台实现。M1 新增会话、布局和语言文件为本阶段继续扩展文件，不覆盖上游业务代码。

## 已执行验证

- `web bun run typecheck`：通过。
- `web bun test`：24 项、61 个顶层断言通过，包含原有 15 项测试、M1 会话/运行配置和平台独立子进程入口。
- 平台启用子进程 `IC_PLATFORM_TEST_PROCESS=1 VITE_PLATFORM_API_BASE=/api bun test tests/platform-gateway.test.ts`：14 项、48 个断言通过。使用真实业务模块及受控 Axios/fetch transport，不启动 HTTP 监听、不请求真实模型、不把它称为真实模型生成验收。
- 14 项覆盖：只读渠道/不持久化、存储注入清除与保留 BYOK、代理/脚本隔离、失效选择、快照归属、跨账号 401、旧余额/402/Blob、余额刷新乱序与 reset、真实 Axios 拦截器、视频序列化恢复、SSE 结束结算、1536/1537 图像边界/小数/Unicode 定价、CSV 公式注入、双语键一致且全部静态引用存在。
- 生产构建与服务端真实供应商验收由主线程整体验收记录归档，本文不重复宣称未由本子任务执行的验证。

## 尚未执行的验收

本子任务未启动任何 HTTP 服务，未执行浏览器交互、截图或 Docker/MinIO 部署验收。自动审批曾拒绝应用 HTTP 启动，未尝试替代监听绕过。浏览器验收需要覆盖：平台/BYOK切换、费用弹窗、账单/兑换、管理员四个面板、长表格和手机布局、跨账号视频恢复。以主线程最终 acceptance 证据为准，不能仅根据上述类型和模块测试把完整交付标为成功。

建议版本归纳：`[新增] 平台模型网关接入实时点数、用量账单与兑换，并提供供应商、模型定价和工作区额度管理，保留自带 Key 模式。`
