import { expect, test } from "bun:test";
import example from "../../specs/template-example.json";
import { validateTemplateSemantics, type TemplateBody } from "../../shared/template";
import { officialTemplateDefinitions } from "../src/templates/official";
import { templateObjectKey, validateTemplateBody } from "../src/templates/validation";
import { ApiError } from "../src/lib/errors";

const copy = () => structuredClone(example.body) as TemplateBody;

test("AJV2020接受权威示例与六个完整官方流程，校验不修改原body", () => {
  for (const template of officialTemplateDefinitions) {
    const before = JSON.stringify(template.body);
    expect(validateTemplateBody(template.body)).toBe(template.body);
    expect(validateTemplateSemantics(template.body)).toEqual([]);
    expect(JSON.stringify(template.body)).toBe(before);
  }
  expect(new Set(officialTemplateDefinitions.flatMap((template) => template.body.steps.map((step) => step.mode)))).toEqual(new Set(["text", "image", "video", "audio"]));
});

test("结构错误返回422与字段路径，不允许额外运行操作", () => {
  for (const invalid of [{ ...copy(), version: 2 }, { ...copy(), unsupported: true }, { ...copy(), ops: [{ type: "run_generation", nodeId: "scene" }] }, { ...copy(), ops: [{ type: "add_node", id: "scene", nodeType: "image", apiKey: "private" }] }]) {
    try { validateTemplateBody(invalid); throw new Error("should reject"); }
    catch (error) { expect(error instanceof ApiError).toBe(true); expect((error as ApiError).status).toBe(422); expect((error as ApiError).extra.fields).toBeArray(); }
  }
});

test("变量、局部引用与图结构的语义错误逐项拒绝", () => {
  const variants: Array<(body: TemplateBody) => void> = [
    (body) => body.variables.push({ ...body.variables[0] }),
    (body) => { body.variables[0].bindNode = "points"; },
    (body) => { body.variables[2].options = []; },
    (body) => { body.variables[2].default = "not-in-options"; },
    (body) => body.ops.push({ ...body.ops[0] }),
    (body) => body.ops.push({ type: "connect_nodes", fromNodeId: "missing", toNodeId: "scene" }),
    (body) => body.ops.push({ type: "connect_nodes", fromNodeId: "size_tb", toNodeId: "scene" }),
    (body) => { (body.ops[2] as any).metadata.prompt = "{{var.missing}}"; },
    (body) => { (body.ops[2] as any).metadata.prompt = "@[node:missing]"; },
    (body) => { (body.ops[2] as any).metadata.groupId = "scene"; },
    (body) => body.ops.push({ type: "add_node", id: "group1", nodeType: "group", metadata: { groupId: "group2" } }, { type: "add_node", id: "group2", nodeType: "group", metadata: { groupId: "group1" } }),
    (body) => { body.steps[0].mode = "video"; },
    (body) => { body.steps[1].nodeIds.push("scene"); },
    (body) => { body.steps.reverse(); },
    (body) => { body.steps[0].nodeIds.push("size_tb"); body.steps[1].nodeIds.shift(); },
  ];
  for (const change of variants) { const body = copy(); change(body); expect(validateTemplateSemantics(body).length).toBeGreaterThan(0); expect(() => validateTemplateBody(body)).toThrow(); }
});

test("模板拒绝临时资源、凭据、账号状态和私有渠道模型", () => {
  for (const metadata of [{ content: "blob:temporary" }, { storageKey: "image:local" }, { model: "private-channel::gpt-image-2" }, { nested: { apiKey: "private" } }, { nested: { imageUrl: "/api/files/ws/foreign/private.png" } }, { videoTaskWorkspaceId: "ws_other" }, { platformContext: { workspaceId: "ws_other" } }, { images: [] }, { references: ["https://provider/private"] }]) {
    const body = copy(); (body.ops[0] as any).metadata = metadata;
    expect(() => validateTemplateBody(body)).toThrow();
  }
  for (const url of ["blob:temporary", "data:image/png;base64,AA", "https://other.test/image.png", "/api/files/ws/x/../secret.png", "/api/files/ws/x/a.png?token=secret", "/api/files/%ZZ"]) expect(() => templateObjectKey(url)).toThrow();
});

test("inline节点引用形成步骤依赖，不允许同一步并行读取未完成输出", () => {
  const body = copy();
  body.ops = body.ops.filter((op) => op.type !== "connect_nodes");
  (body.ops[3] as any).metadata.prompt = "使用@[node:scene]的结果";
  body.steps = [{ label: "错误并发", mode: "image", nodeIds: ["scene", "size_tb"] }];
  expect(validateTemplateSemantics(body).some((issue) => issue.path === "/steps/0")).toBe(true);
});
