# 无限画布文档索引

## 项目介绍

- [快速开始](/zh-CN/docs/overview/quick-start)
- [功能介绍](/zh-CN/docs/overview/features)
- [Render 部署](/zh-CN/docs/overview/render)
- [Docker 部署](/zh-CN/docs/overview/docker)
- [平台模式部署](/zh-CN/docs/overview/platform-deployment)
- [计费说明](/zh-CN/docs/overview/platform-billing)
- [品牌与模板](/zh-CN/docs/overview/brand-templates)
- [第三方提示词来源](/zh-CN/docs/overview/third-party-prompt-repositories)

## 操作手册

- [画布节点操作手册](/zh-CN/docs/canvas/canvas-node-manual)
- [画布快捷键](/zh-CN/docs/canvas/canvas-shortcuts)

## 开发与数据

- [本地开发](/zh-CN/docs/development/local-development)
- [画布数据结构](/zh-CN/docs/development/canvas-data-structure)

## 商务合作

- [开源协议](/zh-CN/docs/business/license)
- [商务合作](/zh-CN/docs/business/business)

## 支持与安全

- [漏洞提交](/zh-CN/docs/support/security)
- [平台安全与数据边界](/zh-CN/docs/support/platform-security)
- [赞助支持](/zh-CN/docs/support/sponsor)

## 项目进度

- [更新日志](/zh-CN/docs/progress/changelog)
- [待测试](/zh-CN/docs/progress/pending-test)
- [TODO](/zh-CN/docs/progress/todo)

## 说明

- 当前画布项目和“我的素材”主要保存在浏览器本地，跨设备可自行配置 WebDAV 同步。
- 自带 Key 保存在浏览器本地，由前端直连供应商。可选平台模式的供应商 Key 在服务端加密保存，工作区、品牌、模板、账本和任务保存在 PostgreSQL/S3。
- 本次二开的进度、问题和验收证据见仓库 `docs/development/`；生产部署与供应商能力限制单独列出，不与本机集成验收混淆。

## 原理说明

- [本地 Codex 连接画布原理](/zh-CN/docs/development/local-codex-canvas)
