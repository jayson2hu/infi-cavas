# M1 前端交付与验收记录

## 计划与已读文件

1. 已读 AGENTS、PRD、技术方案、UI 规范与首页静态稿、OpenAPI 的 Me/Workspace/Member/summary 契约。
2. 已读 router、UserLayout、AppTopNav、AppProviders、ClientRootInit、AgentPanel、配置 store、主题、i18n、运行期配置与 Docker entrypoint。
3. 已使用 frontend-design 与 vercel-react-best-practices 技能，按指定设计稿实现，不替换既有 UI 库。
4. 新增平台接口客户端、会话 store、路由守卫、登录注册邀请、工作区布局、团队管理和真实余额摘要页。
5. 工作区请求显式隔离，迟到的旧响应不能覆盖新会话；纯前端模式保留原路由树。
6. 验证类型、会话并发行为、邀请跳转和运行期配置转义，记录不能执行的浏览器验收。

## 设计依据

浅色底色 #f4f2ed，侧栏 #f0eee8，卡片 #fbfaf7，文字 #1c1917，边界 #e3dfd6，链接 #2a49c9；232px 工作区侧栏，12px 卡片圆角，Inter/Noto Sans SC 字体栈。深色对应 token 统一放在 globals.css，Ant Design 弹层与基础 token 统一由 app-theme 提供。手机宽度折叠为抽屉，内容区保持独立滚动。未写入示例工作区、人名或点数。

## 原文件修改理由

| 原文件 | 修改理由 |
| --- | --- |
| web/src/router.tsx | 按平台开关选择新增路由树；账号、邀请公开，工作区页受保护，画布继续全屏使用 UserLayout。首页暂保留原 HomePage，M5 替换。 |
| web/src/constant/runtime-config.ts | 读取 PLATFORM_API_BASE/BRAND_NAME；显式空的运行期平台前缀优先于构建值，允许关闭平台模式。 |
| web/src/vite-env.d.ts | 声明新增构建变量类型。 |
| web/docker-entrypoint.sh | 加入平台前缀与产品名；用 UTF-8 Base64 注入避免中文丢失、引号或换行破坏脚本。 |
| web/vite.config.ts | 本地 /api 反向代理至 8787，保留浏览器 Origin，使开发与生产同域调用一致。 |
| web/src/main.tsx | 仅平台模式切换指定字体栈及平台模式标记。 |
| web/src/stores/use-theme-store.ts | 平台初始浅色，纯前端保持原深色；已有主题偏好继续保留。 |
| web/src/lib/app-theme.ts | 平台模式统一暖石色背景、边框、圆角与弹层 token；不影响纯前端主题。 |
| web/src/styles/globals.css | 新增跨页面平台 token、工作区布局、认证卡片、响应式与键盘焦点规则。 |
| web/src/i18n/locales/zh-CN.ts、en-US.ts | 只引入新增 platform 命名空间；具体新文案放在同目录 platform-zh-CN/platform-en-US。 |

所有新增文件以当前工作区完整源码交付；原文件修改可用 git diff 按上述路径审查。

## 行为与权限

- 会话仅驻内存，认证由 HttpOnly Cookie 承载；axios 请求带 credentials 和当前工作区头。
- 注册创建个人工作区、赠送点数由后端事务完成，前端直接消费返回的 Me。
- 工作区切换等待后端成员校验后更新；请求序号阻止迟到响应覆盖；查询 key 同时包括用户与工作区，页面切换后卸载旧请求。
- 登录后的外部重定向、协议相对 URL、反斜杠和控制字符被拒绝；邀请在登录/注册相互切换时保留。
- 成员仅查看列表；owner/admin 可创建邀请、改名、修改非 owner 成员角色和上限、移除成员。真正权限由服务端重新校验。
- 团队邀请显示实际服务器链接和有效期，使用现有 useCopyText 复制。
- 工作区壳继续挂载 AgentPanel、AppConfigModal、UserStatusActions 与 Agent 自动连接；原画布布局保持原代码。
- M1 余额页只展示真实 summary 已实现字段；没有模板/品牌假页面，也没有在线支付入口。

## 测试与验收

- `web bun run typecheck`：通过。
- `web/tests/platform-session.test.ts`：7 个测试、22 个断言通过。覆盖初始化去重、401 匿名、工作区头切换、失败切换保留旧区、乱序响应、退出后的迟到响应、旧区401不清新会话，以及安全重定向。
- `web/tests/platform-runtime.test.ts`：1 个测试、3 个断言通过，验证生成的 config.js 正确保留中文、引号、反斜杠、换行及脚本样文本，内容不会执行。
- 全量 `web bun test`：23 个测试、60 个断言通过（含上游 15 个测试）。初次运行注入测试遇到系统临时目录 EPERM，改用项目内已忽略的 test-results 临时目录后通过，无系统权限变更。
- 主线程生产构建通过；原有大 bundle 和静态/动态 import 混用警告未扩大重构。
- M1.4：路由守卫、工作区头、纯前端独立分支已实现；浏览器真实跳转和交互仍待运行验证。
- M1.5：邀请、复制、角色、月度上限、移除的实际 API 已接入；成员视图隐藏管理入口。后端权限由主线程真实 PG 集成测试覆盖。

浏览器手工步骤：平台模式访问 /billing 应到登录页；注册后余额与注册赠点相等；创建工作区后观察请求头改变；邀请第二账号加入；管理员修改角色和上限，成员登录看不到管理按钮；390px 下打开工作区抽屉与团队列表；关闭 PLATFORM_API_BASE 后检查原路由和配置。

当前自动审批拒绝本机 HTTP 服务启动，因此没有启动替代 HTTP 监听，没有执行浏览器交互或截图验收，不能把这些项目标为通过。Docker/MinIO 实际部署限制仍按总问题记录保留。

## CHANGELOG 建议

- [新增] 平台账号与工作区支持注册登录、邀请成员、角色和月度上限管理，并提供中文/英文工作区导航。
