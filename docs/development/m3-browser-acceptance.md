# M3 浏览器验收记录

最终构建 `index-Dc8w7lWM.js` 的浏览器验收通过：7 组检查，18.77 秒，浏览器运行时异常为 0。已包含 UI04 要求的画布品牌侧栏 Logo、参考图状态与规则摘要。

## 已验证行为

1. 通过真实页面创建品牌、设为默认并开启强制套用；必带描述和避免内容自动保存；色板修改后注入预览正确更新。
2. 通过浏览器上传三张 64×64 PNG（Logo、SKU、风格参考）到独占 S3 测试桶；PUT 均返回 200，业务资产创建返回 201，最终素材 URL 使用服务端固化的品牌对象路径，图片可解码显示。风格图勾选后预览显示实际附带 1 张；快速连续三次修改示例提示词只产生一次防抖预览请求。
3. 第二个隔离账号在不发送工作区请求头的情况下读取第一个账号的品牌文件，真实文件接口返回 403。
4. 390px 品牌页 document/body 无横向溢出。
5. 画布品牌侧栏显示已上传的真实 Logo 和风格图、随生成附带状态、真实品牌色，以及必带描述和避免内容摘要。
6. 使用真实 HTML 拖拽将侧栏 SKU 拖入画布，生成普通 image 节点；新建生成配置后，“品牌套件”开关处于选中且禁用状态。
7. 从画布菜单下载 ZIP，解析 `projects.json` 后确认包含普通 image 节点和 `image:` 本地存储键；ZIP 内图片与上传原 PNG 字节完全一致。

人工已核对品牌桌面、390px 品牌页和两张画布截图：资产图片、规则预览、品牌侧栏、卡片及强制品牌状态正常。额外截图 `m3-03-canvas-sku-imported.png` 展示配置节点创建前的普通图片节点和完整品牌侧栏，移动截图从页面顶部展示品牌名称、Logo、默认标记及操作按钮。

## 验收边界与安全清理

- 使用 `web/dist`、隔离无头 Chrome、真实 Hono `app.request`、真实本机 `ic_test` PostgreSQL 与已有本机 S3rver；没有新增 HTTP 监听器。
- 每次创建随机名称的独占 `ic-browser-*` 桶及随机 ID 的受控模型/供应商/定价测试记录。供应商 fetch 始终拒绝执行，不调用真实模型，不使用真实供应商密钥。
- 本轮真实 S3 请求为 3 次 PUT 和 4 次 GET，均为 200。退出时清理本次 2 个注册用户、所属工作区、受控模型/供应商及独占桶。
- 虚拟页面由 Playwright 提供响应，没有真实服务端 IP。Chrome 会将其到回环 S3 的重定向判为未经授权的本机网络访问，因此验收传输层先调用真实 `/files` 并记录 302，再通过 stdio 桥读取其签名 S3 GET，最后把真实图片字节交给页面。报告明确记录 `fileRedirectsFollowedByTransport: true`。
- 本证据覆盖真实业务鉴权、上传、对象读取及前端行为，不代表浏览器跨源 302、HTTP 反向代理、Docker Compose 或 MinIO 部署已验收。未关闭浏览器安全策略。
- 控制台日志移除 URL 查询串，避免 CORS 错误消息泄露预签名参数。

## 文件及复跑

- 脚本：`scripts/browser_acceptance.py`、`server/scripts/browser-bridge.ts`。
- 原始证据：`artifacts/acceptance/browser-m3/report.json`、同目录 PNG 和 `brand-canvas.zip`。
- 命令：先加载 `.tools/local-env.ps1`，再执行 `python scripts/browser_acceptance.py --stage m3 --with-storage --output artifacts/acceptance/browser-m3`。

## 本阶段发现并解决的问题

- 异步 S3 初始化前启用 readline 会丢失先到达的 ping；调整为初始化后再读取 stdin。仅本轮生成的遗留测试桶已清理，后续创建/清理 smoke 通过。
- SKU 下载不应携带 `X-IC-Workspace` 跟随 302 到 S3，否则生产 CORS 可能拒绝；前端改为依靠文件路径鉴权和 `same-origin` 凭据模式。
- 本地图片写入完成后再次检查会话与工作区，避免异步插入落入新账号或工作区。
- AWS SDK 给无 Body 的预签名 PUT 生成了错误的空内容 CRC32；签名客户端改为仅在协议要求时添加校验，独立生成 URL 验证已不含该空校验值。
- 对象删除先于数据库提交会导致回滚后图片缺失；后端改为持久清理任务，在事务结果确定后清理，并由维护扫描重试。独立代码复核通过，回滚/重试测试由后端验收覆盖。
