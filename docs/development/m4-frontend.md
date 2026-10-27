# M4 模板中心与画布流程接入

## 计划与阅读依据

按 M3 最终门槛通过后开始 M4。已读交付包 PRD 模板流程、技术方案第 7 章、UI04 模板页/画布运行条、任务 M4、权威 template.schema.json/example/OpenAPI，以及真实画布 store、生成分支、Agent 操作桥、图片存储、分组几何/引用和选择工具栏。

继续沿用 frontend-design、vercel-react-best-practices 和交付包 token；保留原前端 BYOK、插件和本地画布。纯转换/序列化/运行器由主线程负责 `web/src/lib/templates/`，共享类型与后端 CRUD/seed 由后端线程负责；本记录覆盖页面、服务和实际画布接入。

实施顺序：API 与图片准备；模板列表/详情/变量/SKU；画布实例化与撤销；真实生成结果、运行条和停止恢复；保存团队模板；嵌套组操作；自动回归与独立浏览器交接。

## 已实现

- `/templates` 提供搜索、分类和团队筛选，卡片最小 250px，详情区 340px、窄屏改为上下布局。使用真实 summary/detail 数据，显示流程节点、使用次数、所需变量与费用。画布左侧模板 tab 复用同一组件，插入当前视口；中心则创建本地新画布后一次插入。
- 变量支持文本、选择和 PNG/JPEG/WebP 图片；图片可上传或从当前品牌 SKU 选择，保存到原 IndexedDB 图片存储后才实例化。已有模板的默认图片也下载为本地图片。缺失必填项禁用插入并列明字段；插入只调用 use 计数，不执行生成，不扣点。
- 固定图片和图片变量值都通过模板纯转换映射到普通 image 节点。服务端 body 保持不变，准备好的本地固定图片通过 `options.images` 传入；使用前检查插件是否已启用，避免未知类型被旧 Agent 操作静默变成文本。节点 ID、连线、引用和内组 ID 由纯核统一重映射。
- 图形整体按视口中心平移并生成外层模板组；新画布通过已消费的路由 state 防止重复 effect 插入。提供“撤销插入”，只在插入快照仍为当前节点状态时展示，后续编辑仍可使用原 Ctrl/Cmd+Z 历史。
- 外层组 metadata.templateRun 保存在现有本地画布 store。运行条显示名称、步骤、状态、当前未完成部分的估价；执行前确认，步骤串行、同一步节点并行。完成节点不重复运行，失败节点可重试，停止使用原真实 AbortController。页面重开时将残留 running 转为 stopped，保留已完成节点和步骤。
- `handleGenerateNode` 现在返回明确 boolean；配置未就绪、节点不存在、取消、异常或图片/文本部分失败都返回 false。上下文 hydration 纳入 try/finally。模板请求强制写回同一目标，保留分组、原步骤标题和原提示词，避免用户“另建结果”设置破坏下游预置连接。步骤间同步提交状态后再读取参考图，防止 React 批处理导致下一步读取旧内容。
- 运行作用域按项目与账号/工作区隔离，切画布/切账号/切工作区时停止实际请求，旧运行回调不能写入新画布。删除运行中的外层模板组也会停止；普通组保留原先删除组、释放成员的行为。
- 视频刷新恢复复用已有 videoTaskId；自动恢复和点击继续共享同一节点的轮询 Promise，成功后立即写入相关模板的 completedNodeIds，避免再次创建任务或重复扣点。逐个节点成功也立即保存流程进度，不再等整步全部结束。切项目时中止旧恢复轮询并拒绝其晚到写回。
- 续跑开始先同步读取最新组状态，并记录当时未完成的既有视频任务；每个节点生成前再同步读取结果，若同一恢复任务刚刚完成则直接认定成功，排除自动恢复与手动续跑之间的窄竞态。已完整完成后明确“运行全部”仍会重新生成。
- 独立视频刷新专项发现模型列表晚于画布恢复时，旧单次 effect 会把任务留在错误状态。现仅捕获恢复时已有的任务候选，等待原模型可用后按项目/节点/taskId 启动一次；尚未就绪不写错误、不消耗恢复机会，已删除 BYOK 渠道不降级到其他模型。恢复轮询不依赖品牌加载，因为原生成请求已提交；保留任务的账号和工作区归属校验。
- 保存入口位于画布菜单和多选工具栏；无选区保存全画布。可将实际输入文本/图片标为变量，可上传封面。保存前验证图结构；固定图片通过 template_image 预签名上传，服务端固化后返回授权文件路径。提示“生成结果会清空，保留输入和生成步骤”。
- 保存时用 `buildGenerationConfig` 冻结实际模型/张数/尺寸/质量及音视频参数，与节点估价一起交给序列化器；节点显式参数优先。序列化器清除密钥、平台上下文、运行输出和本地 storageKey，转换 config 及历史结果为原位生成步骤，拒绝循环或范围外引用。
- 费用按当前有效模型 priceHint 计算；图片实际拆 n 个单图请求，估价也逐请求取整后乘张数。团队模板列表保留保存时的步骤估价，详情/运行条使用当前价格；无法估计时明确说明，BYOK 不扣平台点数。
- 内外组使用递归后代集合处理拖动、资源读取、选择保存、模板组删除和侧栏节点树；拖动外组时保留已有内组关系。普通解除外组会保留仍有子节点的内组。

