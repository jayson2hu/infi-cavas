# M5 公开文档

新增中英双语“平台模式部署”“计费说明”“品牌与模板”和“平台安全与数据边界”，更新对应导航、AI文档索引和README入口。内容依据实际Compose、环境变量、初始化、定价、账本、权限、品牌注入、模板运行和浏览器验收实现编写。

原文件修改理由：

- README：区分当前二开与上游，补平台入口；纯前端命令改用明确的web-only文件，避免旧命令误启平台或克隆上游后缺少二开文件。
- Docker/快速开始文档：区分主平台Compose与纯前端；纠正上游“主应用运行Next.js”的过期说明，实际为Vite+nginx，Next.js仅用于文档站。
- features两语言：记录已通过本机验收的账号/计费/品牌/模板能力，说明本地画布边界与部署验证范围。
- overview/support meta及docs/index两语言：让新增文档在两种语言中均可访问。
- todo/pending-test两语言：保留上游条目，增加平台已验证变更和环境/供应商缺口；最终M5结论在全部检查后更新。
- docs/package.json：类型检查先生成Next路由类型，再完整生成MDX模块，最后检查TS，防止Next配置插件在退出时留下空的.source/server.ts（I030）。无依赖或锁文件变更。

部署说明不包含真实凭据。明确APP_ORIGIN、公开S3签名Host/CORS、仅内网可信代理、多层代理IP、独立环境bucket、数据库地址一致性、备份与APP_SECRET轮换要求。说明无在线支付、BYOK仍保存于浏览器、插件仍有页面权限，以及签名URL持有者的访问范围。

## 验证

按既有 `docs/bun.lock` 冻结安装366个包，未改锁文件。第一次Next构建因用户级遥测配置EPERM中止；改用单次命令环境 `CI=1`、`NEXT_TELEMETRY_DISABLED=1` 后，MDX编译、TypeScript及81页静态生成完成，退出0。Windows standalone复制Shiki路径出现EPERM警告（I028），不能因此称文档运行镜像验收通过。没有启动HTTP服务。

更新最终文案后再次build在清理Shiki生成junction时EPERM；随后仅删除该生成链接的PowerShell操作被自动审批拒绝（blocked by policy），未尝试换工具删除。最终使用现有 `bun run types:check` 完成fumadocs-mdx、Next路由类型生成和TypeScript，退出0；没有执行缓存清理或监听服务。最终内容/类型验证通过，Windows standalone重新打包仍受此环境问题限制。

最后复查发现Next typegen插件异步写入会偶发留下空的.source/server.ts；按I030调整生成顺序后，最终types:check连续两次均通过。

新增8份文档的双语导航、生成模块导入与MDX/TS内容已核对。部署操作说明不等于已执行Docker验收；供应商图片、受控多模态与未验证真实能力均明确区分。
