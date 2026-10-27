# M5 最终独立验收

2026-10-25，对冻结构建 `index-j2BHYI-z.js` / `index-B4wda029.css` 完成三模式浏览器验收：平台模式 14 组 / 32.72 秒，关闭计费 1 组 / 9.89 秒，纯前端 3 组 / 11.38 秒。三份报告均通过，页面运行时异常和传输异常均为 0，独占测试用户、模板、模型、供应商及桶均清理完成。桌面首页、390px 首页与计费页、关于弹窗已人工核对截图。

后续仅补充 CHANGELOG M5 文案的最终构建为 `index-CyPMoyEb.js`（CSS 不变），未修改业务逻辑。验收桥扩展独立真实图片模式后，在此最终构建重新执行传输专项：7 组 / 6.31 秒通过，0 页面/传输异常，证据为 `artifacts/acceptance/browser-m5-transport/report.json`。真实模式预检通过，密钥在内存中解密成功，供应商调用为 0，见 `browser-m5-real-ecom/preparation.json`。

随后一次真实图片供应商流程通过：注册至 8 图完成 **84.84 秒**，实际 8 请求、40 点、余额 200→160、8 个归档哈希一致，0 页面/传输异常。首次因验收选项定位失败而结束的零调用记录和一次恢复记录均保留，未重复付费；完整证据及像素偏差见 `m5-real-provider.md`。

最终构建再补首页专项 3 组 / 22.67 秒通过（`browser-m5-home-final/report.json`）：每段 5.5 秒内首页 jobs GET 在 visible/hidden/visible 状态分别增加 1/0/1；真实语言按钮切到英文后首页标题、推荐/最近画布/最近生成、模板中心和平台免计费文案正确，无原始翻译 key。截图已人工复核，官方模板名称与描述作为数据库业务内容仍保留中文。可见性测试因无头浏览器限制而显式设置 document.visibilityState 并派发 visibilitychange，执行实际应用订阅和轮询逻辑；没有把它写成操作系统后台标签实测。此专项供应商调用为 0，页面/传输异常为 0，独占资源已清理。

## 最终 12 项清单

| 项目 | 结果与证据 |
| --- | --- |
| 注册→首页→电商模板→变量→新画布→运行→出图，3 分钟内 | 真实图片供应商通过，84.84 秒；从真实注册页面进入新首页，通过推荐卡片的模板 ID 链接进入正确详情，上传商品并填写变量，生成 5 张候选主图和 3 张适配图。结果 ZIP 含 9 个图片文件（含原商品）。受控版本为 8.2 秒，两个结果分别记录。 |
| 顶栏余额实时更新，流水与 job 对应 | 通过，无刷新 200→160；8 个 succeeded job 合计 40 点，各有 hold/settle 流水且金额和为对应扣费负值；首页最近 4 任务 ID 与 API 排序一致，本地项目真实显示。 |
| 错误供应商 base_url，节点报错并全额退款 | 通过，只修改本次独占供应商地址；5 个实际网关任务 failed、chargedCredits=0，逐个 hold/refund，余额维持 160。错误地址由验收传输拒绝，不访问外网。 |
| 余额不足弹窗且不调用上游 | 通过，余额耗尽后真实界面显示“点数不足”，job 集合与供应商 trace 均无增加。 |
| member 月度上限拦截，admin 豁免 | 通过，真实团队月限设为 4；member 第一次成功，第二次 402/member_cap_exceeded 且无上游；将同一成员改 admin 后再次成功，团队余额 20→12。 |
| 强制品牌开关禁用 | 复用 M3 已通过证据：真实页面创建强制品牌，画布配置节点开关选中且禁用；见 `m3-browser-acceptance.md`。后端强制品牌优先级及真实供应商参考图编辑见 `m3-backend.md`。 |
| 视频生成中刷新后恢复轮询、正确结算 | 复用 M4 最终构建的专项证据：刷新后复用 3 个任务 ID；另验证模型延迟加载时自动恢复并在继续运行时跳过已完成节点；两场景均仅创建 3 个视频任务，总扣费 171；见 `m4-browser-acceptance.md`。 |
| BYOK 可生成、不扣点、品牌只注入文字 | 通过真实渠道设置 UI 新增渠道、拉取模型、保存并在生图工作台生成。即使默认品牌含 attachOnGenerate 风格参考，实际 BYOK 请求只有品牌文字，无 image/images/reference_images，无 Cookie/X-IC 请求头；平台 job、余额、用量和供应商 trace 不变。BYOK HTTPS 由浏览器 route 提供受控有效图片。 |
| PLATFORM_API_BASE 为空保留原项目行为 | 通过独立进程及浏览器配置：无平台外壳、登录或平台 API 请求；原首页→新建画布→文本节点→ZIP 导出，以及原渠道配置和生图工作台可用。 |
| BILLING_ENABLED=false 不扣点且“用量统计” | 通过独立后端进程：生成成功，余额维持 200，monthCharged=0，image job=1，成功率 100%；成功 job chargedCredits=0，账本仅注册 grant；页面标题“用量统计”，模板详情明确“平台免计费”，不混写为 BYOK。 |
| API/日志不出现上游 Key 明文 | 现有安全专项覆盖管理接口不返回原 Key、JSON Unicode 转义/跨 SSE 事件/媒体字节/错误内容脱敏、密钥加密存储及日志上下文；见 `m2-gateway-security.md` 与服务端集成测试。最终浏览器报告只存自生成 BYOK keyMatched 布尔值，不记录 Authorization。此项为已覆盖路径的测试结论，不声称穷举所有可能的供应商编码。 |
| 390px 首页、模板中心、计费页无横向滚动 | 通过，三页 document/body/viewport 均为 390；最终截图分别为 mobile-home.png、mobile-templates.png、mobile-billing.png。模板变量详情的移动操作另有 M4 证据。 |

