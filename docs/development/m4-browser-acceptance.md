# M4 独立浏览器验收

2026-10-25：最终前端构建 `index-DmlSXDY7.js`、`index-BZ4LRWx0.css` 验收通过。六套官方模板完整流程 **27 组 / 50.94 秒**，视频刷新恢复专项 **6 组 / 22.53 秒**，均无浏览器 pageerror 和传输错误。独立传输自检 **7 组**通过；新增验收脚本已通过服务端 TypeScript 检查和 Python 语法检查。

## 环境与证据边界

- 隔离 headless Chrome、真实打包的 React 应用、真实 Hono `app.request`、本机 PostgreSQL `ic_test`、已存在的本机 S3rver。
- 不启动 HTTP 监听。Playwright 路由通过 Bun stdin/stdout 传递业务请求和响应，认证使用真实 HttpOnly Cookie；S3 上传/读取使用本次随机独占桶。
- 本轮进程的注册赠点设为 2000，以支撑全部流程；正式注册赠点逻辑另由 M2 的 200 点浏览器验收覆盖。
- 图片、SSE 文本、WebM 视频和 WAV 音频来自受控本地供应商。没有调用真实付费模型，不能据此声称真实供应商文本/音视频、最终图像质量、实际输出像素/视频时长或生产部署通过。I-017、I-024 的供应商限制仍适用。
- 六套测试模板直接复制 `officialTemplateDefinitions`，只把显式 `metadata.model` 替换为相同能力的随机受控模型；逆向替换后与原定义严格 JSON 相等。报告保存 `sourceTemplateId`、副本 ID、模型映射和等价断言；未改现有模型路由、原模板计数、节点、连线、变量或步骤。固定官方 ID 的幂等 seed 见后端验收。
- `/api/files` 真实返回授权后的 302，验收传输跟随签名地址读取真实 S3 字节后回给浏览器。虚拟文档没有真实本机 HTTP 来源，因此此方式不覆盖生产跨域 CORS/重定向部署。
- Chrome CDP 的 `postData` 省略 multipart 文件，初版直接转发导致缺失 boundary。已在测试传输层捕获实际 FormData 字段、文件名、MIME 与原始字节，由 Bun 用匹配的新 boundary 重建，删除原 Content-Type/length；独立 PNG SHA256 检查证明字节一致。该问题不是业务代码缺陷。
- 每轮精确清理本轮注册用户、工作区、六个模板副本、模型、供应商和独占存储桶；最终两个报告 `cleanup.ok=true`。

## 六套模板结果

| 官方模板 | 成功生成节点 / 输出 | 实际扣点 | 额外覆盖 |
| --- | --- | ---: | --- |
| 电商主图套图 | 4 个生成节点，5 张场景候选 + 3 张尺寸图 | 40 | 产品上传、品牌 SKU、文本/select 变量；3 个后续请求的输入 SHA256 均等于实际生成的主图且不同于原 SKU；尺寸请求分别为 1024×1024、1088×1920、1248×1664 |
| 商品详情页长图 | 1 文本 + 3 板块图 + 1 长图 | 21 | 中间并行步骤指定一个节点首次失败；失败时未执行长图；继续后只重试失败节点，成功同伴不重复执行，失败请求已退款 |
| 短视频分镜 | 2 文本 + 3 分镜图 + 3 视频 + 1 音频 | 171 | 双文本节点在上游同时等待；点击停止后两个真实请求均 Abort 并退款；刷新后继续完成四种能力 |
| 品牌活动海报 | 1 文本 + 2 图片 | 9 | 完整界面运行、输出落入本地存储并导出 |
| 小红书种草组图 | 1 文本 + 3 图片 | 25 | 完整界面运行、输出落入本地存储并导出 |
| 门店物料延展 | 1 文本 + 3 图片 | 17 | 完整界面运行、输出落入本地存储并导出 |

