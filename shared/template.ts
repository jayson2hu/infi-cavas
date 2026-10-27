export type TemplateMode = "text" | "image" | "video" | "audio";
export type TemplateVariable = { key: string; label: string; type: "text" | "image" | "select"; required?: boolean; placeholder?: string; default?: string; options?: string[]; bindNode?: string; allowBrandSku?: boolean };
export type TemplateNodeOp = { type: "add_node"; id: string; nodeType: string; title?: string; x?: number; y?: number; width?: number; height?: number; metadata?: Record<string, unknown> };
export type TemplateConnectOp = { type: "connect_nodes"; fromNodeId: string; toNodeId: string };
export type TemplateOp = TemplateNodeOp | TemplateConnectOp;
export type TemplateStep = { label: string; nodeIds: string[]; mode: TemplateMode; estimate?: number };
export type TemplateBody = { version: 1; variables: TemplateVariable[]; ops: TemplateOp[]; steps: TemplateStep[] };
export type TemplateIssue = { path: string; message: string };

export function validateTemplateSemantics(body: TemplateBody): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  if (!body || body.version !== 1 || !Array.isArray(body.ops) || !Array.isArray(body.variables) || !Array.isArray(body.steps)) return [{ path: "/", message: "模板结构或版本不合法" }];
  const nodes = new Map<string, { node: TemplateNodeOp; index: number }>();
  const dependencies = new Map<string, Set<string>>();
  body.ops.forEach((op, index) => {
    if (op.type !== "add_node") return;
    if (!op.id.trim()) add(`/ops/${index}/id`, "节点局部ID不能为空");
    if (!op.nodeType.trim()) add(`/ops/${index}/nodeType`, "节点类型不能为空");
    if (nodes.has(op.id)) add(`/ops/${index}/id`, "节点局部ID重复");
    else { nodes.set(op.id, { node: op, index }); dependencies.set(op.id, new Set()); }
    for (const field of ["x", "y", "width", "height"] as const) if (op[field] !== undefined && (!Number.isFinite(op[field]) || (field === "width" || field === "height") && op[field]! <= 0)) add(`/ops/${index}/${field}`, "节点坐标和尺寸不合法");
  });
  const variables = new Map<string, TemplateVariable>();
  const imageBindings = new Set<string>();
  body.variables.forEach((variable, index) => {
    if (variables.has(variable.key)) add(`/variables/${index}/key`, "变量名称重复");
    variables.set(variable.key, variable);
    if (variable.type === "image") {
      if (!variable.bindNode || nodes.get(variable.bindNode)?.node.nodeType !== "image") add(`/variables/${index}/bindNode`, "图片变量必须绑定到存在的图片节点");
      if (variable.bindNode && imageBindings.has(variable.bindNode)) add(`/variables/${index}/bindNode`, "一个图片节点不能绑定多个图片变量");
      if (variable.bindNode) imageBindings.add(variable.bindNode);
      if (variable.default && !variable.default.startsWith("/api/files/")) add(`/variables/${index}/default`, "默认图片必须使用平台文件地址");
    } else if (variable.bindNode !== undefined || variable.allowBrandSku !== undefined) add(`/variables/${index}`, "只有图片变量可以绑定图片节点或选择品牌SKU");
    if (variable.type === "select") {
      if (!variable.options?.length || new Set(variable.options).size !== variable.options.length) add(`/variables/${index}/options`, "选择变量必须具有非空且不重复的选项");
      if (variable.default !== undefined && !variable.options?.includes(variable.default)) add(`/variables/${index}/default`, "默认值必须属于选项列表");
    } else if (variable.options !== undefined) add(`/variables/${index}/options`, "只有选择变量可以设置选项");
  });
  const visitStrings = (value: unknown, path: string, visitor: (text: string, path: string) => void) => {
    if (typeof value === "string") visitor(value, path);
    else if (Array.isArray(value)) value.forEach((item, index) => visitStrings(item, `${path}/${index}`, visitor));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => visitStrings(item, `${path}/${key}`, visitor));
  };
  const connect = (from: string, to: string, path: string) => {
    if (!nodes.has(from) || !nodes.has(to)) { add(path, "引用的节点不存在"); return; }
    dependencies.get(to)!.add(from);
  };
  body.ops.forEach((op, index) => {
    if (op.type === "connect_nodes") { connect(op.fromNodeId, op.toNodeId, `/ops/${index}`); return; }
    visitStrings({ title: op.title, metadata: op.metadata }, `/ops/${index}`, (text, path) => {
      for (const match of text.matchAll(/\{\{var\.([^{}]+)\}\}/g)) {
        const variable = variables.get(match[1]);
        if (!variable) add(path, `变量 ${match[1]} 不存在`);
        else if (variable.type === "image") add(path, "图片变量只能通过bindNode绑定，不能作为文字占位符");
      }
      if (text.replace(/\{\{var\.[^{}]+\}\}/g, "").includes("{{var.")) add(path, "变量占位符格式不完整");
      for (const match of text.matchAll(/@\[node:([^\]]+)\]/g)) {
        if (!nodes.has(match[1])) add(path, `节点引用 ${match[1]} 不存在`);
        else if (/\/metadata\/(prompt|composerContent|content)$/.test(path)) connect(match[1], op.id, path);
      }
    });
    const groupId = op.metadata?.groupId;
    if (groupId !== undefined) {
      if (typeof groupId !== "string" || nodes.get(groupId)?.node.nodeType !== "group") add(`/ops/${index}/metadata/groupId`, "所属组必须是存在的group节点");
      else connect(op.id, groupId, `/ops/${index}/metadata/groupId`);
    }
    const inspectMetadata = (value: unknown, path: string) => {
      if (typeof value === "string" && /^(?:blob:|data:|image:|audio:|video:|media:|file:)/i.test(value)) add(path, "模板不能保存浏览器临时地址或本地存储引用");
      if (typeof value === "string" && value.startsWith("/api/files/") && (op.nodeType !== "image" || path !== `/ops/${index}/metadata/content`)) add(path, "模板文件引用只能保存在图片节点content中");
      if (Array.isArray(value)) value.forEach((item, itemIndex) => inspectMetadata(item, `${path}/${itemIndex}`));
      else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
        if (/^(?:__proto__|constructor|prototype|storageKey|images|texts|primaryImageId|primaryTextId|status|errorDetails|videoTask.*|platformContext|templateRun|references|api_?key|providerKey|authorization|headers|token|accessToken|refreshToken|password|cookie|session.*|userId|workspaceId|channelId|providerId|baseUrl)$/i.test(key)) add(`${path}/${key}`, "模板不能保存运行状态、凭据、账号上下文或本地资源");
        inspectMetadata(item, `${path}/${key}`);
      }
    };
    inspectMetadata(op.metadata, `/ops/${index}/metadata`);
    if (op.metadata?.model !== undefined && (typeof op.metadata.model !== "string" || op.metadata.model.includes("::"))) add(`/ops/${index}/metadata/model`, "模板模型必须是裸模型ID，不能包含私有渠道ID");
    for (const field of ["content", "prompt", "composerContent", "size", "quality", "groupId"] as const) if (op.metadata?.[field] !== undefined && typeof op.metadata[field] !== "string") add(`/ops/${index}/metadata/${field}`, "该节点字段必须是字符串");
    for (const field of ["count", "textCount"] as const) if (op.metadata?.[field] !== undefined && (!Number.isSafeInteger(op.metadata[field]) || Number(op.metadata[field]) <= 0)) add(`/ops/${index}/metadata/${field}`, "生成数量必须是正整数");
    if ((op.nodeType === "video" || op.nodeType === "audio") && op.metadata?.content) add(`/ops/${index}/metadata/content`, "模板不保存已有视频或音频结果，请保留空生成节点");
    if (op.nodeType === "image" && op.metadata?.content && (typeof op.metadata.content !== "string" || !op.metadata.content.startsWith("/api/files/"))) add(`/ops/${index}/metadata/content`, "模板图片必须使用平台文件地址");
  });
  const stage = new Map<string, number>();
  body.steps.forEach((step, index) => {
    step.nodeIds.forEach((nodeId, item) => {
      const node = nodes.get(nodeId)?.node;
      if (!node) add(`/steps/${index}/nodeIds/${item}`, "生成目标节点不存在");
      else if (node.nodeType !== step.mode) add(`/steps/${index}/nodeIds/${item}`, "生成目标必须是与mode对应的结果节点，配置节点须先转换");
      if (stage.has(nodeId)) add(`/steps/${index}/nodeIds/${item}`, "生成目标不能在步骤中重复出现");
      else stage.set(nodeId, index);
      if (node?.metadata?.generationMode && node.metadata.generationMode !== step.mode) add(`/steps/${index}/mode`, "步骤mode与节点生成能力不一致");
    });
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const inspect = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return false;
    if (visited.has(nodeId)) return true;
    visiting.add(nodeId);
    for (const parent of dependencies.get(nodeId) ?? []) if (!inspect(parent)) return false;
    visiting.delete(nodeId); visited.add(nodeId); return true;
  };
  if ([...nodes.keys()].some((nodeId) => !inspect(nodeId))) add("/ops", "节点连线、引用或分组存在循环");
  else for (const [nodeId, stepIndex] of stage) {
    const checked = new Set<string>();
    const queue = [...(dependencies.get(nodeId) ?? [])];
    while (queue.length) {
      const parent = queue.pop()!;
      if (checked.has(parent)) continue;
      checked.add(parent);
      if (stage.has(parent) && stage.get(parent)! >= stepIndex) add(`/steps/${stepIndex}`, "依赖的生成节点必须在更早步骤完成，不能同一步并发或倒序运行");
      queue.push(...(dependencies.get(parent) ?? []));
    }
  }
  return issues;
}
