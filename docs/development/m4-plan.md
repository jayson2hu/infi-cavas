# M4 实施计划（M3 验收后执行）

已读：PRD 模板流程、03 第7章、05 M4及端到端清单、权威模板schema/example/OpenAPI/SQL、canvas-agent-ops、use-agent-bridge、CanvasNodeMetadata、project.tsx真实生成分支与canvas-generation-helpers。

1. 服务端使用AJV2020校验原始body，再检查局部ID唯一、变量绑定、引用存在、连线无环及步骤依赖顺序；422指出字段。保持原23表不变。
2. 官方模板对所有工作区可见，团队模板严格隔离；owner/admin及本工作区品牌编辑者可发布团队模板，官方修改仅平台管理员。写事务内重查权限，use只增加计数不触碰账本。
3. 图片上传复用M3验证后固化的S3对象，模板只保存可授权的文件引用，不保存浏览器blob地址、IndexedDB storageKey、供应商Key或账号上下文。
4. 实例化纯转换接收已存入IndexedDB的图片元数据与可注入ID工厂。单次替换变量、所有局部引用、连线和groupId；以视口原点平移，追加group/templateRun和选择操作；不生成、不扣点。
5. 插入调用applyAgentOps；提供明确撤销入口，使用其已有快照恢复能力。新画布创建成功后一次插入、一次use统计，防重复effect插入。
6. 模板运行按step串行、节点并发；Promise完成后必须获得真实成功/失败结果，不能把当前吞异常的Promise<void>当作成功。部分图片失败也应停止后续步骤；停止取消当前请求，重试保留已成功步骤。
7. 原project.tsx已确认空image/video/audio及空text原位写回，config生成新子节点。保存模板时将生成config转换成对应空结果节点，清除运行输出。模板重试需保持同一目标ID，不能受用户“另建结果节点”设置影响。
8. 保存选择节点（无选择则全画布）时保留内部连线、相对坐标；输入文本/图片可标为变量，图片外部持久化后转换ops，拓扑层生成steps。拒绝循环和未能重建的引用，不静默遗漏。
9. 六个官方模板幂等seed：电商主图套图、商品详情页长图、短视频分镜、品牌活动海报、小红书种草组图、门店物料延展。按当前数据定价展示估计，示例电商主图5+3图共40点；供应商实际输出尺寸问题I-017保留。
10. 验收包括模板权限/语义、纯转换、真实画布插入与撤销、步骤依赖/失败重试/停止、保存后再次实例化；六个模板逐个浏览器运行。受控上游集成与真实供应商测试分开记录，不能冒充同一证据。

## 原代码确认

- `applyCanvasAgentOps` 支持指定ID、metadata、连线及select_nodes；坐标字段采用x/y或position。
- `useAgentBridge.applyAgentOps`立即更新nodesRef等引用并保存撤销快照，但目前只返回applyAgentOps，需要为模板入口暴露现有undo。
- `handleGenerateNode`的图片count目前拆成多个n=1并发请求，写入同节点images；下一步须等所有图片完成。已核对`readReferenceImage`读取该节点当前主图content/storageKey，故示例的5张场景图是同节点候选，三个尺寸节点沿用当前主图进行适配（共5+3张，不会隐式变成5×3张）；验收须确认读取到实际主图。
- 原生成函数多处捕获异常后正常return，且hydration在try外；运行器接入必须补明确结果及finally，避免误判与悬挂状态。
- 模板内原有group再被实例外层group包裹会形成嵌套；保留groupId重映射和组资源连线，最小补充递归成员遍历供拖动、选择删除、资源读取及左侧节点树使用，不能靠删除原group关系制造“可运行”假象。