插入每套模板前后对比完整账单摘要和供应商轨迹：无扣费、无生成任务；仅 `use_count + 1`。局部 ID 全部重映射，变量出现在真实画布内容，图片原字节可从导出 ZIP 读回。电商模板单击“撤销插入”后，节点和连线均为空。

已执行的电商流程通过真实 Ctrl+A、画布菜单保存为团队模板；产品图和卖点文本勾选为变量。服务端返回永久模板文件 URL 和文本默认值，生成节点没有历史 content/images/storageKey/templateRun/账号凭据。再次插入时读取永久图片、使用默认变量、生成全新 ID；整套再次运行并导出 8 张新图片，实际仍为 40 点。保存后产生的嵌套组也得到真实界面覆盖。

## 视频刷新去重与 I-027

独立创建两套短视频流程，把真实视频任务的轮询响应保持为等待状态；导出确认 3 个节点均已保存 `videoTaskId` 后刷新：

1. **任务尚在轮询时点击继续**：复用现有任务/Promise，完成后再执行旁白；上游 `POST videos` 总数仍为 3，整套实际扣费 171 点。
2. **等待自动恢复完成后再继续**：刻意延迟平台模型列表 750ms，验证恢复能等待模型配置就绪；3 个视频成功后已写入 `templateRun.completedNodeIds`，继续运行跳过这 3 个视频，仅执行余下步骤。上游视频创建仍为 3 次，整套仍为 171 点。

初验确实复现了自动恢复早于模型列表、只运行一次后卡错误的产品竞态；最终构建修复并通过上述两分支。这与此前单纯“停止后刷新继续”的场景分别留证，不以其中一项代替另一项。

## 视觉与独立代码复核

- 人工检查桌面模板中心、390px 模板列表及完整变量详情截图；响应式稳定后 document/body 均不超过视口。下拉关闭动画期间的旧 portal 位置已通过等待布局稳定排除。
- 最终画布侧栏五个标签保持单行并可横向滚动，未再被挤成竖排。画布截图、每套插入/完成 ZIP 均留存；测试图片为不同颜色的 64×64 PNG，产品图为独立 96×64 PNG，以避免错误引用原图也通过哈希断言。
- 独立复核共享语义验证、实例化、反向序列化、串行步骤/并发节点运行器：ID 与变量单次替换、组关系/引用重映射、生成依赖顺序、成功节点即时保存、失败续跑、停止阻止下游和隐私字段清理均符合本阶段约定。专门的后端/纯函数断言计数分别见 `m4-backend.md`、`m4-core.md`。

## 可复现命令与文件

先加载 `.tools/local-env.ps1` 中的本机环境（不输出凭据），在项目根目录执行：

```powershell
$env:PYTHONIOENCODING = 'utf-8'
python scripts/templates_browser_acceptance.py --transport-smoke --output artifacts/acceptance/browser-m4-transport
python scripts/templates_browser_acceptance.py --output artifacts/acceptance/browser-m4
python scripts/templates_browser_acceptance.py --video-recovery --output artifacts/acceptance/browser-m4-video-recovery
```

三种模式顺序执行，避免多轮随机模型同时可见影响默认模型选择。

- 主报告：`artifacts/acceptance/browser-m4/report.json`。
- 视频恢复报告：`artifacts/acceptance/browser-m4-video-recovery/report.json`。
- 传输报告：`artifacts/acceptance/browser-m4-transport/report.json`。
- 桌面详情：`browser-m4/m4-01-template-detail.png`；移动详情：`browser-m4/m4-03-template-detail-mobile.png`。
- 每套 `*-inserted.zip`、`*-completed.zip` 包含画布数据和真实媒体字节；视频专项另有刷新前及自动恢复后的 ZIP。
- `m4-failure.*` 是调试时保留的历史失败截图/HTML，最终状态以同目录 `report.json` 为准，不代表最终验收失败。

本阶段界面功能与受控端到端验收通过。Docker/Compose、真实 MinIO、真实 HTTP 反代和真实文本/视频/语音供应商未由本验收执行。
