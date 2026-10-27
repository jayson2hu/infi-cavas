# M2 实施计划（M1 验收后执行）

已读：03 的网关/计价/账本/扫描器章节、OpenAPI 管理与计费接口、权威 SQL、M1 session/ledger、真实前端 config/image/video/audio、canvas-generation-helpers 与 handleGenerateNode。

1. 计价只读取 pricing_rules，覆盖每张/每秒/token/字符、取整和整数溢出；默认单价仅 seed。
2. 账本统一 workspace→job/member/bucket 锁顺序；冻结不足整体回滚；结算退款仅允许 held→终态。
3. 注册 grant 已作为 M1 最小依赖实现；M2 扩展 hold/settle/refund、兑换、周期重置与真实 PG 并发测试。
4. Key AES-GCM；后台返回 last4；网关错误做已知秘钥脱敏；不记录原始上游请求头。
5. 网关全部8接口保持前端实际格式；provider映射用 model_routes；未输出时才故障切换。
6. SSE 逐块透传且解析 response.completed usage；结束后前端主动刷新余额，不伪造最终响应头。
7. 视频任务本地ID、归属验证、终态幂等；30分钟主动查询，2小时超时退款。
8. 前端虚拟平台渠道只存在内存，禁止自定义script和Gemini，保留BYOK与纯前端行为。
9. 实际画布多图是逐张count=1并发请求；模板估价总张数与网关逐请求流水需一致。
10. 计费页/管理员页按设计稿和实际数据；支付维持兑换码/联系管理员，不创建虚假付款流程。
11. 后端集成用依赖注入fetch的受控上游覆盖故障/SSE/视频；单独记录真实供应商验证限制。

接口计划：`hold(input)` 保存job及冻结明细；`settle(jobId, actual, details?)`、`refund(jobId, details?)` 返回终态与余额。锁定workspace后必须重读成员权限/上限，不能依赖中间件的旧快照。任何补扣不足均不出现负余额，并标记overdraft，chargedCredits等于实际扣到的点数。
