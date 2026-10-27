import Ajv2020 from "ajv/dist/2020";
import schema from "../../../specs/template.schema.json";
import { validateTemplateSemantics, type TemplateBody } from "../../../shared/template";
import { ApiError, invariant } from "../lib/errors";

const validate = new Ajv2020({ allErrors: true }).compile<TemplateBody>(schema);
export function validateTemplateBody(value: unknown): TemplateBody {
  if (!validate(value)) throw new ApiError(422, "invalid_template", "模板结构不符合规格", { fields: validate.errors?.map((error) => ({ path: error.instancePath || "/", message: error.message ?? "字段格式错误" })) });
  const fields = validateTemplateSemantics(value);
  if (fields.length) throw new ApiError(422, "invalid_template", "模板引用或运行步骤不合法", { fields });
  for (const [index, op] of value.ops.entries()) {
    const allowed = op.type === "add_node" ? ["type", "id", "nodeType", "title", "x", "y", "width", "height", "metadata"] : ["type", "fromNodeId", "toNodeId"];
    const unsupported = Object.keys(op).filter((key) => !allowed.includes(key));
    if (unsupported.length) throw new ApiError(422, "invalid_template", "模板不能包含额外的运行指令或私有字段", { fields: unsupported.map((key) => ({ path: `/ops/${index}/${key}`, message: "不支持的模板操作字段" })) });
  }
  invariant(value.steps.reduce((sum, step) => sum + (step.estimate ?? 0), 0) <= 2147483647, 422, "invalid_template", "模板预估点数超出整数范围");
  return value;
}

export function templateObjectKey(url: string) {
  invariant(url.startsWith("/api/files/"), 422, "invalid_template_image", "模板图片必须使用平台文件地址");
  let key: string;
  try { key = decodeURIComponent(url.slice("/api/files/".length)); }
  catch { throw new ApiError(422, "invalid_template_image", "模板图片地址不合法"); }
  invariant(key && !/[\\\u0000-\u001f?#]/.test(key) && !key.split("/").some((part) => !part || part === "." || part === ".."), 422, "invalid_template_image", "模板图片地址不合法");
  return key;
}

export function templateImageReferences(body: TemplateBody) {
  const references: Array<{ value: string; metadata?: Record<string, unknown>; set: (value: string) => void }> = [];
  for (const op of body.ops) if (op.type === "add_node" && op.nodeType === "image" && typeof op.metadata?.content === "string" && op.metadata.content) {
    references.push({ value: op.metadata.content, metadata: op.metadata, set: (value) => { op.metadata!.content = value; } });
  }
  for (const variable of body.variables) if (variable.type === "image" && variable.default) references.push({ value: variable.default, set: (value) => { variable.default = value; } });
  return references;
}

export function templateObjectKeys(body: TemplateBody, coverObjectKey?: string | null) {
  return [...new Set([...templateImageReferences(body).map((reference) => templateObjectKey(reference.value)), ...(coverObjectKey ? [coverObjectKey] : [])])];
}