## 原文件修改理由

| 文件 | 理由 |
| --- | --- |
| web/src/router.tsx、layouts/workspace-layout.tsx | 模板中心路由、导航和入口 |
| web/src/types/canvas.ts | 本地节点声明 templateRun 类型 |
| web/src/components/canvas/canvas-side-panel.tsx | 模板 tab；嵌套节点树展示 |
| web/src/components/canvas/canvas-top-bar.tsx、canvas-selection-toolbar.tsx | 保存团队模板入口 |
| web/src/pages/canvas/project.tsx | 实例化/运行/保存接入；真实 boolean 生成结果、原位重试、嵌套组拖动和模板组删除 |
| web/src/pages/canvas/hooks/use-agent-bridge.ts | 暴露既有快照撤销，生成 Promise 类型与实际结果一致 |
| web/src/lib/canvas/canvas-node-geometry.ts、canvas-resource-references.ts | 嵌套组后代与资源读取；解除外组保留内组 |
| web/src/lib/canvas/canvas-generation-helpers.ts | 重开画布时恢复中断模板状态 |
| web/src/i18n/locales/platform-zh-CN.ts、platform-en-US.ts | 引入独立模板双语文案和导航 |
| web/tests/platform-gateway.test.ts | 隔离平台上下文里的真实服务/估价/恢复回归 |

新增 templates API、components/templates、pages/templates、use-canvas-templates、canvas-group-members、独立双语文案和分组回归。没有新增 UI 库、业务表字段或画布云同步。

## 自动验证与待完成验收

- `bun run typecheck`：通过。
- 完整前端 `bun test`：主线程最后全量复验 39 项、125 个顶层断言通过，包含平台隔离子进程。
- 平台子进程原 23 项 M1–M3 回归继续通过，新增模板 API/上传/估价/恢复/准备/参数快照 6 项；嵌套组新增 3 项、6 个断言。
- 第一版生产构建通过（27.79s，`index-4ojnExcE.js`）；仍只有既有大 bundle 与静态/动态 import 混用警告。独立验收所需模板 ID DOM 属性随后补入，最终构建由交接记录更新。
- 模板 ID DOM 属性、裸模型 ID 估价和逐请求取整的最终专项通过：模板平台 6 项、19 断言；完整平台隔离套件共 29 项。视频恢复修复后类型检查通过，纯核与分组 15 项、64 断言通过；新构建待独立浏览器补视频刷新回归。
- 最终只读视频轮询保护回归 1 项、8 断言通过：品牌未加载时可查询已有任务，但新建仍拒绝且旧账号不能查询。最终构建 `index-DmlSXDY7.js` 通过（26.86s）；其恢复逻辑与已通过独立视频刷新 6 组的 `index-ComBTwC-.js` 一致，仅提取可测 helper 并修正表单合法 `constructor` 变量键的自有属性判定。六模板全套浏览器证据由独立验收汇总。
- 真实浏览器六模板运行、插入/撤销、保存/重新使用、失败/停止/恢复、移动端布局由独立验收执行；目前不以纯核测试代替浏览器结果，不称为真实模型出图。本子任务不启动 HTTP 监听。

## M5 已记录边界

- `BILLING_ENABLED=false` 时，模板详情与运行确认应根据 `useCreditsStore.billingEnabled[workspaceId]` 说明平台不扣点；不能继续显示会扣估计点数，也不能误写成 BYOK。按主线程安排在 M4 六模板门槛通过后完成该收尾验收。
