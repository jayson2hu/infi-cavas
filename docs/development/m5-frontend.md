# M5 平台首页与开源署名

## 计划与范围

M4 最终 27 项主验收与 6 项视频恢复验收通过后开始。依据 M5 计划、PRD 首页、UI04 全局布局/首页/移动端和最终验收清单，继续使用 frontend-design、vercel-react-best-practices 及既有 warm-stone token。

顺序：确认真实模板、任务、品牌与本地画布数据；独立平台首页；模板 query id 直达；免计费文案；关于与许可证；自动检查；独立浏览器验收。本记录只覆盖前端，部署文件与交付文档由主线程/后端线程单独完成。

## 已实现

- 登录平台首页使用新增 `pages/home/platform-home.tsx`，游客和纯前端模式仍使用原 `HomePage`。不修改上游首页内容，不提供未实现的云同步、团队画布或支付入口。
- 使用现有 templates API 的真实列表，按 `useCount` 降序选前 4 个，展示真实分类、名称、说明、最多 3 个流程节点、保存估价。卡片链接 `/templates?id=...`，模板中心详情读取并更新 URL，浏览器前进/后退也恢复对应选择。紧凑画布侧栏仍使用独立本地选择。
- 最近画布从已有本地 store 按 `updatedAt` 取前 6 个，只显示“全部”和“保存在当前浏览器”。首个有图片数据的 image 节点提供缩略图，支持生成结果数组；按 storageKey 从 IndexedDB 解析有效 URL 并使用已有预览缓存。没有图像或读取失败显示真实占位。没有制造预览图或任务。
- 当前品牌从已有 brand store 读取 Logo/名称/SKU 数/颜色/强制规则状态及必用禁用词，工作区和会话 generation 必须匹配。品牌未选中、加载和错误均有对应状态与管理入口。
- 最近任务调用现有 `/billing/jobs`，按 `createdAt` 排序展示 4 个，呈现模型、真实状态、提示词、时间和实际/预估点数。只有本机存在关联画布时显示打开画布链接，避免把云端 projectId 当作已同步画布。任务查询在文档 visible 时才启用，5000ms 轮询，visibilitychange 后暂停/恢复，不做后台轮询。
- 所有页面模块都有实际 loading/error/empty 状态。首页私有 CSS 复用平台 token，桌面两栏、窄屏顺序堆叠，未写入全局样式。
- 模板详情、卡片和运行确认读取真实 billingEnabled；平台 `false` 明确“平台免计费 · 不扣平台点数”，步骤显示 0，运行按钮不再显示收费数字。BYOK 仍是独立“自带 Key”说明，未把免计费平台请求误称为 BYOK。
- 在原 `VersionReleaseModal` 增加“基于 infinite-canvas”、上游 GitHub 链接和可展开 MIT 全文。全文用原根目录 `LICENSE?raw` 构建导入，离线可读，没有修改或删减 LICENSE。后端线程已保证 Docker 构建上下文复制根 LICENSE，并在运行镜像提供原文件。
- 新增文案均有中文和英文。首页卡片提供 `data-template-id`、`data-project-id`、`data-job-id`，署名区提供 `data-about-attribution` 供独立验收稳定定位。

## 原文件修改理由

| 文件 | 理由 |
| --- | --- |
| `web/src/router.tsx` | 登录平台首页切换为真实业务首页，保留游客/纯前端首页 |
| `web/src/components/templates/template-library.tsx` | 支持首页模板链接 `?id=`；读取免计费状态并准确展示 |
| `web/src/components/templates/template-run-bar.tsx` | 运行确认准确区分平台免计费与 BYOK |
| `web/src/components/layout/version-release-modal.tsx` | 复用现有入口提供上游署名、链接和 MIT 原文 |
| `web/src/i18n/locales/platform-{zh-CN,en-US}.ts` | 合并独立首页双语文案 |
| `web/src/i18n/locales/template-{zh-CN,en-US}.ts` | 新增平台免计费及插入/运行解释 |

新增 `platform-home.tsx/css`、纯数据选择 `home-data.ts`、双语 home 文案和 `home-data.test.ts`。未新增依赖、业务字段、支付渠道或云端画布服务。

## 问题与验证记录

- 原首页是公开展示页，登录后直接复用会缺失业务数据；现单独新增平台页，保留上游页面。
- 本地保存的 blob URL 在刷新后失效，因此首页从 storageKey 重新解析 IndexedDB 图片，图片预览失败保留占位。视频与文本内容不被误当成图片。
- 原模板中心只记录组件内选中项，首页链接无法直接打开详情；现非紧凑模式以 URL 参数作为选择来源，并保留工作区隔离的 query key。
- 原模板估价没有区分平台免计费配置，造成 false 模式仍显示费用；现展示层明确说明免费平台调用，保持 BYOK 标识语义独立，实际扣费规则仍由服务端保证。
- `bun run --cwd web typecheck`：通过。
- `bun test --cwd web tests/home-data.test.ts`：3 项 / 8 断言通过，验证真实使用数前 4、不可变排序、本地更新时间前 6、首个图片与生成数组选择、空态及排除文本/视频。
- `bun run --cwd web build`：29.34 秒通过，交审计构建 `index-j2BHYI-z.js` / `index-B4wda029.css`。保留既有大包与静态/动态 import 提示，无新增构建错误。
- 独立浏览器三模式18组与最终首页补验3组通过；覆盖真实首页/预览、390px、query id、关于MIT、英文、免计费/BYOK，轮询补验使用合成document可见状态及真实订阅。完整前端42项/133顶层断言通过；结果见m5-acceptance.md。真实完整电商8图84.84秒、40点/归档通过，见m5-real-provider.md。
- Docker/真实 MinIO 干净机器部署尚未具备执行环境；本前端构建或无监听浏览器验收不能替代该项，未宣称生产部署验收成功。