## M5 其他检查

- 首页推荐 4 个真实模板；默认品牌的名称与必带词来自真实接口；最近项目来自当前浏览器的实际画布；最近生成来自实际 job。
- 关于弹窗包含“基于 infinite-canvas”、准确上游链接，展开 MIT 后 `<pre>` 文本与仓库 LICENSE 完全一致；平台与纯前端两模式都通过。
- 只读复核 Dockerfile、server/Dockerfile、compose、nginx、环境示例及启动入口：shared/specs/LICENSE 随镜像复制；必填密钥为空时 Compose 拒绝；server/PG 不公开端口；nginx 覆盖可信 IP 头、关闭流缓冲、900 秒超时、100MB 请求限制；S3 公网签名地址与本机默认绑定有明确配置；启动先迁移、seed、桶/CORS，成功后才监听。迁移使用保留连接持 advisory lock，原连接池执行 Drizzle 迁移，finally 解锁。另有后端真实 PG 新库/多进程迁移/幂等 seed 测试证据。最终 web-only Compose 已复核为从当前源码构建，显式设置 PLATFORM_API_BASE 为空。

## 边界与复跑

浏览器加载实际 `web/dist`，API 通过 Bun stdio 调用真实 Hono `app.request`，使用真实本机 PostgreSQL `ic_test` 和已有 S3rver，未创建 HTTP 监听。三模式报告的平台供应商与 BYOK 响应受控；另行执行的真实图片流程实际付费 8 请求，两类证据分开记录。`/api/files` 的真实 302 由传输桥读取签名对象后交付浏览器；multipart 桥保留浏览器实际字段与文件字节，已有 SHA256 独立验收。

本记录不代表干净机器 `docker compose up -d`、Nginx HTTP、真实 MinIO/CORS 部署或真实文本/视频/语音供应商已验收。当前环境无 Docker/WSL，且此前 HTTP 监听操作被自动审批拒绝；M5.2 的干净机器部署验收仍须在允许的环境完成。真实图片供应商证据与本受控报告分开记录，已知返回尺寸偏差 I017 保留。

脚本为 `scripts/final_browser_acceptance.py`。加载 `.tools/local-env.ps1` 后依次执行（不可并行，以免共享模型优先级干扰）：

```powershell
python scripts/final_browser_acceptance.py --mode billing-off
python scripts/final_browser_acceptance.py --mode web-only
python scripts/final_browser_acceptance.py --mode normal
```

报告及截图位于 `artifacts/acceptance/browser-m5-billing-off/`、`browser-m5-web-only/`、`browser-m5-normal/`。验收脚本开发中修正了“新建画布”多按钮和“新增渠道”实际文案的定位方式；未发现需要修改业务实现的新缺陷。
