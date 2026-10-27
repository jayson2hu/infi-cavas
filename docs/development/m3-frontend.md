# M3 品牌套件前端实现与验收记录

## 计划与阅读依据

已阅读 AGENTS、M3 计划、交付包 PRD/技术方案/任务 3.1–3.5、品牌页和画布 UI 规范、04 品牌资产 PNG、OpenAPI brands/uploads/files 契约，以及真实品牌后端与共享注入实现。继续遵循 frontend-design 与 vercel-react-best-practices，指定设计稿优先，不替换 UI 库。

修改前已阅读品牌相关的配置 store、会话及请求客户端、画布顶栏/侧栏/配置节点/提示词面板、生成配置构造、插件生成、工作台、图片本地存储、普通图片节点创建和 ZIP 导出路径。

实施顺序：真实品牌 API 与选择 store；品牌规则快照和默认参数；资产页与权限；画布选择/开关/SKU；BYOK 文字注入；并发边界回归、类型检查与构建；交给独立浏览器验收。

## 已实现的行为

- `/brand` 展示真实工作区品牌；`/brand/:id` 实现概览、产品 SKU、风格参考、提示词规则和生成记录五个页签。概览包含 Logo、ColorPicker 色板、SKU、风格参考、规则、实际注入预览和权限卡片，按指定暖色 token 和响应式网格布局。
- owner/admin 可创建、设默认、设置强制套用和编辑者；普通成员仅在 canEdit 时编辑。普通编辑者不能删除默认或强制品牌。只读视图隐藏编辑控件，生成记录仍由服务端按成员权限过滤。数据库没有最近编辑者字段，前端仅显示实际更新时间，不伪造姓名。
- 图片上传先请求预签名，原样带签名返回的 headers PUT 到对象存储，再提交 objectKey。只接收 PNG/JPEG/WebP，单图 20MB 上限来自规格。支持批量上传、素材名称/规格/标签编辑、删除、风格参考 attachOnGenerate 开关；失败后保留尚未上传的队列。
- 提示词规则停止输入 300ms 后自动保存；按序执行请求并跳过过期草稿，避免旧写入覆盖新规则；保存后使真实 injection-preview 查询失效。示例提示词也按 300ms 防抖刷新。预览按会话代次、工作区、品牌、更新时间、模型和提示词隔离，使用服务端与网关相同格式。
- 当前品牌选择仅将极小的品牌 ID 写入 `infinite-canvas:brand:<userId>:<workspaceId>`。完整品牌、素材、规则和显式参数覆盖仅驻内存。恢复 ID 时再次读取品牌列表验证；删除或失效 ID 回到有效默认品牌。账号变化重置状态；旧工作区的异步 mutation 刷新在 store 入口即拒绝，不能取消当前加载。
- 画布顶栏和工作区侧栏提供当前品牌选择；配置节点和普通图片/文本/视频/语音提示词面板提供 metadata.brandKit 开关。关闭时平台请求带 `X-IC-Brand: none`；强制套用时开关禁用并说明原因。生成配置冻结品牌规则、工作区与会话代次，切品牌只影响后续生成。
- 品牌 defaultParams 的 API 键在 `lib/platform-brand.ts` 单点映射到 AiConfig。节点显式参数优先于品牌默认参数，品牌默认参数优先于全局配置；工作台显式修改品牌默认参数时只写当前品牌的内存覆盖，切换账号/工作区/品牌清空，不改写全局默认。n 同时映射图片 count 与 canvasImageCount；seconds、resolution、音频参数、文本 temperature/max_output_tokens 和模型选择也接入实际请求。插件未显式传参数时保留有效品牌默认值。
- BYOK 使用共享纯函数 `shared/brand-inject.ts` 的纯文字 instructions，添加到原 systemPrompt 前；图片/文本沿用现有系统提示入口，视频前置文字、音频使用 instructions。BYOK 不追加品牌参考图，不使用平台余额接口生成，也不扣平台点数。
- 左侧品牌页签展示真实 SKU，既能点击插入，也能拖入指定画布位置。拖拽载荷只有账号代次、工作区、品牌和资产 ID；落点时再次从实际品牌接口找素材，不信任任意 URL。下载完成和浏览器本地图片保存完成后均重新校验上下文，再使用原普通图片节点和 image storageKey；现有 ZIP 导出会打包这张原图。
- 左侧品牌页签同时展示当前品牌的 Logo 变体、品牌色、风格参考图与“随生成附带”状态、必带描述及避免内容摘要；SKU 采用三列缩略图。全部复用当前已加载品牌数据，不新增接口请求，空内容提供中英文提示。
- `/files` 图片下载只使用同源 Cookie，不附带自定义工作区头，避免 302 到 S3 后触发生产 CORS 拒绝；后端按对象路径校验用户对工作区的成员权限。

## 原文件修改理由

