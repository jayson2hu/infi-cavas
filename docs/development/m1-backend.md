# M1 后端计划与交付

已读：AGENTS、03 技术方案账号/权限/账本章节、OpenAPI auth/workspaces/billing、schema.ts、app.ts、env.ts、db/client.ts。

计划新增 session/Origin/role 中间件、密码会话认证与工作区邀请路由、事务赠点、账单摘要、共用错误/ID/加密工具和真实数据库 HTTP 集成测试。修改 app.ts 挂载路由；不改权威表结构。会话仅保存哈希；权限以数据库成员关系为准；注册用户/个人工作区/赠点/可选接受邀请同一事务。所有账本变更锁定工作区再写桶和流水，为 M2 并发冻结统一锁顺序。

浏览器 HTTP 服务启动因自动审批拒绝暂未完成；app.request 集成测试可独立推进。权限边界和失败事务必须实测后才记通过。
