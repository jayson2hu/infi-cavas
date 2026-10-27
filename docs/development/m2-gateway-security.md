# M2 网关安全、取消与并发复核

已阅读真实源码 `gateway/router.ts`、`upstream.ts`、`archive.ts`、`auth.ts`、`moderation.ts`、`billing/ledger.ts`、`lib/s3.ts`、现有网关测试，以及权威规格对应的媒体与网关流程。只调整网关及安全辅助代码，不增加数据库字段、请求大小限制、重试次数或超时边界。

## 发现与修复

| 问题 | 修复与修改理由 |
| --- | --- |
| 序列化 JSON 中的 Unicode 转义可绕过明文 Key 替换 | `upstream.ts` 在 JSON 解码后递归脱敏字符串与键名；错误信息同样先解析再脱敏。图片原始下载 URL 只在服务端使用，完成下载后删除 URL，再脱敏返回元数据。 |
| Key 分散在多个 SSE delta 事件时可被客户端重新拼出 | 新增 `response-stream.ts`，使用 `eventsource-parser` 解析事件，保留与实际 Key 长度相关的未确定尾部，在跨事件脱敏时保留原输出项的归属。没有新增固定缓冲大小。 |
| 仅由 event 字段表达的失败或无终态 EOF 被当作成功 | 同时识别事件名与 JSON type；失败、未完成 EOF、消费取消和请求中止走幂等退款。收到明确完成事件即可结束并关闭上游读取，不等待连接自然断开。完成帧仅在结算成功后发出。 |
| 流式完成消息包含的文本未经过结果审核 | `moderation.ts` 统一提取嵌套输出文本；增量文本、output_text.done 和 response.completed 中的输出都经过既有结果审核 hook。 |
| 同步结果可能在取消或后台退款后仍被报告成功 | 图片、非流式文本和音频结算前检查中止；结算结果必须为 succeeded 才可返回并归档。视频建任务时按工作区、job 顺序加锁，确认 job 仍为 held。 |
| 视频完成、失败及排队响应竞争导致任务镜像与账本矛盾 | `router.ts` 中先通过账本幂等 settle/refund，再按工作区、job、video task 顺序加锁，以账本终态更新镜像；迟到响应不能覆盖已完成或已退款状态。 |
| 视频内容端点将 HTTP 200 JSON 错误当作视频直接透传 | 视频必须具有 video/* 或 application/octet-stream MIME；图片、音频及归档媒体检查已知 Key 的原始字节，视频流跨 chunk 检查。读取已归档视频时验证对象属于当前工作区。 |
| 参考图只检查 File 数量 | 新增 `media.ts` 校验已使用字段中的非空文件、PNG/JPEG/WebP 文件头与 MIME 一致，mask 仅允许 PNG；在 hold 和上游请求前拒绝伪装内容。 |
| 视频下载尚未进入归档队列时清理程序会提前继续 | `archive.ts` 的 trackArchive 跟踪完整下载、写对象、写元数据过程，drainArchives 可等到结束。 |
| 多实例同时创建 S3 桶时，已经归当前账号所有的桶仍报错 | `lib/s3.ts` 遇到 BucketAlreadyOwnedByYou 后重新 HEAD 验证；其他错误继续抛出。 |

## 可复用接口

- `validateReferenceImages(body: FormData): Promise<void>`：检查 image、image[]、first_frame、last_frame、mask；拒绝非 File、空文件和文件头/MIME 不符。该函数不处理 S3 上传、不新增大小限制，也不等价于完整图像解码。
- `assertNoMediaSecret(bytes: Uint8Array, secrets: string[]): void` 与 `guardMediaStream(body, secrets)`：防止已知平台供应商 Key 以原始字节出现在媒体响应。
- `redactPayload(value: unknown, secrets: string[]): unknown`：对已解码的 JSON 递归脱敏。
- `responseText(value: unknown): string`：提取 Responses 的输入、输出与嵌套 content 文本，供现有审核 hook 使用。
- `trackArchive(jobId, promise)`：登记完整异步归档过程，保持原 enqueueArchive 返回值行为。

## 验收证据

在本地 Bun 1.3.14、真实 PostgreSQL 16 测试库与 S3rver 条件下执行：

```text
bun run typecheck
bun test tests/gateway-stream.test.ts tests/gateway.integration.test.ts
```

类型检查通过；21 项测试通过、0 失败、130 次断言。覆盖原网关功能、Unicode 转义脱敏、跨事件脱敏及输出项归属、显式完成但不关闭的上游、失败事件名、无终态 EOF、取消、已退款迟到图片、参考图 MIME/文件头伪装、双方先后获胜的视频竞争、视频 JSON 错误拒绝、跨工作区视频访问，以及带凭据图片 URL 的服务端下载。

并发测试用 Promise 屏障明确安排请求先后，不依赖 sleep；测试清理等待完整归档任务后只删除本次 fixture。测试仅注入受控上游响应，不属于真实模型出图或真实视频生成验收；S3rver 结果也不代表 Docker/MinIO 已验收。本次没有启动 HTTP 服务。

已检查 todo 与 pending-test：本专项没有完成其中原有待办，版本级网关记录及待人工验收项由主线程统一汇总，避免并发修改公共进度文件。
