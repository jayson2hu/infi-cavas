# M1–M2 浏览器验收记录

日期：2026-10-25。结果：通过，9 项检查，耗时 24.8 秒，浏览器 `pageerror` 为 0。

## 验收方式

- 使用本机构建产物 `web/dist` 和隔离的无头 Chrome 上下文，桌面尺寸 1440×1000，移动端尺寸 390×844。
- Playwright `route.fulfill` 提供构建资源；API 经 stdin/stdout 调用真实 Hono `app.request`，连接本机 `ic_test` PostgreSQL 数据库。
- 未开启 HTTP 监听端口，未调用真实模型供应商。外部提示词源和版本检查请求被测试脚本主动阻止。
- 测试随机生成两个用户，通过真实页面注册；结束时仅清理本次注册的用户及其工作区。
- 本记录证明前端与真实业务 API/数据库的集成行为，不代替 HTTP、反向代理、Docker Compose 或 MinIO 部署验收。真实供应商/S3 的独立证据见 `artifacts/acceptance/real-provider.json`。

## 已通过项目

1. 匿名访问账单页跳转登录，保留原路径。
2. 注册成功后回到账单页，创建个人工作区，赠送 200 点，浏览器保存 HttpOnly 会话 Cookie。
3. 创建团队并切换工作区，生成有效邀请链接。
4. 第二个隔离浏览器通过邀请注册并自动加入团队；所有者修改成员月度上限为 12 点；普通成员看不到成员用量及账单导出，并且成员用量 API 返回 403。
5. 切回个人工作区并下载 CSV，流水包含注册赠送 200 点。
6. 390px 首页无 document/body 横向溢出。
7. 390px 团队页无 document/body 横向溢出，成员表在局部容器中横向滚动。
8. 390px 账单页无 document/body 横向溢出，统计卡片按单列排列。
9. 退出登录清除 Cookie；错误密码显示中文提示；正确密码重新登录回到账单页。

人工已核对登录、账单桌面、团队成员桌面和三张移动端截图：文字、按钮、表格、卡片均正常，无遮挡主操作或错误空白页。

## 证据及复跑

- 脚本：`scripts/browser_acceptance.py`。
- 业务桥：`server/scripts/browser-bridge.ts`，包含在服务端 TypeScript 检查中。
- 原始报告和截图：`artifacts/acceptance/browser/`，成功标识为 `report.json` 中 `passed: true`。
- 命令：`python scripts/browser_acceptance.py`，前提是已构建前端、运行本机测试 PostgreSQL 并完成迁移。

报告中的控制台资源错误对应主动阻止的外部请求以及断言预期的 401/403；不存在未处理浏览器运行时异常。

## 验收脚本问题记录

- 本机 Python 3.8 不支持 `Path.is_relative_to`，改用 `relative_to` 与 `ValueError` 检查静态文件边界。
- Ant Design 会在双中文按钮文字间自动插空格，定位器改为允许空白的正则表达式。
- 浏览器虚拟域名使用 HTTPS 安全上下文，避免 PWA 在非安全上下文缺少 `navigator.serviceWorker`。所有请求均由 Playwright 提供响应，没有建立 HTTPS 监听器。

上述问题均为验收环境/脚本校准，不是产品缺陷。
