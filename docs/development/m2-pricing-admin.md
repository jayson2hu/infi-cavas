# M2 计价、密钥与模型管理

已读权威 `specs/schema.sql`、`openapi.yaml` 的供应商与模型定义，技术方案计价/网关/安全章节，以及 M1 中间件、数据库 client、现有测试。

新增：`gateway/pricing.ts`、`lib/crypto.ts`、`routes/admin.ts` 及对应单元/真实 PostgreSQL 集成测试。`app.ts` 由主线程统一挂载路由。增加 `decimal.js` 精确处理十进制计费，并按主线程需要加入 `eventsource-parser` 供 SSE 使用；不替换既定选型。

## 行为与原文件修改理由

- `pricing` 为纯函数，价格来自参数；所有输出为 PostgreSQL integer 范围内的向上取整点数。覆盖图片最长边分档、实际张数、秒数、文本 usage 与缺失回退、Unicode 字符计费。十进制运算使用成熟库，避免临界值多扣点。`config` 使用 SQL 的 `input/output/hold/min`；文本 `hold/min` 缺省仅采用技术方案明确的 10/1。
- AES-256-GCM 采用随机 12 字节 IV、16 字节认证标签，主密钥由 APP_SECRET 的 SHA256 派生，密文格式为 base64(iv|tag|ciphertext)。错误统一不含秘密。
- 管理路由强制 session 与平台管理员校验。供应商响应仅返回 last4，更新空 Key 不改变原密文；连通测试不透传上游错误或回显密钥的模型名。
- 模型/路由/定价统一事务保存，校验能力与计价单位匹配、供应商存在、路由不重复、价格为有效非负值。模型删除仅停用。
- SQL 历史 job/video FK 不允许直接删除已使用供应商；此时 DELETE 只设置 is_active=false，保留历史关联。无历史引用时正常删除并由 FK 清理路由。
- 供应商 baseUrl 规范为不含末尾 `/v1` 的 HTTP(S) 地址，不接受 URL 内嵌凭据或查询参数，避免凭据进入管理响应。

## 导出

`estimate(rule, params)`、`actual(rule, params, response?)`、`validatePricingRule(input)`、`pricingRuleSchema`；`encryptSecret(plaintext, secret?)`、`decryptSecret(ciphertext, secret?)`；`adminRoutes`、可注入 fetch 的 `createAdminRoutes()`。

验收：`bun run typecheck` 通过；`bun test tests/admin.integration.test.ts tests/pricing.test.ts tests/crypto.test.ts tests/auth-security.integration.test.ts` 共 14 项通过、0 失败、110 次断言。管理接口集成测试连接真实 PostgreSQL，并通过注入 fetch 验证供应商请求与错误脱敏，不代表真实供应商出图验收。
