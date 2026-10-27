# M5 真实电商模板验收

2026-10-25，在业务验收构建 `index-CyPMoyEb.js` / `index-B4wda029.css` 上完成一次真实供应商电商模板流程。`passed`、`functionalPassed`、`withinThreeMinutes` 均为 true：从注册到 8 张图完成为 **84.84 秒**，生成阶段为 **77.39 秒**，含归档读取和截图的完整脚本为 91.86 秒。页面与传输异常均为 0。之后仅补I029的CHANGELOG文字，最终构建变为index-sSvZtVl8.js；图片生成业务逻辑未变，没有重复付费运行。

## 实际路径与结果

真实注册 UI → 新首页推荐 → 官方“电商主图套图”独占副本 → 上传已有白色陶瓷杯验收图 → 填写真实商品描述并选择“木质桌面 · 清晨侧光” → 新画布 → 运行全部 → 5 张候选主图 → 3 张适配图。模板内容与官方定义相同，仅通过独占模型 ID 路由到实际 `gpt-image-2`，未替换输出或修改模板提示词、步骤、数量和尺寸。

- 供应商为已有配置的真实 HTTPS 图片供应商，8 次 POST 均实际使用 `gpt-image-2`、n=1；只允许图片 generations/edits 路径，不调用文本/视频/音频。
- 5 次第一步请求的参考图 SHA256 都等于上传商品；导出主图的 SHA256 属于这 5 次真实输出且不同于原商品；3 次下游请求的参考图 SHA256 都等于该生成主图。
- 8 个 job 均 succeeded，总计 40 点；顶栏无需刷新显示 200→160。每个 job 的 hold/settle 流水金额和等于其扣费负值。
- 8 个归档对象均经真实鉴权文件接口和 S3rver 读取、解码；SHA256 分别匹配对应真实供应商输出。画布 ZIP 含原商品和 8 张结果，共 9 个媒体文件。
- 退出清理本次 1 个用户、工作区、独占模型/模板/供应商和桶；真实图片与报告保留在本地验收目录。

## I017：供应商实际尺寸偏差

| 输出 | 请求像素 | 实际像素 | 数量 |
| --- | --- | --- | --- |
| 场景候选主图 | 1024×1024 | 1374×1145 | 5 |
| 方形适配图 | 1024×1024 | 1254×1254 | 1 |
| 9:16 适配图 | 1088×1920 | 941×1672 | 1 |
| 3:4 适配图 | 1248×1664 | 1086×1448 | 1 |

平台转发了规格要求的尺寸，但供应商未返回对应像素。没有偷偷裁切或重采样；工作流、引用、计费和归档通过不等于供应商像素合同通过，I017 保留。主线程已目视画布、原图及八图联系表：输出保持白色陶瓷杯与木桌晨光场景；联系表只作缩略预览，8份原始PNG未修改。

## 零调用恢复与证据链

首次显式执行在选择默认场景时遇到验收脚本 strict locator 冲突：选中标签与下拉选项同名。该次 `providerTrace=[]`，清理成功，未发真实供应商请求。定位已限定在可见下拉框内，另用受控浏览器验证默认选项可选并完整插入、供应商调用为 0。

首次 `paid-run.started.json` 和失败 `report.json` 保持原样。一次恢复入口只有在原报告明确失败、非预检、供应商 trace 严格空数组、cleanup.ok/storageCleaned 均 true 时才允许；通过排他新建 `paid-run.zero-call-retry.started.json` 防止再执行。恢复报告保留原报告 SHA256 `086773c76712c05964a04b51d5fd1f3fba565b597b8a723b44e6c20a000b227b`。本轮累计实际付费调用仍为 8 次，没有重复付费运行。

- 首次记录：`artifacts/acceptance/browser-m5-real-ecom/report.json`、`paid-run.started.json`。
- 成功记录：`artifacts/acceptance/browser-m5-real-ecom/zero-call-retry/report.json`、同目录 ZIP/截图/real-output-1.png 至 real-output-8.png。
- 入口：`scripts/real_ecom_browser_acceptance.py`；服务端限流与真实 trace：`server/scripts/browser-real-provider.ts`。普通浏览器脚本默认仍为受控供应商，真实模式需要显式参数和环境开关；密钥从 `.tools/provider-secret.enc` 仅解密到内存，再以本次隔离 secret 加密到独占供应商行，没有写入报告、页面或日志。

浏览器 UI、真实 Hono `app.request`、PostgreSQL、对象读写和真实图片 HTTPS 上游均参与此次流程。HTTP 监听、Nginx、Docker Compose、实际 MinIO、真实文本/视频/语音供应商仍不在本次证据范围。
