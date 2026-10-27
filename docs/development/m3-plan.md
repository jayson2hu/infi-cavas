# M3 实施计划（M2 验收后执行）

已读：PRD 品牌能力、03 的品牌注入/上传章节、04 品牌页及画布要求、OpenAPI brands/uploads/files、SQL brands/colors/assets、真实 gateway/router 与 lib/s3、画布图片上传/节点生成链路。

1. 品牌 CRUD、颜色整体替换和资产修改均校验所属工作区；member仅在editor_user_ids中才能编辑。
2. enforced及编辑者名单属于管理员配置，不能让普通品牌编辑者提升权限；默认品牌只能指向本工作区品牌。
3. 上传按purpose/mimeType/bytes预签名，限制PNG/JPEG/WebP与20MB；业务关联时HEAD并读取真实bytes校验归属/类型/大小/签名，再固化到无PUT授权的最终key，防伪造objectKey及预签名重复覆盖。
4. 品牌注入纯函数返回文本、实际附带的风格参考对象key与上游endpoint；用户图优先，参考总数不超模型上限。
5. 默认品牌强制开启时忽略请求none；显式品牌ID必须属于工作区。不能从none凭空推断未发送的非默认品牌ID。
6. 文本注入system/instructions，图像参考可将generations改为edits，音频/视频仅文字；品牌参考不影响n与计费。
7. 注入预览复用同一纯函数，前端300ms防抖；不存在的updated_by不伪造展示。为准确计算模型支持及图数量，兼容增加可选modelId/originalReferenceCount查询参数，记录OpenAPI扩展差异。
8. 前端品牌页、当前品牌store、顶栏切换、节点开关和左侧SKU拖入，继续使用原uploadImage与普通image节点，保持导出能力。
9. 自带Key仅注入品牌文字，不上传附带参考、不扣平台点数；纯前端模式无品牌云请求。
10. 验收覆盖跨工作区文件403、成员编辑权限、强制套用、编辑转发带实际参考、预览一致、S3实际上传读回，以及真实供应商一次参考图编辑。