| 原文件 | M3 修改理由 |
| --- | --- |
| web/src/stores/use-config-store.ts | 生成配置携带冻结的品牌规则；使用统一默认参数映射；品牌内存覆盖与 BYOK 文本注入；旧账号配置发前拒绝 |
| web/src/lib/platform.ts | 根据节点开关与强制规则设置品牌头；品牌尚未加载时阻止错误归属请求 |
| web/src/components/layout/platform-runtime.tsx | 加载当前账号/工作区的品牌状态 |
| web/src/router.tsx、layouts/workspace-layout.tsx | 品牌路由、导航和跨页面品牌选择入口 |
| web/src/components/canvas/canvas-top-bar.tsx | 当前品牌切换，保留原画布扁平样式 |
| web/src/components/canvas/canvas-side-panel.tsx | 新增品牌页签，复用既有资产插入回调 |
| web/src/components/canvas/canvas-config-node-panel.tsx、canvas-node-prompt-panel.tsx | 节点品牌开关与强制套用说明 |
| web/src/types/canvas.ts、lib/canvas/canvas-generation-helpers.ts | 本地节点 metadata.brandKit 以及实际生成上下文传递 |
| web/src/pages/canvas/project.tsx | 识别品牌 SKU 拖拽，复用 createImageFileNode；本地异步保存完成后再验证上下文 |
| web/src/pages/canvas/hooks/use-plugin-host.tsx | 插件没有显式指定 count 时不覆盖品牌 n 默认值 |
| web/src/pages/image/index.tsx | 生成批量数读取有效配置，使品牌 n 和费用提示一致 |
| web/src/services/api/image.ts | 文本默认 temperature/max_output_tokens 接入 OpenAI/Gemini 请求 |
| web/src/services/api/video.ts、audio.ts | BYOK 视频/语音使用品牌文字，保持不附加参考图 |
| web/src/i18n/locales/platform-zh-CN.ts、platform-en-US.ts | 引入品牌中英文文案和导航键 |
| web/tests/platform-gateway.test.ts | 在隔离平台运行态中增加真实模块的 M3 回归 |

新增平台 brands API、use-brand-store、platform-brand/brand-drag、components/brand、pages/brand 和独立品牌语言文件，页面专有样式保留在 brand.css。shared/brand-inject.ts 由后端子任务维护，前后端直接复用；无新增业务表字段、画布云同步或额外 UI 库。

## 审查中修复的问题

1. `load` 入口若未检查工作区，旧上传 finally 的 refresh 可递增 revision 并清掉新工作区品牌。现先验证账号代次和工作区，再允许任何状态变更，并有并发回归。
2. S3 跳转下载携带 `X-IC-Workspace` 会与生产允许的 CORS headers 不匹配。现下载使用 same-origin credentials 且不发送该头，保留下载前后的账号/工作区验证。
3. 下载后本地 `uploadImage` 仍有异步边界。点击插入和拖入均在本地保存后再验证，防止切账号/切工作区后插入错误画布。
4. 品牌默认 n 仅映射 count 时会被画布 canvasImageCount 覆盖；工作台也曾读取原始 config.count。现两条实际生成路径均读取有效品牌数量，显式节点数量仍最高优先。
5. 工作台参数覆盖若同时写全局配置，会残留到其他品牌。现属于当前品牌默认值的覆盖仅写 use-brand-store 内存，并在上下文变化时清空。

## 自动验证与浏览器交接

- `bun run typecheck`：通过。
- 完整 `bun test`：24 项、61 个顶层断言通过，包含独立平台子进程入口。
- `IC_PLATFORM_TEST_PROCESS=1 VITE_PLATFORM_API_BASE=/api bun test tests/platform-gateway.test.ts`：23 项、90 个断言通过，其中新增 M3 9 项、42 个断言。覆盖持久化 ID 隔离/验证、旧工作区刷新拒绝、品牌选择乱序、none/enforced、覆盖清空、参数优先级、真实 BYOK 请求不附参考且不扣点、SKU 下载 CORS、上传签名头及切区中止关联。原 M2 回归与双语键校验同时通过。
- 生产构建通过，仍仅有既有的大 bundle 与静态/动态 import 混用提示。最终构建证据与独立浏览器结果由主线程 acceptance 汇总。
- 300ms UI 操作、真实 SKU 拖入并 ZIP 解包原字节、默认/强制开关、桌面与 390px 布局属于独立浏览器验收，不能用模块测试替代。本子任务不启动 HTTP 监听；主线程使用已批准的浏览器测试桥进行实际页面验证。
- 随后按 UI04 补齐侧栏 Logo/风格参考/规则摘要，类型检查、双语键专项和生产构建再次通过，入口为 `index-Dc8w7lWM.js`。独立浏览器最终 7 项全部通过（18.77s），包含侧栏完整内容、真实 SKU 拖入与 ZIP 原字节；3 次 PUT / 4 次 GET 返回 200，pageerror 为 0。完整证据见 `m3-browser-acceptance.md` 与 `artifacts/acceptance/browser-m3/`。

建议版本归纳：`[新增] 工作区品牌资产支持色板、SKU、风格参考和提示词规则，画布生成可切换或强制套用品牌，保留 BYOK 纯文字规则与本地素材导出。`
