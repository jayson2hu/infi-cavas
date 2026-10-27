# M5 实施计划（M4验收后执行）

已读：PRD首页/非功能要求、03第9–11章、04首页/全局布局及移动端、05 M5及最终清单、当前Dockerfile/nginx.conf/compose、server入口与迁移/seed、运行期配置入口。

1. 首页从真实接口取前4个高使用模板、当前品牌与最近4个任务；本地canvas store取6个最近项目。任务仅在文档可见时每5秒轮询，不展示未实现的云同步/团队共享/支付。
2. 保留纯前端compose及nginx静态配置；平台compose包含web、server、PG16、MinIO和一次性bucket初始化。服务间依赖health/completed，持久卷与必要环境示例清楚。
3. Web nginx的/api代理关闭buffer/request buffering，900s超时和100MB请求上限；server保持容器内网，只有nginx可带可信X-Real-IP，nginx必须覆盖该头。不能在server公开时打开TRUST_PROXY。
4. S3_PUBLIC_ENDPOINT必须浏览器可访问且符合实际签名Host，不能将容器内minio地址直接交给浏览器；默认本机端口映射，远端使用部署者显式HTTPS对象存储地址。记录CORS与APP_ORIGIN要求。
5. server启动先迁移、幂等seed及bucket/CORS准备，再启动sweeper并导出监听。多人/多副本启动须确保迁移互斥，不让bootstrap重置运营数据。实际部署命令和失败定位写文档。
6. Docker构建复制共享brand-inject及模板schema所需文件；锁文件安装、运行期配置、LICENSE都进入对应镜像。私有工具/凭据/artifacts保持忽略。
7. 补平台部署、计费说明、品牌与模板文档，说明BYOK密钥仍在本地、画布不云同步；支持安全文档记录第三方插件/脚本信任范围。按用户授权的完整自验更新功能及待测入口，不夸大生产部署状态。
8. 关于入口保留上游链接、MIT全文入口和“基于infinite-canvas”署名。
9. 最终验收按05逐条：注册模板出图/余额/退款/402/成员额度/强制品牌/视频刷新/BYOK/纯前端/BILLING_ENABLED=false/密钥泄露/390px；模板受控上游与真实供应商结果分别标注。
10. 本机无Docker/WSL且HTTP服务监听被自动审批拒绝，当前不能完成“干净机器docker compose up”必选验收。先完成可审阅的实现与无监听浏览器/真实PG/S3/HTTPS供应商证据，再明确剩余环境条件，不能把静态检查写成实机通过。
